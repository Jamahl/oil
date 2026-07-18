'use strict';
// One-time migration: import the JSON bot ledgers (data/bot_state*.json) into the
// bot_trades table so trade history is DB-backed and shared across machines —
// every host with DATABASE_URL then sees the same record (the JSON files are
// gitignored and never travel). Idempotent: rows dedupe ON CONFLICT
// (instrument, env, deal_id), so a re-run inserts nothing new. Closed rows with
// no dealId (broker-record recoveries) get a deterministic synthetic id
// 'import-<hash of closedAt+pnl>' so a re-run maps them to the same row.
//
// DATABASE_URL is read from .env via lib/env. Run: node scripts/import_bot_history.js
require('../lib/env');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const journal = require('../lib/journal');

const DATA_DIR = path.join(__dirname, '..', 'data');

// The three ledgers named in the task -> (instrument, default env). Rows also
// carry their own `env`; we prefer that and fall back to the file's default.
const LEDGERS = [
  { file: 'bot_state.json', instrument: 'brent', env: 'demo' },
  { file: 'bot_state_live.json', instrument: 'brent', env: 'live' },
  { file: 'bot_state_btc.json', instrument: 'btc', env: 'demo' },
];

function readState(file) {
  const p = path.join(DATA_DIR, file);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { try { return JSON.parse(fs.readFileSync(p + '.bak', 'utf8')); } catch { return null; } }
}

// Deterministic id for a dealId-less broker-record recovery.
function synthId(row) {
  return 'import-' + crypto.createHash('sha1').update(`${row.closedAt}|${row.pnl}`).digest('hex').slice(0, 16);
}

const numOrNull = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));
const msOrNull = (v) => { const t = Date.parse(v); return Number.isNaN(t) ? null : t; };

async function exists(d, instrument, env, dealId) {
  return !!(await d.get('SELECT 1 AS x FROM bot_trades WHERE instrument=? AND env=? AND deal_id=?', [instrument, env, dealId]));
}

(async () => {
  const d = await journal.getDriver(); // also runs the idempotent DDL (creates bot_trades)
  console.log('storage driver:', d.kind);

  for (const L of LEDGERS) {
    const st = readState(L.file);
    if (!st) { console.log(`\n${L.file}: not found — skipped`); continue; }
    const open = Array.isArray(st.open) ? st.open : [];
    const closed = Array.isArray(st.closed) ? st.closed : [];
    let insOpen = 0, insClosed = 0, deduped = 0, synth = 0;

    for (const t of open) {
      const env = t.env || L.env;
      const dealId = t.dealId || synthId(t);
      if (!t.dealId) synth++;
      const had = await exists(d, L.instrument, env, dealId);
      await d.run(
        `INSERT INTO bot_trades (instrument, env, deal_id, kind, dir, size, entry, sl, tp, opened_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
         ON CONFLICT (instrument, env, deal_id) DO NOTHING`,
        [L.instrument, env, dealId, t.kind || null, t.dir || null, numOrNull(t.size), numOrNull(t.entry), numOrNull(t.sl), numOrNull(t.tp), msOrNull(t.at)]
      );
      if (had) deduped++; else insOpen++;
    }

    for (const t of closed) {
      const env = t.env || L.env;
      const dealId = t.dealId || synthId(t);
      if (!t.dealId) synth++;
      const had = await exists(d, L.instrument, env, dealId);
      await d.run(
        `INSERT INTO bot_trades (instrument, env, deal_id, kind, dir, size, entry, sl, tp, opened_at, closed_at, exit, pnl, reason, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'closed')
         ON CONFLICT (instrument, env, deal_id) DO NOTHING`,
        [L.instrument, env, dealId, t.kind || null, t.dir || null, numOrNull(t.size), numOrNull(t.entry), numOrNull(t.sl), numOrNull(t.tp),
         msOrNull(t.at), msOrNull(t.closedAt), numOrNull(t.exit), numOrNull(t.pnl), t.reason || null]
      );
      if (had) deduped++; else insClosed++;
    }

    console.log(
      `\n${L.file} -> ${L.instrument}:` +
      `\n  file:     open=${open.length} closed=${closed.length} (synthetic ids used=${synth})` +
      `\n  inserted: open=${insOpen} closed=${insClosed}` +
      `\n  deduped:  ${deduped} (already present)`
    );
  }

  const tallies = await d.all(
    "SELECT instrument, env, status, COUNT(*) AS n FROM bot_trades GROUP BY instrument, env, status ORDER BY instrument, env, status"
  );
  console.log('\nbot_trades now holds:');
  for (const r of tallies) console.log(`  ${r.instrument}/${r.env} ${r.status}: ${Number(r.n)}`);

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
