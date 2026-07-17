'use strict';
/* CrudeSignal Lab frontend — simple view first (price, targets, news, fundamentals),
   full model lab behind the Advanced fold. Chart tokens follow the dataviz method. */

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
      const hit = t.bucketHit ? ` <span title="how often this conviction bucket was right out-of-sample">(${fmt.pct0(t.bucketHit.hitRate)} hist.)</span>` : '';
      return `<div class="target">
        <div class="when">in ${t.label}</div>
        <div class="tgt">${fmt.usd(t.target)}</div>
        <div class="range">${fmt.usd(t.low)} – ${fmt.usd(t.high)}</div>
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
        line('Long Brent', bt.equity.buyHold.map((p) => p.v), cssVar('--series-1')),
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
    { label: 'long Brent', color: cssVar('--series-1') },
  ]);
}

function renderSpread(d) {
  charts.spread = new Chart($('ch-spread'), {
    type: 'line',
    data: { labels: d.series.dates, datasets: [line('WTI−Brent', d.series.spread, cssVar('--series-2'))] },
    options: (() => {
      const o = baseOpts({ yFmt: (v) => '$' + v.toFixed(1) });
      o.scales.y.grid.color = (ctx) => (ctx.tick.value === 0 ? cssVar('--baseline') : cssVar('--grid'));
      o.plugins.tooltip.callbacks = { label: (c) => ' spread ' + fmt.usd(c.parsed.y) };
      return o;
    })(),
  });
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
          backgroundColor: cssVar('--series-1') + '99',
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
      <li><b>Sources:</b> live spot via Capital.com CFD (<code>OIL_BRENT</code>, 5s poll, Yahoo fallback); Yahoo Finance (<code>BZ=F</code>, <code>CL=F</code>, <code>DX-Y.NYB</code>, <code>^OVX</code>, intraday bars); EIA weekly crude stocks (<code>WCESTUS1</code>); news via ${s.parallelEnabled ? 'Parallel Search API + ' : ''}Google News & OilPrice RSS, keyword-scored (CrudeSignal tier lists)${d.news.llm && d.news.llm.ok ? `, LLM-enriched by <code>${d.news.llm.model}</code> via OpenRouter (direction + materiality per headline; keyword layer is the un-suppressible fallback)` : ''}.</li>
      <li><b>Targets:</b> spot × (1 + model expected return) ± 1σ, σ = trailing realized vol scaled √t (63d daily / 200-bar intraday), widened ×1.2 (ELEVATED) or ×1.5 (EVENT) by the news tape.</li>
      <li><b>No lookahead:</b> EIA joins on release date (Fri week-end + 5d); training labels only used once their window has elapsed (index-based, works at any bar frequency).</li>
      <li><b>Models:</b> ridge (λ picked on each training window's tail) + random forest (24 trees, depth 5, rolling ~5y, daily only). Intraday models: ridge on bar momentum + vol. Walk-forward, strictly out-of-sample; 5d/21d scored on non-overlapping windows.</li>
      <li><b>Honesty rules:</b> dead-zone calls show as flat; conviction buckets carry realized OOS hit rates; no bare probabilities; hit rate always printed beside the base rate.</li>
      <li><b>Limits:</b> front-month splice; no costs; news scoring is keyword-based (no LLM yet); nobody's model sees the next drone strike — bands are the honest part.</li>
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
  renderInventory(d);
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
  renderSpread(d);
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

/* --- prediction journal --- */
const HZ_LABELS = { m15: '15 min', h1: '1 hour', d1: '1 day', w1: '1 week', mo1: '1 month' };

async function loadJournal() {
  try {
    const j = await (await fetch('/api/journal')).json();
    if (j.error) throw new Error(j.error);
    const rows = Object.entries(j.stats.horizons)
      .map(([hz, s]) => {
        const cal = j.calibration[hz] || { k: 1, bias: 0, active: false, n: 0 };
        const calTxt = cal.active
          ? `k=${cal.k.toFixed(2)} bias=${fmt.pct(cal.bias, 3)} <span class="good">active</span>`
          : `k=${(cal.k || 1).toFixed(2)} <span class="news-tags">shadow (n=${cal.n})</span>`;
        const cover = s.bandCoverage == null ? '—' : fmt.pct0(s.bandCoverage);
        const coverCls = s.bandCoverage == null ? '' : Math.abs(s.bandCoverage - 0.68) <= 0.07 ? 'good' : 'bad';
        return `<tr>
          <td>${HZ_LABELS[hz] || hz}</td>
          <td>${s.resolved}<div class="note">${s.open} open</div></td>
          <td>${s.dirHitRate == null ? '—' : fmt.pct0(s.dirHitRate)} <span class="note">vs ${s.baseUp == null ? '—' : fmt.pct0(Math.max(s.baseUp, 1 - s.baseUp))}</span></td>
          <td class="${coverCls}">${cover} <span class="note">→68%</span></td>
          <td>${s.meanErr == null ? '—' : fmt.pct(s.meanErr, 3)}</td>
          <td>${calTxt}</td>
          <td>${s.leanVerdict}</td>
        </tr>`;
      })
      .join('');
    $('journal-body').innerHTML = `<table class="bt">
      <thead><tr><th>Horizon</th><th>Resolved</th><th>Direction hit</th><th>Band coverage</th><th>Bias</th><th>Calibration</th><th>Lean verdict</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
    const sig = j.signals || {};
    const sigTxt = sig.n
      ? ` · signals: ${sig.n} logged (${sig.buys} buy / ${sig.holds} hold / ${sig.sells} sell)${sig.n1h ? `, 1h hit ${fmt.pct0(sig.hit1h)} (n=${sig.n1h})` : ''}${sig.n1d ? `, 1d hit ${fmt.pct0(sig.hit1d)} (n=${sig.n1d})` : ''}`
      : '';
    $('journal-meta').textContent = `${j.stats.totals.resolved} resolved · ${j.stats.totals.open} open · ${j.stats.totals.unresolvable} unresolvable · storage: ${j.storage === 'neon' ? 'Neon Postgres' : 'local SQLite'} · logs every 5 min${sigTxt}`;
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
  document.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.model === model));
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
  } catch {
    /* next tick */
  }
}
setInterval(pollPrice, 5000);

initConfig();
load('ridge').then(pollPrice);
