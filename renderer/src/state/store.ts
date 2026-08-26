/**
 * Application state.
 *
 * Chart data and indicator attachments live here; the chart component reads
 * from the store and imperatively drives lightweight-charts, which owns its
 * own rendering and must not be re-created on every React render.
 */

import { create } from 'zustand';
import { api } from '../api';
import type {
  ActiveTool, Alert, AlertEvent, AppSettings, AttachedIndicator, Candle, ChartLayout, ChartPaneState,
  Drawing, DrawingProps, EarningsEvent, Fundamentals, Interval, ScriptRenderDescriptor, SeriesType,
  SymbolMeta, UserScript, Watchlist, WatchlistItem, Quote,
} from '@shared/types';
import { runScript as runScriptSandboxed } from '../scripting/runner';
import { DEFAULT_SETTINGS } from '@shared/types';
import type { DataStatus } from '@shared/ipc';
import { defaultParams, getIndicator, type IndicatorPreset } from '@shared/indicators/registry';
import { bestIntervalFor, rangeSupported, type RangePreset } from '../chart/data';
import { MARKET_REGIONS, SPARK_BARS, type MarketTile } from '../panels/MarketBar';

let instanceCounter = 0;
const nextInstanceId = () => `i${Date.now().toString(36)}${(instanceCounter++).toString(36)}`;

interface AppState {
  // --- settings ---
  settings: AppSettings;
  loadSettings: () => Promise<void>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;

  // --- chart ---
  symbol: string;
  interval: Interval;
  seriesType: SeriesType;
  priceScale: 'normal' | 'logarithmic' | 'percentage';
  candles: Candle[];
  meta: SymbolMeta | null;
  quote: Quote | null;
  loading: boolean;
  error: string | null;
  status: DataStatus | null;

  /** Visible window preset. Not the fetch window — we always cache full history. */
  range: RangePreset;

  setSymbol: (symbol: string) => Promise<void>;
  setInterval: (interval: Interval) => Promise<void>;
  setSeriesType: (t: SeriesType) => void;
  setPriceScale: (s: AppState['priceScale']) => void;
  setRange: (r: RangePreset) => Promise<void>;
  reloadCandles: (force?: boolean) => Promise<void>;
  setStatus: (s: DataStatus) => void;

  // --- indicators ---
  indicators: AttachedIndicator[];
  addIndicator: (indicatorId: string, params?: Record<string, any>, colors?: Record<string, string>) => void;
  addPreset: (preset: IndicatorPreset) => void;
  removeIndicator: (instanceId: string) => void;
  updateIndicatorParams: (instanceId: string, params: Record<string, any>) => void;
  toggleIndicator: (instanceId: string) => void;

  // --- user scripts attached to the chart ---
  attachedScripts: { scriptId: number; name: string; inputs: Record<string, any>; visible: boolean }[];
  /** Latest successful render descriptor per attached script. */
  scriptResults: Record<number, ScriptRenderDescriptor>;
  /** Error text per attached script, surfaced in the indicator panel. */
  scriptErrors: Record<number, string>;
  attachScript: (scriptId: number, inputs: Record<string, any>) => Promise<void>;
  detachScript: (scriptId: number) => void;
  toggleScript: (scriptId: number) => void;
  runAttachedScripts: () => Promise<void>;

  // --- benchmark for relative strength ---
  benchmarkCandles: Candle[];
  loadBenchmark: () => Promise<void>;

  // --- symbol fundamentals ---
  fundamentals: Fundamentals | null;
  fundamentalsLoading: boolean;
  loadFundamentals: (symbol: string) => Promise<void>;

  // --- past earnings reports, flagged on the chart ---
  earnings: EarningsEvent[];
  loadEarnings: (symbol: string) => Promise<void>;

  // --- market summary strip ---
  marketRegion: string;
  marketTiles: MarketTile[];
  marketLoading: boolean;
  setMarketRegion: (id: string) => void;
  loadMarketBar: () => Promise<void>;
  refreshMarketQuotes: () => Promise<void>;

  // --- watchlists ---
  watchlists: Watchlist[];
  activeWatchlistId: number | null;
  watchlistItems: WatchlistItem[];
  watchlistQuotes: Record<string, Quote>;
  loadWatchlists: () => Promise<void>;
  selectWatchlist: (id: number) => Promise<void>;
  createWatchlist: (name: string) => Promise<void>;
  renameWatchlist: (id: number, name: string) => Promise<void>;
  deleteWatchlist: (id: number) => Promise<void>;
  addToWatchlist: (symbol: string) => Promise<void>;
  removeFromWatchlist: (id: number) => Promise<void>;
  refreshWatchlistQuotes: () => Promise<void>;

  // --- alerts ---
  alerts: Alert[];
  alertEvents: AlertEvent[];
  loadAlerts: () => Promise<void>;
  saveAlert: (alert: Partial<Alert> & { symbol: string; condition: Alert['condition'] }) => Promise<void>;
  removeAlert: (id: number) => Promise<void>;
  toggleAlert: (id: number) => Promise<void>;
  acknowledgeEvent: (id: number) => Promise<void>;
  /** Called from the main-process push when an alert fires. */
  receiveAlertEvent: (event: AlertEvent) => void;

  // --- drawings ---
  activeTool: ActiveTool;
  drawings: Drawing[];
  selectedDrawingId: number | null;
  /** Style applied to the next drawing placed. */
  drawColor: string;
  drawWidth: number;
  /** Snap new points to the nearest bar rather than anywhere between. */
  magnet: boolean;
  setActiveTool: (tool: ActiveTool) => void;
  setDrawStyle: (patch: { color?: string; width?: number }) => void;
  toggleMagnet: () => void;
  selectDrawing: (id: number | null) => void;
  loadDrawings: (symbol: string) => Promise<void>;
  addDrawing: (drawing: Omit<Drawing, 'id' | 'createdAt' | 'symbol'>) => Promise<Drawing | null>;
  updateDrawing: (id: number, patch: Partial<Drawing>, persist?: boolean) => void;
  patchDrawingProps: (id: number, props: Partial<DrawingProps>) => void;
  deleteDrawing: (id: number) => Promise<void>;
  clearDrawings: () => Promise<void>;

  // --- saved layouts ---
  layouts: ChartLayout[];
  loadLayouts: () => Promise<void>;
  saveLayout: (name: string, isDefault: boolean) => Promise<void>;
  applyLayout: (id: number) => Promise<void>;
  removeLayout: (id: number) => Promise<void>;
}

export const useStore = create<AppState>((set, get) => ({
  // -------------------------------------------------------------------------
  settings: DEFAULT_SETTINGS,

  async loadSettings() {
    const settings = await api.getSettings();
    set({ settings, interval: settings.defaultInterval, seriesType: settings.defaultSeriesType });
  },

  async updateSettings(patch) {
    const settings = await api.setSettings(patch);
    set({ settings });
    // Adjusted-close and currency changes alter every price on screen.
    if ('useAdjustedClose' in patch) await get().reloadCandles();
  },

  // -------------------------------------------------------------------------
  symbol: 'AAPL',
  interval: '1d',
  seriesType: 'candlestick',
  priceScale: 'normal',
  range: '1Y',
  candles: [],
  meta: null,
  quote: null,
  loading: false,
  error: null,
  status: null,

  async setSymbol(symbol) {
    const clean = symbol.trim().toUpperCase();
    if (!clean || clean === get().symbol) return;
    // Persisted indicators are per-symbol, so swap them with the symbol.
    set({ symbol: clean, candles: [], meta: null, quote: null, error: null });
    void api.recordSearch(clean);
    set({ fundamentals: null, earnings: [] });
    await Promise.all([
      get().reloadCandles(),
      loadIndicatorsFor(clean, set),
      get().loadDrawings(clean),
      get().loadFundamentals(clean),
      get().loadEarnings(clean),
    ]);
  },

  async setInterval(interval) {
    if (interval === get().interval) return;
    set({ interval, candles: [] });
    await get().reloadCandles();
  },

  setSeriesType: (seriesType) => set({ seriesType }),
  setPriceScale: (priceScale) => set({ priceScale }),
  setStatus: (status) => set({ status }),

  async setRange(range) {
    // A short range on a daily chart is unreadable, and a multi-year range
    // cannot be served by 1-minute bars — switch interval when the current one
    // cannot express the requested window.
    const { interval } = get();
    set({ range });
    if (!rangeSupported(range, interval)) {
      await get().setInterval(bestIntervalFor(range));
    }
  },

  async reloadCandles(force = false) {
    const { symbol, interval } = get();
    if (!symbol) return;
    set({ loading: true, error: null });
    try {
      const candles = await api.getCandles(symbol, interval, { force });
      set({ candles, loading: false });

      // Metadata and quote are supporting detail; never let them fail the chart.
      void api.getSymbolMeta(symbol).then((meta) => {
        if (get().symbol === symbol) set({ meta: meta as SymbolMeta | null });
      }).catch(() => {});
      void api.getQuote(symbol).then((quote) => {
        if (get().symbol === symbol) set({ quote: quote as Quote | null });
      }).catch(() => {});
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e), candles: [] });
    }
  },

  // -------------------------------------------------------------------------
  indicators: [],

  addIndicator(indicatorId, params, colors) {
    const def = getIndicator(indicatorId);
    if (!def) return;
    const inst: AttachedIndicator = {
      instanceId: nextInstanceId(),
      indicatorId,
      params: { ...defaultParams(def), ...(params ?? {}) },
      colors,
      visible: true,
    };
    const indicators = [...get().indicators, inst];
    set({ indicators });
    void persistIndicators(get().symbol, indicators);
  },

  addPreset(preset) {
    get().addIndicator(preset.indicatorId, preset.params, preset.colors);
  },

  removeIndicator(instanceId) {
    const indicators = get().indicators.filter((i) => i.instanceId !== instanceId);
    set({ indicators });
    void persistIndicators(get().symbol, indicators);
  },

  updateIndicatorParams(instanceId, params) {
    const indicators = get().indicators.map((i) =>
      i.instanceId === instanceId ? { ...i, params: { ...i.params, ...params } } : i,
    );
    set({ indicators });
    void persistIndicators(get().symbol, indicators);
  },

  toggleIndicator(instanceId) {
    const indicators = get().indicators.map((i) =>
      i.instanceId === instanceId ? { ...i, visible: !i.visible } : i,
    );
    set({ indicators });
    void persistIndicators(get().symbol, indicators);
  },

  // -------------------------------------------------------------------------
  attachedScripts: [],
  scriptResults: {},
  scriptErrors: {},

  async attachScript(scriptId, inputs) {
    if (get().attachedScripts.some((s) => s.scriptId === scriptId)) return;
    const script = (await api.getScript(scriptId)) as UserScript | null;
    if (!script) return;
    set({ attachedScripts: [...get().attachedScripts, { scriptId, name: script.name, inputs, visible: true }] });
    await get().runAttachedScripts();
  },

  detachScript(scriptId) {
    const { scriptResults, scriptErrors } = get();
    const results = { ...scriptResults };
    const errors = { ...scriptErrors };
    delete results[scriptId];
    delete errors[scriptId];
    set({
      attachedScripts: get().attachedScripts.filter((s) => s.scriptId !== scriptId),
      scriptResults: results,
      scriptErrors: errors,
    });
  },

  toggleScript(scriptId) {
    set({
      attachedScripts: get().attachedScripts.map((s) =>
        s.scriptId === scriptId ? { ...s, visible: !s.visible } : s,
      ),
    });
  },

  /**
   * Re-run every attached script against the current bars.
   *
   * Sequential rather than parallel: they share one sandbox worker, and a
   * handful of scripts over a few thousand bars is milliseconds of work.
   */
  async runAttachedScripts() {
    const { attachedScripts, candles } = get();
    if (attachedScripts.length === 0 || candles.length === 0) return;

    const results: Record<number, ScriptRenderDescriptor> = {};
    const errors: Record<number, string> = {};

    for (const attached of attachedScripts) {
      if (!attached.visible) continue;
      const script = (await api.getScript(attached.scriptId)) as UserScript | null;
      if (!script) continue;
      const res = await runScriptSandboxed(script.source, candles, attached.inputs);
      if (res.ok) results[attached.scriptId] = res.descriptor;
      else errors[attached.scriptId] = res.error.message;
    }

    set({ scriptResults: results, scriptErrors: errors });
  },

  // -------------------------------------------------------------------------
  benchmarkCandles: [],

  async loadBenchmark() {
    const { settings } = get();
    try {
      const candles = await api.getCandles(settings.benchmarkSymbol, '1d', {});
      set({ benchmarkCandles: candles });
    } catch {
      set({ benchmarkCandles: [] });
    }
  },

  // -------------------------------------------------------------------------
  marketRegion: 'us',
  marketTiles: [],
  marketLoading: false,

  setMarketRegion(id) {
    // Clear immediately so the strip does not show the previous region's
    // numbers under the new region's name while the fetch is in flight.
    set({ marketRegion: id, marketTiles: [] });
  },

  /**
   * Load the strip: one batched quote request, then a sparkline per symbol.
   *
   * Sparklines go through the normal cache-first candle path, so this is mostly
   * free after the first call and degrades to "no sparkline" rather than an
   * error when a symbol has no intraday history.
   */
  async loadMarketBar() {
    const region = MARKET_REGIONS.find((r) => r.id === get().marketRegion) ?? MARKET_REGIONS[0];
    const symbols = region.symbols.map((s) => s.symbol);
    set({ marketLoading: true });

    let quotes: Quote[] = [];
    try {
      quotes = (await api.getQuotes(symbols)) as Quote[];
    } catch {
      quotes = [];
    }
    const byQuote = new Map(quotes.map((q) => [q.symbol, q]));

    const tiles: MarketTile[] = [];
    for (const entry of region.symbols) {
      // Abandon the whole load if the user switched region mid-flight.
      if (get().marketRegion !== region.id) return;

      let spark: number[] = [];
      try {
        const candles = (await api.getCandles(entry.symbol, '15m', {})) as Candle[];
        spark = candles.slice(-SPARK_BARS).map((c) => c.close);
      } catch {
        spark = [];
      }
      const q = byQuote.get(entry.symbol);
      tiles.push({
        symbol: entry.symbol,
        label: entry.label,
        price: q?.price,
        change: q?.change,
        changePercent: q?.changePercent,
        previousClose: q?.previousClose,
        spark,
      });
      // Publish incrementally so the strip fills in rather than appearing at
      // once after every symbol has been fetched.
      set({ marketTiles: [...tiles] });
    }

    set({ marketLoading: false });
  },

  /** Prices only — one request, no candles. */
  async refreshMarketQuotes() {
    const tiles = get().marketTiles;
    if (tiles.length === 0) return;
    try {
      const quotes = (await api.getQuotes(tiles.map((t) => t.symbol))) as Quote[];
      const byQuote = new Map(quotes.map((q) => [q.symbol, q]));
      set({
        marketTiles: get().marketTiles.map((t) => {
          const q = byQuote.get(t.symbol);
          return q
            ? { ...t, price: q.price, change: q.change, changePercent: q.changePercent, previousClose: q.previousClose }
            : t;
        }),
      });
    } catch {
      // Keep the previous values rather than blanking the strip.
    }
  },

  // -------------------------------------------------------------------------
  fundamentals: null,
  fundamentalsLoading: false,

  async loadFundamentals(symbol) {
    set({ fundamentalsLoading: true });
    try {
      const fundamentals = (await api.getFundamentals(symbol)) as Fundamentals;
      // The symbol may have changed while this was in flight; a stale panel
      // beside a fresh chart is worse than an empty one.
      if (get().symbol !== symbol) return;
      set({ fundamentals, fundamentalsLoading: false });
    } catch {
      if (get().symbol !== symbol) return;
      set({ fundamentals: null, fundamentalsLoading: false });
    }
  },

  // -------------------------------------------------------------------------
  earnings: [],

  /**
   * Fetch the symbol's past earnings dates.
   *
   * Failure is silent and leaves the list empty: the `E` markers are an
   * annotation on the chart, and losing them must never be allowed to look
   * like a broken chart.
   */
  async loadEarnings(symbol) {
    try {
      const earnings = (await api.getEarnings(symbol)) as EarningsEvent[];
      // The user may have moved on while this was in flight; one symbol's
      // report dates drawn over another's bars would be actively misleading.
      if (get().symbol !== symbol) return;
      set({ earnings: earnings ?? [] });
    } catch {
      if (get().symbol !== symbol) return;
      set({ earnings: [] });
    }
  },

  // -------------------------------------------------------------------------
  watchlists: [],
  activeWatchlistId: null,
  watchlistItems: [],
  watchlistQuotes: {},

  async loadWatchlists() {
    const watchlists = (await api.listWatchlists()) as Watchlist[];
    set({ watchlists });

    // Keep the current selection if it still exists, otherwise fall back to the
    // one saved from last session, and only then to the first list.
    const current = get().activeWatchlistId;
    if (current != null && watchlists.some((w) => w.id === current)) return;

    const remembered = get().settings.activeWatchlistId;
    const target = watchlists.find((w) => w.id === remembered) ?? watchlists[0];
    if (target) await get().selectWatchlist(target.id);
  },

  async selectWatchlist(id) {
    const watchlistItems = (await api.listWatchlistItems(id)) as WatchlistItem[];
    set({
      activeWatchlistId: id,
      watchlistItems,
      // Mirror locally so a reload during this session sees the same choice.
      settings: { ...get().settings, activeWatchlistId: id },
    });
    // Remembered for next launch. Written directly rather than through
    // updateSettings, which would also trigger a candle reload.
    void api.setSettings({ activeWatchlistId: id }).catch(() => {});
    void get().refreshWatchlistQuotes();
  },

  async createWatchlist(name) {
    const created = (await api.createWatchlist(name)) as Watchlist;
    set({ watchlists: [...get().watchlists, created] });
    await get().selectWatchlist(created.id);
  },

  async renameWatchlist(id, name) {
    const clean = name.trim();
    if (!clean) return;
    await api.renameWatchlist(id, clean);
    set({ watchlists: get().watchlists.map((w) => (w.id === id ? { ...w, name: clean } : w)) });
  },

  /**
   * Delete a list and land somewhere sensible.
   *
   * Clearing the selection first matters: `listWatchlists` recreates a default
   * list when the table empties, and `loadWatchlists` only picks a new one when
   * the current selection is gone.
   */
  async deleteWatchlist(id) {
    await api.deleteWatchlist(id);
    const remaining = get().watchlists.filter((w) => w.id !== id);
    set({ watchlists: remaining, activeWatchlistId: null, watchlistItems: [], watchlistQuotes: {} });
    await get().loadWatchlists();
  },

  async addToWatchlist(symbol) {
    // Recover rather than no-op if the selection was somehow lost — silently
    // dropping the symbol is the worst possible outcome here.
    let id = get().activeWatchlistId;
    if (id == null) {
      await get().loadWatchlists();
      id = get().activeWatchlistId;
    }
    if (id == null) return;
    await api.addWatchlistItem(id, symbol);
    await get().selectWatchlist(id);
  },

  async removeFromWatchlist(itemId) {
    await api.removeWatchlistItem(itemId);
    const id = get().activeWatchlistId;
    if (id != null) await get().selectWatchlist(id);
  },

  async refreshWatchlistQuotes() {
    const symbols = get().watchlistItems.map((i) => i.symbol);
    if (symbols.length === 0) return set({ watchlistQuotes: {} });
    const quotes = (await api.getQuotes(symbols)) as Quote[];
    set({ watchlistQuotes: Object.fromEntries(quotes.map((q) => [q.symbol, q])) });
  },

  // -------------------------------------------------------------------------
  alerts: [],
  alertEvents: [],

  async loadAlerts() {
    const [alerts, alertEvents] = await Promise.all([
      api.listAlerts() as Promise<Alert[]>,
      api.listAlertEvents(100) as Promise<AlertEvent[]>,
    ]);
    set({ alerts, alertEvents });
  },

  async saveAlert(alert) {
    await api.saveAlert(alert);
    await get().loadAlerts();
  },

  async removeAlert(id) {
    await api.deleteAlert(id);
    await get().loadAlerts();
  },

  async toggleAlert(id) {
    const alert = get().alerts.find((a) => a.id === id);
    if (!alert) return;
    await api.saveAlert({ ...alert, enabled: !alert.enabled });
    await get().loadAlerts();
  },

  async acknowledgeEvent(id) {
    await api.ackAlertEvent(id);
    set({ alertEvents: get().alertEvents.map((e) => (e.id === id ? { ...e, acknowledged: true } : e)) });
  },

  receiveAlertEvent(event) {
    // Prepend rather than refetch: the push already carries the whole event, and
    // the engine may fire while the panel is closed.
    set({ alertEvents: [event, ...get().alertEvents.filter((e) => e.id !== event.id)].slice(0, 100) });
    void get().loadAlerts();
  },

  // -------------------------------------------------------------------------
  activeTool: 'cursor',
  drawings: [],
  selectedDrawingId: null,
  drawColor: '#2962ff',
  drawWidth: 1,
  magnet: true,

  setActiveTool(activeTool) {
    // Leaving a drawing tool drops the selection, so the style bar always
    // reflects what the next click will produce.
    set({ activeTool, selectedDrawingId: activeTool === 'cursor' ? get().selectedDrawingId : null });
  },

  setDrawStyle({ color, width }) {
    if (color != null) set({ drawColor: color });
    if (width != null) set({ drawWidth: width });

    // With something selected, the style bar restyles it rather than only
    // setting the default for the next drawing.
    const id = get().selectedDrawingId;
    if (id != null) {
      get().updateDrawing(id, {
        ...(color != null ? { color } : {}),
        ...(width != null ? { lineWidth: width } : {}),
      });
    }
  },

  toggleMagnet: () => set({ magnet: !get().magnet }),
  selectDrawing: (selectedDrawingId) => set({ selectedDrawingId }),

  async loadDrawings(symbol) {
    try {
      const drawings = (await api.getDrawings(symbol)) as Drawing[];
      set({ drawings: drawings ?? [], selectedDrawingId: null });
    } catch {
      set({ drawings: [], selectedDrawingId: null });
    }
  },

  async addDrawing(input) {
    const symbol = get().symbol;
    try {
      const saved = (await api.saveDrawing({ ...input, symbol })) as Drawing;
      set({ drawings: [...get().drawings, saved] });
      return saved;
    } catch {
      return null;
    }
  },

  /**
   * Update a drawing locally, and optionally persist.
   *
   * Dragging calls this on every mouse move with `persist: false` so the canvas
   * keeps up without a database write per frame; the write happens once on
   * mouse-up.
   */
  updateDrawing(id, patch, persist = true) {
    const drawings = get().drawings.map((d) => (d.id === id ? { ...d, ...patch } : d));
    set({ drawings });
    if (persist) {
      const updated = drawings.find((d) => d.id === id);
      if (updated) void api.saveDrawing(updated).catch(() => {});
    }
  },

  patchDrawingProps(id, props) {
    const current = get().drawings.find((d) => d.id === id);
    if (!current) return;
    get().updateDrawing(id, { props: { ...current.props, ...props } });
  },

  async deleteDrawing(id) {
    await api.deleteDrawing(id).catch(() => {});
    set({
      drawings: get().drawings.filter((d) => d.id !== id),
      selectedDrawingId: get().selectedDrawingId === id ? null : get().selectedDrawingId,
    });
  },

  async clearDrawings() {
    const ids = get().drawings.map((d) => d.id);
    set({ drawings: [], selectedDrawingId: null });
    await Promise.all(ids.map((id) => api.deleteDrawing(id).catch(() => {})));
  },

  // -------------------------------------------------------------------------
  layouts: [],

  async loadLayouts() {
    set({ layouts: (await api.listLayouts()) as ChartLayout[] });
  },

  async saveLayout(name, isDefault) {
    await api.saveLayout({ name, grid: 1, panes: [currentPaneState(get())], isDefault });
    await get().loadLayouts();
  },

  /**
   * Restore a saved layout into the live chart.
   *
   * Only the first pane is applied: the store models a single chart today, and
   * a saved 4-grid should degrade to its primary chart rather than be refused.
   */
  async applyLayout(id) {
    const layout = get().layouts.find((l) => l.id === id);
    const pane = layout?.panes?.[0];
    if (!pane) return;

    set({
      seriesType: pane.seriesType ?? get().seriesType,
      priceScale: pane.priceScale ?? get().priceScale,
      indicators: pane.indicators ?? [],
      attachedScripts: [],
      scriptResults: {},
      scriptErrors: {},
    });

    // Symbol and interval drive the fetch, so set them before reloading.
    const symbolChanged = pane.symbol && pane.symbol !== get().symbol;
    if (symbolChanged) set({ earnings: [] });
    set({ symbol: pane.symbol || get().symbol, interval: pane.interval || get().interval });
    await get().reloadCandles();
    void get().loadEarnings(get().symbol);

    // The layout's indicators are now this symbol's saved set.
    void persistIndicators(get().symbol, pane.indicators ?? []);
    if (symbolChanged) void api.recordSearch(get().symbol);

    for (const s of pane.scripts ?? []) {
      await get().attachScript(s.scriptId, s.inputs ?? {});
    }
  },

  async removeLayout(id) {
    await api.deleteLayout(id);
    await get().loadLayouts();
  },
}));

/** Snapshot the live chart in the shape `chart_layouts` persists. */
function currentPaneState(s: AppState): ChartPaneState {
  return {
    symbol: s.symbol,
    interval: s.interval,
    seriesType: s.seriesType,
    priceScale: s.priceScale,
    indicators: s.indicators,
    scripts: s.attachedScripts.map((a) => ({ scriptId: a.scriptId, inputs: a.inputs, visible: a.visible })),
    compareSymbols: [],
  };
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

async function persistIndicators(symbol: string, indicators: AttachedIndicator[]): Promise<void> {
  try {
    await api.saveChartIndicators(symbol, indicators);
  } catch {
    // A failed save should never break the chart the user is looking at.
  }
}

async function loadIndicatorsFor(symbol: string, set: (partial: Partial<AppState>) => void): Promise<void> {
  try {
    const saved = (await api.getChartIndicators(symbol)) as AttachedIndicator[];
    set({ indicators: saved ?? [] });
  } catch {
    set({ indicators: [] });
  }
}

/** Restore a symbol's saved indicators on first load. */
export async function hydrateIndicators(symbol: string): Promise<void> {
  await loadIndicatorsFor(symbol, (partial) => useStore.setState(partial));
}

/**
 * Restore the default layout at boot, if one is saved.
 *
 * Returns whether a layout was applied, so the caller can fall back to the
 * per-symbol indicator restore when there is nothing saved.
 */
export async function hydrateDefaultLayout(): Promise<boolean> {
  try {
    await useStore.getState().loadLayouts();
    const preferred = useStore.getState().layouts.find((l) => l.isDefault);
    if (!preferred) return false;
    await useStore.getState().applyLayout(preferred.id);
    return true;
  } catch {
    // A bad saved layout must never stop the app from opening.
    return false;
  }
}
