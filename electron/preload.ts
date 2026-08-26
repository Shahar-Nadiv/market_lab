/**
 * The only bridge between renderer and main.
 *
 * Everything the UI can do to the filesystem, the database or the network is
 * enumerated here. The renderer gets no `require`, no Node globals and no
 * ability to invoke arbitrary channels.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc';
import type { DataStatus } from '../shared/ipc';
import type {
  AlertEvent,
  AppSettings,
  Candle,
  EarningsEvent,
  Interval,
} from '../shared/types';

const api = {
  // --- Market data -------------------------------------------------------
  getCandles: (symbol: string, interval: Interval, opts?: { force?: boolean }): Promise<Candle[]> =>
    ipcRenderer.invoke(IPC.GET_CANDLES, symbol, interval, opts ?? {}),
  getQuote: (symbol: string) => ipcRenderer.invoke(IPC.GET_QUOTE, symbol),
  getQuotes: (symbols: string[]) => ipcRenderer.invoke(IPC.GET_QUOTES, symbols),
  getFundamentals: (symbol: string) => ipcRenderer.invoke(IPC.GET_FUNDAMENTALS, symbol),
  getEarnings: (symbol: string, opts?: { force?: boolean }): Promise<EarningsEvent[]> =>
    ipcRenderer.invoke(IPC.GET_EARNINGS, symbol, opts ?? {}),
  searchSymbols: (query: string) => ipcRenderer.invoke(IPC.SEARCH_SYMBOLS, query),
  getSymbolMeta: (symbol: string) => ipcRenderer.invoke(IPC.GET_SYMBOL_META, symbol),

  // --- Settings ----------------------------------------------------------
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.GET_SETTINGS),
  setSettings: (patch: Partial<AppSettings>): Promise<AppSettings> =>
    ipcRenderer.invoke(IPC.SET_SETTINGS, patch),

  // --- Watchlists --------------------------------------------------------
  listWatchlists: () => ipcRenderer.invoke(IPC.LIST_WATCHLISTS),
  createWatchlist: (name: string) => ipcRenderer.invoke(IPC.CREATE_WATCHLIST, name),
  renameWatchlist: (id: number, name: string) => ipcRenderer.invoke(IPC.RENAME_WATCHLIST, id, name),
  deleteWatchlist: (id: number) => ipcRenderer.invoke(IPC.DELETE_WATCHLIST, id),
  listWatchlistItems: (watchlistId: number) => ipcRenderer.invoke(IPC.LIST_WATCHLIST_ITEMS, watchlistId),
  addWatchlistItem: (watchlistId: number, symbol: string) =>
    ipcRenderer.invoke(IPC.ADD_WATCHLIST_ITEM, watchlistId, symbol),
  removeWatchlistItem: (id: number) => ipcRenderer.invoke(IPC.REMOVE_WATCHLIST_ITEM, id),

  // --- Search history ----------------------------------------------------
  recordSearch: (symbol: string) => ipcRenderer.invoke(IPC.RECORD_SEARCH, symbol),
  recentSymbols: (limit?: number) => ipcRenderer.invoke(IPC.RECENT_SYMBOLS, limit ?? 20),

  // --- Scripts -----------------------------------------------------------
  listScripts: () => ipcRenderer.invoke(IPC.LIST_SCRIPTS),
  getScript: (id: number) => ipcRenderer.invoke(IPC.GET_SCRIPT, id),
  saveScript: (script: { id?: number; name: string; source: string; overlay: boolean }) =>
    ipcRenderer.invoke(IPC.SAVE_SCRIPT, script),
  deleteScript: (id: number) => ipcRenderer.invoke(IPC.DELETE_SCRIPT, id),
  listScriptVersions: (id: number) => ipcRenderer.invoke(IPC.LIST_SCRIPT_VERSIONS, id),
  /** Compile and execute a script in the main-process sandbox. */
  runScript: (source: string, candles: Candle[], inputs: Record<string, unknown>) =>
    ipcRenderer.invoke(IPC.RUN_SCRIPT, source, candles, inputs),

  // --- Chart state -------------------------------------------------------
  getChartIndicators: (symbol: string) => ipcRenderer.invoke(IPC.GET_CHART_INDICATORS, symbol),
  saveChartIndicators: (symbol: string, indicators: unknown[]) =>
    ipcRenderer.invoke(IPC.SAVE_CHART_INDICATORS, symbol, indicators),
  listLayouts: () => ipcRenderer.invoke(IPC.LIST_LAYOUTS),
  saveLayout: (layout: unknown) => ipcRenderer.invoke(IPC.SAVE_LAYOUT, layout),
  deleteLayout: (id: number) => ipcRenderer.invoke(IPC.DELETE_LAYOUT, id),

  // --- Drawings ----------------------------------------------------------
  getDrawings: (symbol: string) => ipcRenderer.invoke(IPC.GET_DRAWINGS, symbol),
  saveDrawing: (drawing: unknown) => ipcRenderer.invoke(IPC.SAVE_DRAWING, drawing),
  deleteDrawing: (id: number) => ipcRenderer.invoke(IPC.DELETE_DRAWING, id),

  // --- Alerts ------------------------------------------------------------
  listAlerts: () => ipcRenderer.invoke(IPC.LIST_ALERTS),
  saveAlert: (alert: unknown) => ipcRenderer.invoke(IPC.SAVE_ALERT, alert),
  deleteAlert: (id: number) => ipcRenderer.invoke(IPC.DELETE_ALERT, id),
  listAlertEvents: (limit?: number) => ipcRenderer.invoke(IPC.LIST_ALERT_EVENTS, limit ?? 100),
  ackAlertEvent: (id: number) => ipcRenderer.invoke(IPC.ACK_ALERT_EVENT, id),

  // --- Backup ------------------------------------------------------------
  exportBackup: () => ipcRenderer.invoke(IPC.EXPORT_BACKUP),
  importBackup: () => ipcRenderer.invoke(IPC.IMPORT_BACKUP),

  // --- Push subscriptions ------------------------------------------------
  /**
   * Returns an unsubscribe function so React effects can clean up properly.
   * The cleanup must return void — `removeListener` returns the emitter, which
   * React would reject as an effect destructor.
   */
  onAlertFired: (cb: (event: AlertEvent) => void): (() => void) => {
    const listener = (_e: unknown, payload: AlertEvent) => cb(payload);
    ipcRenderer.on(IPC.ON_ALERT_FIRED, listener);
    return () => {
      ipcRenderer.removeListener(IPC.ON_ALERT_FIRED, listener);
    };
  },
  onDataStatus: (cb: (status: DataStatus) => void): (() => void) => {
    const listener = (_e: unknown, payload: DataStatus) => cb(payload);
    ipcRenderer.on(IPC.ON_DATA_STATUS, listener);
    return () => {
      ipcRenderer.removeListener(IPC.ON_DATA_STATUS, listener);
    };
  },
};

export type MarketLabApi = typeof api;

contextBridge.exposeInMainWorld('marketlab', api);
