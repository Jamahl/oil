'use strict';
// Brent scalp bot — Node port of quantedge's brent_scalp_bot (branch
// claude/capital-brent-scalp-bot-wc5oax), wired to THIS app's combiner signal
// and Capital.com client. Philosophy kept from the original: risk rails first
// (spread gate, max concurrent, cooldown, daily loss kill), broker-side SL/TP
// attached at entry so exits survive the bot dying. Differences from the
// Python original: single TP instead of TP1 partial close (Capital's DELETE
// closes full positions; partials need opposite orders — deferred), and
// signals come from lib/signal.js instead of quantedge's scalp engine.
const fs = require('fs');
const path = require('path');
const capital = require('./capital');

const statePath = (env) => path.join(__dirname, '..', 'data', env === 'live' ? 'bot_state_live.json' : 'bot_state.json');
let STATE_PATH = statePath('demo');
const LIVE_SAFE = { positionSize: 1, minConfidence: 'Strong', dailyLossCap: 30, maxOpenTrades: 2 };

const DEFAULT_CONFIG = {
  sizeMode: 'fixed', // 'fixed' contracts | 'risk' (riskAmount / stop distance)
  positionSize: 10, // barrels (fixed mode)
  riskAmount: 50, // account-ccy risked per trade (risk mode)
  tpMode: 'usd', // 'usd' | 'pct'
  tpValue: 0.25, // $0.25 or 0.25%
  slMode: 'usd',
  slValue: 0.35,
  maxOpenTrades: 3,
  cooldownSec: 120, // min gap between entries
  minConfidence: 'Lean', // Lean | Moderate | Strong
  maxSpreadToTp: 0.2, // spread must be <= 20% of TP distance (ported rail)
  dailyLossCap: 200, // account-ccy realized loss that halts the bot for the day
  allowLive: false, // hard guard: never trade a live account unless explicitly set
  runnerEnabled: true, // banker+runner split on hot momentum
  runnerMomentum: 0.5, // momentum component score that triggers the split
};

const CONF_RANK = { Lean: 1, Moderate: 2, Strong: 3 };

const state = {
  running: false,
  config: { ...DEFAULT_CONFIG },
  open: [], // {dealId, dir, size, entry, sl, tp, at}
  closed: [], // last 50, {dir,size,entry,exit,pnl,at,closedAt,reason}
  events: [], // ring buffer of {at, msg}
  lastEntryAt: 0,
  dayPnl: 0,
  dayKey: '',
  halted: null, // reason string when risk rail tripped
};

function log(msg) {
  state.events.unshift({ at: new Date().toISOString(), msg });
  state.events = state.events.slice(0, 40);
  console.log('bot:', msg);
}

function save() {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const { running, config, open, closed, events, dayPnl, dayKey } = state;
  fs.writeFileSync(STATE_PATH, JSON.stringify({ running, config, open, closed, events, dayPnl, dayKey }, null, 2));
}
try {
  Object.assign(state, JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')));
  state.running = false; // never auto-resume trading after a restart
  state.config = { ...DEFAULT_CONFIG, ...state.config }; // pick up new keys on upgrade
} catch {}

function validate(c) {
  if (!['fixed', 'risk'].includes(c.sizeMode)) throw new Error('sizeMode');
  if (!(c.positionSize > 0 && c.positionSize <= 500)) throw new Error('positionSize must be 0-500');
  if (!(c.riskAmount > 0 && c.riskAmount <= 5000)) throw new Error('riskAmount must be 0-5000');
  for (const k of ['tp', 'sl']) {
    if (!['usd', 'pct'].includes(c[k + 'Mode'])) throw new Error(k + 'Mode');
    if (!(c[k + 'Value'] > 0 && c[k + 'Value'] <= (c[k + 'Mode'] === 'usd' ? 20 : 5))) throw new Error(k + 'Value out of range');
  }
  if (!(c.maxOpenTrades >= 1 && c.maxOpenTrades <= 10)) throw new Error('maxOpenTrades 1-10');
  if (!(c.cooldownSec >= 15 && c.cooldownSec <= 3600)) throw new Error('cooldownSec 15-3600');
  if (!CONF_RANK[c.minConfidence]) throw new Error('minConfidence');
  if (!(c.dailyLossCap > 0 && c.dailyLossCap <= 100000)) throw new Error('dailyLossCap');
  if (!(c.runnerMomentum >= 0.1 && c.runnerMomentum <= 1)) throw new Error('runnerMomentum 0.1-1');
}

function setConfig(patch) {
  const next = { ...state.config, ...patch };
  validate(next);
  state.config = next;
  save();
  return state.config;
}

function distances(price) {
  const c = state.config;
  const tp = c.tpMode === 'usd' ? c.tpValue : (price * c.tpValue) / 100;
  const sl = c.slMode === 'usd' ? c.slValue : (price * c.slValue) / 100;
  return { tp, sl };
}

function rollDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (state.dayKey !== today) {
    state.dayKey = today;
    state.dayPnl = 0;
    if (state.halted === 'daily loss cap') state.halted = null;
  }
}

// Book broker-side closes (TP/SL/manual) into history — safe to call any time.
async function reconcile(spot) {
  if (!capital.configured() || !state.open.length) return;
  // Reconcile: detect broker-side closes (TP/SL hit) and book P/L.
  try {
    const broker = await capital.listPositions();
    const brokerIds = new Set(broker.map((p) => p.position && p.position.dealId));
    for (const t of [...state.open]) {
      if (!brokerIds.has(t.dealId)) {
        const exit = spot && spot.mid ? spot.mid : t.entry; // best effort — broker doesn't return close price here
        const pnl = (t.dir === 'BUY' ? exit - t.entry : t.entry - exit) * t.size;
        state.dayPnl += pnl;
        state.open = state.open.filter((x) => x.dealId !== t.dealId);
        state.closed.unshift({ ...t, exit, pnl: Math.round(pnl * 100) / 100, closedAt: new Date().toISOString(), reason: 'broker close (TP/SL)' });
        state.closed = state.closed.slice(0, 50);
        log(`closed ${t.dir} ${t.size} @~${exit.toFixed(2)} pnl ~${pnl.toFixed(2)} (day ${state.dayPnl.toFixed(2)})`);
      }
    }
  } catch (e) {
    log('reconcile failed: ' + e.message);
  }

}

// One decision pass — called every signal tick (~15s) while running.
async function tick(signal, spot) {
  if (!state.running) return;
  rollDay();
  if (capital.env() !== 'demo' && !state.config.allowLive) {
    state.running = false;
    log('HALT: account is not demo and allowLive=false');
    return save();
  }

  await reconcile(spot);

  if (state.dayPnl <= -state.config.dailyLossCap) {
    if (state.halted !== 'daily loss cap') {
      state.halted = 'daily loss cap';
      log(`HALT: daily loss cap hit ($${state.dayPnl.toFixed(2)})`);
    }
    return save();
  }
  state.halted = null;

  // Entry gates.
  const c = state.config;
  if (!signal || !spot || spot.source !== 'capital-cfd') return save();
  if (spot.marketStatus && spot.marketStatus !== 'TRADEABLE') return save(); // closed/auction: no entries
  if (signal.signal === 'HOLD') return save();
  if ((CONF_RANK[signal.confidence] || 0) < CONF_RANK[c.minConfidence]) return save();
  if (state.open.length >= c.maxOpenTrades) return save();
  if (Date.now() - state.lastEntryAt < c.cooldownSec * 1000) return save();
  const { tp, sl } = distances(spot.mid);
  const openRisk = state.open.reduce((s, t) => s + t.size * Math.abs(t.entry - t.sl), 0);
  if (state.dayPnl - openRisk - size * sl <= -c.dailyLossCap) {
    log('skip entry: worst case (realized ' + state.dayPnl.toFixed(2) + ' - open risk ' + openRisk.toFixed(2) + ' - new ' + (size * sl).toFixed(2) + ') would breach daily cap');
    return save();
  }
  const spread = spot.offer - spot.bid;
  if (spread > c.maxSpreadToTp * tp) {
    log(`skip entry: spread $${spread.toFixed(3)} > ${c.maxSpreadToTp * 100}% of TP $${tp.toFixed(2)}`);
    return save();
  }

  const dir = signal.signal; // BUY | SELL
  const entryRef = dir === 'BUY' ? spot.offer : spot.bid;
  const size =
    c.sizeMode === 'fixed' ? c.positionSize : Math.max(1, Math.floor((c.riskAmount / sl) * 10) / 10);
  const stopLevel = dir === 'BUY' ? entryRef - sl : entryRef + sl;
  const profitLevel = dir === 'BUY' ? entryRef + tp : entryRef - tp;

// Hot momentum + runner enabled -> split into banker (fixed TP) + runner
  // (broker-side trailing stop, uncapped upside). Same total size, same worst case.
  const momo = (signal.components || []).find((x) => x.key === 'momentum');
  const hot = c.runnerEnabled && momo && Math.abs(momo.score) >= c.runnerMomentum && Math.sign(momo.score) === (dir === 'BUY' ? 1 : -1);
  const half = Math.floor((size / 2) * 10) / 10;
  const tickets = hot && half >= 1
    ? [ { kind: 'banker', size: half, trailing: false }, { kind: 'runner', size: Math.round((size - half) * 10) / 10, trailing: true } ]
    : [ { kind: 'solo', size, trailing: false } ];
  for (const tk of tickets) {
    try {
      const res = await capital.openPosition(
        tk.trailing
          ? { direction: dir, size: tk.size, trailingStop: true, stopDistance: Math.round(sl * 100) / 100 }
          : { direction: dir, size: tk.size, stopLevel: Math.round(stopLevel * 100) / 100, profitLevel: Math.round(profitLevel * 100) / 100 }
      );
      const conf = await capital.confirmDeal(res.dealReference);
      if (conf.dealStatus !== 'ACCEPTED') throw new Error('rejected: ' + (conf.rejectReason || conf.dealStatus));
      const dealId = (conf.affectedDeals && conf.affectedDeals[0] && conf.affectedDeals[0].dealId) || conf.dealId;
      state.open.push({ dealId, dir, size: tk.size, entry: conf.level || entryRef, sl: stopLevel, tp: tk.trailing ? null : profitLevel, kind: tk.kind, env: capital.env(), at: new Date().toISOString() });
      state.lastEntryAt = Date.now();
      const exitDesc = tk.trailing
        ? 'trailing SL $' + sl.toFixed(2)
        : 'SL ' + stopLevel.toFixed(2) + ' TP ' + profitLevel.toFixed(2);
      log('OPEN ' + tk.kind.toUpperCase() + ' ' + dir + ' ' + tk.size + ' @' + (conf.level || entryRef).toFixed(2) + ' ' + exitDesc + (hot ? ' [hot momentum ' + momo.score + ']' : ''));
    } catch (e) {
      log(tk.kind + ' entry failed: ' + e.message);
    }
  }
  save();
}

// One-tap manual entry using the configured size/TP/SL (demo-guarded).
async function manual(dir, spot) {
  if (capital.env() !== 'demo' && !state.config.allowLive) throw new Error('not demo; allowLive=false');
  if (!spot || spot.source !== 'capital-cfd') throw new Error('no live quote');
  if (spot.marketStatus && spot.marketStatus !== 'TRADEABLE') throw new Error('market is closed (' + spot.marketStatus + ')');
  { const { sl: msl } = distances(spot.mid);
    const mOpenRisk = state.open.reduce((s, t) => s + t.size * Math.abs(t.entry - t.sl), 0);
    const mSize = state.config.sizeMode === 'fixed' ? state.config.positionSize : Math.max(1, Math.floor((state.config.riskAmount / msl) * 10) / 10);
    if (state.dayPnl - mOpenRisk - mSize * msl <= -state.config.dailyLossCap) throw new Error('blocked: would breach daily loss cap incl. open risk'); }
  const { tp, sl } = distances(spot.mid);
  const entryRef = dir === 'BUY' ? spot.offer : spot.bid;
  const size = state.config.sizeMode === 'fixed' ? state.config.positionSize : Math.max(1, Math.floor((state.config.riskAmount / sl) * 10) / 10);
  const stopLevel = dir === 'BUY' ? entryRef - sl : entryRef + sl;
  const profitLevel = dir === 'BUY' ? entryRef + tp : entryRef - tp;
  const res = await capital.openPosition({ direction: dir, size, stopLevel: Math.round(stopLevel*100)/100, profitLevel: Math.round(profitLevel*100)/100 });
  const conf = await capital.confirmDeal(res.dealReference);
  if (conf.dealStatus !== 'ACCEPTED') throw new Error('rejected: ' + (conf.rejectReason || conf.dealStatus));
  const dealId = (conf.affectedDeals && conf.affectedDeals[0] && conf.affectedDeals[0].dealId) || conf.dealId;
  state.open.push({ dealId, dir, size, entry: conf.level || entryRef, sl: stopLevel, tp: profitLevel, at: new Date().toISOString() });
  state.open[state.open.length-1].env = capital.env();
  log('MANUAL ' + dir + ' ' + size + ' @' + (conf.level || entryRef).toFixed(2));
  save();
}

async function closeAll() {
  for (const t of [...state.open]) {
    try {
      await capital.closePosition(t.dealId);
      log(`manual close ${t.dir} ${t.size}`);
    } catch (e) {
      log(`close failed ${t.dealId}: ${e.message}`);
    }
  }
}

// Switch trading environment (bot must be stopped). Loads that env's own
// state file; a fresh live tab starts with conservative defaults.
function switchEnv(env) {
  if (state.running) { stop(); log('auto-stopped for account switch (open positions keep broker-side stops)'); }
  save();
  STATE_PATH = statePath(env);
  state.open = []; state.closed = []; state.events = []; state.dayPnl = 0; state.dayKey = ''; state.halted = null;
  state.config = { ...DEFAULT_CONFIG, ...(env === 'live' ? LIVE_SAFE : {}) };
  try { const saved = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); Object.assign(state, saved); state.running = false; state.config = { ...DEFAULT_CONFIG, ...(env === 'live' ? LIVE_SAFE : {}), ...saved.config }; } catch {}
  if (env === 'live') state.config.allowLive = true; else state.config.allowLive = false;
  capital.setEnv(env);
  try { fs.writeFileSync(path.join(__dirname, '..', 'data', 'bot_env.txt'), env); } catch {}
  log('switched to ' + env.toUpperCase() + ' account');
  save();
}

function start() {
  if (capital.env() !== 'demo' && !state.config.allowLive) throw new Error('refusing: account is not demo and allowLive=false');
  state.running = true;
  state.halted = null;
  capital.ensureHedging().then((r) => log('hedging mode: ' + r)).catch(() => {});
  log(`bot started (${capital.env()} account, max ${state.config.maxOpenTrades} trades, TP ${state.config.tpMode === 'usd' ? '$' + state.config.tpValue : state.config.tpValue + '%'})`);
  save();
}
function stop() {
  state.running = false;
  log('bot stopped (open positions keep their broker-side SL/TP)');
  save();
}

function status(spot) {
  const openView = state.open.map((t) => ({
    ...t,
    livePnl: spot && spot.mid ? Math.round((t.dir === 'BUY' ? spot.mid - t.entry : t.entry - spot.mid) * t.size * 100) / 100 : null,
  }));
  return {
    running: state.running,
    env: capital.env() || 'unconfigured',
    halted: state.halted,
    config: state.config,
    open: openView,
    closed: state.closed.slice(0, 15),
    events: state.events.slice(0, 12),
    dayPnl: Math.round(state.dayPnl * 100) / 100,
    closedCount: state.closed.length,
  };
}

// Restore the last-selected account across restarts (never auto-starts).
try {
  const savedEnv = fs.readFileSync(path.join(__dirname, '..', 'data', 'bot_env.txt'), 'utf8').trim();
  if (savedEnv === 'live') switchEnv('live');
} catch {}

module.exports = { tick, start, stop, closeAll, manual, reconcile, switchEnv, setConfig, status };
