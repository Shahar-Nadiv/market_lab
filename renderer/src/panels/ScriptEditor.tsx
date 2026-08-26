/**
 * Script editor: write an indicator, run it against the current chart's bars,
 * see the result immediately, and save it.
 *
 * A deliberately plain code editor (textarea + line gutter) rather than a full
 * IDE — it keeps the bundle small and works identically offline. The API
 * reference sits alongside, which is what actually makes the feature usable.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../state/store';
import { runScript } from '../scripting/runner';
import { EXAMPLE_SCRIPTS } from '../scripting/examples';
import type { ScriptRunResult, UserScript } from '@shared/types';

const API_REFERENCE: { group: string; items: [string, string][] }[] = [
  {
    group: 'Declare',
    items: [
      ['indicator(title, { overlay })', 'Name the script and choose its pane'],
      ['input.int(def, label)', 'Integer input, editable after attaching'],
      ['input.float(def, label)', 'Decimal input'],
      ['input.bool(def, label)', 'Checkbox input'],
      ['input.source(def, label)', 'Price source selector'],
    ],
  },
  {
    group: 'Series',
    items: [
      ['open high low close', 'Price arrays, one value per bar'],
      ['volume time bar_index', 'Volume, timestamps, bar numbers'],
      ['hl2 hlc3 ohlc4', 'Synthetic averages'],
    ],
  },
  {
    group: 'Maths',
    items: [
      ['sma(src, len)', 'Simple moving average'],
      ['ema(src, len)  wma  rma  vwma', 'Other averages'],
      ['rsi(src, len)', 'Relative strength index'],
      ['macd(src, f, s, sig)', 'Returns { macd, signal, histogram }'],
      ['bbands(src, len, mult)', 'Returns { upper, basis, lower }'],
      ['atr(len)  adx(len)  stoch(k, ks, d)', 'Volatility and trend'],
      ['highest(src, len)  lowest(src, len)', 'Rolling extremes'],
      ['stdev(src, len)  change(src, n)', 'Dispersion and differences'],
      ['crossover(a, b)  crossunder(a, b)', 'Crossing tests'],
      ['add sub mul div map', 'Element-wise arithmetic on series'],
    ],
  },
  {
    group: 'Draw',
    items: [
      ['plot(series, { color, title })', 'Draw a line or histogram'],
      ['plotshape(cond, { shape, location })', 'Mark bars where a condition holds'],
      ['hline(value, { color })', 'Horizontal reference level'],
      ['alertcondition(cond, title)', 'Expose a trigger to the alerts panel'],
    ],
  },
];

export default function ScriptEditor({ onClose }: { onClose: () => void }) {
  const candles = useStore((s) => s.candles);
  const symbol = useStore((s) => s.symbol);
  const attachScript = useStore((s) => s.attachScript);

  const [scripts, setScripts] = useState<UserScript[]>([]);
  const [current, setCurrent] = useState<UserScript | null>(null);
  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  const [result, setResult] = useState<ScriptRunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showRef, setShowRef] = useState(true);
  const textRef = useRef<HTMLTextAreaElement>(null);

  async function refreshList() {
    const list = (await api.listScripts()) as UserScript[];
    setScripts(list);
    return list;
  }

  // Seed the examples once, so the editor is never an empty box.
  useEffect(() => {
    void (async () => {
      let list = await refreshList();
      if (list.length === 0) {
        for (const ex of EXAMPLE_SCRIPTS) {
          await api.saveScript({ name: ex.name, source: ex.source, overlay: ex.overlay });
        }
        list = await refreshList();
      }
      if (list[0]) load(list[0]);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function load(s: UserScript) {
    setCurrent(s);
    setName(s.name);
    setSource(s.source);
    setResult(null);
    setDirty(false);
  }

  // Re-run on a debounce while editing, so the preview tracks the code.
  useEffect(() => {
    if (!source || candles.length === 0) return;
    const t = setTimeout(() => void run(), 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, candles]);

  async function run() {
    if (candles.length === 0) return;
    setRunning(true);
    try {
      setResult(await runScript(source, candles, {}));
    } finally {
      setRunning(false);
    }
  }

  async function save() {
    const saved = (await api.saveScript({
      id: current?.id,
      name,
      source,
      overlay: result?.ok ? result.descriptor.overlay : true,
    })) as { id: number; version: number };
    const list = await refreshList();
    const fresh = list.find((s) => s.id === saved.id);
    if (fresh) load(fresh);
  }

  async function remove(id: number) {
    await api.deleteScript(id);
    const list = await refreshList();
    if (current?.id === id) {
      if (list[0]) load(list[0]);
      else {
        setCurrent(null);
        setName('');
        setSource('');
      }
    }
  }

  function newScript() {
    setCurrent(null);
    setName('New indicator');
    setSource(`indicator("New indicator", { overlay: true })\n\nconst len = input.int(50, "Length")\nplot(sma(close, len), { color: "#2962ff", title: "MA" })\n`);
    setDirty(true);
  }

  /** Tab should indent, not move focus out of the editor. */
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Tab') {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: a, selectionEnd: b } = el;
      const next = source.slice(0, a) + '  ' + source.slice(b);
      setSource(next);
      setDirty(true);
      requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
    } else if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void save();
    }
  }

  const lineCount = useMemo(() => source.split('\n').length, [source]);
  const errorLine = result && !result.ok ? result.error.line : undefined;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-ground">
      <header className="flex items-center gap-2 border-b border-edge bg-panel px-3 py-2">
        <span className="text-xs font-semibold">Scripts</span>
        <input
          value={name}
          onChange={(e) => { setName(e.target.value); setDirty(true); }}
          className="w-64 rounded border border-edge bg-panel-2 px-2 py-1 text-xs outline-none focus:border-accent"
          placeholder="Script name"
        />
        <button onClick={() => void save()} className="rounded bg-accent px-2.5 py-1 text-xs text-white hover:opacity-90">
          Save{dirty ? ' •' : ''}
        </button>
        <button onClick={newScript} className="rounded border border-edge px-2.5 py-1 text-xs text-ink-dim hover:border-accent hover:text-ink">
          New
        </button>
        <button
          onClick={() => {
            if (result?.ok && current) {
              attachScript(current.id, {});
              onClose();
            }
          }}
          disabled={!result?.ok || !current}
          title={current ? 'Add this script to the chart' : 'Save the script first'}
          className="rounded border border-accent/60 bg-accent/10 px-2.5 py-1 text-xs text-accent hover:bg-accent/20 disabled:opacity-40"
        >
          Add to chart
        </button>

        <span className="ml-auto text-[11px] text-ink-faint">
          Running against <span className="text-ink-dim">{symbol}</span> · {candles.length} bars
        </span>
        <button onClick={() => setShowRef((v) => !v)} className="rounded border border-edge px-2 py-1 text-[11px] text-ink-dim hover:text-ink">
          {showRef ? 'Hide reference' : 'Reference'}
        </button>
        <button onClick={onClose} className="rounded border border-edge px-2 py-1 text-[11px] text-ink-dim hover:border-down hover:text-down">
          Close
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Saved scripts */}
        <aside className="w-52 shrink-0 overflow-auto border-r border-edge bg-panel">
          <ul className="py-1">
            {scripts.map((s) => (
              <li key={s.id} className="group flex items-center">
                <button
                  onClick={() => load(s)}
                  className={`min-w-0 flex-1 truncate px-3 py-1.5 text-left text-[11px] ${
                    current?.id === s.id ? 'bg-panel-2 text-ink' : 'text-ink-dim hover:bg-panel-2'
                  }`}
                >
                  {s.name}
                  <span className="ml-1 text-ink-faint">v{s.version}</span>
                </button>
                <button
                  onClick={() => void remove(s.id)}
                  className="px-2 text-[11px] text-transparent group-hover:text-ink-faint hover:!text-down"
                  title="Delete"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </aside>

        {/* Code */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative flex min-h-0 flex-1">
            <div className="select-none overflow-hidden border-r border-edge bg-panel px-2 py-2 text-right font-mono text-[11px] leading-[1.5] text-ink-faint">
              {Array.from({ length: lineCount }, (_, i) => (
                <div key={i} className={i + 1 === errorLine ? 'text-down' : undefined}>{i + 1}</div>
              ))}
            </div>
            <textarea
              ref={textRef}
              value={source}
              onChange={(e) => { setSource(e.target.value); setDirty(true); }}
              onKeyDown={onKeyDown}
              spellCheck={false}
              className="flex-1 resize-none bg-ground p-2 font-mono text-[11px] leading-[1.5] text-ink outline-none"
              style={{ tabSize: 2 }}
            />
          </div>

          {/* Result */}
          <div className="h-40 shrink-0 overflow-auto border-t border-edge bg-panel p-2 text-[11px]">
            {running && <div className="text-ink-faint">Running…</div>}

            {!running && result?.ok && (
              <div>
                <div className="mb-1 flex items-center gap-2">
                  <span className="text-up">✓ {result.descriptor.title}</span>
                  <span className="text-ink-faint">
                    {result.descriptor.overlay ? 'overlay' : 'separate pane'} · {result.durationMs}ms
                  </span>
                </div>
                <Row label="Plots" values={result.descriptor.plots.map((p) => `${p.title} (${lastOf(p.data)})`)} />
                <Row label="Inputs" values={result.descriptor.inputs.map((i) => `${i.label}=${i.default}`)} />
                <Row label="Alerts" values={result.descriptor.alertConditions.map((a) => a.title)} />
                <Row label="Shapes" values={result.descriptor.shapes.map((s) => `${s.title} (${s.data.filter(Boolean).length} bars)`)} />
              </div>
            )}

            {!running && result && !result.ok && (
              <div className="text-down">
                <div className="font-medium">
                  {result.error.kind === 'security' ? 'Blocked' : result.error.kind === 'timeout' ? 'Timed out' : 'Error'}
                  {result.error.line != null && ` on line ${result.error.line}`}
                </div>
                <div className="mt-0.5">{result.error.message}</div>
              </div>
            )}

            {!running && !result && <div className="text-ink-faint">Edit the code to run it.</div>}
          </div>
        </div>

        {/* API reference */}
        {showRef && (
          <aside className="w-80 shrink-0 overflow-auto border-l border-edge bg-panel p-3">
            <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">API</h3>
            {API_REFERENCE.map((g) => (
              <div key={g.group} className="mb-3">
                <div className="mb-1 text-[10px] uppercase tracking-wide text-ink-faint">{g.group}</div>
                <ul className="space-y-1">
                  {g.items.map(([sig, desc]) => (
                    <li key={sig}>
                      <code className="block font-mono text-[10px] text-accent">{sig}</code>
                      <span className="text-[10px] text-ink-faint">{desc}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <p className="mt-4 border-t border-edge pt-2 text-[10px] text-ink-faint">
              Scripts run in a sandbox with no network or filesystem access, and are stopped if they run too long.
            </p>
          </aside>
        )}
      </div>
    </div>
  );
}

function Row({ label, values }: { label: string; values: string[] }) {
  if (values.length === 0) return null;
  return (
    <div className="flex gap-2">
      <span className="w-12 shrink-0 text-ink-faint">{label}</span>
      <span className="text-ink-dim">{values.join(', ')}</span>
    </div>
  );
}

function lastOf(data: (number | null)[]): string {
  for (let i = data.length - 1; i >= 0; i--) {
    const v = data[i];
    if (v != null) return v.toFixed(2);
  }
  return '—';
}
