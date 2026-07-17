'use strict';
/* CrudeSignal Lab frontend — price, signal, targets, news, fundamentals, journal.
   Chart tokens follow the dataviz method. */

const $ = (id) => document.getElementById(id);
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const charts = {};
let lastData = null;
let currentModel = 'ridge';

const fmt = {
  usd: (v, dp = 2) => (v == null ? '—' : '$' + v.toFixed(dp)),
  num: (v, dp = 2) => (v == null ? '—' : v.toFixed(dp)),
  pct: (v, dp = 2) => (v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(dp) + '%'),
  pct0: (v, dp = 1) => (v == null ? '—' : (v * 100).toFixed(dp) + '%'),
  mmbbl: (v) => (v == null ? '—' : v.toFixed(1) + 'M'),
};

function destroyCharts() {
  for (const k of Object.keys(charts)) {
    charts[k].destroy();
    delete charts[k];
  }
}

function baseOpts({ yFmt, xLabels = true } = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: false }, tooltip: { callbacks: {} } },
    scales: {
      x: {
        grid: { display: false },
        border: { color: cssVar('--baseline') },
        ticks: { display: xLabels, color: cssVar('--muted'), maxRotation: 0, autoSkip: true, maxTicksLimit: 6 },
      },
      y: {
        grid: { color: cssVar('--grid'), drawTicks: false },
        border: { display: false },
        ticks: { color: cssVar('--muted'), maxTicksLimit: 6, callback: yFmt },
      },
    },
  };
}

function line(label, data, color) {
  return {
    label,
    data,
    borderColor: color,
    backgroundColor: color,
    borderWidth: 2,
    pointRadius: 0,
    pointHoverRadius: 4,
    pointHitRadius: 10,
    tension: 0,
    spanGaps: true,
  };
}

function htmlLegend(el, items) {
  el.innerHTML = items
    .map((it) => `<span class="key"><span class="swatch ${it.box ? 'box' : ''}" style="background:${it.color}"></span>${it.label}</span>`)
    .join('');
}

/* ================= simple view ================= */

function renderHero(d) {
  const k = d.kpis.brent;
  const chg = k.prev ? d.price.value / k.prev - 1 : null;
  const asof = d.price.asOf.length > 10 ? new Date(d.price.asOf).toLocaleString() : d.price.asOf;
  $('hero-price').innerHTML = `
    <div class="label">Brent crude <span id="live-badge" class="live-badge"><span class="dot"></span>delayed</span></div>
    <div class="big" id="hero-big">${fmt.usd(d.price.value)}</div>
    <div class="delta ${chg >= 0 ? 'up' : 'down'}" id="hero-delta">${chg >= 0 ? '▲' : '▼'} ${fmt.pct(chg)} vs prior close</div>
    <div class="asof" id="hero-asof">as of ${asof}</div>`;

  const a = d.news.activity;
  const explain = {
    QUIET: 'Calm tape — no major oil-moving headlines. Fundamentals and flows dominate; targets use normal volatility.',
    ELEVATED: 'Above-normal news flow. Targets widened ×1.2 — headlines can override the model quickly.',
    EVENT: 'News-driven tape: major oil-moving events in play. Targets widened ×1.5 and model leans are unreliable — headlines rule.',
  }[a.level];
  const lanes = d.news.lanes || {};
  $('hero-state').innerHTML = `
    <span class="state-badge state-${a.level}"><span class="dot"></span>${a.level} tape</span>
    <p>${explain}</p>
    <p class="note">news score ${a.points} · lanes: ${lanes.parallel ? 'Parallel ✓' : 'Parallel —'} · ${lanes.rss ? 'RSS ✓' : 'RSS —'} · refreshed ${d.news.fetchedAt ? new Date(d.news.fetchedAt).toLocaleTimeString() : '—'}</p>`;
}

function renderTargets(d, liveSpot) {
  const spot = liveSpot || d.price.value;
  const anchored = d.targets.map((t) => ({
    ...t,
    target: spot * (1 + t.expectedReturn),
    low: spot * (1 + t.expectedReturn - t.bandPct),
    high: spot * (1 + t.expectedReturn + t.bandPct),
  }));
  $('targets').innerHTML = anchored
    .map((t) => {
      const leanCls = t.direction === 'BULLISH' ? 'bull' : t.direction === 'BEARISH' ? 'bear' : '';
      const leanTxt =
        t.direction === 'FLAT'
          ? '— no lean'
          : `${t.direction === 'BULLISH' ? '▲ leans up' : '▼ leans down'}${t.bucket ? ' · ' + t.bucket : ''}`;
      const leanTitle = t.bucketHit
        ? `this conviction bucket was right ${fmt.pct0(t.bucketHit.hitRate)} of the time out-of-sample (n=${t.bucketHit.n})`
        : 'historical hit rate appears once enough predictions are scored';
      // Only a REAL edge earns a line on the card — the shared note below the row
      // already carries the near-coin-flip disclaimer once, not six times.
      const edgeLine = t.edge.cls !== 'none' ? `<div class="edge">${t.edge.label}</div>` : '';
      return `<div class="target">
        <div class="when">in ${t.label}</div>
        <div class="tgt">${fmt.usd(t.target)}</div>
        <div class="range">${fmt.usd(t.low)} – ${fmt.usd(t.high)}</div>
        <span class="lean ${leanCls}" title="${leanTitle}">${leanTxt}</span>
        ${edgeLine}
      </div>`;
    })
    .join('');
  const anyEvent = d.news.activity.level !== 'QUIET';
  $('targets-note').textContent =
    `Range = most-likely path ±1σ from recent realized volatility (about 2-in-3 odds)` +
    (anyEvent ? `, widened for the ${d.news.activity.level.toLowerCase()} news tape` : '') +
    `. Leans appear only when the model clears its dead zone — every model is near coin-flip historically, so treat leans as context, not signals.`;
}

function renderNews(d) {
  const items = d.news.items || [];
  const llm = d.news.llm || { ok: false };

  const st = $('llm-status');
  st.className = 'chip ' + (llm.ok ? 'ok' : llm.reason === 'no OPENROUTER_API_KEY' || llm.reason === 'disabled' ? 'off' : 'bad');
  st.title = llm.ok ? `scored by ${llm.model}` : llm.reason || 'off';
  st.innerHTML = `<span class="dot"></span>AI ${llm.ok ? 'on' : 'off'}`;

  const read = $('llm-read');
  if (llm.ok && llm.summary) {
    const leanCls = llm.lean === 'bullish' ? 'bull' : llm.lean === 'bearish' ? 'bear' : '';
    read.hidden = false;
    read.innerHTML = `AI read: <b class="${leanCls}">${llm.lean.toUpperCase()}</b> — ${escapeHtml(llm.summary)} <span class="who">· ${escapeHtml(llm.model)}</span>`;
  } else {
    read.hidden = true;
  }

  if (!items.length) {
    $('news-list').innerHTML = '<p class="note">No headlines available — news lanes down or first fetch pending.</p>';
    return;
  }
  $('news-list').innerHTML = items
    .map((it) => {
      const cls = it.score >= 3 ? 'hot' : it.score >= 1 ? 'warm' : '';
      const age = it.publishedAt ? relAge(it.publishedAt) : '';
      const ai = it.ai
        ? ` · <span class="ai-dir ${it.ai.direction === 'bull' ? 'bull' : it.ai.direction === 'bear' ? 'bear' : ''}">AI: ${
            it.ai.direction === 'bull' ? '▲ bull' : it.ai.direction === 'bear' ? '▼ bear' : '— unclear'
          }${it.ai.materiality >= 2 ? ' · mat ' + it.ai.materiality : ''}</span>${it.ai.novelty === 'rehash' ? ' · <span class="news-tags">rehash</span>' : ''}`
        : '';
      return `<div class="news-item">
        <span class="news-score ${cls}">${it.score}</span>
        <div>
          <a href="${it.url || '#'}" target="_blank" rel="noopener">${escapeHtml(it.title)}</a>
          <div class="news-meta">${escapeHtml(it.source || '')}${age ? ' · ' + age : ''}${it.tags && it.tags.length ? ' · <span class="news-tags">' + it.tags.join(', ') + '</span>' : ''}${ai}</div>
        </div>
      </div>`;
    })
    .join('');
}

function relAge(iso) {
  const h = (Date.now() - Date.parse(iso)) / 3600000;
  if (!isFinite(h) || h < 0) return '';
  if (h < 1) return Math.round(h * 60) + 'm ago';
  if (h < 24) return Math.round(h) + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderIntraday(d) {
  if (!d.series.intraday) return;
  const s = d.series.intraday;
  const labels = s.dates.map((iso) => {
    const dt = new Date(iso);
    return `${dt.getMonth() + 1}/${dt.getDate()} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
  });
  charts.intraday = new Chart($('ch-intraday'), {
    type: 'line',
    data: { labels, datasets: [line('Brent', s.close, cssVar('--series-1'))] },
    options: (() => {
      const o = baseOpts({ yFmt: (v) => '$' + v.toFixed(1) });
      o.plugins.tooltip.callbacks = { label: (c) => ' Brent ' + fmt.usd(c.parsed.y) };
      return o;
    })(),
  });
}

function renderPrice(d) {
  charts.price = new Chart($('ch-price'), {
    type: 'line',
    data: { labels: d.series.dates, datasets: [line('Brent', d.series.brent, cssVar('--series-1'))] },
    options: (() => {
      const o = baseOpts({ yFmt: (v) => '$' + v });
      o.plugins.tooltip.callbacks = { label: (c) => ' Brent ' + fmt.usd(c.parsed.y) };
      return o;
    })(),
  });
}

function renderInventory(d) {
  if (!d.series.inventory) return;
  const inv = d.series.inventory;
  charts.invLevel = new Chart($('ch-inv-level'), {
    type: 'line',
    data: { labels: inv.weekEnd, datasets: [line('Stocks', inv.level, cssVar('--series-1'))] },
    options: (() => {
      const o = baseOpts({ yFmt: (v) => v.toFixed(0) + 'M', xLabels: false });
      o.plugins.tooltip.callbacks = { label: (c) => ' stocks ' + c.parsed.y.toFixed(1) + 'M bbl' };
      return o;
    })(),
  });
  charts.invChg = new Chart($('ch-inv-chg'), {
    type: 'bar',
    data: {
      labels: inv.weekEnd,
      datasets: [
        {
          label: 'Weekly Δ',
          data: inv.chg,
          backgroundColor: inv.chg.map((v) => (v >= 0 ? cssVar('--neg') : cssVar('--pos'))),
          borderRadius: 3,
          borderSkipped: 'start',
          maxBarThickness: 8,
        },
      ],
    },
    options: (() => {
      const o = baseOpts({ yFmt: (v) => v + 'M' });
      o.interaction = { mode: 'nearest', intersect: false };
      o.scales.y.grid.color = (ctx) => (ctx.tick.value === 0 ? cssVar('--baseline') : cssVar('--grid'));
      o.plugins.tooltip.callbacks = { label: (c) => ` ${c.parsed.y >= 0 ? 'build' : 'draw'} ${Math.abs(c.parsed.y).toFixed(1)}M bbl` };
      return o;
    })(),
  });
  htmlLegend($('lg-inv'), [
    { label: 'stocks level', color: cssVar('--series-1') },
    { label: 'weekly build (price-bearish)', color: cssVar('--neg'), box: true },
    { label: 'weekly draw (price-bullish)', color: cssVar('--pos'), box: true },
  ]);
}

function renderKpis(d) {
  const k = d.kpis;
  const cells = [];
  const deltaHtml = (cur, prev, formatter, invert = false) => {
    if (cur == null || prev == null) return '';
    const dd = cur - prev;
    const up = dd >= 0;
    const cls = invert ? (up ? 'down' : 'up') : up ? 'up' : 'down';
    return `<div class="delta ${cls}">${up ? '▲' : '▼'} ${formatter(dd)}</div>`;
  };
  cells.push(`<div class="kpi"><div class="label">WTI (CL=F)</div><div class="value">${fmt.usd(k.wti.value)}</div>${deltaHtml(k.wti.value, k.wti.prev, (x) => fmt.pct(x / k.wti.prev))}</div>`);
  cells.push(`<div class="kpi"><div class="label">WTI−Brent spread</div><div class="value">${fmt.usd(k.spread.value)}</div>${deltaHtml(k.spread.value, k.spread.prev, (x) => '$' + x.toFixed(2))}</div>`);
  cells.push(`<div class="kpi"><div class="label">Dollar index</div><div class="value">${fmt.num(k.dxy.value)}</div>${deltaHtml(k.dxy.value, k.dxy.prev, (x) => fmt.pct(x / k.dxy.prev), true)}</div>`);
  if (k.ovx) cells.push(`<div class="kpi"><div class="label">OVX (oil VIX)</div><div class="value">${fmt.num(k.ovx.value, 1)}</div>${deltaHtml(k.ovx.value, k.ovx.prev, (x) => x.toFixed(1) + ' pts', true)}</div>`);
  if (k.inventory) {
    const c = k.inventory.chg;
    cells.push(`<div class="kpi"><div class="label">Crude stocks (excl SPR)</div><div class="value">${fmt.mmbbl(k.inventory.level)}</div><div class="delta">${c >= 0 ? '▲' : '▼'} ${Math.abs(c).toFixed(1)}M ${c >= 0 ? 'build' : 'draw'}</div><div class="sub">week ending ${k.inventory.weekEnd}</div></div>`);
  }
  if (k.curve) {
    const cv = k.curve;
    const tilt = cv.state === 'backwardation' ? 'tight physical market (bullish tilt)' : cv.state === 'contango' ? 'oversupplied (bearish tilt)' : 'balanced';
    const cls = cv.state === 'backwardation' ? 'up' : cv.state === 'contango' ? 'down' : '';
    cells.push(`<div class="kpi"><div class="label">Brent curve M1−M2</div><div class="value">${cv.spread >= 0 ? '+' : ''}$${cv.spread.toFixed(2)}</div><div class="delta ${cls}">${cv.state} · ${cv.chg5d >= 0 ? '+' : ''}${cv.chg5d.toFixed(2)} 5d</div><div class="sub">${tilt}</div></div>`);
  }
  $('kpis').innerHTML = cells.join('');
}

function renderDataChip(d) {
  const bad = d.health.filter((h) => !h.ok).length;
  const stale = d.health.filter((h) => h.ok && h.stale).length;
  const el = $('data-ok');
  const cls = bad ? 'bad' : stale ? 'stale' : 'ok';
  el.className = `chip ${cls}`;
  el.innerHTML = `<span class="dot"></span>${bad ? bad + ' feed(s) down' : stale ? stale + ' feed(s) stale' : 'data OK'}`;
}

/* ================= orchestration ================= */

function renderSimple(d) {
  renderDataChip(d);
  renderHero(d);
  renderTargets(d);
  renderNews(d);
  renderIntraday(d);
  renderPrice(d);
  renderInventory(d);
  renderKpis(d);
}

function renderAll(d) {
  destroyCharts();
  renderSimple(d);
}

function setStatus(msg, isError = false) {
  const el = $('status');
  if (!msg) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

/* --- prediction journal (plain-language scoreboard) --- */
const HZ_LABELS = { m15: '15-minute', m30: '30-minute', h1: '1-hour', d1: '1-day', w1: '1-week', mo1: '1-month' };

function rangeQuality(cov, resolved, cal, minN) {
  if (cov == null || resolved < 5) return { txt: 'not enough scored yet', cls: '' };
  const p = fmt.pct0(cov, 0);
  if (Math.abs(cov - 0.68) <= 0.07) return { txt: `${p} landed inside the range — on target ✓`, cls: 'good' };
  // Describe the correction honestly: applied only once tuning is live (minN).
  const kPct = cal ? Math.round(Math.abs(cal.k - 1) * 100) : 0;
  const fix = (verb) =>
    cal && cal.active
      ? `${verb}ing ${kPct}% now`
      : `will ${verb} ~${kPct}% once tuning goes live at ${minN} scored`;
  if (cov > 0.68) return { txt: `${p} landed inside — ranges too cautious; ${fix('tighten')}`, cls: '' };
  return { txt: `only ${p} landed inside — ranges too tight; ${fix('widen')}`, cls: 'bad' };
}

function arrowQuality(s) {
  if (!s.dirN || s.dirN < 5) return { txt: 'too few arrows shown to judge', cls: '' };
  const hit = fmt.pct0(s.dirHitRate, 0);
  const coin = s.baseUp == null ? '50%' : fmt.pct0(Math.max(s.baseUp, 1 - s.baseUp), 0);
  const base = { txt: `right ${hit} of the time (coin flip ≈ ${coin}, n=${s.dirN})`, cls: '' };
  if (s.leanVerdict === 'keep leans') return { txt: base.txt + ' — real edge, trust the arrows', cls: 'good' };
  if (s.leanVerdict === 'suppress leans') return { txt: base.txt + ' — worse than coin flip, ignore the arrows', cls: 'bad' };
  if (s.leanVerdict === 'no edge — treat as flat') return { txt: base.txt + ' — no better than chance, context only', cls: '' };
  return base;
}

function tuneStatus(cal, minN) {
  if (!cal || !cal.n) return 'auto-tuning starts after first scored predictions';
  if (!cal.active) return `auto-tuning warms up at ${minN} scored — has ${cal.n}`;
  const kPct = Math.round(Math.abs(cal.k - 1) * 100);
  const kTxt = kPct < 2 ? 'ranges confirmed accurate' : cal.k > 1 ? `ranges widened ${kPct}%` : `ranges tightened ${kPct}%`;
  const bTxt = Math.abs(cal.bias) >= 0.0005 ? `, targets nudged ${cal.bias > 0 ? 'down' : 'up'} ${fmt.pct0(Math.abs(cal.bias))}` : '';
  return `auto-tuning ON: ${kTxt}${bTxt}`;
}

async function loadJournal() {
  try {
    const j = await (await fetch('/api/journal')).json();
    if (j.error) throw new Error(j.error);

    const totalScored = j.stats.totals.resolved;
    const intro =
      totalScored === 0
        ? `Every prediction this page shows gets logged and scored against the real price once its time is up — then the ranges auto-correct from the results. Nothing scored yet: the first 15-minute predictions resolve within the hour; longer horizons take their own duration.`
        : `Every prediction gets logged, scored against the real price when its time is up, and the results auto-correct the ranges. <b>${totalScored} scored so far</b> (${j.stats.totals.open} waiting).`;

    const rows = Object.entries(j.stats.horizons)
      .map(([hz, s]) => {
        const cal = j.calibration[hz] || { k: 1, bias: 0, active: false, n: 0 };
        const minN = (j.horizons[hz] && j.horizons[hz].minN) || 50;
        const prog = Math.min(100, Math.round((cal.n / minN) * 100));
        const range = rangeQuality(s.bandCoverage, s.resolved, cal, minN);
        const arrow = arrowQuality(s);
        return `<div class="jrow">
          <div class="jcell jhz">
            <b>${HZ_LABELS[hz] || hz}</b>
            <div class="learnbar" title="progress toward ${minN} scored predictions (when auto-tuning switches on)"><div class="learnfill" style="width:${prog}%"></div></div>
            <span class="note">${s.resolved} scored · ${s.open} waiting</span>
          </div>
          <div class="jcell"><span class="jlabel">Ranges</span><span class="${range.cls}">${range.txt}</span></div>
          <div class="jcell"><span class="jlabel">Arrows (▲▼)</span><span class="${arrow.cls}">${arrow.txt}</span></div>
          <div class="jcell"><span class="jlabel">Self-correction</span><span>${tuneStatus(cal, minN)}</span></div>
        </div>`;
      })
      .join('');

    const sig = j.signals || {};
    let sigLine = '';
    if (sig.n) {
      const parts = [`${sig.n} logged (${sig.buys} buy / ${sig.holds} hold / ${sig.sells} sell)`];
      if (sig.n1h >= 5) parts.push(`an hour later the call was right ${fmt.pct0(sig.hit1h, 0)} of the time (n=${sig.n1h})`);
      else parts.push('accuracy appears once ~5 calls have aged an hour');
      if (sig.n1d >= 5) parts.push(`a day later: ${fmt.pct0(sig.hit1d, 0)} (n=${sig.n1d})`);
      sigLine = `<div class="jrow jsig"><div class="jcell jhz"><b>BUY/SELL signal</b></div><div class="jcell wide"><span class="jlabel">Track record</span><span>${parts.join(' · ')}</span></div></div>`;
    }

    $('journal-body').innerHTML = `<p class="jintro">${intro}</p>${rows}${sigLine}`;
    $('journal-meta').textContent = `stored in ${j.storage === 'neon' ? 'Neon Postgres (cloud)' : 'local SQLite'} · new entries every 5 min while the server runs`;
  } catch (e) {
    $('journal-body').innerHTML = `<p class="note">Journal unavailable: ${e.message}</p>`;
  }
}

$('btn-insight').addEventListener('click', async () => {
  const btn = $('btn-insight');
  const out = $('insight-out');
  btn.disabled = true;
  out.hidden = false;
  out.textContent = 'Reviewing journal stats with the configured model…';
  try {
    const r = await (await fetch('/api/journal/insight')).json();
    if (r.error) throw new Error(r.error);
    out.innerHTML = escapeHtml(r.markdown)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/^###?\s?(.+)$/gm, '<b>$1</b>')
      .replace(/^[-*]\s/gm, '• ')
      .replace(/\n/g, '<br>');
  } catch (e) {
    out.textContent = 'Insight failed: ' + e.message;
  } finally {
    btn.disabled = false;
  }
});

async function load(model) {
  currentModel = model;
  setStatus(model === 'forest' ? 'Training random forest out-of-sample — first run can take a minute or two…' : 'Loading data & training models…');
  try {
    const res = await fetch('/api/dashboard?model=' + model);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || res.statusText);
    lastData = json;
    renderAll(json);
    setStatus(null);
    loadJournal();
  } catch (e) {
    setStatus('Failed: ' + e.message + ' — is a feed down? Retry or check server logs.', true);
  }
}

setInterval(loadJournal, 5 * 60 * 1000);

/* --- realtime BUY/HOLD/SELL signal --- */
async function pollSignal() {
  try {
    const s = await (await fetch('/api/signal')).json();
    if (s.error) return;
    const cls = s.signal === 'BUY' ? 'buy' : s.signal === 'SELL' ? 'sell' : 'hold';
    const pos = Math.max(0, Math.min(100, ((s.bias + 1) / 2) * 100));
    const comps = s.components
      .filter((c) => Math.abs(c.score) > 0.02 || c.key === 'news')
      .sort((a, b) => Math.abs(b.score * b.weight) - Math.abs(a.score * a.weight))
      .slice(0, 3)
      .map((c) => {
        const up = c.score > 0;
        return `<div class="comp">${c.label}: <b class="${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${Math.abs(c.score).toFixed(2)}</b>${c.gated ? ' <span class="news-tags">(muted by journal)</span>' : ''}</div>`;
      })
      .join('');
    $('hero-signal').innerHTML = `
      <div class="label">Signal · ${s.tape} tape${s.confidence ? ` · ${s.confidence} (uncalibrated)` : ''}</div>
      <div class="sig-word ${cls}">${s.signal}</div>
      <div class="sig-track"><div class="sig-marker" style="left:calc(${pos}% - 2px)"></div></div>
      <div class="sig-scale"><span>sell −1</span><span>dead zone ±${s.deadZone}</span><span>+1 buy</span></div>
      ${comps}
      <div class="comp note">${escapeHtml(s.caveat)}</div>`;
  } catch {
    /* next tick */
  }
}
setInterval(pollSignal, 15000);
pollSignal();

/* --- 5-min news poll: refresh the tape without redrawing charts --- */
async function pollNews() {
  try {
    const n = await (await fetch('/api/news')).json();
    if (!n || n.error || !lastData) return;
    lastData.news = n;
    renderNews(lastData);
    renderHero(lastData); // tape badge + score line live on the hero card
  } catch {
    /* next tick */
  }
}
setInterval(pollNews, 5 * 60 * 1000);

/* --- scalp bot --- */
let botEditing = false;
const CONF_RANK_TXT = (m) => (m === 'Lean' ? ' (any strength)' : ' (' + m + ' or stronger)');
const BOT_FIELDS = ['sizeMode', 'positionSize', 'riskAmount', 'tpMode', 'tpValue', 'slMode', 'slValue', 'maxOpenTrades', 'cooldownSec', 'minConfidence', 'dailyLossCap'];

function botSentence(c) {
  const win = c.positionSize * (c.tpMode === 'usd' ? c.tpValue : 0);
  const loss = c.positionSize * (c.slMode === 'usd' ? c.slValue : 0);
  const V = (t, cls = '') => `<span class="bot-var ${cls}">${t}</span>`;
  return `<div id="bot-explain"><p class="bot-sentence">Each trade is ${V(c.positionSize + ' barrels')} when the signal fires${CONF_RANK_TXT(c.minConfidence)}. It banks ${V('+$' + win.toFixed(2), 'win')} when price moves $${c.tpValue} your way, or cuts at ${V('−$' + loss.toFixed(2), 'lose')} if it goes $${c.slValue} against you. Up to ${V(c.maxOpenTrades + ' trades')} at once, ${V(Math.round(c.cooldownSec / 60) + ' min')} between entries, day stops after ${V('−$' + c.dailyLossCap, 'lose')}.</p></div>`;
}

function botConfigForm(c) {
  const sel = (name, opts, cur) =>
    `<select data-bk="${name}">${opts.map((o) => `<option value="${o[0]}" ${o[0] === String(cur) ? 'selected' : ''}>${o[1]}</option>`).join('')}</select>`;
  const num = (name, cur, step = 'any') => `<input data-bk="${name}" type="number" step="${step}" value="${cur}">`;
  return botSentence(c) + `<div class="bot-grid">
    <span><label>Trade size (barrels)</label>${num('positionSize', c.positionSize, '0.1')}</span>
    <span><label>Take profit ($/barrel)</label>${num('tpValue', c.tpValue, '0.01')}</span>
    <span><label>Stop loss ($/barrel)</label>${num('slValue', c.slValue, '0.01')}</span>
    <span><label>Max trades at once</label>${num('maxOpenTrades', c.maxOpenTrades, '1')}</span>
    <span><label>&nbsp;</label><button id="bot-save" class="btn small">Save</button></span>
  </div>
  <details><summary class="note" style="cursor:pointer">Advanced</summary><div class="bot-grid">
    <span><label>Sizing</label>${sel('sizeMode', [['fixed', 'fixed size'], ['risk', 'risk amount']], c.sizeMode)}</span>
    <span><label>Risk $ / trade</label>${num('riskAmount', c.riskAmount, '1')}</span>
    <span><label>TP unit</label>${sel('tpMode', [['usd', '$ per barrel'], ['pct', '% of price']], c.tpMode)}</span>
    <span><label>SL unit</label>${sel('slMode', [['usd', '$ per barrel'], ['pct', '% of price']], c.slMode)}</span>
    <span><label>Pause between trades (sec)</label>${num('cooldownSec', c.cooldownSec, '15')}</span>
    <span><label>Min signal strength</label>${sel('minConfidence', [['Lean', 'Lean'], ['Moderate', 'Moderate'], ['Strong', 'Strong']], c.minConfidence)}</span>
    <span><label>Runner on hot momentum</label>${sel('runnerEnabled', [['true','on'],['false','off']], String(c.runnerEnabled))}</span>
    <span><label>Momentum trigger (0-1)</label>${num('runnerMomentum', c.runnerMomentum, '0.05')}</span>
    <span><label>Stop for the day after losing $</label>${num('dailyLossCap', c.dailyLossCap, '10')}</span>
  </div></details>`;
}

async function pollBot() {
  try {
    const b = await (await fetch('/api/bot')).json();
    if (b.error) throw new Error(b.error);
    const envChip = $('bot-env');
    envChip.className = 'chip ' + (b.running ? 'run' : b.halted ? 'halt' : 'off');
    envChip.innerHTML = `<span class="dot"></span>${b.env.toUpperCase()} · ${b.running ? (b.halted ? 'HALTED: ' + b.halted : 'RUNNING') : 'stopped'}`;
    document.getElementById('tab-demo').classList.toggle('active', b.env !== 'live');
    document.getElementById('tab-live').classList.toggle('active', b.env === 'live');
    document.getElementById('bot-card').classList.toggle('live-mode', b.env === 'live');
    $('bot-start').hidden = b.running;
    $('bot-stop').hidden = !b.running;

    const openRows = b.open
      .map(
        (t) =>
          `<tr><td>${t.env === 'live' ? '<span class="envtag real">REAL</span> ' : '<span class="envtag">demo</span> '}${t.dir}${t.kind && t.kind !== 'solo' ? ' · ' + t.kind : ''}</td><td>${t.size}</td><td>$${t.entry.toFixed(2)}</td><td>$${t.sl.toFixed(2)}</td><td>${t.tp == null ? 'trailing' : '$' + t.tp.toFixed(2)}</td><td class="${t.livePnl > 0 ? 'good' : t.livePnl < 0 ? 'bad' : ''}">${t.livePnl == null ? '—' : '$' + t.livePnl.toFixed(2)}</td><td><button class="xclose" data-deal="${t.dealId}" title="close this position now">×</button></td></tr>`
      )
      .join('');
    const openHdr = '<div class="jlabel" style="margin-top:8px">● Open positions — live, not yet closed</div>';
    const openTable = b.open.length
      ? `<table class="bt"><thead><tr><th>Dir</th><th>Size</th><th>Entry</th><th>SL</th><th>TP</th><th>Live P/L</th><th></th></tr></thead><tbody>${openRows}</tbody></table>`
      : '<p class="note">No open positions.</p>';
    const closedHdr = b.closed.length ? '<div class="jlabel" style="margin-top:12px">✓ Closed trades — settled history</div>' : '';
    const wins = b.closed.filter((t) => t.pnl > 0).length;
    const dayCls = b.dayPnl > 0 ? 'up' : b.dayPnl < 0 ? 'down' : '';
    const floating = b.open.reduce((s, t) => s + (t.livePnl || 0), 0);
    const plain = b.running
      ? `The bot is <b class="good">ON</b> (${b.env === 'live' ? '<b class="bad">REAL money</b>' : 'demo money'}). Today it has banked <b class="${dayCls === 'down' ? 'bad' : 'good'}">${b.dayPnl.toFixed(2)}\</b> from ${b.closedCount} finished trade${b.closedCount === 1 ? '' : 's'} (${wins} won). ${b.open.length ? `${b.open.length} trade${b.open.length > 1 ? 's are' : ' is'} still open, currently ${floating >= 0 ? 'up' : 'down'} ${Math.abs(floating).toFixed(2)} — each closes itself at its take-profit or stop.` : 'No trades open right now — it waits for the next signal.'}`
      : `The bot is <b>OFF</b>. Press Start and it will trade the signal automatically with ${b.env === 'live' ? '<b class="bad">REAL money</b>' : 'demo money'}.`;
    const stats = `<p class="jintro">${plain}</p>`;
    const events = `<div class="bot-events">${b.events.map((e) => `${new Date(e.at).toLocaleTimeString()} — ${escapeHtml(e.msg)}`).join('<br>')}</div>`;

    const closedTable = b.closed.length
      ? `<table class="bt"><thead><tr><th>Closed</th><th>Dir</th><th>Size</th><th>Entry</th><th>Exit</th><th>P/L</th><th>Why</th></tr></thead><tbody>${b.closed
          .map(
            (t) =>
              `<tr><td>${new Date(t.closedAt).toLocaleTimeString()}</td><td>${t.env === 'live' ? '<span class="envtag real">REAL</span> ' : ''}${t.dir || '—'}</td><td>${t.size == null ? '—' : t.size}</td><td>${t.entry == null ? '—' : '$' + t.entry.toFixed(2)}</td><td>${t.exit == null ? '—' : '$' + t.exit.toFixed(2)}</td><td class="${t.pnl > 0 ? 'good' : 'bad'}">$${t.pnl.toFixed(2)}</td><td class="note">${escapeHtml(t.reason || '')}</td></tr>`
          )
          .join('')}</tbody></table>`
      : '<p class="note">No settled trades on this account yet — each tab keeps its own history (your demo trades are on the Demo tab).</p>';
    if (!botEditing) {
      $('bot-body').innerHTML = stats + openHdr + openTable + closedHdr + closedTable + '<details style="margin-top:10px"><summary class="note" style="cursor:pointer">Settings</summary>' + botConfigForm(b.config) + '</details><details style="margin-top:6px"><summary class="note" style="cursor:pointer">Activity log</summary>' + events + '</details>';
      document.querySelectorAll('#bot-body [data-bk]').forEach((el) => {
        el.addEventListener('focus', () => (botEditing = true));
        el.addEventListener('input', () => {
          const v = { ...b.config };
          document.querySelectorAll('#bot-body [data-bk]').forEach((x) => { v[x.dataset.bk] = x.type === 'number' ? Number(x.value) : x.value; });
          const ex = document.getElementById('bot-explain');
          if (ex) ex.outerHTML = botSentence(v);
        });
      });
      const saveBtn = $('bot-save');
      if (saveBtn)
        saveBtn.addEventListener('click', async () => {
          const patch = {};
          document.querySelectorAll('#bot-body [data-bk]').forEach((el) => {
            const v = el.type === 'number' ? Number(el.value) : el.value;
            patch[el.dataset.bk] = el.dataset.bk === 'runnerEnabled' ? v === 'true' : v;
          });
          const r = await fetch('/api/bot/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
          const j = await r.json();
          botEditing = false;
          if (!r.ok) setStatus('Bot config rejected: ' + j.error, true);
          else setStatus(null);
          pollBot();
        });
    }
  } catch (e) {
    $('bot-body').innerHTML = `<p class="note">Bot unavailable: ${escapeHtml(e.message)}</p>`;
  }
}
$('bot-start').addEventListener('click', async () => {
  const r = await fetch('/api/bot/start', { method: 'POST' });
  if (!r.ok) setStatus('Bot start refused: ' + (await r.json()).error, true);
  botEditing = false;
  pollBot();
});
$('bot-stop').addEventListener('click', async () => {
  await fetch('/api/bot/stop', { method: 'POST' });
  botEditing = false;
  pollBot();
});
for (const t of ['demo', 'live'])
  $('tab-' + (t === 'live' ? 'live' : 'demo')).addEventListener('click', async () => {
    const r = await fetch('/api/bot/env', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ env: t }) });
    if (!r.ok) { setStatus('Switch refused: ' + (await r.json()).error, true); return; }
    setStatus(null); botEditing = false; pollBot();
  });
for (const d of ['buy', 'sell'])
  $('bot-' + d).addEventListener('click', async () => {
    const r = await fetch('/api/bot/manual', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: d.toUpperCase() }) });
    if (!r.ok) setStatus('Manual trade refused: ' + (await r.json()).error, true); else setStatus(null);
    pollBot();
  });
$('bot-body').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('.xclose');
  if (!btn) return;
  btn.disabled = true;
  const r = await fetch('/api/bot/close-one', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dealId: btn.dataset.deal }) });
  if (!r.ok) setStatus('Close failed: ' + (await r.json()).error, true);
  pollBot();
});
$('bot-closeall').addEventListener('click', async () => {
  await fetch('/api/bot/close-all', { method: 'POST' });
  pollBot();
});
setInterval(() => {
  if (!botEditing) pollBot();
}, 10000);
pollBot();

$('btn-refresh').addEventListener('click', async () => {
  const btn = $('btn-refresh');
  btn.disabled = true;
  setStatus('Refetching all feeds & retraining…');
  try {
    const res = await fetch('/api/refresh', { method: 'POST' });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    await load(currentModel);
  } catch (e) {
    setStatus('Refresh failed: ' + e.message, true);
  } finally {
    btn.disabled = false;
  }
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (lastData) renderAll(lastData);
});

/* --- LLM model config --- */
async function initConfig() {
  try {
    const cfg = await (await fetch('/api/config')).json();
    $('inp-llm').value = cfg.newsModel || '';
  } catch {
    /* non-fatal */
  }
}

$('btn-llm').addEventListener('click', async () => {
  const btn = $('btn-llm');
  const slug = $('inp-llm').value.trim();
  if (!slug) return;
  btn.disabled = true;
  setStatus(`Re-scoring news with ${slug}…`);
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newsModel: slug }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || res.statusText);
    await load(currentModel);
  } catch (e) {
    setStatus('Model change failed: ' + e.message, true);
  } finally {
    btn.disabled = false;
  }
});

/* --- live price poll (capital.com CFD, yahoo fallback) --- */
let liveSpot = null;
async function pollPrice() {
  try {
    const p = await (await fetch('/api/price')).json();
    if (!p || p.error || !lastData) return;
    liveSpot = p.mid;
    const live = p.source === 'capital-cfd';
    const badge = $('live-badge');
    if (badge) {
      badge.className = 'live-badge' + (live ? ' live' : '');
      badge.innerHTML = `<span class="dot"></span>${live ? `LIVE CFD${p.env === 'demo' ? '' : ''}${p.marketStatus && p.marketStatus !== 'TRADEABLE' ? ' · ' + p.marketStatus.toLowerCase() : ''}` : 'delayed'}`;
    }
    const big = $('hero-big');
    if (big) big.textContent = fmt.usd(p.mid);
    const asof = $('hero-asof');
    if (asof) asof.textContent = 'as of ' + new Date(p.at).toLocaleTimeString() + (live ? ` · bid ${p.bid.toFixed(2)} / ask ${p.offer.toFixed(2)}` : '');
    const deltaEl = $('hero-delta');
    if (deltaEl && live && p.pctChange != null) {
      const up = p.pctChange >= 0;
      deltaEl.className = `delta ${up ? 'up' : 'down'}`;
      deltaEl.textContent = `${up ? '▲' : '▼'} ${up ? '+' : ''}${p.pctChange.toFixed(2)}% today`;
    }
    renderTargets(lastData, liveSpot); // re-anchor target prices on the live spot
    renderScalp(p);
  } catch {
    /* next tick */
  }
}
setInterval(pollPrice, 5000);

// Scalper's viability check: is the typical short-horizon move big enough to
// pay the round-trip spread? Updates with every live tick.
function renderScalp(p) {
  const el = $('scalp');
  if (!el || !lastData) return;
  const t15 = lastData.targets.find((t) => t.id === 'm15');
  const t30 = lastData.targets.find((t) => t.id === 'm30');
  if (!t15) {
    el.hidden = true;
    return;
  }
  const live = p.source === 'capital-cfd' && p.bid != null && p.offer != null;
  const spot = p.mid;
  const range15 = spot * t15.bandPct;
  const range30 = t30 ? spot * t30.bandPct : null;
  const spread = live ? p.offer - p.bid : null;
  const ratio = spread > 0 ? range15 / spread : null;
  const verdict =
    ratio == null
      ? { cls: '', txt: 'live spread unavailable (delayed feed)' }
      : ratio >= 8
        ? { cls: 'good', txt: `good — typical move is ${ratio.toFixed(0)}× the spread` }
        : ratio >= 4
          ? { cls: 'ok', txt: `workable — move is ${ratio.toFixed(0)}× the spread` }
          : { cls: 'poor', txt: 'poor — the spread eats the typical move' };
  const tape = lastData.news.activity.level;
  el.hidden = false;
  el.innerHTML = `
    <span><span class="slabel">Scalp conditions</span><span class="scalp-verdict ${verdict.cls}">${verdict.txt}</span></span>
    <span><span class="slabel">CFD spread (your cost)</span><span class="sval">${spread != null ? '$' + spread.toFixed(3) : '—'}</span></span>
    <span><span class="slabel">Typical 15m move (±1σ)</span><span class="sval">±$${range15.toFixed(2)}</span></span>
    ${range30 != null ? `<span><span class="slabel">Typical 30m move</span><span class="sval">±$${range30.toFixed(2)}</span></span>` : ''}
    <span><span class="slabel">Move ÷ spread</span><span class="sval">${ratio != null ? ratio.toFixed(1) + '×' : '—'}</span></span>
    ${tape !== 'QUIET' ? `<span class="note">⚠ ${tape} tape — headline jumps, slippage risk on tight stops</span>` : ''}`;
}

initConfig();
load('ridge').then(pollPrice);
