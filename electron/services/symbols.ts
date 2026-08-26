/**
 * Symbol search.
 *
 * The point of difference from a plain API passthrough is that your own
 * history ranks first. After a week of use the symbols you actually watch are
 * one keystroke away, and they resolve instantly with no network round-trip.
 */

import type { SearchResult } from '../../shared/types';
import { getDatabase } from './db';
import { searchSymbols as remoteSearch } from './market-data';

/** Indices and popular ETFs worth offering before any history exists. */
const SEEDED: { symbol: string; name: string; exchange: string; quoteType: SearchResult['quoteType'] }[] = [
  // Israel
  { symbol: '^TA125.TA', name: 'TA-125 Index', exchange: 'Tel Aviv', quoteType: 'INDEX' },
  { symbol: 'TA35.TA', name: 'TA-35 Index', exchange: 'Tel Aviv', quoteType: 'INDEX' },
  { symbol: 'TA90.TA', name: 'TA-90 Index', exchange: 'Tel Aviv', quoteType: 'INDEX' },
  // TASE sector indices (TA-Banks, TA-Insurance) are deliberately absent:
  // Yahoo returns nothing for them in any spelling, so seeding them here would
  // offer a suggestion that resolves to an empty chart.
  { symbol: 'TEVA.TA', name: 'Teva Pharmaceutical Industries', exchange: 'Tel Aviv', quoteType: 'EQUITY' },
  { symbol: 'POLI.TA', name: 'Bank Hapoalim', exchange: 'Tel Aviv', quoteType: 'EQUITY' },
  { symbol: 'LUMI.TA', name: 'Bank Leumi', exchange: 'Tel Aviv', quoteType: 'EQUITY' },
  { symbol: 'NICE.TA', name: 'NICE Ltd', exchange: 'Tel Aviv', quoteType: 'EQUITY' },
  { symbol: 'ELAL.TA', name: 'El Al Israel Airlines', exchange: 'Tel Aviv', quoteType: 'EQUITY' },

  // US indices
  { symbol: '^GSPC', name: 'S&P 500', exchange: 'SNP', quoteType: 'INDEX' },
  { symbol: '^IXIC', name: 'NASDAQ Composite', exchange: 'Nasdaq', quoteType: 'INDEX' },
  { symbol: '^DJI', name: 'Dow Jones Industrial Average', exchange: 'DJI', quoteType: 'INDEX' },
  { symbol: '^RUT', name: 'Russell 2000', exchange: 'Russell', quoteType: 'INDEX' },
  { symbol: '^VIX', name: 'CBOE Volatility Index', exchange: 'CBOE', quoteType: 'INDEX' },

  // International indices
  { symbol: '^GDAXI', name: 'DAX', exchange: 'XETRA', quoteType: 'INDEX' },
  { symbol: '^FTSE', name: 'FTSE 100', exchange: 'London', quoteType: 'INDEX' },
  { symbol: '^N225', name: 'Nikkei 225', exchange: 'Osaka', quoteType: 'INDEX' },
  { symbol: '^HSI', name: 'Hang Seng Index', exchange: 'Hong Kong', quoteType: 'INDEX' },
  { symbol: '^STOXX50E', name: 'EURO STOXX 50', exchange: 'Euronext', quoteType: 'INDEX' },

  // Core ETFs
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', exchange: 'NYSE Arca', quoteType: 'ETF' },
  { symbol: 'QQQ', name: 'Invesco QQQ Trust', exchange: 'Nasdaq', quoteType: 'ETF' },
  { symbol: 'VTI', name: 'Vanguard Total Stock Market ETF', exchange: 'NYSE Arca', quoteType: 'ETF' },
  { symbol: 'IWM', name: 'iShares Russell 2000 ETF', exchange: 'NYSE Arca', quoteType: 'ETF' },
  { symbol: 'VOO', name: 'Vanguard S&P 500 ETF', exchange: 'NYSE Arca', quoteType: 'ETF' },
];

/**
 * Recency x frequency score.
 *
 * Frequency uses log so a symbol looked up 100 times does not permanently
 * outrank one you started following yesterday; recency decays with a ~10 day
 * half-life so the list tracks what you are working on now.
 */
function historyScore(hitCount: number, lastUsed: number, now: number): number {
  const ageDays = Math.max(0, (now - lastUsed) / 86400);
  const recency = Math.exp(-ageDays / 10);
  return (1 + Math.log1p(hitCount)) * (0.25 + recency);
}

function matches(query: string, symbol: string, name: string): boolean {
  const q = query.toLowerCase();
  return symbol.toLowerCase().includes(q) || name.toLowerCase().includes(q);
}

/**
 * Search across the user's history, the local symbol cache, a seeded list of
 * indices/ETFs, and finally Yahoo.
 *
 * Local sources answer instantly; the remote call only fills in what local
 * knowledge does not already cover. A remote failure degrades to local-only
 * results rather than an error, so search still works offline.
 */
export async function searchAll(query: string): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) return recentAsResults(12);

  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);
  const out = new Map<string, SearchResult>();

  // 1. The user's own history, scored.
  const history = db
    .prepare('SELECT symbol, hit_count AS hitCount, last_used AS lastUsed FROM search_history')
    .all() as { symbol: string; hitCount: number; lastUsed: number }[];

  const cachedMeta = new Map(
    (
      db.prepare('SELECT symbol, long_name AS name, exchange, quote_type AS quoteType FROM symbols').all() as {
        symbol: string; name: string; exchange: string; quoteType: SearchResult['quoteType'];
      }[]
    ).map((r) => [r.symbol, r]),
  );

  for (const h of history) {
    const meta = cachedMeta.get(h.symbol);
    if (!matches(q, h.symbol, meta?.name ?? '')) continue;
    out.set(h.symbol, {
      symbol: h.symbol,
      name: meta?.name ?? h.symbol,
      exchange: meta?.exchange ?? '',
      quoteType: meta?.quoteType ?? 'OTHER',
      origin: 'history',
      // Offset keeps history above every non-history hit.
      score: 1000 + historyScore(h.hitCount, h.lastUsed, now),
    });
  }

  // 2. Symbols we have metadata for but no search history.
  for (const [symbol, meta] of cachedMeta) {
    if (out.has(symbol) || !matches(q, symbol, meta.name)) continue;
    out.set(symbol, { symbol, name: meta.name, exchange: meta.exchange, quoteType: meta.quoteType, origin: 'cache', score: 500 });
  }

  // 3. Seeded indices and ETFs, so a fresh install can find ^GSPC or TA-35.
  for (const s of SEEDED) {
    if (out.has(s.symbol) || !matches(q, s.symbol, s.name)) continue;
    out.set(s.symbol, { ...s, origin: 'cache', score: 400 });
  }

  // 4. Remote, to cover everything we have never seen.
  try {
    for (const r of await remoteSearch(q)) {
      if (out.has(r.symbol)) continue;
      out.set(r.symbol, r);
    }
  } catch {
    // Offline: local results stand on their own.
  }

  return rankByTicker(q, [...out.values()]).slice(0, 25);
}

/**
 * Final ranking pass: what you typed should be what you get.
 *
 * Each source scores on its own scale — history by recency, Yahoo by its own
 * relevance — and Yahoo's is unreliable for exact tickers: searching "MSFT"
 * returns MSFO above MSFT. Applying the ticker boost here, after every source
 * has contributed, is what makes an exact match win regardless of where it came
 * from. Boosting inside one branch (as this used to) only fixed that branch.
 *
 * The suffix strip means typing "TEVA" ranks TEVA.TA as an exact hit, which is
 * what someone watching the Tel Aviv listing means.
 */
function rankByTicker(query: string, results: SearchResult[]): SearchResult[] {
  const q = query.trim().toLowerCase();
  const base = (symbol: string) => symbol.toLowerCase().split('.')[0];

  const scored = results.map((r) => {
    const symbol = r.symbol.toLowerCase();
    // Literal match beats suffix-stripped match, so typing "TEVA" gives the US
    // listing and "TEVA.TA" gives the Tel Aviv one — what you type is what you
    // get, rather than the venue we happen to have seeded.
    let boost = 0;
    if (symbol === q) boost = 2000;
    else if (base(r.symbol) === q) boost = 1500;
    else if (symbol.startsWith(q) || base(r.symbol).startsWith(q)) boost = 600;
    return { r, rank: r.score + boost };
  });

  return scored
    .sort((a, b) => b.rank - a.rank || a.r.symbol.length - b.r.symbol.length || a.r.symbol.localeCompare(b.r.symbol))
    .map((s) => s.r);
}

/** Most recently looked-up symbols, for an empty search box. */
export function recentAsResults(limit: number): SearchResult[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT h.symbol, h.hit_count AS hitCount, h.last_used AS lastUsed,
              s.long_name AS name, s.exchange, s.quote_type AS quoteType
       FROM search_history h
       LEFT JOIN symbols s ON s.symbol = h.symbol
       ORDER BY h.last_used DESC LIMIT ?`,
    )
    .all(limit) as any[];

  const now = Math.floor(Date.now() / 1000);
  return rows.map((r) => ({
    symbol: r.symbol,
    name: r.name ?? r.symbol,
    exchange: r.exchange ?? '',
    quoteType: r.quoteType ?? 'OTHER',
    origin: 'history' as const,
    score: historyScore(r.hitCount, r.lastUsed, now),
  }));
}

export function recordSearch(symbol: string): void {
  const clean = symbol.trim().toUpperCase();
  if (!clean) return;
  getDatabase()
    .prepare(
      `INSERT INTO search_history (symbol, hit_count, last_used) VALUES (?, 1, ?)
       ON CONFLICT(symbol) DO UPDATE SET hit_count = hit_count + 1, last_used = excluded.last_used`,
    )
    .run(clean, Math.floor(Date.now() / 1000));
}
