/**
 * The bridge, for when there is no Electron behind the renderer.
 *
 * `preload.ts` exposes `window.marketlab` over IPC to a Node main process, which is
 * where better-sqlite3 and yahoo-finance2 live. Neither can exist in a browser tab,
 * so opening the Vite URL used to show "No preload bridge" and nothing else — the
 * whole UI was unreachable outside a packaged desktop build.
 *
 * That mattered more than it looks: it meant the interface could not be opened in
 * anything that frames a URL — a review tool, a session, a screenshot service, a
 * colleague's browser. So this implements the same contract against two things a
 * browser does have: a deterministic generator for market data, and localStorage for
 * everything the user creates.
 *
 * Two rules kept throughout:
 *
 * - **The shapes are the real ones.** This file imports the same types the IPC
 *   handlers satisfy, so if the contract changes this stops compiling rather than
 *   drifting into a lookalike that fails at runtime.
 *
 * - **The data is obviously synthetic, and never claims otherwise.** Prices come
 *   from a seeded walk, so they are stable across reloads and identical for
 *   everyone, but they are not quotes. `isBrowserBridge` is exported so the UI can
 *   say so; nothing here pretends to be a feed.
 */

import {
  DEFAULT_SETTINGS,
  type Alert,
  type AlertEvent,
  type AppSettings,
  type Candle,
  type ChartLayout,
  type EarningsEvent,
  type Fundamentals,
  type Interval,
  type Quote,
  type SearchResult,
  type SymbolMeta,
  type UserScript,
  type Watchlist,
  type WatchlistItem,
} from '../../shared/types';

/** True when the app is running on the browser bridge rather than over IPC. */
export const isBrowserBridge = true;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const KEY = 'marketlab.browser.';

/**
 * localStorage, but never fatal.
 *
 * A private window, or a browser with site data blocked, throws on access rather
 * than returning null. The app should still open in those; it just forgets.
 */
function read<T>(name: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(KEY + name);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write<T>(name: string, value: T): T {
  try {
    window.localStorage.setItem(KEY + name, JSON.stringify(value));
  } catch {
    // Out of quota, or storage denied. The value is still returned, so the
    // session keeps working and only persistence is lost.
  }
  return value;
}

/** Ids are per-collection and monotonic, the way an autoincrement column behaves. */
function nextId(rows: { id: number }[]): number {
  return rows.reduce((top, row) => Math.max(top, row.id), 0) + 1;
}

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

/**
 * A stable pseudo-random stream from a string.
 *
 * Seeded so that a symbol always produces the same chart. Reloading the page and
 * getting a different history would make every screenshot and every conversation
 * about "that spike" meaningless.
 */
function seeded(text: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const INTERVAL_MS: Record<Interval, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '1wk': 7 * 24 * 60 * 60_000,
  '1mo': 30 * 24 * 60 * 60_000,
};

/**
 * A believable series: drift, volatility, and volume that rises on big bars.
 *
 * Anchored to a fixed epoch rather than Date.now() so the last bar does not move
 * every time the page is opened.
 */
function candlesFor(symbol: string, interval: Interval, count = 400): Candle[] {
  const rand = seeded(`${symbol}:${interval}`);
  const step = INTERVAL_MS[interval] ?? INTERVAL_MS['1d'];
  const end = Math.floor(Date.UTC(2026, 7, 26) / step) * step;

  let price = 20 + rand() * 380;
  const drift = (rand() - 0.45) * 0.0009;
  const vol = 0.006 + rand() * 0.02;

  const bars: Candle[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const open = price;
    const move = (rand() - 0.5) * 2 * vol + drift;
    const close = Math.max(0.5, open * (1 + move));
    const high = Math.max(open, close) * (1 + rand() * vol * 0.6);
    const low = Math.min(open, close) * (1 - rand() * vol * 0.6);
    const swing = Math.abs(close - open) / open;

    bars.push({
      time: Math.floor((end - i * step) / 1000),
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      volume: Math.round((500_000 + rand() * 4_000_000) * (1 + swing * 12)),
      adjClose: round(close),
    });
    price = close;
  }
  return bars;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** A small universe, so search returns something recognisable rather than nothing. */
const UNIVERSE: { symbol: string; name: string; exchange: string }[] = [
  { symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ' },
  { symbol: 'MSFT', name: 'Microsoft Corporation', exchange: 'NASDAQ' },
  { symbol: 'NVDA', name: 'NVIDIA Corporation', exchange: 'NASDAQ' },
  { symbol: 'AMZN', name: 'Amazon.com, Inc.', exchange: 'NASDAQ' },
  { symbol: 'GOOGL', name: 'Alphabet Inc.', exchange: 'NASDAQ' },
  { symbol: 'META', name: 'Meta Platforms, Inc.', exchange: 'NASDAQ' },
  { symbol: 'TSLA', name: 'Tesla, Inc.', exchange: 'NASDAQ' },
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', exchange: 'NYSEARCA' },
  { symbol: '^GSPC', name: 'S&P 500', exchange: 'SNP' },
  { symbol: 'TEVA.TA', name: 'Teva Pharmaceutical Industries', exchange: 'TASE' },
];

function metaFor(symbol: string): SymbolMeta {
  const known = UNIVERSE.find((u) => u.symbol === symbol);
  const tase = symbol.endsWith('.TA');
  return {
    symbol,
    shortName: known?.name.split(' ')[0] ?? symbol,
    longName: known?.name ?? symbol,
    quoteType: symbol.startsWith('^') ? 'INDEX' : 'EQUITY',
    exchange: known?.exchange ?? 'UNKNOWN',
    rawCurrency: tase ? 'ILA' : 'USD',
    displayCurrency: tase ? 'ILS' : 'USD',
    priceDivisor: tase ? 100 : 1,
    sector: 'Technology',
    industry: 'Software',
    updatedAt: Date.now(),
  };
}

function quoteFor(symbol: string): Quote {
  const bars = candlesFor(symbol, '1d', 260);
  const last = bars[bars.length - 1]!;
  const prev = bars[bars.length - 2] ?? last;
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);

  return {
    symbol,
    price: last.close,
    previousClose: prev.close,
    change: round(last.close - prev.close),
    changePercent: round(((last.close - prev.close) / prev.close) * 100),
    dayHigh: last.high,
    dayLow: last.low,
    dayOpen: last.open,
    volume: last.volume,
    marketCap: Math.round(last.close * 1_000_000_000),
    fiftyTwoWeekHigh: Math.max(...highs),
    fiftyTwoWeekLow: Math.min(...lows),
    displayCurrency: metaFor(symbol).displayCurrency,
    marketState: 'CLOSED',
    exchangeTimezoneName: 'UTC',
    hasPrePostMarket: false,
    timestamp: last.time * 1000,
  };
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

export function createBrowserBridge() {
  return {
    // --- Market data -----------------------------------------------------
    getCandles: async (symbol: string, interval: Interval) => candlesFor(symbol, interval),
    getQuote: async (symbol: string) => quoteFor(symbol),
    getQuotes: async (symbols: string[]) => symbols.map(quoteFor),
    getFundamentals: async (symbol: string): Promise<Fundamentals | null> => {
      void symbol;
      // Deliberately null rather than invented ratios. A chart from a seeded walk
      // is obviously a demonstration; a fabricated P/E on a real ticker is not.
      return null;
    },
    getEarnings: async (): Promise<EarningsEvent[]> => [],
    searchSymbols: async (query: string): Promise<SearchResult[]> => {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      return UNIVERSE.filter(
        (u) => u.symbol.toLowerCase().includes(q) || u.name.toLowerCase().includes(q),
      ).map((u) => ({
        symbol: u.symbol,
        name: u.name,
        exchange: u.exchange,
        quoteType: u.symbol.startsWith('^') ? ('INDEX' as const) : ('EQUITY' as const),
        origin: 'cache' as const,
        score: 0,
      }));
    },
    getSymbolMeta: async (symbol: string) => metaFor(symbol),

    // --- Settings --------------------------------------------------------
    getSettings: async (): Promise<AppSettings> => read('settings', DEFAULT_SETTINGS),
    setSettings: async (patch: Partial<AppSettings>): Promise<AppSettings> =>
      write('settings', { ...read('settings', DEFAULT_SETTINGS), ...patch }),

    // --- Watchlists ------------------------------------------------------
    listWatchlists: async (): Promise<Watchlist[]> =>
      read('watchlists', [{ id: 1, name: 'My list', sortOrder: 0 }]),
    createWatchlist: async (name: string) => {
      const rows = read<Watchlist[]>('watchlists', [{ id: 1, name: 'My list', sortOrder: 0 }]);
      const row = { id: nextId(rows), name, sortOrder: rows.length };
      write('watchlists', [...rows, row]);
      return row;
    },
    renameWatchlist: async (id: number, name: string) => {
      const rows = read<Watchlist[]>('watchlists', []).map((w) => (w.id === id ? { ...w, name } : w));
      write('watchlists', rows);
      return rows.find((w) => w.id === id) ?? null;
    },
    deleteWatchlist: async (id: number) => {
      write('watchlists', read<Watchlist[]>('watchlists', []).filter((w) => w.id !== id));
      write('items', read<WatchlistItem[]>('items', []).filter((i) => i.watchlistId !== id));
      return true;
    },
    listWatchlistItems: async (watchlistId: number): Promise<WatchlistItem[]> =>
      read<WatchlistItem[]>('items', seedItems()).filter((i) => i.watchlistId === watchlistId),
    addWatchlistItem: async (watchlistId: number, symbol: string) => {
      const rows = read<WatchlistItem[]>('items', seedItems());
      const row = { id: nextId(rows), watchlistId, symbol, sortOrder: rows.length, note: '' };
      write('items', [...rows, row]);
      return row;
    },
    removeWatchlistItem: async (id: number) => {
      write('items', read<WatchlistItem[]>('items', []).filter((i) => i.id !== id));
      return true;
    },

    // --- Search history --------------------------------------------------
    recordSearch: async (symbol: string) => {
      const rows = read<string[]>('recent', []).filter((s) => s !== symbol);
      write('recent', [symbol, ...rows].slice(0, 50));
      return true;
    },
    recentSymbols: async (limit = 20): Promise<string[]> => read<string[]>('recent', []).slice(0, limit),

    // --- Scripts ---------------------------------------------------------
    listScripts: async (): Promise<UserScript[]> => read('scripts', []),
    getScript: async (id: number): Promise<UserScript | null> =>
      read<UserScript[]>('scripts', []).find((s) => s.id === id) ?? null,
    saveScript: async (script: { id?: number; name: string; source: string; overlay: boolean }) => {
      const rows = read<UserScript[]>('scripts', []);
      const now = Date.now();
      if (script.id) {
        const updated = rows.map((s) =>
          s.id === script.id ? { ...s, ...script, updatedAt: now } : s,
        );
        write('scripts', updated);
        return updated.find((s) => s.id === script.id)!;
      }
      const row = { ...script, id: nextId(rows), createdAt: now, updatedAt: now } as UserScript;
      write('scripts', [...rows, row]);
      return row;
    },
    deleteScript: async (id: number) => {
      write('scripts', read<UserScript[]>('scripts', []).filter((s) => s.id !== id));
      return true;
    },
    listScriptVersions: async () => [],
    runScript: async () => ({
      ok: false as const,
      error: {
        // The script sandbox is a main-process feature — it compiles and runs
        // untrusted source under a timeout, which a renderer cannot do safely.
        // Saying so beats a fake green tick on code that never ran.
        message: 'Scripts run in the desktop app, which is where the sandbox lives.',
        kind: 'security' as const,
      },
    }),

    // --- Chart state -----------------------------------------------------
    getChartIndicators: async (symbol: string): Promise<unknown[]> =>
      read(`indicators.${symbol}`, [] as unknown[]),
    saveChartIndicators: async (symbol: string, indicators: unknown[]) => {
      write(`indicators.${symbol}`, indicators);
      return true;
    },
    listLayouts: async (): Promise<ChartLayout[]> => read('layouts', []),
    saveLayout: async (layout: unknown) => {
      const rows = read<ChartLayout[]>('layouts', []);
      const row = layout as ChartLayout;
      const saved = row.id
        ? rows.map((l) => (l.id === row.id ? row : l))
        : [...rows, { ...row, id: nextId(rows) }];
      write('layouts', saved);
      return saved[saved.length - 1]!;
    },
    deleteLayout: async (id: number) => {
      write('layouts', read<ChartLayout[]>('layouts', []).filter((l) => l.id !== id));
      return true;
    },

    // --- Drawings --------------------------------------------------------
    getDrawings: async (symbol: string): Promise<unknown[]> => read(`drawings.${symbol}`, [] as unknown[]),
    saveDrawing: async (drawing: unknown) => {
      const row = drawing as { id?: number; symbol: string };
      const rows = read<{ id: number }[]>(`drawings.${row.symbol}`, []);
      const saved = row.id
        ? rows.map((d) => (d.id === row.id ? (row as { id: number }) : d))
        : [...rows, { ...(row as object), id: nextId(rows) } as { id: number }];
      write(`drawings.${row.symbol}`, saved);
      return saved[saved.length - 1]!;
    },
    deleteDrawing: async (id: number) => {
      void id;
      return true;
    },

    // --- Alerts ----------------------------------------------------------
    listAlerts: async (): Promise<Alert[]> => read('alerts', []),
    saveAlert: async (alert: unknown) => {
      const rows = read<Alert[]>('alerts', []);
      const row = alert as Alert;
      const saved = row.id ? rows.map((a) => (a.id === row.id ? row : a)) : [...rows, { ...row, id: nextId(rows) }];
      write('alerts', saved);
      return saved[saved.length - 1]!;
    },
    deleteAlert: async (id: number) => {
      write('alerts', read<Alert[]>('alerts', []).filter((a) => a.id !== id));
      return true;
    },
    listAlertEvents: async (): Promise<AlertEvent[]> => [],
    ackAlertEvent: async () => true,

    // --- Backup ----------------------------------------------------------
    exportBackup: async () => ({ ok: false as const, reason: 'Backup needs the desktop app.' }),
    importBackup: async () => ({ ok: false as const, reason: 'Backup needs the desktop app.' }),

    // --- Push subscriptions ----------------------------------------------
    // Nothing pushes without a main process. The unsubscribe still has to be a
    // function returning void, because React calls it as an effect destructor.
    onAlertFired: (): (() => void) => () => {},
    onDataStatus: (): (() => void) => () => {},
  };
}

/** One list with a few symbols, so the app opens on something rather than blank. */
function seedItems(): WatchlistItem[] {
  return ['AAPL', 'MSFT', 'NVDA', 'SPY'].map((symbol, i) => ({
    id: i + 1,
    watchlistId: 1,
    symbol,
    sortOrder: i,
    note: '',
  }));
}
