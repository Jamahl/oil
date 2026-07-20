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
  // WPSR extras — only populated when the caller fetches the optional series
  // (research runner does; the dashboard doesn't until a candidate PROMOTEs).
  { key: 'cushChg', label: 'Cushing stocks Δ (mmbbl/wk)' },
  { key: 'cushZ', label: 'Cushing Δ z-score (52w)' },
  { key: 'gasZ', label: 'Gasoline stocks Δ z (52w)' },
  { key: 'distZ', label: 'Distillate stocks Δ z (52w)' },
  { key: 'utilChg4', label: 'Refinery utilization 4w Δ (pp)' },
  { key: 'sprChg4', label: 'SPR stocks 4w Δ (mmbbl)' },
  { key: 'cotNetOI', label: 'COT WTI net-spec / OI' },
  { key: 'cotZ', label: 'COT net/OI z-score (52w)' },
];

// EIA WPSR: week ends Friday, released the following Wednesday 10:30 ET.
// weekEnd + 5 days = that Wednesday; the value is usable at that day's close.
const EIA_RELEASE_LAG_DAYS = 5;

// Weekly series -> daily columns: change over `diffWeeks` weeks + 52w z-score of
// the 1w change, both joined as-of the WPSR release date. scale converts units.
function weeklyChangeZ(series, dates, { scale = 1, diffWeeks = 1 } = {}) {
  const nil = () => new Array(dates.length).fill(null);
  if (!series || !series.weekEnd || series.weekEnd.length < 60) return { chg: nil(), z: nil() };
  const chg = [];
  const zs = [];
  const avail = [];
  const oneWk = [];
  for (let i = diffWeeks; i < series.weekEnd.length; i++) {
    chg.push((series.value[i] - series.value[i - diffWeeks]) * scale);
    avail.push(addDays(series.weekEnd[i], EIA_RELEASE_LAG_DAYS));
    oneWk.push((series.value[i] - series.value[i - 1]) * scale);
    const w = oneWk.slice(Math.max(0, oneWk.length - 52));
    const s = std(w);
    zs.push(s > 0 ? (oneWk[oneWk.length - 1] - mean(w)) / s : 0);
  }
  return { chg: asOfJoin(dates, avail, chg, 40), z: asOfJoin(dates, avail, zs, 40) };
}

// opts.featureKeys restricts the feature set (research ablations); coverage
// filtering still applies on top.
function buildDataset(raw, opts = {}) {
  const { brent, wti, dxy, ovx, inv, cush, gas, dist, util, spr, cot } = raw;
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

  // Optional WPSR extras (kbbl -> mmbbl for stocks; utilization is in percent).
  const cushCZ = weeklyChangeZ(cush, dates, { scale: 1 / 1000 });
  const gasCZ = weeklyChangeZ(gas, dates, { scale: 1 / 1000 });
  const distCZ = weeklyChangeZ(dist, dates, { scale: 1 / 1000 });
  const utilCZ = weeklyChangeZ(util, dates, { diffWeeks: 4 });
  const sprCZ = weeklyChangeZ(spr, dates, { scale: 1 / 1000, diffWeeks: 4 });

  // COT: net non-commercial / open interest (crowdedness level + 52w z of the
  // level). As-of Tuesday, published Friday 15:30 ET -> usable at Friday close.
  const COT_RELEASE_LAG_DAYS = 3;
  let cotLvlAsOf = new Array(dates.length).fill(null);
  let cotZAsOf = new Array(dates.length).fill(null);
  if (cot && cot.asOf.length > 60) {
    const ratio = cot.asOf.map((_, i) => cot.net[i] / cot.oi[i]);
    const avail = cot.asOf.map((d) => addDays(d, COT_RELEASE_LAG_DAYS));
    const zs = ratio.map((v, i) => {
      const w = ratio.slice(Math.max(0, i - 51), i + 1);
      const s = std(w);
      return s > 0 ? (v - mean(w)) / s : 0;
    });
    cotLvlAsOf = asOfJoin(dates, avail, ratio, 30);
    cotZAsOf = asOfJoin(dates, avail, zs, 30);
  }

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
    cushChg: cushCZ.chg,
    cushZ: cushCZ.z,
    gasZ: gasCZ.z,
    distZ: distCZ.z,
    utilChg4: utilCZ.chg,
    sprChg4: sprCZ.chg,
    cotNetOI: cotLvlAsOf,
    cotZ: cotZAsOf,
  };

  // Keep features whose column has real coverage (a dead optional feed drops out).
  const activeFeatures = FEATURES.filter(({ key }) => {
    if (opts.featureKeys && !opts.featureKeys.includes(key)) return false;
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

// Gold daily dataset — same row shape as the oil dataset so the walk-forward
// model machinery is reused unchanged (the price field keeps the historical
// `brent` key; treat it as "spot"). Features mirror the oil set: momentum,
// realized vol, dollar, implied vol (GVZ = gold VIX), and the gold/silver
// ratio as the cross-metal spread analogue.
const GOLD_FEATURES = [
  { key: 'ret1', label: 'Gold 1d return' },
  { key: 'ret5', label: 'Gold 5d return' },
  { key: 'ret21', label: 'Gold 21d return' },
  { key: 'vol21', label: 'Realized vol (21d)' },
  { key: 'dxyRet5', label: 'Dollar index 5d return' },
  { key: 'gvzLvl', label: 'GVZ level (gold VIX)' },
  { key: 'gvzChg5', label: 'GVZ 5d change' },
  { key: 'ratioLvl', label: 'Gold/silver ratio' },
  { key: 'ratioChg5', label: 'Ratio 5d change' },
];

function buildGoldDataset(raw) {
  const { gold, silver, dxy, gvz } = raw;
  const dates = gold.dates;
  const au = gold.close;
  const ag = silver ? asOfJoin(dates, silver.dates, silver.close, 5) : new Array(dates.length).fill(null);
  const dx = asOfJoin(dates, dxy.dates, dxy.close, 5);
  const gv = gvz ? asOfJoin(dates, gvz.dates, gvz.close, 7) : new Array(dates.length).fill(null);

  const ret1 = pctChange(au, 1);
  const ratio = dates.map((_, i) => (au[i] != null && ag[i] != null && ag[i] !== 0 ? au[i] / ag[i] : null));

  const cols = {
    ret1,
    ret5: pctChange(au, 5),
    ret21: pctChange(au, 21),
    vol21: rollingVol(ret1, 21),
    dxyRet5: pctChange(dx, 5),
    gvzLvl: gv,
    gvzChg5: change(gv, 5),
    ratioLvl: ratio,
    ratioChg5: change(ratio, 5),
  };

  const activeFeatures = GOLD_FEATURES.filter(({ key }) => {
    const nonNull = cols[key].filter((v) => v != null).length;
    return nonNull > dates.length * 0.5;
  });

  const fwd1 = dates.map((_, i) => (i + 1 < au.length ? au[i + 1] / au[i] - 1 : null));
  const fwd5 = dates.map((_, i) => (i + 5 < au.length ? au[i + 5] / au[i] - 1 : null));
  const fwd21 = dates.map((_, i) => (i + 21 < au.length ? au[i + 21] / au[i] - 1 : null));

  const rows = [];
  for (let i = 0; i < dates.length; i++) {
    const x = activeFeatures.map(({ key }) => cols[key][i]);
    if (x.some((v) => v == null)) continue;
    rows.push({ i, date: dates[i], x, fwd1: fwd1[i], fwd5: fwd5[i], fwd21: fwd21[i], brent: au[i] });
  }

  return {
    dates,
    gold: au,
    silver: ag,
    dxy: dx,
    gvz: gv,
    ratio,
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
      brent: c[i],
    });
  }
  return { rows, features: INTRADAY_FEATURES };
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

module.exports = { buildDataset, buildGoldDataset, buildIntradayRows, recentVol, pearson, mean, std, FEATURES, GOLD_FEATURES };
