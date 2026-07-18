'use strict';
// News layer, parameterized per instrument by a `newsPack` from
// lib/instruments.js (feeds, keyword tiers, topic regex, cache keys, LLM
// persona). Lanes: Parallel Search API (if PARALLEL_API_KEY, cached 30 min)
// + free RSS. Items are deduped and keyword-scored (PRD tier lists) — that
// deterministic layer always runs and is the fallback. An optional OpenRouter
// LLM pass (configurable model) adds per-headline direction, materiality and a
// one-line market read; materiality feeds the tape score but the keyword score
// is never suppressed (PRD safety rule). Every disk-cache key comes from the
// pack, so instruments never share a cache entry.
const { readCache, writeCache, fetchWithRetry } = require('./fetchers');
const { scoreNews, DEFAULT_MODEL } = require('./llm');
const { INSTRUMENTS } = require('./instruments');

const NEWS_TTL_MS = 5 * 60 * 1000; // RSS lanes are free — refresh the tape every 5 min
const PARALLEL_TTL_MS = 30 * 60 * 1000; // paid lane keeps its own slower cadence (~$0.24/day)

const DEFAULT_PACK = INSTRUMENTS.brent.newsPack;

// Tier entries may be plain substrings or RegExps (word-boundary-sensitive
// keywords like btc's 'sec' use a RegExp so "security" doesn't match).
function tierHit(t, k) {
  return k instanceof RegExp ? k.test(t) : t.includes(k);
}
function tierTag(k) {
  return k instanceof RegExp ? k.source.replace(/\\b/g, '') : k;
}

function scoreText(text, pack = DEFAULT_PACK) {
  const t = (text || '').toLowerCase();
  const tags = [];
  let pts = 0;
  for (const k of pack.tier1) {
    if (tierHit(t, k)) {
      pts += 3;
      tags.push(tierTag(k));
    }
  }
  for (const k of pack.tier2) {
    if (tierHit(t, k)) {
      pts += 1;
      tags.push(tierTag(k));
    }
  }
  return { pts: Math.min(pts, 9), tags: tags.slice(0, 4) };
}

function stripCdata(s) {
  return s
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

// Tolerant RSS <item> parser — good enough for Google News / OilPrice feeds.
function parseRss(xml, sourceLabel) {
  const items = [];
  const chunks = xml.split(/<item[\s>]/).slice(1);
  for (const chunk of chunks.slice(0, 40)) {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/.exec(chunk);
    const link = /<link[^>]*>([\s\S]*?)<\/link>/.exec(chunk);
    const pub = /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/.exec(chunk);
    if (!title) continue;
    let t = stripCdata(title[1]);
    let source = sourceLabel;
    const m = /^(.*)\s+-\s+([^-]{2,40})$/.exec(t);
    if (sourceLabel === 'Google News' && m) {
      t = m[1];
      source = m[2].trim();
    }
    const ts = pub ? Date.parse(stripCdata(pub[1])) : NaN;
    items.push({
      title: t,
      url: link ? stripCdata(link[1]) : null,
      source,
      publishedAt: isFinite(ts) ? new Date(ts).toISOString() : null,
    });
  }
  return items;
}

// Feed lists live in lib/instruments.js (pack.feeds). `topicFilter` feeds are
// general-news firehoses kept only where the title matches the pack's topic.
async function fetchRss(feed, pack) {
  const res = await fetchWithRetry(feed.url, {}, 2);
  let items = parseRss(await res.text(), feed.label);
  if (feed.topicFilter) items = items.filter((it) => pack.topicRe.test(it.title));
  return items;
}

async function fetchParallel(apiKey, pack) {
  const cached = readCache(pack.parallelCacheKey, PARALLEL_TTL_MS);
  if (cached) return cached;
  const res = await fetchWithRetry(
    'https://api.parallel.ai/v1beta/search',
    {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        objective: pack.parallelObjective,
        search_queries: pack.parallelQueries,
        processor: 'base',
        max_results: 10,
        max_chars_per_result: 800,
      }),
    },
    2
  );
  const json = await res.json();
  const items = (json.results || []).map((r) => ({
    title: r.title || r.url,
    url: r.url,
    source: 'Parallel',
    publishedAt: r.publish_date || null,
    excerpt: (r.excerpts || []).join(' ').slice(0, 800),
  }));
  writeCache(pack.parallelCacheKey, items);
  return items;
}

function dedupe(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = (it.title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

function ageHours(it, now) {
  return it.publishedAt ? Math.max(0, (now - Date.parse(it.publishedAt)) / 3600000) : 24;
}

// Raw lanes + keyword layer, disk-cached (no LLM here so a model switch re-scores
// instantly from cache).
async function fetchRawNews(pack) {
  const cached = readCache(pack.cacheKey, NEWS_TTL_MS);
  if (cached) return cached;

  const apiKey = process.env.PARALLEL_API_KEY || '';
  const jobs = pack.feeds.map((f) => fetchRss(f, pack));
  if (apiKey) jobs.push(fetchParallel(apiKey, pack));

  const settled = await Promise.allSettled(jobs);
  const lanes = {
    rss: settled.slice(0, pack.feeds.length).some((s) => s.status === 'fulfilled'),
    parallel: apiKey ? settled[settled.length - 1].status === 'fulfilled' : false,
  };
  const merged = dedupe(settled.filter((s) => s.status === 'fulfilled').flatMap((s) => s.value));

  const now = Date.now();
  const scored = merged.map((it) => {
    const { pts, tags } = scoreText(it.title + ' ' + (it.excerpt || ''), pack);
    return { title: it.title, url: it.url, source: it.source, publishedAt: it.publishedAt, score: pts, tags };
  });

  // Freshness-first: last 48h only (fall back to 7d if the tape is dead), ranked
  // by keyword weight decayed with age, capped per source so no outlet floods.
  let pool = scored.filter((it) => ageHours(it, now) <= 48);
  if (pool.length < 6) pool = scored.filter((it) => ageHours(it, now) <= 7 * 24);
  // SELECT the best 16 by decayed keyword weight (with per-source caps)…
  pool.sort((a, b) => rank(b, now) - rank(a, now));
  const perSource = {};
  const items = [];
  for (const it of pool) {
    const src = it.source || '?';
    if ((perSource[src] || 0) >= 3) continue;
    perSource[src] = (perSource[src] || 0) + 1;
    items.push(it);
    if (items.length >= 18) break;
  }
  // …then PRESENT newest-first (undated items sink to the bottom).
  items.sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0));

  let points = 0;
  for (const it of items) points += it.score * Math.exp(-ageHours(it, now) / 12);

  const raw = {
    fetchedAt: new Date(now).toISOString(),
    items,
    keywordPoints: Math.round(points * 10) / 10,
    lanes,
  };
  writeCache(pack.cacheKey, raw);
  return raw;
}

function rank(it, now) {
  return (1 + it.score) * Math.exp(-ageHours(it, now) / 18);
}

function levelFor(points) {
  return points >= 9 ? 'EVENT' : points >= 4 ? 'ELEVATED' : 'QUIET';
}

// Full bundle: raw lanes + optional LLM enrichment for the given model slug.
// `pack` defaults to brent's so pre-existing callers behave identically.
async function fetchNews(model, pack = DEFAULT_PACK) {
  const raw = await fetchRawNews(pack);
  const now = Date.now();

  let llm = { ok: false, reason: 'disabled' };
  try {
    llm = await scoreNews(raw.items, model || DEFAULT_MODEL, process.env.OPENROUTER_API_KEY || '', pack);
  } catch (e) {
    llm = { ok: false, reason: String(e.message || e) };
  }

  let bonus = 0;
  const items = raw.items.map((it, i) => {
    const ai = llm.ok ? llm.byIndex[i] : null;
    if (ai) {
      const matPts = ai.materiality === 3 ? 3 : ai.materiality === 2 ? 1 : 0;
      const noveltyFactor = ai.novelty === 'rehash' ? 0.3 : 1; // priced-in stories barely move the tape
      bonus += matPts * noveltyFactor * Math.exp(-ageHours(it, now) / 12);
    }
    return ai ? { ...it, ai } : it;
  });
  const points = Math.round((raw.keywordPoints + bonus) * 10) / 10;

  return {
    fetchedAt: raw.fetchedAt,
    items,
    activity: { level: levelFor(points), points, keywordPoints: raw.keywordPoints },
    lanes: raw.lanes,
    llm: llm.ok
      ? { ok: true, model: llm.model, lean: llm.overall.lean, summary: llm.overall.summary }
      : { ok: false, reason: llm.reason },
  };
}

// Band multiplier: news-driven tape is wider than the trailing-vol estimate.
function newsBandFactor(level) {
  return level === 'EVENT' ? 1.5 : level === 'ELEVATED' ? 1.2 : 1.0;
}

module.exports = { fetchNews, newsBandFactor };
