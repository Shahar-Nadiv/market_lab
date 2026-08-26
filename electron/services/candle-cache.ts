/**
 * OHLCV cache: SQLite-backed, incremental, and offline-tolerant.
 *
 * Two properties matter here:
 *   - We only ever fetch the *gap* between what we have and now, so a chart
 *     you open daily costs one small request instead of a full backfill.
 *   - If the network is gone, cached bars are returned rather than an error.
 *     Charts, indicators and scripts all keep working; you just stop getting
 *     new data.
 */

import type { Candle, Interval, SymbolMeta } from '../../shared/types';
import { isIntraday } from '../../shared/types';
import {
  exchangeByCode,
  exchangeFromSymbol,
  isMarketOpen,
  isUnknownExchange,
  observedTradingDays,
} from '../../shared/exchanges';
import { getDatabase } from './db';
import { fetchCandles, fetchCandlesStooq, MAX_LOOKBACK_DAYS } from './market-data';

const DAY = 86400;

/** 1970-01-02, the earliest period1 Yahoo reliably accepts. */
const EPOCH_FLOOR_MS = 86400 * 1000;

/** How long cached bars stay fresh, by interval, while the market is open. */
const TTL_SECONDS: Record<Interval, number> = {
  '1m': 60,
  '5m': 120,
  '15m': 300,
  '30m': 300,
  '1h': 600,
  '1d': 3600,
  '1wk': 6 * 3600,
  '1mo': 24 * 3600,
};

export interface LoadResult {
  candles: Candle[];
  source: 'cache' | 'yahoo' | 'stooq';
  /** Set when we served stale cache because the network failed. */
  warning?: string;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function readCached(symbol: string, interval: Interval): Candle[] {
  return getDatabase()
    .prepare(
      `SELECT ts AS time, open, high, low, close, volume, adj_close AS adjClose
       FROM candles WHERE symbol = ? AND interval = ? ORDER BY ts`,
    )
    .all(symbol, interval) as Candle[];
}

function readSeriesMeta(symbol: string, interval: Interval): { lastTs: number; fetchedAt: number } | null {
  const row = getDatabase()
    .prepare('SELECT last_ts AS lastTs, fetched_at AS fetchedAt FROM series_meta WHERE symbol = ? AND interval = ?')
    .get(symbol, interval) as { lastTs: number | null; fetchedAt: number } | undefined;
  if (!row || row.lastTs == null) return null;
  return { lastTs: row.lastTs, fetchedAt: row.fetchedAt };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function writeCandles(symbol: string, interval: Interval, candles: Candle[]): void {
  if (candles.length === 0) return;
  const db = getDatabase();
  const stmt = db.prepare(
    `INSERT INTO candles (symbol, interval, ts, open, high, low, close, volume, adj_close)
     VALUES (@symbol, @interval, @ts, @open, @high, @low, @close, @volume, @adjClose)
     ON CONFLICT(symbol, interval, ts) DO UPDATE SET
       open = excluded.open, high = excluded.high, low = excluded.low,
       close = excluded.close, volume = excluded.volume, adj_close = excluded.adj_close`,
  );

  // One transaction for the whole batch: a 20-year daily backfill is ~5000
  // rows and would otherwise be 5000 separate fsyncs.
  db.transaction((rows: Candle[]) => {
    for (const c of rows) {
      stmt.run({ symbol, interval, ts: c.time, ...c, adjClose: c.adjClose });
    }
  })(candles);

  const agg = db
    .prepare('SELECT MIN(ts) AS first, MAX(ts) AS last, COUNT(*) AS n FROM candles WHERE symbol = ? AND interval = ?')
    .get(symbol, interval) as { first: number; last: number; n: number };

  db.prepare(
    `INSERT INTO series_meta (symbol, interval, first_ts, last_ts, fetched_at, bar_count)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol, interval) DO UPDATE SET
       first_ts = excluded.first_ts, last_ts = excluded.last_ts,
       fetched_at = excluded.fetched_at, bar_count = excluded.bar_count`,
  ).run(symbol, interval, agg.first, agg.last, Math.floor(Date.now() / 1000), agg.n);
}

export function upsertSymbolMeta(meta: SymbolMeta): void {
  getDatabase()
    .prepare(
      `INSERT INTO symbols (symbol, short_name, long_name, quote_type, exchange,
                            raw_currency, display_currency, price_divisor, sector, industry, updated_at)
       VALUES (@symbol, @shortName, @longName, @quoteType, @exchange,
               @rawCurrency, @displayCurrency, @priceDivisor, @sector, @industry, @updatedAt)
       ON CONFLICT(symbol) DO UPDATE SET
         short_name = excluded.short_name, long_name = excluded.long_name,
         quote_type = excluded.quote_type, exchange = excluded.exchange,
         raw_currency = excluded.raw_currency, display_currency = excluded.display_currency,
         price_divisor = excluded.price_divisor, sector = excluded.sector,
         industry = excluded.industry, updated_at = excluded.updated_at`,
    )
    .run({ ...meta, sector: meta.sector ?? null, industry: meta.industry ?? null });
}

export function readSymbolMeta(symbol: string): SymbolMeta | null {
  const row = getDatabase()
    .prepare(
      `SELECT symbol, short_name AS shortName, long_name AS longName, quote_type AS quoteType,
              exchange, raw_currency AS rawCurrency, display_currency AS displayCurrency,
              price_divisor AS priceDivisor, sector, industry, updated_at AS updatedAt
       FROM symbols WHERE symbol = ?`,
    )
    .get(symbol) as SymbolMeta | undefined;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

/**
 * Decide whether cached bars need refreshing.
 *
 * The important case is daily bars outside market hours: once a session has
 * closed and we hold its bar, there is nothing new to fetch until the next
 * session, so a chart opened repeatedly over a weekend costs zero requests.
 */
function isStale(symbol: string, interval: Interval, cached: Candle[]): boolean {
  const meta = readSeriesMeta(symbol, interval);
  if (!meta || cached.length === 0) return true;

  const now = Math.floor(Date.now() / 1000);
  const age = now - meta.fetchedAt;
  if (age < 30) return false; // debounce rapid re-opens

  const symbolMeta = readSymbolMeta(symbol);
  // Same guard as the alert engine: an UNKNOWN exchange is always "open" and
  // would defeat the whole out-of-hours staleness policy.
  const exchange = symbolMeta && !isUnknownExchange(symbolMeta.exchange)
    ? exchangeByCode(symbolMeta.exchange)
    : exchangeFromSymbol(symbol);
  const tradingDays = observedTradingDays(cached, exchange.timezone, exchange.defaultTradingDays);
  const open = isMarketOpen(exchange, tradingDays, now);

  if (open) return age > TTL_SECONDS[interval];

  // Market closed. For daily+ bars, we are current once we hold a bar from the
  // most recent session; re-check at most hourly to catch late-posted data.
  if (!isIntraday(interval)) {
    const barAge = now - meta.lastTs;
    if (barAge < 3 * DAY) return age > 3600;
    // A long gap means either a real holiday stretch or a symbol we have not
    // opened in a while — worth one request.
    return age > 6 * 3600;
  }

  // Intraday outside hours never gains new bars; refresh sparingly.
  return age > 4 * 3600;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Load bars for a symbol, fetching only what the cache is missing.
 *
 * Never throws on network failure: if we hold any cached bars they are
 * returned with a warning, because a stale chart beats no chart.
 */
export async function loadCandles(
  symbol: string,
  interval: Interval,
  opts: { force?: boolean } = {},
): Promise<LoadResult> {
  const cached = readCached(symbol, interval);

  if (!opts.force && cached.length > 0 && !isStale(symbol, interval, cached)) {
    return { candles: cached, source: 'cache' };
  }

  const now = new Date();
  const maxLookback = MAX_LOOKBACK_DAYS[interval];
  // Yahoo's intraday caps are exclusive: asking for exactly 60 days of 15m bars
  // is rejected outright ("must be within the last 60 days") rather than
  // trimmed, which fails the whole fetch. Back off half a day so the request
  // sits comfortably inside the window despite clock skew and request latency.
  // Daily and coarser use a deliberately huge lookback meaning "everything",
  // where the margin is irrelevant.
  const INTRADAY_MARGIN_DAYS = 0.5;
  const requestDays = maxLookback < 3650 ? maxLookback - INTRADAY_MARGIN_DAYS : maxLookback;
  // Clamp to just after the Unix epoch. That huge daily lookback naively
  // subtracts to a pre-1970 date — Yahoo rejects those and quietly returns a
  // stub range instead of full history.
  const earliestAllowed = new Date(
    Math.max(EPOCH_FLOOR_MS, now.getTime() - requestDays * DAY * 1000),
  );

  // Incremental: start a few bars before the last one we hold so the most
  // recent (possibly still-forming) bar gets corrected rather than frozen.
  let from = earliestAllowed;
  if (cached.length > 0 && !opts.force) {
    const overlap = isIntraday(interval) ? 3 * DAY : 10 * DAY;
    const incremental = new Date((cached[cached.length - 1].time - overlap) * 1000);
    if (incremental > from) from = incremental;
  }

  try {
    const res = await fetchCandles(symbol, interval, from, now);
    if (res.candles.length > 0) {
      writeCandles(symbol, interval, res.candles);
      // Chart metadata is the cheapest reliable source of currency and
      // exchange, so record it immediately rather than blocking on a separate
      // quoteSummary call. It carries no company name, though — `updatedAt: 0`
      // marks the row as a placeholder so the metadata path still fetches the
      // real names instead of treating this stub as fresh.
      if (!readSymbolMeta(symbol)) {
        upsertSymbolMeta({
          symbol,
          shortName: symbol,
          longName: symbol,
          quoteType: res.meta.quoteType,
          exchange: res.meta.exchange,
          rawCurrency: res.meta.rawCurrency,
          displayCurrency: res.meta.displayCurrency,
          priceDivisor: res.meta.priceDivisor,
          updatedAt: 0,
        });
      }
    }
    return { candles: readCached(symbol, interval), source: 'yahoo' };
  } catch (yahooErr) {
    const message = yahooErr instanceof Error ? yahooErr.message : String(yahooErr);

    // A bad ticker is a real error the user needs to see, not a network blip
    // to paper over with a fallback.
    if (/No data found|delisted|Not Found|404/i.test(message) && cached.length === 0) {
      throw new Error(`Unknown symbol: ${symbol}`);
    }

    if (interval === '1d') {
      try {
        const stooq = await fetchCandlesStooq(symbol);
        if (stooq?.length) {
          writeCandles(symbol, interval, stooq);
          return {
            candles: readCached(symbol, interval),
            source: 'stooq',
            warning: 'Yahoo unavailable — daily bars served from Stooq.',
          };
        }
      } catch {
        // Fallback failure is not interesting; the cache path below covers it.
      }
    }

    if (cached.length > 0) {
      return { candles: cached, source: 'cache', warning: `Offline — showing cached data. (${message})` };
    }
    throw yahooErr;
  }
}

/** Bars available for a symbol without touching the network. */
export function cachedCandles(symbol: string, interval: Interval): Candle[] {
  return readCached(symbol, interval);
}
