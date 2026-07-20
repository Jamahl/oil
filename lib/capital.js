'use strict';
// Capital.com CFD quote feed (routes mirrored from quantedge's capital_client).
// Session: POST /session with X-CAP-API-KEY + identifier/password -> CST and
// X-SECURITY-TOKEN response headers, reused until a 401 forces re-login.
// Sessions idle out after ~10 min; our poll cadence keeps them warm.
const BASES = {
  demo: 'https://demo-api-capital.backend-capital.com/api/v1',
  live: 'https://api-capital.backend-capital.com/api/v1',
};
const EPICS = { brent: 'OIL_BRENT', wti: 'OIL_CRUDE', gold: 'GOLD' };

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

// Single-flight guard: /api/price and /api/positions poll concurrently, and
// two cold requests inside the 2s login throttle would fail the second one.
// Both share one in-flight login instead.
let loginInFlight = null;
function loginOnce(c) {
  if (!loginInFlight) {
    loginInFlight = login(c).finally(() => {
      loginInFlight = null;
    });
  }
  return loginInFlight;
}

// Live CFD snapshot -> { source, env, epic, bid, offer, mid, pctChange, marketStatus, at }
async function snapshot(instrument = 'brent') {
  const c = creds();
  if (!c) return null;
  const epic = EPICS[instrument] || instrument;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!session.cst) await loginOnce(c);
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

// Open CFD positions — read-only account view, no order routes exist here.
// -> { env, at, positions: [{ dealId, epic, name, instrumentType, direction,
//      size, openLevel, current, pl, currency, openedAt }] }
async function positions() {
  const c = creds();
  if (!c) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!session.cst) await loginOnce(c);
    const res = await fetch(`${c.base}/positions`, {
      headers: { CST: session.cst, 'X-SECURITY-TOKEN': session.token },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 401) {
      session.cst = null; // expired — re-login once
      continue;
    }
    if (!res.ok) throw new Error(`capital positions HTTP ${res.status}`);
    const j = await res.json();
    const list = Array.isArray(j.positions) ? j.positions : [];
    return {
      env: c.env,
      at: new Date().toISOString(),
      positions: list.map((row) => {
        const p = row.position || {};
        const m = row.market || {};
        const short = p.direction === 'SELL';
        // A long closes at bid, a short closes at offer — that side is "current".
        const current = short ? Number(m.offer) : Number(m.bid);
        return {
          dealId: p.dealId || null,
          epic: m.epic || p.epic || null,
          name: m.instrumentName || m.epic || p.epic || 'unknown',
          instrumentType: m.instrumentType || null,
          direction: short ? 'SHORT' : 'LONG',
          size: isFinite(Number(p.size)) ? Number(p.size) : null,
          openLevel: isFinite(Number(p.level)) ? Number(p.level) : null,
          current: isFinite(current) ? current : null,
          pl: isFinite(Number(p.upl)) ? Number(p.upl) : null,
          currency: p.currency || null,
          // createdDateUTC arrives without a zone suffix — append Z so
          // clients don't parse it as local time.
          openedAt: p.createdDateUTC
            ? (/[zZ]|[+-]\d{2}:?\d{2}$/.test(p.createdDateUTC) ? p.createdDateUTC : p.createdDateUTC + 'Z')
            : p.createdDate || null,
        };
      }),
    };
  }
  throw new Error('capital: authentication failed twice');
}

module.exports = { snapshot, positions, configured: () => Boolean(creds()) };
