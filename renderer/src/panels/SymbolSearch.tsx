/**
 * Symbol search with a ranked type-ahead.
 *
 * Results are merged in the main process: your own history first (scored by
 * recency x frequency), then locally cached symbols and seeded indices, then
 * Yahoo. Local hits appear with no network round-trip, so the symbols you
 * actually watch resolve instantly.
 */

import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../state/store';
import type { SearchResult } from '@shared/types';

export default function SymbolSearch({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const setSymbol = useStore((s) => s.setSymbol);
  const addToWatchlist = useStore((s) => s.addToWatchlist);
  const watchlists = useStore((s) => s.watchlists);
  const activeWatchlistId = useStore((s) => s.activeWatchlistId);
  const watchlistItems = useStore((s) => s.watchlistItems);

  const activeList = watchlists.find((w) => w.id === activeWatchlistId) ?? null;
  const inList = new Set(watchlistItems.map((i) => i.symbol));

  useEffect(() => inputRef.current?.focus(), []);

  // Debounced: the remote leg of the search should not fire on every keystroke.
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const r = (await api.searchSymbols(query)) as SearchResult[];
        if (!cancelled) {
          setResults(r);
          setSelected(0);
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, query ? 180 : 0);

    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  async function choose(r: SearchResult) {
    await setSymbol(r.symbol);
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = results[selected];
      // Enter on a free-typed ticker should still work even with no matches.
      if (hit) void choose(hit);
      else if (query.trim()) void setSymbol(query).then(onClose);
    } else if (e.key === 'Escape') {
      onClose();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]" onClick={onClose}>
      <div
        className="w-[560px] overflow-hidden rounded-lg border border-edge bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search symbol — AAPL, SPY, TEVA.TA, ^GSPC, TA35.TA…"
          className="w-full border-b border-edge bg-transparent px-4 py-3 text-sm outline-none placeholder:text-ink-faint"
        />

        <ul className="max-h-[52vh] overflow-auto py-1">
          {results.length === 0 && (
            <li className="px-4 py-6 text-center text-xs text-ink-faint">
              {busy ? 'Searching…' : query ? 'No matches. Press Enter to load this ticker anyway.' : 'Start typing to search.'}
            </li>
          )}
          {results.map((r, i) => (
            <li key={r.symbol}>
              <button
                onMouseEnter={() => setSelected(i)}
                onClick={() => void choose(r)}
                className={`flex w-full items-center gap-3 px-4 py-2 text-left ${
                  i === selected ? 'bg-panel-2' : ''
                }`}
              >
                <span className="w-28 shrink-0 truncate text-xs font-medium">{r.symbol}</span>
                <span className="flex-1 truncate text-xs text-ink-dim">{r.name}</span>
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-ink-faint">{r.quoteType}</span>
                <span className="w-24 shrink-0 truncate text-right text-[10px] text-ink-faint">{r.exchange}</span>
                {r.origin === 'history' && (
                  <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-accent">
                    recent
                  </span>
                )}
                {/* Adding is a distinct action from opening: the row opens the
                    symbol, this adds it to the list without leaving the search. */}
                <span
                  role="button"
                  tabIndex={0}
                  title={
                    inList.has(r.symbol)
                      ? `Already in ${activeList?.name ?? 'this list'}`
                      : `Add to ${activeList?.name ?? 'watchlist'}`
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!inList.has(r.symbol)) void addToWatchlist(r.symbol);
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && e.stopPropagation()}
                  className={`shrink-0 rounded px-1.5 py-0.5 ${
                    inList.has(r.symbol)
                      ? 'text-up'
                      : 'text-ink-faint hover:bg-panel hover:text-accent'
                  }`}
                >
                  {inList.has(r.symbol) ? '✓' : '+'}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-3 border-t border-edge px-4 py-1.5 text-[10px] text-ink-faint">
          <span>↑↓ navigate</span>
          <span>↵ open on chart</span>
          <span>
            <kbd className="rounded bg-panel-2 px-1">+</kbd> add to{' '}
            <span className="text-ink-dim">{activeList?.name ?? 'watchlist'}</span>
          </span>
          <span className="ml-auto">esc close</span>
        </div>
      </div>
    </div>
  );
}
