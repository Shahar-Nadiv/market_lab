import { useEffect, useState } from 'react';
import { api, hasBridge } from './api';
import { useStore, hydrateIndicators, hydrateDefaultLayout } from './state/store';
import ChartView from './chart/ChartView';
import Toolbar from './panels/Toolbar';
import Watchlist from './panels/Watchlist';
import IndicatorPanel from './panels/IndicatorPanel';
import SymbolSearch from './panels/SymbolSearch';
import ScriptEditor from './panels/ScriptEditor';
import AlertPanel from './panels/AlertPanel';
import DrawingToolbar from './panels/DrawingToolbar';
import MarketBar from './panels/MarketBar';
import IndicatorLibrary from './panels/IndicatorLibrary';

/**
 * The workspace: watchlist on the left, chart in the middle, indicators on the
 * right. Deliberately dense — this is a tool you read at a glance, not a
 * marketing page.
 */
export default function App() {
  const [searchOpen, setSearchOpen] = useState(false);
  const [scriptsOpen, setScriptsOpen] = useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const {
    settings, symbol, loadSettings, loadWatchlists, reloadCandles, loadBenchmark, setStatus,
    loadAlerts, receiveAlertEvent, loadDrawings, loadFundamentals, loadEarnings,
  } = useStore();

  // Boot: settings first, since they determine the default interval used by
  // the initial candle load.
  useEffect(() => {
    // No hasBridge guard. It was here because `api` was undefined outside Electron,
    // so every one of these calls would have thrown; now the browser bridge answers
    // the same contract, and skipping the boot was what left the chart empty with
    // no error to explain it — loading finished, and nothing had been asked for.
    void (async () => {
      await loadSettings();
      await loadWatchlists();
      // A saved default layout owns symbol, interval and indicators, so only
      // fall back to the per-symbol restore when there isn't one.
      const restored = await hydrateDefaultLayout();
      if (!restored) {
        await hydrateIndicators(useStore.getState().symbol);
        await reloadCandles();
      }
      void loadBenchmark();
      void loadAlerts();
      void loadDrawings(useStore.getState().symbol);
      void loadFundamentals(useStore.getState().symbol);
      void loadEarnings(useStore.getState().symbol);
    })();
  }, [loadSettings, loadWatchlists, reloadCandles, loadBenchmark, loadAlerts, loadDrawings, loadFundamentals, loadEarnings]);

  // Feed-health pushes from the main process. The browser bridge has nothing to
  // push, so its subscribe returns a no-op unsubscribe and this is simply quiet.
  useEffect(() => api.onDataStatus(setStatus), [setStatus]);

  // Alerts fire in the main process, including while this window was hidden.
  useEffect(() => api.onAlertFired(receiveAlertEvent), [receiveAlertEvent]);

  // "/" opens search, the way it does in every trading terminal.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      if (typing) return;
      if (e.key === '/' || (e.key === 'k' && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        setSearchOpen(true);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The chart palette is per-theme, so drive the document too.
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  return (
    <div className="flex h-full flex-col bg-ground text-ink">
      {/*
        Outside Electron the app runs on the browser bridge: the interface is real,
        the prices are a seeded walk and anything saved lives in localStorage. Said
        once, quietly, at the top — it used to be a full-screen dead end, which made
        the whole UI unreachable in a browser for the sake of a caveat.
      */}
      {!hasBridge && (
        <div className="flex items-center gap-2 border-b border-line bg-panel-2 px-3 py-1.5 text-xs text-ink-dim">
          <span className="font-semibold text-ink">Browser preview</span>
          <span>
            Sample prices, saved in this browser. Live data and scripts need the desktop app.
          </span>
        </div>
      )}
      <Toolbar onSearch={() => setSearchOpen(true)} onOpenAlerts={() => setAlertsOpen(true)} />

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-60 shrink-0 flex-col border-r border-edge bg-panel">
          <Watchlist onSearch={() => setSearchOpen(true)} />
        </aside>

        <DrawingToolbar />

        <main className="flex min-w-0 flex-1 flex-col">
          <MarketBar />
          <div className="min-h-0 flex-1">
            <ChartView key={symbol} />
          </div>
        </main>

        <aside className="w-64 shrink-0 overflow-auto border-l border-edge bg-panel">
          <IndicatorPanel onOpenScripts={() => setScriptsOpen(true)} onOpenLibrary={() => setLibraryOpen(true)} />
        </aside>
      </div>

      {searchOpen && <SymbolSearch onClose={() => setSearchOpen(false)} />}
      {scriptsOpen && <ScriptEditor onClose={() => setScriptsOpen(false)} />}
      {alertsOpen && <AlertPanel onClose={() => setAlertsOpen(false)} />}
      {libraryOpen && <IndicatorLibrary onClose={() => setLibraryOpen(false)} />}
    </div>
  );
}
