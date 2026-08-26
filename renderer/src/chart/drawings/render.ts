/**
 * Drawing rendering.
 *
 * One canvas, redrawn whenever the chart moves. Each tool gets a case in
 * `drawOne`; everything shared — stroking, filling, labels, selection handles —
 * lives in the helpers above it, so a new tool is usually a dozen lines.
 *
 * Rendering is deliberately stateless: given a drawing and a projection it
 * paints, and nothing else. Interaction state (what is selected, what is being
 * dragged) is passed in rather than held here.
 */

import type { Candle, Drawing } from '@shared/types';
import { FIB_LEVELS } from './catalogue';
import {
  distanceToLine, distanceToRay, distanceToSegment, extendRay, extendToBounds,
  type Projection, type Vec,
} from './projection';

export interface RenderTheme {
  text: string;
  textDim: string;
  panel: string;
  border: string;
  up: string;
  down: string;
}

export interface RenderContext {
  ctx: CanvasRenderingContext2D;
  projection: Projection;
  theme: RenderTheme;
  candles: Candle[];
  /** Bar interval in seconds, for elapsed-time readouts. */
  intraday: boolean;
}

const HANDLE = 4;
/** How close a click has to be, in pixels, to count as hitting a drawing. */
export const HIT_TOLERANCE = 7;

// ---------------------------------------------------------------------------
// Painting helpers
// ---------------------------------------------------------------------------

function applyStroke(rc: RenderContext, d: Drawing): void {
  const { ctx } = rc;
  ctx.strokeStyle = d.color;
  ctx.lineWidth = d.lineWidth || 1;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const style = d.props.lineStyle ?? 'solid';
  ctx.setLineDash(style === 'dashed' ? [6, 4] : style === 'dotted' ? [1, 3] : []);
}

function fillStyle(d: Drawing): string {
  const base = d.props.fill ?? d.color;
  const alpha = d.props.fillOpacity ?? 0.12;
  return withAlpha(base, alpha);
}

/** Apply an alpha to a hex or rgb colour without a colour library. */
export function withAlpha(color: string, alpha: number): string {
  if (color.startsWith('rgba')) return color.replace(/[\d.]+\)$/, `${alpha})`);
  if (color.startsWith('rgb(')) return color.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`);
  const hex = color.replace('#', '');
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function line(rc: RenderContext, a: Vec, b: Vec): void {
  rc.ctx.beginPath();
  rc.ctx.moveTo(a.x, a.y);
  rc.ctx.lineTo(b.x, b.y);
  rc.ctx.stroke();
}

function poly(rc: RenderContext, pts: Vec[], close = false): void {
  if (pts.length < 2) return;
  rc.ctx.beginPath();
  rc.ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) rc.ctx.lineTo(pts[i].x, pts[i].y);
  if (close) rc.ctx.closePath();
  rc.ctx.stroke();
}

function arrowHead(rc: RenderContext, from: Vec, to: Vec, size = 9): void {
  const { ctx } = rc;
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - size * Math.cos(angle - Math.PI / 7), to.y - size * Math.sin(angle - Math.PI / 7));
  ctx.lineTo(to.x - size * Math.cos(angle + Math.PI / 7), to.y - size * Math.sin(angle + Math.PI / 7));
  ctx.closePath();
  ctx.fillStyle = ctx.strokeStyle as string;
  ctx.fill();
}

type LabelAlign = 'left' | 'center' | 'right';

/** A small rounded chip of text, used for every readout on the chart. */
function chip(
  rc: RenderContext,
  text: string,
  x: number,
  y: number,
  opts: { align?: LabelAlign; bg?: string; fg?: string; size?: number; below?: boolean } = {},
): void {
  const { ctx, theme } = rc;
  const size = opts.size ?? 11;
  const padX = 5;
  const padY = 3;
  ctx.font = `${size}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.setLineDash([]);

  const lines = text.split('\n');
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + padX * 2;
  const lineH = size + 3;
  const h = lines.length * lineH + padY * 2 - 3;

  const align = opts.align ?? 'left';
  const bx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
  const by = opts.below ? y : y - h / 2;

  ctx.fillStyle = opts.bg ?? theme.panel;
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = 1;
  roundRect(ctx, bx, by, w, h, 3);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = opts.fg ?? theme.text;
  ctx.textAlign = 'left';
  lines.forEach((l, i) => ctx.fillText(l, bx + padX, by + padY + lineH * i + lineH / 2 - 1.5));
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

export function drawHandles(rc: RenderContext, pts: Vec[], color: string): void {
  const { ctx } = rc;
  ctx.setLineDash([]);
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.rect(p.x - HANDLE, p.y - HANDLE, HANDLE * 2, HANDLE * 2);
    ctx.fill();
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// Readout formatting
// ---------------------------------------------------------------------------

function fmtPrice(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toFixed(2);
  if (abs >= 1) return v.toFixed(2);
  return v.toFixed(4);
}

function fmtSigned(v: number): string {
  return `${v >= 0 ? '+' : ''}${fmtPrice(v)}`;
}

function fmtDuration(seconds: number): string {
  const s = Math.abs(seconds);
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(s < 36000 ? 1 : 0)}h`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d`;
  if (s < 86400 * 365) return `${(s / (86400 * 30)).toFixed(1)}mo`;
  return `${(s / (86400 * 365)).toFixed(1)}y`;
}

/** The standard change readout shared by the measure and info tools. */
function changeText(rc: RenderContext, a: { time: number; price: number }, b: { time: number; price: number }): string {
  const delta = b.price - a.price;
  const pct = a.price !== 0 ? (delta / a.price) * 100 : 0;
  const bars = Math.abs(rc.projection.barsBetween(a.time, b.time));
  return `${fmtSigned(delta)}  (${fmtSigned(pct)}%)\n${bars} bars, ${fmtDuration(b.time - a.time)}`;
}

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

export function drawOne(rc: RenderContext, d: Drawing, selected: boolean): void {
  if (d.props.hidden) return;

  const { ctx, projection: p, theme } = rc;
  const pts: Vec[] = d.points.map((pt) => ({ x: p.x(pt.time), y: p.y(pt.price) }));
  if (pts.some((v) => !Number.isFinite(v.x) || !Number.isFinite(v.y))) return;

  const W = p.width;
  const H = p.height;
  ctx.save();
  ctx.globalAlpha = d.props.locked ? 0.6 : 1;
  applyStroke(rc, d);

  const [a, b, c, dd] = pts;

  switch (d.tool) {
    // --- straight lines ----------------------------------------------------
    case 'trendline':
      line(rc, a, b);
      break;

    case 'ray':
      line(rc, a, extendRay(a, b, W, H));
      break;

    case 'extended': {
      const [s, e] = extendToBounds(a, b, W, H);
      line(rc, s, e);
      break;
    }

    case 'info_line':
      line(rc, a, b);
      if (d.props.showLabels !== false) {
        chip(rc, changeText(rc, d.points[0], d.points[1]), (a.x + b.x) / 2, (a.y + b.y) / 2 - 18, { align: 'center' });
      }
      break;

    case 'trend_angle': {
      line(rc, a, b);
      // A horizontal reference from the anchor, plus the swept wedge between
      // it and the line, is what makes the number mean something at a glance.
      const forward = b.x >= a.x;
      const reference = forward ? 0 : Math.PI;
      const heading = Math.atan2(b.y - a.y, b.x - a.x);
      // Signed shortest sweep from the reference to the line, so the arc is a
      // wedge rather than the long way round the circle.
      let sweep = heading - reference;
      while (sweep > Math.PI) sweep -= 2 * Math.PI;
      while (sweep < -Math.PI) sweep += 2 * Math.PI;

      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = theme.textDim;
      ctx.lineWidth = 1;
      line(rc, a, { x: a.x + (forward ? 60 : -60), y: a.y });
      ctx.beginPath();
      ctx.arc(a.x, a.y, 34, reference, reference + sweep, sweep < 0);
      ctx.stroke();
      ctx.restore();

      if (d.props.showLabels !== false) {
        // Canvas y grows downward, so an upward line is a negative sweep.
        const degrees = (-sweep * 180) / Math.PI;
        chip(rc, `${degrees.toFixed(1)}°`, a.x + (forward ? 44 : -44), a.y - 18, {
          align: forward ? 'left' : 'right',
        });
      }
      break;
    }

    case 'hline':
      line(rc, { x: 0, y: a.y }, { x: W, y: a.y });
      chip(rc, fmtPrice(d.points[0].price), W - 4, a.y, { align: 'right', bg: d.color, fg: '#fff' });
      break;

    case 'hray':
      line(rc, a, { x: W, y: a.y });
      chip(rc, fmtPrice(d.points[0].price), W - 4, a.y, { align: 'right', bg: d.color, fg: '#fff' });
      break;

    case 'vline':
      line(rc, { x: a.x, y: 0 }, { x: a.x, y: H });
      break;

    case 'crossline':
      line(rc, { x: 0, y: a.y }, { x: W, y: a.y });
      line(rc, { x: a.x, y: 0 }, { x: a.x, y: H });
      chip(rc, fmtPrice(d.points[0].price), W - 4, a.y, { align: 'right', bg: d.color, fg: '#fff' });
      break;

    // --- channels ----------------------------------------------------------
    case 'parallel_channel': {
      // Third point sets the channel width; the second line stays parallel.
      const dy = c.y - projectOntoLine(c, a, b).y;
      const a2 = { x: a.x, y: a.y + dy };
      const b2 = { x: b.x, y: b.y + dy };
      ctx.fillStyle = fillStyle(d);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(b2.x, b2.y);
      ctx.lineTo(a2.x, a2.y);
      ctx.closePath();
      ctx.fill();
      line(rc, a, b);
      line(rc, a2, b2);
      break;
    }

    case 'disjoint_channel': {
      ctx.fillStyle = fillStyle(d);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(dd.x, dd.y);
      ctx.lineTo(c.x, c.y);
      ctx.closePath();
      ctx.fill();
      line(rc, a, b);
      line(rc, c, dd);
      break;
    }

    // --- fibonacci ---------------------------------------------------------
    case 'fib_retracement': {
      const levels = d.props.levels ?? FIB_LEVELS;
      const p0 = d.points[0].price;
      const p1 = d.points[1].price;
      const left = Math.min(a.x, b.x);
      const right = W;

      let prevY: number | null = null;
      levels.forEach((lvl, i) => {
        const price = p1 + (p0 - p1) * lvl;
        const y = p.y(price);
        if (!Number.isFinite(y)) return;
        if (prevY != null && (d.props.fillOpacity ?? 0) > 0) {
          ctx.fillStyle = withAlpha(FIB_BAND_COLORS[i % FIB_BAND_COLORS.length], d.props.fillOpacity ?? 0.06);
          ctx.fillRect(left, Math.min(prevY, y), right - left, Math.abs(y - prevY));
        }
        applyStroke(rc, d);
        line(rc, { x: left, y }, { x: right, y });
        if (d.props.showLabels !== false) {
          chip(rc, `${lvl.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}  ${fmtPrice(price)}`, left + 4, y - 9, {
            size: 10,
          });
        }
        prevY = y;
      });
      applyStroke(rc, d);
      ctx.save();
      ctx.setLineDash([4, 4]);
      line(rc, a, b);
      ctx.restore();
      break;
    }

    case 'fib_extension': {
      const levels = d.props.levels ?? [0, 0.618, 1, 1.618, 2.618];
      const move = d.points[1].price - d.points[0].price;
      const anchor = d.points[2].price;
      levels.forEach((lvl) => {
        const price = anchor + move * lvl;
        const y = p.y(price);
        if (!Number.isFinite(y)) return;
        line(rc, { x: Math.min(a.x, c.x), y }, { x: W, y });
        if (d.props.showLabels !== false) {
          chip(rc, `${lvl}  ${fmtPrice(price)}`, Math.min(a.x, c.x) + 4, y - 9, { size: 10 });
        }
      });
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = theme.textDim;
      poly(rc, [a, b, c]);
      ctx.restore();
      break;
    }

    case 'fib_timezone': {
      const unit = p.barsBetween(d.points[0].time, d.points[1].time) || 1;
      const seq = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89];
      for (const n of seq) {
        const t = timeAtBarOffset(rc, d.points[0].time, n * unit);
        const x = p.x(t);
        if (!Number.isFinite(x) || x < -10 || x > W + 10) continue;
        line(rc, { x, y: 0 }, { x, y: H });
        if (d.props.showLabels !== false) chip(rc, String(n), x + 3, 12, { size: 10 });
      }
      break;
    }

    // --- shapes ------------------------------------------------------------
    case 'rectangle': {
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x);
      const h = Math.abs(b.y - a.y);
      ctx.fillStyle = fillStyle(d);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
      break;
    }

    case 'ellipse': {
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
      ctx.fillStyle = fillStyle(d);
      ctx.fill();
      ctx.stroke();
      break;
    }

    case 'triangle':
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(c.x, c.y);
      ctx.closePath();
      ctx.fillStyle = fillStyle(d);
      ctx.fill();
      ctx.stroke();
      break;

    case 'polyline':
      poly(rc, pts);
      break;

    case 'path':
      poly(rc, pts);
      if (pts.length >= 2) arrowHead(rc, pts[pts.length - 2], pts[pts.length - 1]);
      break;

    case 'brush':
      poly(rc, pts);
      break;

    case 'highlighter':
      ctx.save();
      ctx.globalAlpha = d.props.fillOpacity ?? 0.3;
      ctx.lineWidth = d.lineWidth || 12;
      ctx.lineCap = 'round';
      ctx.setLineDash([]);
      poly(rc, pts);
      ctx.restore();
      break;

    // --- annotation --------------------------------------------------------
    case 'text':
      chip(rc, d.text || 'Text', a.x, a.y, { size: d.props.fontSize ?? 13, fg: d.color });
      break;

    case 'callout': {
      ctx.save();
      ctx.setLineDash([]);
      line(rc, b, a);
      arrowHead(rc, b, a, 8);
      ctx.restore();
      chip(rc, d.text || 'Callout', b.x, b.y, {
        size: d.props.fontSize ?? 12,
        align: 'center',
        bg: theme.panel,
        fg: d.color,
      });
      break;
    }

    case 'note': {
      // A map-style pin, so the anchor is unambiguous at the tip.
      ctx.save();
      ctx.setLineDash([]);
      ctx.fillStyle = d.color;
      ctx.beginPath();
      ctx.arc(a.x, a.y - 12, 7, Math.PI, 0);
      ctx.lineTo(a.x, a.y);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(a.x, a.y - 12, 2.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      if (d.text) chip(rc, d.text, a.x + 10, a.y - 14, { size: d.props.fontSize ?? 12 });
      break;
    }

    case 'price_label':
      chip(rc, d.text ? `${d.text}  ${fmtPrice(d.points[0].price)}` : fmtPrice(d.points[0].price), a.x, a.y, {
        size: d.props.fontSize ?? 11,
        bg: d.color,
        fg: '#fff',
      });
      break;

    case 'arrow_marker':
      line(rc, a, b);
      arrowHead(rc, a, b);
      break;

    // --- measure -----------------------------------------------------------
    case 'measure': {
      const rising = d.points[1].price >= d.points[0].price;
      const tone = rising ? theme.up : theme.down;
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const w = Math.abs(b.x - a.x);
      const h = Math.abs(b.y - a.y);
      ctx.fillStyle = withAlpha(tone, d.props.fillOpacity ?? 0.1);
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = tone;
      ctx.strokeRect(x, y, w, h);
      ctx.save();
      ctx.setLineDash([]);
      line(rc, { x: x + w / 2, y: a.y }, { x: x + w / 2, y: b.y });
      arrowHead(rc, { x: x + w / 2, y: a.y }, { x: x + w / 2, y: b.y }, 7);
      ctx.restore();
      chip(rc, changeText(rc, d.points[0], d.points[1]), x + w / 2, y - 22, {
        align: 'center', bg: tone, fg: '#fff',
      });
      break;
    }

    case 'price_range': {
      const tone = d.points[1].price >= d.points[0].price ? theme.up : theme.down;
      ctx.strokeStyle = tone;
      const x = (a.x + b.x) / 2;
      ctx.fillStyle = withAlpha(tone, d.props.fillOpacity ?? 0.1);
      ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      line(rc, { x, y: a.y }, { x, y: b.y });
      ctx.save();
      ctx.setLineDash([]);
      arrowHead(rc, { x, y: a.y }, { x, y: b.y }, 7);
      arrowHead(rc, { x, y: b.y }, { x, y: a.y }, 7);
      ctx.restore();
      const delta = d.points[1].price - d.points[0].price;
      const pct = d.points[0].price ? (delta / d.points[0].price) * 100 : 0;
      chip(rc, `${fmtSigned(delta)}  (${fmtSigned(pct)}%)`, x, (a.y + b.y) / 2, {
        align: 'center', bg: tone, fg: '#fff',
      });
      break;
    }

    case 'date_range': {
      const y = (a.y + b.y) / 2;
      ctx.fillStyle = withAlpha(d.color, d.props.fillOpacity ?? 0.1);
      ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      line(rc, { x: a.x, y }, { x: b.x, y });
      ctx.save();
      ctx.setLineDash([]);
      arrowHead(rc, { x: a.x, y }, { x: b.x, y }, 7);
      arrowHead(rc, { x: b.x, y }, { x: a.x, y }, 7);
      ctx.restore();
      const bars = Math.abs(p.barsBetween(d.points[0].time, d.points[1].time));
      chip(rc, `${bars} bars\n${fmtDuration(d.points[1].time - d.points[0].time)}`, (a.x + b.x) / 2, y - 22, {
        align: 'center',
      });
      break;
    }

    // --- positions ---------------------------------------------------------
    case 'long_position':
    case 'short_position': {
      const long = d.tool === 'long_position';
      const entry = d.points[0];
      const target = d.points[1];
      const stop = d.points[2] ?? { time: target.time, price: entry.price - (target.price - entry.price) / 2 };

      const x0 = Math.min(a.x, b.x);
      const x1 = Math.max(a.x, b.x);
      const yEntry = p.y(entry.price);
      const yTarget = p.y(target.price);
      const yStop = p.y(stop.price);

      ctx.setLineDash([]);
      // Profit band toward the target, loss band toward the stop.
      ctx.fillStyle = withAlpha(theme.up, d.props.fillOpacity ?? 0.14);
      ctx.fillRect(x0, Math.min(yEntry, yTarget), x1 - x0, Math.abs(yTarget - yEntry));
      ctx.fillStyle = withAlpha(theme.down, d.props.fillOpacity ?? 0.14);
      ctx.fillRect(x0, Math.min(yEntry, yStop), x1 - x0, Math.abs(yStop - yEntry));

      ctx.strokeStyle = theme.textDim;
      line(rc, { x: x0, y: yEntry }, { x: x1, y: yEntry });
      ctx.strokeStyle = theme.up;
      line(rc, { x: x0, y: yTarget }, { x: x1, y: yTarget });
      ctx.strokeStyle = theme.down;
      line(rc, { x: x0, y: yStop }, { x: x1, y: yStop });

      if (d.props.showLabels !== false) {
        const reward = Math.abs(target.price - entry.price);
        const risk = Math.abs(entry.price - stop.price);
        const rr = risk > 0 ? (reward / risk).toFixed(2) : '∞';
        const pctReward = entry.price ? (reward / entry.price) * 100 : 0;
        const pctRisk = entry.price ? (risk / entry.price) * 100 : 0;
        chip(rc, `Target ${fmtPrice(target.price)}  (+${pctReward.toFixed(2)}%)`, x1 - 4, yTarget, {
          align: 'right', bg: theme.up, fg: '#fff', size: 10,
        });
        chip(rc, `Stop ${fmtPrice(stop.price)}  (−${pctRisk.toFixed(2)}%)`, x1 - 4, yStop, {
          align: 'right', bg: theme.down, fg: '#fff', size: 10,
        });
        chip(rc, `${long ? 'Long' : 'Short'} ${fmtPrice(entry.price)}\nR:R ${rr}`, x0 + 4, yEntry, { size: 10 });
      }
      break;
    }

    default:
      break;
  }

  ctx.restore();

  if (selected) {
    drawHandles(rc, positionHandles(rc, d, pts), d.color);
  }
}

const FIB_BAND_COLORS = ['#787b86', '#ef5350', '#ff6d00', '#ffb300', '#66bb6a', '#26a69a', '#2962ff'];

/** Position tools carry an implicit third handle for the stop. */
function positionHandles(rc: RenderContext, d: Drawing, pts: Vec[]): Vec[] {
  if (d.tool !== 'long_position' && d.tool !== 'short_position') return pts;
  if (d.points.length >= 3) return pts;
  const entry = d.points[0];
  const target = d.points[1];
  const stopPrice = entry.price - (target.price - entry.price) / 2;
  return [...pts, { x: rc.projection.x(target.time), y: rc.projection.y(stopPrice) }];
}

/** Foot of the perpendicular from p onto the line through a and b. */
function projectOntoLine(p: Vec, a: Vec, b: Vec): Vec {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return a;
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/** Timestamp `n` bars after `time`, following real bars where they exist. */
function timeAtBarOffset(rc: RenderContext, time: number, n: number): number {
  const { candles } = rc;
  if (candles.length === 0) return time;
  const idx = candles.findIndex((c) => c.time >= time);
  const base = idx < 0 ? candles.length - 1 : idx;
  const target = base + Math.round(n);
  if (target < candles.length && target >= 0) return candles[target].time;
  const step = candles.length > 1 ? candles[candles.length - 1].time - candles[candles.length - 2].time : 86400;
  return candles[candles.length - 1].time + (target - (candles.length - 1)) * step;
}

// ---------------------------------------------------------------------------
// Hit testing — mirrors the rendering, so what looks clickable is clickable
// ---------------------------------------------------------------------------

export function hitTest(rc: RenderContext, d: Drawing, cursor: Vec): boolean {
  if (d.props.hidden || d.props.locked) return false;
  const { projection: p } = rc;
  const pts: Vec[] = d.points.map((pt) => ({ x: p.x(pt.time), y: p.y(pt.price) }));
  if (pts.some((v) => !Number.isFinite(v.x) || !Number.isFinite(v.y))) return false;
  const [a, b, c, dd] = pts;
  const W = p.width;
  const H = p.height;
  const tol = Math.max(HIT_TOLERANCE, (d.lineWidth || 1) + 4);

  switch (d.tool) {
    case 'trendline':
    case 'info_line':
    case 'trend_angle':
    case 'arrow_marker':
      return distanceToSegment(cursor, a, b) <= tol;

    case 'ray':
      return distanceToRay(cursor, a, b) <= tol;

    case 'extended':
      return distanceToLine(cursor, a, b) <= tol;

    case 'hline':
    case 'hray':
      return Math.abs(cursor.y - a.y) <= tol && (d.tool === 'hline' || cursor.x >= a.x - tol);

    case 'vline':
      return Math.abs(cursor.x - a.x) <= tol;

    case 'crossline':
      return Math.abs(cursor.y - a.y) <= tol || Math.abs(cursor.x - a.x) <= tol;

    case 'parallel_channel': {
      const dy = c.y - projectOntoLine(c, a, b).y;
      return (
        distanceToSegment(cursor, a, b) <= tol ||
        distanceToSegment(cursor, { x: a.x, y: a.y + dy }, { x: b.x, y: b.y + dy }) <= tol ||
        insidePolygon(cursor, [a, b, { x: b.x, y: b.y + dy }, { x: a.x, y: a.y + dy }])
      );
    }

    case 'disjoint_channel':
      return (
        distanceToSegment(cursor, a, b) <= tol ||
        distanceToSegment(cursor, c, dd) <= tol ||
        insidePolygon(cursor, [a, b, dd, c])
      );

    case 'fib_retracement':
    case 'fib_extension': {
      const levels = d.props.levels ?? FIB_LEVELS;
      const left = Math.min(a.x, d.tool === 'fib_extension' ? c.x : b.x);
      if (cursor.x < left - tol) return false;
      for (const lvl of levels) {
        const price =
          d.tool === 'fib_retracement'
            ? d.points[1].price + (d.points[0].price - d.points[1].price) * lvl
            : d.points[2].price + (d.points[1].price - d.points[0].price) * lvl;
        if (Math.abs(cursor.y - p.y(price)) <= tol) return true;
      }
      return distanceToSegment(cursor, a, b) <= tol;
    }

    case 'fib_timezone': {
      const unit = p.barsBetween(d.points[0].time, d.points[1].time) || 1;
      for (const n of [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89]) {
        const x = p.x(timeAtBarOffset(rc, d.points[0].time, n * unit));
        if (Math.abs(cursor.x - x) <= tol) return true;
      }
      return false;
    }

    case 'rectangle':
    case 'measure':
    case 'price_range':
    case 'date_range':
      return insideRect(cursor, a, b, tol);

    case 'ellipse': {
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      const rx = Math.abs(b.x - a.x) / 2 || 1;
      const ry = Math.abs(b.y - a.y) / 2 || 1;
      const v = ((cursor.x - cx) / rx) ** 2 + ((cursor.y - cy) / ry) ** 2;
      return v <= 1.25;
    }

    case 'triangle':
      return insidePolygon(cursor, [a, b, c]) || distanceToSegment(cursor, a, b) <= tol;

    case 'polyline':
    case 'path':
    case 'brush':
    case 'highlighter': {
      const width = d.tool === 'highlighter' ? Math.max(tol, (d.lineWidth || 12) / 2 + 2) : tol;
      for (let i = 1; i < pts.length; i++) {
        if (distanceToSegment(cursor, pts[i - 1], pts[i]) <= width) return true;
      }
      return false;
    }

    case 'text':
    case 'price_label':
    case 'note':
      return Math.abs(cursor.x - a.x) <= 40 && Math.abs(cursor.y - a.y) <= 16;

    case 'callout':
      return (
        (Math.abs(cursor.x - b.x) <= 50 && Math.abs(cursor.y - b.y) <= 16) ||
        distanceToSegment(cursor, a, b) <= tol
      );

    case 'long_position':
    case 'short_position':
      return insideRect(cursor, a, b, tol) || insideRect(cursor, a, { x: b.x, y: pts[2]?.y ?? b.y }, tol);

    default:
      return false;
  }
}

function insideRect(p: Vec, a: Vec, b: Vec, tol: number): boolean {
  return (
    p.x >= Math.min(a.x, b.x) - tol && p.x <= Math.max(a.x, b.x) + tol &&
    p.y >= Math.min(a.y, b.y) - tol && p.y <= Math.max(a.y, b.y) + tol
  );
}

function insidePolygon(p: Vec, poly: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Index of the handle under the cursor, or -1. */
export function handleAt(rc: RenderContext, d: Drawing, cursor: Vec): number {
  const pts = d.points.map((pt) => ({ x: rc.projection.x(pt.time), y: rc.projection.y(pt.price) }));
  const all = positionHandles(rc, d, pts);
  for (let i = 0; i < all.length; i++) {
    if (Math.abs(cursor.x - all[i].x) <= HANDLE + 3 && Math.abs(cursor.y - all[i].y) <= HANDLE + 3) return i;
  }
  return -1;
}
