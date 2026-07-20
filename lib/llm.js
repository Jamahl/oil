'use strict';
// LLM news scoring via OpenRouter (PRD F3.5 pattern, scaled down): one batched
// call per news refresh, model slug is runtime-configurable. The keyword layer
// always runs first and is never overridden — the LLM only ADDS direction,
// materiality and a one-line market read; on any failure the bundle ships
// keyword-only, visibly flagged.
const { readCache, writeCache, fetchWithRetry } = require('./fetchers');

const LLM_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MODEL = 'poolside/laguna-xs-2.1:free';

const PROMPT_VERSION = 'v2';

const SYSTEM = `You are a senior crude-oil market analyst writing for a discretionary Brent trader. You will get a numbered list of recent headlines with source and age. Judge each headline's likely effect on the CRUDE OIL PRICE over the next days — not whether the news is good or bad for the world.

Reply ONLY minified JSON, no prose, no code fences:
{"items":[{"i":<index>,"direction":"bull"|"bear"|"unclear","materiality":1|2|3,"novelty":"new"|"update"|"rehash"}],"overall":{"lean":"bullish"|"bearish"|"mixed"|"quiet","summary":"<=140 chars"}}

DIRECTION — think supply/demand for crude itself:
- bull: supply loss or credible threat to it (war escalation, chokepoint/tanker disruption, sanctions on an exporter, OPEC+ cut, outage/force majeure, big inventory DRAW, strong demand data).
- bear: supply added or threat receding (ceasefire/de-escalation, OPEC+ hike, SPR release, sanctions relief, big inventory BUILD, demand destruction — recession signs, weak China, hawkish Fed/strong dollar).
- Traps to get right: a ceasefire headline during a war-premium rally is sharply BEAR. A refinery outage cuts crude demand — BEAR for crude even though products rise. Retail gasoline-price stories are derivative noise. Analyst forecasts/opinion pieces take the direction of their argument but are never materiality 3. If genuinely ambiguous, say "unclear" — do not guess.

MATERIALITY — would this move Brent today?
- 3: could move Brent >1% (chokepoint closed/attacked, OPEC+ surprise, war escalation/entry of new party, major force majeure, sanctions on a top-10 exporter, SPR action).
- 2: notable but regional/incremental (single outage, inventory surprise, credible threats, big demand datapoint).
- 1: background — opinion, explainer, retail prices, equities angle, small updates.

NOVELTY — critical for a trader; use the ages given:
- new: first report of a fresh event.
- update: meaningful new development in a known story.
- rehash: re-reporting or commentary on something days old that the market has already priced. Ongoing-war color pieces are rehash unless they add a new escalation.

OVERALL — lean = net NEAR-TERM price pressure from THIS set of headlines, weighted by materiality and novelty (rehash counts little). "quiet" if nothing material. summary: name the single dominant driver and the main offset, plain language, <=140 chars.`;

const SYSTEM_GOLD = `You are a senior precious-metals analyst writing for a discretionary gold trader. You will get a numbered list of recent headlines with source and age. Judge each headline's likely effect on the GOLD PRICE over the next days — not whether the news is good or bad for the world.

Reply ONLY minified JSON, no prose, no code fences:
{"items":[{"i":<index>,"direction":"bull"|"bear"|"unclear","materiality":1|2|3,"novelty":"new"|"update"|"rehash"}],"overall":{"lean":"bullish"|"bearish"|"mixed"|"quiet","summary":"<=140 chars"}}

DIRECTION — think real yields, the dollar, and safe-haven demand:
- bull: dovish Fed surprise (cuts, pause, QE), soft inflation/jobs data lowering real yields, dollar weakness, war escalation or fresh geopolitical shock, sanctions/reserve-freeze fears, central-bank gold buying, bank stress or credit events, big ETF inflows.
- bear: hawkish Fed surprise (hikes, higher-for-longer), hot CPI/strong payrolls raising real yields, dollar strength, ceasefire/de-escalation during a safe-haven rally, risk-on melt-ups pulling flows to equities/crypto, central-bank selling, big ETF outflows.
- Traps to get right: STRONG economic data is usually BEAR for gold (higher yields) even though it is "good news". A ceasefire during a fear rally is sharply BEAR. Inflation is bull only if the Fed is NOT expected to answer it with hikes. Mining-supply and jewellery stories rarely move spot. Analyst price targets take the direction of their argument but are never materiality 3. If genuinely ambiguous, say "unclear" — do not guess.

MATERIALITY — would this move gold >1% today?
- 3: FOMC surprise, big CPI/payrolls miss or beat, major war escalation or new party entering, reserve-freeze/confiscation news, systemic bank stress.
- 2: notable but incremental (Fed-speak shifting odds, sizable central-bank purchase, meaningful dollar/yield move, credible geopolitical threat).
- 1: background — opinion, explainers, price-target notes, jewellery/mining colour, small updates.

NOVELTY — critical for a trader; use the ages given:
- new: first report of a fresh event.
- update: meaningful new development in a known story.
- rehash: re-reporting or commentary on something days old that the market has already priced. "Gold hits record" colour pieces are rehash unless they carry a new driver.

OVERALL — lean = net NEAR-TERM price pressure from THIS set of headlines, weighted by materiality and novelty (rehash counts little). "quiet" if nothing material. summary: name the single dominant driver and the main offset, plain language, <=140 chars.`;

const PROMPTS = {
  oil: { system: SYSTEM, userLabel: 'crude-oil' },
  gold: { system: SYSTEM_GOLD, userLabel: 'gold' },
};

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
// asset: 'oil' (default) or 'gold' — picks the analyst prompt and cache lane.
async function scoreNews(items, model, apiKey, asset = 'oil') {
  if (!apiKey) return { ok: false, reason: 'no OPENROUTER_API_KEY' };
  if (!items.length) return { ok: false, reason: 'no headlines' };
  const prompt = PROMPTS[asset] || PROMPTS.oil;
  const slug = (model || DEFAULT_MODEL).trim();
  const cacheKey = `news_llm_${asset}_${PROMPT_VERSION}_${slug.replace(/[^a-z0-9.-]+/gi, '_')}_${djb2(items.map((i) => i.title).join('|'))}`;
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
          { role: 'system', content: prompt.system },
          { role: 'user', content: `Score these ${prompt.userLabel} headlines:\n${list}` },
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

module.exports = { scoreNews, DEFAULT_MODEL };
