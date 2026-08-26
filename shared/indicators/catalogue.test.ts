/**
 * Contract tests across the *whole* library, not just the original core.
 *
 * The catalogue is large and hand-written, so the risk is not a subtly wrong
 * number in one indicator — it is a whole entry that throws, misaligns by a
 * bar, or declares a plot it never fills, and is only discovered when a user
 * clicks it. These checks run every entry against several shapes of input.
 */

import { describe, it, expect } from 'vitest';
import type { Candle, IndicatorDef } from '../types';
import { ALL_INDICATORS, defaultParams, runIndicator } from './registry';

function makeCandles(n: number, close: (i: number) => number, volume: (i: number) => number = () => 1_000_000): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const c = close(i);
    const spread = Math.max(0.5, Math.abs(c) * 0.01);
    return {
      time: 1600000000 + i * 86400,
      open: c - spread / 3,
      high: c + spread,
      low: c - spread,
      close: c,
      volume: volume(i),
      adjClose: c,
    };
  });
}

/** A trending, oscillating series long enough for every default lookback. */
const TREND = makeCandles(400, (i) => 100 + i * 0.5 + Math.sin(i / 7) * 6);
/** Pathological but legal: perfectly flat, so every range and deviation is zero. */
const FLAT = makeCandles(300, () => 100, () => 0);
/** A hard crash then recovery, which exercises the trend-flip branches. */
const SHOCK = makeCandles(300, (i) => (i < 150 ? 200 - i * 0.8 : 80 + (i - 150) * 1.2));

const CTX = { benchmark: TREND, timezone: 'UTC', interval: '1d' as const };

function run(def: IndicatorDef, candles: Candle[]) {
  return runIndicator(def.id, candles, defaultParams(def), CTX);
}

describe('library catalogue', () => {
  it('is substantial and covers indicators, strategies and patterns', () => {
    const kinds = new Set(ALL_INDICATORS.map((d) => d.kind ?? 'indicator'));
    expect(ALL_INDICATORS.length).toBeGreaterThan(50);
    expect(kinds.has('indicator')).toBe(true);
    expect(kinds.has('strategy')).toBe(true);
    expect(kinds.has('pattern')).toBe(true);
  });

  it('every entry has a unique id', () => {
    const ids = ALL_INDICATORS.map((d) => d.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes, `duplicate ids: ${dupes.join(', ')}`).toEqual([]);
  });

  it('every entry is labelled, described and categorised', () => {
    for (const def of ALL_INDICATORS) {
      expect(def.label, `${def.id} has no label`).toBeTruthy();
      expect(def.description, `${def.id} has no description`).toBeTruthy();
      expect(def.category, `${def.id} has no category`).toBeTruthy();
    }
  });

  it('every declared plot is actually produced', () => {
    for (const def of ALL_INDICATORS) {
      const { result, error } = run(def, TREND);
      expect(error, `${def.id} errored: ${error}`).toBeUndefined();
      for (const plot of def.plots) {
        expect(result!.series[plot.key], `${def.id} declares plot "${plot.key}" but never fills it`).toBeDefined();
      }
    }
  });

  it('every output series aligns bar-for-bar with the input', () => {
    for (const def of ALL_INDICATORS) {
      const { result } = run(def, TREND);
      for (const [key, series] of Object.entries(result!.series)) {
        expect(series.length, `${def.id}.${key} is ${series.length}, expected ${TREND.length}`).toBe(TREND.length);
      }
    }
  });

  it('produces no NaN or Infinity in any output', () => {
    for (const def of ALL_INDICATORS) {
      const { result } = run(def, TREND);
      for (const [key, series] of Object.entries(result!.series)) {
        const bad = series.findIndex((v) => v != null && !Number.isFinite(v));
        expect(bad, `${def.id}.${key} has a non-finite value at bar ${bad}`).toBe(-1);
      }
    }
  });

  it('survives a flat series, where every range and deviation is zero', () => {
    for (const def of ALL_INDICATORS) {
      const { error, result } = run(def, FLAT);
      expect(error, `${def.id} errored on a flat series: ${error}`).toBeUndefined();
      for (const [key, series] of Object.entries(result!.series)) {
        const bad = series.findIndex((v) => v != null && !Number.isFinite(v));
        expect(bad, `${def.id}.${key} went non-finite on flat input at bar ${bad}`).toBe(-1);
      }
    }
  });

  it('survives a trend reversal without throwing', () => {
    for (const def of ALL_INDICATORS) {
      const { error } = run(def, SHOCK);
      expect(error, `${def.id} errored on a reversal: ${error}`).toBeUndefined();
    }
  });

  it('survives a series far shorter than its lookback', () => {
    for (const len of [1, 2, 5]) {
      for (const def of ALL_INDICATORS) {
        const { error } = run(def, TREND.slice(0, len));
        expect(error, `${def.id} threw on ${len} candle(s): ${error}`).toBeUndefined();
      }
    }
  });

  it('markers are in range, and only strategies and patterns emit them', () => {
    for (const def of ALL_INDICATORS) {
      const { result } = run(def, TREND);
      const markers = result!.markers ?? [];
      if (markers.length > 0) {
        expect(def.kind, `${def.id} emits markers but is kind "${def.kind}"`).not.toBe('indicator');
      }
      for (const m of markers) {
        expect(m.index, `${def.id} marker index ${m.index} out of range`).toBeGreaterThanOrEqual(0);
        expect(m.index, `${def.id} marker index ${m.index} out of range`).toBeLessThan(TREND.length);
      }
    }
  });

  it('every strategy actually signals on a series that reverses', () => {
    const strategies = ALL_INDICATORS.filter((d) => d.kind === 'strategy');
    expect(strategies.length).toBeGreaterThan(4);
    for (const def of strategies) {
      const { result } = run(def, SHOCK);
      expect(result!.markers?.length ?? 0, `${def.id} produced no signal across a full reversal`).toBeGreaterThan(0);
    }
  });

  it('patterns declare no plots and mark only real bars', () => {
    const patterns = ALL_INDICATORS.filter((d) => d.kind === 'pattern');
    expect(patterns.length).toBeGreaterThan(8);
    for (const def of patterns) {
      expect(def.plots.length, `${def.id} is a pattern but declares plots`).toBe(0);
      const { result } = run(def, TREND);
      for (const m of result!.markers ?? []) {
        expect(Number.isInteger(m.index), `${def.id} marker index is not an integer`).toBe(true);
      }
    }
  });

  it('parameter defaults are within their own declared bounds', () => {
    for (const def of ALL_INDICATORS) {
      for (const p of def.params) {
        if (typeof p.default === 'number') {
          if (p.min != null) expect(p.default, `${def.id}.${p.key} default below min`).toBeGreaterThanOrEqual(p.min);
          if (p.max != null) expect(p.default, `${def.id}.${p.key} default above max`).toBeLessThanOrEqual(p.max);
        }
        if (p.options) {
          expect(p.options, `${def.id}.${p.key} default is not one of its options`).toContain(p.default as string);
        }
      }
    }
  });
});

/**
 * A pattern that can never fire is a silent bug: it shows in the library, adds
 * to the chart, and simply does nothing forever.
 *
 * Each case is a hand-built bar sequence containing exactly one textbook
 * instance of the pattern, asserted to be detected on its final bar. Fishing
 * for patterns in a random series was the obvious alternative and a bad one:
 * three-bar formations occur roughly twice in six thousand random bars, so the
 * result turned on the seed rather than on the detector.
 */
describe('pattern detection', () => {
  /** `bar(open, high, low, close)` — time and volume are irrelevant here. */
  let clock = 1600000000;
  const bar = (open: number, high: number, low: number, close: number): Candle => ({
    time: (clock += 86400), open, high, low, close, volume: 1_000_000, adjClose: close,
  });

  /** Filler so three-bar patterns have somewhere to sit. */
  const flat = () => bar(100, 100.5, 99.5, 100);

  const CASES: { id: string; label: string; bars: Candle[]; side: 'buy' | 'sell' | 'neutral' }[] = [
    { id: 'pat_doji', label: 'Doji', side: 'neutral', bars: [flat(), bar(100, 101, 99, 100)] },

    // Falls versus the prior close, then a long lower wick.
    { id: 'pat_hammer', label: 'Hammer', side: 'buy',
      bars: [bar(100, 100.5, 99.5, 100), bar(96, 96.8, 93, 96.5)] },

    // Rises versus the prior close, then a long upper wick.
    { id: 'pat_shooting_star', label: 'Shooting Star', side: 'sell',
      bars: [bar(100, 100.5, 99.5, 100), bar(103.5, 107, 103.2, 104)] },

    { id: 'pat_engulfing', label: 'Engulfing', side: 'buy',
      bars: [bar(100, 100.2, 97.8, 98), bar(97.5, 101.2, 97.3, 101)] },

    // Small body sitting entirely inside the previous, larger one.
    { id: 'pat_harami', label: 'Harami', side: 'buy',
      bars: [bar(100, 100.5, 89.5, 90), bar(94, 96.5, 93.5, 96)] },

    { id: 'pat_morning_star', label: 'Morning Star', side: 'buy',
      bars: [bar(100, 100.5, 89.5, 90), bar(89.5, 90.5, 88.5, 89.7), bar(90, 97, 89.8, 96)] },

    { id: 'pat_evening_star', label: 'Evening Star', side: 'sell',
      bars: [bar(90, 100.5, 89.5, 100), bar(100.3, 101.5, 99.5, 100.6), bar(100, 100.2, 92, 93)] },

    { id: 'pat_three_soldiers', label: 'Three White Soldiers', side: 'buy',
      bars: [bar(100, 104.2, 99.9, 104), bar(104, 108.2, 103.9, 108), bar(108, 112.2, 107.9, 112)] },

    { id: 'pat_three_crows', label: 'Three Black Crows', side: 'sell',
      bars: [bar(112, 112.1, 107.8, 108), bar(108, 108.1, 103.8, 104), bar(104, 104.1, 99.8, 100)] },

    // Opens below the prior close, closes back above the prior midpoint.
    { id: 'pat_piercing', label: 'Piercing Line', side: 'buy',
      bars: [bar(100, 100.5, 94.5, 95), bar(94, 98.5, 93.8, 98)] },

    { id: 'pat_dark_cloud', label: 'Dark Cloud Cover', side: 'sell',
      bars: [bar(95, 100.5, 94.5, 100), bar(101, 101.2, 96.8, 97)] },

    // Almost no wick at either end.
    { id: 'pat_marubozu', label: 'Marubozu', side: 'buy',
      bars: [flat(), bar(100, 105.05, 99.95, 105)] },
  ];

  it('covers every registered pattern', () => {
    const registered = ALL_INDICATORS.filter((d) => d.kind === 'pattern').map((d) => d.id).sort();
    const covered = CASES.map((c) => c.id).sort();
    expect(covered, 'a registered pattern has no detection test').toEqual(registered);
  });

  for (const c of CASES) {
    it(`detects ${c.label}`, () => {
      const def = ALL_INDICATORS.find((d) => d.id === c.id)!;
      const { result, error } = runIndicator(def.id, c.bars, defaultParams(def), CTX);
      expect(error, `${c.id} errored: ${error}`).toBeUndefined();
      const hit = (result!.markers ?? []).find((m) => m.index === c.bars.length - 1);
      expect(hit, `${c.label} was not detected on its final bar`).toBeDefined();
      expect(hit!.side, `${c.label} detected with the wrong side`).toBe(c.side);
    });
  }
});
