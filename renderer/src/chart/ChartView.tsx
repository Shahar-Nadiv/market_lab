/**
 * The price chart.
 *
 * lightweight-charts owns its own canvas and rendering loop, so this component
 * creates the chart once and drives it imperatively from effects. Re-creating
 * the chart on every render would drop the user's zoom and pan on every state
 * change.
 *
 * Series are reconciled rather than rebuilt: when an indicator's parameters
 * change we update the existing series' data instead of removing and re-adding
 * it, which avoids a visible flash and keeps the pane layout stable.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  createSeriesMarkers,
  AreaSeries,
  BarSeries,
  BaselineSeries,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useStore } from '../state/store';
import { runIndicator, getIndicator } from '@shared/indicators/registry';
import type { AttachedIndicator, Candle, EarningsEvent, IndicatorResult } from '@shared/types';
import { DARK, LIGHT, UP, DOWN, EARNINGS, chartOptions } from './theme';
import {
  prepareCandles, toBars, toCloseLine, toLine, toVolume, toHistogram, priceFormat, formatPrice, formatVolume,
  rangeStart, alignEarnings, earningsSummary,
} from './data';
import { isIntraday } from '@shared/types';
import DrawingLayer from './DrawingLayer';

/** What the crosshair legend shows for the hovered bar. */
interface LegendState {
  time: number | null;
  ohlc: { open: number; high: number; low: number; close: number; volume: number } | null;
  values: { label: string; value: number | null; color: string }[];
  /** The earnings report on the hovered bar, if it carries one. */
  earnings: EarningsEvent | null;
}

const EMPTY_LEGEND: LegendState = { time: null, ohlc: null, values: [], earnings: null };

export default function ChartView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceSeriesRef = useRef<ISeriesApi<any> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<any> | null>(null);

  /** Indicator series keyed `${instanceId}:${plotKey}`, so we can reconcile. */
  const indicatorSeriesRef = useRef<Map<string, { series: ISeriesApi<any>; paneIndex: number }>>(new Map());
  /** Pane index allocated to each separate-panel indicator instance. */
  const panesRef = useRef<Map<string, number>>(new Map());
  /** Instances whose static reference levels have already been drawn. */
  const levelsApplied = useRef<Set<string>>(new Set());
  /**
   * Marker plugin bound to the price series. Strategies and candlestick
   * patterns output flagged bars rather than lines, and every attached one
   * contributes to a single marker set — the plugin replaces wholesale rather
   * than merging, so they are collected before being applied.
   */
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  /** Script plot series, keyed `${scriptId}:${plotKey}`. */
  const scriptSeriesRef = useRef<Map<string, { series: ISeriesApi<any>; paneIndex: number }>>(new Map());
  const scriptPanesRef = useRef<Map<number, number>>(new Map());

  const {
    candles: rawCandles, seriesType, priceScale, indicators, settings, symbol, interval,
    meta, benchmarkCandles, loading, error, range, earnings,
    attachedScripts, scriptResults, runAttachedScripts,
  } = useStore();

  const [legend, setLegend] = useState<LegendState>(EMPTY_LEGEND);
  /**
   * Flips once the chart and its price series exist. The drawing overlay needs
   * both as real objects, and refs alone would not re-render to hand them over.
   */
  const [chartReady, setChartReady] = useState(false);
  /**
   * Latest crosshair handler, reachable from the create-once effect.
   *
   * The chart is subscribed exactly once, so a handler passed directly would
   * close over the *first* render's candles and indicators — permanently empty
   * ones — and every hover would read from them.
   */
  const onCrosshairRef = useRef<(param: MouseEventParams) => void>(() => {});

  const palette = settings.theme === 'light' ? LIGHT : DARK;
  const intraday = isIntraday(interval);

  /** Bars after adjusted-close and Heikin-Ashi transforms. */
  const candles = useMemo(
    () => prepareCandles(rawCandles, seriesType, settings.useAdjustedClose),
    [rawCandles, seriesType, settings.useAdjustedClose],
  );

  /** Indicator outputs, recomputed only when inputs actually change. */
  const computed = useMemo(() => {
    const out = new Map<string, IndicatorResult>();
    if (candles.length === 0) return out;
    for (const inst of indicators) {
      if (!inst.visible) continue;
      const { result } = runIndicator(inst.indicatorId, candles, inst.params, {
        timezone: meta?.exchange ? undefined : undefined,
        benchmark: benchmarkCandles,
        useAdjusted: false, // already applied to `candles`
        interval,
      });
      if (result) out.set(inst.instanceId, result);
    }
    return out;
  }, [candles, indicators, benchmarkCandles, interval, meta]);

  /**
   * Earnings reports keyed by the bar index they land on.
   *
   * Indexed rather than listed because both consumers want random access: the
   * marker pass reads the bar's timestamp, and the crosshair legend asks
   * "does the bar under the cursor have one?" on every mouse move.
   */
  const earningsByBar = useMemo(
    () => (settings.showEarnings ? alignEarnings(candles, earnings) : new Map<number, EarningsEvent>()),
    [candles, earnings, settings.showEarnings],
  );

  // -------------------------------------------------------------------------
  // Create the chart once
  // -------------------------------------------------------------------------
  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, chartOptions(palette, intraday));
    chartRef.current = chart;

    const onMove = (param: MouseEventParams) => {
      if (!param.time || !param.point) {
        setLegend(EMPTY_LEGEND);
        return;
      }
      onCrosshairRef.current(param);
    };
    chart.subscribeCrosshairMove(onMove);

    return () => {
      setChartReady(false);
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      chartRef.current = null;
      priceSeriesRef.current = null;
      volumeSeriesRef.current = null;
      indicatorSeriesRef.current.clear();
      panesRef.current.clear();
    };
    // Intentionally created once; theme and interval are applied by effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------------------------------------------------------------------------
  // Theme / axis options
  // -------------------------------------------------------------------------
  useEffect(() => {
    chartRef.current?.applyOptions(chartOptions(palette, intraday));
  }, [palette, intraday]);

  useEffect(() => {
    chartRef.current?.priceScale('right').applyOptions({
      mode: priceScale === 'logarithmic' ? 1 : priceScale === 'percentage' ? 2 : 0,
    });
  }, [priceScale]);

  // -------------------------------------------------------------------------
  // Price series — recreated only when the series *type* changes
  // -------------------------------------------------------------------------
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    if (priceSeriesRef.current) {
      chart.removeSeries(priceSeriesRef.current);
      priceSeriesRef.current = null;
      // The marker plugin is bound to the series being removed; drop it so the
      // next render rebinds to the new one instead of writing to a dead handle.
      markersRef.current = null;
    }

    const sample = candles.at(-1)?.close ?? 1;
    const fmt = { type: 'price' as const, ...priceFormat(sample) };
    let series: ISeriesApi<any>;

    switch (seriesType) {
      case 'bar':
        series = chart.addSeries(BarSeries, { upColor: UP, downColor: DOWN, priceFormat: fmt }, 0);
        break;
      case 'line':
        series = chart.addSeries(LineSeries, { color: '#2962ff', lineWidth: 2, priceFormat: fmt }, 0);
        break;
      case 'area':
        series = chart.addSeries(AreaSeries, {
          lineColor: '#2962ff', topColor: 'rgba(41,98,255,0.28)', bottomColor: 'rgba(41,98,255,0.02)', priceFormat: fmt,
        }, 0);
        break;
      case 'baseline':
        series = chart.addSeries(BaselineSeries, { priceFormat: fmt }, 0);
        break;
      default:
        series = chart.addSeries(CandlestickSeries, {
          upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN,
          wickUpColor: UP, wickDownColor: DOWN, priceFormat: fmt,
        }, 0);
    }
    priceSeriesRef.current = series;
    setChartReady(true);
  }, [seriesType]);

  // -------------------------------------------------------------------------
  // Price data
  // -------------------------------------------------------------------------
  useEffect(() => {
    const series = priceSeriesRef.current;
    if (!series || candles.length === 0) return;
    const usesClose = seriesType === 'line' || seriesType === 'area' || seriesType === 'baseline';
    series.setData(usesClose ? toCloseLine(candles) : (toBars(candles) as any));
  }, [candles, seriesType]);

  /**
   * Apply the selected range once data is present.
   *
   * Keyed on the first/last bar rather than on `candles` so a background
   * refresh that appends nothing does not yank the user's zoom back. Showing
   * the full 45-year history by default would squash the recent action into a
   * few pixels, so the range preset decides the opening window.
   */
  const firstTime = candles[0]?.time;
  const lastTime = candles.at(-1)?.time;
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || firstTime == null || lastTime == null) return;

    if (range === 'MAX') {
      chart.timeScale().fitContent();
      return;
    }
    const from = rangeStart(range, lastTime);
    chart.timeScale().setVisibleRange({
      from: Math.max(from ?? firstTime, firstTime) as UTCTimestamp,
      to: lastTime as UTCTimestamp,
    });
  }, [range, firstTime, lastTime, symbol, interval]);

  // -------------------------------------------------------------------------
  // Volume overlay on the price pane
  // -------------------------------------------------------------------------
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    if (!volumeSeriesRef.current) {
      const vol = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' },
        // Its own scale id keeps volume from compressing the price axis.
        priceScaleId: 'volume',
        lastValueVisible: false,
        priceLineVisible: false,
      }, 0);
      chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      volumeSeriesRef.current = vol;
    }
    if (candles.length > 0) volumeSeriesRef.current.setData(toVolume(candles));
  }, [candles]);

  // -------------------------------------------------------------------------
  // Indicator series reconciliation
  // -------------------------------------------------------------------------
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const seriesMap = indicatorSeriesRef.current;
    const wanted = new Set<string>();

    // Allocate a pane per separate-panel indicator, reusing existing ones.
    for (const inst of indicators) {
      const def = getIndicator(inst.indicatorId);
      if (!def || !inst.visible || !computed.has(inst.instanceId)) continue;
      if (def.panel === 'separate' && !panesRef.current.has(inst.instanceId)) {
        const pane = chart.addPane();
        panesRef.current.set(inst.instanceId, pane.paneIndex());
      }
    }

    for (const inst of indicators) {
      const def = getIndicator(inst.indicatorId);
      const result = computed.get(inst.instanceId);
      if (!def || !inst.visible || !result) continue;

      const paneIndex = def.panel === 'separate' ? panesRef.current.get(inst.instanceId) ?? 0 : 0;

      for (const plot of def.plots) {
        const key = `${inst.instanceId}:${plot.key}`;
        const data = result.series[plot.key];
        if (!data) continue;
        wanted.add(key);

        const color = inst.colors?.[plot.key] ?? plot.color;
        let entry = seriesMap.get(key);

        // Pane changes require a fresh series; lightweight-charts cannot move one.
        if (entry && entry.paneIndex !== paneIndex) {
          chart.removeSeries(entry.series);
          seriesMap.delete(key);
          entry = undefined;
        }

        if (!entry) {
          const series = plot.style === 'histogram'
            ? chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, paneIndex)
            : chart.addSeries(LineSeries, {
                color,
                lineWidth: (plot.lineWidth ?? 1) as any,
                lineStyle: plot.style === 'dashed' ? LineStyle.Dashed : LineStyle.Solid,
                priceLineVisible: false,
                lastValueVisible: def.panel === 'overlay',
                crosshairMarkerVisible: false,
              }, paneIndex);
          entry = { series, paneIndex };
          seriesMap.set(key, entry);
        } else if (plot.style !== 'histogram') {
          entry.series.applyOptions({ color, lineWidth: (plot.lineWidth ?? 1) as any });
        }

        entry.series.setData(
          plot.style === 'histogram'
            ? (toHistogram(candles, data, color) as any)
            : (toLine(candles, data) as any),
        );
      }

      // Static reference levels (RSI 70/30, MACD zero, ADX 25).
      if (result.levels?.length) {
        const anchorKey = `${inst.instanceId}:${def.plots[0].key}`;
        const anchor = seriesMap.get(anchorKey);
        if (anchor && !levelsApplied.current.has(inst.instanceId)) {
          for (const lvl of result.levels) {
            anchor.series.createPriceLine({
              price: lvl.value,
              color: lvl.color,
              lineWidth: 1,
              lineStyle: LineStyle.Dotted,
              axisLabelVisible: true,
              title: lvl.label ?? '',
            });
          }
          levelsApplied.current.add(inst.instanceId);
        }
      }
    }

    // Drop series for indicators that were removed or hidden.
    for (const [key, entry] of [...seriesMap]) {
      if (wanted.has(key)) continue;
      chart.removeSeries(entry.series);
      seriesMap.delete(key);
      const instanceId = key.split(':')[0];
      levelsApplied.current.delete(instanceId);
    }

    // Release panes whose indicator is gone, so panes do not accumulate.
    const liveInstances = new Set(indicators.filter((i) => i.visible).map((i) => i.instanceId));
    for (const [instanceId] of [...panesRef.current]) {
      if (!liveInstances.has(instanceId)) panesRef.current.delete(instanceId);
    }
  }, [indicators, computed, candles]);

  // -------------------------------------------------------------------------
  // Strategy, pattern and earnings markers
  //
  // Collected from every source into one set, because the marker plugin owns
  // the series wholesale — calling it per indicator would leave only the last
  // one's flags on the chart.
  // -------------------------------------------------------------------------
  useEffect(() => {
    const series = priceSeriesRef.current;
    if (!series || candles.length === 0) return;

    const markers: SeriesMarker<Time>[] = [];

    // Earnings sit below the bar, where they cover no price action, and use a
    // plain 'E' so a chart with twenty years of quarters stays readable.
    for (const index of earningsByBar.keys()) {
      const bar = candles[index];
      if (!bar) continue;
      markers.push({
        time: bar.time as UTCTimestamp,
        position: 'belowBar',
        shape: 'circle',
        color: EARNINGS,
        text: 'E',
      });
    }

    for (const inst of indicators) {
      if (!inst.visible) continue;
      const result = computed.get(inst.instanceId);
      if (!result?.markers?.length) continue;

      for (const m of result.markers) {
        const bar = candles[m.index];
        if (!bar) continue;
        const buy = m.side === 'buy';
        markers.push({
          time: bar.time as UTCTimestamp,
          // Buys sit under the bar and sells above it, so a marker never
          // covers the price action it refers to.
          position: buy ? 'belowBar' : m.side === 'sell' ? 'aboveBar' : 'inBar',
          shape: buy ? 'arrowUp' : m.side === 'sell' ? 'arrowDown' : 'circle',
          color: buy ? UP : m.side === 'sell' ? DOWN : palette.crosshair,
          text: m.text ?? '',
        });
      }
    }

    markers.sort((a, b) => (a.time as number) - (b.time as number));

    if (!markersRef.current) {
      markersRef.current = createSeriesMarkers(series, markers);
    } else {
      markersRef.current.setMarkers(markers);
    }
  }, [indicators, computed, candles, seriesType, palette.crosshair, earningsByBar]);

  // -------------------------------------------------------------------------
  // User script plots
  //
  // Same reconciliation as built-in indicators, keyed on the script id so a
  // re-run updates the existing series rather than flashing a new one in.
  // -------------------------------------------------------------------------
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const seriesMap = scriptSeriesRef.current;
    const wanted = new Set<string>();

    for (const attached of attachedScripts) {
      const descriptor = scriptResults[attached.scriptId];
      if (!attached.visible || !descriptor) continue;

      if (!descriptor.overlay && !scriptPanesRef.current.has(attached.scriptId)) {
        scriptPanesRef.current.set(attached.scriptId, chart.addPane().paneIndex());
      }
      const paneIndex = descriptor.overlay ? 0 : scriptPanesRef.current.get(attached.scriptId) ?? 0;

      for (const plot of descriptor.plots) {
        const key = `${attached.scriptId}:${plot.key}`;
        wanted.add(key);
        let entry = seriesMap.get(key);

        if (entry && entry.paneIndex !== paneIndex) {
          chart.removeSeries(entry.series);
          seriesMap.delete(key);
          entry = undefined;
        }
        if (!entry) {
          const series = plot.style === 'histogram'
            ? chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, paneIndex)
            : chart.addSeries(LineSeries, {
                color: plot.color,
                lineWidth: plot.lineWidth as any,
                lineStyle: plot.style === 'dashed' ? LineStyle.Dashed : LineStyle.Solid,
                priceLineVisible: false,
                crosshairMarkerVisible: false,
              }, paneIndex);
          entry = { series, paneIndex };
          seriesMap.set(key, entry);
        }
        entry.series.setData(
          plot.style === 'histogram'
            ? (toHistogram(candles, plot.data, plot.color) as any)
            : (toLine(candles, plot.data) as any),
        );
      }

    }

    for (const [key, entry] of [...seriesMap]) {
      if (wanted.has(key)) continue;
      chart.removeSeries(entry.series);
      seriesMap.delete(key);
    }

    const liveScripts = new Set(attachedScripts.filter((s) => s.visible).map((s) => s.scriptId));
    for (const [scriptId] of [...scriptPanesRef.current]) {
      if (!liveScripts.has(scriptId)) scriptPanesRef.current.delete(scriptId);
    }
  }, [attachedScripts, scriptResults, candles]);

  // Re-run scripts whenever the underlying bars change.
  useEffect(() => {
    if (candles.length > 0 && attachedScripts.length > 0) void runAttachedScripts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, attachedScripts.length]);

  // -------------------------------------------------------------------------
  // Legend
  // -------------------------------------------------------------------------
  function updateLegend(param: MouseEventParams): void {
    const t = param.time as UTCTimestamp | undefined;
    if (t == null) return;
    const idx = candles.findIndex((c) => c.time === t);
    if (idx < 0) return;
    const bar = candles[idx];

    const values: LegendState['values'] = [];
    for (const inst of indicators) {
      const def = getIndicator(inst.indicatorId);
      const result = computed.get(inst.instanceId);
      if (!def || !result || !inst.visible) continue;
      for (const plot of def.plots) {
        const s = result.series[plot.key];
        if (!s) continue;
        values.push({
          label: `${def.label === plot.label ? plot.label : `${shortLabel(def.label, inst)} ${plot.label}`}`,
          value: s[idx] ?? null,
          color: inst.colors?.[plot.key] ?? plot.color,
        });
      }
    }

    setLegend({
      time: bar.time,
      ohlc: { open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume },
      values,
    });
  }

  const last = candles.at(-1);
  const shown = legend.ohlc ?? (last ? { open: last.open, high: last.high, low: last.low, close: last.close, volume: last.volume } : null);
  const shownTime = legend.time ?? last?.time ?? null;
  const currency = meta?.displayCurrency ?? '';
  const up = shown ? shown.close >= shown.open : true;

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />

      {chartReady && chartRef.current && priceSeriesRef.current && containerRef.current && (
        <DrawingLayer
          chart={chartRef.current}
          series={priceSeriesRef.current}
          container={containerRef.current}
          candles={candles}
          intraday={intraday}
        />
      )}

      {/* Legend floats above the canvas; pointer-events off so it never
          swallows a drag intended for the chart. */}
      <div className="pointer-events-none absolute left-2 top-2 z-10 select-none text-[11px] leading-tight">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold text-ink">{symbol}</span>
          <span className="text-ink-faint">{interval}</span>
          {meta?.longName && <span className="max-w-72 truncate text-ink-faint">{meta.longName}</span>}
        </div>

        {shown && (
          <div className="mt-0.5 flex flex-wrap gap-x-3 tnum">
            <LegendPair label="O" value={shown.open} currency={currency} up={up} />
            <LegendPair label="H" value={shown.high} currency={currency} up={up} />
            <LegendPair label="L" value={shown.low} currency={currency} up={up} />
            <LegendPair label="C" value={shown.close} currency={currency} up={up} />
            <span className="text-ink-faint">
              Vol <span className="text-ink-dim">{formatVolume(shown.volume)}</span>
            </span>
            {shownTime && (
              <span className="text-ink-faint">
                {new Date(shownTime * 1000).toLocaleString(undefined, {
                  year: 'numeric', month: 'short', day: '2-digit',
                  ...(intraday ? { hour: '2-digit', minute: '2-digit' } : {}),
                })}
              </span>
            )}
          </div>
        )}

        {legend.values.length > 0 && (
          <div className="mt-1 space-y-0.5">
            {legend.values.map((v, i) => (
              <div key={i} className="flex items-center gap-1.5 tnum">
                <span className="inline-block h-[2px] w-3 rounded" style={{ background: v.color }} />
                <span className="text-ink-faint">{v.label}</span>
                <span className="text-ink-dim">{formatPrice(v.value)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {loading && candles.length === 0 && (
        <Overlay>Loading {symbol}…</Overlay>
      )}
      {error && (
        <Overlay tone="error">
          <div className="font-medium">{error}</div>
          <div className="mt-1 text-ink-faint">Check the ticker, or try again once you are back online.</div>
        </Overlay>
      )}
      {!loading && !error && candles.length === 0 && (
        <Overlay>No data for {symbol} at {interval}.</Overlay>
      )}
    </div>
  );
}

function shortLabel(defLabel: string, inst: AttachedIndicator): string {
  // Show the defining parameter so two MAs are distinguishable in the legend.
  const p = inst.params;
  if (p.length != null) return `${p.maType ?? ''}${p.length}`.trim();
  if (p.fast != null && p.slow != null) return `${p.fast}/${p.slow}`;
  return defLabel;
}

function LegendPair({ label, value, currency, up }: { label: string; value: number; currency: string; up: boolean }) {
  return (
    <span className="text-ink-faint">
      {label} <span className={up ? 'text-up' : 'text-down'}>{formatPrice(value, currency)}</span>
    </span>
  );
}

function Overlay({ children, tone }: { children: React.ReactNode; tone?: 'error' }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center">
      <div className={`rounded-lg border px-4 py-3 text-xs ${
        tone === 'error' ? 'border-down/40 bg-panel text-down' : 'border-edge bg-panel text-ink-dim'
      }`}>
        {children}
      </div>
    </div>
  );
}
