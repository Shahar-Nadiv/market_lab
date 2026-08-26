/**
 * Electron main process: window lifecycle, tray, and service wiring.
 *
 * Running the data layer here rather than in the renderer is deliberate — Node
 * HTTP requests are not subject to CORS, which is what makes it possible to
 * talk to Yahoo directly with no proxy server in between.
 */

import { app, BrowserWindow, Tray, Menu, nativeImage, nativeTheme, shell, ipcMain } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { openDatabase, closeDatabase, getSetting, setSetting } from './services/db';
import { registerIpcHandlers, exportBackupTo, importBackupFrom } from './ipc/register';
import { IPC } from '../shared/ipc';
import {
  startAlertEngine, stopAlertEngine, isAlertEngineRunning, unacknowledgedCount,
} from './services/alerts';

const isDev = process.env.NODE_ENV === 'development';
const DEV_SERVER_URL = 'http://localhost:5173';

/**
 * Pin the application name.
 *
 * `app.getPath('userData')` is derived from it, so leaving it to default would
 * put the database somewhere different when running from source than when
 * running the installed package — and silently orphan the user's watchlists,
 * scripts and drawings the moment they install the .deb. Must run before
 * anything asks for a path.
 */
app.setName('MarketLab');

/**
 * Resolve a file shipped alongside the app.
 *
 * Packaged builds keep these in `resources/` (declared as `extraResources`);
 * running from source they sit in `build/` at the repo root. Getting this wrong
 * is invisible in dev and shows up as a missing tray icon only once installed.
 */
function resourcePath(name: string): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(__dirname, '../../build', name);
}

/**
 * Carry data over from the pre-1.0 userData directory.
 *
 * Early builds ran under the package name (`tradingview-replica`) rather than
 * the product name. Copy rather than move, so a failed first run of the new
 * build cannot destroy the only copy of someone's data.
 */
function migrateLegacyUserData(userDataDir: string): void {
  const legacy = path.join(path.dirname(userDataDir), 'tradingview-replica');
  if (legacy === userDataDir) return;

  const target = path.join(userDataDir, 'marketlab.db');
  if (fs.existsSync(target)) return; // already have data here; never overwrite
  if (!fs.existsSync(path.join(legacy, 'marketlab.db'))) return;

  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    // WAL and shared-memory sidecars must travel with the database file.
    for (const suffix of ['', '-wal', '-shm']) {
      const from = path.join(legacy, `marketlab.db${suffix}`);
      if (fs.existsSync(from)) fs.copyFileSync(from, `${target}${suffix}`);
    }
    console.log(`[main] migrated existing data from ${legacy}`);
  } catch (e) {
    // A failed migration must not stop the app opening; it just starts fresh.
    console.warn('[main] could not migrate legacy data:', e instanceof Error ? e.message : e);
  }
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** Set on real quit so the close handler knows to exit instead of hide. */
let isQuitting = false;

// A second instance would open a second connection to the same SQLite file and
// run a duplicate alert poller, so keep a single instance and focus it.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1100,
    minHeight: 680,
    // Painted before the renderer loads, so it has to match the theme or the
    // window flashes the wrong colour on every launch.
    backgroundColor: getSetting<'dark' | 'light'>('theme', 'dark') === 'light' ? '#ffffff' : '#0b0e11',
    show: false,
    title: 'MarketLab',
    // Some Linux shells read the window icon rather than the .desktop entry
    // when grouping a running app in the dock.
    icon: resourcePath('icon.png'),
    // The stock Electron menu (File/Edit/View/Window) renders in the system's
    // light chrome above a dark workspace and offers nothing this app needs.
    // Hidden rather than removed, so Alt still reaches it for devtools.
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // The renderer is treated as untrusted: it reaches main only through the
      // explicit contextBridge surface in preload.ts.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  if (isDev) {
    void mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // External links open in the real browser, never inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Closing the window keeps the alert engine alive in the tray; quitting is
  // an explicit action from the tray menu or Cmd/Ctrl+Q.
  mainWindow.on('close', (e) => {
    if (!isQuitting && getSetting('alertsEnabled', true)) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showMainWindow(): void {
  if (!mainWindow) createWindow();
  else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function createTray(): void {
  let image = nativeImage.createFromPath(resourcePath('tray.png'));
  // An empty image still yields a working (if invisible) tray item, which beats
  // failing to start because an asset is missing.
  if (image.isEmpty()) image = nativeImage.createEmpty();

  tray = new Tray(image);
  tray.on('click', () => {
    if (mainWindow?.isVisible()) mainWindow.hide();
    else showMainWindow();
  });
  refreshTray();
}

/**
 * Rebuild the tray menu and tooltip.
 *
 * The menu carries live state (whether alerts are running, how many have fired
 * unread), so it is rebuilt on change rather than constructed once.
 */
function refreshTray(): void {
  if (!tray) return;

  const alertsOn = isAlertEngineRunning();
  let unread = 0;
  try {
    unread = unacknowledgedCount();
  } catch {
    // Before the DB is open, or if it goes away — the tray still works.
  }

  tray.setToolTip(unread > 0 ? `MarketLab — ${unread} alert${unread === 1 ? '' : 's'}` : 'MarketLab');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open MarketLab', click: showMainWindow },
      ...(unread > 0
        ? [{ label: `${unread} unread alert${unread === 1 ? '' : 's'}`, enabled: false }]
        : []),
      { type: 'separator' },
      {
        label: 'Alerts enabled',
        type: 'checkbox',
        checked: alertsOn,
        click: (item) => setAlertsEnabled(item.checked),
      },
      { type: 'separator' },
      { label: 'Export backup…', click: () => void exportBackupTo(mainWindow) },
      { label: 'Import backup…', click: () => void importBackupFrom(mainWindow) },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
}

/**
 * Turning alerts off also gives up the tray's claim on the process: with no
 * engine to keep alive, closing the window should quit rather than silently
 * leave a background process behind.
 */
function setAlertsEnabled(enabled: boolean): void {
  setSetting('alertsEnabled', enabled);
  if (enabled) startAlertEngine({ onFired: handleAlertFired });
  else stopAlertEngine();
  refreshTray();
}

function handleAlertFired(event: unknown): void {
  mainWindow?.webContents.send(IPC.ON_ALERT_FIRED, event);
  refreshTray();
}

app.whenReady().then(() => {
  const userDataDir = app.getPath('userData');
  migrateLegacyUserData(userDataDir);
  openDatabase(userDataDir);

  // Drive the OS window chrome — title bar, scrollbars, native dialogs — from
  // the app's own theme, so a dark workspace does not sit inside light chrome.
  nativeTheme.themeSource = getSetting<'dark' | 'light'>('theme', 'dark');
  // Acknowledging an alert in the UI clears the tray badge, so the handler
  // needs a way back here.
  registerIpcHandlers(ipcMain, () => mainWindow, { onAlertsRead: refreshTray });
  createWindow();
  createTray();

  if (getSetting('alertsEnabled', true)) startAlertEngine({ onFired: handleAlertFired });
  refreshTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  // Staying alive is only justified by work left to do. With the alert engine
  // running the tray keeps the process up; with alerts off there is nothing to
  // keep running, so closing the window means quitting.
  if (!tray || !isAlertEngineRunning()) app.quit();
});

app.on('quit', () => {
  stopAlertEngine();
  closeDatabase();
});
