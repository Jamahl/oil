'use strict';
// Instrument registry — THE single place instrument-specific literals live.
// Everything else (server, news, llm, bot, capital callers) is parameterized by
// an entry from this table. Adding an instrument = adding an entry here plus a
// nav button; no instrument literals belong anywhere else.
//
// Segregation rules:
// - Cache keys, state files, LLM prompt versions and DB rows are all namespaced
//   per instrument. brent keeps its ORIGINAL keys/files/prompts byte-for-byte so
//   existing caches, bot state and journal history remain valid.
// - `liveLocked: true` is a HARD demo-only lock enforced in lib/bot.js
//   regardless of config or env — btc can never touch a live account.

// ---- brent news pack (moved verbatim from lib/news.js / lib/llm.js) ----

const OIL_TIER1 = [
  'opec+', 'opec', 'emergency meeting', 'attack', 'strait of hormuz', 'hormuz',
  'sanction', 'force majeure', 'hurricane', 'spr release', 'blockade', 'drone',
  'strike on', 'missile', 'war escalat', 'escalation', 'invasion',
];
const OIL_TIER2 = [
  'production cut', 'output cut', 'production increase', 'quota', 'pipeline',
  'refinery', 'ceasefire', 'inventory', 'inventories', 'stockpile', 'embargo',
  'tanker', 'supply disruption', 'outage', 'iran', 'russia', 'venezuela', 'draw', 'build',
  // supply-side tells the smart money watches: Saudi output signals, OSPs, surveys
  'saudi', 'aramco', 'official selling price', 'osp', 'opec survey', 'output rose',
  'output fell', 'production rose', 'floating storage', 'rig count',
];

const OIL_TOPIC = /(oil|crude|opec|brent|energy|gasoline|petrol|hormuz|tanker|refiner|barrel|lng|natural gas)/i;

const OIL_FEEDS = [
  { url: 'https://news.google.com/rss/search?q=crude+oil+OR+OPEC+OR+brent+when:2d&hl=en-US&gl=US&ceid=US:en', label: 'Google News' },
  { url: 'https://news.google.com/rss/search?q=(crude+oil+OR+OPEC+OR+brent)+source:bloomberg+when:2d&hl=en-US&gl=US&ceid=US:en', label: 'Bloomberg' },
  { url: 'https://news.google.com/rss/search?q=(crude+oil+OR+OPEC+OR+brent)+source:reuters+when:2d&hl=en-US&gl=US&ceid=US:en', label: 'Reuters' },
  { url: 'https://www.theguardian.com/business/oil/rss', label: 'The Guardian' },
  { url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=19836768', label: 'CNBC' },
  { url: 'https://www.aljazeera.com/xml/rss/all.xml', label: 'Al Jazeera', topicFilter: true },
  { url: 'https://oilprice.com/rss/main', label: 'OilPrice' },
  { url: 'https://www.rigzone.com/news/rss/rigzone_latest.aspx', label: 'Rigzone' },
  { url: 'https://www.rigzone.com/news/rss/rigzone_original.aspx', label: 'Rigzone' },
  { url: 'https://www.worldoil.com/rss?feed=news', label: 'World Oil' },
  { url: 'https://gcaptain.com/feed/', label: 'gCaptain', topicFilter: true }, // shipping/tanker lane — chokepoint coverage
  { url: 'https://www.eia.gov/rss/todayinenergy.xml', label: 'EIA' },
  { url: 'https://www.investing.com/rss/news_11.rss', label: 'Investing.com', topicFilter: true }, // commodities feed carries gold/silver noise
];

const OIL_SYSTEM = `You are a senior crude-oil market analyst writing for a discretionary Brent trader. You will get a numbered list of recent headlines with source and age. Judge each headline's likely effect on the CRUDE OIL PRICE over the next days — not whether the news is good or bad for the world.

Reply ONLY minified JSON, no prose, no code fences:
{"items":[{"i":<index>,"direction":"bull"|"bear"|"unclear","materiality":1|2|3,"novelty":"new"|"update"|"rehash"}],"overall":{"lean":"bullish"|"bearish"|"mixed"|"quiet","summary":"<=140 chars"}}

DIRECTION — think supply/demand for crude itself:
- bull: supply loss or credible threat to it (war escalation, chokepoint/tanker disruption, sanctions on an exporter, OPEC+ cut, outage/force majeure, big inventory DRAW, strong demand data).
- bear: supply added or threat receding (ceasefire/de-escalation, OPEC+ hike, SPR release, sanctions relief, big inventory BUILD, demand destruction — recession signs, weak China, hawkish Fed/strong dollar).
- Traps to get right: a ceasefire headline during a war-premium rally is sharply BEAR. A refinery outage cuts crude demand — BEAR for crude even though products rise. Retail gasoline-price stories are derivative noise. Analyst forecasts/opinion pieces take the direction of their argument but are never materiality 3. If genuinely ambiguous, say "unclear" — do not guess.
- Supply-side tells (what physical desks trade on): rising Saudi/OPEC+ output, an OPEC survey showing production rose, or Saudi OSP (official selling price) CUTS to Asia = BEAR (ample supply / defending market share). Output discipline, quota compliance, OSP hikes = BULL. Tanker-flow stories (loadings up, floating storage draining onto market) = supply signals, score them like production data.

MATERIALITY — would this move Brent today?
- 3: could move Brent >1% (chokepoint closed/attacked, OPEC+ surprise, war escalation/entry of new party, major force majeure, sanctions on a top-10 exporter, SPR action).
- 2: notable but regional/incremental (single outage, inventory surprise, credible threats, big demand datapoint).
- 1: background — opinion, explainer, retail prices, equities angle, small updates.

NOVELTY — critical for a trader; use the ages given:
- new: first report of a fresh event.
- update: meaningful new development in a known story.
- rehash: re-reporting or commentary on something days old that the market has already priced. Ongoing-war color pieces are rehash unless they add a new escalation.

OVERALL — lean = net NEAR-TERM price pressure from THIS set of headlines, weighted by materiality and novelty (rehash counts little). "quiet" if nothing material. summary: name the single dominant driver and the main offset, plain language, <=140 chars.`;

// ---- btc news pack ----

// NOTE: tiers may mix plain substrings and RegExps (lib/news.js scoreText
// handles both). 'sec' gets a word boundary so it doesn't match "security".
const BTC_TIER1 = [
  /\bsec\b/, 'etf approval', 'etf outflow', 'hack', 'exploit', 'bankrupt',
  'fomc', 'rate cut', 'rate hike', /\bban\b/, 'liquidation cascade',
];
const BTC_TIER2 = [
  'etf', 'halving', 'whale', 'liquidation', 'stablecoin', 'mining',
  'microstrategy', 'institutional', 'tether',
];

const BTC_TOPIC = /(bitcoin|btc|crypto|ethereum|blockchain|stablecoin|coinbase|binance|defi|halving|satoshi|digital asset)/i;

// Feeds curl-verified 2026-07-18: all five returned HTTP 200 with fresh items.
const BTC_FEEDS = [
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', label: 'CoinDesk' },
  { url: 'https://cointelegraph.com/rss', label: 'Cointelegraph' },
  { url: 'https://decrypt.co/feed', label: 'Decrypt' },
  { url: 'https://news.google.com/rss/search?q=bitcoin+OR+crypto+OR+BTC+when:2d&hl=en-US&gl=US&ceid=US:en', label: 'Google News' },
  { url: 'https://news.google.com/rss/search?q=(bitcoin+OR+crypto)+source:bloomberg+when:2d&hl=en-US&gl=US&ceid=US:en', label: 'Bloomberg' },
];

const BTC_SYSTEM = `You are a senior crypto market analyst writing for a discretionary Bitcoin trader. You will get a numbered list of recent headlines with source and age. Judge each headline's likely effect on the BITCOIN price over the next days — not whether the news is good or bad for the world.

Reply ONLY minified JSON, no prose, no code fences:
{"items":[{"i":<index>,"direction":"bull"|"bear"|"unclear","materiality":1|2|3,"novelty":"new"|"update"|"rehash"}],"overall":{"lean":"bullish"|"bearish"|"mixed"|"quiet","summary":"<=140 chars"}}

DIRECTION — think flows and macro for bitcoin itself:
- bull: spot-ETF inflows, institutional/corporate treasury buying, dovish Fed (rate cuts, weak dollar), regulatory clarity or approvals, sovereign/state adoption, short-liquidation squeezes, supply tightening (post-halving, exchange balances draining).
- bear: ETF outflows, exchange/protocol hacks or exploits, SEC enforcement or bans, hawkish Fed (rate hikes, strong dollar, hot inflation), large distributions (government/Mt.Gox/whale sales), stablecoin instability or depegs, long-liquidation cascades, crypto-firm bankruptcies.
- Traps to get right: altcoin-specific news is background for BTC unless it is systemic (a major exchange or stablecoin). "Crypto stock" moves (miners, Coinbase) are derivative noise. Price-recap articles ("bitcoin falls below X") describe a move that already happened — rehash, not a driver. Halving anticipation is priced in far ahead. Macro (FOMC, CPI, dollar) often dominates crypto-native news. If genuinely ambiguous, say "unclear" — do not guess.

MATERIALITY — would this move bitcoin today? (BTC is more volatile than oil; scale accordingly)
- 3: could move BTC >2% (spot-ETF approval/denial or massive flow day, major exchange collapse or hack, FOMC surprise, sovereign adoption or ban, US strategic-reserve news, top-3 stablecoin depeg).
- 2: notable but incremental (sizeable ETF flow prints, single protocol exploit, a big institutional allocation, notable regulatory filing or lawsuit development).
- 1: background — opinion, explainer, altcoin color, price recaps, small updates.

NOVELTY — critical for a trader; use the ages given:
- new: first report of a fresh event.
- update: meaningful new development in a known story.
- rehash: re-reporting or commentary on something days old that the market has already priced. Bull/bear prediction pieces are rehash unless tied to a new event.

OVERALL — lean = net NEAR-TERM price pressure from THIS set of headlines, weighted by materiality and novelty (rehash counts little). "quiet" if nothing material. summary: name the single dominant driver and the main offset, plain language, <=140 chars.`;

// ---- the registry ----

const INSTRUMENTS = {
  brent: {
    id: 'brent',
    label: 'Brent',
    fullLabel: 'Brent crude',
    epic: 'OIL_BRENT', // Capital.com CFD epic
    yahooDaily: 'BZ=F',
    yahooIntraday: 'BZ=F',
    tradesWeekends: false,
    features: 'oil', // full oil feature set: WTI/DXY/OVX/EIA/curve
    liveLocked: false,
    drivesGlobalCapitalEnv: true, // this bot's env selection sets the app-wide default Capital env (spot feed) — original behavior
    priceDp: 2,
    sizeUnit: 'barrels',
    sizeDecimals: 1, // sizes round down to 0.1
    minSize: 1,
    botDefaults: {}, // uses lib/bot.js DEFAULT_CONFIG unchanged
    botStateFile: 'bot_state', // -> bot_state.json / bot_state_live.json (original names)
    botEnvFile: 'bot_env.txt',
    newsPack: {
      cacheKey: 'news_raw', // original cache keys — existing disk cache stays valid
      parallelCacheKey: 'news_parallel',
      llmCachePrefix: 'news_llm',
      promptVersion: 'v3',
      tier1: OIL_TIER1,
      tier2: OIL_TIER2,
      topicRe: OIL_TOPIC,
      feeds: OIL_FEEDS,
      parallelObjective:
        'Breaking news from the past 24-48 hours moving crude oil prices (Brent/WTI): OPEC+ decisions, geopolitics, supply disruptions, sanctions, inventories, demand. Only recent news reports — no explainers or evergreen pages.',
      parallelQueries: ['crude oil price news today', 'OPEC Brent supply disruption latest'],
      systemPrompt: OIL_SYSTEM,
      scoreLabel: 'crude-oil headlines',
      sourcesLine: 'newest first · updates every 5 min · Bloomberg / Reuters / Guardian / CNBC / Al Jazeera / OilPrice / Rigzone / World Oil / gCaptain / EIA / Investing.com + Parallel',
    },
  },

  btc: {
    id: 'btc',
    label: 'Bitcoin',
    fullLabel: 'Bitcoin',
    epic: 'BTCUSD', // verified on the Capital.com demo API 2026-07-18 (min deal 0.0001, ~24/7)
    yahooDaily: 'BTC-USD',
    yahooIntraday: 'BTC-USD',
    tradesWeekends: true,
    features: 'generic', // momentum + vol only; no curve/EIA/OVX/DXY/WTI
    liveLocked: true, // HARD demo-only lock (enforced in lib/bot.js)
    priceDp: 0,
    sizeUnit: 'BTC',
    sizeDecimals: 4, // Capital BTCUSD min size increment is 0.0001
    minSize: 0.001,
    botDefaults: {
      // BTC at ~$64k with a ~$50 CFD spread: usd-mode TP capped at $20 could
      // never pass the spread<=20%-of-TP rail, so BTC defaults to pct mode.
      positionSize: 0.01, // ~$640 notional
      tpMode: 'pct',
      tpValue: 0.5, // ~$320 at $64k — spread ~15% of TP, inside the rail
      slMode: 'pct',
      slValue: 0.7,
    },
    botStateFile: 'bot_state_btc', // -> bot_state_btc.json / bot_state_btc_live.json
    botEnvFile: 'bot_env_btc.txt',
    newsPack: {
      cacheKey: 'news_raw_btc',
      parallelCacheKey: 'news_parallel_btc',
      llmCachePrefix: 'news_llm_btc',
      promptVersion: 'v1',
      tier1: BTC_TIER1,
      tier2: BTC_TIER2,
      topicRe: BTC_TOPIC,
      feeds: BTC_FEEDS,
      parallelObjective:
        'Breaking news from the past 24-48 hours moving the BITCOIN price: spot-ETF flows, SEC and regulatory decisions, exchange hacks or exploits, FOMC/rates/dollar macro, institutional adoption, liquidations, stablecoins. Only recent news reports — no explainers or evergreen pages.',
      parallelQueries: ['bitcoin price news today', 'bitcoin ETF SEC crypto regulation latest'],
      systemPrompt: BTC_SYSTEM,
      scoreLabel: 'bitcoin/crypto headlines',
      sourcesLine: 'newest first · updates every 5 min · CoinDesk / Cointelegraph / Decrypt / Google News / Bloomberg + Parallel',
    },
  },
};

const INSTRUMENT_IDS = Object.keys(INSTRUMENTS);

// Resolve a request/query value to a known instrument id — unknown values fall
// back to brent so every pre-existing URL keeps its exact old behavior.
function resolveId(value) {
  return INSTRUMENTS[value] ? value : 'brent';
}

function get(idOrValue) {
  return INSTRUMENTS[resolveId(idOrValue)];
}

module.exports = { INSTRUMENTS, INSTRUMENT_IDS, resolveId, get };
