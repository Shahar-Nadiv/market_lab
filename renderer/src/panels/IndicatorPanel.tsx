/**
 * Indicator management: one-click DMA presets, the full catalogue, and
 * per-instance parameter editing for whatever is currently on the chart.
 */

import { useState } from 'react';
import { useStore } from '../state/store';
import { PRESETS, getIndicator } from '@shared/indicators/registry';
import type { ParamSpec } from '@shared/types';
import SymbolInfo from './SymbolInfo';

export default function IndicatorPanel({ onOpenScripts, onOpenLibrary }: { onOpenScripts: () => void; onOpenLibrary: () => void }) {
  const {
    indicators, addPreset, removeIndicator, toggleIndicator, updateIndicatorParams,
    attachedScripts, scriptResults, scriptErrors, detachScript, toggleScript,
    interval,
  } = useStore();

  // A moving average is N *bars*, not N days. On any non-daily chart a preset
  // named "200 DMA" is therefore not a 200-day average at all — on 15m bars it
  // spans about a week and reads far higher in an uptrend. Cheap to say, and
  // the alternative is silently wrong numbers.
  const dailyPreset = interval !== '1d' && indicators.some((i) => {
    const def = getIndicator(i.indicatorId);
    return def?.category === 'Moving Averages' && (i.params.length >= 20 || i.params.slow >= 20);
  });
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div className="flex h-full flex-col">
      <Section title="Presets">
        {interval !== '1d' && (
          <p className="mb-1.5 rounded border border-yellow-500/30 bg-yellow-500/10 px-1.5 py-1 text-[10px] leading-snug text-yellow-500/90">
            You are on <span className="tnum font-medium">{interval}</span> bars. These presets average that many
            <em> bars</em>, so “200 DMA” here is 200 × {interval}, not 200 days. Switch to <span className="tnum">D</span> for
            true daily averages.
          </p>
        )}
        <div className="flex flex-wrap gap-1">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => addPreset(p)}
              title={interval === '1d'
                ? `Add ${p.label}`
                : `Add ${p.label} — on ${interval} bars this averages ${p.params.length ?? p.params.slow} × ${interval}, not days`}
              className="rounded border border-edge bg-panel-2 px-2 py-1 text-[11px] hover:border-accent hover:text-ink"
            >
              {p.label}
            </button>
          ))}
        </div>
      </Section>

      <Section
        title="On this chart"
        action={
          <button
            onClick={onOpenLibrary}
            title="Open the indicator library"
            className="rounded border border-edge px-1.5 py-0.5 text-[10px] text-ink-dim hover:border-accent hover:text-ink"
          >
            + Add
          </button>
        }
      >
        {dailyPreset && (
          <p className="mb-1.5 text-[10px] leading-snug text-yellow-500/90">
            Averages below are over {interval} bars, not days.
          </p>
        )}

        {indicators.length === 0 && (
          <p className="text-[11px] text-ink-faint">
            Nothing attached. Use a preset above, or <span className="text-ink-dim">+ Add</span> to browse the library.
          </p>
        )}

        <ul className="space-y-1">
          {indicators.map((inst) => {
            const def = getIndicator(inst.indicatorId);
            if (!def) return null;
            const isEditing = editing === inst.instanceId;
            return (
              <li key={inst.instanceId} className="rounded border border-edge bg-panel-2">
                <div className="flex items-center gap-1.5 px-2 py-1">
                  <button
                    onClick={() => toggleIndicator(inst.instanceId)}
                    title={inst.visible ? 'Hide' : 'Show'}
                    className={`text-[11px] ${inst.visible ? 'text-up' : 'text-ink-faint'}`}
                  >
                    {inst.visible ? '◉' : '○'}
                  </button>
                  <span className="flex-1 truncate text-[11px]">
                    {def.label}
                    <span className="ml-1 text-ink-faint tnum">{summarize(inst.params)}</span>
                  </span>
                  {def.params.length > 0 && (
                    <button
                      onClick={() => setEditing(isEditing ? null : inst.instanceId)}
                      className="rounded px-1 text-[10px] text-ink-faint hover:text-ink"
                      title="Settings"
                    >
                      ⚙
                    </button>
                  )}
                  <button
                    onClick={() => removeIndicator(inst.instanceId)}
                    className="rounded px-1 text-[11px] text-ink-faint hover:text-down"
                    title="Remove"
                  >
                    ×
                  </button>
                </div>

                {isEditing && (
                  <div className="space-y-1.5 border-t border-edge px-2 py-2">
                    {def.params.map((spec) => (
                      <ParamField
                        key={spec.key}
                        spec={spec}
                        value={inst.params[spec.key]}
                        onChange={(v) => updateIndicatorParams(inst.instanceId, { [spec.key]: v })}
                      />
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Section>

      <Section
        title="Scripts"
        action={
          <button
            onClick={onOpenScripts}
            className="rounded border border-edge px-1.5 py-0.5 text-[10px] text-ink-dim hover:border-accent hover:text-ink"
          >
            Editor
          </button>
        }
      >
        {attachedScripts.length === 0 && (
          <p className="text-[11px] text-ink-faint">
            No scripts on this chart. Open the editor to write one or attach a saved script.
          </p>
        )}
        <ul className="space-y-1">
          {attachedScripts.map((s) => {
            const err = scriptErrors[s.scriptId];
            const desc = scriptResults[s.scriptId];
            return (
              <li key={s.scriptId} className="rounded border border-edge bg-panel-2 px-2 py-1">
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => toggleScript(s.scriptId)}
                    className={`text-[11px] ${s.visible ? 'text-up' : 'text-ink-faint'}`}
                  >
                    {s.visible ? '◉' : '○'}
                  </button>
                  <span className="flex-1 truncate text-[11px]">{desc?.title ?? s.name}</span>
                  <button
                    onClick={() => detachScript(s.scriptId)}
                    className="px-1 text-[11px] text-ink-faint hover:text-down"
                    title="Remove"
                  >
                    ×
                  </button>
                </div>
                {err && <div className="mt-0.5 text-[10px] text-down">{err}</div>}
              </li>
            );
          })}
        </ul>
      </Section>

      <SymbolInfo />
    </div>
  );
}

/** Compact parameter summary shown next to the indicator name. */
function summarize(params: Record<string, any>): string {
  const bits: string[] = [];
  if (params.fast != null && params.slow != null) bits.push(`${params.fast}/${params.slow}`);
  else if (params.length != null) bits.push(String(params.length));
  if (params.maType && params.maType !== 'SMA') bits.push(params.maType);
  if (params.source && params.source !== 'close') bits.push(params.source);
  return bits.join(' ');
}

function ParamField({ spec, value, onChange }: { spec: ParamSpec; value: any; onChange: (v: any) => void }) {
  if (spec.type === 'bool') {
    return (
      <label className="flex items-center justify-between text-[11px]">
        <span className="text-ink-dim">{spec.label}</span>
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
      </label>
    );
  }

  if (spec.options) {
    return (
      <label className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-ink-dim">{spec.label}</span>
        <select
          value={String(value ?? spec.default)}
          onChange={(e) => onChange(e.target.value)}
          className="w-28 rounded border border-edge bg-panel px-1.5 py-0.5 text-[11px] outline-none focus:border-accent"
        >
          {spec.options.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <label className="flex items-center justify-between gap-2 text-[11px]">
      <span className="text-ink-dim">{spec.label}</span>
      <input
        type="number"
        value={Number(value ?? spec.default)}
        min={spec.min}
        max={spec.max}
        step={spec.type === 'float' ? 0.1 : 1}
        onChange={(e) => {
          const n = spec.type === 'float' ? parseFloat(e.target.value) : parseInt(e.target.value, 10);
          // Ignore intermediate empty/NaN states while the user is typing.
          if (Number.isFinite(n)) onChange(n);
        }}
        className="w-28 rounded border border-edge bg-panel px-1.5 py-0.5 text-right text-[11px] tnum outline-none focus:border-accent"
      />
    </label>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="border-b border-edge p-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}
