/**
 * Market data client.
 *
 * Lives in the main process because Node HTTP requests are not subject to
 * CORS — that is the whole reason this app needs no proxy server.
 *
 * Everything outbound funnels through one rate-limited queue. Yahoo throttles
 * bursts aggressively, and a 40-symbol watchlist refresh would otherwise trip
 * it within seconds.
 */

import YahooFinance from 'yahoo-finance2';
import type {
  Candle, EarningsEvent, Fundamentals, Interval, Quote, QuoteType, SearchResult, SymbolMeta,
} from '../../shared/types';
import { exchangeFromYahooCode, exchangeFromYahooCodes, normalizeCurrency } from '../../shared/exchanges';

const yf = new YahooFinance({
  // These notices print on every call and say nothing actionable.
  suppressNotices: ['yahooSurvey', 'ripHistorical'],
});

// ---------------------------------------------------------------------------
// Rate-limited request queue
// ---------------------------------------------------------------------------

const MAX_CONCURRENT = 2;
const MIN_GAP_MS = 250;

let active = 0;
let lastStart = 0;
const pending: (() => void)[] = [];

function pump(): void {
  if (active >= MAX_CONCURRENT || pending.length === 0) return;
  const wait = Math.max(0, lastStart + MIN_GAP_MS - Date.now());
  setTimeout(() => {
    const next = pending.shift();
    if (!next) return;
    active++;
    lastStart = Date.now();
    next();
  }, wait);
}

/** Run `fn` through the queue, with backoff on throttling and transient errors. */
function enqueue<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    pending.push(async () => {
      try {
        resolve(await fn());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const transient = /429|too many|503|502|504|timeout|ECONNRESET|ETIMEDOUT|socket hang up/i.test(msg);
        if (transient && retries > 0) {
          // Exponential backoff: 1s, 2s, 4s.
          const delay = 1000 * 2 ** (3 - retries);
          setTimeout(() => {
            enqueue(fn, retries - 1).then(resolve, reject);
          }, delay);
        } else {
          reject(err);
        }
      } finally {
        active--;
        pump();
      }
    });
    pump();
  });
}

// ---------------------------------------------------------------------------
// Interval handling
// ---------------------------------------------------------------------------

/**
 * How far back Yahoo will serve each interval. Requesting more silently
 * returns a short series, so the UI uses these to disable impossible
 * range/interval combinations rather than showing truncated data.
 */
export const MAX_LOOKBACK_DAYS: Record<Interval, number> = {
  '1m': 7,
  '5m': 60,
  '15m': 60,
  '30m': 60,
  '1h': 730,
  '1d': 36500,
  '1wk': 36500,
  '1mo': 36500,
};

/** Our interval names happen to match Yahoo's, except we spell one hour `1h`. */
function toYahooInterval(interval: Interval): string {
  return interval === '1h' ? '60m' : interval;
}

// ---------------------------------------------------------------------------
// Candles
// ---------------------------------------------------------------------------

export interface FetchCandlesResult {
  candles: Candle[];
  meta: {
    rawCurrency: string;
    displayCurrency: string;
    priceDivisor: number;
    exchange: string;
    timezone: string;
    quoteType: QuoteType;
  };
  source: 'yahoo' | 'stooq';
}

/**
 * Fetch OHLCV bars.
 *
 * Prices are normalized to the display currency here, at the boundary, so that
 * everything downstream — cache, indicators, alerts, chart — works in one
 * consistent unit. TASE equities arrive in agorot and are divided by 100; TASE
 * indices arrive in points and are not. See docs/DATA_NOTES.md.
 */
export async function fetchCandles(
  symbol: string,
  interval: Interval,
  from: Date,
  to: Date = new Date(),
): Promise<FetchCandlesResult> {
  const result = await enqueue(() =>
    yf.chart(symbol, {
      period1: from,
      period2: to,
      interval: toYahooInterval(interval) as any,
      // Splits and dividends drive the adjusted-close series, which is what
      // makes a 200 DMA correct across a split.
      events: 'div|split',
    }),
  );

  const meta: any = result.meta ?? {};
  const currency = normalizeCurrency(meta.currency);
  const exchange = exchangeFromYahooCode(meta.exchangeName);

  const candles: Candle[] = [];
  for (const q of result.quotes ?? []) {
    // Yahoo emits null OHLC for halted or untraded bars; they would poison
    // every indicator downstream, so drop them at ingest.
    if (q.open == null || q.high == null || q.low == null || q.close == null) continue;
    const t = Math.floor(new Date(q.date).getTime() / 1000);
    if (!Number.isFinite(t)) continue;

    const d = currency.divisor;
    candles.push({
      time: t,
      open: q.open / d,
      high: q.high / d,
      low: q.low / d,
      close: q.close / d,
      volume: q.volume ?? 0,
      adjClose: (q.adjclose ?? q.close) / d,
    });
  }

  candles.sort((a, b) => a.time - b.time);

  return {
    candles,
    meta: {
      rawCurrency: currency.raw,
      displayCurrency: currency.display,
      priceDivisor: currency.divisor,
      exchange: exchange.code,
      timezone: meta.exchangeTimezoneName ?? exchange.timezone,
      quoteType: normalizeQuoteType(meta.instrumentType),
    },
    source: 'yahoo',
  };
}

/**
 * Daily bars from Stooq, used when Yahoo is unreachable.
 *
 * Free, no key, no rate limit worth worrying about — but US-centric and daily
 * only, so it is a degraded fallback rather than a peer source. Returns null
 * when Stooq has no mapping for the symbol.
 */
export async function fetchCandlesStooq(symbol: string): Promise<Candle[] | null> {
  const mapped = toStooqSymbol(symbol);
  if (!mapped) return null;

  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(mapped)}&i=d`;
  const res = await enqueue(() => fetch(url));
  if (!res.ok) return null;

  const text = await res.text();
  // Stooq answers unknown symbols with a plain-text body, not a 404.
  if (!text.startsWith('Date,')) return null;

  const out: Candle[] = [];
  for (const line of text.trim().split('\n').slice(1)) {
    const [date, o, h, l, c, v] = line.split(',');
    const t = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
    const close = Number(c);
    if (!Number.isFinite(t) || !Number.isFinite(close)) continue;
    out.push({
      time: t,
      open: Number(o),
      high: Number(h),
      low: Number(l),
      close,
      volume: Number(v) || 0,
      adjClose: close,
    });
  }
  return out.length ? out : null;
}

function toStooqSymbol(symbol: string): string | null {
  // Stooq has no useful coverage of indices or of the exchanges we care about
  // outside the US, so restrict the fallback to plain US tickers.
  if (symbol.startsWith('^') || symbol.includes('.')) return null;
  return `${symbol.toLowerCase()}.us`;
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

/** Divide a quoted price by the currency divisor, preserving absence. */
function div(v: unknown, d: number): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v / d : undefined;
}

export async function fetchQuotes(symbols: string[]): Promise<Quote[]> {
  if (symbols.length === 0) return [];
  // Validation off for the same reason as quoteSummary: Yahoo omits fields for
  // thinly-covered symbols and the schema treats that as fatal.
  const raw = await enqueue(() => yf.quote(symbols, {}, { validateResult: false }));
  const list: any[] = Array.isArray(raw) ? raw : [raw];

  return list.filter(Boolean).map((q) => {
    const currency = normalizeCurrency(q.currency);
    const d = currency.divisor;
    const price = (q.regularMarketPrice ?? 0) / d;
    const prev = (q.regularMarketPreviousClose ?? 0) / d;
    return {
      symbol: q.symbol,
      price,
      previousClose: prev,
      change: (q.regularMarketChange ?? 0) / d,
      // Percentages are unit-free, so they must NOT be divided.
      changePercent: q.regularMarketChangePercent ?? 0,
      dayHigh: (q.regularMarketDayHigh ?? 0) / d,
      dayLow: (q.regularMarketDayLow ?? 0) / d,
      dayOpen: (q.regularMarketOpen ?? 0) / d,
      volume: q.regularMarketVolume ?? 0,
      marketCap: q.marketCap,
      fiftyTwoWeekHigh: q.fiftyTwoWeekHigh != null ? q.fiftyTwoWeekHigh / d : undefined,
      fiftyTwoWeekLow: q.fiftyTwoWeekLow != null ? q.fiftyTwoWeekLow / d : undefined,
      displayCurrency: currency.display,
      marketState: mapMarketState(q.marketState),
      exchangeTimezoneName: q.exchangeTimezoneShortName,

      hasPrePostMarket: q.hasPrePostMarketData ?? false,
      preMarketPrice: div(q.preMarketPrice, d),
      preMarketChange: div(q.preMarketChange, d),
      preMarketChangePercent: q.preMarketChangePercent,
      preMarketTime: toUnix(q.preMarketTime),
      postMarketPrice: div(q.postMarketPrice, d),
      postMarketChange: div(q.postMarketChange, d),
      postMarketChangePercent: q.postMarketChangePercent,
      postMarketTime: toUnix(q.postMarketTime),

      timestamp: Math.floor(Date.now() / 1000),
    } satisfies Quote;
  });
}

/**
 * Collapse Yahoo's six states to the four the UI distinguishes.
 *
 * `PREPRE` (overnight) and `POSTPOST` (extended hours finished) are closed —
 * mapping POSTPOST to POST, as this used to, made the UI claim after-hours
 * trading was live for the rest of the night.
 */
function mapMarketState(s: string | undefined): Quote['marketState'] {
  switch (s) {
    case 'REGULAR': return 'REGULAR';
    case 'PRE': return 'PRE';
    case 'POST': return 'POST';
    case 'PREPRE':
    case 'POSTPOST':
    case 'CLOSED':
    default: return 'CLOSED';
  }
}

// ---------------------------------------------------------------------------
// Search & metadata
// ---------------------------------------------------------------------------

export async function searchSymbols(query: string): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) return [];

  const res = await enqueue(() => yf.search(q, { newsCount: 0, quotesCount: 12 }));
  return (res.quotes ?? [])
    .filter((r: any) => r.symbol)
    .map((r: any) => ({
      symbol: r.symbol,
      name: r.longname ?? r.shortname ?? r.symbol,
      exchange: r.exchDisp ?? r.exchange ?? '',
      quoteType: normalizeQuoteType(r.quoteType),
      origin: 'remote' as const,
      score: 0,
    }));
}

export async function fetchSymbolMeta(symbol: string): Promise<SymbolMeta> {
  const res: any = await enqueue(() =>
    yf.quoteSummary(symbol, { modules: ['price', 'assetProfile'] }),
  );
  const price = res?.price ?? {};
  const profile = res?.assetProfile ?? {};
  const currency = normalizeCurrency(price.currency);
  // `exchange` carries the short code the registry indexes; `exchangeName` is
  // a display label. Preferring the label resolved every symbol to UNKNOWN.
  const exchange = exchangeFromYahooCodes(price.exchange, price.exchangeName);

  return {
    symbol,
    shortName: price.shortName ?? symbol,
    longName: price.longName ?? price.shortName ?? symbol,
    quoteType: normalizeQuoteType(price.quoteType),
    exchange: exchange.code,
    rawCurrency: currency.raw,
    displayCurrency: currency.display,
    priceDivisor: currency.divisor,
    sector: profile.sector,
    industry: profile.industry,
    updatedAt: Math.floor(Date.now() / 1000),
  };
}

/** Yahoo returns dates as Date objects or ISO strings; we store unix seconds. */
function toUnix(value: unknown): number | undefined {
  if (!value) return undefined;
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

export async function fetchFundamentals(symbol: string): Promise<Fundamentals> {
  // Modules are requested in one call — quoteSummary charges the same round
  // trip for one as for ten, and a partial panel looks broken.
  const res: any = await enqueue(() =>
    yf.quoteSummary(
      symbol,
      {
        modules: [
          'price', 'summaryDetail', 'defaultKeyStatistics', 'assetProfile',
          'financialData', 'calendarEvents', 'recommendationTrend', 'earnings',
        ],
      },
      // Schema validation is off here on purpose. yahoo-finance2 marks fields
      // like `earningsChart.quarterly[].estimate` as required, and Yahoo simply
      // omits them for symbols with thin analyst coverage — POLI.TA and most
      // TASE listings among them. Validation then throws away the *entire*
      // response, so a missing consensus figure costs the whole panel. Every
      // field below is read defensively and renders an em dash when absent,
      // which is the right failure mode; a hard error is not.
      { validateResult: false },
    ),
  );

  const price = res?.price ?? {};
  const detail = res?.summaryDetail ?? {};
  const stats = res?.defaultKeyStatistics ?? {};
  const profile = res?.assetProfile ?? {};
  const financial = res?.financialData ?? {};
  const calendar = res?.calendarEvents ?? {};
  const currency = normalizeCurrency(price.currency);
  const d = currency.divisor;

  /**
   * Normalise a *quoted price* out of the minor unit (agorot, pence).
   *
   * Only quoted prices need this. Yahoo is inconsistent about it: for a TASE
   * listing, bid/ask/close/52-week/analyst targets all arrive in agorot, but
   * market cap, dividend rate and EPS arrive already in shekels. Verified
   * against POLI.TA and LUMI.TA — see docs/DATA_NOTES.md. Applying the divisor
   * to the wrong field is silent: it just renders a number 100x off.
   */
  const p = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v / d : undefined;

  /** Fields Yahoo already reports in the major currency unit. */
  const major = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;

  // The most recent trend row is the current view; older rows are history.
  const trend = res?.recommendationTrend?.trend?.[0];
  const recommendation: Fundamentals['recommendation'] = trend
    ? {
        strongBuy: trend.strongBuy ?? 0,
        buy: trend.buy ?? 0,
        hold: trend.hold ?? 0,
        sell: trend.sell ?? 0,
        strongSell: trend.strongSell ?? 0,
        mean: financial.recommendationMean,
        key: financial.recommendationKey,
        analystCount: financial.numberOfAnalystOpinions,
      }
    : undefined;

  const quarterly: any[] = res?.earnings?.earningsChart?.quarterly ?? [];
  const earningsHistory: Fundamentals['earningsHistory'] = quarterly.map((q) => ({
    fiscalQuarter: q.fiscalQuarter ?? q.date ?? '',
    calendarQuarter: q.calendarQuarter ?? q.date,
    epsActual: q.actual,
    epsEstimate: q.estimate,
    // `surprisePct` arrives as a string here, unlike earningsHistory's fraction.
    surprisePercent: q.surprisePct != null ? Number(q.surprisePct) : undefined,
    periodEnd: toUnix(q.periodEndDate),
    reportedDate: toUnix(q.reportedDate),
  }));

  return {
    symbol,
    currency: currency.display,

    previousClose: p(price.regularMarketPreviousClose ?? detail.previousClose),
    open: p(price.regularMarketOpen ?? detail.open),
    bid: p(detail.bid),
    ask: p(detail.ask),
    bidSize: detail.bidSize,
    askSize: detail.askSize,
    dayLow: p(detail.dayLow),
    dayHigh: p(detail.dayHigh),
    volume: price.regularMarketVolume ?? detail.volume,

    fiftyTwoWeekHigh: p(detail.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: p(detail.fiftyTwoWeekLow),
    averageVolume: detail.averageVolume,
    // Already in shekels for TASE even though prices are in agorot.
    marketCap: major(detail.marketCap ?? price.marketCap),

    beta: detail.beta ?? stats.beta,
    trailingPE: detail.trailingPE,
    forwardPE: detail.forwardPE ?? stats.forwardPE,
    epsTrailing: stats.trailingEps,
    epsForward: stats.forwardEps,

    dividendRate: major(detail.dividendRate),
    // Yahoo reports yield as a fraction; present it as a percentage.
    dividendYield: detail.dividendYield != null ? detail.dividendYield * 100 : undefined,
    exDividendDate: toUnix(detail.exDividendDate ?? calendar.exDividendDate),
    dividendDate: toUnix(calendar.dividendDate),

    earningsDate: toUnix(calendar.earnings?.earningsDate?.[0]),
    earningsDateEstimated: calendar.earnings?.isEarningsDateEstimate,
    targetMeanPrice: p(financial.targetMeanPrice),
    targetHighPrice: p(financial.targetHighPrice),
    targetLowPrice: p(financial.targetLowPrice),

    recommendation,
    earningsHistory,

    sector: profile.sector,
    industry: profile.industry,
    employees: profile.fullTimeEmployees,
    description: profile.longBusinessSummary,
  };
}

// ---------------------------------------------------------------------------
// Earnings dates
// ---------------------------------------------------------------------------

/**
 * SEC forms that accompany a results announcement.
 *
 * 8-K is deliberately excluded: the earnings release *is* an 8-K, but so is
 * every board change, debt issue and executive departure, and Yahoo gives them
 * all the same generic title — there is no way to tell which 8-K is the
 * earnings one, so including them would scatter false `E` markers across the
 * chart. The periodic reports are unambiguous and land within a few days of
 * the release.
 */
const EARNINGS_FORMS = /^(10-Q|10-K|20-F|40-F|6-K)$/i;

/**
 * Two announcements of the same quarter never fall this close together, so
 * anything inside the window is the same event seen through a second source.
 */
const DEDUP_WINDOW_SEC = 10 * 86400;

/**
 * When each of a symbol's past quarters was announced.
 *
 * Two sources are merged because neither is sufficient alone. Yahoo's earnings
 * chart carries an exact announcement timestamp and the EPS beat/miss, but only
 * for the last four quarters — that is one year of markers on a chart that
 * routinely shows twenty. SEC filing dates reach back about five years and
 * cover every listed US filer, at the cost of landing one to three days after
 * the press release.
 *
 * Where they overlap the reported date wins, since it is both exact and richer.
 *
 * Symbols with no earnings at all — indices, ETFs, FX, crypto — make Yahoo
 * reject the whole request; that is an empty result here, not an error, because
 * "this instrument does not report earnings" is a perfectly ordinary answer.
 */
export async function fetchEarnings(symbol: string): Promise<EarningsEvent[]> {
  let res: any;
  try {
    res = await enqueue(() =>
      yf.quoteSummary(
        symbol,
        { modules: ['earnings', 'secFilings'] },
        // Same reasoning as fetchFundamentals: Yahoo omits fields for thinly
        // covered symbols and validation would discard the entire response
        // over one absent consensus estimate.
        { validateResult: false },
      ),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/No fundamentals data found|Not Found|404/i.test(msg)) return [];
    throw err;
  }

  const events: EarningsEvent[] = [];

  // Exact announcements first, so the dedup pass below keeps them over the
  // filing dates that approximate the same quarters.
  for (const q of (res?.earnings?.earningsChart?.quarterly ?? []) as any[]) {
    const time = toUnix(q.reportedDate);
    if (time == null) continue;
    events.push({
      time,
      source: 'reported',
      fiscalQuarter: q.fiscalQuarter ?? q.date,
      epsActual: typeof q.actual === 'number' ? q.actual : undefined,
      epsEstimate: typeof q.estimate === 'number' ? q.estimate : undefined,
      // `surprisePct` arrives as a string on this module, unlike elsewhere.
      surprisePercent: q.surprisePct != null ? Number(q.surprisePct) : undefined,
    });
  }

  for (const f of (res?.secFilings?.filings ?? []) as any[]) {
    const form = String(f.type ?? '');
    if (!EARNINGS_FORMS.test(form)) continue;
    const time = toUnix(f.epochDate ?? f.date);
    if (time == null) continue;
    events.push({ time, source: 'filing', form: form.toUpperCase() });
  }

  return dedupeEarnings(events);
}

/**
 * Collapse the merged feeds to one event per quarter, oldest first.
 *
 * Sorting by source before time makes the rule a single pass: every `reported`
 * row is placed first and therefore claims its window, so a filing describing
 * the same quarter is dropped rather than the other way round. Amended filings
 * and a 10-K filed beside a 10-Q collapse by the same rule.
 */
function dedupeEarnings(events: EarningsEvent[]): EarningsEvent[] {
  const byPrecision = [...events].sort((a, b) => {
    if (a.source !== b.source) return a.source === 'reported' ? -1 : 1;
    return a.time - b.time;
  });

  const kept: EarningsEvent[] = [];
  for (const e of byPrecision) {
    if (kept.some((k) => Math.abs(k.time - e.time) < DEDUP_WINDOW_SEC)) continue;
    kept.push(e);
  }
  return kept.sort((a, b) => a.time - b.time);
}

function normalizeQuoteType(t: string | undefined): QuoteType {
  const up = (t ?? '').toUpperCase();
  const known: QuoteType[] = ['EQUITY', 'ETF', 'INDEX', 'MUTUALFUND', 'CRYPTOCURRENCY', 'CURRENCY', 'FUTURE'];
  return (known as string[]).includes(up) ? (up as QuoteType) : 'OTHER';
}
