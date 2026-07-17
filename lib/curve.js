'use strict';
// Brent term structure (PRD C1, condensed). M1−M2 prompt spread from individual
// Yahoo contract months (keyless): backwardation = physically tight = bullish
// tilt; contango = glut = bearish. The spread usually moves before flat price
// on real supply changes (e.g. quiet OPEC over-production) — it is the
// news-independent "physical market" input to the signal combiner.
const { yahooSeries } = require('./fetchers');

const MONTH_CODES = ['F', 'G', 'H', 'J', 'K', 'M', 'N', 'Q', 'U', 'V', 'X', 'Z'];

// Candidate contract symbols starting ~front month. Brent trades ~2 months
// ahead of delivery (Sep contract is front in mid-July), so start at +2 and
// let data freshness decide which are really alive.
function candidateSymbols(now = new Date()) {
  const out = [];
  for (let k = 2; k <= 8; k++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1));
    out.push(`BZ${MONTH_CODES[d.getUTCMonth()]}${String(d.getUTCFullYear()).slice(2)}.NYM`);
  }
  return out;
}

// -> { m1, m2, spread, spread5dAgo, chg5d, state, score, asOf } | throws
async function fetchCurve() {
  const symbols = candidateSymbols();
  const settled = await Promise.allSettled(
    symbols.map((s) => yahooSeries(s, { range: '3mo', interval: '1d', ttlMs: 30 * 60 * 1000 }))
  );
  const staleCutoff = Date.now() - 5 * 86400000;
  const live = [];
  for (let i = 0; i < symbols.length; i++) {
    const r = settled[i];
    if (r.status !== 'fulfilled') continue;
    const s = r.value;
    if (s.dates.length < 8) continue;
    if (Date.parse(s.dates[s.dates.length - 1]) < staleCutoff) continue; // expired/dead month
    live.push(s);
  }
  if (live.length < 2) throw new Error('curve: fewer than 2 live Brent contract months');
  const [m1, m2] = live; // candidateSymbols() is already in contract order

  // Align the two series on shared dates and take the spread.
  const idx2 = new Map(m2.dates.map((d, i) => [d, i]));
  const spreads = [];
  for (let i = 0; i < m1.dates.length; i++) {
    const j = idx2.get(m1.dates[i]);
    if (j != null) spreads.push(m1.close[i] - m2.close[j]);
  }
  if (spreads.length < 6) throw new Error('curve: not enough overlapping sessions');

  const spread = spreads[spreads.length - 1];
  const spread5dAgo = spreads[Math.max(0, spreads.length - 6)];
  const chg5d = spread - spread5dAgo;
  // PRD C1 condensed: level (±$0.40 scale) + 5-session momentum (±$0.30 scale).
  const score = 0.6 * Math.tanh(spread / 0.4) + 0.4 * Math.tanh(chg5d / 0.3);
  const state = spread >= 0.3 ? 'backwardation' : spread <= -0.3 ? 'contango' : 'flat';

  return {
    m1: m1.symbol,
    m2: m2.symbol,
    spread: Math.round(spread * 100) / 100,
    spread5dAgo: Math.round(spread5dAgo * 100) / 100,
    chg5d: Math.round(chg5d * 100) / 100,
    state,
    score: Math.round(score * 1000) / 1000,
    asOf: m1.dates[m1.dates.length - 1],
  };
}

module.exports = { fetchCurve };
