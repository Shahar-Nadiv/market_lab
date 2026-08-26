/**
 * Phase 0 acceptance test: migrations run, writes land, and data survives a
 * full close/reopen cycle.
 *
 * Run with Electron's bundled Node so the better-sqlite3 native binding
 * matches the ABI it was rebuilt for:
 *   ELECTRON_RUN_AS_NODE=1 npx electron scripts/smoke-db.js
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const { openDatabase, closeDatabase, getDatabase, getSetting, setSetting } = require('../dist/electron/services/db');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketlab-smoke-'));
let failures = 0;
/** Filled in by the migration check, then asserted stable across a restart. */
let MIGRATION_COUNT = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${label}\n       ${e.message}`);
  }
}

console.log(`\nPhase 0 smoke test  (${dir})\n`);

// --- first session ---------------------------------------------------------
openDatabase(dir);

check('every migration recorded exactly once, in order', () => {
  const rows = getDatabase().prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
  assert.ok(rows.length >= 1, 'no migrations applied');
  // Versions must be a dense 1..N run: a gap means a migration was renumbered
  // or dropped, which would leave existing installs unable to catch up.
  rows.forEach((r, i) => assert.strictEqual(r.version, i + 1, `migration ${i + 1} missing or misnumbered`));
  MIGRATION_COUNT = rows.length;
});

check('all tables created', () => {
  const names = getDatabase()
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  for (const t of [
    'settings', 'symbols', 'candles', 'series_meta', 'search_history',
    'watchlists', 'watchlist_items', 'scripts', 'script_versions',
    'chart_layouts', 'chart_indicators', 'drawings', 'alerts', 'alert_events',
  ]) {
    assert.ok(names.includes(t), `missing table: ${t}`);
  }
});

check('WAL mode active', () => {
  const mode = getDatabase().pragma('journal_mode', { simple: true });
  assert.strictEqual(String(mode).toLowerCase(), 'wal');
});

check('settings write', () => {
  setSetting('theme', 'light');
  setSetting('defaultInterval', '1wk');
  assert.strictEqual(getSetting('theme', 'dark'), 'light');
});

check('search history upsert increments', () => {
  const db = getDatabase();
  const stmt = db.prepare(
    `INSERT INTO search_history (symbol, hit_count, last_used) VALUES (?, 1, ?)
     ON CONFLICT(symbol) DO UPDATE SET hit_count = hit_count + 1, last_used = excluded.last_used`,
  );
  stmt.run('TEVA.TA', 1000);
  stmt.run('TEVA.TA', 2000);
  stmt.run('AAPL', 1500);
  const row = db.prepare('SELECT hit_count, last_used FROM search_history WHERE symbol = ?').get('TEVA.TA');
  assert.strictEqual(row.hit_count, 2, 'hit_count should increment on re-search');
  assert.strictEqual(row.last_used, 2000);
});

check('candle upsert is idempotent', () => {
  const db = getDatabase();
  const ins = db.prepare(
    `INSERT INTO candles (symbol, interval, ts, open, high, low, close, volume, adj_close)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol, interval, ts) DO UPDATE SET close = excluded.close`,
  );
  ins.run('AAPL', '1d', 1000, 1, 2, 0.5, 1.5, 100, 1.5);
  ins.run('AAPL', '1d', 1000, 1, 2, 0.5, 9.9, 100, 9.9);
  const rows = db.prepare('SELECT close FROM candles WHERE symbol=? AND interval=?').all('AAPL', '1d');
  assert.strictEqual(rows.length, 1, 're-inserting the same bar must not duplicate it');
  assert.strictEqual(rows[0].close, 9.9, 'later fetch should overwrite the bar');
});

check('watchlist cascade delete removes items', () => {
  const db = getDatabase();
  const wl = db.prepare('INSERT INTO watchlists (name, sort_order) VALUES (?, 0)').run('Test');
  db.prepare('INSERT INTO watchlist_items (watchlist_id, symbol, sort_order) VALUES (?, ?, 0)')
    .run(wl.lastInsertRowid, 'SPY');
  db.prepare('DELETE FROM watchlists WHERE id = ?').run(wl.lastInsertRowid);
  const left = db.prepare('SELECT COUNT(*) AS n FROM watchlist_items WHERE watchlist_id = ?')
    .get(wl.lastInsertRowid);
  assert.strictEqual(left.n, 0, 'foreign_keys pragma should cascade the delete');
});

closeDatabase();

// --- second session: the part that actually matters ------------------------
openDatabase(dir);

check('settings survive restart', () => {
  assert.strictEqual(getSetting('theme', 'dark'), 'light');
  assert.strictEqual(getSetting('defaultInterval', '1d'), '1wk');
});

check('search history survives restart', () => {
  const rows = getDatabase().prepare('SELECT symbol, hit_count FROM search_history ORDER BY symbol').all();
  assert.deepStrictEqual(rows, [
    { symbol: 'AAPL', hit_count: 1 },
    { symbol: 'TEVA.TA', hit_count: 2 },
  ]);
});

check('migrations do not re-run', () => {
  const n = getDatabase().prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n;
  assert.strictEqual(n, MIGRATION_COUNT, 'reopening must not re-apply migrations');
});

check('drawings carry their style props column', () => {
  const cols = getDatabase().prepare('PRAGMA table_info(drawings)').all().map((c) => c.name);
  assert.ok(cols.includes('props'), 'migration 2 should have added drawings.props');
});

check('a drawing round-trips with its points and props', () => {
  const db = getDatabase();
  const points = JSON.stringify([{ time: 1000, price: 12.5 }, { time: 2000, price: 15.25 }]);
  const props = JSON.stringify({ lineStyle: 'dashed', levels: [0, 0.618, 1] });
  db.prepare(
    `INSERT INTO drawings (symbol, tool, points, color, line_width, text, props, created_at)
     VALUES ('SPY', 'fib_retracement', ?, '#2962ff', 2, '', ?, 1000)`,
  ).run(points, props);
  const row = db.prepare('SELECT points, props FROM drawings WHERE symbol = ?').get('SPY');
  assert.deepStrictEqual(JSON.parse(row.points)[1], { time: 2000, price: 15.25 });
  assert.deepStrictEqual(JSON.parse(row.props).levels, [0, 0.618, 1]);
});

closeDatabase();
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`);
process.exit(failures === 0 ? 0 : 1);
