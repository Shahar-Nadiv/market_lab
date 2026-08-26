/**
 * Starter scripts, seeded on first run.
 *
 * These double as the documentation for the API — every one of them is a
 * working script that demonstrates a different part of the surface.
 */

export interface ExampleScript {
  name: string;
  overlay: boolean;
  source: string;
}

export const EXAMPLE_SCRIPTS: ExampleScript[] = [
  {
    name: 'Golden Cross (150 / 200)',
    overlay: true,
    source: `indicator("Golden Cross", { overlay: true })

const fastLen = input.int(150, "Fast DMA")
const slowLen = input.int(200, "Slow DMA")

const fast = sma(close, fastLen)
const slow = sma(close, slowLen)

plot(fast, { color: "#2962ff", title: "150 DMA", lineWidth: 2 })
plot(slow, { color: "#ff6d00", title: "200 DMA", lineWidth: 2 })

// Marks the bar where the fast average crosses the slow one.
plotshape(crossover(fast, slow), {
  shape: "triangleUp", location: "belowBar", color: "#26a69a", title: "Golden cross"
})
plotshape(crossunder(fast, slow), {
  shape: "triangleDown", location: "aboveBar", color: "#ef5350", title: "Death cross"
})

alertcondition(crossover(fast, slow), "Golden cross")
alertcondition(crossunder(fast, slow), "Death cross")
`,
  },
  {
    name: 'Distance from 200 DMA',
    overlay: false,
    source: `indicator("% from 200 DMA", { overlay: false })

const len = input.int(200, "Length")
const ma = sma(close, len)

// How far price is stretched from its long average, in percent.
const dist = div(mul(sub(close, ma), 100), ma)

plot(dist, { color: "#9c27b0", title: "% from MA", lineWidth: 2 })
hline(0, { color: "#787b86", title: "MA" })
hline(10, { color: "#ef5350", title: "Extended" })
hline(-10, { color: "#26a69a", title: "Oversold" })

alertcondition(map(dist, d => d > 15), "More than 15% above the 200 DMA")
`,
  },
  {
    name: 'RSI with divergence shading',
    overlay: false,
    source: `indicator("RSI", { overlay: false })

const len = input.int(14, "Length")
const r = rsi(close, len)

plot(r, { color: "#9c27b0", title: "RSI", lineWidth: 2 })
hline(70, { color: "#ef5350", title: "Overbought" })
hline(50, { color: "#787b86" })
hline(30, { color: "#26a69a", title: "Oversold" })

plotshape(map(r, v => v > 70), { shape: "circle", location: "aboveBar", color: "#ef5350" })
plotshape(map(r, v => v < 30), { shape: "circle", location: "belowBar", color: "#26a69a" })

alertcondition(crossunder(r, 70), "RSI dropped out of overbought")
alertcondition(crossover(r, 30), "RSI reclaimed oversold")
`,
  },
  {
    name: 'Volume spike',
    overlay: false,
    source: `indicator("Volume spike", { overlay: false })

const len = input.int(20, "Average length")
const mult = input.float(2, "Spike multiple")

const avg = sma(volume, len)
const ratio = div(volume, avg)

plot(ratio, { color: "#ffb300", title: "Volume / average", style: "histogram" })
hline(1, { color: "#787b86" })
hline(mult, { color: "#ef5350", title: "Spike" })

alertcondition(map(ratio, v => v >= mult), "Volume spike")
`,
  },
  {
    name: 'Donchian breakout',
    overlay: true,
    source: `indicator("Donchian breakout", { overlay: true })

const len = input.int(20, "Channel length")

const upper = highest(high, len)
const lower = lowest(low, len)

plot(upper, { color: "#26a69a", title: "Upper" })
plot(lower, { color: "#ef5350", title: "Lower" })

// A close beyond yesterday's channel is the classic breakout trigger.
const brokeUp = []
const brokeDown = []
for (let i = 0; i < close.length; i++) {
  const u = i > 0 ? upper[i - 1] : null
  const l = i > 0 ? lower[i - 1] : null
  brokeUp.push(u != null && close[i] > u)
  brokeDown.push(l != null && close[i] < l)
}

plotshape(brokeUp, { shape: "triangleUp", location: "belowBar", color: "#26a69a" })
plotshape(brokeDown, { shape: "triangleDown", location: "aboveBar", color: "#ef5350" })

alertcondition(brokeUp, "Broke above the channel")
alertcondition(brokeDown, "Broke below the channel")
`,
  },
  {
    name: 'Bollinger squeeze',
    overlay: true,
    source: `indicator("Bollinger squeeze", { overlay: true })

const len = input.int(20, "Length")
const mult = input.float(2, "Std dev")

const bb = bbands(close, len, mult)
plot(bb.upper, { color: "#2962ff", title: "Upper", lineWidth: 1 })
plot(bb.basis, { color: "#ff6d00", title: "Basis", style: "dashed", lineWidth: 1 })
plot(bb.lower, { color: "#2962ff", title: "Lower", lineWidth: 1 })

// Band width relative to price: a low reading means volatility has compressed.
const width = div(mul(sub(bb.upper, bb.lower), 100), bb.basis)
const squeeze = map(width, w => w < 5)

plotshape(squeeze, { shape: "circle", location: "belowBar", color: "#ffb300", title: "Squeeze" })
alertcondition(squeeze, "Bollinger squeeze")
`,
  },
];
