'use strict';
// Price-target assembly. A target = spot × (1 + model expected return), wrapped
// in a ±1σ band from trailing realized vol scaled to the horizon (√t) and widened
// when the news tape is hot. ~68% of outcomes should land inside the band — the
// UI says "about 2-in-3 odds" and shows the model's real OOS hit rate beside any
// directional lean, so the band is the honest part and the lean is context.

function edgeTag(bt) {
  if (!bt) return { label: 'unproven', cls: 'none' };
  const e = bt.hitRate - bt.baseRateUp;
  if (e > 0.05) return { label: `edge +${(e * 100).toFixed(0)}pts vs base`, cls: 'some' };
  if (e > 0.02) return { label: 'weak edge', cls: 'weak' };
  return { label: 'no proven edge', cls: 'none' };
}

function one({ id, label, price, bundle, sigma, bandFactor, asOf, note }) {
  const p = bundle && bundle.prediction;
  const mu = p ? p.expectedReturn : 0;
  const s = sigma * bandFactor;
  const neutral = !p || p.direction === 'NEUTRAL';
  return {
    id,
    label,
    asOf,
    target: price * (1 + mu),
    low: price * (1 + mu - s),
    high: price * (1 + mu + s),
    expectedReturn: mu,
    direction: neutral ? 'FLAT' : p.direction,
    bucket: p ? p.bucket : null,
    bucketHit: bucketHit(bundle),
    edge: edgeTag(bundle && bundle.backtest),
    bandPct: s,
    note: note || null,
  };
}

function bucketHit(bundle) {
  if (!bundle || !bundle.bucketStats || !bundle.prediction) return null;
  const b = bundle.bucketStats.find((x) => x.name === bundle.prediction.bucket);
  return b && b.n >= 20 ? { hitRate: b.hitRate, n: b.n } : null;
}

// vols: { bar15, bar60, daily } — one-step return std for each series.
function buildTargets({ price, asOfDaily, asOf15, asOf60, bundles, vols, newsLevel, bandFactor }) {
  const f = bandFactor;
  return [
    one({ id: 'm15', label: '15 min', price, bundle: bundles.i15, sigma: vols.bar15, bandFactor: f, asOf: asOf15, note: 'intraday model' }),
    one({ id: 'h1', label: '1 hour', price, bundle: bundles.i60, sigma: vols.bar60, bandFactor: f, asOf: asOf60, note: 'intraday model' }),
    one({ id: 'd1', label: '1 day', price, bundle: bundles.h1, sigma: vols.daily, bandFactor: f, asOf: asOfDaily }),
    one({ id: 'w1', label: '1 week', price, bundle: bundles.h5, sigma: vols.daily * Math.sqrt(5), bandFactor: f, asOf: asOfDaily }),
    one({ id: 'mo1', label: '1 month', price, bundle: bundles.h21, sigma: vols.daily * Math.sqrt(21), bandFactor: f, asOf: asOfDaily }),
  ].map((t) => ({ ...t, newsLevel }));
}

module.exports = { buildTargets };
