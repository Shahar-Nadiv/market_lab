/**
 * Phase 6 acceptance test: the alert engine's real paths, not just its maths.
 *
 * The unit suite covers `evaluateAlert` in isolation. This exercises what only
 * exists once Electron and SQLite are in play: alert rows surviving a save/load
 * round trip, session logic refusing to poll a shut venue, the backup bundle
 * restoring what it exported, and — the one that matters most — an
 * `indicator_cross` agreeing bar-for-bar with what the chart would draw.
 *
 *   ELECTRON_RUN_AS_NODE=1 npx electron scripts/verify-alerts.js
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const { openDatabase, closeDatabase, getDatabase } = require('../dist/electron/services/db');
const {
  evaluateAlert, seedState, isEligible, EMPTY_STATE,
} = require('../dist/shared/alerts/evaluate');
const { runIndicator } = require('../dist/shared/indicators/registry');
const {
  exchangeByCode, isMarketOpen, observedTradingDays, secondsUntilNextOpen,
} = require('../dist/shared/exchanges');
const { exportBundle, importBundle, parseBundle, serializeBundle } = require('../dist/electron/services/backup');

const DAY = 86400;
const T0 = 1600000000;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketlab-alerts-'));
let failures = 0;

/** Awaits `fn` so an async check's rejection is caught like a sync throw. */
async function check(label, fn) {
  try {
    await fn();
    console.log(`  ok   ${label}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${label}\n       ${e.message}`);
  }
}

/** Synthetic daily bars, oldest first. */
function bars(n, close, volume = () => 1_000_000) {
  return Array.from({ length: n }, (_, i) => {
    const c = close(i);
    return { time: T0 + i * DAY, open: c, high: c + 0.5, low: c - 0.5, close: c, volume: volume(i), adjClose: c };
  });
}

function alert(condition, overrides = {}) {
  return {
    id: 1, symbol: 'TEST', interval: '1d', condition,
    repeat: 'every_time', cooldownSec: 0, expiresAt: null,
    enabled: true, sound: true, note: '', createdAt: T0, lastFiredAt: null,
    ...overrides,
  };
}

const RISING = bars(400, (i) => 100 + i * 0.5);

(async () => {
  console.log(`\nAlert engine verification  (${dir})\n`);

  openDatabase(dir);
  // The alerts service is required after the DB is open — it reads on import
  // through getDatabase(), which throws if the connection isn't up yet.
  const alertsService = require('../dist/electron/services/alerts');

  // ---------------------------------------------------------------------------
  console.log(' persistence');

  await check('an alert survives a save/load round trip', () => {
    const saved = alertsService.saveAlert({
      symbol: 'aapl',
      interval: '1d',
      condition: { type: 'indicator_cross', indicatorId: 'ma', indicatorParams: { length: 200, maType: 'SMA' }, plotKey: 'ma', direction: 'below' },
      repeat: 'every_time',
      cooldownSec: 600,
      note: 'watch the 200',
    });
    assert.strictEqual(saved.symbol, 'AAPL', 'symbol should be normalised to upper case');
    assert.strictEqual(saved.condition.indicatorParams.length, 200, 'condition must round-trip through JSON');
    assert.strictEqual(saved.cooldownSec, 600);
    assert.strictEqual(saved.enabled, true);
    assert.strictEqual(saved.lastFiredAt, null);
  });

  await check('editing an alert updates rather than duplicating it', () => {
    const [existing] = alertsService.listAlerts();
    alertsService.saveAlert({ ...existing, note: 'edited' });
    const all = alertsService.listAlerts();
    assert.strictEqual(all.length, 1, `expected 1 alert, got ${all.length}`);
    assert.strictEqual(all[0].note, 'edited');
  });

  await check('deleting an alert cascades to its fired events', () => {
    const [a] = alertsService.listAlerts();
    getDatabase()
      .prepare('INSERT INTO alert_events (alert_id, symbol, fired_at, price, message) VALUES (?, ?, ?, ?, ?)')
      .run(a.id, a.symbol, T0, 100, 'test');
    assert.strictEqual(alertsService.unacknowledgedCount(), 1);
    alertsService.deleteAlert(a.id);
    assert.strictEqual(alertsService.listAlertEvents().length, 0, 'events should not outlive their alert');
    assert.strictEqual(alertsService.listAlerts().length, 0);
  });

  // ---------------------------------------------------------------------------
  console.log('\n gating');

  await check('a fire-once alert stops being eligible after it fires', () => {
    const a = alert({ type: 'price_above', value: 1 }, { repeat: 'once', lastFiredAt: T0 });
    assert.strictEqual(isEligible(a, T0 + 99999), false);
  });

  await check('cooldown suppresses, then releases', () => {
    const a = alert({ type: 'price_above', value: 1 }, { cooldownSec: 300, lastFiredAt: T0 });
    assert.strictEqual(isEligible(a, T0 + 100), false, 'inside cooldown');
    assert.strictEqual(isEligible(a, T0 + 400), true, 'past cooldown');
  });

  await check('expiry disables an alert', () => {
    const a = alert({ type: 'price_above', value: 1 }, { expiresAt: T0 });
    assert.strictEqual(isEligible(a, T0 + 1), false);
  });

  // ---------------------------------------------------------------------------
  console.log('\n session awareness');

  await check('a TASE symbol is closed on a day it has never had a bar', () => {
    const tase = exchangeByCode('TASE');
    // Bars only ever on Mon–Fri Jerusalem time, matching what the feed returns.
    const observed = observedTradingDays(
      bars(400, () => 100).filter((c) => {
        const d = new Date(c.time * 1000).getUTCDay();
        return d >= 1 && d <= 5;
      }),
      tase.timezone,
      tase.defaultTradingDays,
    );
    assert.ok(!observed.includes(6), 'Saturday must not be an observed trading day');

    // A Saturday inside the Jerusalem session window.
    let saturdayMidday = null;
    for (let t = T0; t < T0 + 14 * DAY; t += 3600) {
      const local = new Intl.DateTimeFormat('en-US', { timeZone: tase.timezone, weekday: 'short', hour: '2-digit', hour12: false })
        .formatToParts(new Date(t * 1000));
      const wd = local.find((p) => p.type === 'weekday').value;
      const hr = Number(local.find((p) => p.type === 'hour').value);
      if (wd === 'Sat' && hr === 12) { saturdayMidday = t; break; }
    }
    assert.ok(saturdayMidday, 'could not locate a Saturday to test');
    assert.strictEqual(isMarketOpen(tase, observed, saturdayMidday), false, 'TASE must not poll on a Saturday');
  });

  await check('a closed venue schedules a real wait, not a busy loop', () => {
    const tase = exchangeByCode('TASE');
    const days = [1, 2, 3, 4, 5];
    // Midnight Jerusalem — closed, but the next session is hours away.
    const wait = secondsUntilNextOpen(tase, days, T0);
    assert.ok(wait > 0, 'a closed market must report a positive wait');
    assert.ok(wait <= 8 * DAY, `wait of ${wait}s is implausible`);
  });

  await check('an open venue reports zero wait', () => {
    const nyse = exchangeByCode('NYSE');
    const days = [1, 2, 3, 4, 5];
    let openMoment = null;
    for (let t = T0; t < T0 + 14 * DAY; t += 900) {
      if (isMarketOpen(nyse, days, t)) { openMoment = t; break; }
    }
    assert.ok(openMoment, 'could not find an open NYSE moment');
    assert.strictEqual(secondsUntilNextOpen(nyse, days, openMoment), 0);
  });

  // ---------------------------------------------------------------------------
  console.log('\n trigger correctness');

  await check('indicator_cross agrees with the chart bar-for-bar', () => {
    const params = { length: 200, maType: 'SMA', source: 'close' };
    const { result } = runIndicator('ma', RISING, params);
    const a = alert({ type: 'indicator_cross', indicatorId: 'ma', indicatorParams: params, plotKey: 'ma', direction: 'any' });

    // Walk the series and confirm the engine's reference matches the chart's
    // rendered value at every bar it has one.
    let compared = 0;
    for (let i = 250; i < RISING.length; i += 25) {
      const slice = RISING.slice(0, i + 1);
      const chartValue = result.series.ma[i];
      const r = evaluateAlert(a, { candles: slice, price: slice[i].close, now: T0 }, EMPTY_STATE);
      assert.ok(chartValue != null, `chart has no value at bar ${i}`);
      assert.ok(
        Math.abs(r.state.prevRef - chartValue) < 1e-9,
        `bar ${i}: engine ${r.state.prevRef} vs chart ${chartValue} — alerts and chart would disagree`,
      );
      compared++;
    }
    assert.ok(compared >= 5, 'not enough bars compared to be meaningful');
  });

  await check('a cross fires exactly once on the crossing', () => {
    const a = alert({ type: 'price_cross', value: 100, direction: 'above' });
    const candles = bars(50, () => 100);
    let state = { prevPrice: 98, prevRef: 100, prevTrue: false };
    const fires = [];
    for (const price of [99, 99.5, 101, 102, 103, 99, 101]) {
      const r = evaluateAlert(a, { candles, price, now: T0 }, state);
      state = r.state;
      if (r.fired) fires.push(price);
    }
    assert.deepStrictEqual(fires, [101, 101], 'should fire on each upward crossing, not while above');
  });

  await check('an already-true condition does not fire on the first look', () => {
    const a = alert({ type: 'price_above', value: 110 });
    const candles = bars(30, () => 130); // already well above the level
    const state = seedState(a, candles);
    const r = evaluateAlert(a, { candles, price: 131, now: T0 }, state);
    assert.strictEqual(r.fired, false, 'seeding must absorb a standing condition');
  });

  await check('a restart does not replay an alert that is still true', () => {
    const a = alert({ type: 'indicator_cross', indicatorId: 'ma', indicatorParams: { length: 200, maType: 'SMA' }, plotKey: 'ma', direction: 'any' });
    // Fresh engine state, price far above its 200 DMA and staying there.
    const state = seedState(a, RISING);
    const last = RISING[RISING.length - 1].close;
    assert.strictEqual(evaluateAlert(a, { candles: RISING, price: last, now: T0 }, state).fired, false);
  });

  await check('volume spike fires only on the outlier bar', () => {
    const a = alert({ type: 'volume_spike', value: 3, lookback: 20 });
    const quiet = bars(30, () => 100, () => 1_000_000);
    const loud = bars(30, () => 100, (i) => (i === 29 ? 10_000_000 : 1_000_000));
    const base = { prevPrice: 100, prevRef: null, prevTrue: false };
    assert.strictEqual(evaluateAlert(a, { candles: quiet, price: 100, now: T0 }, base).fired, false);
    assert.strictEqual(evaluateAlert(a, { candles: loud, price: 100, now: T0 }, base).fired, true);
  });

  await check('a broken condition reports an error instead of throwing', () => {
    const a = alert({ type: 'indicator_cross', indicatorId: 'does-not-exist' });
    const r = evaluateAlert(a, { candles: RISING, price: 100, now: T0 }, EMPTY_STATE);
    assert.strictEqual(r.fired, false);
    assert.ok(r.error, 'a misconfigured alert should report why');
  });

  // ---------------------------------------------------------------------------
  console.log('\n end-to-end firing');

  /** Seed the candle cache directly, so evaluation needs no network. */
  function seedCache(symbol, interval, candles) {
    const db = getDatabase();
    const ins = db.prepare(
      `INSERT INTO candles (symbol, interval, ts, open, high, low, close, volume, adj_close)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(symbol, interval, ts) DO UPDATE SET close = excluded.close`,
    );
    db.transaction(() => {
      for (const c of candles) ins.run(symbol, interval, c.time, c.open, c.high, c.low, c.close, c.volume, c.adjClose);
    })();
    // Mark the series fresh so the cache is not considered stale and no fetch is
    // attempted — the whole point of this test is to stay offline.
    db.prepare(
      `INSERT INTO series_meta (symbol, interval, first_ts, last_ts, fetched_at, bar_count)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(symbol, interval) DO UPDATE SET last_ts = excluded.last_ts, fetched_at = excluded.fetched_at`,
    ).run(
      symbol, interval, candles[0].time, candles[candles.length - 1].time,
      Math.floor(Date.now() / 1000), candles.length,
    );
  }

  let e2eAlert = null;

  await check('the full path fires and records an event', async () => {
    seedCache('E2E', '1d', RISING);
    e2eAlert = alertsService.saveAlert({
      symbol: 'E2E',
      interval: '1d',
      condition: {
        type: 'indicator_cross',
        indicatorId: 'ma',
        indicatorParams: { length: 200, maType: 'SMA', source: 'close' },
        plotKey: 'ma',
        direction: 'below',
      },
      repeat: 'every_time',
      cooldownSec: 0,
      note: 'e2e',
    });

    const { result } = runIndicator('ma', RISING, { length: 200, maType: 'SMA', source: 'close' });
    const ma = result.series.ma[RISING.length - 1];

    // First look seeds the edge from history — above the MA, so nothing fires.
    const first = await alertsService.evaluateAndFire(e2eAlert, { price: ma + 5, now: T0 });
    assert.strictEqual(first.fired, false, `seeding look should not fire (${first.error ?? ''})`);
    assert.strictEqual(alertsService.listAlertEvents().length, 0);

    // Now drop the price through the 200 DMA — the doctored threshold case.
    const second = await alertsService.evaluateAndFire(e2eAlert, { price: ma - 5, now: T0 + 60 });
    assert.strictEqual(second.fired, true, `cross below the 200 DMA should fire (${second.error ?? ''})`);

    const events = alertsService.listAlertEvents();
    assert.strictEqual(events.length, 1, 'exactly one event should be recorded');
    assert.strictEqual(events[0].symbol, 'E2E');
    assert.ok(/crossed below/.test(events[0].message), `unhelpful message: "${events[0].message}"`);
    assert.ok(Math.abs(events[0].price - (ma - 5)) < 1e-6, 'the event should record the triggering price');
    assert.strictEqual(events[0].acknowledged, false);
    assert.strictEqual(alertsService.unacknowledgedCount(), 1, 'tray badge count should reflect the new event');
  });

  await check('lastFiredAt is stamped, so cooldown has something to work from', () => {
    const [stored] = alertsService.listAlerts().filter((a) => a.symbol === 'E2E');
    assert.ok(stored.lastFiredAt, 'lastFiredAt must be set after firing');
    assert.strictEqual(isEligible({ ...stored, cooldownSec: 3600 }, stored.lastFiredAt + 10), false);
  });

  await check('acknowledging clears the unread count', () => {
    const [event] = alertsService.listAlertEvents();
    alertsService.ackAlertEvent(event.id);
    assert.strictEqual(alertsService.unacknowledgedCount(), 0);
  });

  await check('a fire-once alert disables itself after firing', async () => {
    seedCache('ONCE', '1d', RISING);
    const once = alertsService.saveAlert({
      symbol: 'ONCE',
      interval: '1d',
      condition: { type: 'price_below', value: 150 },
      repeat: 'once',
      cooldownSec: 0,
    });
    // Seed above the level, then drop through it.
    await alertsService.evaluateAndFire(once, { price: 200, now: T0 });
    const r = await alertsService.evaluateAndFire(once, { price: 100, now: T0 + 60 });
    assert.strictEqual(r.fired, true, `price_below should have fired (${r.error ?? ''})`);

    const after = alertsService.listAlerts().find((a) => a.id === once.id);
    assert.strictEqual(after.enabled, false, 'a fire-once alert should disable itself');
    assert.strictEqual(isEligible(after, T0 + 120), false);
  });

  await check('a restart does not replay an already-broken 200 DMA', async () => {
    // The scenario that matters: the app reopens on a symbol that crossed below
    // its 200 DMA some time ago and has stayed there. Nothing new has happened,
    // so nothing should fire — even though the condition reads as "true".
    const brokenDown = bars(400, (i) => (i < 300 ? 100 + i * 0.5 : 250 - (i - 300) * 1.3));
    seedCache('FALLEN', '1d', brokenDown);

    const params = { length: 200, maType: 'SMA', source: 'close' };
    const { result } = runIndicator('ma', brokenDown, params);
    const ma = result.series.ma[brokenDown.length - 1];
    const lastClose = brokenDown[brokenDown.length - 1].close;
    assert.ok(lastClose < ma, `setup is wrong: last close ${lastClose} should be below the MA ${ma}`);

    const fallen = alertsService.saveAlert({
      symbol: 'FALLEN',
      interval: '1d',
      condition: { type: 'indicator_cross', indicatorId: 'ma', indicatorParams: params, plotKey: 'ma', direction: 'below' },
      repeat: 'every_time',
      cooldownSec: 0,
    });

    alertsService.resetAlertState(fallen.id);
    const r = await alertsService.evaluateAndFire(fallen, { price: lastClose, now: T0 + 120 });
    assert.strictEqual(r.fired, false, 'a restart must not replay a standing condition');

    // And it still fires on a genuine new cross after recovering above the line.
    await alertsService.evaluateAndFire(fallen, { price: ma + 10, now: T0 + 180 });
    const again = await alertsService.evaluateAndFire(fallen, { price: ma - 10, now: T0 + 240 });
    assert.strictEqual(again.fired, true, 'a real cross after a recovery must still fire');
  });

  // ---------------------------------------------------------------------------
  console.log('\n backup round trip');

  await check('a bundle restores everything it exported', () => {
    const db = getDatabase();
    // Start from a clean slate: earlier sections left alerts behind, and this
    // check is about what the bundle carries, not what preceded it.
    db.prepare('DELETE FROM alerts').run();
    db.prepare('DELETE FROM watchlists').run();
    db.prepare('DELETE FROM scripts').run();

    db.prepare('INSERT INTO watchlists (name, sort_order) VALUES (?, 0)').run('Backup Test');
    const wl = db.prepare('SELECT id FROM watchlists WHERE name = ?').get('Backup Test');
    db.prepare('INSERT INTO watchlist_items (watchlist_id, symbol, sort_order) VALUES (?, ?, 0)').run(wl.id, 'TEVA.TA');
    db.prepare('INSERT INTO scripts (name, source, version, overlay, created_at, updated_at) VALUES (?, ?, 1, 1, ?, ?)')
      .run('Golden Cross', 'plot(sma(close, 200))', T0, T0);
    alertsService.saveAlert({ symbol: 'SPY', condition: { type: 'price_above', value: 500 } });

    const text = serializeBundle(exportBundle());
    assert.ok(text.length > 0);

    // Wipe, then restore from the bundle.
    db.prepare('DELETE FROM watchlists').run();
    db.prepare('DELETE FROM scripts').run();
    db.prepare('DELETE FROM alerts').run();
    assert.strictEqual(alertsService.listAlerts().length, 0, 'wipe should have emptied alerts');

    importBundle(parseBundle(text));

    const lists = db.prepare('SELECT name FROM watchlists').all().map((r) => r.name);
    assert.ok(lists.includes('Backup Test'), 'watchlist not restored');
    const items = db.prepare('SELECT symbol FROM watchlist_items').all().map((r) => r.symbol);
    assert.ok(items.includes('TEVA.TA'), 'watchlist item not restored');
    const scripts = db.prepare('SELECT name FROM scripts').all().map((r) => r.name);
    assert.ok(scripts.includes('Golden Cross'), 'script not restored');
    const restored = alertsService.listAlerts();
    assert.strictEqual(restored.length, 1, 'alert not restored');
    assert.strictEqual(restored[0].symbol, 'SPY');
    assert.strictEqual(restored[0].condition.value, 500, 'condition JSON must survive the round trip');
  });

  await check('the candle cache is deliberately excluded', () => {
    getDatabase()
      .prepare(
        `INSERT INTO candles (symbol, interval, ts, open, high, low, close, volume, adj_close)
         VALUES ('AAPL', '1d', 1000, 1, 2, 0.5, 1.5, 100, 1.5)`,
      )
      .run();
    const bundle = exportBundle();
    assert.strictEqual(bundle.tables.candles, undefined, 'candles must not be in the bundle');
    assert.ok(bundle.tables.watchlists, 'watchlists must be');
  });

  await check('a foreign file is refused with a readable message', () => {
    assert.throws(() => parseBundle('{"format":"something-else"}'), /not a MarketLab backup/);
    assert.throws(() => parseBundle('not json at all'), /not valid JSON/);
    assert.throws(() => parseBundle('{"format":"marketlab-backup","version":999}'), /newer version/);
  });

  // ---------------------------------------------------------------------------
  closeDatabase();
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
