/**
 * Strategies and candlestick patterns.
 *
 * These use the same registry contract as indicators, but their real output is
 * `markers` — the bars where an entry, exit or pattern occurred — rather than a
 * continuous line. Reusing the contract means a strategy is alertable and
 * screenable for free; it does not mean it is backtested. Nothing here reports
 * a P&L, and none of it is advice: the markers say "this condition occurred on
 * this bar", nothing more.
 */

import type { Candle, IndicatorContext, IndicatorDef, IndicatorMarker, Series } from '../types';
import { atr, crossover, crossunder, ema, rsi, sma, sourceSeries, stdev, combine, movingAverage, type MaType } from './math';
import { superTrend } from './extras';

const C = {
  blue: '#2962ff', orange: '#ff6d00', teal: '#26a69a', red: '#ef5350',
  grey: '#787b86', purple: '#9c27b0', yellow: '#ffb300',
};

const SOURCE_PARAM = {
  key: 'source', label: 'Source', type: 'source' as const, default: 'close',
  options: ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4'],
};

const len = (key: string, label: string, def: number) =>
  ({ key, label, type: 'int' as const, default: def, min: 1, max: 1000 });

function src(candles: Candle[], params: Record<string, any>, ctx?: IndicatorContext): number[] {
  return sourceSeries(candles, (params.source ?? 'close') as any, ctx?.useAdjusted ?? false);
}

/** Turn two boolean signal arrays into markers. */
function toMarkers(buys: boolean[], sells: boolean[], buyText: string, sellText: string): IndicatorMarker[] {
  const out: IndicatorMarker[] = [];
  for (let i = 0; i < buys.length; i++) {
    if (buys[i]) out.push({ index: i, side: 'buy', text: buyText });
    else if (sells[i]) out.push({ index: i, side: 'sell', text: sellText });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

const maCrossStrategy: IndicatorDef = {
  id: 'strat_ma_cross', label: 'Moving Average Crossover', kind: 'strategy', category: 'Strategies',
  description: 'Long when the fast average crosses above the slow one, flat when it crosses back. The 50/200 default is the classic Golden Cross.',
  tags: ['golden cross', 'death cross', 'crossover'],
  panel: 'overlay',
  params: [len('fast', 'Fast', 50), len('slow', 'Slow', 200),
    { key: 'maType', label: 'Type', type: 'string', default: 'SMA', options: ['SMA', 'EMA', 'WMA', 'RMA'] }, SOURCE_PARAM],
  plots: [
    { key: 'fast', label: 'Fast', style: 'line', color: C.blue, lineWidth: 2 },
    { key: 'slow', label: 'Slow', style: 'line', color: C.orange, lineWidth: 2 },
  ],
  calc: (c, p, ctx) => {
    const values = src(c, p, ctx);
    const volumes = c.map((x) => x.volume);
    const fast = movingAverage(p.maType as MaType, values, p.fast, volumes);
    const slow = movingAverage(p.maType as MaType, values, p.slow, volumes);
    return {
      series: { fast, slow },
      markers: toMarkers(crossover(fast, slow), crossunder(fast, slow), 'Golden Cross', 'Death Cross'),
    };
  },
};

const rsiReversal: IndicatorDef = {
  id: 'strat_rsi_reversal', label: 'RSI Reversal', kind: 'strategy', category: 'Strategies',
  description: 'Buys as RSI climbs back out of oversold and sells as it drops out of overbought.',
  tags: ['rsi', 'mean reversion', 'oversold', 'overbought'],
  panel: 'separate',
  params: [len('length', 'RSI Length', 14), len('oversold', 'Oversold', 30), len('overbought', 'Overbought', 70), SOURCE_PARAM],
  plots: [{ key: 'rsi', label: 'RSI', style: 'line', color: C.purple, lineWidth: 2 }],
  calc: (c, p, ctx) => {
    const r = rsi(src(c, p, ctx), p.length);
    const buys: boolean[] = new Array(c.length).fill(false);
    const sells: boolean[] = new Array(c.length).fill(false);
    for (let i = 1; i < c.length; i++) {
      const prev = r[i - 1], now = r[i];
      if (prev == null || now == null) continue;
      // The signal is the exit from the zone, not entry into it: oversold can
      // stay oversold for weeks in a downtrend.
      if (prev <= p.oversold && now > p.oversold) buys[i] = true;
      if (prev >= p.overbought && now < p.overbought) sells[i] = true;
    }
    return {
      series: { rsi: r },
      markers: toMarkers(buys, sells, 'RSI exit oversold', 'RSI exit overbought'),
      levels: [
        { value: p.overbought, color: C.red, label: String(p.overbought) },
        { value: p.oversold, color: C.teal, label: String(p.oversold) },
      ],
    };
  },
};

const macdStrategy: IndicatorDef = {
  id: 'strat_macd', label: 'MACD Signal Cross', kind: 'strategy', category: 'Strategies',
  description: 'Entries on the MACD line crossing its signal line.',
  tags: ['macd'],
  panel: 'separate',
  params: [len('fast', 'Fast', 12), len('slow', 'Slow', 26), len('signal', 'Signal', 9), SOURCE_PARAM],
  plots: [
    { key: 'macd', label: 'MACD', style: 'line', color: C.blue, lineWidth: 2 },
    { key: 'signal', label: 'Signal', style: 'line', color: C.orange, lineWidth: 1 },
  ],
  calc: (c, p, ctx) => {
    const values = src(c, p, ctx);
    const line = combine(ema(values, p.fast), ema(values, p.slow), (a, b) => a - b);
    const signal: Series = new Array(values.length).fill(null);
    const k = 2 / (p.signal + 1);
    let prev: number | null = null;
    for (let i = 0; i < line.length; i++) {
      const v = line[i];
      if (v == null) continue;
      prev = prev == null ? v : v * k + prev * (1 - k);
      signal[i] = prev;
    }
    return {
      series: { macd: line, signal },
      markers: toMarkers(crossover(line, signal), crossunder(line, signal), 'MACD cross up', 'MACD cross down'),
      levels: [{ value: 0, color: C.grey }],
    };
  },
};

const bollingerBounce: IndicatorDef = {
  id: 'strat_bb_bounce', label: 'Bollinger Band Bounce', kind: 'strategy', category: 'Strategies',
  description: 'Mean reversion: buys a close back inside the lower band, sells a close back inside the upper.',
  tags: ['bollinger', 'mean reversion', 'bounce'],
  panel: 'overlay',
  params: [len('length', 'Length', 20), { key: 'mult', label: 'Deviations', type: 'float', default: 2, min: 0.1, max: 10 }, SOURCE_PARAM],
  plots: [
    { key: 'upper', label: 'Upper', style: 'line', color: C.grey, lineWidth: 1 },
    { key: 'basis', label: 'Basis', style: 'dashed', color: C.grey, lineWidth: 1 },
    { key: 'lower', label: 'Lower', style: 'line', color: C.grey, lineWidth: 1 },
  ],
  calc: (c, p, ctx) => {
    const values = src(c, p, ctx);
    const basis = sma(values, p.length);
    const sd = stdev(values, p.length);
    const upper = combine(basis, sd, (b, s) => b + s * p.mult);
    const lower = combine(basis, sd, (b, s) => b - s * p.mult);

    const buys: boolean[] = new Array(c.length).fill(false);
    const sells: boolean[] = new Array(c.length).fill(false);
    for (let i = 1; i < c.length; i++) {
      const lo = lower[i], hi = upper[i];
      if (lo == null || hi == null) continue;
      const prevLo = lower[i - 1], prevHi = upper[i - 1];
      if (prevLo == null || prevHi == null) continue;
      if (values[i - 1] < prevLo && values[i] > lo) buys[i] = true;
      if (values[i - 1] > prevHi && values[i] < hi) sells[i] = true;
    }
    return {
      series: { upper, basis, lower },
      markers: toMarkers(buys, sells, 'Re-entered lower band', 'Re-entered upper band'),
    };
  },
};

const superTrendStrategy: IndicatorDef = {
  id: 'strat_supertrend', label: 'SuperTrend Follow', kind: 'strategy', category: 'Strategies',
  description: 'Trend following: flips long or short each time SuperTrend changes side.',
  tags: ['supertrend', 'trend following'],
  panel: 'overlay',
  params: [len('length', 'ATR Length', 10), { key: 'mult', label: 'Multiplier', type: 'float', default: 3, min: 0.5, max: 20 }],
  plots: [{ key: 'trend', label: 'SuperTrend', style: 'line', color: C.teal, lineWidth: 2 }],
  calc: (c, p) => {
    const { trend, direction } = superTrend(c, p.length, p.mult);
    const buys: boolean[] = new Array(c.length).fill(false);
    const sells: boolean[] = new Array(c.length).fill(false);
    for (let i = 1; i < c.length; i++) {
      const prev = direction[i - 1], now = direction[i];
      if (prev == null || now == null || prev === now) continue;
      if (now === 1) buys[i] = true;
      else sells[i] = true;
    }
    return { series: { trend }, markers: toMarkers(buys, sells, 'Trend up', 'Trend down') };
  },
};

const donchianBreakout: IndicatorDef = {
  id: 'strat_donchian', label: 'Donchian Breakout (Turtle)', kind: 'strategy', category: 'Strategies',
  description: 'The Turtle rule: buy a break of the N-bar high, exit on a break of the shorter low.',
  tags: ['turtle', 'donchian', 'breakout'],
  panel: 'overlay',
  params: [len('entry', 'Entry Length', 20), len('exit', 'Exit Length', 10)],
  plots: [
    { key: 'upper', label: 'Entry High', style: 'line', color: C.teal, lineWidth: 1 },
    { key: 'lower', label: 'Exit Low', style: 'line', color: C.red, lineWidth: 1 },
  ],
  calc: (c, p) => {
    const upper: Series = new Array(c.length).fill(null);
    const lower: Series = new Array(c.length).fill(null);
    const buys: boolean[] = new Array(c.length).fill(false);
    const sells: boolean[] = new Array(c.length).fill(false);

    for (let i = 0; i < c.length; i++) {
      // Channels exclude the current bar, otherwise price can never break out
      // of a range it is itself setting.
      if (i >= p.entry) {
        let hi = -Infinity;
        for (let j = i - p.entry; j < i; j++) hi = Math.max(hi, c[j].high);
        upper[i] = hi;
        if (c[i].close > hi) buys[i] = true;
      }
      if (i >= p.exit) {
        let lo = Infinity;
        for (let j = i - p.exit; j < i; j++) lo = Math.min(lo, c[j].low);
        lower[i] = lo;
        if (c[i].close < lo) sells[i] = true;
      }
    }
    return { series: { upper, lower }, markers: toMarkers(buys, sells, 'Breakout', 'Exit') };
  },
};

const atrTrailStop: IndicatorDef = {
  id: 'strat_atr_stop', label: 'ATR Trailing Stop', kind: 'strategy', category: 'Strategies',
  description: 'A stop that trails by a multiple of ATR and never loosens; flips side when hit.',
  tags: ['atr', 'trailing stop', 'chandelier'],
  panel: 'overlay',
  params: [len('length', 'ATR Length', 14), { key: 'mult', label: 'Multiplier', type: 'float', default: 3, min: 0.5, max: 20 }],
  plots: [{ key: 'stop', label: 'Trailing Stop', style: 'line', color: C.yellow, lineWidth: 2 }],
  calc: (c, p) => {
    const range = atr(c, p.length);
    const stop: Series = new Array(c.length).fill(null);
    const buys: boolean[] = new Array(c.length).fill(false);
    const sells: boolean[] = new Array(c.length).fill(false);

    let long = true;
    let level: number | null = null;
    for (let i = 0; i < c.length; i++) {
      const a = range[i];
      if (a == null) continue;
      const offset = a * p.mult;
      if (level == null) {
        level = c[i].close - offset;
      } else if (long) {
        level = Math.max(level, c[i].close - offset);
        if (c[i].close < level) { long = false; level = c[i].close + offset; sells[i] = true; }
      } else {
        level = Math.min(level, c[i].close + offset);
        if (c[i].close > level) { long = true; level = c[i].close - offset; buys[i] = true; }
      }
      stop[i] = level;
    }
    return { series: { stop }, markers: toMarkers(buys, sells, 'Stop flipped long', 'Stop hit') };
  },
};

// ---------------------------------------------------------------------------
// Candlestick patterns
// ---------------------------------------------------------------------------

interface PatternSpec {
  id: string;
  label: string;
  description: string;
  tags?: string[];
  /** Returns 'buy' for bullish, 'sell' for bearish, or null. */
  test(c: Candle[], i: number): 'buy' | 'sell' | null;
  /** Bars of history the test needs before it can run. */
  lookback: number;
}

const body = (c: Candle) => Math.abs(c.close - c.open);
const range = (c: Candle) => c.high - c.low;
const upperWick = (c: Candle) => c.high - Math.max(c.open, c.close);
const lowerWick = (c: Candle) => Math.min(c.open, c.close) - c.low;
const isUp = (c: Candle) => c.close > c.open;

const PATTERN_SPECS: PatternSpec[] = [
  {
    id: 'doji', label: 'Doji', lookback: 0,
    description: 'Open and close almost equal — the session ended undecided.',
    test: (c, i) => (range(c[i]) > 0 && body(c[i]) <= range(c[i]) * 0.05 ? 'neutral' as any : null),
  },
  {
    id: 'hammer', label: 'Hammer', lookback: 1,
    description: 'A long lower wick after a decline: sellers pushed down and were rejected.',
    tags: ['bullish'],
    test: (c, i) => {
      const b = body(c[i]);
      return b > 0 && lowerWick(c[i]) >= b * 2 && upperWick(c[i]) <= b * 0.6 && c[i].close < c[i - 1].close
        ? 'buy' : null;
    },
  },
  {
    id: 'shooting_star', label: 'Shooting Star', lookback: 1,
    description: 'A long upper wick after a rally: buyers pushed up and failed to hold it.',
    tags: ['bearish'],
    test: (c, i) => {
      const b = body(c[i]);
      return b > 0 && upperWick(c[i]) >= b * 2 && lowerWick(c[i]) <= b * 0.6 && c[i].close > c[i - 1].close
        ? 'sell' : null;
    },
  },
  {
    id: 'engulfing', label: 'Engulfing', lookback: 1,
    description: 'The body completely covers the previous one — a decisive change of control.',
    tags: ['bullish', 'bearish'],
    test: (c, i) => {
      const prev = c[i - 1], now = c[i];
      if (body(prev) === 0) return null;
      const covers = Math.max(now.open, now.close) >= Math.max(prev.open, prev.close)
        && Math.min(now.open, now.close) <= Math.min(prev.open, prev.close);
      if (!covers || body(now) <= body(prev)) return null;
      if (isUp(now) && !isUp(prev)) return 'buy';
      if (!isUp(now) && isUp(prev)) return 'sell';
      return null;
    },
  },
  {
    id: 'harami', label: 'Harami', lookback: 1,
    description: 'A small body inside the previous large one — the trend has paused.',
    test: (c, i) => {
      const prev = c[i - 1], now = c[i];
      if (body(prev) === 0 || body(now) >= body(prev) * 0.6) return null;
      const inside = Math.max(now.open, now.close) <= Math.max(prev.open, prev.close)
        && Math.min(now.open, now.close) >= Math.min(prev.open, prev.close);
      if (!inside) return null;
      return isUp(prev) ? 'sell' : 'buy';
    },
  },
  {
    id: 'morning_star', label: 'Morning Star', lookback: 2,
    description: 'Down bar, small indecisive bar, then a strong up bar — a three-session bottom.',
    tags: ['bullish'],
    test: (c, i) => {
      const [a, b, d] = [c[i - 2], c[i - 1], c[i]];
      return !isUp(a) && body(b) <= range(b) * 0.4 && isUp(d) && d.close > (a.open + a.close) / 2
        ? 'buy' : null;
    },
  },
  {
    id: 'evening_star', label: 'Evening Star', lookback: 2,
    description: 'Up bar, small indecisive bar, then a strong down bar — a three-session top.',
    tags: ['bearish'],
    test: (c, i) => {
      const [a, b, d] = [c[i - 2], c[i - 1], c[i]];
      return isUp(a) && body(b) <= range(b) * 0.4 && !isUp(d) && d.close < (a.open + a.close) / 2
        ? 'sell' : null;
    },
  },
  {
    id: 'three_soldiers', label: 'Three White Soldiers', lookback: 2,
    description: 'Three strong up bars in a row, each closing higher — sustained accumulation.',
    tags: ['bullish'],
    test: (c, i) => {
      for (let k = 0; k < 3; k++) {
        const bar = c[i - k];
        if (!isUp(bar) || body(bar) < range(bar) * 0.6) return null;
      }
      // Progressive closes *within the three* bars. Comparing the oldest of
      // them against a fourth bar both over-constrains the pattern and reads
      // past the start of the array on the first testable bar.
      return c[i].close > c[i - 1].close && c[i - 1].close > c[i - 2].close ? 'buy' : null;
    },
  },
  {
    id: 'three_crows', label: 'Three Black Crows', lookback: 2,
    description: 'Three strong down bars in a row, each closing lower — sustained distribution.',
    tags: ['bearish'],
    test: (c, i) => {
      for (let k = 0; k < 3; k++) {
        const bar = c[i - k];
        if (isUp(bar) || body(bar) < range(bar) * 0.6) return null;
      }
      return c[i].close < c[i - 1].close && c[i - 1].close < c[i - 2].close ? 'sell' : null;
    },
  },
  {
    id: 'piercing', label: 'Piercing Line', lookback: 1,
    description: 'An up bar closing back above the midpoint of the previous down bar.',
    tags: ['bullish'],
    test: (c, i) => {
      const prev = c[i - 1], now = c[i];
      // The textbook version demands a gap below the prior *low*, which
      // essentially never happens on a liquid equity. The widely-used form
      // opens below the prior close, which is what actually detects the
      // pattern on real bars.
      return !isUp(prev) && isUp(now) && now.open < prev.close
        && now.close > (prev.open + prev.close) / 2 && now.close < prev.open ? 'buy' : null;
    },
  },
  {
    id: 'dark_cloud', label: 'Dark Cloud Cover', lookback: 1,
    description: 'A down bar closing back below the midpoint of the previous up bar.',
    tags: ['bearish'],
    test: (c, i) => {
      const prev = c[i - 1], now = c[i];
      // Mirrors Piercing Line: opens above the prior close rather than
      // requiring a gap above the prior high.
      return isUp(prev) && !isUp(now) && now.open > prev.close
        && now.close < (prev.open + prev.close) / 2 && now.close > prev.open ? 'sell' : null;
    },
  },
  {
    id: 'marubozu', label: 'Marubozu', lookback: 0,
    description: 'Almost no wick at either end — one side controlled the whole session.',
    test: (c, i) => {
      const r = range(c[i]);
      // 'Little or no shadow' — 90% is the common threshold; 95% is so
      // strict that real daily bars almost never qualify.
      if (r === 0 || body(c[i]) < r * 0.9) return null;
      return isUp(c[i]) ? 'buy' : 'sell';
    },
  },
];

/** Every pattern becomes a registry entry marking the bars where it occurs. */
const PATTERN_DEFS: IndicatorDef[] = PATTERN_SPECS.map((spec) => ({
  id: `pat_${spec.id}`,
  label: spec.label,
  kind: 'pattern' as const,
  category: 'Candlestick Patterns' as const,
  description: spec.description,
  tags: ['pattern', 'candlestick', ...(spec.tags ?? [])],
  panel: 'overlay' as const,
  params: [],
  // Patterns draw no line; the marker is the whole output. An empty plot list
  // keeps the chart from allocating a series it would never fill.
  plots: [],
  calc: (candles: Candle[]) => {
    const markers: IndicatorMarker[] = [];
    for (let i = spec.lookback; i < candles.length; i++) {
      const hit = spec.test(candles, i);
      if (hit) markers.push({ index: i, side: hit, text: spec.label });
    }
    return { series: {}, markers };
  },
}));

export const STRATEGY_DEFS: IndicatorDef[] = [
  maCrossStrategy, rsiReversal, macdStrategy, bollingerBounce,
  superTrendStrategy, donchianBreakout, atrTrailStop,
];

export const PATTERN_INDICATORS: IndicatorDef[] = PATTERN_DEFS;
