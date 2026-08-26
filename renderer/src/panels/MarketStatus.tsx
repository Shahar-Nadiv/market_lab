/**
 * Session status for the symbol on screen.
 *
 * Answers two questions a price alone cannot: is this number live, and is
 * anything trading outside the regular session? Without it a stale Friday close
 * looks identical to a live quote, which is exactly the kind of thing that gets
 * acted on by mistake.
 *
 * Yahoo's per-symbol `marketState` is the authority for which session is live —
 * it already accounts for holidays and half-days, which our exchange registry
 * does not. The registry is used only for the "opens in" countdown.
 */

import { useEffect, useState } from 'react';
import { useStore } from '../state/store';
import {
  exchangeByCode, exchangeFromSymbol, isUnknownExchange, observedTradingDays, secondsUntilNextOpen,
} from '@shared/exchanges';
import type { Quote } from '@shared/types';

const TONE = {
  REGULAR: { dot: 'bg-up', text: 'text-up', label: 'Market open' },
  PRE: { dot: 'bg-yellow-400', text: 'text-yellow-400', label: 'Pre-market' },
  POST: { dot: 'bg-purple-400', text: 'text-purple-400', label: 'After hours' },
  CLOSED: { dot: 'bg-ink-faint', text: 'text-ink-faint', label: 'Market closed' },
} as const;

export default function MarketStatus() {
  const { quote, symbol, candles, meta } = useStore();
  // Re-render on a timer so the countdown ticks without a new quote.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!quote) return null;

  const state = quote.marketState;
  const tone = TONE[state] ?? TONE.CLOSED;

  // Which extended-hours print to surface, if any. Both stay populated after
  // their session ends, so prefer the one matching the current state and
  // otherwise fall back to the most recent.
  const extended = pickExtended(quote);

  return (
    <div className="flex items-center gap-2">
      <span className="flex items-center gap-1.5" title={statusTitle(quote, symbol, candles, meta?.exchange)}>
        <span className={`h-1.5 w-1.5 rounded-full ${tone.dot} ${state === 'REGULAR' ? 'animate-pulse' : ''}`} />
        <span className={`whitespace-nowrap text-[10px] ${tone.text}`}>{tone.label}</span>
      </span>

      {state === 'CLOSED' && (
        <span className="whitespace-nowrap text-[10px] text-ink-faint">
          {countdown(symbol, candles, meta?.exchange)}
        </span>
      )}

      {extended && (
        <span className="flex items-baseline gap-1 whitespace-nowrap border-l border-edge pl-2 text-[10px]">
          <span className="text-ink-faint">{extended.label}</span>
          <span className="tnum text-ink-dim">{fmt(extended.price, extended.price)}</span>
          <span className={`tnum ${extended.percent >= 0 ? 'text-up' : 'text-down'}`}>
            {extended.percent >= 0 ? '+' : ''}{fmt(extended.change, extended.price)} ({extended.percent >= 0 ? '+' : ''}
            {extended.percent.toFixed(2)}%)
          </span>
        </span>
      )}
    </div>
  );
}

interface Extended {
  label: string;
  price: number;
  change: number;
  percent: number;
}

/**
 * Choose which extended-hours print to show.
 *
 * During pre-market the pre figures are live. During after-hours the post
 * figures are. Overnight (Yahoo's `PREPRE`) neither session is running but the
 * previous evening's after-hours close is still the most recent trade, so it is
 * shown labelled as such rather than hidden.
 */
function pickExtended(q: Quote): Extended | null {
  if (!q.hasPrePostMarket) return null;

  const pre = q.preMarketPrice != null && q.preMarketChangePercent != null
    ? { label: 'Pre-market', price: q.preMarketPrice, change: q.preMarketChange ?? 0, percent: q.preMarketChangePercent, time: q.preMarketTime ?? 0 }
    : null;
  const post = q.postMarketPrice != null && q.postMarketChangePercent != null
    ? { label: 'After hours', price: q.postMarketPrice, change: q.postMarketChange ?? 0, percent: q.postMarketChangePercent, time: q.postMarketTime ?? 0 }
    : null;

  if (q.marketState === 'PRE' && pre) return pre;
  if (q.marketState === 'POST' && post) return post;
  if (q.marketState === 'REGULAR') return null; // the regular price is the live one

  if (!pre && !post) return null;
  if (!pre) return post;
  if (!post) return pre;
  return pre.time >= post.time ? pre : post;
}

/** Trading days derived from the symbol's own bars, as everywhere else. */
function exchangeFor(symbol: string, exchangeCode?: string) {
  // UNKNOWN is a real code meaning "unresolved", and its session runs all day —
  // trusting it would report every closed market as open.
  return isUnknownExchange(exchangeCode) ? exchangeFromSymbol(symbol) : exchangeByCode(exchangeCode!);
}

function countdown(symbol: string, candles: { time: number }[], exchangeCode?: string): string {
  const exchange = exchangeFor(symbol, exchangeCode);
  const days = observedTradingDays(candles as any, exchange.timezone, exchange.defaultTradingDays);
  const seconds = secondsUntilNextOpen(exchange, days);
  if (seconds <= 0) return '';
  return `opens in ${humanise(seconds)}`;
}

function statusTitle(q: Quote, symbol: string, candles: { time: number }[], exchangeCode?: string): string {
  const exchange = exchangeFor(symbol, exchangeCode);
  const zone = q.exchangeTimezoneName ? ` (${q.exchangeTimezoneName})` : '';
  const asOf = q.timestamp ? new Date(q.timestamp * 1000).toLocaleTimeString() : '';
  const base = `${exchange.label}${zone} · quote taken ${asOf}`;
  return q.marketState === 'REGULAR'
    ? `${base}\nRegular session is trading.`
    : `${base}\n${countdown(symbol, candles, exchangeCode) || 'Regular session is not trading.'}`;
}

function humanise(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/**
 * Precision comes from the instrument's price level, not from the magnitude of
 * the number being printed: a 0.16 move on a 305 stock is "+0.16", not
 * "+0.1600".
 */
function fmt(v: number, reference = v): string {
  const digits = Math.abs(reference) < 1 ? 4 : 2;
  return v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
