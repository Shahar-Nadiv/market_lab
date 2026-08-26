/**
 * Symbol info: the analyst verdict, the numbers you check before a trade, and
 * the last four reported quarters.
 *
 * The layout is built for a narrow sidebar read at a glance, so it leads with
 * the one thing that is a judgement — the rating gauge — and puts the raw
 * statistics below it as a scannable two-column list rather than a table.
 *
 * Missing data is shown as an em dash rather than hidden. An ETF has no P/E and
 * an index has no analyst coverage; blanking those rows would make the panel
 * change shape per symbol and leave you wondering whether it failed to load.
 */

import { useEffect } from 'react';
import { useStore } from '../state/store';
import type { EarningsQuarter, Fundamentals, RecommendationTrend } from '@shared/types';

// Yahoo's mean runs 1 (Strong Buy) → 5 (Strong Sell). Lower is more bullish.
const RATINGS = [
  { label: 'Strong Buy', short: 'STRONG BUY', color: '#0f9d76' },
  { label: 'Buy', short: 'BUY', color: '#26a69a' },
  { label: 'Hold', short: 'HOLD', color: '#9aa0a6' },
  { label: 'Sell', short: 'SELL', color: '#ef5350' },
  { label: 'Strong Sell', short: 'STRONG SELL', color: '#c62828' },
];

export default function SymbolInfo() {
  const { symbol, fundamentals, fundamentalsLoading, loadFundamentals, meta } = useStore();

  useEffect(() => {
    if (!fundamentals && !fundamentalsLoading) void loadFundamentals(symbol);
    // Only on symbol change: the store clears `fundamentals` when the symbol
    // switches, which is what re-triggers this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  if (fundamentalsLoading && !fundamentals) {
    return <Section title="Symbol info"><p className="text-[11px] text-ink-faint">Loading {symbol}…</p></Section>;
  }
  if (!fundamentals) {
    return (
      <Section title="Symbol info">
        <p className="text-[11px] text-ink-faint">No fundamentals available for {symbol}.</p>
      </Section>
    );
  }

  const f = fundamentals;
  const ccy = f.currency ?? meta?.displayCurrency ?? '';

  return (
    <>
      {f.recommendation && <AnalystRating rec={f.recommendation} fundamentals={f} currency={ccy} />}

      <Section title="Key statistics">
        <dl className="space-y-0">
          <Row label="Previous Close" value={num(f.previousClose)} />
          <Row label="Open" value={num(f.open)} />
          <Row label="Bid" value={sized(f.bid, f.bidSize)} />
          <Row label="Ask" value={sized(f.ask, f.askSize)} />
          <Row label="Day's Range" value={range(f.dayLow, f.dayHigh)} />
          <Row label="52 Week Range" value={range(f.fiftyTwoWeekLow, f.fiftyTwoWeekHigh)} />
          <Row label="Volume" value={int(f.volume)} />
          <Row label="Avg. Volume" value={int(f.averageVolume)} />
          <Row label="Market Cap (intraday)" value={compact(f.marketCap)} />
          <Row label="Beta (5Y Monthly)" value={num(f.beta)} />
          <Row label="PE Ratio (TTM)" value={num(f.trailingPE)} />
          <Row label="EPS (TTM)" value={num(f.epsTrailing)} />
          <Row
            label={`Earnings Date${f.earningsDateEstimated ? ' (est.)' : ''}`}
            value={date(f.earningsDate)}
          />
          <Row label="Forward Dividend & Yield" value={dividend(f)} />
          <Row label="Ex-Dividend Date" value={date(f.exDividendDate)} />
          <Row label="1y Target Est" value={num(f.targetMeanPrice)} />
        </dl>
      </Section>

      <Earnings symbol={symbol} history={f.earningsHistory ?? []} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Analyst rating
// ---------------------------------------------------------------------------

function AnalystRating({
  rec, fundamentals, currency,
}: {
  rec: RecommendationTrend;
  fundamentals: Fundamentals;
  currency: string;
}) {
  const counts = [rec.strongBuy, rec.buy, rec.hold, rec.sell, rec.strongSell];
  const total = counts.reduce((a, b) => a + b, 0);

  // Prefer Yahoo's own mean; fall back to the weighted average of the counts so
  // the gauge still reads correctly when only the breakdown is published.
  const mean =
    rec.mean ??
    (total > 0 ? counts.reduce((sum, n, i) => sum + n * (i + 1), 0) / total : undefined);

  if (mean == null) return null;

  const bucket = Math.min(4, Math.max(0, Math.round(mean) - 1));
  const rating = RATINGS[bucket];

  return (
    <Section title="Analyst rating">
      <Gauge mean={mean} />

      <div className="mt-1 text-center">
        <div className="text-[13px] font-semibold tracking-wide" style={{ color: rating.color }}>
          {rating.short}
        </div>
        <div className="mt-0.5 text-[10px] text-ink-faint">
          {total > 0 ? `${total} analyst${total === 1 ? '' : 's'}` : 'Consensus'} · mean {mean.toFixed(2)}
        </div>
      </div>

      {total > 0 && (
        <ul className="mt-2.5 space-y-1">
          {RATINGS.map((r, i) => (
            <li key={r.label} className="flex items-center gap-1.5">
              <span className="w-[62px] shrink-0 text-[10px] text-ink-dim">{r.label}</span>
              <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-panel-2">
                <span
                  className="block h-full rounded-full transition-[width]"
                  style={{ width: `${total ? (counts[i] / total) * 100 : 0}%`, background: r.color }}
                />
              </span>
              <span className="w-4 shrink-0 text-right text-[10px] tnum text-ink-dim">{counts[i]}</span>
            </li>
          ))}
        </ul>
      )}

      <PriceTarget fundamentals={fundamentals} currency={currency} />
    </Section>
  );
}

/**
 * A five-segment dial with a needle at the consensus.
 *
 * Drawn as SVG arcs rather than a rotated image so it stays crisp at any zoom
 * and picks up the rating colours directly.
 */
function Gauge({ mean }: { mean: number }) {
  const CX = 82;
  const CY = 76;
  const R = 58;
  const WIDTH = 11;
  const GAP = 2.5;

  // Clamp so a malformed mean cannot swing the needle off the dial.
  // t runs 0 (Strong Buy) → 1 (Strong Sell).
  const t = Math.min(1, Math.max(0, (mean - 1) / 4));

  // Bearish on the left, bullish on the right, as TradingView draws it — so
  // the dial is read left-to-right like the sentiment it represents. That
  // means the segments render in reverse of the RATINGS order, and the needle
  // sweeps from 360° (right) back to 180° (left) as the rating worsens.
  const segments = [...RATINGS].reverse();
  const activeFromRight = Math.min(4, Math.floor(t * 5));
  const activeIndex = 4 - activeFromRight;

  const needleDeg = 360 - t * 180;
  const [nx, ny] = polar(CX, CY, R - WIDTH - 7, needleDeg);

  return (
    <svg
      viewBox="0 0 164 96"
      className="mx-auto block w-full max-w-[164px]"
      role="img"
      aria-label={`Analyst consensus ${mean.toFixed(2)} on a 1–5 scale`}
    >
      {segments.map((r, j) => (
        <path
          key={r.label}
          d={arc(CX, CY, R - WIDTH / 2, 180 + j * 36 + GAP / 2, 180 + (j + 1) * 36 - GAP / 2)}
          stroke={r.color}
          strokeWidth={WIDTH}
          fill="none"
          strokeLinecap="butt"
          // Dim every segment except the one the needle sits in, so the verdict
          // reads at a glance rather than needing the needle to be traced.
          opacity={j === activeIndex ? 1 : 0.25}
        />
      ))}

      <line x1={CX} y1={CY} x2={nx} y2={ny} stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" className="text-ink" />
      <circle cx={CX} cy={CY} r={4.5} className="fill-ink" />
      <circle cx={CX} cy={CY} r={1.75} className="fill-panel" />

      <text x={4} y={92} className="fill-current text-ink-faint" style={{ fontSize: 8.5 }}>Sell</text>
      <text x={160} y={92} textAnchor="end" className="fill-current text-ink-faint" style={{ fontSize: 8.5 }}>Buy</text>
    </svg>
  );
}

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arc(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const [x1, y1] = polar(cx, cy, r, startDeg);
  const [x2, y2] = polar(cx, cy, r, endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/** Low / mean / high target, with today's price marked against the span. */
function PriceTarget({ fundamentals: f, currency }: { fundamentals: Fundamentals; currency: string }) {
  const { quote } = useStore();
  const low = f.targetLowPrice;
  const high = f.targetHighPrice;
  const mean = f.targetMeanPrice;
  if (low == null || high == null || mean == null || high <= low) return null;

  const price = quote?.price;
  const pos = (v: number) => ((v - low) / (high - low)) * 100;
  const upside = price && mean ? ((mean - price) / price) * 100 : null;

  return (
    <div className="mt-3 border-t border-edge pt-2.5">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wide text-ink-faint">Price target</span>
        {upside != null && (
          <span className={`text-[10px] tnum ${upside >= 0 ? 'text-up' : 'text-down'}`}>
            {upside >= 0 ? '+' : ''}{upside.toFixed(1)}% to target
          </span>
        )}
      </div>

      <div className="relative h-1.5 rounded-full bg-panel-2">
        <span className="absolute inset-y-0 rounded-full bg-accent/30" style={{ left: 0, right: 0 }} />
        <span className="absolute -top-0.5 h-2.5 w-0.5 rounded bg-accent" style={{ left: `${pos(mean)}%` }} title={`Mean ${num(mean)}`} />
        {price != null && price >= low && price <= high && (
          <span
            className="absolute -top-1 h-3.5 w-[3px] rounded bg-ink"
            style={{ left: `${pos(price)}%` }}
            title={`Current ${num(price)}`}
          />
        )}
      </div>

      <div className="mt-1 flex justify-between text-[10px] tnum text-ink-faint">
        <span>{num(low)}</span>
        <span className="text-ink-dim">{num(mean)} {currency}</span>
        <span>{num(high)}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Earnings
// ---------------------------------------------------------------------------

/**
 * The last four reported quarters, each linking out to the filing.
 *
 * Yahoo publishes no per-quarter report URL, so the link goes to the official
 * source instead: EDGAR's filing index for that ticker, bounded to just after
 * the reporting date so the quarter in question is the first result. Non-US
 * listings have no EDGAR presence, so those fall back to Yahoo.
 */
function Earnings({ symbol, history }: { symbol: string; history: EarningsQuarter[] }) {
  if (history.length === 0) return null;
  const usListed = !symbol.includes('.') && !symbol.startsWith('^');

  function reportUrl(q: EarningsQuarter): string {
    if (!usListed) return `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/analysis`;
    // `dateb` is EDGAR's "filed before" bound; a week's grace puts the filing
    // for this quarter at the top. `type=10-` matches both 10-Q and 10-K, so
    // the annual quarter is not silently missing.
    const before = q.reportedDate ? new Date((q.reportedDate + 7 * 86400) * 1000) : null;
    const dateb = before ? before.toISOString().slice(0, 10).replace(/-/g, '') : '';
    return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&ticker=${encodeURIComponent(symbol)}&type=10-&dateb=${dateb}&owner=include&count=10`;
  }

  return (
    <Section
      title="Earnings"
      action={
        <button
          onClick={() => open(`https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/analysis`)}
          className="rounded border border-edge px-1.5 py-0.5 text-[10px] text-ink-dim hover:border-accent hover:text-ink"
        >
          All ↗
        </button>
      }
    >
      <ul className="space-y-1">
        {history.map((q, i) => {
          const beat = q.surprisePercent != null && q.surprisePercent >= 0;
          return (
            <li key={q.fiscalQuarter || i}>
              <button
                onClick={() => open(reportUrl(q))}
                title={
                  usListed
                    ? `Open SEC filings around ${q.reportedDate ? new Date(q.reportedDate * 1000).toLocaleDateString() : 'this quarter'}`
                    : 'Open the earnings page on Yahoo Finance'
                }
                className="group flex w-full items-center gap-2 rounded border border-edge bg-panel-2 px-2 py-1.5 text-left hover:border-accent"
              >
                <span className="w-12 shrink-0 text-[11px] font-medium">{q.fiscalQuarter || '—'}</span>
                <span className="min-w-0 flex-1 text-[10px] text-ink-faint">
                  EPS <span className="tnum text-ink-dim">{num(q.epsActual)}</span>
                  <span className="text-ink-faint"> vs {num(q.epsEstimate)}</span>
                </span>
                {q.surprisePercent != null && (
                  <span className={`shrink-0 text-[10px] tnum ${beat ? 'text-up' : 'text-down'}`}>
                    {beat ? '+' : ''}{q.surprisePercent.toFixed(1)}%
                  </span>
                )}
                <span className="shrink-0 text-[10px] text-ink-faint group-hover:text-accent">↗</span>
              </button>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/** External links leave the app: main.ts routes them to the system browser. */
function open(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

const DASH = '—';

function num(v: number | undefined | null, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  return v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function int(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  return Math.round(v).toLocaleString();
}

/** 7.361B — the scale traders read market caps in. */
function compact(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  const abs = Math.abs(v);
  const units: [number, string][] = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [size, suffix] of units) {
    if (abs >= size) return `${(v / size).toFixed(3)}${suffix}`;
  }
  return v.toFixed(2);
}

function range(low: number | undefined, high: number | undefined): string {
  if (low == null || high == null) return DASH;
  return `${num(low)} - ${num(high)}`;
}

function sized(price: number | undefined, size: number | undefined): string {
  if (price == null) return DASH;
  return size != null ? `${num(price)} x ${size}` : num(price);
}

function date(unixSeconds: number | undefined): string {
  if (!unixSeconds) return DASH;
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

function dividend(f: Fundamentals): string {
  if (f.dividendRate == null && f.dividendYield == null) return DASH;
  const rate = f.dividendRate != null ? num(f.dividendRate) : DASH;
  const yieldPct = f.dividendYield != null ? `${f.dividendYield.toFixed(2)}%` : DASH;
  return `${rate} (${yieldPct})`;
}

function Row({ label, value }: { label: string; value: string }) {
  const missing = value === DASH;
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-edge/50 py-[5px] last:border-0">
      <dt className="min-w-0 shrink text-[10.5px] leading-tight text-ink-faint">{label}</dt>
      <dd className={`shrink-0 text-right text-[11px] tnum ${missing ? 'text-ink-faint' : 'text-ink-dim'}`}>
        {value}
      </dd>
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="border-b border-edge p-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}
