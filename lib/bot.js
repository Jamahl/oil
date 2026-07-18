'use strict';
// Scalp bot — Node port of quantedge's brent_scalp_bot (branch
// claude/capital-brent-scalp-bot-wc5oax), wired to THIS app's combiner signal
// and Capital.com client. Philosophy kept from the original: risk rails first
// (spread gate, max concurrent, cooldown, daily loss kill), broker-side SL/TP
// attached at entry so exits survive the bot dying. Differences from the
// Python original: single TP instead of TP1 partial close (Capital's DELETE
// closes full positions; partials need opposite orders — deferred), and
// signals come from lib/signal.js instead of quantedge's scalp engine.
//
// MULTI-INSTANCE: `create(inst)` builds one fully isolated bot per instrument
// (registry entry from lib/instruments.js). Each instance owns its state
// object, state files (inst.botStateFile / inst.botEnvFile), env selection and
// dealing env — no mutable state is shared between instruments. Instruments
// with inst.liveLocked (btc) are HARD demo-only: live env is refused at every
// entry point regardless of config or environment variables.
const fs = require('fs');
const path = require('path');
const capital = require('./capital');

const DATA_DIR = path.join(__dirname, '..', 'data');
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
const CLOSED_KEEP = 1000; // full trade history retained in the state file

function createBot(inst) {
  const statePath = (env) => path.join(DATA_DIR, inst.botStateFile + (env === 'live' ? '_live' : '') + '.json');
  const envPath = path.join(DATA_DIR, inst.botEnvFile);
  const baseConfig = (env) => ({ ...DEFAULT_CONFIG, ...inst.botDefaults, ...(env === 'live' ? LIVE_SAFE : {}) });
  let envName = 'demo';
  let STATE_PATH = statePath('demo');

  // Size arithmetic on the instrument's grid (brent: 0.1 barrels, btc: 0.0001).
  const sizePow = Math.pow(10, inst.sizeDecimals);
  const roundSize = (x) => Math.floor(x * sizePow) / sizePow;

  const state = {
    running: false,
    config: baseConfig('demo'),
    open: [], // {dealId, dir, size, entry, sl, tp, at}
    closed: [], // last CLOSED_KEEP, {dir,size,entry,exit,pnl,at,closedAt,reason}
    events: [], // ring buffer of {at, msg}
    lastEntryAt: 0,
    dayPnl: 0,
    dayKey: '',
    halted: null, // reason string when risk rail tripped
    waiting: null,
  };

  function log(msg) {
    state.events.unshift({ at: new Date().toISOString(), msg });
    state.events = state.events.slice(0, 40);
    console.log(`bot[${inst.id}]:`, msg);
  }

  function save() {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    const { running, config, open, closed, events, dayPnl, dayKey } = state;
    const s = JSON.stringify({ running, config, open, closed, events, dayPnl, dayKey }, null, 2);
    try { if (fs.existsSync(STATE_PATH)) fs.renameSync(STATE_PATH, STATE_PATH + '.bak'); } catch {}
    fs.writeFileSync(STATE_PATH + '.tmp', s);
    fs.renameSync(STATE_PATH + '.tmp', STATE_PATH);
  }

  function loadState(env) {
    try {
      const saved = JSON.parse((() => { try { return fs.readFileSync(STATE_PATH, 'utf8'); } catch (e) { return fs.readFileSync(STATE_PATH + '.bak', 'utf8'); } })());
      Object.assign(state, saved);
      state.running = false; // never auto-resume trading after a restart/switch
      state.config = { ...baseConfig(env), ...saved.config }; // pick up new keys on upgrade
    } catch {}
  }
  loadState('demo');

  // The hard demo-only lock: allowLive can never be true for a liveLocked
  // instrument, no matter what a config patch, state file or env var says.
  function enforceLiveLock() {
    if (inst.liveLocked) state.config.allowLive = false;
  }
  enforceLiveLock();

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
    if (inst.liveLocked) next.allowLive = false; // patch cannot unlock it
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

  function sizeFor(sl) {
    const c = state.config;
    return c.sizeMode === 'fixed' ? c.positionSize : Math.max(inst.minSize, roundSize(c.riskAmount / sl));
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
      const broker = await capital.listPositions(envName);
      const brokerIds = new Set(broker.map((p) => p.position && p.position.dealId));
      for (const t of [...state.open]) {
        if (!brokerIds.has(t.dealId)) {
          const exit = spot && spot.mid ? spot.mid : t.entry; // best effort — broker doesn't return close price here
          const pnl = (t.dir === 'BUY' ? exit - t.entry : t.entry - exit) * t.size;
          state.dayPnl += pnl;
          state.open = state.open.filter((x) => x.dealId !== t.dealId);
          state.closed.unshift({ ...t, exit, pnl: Math.round(pnl * 100) / 100, closedAt: new Date().toISOString(), reason: 'broker close (TP/SL)' });
          state.closed = state.closed.slice(0, CLOSED_KEEP);
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
    enforceLiveLock();
    if (envName !== 'demo' && (inst.liveLocked || !state.config.allowLive)) {
      state.running = false;
      log(inst.liveLocked ? `HALT: ${inst.label} is demo-only (live hard-locked)` : 'HALT: account is not demo and allowLive=false');
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

    // Entry gates — each records WHY it is waiting so the UI can show it.
    const c = state.config;
    const wait = (why) => {
      state.waiting = why;
      return save();
    };
    if (!signal || !spot || spot.source !== 'capital-cfd') return wait('no live quote');
    if (spot.marketStatus && spot.marketStatus !== 'TRADEABLE') return wait('market is closed (' + spot.marketStatus + ')');
    if (signal.signal === 'HOLD') return wait('signal is HOLD — inside the dead zone');
    if ((CONF_RANK[signal.confidence] || 0) < CONF_RANK[c.minConfidence])
      return wait('signal is ' + signal.signal + ' ' + signal.confidence + ' — needs ' + c.minConfidence);
    if (state.open.length >= c.maxOpenTrades) return wait('at max open trades (' + c.maxOpenTrades + ')');
    if (Date.now() - state.lastEntryAt < c.cooldownSec * 1000)
      return wait('cooldown — ' + Math.ceil((c.cooldownSec * 1000 - (Date.now() - state.lastEntryAt)) / 1000) + 's left');
    state.waiting = null;
    const { tp, sl } = distances(spot.mid);
    const size = sizeFor(sl);
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
    const stopLevel = dir === 'BUY' ? entryRef - sl : entryRef + sl;
    const profitLevel = dir === 'BUY' ? entryRef + tp : entryRef - tp;

    // Hot momentum + runner enabled -> split into banker (fixed TP) + runner
    // (broker-side trailing stop, uncapped upside). Same total size, same worst case.
    const momo = (signal.components || []).find((x) => x.key === 'momentum');
    const hot = c.runnerEnabled && momo && Math.abs(momo.score) >= c.runnerMomentum && Math.sign(momo.score) === (dir === 'BUY' ? 1 : -1);
    const half = roundSize(size / 2);
    const tickets = hot && half >= inst.minSize
      ? [ { kind: 'banker', size: half, trailing: false }, { kind: 'runner', size: Math.round((size - half) * sizePow) / sizePow, trailing: true } ]
      : [ { kind: 'solo', size, trailing: false } ];
    for (const tk of tickets) {
      try {
        const res = await capital.openPosition(
          tk.trailing
            ? { epic: inst.epic, env: envName, direction: dir, size: tk.size, trailingStop: true, stopDistance: Math.round(sl * 100) / 100 }
            : { epic: inst.epic, env: envName, direction: dir, size: tk.size, stopLevel: Math.round(stopLevel * 100) / 100, profitLevel: Math.round(profitLevel * 100) / 100 }
        );
        const conf = await capital.confirmDeal(res.dealReference, envName);
        if (conf.dealStatus !== 'ACCEPTED') throw new Error('rejected: ' + (conf.rejectReason || conf.dealStatus));
        const dealId = (conf.affectedDeals && conf.affectedDeals[0] && conf.affectedDeals[0].dealId) || conf.dealId;
        state.open.push({ dealId, dir, size: tk.size, entry: conf.level || entryRef, sl: stopLevel, tp: tk.trailing ? null : profitLevel, kind: tk.kind, env: envName, at: new Date().toISOString() });
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
    enforceLiveLock();
    if (envName !== 'demo' && (inst.liveLocked || !state.config.allowLive)) {
      throw new Error(inst.liveLocked ? inst.label + ' is demo-only (live hard-locked)' : 'not demo; allowLive=false');
    }
    if (!spot || spot.source !== 'capital-cfd') throw new Error('no live quote');
    if (spot.marketStatus && spot.marketStatus !== 'TRADEABLE') throw new Error('market is closed (' + spot.marketStatus + ')');
    { const { sl: msl } = distances(spot.mid);
      const mOpenRisk = state.open.reduce((s, t) => s + t.size * Math.abs(t.entry - t.sl), 0);
      const mSize = sizeFor(msl);
      if (state.dayPnl - mOpenRisk - mSize * msl <= -state.config.dailyLossCap) throw new Error('blocked: would breach daily loss cap incl. open risk'); }
    const { tp, sl } = distances(spot.mid);
    const entryRef = dir === 'BUY' ? spot.offer : spot.bid;
    const size = sizeFor(sl);
    const stopLevel = dir === 'BUY' ? entryRef - sl : entryRef + sl;
    const profitLevel = dir === 'BUY' ? entryRef + tp : entryRef - tp;
    const res = await capital.openPosition({ epic: inst.epic, env: envName, direction: dir, size, stopLevel: Math.round(stopLevel*100)/100, profitLevel: Math.round(profitLevel*100)/100 });
    const conf = await capital.confirmDeal(res.dealReference, envName);
    if (conf.dealStatus !== 'ACCEPTED') throw new Error('rejected: ' + (conf.rejectReason || conf.dealStatus));
    const dealId = (conf.affectedDeals && conf.affectedDeals[0] && conf.affectedDeals[0].dealId) || conf.dealId;
    state.open.push({ dealId, dir, size, entry: conf.level || entryRef, sl: stopLevel, tp: profitLevel, env: envName, at: new Date().toISOString() });
    log('MANUAL ' + dir + ' ' + size + ' @' + (conf.level || entryRef).toFixed(2));
    save();
  }

  async function closeAll() {
    for (const t of [...state.open]) {
      try {
        await capital.closePosition(t.dealId, envName);
        log(`manual close ${t.dir} ${t.size}`);
      } catch (e) {
        log(`close failed ${t.dealId}: ${e.message}`);
      }
    }
  }

  const closeOne = (dealId) => capital.closePosition(dealId, envName);

  // Switch trading environment (bot must be stopped). Loads that env's own
  // state file; a fresh live tab starts with conservative defaults.
  function switchEnv(env) {
    if (env === 'live' && inst.liveLocked) throw new Error(inst.label + ' is demo-only — live trading is hard-locked off');
    if (state.running) { stop(); log('auto-stopped for account switch (open positions keep broker-side stops)'); }
    save();
    envName = env === 'live' ? 'live' : 'demo';
    STATE_PATH = statePath(envName);
    state.open = []; state.closed = []; state.events = []; state.dayPnl = 0; state.dayKey = ''; state.halted = null;
    state.config = baseConfig(envName);
    loadState(envName);
    if (envName === 'live') state.config.allowLive = true; else state.config.allowLive = false;
    enforceLiveLock();
    if (inst.drivesGlobalCapitalEnv) capital.setEnv(envName); // brent: the app-wide spot feed follows this bot's account
    try { fs.writeFileSync(envPath, envName); } catch {}
    log('switched to ' + envName.toUpperCase() + ' account');
    save();
  }

  function start() {
    enforceLiveLock();
    if (envName !== 'demo' && (inst.liveLocked || !state.config.allowLive)) {
      throw new Error(inst.liveLocked ? inst.label + ' is demo-only (live hard-locked)' : 'refusing: account is not demo and allowLive=false');
    }
    state.running = true;
    state.halted = null;
    capital.ensureHedging(envName).then((r) => log('hedging mode: ' + r)).catch(() => {});
    log(`bot started (${envName} account, max ${state.config.maxOpenTrades} trades, TP ${state.config.tpMode === 'usd' ? '$' + state.config.tpValue : state.config.tpValue + '%'})`);
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
    // All-time performance from the full persisted history (null-pnl records excluded).
    const scored = state.closed.filter((t) => t.pnl != null);
    const wins = scored.filter((t) => t.pnl > 0).length;
    const pnlTotal = scored.reduce((s, t) => s + t.pnl, 0);
    return {
      instrument: inst.id,
      label: inst.label,
      sizeUnit: inst.sizeUnit,
      liveLocked: Boolean(inst.liveLocked),
      running: state.running,
      env: capital.configured() ? envName : 'unconfigured',
      waiting: state.waiting || null,
      halted: state.halted,
      config: state.config,
      open: openView,
      closed: state.closed.slice(0, 15),
      events: state.events.slice(0, 12),
      dayPnl: Math.round(state.dayPnl * 100) / 100,
      closedCount: state.closed.length,
      stats: {
        pnl: Math.round(pnlTotal * 100) / 100,
        trades: scored.length,
        wins,
        winRate: scored.length ? wins / scored.length : null,
      },
    };
  }

  // Full persisted trade history (the status payload only carries 15 rows).
  function history() {
    return { instrument: inst.id, env: envName, closed: state.closed, count: state.closed.length };
  }

  const envOf = () => envName;

  // Restore the last-selected account across restarts (never auto-starts).
  // liveLocked instruments ignore a stray 'live' in the env file.
  try {
    const savedEnv = fs.readFileSync(envPath, 'utf8').trim();
    if (savedEnv === 'live' && !inst.liveLocked) switchEnv('live');
  } catch {}

  return { tick, start, stop, closeAll, closeOne, manual, reconcile, switchEnv, setConfig, status, history, env: envOf };
}

module.exports = { create: createBot };
