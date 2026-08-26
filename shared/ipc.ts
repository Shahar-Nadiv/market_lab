/**
 * The IPC contract between renderer and main.
 *
 * Both sides import these names, so a typo becomes a compile error rather than
 * a silently dead channel.
 */

export const IPC = {
  // Market data
  GET_CANDLES: 'market:getCandles',
  GET_QUOTE: 'market:getQuote',
  GET_QUOTES: 'market:getQuotes',
  GET_FUNDAMENTALS: 'market:getFundamentals',
  GET_EARNINGS: 'market:getEarnings',
  SEARCH_SYMBOLS: 'market:search',
  GET_SYMBOL_META: 'market:getSymbolMeta',

  // Settings
  GET_SETTINGS: 'settings:get',
  SET_SETTINGS: 'settings:set',

  // Watchlists
  LIST_WATCHLISTS: 'watchlist:list',
  CREATE_WATCHLIST: 'watchlist:create',
  RENAME_WATCHLIST: 'watchlist:rename',
  DELETE_WATCHLIST: 'watchlist:delete',
  LIST_WATCHLIST_ITEMS: 'watchlist:items',
  ADD_WATCHLIST_ITEM: 'watchlist:addItem',
  REMOVE_WATCHLIST_ITEM: 'watchlist:removeItem',

  // Search history
  RECORD_SEARCH: 'history:record',
  RECENT_SYMBOLS: 'history:recent',

  // Scripts
  LIST_SCRIPTS: 'script:list',
  GET_SCRIPT: 'script:get',
  SAVE_SCRIPT: 'script:save',
  DELETE_SCRIPT: 'script:delete',
  LIST_SCRIPT_VERSIONS: 'script:versions',
  RUN_SCRIPT: 'script:run',

  // Chart state
  GET_CHART_INDICATORS: 'chart:getIndicators',
  SAVE_CHART_INDICATORS: 'chart:saveIndicators',
  LIST_LAYOUTS: 'chart:listLayouts',
  SAVE_LAYOUT: 'chart:saveLayout',
  DELETE_LAYOUT: 'chart:deleteLayout',

  // Drawings
  GET_DRAWINGS: 'drawing:list',
  SAVE_DRAWING: 'drawing:save',
  DELETE_DRAWING: 'drawing:delete',

  // Alerts
  LIST_ALERTS: 'alert:list',
  SAVE_ALERT: 'alert:save',
  DELETE_ALERT: 'alert:delete',
  LIST_ALERT_EVENTS: 'alert:events',
  ACK_ALERT_EVENT: 'alert:ack',

  // Backup
  EXPORT_BACKUP: 'backup:export',
  IMPORT_BACKUP: 'backup:import',

  // Main -> renderer pushes
  ON_ALERT_FIRED: 'alert:fired',
  ON_DATA_STATUS: 'market:status',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/** Reported to the renderer so the UI can show feed health honestly. */
export interface DataStatus {
  online: boolean;
  /** Which source served the most recent request. */
  source: 'yahoo' | 'stooq' | 'cache';
  message?: string;
  lastUpdated: number;
}
