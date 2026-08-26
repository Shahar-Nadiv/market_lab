/**
 * The wider technical catalogue.
 *
 * `registry.ts` holds the entries the app was built around (the moving-average
 * work, the core oscillators); this file adds the rest of what a library screen
 * is expected to carry. Every entry follows the same contract, so adding one
 * here makes it available to the chart, the script API, the alert engine and
 * the screener at once.
 */

import type { Candle, IndicatorContext, IndicatorDef, Series } from '../types';
import {
  atr, combine, ema, highest, lowest, mapSeries, movingAverage, rsi, sma, sourceSeries, stdev,
  type MaType,
} from './math';
import {
  accumulationDistribution, aroon, awesomeOscillator, balanceOfPower, bandwidth, cci,
  chaikinMoneyFlow, chaikinOscillator, chaikinVolatility, cmo, coppock, dema, dpo, easeOfMovement,
  elderRay, envelopes, forceIndex, hma, historicalVolatility, ichimoku, keltner,
  linearRegressionChannel, mfi, momentum, parabolicSar, percentB, pivotPoints, ppo,
  priceVolumeTrend, roc, stochRsi, superTrend, tema, trix, tsi, typicalPrice, ultimateOscillator,
  volumeOscillator, vortex, williamsR,
} from './extras';

const C = {
  blue: '#2962ff', orange: '#ff6d00', purple: '#9c27b0', teal: '#26a69a',
  red: '#ef5350', yellow: '#ffb300', grey: '#787b86', green: '#66bb6a',
  pink: '#ec407a', cyan: '#00bcd4',
};

const SOURCE_PARAM = {
  key: 'source', label: 'Source', type: 'source' as const, default: 'close',
  options: ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4'],
};

const MA_TYPE_PARAM = {
  key: 'maType', label: 'Type', type: 'string' as const, default: 'SMA',
  options: ['SMA', 'EMA', 'WMA', 'VWMA', 'RMA'],
};

function src(candles: Candle[], params: Record<string, any>, ctx?: IndicatorContext): number[] {
  return sourceSeries(candles, (params.source ?? 'close') as any, ctx?.useAdjusted ?? false);
}

const len = (key: string, label: string, def: number) =>
  ({ key, label, type: 'int' as const, default: def, min: 1, max: 1000 });

// ---------------------------------------------------------------------------
// Moving averages
// ---------------------------------------------------------------------------

const hullMa: IndicatorDef = {
  id: 'hma', label: 'Hull Moving Average', category: 'Moving Averages',
  description: 'A moving average tuned to turn quickly without the noise of a short EMA.',
  tags: ['hull', 'hma'],
  panel: 'overlay',
  params: [len('length', 'Length', 21), SOURCE_PARAM],
  plots: [{ key: 'hma', label: 'HMA', style: 'line', color: C.purple, lineWidth: 2 }],
  calc: (c, p, ctx) => ({ series: { hma: hma(src(c, p, ctx), p.length) } }),
};

const demaIndicator: IndicatorDef = {
  id: 'dema', label: 'Double EMA', category: 'Moving Averages',
  description: 'EMA with much of the lag removed, at the cost of overshooting turns.',
  tags: ['dema'],
  panel: 'overlay',
  params: [len('length', 'Length', 21), SOURCE_PARAM],
  plots: [{ key: 'dema', label: 'DEMA', style: 'line', color: C.teal, lineWidth: 2 }],
  calc: (c, p, ctx) => ({ series: { dema: dema(src(c, p, ctx), p.length) } }),
};

const temaIndicator: IndicatorDef = {
  id: 'tema', label: 'Triple EMA', category: 'Moving Averages',
  description: 'Even less lag than a double EMA, and correspondingly more overshoot.',
  tags: ['tema'],
  panel: 'overlay',
  params: [len('length', 'Length', 21), SOURCE_PARAM],
  plots: [{ key: 'tema', label: 'TEMA', style: 'line', color: C.cyan, lineWidth: 2 }],
  calc: (c, p, ctx) => ({ series: { tema: tema(src(c, p, ctx), p.length) } }),
};

const maRibbon: IndicatorDef = {
  id: 'ma_ribbon', label: 'Moving Average Ribbon', category: 'Moving Averages',
  description: 'Six averages at once — the spread between them shows trend strength.',
  tags: ['ribbon', 'guppy'],
  panel: 'overlay',
  params: [
    len('start', 'Shortest', 20), len('step', 'Step', 20), MA_TYPE_PARAM, SOURCE_PARAM,
  ],
  plots: [1, 2, 3, 4, 5, 6].map((n, i) => ({
    key: `ma${n}`, label: `MA ${n}`, style: 'line' as const,
    color: [C.blue, C.cyan, C.teal, C.green, C.yellow, C.orange][i], lineWidth: 1,
  })),
  calc: (c, p, ctx) => {
    const values = src(c, p, ctx);
    const volumes = c.map((x) => x.volume);
    const series: Record<string, Series> = {};
    for (let n = 1; n <= 6; n++) {
      series[`ma${n}`] = movingAverage(p.maType as MaType, values, p.start + p.step * (n - 1), volumes);
    }
    return { series };
  },
};

// ---------------------------------------------------------------------------
// Momentum
// ---------------------------------------------------------------------------

const cciIndicator: IndicatorDef = {
  id: 'cci', label: 'Commodity Channel Index', category: 'Momentum',
  description: 'How far price has strayed from its average, in units of mean deviation.',
  tags: ['cci'],
  panel: 'separate',
  params: [len('length', 'Length', 20)],
  plots: [{ key: 'cci', label: 'CCI', style: 'line', color: C.blue, lineWidth: 2 }],
  calc: (c, p) => ({
    series: { cci: cci(c, p.length) },
    levels: [
      { value: 100, color: C.red, label: '100' },
      { value: -100, color: C.teal, label: '-100' },
      { value: 0, color: C.grey },
    ],
  }),
};

const williams: IndicatorDef = {
  id: 'williams_r', label: 'Williams %R', category: 'Momentum',
  description: 'Where the close sits in the recent range. Above -20 is stretched, below -80 is washed out.',
  tags: ['williams', 'percent r'],
  panel: 'separate',
  params: [len('length', 'Length', 14)],
  plots: [{ key: 'r', label: '%R', style: 'line', color: C.purple, lineWidth: 2 }],
  calc: (c, p) => ({
    series: { r: williamsR(c, p.length) },
    levels: [
      { value: -20, color: C.red, label: '-20' },
      { value: -80, color: C.teal, label: '-80' },
    ],
  }),
};

const rocIndicator: IndicatorDef = {
  id: 'roc', label: 'Rate of Change', category: 'Momentum',
  description: 'Percentage change over N bars — the simplest momentum measure there is.',
  tags: ['roc', 'rate of change'],
  panel: 'separate',
  params: [len('length', 'Length', 9), SOURCE_PARAM],
  plots: [{ key: 'roc', label: 'ROC', style: 'line', color: C.orange, lineWidth: 2 }],
  calc: (c, p, ctx) => ({
    series: { roc: roc(src(c, p, ctx), p.length) },
    levels: [{ value: 0, color: C.grey }],
  }),
};

const momentumIndicator: IndicatorDef = {
  id: 'momentum', label: 'Momentum', category: 'Momentum',
  description: 'Price now minus price N bars ago, in points rather than percent.',
  tags: ['mom'],
  panel: 'separate',
  params: [len('length', 'Length', 10), SOURCE_PARAM],
  plots: [{ key: 'mom', label: 'Momentum', style: 'line', color: C.blue, lineWidth: 2 }],
  calc: (c, p, ctx) => ({
    series: { mom: momentum(src(c, p, ctx), p.length) },
    levels: [{ value: 0, color: C.grey }],
  }),
};

const mfiIndicator: IndicatorDef = {
  id: 'mfi', label: 'Money Flow Index', category: 'Momentum',
  description: 'RSI weighted by volume — momentum that only counts when money moves with it.',
  tags: ['mfi', 'money flow'],
  panel: 'separate',
  params: [len('length', 'Length', 14)],
  plots: [{ key: 'mfi', label: 'MFI', style: 'line', color: C.teal, lineWidth: 2 }],
  calc: (c, p) => ({
    series: { mfi: mfi(c, p.length) },
    levels: [
      { value: 80, color: C.red, label: '80' },
      { value: 20, color: C.teal, label: '20' },
    ],
  }),
};

const stochRsiIndicator: IndicatorDef = {
  id: 'stoch_rsi', label: 'Stochastic RSI', category: 'Momentum',
  description: 'The stochastic applied to RSI itself. Far more sensitive than either alone.',
  tags: ['stochrsi', 'srsi'],
  panel: 'separate',
  params: [len('rsiLength', 'RSI Length', 14), len('stochLength', 'Stochastic Length', 14),
    len('k', '%K Smoothing', 3), len('d', '%D Smoothing', 3), SOURCE_PARAM],
  plots: [
    { key: 'k', label: '%K', style: 'line', color: C.blue, lineWidth: 2 },
    { key: 'd', label: '%D', style: 'line', color: C.orange, lineWidth: 1 },
  ],
  calc: (c, p, ctx) => {
    const r = rsi(src(c, p, ctx), p.rsiLength);
    const { k, d } = stochRsi(r, p.stochLength, p.k, p.d);
    return {
      series: { k, d },
      levels: [
        { value: 80, color: C.red, label: '80' },
        { value: 20, color: C.teal, label: '20' },
      ],
    };
  },
};

const awesome: IndicatorDef = {
  id: 'awesome', label: 'Awesome Oscillator', category: 'Momentum',
  description: 'The 5/34 spread of median price, drawn as a histogram of momentum shifts.',
  tags: ['ao', 'awesome'],
  panel: 'separate',
  params: [len('fast', 'Fast', 5), len('slow', 'Slow', 34)],
  plots: [{ key: 'ao', label: 'AO', style: 'histogram', color: C.teal }],
  calc: (c, p) => ({
    series: { ao: awesomeOscillator(c, p.fast, p.slow) },
    levels: [{ value: 0, color: C.grey }],
  }),
};

const tsiIndicator: IndicatorDef = {
  id: 'tsi', label: 'True Strength Index', category: 'Momentum',
  description: 'Double-smoothed momentum — much of the noise removed, direction kept.',
  tags: ['tsi'],
  panel: 'separate',
  params: [len('long', 'Long', 25), len('short', 'Short', 13), SOURCE_PARAM],
  plots: [{ key: 'tsi', label: 'TSI', style: 'line', color: C.purple, lineWidth: 2 }],
  calc: (c, p, ctx) => ({
    series: { tsi: tsi(src(c, p, ctx), p.long, p.short) },
    levels: [{ value: 0, color: C.grey }],
  }),
};

const ppoIndicator: IndicatorDef = {
  id: 'ppo', label: 'Percentage Price Oscillator', category: 'Momentum',
  description: 'MACD expressed in percent, so it compares across instruments of different price.',
  tags: ['ppo'],
  panel: 'separate',
  params: [len('fast', 'Fast', 12), len('slow', 'Slow', 26), len('signal', 'Signal', 9), SOURCE_PARAM],
  plots: [
    { key: 'ppo', label: 'PPO', style: 'line', color: C.blue, lineWidth: 2 },
    { key: 'signal', label: 'Signal', style: 'line', color: C.orange, lineWidth: 1 },
    { key: 'histogram', label: 'Histogram', style: 'histogram', color: C.grey },
  ],
  calc: (c, p, ctx) => {
    const r = ppo(src(c, p, ctx), p.fast, p.slow, p.signal);
    return { series: { ppo: r.ppo, signal: r.signal, histogram: r.histogram }, levels: [{ value: 0, color: C.grey }] };
  },
};

const cmoIndicator: IndicatorDef = {
  id: 'cmo', label: 'Chande Momentum Oscillator', category: 'Momentum',
  description: 'Up moves against down moves over a window, scaled -100 to 100.',
  tags: ['cmo', 'chande'],
  panel: 'separate',
  params: [len('length', 'Length', 9), SOURCE_PARAM],
  plots: [{ key: 'cmo', label: 'CMO', style: 'line', color: C.pink, lineWidth: 2 }],
  calc: (c, p, ctx) => ({
    series: { cmo: cmo(src(c, p, ctx), p.length) },
    levels: [
      { value: 50, color: C.red }, { value: -50, color: C.teal }, { value: 0, color: C.grey },
    ],
  }),
};

const ultimate: IndicatorDef = {
  id: 'ultimate', label: 'Ultimate Oscillator', category: 'Momentum',
  description: 'Three lookbacks blended 4:2:1, which resists the false divergences single-period oscillators give.',
  tags: ['uo', 'ultimate'],
  panel: 'separate',
  params: [len('p1', 'Fast', 7), len('p2', 'Middle', 14), len('p3', 'Slow', 28)],
  plots: [{ key: 'uo', label: 'UO', style: 'line', color: C.blue, lineWidth: 2 }],
  calc: (c, p) => ({
    series: { uo: ultimateOscillator(c, p.p1, p.p2, p.p3) },
    levels: [{ value: 70, color: C.red, label: '70' }, { value: 30, color: C.teal, label: '30' }],
  }),
};

const dpoIndicator: IndicatorDef = {
  id: 'dpo', label: 'Detrended Price Oscillator', category: 'Momentum',
  description: 'Trend removed so the remaining cycle is visible.',
  tags: ['dpo'],
  panel: 'separate',
  params: [len('length', 'Length', 20), SOURCE_PARAM],
  plots: [{ key: 'dpo', label: 'DPO', style: 'line', color: C.orange, lineWidth: 2 }],
  calc: (c, p, ctx) => ({ series: { dpo: dpo(src(c, p, ctx), p.length) }, levels: [{ value: 0, color: C.grey }] }),
};

const coppockCurve: IndicatorDef = {
  id: 'coppock', label: 'Coppock Curve', category: 'Momentum',
  description: 'A long-term bottom finder: turns up from below zero have marked major lows.',
  tags: ['coppock'],
  panel: 'separate',
  params: [len('roc1', 'Long ROC', 14), len('roc2', 'Short ROC', 11), len('wma', 'WMA', 10), SOURCE_PARAM],
  plots: [{ key: 'coppock', label: 'Coppock', style: 'line', color: C.purple, lineWidth: 2 }],
  calc: (c, p, ctx) => ({
    series: { coppock: coppock(src(c, p, ctx), p.roc1, p.roc2, p.wma) },
    levels: [{ value: 0, color: C.grey }],
  }),
};

const bop: IndicatorDef = {
  id: 'bop', label: 'Balance of Power', category: 'Momentum',
  description: 'Where the close finished within each bar — who won the session, buyers or sellers.',
  tags: ['bop'],
  panel: 'separate',
  params: [len('length', 'Smoothing', 14)],
  plots: [{ key: 'bop', label: 'BOP', style: 'histogram', color: C.teal }],
  calc: (c, p) => ({ series: { bop: balanceOfPower(c, p.length) }, levels: [{ value: 0, color: C.grey }] }),
};

// ---------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------

const superTrendIndicator: IndicatorDef = {
  id: 'supertrend', label: 'SuperTrend', category: 'Trend',
  description: 'ATR bands that flip side when price closes through them. A trailing stop you can see.',
  tags: ['supertrend', 'st'],
  panel: 'overlay',
  params: [len('length', 'ATR Length', 10), { key: 'mult', label: 'Multiplier', type: 'float', default: 3, min: 0.5, max: 20 }],
  plots: [{ key: 'trend', label: 'SuperTrend', style: 'line', color: C.teal, lineWidth: 2 }],
  calc: (c, p) => ({ series: { trend: superTrend(c, p.length, p.mult).trend } }),
};

const psar: IndicatorDef = {
  id: 'psar', label: 'Parabolic SAR', category: 'Trend',
  description: 'Dots that tighten behind a trend and flip when it breaks.',
  tags: ['sar', 'parabolic'],
  panel: 'overlay',
  params: [
    { key: 'step', label: 'Step', type: 'float', default: 0.02, min: 0.001, max: 1 },
    { key: 'max', label: 'Max Step', type: 'float', default: 0.2, min: 0.01, max: 1 },
  ],
  plots: [{ key: 'sar', label: 'SAR', style: 'line', color: C.yellow, lineWidth: 1 }],
  calc: (c, p) => ({ series: { sar: parabolicSar(c, p.step, p.max).sar } }),
};

const ichimokuIndicator: IndicatorDef = {
  id: 'ichimoku', label: 'Ichimoku Cloud', category: 'Trend',
  description: 'Conversion and base lines with the cloud between the two leading spans.',
  tags: ['ichimoku', 'kumo', 'cloud'],
  panel: 'overlay',
  params: [len('conversion', 'Conversion', 9), len('base', 'Base', 26), len('spanB', 'Leading Span B', 52)],
  plots: [
    { key: 'conversion', label: 'Conversion', style: 'line', color: C.blue, lineWidth: 1 },
    { key: 'base', label: 'Base', style: 'line', color: C.red, lineWidth: 1 },
    { key: 'spanA', label: 'Span A', style: 'line', color: C.teal, lineWidth: 1 },
    { key: 'spanB', label: 'Span B', style: 'line', color: C.orange, lineWidth: 1 },
  ],
  calc: (c, p) => {
    const r = ichimoku(c, p.conversion, p.base, p.spanB);
    return { series: { conversion: r.conversion, base: r.base, spanA: r.spanA, spanB: r.spanB } };
  },
};

const aroonIndicator: IndicatorDef = {
  id: 'aroon', label: 'Aroon', category: 'Trend',
  description: 'How recently the window set its high and its low — a trend-age measure.',
  tags: ['aroon'],
  panel: 'separate',
  params: [len('length', 'Length', 14)],
  plots: [
    { key: 'up', label: 'Aroon Up', style: 'line', color: C.teal, lineWidth: 2 },
    { key: 'down', label: 'Aroon Down', style: 'line', color: C.red, lineWidth: 2 },
  ],
  calc: (c, p) => {
    const r = aroon(c, p.length);
    return { series: { up: r.up, down: r.down }, levels: [{ value: 70, color: C.grey }, { value: 30, color: C.grey }] };
  },
};

const trixIndicator: IndicatorDef = {
  id: 'trix', label: 'TRIX', category: 'Trend',
  description: 'Rate of change of a triple-smoothed EMA — slow, but almost noise free.',
  tags: ['trix'],
  panel: 'separate',
  params: [len('length', 'Length', 15), len('signal', 'Signal', 9), SOURCE_PARAM],
  plots: [
    { key: 'trix', label: 'TRIX', style: 'line', color: C.blue, lineWidth: 2 },
    { key: 'signal', label: 'Signal', style: 'line', color: C.orange, lineWidth: 1 },
  ],
  calc: (c, p, ctx) => {
    const r = trix(src(c, p, ctx), p.length, p.signal);
    return { series: { trix: r.trix, signal: r.signal }, levels: [{ value: 0, color: C.grey }] };
  },
};

const vortexIndicator: IndicatorDef = {
  id: 'vortex', label: 'Vortex Indicator', category: 'Trend',
  description: 'Competing up and down trend strength; the crossover marks the turn.',
  tags: ['vortex', 'vi'],
  panel: 'separate',
  params: [len('length', 'Length', 14)],
  plots: [
    { key: 'plus', label: 'VI+', style: 'line', color: C.teal, lineWidth: 2 },
    { key: 'minus', label: 'VI-', style: 'line', color: C.red, lineWidth: 2 },
  ],
  calc: (c, p) => {
    const r = vortex(c, p.length);
    return { series: { plus: r.plus, minus: r.minus }, levels: [{ value: 1, color: C.grey }] };
  },
};

const elderRayIndicator: IndicatorDef = {
  id: 'elder_ray', label: 'Elder Ray Index', category: 'Trend',
  description: 'Bull and bear power measured either side of an EMA.',
  tags: ['elder', 'bull power', 'bear power'],
  panel: 'separate',
  params: [len('length', 'Length', 13)],
  plots: [
    { key: 'bull', label: 'Bull Power', style: 'histogram', color: C.teal },
    { key: 'bear', label: 'Bear Power', style: 'histogram', color: C.red },
  ],
  calc: (c, p) => {
    const r = elderRay(c, p.length);
    return { series: { bull: r.bull, bear: r.bear }, levels: [{ value: 0, color: C.grey }] };
  },
};

// ---------------------------------------------------------------------------
// Bands and channels
// ---------------------------------------------------------------------------

const keltnerIndicator: IndicatorDef = {
  id: 'keltner', label: 'Keltner Channels', category: 'Bands & Channels',
  description: 'An EMA with ATR-scaled rails. Steadier than Bollinger Bands because it uses range, not deviation.',
  tags: ['keltner'],
  panel: 'overlay',
  params: [len('length', 'Length', 20), { key: 'mult', label: 'Multiplier', type: 'float', default: 2, min: 0.1, max: 10 }, len('atrLength', 'ATR Length', 10)],
  plots: [
    { key: 'upper', label: 'Upper', style: 'line', color: C.blue, lineWidth: 1 },
    { key: 'basis', label: 'Basis', style: 'dashed', color: C.grey, lineWidth: 1 },
    { key: 'lower', label: 'Lower', style: 'line', color: C.blue, lineWidth: 1 },
  ],
  calc: (c, p) => {
    const r = keltner(c, p.length, p.mult, p.atrLength);
    return { series: { upper: r.upper, basis: r.basis, lower: r.lower } };
  },
};

const envelopesIndicator: IndicatorDef = {
  id: 'envelopes', label: 'Moving Average Envelopes', category: 'Bands & Channels',
  description: 'Fixed-percentage rails around an average — the simplest mean-reversion frame.',
  tags: ['envelope'],
  panel: 'overlay',
  params: [len('length', 'Length', 20), { key: 'percent', label: 'Percent', type: 'float', default: 2.5, min: 0.1, max: 50 }, SOURCE_PARAM],
  plots: [
    { key: 'upper', label: 'Upper', style: 'line', color: C.purple, lineWidth: 1 },
    { key: 'basis', label: 'Basis', style: 'dashed', color: C.grey, lineWidth: 1 },
    { key: 'lower', label: 'Lower', style: 'line', color: C.purple, lineWidth: 1 },
  ],
  calc: (c, p, ctx) => {
    const r = envelopes(src(c, p, ctx), p.length, p.percent);
    return { series: { upper: r.upper, basis: r.basis, lower: r.lower } };
  },
};

const linRegChannel: IndicatorDef = {
  id: 'linreg_channel', label: 'Linear Regression Channel', category: 'Bands & Channels',
  description: 'The best-fit line through the window, with deviation rails either side.',
  tags: ['regression', 'linreg'],
  panel: 'overlay',
  params: [len('length', 'Length', 100), { key: 'mult', label: 'Deviations', type: 'float', default: 2, min: 0.5, max: 5 }, SOURCE_PARAM],
  plots: [
    { key: 'upper', label: 'Upper', style: 'line', color: C.cyan, lineWidth: 1 },
    { key: 'basis', label: 'Basis', style: 'line', color: C.cyan, lineWidth: 2 },
    { key: 'lower', label: 'Lower', style: 'line', color: C.cyan, lineWidth: 1 },
  ],
  calc: (c, p, ctx) => {
    const r = linearRegressionChannel(src(c, p, ctx), p.length, p.mult);
    return { series: { upper: r.upper, basis: r.basis, lower: r.lower } };
  },
};

const percentBIndicator: IndicatorDef = {
  id: 'percent_b', label: 'Bollinger %B', category: 'Bands & Channels',
  description: 'Where price sits inside the Bollinger Bands: 1 is the upper rail, 0 the lower.',
  tags: ['%b', 'percent b', 'bollinger'],
  panel: 'separate',
  params: [len('length', 'Length', 20), { key: 'mult', label: 'Deviations', type: 'float', default: 2, min: 0.1, max: 10 }, SOURCE_PARAM],
  plots: [{ key: 'b', label: '%B', style: 'line', color: C.blue, lineWidth: 2 }],
  calc: (c, p, ctx) => {
    const values = src(c, p, ctx);
    const basis = sma(values, p.length);
    const sd = stdev(values, p.length);
    const upper = combine(basis, sd, (b, s) => b + s * p.mult);
    const lower = combine(basis, sd, (b, s) => b - s * p.mult);
    return {
      series: { b: percentB(values, upper, lower) },
      levels: [{ value: 1, color: C.red }, { value: 0, color: C.teal }, { value: 0.5, color: C.grey }],
    };
  },
};

const bandwidthIndicator: IndicatorDef = {
  id: 'bandwidth', label: 'Bollinger Bandwidth', category: 'Volatility',
  description: 'How wide the bands are. Multi-month lows mark the squeezes that precede big moves.',
  tags: ['bandwidth', 'squeeze'],
  panel: 'separate',
  params: [len('length', 'Length', 20), { key: 'mult', label: 'Deviations', type: 'float', default: 2, min: 0.1, max: 10 }, SOURCE_PARAM],
  plots: [{ key: 'bw', label: 'Bandwidth', style: 'line', color: C.orange, lineWidth: 2 }],
  calc: (c, p, ctx) => {
    const values = src(c, p, ctx);
    const basis = sma(values, p.length);
    const sd = stdev(values, p.length);
    return {
      series: {
        bw: bandwidth(basis, combine(basis, sd, (b, s) => b + s * p.mult), combine(basis, sd, (b, s) => b - s * p.mult)),
      },
    };
  },
};

const pivots: IndicatorDef = {
  id: 'pivots', label: 'Pivot Points', category: 'Support & Resistance',
  description: 'Floor-trader pivot with two supports and two resistances, from the previous bar.',
  tags: ['pivot', 'support', 'resistance'],
  panel: 'overlay',
  params: [],
  plots: [
    { key: 'r2', label: 'R2', style: 'dashed', color: C.red, lineWidth: 1 },
    { key: 'r1', label: 'R1', style: 'dashed', color: C.red, lineWidth: 1 },
    { key: 'pivot', label: 'Pivot', style: 'line', color: C.yellow, lineWidth: 1 },
    { key: 's1', label: 'S1', style: 'dashed', color: C.teal, lineWidth: 1 },
    { key: 's2', label: 'S2', style: 'dashed', color: C.teal, lineWidth: 1 },
  ],
  calc: (c) => {
    const r = pivotPoints(c);
    return { series: { r2: r.r2, r1: r.r1, pivot: r.pivot, s1: r.s1, s2: r.s2 } };
  },
};

// ---------------------------------------------------------------------------
// Volume
// ---------------------------------------------------------------------------

const adLine: IndicatorDef = {
  id: 'ad_line', label: 'Accumulation/Distribution', category: 'Volume',
  description: 'Running total of volume weighted by where each bar closed in its range.',
  tags: ['a/d', 'accumulation', 'distribution'],
  panel: 'separate',
  params: [],
  plots: [{ key: 'ad', label: 'A/D', style: 'line', color: C.teal, lineWidth: 2 }],
  calc: (c) => ({ series: { ad: accumulationDistribution(c) } }),
};

const cmfIndicator: IndicatorDef = {
  id: 'cmf', label: 'Chaikin Money Flow', category: 'Volume',
  description: 'Accumulation over a window, normalised by volume. Above zero is net buying.',
  tags: ['cmf', 'chaikin'],
  panel: 'separate',
  params: [len('length', 'Length', 20)],
  plots: [{ key: 'cmf', label: 'CMF', style: 'histogram', color: C.teal }],
  calc: (c, p) => ({ series: { cmf: chaikinMoneyFlow(c, p.length) }, levels: [{ value: 0, color: C.grey }] }),
};

const chaikinOsc: IndicatorDef = {
  id: 'chaikin_osc', label: 'Chaikin Oscillator', category: 'Volume',
  description: 'MACD of the accumulation line — momentum of money flow rather than of price.',
  tags: ['chaikin oscillator'],
  panel: 'separate',
  params: [len('fast', 'Fast', 3), len('slow', 'Slow', 10)],
  plots: [{ key: 'osc', label: 'Chaikin Osc', style: 'line', color: C.purple, lineWidth: 2 }],
  calc: (c, p) => ({ series: { osc: chaikinOscillator(c, p.fast, p.slow) }, levels: [{ value: 0, color: C.grey }] }),
};

const forceIndexIndicator: IndicatorDef = {
  id: 'force_index', label: 'Force Index', category: 'Volume',
  description: 'Price change scaled by volume — how much conviction was behind the move.',
  tags: ['force'],
  panel: 'separate',
  params: [len('length', 'Length', 13)],
  plots: [{ key: 'force', label: 'Force', style: 'line', color: C.blue, lineWidth: 2 }],
  calc: (c, p) => ({ series: { force: forceIndex(c, p.length) }, levels: [{ value: 0, color: C.grey }] }),
};

const eomIndicator: IndicatorDef = {
  id: 'eom', label: 'Ease of Movement', category: 'Volume',
  description: 'How far price travelled per unit of volume. High values mean little resistance.',
  tags: ['eom', 'ease'],
  panel: 'separate',
  params: [len('length', 'Length', 14)],
  plots: [{ key: 'eom', label: 'EOM', style: 'line', color: C.cyan, lineWidth: 2 }],
  calc: (c, p) => ({ series: { eom: easeOfMovement(c, p.length) }, levels: [{ value: 0, color: C.grey }] }),
};

const pvtIndicator: IndicatorDef = {
  id: 'pvt', label: 'Price Volume Trend', category: 'Volume',
  description: 'Like OBV, but each bar contributes in proportion to its percentage move.',
  tags: ['pvt'],
  panel: 'separate',
  params: [],
  plots: [{ key: 'pvt', label: 'PVT', style: 'line', color: C.green, lineWidth: 2 }],
  calc: (c) => ({ series: { pvt: priceVolumeTrend(c) } }),
};

const volumeOsc: IndicatorDef = {
  id: 'volume_osc', label: 'Volume Oscillator', category: 'Volume',
  description: 'Spread between fast and slow volume averages — is participation rising or fading?',
  tags: ['volume oscillator'],
  panel: 'separate',
  params: [len('fast', 'Fast', 5), len('slow', 'Slow', 10)],
  plots: [{ key: 'osc', label: 'Volume Osc', style: 'histogram', color: C.blue }],
  calc: (c, p) => ({ series: { osc: volumeOscillator(c, p.fast, p.slow) }, levels: [{ value: 0, color: C.grey }] }),
};

// ---------------------------------------------------------------------------
// Volatility
// ---------------------------------------------------------------------------

const histVol: IndicatorDef = {
  id: 'hist_vol', label: 'Historical Volatility', category: 'Volatility',
  description: 'Annualised standard deviation of log returns, as a percentage.',
  tags: ['hv', 'volatility'],
  panel: 'separate',
  params: [len('length', 'Length', 20), len('barsPerYear', 'Bars per Year', 252), SOURCE_PARAM],
  plots: [{ key: 'hv', label: 'HV %', style: 'line', color: C.orange, lineWidth: 2 }],
  calc: (c, p, ctx) => ({ series: { hv: historicalVolatility(src(c, p, ctx), p.length, p.barsPerYear) } }),
};

const chaikinVol: IndicatorDef = {
  id: 'chaikin_vol', label: 'Chaikin Volatility', category: 'Volatility',
  description: 'Rate of change of the high-low spread. Spikes mark expansion.',
  tags: ['chaikin volatility'],
  panel: 'separate',
  params: [len('length', 'EMA Length', 10), len('rocLength', 'ROC Length', 10)],
  plots: [{ key: 'cv', label: 'Chaikin Vol', style: 'line', color: C.pink, lineWidth: 2 }],
  calc: (c, p) => ({ series: { cv: chaikinVolatility(c, p.length, p.rocLength) }, levels: [{ value: 0, color: C.grey }] }),
};

const stdevIndicator: IndicatorDef = {
  id: 'stdev', label: 'Standard Deviation', category: 'Volatility',
  description: 'Raw dispersion of price around its mean, in price units.',
  tags: ['stdev', 'sd'],
  panel: 'separate',
  params: [len('length', 'Length', 20), SOURCE_PARAM],
  plots: [{ key: 'sd', label: 'StdDev', style: 'line', color: C.grey, lineWidth: 2 }],
  calc: (c, p, ctx) => ({ series: { sd: stdev(src(c, p, ctx), p.length) } }),
};

const atrPercent: IndicatorDef = {
  id: 'atr_percent', label: 'ATR Percent', category: 'Volatility',
  description: 'ATR as a percentage of price, so it compares across instruments.',
  tags: ['atr%', 'atr percent'],
  panel: 'separate',
  params: [len('length', 'Length', 14)],
  plots: [{ key: 'atrp', label: 'ATR %', style: 'line', color: C.yellow, lineWidth: 2 }],
  calc: (c, p) => {
    const a = atr(c, p.length);
    const out: Series = a.map((v, i) => (v == null || c[i].close === 0 ? null : (v / c[i].close) * 100));
    return { series: { atrp: out } };
  },
};

export const MORE_INDICATORS: IndicatorDef[] = [
  hullMa, demaIndicator, temaIndicator, maRibbon,
  cciIndicator, williams, rocIndicator, momentumIndicator, mfiIndicator, stochRsiIndicator,
  awesome, tsiIndicator, ppoIndicator, cmoIndicator, ultimate, dpoIndicator, coppockCurve, bop,
  superTrendIndicator, psar, ichimokuIndicator, aroonIndicator, trixIndicator, vortexIndicator, elderRayIndicator,
  keltnerIndicator, envelopesIndicator, linRegChannel, percentBIndicator, pivots,
  adLine, cmfIndicator, chaikinOsc, forceIndexIndicator, eomIndicator, pvtIndicator, volumeOsc,
  histVol, chaikinVol, stdevIndicator, atrPercent, bandwidthIndicator,
];
