'use strict';
// Capital.com CFD quote feed (routes mirrored from quantedge's capital_client).
// Session: POST /session with X-CAP-API-KEY + identifier/password -> CST and
// X-SECURITY-TOKEN response headers, reused until a 401 forces re-login.
// Sessions idle out after ~10 min; our poll cadence keeps them warm.
const BASES = {
  demo: 'https://demo-api-capital.backend-capital.com/api/v1',
  live: 'https://api-capital.backend-capital.com/api/v1',
};
const EPICS = { brent: 'OIL_BRENT', wti: 'OIL_CRUDE' };

const sessions = { demo: { cst: null, token: null, lastLoginAt: 0 }, live: { cst: null, token: null, lastLoginAt: 0 } };
let activeEnv = null; // null -> CAPITAL_ENVIRONMENT
const setEnv = (e) => { activeEnv = e === 'live' ? 'live' : 'demo'; };

// envOverride: per-call environment for multi-instrument use — a demo-locked
// bot passes its own env on every call and never touches the global default,
// so it can run alongside a live bot on another instrument. Omitted -> the
// global default (activeEnv / CAPITAL_ENVIRONMENT), exactly as before.
function creds(envOverride) {
  const { CAPITAL_API_KEY, CAPITAL_IDENTIFIER, CAPITAL_PASSWORD, CAPITAL_ENVIRONMENT } = process.env;
  if (!CAPITAL_API_KEY || !CAPITAL_IDENTIFIER || !CAPITAL_PASSWORD) return null;
  const env = (envOverride || activeEnv || CAPITAL_ENVIRONMENT) === 'live' ? 'live' : 'demo';
  return { key: CAPITAL_API_KEY, id: CAPITAL_IDENTIFIER, pw: CAPITAL_PASSWORD, env, base: BASES[env] };
}

async function login(c) {
  const session = sessions[c.env];
  // Capital.com session endpoint is rate-limited to ~1/s — throttle re-logins.
  if (Date.now() - sessions[c.env].lastLoginAt < 2000) throw new Error('capital login throttled');
  sessions[c.env].lastLoginAt = Date.now();
  const res = await fetch(`${c.base}/session`, {
    method: 'POST',
    headers: { 'X-CAP-API-KEY': c.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: c.id, password: c.pw, encryptedPassword: false }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`capital session HTTP ${res.status}`);
  sessions[c.env].cst = res.headers.get('cst');
  sessions[c.env].token = res.headers.get('x-security-token');
  if (!sessions[c.env].cst || !sessions[c.env].token) throw new Error('capital session: tokens missing');
}

// Live CFD snapshot -> { source, env, epic, bid, offer, mid, pctChange, marketStatus, at }
// `instrument` may be a key of EPICS or a raw epic string (e.g. 'BTCUSD').
async function snapshot(instrument = 'brent', envOverride) {
  const c = creds(envOverride);
  if (!c) return null;
  const epic = EPICS[instrument] || instrument;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!sessions[c.env].cst) await login(c);
    const res = await fetch(`${c.base}/markets/${encodeURIComponent(epic)}`, {
      headers: { CST: sessions[c.env].cst, 'X-SECURITY-TOKEN': sessions[c.env].token },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 401) {
      sessions[c.env].cst = null; // expired — re-login once
      continue;
    }
    if (!res.ok) throw new Error(`capital markets HTTP ${res.status}`);
    const j = await res.json();
    const s = j.snapshot || {};
    const bid = Number(s.bid);
    const offer = Number(s.offer);
    if (!isFinite(bid) || !isFinite(offer) || bid <= 0) throw new Error('capital snapshot: no quote');
    return {
      source: 'capital-cfd',
      env: c.env,
      epic,
      name: (j.instrument && j.instrument.name) || epic,
      bid,
      offer,
      mid: (bid + offer) / 2,
      pctChange: isFinite(Number(s.percentageChange)) ? Number(s.percentageChange) : null,
      marketStatus: s.marketStatus || null,
      high: isFinite(Number(s.high)) ? Number(s.high) : null,
      low: isFinite(Number(s.low)) ? Number(s.low) : null,
      at: new Date().toISOString(),
    };
  }
  throw new Error('capital: authentication failed twice');
}

// ---- dealing (demo-guarded in lib/bot.js) ----
async function dealReq(method, path, body, envOverride) {
  const c = creds(envOverride);
  if (!c) throw new Error('capital not configured');
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!sessions[c.env].cst) await login(c);
    const res = await fetch(c.base + path, {
      method,
      headers: { CST: sessions[c.env].cst, 'X-SECURITY-TOKEN': sessions[c.env].token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401) { sessions[c.env].cst = null; continue; }
    if (!res.ok) throw new Error(method + ' ' + path + ' HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
    return res.json();
  }
  throw new Error('capital auth failed twice');
}

const env = () => (creds() || {}).env;
const openPosition = ({ direction, size, stopLevel, profitLevel, trailingStop, stopDistance, epic = EPICS.brent, env: envOverride }) =>
  dealReq('POST', '/positions', trailingStop
    ? { epic, direction, size, guaranteedStop: false, trailingStop: true, stopDistance }
    : { epic, direction, size, guaranteedStop: false, stopLevel, profitLevel }, envOverride);
const closePosition = (dealId, envOverride) => dealReq('DELETE', '/positions/' + encodeURIComponent(dealId), undefined, envOverride);
const listPositions = async (envOverride) => (await dealReq('GET', '/positions', undefined, envOverride)).positions || [];
const confirmDeal = (ref, envOverride) => dealReq('GET', '/confirms/' + encodeURIComponent(ref), undefined, envOverride);
const ensureHedging = async (envOverride) => {
  const cur = await dealReq('GET', '/accounts/preferences', undefined, envOverride);
  if (!cur.hedgingMode) { await dealReq('PUT', '/accounts/preferences', { hedgingMode: true }, envOverride); return 'enabled'; }
  return 'already on';
};
const accounts = async (envOverride) => (await dealReq('GET', '/accounts', undefined, envOverride)).accounts || [];

module.exports = { snapshot, configured: () => Boolean(creds()), env, openPosition, closePosition, listPositions, confirmDeal, accounts, ensureHedging, setEnv };
