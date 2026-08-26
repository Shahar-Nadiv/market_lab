/**
 * Registry-level behaviour: every indicator honours the shared contract, and
 * the moving-average presets this app is built around produce correct numbers.
 */

import { describe, it, expect } from 'vitest';
import type { Candle } from '../types';
import { INDICATORS, PRESETS, getIndicator, defaultParams, runIndicator } from './registry';
import { sma } from './math';

function makeCandles(n: number, fn: (i: number) => number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const c = fn(i);
    return {
      time: 1600000000 + i * 86400,
      open: c, high: c + 0.5, low: c - 0.5, close: c,
      volume: 1_000_000 + i * 1000,
      adjClose: c,
    };
  });
}

const TREND = makeCandles(400, (i) => 100 + i * 0.5 + Math.sin(i / 7) * 4);

describe('registry contract', () => {
  it('every indicator has a unique id', () => {
    const ids = INDICATORS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every declared plot has a matching output series', () => {
    for (const def of INDICATORS) {
      const { result, error } = runIndicator(def.id, TREND, defaultParams(def), {
        benchmark: TREND, timezone: 'UTC', interval: '1d',
      });
      expect(error, `${def.id} errored: ${error}`).toBeUndefined();
      for (const plot of def.plots) {
        expect(result!.series[plot.key], `${def.id} missing series "${plot.key}"`).toBeDefined();
      }
    }
  });

  it('every output series is exactly as long as the input', () => {
    for (const def of INDICATORS) {
      const { result } = runIndicator(def.id, TREND, defaultParams(def), {
        benchmark: TREND, timezone: 'UTC', interval: '1d',
      });
      for (const [key, series] of Object.entries(result!.series)) {
        expect(series.length, `${def.id}.${key} length`).toBe(TREND.length);
      }
    }
  });

  it('every indicator survives a single candle without throwing', () => {
    for (const def of INDICATORS) {
      const { error } = runIndicator(def.id, TREND.slice(0, 1), defaultParams(def), {
        benchmark: TREND, timezone: 'UTC', interval: '1d',
      });
      expect(error, `${def.id} threw on 1 candle`).toBeUndefined();
    }
  });

  it('reports empty input rather than throwing', () => {
    expect(runIndicator('ma', [], {}).error).toBe('No data');
  });

  it('reports an unknown id', () => {
    expect(runIndicator('nope', TREND, {}).error).toMatch(/Unknown indicator/);
  });

  it('fills in defaults for omitted params', () => {
    const { result } = runIndicator('ma', TREND, {});
    // Default length is 200, so the first 199 bars are undefined.
    expect(result!.series.ma[198]).toBeNull();
    expect(result!.series.ma[199]).not.toBeNull();
  });
});

describe('moving averages', () => {
  it('200 DMA matches a hand-computed mean of the last 200 closes', () => {
    const { result } = runIndicator('ma', TREND, { length: 200, maType: 'SMA', source: 'close' });
    const closes = TREND.map((c) => c.close);
    const manual = closes.slice(200, 400).reduce((a, b) => a + b, 0) / 200;
    expect(result!.series.ma[399]!).toBeCloseTo(manual, 8);
  });

  it('150 DMA sits above the 200 DMA in a rising trend', () => {
    const { result } = runIndicator('dma_cross', TREND, { fast: 150, slow: 200 });
    expect(result!.series.fast[399]!).toBeGreaterThan(result!.series.slow[399]!);
  });

  it('150/200 cross inverts when the trend reverses', () => {
    // Rise for 300 bars, then fall hard enough to drag the fast MA under.
    const reversal = makeCandles(600, (i) => (i < 300 ? 100 + i * 0.5 : 250 - (i - 300) * 0.8));
    const { result } = runIndicator('dma_cross', reversal, { fast: 150, slow: 200 });
    expect(result!.series.fast[299]!).toBeGreaterThan(result!.series.slow[299]!);
    expect(result!.series.fast[599]!).toBeLessThan(result!.series.slow[599]!);
  });

  it('respects the MA type parameter', () => {
    const s = runIndicator('ma', TREND, { length: 50, maType: 'SMA' }).result!.series.ma[399]!;
    const e = runIndicator('ma', TREND, { length: 50, maType: 'EMA' }).result!.series.ma[399]!;
    expect(e).not.toBeCloseTo(s, 6);
  });

  it('uses adjusted prices when asked', () => {
    // Halve adjClose across the board: the MA should halve with it.
    const split = TREND.map((c) => ({ ...c, adjClose: c.close / 2 }));
    const raw = runIndicator('ma', split, { length: 50 }, { useAdjusted: false }).result!.series.ma[399]!;
    const adj = runIndicator('ma', split, { length: 50 }, { useAdjusted: true }).result!.series.ma[399]!;
    expect(adj).toBeCloseTo(raw / 2, 6);
  });
});

describe('% distance from MA', () => {
  it('is zero when price equals the average', () => {
    const flat = makeCandles(300, () => 100);
    const { result } = runIndicator('dist_from_ma', flat, { length: 200 });
    expect(result!.series.dist[299]!).toBeCloseTo(0, 10);
  });

  it('is positive above the average and matches the manual percentage', () => {
    const { result } = runIndicator('dist_from_ma', TREND, { length: 200, maType: 'SMA' });
    const closes = TREND.map((c) => c.close);
    const ma = sma(closes, 200)[399]!;
    const expected = ((closes[399] - ma) / ma) * 100;
    expect(result!.series.dist[399]!).toBeCloseTo(expected, 8);
    expect(result!.series.dist[399]!).toBeGreaterThan(0);
  });
});

describe('bollinger bands', () => {
  it('brackets the basis symmetrically', () => {
    const { result } = runIndicator('bbands', TREND, { length: 20, mult: 2 });
    const i = 399;
    const { upper, lower, basis } = result!.series;
    expect(upper[i]!).toBeGreaterThan(basis[i]!);
    expect(lower[i]!).toBeLessThan(basis[i]!);
    expect(upper[i]! - basis[i]!).toBeCloseTo(basis[i]! - lower[i]!, 8);
  });

  it('collapses to the basis on flat data', () => {
    const flat = makeCandles(100, () => 50);
    const { result } = runIndicator('bbands', flat, { length: 20, mult: 2 });
    expect(result!.series.upper[99]!).toBeCloseTo(50, 8);
    expect(result!.series.lower[99]!).toBeCloseTo(50, 8);
  });
});

describe('donchian channels', () => {
  it('bands enclose price and the basis is their midpoint', () => {
    const { result } = runIndicator('donchian', TREND, { length: 20 });
    const i = 399;
    const { upper, lower, basis } = result!.series;
    expect(upper[i]!).toBeGreaterThanOrEqual(TREND[i].high);
    expect(lower[i]!).toBeLessThanOrEqual(TREND[i].low);
    expect(basis[i]!).toBeCloseTo((upper[i]! + lower[i]!) / 2, 10);
  });
});

describe('relative strength', () => {
  it('is flat at 100 against itself', () => {
    const { result } = runIndicator('rel_strength', TREND, { smooth: 1 }, { benchmark: TREND });
    expect(result!.series.rs[399]!).toBeCloseTo(100, 6);
  });

  it('rises when the symbol outperforms', () => {
    const strong = TREND.map((c, i) => ({ ...c, close: c.close * (1 + i / 1000) }));
    const { result } = runIndicator('rel_strength', strong, { smooth: 1 }, { benchmark: TREND });
    expect(result!.series.rs[399]!).toBeGreaterThan(100);
  });

  it('yields nulls with no benchmark rather than throwing', () => {
    const { result, error } = runIndicator('rel_strength', TREND, {}, {});
    expect(error).toBeUndefined();
    expect(result!.series.rs.every((v) => v === null)).toBe(true);
  });

  it('carries the benchmark forward across mismatched trading days', () => {
    // Benchmark missing every other bar, as with differing exchange holidays.
    const sparse = TREND.filter((_, i) => i % 2 === 0);
    const { result } = runIndicator('rel_strength', TREND, {}, { benchmark: sparse });
    expect(result!.series.rs[399]).not.toBeNull();
  });
});

describe('vwap anchoring', () => {
  it('does not reset every bar on a daily timeframe', () => {
    // If it reset per bar, VWAP would equal hlc3 of that bar exactly.
    const { result } = runIndicator('vwap', TREND, {}, { timezone: 'UTC', interval: '1d' });
    const hlc3 = (TREND[399].high + TREND[399].low + TREND[399].close) / 3;
    expect(result!.series.vwap[399]!).not.toBeCloseTo(hlc3, 6);
  });
});

describe('presets', () => {
  it('all reference a real indicator and run clean', () => {
    for (const p of PRESETS) {
      expect(getIndicator(p.indicatorId), `preset ${p.id}`).toBeDefined();
      const { error } = runIndicator(p.indicatorId, TREND, p.params, { benchmark: TREND, interval: '1d' });
      expect(error, `preset ${p.id}: ${error}`).toBeUndefined();
    }
  });

  it('ship the DMA lengths the app is built around', () => {
    const lengths = PRESETS.filter((p) => p.indicatorId === 'ma').map((p) => p.params.length);
    expect(lengths).toEqual(expect.arrayContaining([20, 50, 100, 150, 200]));
  });

  it('golden cross preset is the 150/200 pair', () => {
    const gc = PRESETS.find((p) => p.id === 'goldenCross')!;
    expect(gc.params.fast).toBe(150);
    expect(gc.params.slow).toBe(200);
  });
});
