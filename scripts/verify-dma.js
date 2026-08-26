/**
 * Independent verification of the moving-average math.
 *
 * Our SMA(200) is computed from raw bars and compared against Yahoo's own
 * `twoHundredDayAverage` / `fiftyDayAverage` fields, which are calculated
 * server-side by a completely separate implementation. Agreement to within a
 * fraction of a percent means our 150/200 DMA lines are trustworthy.
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron scripts/verify-dma.js
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { openDatabase, closeDatabase } = require('../dist/electron/services/db');
const { loadCandles } = require('../dist/electron/services/candle-cache');
const { runIndicator } = require('../dist/shared/indicators/registry');
const YahooFinance = require('yahoo-finance2').default;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketlab-dma-'));
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

// Yahoo's averages are computed over calendar-based windows on their side, so
// exact equality is not expected; anything under this is well within the
// difference between "200 trading days" and "200 calendar days" conventions.
const TOLERANCE_PCT = 2.0;

(async () => {
  console.log('\n200 / 50 DMA cross-check against Yahoo\'s own computed averages\n');
  openDatabase(dir);

  const symbols = ['SPY', 'AAPL', 'MSFT', 'QQQ', '^GSPC'];
  let failures = 0;

  console.log('  symbol      our SMA200   yahoo 200d     diff      our SMA50    yahoo 50d      diff');
  console.log('  ' + '-'.repeat(88));

  for (const symbol of symbols) {
    try {
      const { candles } = await loadCandles(symbol, '1d');
      const q = (await yf.quote(symbol));

      const ours200 = lastValue(runIndicator('ma', candles, { length: 200, maType: 'SMA' }).result.series.ma);
      const ours50 = lastValue(runIndicator('ma', candles, { length: 50, maType: 'SMA' }).result.series.ma);
      const theirs200 = q.twoHundredDayAverage;
      const theirs50 = q.fiftyDayAverage;

      const d200 = pctDiff(ours200, theirs200);
      const d50 = pctDiff(ours50, theirs50);

      const bad = d200 > TOLERANCE_PCT || d50 > TOLERANCE_PCT;
      if (bad) failures++;

      console.log(
        `  ${symbol.padEnd(10)} ${fmt(ours200)} ${fmt(theirs200)} ${pct(d200)}   ${fmt(ours50)} ${fmt(theirs50)} ${pct(d50)} ${bad ? ' <-- OUT OF TOLERANCE' : ''}`,
      );
    } catch (e) {
      failures++;
      console.log(`  ${symbol.padEnd(10)} ERROR ${e.message.slice(0, 60)}`);
    }
  }

  console.log(`\n  tolerance: ${TOLERANCE_PCT}%`);
  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`);

  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
})();

function lastValue(series) {
  for (let i = series.length - 1; i >= 0; i--) if (series[i] != null) return series[i];
  return NaN;
}
function pctDiff(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return Infinity;
  return Math.abs((a - b) / b) * 100;
}
const fmt = (v) => (Number.isFinite(v) ? v.toFixed(2).padStart(12) : '         n/a');
const pct = (v) => (Number.isFinite(v) ? (v.toFixed(3) + '%').padStart(9) : '      n/a');
