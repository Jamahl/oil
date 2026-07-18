'use strict';
// Prediction journal + self-calibrating loop (the PRD's "signal journal is the
// moat" idea, made live). Every few minutes the server logs the targets it is
// currently displaying; once a prediction's horizon elapses it is scored against
// the realized price. The resolved history then feeds back into the targets:
//   L1  band calibration — k scales the ±1σ band so realized coverage -> 68%
//   L2  bias correction  — rolling mean error is subtracted from the model μ
//   L3  lean gating      — direction hit-rate vs base decides whether leans
//                          deserve to be shown (report-only verdict for now)
// Every adjustment is capped, gated on a minimum sample size, and logged to a
// history table — and because logged predictions record the adjustments that
// produced them (k_used, bias_used), each round of "learning" is itself being
// tested by the next round of predictions. That is the recursive part.
//
// Storage: Neon Postgres when DATABASE_URL is set (pg Pool, SSL), otherwise a
// local node:sqlite file — same SQL surface via a tiny adapter, so the app
// keeps journaling even with no cloud database configured.
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'journal.db');

const HORIZONS = {
  m15: { ms: 15 * 60e3, logEveryMs: 5 * 60e3, resolveWindowMs: 20 * 60e3, minN: 100 },
  m30: { ms: 30 * 60e3, logEveryMs: 10 * 60e3, resolveWindowMs: 40 * 60e3, minN: 80 },
  h1: { ms: 60 * 60e3, logEveryMs: 15 * 60e3, resolveWindowMs: 2 * 3600e3, minN: 60 },
  d1: { ms: 24 * 3600e3, logEveryMs: 2 * 3600e3, resolveWindowMs: 3.5 * 24 * 3600e3, minN: 40 },
  w1: { ms: 7 * 24 * 3600e3, logEveryMs: 12 * 3600e3, resolveWindowMs: 3.5 * 24 * 3600e3, minN: 20 },
  mo1: { ms: 30 * 24 * 3600e3, logEveryMs: 24 * 3600e3, resolveWindowMs: 4 * 24 * 3600e3, minN: 12 },
};
const CALIB_WINDOW = 400;
const K_BOUNDS = [0.5, 2.5];
// A realized move smaller than this (~2 bps ≈ half the CFD spread) is noise —
// direction outcomes on such moves are excluded from scoring rather than
// recorded as coin-flip hits/misses (false-positive guard).
const NOISE_RET = 0.0002;

// DDL is shared: sqlite's type affinity happily accepts the Postgres names.
// Only the identity column and upsert syntax differ per driver.
// Every table carries `instrument` (DEFAULT 'brent') so multiple instruments
// journal side-by-side with zero shared rows; price_log and signals key on
// (instrument, ts/at). Pre-instrument databases are migrated idempotently in
// each driver's setup below — existing rows become instrument='brent'.
function ddl(idLine) {
  return `
    CREATE TABLE IF NOT EXISTS predictions (
      ${idLine},
      instrument TEXT NOT NULL DEFAULT 'brent',
      made_at BIGINT NOT NULL,
      horizon TEXT NOT NULL,
      due_at BIGINT NOT NULL,
      spot DOUBLE PRECISION NOT NULL,
      mu DOUBLE PRECISION NOT NULL, mu_raw DOUBLE PRECISION NOT NULL,
      sigma DOUBLE PRECISION NOT NULL, sigma_raw DOUBLE PRECISION NOT NULL,
      news_factor DOUBLE PRECISION NOT NULL, news_level TEXT,
      k_used DOUBLE PRECISION NOT NULL, bias_used DOUBLE PRECISION NOT NULL,
      direction TEXT NOT NULL, bucket TEXT, model TEXT,
      resolved_at BIGINT, realized DOUBLE PRECISION, realized_ret DOUBLE PRECISION,
      dir_correct INTEGER, band_hit INTEGER,
      status TEXT NOT NULL DEFAULT 'open'
    );
    CREATE INDEX IF NOT EXISTS idx_pred_open ON predictions(status, due_at);
    CREATE INDEX IF NOT EXISTS idx_pred_h ON predictions(horizon, status, resolved_at);
    CREATE TABLE IF NOT EXISTS price_log (
      instrument TEXT NOT NULL DEFAULT 'brent',
      ts BIGINT NOT NULL, mid DOUBLE PRECISION NOT NULL, source TEXT,
      PRIMARY KEY (instrument, ts)
    );
    CREATE TABLE IF NOT EXISTS calibration_history (at BIGINT, horizon TEXT, k DOUBLE PRECISION, bias DOUBLE PRECISION, n INTEGER, active INTEGER, instrument TEXT NOT NULL DEFAULT 'brent');
    CREATE TABLE IF NOT EXISTS signals (
      instrument TEXT NOT NULL DEFAULT 'brent',
      at BIGINT NOT NULL,
      signal TEXT NOT NULL, bias DOUBLE PRECISION NOT NULL, confidence TEXT, tape TEXT,
      price DOUBLE PRECISION NOT NULL,
      ret_1h DOUBLE PRECISION, hit_1h INTEGER,
      ret_1d DOUBLE PRECISION, hit_1d INTEGER,
      PRIMARY KEY (instrument, at)
    );
  `;
}

let driverPromise = null;

async function getDriver() {
  if (driverPromise) return driverPromise;
  driverPromise = (async () => {
    if (process.env.DATABASE_URL) {
      const { Pool } = require('pg');
      const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 3,
      });
      await pool.query(ddl('id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY'));
      // Idempotent migration for pre-instrument databases: add the column
      // (existing rows default to 'brent'), then swap single-column PKs to
      // composite (instrument, ts/at) only if they are still single-column.
      for (const t of ['predictions', 'price_log', 'calibration_history', 'signals']) {
        await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS instrument TEXT NOT NULL DEFAULT 'brent'`);
      }
      for (const [table, cols] of [['price_log', '(instrument, ts)'], ['signals', '(instrument, at)']]) {
        const pk = await pool.query(
          `SELECT COUNT(*)::int AS n FROM information_schema.key_column_usage
           WHERE table_schema = current_schema() AND table_name = $1 AND constraint_name = $2`,
          [table, `${table}_pkey`]
        );
        if (pk.rows[0] && pk.rows[0].n === 1) {
          await pool.query(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_pkey`);
          await pool.query(`ALTER TABLE ${table} ADD PRIMARY KEY ${cols}`);
        }
      }
      const toPg = (sql) => {
        let n = 0;
        return sql.replace(/\?/g, () => `$${++n}`);
      };
      return {
        kind: 'neon',
        async run(sql, params = []) {
          await pool.query(toPg(sql), params);
        },
        async all(sql, params = []) {
          return (await pool.query(toPg(sql), params)).rows;
        },
        async get(sql, params = []) {
          return (await pool.query(toPg(sql), params)).rows[0] || null;
        },
        async upsertPrice(ts, mid, source, instrument) {
          await pool.query(
            'INSERT INTO price_log (instrument, ts, mid, source) VALUES ($1, $2, $3, $4) ON CONFLICT (instrument, ts) DO UPDATE SET mid = EXCLUDED.mid, source = EXCLUDED.source',
            [instrument, ts, mid, source]
          );
        },
      };
    }
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB_PATH);
    db.exec(ddl('id INTEGER PRIMARY KEY AUTOINCREMENT'));
    // Idempotent migration for pre-instrument sqlite files. ADD COLUMN covers
    // predictions/calibration_history; price_log and signals need a rebuild to
    // change their PRIMARY KEY (sqlite cannot alter PKs in place).
    const hasInstrument = (t) => db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'instrument');
    if (!hasInstrument('predictions')) db.exec("ALTER TABLE predictions ADD COLUMN instrument TEXT NOT NULL DEFAULT 'brent'");
    if (!hasInstrument('calibration_history')) db.exec("ALTER TABLE calibration_history ADD COLUMN instrument TEXT NOT NULL DEFAULT 'brent'");
    if (!hasInstrument('price_log')) {
      db.exec(`BEGIN;
        CREATE TABLE price_log_new (
          instrument TEXT NOT NULL DEFAULT 'brent',
          ts BIGINT NOT NULL, mid DOUBLE PRECISION NOT NULL, source TEXT,
          PRIMARY KEY (instrument, ts)
        );
        INSERT INTO price_log_new (instrument, ts, mid, source) SELECT 'brent', ts, mid, source FROM price_log;
        DROP TABLE price_log;
        ALTER TABLE price_log_new RENAME TO price_log;
      COMMIT;`);
    }
    if (!hasInstrument('signals')) {
      db.exec(`BEGIN;
        CREATE TABLE signals_new (
          instrument TEXT NOT NULL DEFAULT 'brent',
          at BIGINT NOT NULL,
          signal TEXT NOT NULL, bias DOUBLE PRECISION NOT NULL, confidence TEXT, tape TEXT,
          price DOUBLE PRECISION NOT NULL,
          ret_1h DOUBLE PRECISION, hit_1h INTEGER,
          ret_1d DOUBLE PRECISION, hit_1d INTEGER,
          PRIMARY KEY (instrument, at)
        );
        INSERT INTO signals_new (instrument, at, signal, bias, confidence, tape, price, ret_1h, hit_1h, ret_1d, hit_1d)
          SELECT 'brent', at, signal, bias, confidence, tape, price, ret_1h, hit_1h, ret_1d, hit_1d FROM signals;
        DROP TABLE signals;
        ALTER TABLE signals_new RENAME TO signals;
      COMMIT;`);
    }
    return {
      kind: 'sqlite',
      async run(sql, params = []) {
        db.prepare(sql).run(...params);
      },
      async all(sql, params = []) {
        return db.prepare(sql).all(...params);
      },
      async get(sql, params = []) {
        return db.prepare(sql).get(...params) || null;
      },
      async upsertPrice(ts, mid, source, instrument) {
        db.prepare('INSERT OR REPLACE INTO price_log (instrument, ts, mid, source) VALUES (?, ?, ?, ?)').run(instrument, ts, mid, source);
      },
    };
  })();
  return driverPromise;
}

async function storageKind() {
  return (await getDriver()).kind;
}

async function logPrice(tsMs, mid, source, instrument = 'brent') {
  const d = await getDriver();
  await d.upsertPrice(Math.round(tsMs), mid, source || '?', instrument);
}

// Log the currently displayed targets (one row per horizon whose cadence is due).
async function logPredictions(targets, spot, model, newsLevel, instrument = 'brent') {
  const d = await getDriver();
  const now = Date.now();
  let logged = 0;
  for (const t of targets) {
    const hz = HORIZONS[t.id];
    if (!hz) continue;
    const last = await d.get('SELECT MAX(made_at) AS m FROM predictions WHERE horizon = ? AND instrument = ?', [t.id, instrument]);
    if (last && last.m != null && now - Number(last.m) < hz.logEveryMs - 5000) continue;
    await d.run(
      `INSERT INTO predictions
        (instrument, made_at, horizon, due_at, spot, mu, mu_raw, sigma, sigma_raw, news_factor, news_level, k_used, bias_used, direction, bucket, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        instrument, now, t.id, now + hz.ms, spot,
        t.expectedReturn, t.muRaw != null ? t.muRaw : t.expectedReturn,
        t.bandPct, t.sigmaRaw != null ? t.sigmaRaw : t.bandPct,
        t.newsFactor != null ? t.newsFactor : 1, newsLevel || null,
        t.kUsed != null ? t.kUsed : 1, t.biasUsed != null ? t.biasUsed : 0,
        t.direction, t.bucket || null, model || 'ridge',
      ]
    );
    logged++;
  }
  return logged;
}

// First known price at ts >= due (within window): price_log, then fallback series.
async function lookupRealized(d, dueMs, windowMs, fallbackSeries, instrument) {
  const row = await d.get('SELECT ts, mid FROM price_log WHERE instrument = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC LIMIT 1', [
    instrument,
    Math.round(dueMs),
    Math.round(dueMs + windowMs),
  ]);
  if (row) return { price: row.mid, at: Number(row.ts) };
  if (fallbackSeries) {
    for (let i = 0; i < fallbackSeries.ts.length; i++) {
      if (fallbackSeries.ts[i] >= dueMs && fallbackSeries.ts[i] <= dueMs + windowMs) {
        return { price: fallbackSeries.close[i], at: fallbackSeries.ts[i] };
      }
    }
  }
  return null;
}

// Score everything past due; gaps (server down, weekend) fall back to Yahoo bars.
// Predictions whose whole window passed with no price become 'unresolvable'.
async function resolveDue(fallbackSeries, instrument = 'brent') {
  const d = await getDriver();
  const now = Date.now();
  const open = await d.all("SELECT * FROM predictions WHERE status = 'open' AND due_at <= ? AND instrument = ?", [now, instrument]);
  let resolved = 0;
  let dead = 0;
  for (const p of open) {
    const hz = HORIZONS[p.horizon];
    if (!hz) continue;
    const hit = await lookupRealized(d, Number(p.due_at), hz.resolveWindowMs, fallbackSeries, instrument);
    if (!hit) {
      if (now > Number(p.due_at) + hz.resolveWindowMs) {
        await d.run("UPDATE predictions SET resolved_at=?, status='unresolvable' WHERE id=?", [now, p.id]);
        dead++;
      }
      continue;
    }
    const ret = hit.price / p.spot - 1;
    const dirCorrect =
      p.direction === 'FLAT' || Math.abs(ret) <= NOISE_RET ? null : (p.direction === 'BULLISH') === ret > 0 ? 1 : 0;
    const bandHit = Math.abs(ret - p.mu) <= p.sigma ? 1 : 0;
    await d.run(
      "UPDATE predictions SET resolved_at=?, realized=?, realized_ret=?, dir_correct=?, band_hit=?, status='resolved' WHERE id=?",
      [hit.at, hit.price, ret, dirCorrect, bandHit, p.id]
    );
    resolved++;
  }
  return { resolved, unresolvable: dead, stillOpen: open.length - resolved - dead };
}

// BUY/HOLD/SELL combiner rows — logged each tick, scored against +1h and +1d
// forward returns (HOLD rows keep hits null; they aren't directional claims).
async function logSignal(sig, instrument = 'brent') {
  if (!sig || sig.price == null) return;
  const d = await getDriver();
  const at = Date.parse(sig.at) || Date.now();
  const row = await d.get('SELECT at FROM signals WHERE at = ? AND instrument = ?', [at, instrument]);
  if (row) return;
  await d.run('INSERT INTO signals (instrument, at, signal, bias, confidence, tape, price) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    instrument, at, sig.signal, sig.bias, sig.confidence || null, sig.tape || null, sig.price,
  ]);
}

async function resolveSignals(fallbackSeries, instrument = 'brent') {
  const d = await getDriver();
  const now = Date.now();
  const jobs = [
    { col: 'ret_1h', hit: 'hit_1h', ms: 3600e3, windowMs: 30 * 60e3 },
    { col: 'ret_1d', hit: 'hit_1d', ms: 24 * 3600e3, windowMs: 3.5 * 24 * 3600e3 },
  ];
  for (const j of jobs) {
    const rows = await d.all(`SELECT at, signal, price FROM signals WHERE ${j.col} IS NULL AND at <= ? AND instrument = ?`, [now - j.ms, instrument]);
    for (const r of rows) {
      const found = await lookupRealized(d, Number(r.at) + j.ms, j.windowMs, fallbackSeries, instrument);
      if (!found) {
        if (now > Number(r.at) + j.ms + j.windowMs) {
          await d.run(`UPDATE signals SET ${j.col} = 0, ${j.hit} = NULL WHERE at = ? AND instrument = ?`, [r.at, instrument]); // unresolvable — parked
        }
        continue;
      }
      const ret = found.price / r.price - 1;
      const hit =
        r.signal === 'HOLD' || Math.abs(ret) <= NOISE_RET ? null : (r.signal === 'BUY') === ret > 0 ? 1 : 0;
      await d.run(`UPDATE signals SET ${j.col} = ?, ${j.hit} = ? WHERE at = ? AND instrument = ?`, [ret, hit, r.at, instrument]);
    }
  }
}

async function signalStats(instrument = 'brent') {
  const d = await getDriver();
  const agg = await d.get(`SELECT
      COUNT(*) AS n,
      SUM(CASE WHEN signal='BUY' THEN 1 ELSE 0 END) AS buys,
      SUM(CASE WHEN signal='SELL' THEN 1 ELSE 0 END) AS sells,
      SUM(CASE WHEN hit_1h IS NOT NULL THEN 1 ELSE 0 END) AS n1h,
      SUM(CASE WHEN hit_1h = 1 THEN 1 ELSE 0 END) AS hits1h,
      SUM(CASE WHEN hit_1d IS NOT NULL THEN 1 ELSE 0 END) AS n1d,
      SUM(CASE WHEN hit_1d = 1 THEN 1 ELSE 0 END) AS hits1d
    FROM signals WHERE instrument = ?`, [instrument]);
  const num = (v) => (v == null ? 0 : Number(v));
  return {
    n: num(agg.n),
    buys: num(agg.buys),
    sells: num(agg.sells),
    holds: num(agg.n) - num(agg.buys) - num(agg.sells),
    hit1h: num(agg.n1h) ? num(agg.hits1h) / num(agg.n1h) : null,
    n1h: num(agg.n1h),
    hit1d: num(agg.n1d) ? num(agg.hits1d) / num(agg.n1d) : null,
    n1d: num(agg.n1d),
  };
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

// Recompute per-horizon calibration -> { m15: {k, bias, n, active}, ... }
// active=false = shadow mode (shown, not applied) until minN resolved samples.
async function computeCalibration(instrument = 'brent') {
  const d = await getDriver();
  const out = {};
  for (const [hzId, hz] of Object.entries(HORIZONS)) {
    const rows = (
      await d.all(
        "SELECT mu_raw, sigma_raw, news_factor, realized_ret FROM predictions WHERE horizon=? AND status='resolved' AND instrument=? ORDER BY resolved_at DESC LIMIT ?",
        [hzId, instrument, CALIB_WINDOW]
      )
    ).filter((r) => r.sigma_raw > 0);
    const n = rows.length;
    if (!n) {
      out[hzId] = { k: 1, bias: 0, n: 0, active: false };
      continue;
    }
    const errs = rows.map((r) => r.realized_ret - r.mu_raw);
    const meanErr = errs.reduce((a, b) => a + b, 0) / n;
    const sigTypical = rows.reduce((a, r) => a + r.sigma_raw, 0) / n;
    const bias = Math.max(-0.5 * sigTypical, Math.min(0.5 * sigTypical, meanErr));
    const zs = rows
      .map((r) => Math.abs(r.realized_ret - r.mu_raw - bias) / (r.sigma_raw * (r.news_factor || 1)))
      .sort((a, b) => a - b);
    const k = Math.max(K_BOUNDS[0], Math.min(K_BOUNDS[1], quantile(zs, 0.68)));
    const active = n >= hz.minN;
    out[hzId] = { k: Math.round(k * 1000) / 1000, bias: Math.round(bias * 1e6) / 1e6, n, active };
    const prev = await d.get('SELECT k, bias FROM calibration_history WHERE horizon = ? AND instrument = ? ORDER BY at DESC LIMIT 1', [hzId, instrument]);
    if (!prev || Math.abs(prev.k - out[hzId].k) / (prev.k || 1) > 0.02 || Math.abs(prev.bias - out[hzId].bias) > 1e-4) {
      await d.run('INSERT INTO calibration_history (at, horizon, k, bias, n, active, instrument) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        Date.now(), hzId, out[hzId].k, out[hzId].bias, n, active ? 1 : 0, instrument,
      ]);
    }
  }
  return out;
}

// Scoreboard for the UI: per-horizon accuracy + the L3 lean-gate verdict.
async function stats(instrument = 'brent') {
  const d = await getDriver();
  const out = { horizons: {}, totals: { open: 0, resolved: 0, unresolvable: 0 }, storage: d.kind };
  for (const hzId of Object.keys(HORIZONS)) {
    const agg = await d.get(
      `SELECT
        SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open,
        SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) AS resolved,
        SUM(CASE WHEN status='unresolvable' THEN 1 ELSE 0 END) AS dead,
        SUM(CASE WHEN status='resolved' AND dir_correct IS NOT NULL THEN 1 ELSE 0 END) AS dirn,
        SUM(CASE WHEN status='resolved' AND dir_correct = 1 THEN 1 ELSE 0 END) AS dirhits,
        SUM(CASE WHEN status='resolved' AND realized_ret > 0 THEN 1 ELSE 0 END) AS ups,
        SUM(CASE WHEN status='resolved' AND band_hit = 1 THEN 1 ELSE 0 END) AS bandhits,
        AVG(CASE WHEN status='resolved' THEN realized_ret - mu END) AS meanerr,
        AVG(CASE WHEN status='resolved' THEN ABS(realized_ret - mu) END) AS mae
       FROM predictions WHERE horizon = ? AND instrument = ?`,
      [hzId, instrument]
    );
    const num = (v) => (v == null ? 0 : Number(v));
    const resolved = num(agg.resolved);
    const dirN = num(agg.dirn);
    const dirHitRate = dirN ? num(agg.dirhits) / dirN : null;
    const baseUp = resolved ? num(agg.ups) / resolved : null;
    let leanVerdict = 'collecting';
    if (dirN >= HORIZONS[hzId].minN && baseUp != null) {
      const base = Math.max(baseUp, 1 - baseUp);
      leanVerdict = dirHitRate > base + 0.03 ? 'keep leans' : dirHitRate < base - 0.03 ? 'suppress leans' : 'no edge — treat as flat';
    }
    out.horizons[hzId] = {
      open: num(agg.open),
      resolved,
      unresolvable: num(agg.dead),
      dirN,
      dirHitRate,
      baseUp,
      bandCoverage: resolved ? num(agg.bandhits) / resolved : null,
      meanErr: agg.meanerr != null ? Number(agg.meanerr) : null,
      mae: agg.mae != null ? Number(agg.mae) : null,
      leanVerdict,
    };
    out.totals.open += num(agg.open);
    out.totals.resolved += resolved;
    out.totals.unresolvable += num(agg.dead);
  }
  out.recent = await d.all(
    "SELECT made_at, horizon, spot, mu, sigma, direction, realized_ret, dir_correct, band_hit, status FROM predictions WHERE status != 'open' AND instrument = ? ORDER BY resolved_at DESC LIMIT 25",
    [instrument]
  );
  out.calibrationHistory = await d.all('SELECT * FROM calibration_history WHERE instrument = ? ORDER BY at DESC LIMIT 40', [instrument]);
  return out;
}

module.exports = { logPrice, logPredictions, resolveDue, computeCalibration, stats, storageKind, logSignal, resolveSignals, signalStats, HORIZONS };
