/**
 * Alert evaluation: does the right trigger fire, on the right edge, and stay
 * quiet when it should.
 *
 * The recurring risk with alerts is not missing a signal — it is firing one
 * that was already true when the alert was created, or re-firing it on every
 * poll. Most of what follows pins down that edge behaviour.
 */

import { describe, it, expect } from 'vitest';
import type { Alert, AlertCondition, Candle } from '../types';
import { evaluateAlert, seedState, isEligible, EMPTY_STATE, type AlertState } from './evaluate';
import { runIndicator } from '../indicators/registry';

const DAY = 86400;
const T0 = 1600000000;

function makeCandles(n: number, close: (i: number) => number, volume: (i: number) => number = () => 1_000_000): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const c = close(i);
    return {
      time: T0 + i * DAY,
      open: c, high: c + 0.5, low: c - 0.5, close: c,
      volume: volume(i),
      adjClose: c,
    };
  });
}

function makeAlert(condition: AlertCondition, overrides: Partial<Alert> = {}): Alert {
  return {
    id: 1,
    symbol: 'TEST',
    interval: '1d',
    condition,
    repeat: 'every_time',
    cooldownSec: 0,
    expiresAt: null,
    enabled: true,
    sound: true,
    note: '',
    createdAt: T0,
    lastFiredAt: null,
    ...overrides,
  };
}

/** A flat series at 100, long enough for a 200 DMA to exist. */
const FLAT = makeCandles(400, () => 100);
/** A steady rise from 100 to ~300. */
const RISING = makeCandles(400, (i) => 100 + i * 0.5);

// ---------------------------------------------------------------------------

describe('eligibility gating', () => {
  it('skips disabled alerts', () => {
    expect(isEligible(makeAlert({ type: 'price_above', value: 1 }, { enabled: false }), T0)).toBe(false);
  });

  it('skips expired alerts', () => {
    const a = makeAlert({ type: 'price_above', value: 1 }, { expiresAt: T0 - 1 });
    expect(isEligible(a, T0)).toBe(false);
  });

  it('honours a not-yet-reached expiry', () => {
    const a = makeAlert({ type: 'price_above', value: 1 }, { expiresAt: T0 + 100 });
    expect(isEligible(a, T0)).toBe(true);
  });

  it('a fire-once alert never runs again after firing', () => {
    const a = makeAlert({ type: 'price_above', value: 1 }, { repeat: 'once', lastFiredAt: T0 - 99999 });
    expect(isEligible(a, T0)).toBe(false);
  });

  it('suppresses a repeating alert inside its cooldown, and releases it after', () => {
    const a = makeAlert({ type: 'price_above', value: 1 }, { cooldownSec: 300, lastFiredAt: T0 - 100 });
    expect(isEligible(a, T0)).toBe(false);
    expect(isEligible({ ...a, lastFiredAt: T0 - 400 }, T0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('price threshold triggers', () => {
  const above = makeAlert({ type: 'price_above', value: 110 });

  it('does not fire when the condition was already true at creation', () => {
    // Seeded against a series already trading above the level.
    const candles = makeCandles(10, () => 120);
    const state = seedState(above, candles);
    const r = evaluateAlert(above, { candles, price: 121, now: T0 }, state);
    expect(r.fired).toBe(false);
  });

  it('fires on the crossing, then stays quiet while it remains true', () => {
    const candles = makeCandles(10, () => 105);
    let state = seedState(above, candles);

    const first = evaluateAlert(above, { candles, price: 112, now: T0 }, state);
    expect(first.fired).toBe(true);
    expect(first.message).toContain('rose above');

    const second = evaluateAlert(above, { candles, price: 115, now: T0 + 60 }, first.state);
    expect(second.fired).toBe(false);
  });

  it('re-arms after price falls back below the level', () => {
    const candles = makeCandles(10, () => 105);
    let state: AlertState = seedState(above, candles);
    state = evaluateAlert(above, { candles, price: 112, now: T0 }, state).state;
    state = evaluateAlert(above, { candles, price: 104, now: T0 + 60 }, state).state;
    const again = evaluateAlert(above, { candles, price: 113, now: T0 + 120 }, state);
    expect(again.fired).toBe(true);
  });

  it('price_below mirrors price_above', () => {
    const below = makeAlert({ type: 'price_below', value: 90 });
    const candles = makeCandles(10, () => 95);
    const state = seedState(below, candles);
    expect(evaluateAlert(below, { candles, price: 88, now: T0 }, state).fired).toBe(true);
  });

  it('reports an error rather than firing when no threshold is set', () => {
    const broken = makeAlert({ type: 'price_above' });
    const r = evaluateAlert(broken, { candles: FLAT, price: 100, now: T0 }, EMPTY_STATE);
    expect(r.fired).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

describe('price_cross direction', () => {
  const candles = makeCandles(10, () => 100);

  it('fires upward crosses only when direction is "above"', () => {
    const up = makeAlert({ type: 'price_cross', value: 100, direction: 'above' });
    const state: AlertState = { prevPrice: 98, prevRef: 100, prevTrue: false };
    expect(evaluateAlert(up, { candles, price: 102, now: T0 }, state).fired).toBe(true);

    const downState: AlertState = { prevPrice: 102, prevRef: 100, prevTrue: true };
    expect(evaluateAlert(up, { candles, price: 98, now: T0 }, downState).fired).toBe(false);
  });

  it('fires either way when direction is "any"', () => {
    const any = makeAlert({ type: 'price_cross', value: 100, direction: 'any' });
    const downState: AlertState = { prevPrice: 102, prevRef: 100, prevTrue: true };
    expect(evaluateAlert(any, { candles, price: 98, now: T0 }, downState).fired).toBe(true);
  });

  it('cannot fire without prior state — nothing to have crossed from', () => {
    const any = makeAlert({ type: 'price_cross', value: 100, direction: 'any' });
    expect(evaluateAlert(any, { candles, price: 150, now: T0 }, EMPTY_STATE).fired).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('indicator_cross', () => {
  const cross200 = makeAlert({
    type: 'indicator_cross',
    indicatorId: 'ma',
    indicatorParams: { length: 200, maType: 'SMA', source: 'close' },
    plotKey: 'ma',
    direction: 'below',
  });

  it('uses the same value the chart would draw', () => {
    const { result } = runIndicator('ma', RISING, { length: 200, maType: 'SMA', source: 'close' });
    const chartValue = result!.series.ma[RISING.length - 1]!;

    // Feed a price just under the MA, coming from just above it.
    const state: AlertState = { prevPrice: chartValue + 1, prevRef: chartValue, prevTrue: true };
    const r = evaluateAlert(cross200, { candles: RISING, price: chartValue - 1, now: T0 }, state);

    expect(r.fired).toBe(true);
    // The message quotes the reference, which must be the chart's number.
    expect(r.message).toContain('crossed below');
    expect(r.state.prevRef).toBeCloseTo(chartValue, 9);
  });

  it('stays silent with too little history for the average', () => {
    const short = makeCandles(50, () => 100);
    const r = evaluateAlert(cross200, { candles: short, price: 100, now: T0 }, EMPTY_STATE);
    expect(r.fired).toBe(false);
    expect(r.error).toBeUndefined(); // an absence, not a misconfiguration
  });

  it('reports a bad indicator id as an error', () => {
    const broken = makeAlert({ type: 'indicator_cross', indicatorId: 'nonexistent' });
    const r = evaluateAlert(broken, { candles: RISING, price: 100, now: T0 }, EMPTY_STATE);
    expect(r.fired).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('seeding against a rising series does not fire on the next look', () => {
    // Price is far above its 200 DMA throughout; nothing crossed.
    const state = seedState(cross200, RISING);
    const last = RISING[RISING.length - 1].close;
    expect(evaluateAlert(cross200, { candles: RISING, price: last, now: T0 }, state).fired).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('percent_change', () => {
  it('fires once the move over the window reaches the threshold', () => {
    const a = makeAlert({ type: 'percent_change', value: 5, lookback: 5 });
    const candles = makeCandles(20, () => 100);
    const state: AlertState = { prevPrice: 100, prevRef: null, prevTrue: false };
    expect(evaluateAlert(a, { candles, price: 106, now: T0 }, state).fired).toBe(true);
    expect(evaluateAlert(a, { candles, price: 103, now: T0 }, state).fired).toBe(false);
  });

  it('a negative threshold means a downward move', () => {
    const a = makeAlert({ type: 'percent_change', value: -5, lookback: 5 });
    const candles = makeCandles(20, () => 100);
    const state: AlertState = { prevPrice: 100, prevRef: null, prevTrue: false };
    expect(evaluateAlert(a, { candles, price: 94, now: T0 }, state).fired).toBe(true);
    expect(evaluateAlert(a, { candles, price: 106, now: T0 }, state).fired).toBe(false);
  });
});

describe('volume_spike', () => {
  it('fires when the latest bar dwarfs the trailing average', () => {
    const a = makeAlert({ type: 'volume_spike', value: 3, lookback: 20 });
    const candles = makeCandles(30, () => 100, (i) => (i === 29 ? 10_000_000 : 1_000_000));
    const state: AlertState = { prevPrice: 100, prevRef: null, prevTrue: false };
    expect(evaluateAlert(a, { candles, price: 100, now: T0 }, state).fired).toBe(true);
  });

  it('ignores ordinary volume', () => {
    const a = makeAlert({ type: 'volume_spike', value: 3, lookback: 20 });
    const candles = makeCandles(30, () => 100, () => 1_000_000);
    const state: AlertState = { prevPrice: 100, prevRef: null, prevTrue: false };
    expect(evaluateAlert(a, { candles, price: 100, now: T0 }, state).fired).toBe(false);
  });
});

describe('52-week extremes', () => {
  it('fires on a genuine new high', () => {
    const a = makeAlert({ type: 'new_52w_high' });
    const candles = makeCandles(300, () => 100);
    const state: AlertState = { prevPrice: 100, prevRef: null, prevTrue: false };
    expect(evaluateAlert(a, { candles, price: 150, now: T0 }, state).fired).toBe(true);
  });

  it('does not fire merely for being near the top of the range', () => {
    const a = makeAlert({ type: 'new_52w_high' });
    const candles = makeCandles(300, (i) => 100 + (i === 150 ? 80 : 0));
    const state: AlertState = { prevPrice: 100, prevRef: null, prevTrue: false };
    expect(evaluateAlert(a, { candles, price: 175, now: T0 }, state).fired).toBe(false);
  });

  it('stays silent without a year of history to judge against', () => {
    const a = makeAlert({ type: 'new_52w_low' });
    const candles = makeCandles(10, () => 100);
    const r = evaluateAlert(a, { candles, price: 1, now: T0 }, EMPTY_STATE);
    expect(r.fired).toBe(false);
  });
});

describe('script_condition', () => {
  const a = makeAlert({ type: 'script_condition', scriptId: 1, conditionKey: 'Golden cross' });

  it('fires on the bar the script flags', () => {
    const data = new Array(400).fill(false);
    data[399] = true;
    const state: AlertState = { prevPrice: 100, prevRef: null, prevTrue: false };
    const r = evaluateAlert(a, { candles: FLAT, price: 100, now: T0, scriptCondition: data }, state);
    expect(r.fired).toBe(true);
    expect(r.message).toContain('Golden cross');
  });

  it('does not re-fire while the flag stays true', () => {
    const data = new Array(400).fill(true);
    const state: AlertState = { prevPrice: 100, prevRef: null, prevTrue: true };
    expect(evaluateAlert(a, { candles: FLAT, price: 100, now: T0, scriptCondition: data }, state).fired).toBe(false);
  });

  it('errors when the script produced no condition', () => {
    const r = evaluateAlert(a, { candles: FLAT, price: 100, now: T0 }, EMPTY_STATE);
    expect(r.fired).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe('robustness', () => {
  it('never fires without data', () => {
    const a = makeAlert({ type: 'price_above', value: 1 });
    expect(evaluateAlert(a, { candles: [], price: 100, now: T0 }, EMPTY_STATE).fired).toBe(false);
  });

  it('never fires on a non-finite price', () => {
    const a = makeAlert({ type: 'price_above', value: 1 });
    const state: AlertState = { prevPrice: 0, prevRef: 1, prevTrue: false };
    expect(evaluateAlert(a, { candles: FLAT, price: NaN, now: T0 }, state).fired).toBe(false);
  });

  it('always returns a state to carry forward, even on error', () => {
    const broken = makeAlert({ type: 'price_above' });
    const r = evaluateAlert(broken, { candles: FLAT, price: 100, now: T0 }, EMPTY_STATE);
    expect(r.state).toBeDefined();
    expect(r.state.prevPrice).toBe(100);
  });

  it('seeding on a series shorter than two bars yields empty state', () => {
    const a = makeAlert({ type: 'price_above', value: 100 });
    expect(seedState(a, makeCandles(1, () => 100))).toEqual(EMPTY_STATE);
  });
});
