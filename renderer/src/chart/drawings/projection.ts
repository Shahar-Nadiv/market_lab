/**
 * Mapping between chart space (time, price) and screen space (x, y).
 *
 * Drawings are stored against time and price, never pixels, so they stay put
 * through zoom, pan, resize and interval changes. That means every render has
 * to re-project them, and every mouse event has to un-project.
 *
 * `timeScale().timeToCoordinate()` only answers for times that exist in the
 * data, which would make it impossible to draw between bars or into the future
 * — both things users do constantly. So time is converted to a *fractional
 * logical index* first, interpolating between bars and extrapolating past the
 * last one, and the chart's logical-coordinate API does the rest.
 */

import type { IChartApi, ISeriesApi, Logical } from 'lightweight-charts';
import type { Candle } from '@shared/types';

export interface Point {
  time: number;
  price: number;
}

export interface Projection {
  /** Pixel x for a timestamp, including times beyond the last bar. */
  x(time: number): number;
  /** Pixel y for a price. */
  y(price: number): number;
  /** Timestamp under a pixel x. */
  time(x: number): number;
  /** Price under a pixel y. */
  price(y: number): number;
  /** Whole-bar distance between two timestamps, for "N bars" readouts. */
  barsBetween(t0: number, t1: number): number;
  /** Snap a timestamp to the nearest real bar, for magnet-style placement. */
  snapTime(time: number): number;
  /** The bar nearest a timestamp, for OHLC snapping. */
  barAt(time: number): Candle | null;
  width: number;
  height: number;
}

/** Median spacing between bars — robust to weekend and holiday gaps. */
function typicalStep(candles: Candle[]): number {
  if (candles.length < 2) return 86400;
  const deltas: number[] = [];
  const stride = Math.max(1, Math.floor(candles.length / 200));
  for (let i = stride; i < candles.length; i += stride) {
    const d = candles[i].time - candles[i - stride].time;
    if (d > 0) deltas.push(d / stride);
  }
  if (deltas.length === 0) return 86400;
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)] || 86400;
}

export function makeProjection(
  chart: IChartApi,
  series: ISeriesApi<any>,
  candles: Candle[],
  width: number,
  height: number,
): Projection {
  const timeScale = chart.timeScale();
  const step = typicalStep(candles);
  const n = candles.length;

  /** Fractional bar index for a timestamp; extrapolates outside the data. */
  function timeToLogical(t: number): number {
    if (n === 0) return 0;
    if (t <= candles[0].time) return (t - candles[0].time) / step;
    if (t >= candles[n - 1].time) return n - 1 + (t - candles[n - 1].time) / step;

    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (candles[mid].time <= t) lo = mid;
      else hi = mid;
    }
    const span = candles[hi].time - candles[lo].time || step;
    return lo + (t - candles[lo].time) / span;
  }

  function logicalToTime(l: number): number {
    if (n === 0) return Math.round(l * step);
    if (l <= 0) return Math.round(candles[0].time + l * step);
    if (l >= n - 1) return Math.round(candles[n - 1].time + (l - (n - 1)) * step);
    const lo = Math.floor(l);
    const frac = l - lo;
    const a = candles[lo].time;
    const b = candles[Math.min(lo + 1, n - 1)].time;
    return Math.round(a + (b - a) * frac);
  }

  return {
    width,
    height,

    x(time) {
      const coord = timeScale.logicalToCoordinate(timeToLogical(time) as Logical);
      return coord == null ? NaN : coord;
    },

    y(price) {
      const coord = series.priceToCoordinate(price);
      return coord == null ? NaN : coord;
    },

    time(x) {
      const logical = timeScale.coordinateToLogical(x);
      return logical == null ? 0 : logicalToTime(logical);
    },

    price(y) {
      const p = series.coordinateToPrice(y);
      return p == null ? 0 : (p as number);
    },

    barsBetween(t0, t1) {
      return Math.round(timeToLogical(t1) - timeToLogical(t0));
    },

    snapTime(time) {
      if (n === 0) return time;
      const l = Math.round(timeToLogical(time));
      if (l < 0) return logicalToTime(l);
      if (l > n - 1) return logicalToTime(l);
      return candles[l].time;
    },

    barAt(time) {
      if (n === 0) return null;
      const l = Math.round(timeToLogical(time));
      if (l < 0 || l > n - 1) return null;
      return candles[l];
    },
  };
}

// ---------------------------------------------------------------------------
// Screen-space geometry helpers, shared by rendering and hit-testing
// ---------------------------------------------------------------------------

export interface Vec {
  x: number;
  y: number;
}

export function project(p: Projection, pt: Point): Vec {
  return { x: p.x(pt.time), y: p.y(pt.price) };
}

export function valid(v: Vec): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y);
}

/** Shortest distance from a point to a finite segment. */
export function distanceToSegment(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Distance to an infinite line through a and b. */
export function distanceToLine(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs(dy * (p.x - a.x) - dx * (p.y - a.y)) / len;
}

/** Distance to a ray starting at `a` heading through `b`, extending forward. */
export function distanceToRay(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Where an infinite line through a,b leaves the canvas, for extended lines. */
export function extendToBounds(a: Vec, b: Vec, width: number, height: number): [Vec, Vec] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return [a, b];

  // Parameterise as a + t*(b-a) and clip against the viewport, padded so the
  // stroke does not stop visibly short of the edge.
  const pad = 4;
  const ts: number[] = [];
  if (dx !== 0) {
    ts.push((-pad - a.x) / dx, (width + pad - a.x) / dx);
  }
  if (dy !== 0) {
    ts.push((-pad - a.y) / dy, (height + pad - a.y) / dy);
  }
  if (ts.length === 0) return [a, b];
  const tMin = Math.min(...ts);
  const tMax = Math.max(...ts);
  return [
    { x: a.x + tMin * dx, y: a.y + tMin * dy },
    { x: a.x + tMax * dx, y: a.y + tMax * dy },
  ];
}

/** Forward half of an infinite line, for rays. */
export function extendRay(a: Vec, b: Vec, width: number, height: number): Vec {
  const [, far] = extendToBounds(a, b, width, height);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // `extendToBounds` returns the two ends in parameter order, which may be
  // backwards relative to a→b; pick the end that lies forward of a.
  const forward = (far.x - a.x) * dx + (far.y - a.y) * dy > 0;
  if (forward) return far;
  const [near] = extendToBounds(a, b, width, height);
  return near;
}
