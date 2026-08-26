/**
 * The wider indicator maths.
 *
 * `math.ts` holds the primitives the original phases needed; this file adds the
 * long tail — the oscillators, volume measures, channels and trend systems that
 * a library screen is expected to offer. Kept separate so `math.ts` stays the
 * short, heavily-tested core rather than a 2000-line grab bag.
 *
 * Conventions match `math.ts`: inputs are plain `number[]` where every bar has
 * a value, `Series` where leading bars legitimately have none, and every output
 * is exactly as long as the input so a plot lines up bar-for-bar.
 */

import type { Candle, Series } from '../types';
import {
  atr, combine, ema, highest, lowest, mapSeries, rma, sma, smaOfSeries, stdev, trueRange, wma,
} from './math';

// ---------------------------------------------------------------------------
// Moving-average variants
// ---------------------------------------------------------------------------

/** Series-preserving EMA over a Series that may start with nulls. */
function emaOfSeries(series: Series, period: number): Series {
  const out: Series = new Array(series.length).fill(null);
  const k = 2 / (period + 1);
  let prev: number | null = null;
  for (let i = 0; i < series.length; i++) {
    const v = series[i];
    if (v == null) continue;
    prev = prev == null ? v : v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Double EMA — half the lag of a plain EMA at the cost of overshoot. */
export function dema(values: number[], period: number): Series {
  const e1 = ema(values, period);
  const e2 = emaOfSeries(e1, period);
  return combine(e1, e2, (a, b) => 2 * a - b);
}

/** Triple EMA. */
export function tema(values: number[], period: number): Series {
  const e1 = ema(values, period);
  const e2 = emaOfSeries(e1, period);
  const e3 = emaOfSeries(e2, period);
  const out: Series = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    const a = e1[i], b = e2[i], c = e3[i];
    if (a == null || b == null || c == null) continue;
    out[i] = 3 * a - 3 * b + c;
  }
  return out;
}

/**
 * Hull moving average: WMA of (2*WMA(n/2) - WMA(n)) over sqrt(n).
 * Much faster to turn than an SMA without the noise of a short EMA.
 */
export function hma(values: number[], period: number): Series {
  const half = Math.max(1, Math.floor(period / 2));
  const sqrtN = Math.max(1, Math.round(Math.sqrt(period)));
  const w1 = wma(values, half);
  const w2 = wma(values, period);
  const raw: number[] = new Array(values.length).fill(0);
  const valid: boolean[] = new Array(values.length).fill(false);
  for (let i = 0; i < values.length; i++) {
    const a = w1[i], b = w2[i];
    if (a == null || b == null) continue;
    raw[i] = 2 * a - b;
    valid[i] = true;
  }
  const out = wma(raw, sqrtN);
  for (let i = 0; i < out.length; i++) if (!valid[i]) out[i] = null;
  return out;
}

// ---------------------------------------------------------------------------
// Momentum oscillators
// ---------------------------------------------------------------------------

/** Typical price — the basis for CCI, MFI and VWAP. */
export function typicalPrice(candles: Candle[]): number[] {
  return candles.map((c) => (c.high + c.low + c.close) / 3);
}

/** Commodity Channel Index. Uses mean absolute deviation, not stdev. */
export function cci(candles: Candle[], period = 20): Series {
  const tp = typicalPrice(candles);
  const basis = sma(tp, period);
  const out: Series = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    const b = basis[i];
    if (b == null) continue;
    let dev = 0;
    for (let j = i - period + 1; j <= i; j++) dev += Math.abs(tp[j] - b);
    dev /= period;
    out[i] = dev === 0 ? 0 : (tp[i] - b) / (0.015 * dev);
  }
  return out;
}

/** Williams %R — where the close sits in the recent range, as -100..0. */
export function williamsR(candles: Candle[], period = 14): Series {
  const hh = highest(candles.map((c) => c.high), period);
  const ll = lowest(candles.map((c) => c.low), period);
  const out: Series = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) {
    const h = hh[i], l = ll[i];
    if (h == null || l == null) continue;
    out[i] = h === l ? -50 : ((h - candles[i].close) / (h - l)) * -100;
  }
  return out;
}

/** Rate of change, as a percentage. */
export function roc(values: number[], period = 9): Series {
  const out: Series = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) {
    const base = values[i - period];
    out[i] = base === 0 ? null : ((values[i] - base) / base) * 100;
  }
  return out;
}

/** Raw momentum: price now minus price N bars ago. */
export function momentum(values: number[], period = 10): Series {
  const out: Series = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) out[i] = values[i] - values[i - period];
  return out;
}

/** Money Flow Index — RSI weighted by volume. */
export function mfi(candles: Candle[], period = 14): Series {
  const tp = typicalPrice(candles);
  const out: Series = new Array(candles.length).fill(null);
  for (let i = period; i < candles.length; i++) {
    let pos = 0;
    let neg = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const flow = tp[j] * candles[j].volume;
      if (tp[j] > tp[j - 1]) pos += flow;
      else if (tp[j] < tp[j - 1]) neg += flow;
    }
    out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
  }
  return out;
}

/** Chande Momentum Oscillator. */
export function cmo(values: number[], period = 9): Series {
  const out: Series = new Array(values.length).fill(null);
  for (let i = period; i < values.length; i++) {
    let up = 0;
    let down = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = values[j] - values[j - 1];
      if (d > 0) up += d;
      else down -= d;
    }
    const total = up + down;
    out[i] = total === 0 ? 0 : ((up - down) / total) * 100;
  }
  return out;
}

/** Ultimate Oscillator — three timeframes weighted 4:2:1. */
export function ultimateOscillator(candles: Candle[], p1 = 7, p2 = 14, p3 = 28): Series {
  const bp: number[] = new Array(candles.length).fill(0);
  const tr: number[] = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const prevClose = candles[i - 1].close;
    const low = Math.min(candles[i].low, prevClose);
    bp[i] = candles[i].close - low;
    tr[i] = Math.max(candles[i].high, prevClose) - low;
  }
  const avg = (i: number, n: number): number | null => {
    if (i < n) return null;
    let b = 0;
    let t = 0;
    for (let j = i - n + 1; j <= i; j++) {
      b += bp[j];
      t += tr[j];
    }
    return t === 0 ? null : b / t;
  };
  const out: Series = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) {
    const a1 = avg(i, p1), a2 = avg(i, p2), a3 = avg(i, p3);
    if (a1 == null || a2 == null || a3 == null) continue;
    out[i] = ((4 * a1 + 2 * a2 + a3) / 7) * 100;
  }
  return out;
}

/** Awesome Oscillator — 5/34 SMA spread of the median price. */
export function awesomeOscillator(candles: Candle[], fast = 5, slow = 34): Series {
  const median = candles.map((c) => (c.high + c.low) / 2);
  return combine(sma(median, fast), sma(median, slow), (a, b) => a - b);
}

/** True Strength Index — double-smoothed momentum. */
export function tsi(values: number[], long = 25, short = 13): Series {
  const mom: number[] = new Array(values.length).fill(0);
  for (let i = 1; i < values.length; i++) mom[i] = values[i] - values[i - 1];
  const smooth = (src: number[]) => {
    const first = emaOfSeries(ema(src, long), short);
    return first;
  };
  const num = smooth(mom);
  const den = smooth(mom.map(Math.abs));
  return combine(num, den, (a, b) => (b === 0 ? 0 : (a / b) * 100));
}

/** Percentage Price Oscillator — MACD expressed as a percentage. */
export function ppo(values: number[], fast = 12, slow = 26, signalPeriod = 9): {
  ppo: Series; signal: Series; histogram: Series;
} {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line = combine(f, s, (a, b) => (b === 0 ? 0 : ((a - b) / b) * 100));
  const signal = emaOfSeries(line, signalPeriod);
  return { ppo: line, signal, histogram: combine(line, signal, (a, b) => a - b) };
}

/** Stochastic RSI — the stochastic oscillator applied to RSI itself. */
export function stochRsi(rsiSeries: Series, period = 14, kSmooth = 3, dSmooth = 3): { k: Series; d: Series } {
  const raw: Series = new Array(rsiSeries.length).fill(null);
  for (let i = 0; i < rsiSeries.length; i++) {
    if (i < period - 1) continue;
    let lo = Infinity;
    let hi = -Infinity;
    let ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      const v = rsiSeries[j];
      if (v == null) { ok = false; break; }
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    const cur = rsiSeries[i];
    if (!ok || cur == null) continue;
    raw[i] = hi === lo ? 0 : ((cur - lo) / (hi - lo)) * 100;
  }
  const k = smaOfSeries(raw, kSmooth);
  return { k, d: smaOfSeries(k, dSmooth) };
}

/** Detrended Price Oscillator — price minus a displaced SMA. */
export function dpo(values: number[], period = 20): Series {
  const shift = Math.floor(period / 2) + 1;
  const basis = sma(values, period);
  const out: Series = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    const b = basis[i - shift + shift]; // basis at i, compared against price shifted back
    const past = i - shift;
    if (b == null || past < 0) continue;
    out[i] = values[past] - b;
  }
  return out;
}

/** Coppock Curve — long-term bottom finder. */
export function coppock(values: number[], roc1 = 14, roc2 = 11, wmaPeriod = 10): Series {
  const r1 = roc(values, roc1);
  const r2 = roc(values, roc2);
  const sum = combine(r1, r2, (a, b) => a + b);
  const filled: number[] = new Array(values.length).fill(0);
  const valid: boolean[] = new Array(values.length).fill(false);
  for (let i = 0; i < sum.length; i++) {
    if (sum[i] == null) continue;
    filled[i] = sum[i] as number;
    valid[i] = true;
  }
  const out = wma(filled, wmaPeriod);
  for (let i = 0; i < out.length; i++) if (!valid[i]) out[i] = null;
  return out;
}

/** Balance of Power — where the close finished within the bar. */
export function balanceOfPower(candles: Candle[], smoothing = 14): Series {
  const raw = candles.map((c) => (c.high === c.low ? 0 : (c.close - c.open) / (c.high - c.low)));
  return sma(raw, smoothing);
}

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------

/** Accumulation/Distribution line. */
export function accumulationDistribution(candles: Candle[]): Series {
  const out: Series = new Array(candles.length).fill(null);
  let acc = 0;
  for (let i = 0; i < candles.length; i++) {
    const { high, low, close, volume } = candles[i];
    const range = high - low;
    const mfm = range === 0 ? 0 : ((close - low) - (high - close)) / range;
    acc += mfm * volume;
    out[i] = acc;
  }
  return out;
}

/** Chaikin Money Flow — A/D normalised by volume over a window. */
export function chaikinMoneyFlow(candles: Candle[], period = 20): Series {
  const out: Series = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    let mfv = 0;
    let vol = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const { high, low, close, volume } = candles[j];
      const range = high - low;
      mfv += (range === 0 ? 0 : ((close - low) - (high - close)) / range) * volume;
      vol += volume;
    }
    out[i] = vol === 0 ? 0 : mfv / vol;
  }
  return out;
}

/** Chaikin Oscillator — MACD of the A/D line. */
export function chaikinOscillator(candles: Candle[], fast = 3, slow = 10): Series {
  const ad = accumulationDistribution(candles).map((v) => v ?? 0);
  return combine(ema(ad, fast), ema(ad, slow), (a, b) => a - b);
}

/** Force Index — price change scaled by volume. */
export function forceIndex(candles: Candle[], period = 13): Series {
  const raw: number[] = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    raw[i] = (candles[i].close - candles[i - 1].close) * candles[i].volume;
  }
  return ema(raw, period);
}

/** Ease of Movement — how far price moved per unit of volume. */
export function easeOfMovement(candles: Candle[], period = 14, scale = 1e6): Series {
  const raw: number[] = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const mid = (candles[i].high + candles[i].low) / 2 - (candles[i - 1].high + candles[i - 1].low) / 2;
    const range = candles[i].high - candles[i].low;
    const boxRatio = range === 0 || candles[i].volume === 0 ? 0 : (candles[i].volume / scale) / range;
    raw[i] = boxRatio === 0 ? 0 : mid / boxRatio;
  }
  return sma(raw, period);
}

/** Price Volume Trend. */
export function priceVolumeTrend(candles: Candle[]): Series {
  const out: Series = new Array(candles.length).fill(null);
  let acc = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i > 0) {
      const prev = candles[i - 1].close;
      if (prev !== 0) acc += ((candles[i].close - prev) / prev) * candles[i].volume;
    }
    out[i] = acc;
  }
  return out;
}

/** Volume Oscillator — spread between a fast and slow volume average, in %. */
export function volumeOscillator(candles: Candle[], fast = 5, slow = 10): Series {
  const vol = candles.map((c) => c.volume);
  return combine(ema(vol, fast), ema(vol, slow), (a, b) => (b === 0 ? 0 : ((a - b) / b) * 100));
}

// ---------------------------------------------------------------------------
// Volatility, bands and channels
// ---------------------------------------------------------------------------

/** Keltner Channels — an EMA basis with ATR-scaled bands. */
export function keltner(candles: Candle[], period = 20, mult = 2, atrPeriod = 10): {
  basis: Series; upper: Series; lower: Series;
} {
  const basis = ema(candles.map((c) => c.close), period);
  const range = atr(candles, atrPeriod);
  return {
    basis,
    upper: combine(basis, range, (b, a) => b + a * mult),
    lower: combine(basis, range, (b, a) => b - a * mult),
  };
}

/** Percentage envelopes around a moving average. */
export function envelopes(values: number[], period = 20, percent = 2.5): {
  basis: Series; upper: Series; lower: Series;
} {
  const basis = sma(values, period);
  return {
    basis,
    upper: mapSeries(basis, (v) => v * (1 + percent / 100)),
    lower: mapSeries(basis, (v) => v * (1 - percent / 100)),
  };
}

/** Bollinger %B — where price sits inside the bands, 0..1. */
export function percentB(values: number[], upper: Series, lower: Series): Series {
  const out: Series = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    const u = upper[i], l = lower[i];
    if (u == null || l == null || u === l) continue;
    out[i] = (values[i] - l) / (u - l);
  }
  return out;
}

/** Bollinger Bandwidth — band spread relative to the basis. */
export function bandwidth(basis: Series, upper: Series, lower: Series): Series {
  const out: Series = new Array(basis.length).fill(null);
  for (let i = 0; i < basis.length; i++) {
    const b = basis[i], u = upper[i], l = lower[i];
    if (b == null || u == null || l == null || b === 0) continue;
    out[i] = ((u - l) / b) * 100;
  }
  return out;
}

/** Annualised historical volatility from log returns. */
export function historicalVolatility(values: number[], period = 20, barsPerYear = 252): Series {
  const returns: number[] = new Array(values.length).fill(0);
  for (let i = 1; i < values.length; i++) {
    returns[i] = values[i - 1] > 0 ? Math.log(values[i] / values[i - 1]) : 0;
  }
  return mapSeries(stdev(returns, period), (s) => s * Math.sqrt(barsPerYear) * 100);
}

/** Chaikin Volatility — rate of change of the high-low spread. */
export function chaikinVolatility(candles: Candle[], period = 10, rocPeriod = 10): Series {
  const spread = candles.map((c) => c.high - c.low);
  const smoothed = ema(spread, period);
  const out: Series = new Array(candles.length).fill(null);
  for (let i = rocPeriod; i < candles.length; i++) {
    const now = smoothed[i], past = smoothed[i - rocPeriod];
    if (now == null || past == null || past === 0) continue;
    out[i] = ((now - past) / past) * 100;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trend systems
// ---------------------------------------------------------------------------

/**
 * SuperTrend — ATR bands that flip side when price closes through them.
 * Returns the trend line plus the direction (+1 up, -1 down) so a strategy can
 * read the flips without recomputing.
 */
export function superTrend(candles: Candle[], period = 10, mult = 3): {
  trend: Series; direction: Series; upper: Series; lower: Series;
} {
  const range = atr(candles, period);
  const trend: Series = new Array(candles.length).fill(null);
  const direction: Series = new Array(candles.length).fill(null);
  const upperOut: Series = new Array(candles.length).fill(null);
  const lowerOut: Series = new Array(candles.length).fill(null);

  let prevUpper = 0;
  let prevLower = 0;
  let dir = 1;

  for (let i = 0; i < candles.length; i++) {
    const a = range[i];
    if (a == null) continue;
    const mid = (candles[i].high + candles[i].low) / 2;
    let upper = mid + mult * a;
    let lower = mid - mult * a;

    // Bands only ratchet in the direction of the trend, which is what stops
    // SuperTrend whipsawing on every small pullback.
    if (i > 0 && range[i - 1] != null) {
      upper = candles[i - 1].close > prevUpper ? upper : Math.min(upper, prevUpper);
      lower = candles[i - 1].close < prevLower ? lower : Math.max(lower, prevLower);
      dir = candles[i].close > prevUpper ? 1 : candles[i].close < prevLower ? -1 : dir;
    }

    prevUpper = upper;
    prevLower = lower;
    upperOut[i] = upper;
    lowerOut[i] = lower;
    direction[i] = dir;
    trend[i] = dir === 1 ? lower : upper;
  }
  return { trend, direction, upper: upperOut, lower: lowerOut };
}

/** Parabolic SAR. Returns the dot series and the trend direction. */
export function parabolicSar(candles: Candle[], step = 0.02, max = 0.2): { sar: Series; direction: Series } {
  const sar: Series = new Array(candles.length).fill(null);
  const direction: Series = new Array(candles.length).fill(null);
  if (candles.length < 2) return { sar, direction };

  let up = candles[1].close >= candles[0].close;
  let acc = step;
  let extreme = up ? candles[0].high : candles[0].low;
  let value = up ? candles[0].low : candles[0].high;

  for (let i = 1; i < candles.length; i++) {
    value = value + acc * (extreme - value);

    if (up) {
      // The SAR may never move above the prior two lows while long.
      value = Math.min(value, candles[i - 1].low, candles[Math.max(0, i - 2)].low);
      if (candles[i].low < value) {
        up = false;
        value = extreme;
        extreme = candles[i].low;
        acc = step;
      } else if (candles[i].high > extreme) {
        extreme = candles[i].high;
        acc = Math.min(max, acc + step);
      }
    } else {
      value = Math.max(value, candles[i - 1].high, candles[Math.max(0, i - 2)].high);
      if (candles[i].high > value) {
        up = true;
        value = extreme;
        extreme = candles[i].high;
        acc = step;
      } else if (candles[i].low < extreme) {
        extreme = candles[i].low;
        acc = Math.min(max, acc + step);
      }
    }
    sar[i] = value;
    direction[i] = up ? 1 : -1;
  }
  return { sar, direction };
}

/** Aroon up/down — how recently the window's high and low were set. */
export function aroon(candles: Candle[], period = 14): { up: Series; down: Series; oscillator: Series } {
  const up: Series = new Array(candles.length).fill(null);
  const down: Series = new Array(candles.length).fill(null);
  for (let i = period; i < candles.length; i++) {
    let hi = -Infinity, lo = Infinity, hiIdx = i, loIdx = i;
    for (let j = i - period; j <= i; j++) {
      if (candles[j].high >= hi) { hi = candles[j].high; hiIdx = j; }
      if (candles[j].low <= lo) { lo = candles[j].low; loIdx = j; }
    }
    up[i] = ((period - (i - hiIdx)) / period) * 100;
    down[i] = ((period - (i - loIdx)) / period) * 100;
  }
  return { up, down, oscillator: combine(up, down, (a, b) => a - b) };
}

/** TRIX — rate of change of a triple-smoothed EMA. */
export function trix(values: number[], period = 15, signalPeriod = 9): { trix: Series; signal: Series } {
  const e3 = emaOfSeries(emaOfSeries(ema(values, period), period), period);
  const line: Series = new Array(values.length).fill(null);
  for (let i = 1; i < values.length; i++) {
    const now = e3[i], prev = e3[i - 1];
    if (now == null || prev == null || prev === 0) continue;
    line[i] = ((now - prev) / prev) * 10000;
  }
  return { trix: line, signal: emaOfSeries(line, signalPeriod) };
}

/** Vortex indicator — competing up and down trend strength. */
export function vortex(candles: Candle[], period = 14): { plus: Series; minus: Series } {
  const tr = trueRange(candles);
  const vmPlus: number[] = new Array(candles.length).fill(0);
  const vmMinus: number[] = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    vmPlus[i] = Math.abs(candles[i].high - candles[i - 1].low);
    vmMinus[i] = Math.abs(candles[i].low - candles[i - 1].high);
  }
  const sum = (src: number[], i: number): number | null => {
    if (i < period) return null;
    let total = 0;
    for (let j = i - period + 1; j <= i; j++) total += src[j];
    return total;
  };
  const plus: Series = new Array(candles.length).fill(null);
  const minus: Series = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) {
    const trSum = sum(tr, i);
    if (trSum == null || trSum === 0) continue;
    const p = sum(vmPlus, i), m = sum(vmMinus, i);
    if (p == null || m == null) continue;
    plus[i] = p / trSum;
    minus[i] = m / trSum;
  }
  return { plus, minus };
}

/** Elder Ray — buying and selling pressure either side of an EMA. */
export function elderRay(candles: Candle[], period = 13): { bull: Series; bear: Series } {
  const basis = ema(candles.map((c) => c.close), period);
  const bull: Series = new Array(candles.length).fill(null);
  const bear: Series = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) {
    const b = basis[i];
    if (b == null) continue;
    bull[i] = candles[i].high - b;
    bear[i] = candles[i].low - b;
  }
  return { bull, bear };
}

/**
 * Ichimoku Cloud.
 *
 * Senkou spans are plotted `displacement` bars into the future in a real chart;
 * here they are returned aligned to the bar they were computed from, and the
 * chart shifts them, so the series stays the same length as the candles.
 */
export function ichimoku(candles: Candle[], conversion = 9, base = 26, spanB = 52): {
  conversion: Series; base: Series; spanA: Series; spanB: Series; lagging: Series;
} {
  const midpoint = (period: number): Series => {
    const hh = highest(candles.map((c) => c.high), period);
    const ll = lowest(candles.map((c) => c.low), period);
    return combine(hh, ll, (h, l) => (h + l) / 2);
  };
  const conv = midpoint(conversion);
  const baseline = midpoint(base);
  const lagging: Series = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length - base; i++) lagging[i] = candles[i + base].close;

  return {
    conversion: conv,
    base: baseline,
    spanA: combine(conv, baseline, (a, b) => (a + b) / 2),
    spanB: midpoint(spanB),
    lagging,
  };
}

/** Linear-regression channel: the fitted line plus N-stdev rails. */
export function linearRegressionChannel(values: number[], period = 100, mult = 2): {
  basis: Series; upper: Series; lower: Series;
} {
  const basis: Series = new Array(values.length).fill(null);
  const upper: Series = new Array(values.length).fill(null);
  const lower: Series = new Array(values.length).fill(null);

  for (let i = period - 1; i < values.length; i++) {
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (let k = 0; k < period; k++) {
      const y = values[i - period + 1 + k];
      sumX += k;
      sumY += y;
      sumXY += k * y;
      sumXX += k * k;
    }
    const denom = period * sumXX - sumX * sumX;
    if (denom === 0) continue;
    const slope = (period * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / period;

    // Residual spread around the fit sets the channel width.
    let sq = 0;
    for (let k = 0; k < period; k++) {
      const fit = intercept + slope * k;
      const diff = values[i - period + 1 + k] - fit;
      sq += diff * diff;
    }
    const sd = Math.sqrt(sq / period);
    const end = intercept + slope * (period - 1);
    basis[i] = end;
    upper[i] = end + sd * mult;
    lower[i] = end - sd * mult;
  }
  return { basis, upper, lower };
}

/** Classic floor-trader pivot points, recomputed each bar from the prior bar. */
export function pivotPoints(candles: Candle[]): {
  pivot: Series; r1: Series; r2: Series; s1: Series; s2: Series;
} {
  const mk = (): Series => new Array(candles.length).fill(null);
  const pivot = mk(), r1 = mk(), r2 = mk(), s1 = mk(), s2 = mk();
  for (let i = 1; i < candles.length; i++) {
    const p = candles[i - 1];
    const pp = (p.high + p.low + p.close) / 3;
    pivot[i] = pp;
    r1[i] = 2 * pp - p.low;
    s1[i] = 2 * pp - p.high;
    r2[i] = pp + (p.high - p.low);
    s2[i] = pp - (p.high - p.low);
  }
  return { pivot, r1, r2, s1, s2 };
}

/** Wilder's smoothing exposed for indicators that need it directly. */
export { rma };
