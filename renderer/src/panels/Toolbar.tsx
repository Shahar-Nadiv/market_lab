/**
 * Chart toolbar: symbol, timeframe, series type, scale and range.
 *
 * Intervals that cannot serve the requested range are disabled rather than
 * silently returning a short series — Yahoo caps intraday history hard, and a
 * truncated chart that looks complete is worse than a greyed-out button.
 */

import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../state/store';
import { INTERVALS, type Interval, type SeriesType } from '@shared/types';
import { formatPrice, RANGE_PRESETS, rangeSupported } from '../chart/data';
import MarketStatus from './MarketStatus';

const SERIES_TYPES: { id: SeriesType; label: string; glyph: string }[] = [
  { id: 'candlestick', label: 'Candles', glyph: '▮' },
  { id: 'bar', label: 'Bars', glyph: '┼' },
  { id: 'line', label: 'Line', glyph: '╱' },
  { id: 'area', label: 'Area', glyph: '◺' },
  { id: 'baseline', label: 'Baseline', glyph: '≂' },
  { id: 'heikinashi', label: 'Heikin-Ashi', glyph: '▤' },
];

const INTERVAL_LABEL: Record<Interval, string> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '1d': 'D', '1wk': 'W', '1mo': 'M',
};

export default function Toolbar({ onSearch, onOpenAlerts }: { onSearch: () => void; onOpenAlerts: () => void }) {
  const {
    symbol, interval, seriesType, priceScale, quote, meta, status, loading, range,
    setInterval, setSeriesType, setPriceScale, setRange, reloadCandles, settings, updateSettings,
    alertEvents,
  } = useStore();

  const pct = quote?.changePercent ?? null;
  const up = (pct ?? 0) >= 0;
  const unread = alertEvents.filter((e) => !e.acknowledged).length;

  return (
    <div className="flex items-center gap-2 border-b border-edge bg-panel px-2 py-1.5">
      <button
        onClick={onSearch}
        className="flex items-center gap-2 rounded border border-edge bg-panel-2 px-2.5 py-1 hover:border-accent"
        title="Search symbol (/)"
      >
        <span className="text-xs font-semibold">{symbol}</span>
        <span className="text-[10px] text-ink-faint">▾</span>
      </button>

      {quote && (
        <div className="flex items-baseline gap-1.5">
          <span className="tnum text-xs font-medium">{formatPrice(quote.price)}</span>
          <span className={`tnum text-[11px] ${up ? 'text-up' : 'text-down'}`}>
            {up ? '+' : ''}{formatPrice(quote.change)} ({up ? '+' : ''}{(pct ?? 0).toFixed(2)}%)
          </span>
          {meta?.displayCurrency && <span className="text-[10px] text-ink-faint">{meta.displayCurrency}</span>}
        </div>
      )}

      <MarketStatus />

      <Divider />

      <div className="flex items-center gap-0.5">
        {INTERVALS.map((iv) => (
          <button
            key={iv}
            onClick={() => void setInterval(iv)}
            className={`rounded px-1.5 py-1 text-[11px] ${
              iv === interval ? 'bg-accent text-white' : 'text-ink-dim hover:bg-panel-2 hover:text-ink'
            }`}
          >
            {INTERVAL_LABEL[iv]}
          </button>
        ))}
      </div>

      <Divider />

      <select
        value={seriesType}
        onChange={(e) => setSeriesType(e.target.value as SeriesType)}
        className="rounded border border-edge bg-panel-2 px-1.5 py-1 text-[11px] outline-none focus:border-accent"
        title="Series type"
      >
        {SERIES_TYPES.map((t) => (
          <option key={t.id} value={t.id}>{t.glyph}  {t.label}</option>
        ))}
      </select>

      <select
        value={priceScale}
        onChange={(e) => setPriceScale(e.target.value as any)}
        className="rounded border border-edge bg-panel-2 px-1.5 py-1 text-[11px] outline-none focus:border-accent"
        title="Price scale"
      >
        <option value="normal">Linear</option>
        <option value="logarithmic">Log</option>
        <option value="percentage">%</option>
      </select>

      <Divider />

      <div className="flex items-center gap-0.5">
        {RANGE_PRESETS.map((r) => (
          <button
            key={r}
            onClick={() => void setRange(r)}
            className={`rounded px-1.5 py-1 text-[11px] ${
              r === range ? 'bg-panel-2 text-ink ring-1 ring-accent/50' : 'text-ink-dim hover:bg-panel-2 hover:text-ink'
            }`}
            title={rangeSupported(r, interval) ? `Show ${r}` : `${r} needs a coarser interval — switches automatically`}
          >
            {r}
          </button>
        ))}
      </div>

      <button
        onClick={() => void updateSettings({ useAdjustedClose: !settings.useAdjustedClose })}
        title="Split/dividend-adjusted prices. Off means raw prices, which makes long moving averages wrong across a split."
        className={`rounded border px-2 py-1 text-[11px] ${
          settings.useAdjustedClose ? 'border-accent/50 bg-accent/10 text-accent' : 'border-edge text-ink-faint hover:text-ink'
        }`}
      >
        ADJ
      </button>

      <Divider />

      <LayoutMenu />

      <button
        onClick={onOpenAlerts}
        title="Alerts"
        className="relative rounded border border-edge px-2 py-1 text-[11px] text-ink-dim hover:border-accent hover:text-ink"
      >
        Alerts
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 rounded-full bg-accent px-1 text-[9px] leading-4 text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      <div className="ml-auto flex items-center gap-2">
        {status?.message && (
          <span className="max-w-80 truncate text-[10px] text-down" title={status.message}>
            {status.message}
          </span>
        )}
        {status && !status.message && (
          <span className="text-[10px] text-ink-faint">
            {status.source === 'cache' ? 'cached' : status.source}
          </span>
        )}
        <button
          onClick={() => void reloadCandles(true)}
          disabled={loading}
          title="Refresh data"
          className="rounded border border-edge px-2 py-1 text-[11px] text-ink-dim hover:border-accent hover:text-ink disabled:opacity-40"
        >
          {loading ? '…' : '↻'}
        </button>
        <button
          onClick={() => void updateSettings({ theme: settings.theme === 'dark' ? 'light' : 'dark' })}
          title="Toggle theme"
          className="rounded border border-edge px-2 py-1 text-[11px] text-ink-dim hover:border-accent hover:text-ink"
        >
          {settings.theme === 'dark' ? '☾' : '☀'}
        </button>
      </div>
    </div>
  );
}

function Divider() {
  return <span className="h-4 w-px bg-edge" />;
}

/**
 * Saved layouts: capture the whole workspace under a name and bring it back.
 *
 * "Default" marks the one restored at startup — which is the point of saving a
 * layout at all when you open the app to the same setup every morning.
 */
function LayoutMenu() {
  const { layouts, loadLayouts, saveLayout, applyLayout, removeLayout } = useStore();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadLayouts();
  }, [loadLayouts]);

  // Clicking anywhere else closes the menu, the way a native one behaves.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  async function save(asDefault: boolean) {
    const trimmed = name.trim();
    if (!trimmed) return;
    await saveLayout(trimmed, asDefault);
    setName('');
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Saved layouts"
        className="rounded border border-edge px-2 py-1 text-[11px] text-ink-dim hover:border-accent hover:text-ink"
      >
        Layouts ▾
      </button>

      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-64 rounded border border-edge bg-panel p-2 shadow-lg">
          <div className="flex gap-1">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void save(false)}
              placeholder="Save current as…"
              className="min-w-0 flex-1 rounded border border-edge bg-panel-2 px-2 py-1 text-[11px] outline-none focus:border-accent"
            />
            <button
              onClick={() => void save(false)}
              disabled={!name.trim()}
              className="rounded bg-accent px-2 py-1 text-[11px] text-white hover:opacity-90 disabled:opacity-40"
            >
              Save
            </button>
          </div>
          <button
            onClick={() => void save(true)}
            disabled={!name.trim()}
            className="mt-1 w-full rounded border border-edge px-2 py-1 text-[10px] text-ink-faint hover:text-ink disabled:opacity-40"
          >
            Save as startup default
          </button>

          {layouts.length > 0 && <div className="my-2 h-px bg-edge" />}

          <ul className="max-h-64 space-y-0.5 overflow-auto">
            {layouts.map((l) => (
              <li key={l.id} className="flex items-center gap-1">
                <button
                  onClick={() => {
                    void applyLayout(l.id);
                    setOpen(false);
                  }}
                  className="min-w-0 flex-1 truncate rounded px-1.5 py-1 text-left text-[11px] text-ink-dim hover:bg-panel-2 hover:text-ink"
                >
                  {l.name}
                  {l.isDefault && <span className="ml-1 text-[9px] text-accent">default</span>}
                </button>
                <button
                  onClick={() => void removeLayout(l.id)}
                  title="Delete layout"
                  className="shrink-0 px-1 text-[11px] text-ink-faint hover:text-down"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>

          <div className="mt-2 border-t border-edge pt-2">
            <button
              onClick={() => void api.exportBackup()}
              className="w-full rounded px-1.5 py-1 text-left text-[11px] text-ink-dim hover:bg-panel-2 hover:text-ink"
            >
              Export backup…
            </button>
            <button
              onClick={() => void api.importBackup().then(() => window.location.reload())}
              title="Replaces watchlists, scripts, layouts and alerts with a backup's"
              className="w-full rounded px-1.5 py-1 text-left text-[11px] text-ink-dim hover:bg-panel-2 hover:text-ink"
            >
              Import backup…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
