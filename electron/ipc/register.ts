/**
 * IPC handler registration.
 *
 * Handlers are thin: they validate arguments, call a service, and return plain
 * serializable data. Anything that can throw is wrapped so a failure surfaces
 * in the renderer as a rejected promise rather than an unhandled main-process
 * exception.
 */

import { dialog, nativeTheme, type IpcMain, type BrowserWindow } from 'electron';
import * as fs from 'node:fs/promises';
import { IPC, type DataStatus } from '../../shared/ipc';
import { DEFAULT_SETTINGS, type AppSettings, type ChartLayout, type Drawing, type Interval } from '../../shared/types';
import { isUnknownExchange } from '../../shared/exchanges';
import { getDatabase, getSetting, setSetting } from '../services/db';
import { loadCandles, readSymbolMeta, upsertSymbolMeta } from '../services/candle-cache';
import { loadEarnings } from '../services/earnings-cache';
import { fetchFundamentals, fetchQuotes, fetchSymbolMeta } from '../services/market-data';
import { recentAsResults, recordSearch, searchAll } from '../services/symbols';
import { runUserScript } from '../services/script-host';
import {
  ackAlertEvent, deleteAlert, listAlertEvents, listAlerts, saveAlert, type AlertInput,
} from '../services/alerts';
import { exportBundle, importBundle, parseBundle, serializeBundle } from '../services/backup';

type WindowGetter = () => BrowserWindow | null;

export interface IpcHooks {
  /** Fired when the user acknowledges an alert, so the tray badge can clear. */
  onAlertsRead?: () => void;
}

export function registerIpcHandlers(ipcMain: IpcMain, getWindow: WindowGetter, hooks: IpcHooks = {}): void {
  registerSettings(ipcMain);
  registerWatchlists(ipcMain);
  registerSearchHistory(ipcMain);
  registerMarketData(ipcMain, getWindow);
  registerChartState(ipcMain);
  registerScripts(ipcMain);
  registerAlerts(ipcMain, hooks);
  registerBackup(ipcMain, getWindow);
  registerDrawings(ipcMain);
}

// ---------------------------------------------------------------------------
// Drawings
// ---------------------------------------------------------------------------

const DRAWING_COLUMNS = `
  id, symbol, tool, points, color, line_width AS lineWidth, text, props,
  created_at AS createdAt
`;

function rowToDrawing(r: any): Drawing {
  return {
    id: r.id,
    symbol: r.symbol,
    tool: r.tool,
    points: safeParse(r.points, []),
    color: r.color,
    lineWidth: r.lineWidth,
    text: r.text ?? '',
    props: safeParse(r.props, {}),
    createdAt: r.createdAt,
  };
}

function registerDrawings(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.GET_DRAWINGS, (_e, symbol: string) =>
    (
      getDatabase()
        .prepare(`SELECT ${DRAWING_COLUMNS} FROM drawings WHERE symbol = ? ORDER BY id`)
        .all(String(symbol).trim().toUpperCase()) as any[]
    ).map(rowToDrawing),
  );

  ipcMain.handle(IPC.SAVE_DRAWING, (_e, drawing: Partial<Drawing>) => {
    const db = getDatabase();
    const symbol = String(drawing.symbol ?? '').trim().toUpperCase();
    if (!symbol) throw new Error('Symbol required');
    if (!Array.isArray(drawing.points) || drawing.points.length === 0) throw new Error('Drawing needs points');

    const values = {
      symbol,
      tool: String(drawing.tool ?? 'trendline'),
      points: JSON.stringify(drawing.points),
      color: String(drawing.color ?? '#2962ff'),
      lineWidth: Number(drawing.lineWidth ?? 1),
      text: String(drawing.text ?? ''),
      props: JSON.stringify(drawing.props ?? {}),
    };

    // Dragging saves the same drawing repeatedly, so update in place rather
    // than accumulating a row per gesture.
    if (drawing.id && drawing.id > 0) {
      db.prepare(
        `UPDATE drawings SET symbol = @symbol, tool = @tool, points = @points, color = @color,
           line_width = @lineWidth, text = @text, props = @props
         WHERE id = @id`,
      ).run({ ...values, id: drawing.id });
      return rowToDrawing(db.prepare(`SELECT ${DRAWING_COLUMNS} FROM drawings WHERE id = ?`).get(drawing.id));
    }

    const info = db
      .prepare(
        `INSERT INTO drawings (symbol, tool, points, color, line_width, text, props, created_at)
         VALUES (@symbol, @tool, @points, @color, @lineWidth, @text, @props, @createdAt)`,
      )
      .run({ ...values, createdAt: Math.floor(Date.now() / 1000) });
    return rowToDrawing(
      db.prepare(`SELECT ${DRAWING_COLUMNS} FROM drawings WHERE id = ?`).get(Number(info.lastInsertRowid)),
    );
  });

  ipcMain.handle(IPC.DELETE_DRAWING, (_e, id: number) => {
    getDatabase().prepare('DELETE FROM drawings WHERE id = ?').run(id);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

function registerAlerts(ipcMain: IpcMain, hooks: IpcHooks): void {
  ipcMain.handle(IPC.LIST_ALERTS, () => listAlerts());
  ipcMain.handle(IPC.SAVE_ALERT, (_e, alert: AlertInput) => saveAlert(alert));
  ipcMain.handle(IPC.DELETE_ALERT, (_e, id: number) => {
    deleteAlert(Number(id));
    return true;
  });
  ipcMain.handle(IPC.LIST_ALERT_EVENTS, (_e, limit: number) => listAlertEvents(Number(limit) || 100));
  ipcMain.handle(IPC.ACK_ALERT_EVENT, (_e, id: number) => {
    ackAlertEvent(Number(id));
    hooks.onAlertsRead?.();
    return true;
  });
}

// ---------------------------------------------------------------------------
// Backup — export/import the whole local memory as one JSON file
// ---------------------------------------------------------------------------

/** Today as `YYYY-MM-DD`, for a filename that sorts chronologically. */
function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function exportBackupTo(win: BrowserWindow | null): Promise<{ ok: boolean; path?: string; error?: string }> {
  // Electron's dialog helpers are overloaded on the parent window: passing an
  // explicit `undefined` is not the same as omitting it, so branch rather than
  // coerce. Called from the tray, there may genuinely be no window.
  const options = {
    title: 'Export MarketLab backup',
    defaultPath: `marketlab-backup-${todayStamp()}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  };
  const { canceled, filePath } = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options);
  if (canceled || !filePath) return { ok: false };
  try {
    await fs.writeFile(filePath, serializeBundle(exportBundle()), 'utf8');
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function importBackupFrom(
  win: BrowserWindow | null,
): Promise<{ ok: boolean; counts?: Record<string, number>; error?: string }> {
  const openOptions = {
    title: 'Import MarketLab backup',
    properties: ['openFile' as const],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  };
  const { canceled, filePaths } = win
    ? await dialog.showOpenDialog(win, openOptions)
    : await dialog.showOpenDialog(openOptions);
  const file = filePaths?.[0];
  if (canceled || !file) return { ok: false };

  // Restore is destructive, so make that unmistakable before touching anything.
  const confirmOptions = {
    type: 'warning' as const,
    buttons: ['Replace my data', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Replace local data?',
    message: 'Importing replaces your watchlists, scripts, layouts and alerts with the backup’s.',
    detail: 'Your cached price history is left alone. This cannot be undone.',
  };
  const { response } = win
    ? await dialog.showMessageBox(win, confirmOptions)
    : await dialog.showMessageBox(confirmOptions);
  if (response !== 0) return { ok: false };

  try {
    const bundle = parseBundle(await fs.readFile(file, 'utf8'));
    const { counts } = importBundle(bundle);
    return { ok: true, counts };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function registerBackup(ipcMain: IpcMain, getWindow: WindowGetter): void {
  ipcMain.handle(IPC.EXPORT_BACKUP, () => exportBackupTo(getWindow()));
  ipcMain.handle(IPC.IMPORT_BACKUP, () => importBackupFrom(getWindow()));
}

// ---------------------------------------------------------------------------
// User scripts
// ---------------------------------------------------------------------------

function registerScripts(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.LIST_SCRIPTS, () =>
    getDatabase()
      .prepare(
        `SELECT id, name, source, version, overlay, created_at AS createdAt, updated_at AS updatedAt
         FROM scripts ORDER BY name`,
      )
      .all()
      .map((r: any) => ({ ...r, overlay: !!r.overlay })),
  );

  ipcMain.handle(IPC.GET_SCRIPT, (_e, id: number) => {
    const r = getDatabase()
      .prepare(
        `SELECT id, name, source, version, overlay, created_at AS createdAt, updated_at AS updatedAt
         FROM scripts WHERE id = ?`,
      )
      .get(id) as any;
    return r ? { ...r, overlay: !!r.overlay } : null;
  });

  ipcMain.handle(IPC.SAVE_SCRIPT, (_e, script: { id?: number; name: string; source: string; overlay: boolean }) => {
    const db = getDatabase();
    const now = Math.floor(Date.now() / 1000);
    const name = String(script.name ?? '').trim() || 'Untitled script';
    const source = String(script.source ?? '');
    const overlay = script.overlay === false ? 0 : 1;

    if (!script.id) {
      const info = db
        .prepare('INSERT INTO scripts (name, source, version, overlay, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)')
        .run(name, source, overlay, now, now);
      const id = Number(info.lastInsertRowid);
      db.prepare('INSERT INTO script_versions (script_id, version, source, saved_at) VALUES (?, 1, ?, ?)')
        .run(id, source, now);
      return { id, version: 1 };
    }

    // Snapshot the *previous* source before overwriting, so the history holds
    // what the script used to be rather than what it already is.
    const prev = db.prepare('SELECT source, version FROM scripts WHERE id = ?').get(script.id) as
      | { source: string; version: number }
      | undefined;
    if (!prev) throw new Error(`Script ${script.id} not found`);

    const version = prev.version + 1;
    db.transaction(() => {
      if (prev.source !== source) {
        db.prepare('INSERT INTO script_versions (script_id, version, source, saved_at) VALUES (?, ?, ?, ?)')
          .run(script.id, prev.version, prev.source, now);
      }
      db.prepare('UPDATE scripts SET name = ?, source = ?, version = ?, overlay = ?, updated_at = ? WHERE id = ?')
        .run(name, source, version, overlay, now, script.id);
    })();

    return { id: script.id, version };
  });

  ipcMain.handle(IPC.DELETE_SCRIPT, (_e, id: number) => {
    getDatabase().prepare('DELETE FROM scripts WHERE id = ?').run(id);
    return true;
  });

  ipcMain.handle(IPC.RUN_SCRIPT, (_e, source: string, candles: any[], inputs: Record<string, any>) =>
    runUserScript(String(source ?? ''), candles ?? [], inputs ?? {}),
  );

  ipcMain.handle(IPC.LIST_SCRIPT_VERSIONS, (_e, id: number) =>
    getDatabase()
      .prepare('SELECT id, version, source, saved_at AS savedAt FROM script_versions WHERE script_id = ? ORDER BY version DESC')
      .all(id),
  );
}

// ---------------------------------------------------------------------------
// Chart state (per-symbol indicator attachments)
// ---------------------------------------------------------------------------

function registerChartState(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.GET_CHART_INDICATORS, (_e, symbol: string) => {
    const rows = getDatabase()
      .prepare(
        `SELECT instance_id AS instanceId, indicator_id AS indicatorId, params, colors, visible
         FROM chart_indicators WHERE symbol = ? ORDER BY sort_order, id`,
      )
      .all(String(symbol).trim().toUpperCase()) as any[];

    return rows.map((r) => ({
      instanceId: r.instanceId,
      indicatorId: r.indicatorId,
      params: safeParse(r.params, {}),
      colors: safeParse(r.colors, {}),
      visible: !!r.visible,
    }));
  });

  ipcMain.handle(IPC.SAVE_CHART_INDICATORS, (_e, symbol: string, indicators: any[]) => {
    const db = getDatabase();
    const clean = String(symbol).trim().toUpperCase();
    // Replace wholesale: the renderer owns the ordering and the full set, so a
    // diff would only add ways for the two to disagree.
    db.transaction(() => {
      db.prepare('DELETE FROM chart_indicators WHERE symbol = ?').run(clean);
      const stmt = db.prepare(
        `INSERT INTO chart_indicators (symbol, instance_id, indicator_id, params, colors, visible, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      (indicators ?? []).forEach((i: any, idx: number) => {
        stmt.run(
          clean,
          String(i.instanceId),
          String(i.indicatorId),
          JSON.stringify(i.params ?? {}),
          JSON.stringify(i.colors ?? {}),
          i.visible === false ? 0 : 1,
          idx,
        );
      });
    })();
    return true;
  });

  registerLayouts(ipcMain);
}

// ---------------------------------------------------------------------------
// Saved layouts
// ---------------------------------------------------------------------------

/**
 * Layouts persist the *whole* pane state — symbol, interval, series type,
 * price scale, attached indicators, attached scripts with their input
 * overrides, and compare symbols — even though today's UI only ever writes a
 * single pane. Storing the full shape now means multi-chart grids and compare
 * mode need no schema or IPC change when they arrive.
 */
function registerLayouts(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.LIST_LAYOUTS, () =>
    (
      getDatabase()
        .prepare(
          `SELECT id, name, grid, panes, is_default AS isDefault, updated_at AS updatedAt
           FROM chart_layouts ORDER BY name`,
        )
        .all() as any[]
    ).map((r) => ({ ...r, panes: safeParse(r.panes, []), isDefault: !!r.isDefault })),
  );

  ipcMain.handle(IPC.SAVE_LAYOUT, (_e, layout: Partial<ChartLayout>) => {
    const db = getDatabase();
    const now = Math.floor(Date.now() / 1000);
    const name = String(layout.name ?? '').trim() || 'Untitled layout';
    const grid = [1, 2, 4].includes(Number(layout.grid)) ? Number(layout.grid) : 1;
    const panes = JSON.stringify(layout.panes ?? []);
    const isDefault = layout.isDefault ? 1 : 0;

    return db.transaction(() => {
      // Exactly one default, so boot has an unambiguous layout to restore.
      if (isDefault) db.prepare('UPDATE chart_layouts SET is_default = 0').run();

      if (layout.id) {
        db.prepare(
          'UPDATE chart_layouts SET name = ?, grid = ?, panes = ?, is_default = ?, updated_at = ? WHERE id = ?',
        ).run(name, grid, panes, isDefault, now, layout.id);
        return { id: layout.id };
      }

      // Saving over an existing name replaces it, matching how "Save as" reads
      // to a user who reuses a name deliberately.
      const existing = db.prepare('SELECT id FROM chart_layouts WHERE name = ?').get(name) as
        | { id: number }
        | undefined;
      if (existing) {
        db.prepare(
          'UPDATE chart_layouts SET grid = ?, panes = ?, is_default = ?, updated_at = ? WHERE id = ?',
        ).run(grid, panes, isDefault, now, existing.id);
        return { id: existing.id };
      }

      const info = db
        .prepare('INSERT INTO chart_layouts (name, grid, panes, is_default, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(name, grid, panes, isDefault, now);
      return { id: Number(info.lastInsertRowid) };
    })();
  });

  ipcMain.handle(IPC.DELETE_LAYOUT, (_e, id: number) => {
    getDatabase().prepare('DELETE FROM chart_layouts WHERE id = ?').run(id);
    return true;
  });
}

function safeParse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

function registerMarketData(ipcMain: IpcMain, getWindow: WindowGetter): void {
  /** Keep the UI honest about which source answered and whether we are online. */
  const pushStatus = (status: DataStatus) => {
    getWindow()?.webContents.send(IPC.ON_DATA_STATUS, status);
  };

  ipcMain.handle(IPC.GET_CANDLES, async (_e, symbol: string, interval: Interval, opts: { force?: boolean }) => {
    const res = await loadCandles(String(symbol).trim(), interval, opts ?? {});
    pushStatus({
      online: res.source !== 'cache' || !res.warning,
      source: res.source,
      message: res.warning,
      lastUpdated: Math.floor(Date.now() / 1000),
    });
    return res.candles;
  });

  ipcMain.handle(IPC.GET_QUOTE, async (_e, symbol: string) => (await fetchQuotes([symbol]))[0] ?? null);

  ipcMain.handle(IPC.GET_QUOTES, async (_e, symbols: string[]) => {
    const list = (symbols ?? []).map((s) => String(s).trim()).filter(Boolean);
    if (list.length === 0) return [];
    try {
      return await fetchQuotes(list);
    } catch {
      // A watchlist should still render without live quotes.
      return [];
    }
  });

  ipcMain.handle(IPC.GET_FUNDAMENTALS, (_e, symbol: string) => fetchFundamentals(String(symbol).trim()));

  ipcMain.handle(IPC.GET_EARNINGS, (_e, symbol: string, opts: { force?: boolean }) =>
    loadEarnings(String(symbol).trim(), opts ?? {}),
  );

  ipcMain.handle(IPC.SEARCH_SYMBOLS, (_e, query: string) => searchAll(String(query ?? '')));

  ipcMain.handle(IPC.GET_SYMBOL_META, async (_e, symbol: string) => {
    const clean = String(symbol).trim();
    const cached = readSymbolMeta(clean);
    // Metadata is near-static; a week-old record is fine and saves a request.
    // An unresolved exchange is the exception: it silently makes every session
    // check treat the venue as open around the clock, so refetch it rather than
    // serve it for another week.
    const WEEK = 7 * 86400;
    const fresh = cached && Math.floor(Date.now() / 1000) - cached.updatedAt < WEEK;
    if (cached && fresh && !isUnknownExchange(cached.exchange)) return cached;
    try {
      const fresh = await fetchSymbolMeta(clean);
      upsertSymbolMeta(fresh);
      return fresh;
    } catch {
      return cached;
    }
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function readSettings(): AppSettings {
  // Stored per-key so adding a new setting doesn't invalidate existing ones.
  const out = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]) {
    (out as any)[key] = getSetting(key, DEFAULT_SETTINGS[key]);
  }
  return out;
}

function registerSettings(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.GET_SETTINGS, () => readSettings());

  ipcMain.handle(IPC.SET_SETTINGS, (_e, patch: Partial<AppSettings>) => {
    for (const [key, value] of Object.entries(patch ?? {})) {
      // Ignore unknown keys so a stale renderer can't write junk into settings.
      if (key in DEFAULT_SETTINGS) setSetting(key, value);
    }
    // Keep the OS chrome in step with the in-app theme toggle.
    if (patch?.theme === 'dark' || patch?.theme === 'light') nativeTheme.themeSource = patch.theme;
    return readSettings();
  });
}

// ---------------------------------------------------------------------------
// Watchlists
// ---------------------------------------------------------------------------

function registerWatchlists(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.LIST_WATCHLISTS, () => {
    const db = getDatabase();
    const rows = db.prepare('SELECT id, name, sort_order AS sortOrder FROM watchlists ORDER BY sort_order, id').all();
    if (rows.length === 0) {
      // Give every fresh install one list, so the UI never starts empty.
      const now = db.prepare('INSERT INTO watchlists (name, sort_order) VALUES (?, 0)').run('My Watchlist');
      return [{ id: Number(now.lastInsertRowid), name: 'My Watchlist', sortOrder: 0 }];
    }
    return rows;
  });

  ipcMain.handle(IPC.CREATE_WATCHLIST, (_e, name: string) => {
    const db = getDatabase();
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM watchlists').get() as { m: number };
    const info = db
      .prepare('INSERT INTO watchlists (name, sort_order) VALUES (?, ?)')
      .run(String(name).trim() || 'Untitled', max.m + 1);
    return { id: Number(info.lastInsertRowid), name, sortOrder: max.m + 1 };
  });

  ipcMain.handle(IPC.RENAME_WATCHLIST, (_e, id: number, name: string) => {
    getDatabase().prepare('UPDATE watchlists SET name = ? WHERE id = ?').run(String(name).trim() || 'Untitled', id);
    return true;
  });

  ipcMain.handle(IPC.DELETE_WATCHLIST, (_e, id: number) => {
    getDatabase().prepare('DELETE FROM watchlists WHERE id = ?').run(id);
    return true;
  });

  ipcMain.handle(IPC.LIST_WATCHLIST_ITEMS, (_e, watchlistId: number) =>
    getDatabase()
      .prepare(
        `SELECT id, watchlist_id AS watchlistId, symbol, sort_order AS sortOrder, note
         FROM watchlist_items WHERE watchlist_id = ? ORDER BY sort_order, id`,
      )
      .all(watchlistId),
  );

  ipcMain.handle(IPC.ADD_WATCHLIST_ITEM, (_e, watchlistId: number, symbol: string) => {
    const db = getDatabase();
    const clean = String(symbol).trim().toUpperCase();
    if (!clean) throw new Error('Symbol required');
    const max = db
      .prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM watchlist_items WHERE watchlist_id = ?')
      .get(watchlistId) as { m: number };
    // Re-adding an existing symbol is a no-op rather than an error.
    const info = db
      .prepare(
        `INSERT INTO watchlist_items (watchlist_id, symbol, sort_order)
         VALUES (?, ?, ?) ON CONFLICT(watchlist_id, symbol) DO NOTHING`,
      )
      .run(watchlistId, clean, max.m + 1);
    return { id: Number(info.lastInsertRowid), symbol: clean };
  });

  ipcMain.handle(IPC.REMOVE_WATCHLIST_ITEM, (_e, id: number) => {
    getDatabase().prepare('DELETE FROM watchlist_items WHERE id = ?').run(id);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Search history
// ---------------------------------------------------------------------------

function registerSearchHistory(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.RECORD_SEARCH, (_e, symbol: string) => {
    recordSearch(String(symbol));
    return true;
  });

  ipcMain.handle(IPC.RECENT_SYMBOLS, (_e, limit: number) =>
    recentAsResults(Math.min(Math.max(1, Number(limit) || 20), 100)),
  );
}
