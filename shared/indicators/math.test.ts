/**
 * Indicator math correctness.
 *
 * Expected values are hand-computed or taken from the canonical definitions,
 * not from a previous run of this code — a snapshot of our own output would
 * happily lock in a bug. The seeding conventions asserted here (SMA-seeded
 * EMA, Wilder RMA, population stdev) are the usual reason numbers disagree
 * with other charting platforms.
 */

import { describe, it, expect } from 'vitest';
import type { Candle } from '../types';
import {
  sma, ema, rma, wma, vwma, stdev, highest, lowest, change,
  crossover, crossunder, rsi, macd, atr, trueRange, obv, vwap,
  stochastic, adx, sourceSeries, combine, nz,
} from './math';

/** Build candles from closes, with a fixed intrabar range. */
function candlesFrom(closes: number[], volumes?: number[]): Candle[] {
  return closes.map((c, i) => ({
    time: 1700000000 + i * 86400,
    open: c,
    high: c + 1,
    low: c - 1,
    close: c,
    volume: volumes?.[i] ?? 1000,
    adjClose: c,
  }));
}

const RAMP = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

describe('sma', () => {
  it('is null until the window is full, then averages it', () => {
    const r = sma(RAMP, 3);
    expect(r.slice(0, 2)).toEqual([null, null]);
    expect(r[2]).toBe(2);  // (1+2+3)/3
    expect(r[9]).toBe(9);  // (8+9+10)/3
  });

  it('returns all nulls when there is less data than the period', () => {
    expect(sma([1, 2], 5)).toEqual([null, null]);
  });

  it('stays exact over a long series (no running-sum drift)', () => {
    const values = Array.from({ length: 5000 }, (_, i) => Math.sin(i) * 100 + 500);
    const r = sma(values, 200);
    const manual = values.slice(4800, 5000).reduce((a, b) => a + b, 0) / 200;
    expect(r[4999]!).toBeCloseTo(manual, 8);
  });
});

describe('ema', () => {
  it('seeds from the SMA of the first period, matching TradingView', () => {
    const r = ema(RAMP, 3);
    expect(r.slice(0, 2)).toEqual([null, null]);
    expect(r[2]).toBe(2);              // seed = SMA(1,2,3)
    expect(r[3]).toBeCloseTo(3, 10);   // 4*0.5 + 2*0.5
    expect(r[4]).toBeCloseTo(4, 10);
  });

  it('weights recent data more heavily than sma', () => {
    const values = [...Array(20).fill(10), 100];
    const e = ema(values, 10)!;
    const s = sma(values, 10)!;
    expect(e[20]!).toBeGreaterThan(s[20]!);
  });
});

describe('rma (Wilder)', () => {
  it('smooths more slowly than an ema of the same period', () => {
    const values = [...Array(20).fill(10), 100];
    expect(rma(values, 10)[20]!).toBeLessThan(ema(values, 10)[20]!);
  });

  it('applies the (prev*(n-1)+x)/n recurrence', () => {
    const r = rma(RAMP, 3);
    expect(r[2]).toBe(2);                       // seed = SMA(1,2,3)
    expect(r[3]).toBeCloseTo((2 * 2 + 4) / 3, 10);
  });
});

describe('wma', () => {
  it('weights linearly by recency', () => {
    // (3*3 + 2*2 + 1*1) / 6
    expect(wma([1, 2, 3], 3)[2]).toBeCloseTo(14 / 6, 10);
  });
});

describe('vwma', () => {
  it('lets volume dominate the average', () => {
    const r = vwma([10, 20], [1, 99], 2);
    // Heavily weighted toward the second bar.
    expect(r[1]!).toBeGreaterThan(19);
  });

  it('is null when the window has no volume', () => {
    expect(vwma([10, 20], [0, 0], 2)[1]).toBeNull();
  });
});

describe('stdev', () => {
  it('is the population standard deviation', () => {
    // mean 3, variance (4+1+0+1+4)/5 = 2
    expect(stdev([1, 2, 3, 4, 5], 5)[4]!).toBeCloseTo(Math.SQRT2, 10);
  });

  it('is exactly zero for a flat window, never NaN', () => {
    const r = stdev([5, 5, 5, 5, 5], 5)[4]!;
    expect(r).toBe(0);
    expect(Number.isNaN(r)).toBe(false);
  });
});

describe('highest / lowest', () => {
  it('scans the trailing window', () => {
    const v = [3, 1, 4, 1, 5, 9, 2, 6];
    expect(highest(v, 3)[5]).toBe(9);
    expect(lowest(v, 3)[3]).toBe(1);
  });
});

describe('change', () => {
  it('differences against n bars ago', () => {
    expect(change([10, 12, 15], 1)).toEqual([null, 2, 3]);
    expect(change([10, 12, 15], 2)).toEqual([null, null, 5]);
  });
});

describe('crossover / crossunder', () => {
  it('fires only on the crossing bar', () => {
    const a = [1, 2, 3, 4];
    const b = [3, 3, 3, 3];
    expect(crossover(a, b)).toEqual([false, false, false, true]);
  });

  it('fires on a downward cross', () => {
    expect(crossunder([4, 3, 2], [3, 3, 3])).toEqual([false, false, true]);
  });

  it('treats touch-then-rise as a cross, matching Pine semantics', () => {
    // Equal on the prior bar counts as "at or below".
    expect(crossover([2, 3, 4], [3, 3, 3])[1]).toBe(false);
    expect(crossover([3, 4], [3, 3])[1]).toBe(true);
  });

  it('never fires while either series is still null', () => {
    expect(crossover([null, 5], [null, 1])[1]).toBe(false);
  });
});

describe('rsi', () => {
  it('is 100 when every bar advances', () => {
    expect(rsi(Array.from({ length: 30 }, (_, i) => i + 1), 14)[29]).toBe(100);
  });

  it('is 0 when every bar declines', () => {
    expect(rsi(Array.from({ length: 30 }, (_, i) => 100 - i), 14)[29]).toBeCloseTo(0, 10);
  });

  it('is 50 for symmetric alternating moves', () => {
    const v: number[] = [100];
    for (let i = 1; i < 60; i++) v.push(v[i - 1] + (i % 2 === 0 ? 1 : -1));
    expect(rsi(v, 14)[59]!).toBeGreaterThan(40);
    expect(rsi(v, 14)[59]!).toBeLessThan(60);
  });

  it('stays within 0..100', () => {
    const v = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 3) * 20 + i * 0.1);
    for (const x of rsi(v, 14)) {
      if (x != null) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(100);
      }
    }
  });

  it('is undefined until it has period+1 bars', () => {
    expect(rsi(RAMP, 14).every((v) => v === null)).toBe(true);
  });
});

describe('macd', () => {
  it('is the difference of the two emas', () => {
    const v = Array.from({ length: 100 }, (_, i) => 100 + i);
    const { macd: line } = macd(v, 12, 26, 9);
    const fast = ema(v, 12);
    const slow = ema(v, 26);
    expect(line[99]!).toBeCloseTo(fast[99]! - slow[99]!, 10);
  });

  it('histogram equals macd minus signal', () => {
    const v = Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i / 5) * 10);
    const r = macd(v);
    expect(r.histogram[99]!).toBeCloseTo(r.macd[99]! - r.signal[99]!, 10);
  });

  it('is positive in a sustained uptrend', () => {
    const v = Array.from({ length: 100 }, (_, i) => 100 + i * 2);
    expect(macd(v).macd[99]!).toBeGreaterThan(0);
  });
});

describe('trueRange / atr', () => {
  it('first bar true range is the bar range', () => {
    expect(trueRange(candlesFrom([10, 11]))[0]).toBe(2);
  });

  it('accounts for gaps beyond the bar range', () => {
    const c: Candle[] = [
      { time: 1, open: 10, high: 11, low: 9, close: 10, volume: 0, adjClose: 10 },
      { time: 2, open: 20, high: 21, low: 19, close: 20, volume: 0, adjClose: 20 },
    ];
    // Gap up: |21 - 10| = 11 exceeds the 2-point bar range.
    expect(trueRange(c)[1]).toBe(11);
  });

  it('atr is positive and smooth', () => {
    const a = atr(candlesFrom(Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i) * 5)), 14);
    expect(a[49]!).toBeGreaterThan(0);
  });
});

describe('obv', () => {
  it('adds volume on up bars and subtracts on down bars', () => {
    const c = candlesFrom([10, 11, 10, 10], [100, 200, 300, 400]);
    expect(obv(c)).toEqual([0, 200, -100, -100]);
  });
});

describe('vwap', () => {
  it('resets at each session boundary', () => {
    const c = candlesFrom([10, 20, 30, 40]);
    const r = vwap(c, [true, false, true, false]);
    expect(r[0]).toBeCloseTo(10, 10);
    expect(r[1]).toBeCloseTo(15, 10);
    expect(r[2]).toBeCloseTo(30, 10);  // reset
    expect(r[3]).toBeCloseTo(35, 10);
  });
});

describe('stochastic', () => {
  it('is 100 when the close sits at the window high, 0 at the low', () => {
    // high/low must equal close here: with any intrabar range the close is by
    // definition inside it, so %K could never reach the extremes.
    const flatBars = (closes: number[]): Candle[] =>
      closes.map((c, i) => ({
        time: 1700000000 + i * 86400, open: c, high: c, low: c, close: c, volume: 1000, adjClose: c,
      }));

    const rising = flatBars(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(stochastic(rising, 14, 1, 3).k[29]!).toBeCloseTo(100, 6);

    const falling = flatBars(Array.from({ length: 30 }, (_, i) => 100 - i));
    expect(stochastic(falling, 14, 1, 3).k[29]!).toBeCloseTo(0, 6);
  });

  it('places %K inside the range when bars have an intrabar spread', () => {
    // closes 17..30 with ±1 wicks -> (30-16)/(31-16) = 93.33
    const rising = candlesFrom(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(stochastic(rising, 14, 1, 3).k[29]!).toBeCloseTo((14 / 15) * 100, 6);
  });

  it('returns the neutral 50 for a flat range instead of dividing by zero', () => {
    const flat = candlesFrom(Array(30).fill(10));
    const k = stochastic(flat, 14, 1, 3).k[29]!;
    expect(k).toBe(50);
    expect(Number.isNaN(k)).toBe(false);
  });
});

describe('adx', () => {
  it('reads high for a strong trend and low for chop', () => {
    const trend = candlesFrom(Array.from({ length: 80 }, (_, i) => 100 + i * 2));
    const chop = candlesFrom(Array.from({ length: 80 }, (_, i) => 100 + (i % 2)));
    expect(adx(trend, 14).adx[79]!).toBeGreaterThan(adx(chop, 14).adx[79]!);
  });

  it('puts +DI above -DI in an uptrend', () => {
    const r = adx(candlesFrom(Array.from({ length: 80 }, (_, i) => 100 + i * 2)), 14);
    expect(r.plusDi[79]!).toBeGreaterThan(r.minusDi[79]!);
  });
});

describe('sourceSeries', () => {
  it('computes the synthetic averages', () => {
    const c: Candle[] = [{ time: 1, open: 10, high: 20, low: 0, close: 14, volume: 0, adjClose: 14 }];
    expect(sourceSeries(c, 'hl2')[0]).toBe(10);
    expect(sourceSeries(c, 'hlc3')[0]).toBeCloseTo(34 / 3, 10);
    expect(sourceSeries(c, 'ohlc4')[0]).toBe(11);
  });

  it('rescales the whole bar when using adjusted prices', () => {
    // A 2:1 split: adjClose is half of close, so every field halves.
    const c: Candle[] = [{ time: 1, open: 10, high: 20, low: 0, close: 20, volume: 0, adjClose: 10 }];
    expect(sourceSeries(c, 'high', true)[0]).toBe(10);
    expect(sourceSeries(c, 'close', true)[0]).toBe(10);
  });
});

describe('null propagation', () => {
  it('combine yields null when either input is null', () => {
    expect(combine([1, null, 3], [1, 2, null], (a, b) => a + b)).toEqual([2, null, null]);
  });

  it('nz substitutes for nulls and non-finite values', () => {
    expect(nz([1, null, NaN, Infinity], 0)).toEqual([1, 0, 0, 0]);
  });
});

describe('output length invariant', () => {
  it('every indicator returns exactly one value per input bar', () => {
    const c = candlesFrom(Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 4) * 10));
    const closes = c.map((x) => x.close);
    const n = c.length;

    expect(sma(closes, 50)).toHaveLength(n);
    expect(ema(closes, 50)).toHaveLength(n);
    expect(rsi(closes, 14)).toHaveLength(n);
    expect(atr(c, 14)).toHaveLength(n);
    expect(macd(closes).macd).toHaveLength(n);
    expect(macd(closes).signal).toHaveLength(n);
    expect(stochastic(c).k).toHaveLength(n);
    expect(adx(c).adx).toHaveLength(n);
    expect(obv(c)).toHaveLength(n);
  });
});
