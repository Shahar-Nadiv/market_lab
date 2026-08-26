/**
 * The indicator library.
 *
 * Three columns: sources on the left, the filtered list in the middle, and a
 * live preview on the right. The preview is the reason this exists rather than
 * a plain dropdown — it renders the highlighted entry against the bars you are
 * currently looking at, so you can see what a Vortex or an Ichimoku actually
 * does to *your* chart before committing to it.
 *
 * Highlighting follows the pointer and the keyboard, and is separate from
 * selection: hovering previews, clicking adds.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../state/store';
import { ALL_INDICATORS, PRESETS, defaultParams } from '@shared/indicators/registry';
import type { IndicatorDef, IndicatorKind, UserScript } from '@shared/types';
import IndicatorPreview from './IndicatorPreview';

type NavId = 'technicals' | 'presets' | 'scripts' | `cat:${string}`;

const TABS: { id: IndicatorKind; label: string }[] = [
  { id: 'indicator', label: 'Indicators' },
  { id: 'strategy', label: 'Strategies' },
  { id: 'pattern', label: 'Patterns' },
];

export default function IndicatorLibrary({ onClose }: { onClose: () => void }) {
  const { candles, benchmarkCandles, symbol, addIndicator, addPreset, attachScript } = useStore();

  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<IndicatorKind>('indicator');
  const [nav, setNav] = useState<NavId>('technicals');
  const [scripts, setScripts] = useState<UserScript[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [added, setAdded] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
    void (api.listScripts() as Promise<UserScript[]>).then(setScripts).catch(() => setScripts([]));
  }, []);

  /** Categories present in the current tab, so the nav never offers an empty one. */
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const d of ALL_INDICATORS) if ((d.kind ?? 'indicator') === tab && d.category) set.add(d.category);
    return [...set].sort();
  }, [tab]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();

    if (nav === 'scripts') {
      return scripts
        .filter((s) => !q || s.name.toLowerCase().includes(q))
        .map((s) => ({ kind: 'script' as const, id: `script:${s.id}`, label: s.name, script: s }));
    }

    if (nav === 'presets') {
      return PRESETS
        .filter((p) => !q || p.label.toLowerCase().includes(q))
        .map((p) => ({ kind: 'preset' as const, id: `preset:${p.id}`, label: p.label, preset: p }));
    }

    const wanted = nav.startsWith('cat:') ? nav.slice(4) : null;
    return ALL_INDICATORS
      .filter((d) => (d.kind ?? 'indicator') === tab)
      .filter((d) => !wanted || d.category === wanted)
      .filter((d) => {
        if (!q) return true;
        const hay = [d.label, d.description ?? '', d.category ?? '', ...(d.tags ?? [])].join(' ').toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((d) => ({ kind: 'def' as const, id: d.id, label: d.label, def: d }));
  }, [query, tab, nav, scripts]);

  // Any change to the filters invalidates the highlighted row.
  useEffect(() => setHighlight(0), [query, tab, nav]);

  const current = results[Math.min(highlight, results.length - 1)];
  const previewDef: IndicatorDef | null =
    current?.kind === 'def' ? current.def
      : current?.kind === 'preset' ? ALL_INDICATORS.find((d) => d.id === current.preset.indicatorId) ?? null
        : null;

  function add(item: NonNullable<typeof current>) {
    if (item.kind === 'def') addIndicator(item.def.id);
    else if (item.kind === 'preset') addPreset(item.preset);
    else void attachScript(item.script.id, {});
    setAdded(item.id);
    window.setTimeout(() => setAdded(null), 1200);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && current) {
      e.preventDefault();
      add(current);
    } else if (e.key === 'Escape') {
      onClose();
    }
  }

  // Keep the highlighted row in view when navigating by keyboard.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="flex h-full max-h-[760px] w-full max-w-[1080px] flex-col overflow-hidden rounded-lg border border-edge bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <header className="flex items-center justify-between border-b border-edge px-5 py-3.5">
          <h2 className="text-[15px] font-medium text-ink">Indicators, metrics, and strategies</h2>
          <button onClick={onClose} title="Close (Esc)" className="rounded p-1 text-ink-faint hover:bg-panel-2 hover:text-ink">
            <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
          </button>
        </header>

        <div className="border-b border-edge px-5 py-3">
          <div className="relative">
            <svg viewBox="0 0 20 20" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
              fill="none" stroke="currentColor" strokeWidth="1.6">
              <circle cx="9" cy="9" r="5.5" /><path d="M13.5 13.5L17 17" />
            </svg>
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              className="w-full rounded border border-edge bg-panel-2 py-2 pl-9 pr-3 text-[13px] outline-none focus:border-accent"
            />
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* --- sources ---------------------------------------------------- */}
          <nav className="w-52 shrink-0 overflow-y-auto border-r border-edge py-3">
            <NavGroup title="Personal" />
            <NavItem
              active={nav === 'scripts'} onClick={() => setNav('scripts')}
              icon="M10 10a3 3 0 100-6 3 3 0 000 6zM4 17a6 6 0 0112 0"
              label="My scripts" badge={scripts.length || undefined}
            />

            <NavGroup title="Built-in" />
            <NavItem
              active={nav === 'technicals'} onClick={() => setNav('technicals')}
              icon="M3 15l4-5 3 3 3-6 4 8" label="Technicals"
            />
            <NavItem
              active={nav === 'presets'} onClick={() => setNav('presets')}
              icon="M4 6h12M4 10h12M4 14h8" label="Presets" badge={PRESETS.length}
            />

            {categories.length > 0 && <NavGroup title="Categories" />}
            {categories.map((c) => (
              <NavItem
                key={c} active={nav === `cat:${c}`} onClick={() => setNav(`cat:${c}` as NavId)}
                icon="M4 5h12v10H4z" label={c}
              />
            ))}
          </nav>

          {/* --- list ------------------------------------------------------- */}
          <section className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-1.5 border-b border-edge px-4 py-2.5">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => {
                    setTab(t.id);
                    if (nav.startsWith('cat:')) setNav('technicals');
                  }}
                  className={`rounded-full px-3 py-1 text-[12px] ${
                    tab === t.id && nav !== 'scripts' && nav !== 'presets'
                      ? 'bg-panel-2 font-medium text-ink ring-1 ring-edge'
                      : 'text-ink-dim hover:text-ink'
                  }`}
                >
                  {t.label}
                </button>
              ))}
              <span className="ml-auto text-[10px] uppercase tracking-wide text-ink-faint">
                {results.length} {results.length === 1 ? 'result' : 'results'}
              </span>
            </div>

            <div className="border-b border-edge px-4 py-1.5 text-[10px] uppercase tracking-wide text-ink-faint">
              Script name
            </div>

            <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
              {results.length === 0 && (
                <li className="px-4 py-8 text-center text-[12px] text-ink-faint">
                  Nothing matches “{query}”.
                </li>
              )}
              {results.map((item, i) => (
                <li key={item.id}>
                  <button
                    data-active={i === highlight}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => add(item)}
                    className={`flex w-full items-center gap-2 px-4 py-[7px] text-left text-[13px] ${
                      i === highlight ? 'bg-panel-2 text-ink' : 'text-ink-dim hover:text-ink'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.kind === 'def' && item.def.kind === 'strategy' && <Badge tone="accent">STRATEGY</Badge>}
                    {item.kind === 'def' && item.def.kind === 'pattern' && <Badge tone="muted">PATTERN</Badge>}
                    {item.kind === 'script' && <Badge tone="muted">SCRIPT</Badge>}
                    {added === item.id && <Badge tone="up">ADDED</Badge>}
                  </button>
                </li>
              ))}
            </ul>
          </section>

          {/* --- preview ---------------------------------------------------- */}
          <aside className="flex w-[336px] shrink-0 flex-col overflow-y-auto border-l border-edge p-4">
            {!current && <p className="text-[12px] text-ink-faint">Highlight an entry to preview it.</p>}

            {current && (
              <>
                <div className="mb-1 flex items-start justify-between gap-2">
                  <h3 className="text-[14px] font-medium text-ink">{current.label}</h3>
                  {previewDef?.category && (
                    <span className="shrink-0 rounded bg-panel-2 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-ink-faint">
                      {previewDef.category}
                    </span>
                  )}
                </div>

                <p className="mb-3 text-[11px] leading-relaxed text-ink-dim">
                  {current.kind === 'script'
                    ? 'Your own script. Preview runs on the chart once attached.'
                    : previewDef?.description ?? ''}
                </p>

                {previewDef ? (
                  <>
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-wide text-ink-faint">
                        Preview · {symbol}
                      </span>
                      <span className="text-[10px] text-ink-faint">
                        {previewDef.panel === 'overlay' ? 'On price' : 'Separate pane'}
                      </span>
                    </div>
                    <IndicatorPreview def={previewDef} candles={candles} benchmark={benchmarkCandles} />

                    {previewDef.params.length > 0 && (
                      <dl className="mt-3 space-y-1">
                        {previewDef.params.map((p) => (
                          <div key={p.key} className="flex justify-between text-[11px]">
                            <dt className="text-ink-faint">{p.label}</dt>
                            <dd className="tnum text-ink-dim">{String(defaultParams(previewDef)[p.key])}</dd>
                          </div>
                        ))}
                      </dl>
                    )}
                  </>
                ) : (
                  <div className="flex h-[150px] items-center justify-center rounded border border-edge bg-panel-2 text-[11px] text-ink-faint">
                    No preview for this entry
                  </div>
                )}

                <button
                  onClick={() => add(current)}
                  className="mt-4 w-full rounded bg-accent py-2 text-[12px] font-medium text-white hover:opacity-90"
                >
                  Add to chart
                </button>
                <p className="mt-2 text-center text-[10px] text-ink-faint">
                  ↑↓ to browse · ↵ to add · Esc to close
                </p>
              </>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

function NavGroup({ title }: { title: string }) {
  return (
    <div className="px-4 pb-1 pt-3 text-[10px] uppercase tracking-wide text-ink-faint">{title}</div>
  );
}

function NavItem({
  active, onClick, icon, label, badge,
}: {
  active: boolean; onClick: () => void; icon: string; label: string; badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-4 py-1.5 text-left text-[12px] ${
        active ? 'bg-panel-2 text-accent' : 'text-ink-dim hover:bg-panel-2 hover:text-ink'
      }`}
    >
      <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round">
        <path d={icon} />
      </svg>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge != null && <span className="shrink-0 text-[10px] tnum text-ink-faint">{badge}</span>}
    </button>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone: 'accent' | 'muted' | 'up' }) {
  const cls = tone === 'accent'
    ? 'bg-accent/15 text-accent'
    : tone === 'up' ? 'bg-up/15 text-up' : 'bg-panel text-ink-faint';
  return (
    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide ${cls}`}>
      {children}
    </span>
  );
}
