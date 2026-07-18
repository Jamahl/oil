'use strict';
// Research runner — the autoresearch harness. Enforces the protocol in RESEARCH.md:
// trials score on the tune window only, the holdout window is scored one-shot per
// candidate, every run is journaled to research/journal.jsonl.
//
//   node scripts/research.js trial --desc "what changed" [--horizons fwd1,fwd5,fwd21|1h] [--model ridge|forest] [--cost 0.0003]
//   node scripts/research.js holdout <trialId>
//   node scripts/research.js noise [--horizons fwd1] [--shifts 20]
//   node scripts/research.js list

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { yahooDaily, yahooSeries, eiaCrudeStocks, eiaWeeklySeries, cotWtiPositioning } = require('../lib/fetchers');
const { buildDataset, buildIntradayRows } = require('../lib/data');
const { fitFnFor, walkForward, evaluate } = require('../lib/model');

// ---- Protocol constants (change = protocol change; note it in RESEARCH.md) ----
const HOLDOUT_START = { daily: '2024-07-01', '1h': '2026-01-15' };
const KILL_BAR = { minIC: 0.03, minHitEdge: 0.02, minSharpeNet: 0 };
const JOURNAL = path.join(__dirname, '..', 'research', 'journal.jsonl');

// horizonKey = target field on the rows; dataset picks the loader; stride gives
// non-overlapping scoring; step = walk-forward retrain cadence (matches server).
const HORIZONS = {
  fwd1: { dataset: 'daily', key: 'fwd1', bars: 1, stride: 1, step: 21 },
  fwd5: { dataset: 'daily', key: 'fwd5', bars: 5, stride: 5, step: 21 },
  fwd21: { dataset: 'daily', key: 'fwd21', bars: 21, stride: 21, step: 21 },
  '1h': { dataset: '1h', key: 'fwd1', bars: 1, stride: 1, step: 800 },
};

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else out._.push(argv[i]);
  }
  return out;
}

function readJournal() {
  if (!fs.existsSync(JOURNAL)) return [];
  return fs.readFileSync(JOURNAL, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function appendJournal(entry) {
  fs.mkdirSync(path.dirname(JOURNAL), { recursive: true });
  fs.appendFileSync(JOURNAL, JSON.stringify(entry) + '\n');
}

function gitState() {
  try {
    const head = execSync('git rev-parse --short HEAD', { cwd: path.join(__dirname, '..') }).toString().trim();
    const dirty = execSync('git status --porcelain', { cwd: path.join(__dirname, '..') }).toString().trim().length > 0;
    return { head, dirty };
  } catch {
    return { head: 'unknown', dirty: null };
  }
}

async function loadDataset(which, featureKeys) {
  if (which === 'daily') {
    const warn = (id) => (e) => (console.warn(`feed ${id} failed: ${e.message}`), null);
    const [brent, wti, dxy, ovx, inv, cush, gas, dist, util, spr, cot] = await Promise.all([
      yahooDaily('BZ=F'),
      yahooDaily('CL=F'),
      yahooDaily('DX-Y.NYB'),
      yahooDaily('^OVX').catch(warn('OVX')),
      eiaCrudeStocks().catch(warn('EIA crude')),
      // WPSR extras — research-only until a candidate PROMOTEs (see RESEARCH.md)
      eiaWeeklySeries('W_EPC0_SAX_YCUOK_MBBL').catch(warn('EIA cushing')),
      eiaWeeklySeries('WGTSTUS1').catch(warn('EIA gasoline')),
      eiaWeeklySeries('WDISTUS1').catch(warn('EIA distillate')),
      eiaWeeklySeries('WPULEUS3').catch(warn('EIA utilization')),
      eiaWeeklySeries('WCSSTUS1').catch(warn('EIA SPR')),
      cotWtiPositioning().catch(warn('CFTC COT')),
    ]);
    const ds = buildDataset({ brent, wti, dxy, ovx, inv, cush, gas, dist, util, spr, cot }, { featureKeys });
    return { rows: ds.rows, features: ds.features, barDates: ds.dates, holdoutStart: HOLDOUT_START.daily };
  }
  const series = await yahooSeries('BZ=F', { range: '730d', interval: '1h', ttlMs: 2 * 60 * 60 * 1000 });
  const built = buildIntradayRows(series);
  return { rows: built.rows, features: built.features, barDates: series.dates, holdoutStart: HOLDOUT_START['1h'] };
}

// Tune view: drop holdout rows AND null any target whose forward window lands in
// the holdout period (a 21d label at the boundary is future holdout price data).
function tuneRows(rows, barDates, key, bars, holdoutStart) {
  let cutI = barDates.findIndex((d) => d >= holdoutStart);
  if (cutI === -1) cutI = Infinity;
  return rows
    .filter((r) => r.date < holdoutStart)
    .map((r) => (r.i + bars >= cutI ? { ...r, [key]: null } : r));
}

function metricsOf(bt) {
  if (!bt) return null;
  return {
    n: bt.n,
    hitRate: +bt.hitRate.toFixed(4),
    baseRateUp: +bt.baseRateUp.toFixed(4),
    hitEdge: +(bt.hitRate - Math.max(bt.baseRateUp, 1 - bt.baseRateUp)).toFixed(4),
    ic: +bt.ic.toFixed(4),
    mae: +bt.mae.toFixed(5),
    maeNaive: +bt.maeNaive.toFixed(5),
    sharpeNoCosts: +bt.sharpeNoCosts.toFixed(3),
    sharpeNet: +bt.sharpeNet.toFixed(3),
    nTrades: bt.nTrades,
    maxDrawdown: +bt.maxDrawdown.toFixed(4),
    oosStart: bt.oosStart,
    oosEnd: bt.oosEnd,
  };
}

function fmt(m) {
  if (!m) return '  (too few points)';
  return (
    `  n=${m.n} hit=${(m.hitRate * 100).toFixed(1)}% base=${(Math.max(m.baseRateUp, 1 - m.baseRateUp) * 100).toFixed(1)}% ` +
    `edge=${(m.hitEdge * 100).toFixed(1)}pts IC=${m.ic.toFixed(3)} sharpeNet=${m.sharpeNet.toFixed(2)} ` +
    `(gross ${m.sharpeNoCosts.toFixed(2)}, ${m.nTrades} trades) OOS ${m.oosStart.slice(0, 10)}->${m.oosEnd.slice(0, 10)}`
  );
}

function passesKillBar(m) {
  if (!m) return { pass: false, why: 'too few points' };
  const fails = [];
  if (m.ic < KILL_BAR.minIC) fails.push(`IC ${m.ic.toFixed(3)} < ${KILL_BAR.minIC}`);
  if (m.hitEdge < KILL_BAR.minHitEdge) fails.push(`edge ${(m.hitEdge * 100).toFixed(1)}pts < ${KILL_BAR.minHitEdge * 100}pts`);
  if (m.sharpeNet <= KILL_BAR.minSharpeNet) fails.push(`sharpeNet ${m.sharpeNet.toFixed(2)} <= ${KILL_BAR.minSharpeNet}`);
  return { pass: fails.length === 0, why: fails.join('; ') || 'clears all bars' };
}

async function runTrial(args) {
  const desc = args.desc;
  if (!desc || desc === true) throw new Error('trial requires --desc "what changed and why"');
  const model = args.model || 'ridge';
  const horizons = (args.horizons || 'fwd1,fwd5,fwd21').split(',');
  const cost = args.cost ? parseFloat(args.cost) : undefined;
  const featureKeys = args.features && args.features !== true ? args.features.split(',') : undefined;

  const journal = readJournal();
  const id = 't' + String(journal.filter((e) => e.mode === 'tune').length + 1).padStart(3, '0');
  const metrics = {};
  let features = null;
  let window = null;

  for (const hz of horizons) {
    const cfg = HORIZONS[hz];
    if (!cfg) throw new Error(`unknown horizon ${hz} (use ${Object.keys(HORIZONS).join(', ')})`);
    const ds = await loadDataset(cfg.dataset, featureKeys);
    const rows = tuneRows(ds.rows, ds.barDates, cfg.key, cfg.bars, ds.holdoutStart);
    const t0 = Date.now();
    const preds = walkForward(rows, cfg.key, fitFnFor(model), { initialFrac: 0.6, step: cfg.step });
    const bt = evaluate(rows, preds, cfg.key, cfg.stride, { costPerSide: cost });
    metrics[hz] = metricsOf(bt);
    features = features || ds.features.map((f) => f.key);
    window = window || { tuneEnd: ds.holdoutStart };
    const prior = journal.filter((e) => e.mode === 'tune' && e.metrics && e.metrics[hz]).length;
    console.log(`[${id} ${model} ${hz}] tune window (${Date.now() - t0}ms) — trial #${prior + 1} on this horizon`);
    console.log(fmt(metrics[hz]));
  }

  const entry = {
    id,
    ts: new Date().toISOString(),
    mode: 'tune',
    desc,
    model,
    git: gitState(),
    features,
    window,
    costPerSide: cost != null ? cost : 0.0003,
    metrics,
  };
  appendJournal(entry);
  const nTune = journal.filter((e) => e.mode === 'tune').length + 1;
  console.log(`\nJournaled as ${id}. ${nTune} tune trial(s) total — best-of-${nTune} selection bias applies:`);
  console.log(`run "node scripts/research.js noise" to see what best-of-N looks like on pure noise.`);
  console.log(`Promotion requires a ONE-SHOT holdout run: node scripts/research.js holdout ${id}`);
}

async function runHoldout(args) {
  const ref = args._[0];
  if (!ref) throw new Error('usage: holdout <trialId>');
  const journal = readJournal();
  const trial = journal.find((e) => e.mode === 'tune' && e.id === ref);
  if (!trial) throw new Error(`no tune trial ${ref} in journal`);
  const already = journal.find((e) => e.mode === 'holdout' && e.ref === ref);
  if (already) throw new Error(`${ref} already holdout-scored (${already.id}, ${already.ts}). One shot per candidate — no re-rolls.`);

  const git = gitState();
  if (git.head !== trial.git.head) {
    console.warn(`WARNING: HEAD ${git.head} != trial HEAD ${trial.git.head} — make sure the code state matches the trial.`);
  }
  const nHold = journal.filter((e) => e.mode === 'holdout').length;
  console.log(`Holdout run #${nHold + 1} overall. Every holdout look leaks information — this should be rare.\n`);

  const metrics = {};
  const verdicts = {};
  for (const hz of Object.keys(trial.metrics)) {
    const cfg = HORIZONS[hz];
    // Replay the trial's exact feature set (daily; intraday features are fixed).
    const ds = await loadDataset(cfg.dataset, cfg.dataset === 'daily' ? trial.features : undefined);
    const preds = walkForward(ds.rows, cfg.key, fitFnFor(trial.model), { initialFrac: 0.6, step: cfg.step });
    const bt = evaluate(ds.rows, preds, cfg.key, cfg.stride, { from: ds.holdoutStart, costPerSide: trial.costPerSide });
    metrics[hz] = metricsOf(bt);
    const v = passesKillBar(metrics[hz]);
    verdicts[hz] = v.pass ? 'PROMOTE' : 'KILL';
    console.log(`[holdout ${trial.model} ${hz}] from ${ds.holdoutStart}`);
    console.log(fmt(metrics[hz]));
    console.log(`  -> ${verdicts[hz]} (${v.why})\n`);
  }

  appendJournal({
    id: 'h' + String(nHold + 1).padStart(3, '0'),
    ts: new Date().toISOString(),
    mode: 'holdout',
    ref,
    desc: trial.desc,
    model: trial.model,
    git,
    killBar: KILL_BAR,
    metrics,
    verdicts,
  });
  console.log('Journaled. A KILL verdict is final for this candidate family — iterate on tune, do not re-roll holdout.');
}

// Circular-shift the target column: real features, decoupled labels. The best |IC|
// across K shifted worlds is what "edge found by search" looks like on pure noise.
async function runNoise(args) {
  const hz = (args.horizons || 'fwd1').split(',')[0];
  const K = args.shifts ? parseInt(args.shifts, 10) : 20;
  const cfg = HORIZONS[hz];
  if (!cfg) throw new Error(`unknown horizon ${hz}`);
  const ds = await loadDataset(cfg.dataset);
  const rows = tuneRows(ds.rows, ds.barDates, cfg.key, cfg.bars, ds.holdoutStart);
  const targets = rows.map((r) => r[cfg.key]);
  const n = rows.length;
  const ics = [];
  for (let k = 1; k <= K; k++) {
    const off = 100 + Math.floor(((n - 200) * k) / (K + 1));
    const shifted = rows.map((r, j) => ({ ...r, [cfg.key]: targets[(j + off) % n] }));
    const preds = walkForward(shifted, cfg.key, fitFnFor('ridge'), { initialFrac: 0.6, step: cfg.step });
    const bt = evaluate(shifted, preds, cfg.key, cfg.stride);
    if (bt) ics.push(Math.abs(bt.ic));
    process.stdout.write(`\rshift ${k}/${K}  `);
  }
  ics.sort((a, b) => a - b);
  const q = (f) => ics[Math.min(ics.length - 1, Math.floor(f * ics.length))];
  console.log(`\n[noise bar ${hz}] K=${ics.length} label-shifted worlds, tune window, ridge`);
  console.log(`  |IC|  median=${q(0.5).toFixed(3)}  p95=${q(0.95).toFixed(3)}  max(best-of-${ics.length})=${ics[ics.length - 1].toFixed(3)}`);
  console.log(`  Interpretation: after N trials, a real candidate's tune IC must clear the best-of-N`);
  console.log(`  noise level decisively — otherwise you have selected noise, not signal.`);
}

function runList() {
  const journal = readJournal();
  if (!journal.length) return console.log('journal empty — no trials yet');
  for (const e of journal) {
    const head = `${e.id}  ${e.ts.slice(0, 16)}  ${e.mode.padEnd(7)}  ${e.model || ''}  ${e.mode === 'holdout' ? `ref=${e.ref} ` : ''}${e.desc}`;
    console.log(head);
    for (const [hz, m] of Object.entries(e.metrics || {})) {
      if (!m) continue;
      const verdict = e.verdicts ? `  ${e.verdicts[hz]}` : '';
      console.log(`    ${hz.padEnd(5)} IC=${m.ic.toFixed(3).padStart(6)}  edge=${(m.hitEdge * 100).toFixed(1).padStart(5)}pts  sharpeNet=${m.sharpeNet.toFixed(2).padStart(6)}${verdict}`);
    }
  }
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._.shift();
  if (cmd === 'trial' || cmd === 'baseline') await runTrial(args);
  else if (cmd === 'holdout') await runHoldout(args);
  else if (cmd === 'noise') await runNoise(args);
  else if (cmd === 'list') runList();
  else {
    console.log('usage: research.js trial --desc "..." [--horizons fwd1,fwd5,fwd21|1h] [--model ridge|forest] [--cost 0.0003] [--features k1,k2,...]');
    console.log('       research.js holdout <trialId>   (ONE SHOT per candidate)');
    console.log('       research.js noise [--horizons fwd1] [--shifts 20]');
    console.log('       research.js list');
    process.exit(cmd ? 1 : 0);
  }
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
