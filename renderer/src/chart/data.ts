/**
 * Transforms between our `Candle[]` and the shapes lightweight-charts wants.
 */

import type { CandlestickData, HistogramData, LineData, UTCTimestamp, WhitespaceData } from 'lightweight-charts';
import type { Candle, EarningsEvent, Interval, Series, SeriesType } from '@shared/types';
import { UP_DIM, DOWN_DIM } from './theme';

export type Bar = CandlestickData<UTCTimestamp>;
export type Point = LineData<UTCTimestamp> | WhitespaceData<UTCTimestamp>;

/**
 * Heikin-Ashi bars, derived client-side.
 *
 * Each bar's close is the average of its own OHLC and its open is the midpoint
 * of the previous HA bar, which smooths noise at the cost of no longer showing
 * true prices — worth remembering when reading levels off an HA chart.
 */
export function toHeikinAshi(candles: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const close = (c.open + c.high + c.low + c.close) / 4;
    const open = i === 0 ? (c.open + c.close) / 2 : (out[i - 1].open + out[i - 1].close) / 2;
    out.push({
      time: c.time,
      open,
      close,
      high: Math.max(c.high, open, close),
      low: Math.min(c.low, open, close),
      volume: c.volume,
      adjClose: c.adjClose,
    });
  }
  return out;
}

/** Apply the adjusted-close factor across the whole bar. */
export function applyAdjustment(candles: Candle[], useAdjusted: boolean): Candle[] {
  if (!useAdjusted) return candles;
  return candles.map((c) => {
    const f = c.close === 0 ? 1 : c.adjClose / c.close;
    return f === 1 ? c : {
      ...c,
      open: c.open * f,
      high: c.high * f,
      low: c.low * f,
      close: c.close * f,
    };
  });
}

export function prepareCandles(raw: Candle[], seriesType: SeriesType, useAdjusted: boolean): Candle[] {
  const adjusted = applyAdjustment(raw, useAdjusted);
  return seriesType === 'heikinashi' ? toHeikinAshi(adjusted) : adjusted;
}

export function toBars(candles: Candle[]): Bar[] {
  return candles.map((c) => ({
    time: c.time as UTCTimestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  }));
}

/** Close-only data, for line/area/baseline series types. */
export function toCloseLine(candles: Candle[]): LineData<UTCTimestamp>[] {
  return candles.map((c) => ({ time: c.time as UTCTimestamp, value: c.close }));
}

/**
 * An indicator series aligned to bars.
 *
 * Leading nulls become whitespace points rather than being dropped, so the
 * series stays index-aligned with the price bars and the crosshair legend
 * reads the right value.
 */
export function toLine(candles: Candle[], series: Series): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < candles.length; i++) {
    const v = series[i];
    const time = candles[i].time as UTCTimestamp;
    out.push(v == null || !Number.isFinite(v) ? { time } : { time, value: v });
  }
  return out;
}

/** Volume bars tinted by whether the bar closed up or down. */
export function toVolume(candles: Candle[]): HistogramData<UTCTimestamp>[] {
  return candles.map((c, i) => ({
    time: c.time as UTCTimestamp,
    value: c.volume,
    color: i > 0 && c.close < candles[i - 1].close ? DOWN_DIM : UP_DIM,
  }));
}

/** MACD-style histogram, coloured by sign. */
export function toHistogram(candles: Candle[], series: Series, color: string): (HistogramData<UTCTimestamp> | WhitespaceData<UTCTimestamp>)[] {
  return candles.map((c, i) => {
    const v = series[i];
    const time = c.time as UTCTimestamp;
    if (v == null || !Number.isFinite(v)) return { time };
    return { time, value: v, color: v >= 0 ? UP_DIM : DOWN_DIM };
  });
}

// ---------------------------------------------------------------------------
// Earnings
// ---------------------------------------------------------------------------

/**
 * Index of the last bar at or before `time`, or -1 if `time` predates the data.
 *
 * Binary search rather than a scan: a MAX-range daily chart is thousands of
 * bars and this runs once per earnings report.
 */
function lastBarAtOrBefore(candles: Candle[], time: number): number {
  let lo = 0;
  let hi = candles.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time <= time) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * Typical spacing between bars, in seconds.
 *
 * The median rather than the mean, so weekends, holidays and the odd halted
 * session do not stretch the estimate. Sampled from the tail because that is
 * the region the estimate is used to reason about.
 */
function medianBarSpacing(candles: Candle[]): number {
  const sample = candles.slice(-51);
  const gaps: number[] = [];
  for (let i = 1; i < sample.length; i++) gaps.push(sample[i].time - sample[i - 1].time);
  if (gaps.length === 0) return 86400;
  gaps.sort((a, b) => a - b);
  return gaps[gaps.length >> 1];
}

/**
 * Attach each earnings report to the bar the market heard it on.
 *
 * A result announced at 20:30 UTC belongs to that day's session even though the
 * price reaction lands on the next bar — which is exactly why the marker is
 * worth having: it shows you where the gap came from. So the rule is the last
 * bar at or before the announcement, not the nearest one.
 *
 * Reports that fall past the end of the data are dropped rather than pinned to
 * the final bar. That covers the still-forming case (a company reported this
 * morning but the day's bar has not been fetched yet) and stops a stale cache
 * from stamping an `E` on a bar that predates the announcement entirely.
 */
export function alignEarnings(candles: Candle[], earnings: EarningsEvent[]): Map<number, EarningsEvent> {
  const out = new Map<number, EarningsEvent>();
  if (candles.length === 0 || earnings.length === 0) return out;

  const horizon = candles[candles.length - 1].time + medianBarSpacing(candles);

  for (const e of earnings) {
    if (e.time > horizon) continue;
    const idx = lastBarAtOrBefore(candles, e.time);
    if (idx < 0) continue;
    // Coarse intervals can collapse two reports into one bar. Keeping the
    // first means the marker names the earlier quarter, which is the one whose
    // move the bar actually contains.
    if (!out.has(idx)) out.set(idx, e);
  }
  return out;
}

/** Compact beat/miss summary for the crosshair legend. */
export function earningsSummary(e: EarningsEvent): string {
  const parts: string[] = [];
  if (e.fiscalQuarter) parts.push(e.fiscalQuarter);
  if (e.epsActual != null) {
    parts.push(
      e.epsEstimate != null
        ? `EPS ${formatPrice(e.epsActual)} vs ${formatPrice(e.epsEstimate)} est`
        : `EPS ${formatPrice(e.epsActual)}`,
    );
  }
  if (e.surprisePercent != null && Number.isFinite(e.surprisePercent)) {
    parts.push(`${e.surprisePercent >= 0 ? '+' : ''}${e.surprisePercent.toFixed(1)}%`);
  }
  // Filing rows carry no EPS and are only accurate to a few days, so say so
  // rather than let the marker imply a precision it does not have.
  if (e.source === 'filing') parts.push(`${e.form ?? 'SEC'} filing date`);
  return parts.join(' · ') || 'Earnings report';
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Price precision that suits the magnitude — pennies for cheap, none for indices. */
export function priceFormat(sample: number): { precision: number; minMove: number } {
  const abs = Math.abs(sample);
  if (abs >= 1000) return { precision: 2, minMove: 0.01 };
  if (abs >= 1) return { precision: 2, minMove: 0.01 };
  if (abs >= 0.01) return { precision: 4, minMove: 0.0001 };
  return { precision: 6, minMove: 0.000001 };
}

export function formatVolume(v: number): string {
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(Math.round(v));
}

export function formatPrice(v: number | null | undefined, currency = ''): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const decimals = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return currency + v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

export type RangePreset = '1D' | '5D' | '1M' | '3M' | '6M' | 'YTD' | '1Y' | '5Y' | 'MAX';

export const RANGE_PRESETS: RangePreset[] = ['1D', '5D', '1M', '3M', '6M', 'YTD', '1Y', '5Y', 'MAX'];

/** First timestamp to show for a range preset, or null for the full history. */
export function rangeStart(preset: RangePreset, lastTime: number): number | null {
  const DAY = 86400;
  switch (preset) {
    case '1D': return lastTime - DAY;
    case '5D': return lastTime - 5 * DAY;
    case '1M': return lastTime - 31 * DAY;
    case '3M': return lastTime - 92 * DAY;
    case '6M': return lastTime - 183 * DAY;
    case 'YTD': return Math.floor(new Date(new Date(lastTime * 1000).getUTCFullYear(), 0, 1).getTime() / 1000);
    case '1Y': return lastTime - 366 * DAY;
    case '5Y': return lastTime - 5 * 366 * DAY;
    default: return null;
  }
}

/**
 * Which intervals can serve a given range.
 *
 * Yahoo caps intraday history hard (1m to ~7 days, 5m/15m/30m to ~60), so the
 * UI disables impossible combinations instead of silently drawing a truncated
 * series and letting the user think that is all the data there is.
 */
export const INTERVAL_MAX_DAYS: Record<Interval, number> = {
  '1m': 7,
  '5m': 60,
  '15m': 60,
  '30m': 60,
  '1h': 730,
  '1d': 36500,
  '1wk': 36500,
  '1mo': 36500,
};

const RANGE_DAYS: Record<RangePreset, number> = {
  '1D': 1, '5D': 5, '1M': 31, '3M': 92, '6M': 183, YTD: 366, '1Y': 366, '5Y': 1830, MAX: 36500,
};

export function rangeSupported(preset: RangePreset, interval: Interval): boolean {
  return RANGE_DAYS[preset] <= INTERVAL_MAX_DAYS[interval];
}

/** A sensible interval for a range, used when the current one cannot serve it. */
export function bestIntervalFor(preset: RangePreset): Interval {
  const days = RANGE_DAYS[preset];
  if (days <= 1) return '5m';
  if (days <= 5) return '30m';
  if (days <= 60) return '1h';
  return '1d';
}
