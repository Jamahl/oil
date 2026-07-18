'use strict';
require('./lib/env');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const express = require('express');
const { yahooDaily, yahooSeries, eiaCrudeStocks, clearCache } = require('./lib/fetchers');
const { buildDataset, buildIntradayRows, buildGenericDailyRows, recentVol, pearson } = require('./lib/data');
const { fetchNews, newsBandFactor } = require('./lib/news');
const { DEFAULT_MODEL, chatText } = require('./lib/llm');
const { buildTargets } = require('./lib/targets');
const capital = require('./lib/capital');
const journal = require('./lib/journal');
const { computeSignal } = require('./lib/signal');
const { fetchCurve } = require('./lib/curve');
const bot = require('./lib/bot');
const { INSTRUMENTS, INSTRUMENT_IDS, resolveId } = require('./lib/instruments');

const PORT = process.env.PORT || 4173;
const app = express();
app.use(express.json());

// ---- session auth: active only when AUTH_PASSCODE is set (the VPS). Local
// dev without it stays open. Login page + deps came from the deploy agent's
// commit; this layer replaces its broken server.js rewrite. ----
const AUTH_USER = process.env.AUTH_USER || 'oil';
const AUTH_PASSCODE = process.env.AUTH_PASSCODE || '';
if (AUTH_PASSCODE) {
  const session = require('express-session');
  const rateLimit = require('express-rate-limit');
  app.set('trust proxy', 1); // behind Caddy/nginx
  app.use(
    session({
      secret: process.env.SESSION_SECRET || AUTH_PASSCODE,
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 7 * 24 * 3600e3 },
    })
  );
  const loginLimiter = rateLimit({ windowMs: 15 * 60e3, max: 20 });
  app.use('/api/', rateLimit({ windowMs: 15 * 60e3, max: 600 }));
  app.get('/login', loginLimiter, (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
  app.post('/login', loginLimiter, (req, res) => {
    const b = req.body || {};
    const pass = b.passcode || b.password;
    if (b.username === AUTH_USER && pass && pass === AUTH_PASSCODE) {
      req.session.authed = true;
      return res.json({ ok: true });
    }
    return res.status(401).json({ error: 'invalid credentials' });
  });
  app.post('/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use((req, res, next) => {
    if (req.session && req.session.authed) return next();
    if (req.path === '/login' || req.path === '/health') return next();
    if (!req.path.startsWith('/api/') && req.accepts('html')) return res.redirect('/login');
    return res.status(401).json({ error: 'login required' });
  });
}

app.use(express.static(path.join(__dirname, 'public')));

// Per-instrument runtime state — fully segregated: data, model caches,
// price memos, journal calibration and bot instances never cross.
const makeState = () => ({ loading: null, data: null, models: new Map() });
const states = Object.fromEntries(INSTRUMENT_IDS.map((id) => [id, makeState()]));

// Resolve ?instrument= (query or body) -> known id; anything else = brent so
// every pre-existing URL keeps its exact old behavior.
const instFromReq = (req) =>
  resolveId((req.query && req.query.instrument) || (req.body && req.body.instrument));

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

const FEEDS = {
  brent: [
    { id: 'brent', label: 'Brent BZ=F', fn: () => yahooDaily(INSTRUMENTS.brent.yahooDaily), required: true, staleDays: 7 },
    { id: 'wti', label: 'WTI CL=F', fn: () => yahooDaily('CL=F'), required: true, staleDays: 7 },
    { id: 'dxy', label: 'DXY', fn: () => yahooDaily('DX-Y.NYB'), required: true, staleDays: 7 },
    { id: 'ovx', label: 'OVX', fn: () => yahooDaily('^OVX'), required: false, staleDays: 10 },
    { id: 'inv', label: 'EIA stocks', fn: () => eiaCrudeStocks(), required: false, staleDays: 14 },
    { id: 'i15', label: 'Brent 15m bars', fn: () => yahooSeries(INSTRUMENTS.brent.yahooIntraday, { range: '60d', interval: '15m', ttlMs: 30 * 60 * 1000 }), required: false, staleDays: 4 },
    { id: 'i60', label: 'Brent 1h bars', fn: () => yahooSeries(INSTRUMENTS.brent.yahooIntraday, { range: '730d', interval: '1h', ttlMs: 2 * 60 * 60 * 1000 }), required: false, staleDays: 4 },
    { id: 'news', label: 'News', fn: () => fetchNews(config.newsModel, INSTRUMENTS.brent.newsPack), required: false, staleDays: 2 },
    { id: 'curve', label: 'Brent curve', fn: () => fetchCurve(), required: false, staleDays: 5 },
  ],
  btc: [
    { id: 'daily', label: 'Bitcoin daily', fn: () => yahooDaily(INSTRUMENTS.btc.yahooDaily), required: true, staleDays: 4 },
    { id: 'i15', label: 'Bitcoin 15m bars', fn: () => yahooSeries(INSTRUMENTS.btc.yahooIntraday, { range: '60d', interval: '15m', ttlMs: 30 * 60 * 1000 }), required: false, staleDays: 2 },
    { id: 'i60', label: 'Bitcoin 1h bars', fn: () => yahooSeries(INSTRUMENTS.btc.yahooIntraday, { range: '730d', interval: '1h', ttlMs: 2 * 60 * 60 * 1000 }), required: false, staleDays: 2 },
    { id: 'news', label: 'News', fn: () => fetchNews(config.newsModel, INSTRUMENTS.btc.newsPack), required: false, staleDays: 2 },
  ],
};

function feedLastDate(id, value) {
  if (id === 'inv') return value.weekEnd[value.weekEnd.length - 1];
  if (id === 'news') return value.fetchedAt;
  if (id === 'curve') return value.asOf;
  return value.dates[value.dates.length - 1];
}

// The instrument's primary daily close series inside its dataset.
const dsCloses = (instrument, ds) => (INSTRUMENTS[instrument].features === 'oil' ? ds.brent : ds.close);

async function loadData(instrument = 'brent', force = false) {
  const st = states[instrument];
  if (st.loading) return st.loading;
  if (st.data && !force) return st.data;
  st.loading = (async () => {
    if (force) clearCache();
    const feeds = FEEDS[instrument];
    const results = await Promise.allSettled(feeds.map((f) => f.fn()));
    const raw = {};
    const health = [];
    feeds.forEach((f, idx) => {
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
    const ds = INSTRUMENTS[instrument].features === 'oil' ? buildDataset(raw) : buildGenericDailyRows(raw.daily);
    if (ds.rows.length < 300) throw new Error(`only ${ds.rows.length} usable rows after alignment`);
    const intraday = {
      i15: raw.i15 ? buildIntradayRows(raw.i15) : null,
      i60: raw.i60 ? buildIntradayRows(raw.i60) : null,
    };
    const vols = {
      bar15: raw.i15 ? recentVol(raw.i15.close, 200) : null,
      bar60: raw.i60 ? recentVol(raw.i60.close, 200) : null,
      daily: recentVol(dsCloses(instrument, ds), 63),
    };
    st.data = { raw, ds, intraday, vols, health, builtAt: new Date().toISOString() };
    st.models = new Map();
    return st.data;
  })().finally(() => {
    st.loading = null;
  });
  return st.loading;
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

function getModelBundle(st, key, thunk) {
  if (!st.models.has(key)) {
    const p = thunk().catch((e) => {
      st.models.delete(key);
      throw e;
    });
    st.models.set(key, p);
  }
  return st.models.get(key);
}

function dailyBundle(instrument, kind, horizonKey) {
  const st = states[instrument];
  const { ds } = st.data;
  return getModelBundle(st, `${kind}:${horizonKey}`, () =>
    runWorker({ rows: ds.rows, features: ds.features }, kind, horizonKey, {})
  );
}

function intradayBundle(instrument, id, label, step, horizonKey = 'fwd1') {
  const st = states[instrument];
  const rowsBundle = st.data.intraday[id];
  if (!rowsBundle || rowsBundle.rows.length < 500) return Promise.resolve(null);
  return getModelBundle(st, `ridge:${id}:${horizonKey}`, () =>
    runWorker(rowsBundle, 'ridge', horizonKey, { step, lite: true, label })
  );
}

// The six bundles every consumer needs (dashboard, tick, signal) — all cached
// per instrument.
function coreBundles(instrument, kind) {
  return Promise.all([
    dailyBundle(instrument, kind, 'fwd1'),
    dailyBundle(instrument, kind, 'fwd5'),
    dailyBundle(instrument, kind, 'fwd21'),
    intradayBundle(instrument, 'i15', '15m', 400),
    intradayBundle(instrument, 'i15', '30m', 400, 'fwd2'),
    intradayBundle(instrument, 'i60', '1h', 800),
  ]);
}

// Per-instrument Capital snapshot. brent uses the global default env (which
// follows the brent bot's account tab — original behavior); other instruments
// pin their own bot's env (btc: always demo, it is live-locked).
function snapshotFor(instrument) {
  if (instrument === 'brent') return capital.snapshot('brent');
  return capital.snapshot(INSTRUMENTS[instrument].epic, bots[instrument].env());
}

// Live spot with a short memo so a polling browser costs one upstream call
// per 3s at most. Falls back to the freshest Yahoo bar when capital.com is
// unconfigured or erroring.
const priceCaches = Object.fromEntries(INSTRUMENT_IDS.map((id) => [id, { at: 0, data: null }]));
async function getLiveSpot(instrument = 'brent') {
  const pc = priceCaches[instrument];
  if (pc.data && Date.now() - pc.at < 3000) return pc.data;
  let out = null;
  if (capital.configured()) {
    try {
      out = await snapshotFor(instrument);
    } catch (e) {
      console.error(`capital price failed (${instrument}):`, e.message);
    }
  }
  if (!out) {
    await loadData(instrument);
    const { raw, ds } = states[instrument].data;
    const closes = dsCloses(instrument, ds);
    out = {
      source: 'yahoo-delayed',
      mid: raw.i15 ? raw.i15.close[raw.i15.close.length - 1] : closes[closes.length - 1],
      at: raw.i15 ? raw.i15.dates[raw.i15.dates.length - 1] : ds.dates[ds.dates.length - 1],
      marketStatus: null,
      pctChange: null,
    };
  }
  priceCaches[instrument] = { at: Date.now(), data: out };
  return priceCaches[instrument].data;
}

function liveSpreadPct(instrument = 'brent') {
  const p = priceCaches[instrument].data;
  if (p && p.source === 'capital-cfd' && p.offer > p.bid && p.mid > 0) return (p.offer - p.bid) / p.mid;
  return 0.0004; // ~4 bps fallback when no live quote
}

app.get('/api/price', async (req, res) => {
  try {
    res.json(await getLiveSpot(instFromReq(req)));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Realtime BUY/HOLD/SELL combiner — cheap to compute (cached bundles + news +
// live spot), so it is evaluated fresh on every request. The curve component
// exists only for instruments with the oil feature stack; for the rest the
// combiner is intraday + daily + news + momentum.
const journalStatsCaches = Object.fromEntries(INSTRUMENT_IDS.map((id) => [id, null]));
async function currentSignal(instrument = 'brent') {
  await loadData(instrument);
  const [h1, h5, , i15, , i60] = await coreBundles(instrument, 'ridge');
  const { raw, vols } = states[instrument].data;
  const live = await getLiveSpot(instrument);
  const bars = raw.i15 ? raw.i15.close : [];
  return computeSignal({
    bundles: { h1, h5, i15, i60 },
    vols,
    news: { ...(raw.news || {}), llm: raw.news && raw.news.llm },
    livePrice: live.mid,
    prevPriceHourAgo: bars.length > 4 ? bars[bars.length - 5] : null,
    journalStats: journalStatsCaches[instrument],
    curve: INSTRUMENTS[instrument].features === 'oil' ? raw.curve || null : null,
  });
}

app.get('/api/signal', async (req, res) => {
  try {
    res.json(await currentSignal(instFromReq(req)));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Fresh news bundle for the 5-min UI poll (RSS lanes re-fetch; Parallel and the
// LLM pass ride their own caches, so an unchanged headline set costs nothing).
async function freshNews(instrument = 'brent', maxAgeMs = 5 * 60 * 1000) {
  await loadData(instrument);
  const st = states[instrument];
  const cur = st.data.raw.news;
  const age = cur ? Date.now() - Date.parse(cur.fetchedAt) : Infinity;
  if (age > maxAgeMs) {
    try {
      st.data.raw.news = await fetchNews(config.newsModel, INSTRUMENTS[instrument].newsPack);
    } catch (e) {
      console.error(`news refresh failed (${instrument}):`, e.message);
    }
  }
  return st.data.raw.news;
}

app.get('/api/news', async (req, res) => {
  try {
    res.json(await freshNews(instFromReq(req)));
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
    // Re-score loaded instruments (raw lanes cached — only the LLM pass reruns).
    for (const id of INSTRUMENT_IDS) {
      if (!states[id].data) continue;
      try {
        states[id].data.raw.news = await fetchNews(slug, INSTRUMENTS[id].newsPack);
      } catch (e) {
        console.error(`news re-score failed (${id}):`, e.message);
      }
    }
    res.json({ ok: true, newsModel: slug });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/api/dashboard', async (req, res) => {
  try {
    const instrument = instFromReq(req);
    const inst = INSTRUMENTS[instrument];
    const kind = req.query.model === 'forest' ? 'forest' : 'ridge';
    await loadData(instrument);
    await freshNews(instrument); // dashboard always ships a tape ≤5 min old
    const [h1, h5, h21, i15, i15f2, i60] = await coreBundles(instrument, kind);
    const { ds, raw, intraday, vols, health, builtAt } = states[instrument].data;
    const closes = dsCloses(instrument, ds);

    const lastIdx = ds.dates.length - 1;
    const kpi = (arr) => ({ value: arr[lastIdx], prev: arr[lastIdx - 1] });
    const news = raw.news || { items: [], activity: { level: 'QUIET', points: 0 }, lanes: {} };

    // Live-ish spot: newest close across daily and intraday feeds.
    const spot15 = raw.i15 ? raw.i15.close[raw.i15.close.length - 1] : null;
    const price = spot15 != null ? spot15 : closes[lastIdx];
    const asOf15 = raw.i15 ? raw.i15.dates[raw.i15.dates.length - 1] : null;
    const asOf60 = raw.i60 ? raw.i60.dates[raw.i60.dates.length - 1] : null;

    const targets = buildTargets({
      price,
      asOfDaily: ds.dates[lastIdx],
      asOf15,
      asOf60,
      bundles: { h1, h5, h21, i15, i15f2, i60 },
      vols: { bar15: vols.bar15 || 0.002, bar60: vols.bar60 || 0.004, daily: vols.daily },
      newsLevel: news.activity.level,
      bandFactor: newsBandFactor(news.activity.level),
      calibration: journalCalibs[instrument],
      spreadPct: liveSpreadPct(instrument),
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

    const oil = inst.features === 'oil';
    const invW = oil ? ds.invWeekly : null;

    res.json({
      instrument,
      label: inst.label,
      fullLabel: inst.fullLabel,
      priceDp: inst.priceDp,
      sourcesLine: inst.newsPack.sourcesLine,
      builtAt,
      health,
      price: { value: price, asOf: asOf15 || ds.dates[lastIdx] },
      news,
      targets,
      // Oil-only KPIs ship null for other instruments — the UI hides those cards.
      kpis: {
        brent: kpi(closes), // primary daily close series for the instrument
        wti: oil ? kpi(ds.wti) : null,
        spread: oil ? kpi(ds.spread) : null,
        dxy: oil ? kpi(ds.dxy) : null,
        ovx: oil && raw.ovx ? kpi(ds.ovx) : null,
        inventory: invW
          ? { level: invW.level[invW.level.length - 1], chg: invW.chg[invW.chg.length - 1], weekEnd: invW.weekEnd[invW.weekEnd.length - 1] }
          : null,
        curve: oil ? raw.curve || null : null,
      },
      series: {
        dates: idxRange.map((i) => ds.dates[i]),
        brent: idxRange.map((i) => closes[i]), // primary series (key kept for UI compatibility)
        spread: oil ? idxRange.map((i) => ds.spread[i]) : null,
        intraday: raw.i15
          ? { dates: raw.i15.dates.slice(-320), close: raw.i15.close.slice(-320) }
          : null,
        inventory: invW
          ? { weekEnd: invW.weekEnd.slice(-260), chg: invW.chg.slice(-260), level: invW.level.slice(-260) }
          : null,
      },
      correlations,
      models: { h1, h5, h21, i15, i15f2, i60 },
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
    const instrument = instFromReq(req);
    states[instrument].data = null;
    await loadData(instrument, true);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/* ---------- prediction journal: the self-calibrating loop ---------- */

const journalCalibs = Object.fromEntries(INSTRUMENT_IDS.map((id) => [id, {}])); // populated by each instrument's first tick
const tickingFlags = Object.fromEntries(INSTRUMENT_IDS.map((id) => [id, false]));

// Price history the resolver can score against when the server was down at a
// prediction's due time: 15m bars (60d) + daily closes (10y, ~20:00Z settle).
function resolverFallbackSeries(instrument) {
  const { raw, ds } = states[instrument].data;
  const closes = dsCloses(instrument, ds);
  const pts = [];
  if (raw.i15) for (let i = 0; i < raw.i15.dates.length; i++) pts.push([Date.parse(raw.i15.dates[i]), raw.i15.close[i]]);
  for (let i = 0; i < ds.dates.length; i++) pts.push([Date.parse(ds.dates[i] + 'T20:00:00Z'), closes[i]]);
  pts.sort((a, b) => a[0] - b[0]);
  return { ts: pts.map((p) => p[0]), close: pts.map((p) => p[1]) };
}

// Every 5 min per instrument: log spot, resolve matured predictions, refresh
// calibration, and log the system's CURRENT predictions (always the ridge
// system, so the journal measures one consistent policy).
async function journalTick(instrument = 'brent') {
  if (tickingFlags[instrument]) return;
  tickingFlags[instrument] = true;
  try {
    await loadData(instrument);
    let spot = null;
    let src = 'yahoo';
    if (capital.configured()) {
      try {
        const s = await snapshotFor(instrument);
        spot = s.mid;
        src = 'capital';
      } catch (e) {
        console.error(`journal spot failed (${instrument}):`, e.message);
      }
    }
    const { raw, ds, vols } = states[instrument].data;
    const closes = dsCloses(instrument, ds);
    if (spot == null) spot = raw.i15 ? raw.i15.close[raw.i15.close.length - 1] : closes[closes.length - 1];
    await journal.logPrice(Date.now(), spot, src, instrument);

    const fallback = resolverFallbackSeries(instrument);
    const outcome = await journal.resolveDue(fallback, instrument);
    await journal.resolveSignals(fallback, instrument);
    journalCalibs[instrument] = await journal.computeCalibration(instrument);
    journalStatsCaches[instrument] = await journal.stats(instrument);

    const [h1, h5, h21, i15, i15f2, i60] = await coreBundles(instrument, 'ridge');
    const news = raw.news || { activity: { level: 'QUIET' } };
    const targets = buildTargets({
      price: spot,
      asOfDaily: ds.dates[ds.dates.length - 1],
      asOf15: raw.i15 ? raw.i15.dates[raw.i15.dates.length - 1] : null,
      asOf60: raw.i60 ? raw.i60.dates[raw.i60.dates.length - 1] : null,
      bundles: { h1, h5, h21, i15, i15f2, i60 },
      vols: { bar15: vols.bar15 || 0.002, bar60: vols.bar60 || 0.004, daily: vols.daily },
      newsLevel: news.activity.level,
      bandFactor: newsBandFactor(news.activity.level),
      calibration: journalCalibs[instrument],
      spreadPct: liveSpreadPct(instrument),
    });
    const logged = await journal.logPredictions(targets, spot, 'ridge', news.activity.level, instrument);
    try {
      await journal.logSignal(await currentSignal(instrument), instrument);
    } catch (e) {
      console.error(`signal log failed (${instrument}):`, e.message);
    }
    if (logged || outcome.resolved || outcome.unresolvable) {
      console.log(`journal[${instrument}]: +${logged} logged, ${outcome.resolved} resolved, ${outcome.unresolvable} unresolvable, ${outcome.stillOpen} awaiting price`);
    }
  } catch (e) {
    console.error(`journal tick failed (${instrument}):`, e.message);
  } finally {
    tickingFlags[instrument] = false;
  }
}

// ---- scalp bots: one fully isolated instance per instrument ----
const bots = Object.fromEntries(INSTRUMENT_IDS.map((id) => [id, bot.create(INSTRUMENTS[id])]));
const botFor = (req) => bots[instFromReq(req)];

app.get('/api/bot', async (req, res) => {
  try {
    const instrument = instFromReq(req);
    await bots[instrument].reconcile(priceCaches[instrument].data).catch(() => {});
    res.json(bots[instrument].status(priceCaches[instrument].data));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.get('/api/bot/history', (req, res) => {
  try { res.json(botFor(req).history()); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/bot/config', (req, res) => {
  try {
    const { instrument: _inst, ...patch } = req.body || {}; // routing key, not a config field
    res.json({ ok: true, config: botFor(req).setConfig(patch) });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/bot/env', (req, res) => {
  try { botFor(req).switchEnv(req.body && req.body.env === 'live' ? 'live' : 'demo'); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/bot/start', (req, res) => {
  try { botFor(req).start(); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/bot/manual', async (req, res) => {
  try {
    const instrument = instFromReq(req);
    await bots[instrument].manual(req.body && req.body.dir === 'SELL' ? 'SELL' : 'BUY', await getLiveSpot(instrument));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});
app.post('/api/bot/stop', (req, res) => { botFor(req).stop(); res.json({ ok: true }); });
app.post('/api/bot/close-one', async (req, res) => {
  try {
    if (!req.body || !req.body.dealId) return res.status(400).json({ error: 'dealId required' });
    await botFor(req).closeOne(String(req.body.dealId));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
app.post('/api/bot/close-all', async (req, res) => {
  try { await botFor(req).closeAll(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});
setInterval(async () => {
  for (const id of INSTRUMENT_IDS) {
    try { await bots[id].tick(await currentSignal(id), await getLiveSpot(id)); } catch (e) { console.error(`bot tick failed (${id}):`, e.message); }
  }
}, 15000);

app.get('/api/journal', async (req, res) => {
  try {
    const instrument = instFromReq(req);
    res.json({
      instrument,
      stats: await journal.stats(instrument),
      signals: await journal.signalStats(instrument),
      calibration: journalCalibs[instrument],
      horizons: journal.HORIZONS,
      storage: await journal.storageKind(),
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// On-demand AI review of the journal: what is failing, what to fix first.
app.get('/api/journal/insight', async (req, res) => {
  try {
    const instrument = instFromReq(req);
    const s = await journal.stats(instrument);
    const prompt = [
      `You are a quant reviewing LIVE prediction-journal stats for a ${INSTRUMENTS[instrument].fullLabel} price-target system.`,
      'Per horizon: dirHitRate vs baseUp (direction skill), bandCoverage (target 0.68), meanErr (bias), mae, n counts, leanVerdict.',
      `DATA: ${JSON.stringify({ horizons: s.horizons, calibration: journalCalibs[instrument] })}`,
      'Write markdown, <=200 words: 1) per-horizon one-liners — working / broken / too little data (cite the numbers); 2) "Fix first:" the three highest-impact concrete improvements, ordered. No hedging boilerplate, no praise.',
    ].join('\n');
    const out = await chatText(prompt, config.newsModel, process.env.OPENROUTER_API_KEY || '');
    if (!out.ok) return res.status(502).json({ error: out.reason });
    res.json({ markdown: out.text, model: config.newsModel });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

const srv = app.listen(PORT, () => {
  console.log(`CrudeSignal Lab -> http://localhost:${PORT}`);
  loadData('brent')
    .then(() =>
      coreBundles('brent', 'ridge')
    )
    .then(() => {
      console.log('brent ridge + intraday models warm');
      journalTick('brent'); // first journal entry immediately, then every 5 min
      setInterval(() => journalTick('brent'), 5 * 60 * 1000);
    })
    .then(() => loadData('btc'))
    .then(() => coreBundles('btc', 'ridge'))
    .then(() => {
      console.log('btc ridge + intraday models warm');
      journalTick('btc');
      setInterval(() => journalTick('btc'), 5 * 60 * 1000);
    })
    .catch((e) => console.error('warmup failed:', e.message));
});
srv.on('error', (e) => { console.error('FATAL: listen failed (' + e.code + ') — another server holds the port. Exiting.'); process.exit(1); });
