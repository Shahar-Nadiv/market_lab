# MarketLab

A local-first charting and market-analysis desktop app — stocks, ETFs and
exchange indices, moving-average analysis (150/200 DMA), custom indicator
scripts, watchlists and alerts. No subscription, no account, no cloud: all data
lives in a single SQLite file on your machine.

## Running

```bash
npm install     # also rebuilds better-sqlite3 against Electron's ABI
npm run dev     # Vite dev server + Electron with hot reload
```

Production build and launch from source:

```bash
npm run build
npm start
```

## Installing as a system package

```bash
npm run dist                                  # builds release/*.deb and release/*.AppImage
sudo apt install ./release/tradingview-replica_0.1.0_amd64.deb
```

That installs to `/opt/MarketLab`, puts **MarketLab** in your applications menu
with its icon, and symlinks `/usr/bin/marketlab` so it also runs from a shell.
The package's `postinst` sets the setuid bit on `chrome-sandbox`, so the
installed build runs with Chromium's sandbox enabled — unlike a manually
extracted copy, which needs `--no-sandbox`.

To remove it: `sudo apt remove tradingview-replica`. Your data is in
`~/.config/MarketLab` and is left alone.

`npm run dist:deb` builds only the .deb; `npm run dist:dir` produces an
unpackaged tree in `release/linux-unpacked` for quick testing.

The AppImage in `release/` needs no install at all — `chmod +x` it and run it.

**Where your data lives across versions.** `app.setName('MarketLab')` pins the
userData directory so running from source and running the installed package
share one database. Builds before this used the package name; `main.ts` copies
that older directory across on first run rather than starting empty.

## Checks

```bash
npm run typecheck                                   # both tsconfigs
npm test                                            # indicator + alert maths (vitest)
npm run build                                       # required before the scripts below

ELECTRON_RUN_AS_NODE=1 npx electron scripts/smoke-db.js        # DB + migrations
ELECTRON_RUN_AS_NODE=1 npx electron scripts/verify-sandbox.js  # script sandbox escapes
ELECTRON_RUN_AS_NODE=1 npx electron scripts/verify-alerts.js   # alert engine end to end
npx electron scripts/capture.js out.png             # render the UI to a PNG
```

`scripts/capture.js` renders the built UI without needing a visible window,
which is how to verify the interface over SSH, in CI, or anywhere the GPU is
unavailable.

## Layout

| Path | Contents |
|---|---|
| `shared/` | Types, exchange registry and indicator math used by **both** processes |
| `electron/` | Main process: window, tray, SQLite, market data, alert engine |
| `electron/preload.ts` | The only renderer↔main bridge (contextBridge) |
| `renderer/` | React + Vite UI, charts, scripting editor |
| `docs/DATA_NOTES.md` | Verified quirks of the Yahoo feed — read before touching the data layer |

Indicator math lives in `shared/` on purpose: the `sma()` that draws your 200
DMA is the same one the alert engine uses to decide whether price crossed it.
Two implementations would drift and produce alerts that disagree with the
chart.

## Where your data lives

One SQLite file at `~/.config/MarketLab/marketlab.db` holding settings,
watchlists, search history, saved scripts, chart layouts, drawings, alerts and
the OHLCV cache. Delete it to reset the app; copy it to back it up — take the
`-wal` and `-shm` sidecars with it if the app is running.

The same file is used whether you run from source or from the installed
package. Builds before the packaging work used `~/.config/tradingview-replica`;
that directory is copied across automatically on first run and then left alone.

Because bars are cached, charts, indicators and scripts all keep working with
no network — you just stop getting new data.

## Security posture

The renderer is treated as untrusted: `contextIsolation` on, `nodeIntegration`
off, a strict CSP that blocks all outbound connections, and a preload surface
that enumerates every permitted operation. Custom indicator scripts run in a
Web Worker with `fetch`, `XMLHttpRequest`, `WebSocket` and `importScripts`
removed from the global scope, loop guards injected into the AST, and a
watchdog timeout — a script can draw a wrong line, but it cannot reach the
network or the filesystem.

## Alerts

The alert engine runs in the main process, so it keeps working when the window
is closed — the tray keeps the app alive and fires native notifications. Nine
trigger types: price above/below/crossing a level, crossing an indicator, %
change over a window, volume spike, new 52-week high/low, and any
`alertcondition()` declared by one of your scripts.

Two behaviours worth knowing, because they are deliberate:

- **Alerts are edge-triggered.** An alert for "above 200" created while the
  stock trades at 210 stays silent until price drops below and comes back. A
  standing condition is not a signal, and state is seeded from history at
  startup so a restart never replays alerts that merely happen to be true.
- **Closed markets are not polled.** Trading days come from each symbol's own
  cached bars, so the engine sleeps through nights and weekends and wakes for
  the next session — see `docs/DATA_NOTES.md` for why observed bars, rather
  than a published calendar, are the source of truth here.

## Symbol info

Below the scripts section, the right rail carries the analyst consensus as a
TradingView-style dial (bearish left, bullish right, with the analyst split and
the low/mean/high price target), the full quote statistics — previous close,
open, bid/ask with sizes, day and 52-week range, volume, market cap, beta, P/E,
EPS, earnings date, dividend and yield, ex-dividend date, 1y target — and the
last four reported quarters with EPS actual against consensus.

Each quarter links to the filing itself. Yahoo publishes no per-quarter report
URL, so for US listings the link goes to EDGAR's filing index bounded to just
after that quarter's reporting date, which puts the relevant 10-Q or 10-K first;
non-US listings fall back to the Yahoo earnings page.

Fields that don't apply are shown as `—` rather than hidden, so the panel keeps
its shape between an equity, an ETF and an index.

## Watchlists

Keep as many named lists as you like — the `⋯` button beside the selector
creates, renames, duplicates and deletes them. The list you were last on is
restored at launch. Deleting your last list is safe: a fresh empty one takes
its place rather than leaving the panel with nothing to show.

Adding a symbol is a separate action from opening one, deliberately: in search,
`↵` opens the symbol on the chart, while the `+` on a result adds it to the
current list without closing the search, so you can add several in a row. The
`+` shows a `✓` once the symbol is already in that list.

## Drawing tools

A left rail with seven groups covering ~30 tools: lines (trend line, ray,
extended, info line, trend angle, horizontal/vertical/cross, parallel and
disjoint channels), Fibonacci (retracement, extension, time zones), shapes
(rectangle, ellipse, triangle, polyline, path), annotation (text, callout,
note, price label, arrow, brush, highlighter), measure (date & price range,
price range, date range) and positions (long/short with live risk/reward).

Each rail button remembers the last tool used from its group; right-click it,
or click the corner arrow, for the full list. Keys `1`–`7` jump to a group,
`Esc` cancels, `Delete` removes the selection, and the magnet button snaps new
points to the nearest bar.

Drawings are anchored to **price and time, never pixels**, so they stay put
through zoom, pan, resize and interval changes, and they are stored per symbol
in SQLite alongside everything else.

## Credits

Charts are rendered by [Lightweight Charts™](https://github.com/tradingview/lightweight-charts),
copyright © TradingView, Inc., used under the Apache License 2.0. The on-chart
attribution logo is disabled in `renderer/src/chart/theme.ts` because it sits
over the price action; the attribution lives here instead.

## Status

- [x] **Phase 0** — scaffold, Electron shell, SQLite + migrations, tray
- [x] **Phase 1** — data layer (Yahoo, cache, exchange registry, symbol search)
- [x] **Phase 2** — chart core (lightweight-charts v5)
- [x] **Phase 3** — indicators incl. 150/200 DMA presets
- [x] **Phase 4** — watchlists, search history, saved layouts, JSON backup
- [x] **Phase 5** — sandboxed scripting engine
- [x] **Phase 6** — alerts engine
- [x] **Phase 7a** — drawing tools
- [x] **Phase 7b** — symbol info panel, Linux packaging (.deb + AppImage)
- [ ] Phase 7c — compare mode, screener, CSV export
