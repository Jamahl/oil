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

const session = { cst: null, token: null, lastLoginAt: 0 };

function creds() {
  const { CAPITAL_API_KEY, CAPITAL_IDENTIFIER, CAPITAL_PASSWORD, CAPITAL_ENVIRONMENT } = process.env;
  if (!CAPITAL_API_KEY || !CAPITAL_IDENTIFIER || !CAPITAL_PASSWORD) return null;
  const env = CAPITAL_ENVIRONMENT === 'live' ? 'live' : 'demo';
  return { key: CAPITAL_API_KEY, id: CAPITAL_IDENTIFIER, pw: CAPITAL_PASSWORD, env, base: BASES[env] };
}

async function login(c) {
  // Capital.com session endpoint is rate-limited to ~1/s — throttle re-logins.
  if (Date.now() - session.lastLoginAt < 2000) throw new Error('capital login throttled');
  session.lastLoginAt = Date.now();
  const res = await fetch(`${c.base}/session`, {
    method: 'POST',
    headers: { 'X-CAP-API-KEY': c.key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: c.id, password: c.pw, encryptedPassword: false }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`capital session HTTP ${res.status}`);
  session.cst = res.headers.get('cst');
  session.token = res.headers.get('x-security-token');
  if (!session.cst || !session.token) throw new Error('capital session: tokens missing');
}

// Live CFD snapshot -> { source, env, epic, bid, offer, mid, pctChange, marketStatus, at }
async function snapshot(instrument = 'brent') {
  const c = creds();
  if (!c) return null;
  const epic = EPICS[instrument] || instrument;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!session.cst) await login(c);
    const res = await fetch(`${c.base}/markets/${encodeURIComponent(epic)}`, {
      headers: { CST: session.cst, 'X-SECURITY-TOKEN': session.token },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 401) {
      session.cst = null; // expired — re-login once
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
async function dealReq(method, path, body) {
  const c = creds();
  if (!c) throw new Error('capital not configured');
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!session.cst) await login(c);
    const res = await fetch(c.base + path, {
      method,
      headers: { CST: session.cst, 'X-SECURITY-TOKEN': session.token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401) { session.cst = null; continue; }
    if (!res.ok) throw new Error(method + ' ' + path + ' HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200));
    return res.json();
  }
  throw new Error('capital auth failed twice');
}

const env = () => (creds() || {}).env;
const openPosition = ({ direction, size, stopLevel, profitLevel, trailingStop, stopDistance, epic = EPICS.brent }) =>
  dealReq('POST', '/positions', trailingStop
    ? { epic, direction, size, guaranteedStop: false, trailingStop: true, stopDistance }
    : { epic, direction, size, guaranteedStop: false, stopLevel, profitLevel });
const closePosition = (dealId) => dealReq('DELETE', '/positions/' + encodeURIComponent(dealId));
const listPositions = async () => (await dealReq('GET', '/positions')).positions || [];
const confirmDeal = (ref) => dealReq('GET', '/confirms/' + encodeURIComponent(ref));
const ensureHedging = async () => {
  const cur = await dealReq('GET', '/accounts/preferences');
  if (!cur.hedgingMode) { await dealReq('PUT', '/accounts/preferences', { hedgingMode: true }); return 'enabled'; }
  return 'already on';
};
const accounts = async () => (await dealReq('GET', '/accounts')).accounts || [];

module.exports = { snapshot, configured: () => Boolean(creds()), env, openPosition, closePosition, listPositions, confirmDeal, accounts, ensureHedging };
