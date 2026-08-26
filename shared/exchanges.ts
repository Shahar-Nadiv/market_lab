/**
 * Exchange registry: timezone, currency normalization and session handling.
 *
 * Two hard-won rules are encoded here, both verified against live Yahoo data
 * during development (see `docs/DATA_NOTES.md`):
 *
 *  1. Currency normalization is driven by the **currency code the feed
 *     returns**, never by the ticker suffix. `TEVA.TA` comes back as `ILA`
 *     (agorot, 1/100 shekel) while `^TA125.TA` comes back as `ILS` (index
 *     points). A blanket "divide every .TA symbol by 100" would render the
 *     TA-125 index at 40 instead of 4032.
 *
 *  2. Trading weekdays are **observed from the data**, not hardcoded. Yahoo
 *     presents Tel Aviv sessions on a Monday–Friday grid even for years when
 *     TASE traded Sunday–Thursday, so any hardcoded weekday rule is wrong for
 *     somebody. `observedTradingDays()` derives the real pattern from cached
 *     bars; the `defaultTradingDays` below are only a cold-start fallback.
 */

import type { Candle } from './types';

export interface ExchangeInfo {
  /** Our canonical code. */
  code: string;
  label: string;
  /** Yahoo's `exchangeName` values that map to this entry. */
  yahooCodes: string[];
  /** IANA zone. Never store fixed UTC offsets — DST rules differ per country. */
  timezone: string;
  /** Cold-start fallback only; real days come from observed bars. */
  defaultTradingDays: number[];
  /** Local session open/close as minutes from midnight, for staleness checks. */
  sessionOpenMin: number;
  sessionCloseMin: number;
  /** Ticker suffix used by Yahoo, empty for US. */
  suffix: string;
}

/** Day-of-week constants matching JS `getDay()` (0 = Sunday). */
export const SUN = 0, MON = 1, TUE = 2, WED = 3, THU = 4, FRI = 5, SAT = 6;

const MON_FRI = [MON, TUE, WED, THU, FRI];

export const EXCHANGES: ExchangeInfo[] = [
  {
    code: 'TASE',
    label: 'Tel Aviv Stock Exchange',
    yahooCodes: ['TLV'],
    timezone: 'Asia/Jerusalem',
    // Yahoo serves TASE bars on a Mon-Fri grid; see note 2 above. The real
    // pattern is derived per-symbol at runtime.
    defaultTradingDays: MON_FRI,
    sessionOpenMin: 9 * 60 + 45,
    sessionCloseMin: 17 * 60 + 15,
    suffix: '.TA',
  },
  {
    code: 'NASDAQ',
    label: 'NASDAQ',
    yahooCodes: ['NMS', 'NGM', 'NCM', 'NIM'],
    timezone: 'America/New_York',
    defaultTradingDays: MON_FRI,
    sessionOpenMin: 9 * 60 + 30,
    sessionCloseMin: 16 * 60,
    suffix: '',
  },
  {
    code: 'NYSE',
    label: 'New York Stock Exchange',
    yahooCodes: ['NYQ', 'PCX', 'ASE', 'BTS', 'NYS'],
    timezone: 'America/New_York',
    defaultTradingDays: MON_FRI,
    sessionOpenMin: 9 * 60 + 30,
    sessionCloseMin: 16 * 60,
    suffix: '',
  },
  {
    code: 'INDEX_US',
    label: 'US Indices',
    yahooCodes: ['SNP', 'DJI', 'WCB', 'CGI'],
    timezone: 'America/New_York',
    defaultTradingDays: MON_FRI,
    sessionOpenMin: 9 * 60 + 30,
    sessionCloseMin: 16 * 60,
    suffix: '',
  },
  {
    code: 'XETRA',
    label: 'XETRA / Frankfurt',
    yahooCodes: ['GER', 'FRA', 'STU', 'MUN', 'BER', 'DUS', 'HAM'],
    timezone: 'Europe/Berlin',
    defaultTradingDays: MON_FRI,
    sessionOpenMin: 9 * 60,
    sessionCloseMin: 17 * 60 + 30,
    suffix: '.DE',
  },
  {
    code: 'LSE',
    label: 'London Stock Exchange',
    yahooCodes: ['LSE', 'IOB'],
    timezone: 'Europe/London',
    defaultTradingDays: MON_FRI,
    sessionOpenMin: 8 * 60,
    sessionCloseMin: 16 * 60 + 30,
    suffix: '.L',
  },
  {
    code: 'EURONEXT',
    label: 'Euronext',
    yahooCodes: ['PAR', 'AMS', 'BRU', 'LIS', 'MIL'],
    timezone: 'Europe/Paris',
    defaultTradingDays: MON_FRI,
    sessionOpenMin: 9 * 60,
    sessionCloseMin: 17 * 60 + 30,
    suffix: '.PA',
  },
  {
    code: 'TSE',
    label: 'Tokyo Stock Exchange',
    yahooCodes: ['JPX', 'TYO'],
    timezone: 'Asia/Tokyo',
    defaultTradingDays: MON_FRI,
    sessionOpenMin: 9 * 60,
    sessionCloseMin: 15 * 60,
    suffix: '.T',
  },
  {
    code: 'HKEX',
    label: 'Hong Kong Stock Exchange',
    yahooCodes: ['HKG'],
    timezone: 'Asia/Hong_Kong',
    defaultTradingDays: MON_FRI,
    sessionOpenMin: 9 * 60 + 30,
    sessionCloseMin: 16 * 60,
    suffix: '.HK',
  },
  {
    code: 'TSX',
    label: 'Toronto Stock Exchange',
    yahooCodes: ['TOR', 'VAN', 'CNQ'],
    timezone: 'America/Toronto',
    defaultTradingDays: MON_FRI,
    sessionOpenMin: 9 * 60 + 30,
    sessionCloseMin: 16 * 60,
    suffix: '.TO',
  },
  {
    code: 'ASX',
    label: 'Australian Securities Exchange',
    yahooCodes: ['ASX'],
    timezone: 'Australia/Sydney',
    defaultTradingDays: MON_FRI,
    sessionOpenMin: 10 * 60,
    sessionCloseMin: 16 * 60,
    suffix: '.AX',
  },
];

const UNKNOWN_EXCHANGE: ExchangeInfo = {
  code: 'UNKNOWN',
  label: 'Unknown',
  yahooCodes: [],
  timezone: 'UTC',
  defaultTradingDays: MON_FRI,
  sessionOpenMin: 0,
  sessionCloseMin: 24 * 60 - 1,
  suffix: '',
};

const BY_YAHOO_CODE = new Map<string, ExchangeInfo>();
for (const ex of EXCHANGES) {
  for (const yc of ex.yahooCodes) BY_YAHOO_CODE.set(yc.toUpperCase(), ex);
}

const BY_CODE = new Map<string, ExchangeInfo>(EXCHANGES.map((e) => [e.code, e]));

/** Resolve the exchange for a Yahoo `exchangeName` such as `NMS` or `TLV`. */
export function exchangeFromYahooCode(yahooCode: string | undefined): ExchangeInfo {
  if (!yahooCode) return UNKNOWN_EXCHANGE;
  return BY_YAHOO_CODE.get(yahooCode.toUpperCase()) ?? UNKNOWN_EXCHANGE;
}

/**
 * Resolve an exchange from several Yahoo fields, first match wins.
 *
 * Yahoo reports both a short code (`NMS`, `PCX`, `TLV`) and a display name
 * (`NasdaqGS`, `NYSEArca`, `Tel Aviv`), and which field carries which varies by
 * endpoint. Only the short codes are indexed here, so passing the display name
 * silently yields the catch-all UNKNOWN exchange — whose session is 00:00-23:59
 * and therefore makes every market look permanently open.
 */
export function exchangeFromYahooCodes(...codes: (string | undefined)[]): ExchangeInfo {
  for (const code of codes) {
    if (!code) continue;
    const hit = BY_YAHOO_CODE.get(code.toUpperCase());
    if (hit) return hit;
  }
  return UNKNOWN_EXCHANGE;
}

/** True when the code names no exchange we know, so callers can fall back. */
export function isUnknownExchange(code: string | undefined): boolean {
  return !code || code === UNKNOWN_EXCHANGE.code;
}

export function exchangeByCode(code: string): ExchangeInfo {
  return BY_CODE.get(code) ?? UNKNOWN_EXCHANGE;
}

/**
 * Best-effort exchange guess from the ticker alone, for cold starts before we
 * have metadata. Suffix wins; no suffix implies a US listing.
 */
export function exchangeFromSymbol(symbol: string): ExchangeInfo {
  const dot = symbol.lastIndexOf('.');
  if (dot > 0) {
    const suffix = symbol.slice(dot);
    const match = EXCHANGES.find((e) => e.suffix && e.suffix.toLowerCase() === suffix.toLowerCase());
    if (match) return match;
    return UNKNOWN_EXCHANGE;
  }
  return symbol.startsWith('^') ? exchangeByCode('INDEX_US') : exchangeByCode('NASDAQ');
}

// ---------------------------------------------------------------------------
// Currency normalization
// ---------------------------------------------------------------------------

/**
 * Sub-unit currencies: feeds quote these in 1/100 of the headline currency.
 *
 * `ILA` = Israeli agorot (TASE equities). `GBp`/`GBX` = British pence (LSE).
 * `ZAc` = South African cents. Yahoo is inconsistent about case, so we
 * compare uppercased.
 */
const SUBUNIT_CURRENCIES: Record<string, { display: string; divisor: number }> = {
  ILA: { display: 'ILS', divisor: 100 },
  GBP_PENCE: { display: 'GBP', divisor: 100 },
  GBX: { display: 'GBP', divisor: 100 },
  ZAC: { display: 'ZAR', divisor: 100 },
};

/**
 * Map a raw feed currency to the currency we display and the divisor needed
 * to get there.
 *
 * Yahoo returns `GBp` (lowercase p) for pence, which uppercases to `GBP` and
 * would collide with real pounds — so pence is detected before uppercasing.
 */
export function normalizeCurrency(rawCurrency: string | undefined): { display: string; divisor: number; raw: string } {
  const raw = rawCurrency ?? 'USD';
  if (raw === 'GBp') return { display: 'GBP', divisor: 100, raw };
  const hit = SUBUNIT_CURRENCIES[raw.toUpperCase()];
  if (hit) return { display: hit.display, divisor: hit.divisor, raw };
  return { display: raw.toUpperCase(), divisor: 1, raw };
}

/** Currency symbol for display, falling back to the ISO code. */
export function currencySymbol(code: string): string {
  const map: Record<string, string> = {
    USD: '$', ILS: '₪', EUR: '€', GBP: '£', JPY: '¥',
    CHF: 'Fr', CAD: 'C$', AUD: 'A$', HKD: 'HK$', ZAR: 'R',
  };
  return map[code.toUpperCase()] ?? code.toUpperCase() + ' ';
}

// ---------------------------------------------------------------------------
// Sessions — derived from observed data, not hardcoded calendars
// ---------------------------------------------------------------------------

/** Weekday index (0=Sun) of a UTC timestamp, evaluated in a given IANA zone. */
export function weekdayInZone(unixSeconds: number, timezone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' })
    .format(new Date(unixSeconds * 1000));
  const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
  return idx < 0 ? 1 : idx;
}

/** `YYYY-MM-DD` for a timestamp as seen in a given zone. */
export function dateKeyInZone(unixSeconds: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(unixSeconds * 1000));
}

/** Minutes past local midnight for a timestamp, in a given zone. */
export function minutesInZone(unixSeconds: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(unixSeconds * 1000));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}

/**
 * Derive which weekdays a symbol actually trades on, from its own daily bars.
 *
 * This sidesteps the whole question of what a venue's official calendar says
 * versus what the feed delivers: whatever days bars consistently appear on are
 * the days we treat as sessions. A weekday counts if it carries at least 15%
 * of the busiest weekday's bar count, which tolerates holidays without letting
 * a stray bar create a phantom session day.
 *
 * Falls back to the exchange default when given too little history to judge.
 */
export function observedTradingDays(candles: Candle[], timezone: string, fallback: number[]): number[] {
  if (candles.length < 20) return fallback;
  const counts = new Array(7).fill(0);
  for (const c of candles) counts[weekdayInZone(c.time, timezone)]++;
  const max = Math.max(...counts);
  if (max === 0) return fallback;
  const days: number[] = [];
  for (let d = 0; d < 7; d++) {
    if (counts[d] >= max * 0.15) days.push(d);
  }
  return days.length ? days : fallback;
}

/**
 * Is the venue plausibly in its regular session right now?
 *
 * Used to decide whether to poll for alerts and whether cached data should be
 * considered stale. Holiday closures are not modelled — a poll on a holiday
 * simply returns an unchanged quote, which is harmless.
 */
export function isMarketOpen(
  exchange: ExchangeInfo,
  tradingDays: number[],
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  const day = weekdayInZone(nowSeconds, exchange.timezone);
  if (!tradingDays.includes(day)) return false;
  const mins = minutesInZone(nowSeconds, exchange.timezone);
  return mins >= exchange.sessionOpenMin && mins <= exchange.sessionCloseMin;
}

/**
 * Seconds until the next session opens, for scheduling the alert poller so it
 * sleeps through nights and weekends instead of waking every minute.
 * Returns 0 when the market is currently open.
 */
export function secondsUntilNextOpen(
  exchange: ExchangeInfo,
  tradingDays: number[],
  nowSeconds: number = Math.floor(Date.now() / 1000),
): number {
  if (isMarketOpen(exchange, tradingDays, nowSeconds)) return 0;
  // Step forward in 15-minute increments up to 8 days. Cheap, and immune to
  // DST arithmetic mistakes because every probe is evaluated in the zone.
  const STEP = 15 * 60;
  for (let t = nowSeconds + STEP; t < nowSeconds + 8 * 86400; t += STEP) {
    if (isMarketOpen(exchange, tradingDays, t)) return t - nowSeconds;
  }
  return 8 * 86400;
}
