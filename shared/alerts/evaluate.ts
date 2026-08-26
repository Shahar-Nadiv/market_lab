/**
 * Alert condition evaluation — pure, synchronous, and shared.
 *
 * This lives in `shared/` for the same reason the indicators do: the line the
 * chart draws and the line an alert fires against must come from one
 * implementation. `indicator_cross` here calls the very same `runIndicator()`
 * the chart renders from, so "close crossed the 200 DMA" cannot mean two
 * different things in two places.
 *
 * Everything is a pure function of (alert, context, previous state). The engine
 * in `electron/services/alerts.ts` owns the timers, the network and the
 * database; this module owns only the question "should this fire right now?",
 * which is what makes it testable without Electron.
 *
 * ## Edge semantics
 *
 * Every trigger fires on a *transition*, never on a standing condition. An
 * alert for "price above 200" created while price is already at 210 stays
 * silent until price dips below and comes back — otherwise it would fire on the
 * first poll after creation and every poll thereafter, which is noise rather
 * than a signal. `seedState()` establishes that prior state from history at
 * load time so a restart does not resurrect an already-true condition.
 */

import type { Alert, AlertCondition, Candle, IndicatorContext, Series } from '../types';
import { runIndicator } from '../indicators/registry';

/**
 * What an alert remembers between evaluations.
 *
 * Cross detection needs both sides of the comparison as they were last time:
 * the price, and whatever it is being compared against (a fixed level, or an
 * indicator value that moves bar to bar).
 */
export interface AlertState {
  prevPrice: number | null;
  /** The reference line at the previous evaluation: a level, MA value, etc. */
  prevRef: number | null;
  /** Previous truth of a boolean trigger, for script and threshold conditions. */
  prevTrue: boolean | null;
}

export const EMPTY_STATE: AlertState = { prevPrice: null, prevRef: null, prevTrue: null };

export interface AlertEvalContext {
  /** Bars for the alert's symbol and interval, oldest first. */
  candles: Candle[];
  /** Live price. Falls back to the last close when no quote is available. */
  price: number;
  /** Evaluation time, injectable so tests are not clock-dependent. */
  now: number;
  /**
   * Per-bar truth of the script's `alertcondition()`, for `script_condition`.
   * The sandbox is async and main-process-only, so the caller runs the script
   * and passes the result in rather than this module reaching for it.
   */
  scriptCondition?: boolean[];
  /** Passed through to `runIndicator` so MAs match the chart's adjusted-close setting. */
  indicatorCtx?: IndicatorContext;
}

export interface AlertEvalResult {
  fired: boolean;
  /** Price the decision was made at, recorded on the fired event. */
  price: number;
  message: string;
  /** Carry forward into the next evaluation. Always returned, fired or not. */
  state: AlertState;
  /** Set when the condition could not be evaluated — bad params, no data. */
  error?: string;
}

const DAY = 86400;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Last non-null value of a series, with its index. */
function lastValue(series: Series): { value: number; index: number } | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i];
    if (v != null && Number.isFinite(v)) return { value: v, index: i };
  }
  return null;
}

/**
 * Did `price` cross `ref` in the requested direction since the last look?
 *
 * Touching the level counts as crossing it (`>=`), matching how a stop or a
 * moving-average cross is normally read: at the level is at the signal.
 */
function crossed(
  prevPrice: number | null,
  prevRef: number | null,
  price: number,
  ref: number,
  direction: 'above' | 'below' | 'any',
): boolean {
  if (prevPrice == null || prevRef == null) return false;
  const wasAbove = prevPrice > prevRef;
  const isAbove = price >= ref;
  if (wasAbove === isAbove) return false;
  if (direction === 'above') return isAbove;
  if (direction === 'below') return !isAbove;
  return true;
}

/** Fire only on a false→true edge, so a standing condition stays quiet. */
function rising(prevTrue: boolean | null, isTrue: boolean): boolean {
  return isTrue && prevTrue === false;
}

/**
 * Resolve the moving reference line an `indicator_cross` compares against.
 *
 * Returns the indicator's value at its most recent complete bar. A 200 DMA on
 * 150 bars of history has no value yet, which is an absence rather than an
 * error — the alert simply cannot fire.
 */
function indicatorReference(
  condition: AlertCondition,
  candles: Candle[],
  ctx?: IndicatorContext,
): { value: number | null; error?: string } {
  if (!condition.indicatorId) return { value: null, error: 'No indicator selected' };
  const { result, error } = runIndicator(condition.indicatorId, candles, condition.indicatorParams ?? {}, ctx);
  if (!result) return { value: null, error: error ?? 'Indicator produced no result' };

  const keys = Object.keys(result.series);
  const key = condition.plotKey && condition.plotKey in result.series ? condition.plotKey : keys[0];
  if (!key) return { value: null, error: 'Indicator produced no series' };

  const last = lastValue(result.series[key]);
  return { value: last ? last.value : null };
}

/** Human-readable trigger text, stored on the event and shown in the OS notification. */
function describe(alert: Alert, price: number, ref: number | null): string {
  const c = alert.condition;
  const p = formatPrice(price);
  switch (c.type) {
    case 'price_above': return `${alert.symbol} rose above ${formatPrice(c.value ?? 0)} (now ${p})`;
    case 'price_below': return `${alert.symbol} fell below ${formatPrice(c.value ?? 0)} (now ${p})`;
    case 'price_cross': return `${alert.symbol} crossed ${formatPrice(c.value ?? 0)} (now ${p})`;
    case 'percent_change': return `${alert.symbol} moved ${formatPrice(c.value ?? 0)}% over ${c.lookback ?? 1} bars (now ${p})`;
    case 'volume_spike': return `${alert.symbol} volume spiked ${c.value ?? 2}x its ${c.lookback ?? 20}-bar average`;
    case 'indicator_cross': {
      const label = describeIndicator(c);
      const dir = c.direction === 'below' ? 'crossed below' : c.direction === 'above' ? 'crossed above' : 'crossed';
      return `${alert.symbol} ${dir} ${label}${ref != null ? ` at ${formatPrice(ref)}` : ''} (now ${p})`;
    }
    case 'script_condition': return `${alert.symbol}: ${c.conditionKey || 'script condition'} triggered (now ${p})`;
    case 'new_52w_high': return `${alert.symbol} made a new 52-week high at ${p}`;
    case 'new_52w_low': return `${alert.symbol} made a new 52-week low at ${p}`;
    default: return `${alert.symbol} alert triggered at ${p}`;
  }
}

function describeIndicator(c: AlertCondition): string {
  const len = c.indicatorParams?.length;
  const type = c.indicatorParams?.maType ?? 'SMA';
  if (c.indicatorId === 'ma' && len) return `the ${len} ${type === 'SMA' ? 'DMA' : type}`;
  return c.indicatorId ?? 'the indicator';
}

function formatPrice(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return Math.abs(n) >= 1000 ? n.toFixed(0) : n.toFixed(2);
}

// ---------------------------------------------------------------------------
// Gating — the checks that apply regardless of trigger type
// ---------------------------------------------------------------------------

/**
 * Should this alert be evaluated at all right now?
 *
 * Kept separate from the condition maths so the engine can skip disabled,
 * expired or cooling-down alerts before paying for a quote or an indicator run.
 * Market hours are *not* checked here — that is the engine's job, since it
 * needs the symbol's exchange and observed trading days.
 */
export function isEligible(alert: Alert, now: number): boolean {
  if (!alert.enabled) return false;
  if (alert.expiresAt != null && now >= alert.expiresAt) return false;
  if (alert.repeat === 'once' && alert.lastFiredAt != null) return false;
  if (alert.lastFiredAt != null && now - alert.lastFiredAt < alert.cooldownSec) return false;
  return true;
}

/**
 * Establish prior state from history, without firing.
 *
 * Called when an alert is created or reloaded after a restart. It replays the
 * condition against the second-to-last bar so the next live evaluation has a
 * genuine "before" to compare against — which is what stops a restart from
 * re-firing every alert whose condition happens to be true.
 */
export function seedState(alert: Alert, candles: Candle[], ctx?: AlertEvalContext): AlertState {
  if (candles.length < 2) return { ...EMPTY_STATE };

  const prevBar = candles[candles.length - 2];
  const prevPrice = prevBar.close;
  const c = alert.condition;

  let prevRef: number | null = null;
  let prevTrue: boolean | null = null;

  switch (c.type) {
    case 'price_above':
      prevRef = c.value ?? null;
      prevTrue = prevRef != null ? prevPrice > prevRef : null;
      break;
    case 'price_below':
      prevRef = c.value ?? null;
      prevTrue = prevRef != null ? prevPrice < prevRef : null;
      break;
    case 'price_cross':
      prevRef = c.value ?? null;
      break;
    case 'indicator_cross': {
      // Seed against history minus the latest bar, so the reference is the
      // indicator as it stood one bar ago.
      const { value } = indicatorReference(c, candles.slice(0, -1), ctx?.indicatorCtx);
      prevRef = value;
      break;
    }
    case 'percent_change':
    case 'volume_spike':
    case 'new_52w_high':
    case 'new_52w_low':
    case 'script_condition': {
      const prior = evaluateAt(alert, candles.slice(0, -1), prevPrice, ctx);
      prevTrue = prior;
      break;
    }
  }

  return { prevPrice, prevRef, prevTrue };
}

/**
 * Raw truth of a boolean-style condition at the end of a candle series.
 * Used only for seeding; live evaluation goes through `evaluateAlert`.
 */
function evaluateAt(alert: Alert, candles: Candle[], price: number, ctx?: AlertEvalContext): boolean | null {
  if (candles.length === 0) return null;
  const c = alert.condition;
  switch (c.type) {
    case 'percent_change': return percentChangeTrue(c, candles, price);
    case 'volume_spike': return volumeSpikeTrue(c, candles);
    case 'new_52w_high': return newExtremeTrue(candles, price, 'high');
    case 'new_52w_low': return newExtremeTrue(candles, price, 'low');
    case 'script_condition': {
      const data = ctx?.scriptCondition;
      if (!data || data.length === 0) return null;
      // Align to the shortened series when seeding.
      const idx = Math.min(candles.length, data.length) - 1;
      return idx >= 0 ? !!data[idx] : null;
    }
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Individual trigger predicates
// ---------------------------------------------------------------------------

function percentChangeTrue(c: AlertCondition, candles: Candle[], price: number): boolean | null {
  const lookback = Math.max(1, c.lookback ?? 1);
  if (candles.length < lookback + 1 || c.value == null) return null;
  const base = candles[candles.length - 1 - lookback].close;
  if (!base) return null;
  const pct = ((price - base) / base) * 100;
  // A negative threshold means "moved down by at least this much".
  return c.value < 0 ? pct <= c.value : pct >= c.value;
}

function volumeSpikeTrue(c: AlertCondition, candles: Candle[]): boolean | null {
  const lookback = Math.max(2, c.lookback ?? 20);
  if (candles.length < lookback + 1) return null;
  const multiple = c.value ?? 2;
  const window = candles.slice(-lookback - 1, -1);
  const avg = window.reduce((s, b) => s + b.volume, 0) / window.length;
  if (!avg) return null;
  return candles[candles.length - 1].volume >= avg * multiple;
}

/**
 * A new 52-week extreme, measured against the trailing year *excluding* the
 * current bar — comparing today's high against a window that contains today
 * would make the test trivially true.
 */
function newExtremeTrue(candles: Candle[], price: number, side: 'high' | 'low'): boolean | null {
  const last = candles[candles.length - 1];
  if (!last) return null;
  const cutoff = last.time - 365 * DAY;
  const window = candles.slice(0, -1).filter((b) => b.time >= cutoff);
  if (window.length < 20) return null; // too little history to call it a 52-week extreme
  if (side === 'high') return price > Math.max(...window.map((b) => b.high));
  return price < Math.min(...window.map((b) => b.low));
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Decide whether an alert fires, given the current market picture and what it
 * saw last time.
 *
 * Never throws: a misconfigured alert reports an error and returns unfired,
 * because one bad condition must not take down the poll for every other alert.
 */
export function evaluateAlert(alert: Alert, ctx: AlertEvalContext, prev: AlertState): AlertEvalResult {
  const { candles, price } = ctx;
  const c = alert.condition;
  const unchanged = (error?: string): AlertEvalResult => ({
    fired: false, price, message: '', state: { ...prev, prevPrice: price }, error,
  });

  if (candles.length === 0) return unchanged('No data');
  if (!Number.isFinite(price)) return unchanged('No price');

  switch (c.type) {
    // --- fixed-level triggers ---------------------------------------------
    case 'price_above':
    case 'price_below': {
      if (c.value == null) return unchanged('No threshold set');
      const isTrue = c.type === 'price_above' ? price > c.value : price < c.value;
      const fired = rising(prev.prevTrue, isTrue);
      return {
        fired, price,
        message: fired ? describe(alert, price, c.value) : '',
        state: { prevPrice: price, prevRef: c.value, prevTrue: isTrue },
      };
    }

    case 'price_cross': {
      if (c.value == null) return unchanged('No level set');
      const fired = crossed(prev.prevPrice, prev.prevRef, price, c.value, c.direction ?? 'any');
      return {
        fired, price,
        message: fired ? describe(alert, price, c.value) : '',
        state: { prevPrice: price, prevRef: c.value, prevTrue: price >= c.value },
      };
    }

    // --- moving reference -------------------------------------------------
    case 'indicator_cross': {
      const { value: ref, error } = indicatorReference(c, candles, ctx.indicatorCtx);
      if (error) return unchanged(error);
      if (ref == null) return unchanged(); // not enough history yet — not an error
      const fired = crossed(prev.prevPrice, prev.prevRef, price, ref, c.direction ?? 'any');
      return {
        fired, price,
        message: fired ? describe(alert, price, ref) : '',
        state: { prevPrice: price, prevRef: ref, prevTrue: price >= ref },
      };
    }

    // --- boolean-style triggers -------------------------------------------
    case 'percent_change':
    case 'volume_spike':
    case 'new_52w_high':
    case 'new_52w_low': {
      const isTrue =
        c.type === 'percent_change' ? percentChangeTrue(c, candles, price)
        : c.type === 'volume_spike' ? volumeSpikeTrue(c, candles)
        : newExtremeTrue(candles, price, c.type === 'new_52w_high' ? 'high' : 'low');
      if (isTrue == null) return unchanged();
      const fired = rising(prev.prevTrue, isTrue);
      return {
        fired, price,
        message: fired ? describe(alert, price, null) : '',
        state: { prevPrice: price, prevRef: prev.prevRef, prevTrue: isTrue },
      };
    }

    case 'script_condition': {
      const data = ctx.scriptCondition;
      if (!data || data.length === 0) return unchanged('Script produced no alert condition');
      const isTrue = !!data[data.length - 1];
      const fired = rising(prev.prevTrue, isTrue);
      return {
        fired, price,
        message: fired ? describe(alert, price, null) : '',
        state: { prevPrice: price, prevRef: prev.prevRef, prevTrue: isTrue },
      };
    }

    default:
      return unchanged(`Unknown trigger type: ${(c as AlertCondition).type}`);
  }
}
