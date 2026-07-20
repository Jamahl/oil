'use strict';
require('./lib/env');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const express = require('express');
const { yahooDaily, yahooSeries, eiaCrudeStocks, clearCache } = require('./lib/fetchers');
const { buildDataset, buildGoldDataset, buildIntradayRows, recentVol, pearson } = require('./lib/data');
const { fetchNews, newsBandFactor } = require('./lib/news');
const { DEFAULT_MODEL } = require('./lib/llm');
const { buildTargets } = require('./lib/targets');
const capital = require('./lib/capital');

const PORT = process.env.PORT || 4173;
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const state = {
  loading: null,
  data: null,
  goldLoading: null,
  goldData: null,
  models: new Map(),
};

// Runtime config (news LLM model slug) — survives restarts and cache clears.
const CONFIG_PATH = path.join(__dirname, 'data', 'config.json');
const config = { newsModel: DEFAULT_MODEL };
try {
  Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
} catch {
  /* first run */
}
function saveConfig() {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

const FEEDS = [
  { id: 'brent', label: 'Brent BZ=F', fn: () => yahooDaily('BZ=F'), required: true, staleDays: 7 },
  { id: 'wti', label: 'WTI CL=F', fn: () => yahooDaily('CL=F'), required: true, staleDays: 7 },
  { id: 'dxy', label: 'DXY', fn: () => yahooDaily('DX-Y.NYB'), required: true, staleDays: 7 },
  { id: 'ovx', label: 'OVX', fn: () => yahooDaily('^OVX'), required: false, staleDays: 10 },
  { id: 'inv', label: 'EIA stocks', fn: () => eiaCrudeStocks(), required: false, staleDays: 14 },
  { id: 'i15', label: 'Brent 15m bars', fn: () => yahooSeries('BZ=F', { range: '60d', interval: '15m', ttlMs: 30 * 60 * 1000 }), required: false, staleDays: 4 },
  { id: 'i60', label: 'Brent 1h bars', fn: () => yahooSeries('BZ=F', { range: '730d', interval: '1h', ttlMs: 2 * 60 * 60 * 1000 }), required: false, staleDays: 4 },
  { id: 'news', label: 'News', fn: () => fetchNews(config.newsModel), required: false, staleDays: 2 },
];

// Gold page feeds — separate load path so the oil dashboard's startup and
// required-feed semantics are untouched. GC=F is the only hard requirement.
const GOLD_FEEDS = [
  { id: 'gold', label: 'Gold GC=F', fn: () => yahooDaily('GC=F'), required: true, staleDays: 7 },
  { id: 'silver', label: 'Silver SI=F', fn: () => yahooDaily('SI=F'), required: false, staleDays: 10 },
  { id: 'gvz', label: 'GVZ', fn: () => yahooDaily('^GVZ'), required: false, staleDays: 10 },
  { id: 'dxy', label: 'DXY', fn: () => yahooDaily('DX-Y.NYB'), required: true, staleDays: 7 },
  { id: 'i15', label: 'Gold 15m bars', fn: () => yahooSeries('GC=F', { range: '60d', interval: '15m', ttlMs: 30 * 60 * 1000 }), required: false, staleDays: 4 },
  { id: 'i60', label: 'Gold 1h bars', fn: () => yahooSeries('GC=F', { range: '730d', interval: '1h', ttlMs: 2 * 60 * 60 * 1000 }), required: false, staleDays: 4 },
  { id: 'news', label: 'Gold news', fn: () => fetchNews(config.newsModel, 'gold'), required: false, staleDays: 2 },
];

function feedLastDate(id, value) {
  if (id === 'inv') return value.weekEnd[value.weekEnd.length - 1];
  if (id === 'news') return value.fetchedAt;
  return value.dates[value.dates.length - 1];
}

async function loadData(force = false) {
  if (state.loading) return state.loading;
  if (state.data && !force) return state.data;
  state.loading = (async () => {
    if (force) clearCache();
    const results = await Promise.allSettled(FEEDS.map((f) => f.fn()));
    const raw = {};
    const health = [];
    FEEDS.forEach((f, idx) => {
      const r = results[idx];
      if (r.status === 'fulfilled') {
        raw[f.id] = r.value;
        const lastDate = feedLastDate(f.id, r.value);
        const ageDays = (Date.now() - Date.parse(lastDate)) / 86400000;
        health.push({ id: f.id, label: f.label, ok: true, lastDate: lastDate.slice(0, 16).replace('T', ' '), stale: ageDays > f.staleDays });
      } else {
        raw[f.id] = null;
        health.push({ id: f.id, label: f.label, ok: false, error: String((r.reason && r.reason.message) || r.reason) });
        if (f.required) throw new Error(`${f.label} failed: ${(r.reason && r.reason.message) || r.reason}`);
      }
    });
    const ds = buildDataset(raw);
    if (ds.rows.length < 300) throw new Error(`only ${ds.rows.length} usable rows after alignment`);
    const intraday = {
      i15: raw.i15 ? buildIntradayRows(raw.i15) : null,
      i60: raw.i60 ? buildIntradayRows(raw.i60) : null,
    };
    const vols = {
      bar15: raw.i15 ? recentVol(raw.i15.close, 200) : null,
      bar60: raw.i60 ? recentVol(raw.i60.close, 200) : null,
      daily: recentVol(ds.brent, 63),
    };
    state.data = { raw, ds, intraday, vols, health, builtAt: new Date().toISOString() };
    state.models = new Map();
    return state.data;
  })().finally(() => {
    state.loading = null;
  });
  return state.loading;
}

async function loadGoldData(force = false) {
  if (state.goldLoading) return state.goldLoading;
  if (state.goldData && !force) return state.goldData;
  state.goldLoading = (async () => {
    const results = await Promise.allSettled(GOLD_FEEDS.map((f) => f.fn()));
    const raw = {};
    const health = [];
    GOLD_FEEDS.forEach((f, idx) => {
      const r = results[idx];
      if (r.status === 'fulfilled') {
        raw[f.id] = r.value;
        const lastDate = feedLastDate(f.id, r.value);
        const ageDays = (Date.now() - Date.parse(lastDate)) / 86400000;
        health.push({ id: f.id, label: f.label, ok: true, lastDate: lastDate.slice(0, 16).replace('T', ' '), stale: ageDays > f.staleDays });
      } else {
        raw[f.id] = null;
        health.push({ id: f.id, label: f.label, ok: false, error: String((r.reason && r.reason.message) || r.reason) });
        if (f.required) throw new Error(`${f.label} failed: ${(r.reason && r.reason.message) || r.reason}`);
      }
    });
    const ds = buildGoldDataset(raw);
    if (ds.rows.length < 300) throw new Error(`gold: only ${ds.rows.length} usable rows after alignment`);
    const intraday = {
      i15: raw.i15 ? buildIntradayRows(raw.i15) : null,
      i60: raw.i60 ? buildIntradayRows(raw.i60) : null,
    };
    const vols = {
      bar15: raw.i15 ? recentVol(raw.i15.close, 200) : null,
      bar60: raw.i60 ? recentVol(raw.i60.close, 200) : null,
      daily: recentVol(ds.gold, 63),
    };
    state.goldData = { raw, ds, intraday, vols, health, builtAt: new Date().toISOString() };
    for (const key of state.models.keys()) if (key.startsWith('gold:')) state.models.delete(key);
    return state.goldData;
  })().finally(() => {
    state.goldLoading = null;
  });
  return state.goldLoading;
}

// Model training runs in a worker thread — the pure-JS forest can take tens of
// seconds and must never block the HTTP event loop.
function runWorker(dsSlice, kind, horizonKey, opts) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'lib', 'model-worker.js'), {
      workerData: { ds: dsSlice, kind, horizonKey, opts },
    });
    const t0 = Date.now();
    worker.once('message', (bundle) => {
      console.log(`model ${kind}/${opts.label || horizonKey} computed in ${Date.now() - t0}ms`);
      resolve(bundle);
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`model worker exited with code ${code}`));
    });
  });
}

function getModelBundle(key, thunk) {
  if (!state.models.has(key)) {
    const p = thunk().catch((e) => {
      state.models.delete(key);
      throw e;
    });
    state.models.set(key, p);
  }
  return state.models.get(key);
}

function dailyBundle(kind, horizonKey) {
  const { ds } = state.data;
  return getModelBundle(`${kind}:${horizonKey}`, () =>
    runWorker({ rows: ds.rows, features: ds.features }, kind, horizonKey, {})
  );
}

function intradayBundle(id, label, step) {
  const rowsBundle = state.data.intraday[id];
  if (!rowsBundle || rowsBundle.rows.length < 500) return Promise.resolve(null);
  return getModelBundle(`ridge:${id}`, () =>
    runWorker(rowsBundle, 'ridge', 'fwd1', { step, lite: true, label })
  );
}

function goldDailyBundle(kind, horizonKey) {
  const { ds } = state.goldData;
  return getModelBundle(`gold:${kind}:${horizonKey}`, () =>
    runWorker({ rows: ds.rows, features: ds.features }, kind, horizonKey, {})
  );
}

function goldIntradayBundle(id, label, step) {
  const rowsBundle = state.goldData.intraday[id];
  if (!rowsBundle || rowsBundle.rows.length < 500) return Promise.resolve(null);
  return getModelBundle(`gold:ridge:${id}`, () =>
    runWorker(rowsBundle, 'ridge', 'fwd1', { step, lite: true, label })
  );
}

// Live spot with a short memo so a polling browser costs one upstream call
// per 3s at most. Falls back to the freshest Yahoo bar when capital.com is
// unconfigured or erroring.
const PRICE_INSTRUMENTS = ['brent', 'wti', 'gold'];
const priceCaches = new Map(); // instrument -> { at, data }
app.get('/api/price', async (req, res) => {
  try {
    const instrument = PRICE_INSTRUMENTS.includes(req.query.instrument) ? req.query.instrument : 'brent';
    const cached = priceCaches.get(instrument);
    if (cached && Date.now() - cached.at < 3000) return res.json(cached.data);
    let out = null;
    if (capital.configured()) {
      try {
        out = await capital.snapshot(instrument);
      } catch (e) {
        console.error('capital price failed:', e.message);
      }
    }
    if (!out && instrument !== 'brent') {
      return res.status(502).json({ error: `no live quote for ${instrument} (capital.com down or unconfigured)` });
    }
    if (!out) {
      await loadData();
      const { raw, ds } = state.data;
      out = {
        source: 'yahoo-delayed',
        mid: raw.i15 ? raw.i15.close[raw.i15.close.length - 1] : ds.brent[ds.brent.length - 1],
        at: raw.i15 ? raw.i15.dates[raw.i15.dates.length - 1] : ds.dates[ds.dates.length - 1],
        marketStatus: null,
        pctChange: null,
      };
    }
    priceCaches.set(instrument, { at: Date.now(), data: out });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Open positions overview (scalping bot account) — read-only, memoized like
// /api/price so a polling browser costs one upstream call per 3s at most.
let posCache = { at: 0, data: null };
app.get('/api/positions', async (req, res) => {
  try {
    if (!capital.configured()) return res.json({ configured: false });
    if (posCache.data && Date.now() - posCache.at < 3000) return res.json(posCache.data);
    const snap = await capital.positions();
    const totalPl = snap.positions.reduce((s, p) => s + (p.pl || 0), 0);
    const currencies = [...new Set(snap.positions.map((p) => p.currency).filter(Boolean))];
    const out = {
      configured: true,
      env: snap.env,
      at: snap.at,
      count: snap.positions.length,
      totalPl,
      currency: currencies.length === 1 ? currencies[0] : null,
      positions: snap.positions,
    };
    posCache = { at: Date.now(), data: out };
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/api/config', (req, res) => {
  res.json({
    newsModel: config.newsModel,
    llmKeyPresent: Boolean(process.env.OPENROUTER_API_KEY),
    parallelKeyPresent: Boolean(process.env.PARALLEL_API_KEY),
    capitalConfigured: capital.configured(),
  });
});

app.post('/api/config', async (req, res) => {
  try {
    const slug = String((req.body && req.body.newsModel) || '').trim();
    if (!/^[\w.-]+\/[\w.:-]+$/.test(slug) || slug.length > 100) {
      return res.status(400).json({ error: 'invalid model slug (expected e.g. poolside/laguna-xs-2.1:free)' });
    }
    config.newsModel = slug;
    saveConfig();
    if (state.data) state.data.raw.news = await fetchNews(slug); // raw lanes cached — only the LLM pass reruns
    if (state.goldData) state.goldData.raw.news = await fetchNews(slug, 'gold');
    res.json({ ok: true, newsModel: slug });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/api/dashboard', async (req, res) => {
  try {
    const kind = req.query.model === 'forest' ? 'forest' : 'ridge';
    await loadData();
    // Keep news fresh on long-running servers (raw lanes cache 30 min).
    const newsAge = state.data.raw.news ? Date.now() - Date.parse(state.data.raw.news.fetchedAt) : Infinity;
    if (newsAge > 35 * 60 * 1000) {
      try {
        state.data.raw.news = await fetchNews(config.newsModel);
      } catch (e) {
        console.error('news refresh failed:', e.message);
      }
    }
    const [h1, h5, h21, i15, i60] = await Promise.all([
      dailyBundle(kind, 'fwd1'),
      dailyBundle(kind, 'fwd5'),
      dailyBundle(kind, 'fwd21'),
      intradayBundle('i15', '15m', 400),
      intradayBundle('i60', '1h', 800),
    ]);
    const { ds, raw, intraday, vols, health, builtAt } = state.data;

    const lastIdx = ds.dates.length - 1;
    const kpi = (arr) => ({ value: arr[lastIdx], prev: arr[lastIdx - 1] });
    const invW = ds.invWeekly;
    const news = raw.news || { items: [], activity: { level: 'QUIET', points: 0 }, lanes: {} };

    // Live-ish spot: newest close across daily and intraday feeds.
    const spot15 = raw.i15 ? raw.i15.close[raw.i15.close.length - 1] : null;
    const price = spot15 != null ? spot15 : ds.brent[lastIdx];
    const asOf15 = raw.i15 ? raw.i15.dates[raw.i15.dates.length - 1] : null;
    const asOf60 = raw.i60 ? raw.i60.dates[raw.i60.dates.length - 1] : null;

    const targets = buildTargets({
      price,
      asOfDaily: ds.dates[lastIdx],
      asOf15,
      asOf60,
      bundles: { h1, h5, h21, i15, i60 },
      vols: { bar15: vols.bar15 || 0.002, bar60: vols.bar60 || 0.004, daily: vols.daily },
      newsLevel: news.activity.level,
      bandFactor: newsBandFactor(news.activity.level),
    });

    const tail = 504;
    const from = Math.max(0, ds.dates.length - tail);
    const idxRange = [];
    for (let i = from; i < ds.dates.length; i++) idxRange.push(i);

    const correlations = ds.features.map((f, j) => ({
      label: f.label,
      corr1d: pearson(ds.rows.map((r) => r.x[j]), ds.rows.map((r) => r.fwd1)),
      corr5d: pearson(ds.rows.map((r) => r.x[j]), ds.rows.map((r) => r.fwd5)),
    }));

    res.json({
      builtAt,
      health,
      price: { value: price, asOf: asOf15 || ds.dates[lastIdx] },
      news,
      targets,
      kpis: {
        brent: kpi(ds.brent),
        wti: kpi(ds.wti),
        spread: kpi(ds.spread),
        dxy: kpi(ds.dxy),
        ovx: raw.ovx ? kpi(ds.ovx) : null,
        inventory: invW
          ? { level: invW.level[invW.level.length - 1], chg: invW.chg[invW.chg.length - 1], weekEnd: invW.weekEnd[invW.weekEnd.length - 1] }
          : null,
      },
      series: {
        dates: idxRange.map((i) => ds.dates[i]),
        brent: idxRange.map((i) => ds.brent[i]),
        spread: idxRange.map((i) => ds.spread[i]),
        intraday: raw.i15
          ? { dates: raw.i15.dates.slice(-320), close: raw.i15.close.slice(-320) }
          : null,
        inventory: invW
          ? { weekEnd: invW.weekEnd.slice(-260), chg: invW.chg.slice(-260), level: invW.level.slice(-260) }
          : null,
      },
      correlations,
      models: { h1, h5, h21, i15, i60 },
      sampleInfo: {
        rows: ds.rows.length,
        firstDate: ds.rows[0].date,
        lastDate: ds.rows[ds.rows.length - 1].date,
        features: ds.features.map((f) => f.label),
        intradayBars: {
          m15: intraday.i15 ? intraday.i15.rows.length : 0,
          h1: intraday.i60 ? intraday.i60.rows.length : 0,
        },
        parallelEnabled: Boolean(process.env.PARALLEL_API_KEY),
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/api/gold/dashboard', async (req, res) => {
  try {
    const kind = req.query.model === 'forest' ? 'forest' : 'ridge';
    await loadGoldData();
    const newsAge = state.goldData.raw.news ? Date.now() - Date.parse(state.goldData.raw.news.fetchedAt) : Infinity;
    if (newsAge > 35 * 60 * 1000) {
      try {
        state.goldData.raw.news = await fetchNews(config.newsModel, 'gold');
      } catch (e) {
        console.error('gold news refresh failed:', e.message);
      }
    }
    const [h1, h5, h21, i15, i60] = await Promise.all([
      goldDailyBundle(kind, 'fwd1'),
      goldDailyBundle(kind, 'fwd5'),
      goldDailyBundle(kind, 'fwd21'),
      goldIntradayBundle('i15', '15m', 400),
      goldIntradayBundle('i60', '1h', 800),
    ]);
    const { ds, raw, intraday, vols, health, builtAt } = state.goldData;

    const lastIdx = ds.dates.length - 1;
    const kpi = (arr) => ({ value: arr[lastIdx], prev: arr[lastIdx - 1] });
    const news = raw.news || { items: [], activity: { level: 'QUIET', points: 0 }, lanes: {} };

    const spot15 = raw.i15 ? raw.i15.close[raw.i15.close.length - 1] : null;
    const price = spot15 != null ? spot15 : ds.gold[lastIdx];
    const asOf15 = raw.i15 ? raw.i15.dates[raw.i15.dates.length - 1] : null;
    const asOf60 = raw.i60 ? raw.i60.dates[raw.i60.dates.length - 1] : null;

    const targets = buildTargets({
      price,
      asOfDaily: ds.dates[lastIdx],
      asOf15,
      asOf60,
      bundles: { h1, h5, h21, i15, i60 },
      vols: { bar15: vols.bar15 || 0.002, bar60: vols.bar60 || 0.004, daily: vols.daily },
      newsLevel: news.activity.level,
      bandFactor: newsBandFactor(news.activity.level),
    });

    const tail = 504;
    const from = Math.max(0, ds.dates.length - tail);
    const idxRange = [];
    for (let i = from; i < ds.dates.length; i++) idxRange.push(i);

    const correlations = ds.features.map((f, j) => ({
      label: f.label,
      corr1d: pearson(ds.rows.map((r) => r.x[j]), ds.rows.map((r) => r.fwd1)),
      corr5d: pearson(ds.rows.map((r) => r.x[j]), ds.rows.map((r) => r.fwd5)),
    }));

    res.json({
      builtAt,
      health,
      price: { value: price, asOf: asOf15 || ds.dates[lastIdx] },
      news,
      targets,
      kpis: {
        gold: kpi(ds.gold),
        silver: raw.silver ? kpi(ds.silver) : null,
        ratio: raw.silver ? kpi(ds.ratio) : null,
        dxy: kpi(ds.dxy),
        gvz: raw.gvz ? kpi(ds.gvz) : null,
      },
      series: {
        dates: idxRange.map((i) => ds.dates[i]),
        gold: idxRange.map((i) => ds.gold[i]),
        ratio: idxRange.map((i) => ds.ratio[i]),
        intraday: raw.i15
          ? { dates: raw.i15.dates.slice(-320), close: raw.i15.close.slice(-320) }
          : null,
      },
      correlations,
      models: { h1, h5, h21, i15, i60 },
      sampleInfo: {
        rows: ds.rows.length,
        firstDate: ds.rows[0].date,
        lastDate: ds.rows[ds.rows.length - 1].date,
        features: ds.features.map((f) => f.label),
        intradayBars: {
          m15: intraday.i15 ? intraday.i15.rows.length : 0,
          h1: intraday.i60 ? intraday.i60.rows.length : 0,
        },
        parallelEnabled: Boolean(process.env.PARALLEL_API_KEY),
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/refresh', async (req, res) => {
  try {
    state.data = null;
    state.goldData = null;
    await loadData(true);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`CrudeSignal Lab -> http://localhost:${PORT}`);
  loadData()
    .then(() =>
      Promise.all([
        dailyBundle('ridge', 'fwd1'),
        dailyBundle('ridge', 'fwd5'),
        dailyBundle('ridge', 'fwd21'),
        intradayBundle('i15', '15m', 400),
        intradayBundle('i60', '1h', 800),
      ])
    )
    .then(() => console.log('ridge + intraday models warm'))
    .catch((e) => console.error('warmup failed:', e.message));
});
