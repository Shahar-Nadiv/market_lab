/**
 * Chart theming and colour constants.
 *
 * Kept separate from the Tailwind theme because lightweight-charts needs
 * concrete colour strings at construction time, not CSS custom properties.
 */

import type { DeepPartial, ChartOptions } from 'lightweight-charts';
import { ColorType, CrosshairMode, LineStyle } from 'lightweight-charts';

export const UP = '#26a69a';
export const DOWN = '#ef5350';
export const UP_DIM = 'rgba(38, 166, 154, 0.5)';
export const DOWN_DIM = 'rgba(239, 83, 80, 0.5)';

/**
 * The `E` earnings marker.
 *
 * Amber deliberately: it has to stay distinguishable from the up/down greens
 * and reds a strategy marker uses on the same bar, and from the blue accent
 * every line series defaults to, in both themes.
 */
export const EARNINGS = '#e8a33d';

export interface ChartPalette {
  background: string;
  text: string;
  grid: string;
  border: string;
  crosshair: string;
}

export const DARK: ChartPalette = {
  background: '#0b0e11',
  text: '#8b98a8',
  grid: '#1a222c',
  border: '#232d3a',
  crosshair: '#5a6675',
};

export const LIGHT: ChartPalette = {
  background: '#ffffff',
  text: '#5a6675',
  grid: '#eef1f5',
  border: '#d6dce4',
  crosshair: '#9aa6b4',
};

/**
 * Base chart options.
 *
 * `timeVisible` is driven by the interval: showing HH:MM on a daily chart is
 * noise, and hiding it on a 5-minute chart makes the axis unreadable.
 */
export function chartOptions(palette: ChartPalette, intraday: boolean): DeepPartial<ChartOptions> {
  return {
    layout: {
      background: { type: ColorType.Solid, color: palette.background },
      textColor: palette.text,
      fontSize: 11,
      fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
      // The on-chart TradingView watermark and link. Off here because it sits
      // over the price action in the bottom-left; the Apache-2.0 attribution
      // for lightweight-charts is carried in the README's Credits section
      // instead, which is what the licence actually asks for.
      attributionLogo: false,
      panes: { separatorColor: palette.border, separatorHoverColor: 'rgba(41, 98, 255, 0.3)', enableResize: true },
    },
    grid: {
      vertLines: { color: palette.grid, style: LineStyle.Solid },
      horzLines: { color: palette.grid, style: LineStyle.Solid },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: palette.crosshair, width: 1, style: LineStyle.Dashed, labelBackgroundColor: palette.border },
      horzLine: { color: palette.crosshair, width: 1, style: LineStyle.Dashed, labelBackgroundColor: palette.border },
    },
    rightPriceScale: {
      borderColor: palette.border,
      scaleMargins: { top: 0.1, bottom: 0.1 },
    },
    timeScale: {
      borderColor: palette.border,
      timeVisible: intraday,
      secondsVisible: false,
      rightOffset: 6,
      barSpacing: 8,
    },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
    handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    autoSize: true,
  };
}
