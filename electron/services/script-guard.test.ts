/**
 * Sandbox layer 2: static rejection and loop instrumentation.
 *
 * These assert the escape hatches are closed at compile time. The runtime
 * layers (worker lockdown, watchdog) are exercised end-to-end by
 * scripts/verify-sandbox.js.
 */

import { describe, it, expect } from 'vitest';
import { compileScript, ScriptCompileError, TICK_FN } from './script-guard';

function rejects(source: string) {
  return () => compileScript(source);
}

describe('rejected capabilities', () => {
  const banned: [string, string][] = [
    ['eval', 'eval("1+1")'],
    ['Function constructor', 'new Function("return 1")()'],
    ['fetch', 'fetch("https://evil.example")'],
    ['XMLHttpRequest', 'new XMLHttpRequest()'],
    ['WebSocket', 'new WebSocket("ws://evil.example")'],
    ['importScripts', 'importScripts("https://evil.example/x.js")'],
    ['globalThis', 'globalThis.fetch'],
    ['self', 'self.postMessage(1)'],
    ['window', 'window.document'],
    ['document', 'document.cookie'],
    ['localStorage', 'localStorage.getItem("k")'],
    ['indexedDB', 'indexedDB.open("db")'],
    ['require', 'require("fs")'],
    ['process', 'process.env'],
    ['Worker', 'new Worker("x.js")'],
    ['navigator', 'navigator.userAgent'],
    ['constructor escape', 'const f = (function(){}).constructor; f("return 1")()'],
  ];

  for (const [label, source] of banned) {
    it(`rejects ${label}`, () => {
      expect(rejects(source)).toThrow(ScriptCompileError);
    });
  }

  it('rejects computed access to constructor', () => {
    expect(rejects('const x = {}; x["constructor"]')).toThrow(/not allowed/);
  });

  it('rejects import declarations', () => {
    expect(rejects('import fs from "fs"')).toThrow(ScriptCompileError);
  });

  it('rejects dynamic import', () => {
    expect(rejects('import("fs")')).toThrow(ScriptCompileError);
  });

  it('rejects with statements', () => {
    expect(rejects('with (Math) { }')).toThrow(ScriptCompileError);
  });

  it('reports the offending line', () => {
    try {
      compileScript('const a = 1;\nconst b = 2;\nfetch("x");');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ScriptCompileError);
      expect((e as ScriptCompileError).line).toBe(3);
    }
  });

  it('reports syntax errors with a line number', () => {
    try {
      compileScript('const a = ;');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ScriptCompileError);
      expect((e as ScriptCompileError).line).toBe(1);
    }
  });
});

describe('legitimate scripts compile', () => {
  it('accepts the golden cross example', () => {
    const out = compileScript(`
      indicator("Golden Cross", { overlay: true })
      const fast = input.int(150, "Fast DMA")
      const slow = input.int(200, "Slow DMA")
      const f = sma(close, fast)
      const s = sma(close, slow)
      plot(f, { color: "#2962ff", title: "150 DMA" })
      plot(s, { color: "#ff6d00", title: "200 DMA" })
      plotshape(crossover(f, s), { shape: "triangleUp", location: "belowBar" })
      alertcondition(crossover(f, s), "Golden cross")
    `);
    expect(out).toContain('plot');
    expect(out).toContain('sma');
  });

  it('allows Math and normal control flow', () => {
    expect(rejects('let x = 0; for (let i = 0; i < 10; i++) { x += Math.sqrt(i) }')).not.toThrow();
  });
});

describe('loop and function instrumentation', () => {
  it('injects a budget check into while loops', () => {
    expect(compileScript('while (true) { }')).toContain(`${TICK_FN}()`);
  });

  it('injects into for, for-of and do-while', () => {
    for (const src of [
      'for (let i = 0; i < 5; i++) { }',
      'for (const x of [1,2,3]) { }',
      'do { } while (false)',
    ]) {
      expect(compileScript(src), src).toContain(`${TICK_FN}()`);
    }
  });

  it('promotes a bodyless loop to a block so the guard has somewhere to live', () => {
    const out = compileScript('let n = 0; while (n < 3) n++;');
    expect(out).toContain(`${TICK_FN}()`);
    expect(out).toMatch(/while[\s\S]*\{/);
  });

  it('injects into function declarations, so runaway recursion is caught too', () => {
    const out = compileScript('function f(n) { return f(n + 1) } f(0)');
    expect(out).toContain(`${TICK_FN}()`);
  });

  it('rewrites a concise arrow body into a block and preserves the return', () => {
    const out = compileScript('const double = x => x * 2; double(2)');
    expect(out).toContain(`${TICK_FN}()`);
    expect(out).toContain('return');
  });

  it('leaves loop-free straight-line code without guards', () => {
    expect(compileScript('const a = sma(close, 20)')).not.toContain(`${TICK_FN}()`);
  });
});

describe('instrumented output is still valid javascript', () => {
  it('reparses cleanly after instrumentation', () => {
    const once = compileScript('for (let i=0;i<3;i++){ const f = x => x+1; f(i) }');
    // Compiling the output again would trip on the injected identifier, so just
    // assert it parses as ordinary JS.
    expect(() => new Function('__mlTick__', once)).not.toThrow();
  });
});
