/**
 * The drawing tool catalogue.
 *
 * One entry per tool describes everything the rest of the system needs: which
 * toolbar group it belongs to, how many clicks it takes to place, what icon to
 * show, and what defaults a fresh instance gets. The toolbar's groups and
 * flyout menus are generated from this list, so adding a tool means adding an
 * entry here and a renderer in `render.ts` — there is no third place to touch.
 */

import type { ActiveTool, DrawingProps, DrawingTool } from '@shared/types';

export type ToolGroup = 'cursor' | 'lines' | 'fib' | 'shapes' | 'annotation' | 'measure' | 'position';

export interface ToolDef {
  id: ActiveTool;
  label: string;
  group: ToolGroup;
  /**
   * Clicks needed to place the drawing.
   * `'freehand'` captures a drag path; `'open'` accepts clicks until the user
   * double-clicks or presses Enter.
   */
  points: number | 'freehand' | 'open';
  /** 20×20 viewBox SVG path data. */
  icon: string;
  hint?: string;
  defaults?: Partial<DrawingProps> & { lineWidth?: number };
}

/** Standard Fibonacci retracement ratios, in the order they are drawn. */
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
export const FIB_EXT_LEVELS = [0, 0.618, 1, 1.618, 2.618, 3.618, 4.236];

export const TOOLS: ToolDef[] = [
  // --- Cursors -------------------------------------------------------------
  {
    id: 'cursor', label: 'Cross', group: 'cursor', points: 0,
    icon: 'M10 2v16M2 10h16',
    hint: 'Pan and zoom the chart; click a drawing to select it',
  },
  {
    id: 'eraser', label: 'Eraser', group: 'cursor', points: 0,
    icon: 'M3 14l7-7 5 5-4 4H5zM8 17h9',
    hint: 'Click a drawing to delete it',
  },

  // --- Lines ---------------------------------------------------------------
  {
    id: 'trendline', label: 'Trend Line', group: 'lines', points: 2,
    icon: 'M3 16L17 4M3 16h0M17 4h0',
    hint: 'A segment between two points',
  },
  {
    id: 'ray', label: 'Ray', group: 'lines', points: 2,
    icon: 'M3 16L17 4M13 4h4v4',
    hint: 'Starts at the first point and extends forever to the right',
  },
  {
    id: 'extended', label: 'Extended Line', group: 'lines', points: 2,
    icon: 'M2 17L18 3M2 17h0M18 3h0M5 14l-3 3M15 6l3-3',
    hint: 'Extends past both points',
  },
  {
    id: 'info_line', label: 'Info Line', group: 'lines', points: 2,
    icon: 'M3 16L17 4M8 6h8v4',
    hint: 'A segment labelled with the price, percent and bar change along it',
    defaults: { showLabels: true },
  },
  {
    id: 'trend_angle', label: 'Trend Angle', group: 'lines', points: 2,
    icon: 'M3 16h14M3 16L15 6M3 16a8 8 0 006-3',
    hint: 'A segment labelled with its angle from horizontal',
    defaults: { showLabels: true },
  },
  {
    id: 'hline', label: 'Horizontal Line', group: 'lines', points: 1,
    icon: 'M2 10h16',
    hint: 'A price level across the whole chart',
  },
  {
    id: 'hray', label: 'Horizontal Ray', group: 'lines', points: 1,
    icon: 'M6 10h12M6 10a1 1 0 100-.01',
    hint: 'A price level from this bar forward',
  },
  {
    id: 'vline', label: 'Vertical Line', group: 'lines', points: 1,
    icon: 'M10 2v16',
    hint: 'Marks a date across the whole chart',
  },
  {
    id: 'crossline', label: 'Cross Line', group: 'lines', points: 1,
    icon: 'M10 2v16M2 10h16',
    hint: 'A price and a date at once',
  },
  {
    id: 'parallel_channel', label: 'Parallel Channel', group: 'lines', points: 3,
    icon: 'M2 13L14 3M6 17L18 7',
    hint: 'Two parallel lines: draw the base, then set the width',
    defaults: { fillOpacity: 0.08 },
  },
  {
    id: 'disjoint_channel', label: 'Disjoint Channel', group: 'lines', points: 4,
    icon: 'M2 12L13 4M6 17L18 10',
    hint: 'Two independently angled lines forming a channel',
    defaults: { fillOpacity: 0.08 },
  },

  // --- Fibonacci -----------------------------------------------------------
  {
    id: 'fib_retracement', label: 'Fib Retracement', group: 'fib', points: 2,
    icon: 'M2 4h16M2 8h16M2 12h16M2 16h16',
    hint: 'Retracement levels between a swing low and high',
    defaults: { levels: FIB_LEVELS, showLabels: true, fillOpacity: 0.06 },
  },
  {
    id: 'fib_extension', label: 'Fib Extension', group: 'fib', points: 3,
    icon: 'M2 16h16M2 11h16M2 6h10M2 3h6',
    hint: 'Projection levels from a three-point move',
    defaults: { levels: FIB_EXT_LEVELS, showLabels: true },
  },
  {
    id: 'fib_timezone', label: 'Fib Time Zone', group: 'fib', points: 2,
    icon: 'M3 3v14M6 3v14M11 3v14M18 3v14',
    hint: 'Vertical lines at Fibonacci bar intervals',
    defaults: { showLabels: true },
  },

  // --- Shapes --------------------------------------------------------------
  {
    id: 'rectangle', label: 'Rectangle', group: 'shapes', points: 2,
    icon: 'M3 5h14v10H3z',
    defaults: { fillOpacity: 0.12 },
  },
  {
    id: 'ellipse', label: 'Ellipse', group: 'shapes', points: 2,
    icon: 'M10 5c4 0 7 2.2 7 5s-3 5-7 5-7-2.2-7-5 3-5 7-5z',
    defaults: { fillOpacity: 0.12 },
  },
  {
    id: 'triangle', label: 'Triangle', group: 'shapes', points: 3,
    icon: 'M10 4l7 12H3z',
    defaults: { fillOpacity: 0.12 },
  },
  {
    id: 'polyline', label: 'Polyline', group: 'shapes', points: 'open',
    icon: 'M2 15l5-7 4 4 7-8',
    hint: 'Click each corner; double-click or press Enter to finish',
  },
  {
    id: 'path', label: 'Path', group: 'shapes', points: 'open',
    icon: 'M2 15l5-7 4 4 6-7M14 5h4v4',
    hint: 'A polyline with an arrowhead on the last segment',
  },

  // --- Annotation ----------------------------------------------------------
  {
    id: 'text', label: 'Text', group: 'annotation', points: 1,
    icon: 'M4 5h12M10 5v11',
    hint: 'A free text note anchored to a price and date',
    defaults: { fontSize: 13 },
  },
  {
    id: 'callout', label: 'Callout', group: 'annotation', points: 2,
    icon: 'M3 4h14v8H9l-4 4v-4H3z',
    hint: 'A text box with a leader line pointing at a bar',
    defaults: { fontSize: 12, fillOpacity: 0.95 },
  },
  {
    id: 'note', label: 'Note', group: 'annotation', points: 1,
    icon: 'M10 3a5 5 0 015 5c0 4-5 9-5 9S5 12 5 8a5 5 0 015-5z',
    hint: 'A pin marker with a note on hover',
    defaults: { fontSize: 12 },
  },
  {
    id: 'price_label', label: 'Price Label', group: 'annotation', points: 1,
    icon: 'M3 7h9l5 3-5 3H3z',
    hint: 'A tag showing the exact price at a point',
    defaults: { fontSize: 11 },
  },
  {
    id: 'arrow_marker', label: 'Arrow Marker', group: 'annotation', points: 2,
    icon: 'M3 16L16 5M9 4h8v8',
    hint: 'An arrow pointing from one bar to another',
  },
  {
    id: 'brush', label: 'Brush', group: 'annotation', points: 'freehand',
    icon: 'M3 16c4 0 3-6 7-6s3 4 7 2',
    hint: 'Freehand drawing — click and drag',
    defaults: { lineWidth: 2 },
  },
  {
    id: 'highlighter', label: 'Highlighter', group: 'annotation', points: 'freehand',
    icon: 'M3 15c5 1 6-5 11-4',
    hint: 'Thick translucent freehand marker',
    defaults: { lineWidth: 12, fillOpacity: 0.3 },
  },

  // --- Measure -------------------------------------------------------------
  {
    id: 'measure', label: 'Date and Price Range', group: 'measure', points: 2,
    icon: 'M3 5h14v10H3zM3 10h14M10 5v10',
    hint: 'Price change, percent, bar count and elapsed time in one box',
    defaults: { showLabels: true, fillOpacity: 0.1 },
  },
  {
    id: 'price_range', label: 'Price Range', group: 'measure', points: 2,
    icon: 'M10 3v14M6 6l4-3 4 3M6 14l4 3 4-3',
    hint: 'Price change and percent between two levels',
    defaults: { showLabels: true, fillOpacity: 0.1 },
  },
  {
    id: 'date_range', label: 'Date Range', group: 'measure', points: 2,
    icon: 'M3 10h14M6 6L3 10l3 4M14 6l3 4-3 4',
    hint: 'Bar count and elapsed time between two dates',
    defaults: { showLabels: true, fillOpacity: 0.1 },
  },

  // --- Positions -----------------------------------------------------------
  {
    id: 'long_position', label: 'Long Position', group: 'position', points: 2,
    icon: 'M3 13h14M3 7h14M3 7v6M10 4v3M10 13v3',
    hint: 'Entry, stop and target with the resulting risk/reward',
    defaults: { showLabels: true, fillOpacity: 0.14 },
  },
  {
    id: 'short_position', label: 'Short Position', group: 'position', points: 2,
    icon: 'M3 7h14M3 13h14M3 7v6M10 4v3M10 13v3',
    hint: 'Entry, stop and target for a short, with risk/reward',
    defaults: { showLabels: true, fillOpacity: 0.14 },
  },
];

const BY_ID = new Map(TOOLS.map((t) => [t.id, t]));

export function getTool(id: ActiveTool): ToolDef | undefined {
  return BY_ID.get(id);
}

/** Toolbar groups, in the order they stack down the left rail. */
export const GROUP_ORDER: ToolGroup[] = ['cursor', 'lines', 'fib', 'shapes', 'annotation', 'measure', 'position'];

export const GROUP_LABEL: Record<ToolGroup, string> = {
  cursor: 'Cursors',
  lines: 'Lines',
  fib: 'Fibonacci',
  shapes: 'Shapes',
  annotation: 'Annotation',
  measure: 'Measure',
  position: 'Positions',
};

export function toolsInGroup(group: ToolGroup): ToolDef[] {
  return TOOLS.filter((t) => t.group === group);
}

/** Tools that take a typed string rather than only geometry. */
export const TEXT_TOOLS = new Set<DrawingTool>(['text', 'callout', 'note']);

/** How many clicks a tool needs, normalised for the placement state machine. */
export function clicksNeeded(tool: ActiveTool): number {
  const def = getTool(tool);
  if (!def || typeof def.points !== 'number') return 0;
  return def.points;
}

export const DEFAULT_COLORS = [
  '#2962ff', '#26a69a', '#ef5350', '#ff6d00', '#9c27b0',
  '#ffb300', '#66bb6a', '#787b86', '#ffffff', '#000000',
];
