'use strict';
/* CrudeSignal Lab — gold page. Mirrors app.js against /api/gold/dashboard:
   hero + tape, target cards, gold news, charts, KPIs, model lab in the fold.
   Shares style.css tokens and positions.js (loaded after this file). */

const $ = (id) => document.getElementById(id);
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const charts = {};
let lastData = null;
let currentModel = 'ridge';
let advRendered = false;

const fmt = {
  usd: (v, dp = 2) => (v == null ? '—' : '$' + v.toFixed(dp)),
  num: (v, dp = 2) => (v == null ? '—' : v.toFixed(dp)),
  pct: (v, dp = 2) => (v == null ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(dp) + '%'),
  pct0: (v, dp = 1) => (v == null ? '—' : (v * 100).toFixed(dp) + '%'),
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
  const k = d.kpis.gold;
  const chg = k.prev ? d.price.value / k.prev - 1 : null;
  const asof = d.price.asOf.length > 10 ? new Date(d.price.asOf).toLocaleString() : d.price.asOf;
  $('hero-price').innerHTML = `
    <div class="label">Gold <span id="live-badge" class="live-badge"><span class="dot"></span>delayed</span></div>
    <div class="big" id="hero-big">${fmt.usd(d.price.value)}</div>
    <div class="delta ${chg >= 0 ? 'up' : 'down'}" id="hero-delta">${chg >= 0 ? '▲' : '▼'} ${fmt.pct(chg)} vs prior close</div>
    <div class="asof" id="hero-asof">as of ${asof}</div>`;

  const a = d.news.activity;
  const explain = {
    QUIET: 'Calm tape — no major gold-moving headlines. Rates, the dollar and flows dominate; targets use normal volatility.',
    ELEVATED: 'Above-normal news flow. Targets widened ×1.2 — Fed-speak or data can override the model quickly.',
    EVENT: 'News-driven tape: major gold-moving events in play. Targets widened ×1.5 and model leans are unreliable — headlines rule.',
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
      const hit = t.bucketHit ? ` <span title="how often this conviction bucket was right out-of-sample">(${fmt.pct0(t.bucketHit.hitRate)} hist.)</span>` : '';
      return `<div class="target">
        <div class="when">in ${t.label}</div>
        <div class="tgt">${fmt.usd(t.target, 0)}</div>
        <div class="range">${fmt.usd(t.low, 0)} – ${fmt.usd(t.high, 0)}</div>
        <span class="lean ${leanCls}">${leanTxt}</span>${hit ? `<div class="edge">${hit}</div>` : ''}
        <div class="edge">${t.edge.label}</div>
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
    data: { labels, datasets: [line('Gold', s.close, cssVar('--series-3'))] },
    options: (() => {
      const o = baseOpts({ yFmt: (v) => '$' + v.toFixed(0) });
      o.plugins.tooltip.callbacks = { label: (c) => ' Gold ' + fmt.usd(c.parsed.y) };
      return o;
    })(),
  });
}

function renderPrice(d) {
  charts.price = new Chart($('ch-price'), {
    type: 'line',
    data: { labels: d.series.dates, datasets: [line('Gold', d.series.gold, cssVar('--series-3'))] },
    options: (() => {
      const o = baseOpts({ yFmt: (v) => '$' + v });
      o.plugins.tooltip.callbacks = { label: (c) => ' Gold ' + fmt.usd(c.parsed.y) };
      return o;
    })(),
  });
}

function renderRatio(d) {
  if (!d.series.ratio) return;
  charts.ratio = new Chart($('ch-ratio'), {
    type: 'line',
    data: { labels: d.series.dates, datasets: [line('Gold/silver', d.series.ratio, cssVar('--series-2'))] },
    options: (() => {
      const o = baseOpts({ yFmt: (v) => v.toFixed(0) });
      o.plugins.tooltip.callbacks = { label: (c) => ' ratio ' + c.parsed.y.toFixed(1) };
      return o;
    })(),
  });
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
  if (k.silver) cells.push(`<div class="kpi"><div class="label">Silver (SI=F)</div><div class="value">${fmt.usd(k.silver.value)}</div>${deltaHtml(k.silver.value, k.silver.prev, (x) => fmt.pct(x / k.silver.prev))}</div>`);
  if (k.ratio) cells.push(`<div class="kpi"><div class="label">Gold/silver ratio</div><div class="value">${fmt.num(k.ratio.value, 1)}</div>${deltaHtml(k.ratio.value, k.ratio.prev, (x) => x.toFixed(1))}</div>`);
  cells.push(`<div class="kpi"><div class="label">Dollar index</div><div class="value">${fmt.num(k.dxy.value)}</div>${deltaHtml(k.dxy.value, k.dxy.prev, (x) => fmt.pct(x / k.dxy.prev), true)}</div>`);
  if (k.gvz) cells.push(`<div class="kpi"><div class="label">GVZ (gold VIX)</div><div class="value">${fmt.num(k.gvz.value, 1)}</div>${deltaHtml(k.gvz.value, k.gvz.prev, (x) => x.toFixed(1) + ' pts', true)}</div>`);
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

/* ================= advanced view ================= */

function biasCard(el, m, horizonLabel) {
  const p = m.prediction;
  const bt = m.backtest;
  const neutral = p.direction === 'NEUTRAL';
  const dirCls = neutral ? 'flat' : p.direction === 'BULLISH' ? 'bull' : 'bear';
  const dirWord = neutral ? 'NO EDGE — FLAT' : p.direction;
  let calLine = '';
  if (!neutral && m.bucketStats) {
    const b = m.bucketStats.find((x) => x.name === p.bucket);
    calLine = b && b.n >= 20 ? `backtest ${p.bucket}: ${fmt.pct0(b.hitRate)} hit (n=${b.n})` : 'bucket too thin to calibrate';
  }
  let honesty = '';
  if (bt && bt.hitRate <= bt.baseRateUp + 0.02) {
    honesty = `<div class="cal">⚠ OOS hit ${fmt.pct0(bt.hitRate)} vs ${fmt.pct0(bt.baseRateUp)} base — no proven edge; read as context, not a trade signal.</div>`;
  }
  el.innerHTML = `
    <div class="horizon">${horizonLabel} bias · as of ${m.asOfDate} · ${m.kind === 'ridge' ? 'ridge' : 'random forest'}</div>
    <div class="dir ${dirCls}">${dirWord}</div>
    <div class="exp">expected ${horizonLabel} return: ${fmt.pct(p.expectedReturn)}</div>
    <span class="bucket">${neutral ? `inside dead zone (±${fmt.pct0(p.deadZone)})` : `${p.bucket} conviction`}</span>
    ${calLine ? `<div class="cal">${calLine}</div>` : ''}
    ${honesty}`;
}

function renderDrivers(d) {
  const m = d.models.h5;
  const el = $('drivers-card');
  if (!m.drivers) {
    el.innerHTML = `<h2>What drives the 5d call</h2><p class="note">Random forest is non-linear — per-feature attribution not shown. Switch to Ridge for drivers.</p>`;
    return;
  }
  const items = m.drivers
    .map((dr) => `<li><b>${dr.label}</b> — pushes <span class="pushes">${dr.contribution >= 0 ? 'bullish' : 'bearish'} ${fmt.pct(dr.contribution)}</span></li>`)
    .join('');
  el.innerHTML = `<h2>What drives the 5d call</h2><ul class="drivers">${items}</ul><p class="note">Contribution = standardized weight × today's standardized value, ridge 5d model.</p>`;
}

function renderEquity(d) {
  const bt = d.models.h1.backtest;
  if (!bt || !bt.equity) return;
  charts.equity = new Chart($('ch-equity'), {
    type: 'line',
    data: {
      labels: bt.equity.strategy.map((p) => p.date),
      datasets: [
        line('Model sign strategy (1d)', bt.equity.strategy.map((p) => p.v), cssVar('--series-2')),
        line('Long gold', bt.equity.buyHold.map((p) => p.v), cssVar('--series-3')),
      ],
    },
    options: (() => {
      const o = baseOpts({ yFmt: (v) => '$' + v.toFixed(2) });
      o.plugins.tooltip.callbacks = { label: (c) => ` ${c.dataset.label}: $${c.parsed.y.toFixed(3)}` };
      return o;
    })(),
  });
  htmlLegend($('lg-equity'), [
    { label: 'model sign strategy (1d preds)', color: cssVar('--series-2') },
    { label: 'long gold', color: cssVar('--series-3') },
  ]);
}

function renderCorr(d) {
  const items = d.correlations.filter((c) => c.corr5d != null);
  charts.corr = new Chart($('ch-corr'), {
    type: 'bar',
    data: {
      labels: items.map((c) => c.label),
      datasets: [
        {
          label: 'corr vs next-5d return',
          data: items.map((c) => c.corr5d),
          backgroundColor: items.map((c) => (c.corr5d >= 0 ? cssVar('--pos') : cssVar('--neg'))),
          borderRadius: 3,
          borderSkipped: 'start',
          maxBarThickness: 16,
        },
      ],
    },
    options: (() => {
      const o = baseOpts({});
      o.indexAxis = 'y';
      o.interaction = { mode: 'nearest', intersect: false };
      o.scales.x = {
        grid: { color: (ctx) => (ctx.tick.value === 0 ? cssVar('--baseline') : cssVar('--grid')), drawTicks: false },
        border: { display: false },
        ticks: { color: cssVar('--muted'), maxTicksLimit: 7, callback: (v) => Number(v).toFixed(2) },
      };
      o.scales.y = { grid: { display: false }, border: { color: cssVar('--baseline') }, ticks: { color: cssVar('--text-secondary'), autoSkip: false } };
      o.plugins.tooltip.callbacks = {
        label: (c) => {
          const it = items[c.dataIndex];
          return ` r(5d)=${it.corr5d.toFixed(3)} · r(1d)=${it.corr1d == null ? '—' : it.corr1d.toFixed(3)}`;
        },
      };
      return o;
    })(),
  });
  htmlLegend($('lg-corr'), [
    { label: 'positive — feature ↑ tends to precede price ↑', color: cssVar('--pos'), box: true },
    { label: 'negative — feature ↑ tends to precede price ↓', color: cssVar('--neg'), box: true },
  ]);
}

function renderWeights(d) {
  const m = d.models.h5;
  const note = $('weights-note');
  if (!m.weights) {
    note.hidden = false;
    note.textContent = 'Random forest selected — no linear weights. Switch to Ridge.';
    return;
  }
  note.hidden = true;
  const items = [...m.weights].sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
  charts.weights = new Chart($('ch-weights'), {
    type: 'bar',
    data: {
      labels: items.map((w) => w.label),
      datasets: [
        {
          label: 'standardized weight',
          data: items.map((w) => w.w),
          backgroundColor: items.map((w) => (w.w >= 0 ? cssVar('--pos') : cssVar('--neg'))),
          borderRadius: 3,
          borderSkipped: 'start',
          maxBarThickness: 16,
        },
      ],
    },
    options: (() => {
      const o = baseOpts({});
      o.indexAxis = 'y';
      o.interaction = { mode: 'nearest', intersect: false };
      o.scales.x = {
        grid: { color: (ctx) => (ctx.tick.value === 0 ? cssVar('--baseline') : cssVar('--grid')), drawTicks: false },
        border: { display: false },
        ticks: { color: cssVar('--muted'), maxTicksLimit: 7, callback: (v) => fmt.pct(Number(v), 1) },
      };
      o.scales.y = { grid: { display: false }, border: { color: cssVar('--baseline') }, ticks: { color: cssVar('--text-secondary'), autoSkip: false } };
      o.plugins.tooltip.callbacks = { label: (c) => ` weight ${fmt.pct(items[c.dataIndex].w, 2)} per +1σ` };
      return o;
    })(),
  });
}

function renderScatter(d) {
  const bt = d.models.h5.backtest;
  if (!bt || !bt.scatter) return;
  const zeroGrid = (ctx) => (ctx.tick.value === 0 ? cssVar('--baseline') : cssVar('--grid'));
  charts.scatter = new Chart($('ch-scatter'), {
    type: 'scatter',
    data: {
      datasets: [
        {
          label: 'pred vs realized',
          data: bt.scatter.map((p) => ({ x: p.pred * 100, y: p.actual * 100 })),
          backgroundColor: cssVar('--series-3') + '99',
          pointRadius: 2.5,
          pointHoverRadius: 5,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => ` pred ${c.parsed.x.toFixed(2)}% → realized ${c.parsed.y.toFixed(2)}%` } },
      },
      scales: {
        x: { title: { display: true, text: 'predicted 5d return (%)', color: cssVar('--muted'), font: { size: 11 } }, grid: { color: zeroGrid, drawTicks: false }, border: { display: false }, ticks: { color: cssVar('--muted'), maxTicksLimit: 7 } },
        y: { title: { display: true, text: 'realized 5d return (%)', color: cssVar('--muted'), font: { size: 11 } }, grid: { color: zeroGrid, drawTicks: false }, border: { display: false }, ticks: { color: cssVar('--muted'), maxTicksLimit: 7 } },
      },
    },
  });
}

function renderTable(d) {
  const rows = [
    { name: '15-min', m: d.models.i15, note: 'intraday bars, ridge only' },
    { name: '1-hour', m: d.models.i60, note: 'intraday bars, ridge only' },
    { name: '1-day', m: d.models.h1, note: 'daily, non-overlapping' },
    { name: '1-week', m: d.models.h5, note: 'non-overlapping weeks' },
    { name: '1-month', m: d.models.h21, note: 'non-overlapping months' },
  ];
  const cells = rows
    .filter((r) => r.m && r.m.backtest)
    .map((r) => {
      const bt = r.m.backtest;
      const edge = bt.hitRate - bt.baseRateUp;
      const maeEdge = bt.maeNaive - bt.mae;
      return `<tr>
        <td>${r.name}<div class="note">${r.note}</div></td>
        <td>${bt.oosStart.slice(0, 10)} → ${bt.oosEnd.slice(0, 10)}</td>
        <td>${bt.n}</td>
        <td class="${edge > 0.01 ? 'good' : ''}">${fmt.pct0(bt.hitRate)}</td>
        <td>${fmt.pct0(bt.baseRateUp)}</td>
        <td class="${bt.ic > 0.03 ? 'good' : bt.ic < -0.03 ? 'bad' : ''}">${bt.ic.toFixed(3)}</td>
        <td class="${maeEdge > 0 ? 'good' : 'bad'}">${fmt.pct0(bt.mae)} / ${fmt.pct0(bt.maeNaive)}</td>
        <td class="bad">${fmt.pct0(bt.maxDrawdown)}</td>
      </tr>`;
    })
    .join('');
  $('bt-table').innerHTML = `<table class="bt">
    <thead><tr><th>Horizon</th><th>OOS window</th><th>n</th><th>Hit</th><th>Base up</th><th>IC</th><th>MAE mdl/naive</th><th>Max DD</th></tr></thead>
    <tbody>${cells}</tbody></table>
    <p class="note">IC = corr(prediction, realized). A hit rate inside ±2pts of the base rate = no directional edge — expected here; the honest deliverable is the range, not the arrow.</p>`;
}

function renderMethod(d) {
  const s = d.sampleInfo;
  $('method').innerHTML = `
    <p><b>Sample:</b> ${s.rows} trading days (${s.firstDate} → ${s.lastDate}) + ${s.intradayBars.m15} × 15m bars + ${s.intradayBars.h1} × 1h bars. <b>Daily features:</b> ${s.features.join(' · ')}.</p>
    <ul>
      <li><b>Sources:</b> live spot via Capital.com CFD (<code>GOLD</code>, 5s poll, Yahoo fallback); Yahoo Finance (<code>GC=F</code>, <code>SI=F</code>, <code>DX-Y.NYB</code>, <code>^GVZ</code>, intraday bars); gold news via ${s.parallelEnabled ? 'Parallel Search API + ' : ''}Google News (Bloomberg/Reuters/Kitco source queries), Guardian gold topic, Mining.com — keyword-scored with gold tier lists (Fed/rates, safe haven, central-bank flows)${d.news.llm && d.news.llm.ok ? `, LLM-enriched by <code>${d.news.llm.model}</code> via OpenRouter (gold-analyst prompt; keyword layer is the un-suppressible fallback)` : ''}.</li>
      <li><b>Targets:</b> spot × (1 + model expected return) ± 1σ, σ = trailing realized vol scaled √t (63d daily / 200-bar intraday), widened ×1.2 (ELEVATED) or ×1.5 (EVENT) by the news tape.</li>
      <li><b>Models:</b> same rig as the oil page — ridge (λ picked per window) + random forest, walk-forward, strictly out-of-sample; intraday ridge on bar momentum + vol. Gold features: momentum, realized vol, dollar, GVZ implied vol, gold/silver ratio.</li>
      <li><b>Honesty rules:</b> dead-zone calls show as flat; conviction buckets carry realized OOS hit rates; hit rate always printed beside the base rate. Gold models are new and unproven — same coin-flip warning as oil until shown otherwise.</li>
      <li><b>Limits:</b> front-month splice (GC=F); no costs in the equity curve; nobody's model sees the next Fed surprise — bands are the honest part.</li>
    </ul>`;
}

/* ================= orchestration ================= */

function renderSimple(d) {
  renderDataChip(d);
  renderHero(d);
  renderTargets(d);
  renderNews(d);
  renderIntraday(d);
  renderPrice(d);
  renderRatio(d);
  renderKpis(d);
}

function renderAdvanced(d) {
  $('health').innerHTML = d.health
    .map((h) => {
      const cls = !h.ok ? 'bad' : h.stale ? 'stale' : 'ok';
      const txt = !h.ok ? 'failed' : h.stale ? `stale · ${h.lastDate}` : h.lastDate;
      return `<span class="chip ${cls}" title="${h.ok ? '' : h.error}"><span class="dot"></span><b>${h.label}</b> ${txt}</span>`;
    })
    .join('');
  biasCard($('bias-1d'), d.models.h1, '1d');
  biasCard($('bias-5d'), d.models.h5, '5d');
  renderDrivers(d);
  renderEquity(d);
  renderCorr(d);
  renderWeights(d);
  renderScatter(d);
  renderTable(d);
  renderMethod(d);
}

function renderAll(d) {
  destroyCharts();
  advRendered = false;
  renderSimple(d);
  if ($('advanced').open) {
    renderAdvanced(d);
    advRendered = true;
  }
}

$('advanced').addEventListener('toggle', () => {
  if ($('advanced').open && !advRendered && lastData) {
    renderAdvanced(lastData);
    advRendered = true;
  }
});

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

async function load(model) {
  currentModel = model;
  document.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.model === model));
  setStatus(model === 'forest' ? 'Training random forest out-of-sample — first run can take a minute or two…' : 'Loading gold data & training models…');
  try {
    const res = await fetch('/api/gold/dashboard?model=' + model);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || res.statusText);
    lastData = json;
    renderAll(json);
    setStatus(null);
  } catch (e) {
    setStatus('Failed: ' + e.message + ' — is a feed down? Retry or check server logs.', true);
  }
}

document.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => load(b.dataset.model)));

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

/* --- live price poll (capital.com GOLD CFD) --- */
let liveSpot = null;
async function pollPrice() {
  try {
    const p = await (await fetch('/api/price?instrument=gold')).json();
    if (!p || p.error || !lastData) return;
    liveSpot = p.mid;
    const live = p.source === 'capital-cfd';
    const badge = $('live-badge');
    if (badge) {
      badge.className = 'live-badge' + (live ? ' live' : '');
      badge.innerHTML = `<span class="dot"></span>${live ? `LIVE CFD${p.marketStatus && p.marketStatus !== 'TRADEABLE' ? ' · ' + p.marketStatus.toLowerCase() : ''}` : 'delayed'}`;
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
  } catch {
    /* next tick */
  }
}
setInterval(pollPrice, 5000);

load('ridge').then(pollPrice);
