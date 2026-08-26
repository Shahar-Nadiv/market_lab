/**
 * Watchlist with live quotes.
 *
 * Quotes refresh on a timer while the app is open; a failed refresh leaves the
 * previous values in place rather than blanking the list.
 */

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { formatPrice } from '../chart/data';

/** Which inline editor the header is showing, if any. */
type Editing = { mode: 'create' | 'rename'; value: string } | null;

export default function Watchlist({ onSearch }: { onSearch: () => void }) {
  const {
    watchlists, activeWatchlistId, watchlistItems, watchlistQuotes,
    selectWatchlist, createWatchlist, renameWatchlist, deleteWatchlist,
    removeFromWatchlist, refreshWatchlistQuotes,
    symbol, setSymbol, settings,
  } = useStore();

  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const editRef = useRef<HTMLInputElement>(null);

  const active = watchlists.find((w) => w.id === activeWatchlistId) ?? null;

  useEffect(() => {
    const ms = Math.max(15, settings.alertPollSeconds) * 1000;
    const t = setInterval(() => void refreshWatchlistQuotes(), ms);
    return () => clearInterval(t);
  }, [settings.alertPollSeconds, refreshWatchlistQuotes]);

  useEffect(() => {
    if (editing) editRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  async function commitEdit() {
    if (!editing) return;
    const name = editing.value.trim();
    setEditing(null);
    if (!name) return;
    if (editing.mode === 'create') await createWatchlist(name);
    else if (active) await renameWatchlist(active.id, name);
  }

  async function confirmDelete() {
    setMenuOpen(false);
    if (!active) return;
    const count = watchlistItems.length;
    const message = count
      ? `Delete "${active.name}" and its ${count} symbol${count === 1 ? '' : 's'}?`
      : `Delete "${active.name}"?`;
    // eslint-disable-next-line no-alert
    if (!window.confirm(message)) return;
    await deleteWatchlist(active.id);
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={headerRef} className="relative border-b border-edge px-2 py-1.5">
        {editing ? (
          <input
            ref={editRef}
            value={editing.value}
            onChange={(e) => setEditing({ ...editing, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitEdit();
              if (e.key === 'Escape') setEditing(null);
            }}
            onBlur={() => void commitEdit()}
            placeholder={editing.mode === 'create' ? 'New list name' : 'List name'}
            className="w-full rounded border border-accent bg-panel-2 px-1.5 py-0.5 text-[11px] outline-none"
          />
        ) : (
          <div className="flex items-center gap-1">
            <select
              value={activeWatchlistId ?? ''}
              onChange={(e) => void selectWatchlist(Number(e.target.value))}
              title={`${watchlists.length} list${watchlists.length === 1 ? '' : 's'}`}
              className="min-w-0 flex-1 rounded border border-edge bg-panel-2 px-1.5 py-0.5 text-[11px] outline-none focus:border-accent"
            >
              {watchlists.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
            <button
              onClick={onSearch}
              title="Add symbol to this list"
              className="rounded border border-edge px-1.5 py-0.5 text-[11px] text-ink-dim hover:border-accent hover:text-ink"
            >
              +
            </button>
            <button
              onClick={() => setMenuOpen((o) => !o)}
              title="Manage lists"
              className="rounded border border-edge px-1.5 py-0.5 text-[11px] leading-none text-ink-dim hover:border-accent hover:text-ink"
            >
              ⋯
            </button>
          </div>
        )}

        {menuOpen && (
          <div className="absolute right-2 top-full z-40 mt-1 w-44 rounded border border-edge bg-panel py-1 shadow-xl">
            <MenuItem
              label="New list…"
              onClick={() => {
                setMenuOpen(false);
                setEditing({ mode: 'create', value: '' });
              }}
            />
            <MenuItem
              label="Rename this list…"
              disabled={!active}
              onClick={() => {
                setMenuOpen(false);
                if (active) setEditing({ mode: 'rename', value: active.name });
              }}
            />
            <MenuItem
              label="Duplicate this list"
              disabled={!active}
              onClick={async () => {
                setMenuOpen(false);
                if (!active) return;
                // Capture the symbols before the selection moves to the copy.
                const symbols = watchlistItems.map((i) => i.symbol);
                await createWatchlist(`${active.name} copy`);
                for (const s of symbols) await useStore.getState().addToWatchlist(s);
              }}
            />
            <div className="my-1 h-px bg-edge" />
            <MenuItem label="Delete this list" tone="danger" disabled={!active} onClick={confirmDelete} />
          </div>
        )}
      </div>

      <ul className="flex-1 overflow-auto">
        {watchlistItems.length === 0 && (
          <li className="px-3 py-6 text-center text-[11px] leading-relaxed text-ink-faint">
            This list is empty. Press <kbd className="rounded bg-panel-2 px-1">+</kbd> or{' '}
            <kbd className="rounded bg-panel-2 px-1">/</kbd> to search, then use the{' '}
            <kbd className="rounded bg-panel-2 px-1">+</kbd> on a result to add it here.
          </li>
        )}

        {watchlistItems.map((item) => {
          const q = watchlistQuotes[item.symbol];
          const pct = q?.changePercent ?? null;
          const up = (pct ?? 0) >= 0;
          const active = item.symbol === symbol;
          return (
            <li key={item.id} className={`group ${active ? 'bg-panel-2' : ''}`}>
              <div
                role="button"
                tabIndex={0}
                onClick={() => void setSymbol(item.symbol)}
                onKeyDown={(e) => e.key === 'Enter' && void setSymbol(item.symbol)}
                className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 hover:bg-panel-2"
              >
                <span className={`w-0.5 self-stretch rounded ${active ? 'bg-accent' : 'bg-transparent'}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] font-medium">{item.symbol}</span>
                </span>
                <span className="shrink-0 text-right tnum text-[11px]">
                  {formatPrice(q?.price)}
                </span>
                <span className={`w-16 shrink-0 text-right tnum text-[11px] ${pct == null ? 'text-ink-faint' : up ? 'text-up' : 'text-down'}`}>
                  {pct == null ? '—' : `${up ? '+' : ''}${pct.toFixed(2)}%`}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeFromWatchlist(item.id);
                  }}
                  title="Remove"
                  className="shrink-0 text-[11px] text-transparent group-hover:text-ink-faint hover:!text-down"
                >
                  ×
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function MenuItem({
  label, onClick, disabled, tone,
}: {
  label: string;
  onClick: () => void | Promise<void>;
  disabled?: boolean;
  tone?: 'danger';
}) {
  return (
    <button
      onClick={() => void onClick()}
      disabled={disabled}
      className={`block w-full px-2.5 py-1.5 text-left text-[11px] disabled:opacity-40 ${
        tone === 'danger' ? 'text-ink-dim hover:bg-panel-2 hover:text-down' : 'text-ink-dim hover:bg-panel-2 hover:text-ink'
      }`}
    >
      {label}
    </button>
  );
}
