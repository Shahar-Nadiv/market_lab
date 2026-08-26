/**
 * Indicator primitives.
 *
 * These are the single source of truth for indicator math: the chart, the
 * scripting sandbox, the screener and the alert engine all call into here. Two
 * implementations would drift, and an alert that disagrees with the line on
 * your chart is worse than no alert.
 *
 * Conventions, pinned deliberately because they are the usual reason numbers
 * disagree with other platforms:
 *   - Output arrays are always the same length as the input, left-padded with
 *     `null` until the indicator has enough data to be defined.
 *   - `ema` seeds from the SMA of the first `period` values (TradingView's
 *     convention), not from the first value alone.
 *   - `rma` is Wilder's smoothing, used by RSI, ATR and ADX.
 *   - `stdev` is the population standard deviation, matching Bollinger Bands
 *     as drawn by TradingView.
 */

import type { Candle, PriceSource, Series } from '../types';

// ---------------------------------------------------------------------------
// Source extraction
// ---------------------------------------------------------------------------

/** Pull a price series out of candles, including the synthetic averages. */
export function sourceSeries(candles: Candle[], source: PriceSource, useAdjusted = false): number[] {
  return candles.map((c) => {
    // Adjusted close rescales the whole bar; without it a 200 DMA is wrong for
    // years after any split.
    const factor = useAdjusted && c.close !== 0 ? c.adjClose / c.close : 1;
    switch (source) {
      case 'open': return c.open * factor;
      case 'high': return c.high * factor;
      case 'low': return c.low * factor;
      case 'close': return c.close * factor;
      case 'hl2': return ((c.high + c.low) / 2) * factor;
      case 'hlc3': return ((c.high + c.low + c.close) / 3) * factor;
      case 'ohlc4': return ((c.open + c.high + c.low + c.close) / 4) * factor;
      default: return c.close * factor;
    }
  });
}

// ---------------------------------------------------------------------------
// Moving averages
// ---------------------------------------------------------------------------

/** Simple moving average. O(n) via a running sum. */
export function sma(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average, seeded with the SMA of the first `period` bars. */
export function ema(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's smoothing — the average behind RSI, ATR and ADX. */
export function rma(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** Linearly weighted moving average — most recent bar carries the most weight. */
export function wma(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < values.length; i++) {
    let acc = 0;
    for (let j = 0; j < period; j++) acc += values[i - j] * (period - j);
    out[i] = acc / denom;
  }
  return out;
}

/** Volume-weighted moving average. */
export function vwma(values: number[], volumes: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  let pv = 0;
  let v = 0;
  for (let i = 0; i < values.length; i++) {
    pv += values[i] * volumes[i];
    v += volumes[i];
    if (i >= period) {
      pv -= values[i - period] * volumes[i - period];
      v -= volumes[i - period];
    }
    if (i >= period - 1) out[i] = v === 0 ? null : pv / v;
  }
  return out;
}

/** Dispatch by name, so scripts and the registry share one MA implementation. */
export type MaType = 'SMA' | 'EMA' | 'WMA' | 'RMA' | 'VWMA';

export function movingAverage(type: MaType, values: number[], period: number, volumes?: number[]): Series {
  switch (type) {
    case 'EMA': return ema(values, period);
    case 'WMA': return wma(values, period);
    case 'RMA': return rma(values, period);
    case 'VWMA': return vwma(values, volumes ?? values.map(() => 1), period);
    default: return sma(values, period);
  }
}

// ---------------------------------------------------------------------------
// Dispersion and extremes
// ---------------------------------------------------------------------------

/** Population standard deviation over a rolling window. */
export function stdev(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    sumSq += values[i] * values[i];
    if (i >= period) {
      sum -= values[i - period];
      sumSq -= values[i - period] * values[i - period];
    }
    if (i >= period - 1) {
      const mean = sum / period;
      // Clamp: accumulated float error can push a zero-variance window
      // fractionally negative, and Math.sqrt would return NaN.
      out[i] = Math.sqrt(Math.max(0, sumSq / period - mean * mean));
    }
  }
  return out;
}

export function highest(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let m = -Infinity;
    for (let j = i - period + 1; j <= i; j++) if (values[j] > m) m = values[j];
    out[i] = m;
  }
  return out;
}

export function lowest(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let m = Infinity;
    for (let j = i - period + 1; j <= i; j++) if (values[j] < m) m = values[j];
    out[i] = m;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Series helpers
// ---------------------------------------------------------------------------

/** Difference from `length` bars ago. */
export function change(values: number[], length = 1): Series {
  const out: Series = new Array(values.length).fill(null);
  for (let i = length; i < values.length; i++) out[i] = values[i] - values[i - length];
  return out;
}

/** True on the bar where `a` crosses from at-or-below `b` to above it. */
export function crossover(a: Series, b: Series): boolean[] {
  const out = new Array(a.length).fill(false);
  for (let i = 1; i < a.length; i++) {
    const a0 = a[i - 1], a1 = a[i], b0 = b[i - 1], b1 = b[i];
    if (a0 == null || a1 == null || b0 == null || b1 == null) continue;
    out[i] = a0 <= b0 && a1 > b1;
  }
  return out;
}

/** True on the bar where `a` crosses from at-or-above `b` to below it. */
export function crossunder(a: Series, b: Series): boolean[] {
  const out = new Array(a.length).fill(false);
  for (let i = 1; i < a.length; i++) {
    const a0 = a[i - 1], a1 = a[i], b0 = b[i - 1], b1 = b[i];
    if (a0 == null || a1 == null || b0 == null || b1 == null) continue;
    out[i] = a0 >= b0 && a1 < b1;
  }
  return out;
}

/** A crossing in either direction. */
export function cross(a: Series, b: Series): boolean[] {
  const up = crossover(a, b);
  const down = crossunder(a, b);
  return up.map((v, i) => v || down[i]);
}

/** Replace nulls and non-finite values with `replacement`. */
export function nz(series: Series, replacement = 0): number[] {
  return series.map((v) => (v == null || !Number.isFinite(v) ? replacement : v));
}

/** Constant series, for comparing an indicator against a fixed level. */
export function constant(length: number, value: number): Series {
  return new Array(length).fill(value);
}

/** Element-wise arithmetic that propagates nulls rather than producing NaN. */
export function combine(a: Series, b: Series, fn: (x: number, y: number) => number): Series {
  return a.map((v, i) => {
    const w = b[i];
    return v == null || w == null ? null : fn(v, w);
  });
}

export function mapSeries(a: Series, fn: (x: number) => number): Series {
  return a.map((v) => (v == null ? null : fn(v)));
}

// ---------------------------------------------------------------------------
// Volatility
// ---------------------------------------------------------------------------

/** True range: the bar's range, extended to include any gap from the prior close. */
export function trueRange(candles: Candle[]): number[] {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
}

export function atr(candles: Candle[], period = 14): Series {
  return rma(trueRange(candles), period);
}

// ---------------------------------------------------------------------------
// Oscillators
// ---------------------------------------------------------------------------

export function rsi(values: number[], period = 14): Series {
  const out: Series = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  const gains: number[] = [0];
  const losses: number[] = [0];
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gains.push(Math.max(0, d));
    losses.push(Math.max(0, -d));
  }

  // Wilder seeds from the average of the first `period` changes, which live at
  // indices 1..period — hence the slice offset.
  const avgGain = rma(gains.slice(1), period);
  const avgLoss = rma(losses.slice(1), period);

  for (let i = 0; i < avgGain.length; i++) {
    const g = avgGain[i];
    const l = avgLoss[i];
    if (g == null || l == null) continue;
    // All-gain windows have zero average loss; RSI is 100 by definition.
    out[i + 1] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

export interface MacdResult {
  macd: Series;
  signal: Series;
  histogram: Series;
}

export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  const macdLine = combine(fastEma, slowEma, (a, b) => a - b);

  // The signal EMA must start where the MACD line does, not at bar zero.
  const firstIdx = macdLine.findIndex((v) => v != null);
  const signal: Series = new Array(values.length).fill(null);
  if (firstIdx >= 0) {
    const dense = macdLine.slice(firstIdx).map((v) => v ?? 0);
    const sig = ema(dense, signalPeriod);
    for (let i = 0; i < sig.length; i++) signal[firstIdx + i] = sig[i];
  }

  return { macd: macdLine, signal, histogram: combine(macdLine, signal, (a, b) => a - b) };
}

export interface StochResult {
  k: Series;
  d: Series;
}

export function stochastic(candles: Candle[], kPeriod = 14, kSmooth = 1, dPeriod = 3): StochResult {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);
  const hh = highest(highs, kPeriod);
  const ll = lowest(lows, kPeriod);

  const rawK: Series = closes.map((c, i) => {
    const h = hh[i];
    const l = ll[i];
    if (h == null || l == null) return null;
    // A flat window has no range to normalize against; 50 is the neutral read.
    return h === l ? 50 : ((c - l) / (h - l)) * 100;
  });

  const k = kSmooth > 1 ? smaOfSeries(rawK, kSmooth) : rawK;
  return { k, d: smaOfSeries(k, dPeriod) };
}

/** SMA over a series that may contain leading nulls. */
export function smaOfSeries(series: Series, period: number): Series {
  const out: Series = new Array(series.length).fill(null);
  const first = series.findIndex((v) => v != null);
  if (first < 0) return out;
  const dense = series.slice(first).map((v) => v ?? 0);
  const res = sma(dense, period);
  for (let i = 0; i < res.length; i++) out[first + i] = res[i];
  return out;
}

export interface AdxResult {
  adx: Series;
  plusDi: Series;
  minusDi: Series;
}

export function adx(candles: Candle[], period = 14): AdxResult {
  const n = candles.length;
  const plusDm: number[] = new Array(n).fill(0);
  const minusDm: number[] = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    // Only the larger directional move counts, and only when positive.
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
  }

  const tr = rma(trueRange(candles), period);
  const pdm = rma(plusDm, period);
  const mdm = rma(minusDm, period);

  const plusDi = combine(pdm, tr, (p, t) => (t === 0 ? 0 : (p / t) * 100));
  const minusDi = combine(mdm, tr, (m, t) => (t === 0 ? 0 : (m / t) * 100));

  const dx = combine(plusDi, minusDi, (p, m) => (p + m === 0 ? 0 : (Math.abs(p - m) / (p + m)) * 100));
  return { adx: smoothSeriesRma(dx, period), plusDi, minusDi };
}

function smoothSeriesRma(series: Series, period: number): Series {
  const out: Series = new Array(series.length).fill(null);
  const first = series.findIndex((v) => v != null);
  if (first < 0) return out;
  const dense = series.slice(first).map((v) => v ?? 0);
  const res = rma(dense, period);
  for (let i = 0; i < res.length; i++) out[first + i] = res[i];
  return out;
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

/**
 * Donchian channel: the highest high and lowest low of the trailing window,
 * with the midline between them. A close beyond a band is the classic
 * breakout signal.
 */
export function donchianBands(candles: Candle[], period: number): { upper: Series; lower: Series; basis: Series } {
  const upper = highest(candles.map((c) => c.high), period);
  const lower = lowest(candles.map((c) => c.low), period);
  return { upper, lower, basis: combine(upper, lower, (u, l) => (u + l) / 2) };
}

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------

/** On-balance volume. */
export function obv(candles: Candle[]): Series {
  const out: Series = new Array(candles.length).fill(null);
  if (candles.length === 0) return out;
  let acc = 0;
  out[0] = 0;
  for (let i = 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    acc += d > 0 ? candles[i].volume : d < 0 ? -candles[i].volume : 0;
    out[i] = acc;
  }
  return out;
}

/**
 * Session-anchored VWAP.
 *
 * `isNewSession` marks the first bar of each trading day; the accumulator
 * resets there. Passing an all-false array yields a cumulative VWAP over the
 * whole series, which is what daily and higher timeframes want.
 */
export function vwap(candles: Candle[], isNewSession: boolean[]): Series {
  const out: Series = new Array(candles.length).fill(null);
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < candles.length; i++) {
    if (isNewSession[i]) {
      pv = 0;
      vol = 0;
    }
    const typical = (candles[i].high + candles[i].low + candles[i].close) / 3;
    pv += typical * candles[i].volume;
    vol += candles[i].volume;
    out[i] = vol === 0 ? null : pv / vol;
  }
  return out;
}
