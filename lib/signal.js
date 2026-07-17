'use strict';
// Realtime BUY / HOLD / SELL combiner — a simplified, honest version of the
// CrudeSignal PRD §4.3 canonical combiner. Four components, each a score in
// [-1, +1], blended with tape-dependent weights and journal-verdict gates:
//   intraday  — 15m + 1h model μ, normalized by their own vol (momentum)
//   daily     — 1d + 1w model μ / vol (positioning bias)
//   news      — AI market read direction, scaled by tape heat
//   momentum  — realized last-hour move vs vol (confirmation)
// bias = Σ(w·gate·s) / Σ(w·gate); |bias| < 0.15 = HOLD (dead zone, PRD rule).
// The journal's live lean-verdicts gate the model components: a horizon whose
// displayed leans are losing to the base rate gets muted here too. Confidence
// is bucketed and labeled UNCALIBRATED until the journal has scored enough
// signal history — this is a bias meter, not investment advice.

const DEAD_ZONE = 0.15;

function tanhScore(mu, sigma) {
  if (!isFinite(mu) || !sigma) return 0;
  return Math.tanh(mu / sigma);
}

function modelScore(bundle, sigma) {
  if (!bundle || !bundle.prediction) return null;
  const p = bundle.prediction;
  if (p.direction === 'NEUTRAL') return 0;
  return tanhScore(p.expectedReturn, sigma);
}

// Journal lean-verdict -> gate multiplier for model components.
function verdictGate(verdict) {
  if (verdict === 'suppress leans') return 0;
  if (verdict === 'no edge — treat as flat') return 0.3;
  if (verdict === 'keep leans') return 1;
  return 0.7; // collecting
}

function computeSignal({ bundles, vols, news, livePrice, prevPriceHourAgo, journalStats }) {
  const tape = (news && news.activity && news.activity.level) || 'QUIET';
  const llm = news && news.llm;
  const jh = (journalStats && journalStats.horizons) || {};

  // --- component scores ---
  const sIntraday = avg([modelScore(bundles.i15, vols.bar15), modelScore(bundles.i60, vols.bar60)]);
  const sDaily = avg([modelScore(bundles.h1, vols.daily), modelScore(bundles.h5, vols.daily * Math.sqrt(5))]);
  let sNews = null;
  if (llm && llm.ok) {
    const dir = llm.lean === 'bullish' ? 1 : llm.lean === 'bearish' ? -1 : 0;
    const heat = tape === 'EVENT' ? 1 : tape === 'ELEVATED' ? 0.7 : 0.35;
    sNews = dir * heat;
  }
  let sMomo = null;
  if (livePrice != null && prevPriceHourAgo != null && vols.bar60) {
    sMomo = tanhScore(livePrice / prevPriceHourAgo - 1, vols.bar60 * 1.5);
  }

  // --- weights (tape-dependent) and gates (journal-driven) ---
  const modelDamp = tape === 'EVENT' ? 0.5 : 1; // headline tape: models take the back seat
  const gIntraday = modelDamp * avg([verdictGate(jh.m15 && jh.m15.leanVerdict), verdictGate(jh.h1 && jh.h1.leanVerdict)]);
  const gDaily = modelDamp * avg([verdictGate(jh.d1 && jh.d1.leanVerdict), verdictGate(jh.w1 && jh.w1.leanVerdict)]);
  const wNews = tape === 'QUIET' ? 0.12 : 0.3;

  const components = [
    { key: 'intraday', label: 'Intraday models (15m/1h)', s: sIntraday, w: 0.25, gate: gIntraday },
    { key: 'daily', label: 'Daily/weekly models', s: sDaily, w: 0.25, gate: gDaily },
    { key: 'news', label: 'AI news read', s: sNews, w: wNews, gate: 1 },
    { key: 'momentum', label: 'Last-hour momentum', s: sMomo, w: 0.2, gate: 1 },
  ].filter((c) => c.s != null);

  let num = 0;
  let den = 0;
  for (const c of components) {
    num += c.w * c.gate * c.s;
    den += c.w * c.gate;
  }
  const bias = den > 0 ? num / den : 0;

  const active = components.filter((c) => c.gate > 0 && Math.abs(c.s) > 0.02);
  const agreement = active.length ? active.filter((c) => Math.sign(c.s) === Math.sign(bias)).length / active.length : 0;
  const strength = Math.abs(bias) * (0.5 + 0.5 * agreement);

  const signal = bias > DEAD_ZONE ? 'BUY' : bias < -DEAD_ZONE ? 'SELL' : 'HOLD';
  const confidence = signal === 'HOLD' ? null : strength >= 0.5 ? 'Strong' : strength >= 0.3 ? 'Moderate' : 'Lean';

  return {
    signal,
    bias: Math.round(bias * 1000) / 1000,
    confidence,
    tape,
    deadZone: DEAD_ZONE,
    components: components.map((c) => ({
      key: c.key,
      label: c.label,
      score: Math.round(c.s * 100) / 100,
      weight: Math.round(c.w * c.gate * 100) / 100,
      gated: c.gate < 1,
    })),
    at: new Date().toISOString(),
    price: livePrice,
    caveat: 'uncalibrated bias meter — being scored in the journal; not investment advice',
  };
}

function avg(arr) {
  const xs = arr.filter((v) => v != null && isFinite(v));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

module.exports = { computeSignal };
