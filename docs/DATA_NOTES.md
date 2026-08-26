# Data source notes

Empirical findings about the Yahoo Finance feed, verified against live data on
2026-08-11. These drive real decisions in `shared/exchanges.ts` and the data
layer, so re-verify before changing any of them.

## yahoo-finance2 v4 must be instantiated

v4 is a breaking change from v2/v3. The default export is a class:

```ts
import YahooFinance from 'yahoo-finance2';
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
```

Calling `yahooFinance.chart(...)` on the import directly throws
`Call 'const yahooFinance = new YahooFinance()' first`.

v4 also declares **Node >= 22**. Electron 43 bundles Node 24.18.1, so the app
is fine; only dev-time scripts run on the system Node (20.20.2 here) and will
print an "Unsupported environment" warning. Keep network calls out of the unit
test suite so `vitest` never depends on it.

## TASE prices: currency code decides the divisor, not the ticker suffix

Verified quotes:

| Symbol | `meta.currency` | Raw close | True value |
|---|---|---|---|
| `TEVA.TA` | `ILA` | 11080 | ₪110.80 |
| `POLI.TA` | `ILA` | 7608 | ₪76.08 |
| `^TA125.TA` | **`ILS`** | 4032.30 | 4032.30 index points |
| `TA35.TA` | **`ILS`** | 4157.24 | 4157.24 index points |

TASE **equities** are quoted in agorot (`ILA`, 1/100 ₪) but TASE **indices**
are quoted in points (`ILS`). Dividing every `.TA` symbol by 100 would render
TA-125 at 40 instead of 4032.

**Rule:** normalize from `meta.currency` (`ILA` → ÷100), never from the
suffix. Implemented in `normalizeCurrency()`. The same applies to LSE, where
Yahoo returns `GBp` (pence) for most listings and `GBP` for some — note the
lowercase `p`, which uppercases into a collision with real pounds and so is
special-cased before the uppercase lookup.

## Not every currency field uses the quote currency

The agorot rule above applies to **quoted prices only**. Yahoo reports some
other currency fields for the same symbol already in the major unit, with no
flag to distinguish them. Verified 2026-08-11 against `POLI.TA` (raw price
7632 agorot = ₪76.32) and `LUMI.TA`:

| Field | Unit | Evidence |
|---|---|---|
| `bid` `ask` `open` `previousClose` `dayLow/High` `fiftyTwoWeekLow/High` | agorot | match `regularMarketPrice` scale |
| `targetLowPrice` `targetMeanPrice` `targetHighPrice` | **agorot** | POLI target 8300 vs price 7632 |
| `marketCap` | **shekels** | `marketCap / (rawPrice × sharesOutstanding)` = 0.0100 for TASE, 1.0000 for AAPL |
| `dividendRate` | **shekels** | `rate / (rawPrice/100)` = 0.0341 ≈ `dividendYield` 0.0349; dividing again gives a 100x-low yield |
| `trailingEps` `forwardEps` | **shekels** | `(rawPrice/100) / eps` = 10.59 = the reported `trailingPE` exactly |

**Rule:** divide by the registry divisor only for quoted prices and analyst
price targets. Market cap, dividend rate and EPS are already in the major unit.
`fetchFundamentals()` marks the second group with a `major()` helper rather than
the `p()` price helper, because getting this wrong is silent — the number simply
renders 100x off, and a P/E built from a mis-scaled EPS looks plausible.

## TASE index tickers are inconsistent about the `^` prefix

| Index | Working ticker | Not valid |
|---|---|---|
| TA-125 | `^TA125.TA` | `TA125.TA` |
| TA-35 | `TA35.TA` | `^TA35.TA`, `^TA35` |
| TA-90 | `TA90.TA` | `^TA90.TA` |

There is no pattern to infer here — TA-125 needs the caret and TA-35/TA-90
reject it. Seed these tickers explicitly rather than deriving them.

TASE **sector** indices are not carried at all. Re-checked 2026-08-11:
`^TABANK.TA`, `TABANK.TA`, `^TA-BANK.TA`, `^TAINSUR.TA` and `TAINSUR.TA` all
return no quote. Only the broad TA-35 / TA-90 / TA-125 indices resolve, so
anywhere a sector index is wanted, use liquid constituents instead.

## TASE bars arrive on a Monday–Friday grid

Bar counts by weekday for `^TA125.TA` (weekday evaluated in `Asia/Jerusalem`):

| Year | Sun | Mon | Tue | Wed | Thu | Fri | Sat |
|---|---|---|---|---|---|---|---|
| 2014 | 0 | 49 | 48 | 48 | 49 | 50 | 0 |
| 2018 | 0 | 51 | 52 | 52 | 52 | 52 | 0 |
| 2021 | 0 | 48 | 48 | 49 | 50 | 51 | 0 |
| 2023 | 0 | 51 | 49 | 49 | 49 | 52 | 0 |
| 2024 | 0 | 50 | 47 | 48 | 49 | 52 | 0 |
| 2026 H1 | 0 | 26 | 23 | 23 | 25 | 26 | 0 |

Identical for `TEVA.TA` and `POLI.TA`. Intraday (`1h`) bars agree: full
09:50–16:50 Jerusalem sessions on Fridays, none on Sundays.

This is odd, because TASE has historically traded **Sunday–Thursday**, and the
pattern holds unchanged back to 2014 — so it is not a recent trading-week
reform. Against that, the holiday gaps in the series land on *unshifted*
dates: 2026 gaps appear at Mar 3, Apr 1, Apr 2, Apr 7 and Apr 8, matching
Purim and the Passover closures on those calendar dates rather than one day
earlier.

The two observations pull in opposite directions and were not resolved. **We
did not "correct" the data.** Bars are stored exactly as the feed returns
them, and nothing in the app hardcodes a Sun–Thu or Mon–Fri assumption:

- `observedTradingDays()` derives the session weekdays from each symbol's own
  cached bars, so market-open checks, staleness and alert scheduling are right
  under either explanation.
- Indicator math (including the 150/200 DMA) is a rolling window over ordered
  bars and is unaffected regardless — bar *order* is not in question, only the
  calendar label attached to each bar.

The only user-visible exposure is the date shown under the crosshair possibly
being one day off for TASE symbols. Worth confirming against a known TASE
close before relying on TASE date labels for anything precise.

## Yahoo quirks worth remembering

- Unknown or delisted tickers throw `No data found, symbol may be delisted`
  rather than returning an empty result — catch, don't check for `[]`.
- `meta.exchangeName` is a short code (`NMS`, `NYQ`, `PCX`, `TLV`, `SNP`),
  mapped to our registry in `exchangeFromYahooCode()`.
- `search()` results carry `exchDisp`/`shortname`/`longname` and a relevance
  `score`, and mix asset classes; filter by `quoteType`.
