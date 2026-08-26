/**
 * Phase 1 acceptance test: the data layer against the live feed.
 *
 * Covers the things that are easy to get silently wrong — currency
 * normalization, cache reuse, incremental fetch, and error handling for bad
 * tickers.
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron scripts/smoke-data.js
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const { openDatabase, closeDatabase, getDatabase } = require('../dist/electron/services/db');
const { loadCandles, cachedCandles, readSymbolMeta } = require('../dist/electron/services/candle-cache');
const { fetchCandles } = require('../dist/electron/services/market-data');
const { searchAll, recordSearch } = require('../dist/electron/services/symbols');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketlab-data-'));
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

(async () => {
  console.log(`\nPhase 1 data-layer smoke test  (${dir})\n`);
  openDatabase(dir);

  const from = new Date(Date.now() - 120 * 86400 * 1000);

  // --- currency normalization ---------------------------------------------
  console.log(' currency normalization');

  await check('US equity: USD, no divisor', async () => {
    const r = await fetchCandles('AAPL', '1d', from);
    assert.strictEqual(r.meta.displayCurrency, 'USD');
    assert.strictEqual(r.meta.priceDivisor, 1);
    assert.ok(r.candles.length > 50, `expected >50 bars, got ${r.candles.length}`);
    const last = r.candles.at(-1);
    assert.ok(last.close > 10 && last.close < 10000, `implausible AAPL close ${last.close}`);
  });

  await check('TASE equity: ILA -> ILS, divided by 100', async () => {
    const r = await fetchCandles('TEVA.TA', '1d', from);
    assert.strictEqual(r.meta.rawCurrency, 'ILA');
    assert.strictEqual(r.meta.displayCurrency, 'ILS');
    assert.strictEqual(r.meta.priceDivisor, 100);
    const last = r.candles.at(-1);
    // Raw feed gives ~11000 agorot; normalized must be ~110 shekels.
    assert.ok(last.close > 5 && last.close < 1000, `TEVA.TA close ${last.close} looks like un-normalized agorot`);
  });

  await check('TASE index: ILS, NOT divided', async () => {
    const r = await fetchCandles('^TA125.TA', '1d', from);
    assert.strictEqual(r.meta.displayCurrency, 'ILS');
    assert.strictEqual(r.meta.priceDivisor, 1, 'index must not be divided by 100');
    const last = r.candles.at(-1);
    assert.ok(last.close > 500, `TA-125 at ${last.close} — looks wrongly divided`);
  });

  await check('exchange mapped from feed code', async () => {
    const us = await fetchCandles('AAPL', '1d', from);
    const il = await fetchCandles('TEVA.TA', '1d', from);
    assert.strictEqual(il.meta.exchange, 'TASE');
    assert.ok(['NASDAQ', 'NYSE'].includes(us.meta.exchange), `got ${us.meta.exchange}`);
  });

  // --- bar integrity -------------------------------------------------------
  console.log('\n bar integrity');

  await check('bars sorted, unique, and complete', async () => {
    const r = await fetchCandles('SPY', '1d', from);
    const times = r.candles.map((c) => c.time);
    for (let i = 1; i < times.length; i++) {
      assert.ok(times[i] > times[i - 1], `bars out of order at index ${i}`);
    }
    for (const c of r.candles) {
      assert.ok(Number.isFinite(c.open) && Number.isFinite(c.close), 'null OHLC leaked through');
      assert.ok(c.high >= c.low, `high ${c.high} < low ${c.low}`);
      assert.ok(c.high >= c.close && c.low <= c.close, 'close outside high/low range');
    }
  });

  await check('adjusted close present and sane', async () => {
    const r = await fetchCandles('AAPL', '1d', from);
    const last = r.candles.at(-1);
    assert.ok(last.adjClose > 0);
    // Recent bars have little adjustment, so the two should be close.
    assert.ok(Math.abs(last.adjClose - last.close) / last.close < 0.2, 'adjClose diverges implausibly');
  });

  // --- caching -------------------------------------------------------------
  console.log('\n caching');

  await check('first load hits network and persists', async () => {
    const r = await loadCandles('MSFT', '1d');
    assert.strictEqual(r.source, 'yahoo');
    assert.ok(r.candles.length > 100);
    assert.ok(cachedCandles('MSFT', '1d').length === r.candles.length, 'bars not written to cache');
  });

  await check('second load served from cache, no network', async () => {
    const r = await loadCandles('MSFT', '1d');
    assert.strictEqual(r.source, 'cache', 'fresh data should not be refetched');
  });

  await check('symbol metadata recorded on first fetch', async () => {
    const meta = readSymbolMeta('MSFT');
    assert.ok(meta, 'no metadata row written');
    assert.strictEqual(meta.displayCurrency, 'USD');
  });

  await check('force bypasses cache', async () => {
    const r = await loadCandles('MSFT', '1d', { force: true });
    assert.strictEqual(r.source, 'yahoo');
  });

  await check('re-fetch does not duplicate bars', async () => {
    const before = getDatabase()
      .prepare('SELECT COUNT(*) AS n FROM candles WHERE symbol=? AND interval=?').get('MSFT', '1d').n;
    await loadCandles('MSFT', '1d', { force: true });
    const after = getDatabase()
      .prepare('SELECT COUNT(*) AS n FROM candles WHERE symbol=? AND interval=?').get('MSFT', '1d').n;
    assert.strictEqual(after, before, `bar count changed ${before} -> ${after} on refetch`);
  });

  await check('intraday interval fetches', async () => {
    const r = await loadCandles('AAPL', '1h');
    assert.ok(r.candles.length > 20, `expected intraday bars, got ${r.candles.length}`);
  });

  // --- errors --------------------------------------------------------------
  console.log('\n error handling');

  await check('unknown symbol raises a clear error', async () => {
    await assert.rejects(
      () => loadCandles('ZZZZNOTAREALTICKER', '1d'),
      (e) => /Unknown symbol|No data found/i.test(e.message),
    );
  });

  // --- search --------------------------------------------------------------
  console.log('\n search');

  await check('seeded TASE index findable on a fresh install', async () => {
    const res = await searchAll('TA-125');
    assert.ok(res.some((r) => r.symbol === '^TA125.TA'), 'TA-125 not in results');
  });

  await check('history outranks remote results', async () => {
    recordSearch('TEVA.TA');
    recordSearch('TEVA.TA');
    recordSearch('TEVA.TA');
    const res = await searchAll('TEVA');
    assert.ok(res.length > 0, 'no results');
    assert.strictEqual(res[0].symbol, 'TEVA.TA', `expected history hit first, got ${res[0].symbol}`);
    assert.strictEqual(res[0].origin, 'history');
  });

  await check('remote search finds an unseen symbol', async () => {
    const res = await searchAll('Nvidia');
    assert.ok(res.some((r) => r.symbol === 'NVDA'), 'NVDA not found');
  });

  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
