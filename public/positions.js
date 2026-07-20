'use strict';
/* Positions overview (scalping bot account, read-only) — shared by the oil and
   gold pages. Expects $, escapeHtml, relAge from the page script loaded before
   this file. Default filter comes from <body data-pos-filter="...">. */

let posData = null;
let posFilter = document.body.dataset.posFilter || 'all';
let posFilterTouched = false;

const TAG_RULES = [
  [/OIL|BRENT|CRUDE/i, 'oil'],
  [/NATURAL ?GAS|NATGAS/i, 'gas'],
  [/BTC|BITCOIN/i, 'btc'],
  [/\bETH|ETHEREUM/i, 'eth'],
  [/GOLD|XAU/i, 'gold'],
  [/SILVER|XAG/i, 'silver'],
];
const TYPE_TAGS = { CRYPTOCURRENCIES: 'crypto', CURRENCIES: 'fx', INDICES: 'index', SHARES: 'stock', COMMODITIES: 'cmdty' };
function posTag(p) {
  for (const [re, tag] of TAG_RULES) if (re.test(p.epic || '') || re.test(p.name || '')) return tag;
  return TYPE_TAGS[p.instrumentType] || 'other';
}

const CCY = { USD: '$', EUR: '€', GBP: '£', AUD: 'A$' };
function fmtPl(v, ccy) {
  if (v == null) return '—';
  const sym = CCY[ccy] || (ccy ? ccy + ' ' : '');
  return (v >= 0 ? '+' : '−') + sym + Math.abs(v).toFixed(2);
}

function renderPositions() {
  const card = $('positions-card');
  if (!card) return;
  if (!posData || posData.configured === false) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $('pos-env').textContent = posData.env === 'live' ? ' · LIVE' : ' · demo';

  const tagged = posData.positions.map((p) => ({ ...p, tag: posTag(p) }));
  const tags = [...new Set(tagged.map((p) => p.tag))].sort();
  // A page-default filter (e.g. gold page) falls back to 'all' until such a
  // position exists; a user click sticks even when its tag empties out later.
  if (posFilter !== 'all' && !tags.includes(posFilter)) {
    if (!posFilterTouched) posFilter = 'all';
    else if (!tagged.length) posFilter = 'all';
  }
  const effFilter = tags.includes(posFilter) ? posFilter : 'all';

  $('pos-filters').innerHTML = ['all', ...tags]
    .map((t) => {
      const n = t === 'all' ? tagged.length : tagged.filter((p) => p.tag === t).length;
      return `<button class="chip filter ${effFilter === t ? 'active' : ''}" data-tag="${t}">${t} (${n})</button>`;
    })
    .join('');

  const shown = (effFilter === 'all' ? tagged : tagged.filter((p) => p.tag === effFilter))
    .slice()
    .sort((a, b) => (Date.parse(b.openedAt) || 0) - (Date.parse(a.openedAt) || 0));

  const totCls = posData.totalPl > 0 ? 'up' : posData.totalPl < 0 ? 'down' : '';
  const cells = [
    `<div class="pos-total"><div class="label">Total P&amp;L</div><div class="value ${totCls}">${fmtPl(posData.totalPl, posData.currency)}</div></div>`,
  ];
  if (effFilter !== 'all') {
    const fPl = shown.reduce((s, p) => s + (p.pl || 0), 0);
    const fCls = fPl > 0 ? 'up' : fPl < 0 ? 'down' : '';
    cells.push(`<div class="pos-total"><div class="label">${escapeHtml(effFilter)} P&amp;L</div><div class="value ${fCls}">${fmtPl(fPl, posData.currency)}</div></div>`);
  }
  cells.push(`<div class="pos-total"><div class="label">Open</div><div class="value">${posData.count}</div></div>`);
  $('pos-summary').innerHTML = cells.join('');

  if (!shown.length) {
    $('pos-list').innerHTML = `<p class="note">No open positions${effFilter !== 'all' ? ' for this filter' : ''}.</p>`;
    return;
  }
  $('pos-list').innerHTML = shown
    .map((p) => {
      const plCls = p.pl > 0 ? 'up' : p.pl < 0 ? 'down' : '';
      const opened = p.openedAt ? relAge(p.openedAt) : '';
      return `<div class="pos-row">
        <div class="pos-inst"><b>${escapeHtml(p.name)}</b>
          <div class="pos-meta">${escapeHtml(p.epic || '')} · ${p.size ?? '?'} @ ${p.openLevel != null ? p.openLevel.toFixed(2) : '—'}${opened ? ' · ' + opened : ''}</div>
        </div>
        <div class="pos-pills">
          <span class="pill ${p.direction === 'SHORT' ? 'short' : 'long'}">${p.direction}</span>
          <span class="pill tag-${p.tag}">${p.tag}</span>
        </div>
        <div class="pos-now">${p.current != null ? p.current.toFixed(2) : '—'}</div>
        <div class="pos-pl ${plCls}">${fmtPl(p.pl, p.currency)}</div>
      </div>`;
    })
    .join('');
}

if ($('pos-filters')) {
  $('pos-filters').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tag]');
    if (!btn) return;
    posFilter = btn.dataset.tag;
    posFilterTouched = true;
    renderPositions();
  });
}

async function pollPositions() {
  try {
    const p = await (await fetch('/api/positions')).json();
    if (!p || p.error) return;
    posData = p;
    renderPositions();
  } catch {
    /* next tick */
  }
}
setInterval(pollPositions, 5000);
pollPositions();
