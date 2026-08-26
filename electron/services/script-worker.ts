/**
 * Script sandbox worker thread.
 *
 * Runs one user indicator script inside a `vm` context and posts back a render
 * descriptor. Executing here rather than in the renderer buys three things:
 *
 *   - A real separate V8 context, not just a separate thread. The script gets
 *     fresh intrinsics and cannot reach our objects' prototypes.
 *   - No Content-Security-Policy conflict. The renderer's CSP forbids
 *     `unsafe-eval` (correctly — nothing in the UI should be evaluating
 *     strings), which rules out running user code there at all.
 *   - The same host the alert engine uses, so a script-driven alert and the
 *     line on the chart are produced by identical code.
 *
 * The thread is disposable: the parent terminates it on timeout, which is the
 * backstop behind the step budget compiled into the script.
 */

import { parentPort, workerData } from 'node:worker_threads';
import * as vm from 'node:vm';
import type { Candle, ScriptRenderDescriptor } from '../../shared/types';
import {
  sma, ema, wma, rma, vwma, stdev, highest, lowest, change,
  crossover, crossunder, cross, nz, rsi, atr, obv, macd, stochastic, adx, combine,
} from '../../shared/indicators/math';

export interface ScriptJob {
  code: string;
  candles: Candle[];
  inputs: Record<string, any>;
  maxSteps: number;
  timeoutMs: number;
}

/**
 * Build the API object and evaluate the script against it.
 *
 * Everything the script can see is on this object; the vm context contains
 * nothing else, so there is no `require`, no `process`, no `fetch`.
 */
export function executeScript(job: ScriptJob): ScriptRenderDescriptor {
  const { candles, inputs, maxSteps } = job;
  const n = candles.length;

  // --- step budget (the guard compiled into the script calls this) ---------
  let steps = 0;
  const tick = () => {
    if (++steps > maxSteps) {
      const e: any = new Error('Script exceeded its execution budget (possible infinite loop).');
      e.__mlKind = 'timeout';
      throw e;
    }
  };

  const open = candles.map((c) => c.open);
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const close = candles.map((c) => c.close);
  const volume = candles.map((c) => c.volume);
  const time = candles.map((c) => c.time);
  const hl2 = candles.map((c) => (c.high + c.low) / 2);
  const hlc3 = candles.map((c) => (c.high + c.low + c.close) / 3);
  const ohlc4 = candles.map((c) => (c.open + c.high + c.low + c.close) / 4);

  const declaredInputs: ScriptRenderDescriptor['inputs'] = [];
  const plots: ScriptRenderDescriptor['plots'] = [];
  const shapes: ScriptRenderDescriptor['shapes'] = [];
  const hlines: ScriptRenderDescriptor['hlines'] = [];
  const fills: ScriptRenderDescriptor['fills'] = [];
  const alertConditions: ScriptRenderDescriptor['alertConditions'] = [];
  const meta = { title: 'Untitled', overlay: true };

  function declareInput(type: any, def: any, label?: string, opts?: any): any {
    const key = label || `input${declaredInputs.length}`;
    declaredInputs.push({
      key, label: label || key, type, default: def,
      ...(opts?.min !== undefined ? { min: opts.min } : {}),
      ...(opts?.max !== undefined ? { max: opts.max } : {}),
      ...(opts?.options !== undefined ? { options: opts.options } : {}),
    });
    return Object.prototype.hasOwnProperty.call(inputs ?? {}, key) ? inputs[key] : def;
  }

  const sourceByName = (name: string): number[] => {
    switch (name) {
      case 'open': return open;
      case 'high': return high;
      case 'low': return low;
      case 'hl2': return hl2;
      case 'hlc3': return hlc3;
      case 'ohlc4': return ohlc4;
      default: return close;
    }
  };

  /** Coerce any script output into a full-length numeric series. */
  const toSeries = (v: any): (number | null)[] => {
    if (typeof v === 'number') return new Array(n).fill(Number.isFinite(v) ? v : null);
    if (!Array.isArray(v)) return new Array(n).fill(null);
    const out: (number | null)[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const x = v[i];
      out[i] = typeof x === 'number' && Number.isFinite(x) ? x : null;
    }
    return out;
  };

  const toBools = (v: any): boolean[] => {
    if (!Array.isArray(v)) return new Array(n).fill(!!v);
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = !!v[i];
    return out;
  };

  const zip = (a: any, b: any, fn: (x: number, y: number) => number | null): (number | null)[] => {
    const aArr = Array.isArray(a), bArr = Array.isArray(b);
    const len = aArr ? a.length : bArr ? b.length : 0;
    const out: (number | null)[] = new Array(len);
    for (let i = 0; i < len; i++) {
      const x = aArr ? a[i] : a;
      const y = bArr ? b[i] : b;
      out[i] = x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y) ? null : fn(x, y);
    }
    return out;
  };

  let plotSeq = 0;

  const api: Record<string, any> = {
    __mlTick__: tick,

    open, high, low, close, volume, time, hl2, hlc3, ohlc4,
    bar_index: candles.map((_, i) => i),

    input: {
      int: (def: number, label?: string, opts?: any) => Math.round(Number(declareInput('int', def, label, opts))),
      float: (def: number, label?: string, opts?: any) => Number(declareInput('float', def, label, opts)),
      bool: (def: boolean, label?: string) => !!declareInput('bool', def, label),
      string: (def: string, label?: string, opts?: any) => String(declareInput('string', def, label, opts)),
      color: (def: string, label?: string) => String(declareInput('color', def, label)),
      source: (def: string, label?: string) =>
        sourceByName(String(declareInput('source', def || 'close', label, {
          options: ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4'],
        }))),
    },

    indicator: (title: string, opts?: { overlay?: boolean }) => {
      meta.title = String(title);
      meta.overlay = !opts || opts.overlay !== false;
    },

    plot: (series: any, opts: any = {}) => {
      plots.push({
        key: `p${plotSeq++}`,
        title: opts.title || `Plot ${plots.length + 1}`,
        color: opts.color || '#2962ff',
        style: opts.style || 'line',
        lineWidth: opts.lineWidth || 2,
        data: toSeries(series),
      });
    },
    plotshape: (condition: any, opts: any = {}) => {
      shapes.push({
        key: `s${shapes.length}`,
        title: opts.title || 'Shape',
        shape: opts.shape || 'circle',
        location: opts.location || 'aboveBar',
        color: opts.color || '#2962ff',
        data: toBools(condition),
      });
    },
    hline: (value: number, opts: any = {}) => {
      hlines.push({ value: Number(value), color: opts.color || '#787b86', title: opts.title });
    },
    fill: (a: string, b: string, opts: any = {}) => {
      fills.push({ from: String(a), to: String(b), color: opts.color || 'rgba(41,98,255,0.1)' });
    },
    alertcondition: (condition: any, title?: string) => {
      alertConditions.push({
        key: `a${alertConditions.length}`,
        title: title || `Condition ${alertConditions.length + 1}`,
        data: toBools(condition),
      });
    },

    // Indicator maths — the same implementations the chart and alerts use.
    sma, ema, wma, rma, vwma, stdev, highest, lowest, change,
    crossover, crossunder, cross, nz, rsi,
    atr: (len?: number) => atr(candles, len ?? 14),
    obv: () => obv(candles),
    macd: (s: number[], f?: number, sl?: number, sig?: number) => macd(s, f ?? 12, sl ?? 26, sig ?? 9),
    stoch: (k?: number, ks?: number, d?: number) => stochastic(candles, k ?? 14, ks ?? 1, d ?? 3),
    adx: (len?: number) => adx(candles, len ?? 14),
    bbands: (s: number[], len = 20, mult = 2) => {
      const basis = sma(s, len);
      const dev = stdev(s, len);
      return {
        basis,
        upper: combine(basis, dev, (b, d) => b + mult * d),
        lower: combine(basis, dev, (b, d) => b - mult * d),
      };
    },

    // Element-wise helpers so scripts rarely need explicit loops.
    add: (a: any, b: any) => zip(a, b, (x, y) => x + y),
    sub: (a: any, b: any) => zip(a, b, (x, y) => x - y),
    mul: (a: any, b: any) => zip(a, b, (x, y) => x * y),
    div: (a: any, b: any) => zip(a, b, (x, y) => (y === 0 ? null : x / y)),
    map: (a: any[], fn: (v: any) => any) => (Array.isArray(a) ? a.map((v) => (v == null ? null : fn(v))) : []),

    Math, Number, Array, JSON, String, Boolean, isFinite, isNaN, parseInt, parseFloat,
    console: { log: () => {} },
  };

  // The context contains only our API. There is no `require`, no `process`,
  // no `globalThis` passthrough — the script's global scope IS this object.
  const context = vm.createContext(api, {
    codeGeneration: {
      // Belt and braces: even if the compile-time guard were bypassed, the
      // context itself refuses to build new code from strings.
      strings: false,
      wasm: false,
    },
  });

  vm.runInContext(job.code, context, {
    timeout: job.timeoutMs,
    displayErrors: true,
  });

  return {
    title: meta.title,
    overlay: meta.overlay,
    inputs: declaredInputs,
    plots,
    shapes,
    hlines,
    fills,
    alertConditions,
  };
}

// When loaded as a worker thread, run the job we were constructed with.
if (parentPort) {
  try {
    const descriptor = executeScript(workerData as ScriptJob);
    parentPort.postMessage({ ok: true, descriptor });
  } catch (err: any) {
    parentPort.postMessage({
      ok: false,
      error: {
        message: err?.message ?? String(err),
        kind: err?.__mlKind ?? (/Script execution timed out/i.test(err?.message ?? '') ? 'timeout' : 'runtime'),
      },
    });
  }
}
