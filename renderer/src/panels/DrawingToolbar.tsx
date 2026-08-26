/**
 * The drawing tool rail down the left of the chart.
 *
 * One button per group, showing the group's most recently used tool, with a
 * flyout listing the rest — the same shape TradingView uses, and the reason a
 * rail of eight buttons can reach thirty tools without becoming a wall of
 * icons. Everything here is generated from the tool catalogue.
 */

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import {
  DEFAULT_COLORS, GROUP_LABEL, GROUP_ORDER, TOOLS, getTool, toolsInGroup,
  type ToolDef, type ToolGroup,
} from '../chart/drawings/catalogue';
import type { ActiveTool } from '@shared/types';

const WIDTHS = [1, 2, 3, 4];

export default function DrawingToolbar() {
  const {
    activeTool, setActiveTool, drawings, selectedDrawingId, drawColor, drawWidth, magnet,
    setDrawStyle, toggleMagnet, deleteDrawing, clearDrawings, patchDrawingProps,
  } = useStore();

  /** Last tool picked from each group, so the rail button remembers it. */
  const [lastUsed, setLastUsed] = useState<Record<string, ActiveTool>>(() => {
    const out: Record<string, ActiveTool> = {};
    for (const g of GROUP_ORDER) out[g] = toolsInGroup(g)[0]?.id ?? 'cursor';
    return out;
  });
  const [openGroup, setOpenGroup] = useState<ToolGroup | null>(null);
  const [styleOpen, setStyleOpen] = useState(false);
  const railRef = useRef<HTMLDivElement>(null);

  const selected = drawings.find((d) => d.id === selectedDrawingId) ?? null;

  useEffect(() => {
    if (!openGroup && !styleOpen) return;
    function onDown(e: MouseEvent) {
      if (railRef.current && !railRef.current.contains(e.target as Node)) {
        setOpenGroup(null);
        setStyleOpen(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [openGroup, styleOpen]);

  function pick(tool: ActiveTool) {
    const def = getTool(tool);
    if (def) setLastUsed((m) => ({ ...m, [def.group]: tool }));
    setActiveTool(tool);
    setOpenGroup(null);
  }

  // Number keys jump straight to a group's remembered tool.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > GROUP_ORDER.length) return;
      pick(lastUsed[GROUP_ORDER[n - 1]]);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lastUsed]);

  return (
    <div ref={railRef} className="relative flex w-11 shrink-0 flex-col items-center gap-0.5 border-r border-edge bg-panel py-1.5">
      {GROUP_ORDER.map((group, i) => {
        const current = getTool(lastUsed[group]) ?? toolsInGroup(group)[0];
        const groupTools = toolsInGroup(group);
        const isActive = groupTools.some((t) => t.id === activeTool);

        return (
          <div key={group} className="relative">
            <button
              onClick={() => pick(current.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setOpenGroup(openGroup === group ? null : group);
              }}
              title={`${GROUP_LABEL[group]} — ${current.label}  (${i + 1})\nRight-click, or use the arrow, for the full list`}
              className={`relative flex h-8 w-8 items-center justify-center rounded ${
                isActive ? 'bg-accent/15 text-accent ring-1 ring-accent/40' : 'text-ink-dim hover:bg-panel-2 hover:text-ink'
              }`}
            >
              <ToolIcon def={current} />
              {groupTools.length > 1 && (
                <span
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenGroup(openGroup === group ? null : group);
                  }}
                  className="absolute bottom-0 right-0 h-0 w-0 border-b-[5px] border-l-[5px] border-b-current border-l-transparent opacity-60"
                />
              )}
            </button>

            {openGroup === group && (
              <div className="absolute left-full top-0 z-50 ml-1 w-60 rounded border border-edge bg-panel py-1 shadow-xl">
                <div className="px-2.5 py-1 text-[10px] uppercase tracking-wide text-ink-faint">
                  {GROUP_LABEL[group]}
                </div>
                {groupTools.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => pick(t.id)}
                    title={t.hint}
                    className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[11px] ${
                      t.id === activeTool ? 'bg-accent/15 text-accent' : 'text-ink-dim hover:bg-panel-2 hover:text-ink'
                    }`}
                  >
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center"><ToolIcon def={t} size={16} /></span>
                    {t.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <div className="my-1 h-px w-6 bg-edge" />

      {/* --- style ---------------------------------------------------------- */}
      <button
        onClick={() => setStyleOpen((o) => !o)}
        title={selected ? 'Restyle the selected drawing' : 'Style for new drawings'}
        className="flex h-8 w-8 items-center justify-center rounded text-ink-dim hover:bg-panel-2 hover:text-ink"
      >
        <span className="h-4 w-4 rounded-full border border-edge" style={{ background: selected?.color ?? drawColor }} />
      </button>

      {styleOpen && (
        <div className="absolute left-full top-0 z-50 ml-1 w-52 rounded border border-edge bg-panel p-2 shadow-xl">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-ink-faint">
            {selected ? 'Selected drawing' : 'New drawings'}
          </div>
          <div className="grid grid-cols-5 gap-1">
            {DEFAULT_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setDrawStyle({ color: c })}
                className={`h-5 w-5 rounded border ${
                  (selected?.color ?? drawColor) === c ? 'border-accent ring-1 ring-accent' : 'border-edge'
                }`}
                style={{ background: c }}
                title={c}
              />
            ))}
          </div>

          <div className="mt-2 flex items-center gap-1">
            {WIDTHS.map((w) => (
              <button
                key={w}
                onClick={() => setDrawStyle({ width: w })}
                className={`flex h-6 flex-1 items-center justify-center rounded ${
                  (selected?.lineWidth ?? drawWidth) === w ? 'bg-accent/15 ring-1 ring-accent/40' : 'hover:bg-panel-2'
                }`}
                title={`${w}px`}
              >
                <span className="w-4 rounded bg-ink-dim" style={{ height: w }} />
              </button>
            ))}
          </div>

          {selected && (
            <div className="mt-2 space-y-1 border-t border-edge pt-2">
              <select
                value={selected.props.lineStyle ?? 'solid'}
                onChange={(e) => patchDrawingProps(selected.id, { lineStyle: e.target.value as any })}
                className="w-full rounded border border-edge bg-panel-2 px-1.5 py-1 text-[11px] outline-none focus:border-accent"
              >
                <option value="solid">Solid</option>
                <option value="dashed">Dashed</option>
                <option value="dotted">Dotted</option>
              </select>
              <label className="flex items-center gap-2 text-[11px] text-ink-dim">
                <input
                  type="checkbox"
                  checked={!!selected.props.locked}
                  onChange={(e) => patchDrawingProps(selected.id, { locked: e.target.checked })}
                />
                Lock (ignore clicks)
              </label>
              <button
                onClick={() => void deleteDrawing(selected.id)}
                className="w-full rounded border border-edge px-2 py-1 text-[11px] text-ink-dim hover:border-down hover:text-down"
              >
                Delete drawing
              </button>
            </div>
          )}
        </div>
      )}

      <button
        onClick={toggleMagnet}
        title="Magnet — snap new points to the nearest bar"
        className={`flex h-8 w-8 items-center justify-center rounded text-[13px] ${
          magnet ? 'bg-accent/15 text-accent ring-1 ring-accent/40' : 'text-ink-dim hover:bg-panel-2 hover:text-ink'
        }`}
      >
        <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M5 3v7a5 5 0 0010 0V3h-3v7a2 2 0 01-4 0V3z" />
        </svg>
      </button>

      <button
        onClick={() => void clearDrawings()}
        disabled={drawings.length === 0}
        title={drawings.length ? `Remove all ${drawings.length} drawings on this symbol` : 'No drawings to remove'}
        className="flex h-8 w-8 items-center justify-center rounded text-ink-dim hover:bg-panel-2 hover:text-down disabled:opacity-30"
      >
        <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M4 6h12M8 6V4h4v2M6 6l1 10h6l1-10" />
        </svg>
      </button>

      {drawings.length > 0 && (
        <span className="mt-0.5 text-[9px] tabular-nums text-ink-faint" title="Drawings on this symbol">
          {drawings.length}
        </span>
      )}
    </div>
  );
}

function ToolIcon({ def, size = 18 }: { def: ToolDef; size?: number }) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round">
      <path d={def.icon} />
    </svg>
  );
}

/** Exposed for tests and the keyboard help sheet. */
export const TOOL_COUNT = TOOLS.length;
