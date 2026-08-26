/**
 * Market summary strip above the chart.
 *
 * A row of index/commodity tiles, each with its level, change and an intraday
 * sparkline drawn against a dotted previous-close baseline — the shape Yahoo
 * and TradingView both use, because the dotted line is what turns a squiggle
 * into "up or down on the day" at a glance.
 *
 * Regions are a selector rather than one fixed list: the same strip has to
 * serve someone watching US indices and someone watching TASE, and neither
 * wants to scroll past the other's markets.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../state/store';

export interface MarketRegion {
  id: string;
  label: string;
  symbols: { symbol: string; label: string }[];
}

export const MARKET_REGIONS: MarketRegion[] = [
  {
    id: 'us',
    label: 'US Markets',
    symbols: [
      { symbol: '^GSPC', label: 'S&P 500' },
      { symbol: '^DJI', label: 'Dow 30' },
      { symbol: '^IXIC', label: 'Nasdaq' },
      { symbol: '^RUT', label: 'Russell 2000' },
      { symbol: '^VIX', label: 'VIX' },
      { symbol: 'GC=F', label: 'Gold' },
      { symbol: 'CL=F', label: 'Crude Oil' },
      { symbol: 'BTC-USD', label: 'Bitcoin USD' },
    ],
  },
  {
    id: 'israel',
    label: 'Israel',
    symbols: [
      // Yahoo carries the broad TASE indices but not the sector ones
      // (^TABANK.TA and ^TAINSUR.TA return nothing in any spelling), so the
      // sector slot goes to liquid constituents instead.
      { symbol: '^TA125.TA', label: 'TA-125' },
      { symbol: 'TA35.TA', label: 'TA-35' },
      { symbol: 'TA90.TA', label: 'TA-90' },
      { symbol: 'USDILS=X', label: 'USD/ILS' },
      { symbol: 'TEVA.TA', label: 'Teva' },
      { symbol: 'POLI.TA', label: 'Hapoalim' },
      { symbol: 'LUMI.TA', label: 'Leumi' },
      { symbol: 'NICE.TA', label: 'NICE' },
    ],
  },
  {
    id: 'europe',
    label: 'Europe & Asia',
    symbols: [
      { symbol: '^GDAXI', label: 'DAX' },
      { symbol: '^FTSE', label: 'FTSE 100' },
      { symbol: '^FCHI', label: 'CAC 40' },
      { symbol: '^STOXX50E', label: 'Euro Stoxx 50' },
      { symbol: '^N225', label: 'Nikkei 225' },
      { symbol: '^HSI', label: 'Hang Seng' },
      { symbol: 'EURUSD=X', label: 'EUR/USD' },
    ],
  },
  {
    id: 'commodities',
    label: 'Commodities & Crypto',
    symbols: [
      { symbol: 'GC=F', label: 'Gold' },
      { symbol: 'SI=F', label: 'Silver' },
      { symbol: 'CL=F', label: 'Crude Oil' },
      { symbol: 'NG=F', label: 'Natural Gas' },
      { symbol: 'BTC-USD', label: 'Bitcoin USD' },
      { symbol: 'ETH-USD', label: 'Ethereum USD' },
      { symbol: 'DX-Y.NYB', label: 'US Dollar Index' },
    ],
  },
];

/** How many 15-minute bars the sparkline covers — roughly one session. */
const SPARK_BARS = 40;

export default function MarketBar() {
  const {
    marketRegion, marketTiles, marketLoading,
    setMarketRegion, loadMarketBar, refreshMarketQuotes, setSymbol, settings,
  } = useStore();

  const [menuOpen, setMenuOpen] = useState(false);
  const stripRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);

  const region = MARKET_REGIONS.find((r) => r.id === marketRegion) ?? MARKET_REGIONS[0];

  useEffect(() => {
    void loadMarketBar();
  }, [marketRegion, loadMarketBar]);

  // Quotes are cheap (one batched request); sparklines are one request per
  // symbol, so they refresh far less often.
  useEffect(() => {
    const ms = Math.max(30, settings.alertPollSeconds) * 1000;
    const quotes = setInterval(() => void refreshMarketQuotes(), ms);
    const sparks = setInterval(() => void loadMarketBar(), 5 * 60 * 1000);
    return () => {
      clearInterval(quotes);
      clearInterval(sparks);
    };
  }, [settings.alertPollSeconds, refreshMarketQuotes, loadMarketBar]);

  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  // Only show the scroll arrows when there is something to scroll to.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const check = () => setOverflow(el.scrollWidth > el.clientWidth + 4);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [marketTiles.length]);

  function scrollBy(direction: -1 | 1) {
    stripRef.current?.scrollBy({ left: direction * 340, behavior: 'smooth' });
  }

  return (
    <div className="flex h-[52px] shrink-0 items-stretch border-b border-edge bg-panel">
      {/* --- region selector ------------------------------------------------ */}
      <div ref={menuRef} className="relative flex shrink-0 items-center border-r border-edge px-2.5">
        <button
          onClick={() => setMenuOpen((o) => !o)}
          className="flex items-center gap-1.5 rounded px-1 py-1 text-[11px] font-semibold text-ink hover:text-accent"
          title="Choose which markets to show"
        >
          <svg viewBox="0 0 20 20" className="h-4 w-4 text-accent" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="10" cy="10" r="2.2" />
            <path d="M6.2 13.8a5.4 5.4 0 010-7.6M13.8 6.2a5.4 5.4 0 010 7.6M3.6 16.4a9 9 0 010-12.8M16.4 3.6a9 9 0 010 12.8" />
          </svg>
          <span className="whitespace-nowrap">{region.label}</span>
          <span className="text-[9px] text-ink-faint">▾</span>
        </button>

        {menuOpen && (
          <div className="absolute left-2 top-full z-40 mt-1 w-52 rounded border border-edge bg-panel py-1 shadow-xl">
            {MARKET_REGIONS.map((r) => (
              <button
                key={r.id}
                onClick={() => {
                  setMarketRegion(r.id);
                  setMenuOpen(false);
                }}
                className={`block w-full px-2.5 py-1.5 text-left text-[11px] ${
                  r.id === region.id ? 'bg-accent/15 text-accent' : 'text-ink-dim hover:bg-panel-2 hover:text-ink'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* --- tiles ---------------------------------------------------------- */}
      <div
        ref={stripRef}
        className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {marketTiles.length === 0 && (
          <div className="flex items-center px-3 text-[11px] text-ink-faint">
            {marketLoading ? 'Loading market data…' : 'No market data.'}
          </div>
        )}

        {marketTiles.map((tile) => (
          <Tile key={tile.symbol} tile={tile} onOpen={() => void setSymbol(tile.symbol)} />
        ))}
      </div>

      {/* --- scroll arrows -------------------------------------------------- */}
      {overflow && (
        <div className="flex shrink-0 items-center border-l border-edge">
          <Arrow direction={-1} onClick={() => scrollBy(-1)} />
          <Arrow direction={1} onClick={() => scrollBy(1)} />
        </div>
      )}
    </div>
  );
}

export interface MarketTile {
  symbol: string;
  label: string;
  price?: number;
  change?: number;
  changePercent?: number;
  previousClose?: number;
  spark: number[];
}

function Tile({ tile, onOpen }: { tile: MarketTile; onOpen: () => void }) {
  const pct = tile.changePercent;
  const up = (pct ?? 0) >= 0;
  const has = pct != null && tile.price != null;
  // Precision comes from the price, not from the change: VIX moving 0.20 on a
  // 15.26 level should read "-0.20", not "-0.2000".
  const digits = decimalsFor(tile.price, tile.symbol);

  return (
    <button
      onClick={onOpen}
      title={`Open ${tile.symbol} on the chart`}
      className="group flex shrink-0 items-center gap-2.5 border-r border-edge/60 px-3 text-left hover:bg-panel-2"
    >
      <span className="flex flex-col justify-center gap-0.5">
        <span className="whitespace-nowrap text-[11px] font-semibold text-accent group-hover:underline">
          {tile.label}
        </span>
        <span className="tnum whitespace-nowrap text-[12px] leading-none text-ink">
          {tile.price != null ? fmt(tile.price, digits) : '—'}
        </span>
        <span className={`tnum whitespace-nowrap text-[10px] leading-none ${has ? (up ? 'text-up' : 'text-down') : 'text-ink-faint'}`}>
          {has ? `${up ? '+' : ''}${fmt(tile.change ?? 0, digits)} ${up ? '+' : ''}${pct!.toFixed(2)}%` : '—'}
        </span>
      </span>

      <Sparkline values={tile.spark} baseline={tile.previousClose} up={up} />
    </button>
  );
}

/**
 * Intraday sparkline with a dotted previous-close baseline.
 *
 * The y-domain is widened to always contain the baseline, so the dotted line
 * never falls outside the box — without that, a strongly trending symbol would
 * lose the very reference that makes the shape readable.
 */
function Sparkline({ values, baseline, up }: { values: number[]; baseline?: number; up: boolean }) {
  const W = 62;
  const H = 30;

  const path = useMemo(() => {
    const pts = values.filter((v) => Number.isFinite(v));
    if (pts.length < 2) return null;

    let lo = Math.min(...pts);
    let hi = Math.max(...pts);
    if (baseline != null && Number.isFinite(baseline)) {
      lo = Math.min(lo, baseline);
      hi = Math.max(hi, baseline);
    }
    const span = hi - lo || 1;
    const pad = 3;
    const x = (i: number) => (i / (pts.length - 1)) * W;
    const y = (v: number) => pad + (1 - (v - lo) / span) * (H - pad * 2);

    const line = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    const area = `${line} L${W} ${H} L0 ${H} Z`;
    const baseY = baseline != null && Number.isFinite(baseline) ? y(baseline) : null;
    return { line, area, baseY };
  }, [values, baseline]);

  if (!path) return <span className="h-[30px] w-[62px] shrink-0" />;

  const color = up ? 'var(--color-up)' : 'var(--color-down)';
  const id = `spark-${up ? 'u' : 'd'}`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="shrink-0" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={path.area} fill={`url(#${id})`} />
      <path d={path.line} fill="none" stroke={color} strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" />
      {path.baseY != null && (
        <line x1="0" y1={path.baseY} x2={W} y2={path.baseY} stroke="currentColor" strokeWidth="1"
          strokeDasharray="2 2" className="text-ink-faint" />
      )}
    </svg>
  );
}

function Arrow({ direction, onClick }: { direction: -1 | 1; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={direction < 0 ? 'Scroll left' : 'Scroll right'}
      className="flex h-full w-7 items-center justify-center text-ink-faint hover:bg-panel-2 hover:text-ink"
    >
      <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d={direction < 0 ? 'M12 4L6 10l6 6' : 'M8 4l6 6-6 6'} />
      </svg>
    </button>
  );
}

/**
 * How many decimals this instrument is quoted to.
 *
 * FX is the exception worth special-casing: 2 decimals on USD/ILS would hide
 * the movement entirely, since the whole day's range lives in the third and
 * fourth places.
 */
function decimalsFor(price: number | undefined, symbol: string): number {
  if (symbol.endsWith('=X')) return 4;
  if (price == null || !Number.isFinite(price)) return 2;
  return Math.abs(price) < 1 ? 4 : 2;
}

/** Thousands-separated, matching how index levels are quoted. */
function fmt(v: number, digits = 2): string {
  return v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export { SPARK_BARS };
