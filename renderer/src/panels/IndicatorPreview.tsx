/**
 * Live preview of an indicator, drawn before you add it.
 *
 * Deliberately built on the *real* registry and the *real* bars of the symbol
 * currently on screen, rather than a stock illustration: the point is to answer
 * "what will this look like on what I am actually looking at", which a generic
 * picture cannot. It is an SVG rather than a second chart instance because a
 * lightweight-charts instance per hovered list row would be far too heavy.
 *
 * Overlay indicators draw over a price line in one frame. Separate-pane ones
 * get a small price strip on top and their own frame beneath, mirroring how the
 * chart will actually lay them out.
 */

import { useMemo } from 'react';
import type { Candle, IndicatorDef, IndicatorResult, Series } from '@shared/types';
import { defaultParams, runIndicator } from '@shared/indicators/registry';

/** Bars to draw. Enough to show character, few enough to stay crisp. */
const WINDOW = 140;

interface Props {
  def: IndicatorDef;
  candles: Candle[];
  benchmark?: Candle[];
}

export default function IndicatorPreview({ def, candles, benchmark }: Props) {
  const data = useMemo(() => {
    if (candles.length < 10) return null;
    // Compute over the full series so long lookbacks (a 200 DMA, Ichimoku's
    // 52-bar span) have their history, then show only the tail. Slicing first
    // would leave the preview empty for exactly the indicators most worth
    // previewing.
    const { result, error } = runIndicator(def.id, candles, defaultParams(def), {
      benchmark, timezone: 'UTC', interval: '1d', useAdjusted: false,
    });
    if (!result || error) return null;

    const start = Math.max(0, candles.length - WINDOW);
    const window = candles.slice(start);
    const slice = (s: Series) => s.slice(start);

    const plots = def.plots
      .map((p) => ({ spec: p, values: result.series[p.key] ? slice(result.series[p.key]) : null }))
      .filter((p): p is { spec: typeof p.spec; values: Series } => p.values != null);

    const markers = (result.markers ?? [])
      .filter((m) => m.index >= start)
      .map((m) => ({ ...m, index: m.index - start }));

    return { window, plots, markers, levels: result.levels ?? [], result };
  }, [def, candles, benchmark]);

  if (!data) {
    return (
      <div className="flex h-[150px] items-center justify-center rounded border border-edge bg-panel-2 text-[11px] text-ink-faint">
        No preview available for this symbol
      </div>
    );
  }

  const overlay = def.panel === 'overlay';
  const { window, plots, markers, levels } = data;

  return (
    <div className="overflow-hidden rounded border border-edge bg-ground">
      {overlay ? (
        <Frame
          candles={window}
          plots={plots}
          markers={markers}
          height={150}
          showPrice
          priceStyle={def.kind === 'pattern' || def.kind === 'strategy' ? 'candles' : 'line'}
        />
      ) : (
        <>
          <Frame candles={window} plots={[]} markers={markers} height={58} showPrice priceStyle="line" />
          <div className="h-px bg-edge" />
          <Frame candles={window} plots={plots} markers={[]} height={104} levels={levels} />
        </>
      )}
    </div>
  );
}

type PlotItem = { spec: IndicatorDef['plots'][number]; values: Series };

interface FrameProps {
  candles: Candle[];
  plots: PlotItem[];
  markers: NonNullable<IndicatorResult['markers']>;
  height: number;
  showPrice?: boolean;
  priceStyle?: 'line' | 'candles';
  levels?: NonNullable<IndicatorResult['levels']>;
}

function Frame({ candles, plots, markers, height, showPrice, priceStyle = 'line', levels = [] }: FrameProps) {
  const W = 300;
  const PAD = 8;

  // One shared domain per frame: overlay plots must sit against price on the
  // same scale, or a moving average would not visibly hug it.
  const values: number[] = [];
  if (showPrice) {
    for (const c of candles) values.push(priceStyle === 'candles' ? c.high : c.close, c.low);
  }
  for (const p of plots) for (const v of p.values) if (v != null && Number.isFinite(v)) values.push(v);
  for (const l of levels) values.push(l.value);

  if (values.length === 0) return <div style={{ height }} />;

  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi === lo) { hi += 1; lo -= 1; }
  const span = hi - lo;

  const x = (i: number) => PAD + (i / Math.max(1, candles.length - 1)) * (W - PAD * 2);
  const y = (v: number) => PAD + (1 - (v - lo) / span) * (height - PAD * 2);

  const linePath = (series: Series) => {
    let d = '';
    let pen = false;
    series.forEach((v, i) => {
      if (v == null || !Number.isFinite(v)) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  const closes: Series = candles.map((c) => c.close);
  const barWidth = Math.max(1.2, (W - PAD * 2) / candles.length - 0.8);

  return (
    <svg viewBox={`0 0 ${W} ${height}`} width="100%" height={height} className="block">
      {levels.map((l, i) => (
        <line key={i} x1={PAD} x2={W - PAD} y1={y(l.value)} y2={y(l.value)}
          stroke={l.color} strokeWidth="1" strokeDasharray="2 3" opacity="0.6" />
      ))}

      {showPrice && priceStyle === 'line' && (
        <>
          <path d={`${linePath(closes)} L${x(candles.length - 1)} ${height} L${x(0)} ${height} Z`}
            fill="currentColor" className="text-ink-faint" opacity="0.10" />
          <path d={linePath(closes)} fill="none" stroke="currentColor" strokeWidth="1.2"
            className="text-ink-dim" strokeLinejoin="round" />
        </>
      )}

      {showPrice && priceStyle === 'candles' && candles.map((c, i) => {
        const up = c.close >= c.open;
        const color = up ? '#26a69a' : '#ef5350';
        const top = y(Math.max(c.open, c.close));
        const bottom = y(Math.min(c.open, c.close));
        return (
          <g key={i}>
            <line x1={x(i)} x2={x(i)} y1={y(c.high)} y2={y(c.low)} stroke={color} strokeWidth="0.8" />
            <rect x={x(i) - barWidth / 2} y={top} width={barWidth} height={Math.max(0.8, bottom - top)} fill={color} />
          </g>
        );
      })}

      {plots.map((p) => (
        p.spec.style === 'histogram' ? (
          <g key={p.spec.key}>
            {p.values.map((v, i) => {
              if (v == null || !Number.isFinite(v)) return null;
              const zero = y(Math.max(lo, Math.min(hi, 0)));
              const top = Math.min(zero, y(v));
              return (
                <rect key={i} x={x(i) - barWidth / 2} y={top} width={barWidth}
                  height={Math.max(0.6, Math.abs(y(v) - zero))} fill={p.spec.color} opacity="0.75" />
              );
            })}
          </g>
        ) : (
          <path key={p.spec.key} d={linePath(p.values)} fill="none" stroke={p.spec.color}
            strokeWidth={p.spec.style === 'dashed' ? 1 : (p.spec.lineWidth ?? 1.4)}
            strokeDasharray={p.spec.style === 'dashed' ? '3 3' : undefined}
            strokeLinejoin="round" strokeLinecap="round" />
        )
      ))}

      {markers.map((m, i) => {
        const bar = candles[m.index];
        if (!bar) return null;
        const buy = m.side === 'buy';
        const cy = buy ? y(bar.low) + 7 : y(bar.high) - 7;
        const color = buy ? '#26a69a' : m.side === 'sell' ? '#ef5350' : '#787b86';
        const dir = buy ? 1 : -1;
        return (
          <polygon key={i} fill={color}
            points={`${x(m.index)},${cy - 4 * dir} ${x(m.index) - 3.2},${cy + 2 * dir} ${x(m.index) + 3.2},${cy + 2 * dir}`} />
        );
      })}
    </svg>
  );
}
