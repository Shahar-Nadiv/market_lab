/**
 * Types shared between the Electron main process and the renderer.
 *
 * Keep this file dependency-free and platform-neutral: it is compiled to
 * CommonJS for the main process and consumed directly by Vite for the
 * renderer. Nothing here may import Node or DOM APIs.
 */

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

/** Bar intervals we support. Mirrors what Yahoo's chart endpoint accepts. */
export type Interval =
  | '1m'
  | '5m'
  | '15m'
  | '30m'
  | '1h'
  | '1d'
  | '1wk'
  | '1mo';

export const INTERVALS: Interval[] = ['1m', '5m', '15m', '30m', '1h', '1d', '1wk', '1mo'];

/** True for intervals that resolve below one day. */
export function isIntraday(interval: Interval): boolean {
  return interval === '1m' || interval === '5m' || interval === '15m' || interval === '30m' || interval === '1h';
}

/**
 * A single OHLCV bar.
 *
 * `time` is a Unix timestamp in **seconds** (UTC), which is what
 * lightweight-charts expects for intraday series and what we store in SQLite.
 * Prices are already normalized to the symbol's display currency (see
 * `shared/exchanges.ts` — TASE quotes arrive in agorot and are divided down).
 */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Split/dividend-adjusted close. Equals `close` when no adjustment applies. */
  adjClose: number;
}

/** Which price field an indicator or script reads from each bar. */
export type PriceSource = 'open' | 'high' | 'low' | 'close' | 'hl2' | 'hlc3' | 'ohlc4';

export const PRICE_SOURCES: PriceSource[] = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4'];

/** Asset classes we distinguish in the UI and in session handling. */
export type QuoteType = 'EQUITY' | 'ETF' | 'INDEX' | 'MUTUALFUND' | 'CRYPTOCURRENCY' | 'CURRENCY' | 'FUTURE' | 'OTHER';

/** Cached metadata about a tradable symbol. */
export interface SymbolMeta {
  /** Yahoo ticker, including any exchange suffix (e.g. `TEVA.TA`). */
  symbol: string;
  shortName: string;
  longName: string;
  quoteType: QuoteType;
  /** Exchange code from our registry (e.g. `TASE`, `NASDAQ`), or `UNKNOWN`. */
  exchange: string;
  /** Currency the raw feed quotes in, e.g. `ILA` for agorot. */
  rawCurrency: string;
  /** Currency we display after normalization, e.g. `ILS`. */
  displayCurrency: string;
  /** Divisor applied to raw prices to reach display currency (100 for agorot). */
  priceDivisor: number;
  sector?: string;
  industry?: string;
  updatedAt: number;
}

/** A real-time-ish snapshot quote. */
export interface Quote {
  symbol: string;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  dayHigh: number;
  dayLow: number;
  dayOpen: number;
  volume: number;
  marketCap?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  displayCurrency: string;
  /**
   * Which session is live for this symbol right now.
   *
   * Yahoo also emits `PREPRE` (overnight, before pre-market opens) and
   * `POSTPOST` (after extended hours have ended); both are collapsed to
   * `CLOSED`, because in each the venue is genuinely shut even though a
   * stale extended-hours price is still published.
   */
  marketState: 'PRE' | 'REGULAR' | 'POST' | 'CLOSED';
  /** Short exchange timezone label as the venue reports it, e.g. `EDT`, `IDT`. */
  exchangeTimezoneName?: string;

  /**
   * Extended-hours prices, where the symbol has them at all — indices, FX,
   * crypto and most non-US listings do not. These stay populated after the
   * session ends, so the last after-hours print is still shown overnight,
   * which is what every other terminal does.
   */
  hasPrePostMarket?: boolean;
  preMarketPrice?: number;
  preMarketChange?: number;
  preMarketChangePercent?: number;
  preMarketTime?: number;
  postMarketPrice?: number;
  postMarketChange?: number;
  postMarketChangePercent?: number;
  postMarketTime?: number;

  timestamp: number;
}

/** Fundamentals for the symbol info panel. */
/** Wall Street's aggregate call, as a five-way analyst count. */
export interface RecommendationTrend {
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
  /**
   * Yahoo's mean rating on a 1–5 scale where 1 is Strong Buy and 5 is Strong
   * Sell. Note the inversion: a *lower* number is more bullish.
   */
  mean?: number;
  /** Yahoo's own verdict string, e.g. "buy", "underperform". */
  key?: string;
  analystCount?: number;
}

/** One reported quarter, for the earnings table. */
export interface EarningsQuarter {
  /** Fiscal label as the company reports it, e.g. "1Q2026". */
  fiscalQuarter: string;
  /** Calendar label, which often differs from the fiscal one. */
  calendarQuarter?: string;
  epsActual?: number;
  epsEstimate?: number;
  /** Beat/miss against consensus, as a percentage. */
  surprisePercent?: number;
  /** Unix seconds. */
  periodEnd?: number;
  reportedDate?: number;
}

/**
 * A past earnings report, positioned on the chart as an `E` marker.
 *
 * `time` is the moment the result was *announced*, not the period it covers —
 * the market reacts to the announcement, so that is the bar worth flagging.
 *
 * `source` records how confident that timing is, because the two feeds behind
 * this differ in precision:
 *   - `reported` — Yahoo's own reported-date for the announcement. Exact, but
 *     only the last four quarters carry it.
 *   - `filing`   — the date the 10-Q/10-K reached the SEC. Available for years
 *     back, but a company files one to three days *after* its press release,
 *     so the marker can sit a bar or two late.
 */
export interface EarningsEvent {
  /** Unix seconds of the announcement (or of the filing, for `filing` rows). */
  time: number;
  source: 'reported' | 'filing';
  /** Fiscal label as the company reports it, e.g. "3Q2026". */
  fiscalQuarter?: string;
  epsActual?: number;
  epsEstimate?: number;
  /** Beat/miss against consensus, as a percentage. */
  surprisePercent?: number;
  /** SEC form that supplied a `filing` row, e.g. `10-Q`. */
  form?: string;
}

export interface Fundamentals {
  symbol: string;
  currency?: string;

  // Session
  previousClose?: number;
  open?: number;
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  dayLow?: number;
  dayHigh?: number;
  volume?: number;

  // Range and size
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  averageVolume?: number;
  marketCap?: number;

  // Valuation
  beta?: number;
  trailingPE?: number;
  forwardPE?: number;
  epsTrailing?: number;
  epsForward?: number;

  // Dividend
  dividendRate?: number;
  /** Already converted to a percentage, not Yahoo's raw fraction. */
  dividendYield?: number;
  exDividendDate?: number;
  dividendDate?: number;

  // Forward-looking
  earningsDate?: number;
  /** Yahoo flags an estimated (not yet confirmed) earnings date. */
  earningsDateEstimated?: boolean;
  targetMeanPrice?: number;
  targetHighPrice?: number;
  targetLowPrice?: number;

  // Analyst opinion and history
  recommendation?: RecommendationTrend;
  earningsHistory?: EarningsQuarter[];

  // Profile
  sector?: string;
  industry?: string;
  employees?: number;
  description?: string;
}

/** One hit from symbol search. */
export interface SearchResult {
  symbol: string;
  name: string;
  exchange: string;
  quoteType: QuoteType;
  /** Where this hit came from, so the UI can badge recents. */
  origin: 'history' | 'cache' | 'remote';
  /** Recency x frequency score for history hits; 0 otherwise. */
  score: number;
}

// ---------------------------------------------------------------------------
// Indicators
// ---------------------------------------------------------------------------

/** A computed series aligned 1:1 with the input candles. `null` = no value yet. */
export type Series = (number | null)[];

export type ParamType = 'int' | 'float' | 'bool' | 'source' | 'color' | 'string';

export interface ParamSpec {
  key: string;
  label: string;
  type: ParamType;
  default: number | string | boolean;
  min?: number;
  max?: number;
  /** Allowed values for `string` params rendered as a dropdown. */
  options?: string[];
}

/** How an indicator's output should be drawn. */
export interface PlotSpec {
  key: string;
  label: string;
  /** `line` and `area` overlay price; `histogram` suits MACD; `band` fills. */
  style: 'line' | 'histogram' | 'area' | 'dashed';
  color: string;
  lineWidth?: number;
}

export interface IndicatorResult {
  /** Named output series, keyed to match `PlotSpec.key`. */
  series: Record<string, Series>;
  /** Bars flagged by a strategy or pattern, drawn as chart markers. */
  markers?: IndicatorMarker[];
  /** Optional static horizontal levels (e.g. RSI 70/30). */
  levels?: { value: number; color: string; label?: string }[];
}

/**
 * Extra inputs some indicators need beyond the candles themselves.
 *
 * Kept in one optional bag so the `calc` signature stays uniform across every
 * indicator, whether or not it needs any of this.
 */
export interface IndicatorContext {
  /** IANA zone of the symbol's exchange, for session-anchored maths (VWAP). */
  timezone?: string;
  /** Benchmark bars for relative-strength comparisons. */
  benchmark?: Candle[];
  /** Compute against split/dividend-adjusted prices. */
  useAdjusted?: boolean;
  /** Bar interval, for indicators whose behaviour depends on it. */
  interval?: Interval;
}

/**
 * What a library entry is, which decides the tab it appears under and how its
 * output is drawn: indicators plot lines, strategies and patterns mark bars.
 */
export type IndicatorKind = 'indicator' | 'strategy' | 'pattern';

/** Grouping within the library list, mirroring how traders talk about them. */
export type IndicatorCategory =
  | 'Moving Averages'
  | 'Momentum'
  | 'Trend'
  | 'Bands & Channels'
  | 'Volume'
  | 'Volatility'
  | 'Support & Resistance'
  | 'Breadth & Relative'
  | 'Strategies'
  | 'Candlestick Patterns';

/** A bar the strategy or pattern wants flagged on the chart. */
export interface IndicatorMarker {
  /** Index into the candle array the result was computed from. */
  index: number;
  side: 'buy' | 'sell' | 'neutral';
  text?: string;
}

export interface IndicatorDef {
  id: string;
  label: string;
  /** Short description shown in the library picker and preview card. */
  description?: string;
  /** `overlay` draws on the price pane; `separate` gets its own pane below. */
  panel: 'overlay' | 'separate';
  kind?: IndicatorKind;
  category?: IndicatorCategory;
  /** Extra search terms — abbreviations and alternative names. */
  tags?: string[];
  params: ParamSpec[];
  plots: PlotSpec[];
  calc(candles: Candle[], params: Record<string, any>, ctx?: IndicatorContext): IndicatorResult;
}

/** An indicator instance attached to a chart, with user overrides. */
export interface AttachedIndicator {
  /** Stable per-attachment id, so the same indicator can be added twice. */
  instanceId: string;
  indicatorId: string;
  params: Record<string, any>;
  /** Per-plot color overrides keyed by `PlotSpec.key`. */
  colors?: Record<string, string>;
  visible: boolean;
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

export interface UserScript {
  id: number;
  name: string;
  source: string;
  /** Bumped on every save; `script_versions` keeps the history. */
  version: number;
  overlay: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Inputs a script declared via `input.*`, surfaced to the settings UI. */
export interface ScriptInput {
  key: string;
  label: string;
  type: ParamType;
  default: number | string | boolean;
  min?: number;
  max?: number;
  options?: string[];
}

/**
 * What a sandboxed script returns. The worker never touches the chart — the
 * main thread maps this descriptor onto lightweight-charts series.
 */
export interface ScriptRenderDescriptor {
  title: string;
  overlay: boolean;
  inputs: ScriptInput[];
  plots: { key: string; title: string; color: string; style: PlotSpec['style']; lineWidth: number; data: Series }[];
  shapes: { key: string; title: string; shape: string; location: 'aboveBar' | 'belowBar' | 'atPrice'; color: string; data: boolean[] }[];
  hlines: { value: number; color: string; title?: string }[];
  fills: { from: string; to: string; color: string }[];
  /** Conditions declared via `alertcondition()`, selectable as alert triggers. */
  alertConditions: { key: string; title: string; data: boolean[] }[];
}

export interface ScriptRunError {
  message: string;
  /** 1-based line in the user's source, when we can map it. */
  line?: number;
  kind: 'syntax' | 'runtime' | 'timeout' | 'security';
}

export type ScriptRunResult =
  | { ok: true; descriptor: ScriptRenderDescriptor; durationMs: number }
  | { ok: false; error: ScriptRunError };

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export type AlertTriggerType =
  | 'price_above'
  | 'price_below'
  | 'price_cross'
  | 'percent_change'
  | 'volume_spike'
  | 'indicator_cross'
  | 'script_condition'
  | 'new_52w_high'
  | 'new_52w_low';

export interface AlertCondition {
  type: AlertTriggerType;
  /** Threshold for price/percent/volume triggers. */
  value?: number;
  /** Lookback window in bars for percent_change / volume_spike. */
  lookback?: number;
  /** For indicator_cross: which indicator and params to compare price against. */
  indicatorId?: string;
  indicatorParams?: Record<string, any>;
  /** Which of the indicator's plots to use as the crossed line. */
  plotKey?: string;
  /** Cross direction for price_cross / indicator_cross. */
  direction?: 'above' | 'below' | 'any';
  /** For script_condition: the script and which alertcondition key. */
  scriptId?: number;
  conditionKey?: string;
}

export interface Alert {
  id: number;
  symbol: string;
  interval: Interval;
  condition: AlertCondition;
  /** Fire once then disable, or keep firing on every recurrence. */
  repeat: 'once' | 'every_time';
  /** Minimum seconds between two firings of the same alert. */
  cooldownSec: number;
  /** Unix seconds after which the alert auto-disables; null = never. */
  expiresAt: number | null;
  enabled: boolean;
  sound: boolean;
  note: string;
  createdAt: number;
  lastFiredAt: number | null;
}

export interface AlertEvent {
  id: number;
  alertId: number;
  symbol: string;
  firedAt: number;
  /** Price at the moment the condition evaluated true. */
  price: number;
  message: string;
  /** Cleared when the user acknowledges it in the alert log. */
  acknowledged: boolean;
}

// ---------------------------------------------------------------------------
// Watchlists, layouts, drawings
// ---------------------------------------------------------------------------

export interface Watchlist {
  id: number;
  name: string;
  sortOrder: number;
}

export interface WatchlistItem {
  id: number;
  watchlistId: number;
  symbol: string;
  sortOrder: number;
  note: string;
}

export interface ChartLayout {
  id: number;
  name: string;
  /** 1, 2 or 4 chart panes in the grid. */
  grid: 1 | 2 | 4;
  /** Serialized per-pane state: symbol, interval, indicators, scale. */
  panes: ChartPaneState[];
  isDefault: boolean;
  updatedAt: number;
}

export interface ChartPaneState {
  symbol: string;
  interval: Interval;
  seriesType: SeriesType;
  priceScale: 'normal' | 'logarithmic' | 'percentage';
  indicators: AttachedIndicator[];
  /** Attached user scripts with their input overrides. */
  scripts: { scriptId: number; inputs: Record<string, any>; visible: boolean }[];
  /** Symbols overlaid in compare mode, normalized to % change. */
  compareSymbols: string[];
}

export type SeriesType = 'candlestick' | 'bar' | 'line' | 'area' | 'baseline' | 'heikinashi';

/**
 * Every drawing tool the chart can place.
 *
 * Grouped here the way the toolbar groups them, because the toolbar's flyouts
 * are generated from this catalogue rather than hand-listed — adding a tool
 * means adding it here, a renderer, and nothing else.
 */
export type DrawingTool =
  // Lines
  | 'trendline' | 'ray' | 'extended' | 'info_line' | 'trend_angle'
  | 'hline' | 'hray' | 'vline' | 'crossline'
  | 'parallel_channel' | 'disjoint_channel'
  // Fibonacci
  | 'fib_retracement' | 'fib_extension' | 'fib_timezone'
  // Shapes
  | 'rectangle' | 'ellipse' | 'triangle' | 'polyline' | 'path'
  // Annotation
  | 'text' | 'callout' | 'price_label' | 'arrow_marker' | 'note'
  | 'brush' | 'highlighter'
  // Measure
  | 'measure' | 'price_range' | 'date_range'
  // Positions
  | 'long_position' | 'short_position';

/** Toolbar modes that are not themselves drawings. */
export type PointerTool = 'cursor' | 'eraser';

export type ActiveTool = DrawingTool | PointerTool;

/** Per-drawing styling and behaviour that does not fit the fixed columns. */
export interface DrawingProps {
  lineStyle?: 'solid' | 'dashed' | 'dotted';
  /** Interior fill for shapes, channels and position boxes. */
  fill?: string;
  fillOpacity?: number;
  fontSize?: number;
  /** Fibonacci ratios, so a user can add or remove levels per drawing. */
  levels?: number[];
  /** Show the price/percent/bar readout some line tools carry. */
  showLabels?: boolean;
  /** Excluded from hit-testing and dimmed, rather than deleted. */
  locked?: boolean;
  hidden?: boolean;
}

/**
 * A drawing anchored to price/time (never pixels), so it survives zoom,
 * resize and timeframe changes.
 *
 * Points are stored in chart space, so a trendline drawn on a daily chart
 * still lands on the same prices and dates when the interval changes.
 */
export interface Drawing {
  id: number;
  symbol: string;
  tool: DrawingTool;
  points: { time: number; price: number }[];
  color: string;
  lineWidth: number;
  text: string;
  props: DrawingProps;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface AppSettings {
  theme: 'dark' | 'light';
  defaultInterval: Interval;
  defaultSeriesType: SeriesType;
  /** Use split/dividend-adjusted closes for charts and indicator math. */
  useAdjustedClose: boolean;
  /** Convert agorot-quoted TASE prices to shekels for display. */
  normalizeTaseCurrency: boolean;
  /** Flag past earnings reports on the chart with an `E` marker. */
  showEarnings: boolean;
  alertPollSeconds: number;
  alertsEnabled: boolean;
  benchmarkSymbol: string;
  /**
   * Which watchlist to open on. Only meaningful once you keep more than one —
   * without it the app always lands on whichever list sorts first.
   */
  activeWatchlistId: number | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  defaultInterval: '1d',
  defaultSeriesType: 'candlestick',
  useAdjustedClose: true,
  normalizeTaseCurrency: true,
  showEarnings: true,
  alertPollSeconds: 60,
  alertsEnabled: true,
  activeWatchlistId: null,
  benchmarkSymbol: '^GSPC',
};
