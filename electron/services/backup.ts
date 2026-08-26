/**
 * Backup and restore of the app's local memory as a single JSON bundle.
 *
 * Everything you built is included — watchlists, search history, scripts and
 * their edit history, layouts, drawings, alerts and the fired-alert log. The
 * candle cache is deliberately excluded: it is regenerable from the feed, and
 * including it would turn a small readable file into a large opaque one.
 *
 * Restore replaces rather than merges, inside one transaction. Merging would
 * mean inventing conflict rules for every table (does an imported watchlist
 * named "Tech" join the existing one or sit beside it?), and a half-applied
 * import is worse than a refused one.
 */

import { getDatabase } from './db';

/** Bump when the bundle's shape changes in a way an older reader can't handle. */
export const BACKUP_VERSION = 1;

/**
 * Parent-first order. Import inserts along it and deletes against it reversed,
 * so foreign keys are satisfied in both directions.
 */
const TABLES = [
  'settings',
  'symbols',
  'search_history',
  'watchlists',
  'watchlist_items',
  'scripts',
  'script_versions',
  'chart_layouts',
  'chart_indicators',
  'drawings',
  'alerts',
  'alert_events',
] as const;

export interface BackupBundle {
  format: 'marketlab-backup';
  version: number;
  exportedAt: number;
  tables: Record<string, Record<string, unknown>[]>;
}

export interface ImportSummary {
  /** Rows written, per table. */
  counts: Record<string, number>;
  /** Tables present in the bundle that this build does not know about. */
  skipped: string[];
}

/** Column names of a table, used to filter bundle rows against the live schema. */
function columnsOf(table: string): Set<string> {
  const rows = getDatabase().prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

export function exportBundle(): BackupBundle {
  const db = getDatabase();
  const tables: BackupBundle['tables'] = {};
  for (const table of TABLES) {
    tables[table] = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  }
  return {
    format: 'marketlab-backup',
    version: BACKUP_VERSION,
    exportedAt: Math.floor(Date.now() / 1000),
    tables,
  };
}

export function serializeBundle(bundle: BackupBundle): string {
  return JSON.stringify(bundle, null, 2);
}

/**
 * Validate a parsed bundle before it is allowed anywhere near the database.
 * Throws with a message meant to be shown to the user.
 */
export function parseBundle(text: string): BackupBundle {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (raw?.format !== 'marketlab-backup') {
    throw new Error('That file is not a MarketLab backup.');
  }
  if (typeof raw.version !== 'number' || raw.version > BACKUP_VERSION) {
    throw new Error(`This backup was written by a newer version of MarketLab (format ${raw.version}).`);
  }
  if (!raw.tables || typeof raw.tables !== 'object') {
    throw new Error('That backup is missing its table data.');
  }
  return raw as BackupBundle;
}

/**
 * Replace local data with the bundle's, atomically.
 *
 * Rows are filtered to columns this build actually has, so a bundle from a
 * slightly older or newer schema restores what it can instead of failing
 * wholesale. Unknown tables are reported rather than silently dropped.
 */
export function importBundle(bundle: BackupBundle): ImportSummary {
  const db = getDatabase();
  const counts: Record<string, number> = {};
  const known = new Set<string>(TABLES);
  const skipped = Object.keys(bundle.tables).filter((t) => !known.has(t));

  db.transaction(() => {
    // Children first, so cascades never fight explicit deletes.
    for (const table of [...TABLES].reverse()) {
      db.prepare(`DELETE FROM ${table}`).run();
    }

    for (const table of TABLES) {
      const rows = bundle.tables[table];
      if (!Array.isArray(rows) || rows.length === 0) {
        counts[table] = 0;
        continue;
      }

      const columns = columnsOf(table);
      let written = 0;
      for (const row of rows) {
        const keys = Object.keys(row).filter((k) => columns.has(k));
        if (keys.length === 0) continue;
        const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})`;
        const values: Record<string, unknown> = {};
        // better-sqlite3 binds only primitives; anything structured in a bundle
        // was a JSON string on the way out and must go back as one.
        for (const k of keys) {
          const v = (row as any)[k];
          values[k] = v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
        }
        db.prepare(sql).run(values);
        written++;
      }
      counts[table] = written;
    }
  })();

  return { counts, skipped };
}
