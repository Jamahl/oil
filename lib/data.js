'use strict';
// Series alignment + feature engineering. Everything is causal: a feature at row i
// uses only information available by the close of day i (EIA weekly data joins on
// its release date, not its week-ending date).

function mean(a) {
  let s = 0;
  for (const v of a) s += v;
  return a.length ? s / a.length : 0;
}

function std(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  let s = 0;
  for (const v of a) s += (v - m) * (v - m);
  return Math.sqrt(s / (a.length - 1));
}

function addDays(iso, d) {
  return new Date(Date.parse(iso) + d * 86400000).toISOString().slice(0, 10);
}

// As-of join: for each spine date take the latest b value with bDates <= date,
// null if the latest is older than maxGapDays (stale feed guard).
function asOfJoin(spineDates, bDates, bVals, maxGapDays) {
  const out = new Array(spineDates.length).fill(null);
  let j = 0;
  for (let i = 0; i < spineDates.length; i++) {
    while (j < bDates.length && bDates[j] <= spineDates[i]) j++;
    const k = j - 1;
    if (k >= 0) {
      const gap = (Date.parse(spineDates[i]) - Date.parse(bDates[k])) / 86400000;
      if (gap <= maxGapDays) out[i] = bVals[k];
    }
  }
  return out;
}

function pctChange(arr, n) {
  return arr.map((v, i) => {
    const prev = i >= n ? arr[i - n] : null;
    if (v == null || prev == null || prev === 0) return null;
    return v / prev - 1;
  });
}

function change(arr, n) {
  return arr.map((v, i) => {
    const prev = i >= n ? arr[i - n] : null;
    if (v == null || prev == null) return null;
    return v - prev;
  });
}

// Rolling std of 1d returns over the trailing n days, as a volatility feature.
function rollingVol(ret1, n) {
  const out = new Array(ret1.length).fill(null);
  for (let i = n; i < ret1.length; i++) {
    const w = ret1.slice(i - n + 1, i + 1);
    if (w.some((v) => v == null)) continue;
    out[i] = std(w);
  }
  return out;
}

const FEATURES = [
  { key: 'ret1', label: 'Brent 1d return' },
  { key: 'ret5', label: 'Brent 5d return' },
  { key: 'ret21', label: 'Brent 21d return' },
  { key: 'vol21', label: 'Realized vol (21d)' },
  { key: 'dxyRet5', label: 'Dollar index 5d return' },
  { key: 'ovxLvl', label: 'OVX level (oil VIX)' },
  { key: 'ovxChg5', label: 'OVX 5d change' },
  { key: 'spreadLvl', label: 'WTI−Brent spread ($)' },
  { key: 'spreadChg5', label: 'Spread 5d change' },
  { key: 'invChg', label: 'EIA crude stocks Δ (mmbbl/wk)' },
  { key: 'invZ', label: 'Stocks Δ z-score (52w)' },
];

// EIA WPSR: week ends Friday, released the following Wednesday 10:30 ET.
// weekEnd + 5 days = that Wednesday; the value is usable at that day's close.
const EIA_RELEASE_LAG_DAYS = 5;

function buildDataset(raw) {
  const { brent, wti, dxy, ovx, inv } = raw;
  const dates = brent.dates;
  const bz = brent.close;
  const cl = asOfJoin(dates, wti.dates, wti.close, 5);
  const dx = asOfJoin(dates, dxy.dates, dxy.close, 5);
  const ov = ovx ? asOfJoin(dates, ovx.dates, ovx.close, 7) : new Array(dates.length).fill(null);

  // Weekly inventory -> change, z-score, joined as-of the release date.
  let invChgAsOf = new Array(dates.length).fill(null);
  let invZAsOf = new Array(dates.length).fill(null);
  let invLvlAsOf = new Array(dates.length).fill(null);
  let invWeekly = null;
  if (inv && inv.weekEnd.length > 60) {
    const chg = [];
    const zs = [];
    const avail = [];
    for (let i = 1; i < inv.weekEnd.length; i++) {
      const c = (inv.kbbl[i] - inv.kbbl[i - 1]) / 1000; // mmbbl
      chg.push(c);
      avail.push(addDays(inv.weekEnd[i], EIA_RELEASE_LAG_DAYS));
      const w = chg.slice(Math.max(0, chg.length - 52));
      const s = std(w);
      zs.push(s > 0 ? (c - mean(w)) / s : 0);
    }
    invChgAsOf = asOfJoin(dates, avail, chg, 40);
    invZAsOf = asOfJoin(dates, avail, zs, 40);
    invLvlAsOf = asOfJoin(dates, avail, inv.kbbl.slice(1).map((v) => v / 1000), 40);
    invWeekly = { weekEnd: inv.weekEnd.slice(1), chg, level: inv.kbbl.slice(1).map((v) => v / 1000) };
  }

  const ret1 = pctChange(bz, 1);
  const spread = dates.map((_, i) => (cl[i] != null && bz[i] != null ? cl[i] - bz[i] : null));

  const cols = {
    ret1,
    ret5: pctChange(bz, 5),
    ret21: pctChange(bz, 21),
    vol21: rollingVol(ret1, 21),
    dxyRet5: pctChange(dx, 5),
    ovxLvl: ov,
    ovxChg5: change(ov, 5),
    spreadLvl: spread,
    spreadChg5: change(spread, 5),
    invChg: invChgAsOf,
    invZ: invZAsOf,
  };

  // Keep features whose column has real coverage (a dead optional feed drops out).
  const activeFeatures = FEATURES.filter(({ key }) => {
    const col = cols[key];
    const nonNull = col.filter((v) => v != null).length;
    return nonNull > dates.length * 0.5;
  });

  // Targets: forward returns (unknown for the last rows — stays null).
  const fwd1 = dates.map((_, i) => (i + 1 < bz.length ? bz[i + 1] / bz[i] - 1 : null));
  const fwd5 = dates.map((_, i) => (i + 5 < bz.length ? bz[i + 5] / bz[i] - 1 : null));
  const fwd21 = dates.map((_, i) => (i + 21 < bz.length ? bz[i + 21] / bz[i] - 1 : null));

  // Assemble rows where every active feature is present.
  const rows = [];
  for (let i = 0; i < dates.length; i++) {
    const x = activeFeatures.map(({ key }) => cols[key][i]);
    if (x.some((v) => v == null)) continue;
    rows.push({ i, date: dates[i], x, fwd1: fwd1[i], fwd5: fwd5[i], fwd21: fwd21[i], brent: bz[i] });
  }

  return {
    dates,
    brent: bz,
    wti: cl,
    dxy: dx,
    ovx: ov,
    spread,
    invLvlAsOf,
    invWeekly,
    features: activeFeatures,
    rows,
  };
}

// Intraday bar series -> model rows. Features: bar momentum at three scales +
// rolling vol. Target: next-bar return. Same row shape as the daily dataset so
// the walk-forward machinery is reused unchanged (target key 'fwd1' = next bar).
const INTRADAY_FEATURES = [
  { key: 'ret1', label: 'last-bar return' },
  { key: 'ret4', label: '4-bar return' },
  { key: 'ret16', label: '16-bar return' },
  { key: 'vol32', label: 'rolling vol (32 bars)' },
];

function buildIntradayRows(series) {
  const c = series.close;
  const ret1 = pctChange(c, 1);
  const ret4 = pctChange(c, 4);
  const ret16 = pctChange(c, 16);
  const vol32 = rollingVol(ret1, 32);
  const rows = [];
  for (let i = 0; i < c.length; i++) {
    const x = [ret1[i], ret4[i], ret16[i], vol32[i]];
    if (x.some((v) => v == null)) continue;
    rows.push({
      i,
      date: series.dates[i],
      x,
      fwd1: i + 1 < c.length ? c[i + 1] / c[i] - 1 : null,
      fwd2: i + 2 < c.length ? c[i + 2] / c[i] - 1 : null, // 2 bars = 30 min on the 15m series
      brent: c[i],
    });
  }
  return { rows, features: INTRADAY_FEATURES };
}

// Generic daily rows for instruments without the oil fundamentals stack
// (curve/EIA/OVX/DXY/WTI). Features: momentum at 1/5/21 days + realized vol —
// the buildIntradayRows recipe applied to daily closes. Targets fwd1/fwd5/fwd21
// so the same walk-forward machinery and horizon keys work unchanged.
const GENERIC_DAILY_FEATURES = [
  { key: 'ret1', label: '1d return' },
  { key: 'ret5', label: '5d return' },
  { key: 'ret21', label: '21d return' },
  { key: 'vol21', label: 'Realized vol (21d)' },
];

function buildGenericDailyRows(series) {
  const c = series.close;
  const dates = series.dates;
  const ret1 = pctChange(c, 1);
  const ret5 = pctChange(c, 5);
  const ret21 = pctChange(c, 21);
  const vol21 = rollingVol(ret1, 21);
  const rows = [];
  for (let i = 0; i < c.length; i++) {
    const x = [ret1[i], ret5[i], ret21[i], vol21[i]];
    if (x.some((v) => v == null)) continue;
    rows.push({
      i,
      date: dates[i],
      x,
      fwd1: i + 1 < c.length ? c[i + 1] / c[i] - 1 : null,
      fwd5: i + 5 < c.length ? c[i + 5] / c[i] - 1 : null,
      fwd21: i + 21 < c.length ? c[i + 21] / c[i] - 1 : null,
      close: c[i],
    });
  }
  return { dates, close: c, features: GENERIC_DAILY_FEATURES, rows };
}

// Trailing per-step return volatility (std of last n one-step returns).
function recentVol(closeArr, n) {
  const rets = [];
  for (let i = Math.max(1, closeArr.length - n); i < closeArr.length; i++) {
    if (closeArr[i] != null && closeArr[i - 1] != null && closeArr[i - 1] !== 0) {
      rets.push(closeArr[i] / closeArr[i - 1] - 1);
    }
  }
  return std(rets);
}

// Pearson correlation over pairs where both sides are non-null.
function pearson(a, b) {
  const xs = [];
  const ys = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] != null && b[i] != null) {
      xs.push(a[i]);
      ys.push(b[i]);
    }
  }
  if (xs.length < 3) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) * (xs[i] - mx);
    syy += (ys[i] - my) * (ys[i] - my);
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

module.exports = { buildDataset, buildIntradayRows, buildGenericDailyRows, recentVol, pearson, mean, std, FEATURES };
