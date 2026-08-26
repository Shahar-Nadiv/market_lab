/**
 * End-to-end sandbox verification against the real execution path.
 *
 * The unit tests cover the compile-time guard. This exercises the runtime
 * layers that only exist when a script actually runs: the vm context, the
 * step budget, and the worker-thread kill switch.
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron scripts/verify-sandbox.js
 */

const assert = require('node:assert');
const { runUserScript } = require('../dist/electron/services/script-host');

// Synthetic bars: a rising ramp with enough history for a 200 DMA.
const candles = Array.from({ length: 400 }, (_, i) => {
  const c = 100 + i * 0.5 + Math.sin(i / 7) * 4;
  return { time: 1600000000 + i * 86400, open: c, high: c + 1, low: c - 1, close: c, volume: 1e6 };
});

let failures = 0;

async function check(label, fn) {
  try {
    await fn();
    console.log(`  ok   ${label}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${label}\n       ${e.message}`);
  }
}

/** Assert a script is refused, and that the refusal is categorised correctly. */
async function blocked(label, source, kind) {
  await check(label, async () => {
    const r = await runUserScript(source, candles);
    assert.strictEqual(r.ok, false, 'script was allowed to run');
    if (kind) assert.strictEqual(r.error.kind, kind, `expected kind "${kind}", got "${r.error.kind}"`);
  });
}

(async () => {
  console.log('\nSandbox verification (real execution path)\n');

  console.log(' escape attempts');
  await blocked('fetch is refused', 'fetch("https://example.com")', 'security');
  await blocked('require is refused', 'const fs = require("fs")', 'security');
  await blocked('process is refused', 'plot(process.env)', 'security');
  await blocked('eval is refused', 'eval("1+1")', 'security');
  await blocked('Function constructor is refused', 'new Function("return 1")()', 'security');
  await blocked('globalThis is refused', 'plot(globalThis)', 'security');
  await blocked('constructor escape is refused', 'const f=(function(){}).constructor; f("return 1")()', 'security');
  await blocked('import is refused', 'import("node:fs")', 'security');

  await check('vm context exposes no Node globals', async () => {
    // `require` is blocked at compile time, so probe a name the guard allows
    // but the context should not provide.
    const r = await runUserScript('plot(typeof Buffer === "undefined" ? close : 0)', candles);
    assert.strictEqual(r.ok, true, r.ok ? '' : r.error.message);
    // If Buffer leaked, the plot would be a flat zero line instead of price.
    assert.ok(r.descriptor.plots[0].data[399] > 1, 'Buffer leaked into the sandbox');
  });

  console.log('\n runaway code');
  await check('infinite while loop is stopped', async () => {
    const r = await runUserScript('while (true) { }', candles);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.kind, 'timeout', `got kind "${r.error.kind}": ${r.error.message}`);
  });

  await check('infinite recursion is stopped', async () => {
    const r = await runUserScript('function f(){ return f() } f()', candles);
    assert.strictEqual(r.ok, false);
    assert.ok(['timeout', 'runtime'].includes(r.error.kind), `unexpected kind ${r.error.kind}`);
  });

  await check('a tight for loop is stopped', async () => {
    const r = await runUserScript('let x=0; for(;;){ x++ } plot(x)', candles);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.kind, 'timeout');
  });

  await check('the sandbox still works after a runaway script', async () => {
    const r = await runUserScript('plot(sma(close, 20))', candles);
    assert.strictEqual(r.ok, true, r.ok ? '' : r.error.message);
  });

  console.log('\n legitimate scripts');
  await check('golden cross produces correct plots and alerts', async () => {
    const r = await runUserScript(
      `indicator("Golden Cross", { overlay: true })
       const fast = input.int(150, "Fast DMA")
       const slow = input.int(200, "Slow DMA")
       const f = sma(close, fast)
       const s = sma(close, slow)
       plot(f, { color: "#2962ff", title: "150 DMA" })
       plot(s, { color: "#ff6d00", title: "200 DMA" })
       plotshape(crossover(f, s), { shape: "triangleUp", location: "belowBar" })
       alertcondition(crossover(f, s), "Golden cross")`,
      candles,
    );
    assert.strictEqual(r.ok, true, r.ok ? '' : r.error.message);
    assert.strictEqual(r.descriptor.title, 'Golden Cross');
    assert.strictEqual(r.descriptor.overlay, true);
    assert.strictEqual(r.descriptor.plots.length, 2);
    assert.strictEqual(r.descriptor.inputs.length, 2);
    assert.strictEqual(r.descriptor.alertConditions.length, 1);
    assert.strictEqual(r.descriptor.plots[0].data.length, candles.length, 'plot must align 1:1 with bars');
    // In a rising series the 150 DMA sits above the 200 DMA.
    assert.ok(r.descriptor.plots[0].data[399] > r.descriptor.plots[1].data[399]);
    // Leading bars have no average yet.
    assert.strictEqual(r.descriptor.plots[1].data[100], null);
  });

  await check('script maths matches the built-in indicator', async () => {
    const { runIndicator } = require('../dist/shared/indicators/registry');
    const viaScript = await runUserScript('plot(sma(close, 200))', candles);
    const viaRegistry = runIndicator('ma', candles, { length: 200, maType: 'SMA', source: 'close' });
    assert.strictEqual(viaScript.ok, true);
    const a = viaScript.descriptor.plots[0].data[399];
    const b = viaRegistry.result.series.ma[399];
    assert.ok(Math.abs(a - b) < 1e-9, `script ${a} vs registry ${b} — chart and alerts would disagree`);
  });

  await check('inputs can be overridden at attach time', async () => {
    const src = 'const len = input.int(50, "Length"); plot(sma(close, len))';
    const a = await runUserScript(src, candles, {});
    const b = await runUserScript(src, candles, { Length: 10 });
    assert.notStrictEqual(a.descriptor.plots[0].data[399], b.descriptor.plots[0].data[399]);
  });

  await check('a runtime error reports cleanly', async () => {
    const r = await runUserScript('plot(nope.field)', candles);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.kind, 'runtime');
  });

  await check('a syntax error reports its line', async () => {
    const r = await runUserScript('const a = 1\nconst b = ;', candles);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.kind, 'syntax');
    assert.strictEqual(r.error.line, 2);
  });

  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
