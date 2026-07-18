'use strict';
// LLM news scoring via OpenRouter (PRD F3.5 pattern, scaled down): one batched
// call per news refresh, model slug is runtime-configurable. The keyword layer
// always runs first and is never overridden — the LLM only ADDS direction,
// materiality and a one-line market read; on any failure the bundle ships
// keyword-only, visibly flagged.
//
// The analyst persona, prompt version and cache prefix come from the
// instrument's newsPack (lib/instruments.js) so each instrument has its own
// prompt AND its own disk-cache namespace; brent's are byte-identical to the
// originals, keeping existing cache entries valid.
const { readCache, writeCache, fetchWithRetry } = require('./fetchers');
const { INSTRUMENTS } = require('./instruments');

const LLM_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MODEL = 'poolside/laguna-xs-2.1:free';

const DEFAULT_PACK = INSTRUMENTS.brent.newsPack;

function djb2(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

function extractJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/g, '');
  const a = cleaned.indexOf('{');
  const b = cleaned.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(cleaned.slice(a, b + 1));
  } catch {
    return null;
  }
}

// -> { ok, model, byIndex: {0:{direction,materiality},...}, overall:{lean,summary} }
// pack: instrument newsPack — systemPrompt/promptVersion/llmCachePrefix/scoreLabel.
async function scoreNews(items, model, apiKey, pack = DEFAULT_PACK) {
  if (!apiKey) return { ok: false, reason: 'no OPENROUTER_API_KEY' };
  if (!items.length) return { ok: false, reason: 'no headlines' };
  const slug = (model || DEFAULT_MODEL).trim();
  const cacheKey = `${pack.llmCachePrefix}_${pack.promptVersion}_${slug.replace(/[^a-z0-9.-]+/gi, '_')}_${djb2(items.map((i) => i.title).join('|'))}`;
  const hit = readCache(cacheKey, LLM_TTL_MS);
  if (hit) return hit;

  const now = Date.now();
  const list = items
    .map((it, i) => {
      const h = it.publishedAt ? Math.max(0, (now - Date.parse(it.publishedAt)) / 3600000) : null;
      const age = h == null ? 'age unknown' : h < 1 ? `${Math.round(h * 60)}m ago` : h < 24 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`;
      return `${i}. [${it.source || 'unknown'} · ${age}] ${it.title}`;
    })
    .join('\n');
  const res = await fetchWithRetry(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: slug,
        temperature: 0,
        max_tokens: 2500,
        reasoning: { enabled: false }, // laguna & other reasoners: spend tokens on the answer, not the monologue
        messages: [
          { role: 'system', content: pack.systemPrompt },
          { role: 'user', content: `Score these ${pack.scoreLabel}:\n${list}` },
        ],
      }),
    },
    2
  ).catch((e) => ({ __err: e }));
  if (res.__err) return { ok: false, reason: String(res.__err.message || res.__err) };

  const json = await res.json().catch(() => null);
  if (json && json.error) return { ok: false, reason: json.error.message || 'OpenRouter error' };
  const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  const parsed = extractJson(content);
  if (!parsed || !Array.isArray(parsed.items)) return { ok: false, reason: 'unparseable model output' };

  const byIndex = {};
  for (const it of parsed.items) {
    const i = Number(it.i);
    if (!Number.isInteger(i) || i < 0 || i >= items.length) continue;
    const direction = ['bull', 'bear', 'unclear'].includes(it.direction) ? it.direction : 'unclear';
    const materiality = [1, 2, 3].includes(it.materiality) ? it.materiality : 1;
    const novelty = ['new', 'update', 'rehash'].includes(it.novelty) ? it.novelty : 'new';
    byIndex[i] = { direction, materiality, novelty };
  }
  const o = parsed.overall || {};
  const out = {
    ok: true,
    model: slug,
    byIndex,
    overall: {
      lean: ['bullish', 'bearish', 'mixed', 'quiet'].includes(o.lean) ? o.lean : 'mixed',
      summary: String(o.summary || '').slice(0, 180),
    },
  };
  writeCache(cacheKey, out);
  return out;
}

// Plain-text chat helper (journal insight etc). -> { ok, text } | { ok:false, reason }
async function chatText(prompt, model, apiKey, maxTokens = 1200) {
  if (!apiKey) return { ok: false, reason: 'no OPENROUTER_API_KEY' };
  const res = await fetchWithRetry(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: (model || DEFAULT_MODEL).trim(),
        temperature: 0.2,
        max_tokens: maxTokens,
        reasoning: { enabled: false },
        messages: [{ role: 'user', content: prompt }],
      }),
    },
    2
  ).catch((e) => ({ __err: e }));
  if (res.__err) return { ok: false, reason: String(res.__err.message || res.__err) };
  const json = await res.json().catch(() => null);
  if (json && json.error) return { ok: false, reason: json.error.message || 'OpenRouter error' };
  const text = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!text) return { ok: false, reason: 'empty model output' };
  return { ok: true, text };
}

module.exports = { scoreNews, chatText, DEFAULT_MODEL };
