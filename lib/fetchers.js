'use strict';
// Data fetchers, all free/keyless. Disk cache under data/ with TTL so dev restarts don't hammer sources.
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const CACHE_DIR = path.join(__dirname, '..', 'data');
const TTL_MS = 6 * 60 * 60 * 1000;
const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) crudesignal-lab/0.1' };

function cachePath(key) {
  return path.join(CACHE_DIR, key + '.json');
}

function readCache(key, ttlMs = TTL_MS) {
  try {
    const p = cachePath(key);
    if (Date.now() - fs.statSync(p).mtimeMs > ttlMs) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(key, obj) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath(key), JSON.stringify(obj));
}

function clearCache() {
  if (!fs.existsSync(CACHE_DIR)) return;
  for (const f of fs.readdirSync(CACHE_DIR)) {
    if (f.endsWith('.json') && f !== 'config.json') fs.unlinkSync(path.join(CACHE_DIR, f));
  }
}

async function fetchWithRetry(url, opts = {}, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        ...opts,
        headers: { ...UA, ...(opts.headers || {}) },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

// Yahoo Finance closes -> { symbol, dates[], close[] } ascending, nulls dropped.
// interval '1d' keys dates as YYYY-MM-DD; intraday intervals keep full ISO timestamps.
async function yahooSeries(symbol, { range = '10y', interval = '1d', ttlMs = TTL_MS } = {}) {
  const key = `yahoo_${symbol.replace(/[^A-Za-z0-9]/g, '_')}_${range}_${interval}`;
  const hit = readCache(key, ttlMs);
  if (hit) return hit;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const res = await fetchWithRetry(url);
  const json = await res.json();
  const r = json && json.chart && json.chart.result && json.chart.result[0];
  if (!r || !r.timestamp) throw new Error(`Yahoo: empty result for ${symbol}`);
  const ts = r.timestamp;
  const close = (r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close) || [];
  const daily = interval === '1d';
  const dates = [];
  const vals = [];
  for (let i = 0; i < ts.length; i++) {
    const c = close[i];
    if (c == null || !isFinite(c)) continue;
    const iso = new Date(ts[i] * 1000).toISOString();
    const d = daily ? iso.slice(0, 10) : iso;
    if (dates.length && dates[dates.length - 1] === d) {
      vals[vals.length - 1] = c; // live bar duplicates the last completed daily bar
      continue;
    }
    dates.push(d);
    vals.push(c);
  }
  const out = {
    symbol,
    interval,
    dates,
    close: vals,
    meta: {
      price: (r.meta && r.meta.regularMarketPrice) != null ? r.meta.regularMarketPrice : vals[vals.length - 1],
      time: (r.meta && r.meta.regularMarketTime) || null,
    },
  };
  writeCache(key, out);
  return out;
}

function yahooDaily(symbol, range = '10y') {
  return yahooSeries(symbol, { range, interval: '1d' });
}

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
function excelDate(serial) {
  return new Date(EXCEL_EPOCH + Math.round(serial) * 86400000).toISOString().slice(0, 10);
}

// EIA weekly U.S. ending stocks of crude oil excl SPR (thousand barrels), from the
// public dnav history workbook (no API key). -> { weekEnd[], kbbl[] } ascending.
async function eiaCrudeStocks() {
  const key = 'eia_wcestus1';
  const hit = readCache(key);
  if (hit) return hit;
  const res = await fetchWithRetry('https://www.eia.gov/dnav/pet/hist_xls/WCESTUS1w.xls');
  const buf = Buffer.from(await res.arrayBuffer());
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets['Data 1'];
  if (!ws) throw new Error('EIA: sheet "Data 1" missing in WCESTUS1w.xls');
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const weekEnd = [];
  const kbbl = [];
  for (const row of rows) {
    if (typeof row[0] === 'number' && typeof row[1] === 'number') {
      weekEnd.push(excelDate(row[0]));
      kbbl.push(row[1]);
    }
  }
  if (!weekEnd.length) throw new Error('EIA: no data rows parsed');
  const out = { weekEnd, kbbl };
  writeCache(key, out);
  return out;
}

module.exports = { yahooDaily, yahooSeries, eiaCrudeStocks, clearCache, readCache, writeCache, fetchWithRetry };
