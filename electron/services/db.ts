/**
 * SQLite persistence: connection, pragmas and versioned migrations.
 *
 * The whole app's "local memory" lives in one file under Electron's userData
 * directory, so backing up or resetting the app is a single-file operation.
 */

import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';

export type DB = Database.Database;

let db: DB | null = null;

/**
 * Each migration runs exactly once, in order, inside a transaction. Never edit
 * a migration that has shipped — append a new one instead.
 */
const MIGRATIONS: { version: number; name: string; up: string }[] = [
  {
    version: 1,
    name: 'initial schema',
    up: `
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Cached symbol metadata. 'exchange' holds our registry code.
      CREATE TABLE symbols (
        symbol           TEXT PRIMARY KEY,
        short_name       TEXT NOT NULL DEFAULT '',
        long_name        TEXT NOT NULL DEFAULT '',
        quote_type       TEXT NOT NULL DEFAULT 'OTHER',
        exchange         TEXT NOT NULL DEFAULT 'UNKNOWN',
        raw_currency     TEXT NOT NULL DEFAULT 'USD',
        display_currency TEXT NOT NULL DEFAULT 'USD',
        price_divisor    REAL NOT NULL DEFAULT 1,
        sector           TEXT,
        industry         TEXT,
        updated_at       INTEGER NOT NULL
      );

      -- OHLCV cache. Prices are stored already normalized to display currency.
      -- Composite PK gives us idempotent upserts and a fast range scan.
      CREATE TABLE candles (
        symbol    TEXT    NOT NULL,
        interval  TEXT    NOT NULL,
        ts        INTEGER NOT NULL,
        open      REAL    NOT NULL,
        high      REAL    NOT NULL,
        low       REAL    NOT NULL,
        close     REAL    NOT NULL,
        volume    REAL    NOT NULL DEFAULT 0,
        adj_close REAL    NOT NULL,
        PRIMARY KEY (symbol, interval, ts)
      ) WITHOUT ROWID;

      -- Tracks how fresh each (symbol, interval) series is, so we can decide
      -- whether to hit the network without scanning the candle table.
      CREATE TABLE series_meta (
        symbol        TEXT    NOT NULL,
        interval      TEXT    NOT NULL,
        first_ts      INTEGER,
        last_ts       INTEGER,
        fetched_at    INTEGER NOT NULL,
        bar_count     INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (symbol, interval)
      );

      -- Ranked type-ahead source: recency x frequency of the user's own lookups.
      CREATE TABLE search_history (
        symbol      TEXT PRIMARY KEY,
        hit_count   INTEGER NOT NULL DEFAULT 1,
        last_used   INTEGER NOT NULL
      );

      CREATE TABLE watchlists (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE watchlist_items (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        watchlist_id INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
        symbol       TEXT NOT NULL,
        sort_order   INTEGER NOT NULL DEFAULT 0,
        note         TEXT NOT NULL DEFAULT '',
        UNIQUE (watchlist_id, symbol)
      );
      CREATE INDEX idx_watchlist_items_list ON watchlist_items(watchlist_id, sort_order);

      CREATE TABLE scripts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        source     TEXT NOT NULL,
        version    INTEGER NOT NULL DEFAULT 1,
        overlay    INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Every save snapshots the previous source so edits can be rolled back.
      CREATE TABLE script_versions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        script_id  INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
        version    INTEGER NOT NULL,
        source     TEXT NOT NULL,
        saved_at   INTEGER NOT NULL
      );
      CREATE INDEX idx_script_versions ON script_versions(script_id, version DESC);

      CREATE TABLE chart_layouts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL,
        grid       INTEGER NOT NULL DEFAULT 1,
        panes      TEXT NOT NULL,          -- JSON ChartPaneState[]
        is_default INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      -- Indicators attached per symbol, so a chart reopens as you left it.
      CREATE TABLE chart_indicators (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol        TEXT NOT NULL,
        instance_id   TEXT NOT NULL,
        indicator_id  TEXT NOT NULL,
        params        TEXT NOT NULL DEFAULT '{}',
        colors        TEXT NOT NULL DEFAULT '{}',
        visible       INTEGER NOT NULL DEFAULT 1,
        sort_order    INTEGER NOT NULL DEFAULT 0,
        UNIQUE (symbol, instance_id)
      );

      -- Anchored to price/time, never pixels, so they survive zoom and resize.
      CREATE TABLE drawings (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol     TEXT NOT NULL,
        tool       TEXT NOT NULL,
        points     TEXT NOT NULL,          -- JSON [{time, price}]
        color      TEXT NOT NULL DEFAULT '#2962ff',
        line_width INTEGER NOT NULL DEFAULT 1,
        text       TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_drawings_symbol ON drawings(symbol);

      CREATE TABLE alerts (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol        TEXT NOT NULL,
        interval      TEXT NOT NULL DEFAULT '1d',
        condition     TEXT NOT NULL,       -- JSON AlertCondition
        repeat        TEXT NOT NULL DEFAULT 'once',
        cooldown_sec  INTEGER NOT NULL DEFAULT 300,
        expires_at    INTEGER,
        enabled       INTEGER NOT NULL DEFAULT 1,
        sound         INTEGER NOT NULL DEFAULT 1,
        note          TEXT NOT NULL DEFAULT '',
        created_at    INTEGER NOT NULL,
        last_fired_at INTEGER
      );
      CREATE INDEX idx_alerts_enabled ON alerts(enabled, symbol);

      CREATE TABLE alert_events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_id     INTEGER NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
        symbol       TEXT NOT NULL,
        fired_at     INTEGER NOT NULL,
        price        REAL NOT NULL,
        message      TEXT NOT NULL DEFAULT '',
        acknowledged INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_alert_events_time ON alert_events(fired_at DESC);
    `,
  },
  {
    version: 2,
    name: 'drawing style props',
    up: `
      -- Per-drawing styling (fill, line style, fib levels, lock/hide) that does
      -- not warrant a column each, and which grows as tools are added.
      ALTER TABLE drawings ADD COLUMN props TEXT NOT NULL DEFAULT '{}';
    `,
  },
  {
    version: 3,
    name: 'earnings report cache',
    up: `
      -- Past earnings announcements, drawn on the chart as 'E' markers.
      -- Rewritten wholesale per symbol on refresh, so the two feeds behind it
      -- cannot accumulate near-duplicate rows for the same quarter.
      CREATE TABLE earnings (
        symbol           TEXT    NOT NULL,
        ts               INTEGER NOT NULL,
        source           TEXT    NOT NULL DEFAULT 'filing',
        fiscal_quarter   TEXT,
        eps_actual       REAL,
        eps_estimate     REAL,
        surprise_percent REAL,
        form             TEXT,
        PRIMARY KEY (symbol, ts)
      ) WITHOUT ROWID;

      -- Separate from the rows themselves so that "we checked, this symbol has
      -- no earnings" is remembered too. Indices and ETFs would otherwise be
      -- re-fetched on every chart open, forever.
      CREATE TABLE earnings_meta (
        symbol     TEXT PRIMARY KEY,
        fetched_at INTEGER NOT NULL,
        row_count  INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
];

/**
 * Open (and migrate) the database.
 *
 * WAL mode lets the alert engine write events while the renderer reads, without
 * either blocking the other.
 */
export function openDatabase(userDataDir: string): DB {
  if (db) return db;

  fs.mkdirSync(userDataDir, { recursive: true });
  const file = path.join(userDataDir, 'marketlab.db');
  const conn = new Database(file);

  conn.pragma('journal_mode = WAL');
  conn.pragma('synchronous = NORMAL');
  conn.pragma('foreign_keys = ON');

  migrate(conn);
  db = conn;
  return db;
}

function migrate(conn: DB): void {
  conn.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);

  const applied = new Set(
    conn.prepare('SELECT version FROM schema_migrations').all().map((r: any) => r.version as number),
  );

  const record = conn.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    // Each migration is atomic: a failure leaves the DB at the prior version
    // rather than half-applied.
    conn.transaction(() => {
      conn.exec(m.up);
      record.run(m.version, m.name, Math.floor(Date.now() / 1000));
    })();
    console.log(`[db] applied migration ${m.version}: ${m.name}`);
  }
}

export function getDatabase(): DB {
  if (!db) throw new Error('Database not opened. Call openDatabase() during app startup.');
  return db;
}

export function closeDatabase(): void {
  db?.close();
  db = null;
}

// ---------------------------------------------------------------------------
// Settings helpers — a simple typed key/value layer over the settings table
// ---------------------------------------------------------------------------

export function getSetting<T>(key: string, fallback: T): T {
  const row = getDatabase().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: unknown): void {
  getDatabase()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}
