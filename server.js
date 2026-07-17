'use strict';
require('./lib/env');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const express = require('express');
const { yahooDaily, yahooSeries, eiaCrudeStocks, clearCache } = require('./lib/fetchers');
const { buildDataset, buildIntradayRows, recentVol, pearson } = require('./lib/data');
const { fetchNews, newsBandFactor } = require('./lib/news');
const { DEFAULT_MODEL, chatText } = require('./lib/llm');
const { buildTargets } = require('./lib/targets');
const capital = require('./lib/capital');
const journal = require('./lib/journal');

const PORT = process.env.PORT || 4173;
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const state = {
  loading: null,
  data: null,
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

// Live spot with a short memo so a polling browser costs one upstream call
// per 3s at most. Falls back to the freshest Yahoo bar when capital.com is
// unconfigured or erroring.
let priceCache = { at: 0, data: null };
app.get('/api/price', async (req, res) => {
  try {
    if (priceCache.data && Date.now() - priceCache.at < 3000) return res.json(priceCache.data);
    let out = null;
    if (capital.configured()) {
      try {
        out = await capital.snapshot('brent');
      } catch (e) {
        console.error('capital price failed:', e.message);
      }
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
    priceCache = { at: Date.now(), data: out };
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
      calibration: journalCalib,
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

app.post('/api/refresh', async (req, res) => {
  try {
    state.data = null;
    await loadData(true);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/* ---------- prediction journal: the self-calibrating loop ---------- */

let journalCalib = {}; // populated by the first tick (storage may be remote)
let ticking = false;

// Price history the resolver can score against when the server was down at a
// prediction's due time: 15m bars (60d) + daily closes (10y, ~20:00Z settle).
function resolverFallbackSeries() {
  const { raw, ds } = state.data;
  const pts = [];
  if (raw.i15) for (let i = 0; i < raw.i15.dates.length; i++) pts.push([Date.parse(raw.i15.dates[i]), raw.i15.close[i]]);
  for (let i = 0; i < ds.dates.length; i++) pts.push([Date.parse(ds.dates[i] + 'T20:00:00Z'), ds.brent[i]]);
  pts.sort((a, b) => a[0] - b[0]);
  return { ts: pts.map((p) => p[0]), close: pts.map((p) => p[1]) };
}

// Every 5 min: log spot, resolve matured predictions, refresh calibration, and
// log the system's CURRENT predictions (always the ridge system, so the journal
// measures one consistent policy regardless of what the UI toggle shows).
async function journalTick() {
  if (ticking) return;
  ticking = true;
  try {
    await loadData();
    let spot = null;
    let src = 'yahoo';
    if (capital.configured()) {
      try {
        const s = await capital.snapshot('brent');
        spot = s.mid;
        src = 'capital';
      } catch (e) {
        console.error('journal spot failed:', e.message);
      }
    }
    const { raw, ds, vols } = state.data;
    if (spot == null) spot = raw.i15 ? raw.i15.close[raw.i15.close.length - 1] : ds.brent[ds.brent.length - 1];
    await journal.logPrice(Date.now(), spot, src);

    const outcome = await journal.resolveDue(resolverFallbackSeries());
    journalCalib = await journal.computeCalibration();

    const [h1, h5, h21, i15, i60] = await Promise.all([
      dailyBundle('ridge', 'fwd1'),
      dailyBundle('ridge', 'fwd5'),
      dailyBundle('ridge', 'fwd21'),
      intradayBundle('i15', '15m', 400),
      intradayBundle('i60', '1h', 800),
    ]);
    const news = raw.news || { activity: { level: 'QUIET' } };
    const targets = buildTargets({
      price: spot,
      asOfDaily: ds.dates[ds.dates.length - 1],
      asOf15: raw.i15 ? raw.i15.dates[raw.i15.dates.length - 1] : null,
      asOf60: raw.i60 ? raw.i60.dates[raw.i60.dates.length - 1] : null,
      bundles: { h1, h5, h21, i15, i60 },
      vols: { bar15: vols.bar15 || 0.002, bar60: vols.bar60 || 0.004, daily: vols.daily },
      newsLevel: news.activity.level,
      bandFactor: newsBandFactor(news.activity.level),
      calibration: journalCalib,
    });
    const logged = await journal.logPredictions(targets, spot, 'ridge', news.activity.level);
    if (logged || outcome.resolved || outcome.unresolvable) {
      console.log(`journal: +${logged} logged, ${outcome.resolved} resolved, ${outcome.unresolvable} unresolvable, ${outcome.stillOpen} awaiting price`);
    }
  } catch (e) {
    console.error('journal tick failed:', e.message);
  } finally {
    ticking = false;
  }
}

app.get('/api/journal', async (req, res) => {
  try {
    res.json({ stats: await journal.stats(), calibration: journalCalib, horizons: journal.HORIZONS, storage: await journal.storageKind() });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// On-demand AI review of the journal: what is failing, what to fix first.
app.get('/api/journal/insight', async (req, res) => {
  try {
    const s = journal.stats();
    const prompt = [
      'You are a quant reviewing LIVE prediction-journal stats for a Brent price-target system.',
      'Per horizon: dirHitRate vs baseUp (direction skill), bandCoverage (target 0.68), meanErr (bias), mae, n counts, leanVerdict.',
      `DATA: ${JSON.stringify({ horizons: s.horizons, calibration: journalCalib })}`,
      'Write markdown, <=200 words: 1) per-horizon one-liners — working / broken / too little data (cite the numbers); 2) "Fix first:" the three highest-impact concrete improvements, ordered. No hedging boilerplate, no praise.',
    ].join('\n');
    const out = await chatText(prompt, config.newsModel, process.env.OPENROUTER_API_KEY || '');
    if (!out.ok) return res.status(502).json({ error: out.reason });
    res.json({ markdown: out.text, model: config.newsModel });
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
    .then(() => {
      console.log('ridge + intraday models warm');
      journalTick(); // first journal entry immediately, then every 5 min
      setInterval(journalTick, 5 * 60 * 1000);
    })
    .catch((e) => console.error('warmup failed:', e.message));
});
