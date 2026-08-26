/**
 * Render the built renderer and write a PNG, without needing a visible window.
 *
 * Used to verify the UI in headless or GPU-less environments (CI, containers,
 * sandboxed shells) where a normal launch cannot reach a compositor.
 *
 *   npx electron scripts/capture.js [outfile.png]
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const OUT = process.argv[2] || path.join(__dirname, '..', 'capture.png');

// Software rendering: the whole point is to work where the GPU does not.
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();

const { openDatabase, closeDatabase } = require('../dist/electron/services/db');
const { registerIpcHandlers } = require('../dist/electron/ipc/register');
const { ipcMain } = require('electron');

app.whenReady().then(async () => {
  // Use a scratch profile so a capture never mutates the real user database.
  const tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'marketlab-capture-'));
  const db = openDatabase(tmpDir);
  registerIpcHandlers(ipcMain, () => win);

  // Optional seeding so a capture can show a populated workspace:
  //   CAPTURE_SYMBOL=AAPL CAPTURE_INDICATORS=1 CAPTURE_WATCHLIST=SPY,QQQ,TEVA.TA
  const seedSymbol = (process.env.CAPTURE_SYMBOL || 'AAPL').toUpperCase();
  if (process.env.CAPTURE_INDICATORS) {
    const add = db.prepare(
      `INSERT INTO chart_indicators (symbol, instance_id, indicator_id, params, colors, visible, sort_order)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    );
    add.run(seedSymbol, 'seed1', 'dma_cross', JSON.stringify({ fast: 150, slow: 200, maType: 'SMA', source: 'close' }), '{}', 0);
    add.run(seedSymbol, 'seed2', 'rsi', JSON.stringify({ length: 14, source: 'close' }), '{}', 1);
    add.run(seedSymbol, 'seed3', 'macd', JSON.stringify({ fast: 12, slow: 26, signal: 9, source: 'close' }), '{}', 2);
  }
  if (process.env.CAPTURE_WATCHLIST) {
    const wl = db.prepare('INSERT INTO watchlists (name, sort_order) VALUES (?, 0)').run('My Watchlist');
    const addItem = db.prepare('INSERT INTO watchlist_items (watchlist_id, symbol, sort_order) VALUES (?, ?, ?)');
    process.env.CAPTURE_WATCHLIST.split(',').forEach((s, i) => addItem.run(wl.lastInsertRowid, s.trim().toUpperCase(), i));
  }
  if (process.env.CAPTURE_SYMBOL) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('__seedSymbol', ?)").run(JSON.stringify(seedSymbol));
  }

  const win = new BrowserWindow({
    width: 1600,
    height: 980,
    show: false,
    backgroundColor: '#0b0e11',
    webPreferences: {
      preload: path.join(__dirname, '..', 'dist', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) errors.push(message);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => errors.push(`load failed ${code}: ${desc}`));

  await win.loadFile(path.join(__dirname, '..', 'dist', 'renderer', 'index.html'));
  // Long enough for React to mount *and* the initial market-data fetch to
  // land, so the capture shows a populated chart rather than a spinner.
  const settleMs = Number(process.env.CAPTURE_WAIT_MS ?? 9000);
  await new Promise((r) => setTimeout(r, settleMs));

  // Optional: drive the UI before capturing, e.g. to open a panel.
  //   CAPTURE_EVAL='[...document.querySelectorAll("button")].find(b=>b.textContent==="Editor").click()'
  if (process.env.CAPTURE_EVAL) {
    try {
      const evalResult = await win.webContents.executeJavaScript(process.env.CAPTURE_EVAL, true);
      if (evalResult !== undefined) console.log('eval ->', JSON.stringify(evalResult));
    } catch (e) {
      errors.push(`CAPTURE_EVAL failed: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, Number(process.env.CAPTURE_EVAL_WAIT_MS ?? 4000)));
  }

  const image = await win.webContents.capturePage();
  fs.writeFileSync(OUT, image.toPNG());

  console.log(`captured -> ${OUT}`);
  if (errors.length) {
    console.log('renderer errors:');
    for (const e of errors) console.log('  ' + e);
  } else {
    console.log('no renderer errors');
  }

  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  app.exit(errors.length ? 1 : 0);
});
