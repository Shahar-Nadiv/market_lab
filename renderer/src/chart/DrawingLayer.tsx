/**
 * The drawing overlay: a canvas above the chart, plus the mouse handling that
 * places, selects and edits drawings.
 *
 * ## How this coexists with the chart's own mouse handling
 *
 * lightweight-charts binds its pan/zoom listeners to its own canvas, which sits
 * inside the container. Rather than covering it with an interactive element —
 * which would kill panning — the canvas here is `pointer-events: none` and the
 * listeners are attached to the *container* in the **capture** phase. That runs
 * before the chart's own handlers, so this layer can decide, per event, whether
 * to consume it (a tool is active, or the user grabbed a drawing) or let it
 * fall through to the chart (ordinary panning). One decision point, no fighting
 * over the pointer.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { useStore } from '../state/store';
import type { Candle, Drawing, DrawingTool } from '@shared/types';
import { clicksNeeded, getTool, TEXT_TOOLS } from './drawings/catalogue';
import { makeProjection, type Point, type Projection, type Vec } from './drawings/projection';
import { drawOne, handleAt, hitTest, type RenderContext, type RenderTheme } from './drawings/render';
import { DARK, LIGHT, UP, DOWN } from './theme';

interface Props {
  chart: IChartApi;
  series: ISeriesApi<any>;
  container: HTMLDivElement;
  candles: Candle[];
  intraday: boolean;
}

/** A drawing being placed, before it has an id or a database row. */
interface Pending {
  tool: DrawingTool;
  points: Point[];
  /** Follows the cursor, so the shape previews before the next click lands. */
  cursor: Point | null;
}

type DragMode =
  | { kind: 'none' }
  | { kind: 'body'; id: number; grab: Point; original: Point[] }
  | { kind: 'handle'; id: number; index: number }
  | { kind: 'freehand'; points: Point[] };

export default function DrawingLayer({ chart, series, container, candles, intraday }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const {
    activeTool, drawings, selectedDrawingId, drawColor, drawWidth, magnet, settings,
    setActiveTool, selectDrawing, addDrawing, updateDrawing, deleteDrawing,
  } = useStore();

  const [pending, setPending] = useState<Pending | null>(null);
  const dragRef = useRef<DragMode>({ kind: 'none' });

  // Mouse handlers are bound once and must not close over stale state, so the
  // pieces they read live in refs alongside the React state that drives render.
  const stateRef = useRef({ activeTool, drawings, selectedDrawingId, drawColor, drawWidth, magnet, pending });
  stateRef.current = { activeTool, drawings, selectedDrawingId, drawColor, drawWidth, magnet, pending };

  const palette = settings.theme === 'light' ? LIGHT : DARK;
  const theme: RenderTheme = {
    text: palette.text,
    textDim: palette.crosshair,
    panel: settings.theme === 'light' ? 'rgba(255,255,255,0.92)' : 'rgba(19,23,29,0.92)',
    border: palette.border,
    up: UP,
    down: DOWN,
  };

  // -------------------------------------------------------------------------
  // Sizing — the canvas tracks the price pane, not the whole container, so
  // drawings never spill over the oscillator panes or the time axis.
  // -------------------------------------------------------------------------
  useLayoutEffect(() => {
    function measure() {
      let width = container.clientWidth;
      let height = container.clientHeight;
      try {
        const pane = chart.paneSize(0);
        if (pane?.width) width = pane.width;
        if (pane?.height) height = pane.height;
      } catch {
        // Older/newer API shape — the container size is a safe fallback.
      }
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    }
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);
    const t = window.setInterval(measure, 500); // catches pane splits, which fire no resize
    return () => {
      ro.disconnect();
      window.clearInterval(t);
    };
  }, [chart, container]);

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------
  const projectionRef = useRef<Projection | null>(null);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width === 0 || size.height === 0) return;

    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== size.width * dpr || canvas.height !== size.height * dpr) {
      canvas.width = size.width * dpr;
      canvas.height = size.height * dpr;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    if (candles.length === 0) return;

    const projection = makeProjection(chart, series, candles, size.width, size.height);
    projectionRef.current = projection;
    const rc: RenderContext = { ctx, projection, theme, candles, intraday };

    for (const d of stateRef.current.drawings) {
      drawOne(rc, d, d.id === stateRef.current.selectedDrawingId);
    }

    // Preview the in-progress shape using the same renderer, so what you see
    // while placing is exactly what you get once it lands.
    const p = stateRef.current.pending;
    if (p && p.cursor) {
      const preview = previewDrawing(p, stateRef.current.drawColor, stateRef.current.drawWidth);
      if (preview) drawOne(rc, preview, false);
    }
  }, [chart, series, candles, size, intraday, theme.text, theme.panel]);

  useEffect(() => {
    render();
  }, [render, drawings, selectedDrawingId, pending]);

  // Repaint whenever the chart moves under us.
  useEffect(() => {
    const timeScale = chart.timeScale();
    const onRange = () => render();
    timeScale.subscribeVisibleLogicalRangeChange(onRange);
    chart.subscribeCrosshairMove(onRange);
    return () => {
      timeScale.unsubscribeVisibleLogicalRangeChange(onRange);
      chart.unsubscribeCrosshairMove(onRange);
    };
  }, [chart, render]);

  // -------------------------------------------------------------------------
  // Mouse handling
  // -------------------------------------------------------------------------
  const toPoint = useCallback((e: MouseEvent): Point | null => {
    const projection = projectionRef.current;
    if (!projection) return null;
    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const time = projection.time(x);
    return {
      time: stateRef.current.magnet ? projection.snapTime(time) : time,
      price: projection.price(y),
    };
  }, [container]);

  const toVec = useCallback((e: MouseEvent): Vec => {
    const rect = container.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, [container]);

  const renderContext = useCallback((): RenderContext | null => {
    const canvas = canvasRef.current;
    const projection = projectionRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx || !projection) return null;
    return { ctx, projection, theme, candles, intraday };
  }, [candles, intraday, theme]);

  /** The topmost drawing under the cursor, so overlapping shapes pick sanely. */
  const drawingAt = useCallback((cursor: Vec): Drawing | null => {
    const rc = renderContext();
    if (!rc) return null;
    const list = stateRef.current.drawings;
    for (let i = list.length - 1; i >= 0; i--) {
      if (hitTest(rc, list[i], cursor)) return list[i];
    }
    return null;
  }, [renderContext]);

  const finish = useCallback(async (tool: DrawingTool, points: Point[]) => {
    const def = getTool(tool);
    let text = '';
    if (TEXT_TOOLS.has(tool)) {
      // eslint-disable-next-line no-alert
      text = window.prompt(tool === 'note' ? 'Note' : 'Text', '') ?? '';
      if (!text && tool === 'text') {
        setPending(null);
        return;
      }
    }

    // Position tools gain a stop handle so risk is editable straight away.
    let finalPoints = points;
    if ((tool === 'long_position' || tool === 'short_position') && points.length === 2) {
      const [entry, target] = points;
      finalPoints = [...points, { time: target.time, price: entry.price - (target.price - entry.price) / 2 }];
    }

    const saved = await addDrawing({
      tool,
      points: finalPoints,
      color: stateRef.current.drawColor,
      lineWidth: def?.defaults?.lineWidth ?? stateRef.current.drawWidth,
      text,
      props: { ...(def?.defaults ?? {}) },
    });
    setPending(null);
    // One shape per click of a tool, then back to the cursor — matching how
    // TradingView behaves unless the tool is explicitly pinned.
    setActiveTool('cursor');
    if (saved) selectDrawing(saved.id);
  }, [addDrawing, setActiveTool, selectDrawing]);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (e.button !== 0) return;
      const { activeTool: tool } = stateRef.current;
      const point = toPoint(e);
      const cursor = toVec(e);
      if (!point) return;

      // --- eraser ---------------------------------------------------------
      if (tool === 'eraser') {
        const hit = drawingAt(cursor);
        if (hit) void deleteDrawing(hit.id);
        e.stopPropagation();
        e.preventDefault();
        return;
      }

      // --- cursor: select, or grab a handle / body ------------------------
      if (tool === 'cursor') {
        const rc = renderContext();
        const selected = stateRef.current.drawings.find((d) => d.id === stateRef.current.selectedDrawingId);

        if (rc && selected && !selected.props.locked) {
          const h = handleAt(rc, selected, cursor);
          if (h >= 0) {
            dragRef.current = { kind: 'handle', id: selected.id, index: h };
            e.stopPropagation();
            e.preventDefault();
            return;
          }
        }

        const hit = drawingAt(cursor);
        if (hit) {
          selectDrawing(hit.id);
          dragRef.current = { kind: 'body', id: hit.id, grab: point, original: hit.points.map((p) => ({ ...p })) };
          e.stopPropagation();
          e.preventDefault();
          return;
        }
        // Nothing under the cursor: clear the selection and let the chart pan.
        if (stateRef.current.selectedDrawingId != null) selectDrawing(null);
        return;
      }

      // --- placing a drawing ----------------------------------------------
      const def = getTool(tool);
      if (!def) return;
      e.stopPropagation();
      e.preventDefault();

      if (def.points === 'freehand') {
        dragRef.current = { kind: 'freehand', points: [point] };
        setPending({ tool: tool as DrawingTool, points: [point], cursor: point });
        return;
      }

      const current = stateRef.current.pending;
      const points = current && current.tool === tool ? [...current.points, point] : [point];

      if (def.points === 'open') {
        setPending({ tool: tool as DrawingTool, points, cursor: point });
        return;
      }

      if (points.length >= clicksNeeded(tool)) {
        void finish(tool as DrawingTool, points);
      } else {
        setPending({ tool: tool as DrawingTool, points, cursor: point });
      }
    }

    function onMouseMove(e: MouseEvent) {
      const point = toPoint(e);
      if (!point) return;
      const drag = dragRef.current;

      if (drag.kind === 'freehand') {
        // Thin the path: a point per pixel would bloat the row for no fidelity.
        const last = drag.points[drag.points.length - 1];
        const projection = projectionRef.current!;
        if (Math.hypot(projection.x(point.time) - projection.x(last.time), projection.y(point.price) - projection.y(last.price)) > 3) {
          drag.points.push(point);
          setPending({ tool: stateRef.current.activeTool as DrawingTool, points: [...drag.points], cursor: point });
        }
        e.stopPropagation();
        return;
      }

      if (drag.kind === 'handle') {
        const d = stateRef.current.drawings.find((x) => x.id === drag.id);
        if (d) {
          const points = [...d.points];
          // Position tools have an implicit third point; materialise it on grab.
          while (points.length <= drag.index) points.push({ ...points[points.length - 1] });
          points[drag.index] = point;
          updateDrawing(drag.id, { points }, false);
        }
        e.stopPropagation();
        e.preventDefault();
        return;
      }

      if (drag.kind === 'body') {
        const dt = point.time - drag.grab.time;
        const dp = point.price - drag.grab.price;
        updateDrawing(
          drag.id,
          { points: drag.original.map((p) => ({ time: p.time + dt, price: p.price + dp })) },
          false,
        );
        e.stopPropagation();
        e.preventDefault();
        return;
      }

      // Preview the next segment while placing.
      const p = stateRef.current.pending;
      if (p) setPending({ ...p, cursor: point });
    }

    function onMouseUp(e: MouseEvent) {
      const drag = dragRef.current;
      dragRef.current = { kind: 'none' };

      if (drag.kind === 'freehand') {
        const tool = stateRef.current.activeTool as DrawingTool;
        if (drag.points.length >= 2) void finish(tool, drag.points);
        else setPending(null);
        e.stopPropagation();
        return;
      }

      if (drag.kind === 'handle' || drag.kind === 'body') {
        // One database write per gesture, not per frame.
        const d = stateRef.current.drawings.find((x) => x.id === drag.id);
        if (d) updateDrawing(d.id, { points: d.points }, true);
      }
    }

    function onDoubleClick(e: MouseEvent) {
      const p = stateRef.current.pending;
      const def = getTool(stateRef.current.activeTool);
      if (p && def?.points === 'open' && p.points.length >= 2) {
        void finish(p.tool, p.points);
        e.stopPropagation();
        e.preventDefault();
      }
    }

    container.addEventListener('mousedown', onMouseDown, true);
    container.addEventListener('mousemove', onMouseMove, true);
    container.addEventListener('dblclick', onDoubleClick, true);
    window.addEventListener('mouseup', onMouseUp, true);
    return () => {
      container.removeEventListener('mousedown', onMouseDown, true);
      container.removeEventListener('mousemove', onMouseMove, true);
      container.removeEventListener('dblclick', onDoubleClick, true);
      window.removeEventListener('mouseup', onMouseUp, true);
    };
  }, [container, toPoint, toVec, drawingAt, renderContext, deleteDrawing, selectDrawing, updateDrawing, finish]);

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      if (e.key === 'Escape') {
        if (stateRef.current.pending) setPending(null);
        else if (stateRef.current.activeTool !== 'cursor') setActiveTool('cursor');
        else selectDrawing(null);
        return;
      }
      if (e.key === 'Enter' && stateRef.current.pending) {
        const p = stateRef.current.pending;
        if (p.points.length >= 2) void finish(p.tool, p.points);
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && stateRef.current.selectedDrawingId != null) {
        e.preventDefault();
        void deleteDrawing(stateRef.current.selectedDrawingId);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setActiveTool, selectDrawing, deleteDrawing, finish]);

  // Cursor affordance: a crosshair while a tool is armed.
  useEffect(() => {
    const cursor = activeTool === 'cursor' ? '' : activeTool === 'eraser' ? 'not-allowed' : 'crosshair';
    container.style.cursor = cursor;
    return () => {
      container.style.cursor = '';
    };
  }, [activeTool, container]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute left-0 top-0 z-[5]"
      style={{ width: size.width, height: size.height }}
    />
  );
}

/** Wrap an in-progress placement in a Drawing so the real renderer can draw it. */
function previewDrawing(pending: Pending, color: string, lineWidth: number): Drawing | null {
  const def = getTool(pending.tool);
  if (!def) return null;

  const points = [...pending.points];
  const needed = typeof def.points === 'number' ? def.points : points.length + 1;
  if (pending.cursor && points.length < needed) points.push(pending.cursor);
  // A shape short of its full point count still previews, by repeating the
  // cursor — better than showing nothing until the last click.
  while (points.length < needed) points.push(pending.cursor ?? points[points.length - 1]);
  if (points.length < 1) return null;

  return {
    id: -1,
    symbol: '',
    tool: pending.tool,
    points,
    color,
    lineWidth: def.defaults?.lineWidth ?? lineWidth,
    text: '',
    props: { ...(def.defaults ?? {}) },
    createdAt: 0,
  };
}
