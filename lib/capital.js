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

const freshSession = () => ({ cst: null, token: null, lastLoginAt: 0, createdAt: 0, loginPromise: null, failStreak: 0, youngDeaths: 0 });
const sessions = { demo: freshSession(), live: freshSession() };
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

// Serialized, rate-limit-compliant login. All concurrent callers share one
// in-flight login per env; the ~1/s session-endpoint limit is respected by
// WAITING out the gap (never by throwing), and repeated failures back off
// exponentially so we stay a polite API citizen even mid-incident.
const LOGIN_GAP_MS = 2000;

function login(c) {
  const s = sessions[c.env];
  if (s.loginPromise) return s.loginPromise; // piggyback the in-flight login
  s.loginPromise = doLogin(c, s).finally(() => { s.loginPromise = null; });
  return s.loginPromise;
}

async function doLogin(c, s) {
  const backoff = s.failStreak ? Math.min(60000, LOGIN_GAP_MS * 2 ** s.failStreak) : LOGIN_GAP_MS;
  const waitMs = s.lastLoginAt + backoff - Date.now();
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  s.lastLoginAt = Date.now();
  try {
    const res = await fetch(`${c.base}/session`, {
      method: 'POST',
      headers: { 'X-CAP-API-KEY': c.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: c.id, password: c.pw, encryptedPassword: false }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`capital session HTTP ${res.status}`);
    s.cst = res.headers.get('cst');
    s.token = res.headers.get('x-security-token');
    if (!s.cst || !s.token) throw new Error('capital session: tokens missing');
    s.createdAt = Date.now();
    s.failStreak = 0;
  } catch (e) {
    s.failStreak = Math.min(s.failStreak + 1, 5); // caps backoff at 64s
    throw e;
  }
}

// A 401 on a session younger than a minute means it was invalidated from the
// OUTSIDE — Capital kills the previous session when the same API key logs in
// elsewhere (classic: local dev server + VPS sharing one key). Detect the
// pattern, say so once, and slow our own logins right down.
function noteAuthFailure(env) {
  const s = sessions[env];
  const young = s.createdAt && Date.now() - s.createdAt < 60000;
  s.youngDeaths = young ? s.youngDeaths + 1 : 0;
  if (s.youngDeaths >= 2) {
    s.failStreak = Math.max(s.failStreak, 4);
    if (s.youngDeaths === 2 || s.youngDeaths % 20 === 0) {
      console.warn(`capital[${env}]: sessions keep dying seconds after login — another instance (local vs VPS?) is likely using the same API key. Use one key per machine. Backing off logins.`);
    }
  }
  s.cst = null;
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
      noteAuthFailure(c.env); // expired or externally invalidated — re-login once
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
    if (res.status === 401) { noteAuthFailure(c.env); continue; }
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
