/**
 * Earnings-date cache.
 *
 * Same shape as the candle cache and for the same reasons: SQLite-backed,
 * cache-first, and it never throws on a network failure — a chart that loses
 * its `E` markers because the wifi dropped would be a worse outcome than
 * showing yesterday's set.
 *
 * The refresh interval is generous because the underlying facts barely move:
 * a company announces four times a year, and a past announcement's date never
 * changes at all.
 */

import type { EarningsEvent } from '../../shared/types';
import { getDatabase } from './db';
import { fetchEarnings } from './market-data';

/**
 * How long a symbol's earnings list stays fresh.
 *
 * Half a day means a chart left open across a reporting evening picks up the
 * new quarter by morning, without the app asking Yahoo about a company's
 * quarterly calendar every time you glance at it.
 */
const TTL_SECONDS = 12 * 3600;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function readCached(symbol: string): EarningsEvent[] {
  const rows = getDatabase()
    .prepare(
      `SELECT ts AS time, source, fiscal_quarter AS fiscalQuarter, eps_actual AS epsActual,
              eps_estimate AS epsEstimate, surprise_percent AS surprisePercent, form
       FROM earnings WHERE symbol = ? ORDER BY ts`,
    )
    .all(symbol) as any[];

  // SQLite hands back nulls where the type says "absent"; strip them so the
  // renderer's `!= null` checks and the JSON that crosses IPC stay honest.
  return rows.map((r) => ({
    time: r.time,
    source: r.source === 'reported' ? 'reported' : 'filing',
    fiscalQuarter: r.fiscalQuarter ?? undefined,
    epsActual: r.epsActual ?? undefined,
    epsEstimate: r.epsEstimate ?? undefined,
    surprisePercent: r.surprisePercent ?? undefined,
    form: r.form ?? undefined,
  }));
}

function readFetchedAt(symbol: string): number | null {
  const row = getDatabase()
    .prepare('SELECT fetched_at AS fetchedAt FROM earnings_meta WHERE symbol = ?')
    .get(symbol) as { fetchedAt: number } | undefined;
  return row?.fetchedAt ?? null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Replace a symbol's stored events wholesale.
 *
 * Not an upsert: a quarter first seen through its SEC filing date is later
 * superseded by the exact reported date, which is a *different* timestamp and
 * therefore a different primary key. Merging would leave both, and the chart
 * would grow a second `E` a day after the first.
 */
function writeEarnings(symbol: string, events: EarningsEvent[]): void {
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);

  const insert = db.prepare(
    `INSERT INTO earnings (symbol, ts, source, fiscal_quarter, eps_actual, eps_estimate, surprise_percent, form)
     VALUES (@symbol, @ts, @source, @fiscalQuarter, @epsActual, @epsEstimate, @surprisePercent, @form)
     ON CONFLICT(symbol, ts) DO UPDATE SET
       source = excluded.source, fiscal_quarter = excluded.fiscal_quarter,
       eps_actual = excluded.eps_actual, eps_estimate = excluded.eps_estimate,
       surprise_percent = excluded.surprise_percent, form = excluded.form`,
  );

  db.transaction(() => {
    db.prepare('DELETE FROM earnings WHERE symbol = ?').run(symbol);
    for (const e of events) {
      insert.run({
        symbol,
        ts: e.time,
        source: e.source,
        fiscalQuarter: e.fiscalQuarter ?? null,
        epsActual: e.epsActual ?? null,
        epsEstimate: e.epsEstimate ?? null,
        surprisePercent: e.surprisePercent ?? null,
        form: e.form ?? null,
      });
    }
    db.prepare(
      `INSERT INTO earnings_meta (symbol, fetched_at, row_count) VALUES (?, ?, ?)
       ON CONFLICT(symbol) DO UPDATE SET fetched_at = excluded.fetched_at, row_count = excluded.row_count`,
    ).run(symbol, now, events.length);
  })();
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Earnings announcements for a symbol, fetched only when the cache has aged out.
 *
 * An empty array is a real answer, not a miss: indices, ETFs, FX and crypto
 * report nothing, and `earnings_meta` remembers that so they are not re-checked
 * on every chart open.
 */
export async function loadEarnings(
  symbol: string,
  opts: { force?: boolean } = {},
): Promise<EarningsEvent[]> {
  const clean = symbol.trim().toUpperCase();
  if (!clean) return [];

  const fetchedAt = readFetchedAt(clean);
  const fresh = fetchedAt != null && Math.floor(Date.now() / 1000) - fetchedAt < TTL_SECONDS;
  if (!opts.force && fresh) return readCached(clean);

  try {
    const events = await fetchEarnings(clean);
    writeEarnings(clean, events);
    return events;
  } catch {
    // Offline, or Yahoo having a moment. Whatever we hold is still correct —
    // past announcement dates do not change.
    return readCached(clean);
  }
}
