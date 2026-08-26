/**
 * The indicator catalogue.
 *
 * One registry entry describes everything any surface needs: what parameters
 * to render in a settings dialog, what plots to draw, and how to compute the
 * values. Adding an entry here makes an indicator available to the chart, the
 * script API, the alert engine and the screener at once — there is no
 * per-surface wiring.
 */

import type { Candle, IndicatorContext, IndicatorDef, IndicatorResult, PriceSource, Series } from '../types';
import { MORE_INDICATORS } from './more';
import { PATTERN_INDICATORS, STRATEGY_DEFS } from './strategies';
import { dateKeyInZone } from '../exchanges';
import {
  adx, atr, combine, donchianBands, ema, highest, lowest, macd, mapSeries,
  movingAverage, obv, rsi, sma, sourceSeries, stdev, stochastic, vwap, type MaType,
} from './math';

const COLORS = {
  blue: '#2962ff',
  orange: '#ff6d00',
  purple: '#9c27b0',
  teal: '#26a69a',
  red: '#ef5350',
  yellow: '#ffb300',
  grey: '#787b86',
  green: '#66bb6a',
};

const SOURCE_PARAM = {
  key: 'source',
  label: 'Source',
  type: 'source' as const,
  default: 'close',
  options: ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4'],
};

const MA_TYPE_PARAM = {
  key: 'maType',
  label: 'Type',
  type: 'string' as const,
  default: 'SMA',
  options: ['SMA', 'EMA', 'WMA', 'VWMA', 'RMA'],
};

function src(candles: Candle[], params: Record<string, any>, ctx?: IndicatorContext): number[] {
  return sourceSeries(candles, (params.source ?? 'close') as PriceSource, ctx?.useAdjusted ?? false);
}

// ---------------------------------------------------------------------------
// Moving averages
// ---------------------------------------------------------------------------

const maIndicator: IndicatorDef = {
  id: 'ma',
  category: 'Moving Averages',
  label: 'Moving Average',
  description: 'Single moving average. Set the length to 150 or 200 for DMA work.',
  panel: 'overlay',
  params: [
    { key: 'length', label: 'Length', type: 'int', default: 200, min: 1, max: 2000 },
    MA_TYPE_PARAM,
    SOURCE_PARAM,
  ],
  plots: [{ key: 'ma', label: 'MA', style: 'line', color: COLORS.orange, lineWidth: 2 }],
  calc(candles, params, ctx) {
    const values = src(candles, params, ctx);
    const volumes = candles.map((c) => c.volume);
    return { series: { ma: movingAverage((params.maType ?? 'SMA') as MaType, values, params.length ?? 200, volumes) } };
  },
};

/**
 * The 150/200 DMA pair with cross markers — the headline use case.
 *
 * Kept as its own entry rather than two separate MAs so the golden/death cross
 * logic, and the `alertcondition` the alert engine binds to, live in one place.
 */
const dmaCross: IndicatorDef = {
  id: 'dma_cross',
  category: 'Moving Averages',
  label: 'Golden / Death Cross (150 & 200 DMA)',
  description: 'Two DMAs with crossover markers. Defaults to the classic 150/200 pair.',
  panel: 'overlay',
  params: [
    { key: 'fast', label: 'Fast length', type: 'int', default: 150, min: 1, max: 2000 },
    { key: 'slow', label: 'Slow length', type: 'int', default: 200, min: 1, max: 2000 },
    MA_TYPE_PARAM,
    SOURCE_PARAM,
  ],
  plots: [
    { key: 'fast', label: 'Fast DMA', style: 'line', color: COLORS.blue, lineWidth: 2 },
    { key: 'slow', label: 'Slow DMA', style: 'line', color: COLORS.orange, lineWidth: 2 },
  ],
  calc(candles, params, ctx) {
    const values = src(candles, params, ctx);
    const volumes = candles.map((c) => c.volume);
    const type = (params.maType ?? 'SMA') as MaType;
    return {
      series: {
        fast: movingAverage(type, values, params.fast ?? 150, volumes),
        slow: movingAverage(type, values, params.slow ?? 200, volumes),
      },
    };
  },
};

/**
 * How far price sits above or below its long MA, in percent.
 *
 * More useful than the raw MA for screening: it makes "extended" and
 * "reclaiming the 200" directly comparable across different-priced symbols.
 */
const distanceFromMa: IndicatorDef = {
  id: 'dist_from_ma',
  category: 'Moving Averages',
  label: '% Distance from MA',
  description: 'Percent above/below a moving average. Defaults to the 200 DMA.',
  panel: 'separate',
  params: [
    { key: 'length', label: 'Length', type: 'int', default: 200, min: 1, max: 2000 },
    MA_TYPE_PARAM,
    SOURCE_PARAM,
  ],
  plots: [{ key: 'dist', label: '% from MA', style: 'area', color: COLORS.purple, lineWidth: 2 }],
  calc(candles, params, ctx) {
    const values = src(candles, params, ctx);
    const volumes = candles.map((c) => c.volume);
    const line = movingAverage((params.maType ?? 'SMA') as MaType, values, params.length ?? 200, volumes);
    const dist: Series = line.map((m, i) => (m == null || m === 0 ? null : ((values[i] - m) / m) * 100));
    return { series: { dist }, levels: [{ value: 0, color: COLORS.grey, label: 'MA' }] };
  },
};

const bollinger: IndicatorDef = {
  id: 'bbands',
  description: 'A moving average with standard-deviation rails. Price spends most of its time inside them, so the edges mark stretch.',
  tags: ['bollinger', 'bb'],
  category: 'Bands & Channels',
  label: 'Bollinger Bands',
  panel: 'overlay',
  params: [
    { key: 'length', label: 'Length', type: 'int', default: 20, min: 1, max: 500 },
    { key: 'mult', label: 'Std dev', type: 'float', default: 2, min: 0.1, max: 10 },
    SOURCE_PARAM,
  ],
  plots: [
    { key: 'upper', label: 'Upper', style: 'line', color: COLORS.blue, lineWidth: 1 },
    { key: 'basis', label: 'Basis', style: 'dashed', color: COLORS.orange, lineWidth: 1 },
    { key: 'lower', label: 'Lower', style: 'line', color: COLORS.blue, lineWidth: 1 },
  ],
  calc(candles, params, ctx) {
    const values = src(candles, params, ctx);
    const length = params.length ?? 20;
    const mult = params.mult ?? 2;
    const basis = sma(values, length);
    const dev = stdev(values, length);
    return {
      series: {
        basis,
        upper: combine(basis, dev, (b, d) => b + mult * d),
        lower: combine(basis, dev, (b, d) => b - mult * d),
      },
    };
  },
};

const donchian: IndicatorDef = {
  id: 'donchian',
  description: 'The highest high and lowest low of the last N bars — the range a breakout has to clear.',
  tags: ['donchian', 'channel'],
  category: 'Bands & Channels',
  label: 'Donchian Channels',
  panel: 'overlay',
  params: [{ key: 'length', label: 'Length', type: 'int', default: 20, min: 1, max: 500 }],
  plots: [
    { key: 'upper', label: 'Upper', style: 'line', color: COLORS.teal, lineWidth: 1 },
    { key: 'basis', label: 'Basis', style: 'dashed', color: COLORS.grey, lineWidth: 1 },
    { key: 'lower', label: 'Lower', style: 'line', color: COLORS.red, lineWidth: 1 },
  ],
  calc(candles, params) {
    return { series: donchianBands(candles, params.length ?? 20) };
  },
};

/** 52-week extremes, drawn as bands on the price pane. */
const range52w: IndicatorDef = {
  id: 'range_52w',
  description: 'The 52-week high and low, the reference levels most of the market watches.',
  tags: ['52 week', 'high low'],
  category: 'Support & Resistance',
  label: '52-Week High / Low',
  panel: 'overlay',
  params: [{ key: 'bars', label: 'Lookback bars', type: 'int', default: 252, min: 2, max: 2000 }],
  plots: [
    { key: 'high', label: '52w High', style: 'dashed', color: COLORS.teal, lineWidth: 1 },
    { key: 'low', label: '52w Low', style: 'dashed', color: COLORS.red, lineWidth: 1 },
  ],
  calc(candles, params) {
    const bars = params.bars ?? 252;
    return {
      series: {
        high: highest(candles.map((c) => c.high), bars),
        low: lowest(candles.map((c) => c.low), bars),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Oscillators
// ---------------------------------------------------------------------------

const rsiIndicator: IndicatorDef = {
  id: 'rsi',
  description: 'Speed and size of recent gains against losses, 0–100. Above 70 is stretched, below 30 is washed out.',
  tags: ['rsi', 'relative strength index'],
  category: 'Momentum',
  label: 'RSI',
  panel: 'separate',
  params: [
    { key: 'length', label: 'Length', type: 'int', default: 14, min: 1, max: 500 },
    SOURCE_PARAM,
  ],
  plots: [{ key: 'rsi', label: 'RSI', style: 'line', color: COLORS.purple, lineWidth: 2 }],
  calc(candles, params, ctx) {
    return {
      series: { rsi: rsi(src(candles, params, ctx), params.length ?? 14) },
      levels: [
        { value: 70, color: COLORS.red, label: 'Overbought' },
        { value: 50, color: COLORS.grey },
        { value: 30, color: COLORS.teal, label: 'Oversold' },
      ],
    };
  },
};

const macdIndicator: IndicatorDef = {
  id: 'macd',
  description: 'The spread between two EMAs against its own signal line — trend momentum and its turns.',
  tags: ['macd'],
  category: 'Momentum',
  label: 'MACD',
  panel: 'separate',
  params: [
    { key: 'fast', label: 'Fast', type: 'int', default: 12, min: 1, max: 200 },
    { key: 'slow', label: 'Slow', type: 'int', default: 26, min: 1, max: 500 },
    { key: 'signal', label: 'Signal', type: 'int', default: 9, min: 1, max: 200 },
    SOURCE_PARAM,
  ],
  plots: [
    { key: 'macd', label: 'MACD', style: 'line', color: COLORS.blue, lineWidth: 2 },
    { key: 'signal', label: 'Signal', style: 'line', color: COLORS.orange, lineWidth: 1 },
    { key: 'histogram', label: 'Histogram', style: 'histogram', color: COLORS.grey, lineWidth: 1 },
  ],
  calc(candles, params, ctx) {
    const r = macd(src(candles, params, ctx), params.fast ?? 12, params.slow ?? 26, params.signal ?? 9);
    return {
      series: { macd: r.macd, signal: r.signal, histogram: r.histogram },
      levels: [{ value: 0, color: COLORS.grey }],
    };
  },
};

const stochIndicator: IndicatorDef = {
  id: 'stoch',
  description: 'Where the close sits within the recent range, smoothed. Classic overbought and oversold readings.',
  tags: ['stochastic', 'stoch'],
  category: 'Momentum',
  label: 'Stochastic',
  panel: 'separate',
  params: [
    { key: 'k', label: '%K length', type: 'int', default: 14, min: 1, max: 500 },
    { key: 'kSmooth', label: '%K smoothing', type: 'int', default: 1, min: 1, max: 100 },
    { key: 'd', label: '%D smoothing', type: 'int', default: 3, min: 1, max: 100 },
  ],
  plots: [
    { key: 'k', label: '%K', style: 'line', color: COLORS.blue, lineWidth: 2 },
    { key: 'd', label: '%D', style: 'line', color: COLORS.orange, lineWidth: 1 },
  ],
  calc(candles, params) {
    const r = stochastic(candles, params.k ?? 14, params.kSmooth ?? 1, params.d ?? 3);
    return {
      series: { k: r.k, d: r.d },
      levels: [
        { value: 80, color: COLORS.red },
        { value: 20, color: COLORS.teal },
      ],
    };
  },
};

const adxIndicator: IndicatorDef = {
  id: 'adx',
  description: 'Trend strength regardless of direction, with the +DI/-DI pair showing which side is winning.',
  tags: ['adx', 'dmi', 'directional'],
  category: 'Trend',
  label: 'ADX / DMI',
  panel: 'separate',
  params: [{ key: 'length', label: 'Length', type: 'int', default: 14, min: 1, max: 200 }],
  plots: [
    { key: 'adx', label: 'ADX', style: 'line', color: COLORS.yellow, lineWidth: 2 },
    { key: 'plusDi', label: '+DI', style: 'line', color: COLORS.teal, lineWidth: 1 },
    { key: 'minusDi', label: '-DI', style: 'line', color: COLORS.red, lineWidth: 1 },
  ],
  calc(candles, params) {
    const r = adx(candles, params.length ?? 14);
    return {
      series: { adx: r.adx, plusDi: r.plusDi, minusDi: r.minusDi },
      // 25 is the conventional threshold between trend and chop.
      levels: [{ value: 25, color: COLORS.grey, label: 'Trend' }],
    };
  },
};

const atrIndicator: IndicatorDef = {
  id: 'atr',
  description: 'Average true range: how far this instrument typically moves in a bar. The basis for position sizing and stops.',
  tags: ['atr', 'true range'],
  category: 'Volatility',
  label: 'ATR',
  panel: 'separate',
  params: [{ key: 'length', label: 'Length', type: 'int', default: 14, min: 1, max: 200 }],
  plots: [{ key: 'atr', label: 'ATR', style: 'line', color: COLORS.yellow, lineWidth: 2 }],
  calc(candles, params) {
    return { series: { atr: atr(candles, params.length ?? 14) } };
  },
};

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------

const volumeIndicator: IndicatorDef = {
  id: 'volume',
  description: 'Traded volume with its moving average, so unusually heavy bars stand out.',
  tags: ['volume', 'vol'],
  category: 'Volume',
  label: 'Volume + Average',
  panel: 'separate',
  params: [{ key: 'length', label: 'Average length', type: 'int', default: 20, min: 1, max: 500 }],
  plots: [
    { key: 'volume', label: 'Volume', style: 'histogram', color: COLORS.grey, lineWidth: 1 },
    { key: 'average', label: 'Average', style: 'line', color: COLORS.orange, lineWidth: 1 },
  ],
  calc(candles, params) {
    const volumes = candles.map((c) => c.volume);
    return { series: { volume: volumes as Series, average: sma(volumes, params.length ?? 20) } };
  },
};

const obvIndicator: IndicatorDef = {
  id: 'obv',
  description: "Running total of volume signed by the day's direction — whether volume is confirming price.",
  tags: ['obv', 'on balance volume'],
  category: 'Volume',
  label: 'On-Balance Volume',
  panel: 'separate',
  params: [],
  plots: [{ key: 'obv', label: 'OBV', style: 'line', color: COLORS.teal, lineWidth: 2 }],
  calc(candles) {
    return { series: { obv: obv(candles) } };
  },
};

const vwapIndicator: IndicatorDef = {
  id: 'vwap',
  description: 'Volume-weighted average price for the session, the level institutional fills are measured against.',
  tags: ['vwap'],
  category: 'Volume',
  label: 'VWAP (session anchored)',
  panel: 'overlay',
  params: [],
  plots: [{ key: 'vwap', label: 'VWAP', style: 'line', color: COLORS.purple, lineWidth: 2 }],
  calc(candles, _params, ctx) {
    const tz = ctx?.timezone ?? 'UTC';
    // A new session starts wherever the local calendar date changes. On daily
    // and higher timeframes every bar is its own day, which would reset VWAP
    // on every bar and make it identical to hlc3 — so anchor cumulatively there.
    const perBarIsADay = ctx?.interval ? ['1d', '1wk', '1mo'].includes(ctx.interval) : false;
    const boundaries = candles.map((c, i) => {
      if (perBarIsADay) return i === 0;
      if (i === 0) return true;
      return dateKeyInZone(c.time, tz) !== dateKeyInZone(candles[i - 1].time, tz);
    });
    return { series: { vwap: vwap(candles, boundaries) } };
  },
};

// ---------------------------------------------------------------------------
// Relative strength
// ---------------------------------------------------------------------------

/**
 * Performance against a benchmark, rebased to 100 at the start of the window.
 *
 * Rising means outperformance regardless of overall market direction, which is
 * the question "is this stock leading or lagging?" asked directly.
 */
const relativeStrength: IndicatorDef = {
  id: 'rel_strength',
  category: 'Breadth & Relative',
  label: 'Relative Strength vs Benchmark',
  description: 'Symbol / benchmark ratio, rebased to 100. Rising = outperforming.',
  panel: 'separate',
  params: [{ key: 'smooth', label: 'Smoothing', type: 'int', default: 1, min: 1, max: 200 }],
  plots: [{ key: 'rs', label: 'RS', style: 'line', color: COLORS.green, lineWidth: 2 }],
  calc(candles, params, ctx) {
    const bench = ctx?.benchmark;
    if (!bench?.length) return { series: { rs: new Array(candles.length).fill(null) } };

    // Benchmark bars rarely align 1:1 with the symbol's (different exchanges,
    // different holidays), so match on timestamp and carry the last known
    // benchmark value forward across gaps.
    const byTime = new Map(bench.map((b) => [b.time, b.close]));
    let last: number | null = null;
    const ratio: Series = candles.map((c) => {
      const b = byTime.get(c.time);
      if (b != null && b !== 0) last = b;
      return last == null || last === 0 ? null : c.close / last;
    });

    const firstIdx = ratio.findIndex((v) => v != null);
    if (firstIdx < 0) return { series: { rs: ratio } };
    const base = ratio[firstIdx]!;
    const rebased = mapSeries(ratio, (v) => (v / base) * 100);

    const smooth = params.smooth ?? 1;
    const out = smooth > 1
      ? (() => {
          const dense = rebased.slice(firstIdx).map((v) => v ?? 0);
          const smoothed = ema(dense, smooth);
          const padded: Series = new Array(candles.length).fill(null);
          for (let i = 0; i < smoothed.length; i++) padded[firstIdx + i] = smoothed[i];
          return padded;
        })()
      : rebased;

    return { series: { rs: out }, levels: [{ value: 100, color: COLORS.grey, label: 'Benchmark' }] };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const INDICATORS: IndicatorDef[] = [
  maIndicator,
  dmaCross,
  distanceFromMa,
  bollinger,
  donchian,
  range52w,
  vwapIndicator,
  rsiIndicator,
  macdIndicator,
  stochIndicator,
  adxIndicator,
  atrIndicator,
  volumeIndicator,
  obvIndicator,
  relativeStrength,
];

/**
 * Everything the library offers: the core entries above, the wider technical
 * catalogue, then strategies and candlestick patterns. Order matters only for
 * the default list; the library screen groups and filters it.
 */
export const ALL_INDICATORS: IndicatorDef[] = [
  ...INDICATORS,
  ...MORE_INDICATORS,
  ...STRATEGY_DEFS,
  ...PATTERN_INDICATORS,
];

const BY_ID = new Map(ALL_INDICATORS.map((i) => [i.id, i]));

export function getIndicator(id: string): IndicatorDef | undefined {
  return BY_ID.get(id);
}

/** Parameter defaults for a fresh instance of an indicator. */
export function defaultParams(def: IndicatorDef): Record<string, any> {
  const out: Record<string, any> = {};
  for (const p of def.params) out[p.key] = p.default;
  return out;
}

/**
 * One-click presets for the moving-average work this app is built around.
 *
 * Each produces a ready-configured indicator instance rather than making the
 * user set length and type by hand every time.
 */
export interface IndicatorPreset {
  id: string;
  label: string;
  indicatorId: string;
  params: Record<string, any>;
  colors?: Record<string, string>;
}

export const PRESETS: IndicatorPreset[] = [
  { id: 'dma20', label: '20 DMA', indicatorId: 'ma', params: { length: 20, maType: 'SMA', source: 'close' }, colors: { ma: COLORS.yellow } },
  { id: 'dma50', label: '50 DMA', indicatorId: 'ma', params: { length: 50, maType: 'SMA', source: 'close' }, colors: { ma: COLORS.green } },
  { id: 'dma100', label: '100 DMA', indicatorId: 'ma', params: { length: 100, maType: 'SMA', source: 'close' }, colors: { ma: COLORS.purple } },
  { id: 'dma150', label: '150 DMA', indicatorId: 'ma', params: { length: 150, maType: 'SMA', source: 'close' }, colors: { ma: COLORS.blue } },
  { id: 'dma200', label: '200 DMA', indicatorId: 'ma', params: { length: 200, maType: 'SMA', source: 'close' }, colors: { ma: COLORS.orange } },
  { id: 'goldenCross', label: 'Golden Cross (150 / 200)', indicatorId: 'dma_cross', params: { fast: 150, slow: 200, maType: 'SMA', source: 'close' } },
  { id: 'ema2150', label: '21 / 50 EMA', indicatorId: 'dma_cross', params: { fast: 21, slow: 50, maType: 'EMA', source: 'close' } },
  { id: 'dist200', label: '% from 200 DMA', indicatorId: 'dist_from_ma', params: { length: 200, maType: 'SMA', source: 'close' } },
];

/**
 * Run an indicator, tolerating bad parameters rather than crashing the chart.
 * A misconfigured indicator should draw nothing and report why.
 */
export function runIndicator(
  id: string,
  candles: Candle[],
  params: Record<string, any>,
  ctx?: IndicatorContext,
): { result: IndicatorResult | null; error?: string } {
  const def = BY_ID.get(id);
  if (!def) return { result: null, error: `Unknown indicator: ${id}` };
  if (candles.length === 0) return { result: null, error: 'No data' };
  try {
    return { result: def.calc(candles, { ...defaultParams(def), ...params }, ctx) };
  } catch (e) {
    return { result: null, error: e instanceof Error ? e.message : String(e) };
  }
}
