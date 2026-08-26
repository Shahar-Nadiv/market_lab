/**
 * Alerts: define what should wake you, and read back what already did.
 *
 * The condition builder is driven off the shared indicator registry and the
 * saved-script list rather than a hardcoded menu, so a new indicator becomes
 * alertable the moment it is registered — the same reason the chart needs no
 * per-indicator wiring.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useStore } from '../state/store';
import { formatPrice } from '../chart/data';
import { INDICATORS, PRESETS } from '@shared/indicators/registry';
import { INTERVALS, type Alert, type AlertCondition, type AlertTriggerType, type Interval, type UserScript } from '@shared/types';

const TRIGGERS: { type: AlertTriggerType; label: string; hint: string }[] = [
  { type: 'price_cross', label: 'Price crosses level', hint: 'Fires when price moves through a level you set.' },
  { type: 'price_above', label: 'Price rises above', hint: 'Fires when price moves up through the level.' },
  { type: 'price_below', label: 'Price falls below', hint: 'Fires when price moves down through the level.' },
  { type: 'indicator_cross', label: 'Price crosses indicator', hint: 'Fires on a cross of a moving average or band — the same line the chart draws.' },
  { type: 'percent_change', label: '% change over window', hint: 'Fires when the move over N bars reaches your threshold. Negative means downward.' },
  { type: 'volume_spike', label: 'Volume spike', hint: 'Fires when the latest bar’s volume is a multiple of its recent average.' },
  { type: 'new_52w_high', label: 'New 52-week high', hint: 'Fires on a genuine new high against the trailing year.' },
  { type: 'new_52w_low', label: 'New 52-week low', hint: 'Fires on a genuine new low against the trailing year.' },
  { type: 'script_condition', label: 'Script condition', hint: 'Fires on an alertcondition() declared by one of your scripts.' },
];

/** Indicators whose output is a price-level line worth crossing. */
const CROSSABLE = new Set(['ma', 'bbands', 'donchian', 'range_52w', 'vwap']);

const DEFAULT_CONDITION: AlertCondition = { type: 'price_cross', direction: 'any', value: 0 };

export default function AlertPanel({ onClose }: { onClose: () => void }) {
  const {
    symbol, quote, alerts, alertEvents, loadAlerts, saveAlert, removeAlert, toggleAlert, acknowledgeEvent,
  } = useStore();

  const [editing, setEditing] = useState<Alert | null>(null);
  const [draft, setDraft] = useState<Partial<Alert>>(() => newDraft(symbol));
  const [scripts, setScripts] = useState<UserScript[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadAlerts();
    void (api.listScripts() as Promise<UserScript[]>).then(setScripts).catch(() => setScripts([]));
  }, [loadAlerts]);

  // Seed the level from the live price, which is almost always the number the
  // user is reasoning from when they open this panel.
  useEffect(() => {
    if (!editing && quote?.price && !draft.condition?.value) {
      setDraft((d) => ({ ...d, condition: { ...d.condition!, value: Number(quote.price.toFixed(2)) } }));
    }
  }, [quote?.price, editing]);

  const condition = draft.condition ?? DEFAULT_CONDITION;
  const trigger = TRIGGERS.find((t) => t.type === condition.type) ?? TRIGGERS[0];

  function patchCondition(patch: Partial<AlertCondition>) {
    setDraft((d) => ({ ...d, condition: { ...(d.condition ?? DEFAULT_CONDITION), ...patch } }));
  }

  /**
   * Switching trigger type fills in a sensible starting point rather than
   * leaving the follow-up fields blank. An indicator cross defaults to the 200
   * DMA, which is the line this app exists to watch.
   */
  function changeTrigger(type: AlertTriggerType) {
    if (type === 'indicator_cross' && !condition.indicatorId) {
      const dma200 = PRESETS.find((p) => p.id === 'dma200');
      return patchCondition({
        type,
        direction: condition.direction ?? 'any',
        indicatorId: dma200?.indicatorId ?? 'ma',
        indicatorParams: dma200?.params ?? { length: 200, maType: 'SMA', source: 'close' },
        plotKey: 'ma',
      });
    }
    if (type === 'volume_spike') return patchCondition({ type, value: condition.value ?? 3, lookback: condition.lookback ?? 20 });
    if (type === 'percent_change') return patchCondition({ type, value: condition.value ?? 5, lookback: condition.lookback ?? 5 });
    patchCondition({ type });
  }

  function startNew() {
    setEditing(null);
    setDraft(newDraft(symbol, quote?.price));
    setError(null);
  }

  function startEdit(alert: Alert) {
    setEditing(alert);
    setDraft(alert);
    setError(null);
  }

  async function submit() {
    setError(null);
    const c = draft.condition ?? DEFAULT_CONDITION;
    if (needsValue(c.type) && (c.value == null || !Number.isFinite(c.value))) {
      return setError('Set a value for this trigger.');
    }
    if (c.type === 'indicator_cross' && !c.indicatorId) return setError('Choose an indicator to cross.');
    if (c.type === 'script_condition' && !c.scriptId) return setError('Choose a script.');

    try {
      await saveAlert({
        ...draft,
        symbol: (draft.symbol || symbol).toUpperCase(),
        condition: c,
      } as Alert);
      startNew();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const unread = alertEvents.filter((e) => !e.acknowledged).length;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ground">
      <header className="flex items-center gap-2 border-b border-edge bg-panel px-3 py-2">
        <span className="text-xs font-semibold">Alerts</span>
        <span className="text-[11px] text-ink-faint">
          {alerts.filter((a) => a.enabled).length} active
          {unread > 0 && <span className="ml-2 text-accent">{unread} unread</span>}
        </span>
        <button
          onClick={startNew}
          className="ml-auto rounded border border-edge px-2.5 py-1 text-xs text-ink-dim hover:border-accent hover:text-ink"
        >
          New alert
        </button>
        <button onClick={onClose} className="rounded border border-edge px-2.5 py-1 text-xs text-ink-dim hover:border-accent hover:text-ink">
          Close
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ---------------------------------------------------------------- */}
        <section className="w-96 shrink-0 overflow-auto border-r border-edge p-3">
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
            {editing ? `Edit alert #${editing.id}` : 'New alert'}
          </h2>

          <Field label="Symbol">
            <input
              value={draft.symbol ?? symbol}
              onChange={(e) => setDraft((d) => ({ ...d, symbol: e.target.value.toUpperCase() }))}
              className={inputClass}
            />
          </Field>

          <Field label="Interval" hint="Which bars the condition is evaluated against.">
            <select
              value={draft.interval ?? '1d'}
              onChange={(e) => setDraft((d) => ({ ...d, interval: e.target.value as Interval }))}
              className={inputClass}
            >
              {INTERVALS.map((iv) => <option key={iv} value={iv}>{iv}</option>)}
            </select>
          </Field>

          <Field label="Trigger" hint={trigger.hint}>
            <select
              value={condition.type}
              onChange={(e) => changeTrigger(e.target.value as AlertTriggerType)}
              className={inputClass}
            >
              {TRIGGERS.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
            </select>
          </Field>

          {/* --- trigger-specific inputs ---------------------------------- */}
          {needsValue(condition.type) && (
            <Field label={valueLabel(condition.type)}>
              <input
                type="number"
                step="any"
                value={condition.value ?? ''}
                onChange={(e) => patchCondition({ value: e.target.value === '' ? undefined : Number(e.target.value) })}
                className={inputClass}
              />
            </Field>
          )}

          {(condition.type === 'percent_change' || condition.type === 'volume_spike') && (
            <Field label="Lookback (bars)">
              <input
                type="number"
                min={1}
                value={condition.lookback ?? (condition.type === 'volume_spike' ? 20 : 5)}
                onChange={(e) => patchCondition({ lookback: Number(e.target.value) })}
                className={inputClass}
              />
            </Field>
          )}

          {condition.type === 'indicator_cross' && (
            <>
              <Field label="Indicator" hint="Presets fill in the standard moving-average settings.">
                <select
                  value={presetKeyFor(condition)}
                  onChange={(e) => applyIndicatorChoice(e.target.value, patchCondition)}
                  className={inputClass}
                >
                  <optgroup label="Presets">
                    {PRESETS.filter((p) => CROSSABLE.has(p.indicatorId)).map((p) => (
                      <option key={`preset:${p.id}`} value={`preset:${p.id}`}>{p.label}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Indicators">
                    {INDICATORS.filter((i) => CROSSABLE.has(i.id)).map((i) => (
                      <option key={`ind:${i.id}`} value={`ind:${i.id}`}>{i.label}</option>
                    ))}
                  </optgroup>
                </select>
              </Field>
              <Field label="Plot" hint="Which of the indicator's lines to cross.">
                <select
                  value={condition.plotKey ?? ''}
                  onChange={(e) => patchCondition({ plotKey: e.target.value })}
                  className={inputClass}
                >
                  {plotKeysFor(condition.indicatorId).map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
              </Field>
            </>
          )}

          {condition.type === 'script_condition' && (
            <Field label="Script" hint="Only scripts that call alertcondition() can trigger.">
              <select
                value={condition.scriptId ?? ''}
                onChange={(e) => patchCondition({ scriptId: Number(e.target.value) })}
                className={inputClass}
              >
                <option value="">Choose a script…</option>
                {scripts.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
          )}

          {(condition.type === 'price_cross' || condition.type === 'indicator_cross') && (
            <Field label="Direction">
              <select
                value={condition.direction ?? 'any'}
                onChange={(e) => patchCondition({ direction: e.target.value as 'above' | 'below' | 'any' })}
                className={inputClass}
              >
                <option value="any">Either way</option>
                <option value="above">Crossing up</option>
                <option value="below">Crossing down</option>
              </select>
            </Field>
          )}

          {/* --- delivery ------------------------------------------------- */}
          <div className="my-3 h-px bg-edge" />

          <Field label="Repeat">
            <select
              value={draft.repeat ?? 'once'}
              onChange={(e) => setDraft((d) => ({ ...d, repeat: e.target.value as Alert['repeat'] }))}
              className={inputClass}
            >
              <option value="once">Fire once, then disable</option>
              <option value="every_time">Fire every time</option>
            </select>
          </Field>

          <Field label="Cooldown (seconds)" hint="Minimum gap between two firings of this alert.">
            <input
              type="number"
              min={0}
              value={draft.cooldownSec ?? 300}
              onChange={(e) => setDraft((d) => ({ ...d, cooldownSec: Number(e.target.value) }))}
              className={inputClass}
            />
          </Field>

          <Field label="Expires" hint="Leave blank to never expire.">
            <input
              type="date"
              value={draft.expiresAt ? new Date(draft.expiresAt * 1000).toISOString().slice(0, 10) : ''}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  expiresAt: e.target.value ? Math.floor(new Date(e.target.value).getTime() / 1000) : null,
                }))
              }
              className={inputClass}
            />
          </Field>

          <Field label="Note">
            <input
              value={draft.note ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
              placeholder="Why you set this"
              className={inputClass}
            />
          </Field>

          <label className="mt-2 flex items-center gap-2 text-[11px] text-ink-dim">
            <input
              type="checkbox"
              checked={draft.sound !== false}
              onChange={(e) => setDraft((d) => ({ ...d, sound: e.target.checked }))}
            />
            Play a sound
          </label>

          {error && <p className="mt-2 text-[11px] text-down">{error}</p>}

          <div className="mt-3 flex gap-2">
            <button onClick={() => void submit()} className="rounded bg-accent px-3 py-1 text-xs text-white hover:opacity-90">
              {editing ? 'Save changes' : 'Create alert'}
            </button>
            {editing && (
              <button onClick={startNew} className="rounded border border-edge px-3 py-1 text-xs text-ink-dim hover:text-ink">
                Cancel
              </button>
            )}
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        <section className="min-w-0 flex-1 overflow-auto p-3">
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Active alerts</h2>
          {alerts.length === 0 && <p className="text-[11px] text-ink-faint">No alerts yet.</p>}
          <ul className="space-y-1">
            {alerts.map((a) => (
              <li
                key={a.id}
                className={`flex items-center gap-2 rounded border border-edge px-2 py-1.5 ${a.enabled ? '' : 'opacity-50'}`}
              >
                <button
                  onClick={() => void toggleAlert(a.id)}
                  title={a.enabled ? 'Disable' : 'Enable'}
                  className={`h-2 w-2 shrink-0 rounded-full ${a.enabled ? 'bg-up' : 'bg-ink-faint'}`}
                />
                <span className="w-20 shrink-0 truncate text-xs font-medium">{a.symbol}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-ink-dim">{summarize(a)}</span>
                <span className="shrink-0 text-[10px] text-ink-faint">
                  {a.repeat === 'once' ? 'once' : 'repeating'}
                  {a.lastFiredAt ? ` · fired ${timeAgo(a.lastFiredAt)}` : ''}
                </span>
                <button onClick={() => startEdit(a)} className="shrink-0 text-[11px] text-ink-faint hover:text-ink">
                  edit
                </button>
                <button onClick={() => void removeAlert(a.id)} className="shrink-0 text-[11px] text-ink-faint hover:text-down">
                  ✕
                </button>
              </li>
            ))}
          </ul>

          <h2 className="mb-2 mt-5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">Fired</h2>
          {alertEvents.length === 0 && <p className="text-[11px] text-ink-faint">Nothing has fired yet.</p>}
          <ul className="space-y-1">
            {alertEvents.map((e) => (
              <li
                key={e.id}
                className={`flex items-center gap-2 rounded px-2 py-1.5 ${
                  e.acknowledged ? 'text-ink-faint' : 'bg-panel-2 text-ink'
                }`}
              >
                <span className="w-32 shrink-0 text-[10px] text-ink-faint">{new Date(e.firedAt * 1000).toLocaleString()}</span>
                <span className="min-w-0 flex-1 truncate text-[11px]">{e.message}</span>
                <span className="tnum shrink-0 text-[11px]">{formatPrice(e.price)}</span>
                {!e.acknowledged && (
                  <button onClick={() => void acknowledgeEvent(e.id)} className="shrink-0 text-[11px] text-ink-faint hover:text-ink">
                    mark read
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const inputClass =
  'w-full rounded border border-edge bg-panel-2 px-2 py-1 text-xs outline-none focus:border-accent';

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="mb-2 block" title={hint}>
      <span className="mb-1 block text-[10px] uppercase tracking-wide text-ink-faint">{label}</span>
      {children}
    </label>
  );
}

function newDraft(symbol: string, price?: number): Partial<Alert> {
  return {
    symbol,
    interval: '1d',
    condition: { type: 'price_cross', direction: 'any', value: price ? Number(price.toFixed(2)) : undefined },
    repeat: 'once',
    cooldownSec: 300,
    expiresAt: null,
    enabled: true,
    sound: true,
    note: '',
  };
}

function needsValue(type: AlertTriggerType): boolean {
  return ['price_above', 'price_below', 'price_cross', 'percent_change', 'volume_spike'].includes(type);
}

function valueLabel(type: AlertTriggerType): string {
  if (type === 'percent_change') return 'Percent (negative = down)';
  if (type === 'volume_spike') return 'Multiple of average volume';
  return 'Price level';
}

/** Round-trip the indicator dropdown's value, which encodes preset vs. raw. */
function presetKeyFor(c: AlertCondition): string {
  const preset = PRESETS.find(
    (p) => p.indicatorId === c.indicatorId && p.params.length === c.indicatorParams?.length,
  );
  return preset ? `preset:${preset.id}` : `ind:${c.indicatorId ?? 'ma'}`;
}

function applyIndicatorChoice(value: string, patch: (p: Partial<AlertCondition>) => void): void {
  const [kind, id] = value.split(':');
  if (kind === 'preset') {
    const preset = PRESETS.find((p) => p.id === id);
    if (preset) patch({ indicatorId: preset.indicatorId, indicatorParams: preset.params, plotKey: plotKeysFor(preset.indicatorId)[0] });
    return;
  }
  patch({ indicatorId: id, indicatorParams: {}, plotKey: plotKeysFor(id)[0] });
}

function plotKeysFor(indicatorId: string | undefined): string[] {
  const def = INDICATORS.find((i) => i.id === (indicatorId ?? 'ma'));
  return def ? def.plots.map((p) => p.key) : ['ma'];
}

/** One-line description of an alert, matching the engine's own phrasing. */
function summarize(a: Alert): string {
  const c = a.condition;
  const t = TRIGGERS.find((x) => x.type === c.type)?.label ?? c.type;
  switch (c.type) {
    case 'price_above':
    case 'price_below':
    case 'price_cross':
      return `${t} ${formatPrice(c.value ?? 0)} · ${a.interval}`;
    case 'indicator_cross': {
      const len = c.indicatorParams?.length;
      const line = c.indicatorId === 'ma' && len ? `${len} DMA` : `${c.indicatorId} ${c.plotKey ?? ''}`.trim();
      const dir = c.direction === 'above' ? 'up through' : c.direction === 'below' ? 'down through' : 'through';
      return `Price ${dir} ${line} · ${a.interval}`;
    }
    case 'percent_change':
      return `${c.value}% over ${c.lookback ?? 5} bars · ${a.interval}`;
    case 'volume_spike':
      return `Volume ≥ ${c.value ?? 2}× ${c.lookback ?? 20}-bar average · ${a.interval}`;
    default:
      return `${t} · ${a.interval}`;
  }
}

function timeAgo(unixSeconds: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
