/**
 * The alert engine.
 *
 * Lives in the main process so it keeps running when the window is closed —
 * that is the whole reason this app is Electron rather than a web page. The
 * tray keeps the process alive; this module keeps it useful.
 *
 * Three things it deliberately does *not* do:
 *
 * - **Poll a closed market.** Session state comes from `shared/exchanges.ts`,
 *   with trading days derived from each symbol's own bars. A TASE alert does
 *   not wake up on a day that symbol has never had a bar on, and when every
 *   watched venue is shut the engine sleeps until the earliest next open
 *   instead of ticking through the night.
 * - **Re-implement any maths.** `indicator_cross` resolves through
 *   `runIndicator()` and `script_condition` through the same sandbox the editor
 *   uses, so an alert and the chart cannot disagree about where the 200 DMA is.
 * - **Fire on a standing condition.** Evaluation is edge-triggered and state is
 *   seeded from history at load, so restarting the app does not replay every
 *   alert whose condition happens to be true right now.
 */

import { Notification } from 'electron';
import type { Alert, AlertEvent, Candle, Interval } from '../../shared/types';
import {
  evaluateAlert, isEligible, seedState, EMPTY_STATE, type AlertState,
} from '../../shared/alerts/evaluate';
import {
  exchangeByCode, exchangeFromSymbol, isUnknownExchange, isMarketOpen, observedTradingDays, secondsUntilNextOpen,
  type ExchangeInfo,
} from '../../shared/exchanges';
import { getDatabase, getSetting } from './db';
import { cachedCandles, loadCandles, readSymbolMeta } from './candle-cache';
import { fetchQuotes } from './market-data';
import { runUserScript } from './script-host';

/** How often to look while at least one watched market is trading. */
const POLL_OPEN_SEC = 60;
/** Never sleep longer than this, so a newly added alert is picked up promptly. */
const MAX_SLEEP_SEC = 6 * 3600;
/** Nor shorter than this, to keep a misconfigured alert from hammering Yahoo. */
const MIN_SLEEP_SEC = 30;

export interface AlertEngineHooks {
  /** Called for every fired alert, after the event is persisted. */
  onFired?: (event: AlertEvent, alert: Alert) => void;
}

let timer: NodeJS.Timeout | null = null;
let running = false;
let hooks: AlertEngineHooks = {};
/** Edge-detection memory, keyed by alert id. Rebuilt from history on seed. */
const states = new Map<number, AlertState>();
/** Alerts whose state has been seeded since the engine last started. */
const seeded = new Set<number>();

// ---------------------------------------------------------------------------
// Persistence — the single place alert rows are mapped to and from the DB
// ---------------------------------------------------------------------------

function rowToAlert(r: any): Alert {
  return {
    id: r.id,
    symbol: r.symbol,
    interval: r.interval as Interval,
    condition: safeParse(r.condition, { type: 'price_above' as const }),
    repeat: r.repeat === 'every_time' ? 'every_time' : 'once',
    cooldownSec: r.cooldownSec ?? 300,
    expiresAt: r.expiresAt ?? null,
    enabled: !!r.enabled,
    sound: !!r.sound,
    note: r.note ?? '',
    createdAt: r.createdAt,
    lastFiredAt: r.lastFiredAt ?? null,
  };
}

function safeParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

const ALERT_COLUMNS = `
  id, symbol, interval, condition, repeat, cooldown_sec AS cooldownSec,
  expires_at AS expiresAt, enabled, sound, note,
  created_at AS createdAt, last_fired_at AS lastFiredAt
`;

export function listAlerts(): Alert[] {
  return (getDatabase().prepare(`SELECT ${ALERT_COLUMNS} FROM alerts ORDER BY id DESC`).all() as any[])
    .map(rowToAlert);
}

export function getAlert(id: number): Alert | null {
  const r = getDatabase().prepare(`SELECT ${ALERT_COLUMNS} FROM alerts WHERE id = ?`).get(id) as any;
  return r ? rowToAlert(r) : null;
}

export type AlertInput = Partial<Alert> & { symbol: string; condition: Alert['condition'] };

export function saveAlert(input: AlertInput): Alert {
  const db = getDatabase();
  const now = Math.floor(Date.now() / 1000);
  const symbol = String(input.symbol ?? '').trim().toUpperCase();
  if (!symbol) throw new Error('Symbol required');

  const values = {
    symbol,
    interval: (input.interval ?? '1d') as Interval,
    condition: JSON.stringify(input.condition ?? {}),
    repeat: input.repeat === 'every_time' ? 'every_time' : 'once',
    cooldownSec: Math.max(0, Number(input.cooldownSec ?? 300)),
    expiresAt: input.expiresAt ?? null,
    enabled: input.enabled === false ? 0 : 1,
    sound: input.sound === false ? 0 : 1,
    note: String(input.note ?? ''),
  };

  let id = input.id;
  if (!id) {
    const info = db
      .prepare(
        `INSERT INTO alerts (symbol, interval, condition, repeat, cooldown_sec, expires_at, enabled, sound, note, created_at)
         VALUES (@symbol, @interval, @condition, @repeat, @cooldownSec, @expiresAt, @enabled, @sound, @note, ${now})`,
      )
      .run(values);
    id = Number(info.lastInsertRowid);
  } else {
    db.prepare(
      `UPDATE alerts SET symbol = @symbol, interval = @interval, condition = @condition, repeat = @repeat,
         cooldown_sec = @cooldownSec, expires_at = @expiresAt, enabled = @enabled, sound = @sound, note = @note
       WHERE id = @id`,
    ).run({ ...values, id });
    // An edited condition invalidates whatever edge we were tracking.
    resetAlertState(id);
  }

  notifyAlertsChanged();
  return getAlert(id)!;
}

export function deleteAlert(id: number): void {
  getDatabase().prepare('DELETE FROM alerts WHERE id = ?').run(id);
  resetAlertState(id);
  notifyAlertsChanged();
}

export function listAlertEvents(limit = 100): AlertEvent[] {
  return (
    getDatabase()
      .prepare(
        `SELECT id, alert_id AS alertId, symbol, fired_at AS firedAt, price, message, acknowledged
         FROM alert_events ORDER BY fired_at DESC LIMIT ?`,
      )
      .all(Math.min(Math.max(1, limit), 500)) as any[]
  ).map((r) => ({ ...r, acknowledged: !!r.acknowledged }));
}

export function ackAlertEvent(id: number): void {
  getDatabase().prepare('UPDATE alert_events SET acknowledged = 1 WHERE id = ?').run(id);
}

export function unacknowledgedCount(): number {
  const r = getDatabase()
    .prepare('SELECT COUNT(*) AS n FROM alert_events WHERE acknowledged = 0')
    .get() as { n: number };
  return r.n;
}

// ---------------------------------------------------------------------------
// Session awareness
// ---------------------------------------------------------------------------

function exchangeFor(symbol: string): ExchangeInfo {
  const meta = readSymbolMeta(symbol);
  // An unresolved cached exchange is worse than none: UNKNOWN trades 00:00-23:59
  // and would keep the poller awake all night. Fall back to the ticker suffix.
  if (meta && !isUnknownExchange(meta.exchange)) return exchangeByCode(meta.exchange);
  return exchangeFromSymbol(symbol);
}

/**
 * Trading days for a symbol, derived from its own daily bars.
 *
 * Daily bars are used even for an intraday alert: they are the cleanest signal
 * of which weekdays a venue actually trades, and the cache almost always holds
 * them because the chart fetches dailies first.
 */
function tradingDaysFor(symbol: string, exchange: ExchangeInfo): number[] {
  const daily = cachedCandles(symbol, '1d');
  return observedTradingDays(daily, exchange.timezone, exchange.defaultTradingDays);
}

// ---------------------------------------------------------------------------
// The poll
// ---------------------------------------------------------------------------

interface SymbolPlan {
  symbol: string;
  exchange: ExchangeInfo;
  tradingDays: number[];
  open: boolean;
  alerts: Alert[];
}

/** Group the eligible alerts by symbol and work out which venues are trading. */
function planTick(now: number): SymbolPlan[] {
  const bySymbol = new Map<string, Alert[]>();
  for (const alert of listAlerts()) {
    if (!isEligible(alert, now)) continue;
    const list = bySymbol.get(alert.symbol);
    if (list) list.push(alert);
    else bySymbol.set(alert.symbol, [alert]);
  }

  return [...bySymbol.entries()].map(([symbol, alerts]) => {
    const exchange = exchangeFor(symbol);
    const tradingDays = tradingDaysFor(symbol, exchange);
    return { symbol, exchange, tradingDays, open: isMarketOpen(exchange, tradingDays, now), alerts };
  });
}

/**
 * Resolve the per-bar truth of a script's `alertcondition()`.
 *
 * Runs in the same worker-thread sandbox the editor uses, so a script that
 * misbehaves costs one killed worker rather than the alert engine.
 */
async function scriptConditionFor(alert: Alert, candles: Candle[]): Promise<boolean[] | undefined> {
  const { scriptId, conditionKey } = alert.condition;
  if (!scriptId) return undefined;

  const row = getDatabase().prepare('SELECT source FROM scripts WHERE id = ?').get(scriptId) as
    | { source: string }
    | undefined;
  if (!row) return undefined;

  const res = await runUserScript(row.source, candles, {});
  if (!res.ok) return undefined;

  const conditions = res.descriptor.alertConditions;
  const match = conditionKey ? conditions.find((c) => c.key === conditionKey || c.title === conditionKey) : conditions[0];
  return match?.data;
}

/** Persist a firing, raise the OS notification, and hand it to the caller. */
function fire(alert: Alert, price: number, message: string, now: number): void {
  const db = getDatabase();
  const info = db
    .prepare('INSERT INTO alert_events (alert_id, symbol, fired_at, price, message) VALUES (?, ?, ?, ?, ?)')
    .run(alert.id, alert.symbol, now, price, message);

  db.prepare('UPDATE alerts SET last_fired_at = ? WHERE id = ?').run(now, alert.id);
  // A fire-once alert disables itself so it disappears from the active list
  // rather than lingering as a row that can never fire again.
  if (alert.repeat === 'once') db.prepare('UPDATE alerts SET enabled = 0 WHERE id = ?').run(alert.id);

  const event: AlertEvent = {
    id: Number(info.lastInsertRowid),
    alertId: alert.id,
    symbol: alert.symbol,
    firedAt: now,
    price,
    message,
    acknowledged: false,
  };

  // The event is already persisted, so a desktop environment that cannot show
  // a notification costs the popup, never the alert itself.
  try {
    if (Notification?.isSupported?.()) {
      new Notification({ title: `MarketLab — ${alert.symbol}`, body: message, silent: !alert.sound }).show();
    }
  } catch (e) {
    console.warn('[alerts] notification failed:', e instanceof Error ? e.message : e);
  }

  hooks.onFired?.(event, { ...alert, lastFiredAt: now });
  console.log(`[alerts] fired #${alert.id}: ${message}`);
}

/**
 * Evaluate a single alert against current data and fire it if it triggers.
 *
 * Exported so the whole path — load bars, resolve the reference, seed the edge,
 * decide, persist, notify — can be verified directly, rather than only through
 * a timer that depends on the wall clock and an open market.
 */
export async function evaluateAndFire(
  alert: Alert,
  opts: { price?: number; now?: number; timezone?: string } = {},
): Promise<{ fired: boolean; error?: string }> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);

  // Cache-first: this only reaches the network when the series is stale by the
  // same policy the chart uses.
  const { candles } = await loadCandles(alert.symbol, alert.interval, {});
  if (candles.length === 0) return { fired: false, error: 'No data' };

  const price = opts.price ?? candles[candles.length - 1].close;
  const scriptCondition =
    alert.condition.type === 'script_condition' ? await scriptConditionFor(alert, candles) : undefined;

  const ctx = {
    candles,
    price,
    now,
    scriptCondition,
    indicatorCtx: {
      timezone: opts.timezone ?? exchangeFor(alert.symbol).timezone,
      useAdjusted: getSetting('useAdjustedClose', true),
      interval: alert.interval,
    },
  };

  // First look after a restart establishes the edge instead of testing it.
  if (!seeded.has(alert.id)) {
    states.set(alert.id, seedState(alert, candles, ctx));
    seeded.add(alert.id);
  }

  const prev = states.get(alert.id) ?? EMPTY_STATE;
  const result = evaluateAlert(alert, ctx, prev);
  states.set(alert.id, result.state);

  if (result.error) console.warn(`[alerts] #${alert.id} (${alert.symbol}): ${result.error}`);
  if (result.fired) fire(alert, result.price, result.message, now);
  return { fired: result.fired, error: result.error };
}

/** Forget an alert's edge memory, so the next look re-seeds from history. */
export function resetAlertState(id?: number): void {
  if (id == null) {
    states.clear();
    seeded.clear();
    return;
  }
  states.delete(id);
  seeded.delete(id);
}

async function tick(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const plans = planTick(now);
  const openPlans = plans.filter((p) => p.open);

  // One batched quote request covers every symbol being watched this tick.
  const quotes = new Map<string, number>();
  if (openPlans.length > 0) {
    try {
      for (const q of await fetchQuotes(openPlans.map((p) => p.symbol))) {
        if (Number.isFinite(q.price)) quotes.set(q.symbol, q.price);
      }
    } catch (e) {
      // A failed quote round is not fatal: bars may still have moved, and the
      // last close is a usable fallback for evaluation.
      console.warn('[alerts] quote fetch failed:', e instanceof Error ? e.message : e);
    }
  }

  for (const plan of openPlans) {
    for (const alert of plan.alerts) {
      try {
        await evaluateAndFire(alert, {
          price: quotes.get(alert.symbol),
          now,
          timezone: plan.exchange.timezone,
        });
      } catch (e) {
        // One broken alert must never stop the others being evaluated.
        console.warn(`[alerts] #${alert.id} failed:`, e instanceof Error ? e.message : e);
      }
    }
  }

  scheduleNext(plans, now);
}

/**
 * Decide when to look again.
 *
 * With something trading, a fixed minute. With everything shut, sleep until the
 * earliest venue reopens rather than waking through the night and the weekend —
 * which is what makes an always-on tray process cheap.
 */
function scheduleNext(plans: SymbolPlan[], now: number): void {
  if (!running) return;

  let delay: number;
  if (plans.length === 0) {
    delay = MAX_SLEEP_SEC; // nothing to watch; wake occasionally in case that changes
  } else if (plans.some((p) => p.open)) {
    delay = POLL_OPEN_SEC;
  } else {
    delay = Math.min(...plans.map((p) => secondsUntilNextOpen(p.exchange, p.tradingDays, now)));
  }

  const clamped = Math.min(Math.max(delay, MIN_SLEEP_SEC), MAX_SLEEP_SEC);
  timer = setTimeout(() => void tick(), clamped * 1000);
  // Never hold the process open on this timer alone; the tray decides lifetime.
  timer.unref?.();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function startAlertEngine(engineHooks: AlertEngineHooks = {}): void {
  if (running) return;
  hooks = engineHooks;
  running = true;
  // Start from no edge memory: every alert re-seeds from history on its first
  // look, which is what stops a restart replaying standing conditions.
  resetAlertState();
  console.log('[alerts] engine started');
  void tick();
}

export function stopAlertEngine(): void {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
  console.log('[alerts] engine stopped');
}

export function isAlertEngineRunning(): boolean {
  return running;
}

/** Re-plan immediately — called when alerts are added, edited or removed. */
export function notifyAlertsChanged(): void {
  if (!running) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void tick(), 1000);
  timer.unref?.();
}
