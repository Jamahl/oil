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
  h1: { ms: 60 * 60e3, logEveryMs: 15 * 60e3, resolveWindowMs: 2 * 3600e3, minN: 60 },
  d1: { ms: 24 * 3600e3, logEveryMs: 2 * 3600e3, resolveWindowMs: 3.5 * 24 * 3600e3, minN: 40 },
  w1: { ms: 7 * 24 * 3600e3, logEveryMs: 12 * 3600e3, resolveWindowMs: 3.5 * 24 * 3600e3, minN: 20 },
  mo1: { ms: 30 * 24 * 3600e3, logEveryMs: 24 * 3600e3, resolveWindowMs: 4 * 24 * 3600e3, minN: 12 },
};
const CALIB_WINDOW = 400;
const K_BOUNDS = [0.5, 2.5];

// DDL is shared: sqlite's type affinity happily accepts the Postgres names.
// Only the identity column and upsert syntax differ per driver.
function ddl(idLine) {
  return `
    CREATE TABLE IF NOT EXISTS predictions (
      ${idLine},
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
    CREATE TABLE IF NOT EXISTS price_log (ts BIGINT PRIMARY KEY, mid DOUBLE PRECISION NOT NULL, source TEXT);
    CREATE TABLE IF NOT EXISTS calibration_history (at BIGINT, horizon TEXT, k DOUBLE PRECISION, bias DOUBLE PRECISION, n INTEGER, active INTEGER);
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
        async upsertPrice(ts, mid, source) {
          await pool.query(
            'INSERT INTO price_log (ts, mid, source) VALUES ($1, $2, $3) ON CONFLICT (ts) DO UPDATE SET mid = EXCLUDED.mid, source = EXCLUDED.source',
            [ts, mid, source]
          );
        },
      };
    }
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB_PATH);
    db.exec(ddl('id INTEGER PRIMARY KEY AUTOINCREMENT'));
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
      async upsertPrice(ts, mid, source) {
        db.prepare('INSERT OR REPLACE INTO price_log (ts, mid, source) VALUES (?, ?, ?)').run(ts, mid, source);
      },
    };
  })();
  return driverPromise;
}

async function storageKind() {
  return (await getDriver()).kind;
}

async function logPrice(tsMs, mid, source) {
  const d = await getDriver();
  await d.upsertPrice(Math.round(tsMs), mid, source || '?');
}

// Log the currently displayed targets (one row per horizon whose cadence is due).
async function logPredictions(targets, spot, model, newsLevel) {
  const d = await getDriver();
  const now = Date.now();
  let logged = 0;
  for (const t of targets) {
    const hz = HORIZONS[t.id];
    if (!hz) continue;
    const last = await d.get('SELECT MAX(made_at) AS m FROM predictions WHERE horizon = ?', [t.id]);
    if (last && last.m != null && now - Number(last.m) < hz.logEveryMs - 5000) continue;
    await d.run(
      `INSERT INTO predictions
        (made_at, horizon, due_at, spot, mu, mu_raw, sigma, sigma_raw, news_factor, news_level, k_used, bias_used, direction, bucket, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        now, t.id, now + hz.ms, spot,
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
async function lookupRealized(d, dueMs, windowMs, fallbackSeries) {
  const row = await d.get('SELECT ts, mid FROM price_log WHERE ts >= ? AND ts <= ? ORDER BY ts ASC LIMIT 1', [
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
async function resolveDue(fallbackSeries) {
  const d = await getDriver();
  const now = Date.now();
  const open = await d.all("SELECT * FROM predictions WHERE status = 'open' AND due_at <= ?", [now]);
  let resolved = 0;
  let dead = 0;
  for (const p of open) {
    const hz = HORIZONS[p.horizon];
    if (!hz) continue;
    const hit = await lookupRealized(d, Number(p.due_at), hz.resolveWindowMs, fallbackSeries);
    if (!hit) {
      if (now > Number(p.due_at) + hz.resolveWindowMs) {
        await d.run("UPDATE predictions SET resolved_at=?, status='unresolvable' WHERE id=?", [now, p.id]);
        dead++;
      }
      continue;
    }
    const ret = hit.price / p.spot - 1;
    const dirCorrect = p.direction === 'FLAT' || ret === 0 ? null : (p.direction === 'BULLISH') === ret > 0 ? 1 : 0;
    const bandHit = Math.abs(ret - p.mu) <= p.sigma ? 1 : 0;
    await d.run(
      "UPDATE predictions SET resolved_at=?, realized=?, realized_ret=?, dir_correct=?, band_hit=?, status='resolved' WHERE id=?",
      [hit.at, hit.price, ret, dirCorrect, bandHit, p.id]
    );
    resolved++;
  }
  return { resolved, unresolvable: dead, stillOpen: open.length - resolved - dead };
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

// Recompute per-horizon calibration -> { m15: {k, bias, n, active}, ... }
// active=false = shadow mode (shown, not applied) until minN resolved samples.
async function computeCalibration() {
  const d = await getDriver();
  const out = {};
  for (const [hzId, hz] of Object.entries(HORIZONS)) {
    const rows = (
      await d.all(
        "SELECT mu_raw, sigma_raw, news_factor, realized_ret FROM predictions WHERE horizon=? AND status='resolved' ORDER BY resolved_at DESC LIMIT ?",
        [hzId, CALIB_WINDOW]
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
    const prev = await d.get('SELECT k, bias FROM calibration_history WHERE horizon = ? ORDER BY at DESC LIMIT 1', [hzId]);
    if (!prev || Math.abs(prev.k - out[hzId].k) / (prev.k || 1) > 0.02 || Math.abs(prev.bias - out[hzId].bias) > 1e-4) {
      await d.run('INSERT INTO calibration_history (at, horizon, k, bias, n, active) VALUES (?, ?, ?, ?, ?, ?)', [
        Date.now(), hzId, out[hzId].k, out[hzId].bias, n, active ? 1 : 0,
      ]);
    }
  }
  return out;
}

// Scoreboard for the UI: per-horizon accuracy + the L3 lean-gate verdict.
async function stats() {
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
       FROM predictions WHERE horizon = ?`,
      [hzId]
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
    "SELECT made_at, horizon, spot, mu, sigma, direction, realized_ret, dir_correct, band_hit, status FROM predictions WHERE status != 'open' ORDER BY resolved_at DESC LIMIT 25"
  );
  out.calibrationHistory = await d.all('SELECT * FROM calibration_history ORDER BY at DESC LIMIT 40');
  return out;
}

module.exports = { logPrice, logPredictions, resolveDue, computeCalibration, stats, storageKind, HORIZONS };
