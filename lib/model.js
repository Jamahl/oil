'use strict';
// Models + walk-forward backtest. Ridge is the workhorse (closed form, stable on
// collinear macro features); random forest is the non-linear comparison. All
// evaluation is out-of-sample via expanding-window walk-forward.

const { RandomForestRegression } = require('ml-random-forest');
const { mean, std } = require('./data');

const CLIP_Z = 5; // winsorize standardized features (Apr-2020 style outliers)

function fitScaler(X) {
  const p = X[0].length;
  const mu = new Array(p).fill(0);
  const sd = new Array(p).fill(0);
  for (let j = 0; j < p; j++) {
    const col = X.map((r) => r[j]);
    mu[j] = mean(col);
    sd[j] = std(col) || 1;
  }
  return {
    mu,
    sd,
    apply(row) {
      return row.map((v, j) => {
        const z = (v - mu[j]) / sd[j];
        return Math.max(-CLIP_Z, Math.min(CLIP_Z, z));
      });
    },
  };
}

// Solve (A)w = b via Gaussian elimination with partial pivoting. A is p x p.
function solveLinear(A, b) {
  const p = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < p; col++) {
    let piv = col;
    for (let r = col + 1; r < p; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    if (Math.abs(d) < 1e-12) continue;
    for (let r = 0; r < p; r++) {
      if (r === col) continue;
      const f = M[r][col] / d;
      for (let c = col; c <= p; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[p] / row[i]));
}

function ridgeSolve(Xs, y, lambda) {
  const n = Xs.length;
  const p = Xs[0].length;
  const yMean = mean(y);
  const A = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    const yi = y[i] - yMean;
    for (let j = 0; j < p; j++) {
      b[j] += Xs[i][j] * yi;
      for (let k = j; k < p; k++) A[j][k] += Xs[i][j] * Xs[i][k];
    }
  }
  for (let j = 0; j < p; j++) {
    for (let k = 0; k < j; k++) A[j][k] = A[k][j];
    A[j][j] += lambda;
  }
  const w = solveLinear(A, b);
  return { w, intercept: yMean };
}

const RIDGE_LAMBDAS = [1, 10, 100, 1000];

// Fit ridge on (X, y); pick lambda on the last 20% of the training window.
function fitRidge(X, y) {
  const scaler = fitScaler(X);
  const Xs = X.map((r) => scaler.apply(r));
  const cut = Math.max(30, Math.floor(Xs.length * 0.8));
  let best = null;
  for (const lambda of RIDGE_LAMBDAS) {
    const m = ridgeSolve(Xs.slice(0, cut), y.slice(0, cut), lambda);
    let se = 0;
    let n = 0;
    for (let i = cut; i < Xs.length; i++) {
      const pred = m.intercept + dot(m.w, Xs[i]);
      se += (pred - y[i]) * (pred - y[i]);
      n++;
    }
    const mse = n ? se / n : Infinity;
    if (!best || mse < best.mse) best = { lambda, mse };
  }
  const final = ridgeSolve(Xs, y, best.lambda);
  return {
    kind: 'ridge',
    lambda: best.lambda,
    weights: final.w,
    predict(row) {
      return final.intercept + dot(final.w, scaler.apply(row));
    },
    // Per-feature contribution to the prediction (standardized weight x standardized value).
    explain(row) {
      const xs = scaler.apply(row);
      return final.w.map((w, j) => w * xs[j]);
    },
  };
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Pure-JS forest is slow on thousands of rows — keep it small and cap the
// training window; it runs in a worker thread so the server stays responsive.
const FOREST_MAX_TRAIN = 1250; // ~5 trading years, rolling

function fitForest(X, y) {
  const from = Math.max(0, X.length - FOREST_MAX_TRAIN);
  const Xw = X.slice(from);
  const yw = y.slice(from);
  const scaler = fitScaler(Xw);
  const Xs = Xw.map((r) => scaler.apply(r));
  const rf = new RandomForestRegression({
    nEstimators: 24,
    treeOptions: { maxDepth: 5 },
    seed: 42,
    useSampleBagging: true,
  });
  rf.train(Xs, yw);
  return {
    kind: 'forest',
    predict(row) {
      return rf.predict([scaler.apply(row)])[0];
    },
  };
}

// Forward-return horizon in ROWS (bars) per target key. Rows are sequential in
// time, so row j's h-bar forward return is known once row j+h exists — i.e. at
// prediction index i, rows with j <= i - h are legal training data.
const HORIZON_BARS = { fwd1: 1, fwd2: 2, fwd5: 5, fwd21: 21 };

// Expanding-window walk-forward: train on the causal prefix, predict forward,
// retrain every `step` rows. Returns out-of-sample predictions aligned to rows
// (null inside the initial window).
function walkForward(rows, horizonKey, fitFn, { initialFrac = 0.6, step = 21 } = {}) {
  const h = HORIZON_BARS[horizonKey] || 1;
  const preds = new Array(rows.length).fill(null);
  const start = Math.floor(rows.length * initialFrac);
  let model = null;
  let lastTrain = -1;
  for (let i = start; i < rows.length; i++) {
    if (!model || i - lastTrain >= step) {
      const train = rows.slice(0, Math.max(0, i - h + 1)).filter((r) => r[horizonKey] != null);
      if (train.length < 100) continue;
      model = fitFn(train.map((r) => r.x), train.map((r) => r[horizonKey]));
      lastTrain = i;
    }
    if (model) preds[i] = model.predict(rows[i].x);
  }
  return preds;
}

function maxDrawdown(equity) {
  let peak = -Infinity;
  let mdd = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    mdd = Math.min(mdd, v / peak - 1);
  }
  return mdd;
}

// Metrics on the out-of-sample segment. stride > 1 evaluates non-overlapping
// windows (the honest number for multi-day horizons).
function evaluate(rows, preds, horizonKey, stride = 1) {
  const pts = [];
  for (let i = 0; i < rows.length; i++) {
    if (preds[i] != null && rows[i][horizonKey] != null) pts.push({ pred: preds[i], actual: rows[i][horizonKey], date: rows[i].date });
  }
  const sampled = stride > 1 ? pts.filter((_, k) => k % stride === 0) : pts;
  if (sampled.length < 20) return null;

  let hits = 0;
  let up = 0;
  let sae = 0;
  let saeNaive = 0;
  for (const p of sampled) {
    if (Math.sign(p.pred) !== 0 && Math.sign(p.pred) === Math.sign(p.actual)) hits++;
    if (p.actual > 0) up++;
    sae += Math.abs(p.pred - p.actual);
    saeNaive += Math.abs(p.actual); // naive forecast: zero return
  }
  const ic = corr(sampled.map((p) => p.pred), sampled.map((p) => p.actual));

  // Sign strategy on the full (stride-1) series, 1-day-horizon positions only make
  // sense compounding daily, so the equity curve always uses fwd1-style stepping:
  // position = sign(pred), payoff = position * actual / h (approx daily slice).
  const h = HORIZON_BARS[horizonKey] || 1;
  const strat = [];
  const bh = [];
  const stratRets = [];
  let e = 1;
  let eb = 1;
  for (const p of pts) {
    const r = (Math.sign(p.pred) * p.actual) / h;
    stratRets.push(r);
    e *= 1 + r;
    eb *= 1 + p.actual / h;
    strat.push({ date: p.date, v: e });
    bh.push({ date: p.date, v: eb });
  }
  const sr = std(stratRets) > 0 ? (mean(stratRets) / std(stratRets)) * Math.sqrt(252) : 0;

  return {
    n: sampled.length,
    nAll: pts.length,
    hitRate: hits / sampled.length,
    baseRateUp: up / sampled.length,
    mae: sae / sampled.length,
    maeNaive: saeNaive / sampled.length,
    ic,
    sharpeNoCosts: sr,
    maxDrawdown: maxDrawdown(strat.map((p) => p.v)),
    equity: { strategy: strat, buyHold: bh },
    oosStart: pts[0].date,
    oosEnd: pts[pts.length - 1].date,
    scatter: pts.filter((_, k) => k % Math.max(1, Math.floor(pts.length / 400)) === 0).map((p) => ({ pred: p.pred, actual: p.actual })),
  };
}

function corr(a, b) {
  const ma = mean(a);
  const mb = mean(b);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < a.length; i++) {
    sxy += (a[i] - ma) * (b[i] - mb);
    sxx += (a[i] - ma) * (a[i] - ma);
    syy += (b[i] - mb) * (b[i] - mb);
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
}

// Confidence buckets from the OOS |pred| distribution (PRD F5 style: buckets with
// realized hit rates, never a bare percentage).
function calibrateBuckets(rows, preds, horizonKey) {
  const pts = [];
  for (let i = 0; i < rows.length; i++) {
    if (preds[i] != null && rows[i][horizonKey] != null) pts.push({ pred: preds[i], actual: rows[i][horizonKey] });
  }
  if (pts.length < 60) return null;
  const abs = pts.map((p) => Math.abs(p.pred)).sort((x, y) => x - y);
  const q = (f) => abs[Math.min(abs.length - 1, Math.floor(f * abs.length))];
  const deadZone = q(0.2);
  const t1 = q(0.6);
  const t2 = q(0.87);
  const buckets = { Lean: { hits: 0, n: 0 }, Moderate: { hits: 0, n: 0 }, Strong: { hits: 0, n: 0 } };
  for (const p of pts) {
    const a = Math.abs(p.pred);
    if (a < deadZone) continue;
    const name = a >= t2 ? 'Strong' : a >= t1 ? 'Moderate' : 'Lean';
    buckets[name].n++;
    if (Math.sign(p.pred) === Math.sign(p.actual)) buckets[name].hits++;
  }
  return { deadZone, t1, t2, buckets };
}

function bucketFor(calib, pred) {
  if (!calib) return { name: 'Lean', neutral: false };
  const a = Math.abs(pred);
  if (a < calib.deadZone) return { name: 'Neutral', neutral: true };
  const name = a >= calib.t2 ? 'Strong' : a >= calib.t1 ? 'Moderate' : 'Lean';
  return { name, neutral: false };
}

function fitFnFor(kind) {
  return kind === 'forest' ? fitForest : fitRidge;
}

function downsample(arr, maxN) {
  if (!arr || arr.length <= maxN) return arr;
  const stride = Math.ceil(arr.length / maxN);
  const out = arr.filter((_, i) => i % stride === 0);
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
  return out;
}

// Full model bundle for one (kind, horizon): walk-forward backtest, bucket
// calibration, latest prediction + attribution. Pure function of (rows, features)
// so it can run inside a worker thread. opts: { step, label, lite } — lite drops
// the chart payloads (equity/scatter) for the intraday target models.
function computeBundle({ rows, features }, kind, horizonKey, opts = {}) {
  const step = opts.step || (kind === 'forest' ? 252 : 21);
  const preds = walkForward(rows, horizonKey, fitFnFor(kind), { initialFrac: 0.6, step });
  const stride = HORIZON_BARS[horizonKey] || 1;
  const bt = evaluate(rows, preds, horizonKey, stride);
  const calib = calibrateBuckets(rows, preds, horizonKey);

  const labeled = rows.filter((r) => r[horizonKey] != null);
  const finalModel = fitFnFor(kind)(labeled.map((r) => r.x), labeled.map((r) => r[horizonKey]));
  const last = rows[rows.length - 1];
  const predNow = finalModel.predict(last.x);
  const bucket = bucketFor(calib, predNow);

  let weights = null;
  let drivers = null;
  if (finalModel.kind === 'ridge') {
    weights = features.map((f, j) => ({ label: f.label, w: finalModel.weights[j] }));
    const contribs = finalModel.explain(last.x);
    drivers = features
      .map((f, j) => ({ label: f.label, contribution: contribs[j] }))
      .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
      .slice(0, 3);
  }

  const bucketStats = calib
    ? Object.entries(calib.buckets).map(([name, b]) => ({ name, n: b.n, hitRate: b.n ? b.hits / b.n : null }))
    : null;

  const HORIZON_LABELS = { fwd1: '1d', fwd2: '2bar', fwd5: '5d', fwd21: '21d' };
  return {
    kind,
    horizon: opts.label || HORIZON_LABELS[horizonKey] || horizonKey,
    asOfDate: last.date,
    prediction: {
      expectedReturn: predNow,
      direction: bucket.neutral ? 'NEUTRAL' : predNow > 0 ? 'BULLISH' : 'BEARISH',
      bucket: bucket.name,
      deadZone: calib ? calib.deadZone : null,
    },
    bucketStats,
    weights: opts.lite ? null : weights,
    drivers: opts.lite ? null : drivers,
    backtest: bt && {
      n: bt.n,
      nAll: bt.nAll,
      hitRate: bt.hitRate,
      baseRateUp: bt.baseRateUp,
      mae: bt.mae,
      maeNaive: bt.maeNaive,
      ic: bt.ic,
      sharpeNoCosts: bt.sharpeNoCosts,
      maxDrawdown: bt.maxDrawdown,
      oosStart: bt.oosStart,
      oosEnd: bt.oosEnd,
      equity: opts.lite
        ? null
        : {
            strategy: downsample(bt.equity.strategy, 600),
            buyHold: downsample(bt.equity.buyHold, 600),
          },
      scatter: opts.lite ? null : bt.scatter,
    },
  };
}

module.exports = { fitRidge, fitForest, fitFnFor, walkForward, evaluate, calibrateBuckets, bucketFor, fitScaler, computeBundle };
