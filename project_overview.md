# CrudeSignal Lab — Technical Onboarding

Single-user localhost web app: Brent crude price targets at 6 horizons (15m/30m/1h/1d/1w/1m) with honest volatility bands, a realtime BUY/HOLD/SELL combiner (models + LLM news + Brent term-structure curve), LLM-scored news, live Capital.com CFD spot, EIA fundamentals, a self-calibrating prediction journal, and an optional broker-side **scalp trading bot** that auto-trades the combiner on a demo (or, guarded, live) Capital.com account. Companion "model bench" to the CrudeSignal PRD (`~/Projects/oil-radar/PRD.md`), inheriting its honesty rules: dead zones, calibrated confidence buckets, hit rates always shown next to base rates. Known honest result (README): the statistical models are near coin-flip at daily horizons — **the bands and the journal are the real product**; the bot trades the combiner but its edge is unproven and it is risk-rail-first by design.

## 1. System overview

One Node/Express process (`server.js`, port 4173, no build step) serves a vanilla-JS + Chart.js frontend from `public/`. Data comes from free/keyless feeds (Yahoo, EIA, RSS) plus three keyed services (Parallel, OpenRouter, Capital.com), all disk-cached under `data/`. Model training (ridge closed-form, pure-JS random forest) runs in worker threads so the event loop never blocks. A 5-minute background tick logs predictions to Neon Postgres (or local SQLite), resolves matured ones, and feeds calibration back into the bands. A separate 15-second tick drives the scalp bot off the same combiner signal.

```
  Yahoo Finance   EIA .xls   RSS x13 feeds   Parallel        OpenRouter       Capital.com               Neon PG
  chart API +     WCESTUS1w  majors+Rigzone  /v1beta/search  chat/completions  /session /markets +       DATABASE_URL
  contract months            World Oil/EIA…                                    /positions /confirms      |
       |             |            |               |               |                 |                      |
       v             v            v               v               v                 v                      |
  +--------------------------------------------------------------------------------------------------+     |
  | server.js  (express :4173)                                                                        |    |
  |   lib/fetchers.js  ---- disk cache data/*.json (per-feed TTL)                                     |    |
  |   lib/data.js      buildDataset (11 daily feats) / buildIntradayRows (4; fwd1 + fwd2=30m)         |    |
  |   lib/curve.js     fetchCurve: Brent M1−M2 from live contract months -> PRD-C1 score              |    |
  |   lib/news.js ----> lib/llm.js scoreNews (keyword tiers + LLM v3 pass, tape state)                |    |
  |   lib/capital.js   per-env CFD session (CST/X-SECURITY-TOKEN) + snapshot + dealing endpoints      |    |
  |   lib/targets.js   buildTargets: spot x (1 + mu-bias) +/- sigma*k*newsFactor, economic lean floor |    |
  |   lib/signal.js    computeSignal: 5-component BUY/HOLD/SELL, journal-gated, curve never damped     |   |
  |   lib/bot.js       scalp bot: entry gates -> capital.openPosition (broker SL/TP), reconcile        |   |
  |   lib/journal.js   dual driver: pg Pool (Neon) | node:sqlite  <-------------------------------------------- +
  |                                                                                                   |
  |   state.models (promise cache) --> worker_threads: lib/model-worker.js -> lib/model.js            |
  |   background: journalTick() every 5 min   ·   bot.tick(signal, spot) every 15 s                   |
  +--------------------------------------------------------------------------------------------------+
    ^ 5s /api/price   ^ 15s /api/signal   ^ 5min /api/news   ^ 10s /api/bot   ^ /api/dashboard + /api/journal on load
  +--------------------------------------------------------------------------------------------------+
  | public/app.js  polls, renders; re-anchors all 6 target cards + scalp strip on each live-price tick |
  +--------------------------------------------------------------------------------------------------+
```

## 2. Repository map

| Path | Owns |
|---|---|
| `server.js` | Express app, all routes, `FEEDS` registry (9 feeds), `loadData`, `coreBundles` (6 model bundles), `getLiveSpot`, `liveSpreadPct`, `currentSignal`, `journalTick`, bot routes + 15s bot tick, boot warmup |
| `lib/env.js` | Minimal `.env` loader (KEY=VALUE, existing env wins); required first via `require('./lib/env')` |
| `lib/fetchers.js` | Yahoo chart API (`yahooDaily`/`yahooSeries`), EIA XLS (`eiaCrudeStocks`), disk cache (`readCache`/`writeCache`/`clearCache`), `fetchWithRetry` |
| `lib/capital.js` | Capital.com CFD: per-env session lifecycle, `snapshot()`, dealing (`openPosition`/`closePosition`/`listPositions`/`confirmDeal`/`accounts`/`ensureHedging`), `setEnv`; epic map `EPICS` |
| `lib/curve.js` | `fetchCurve`: picks live Brent contract months (`BZ<code><yy>.NYM`), M1−M2 prompt spread + PRD-C1 `score`/`state` — the physical-market input to the signal + a KPI |
| `lib/data.js` | Causal feature engineering: `asOfJoin`, `buildDataset` (daily), `buildIntradayRows` (adds `fwd2`), `recentVol`, `pearson`, `FEATURES` |
| `lib/news.js` | 13 RSS feeds across 12 outlets + Parallel lane, `parseRss`, `dedupe`, keyword tiers (`scoreText`), selection/ranking, `fetchNews`, `levelFor`, `newsBandFactor` |
| `lib/llm.js` | OpenRouter calls: `scoreNews` (batched headline scoring, prompt `v3`, title-hash cache) and `chatText`; `DEFAULT_MODEL` |
| `lib/targets.js` | `buildTargets`/`one`: target = spot×(1+μ) ± band, journal calibration, `edgeTag`, `bucketHit`, economic lean floor (`minMu`) |
| `lib/model.js` | `fitRidge` (closed-form + λ), `fitForest`, `walkForward`, `evaluate`, `calibrateBuckets`, `computeBundle`; `HORIZON_BARS` (+`fwd2`) |
| `lib/model-worker.js` | 8-line worker-thread shim: `computeBundle(workerData)` → `parentPort.postMessage` |
| `lib/signal.js` | `computeSignal`: 5-component BUY/HOLD/SELL combiner (intraday/daily/news/momentum/curve), tape-dependent weights, journal verdict gates |
| `lib/journal.js` | Prediction + signal journal: dual pg/sqlite driver, DDL, `logPredictions`, `resolveDue`, `logSignal`/`resolveSignals`/`signalStats`, `computeCalibration`, `stats`, `HORIZONS` (m15…mo1 incl `m30`) |
| `lib/bot.js` | Scalp bot: config/validation, entry gates, sizing, banker+runner split, `openPosition` with broker SL/TP, `reconcile`, `manual`, `switchEnv`, atomic state persistence (per-env files + `.bak`) |
| `public/index.html` | Dashboard skeleton: hero row, 6 target cards, scalp strip, bot card (Demo/Real tabs), news card + LLM config, charts, KPI row, journal card |
| `public/app.js` | All rendering + poll loops (price 5s, signal 15s, news 5m, bot 10s, journal 5m); client-side target re-anchoring (`renderTargets`), `renderScalp`, `pollBot` |
| `public/style.css` | Design tokens (light + dark via `prefers-color-scheme`), compact "terminal" density pass (12.5px base, 1440px), all component styles incl. bot/tabs/env tags |
| `public/vendor/chart.umd.min.js` | Vendored Chart.js (no CDN, no build) |
| `scripts/smoke.js` | CLI: fetch → build features → ridge walk-forward fwd1/fwd5 → print metrics (`npm run smoke`) |
| `package.json` | Deps: `express` ^5, `ml-random-forest`, `pg`, `xlsx`. Scripts: `start`, `smoke`. Node ≥22.12 (uses `node:sqlite`, global `fetch`) |
| `README.md` | Product doc: target semantics, feed table, model honesty rules, roadmap |
| `deploy.md` | Hetzner VPS runbook: systemd + Caddy basic-auth, Neon project `rough-unit-12935854`, troubleshooting table |
| `data/` | Disk cache (disposable) + `config.json`, `journal.db` (sqlite fallback), and **bot state** (`bot_state.json`/`bot_state_live.json` + `.bak`, `bot_env.txt`) which is NOT disposable |
| `.env` | Secrets, gitignored (see §9) |

## 3. Runtime state

**In memory (server.js):**

| Var | Contents |
|---|---|
| `state.data` | `{ raw, ds, intraday, vols, health, builtAt }` — raw feed payloads, aligned dataset from `buildDataset`, intraday row bundles, trailing vols (`bar15`/`bar60` over 200 bars, `daily` over 63 closes), per-feed health. Rebuilt by `loadData()`; requires ≥300 aligned rows |
| `state.loading` | In-flight `loadData` promise (dedupes concurrent loads) |
| `state.models` | `Map<key, Promise<bundle>>` — **keys**: `` `${kind}:${horizonKey}` `` for daily (`ridge:fwd1`, `forest:fwd21`, …) and `` `ridge:${id}:${horizonKey}` `` for intraday (`ridge:i15:fwd1`, `ridge:i15:fwd2`, `ridge:i60:fwd1`). Set via `getModelBundle` (failed promises self-delete); wiped whole when `loadData` rebuilds |
| `config` | `{ newsModel }` — loaded from/saved to `data/config.json` (`saveConfig`) |
| `journalCalib` | Per-horizon `{ k, bias, n, active }` from `journal.computeCalibration()`; `{}` until first tick |
| `journalStatsCache` | `journal.stats()` result refreshed each tick; feeds the signal combiner's verdict gates |
| `priceCache` | `{ at, data }` 3s memo in `getLiveSpot`; also read by `liveSpreadPct()` for the economic lean floor |
| `capital.js sessions` | `{ demo:{cst,token,lastLoginAt}, live:{…} }` per-env tokens + `activeEnv`; tokens reused until 401 |
| `bot.js state` | `{ running, config, open[], closed[], events[], lastEntryAt, dayPnl, dayKey, halted }`; mirrored to a per-env disk file (`running` never restored true) |
| `journal.js driverPromise` | Memoized DB driver (pg pool or sqlite handle) |

**On disk (`data/`, written by `lib/fetchers.js`):** default TTL 6h (`TTL_MS`); `clearCache()` deletes all `*.json` **except `config.json`** (it does not touch bot state or `bot_env.txt`).

| File | Feed (`server.js FEEDS`) | TTL | staleDays (health) |
|---|---|---|---|
| `yahoo_BZ_F_10y_1d.json` | `brent` (required) | 6h | 7 |
| `yahoo_CL_F_10y_1d.json` | `wti` (required) | 6h | 7 |
| `yahoo_DX_Y_NYB_10y_1d.json` | `dxy` (required) | 6h | 7 |
| `yahoo__OVX_10y_1d.json` | `ovx` (optional) | 6h | 10 |
| `eia_wcestus1.json` | `inv` (optional) | 6h | 14 |
| `yahoo_BZ_F_60d_15m.json` | `i15` (optional) | 30m | 4 |
| `yahoo_BZ_F_730d_1h.json` | `i60` (optional) | 2h | 4 |
| `yahoo_BZ<mon><yy>_NYM_3mo_1d.json` | `curve` (optional; one per live contract month) | 30m | 5 (on `asOf`) |
| `news_raw.json` | RSS lanes + keyword layer | 5m (`NEWS_TTL_MS`) | 2 |
| `news_parallel.json` | Parallel lane | 30m (`PARALLEL_TTL_MS`) | — |
| `news_llm_v3_{slug}_{hash}.json` | LLM scores per (prompt-version, model, title-set) | 30m (`LLM_TTL_MS`) | — |
| `config.json` | runtime config, survives clearCache | ∞ | — |
| `journal.db` | sqlite journal (only without `DATABASE_URL`) | ∞ | — |
| `bot_state.json` / `bot_state_live.json` (+ `.bak`) · `bot_env.txt` | per-env bot state + last-selected account | ∞ | — |

**In Neon** (when `DATABASE_URL` set): tables `predictions`, `price_log`, `calibration_history`, `signals` (§6). Cache `data/` is disposable, **but the bot state files are not** — they hold open-position bookkeeping.

## 4. Data flows

### (a) Dashboard request → targets payload
1. Browser `load('ridge')` (`public/app.js:load`) → `GET /api/dashboard?model=ridge|forest` (`server.js`). (The UI only ever requests `ridge`; the forest path lives on but has no UI toggle anymore — see §8.)
2. `server.js:loadData` — `Promise.allSettled` over the 9-entry `FEEDS` table; required-feed failure throws, optional ones drop out; per-feed staleness → `health`. Then `lib/data.js:buildDataset` and `buildIntradayRows`, plus `recentVol` for the three sigmas.
3. `server.js:freshNews` — refetch news if the cached bundle is >5 min old.
4. `coreBundles(kind)` → **six** cached bundles: daily `fwd1/fwd5/fwd21` + intraday `i15` (15m, `fwd1`), `i15` (30m, `fwd2`), `i60` (1h, `fwd1`) → `getModelBundle` → `runWorker` → `lib/model.js:computeBundle`. Intraday needs ≥500 rows or resolves `null`.
5. `lib/targets.js:buildTargets` with `vols`, `newsBandFactor(news.activity.level)`, `journalCalib`, and `spreadPct: liveSpreadPct()`.
6. Response: `price`, `news`, `targets` (6), `kpis` (incl. `curve`), `series` (last 504 daily rows, last 320 intraday bars, last 260 inventory weeks), per-feature `correlations` (`pearson` vs fwd1/fwd5), `models` (h1,h5,h21,i15,i15f2,i60), `sampleInfo` (row count, date span, active feature labels, intraday bar counts, `parallelEnabled`).

### (b) Live price poll → client-side re-anchoring
1. `public/app.js:pollPrice` every **5s** → `GET /api/price`.
2. `server.js:getLiveSpot` — 3s `priceCache` memo; `lib/capital.js:snapshot('brent')` if configured (returns `bid/offer/mid/pctChange/marketStatus/env/high/low`), else newest Yahoo bar with `source:'yahoo-delayed'`.
3. Client updates hero badge (LIVE CFD vs delayed, shows `marketStatus` when not TRADEABLE), then `renderTargets(lastData, liveSpot)` re-anchors all **6** cards (`target = spot×(1+μ)`, `low/high = spot×(1+μ∓band)`) with no server round-trip, and `renderScalp(p)` refreshes the **scalp-conditions strip** (CFD spread vs the typical 15m/30m ±1σ move, and a move÷spread verdict: ≥8× good, ≥4× workable, else the spread eats the move).

### (c) News pipeline (`lib/news.js`)
1. `fetchNews(model)` → `fetchRawNews` (5-min disk cache `news_raw` — a model switch re-scores instantly because raw lanes are cached separately from the LLM pass).
2. **Lanes**: 13 `RSS_FEEDS` entries across 12 outlets via `fetchRss`/`parseRss` — Google News general + `source:bloomberg` + `source:reuters` queries, Guardian oil, CNBC energy, Al Jazeera, OilPrice, **Rigzone ×2 (latest + original), World Oil, gCaptain, EIA Today in Energy, Investing.com**. Three firehose feeds (Al Jazeera, gCaptain, Investing.com) carry `topicFilter:true` and are kept only where the title matches `OIL_TOPIC`. Plus `fetchParallel` if `PARALLEL_API_KEY` (own 30-min cache, ~$0.24/day).
3. `dedupe` — normalized first-60-chars title key.
4. Keyword tiers (`scoreText`): `TIER1` hits +3 (hormuz, opec+, attack, sanction, drone, missile…), `TIER2` +1 (incl. supply-side tells: saudi, aramco, OSP, "opec survey", floating storage, rig count…), capped at 9, ≤4 tags.
5. Selection: last 48h (7d fallback if <6), ranked by `rank() = (1+score)·e^(−age/18h)`, ≤3 per source, **max 18**; then re-sorted **newest-first** for display. `keywordPoints = Σ score·e^(−age/12h)`.
6. **LLM pass** (`lib/llm.js:scoreNews`): one batched OpenRouter call. Cache key `news_llm_{PROMPT_VERSION}_{slug}_{djb2(titles)}` — `PROMPT_VERSION='v3'` (editing `SYSTEM` invalidates cached scores). Prompt v3 adds explicit **supply-side direction rules** (rising Saudi/OPEC+ output, survey "output rose", OSP cuts to Asia = BEAR; discipline/OSP hikes = BULL; tanker-flow scored like production) plus the classic traps (ceasefire-into-rally = BEAR, refinery outage = BEAR for crude). Request: `temperature:0`, `max_tokens:2500`, **`reasoning:{enabled:false}`**. `extractJson` strips fences; enums validated defensively.
7. Tape score: `points = keywordPoints + Σ matPts·noveltyFactor·e^(−age/12h)` where mat3→+3, mat2→+1, `rehash`→×0.3. Keyword layer is **never suppressed** (PRD safety rule) — LLM failure ships `llm:{ok:false,reason}` and the UI shows "AI off".
8. `levelFor(points)`: **EVENT ≥9, ELEVATED ≥4, else QUIET** → `newsBandFactor`: ×1.5 / ×1.2 / ×1.0, multiplied into every target band.

### (d) The 5-minute journal tick (`server.js:journalTick`)
Boot warmup runs it once, then `setInterval(journalTick, 5*60*1000)`; `ticking` flag prevents overlap.
1. Get spot (`capital.snapshot`, else freshest Yahoo bar) → `journal.logPrice` into `price_log`.
2. `resolverFallbackSeries` — merged 15m bars (60d) + daily closes stamped `T20:00:00Z`; lets the resolver score predictions that matured while the server was down.
3. `journal.resolveDue(fallback)` — for each due `open` row: `lookupRealized` → `realized_ret`, `dir_correct` (**null** for FLAT *or* `|ret| ≤ NOISE_RET`), `band_hit = |ret−mu| ≤ sigma`. Window fully elapsed with no price → `'unresolvable'`.
4. `journal.resolveSignals(fallback)` — scores combiner rows at +1h and +1d (HOLD or sub-noise moves keep `hit` null).
5. `journalCalib = computeCalibration()`; `journalStatsCache = stats()`.
6. Rebuild ridge bundles + `buildTargets` (with fresh calibration + `spreadPct`) → `journal.logPredictions(targets, spot, 'ridge', newsLevel)` — one row per horizon whose cadence is due. **Always the ridge system**, so the journal measures one consistent policy.
7. `journal.logSignal(await currentSignal())` — one combiner row per tick (PK on `at`).

### (e) BUY/HOLD/SELL combiner (`lib/signal.js:computeSignal`, served by `/api/signal`, computed fresh per request)
Five components, each a score in [−1,+1]:

| Component | Score | Weight | Gate |
|---|---|---|---|
| `intraday` | avg of i15 (÷bar15 vol) + i60 (÷bar60), via `tanh(μ/σ)` | 0.25 | `modelDamp × avg(verdictGate(m15), verdictGate(h1))` |
| `daily` | avg of h1 (÷daily) + h5 (÷daily·√5) | 0.25 | `modelDamp × avg(verdictGate(d1), verdictGate(w1))` |
| `news` | LLM lean (±1/0) × heat (EVENT 1, ELEVATED 0.7, QUIET 0.35) | QUIET 0.12, else 0.3 | 1 |
| `momentum` | `tanh((live/priceHourAgo−1)/(bar60×1.5))` | 0.2 | 1 |
| `curve` | `curve.score` = `0.6·tanh(spread/0.4) + 0.4·tanh(chg5d/0.3)` | 0.15 | 1 — **never news-damped** |

`verdictGate` maps journal L3 verdicts to a multiplier: `suppress leans`→0, `no edge`→0.3, `keep leans`→1, `collecting`→0.7. `modelDamp = 0.5` on EVENT tape (headlines rule; models take the back seat) — it dampens only the two model components, never news/momentum/**curve** (the curve is physical truth that confirms or denies the headlines). Components with a `null` score drop out. `bias = Σ(w·gate·s)/Σ(w·gate)`; **dead zone |bias| < 0.15 → HOLD**. Confidence from `strength = |bias|·(0.5+0.5·agreement)` where agreement = share of active components whose sign matches the bias: Strong ≥0.5, Moderate ≥0.3, else Lean; always shipped with the "uncalibrated bias meter" caveat.

### (f) The scalp trading bot (`lib/bot.js`, `/api/bot*`, UI bot card)
A Node port of quantedge's `brent_scalp_bot`, wired to this app's combiner signal and `lib/capital.js` dealing. Philosophy: risk rails first, broker-side SL/TP attached at entry so exits survive the bot (or process) dying.

- **Loop**: `server.js` runs `setInterval(() => bot.tick(currentSignal(), getLiveSpot()), 15000)`. `tick` no-ops unless `state.running`.
- **Entry gates** (all must pass): live quote is `capital-cfd` and `marketStatus==='TRADEABLE'`; signal ≠ HOLD; `CONF_RANK[confidence] ≥ minConfidence`; `open.length < maxOpenTrades`; `cooldownSec` elapsed since `lastEntryAt`; spread ≤ `maxSpreadToTp` (20%) of the TP distance; and a **daily-loss worst-case** gate — realized `dayPnl` minus open-position risk (Σ size·|entry−sl|) minus the new trade's max loss must stay above `−dailyLossCap`.
- **Sizing** (`distances`/sizing): `fixed` = `positionSize` barrels, or `risk` = `max(1, riskAmount/slDistance)`. TP/SL are `$`/barrel or `%` of price.
- **Banker + runner**: on hot momentum (`runnerEnabled` and the signal's `momentum` component ≥ `runnerMomentum`, same sign as the trade) the size splits into a *banker* (half, fixed SL+TP) and a *runner* (rest, broker-side **trailing stop** via `stopDistance`, no TP → uncapped upside); otherwise one *solo* ticket. Each ticket = `capital.openPosition` → `confirmDeal` (must be `ACCEPTED`) → pushed to `state.open` with its `dealId`, `kind`, and `env`.
- **Reconcile**: `reconcile()` lists broker positions and books any of `state.open` the broker has closed (TP/SL/manual) into `closed[]` (best-effort exit ≈ live mid, since the API doesn't return the close price here). Runs on **every `tick` and every `GET /api/bot`**.
- **Manual / close**: `manual('BUY'|'SELL')` opens one solo ticket with the configured size/TP/SL (same guards, no runner); `closeAll()` and close-one call `capital.closePosition`.
- **Environments**: per-env state files (`bot_state.json` / `bot_state_live.json`), selection persisted to `bot_env.txt` and restored on boot (**never auto-starts**). `switchEnv` stops the bot, calls `capital.setEnv`, and loads that account's saved config; the **live** account is seeded with `LIVE_SAFE` (size 1, Strong-only, $30 cap, max 2) and `allowLive=true`, demo clears `allowLive`. `start`/`tick`/`manual` refuse a non-demo account unless `allowLive`.
- **State durability**: `save()` is atomic — write `.tmp`, rename the previous file to `.bak`, rename `.tmp` into place; boot loads `.bak` if the primary is unreadable. Added after a real corruption incident caused by two server processes writing the same file — **run one server process only**.

Bot config (`DEFAULT_CONFIG`, `validate()`, `LIVE_SAFE`):

| Key | Demo default | Live (`LIVE_SAFE`) | Validation |
|---|---|---|---|
| `sizeMode` | `fixed` | — | `fixed` \| `risk` |
| `positionSize` | 10 | **1** | 0–500 barrels |
| `riskAmount` | 50 | — | 0–5000 (risk mode) |
| `tpMode` / `slMode` | `usd` | — | `usd` \| `pct` |
| `tpValue` / `slValue` | 0.25 / 0.35 | — | ≤20 ($/bbl) or ≤5 (%) |
| `maxOpenTrades` | 3 | **2** | 1–10 |
| `cooldownSec` | 120 | — | 15–3600 |
| `minConfidence` | `Lean` | **Strong** | Lean \| Moderate \| Strong |
| `maxSpreadToTp` | 0.2 | — | fixed rail (spread ≤ 20% of TP) |
| `dailyLossCap` | 200 | **30** | 0–100000 |
| `runnerEnabled` / `runnerMomentum` | `true` / 0.5 | — | momentum 0.1–1 |
| `allowLive` | `false` | `true` | hard live-trade guard |

### (g) The UI, briefly (`public/index.html` + `app.js` + `style.css`)
No framework, no build; the page is a fixed skeleton and `app.js` fills it from the poll loops. A **compact "terminal" density pass** at the bottom of `style.css` overrides the base styles (12.5px body, 1440px `.wrap`, tighter cards) — the earlier, roomier rules still exist above it and are simply superseded. The Advanced section (model toggle, backtest charts, weight/driver panels) was **removed entirely** from the UI; its CSS classes (`.advanced`, `.bias-*`, `.drivers`, `.method`) are now dead. Notable cards:

- **Bot card** (`#bot-card`, `pollBot` every 10s): a **Demo / Real tab** pair (`renderScalp`-style env chip), a plain-language **status sentence**, a **config sentence** whose bold pills (`botSentence`) recompute live as you edit the form, four simple settings (trade size, TP, SL, max trades) + an **Advanced** `<details>` (sizing mode, risk $, TP/SL units, cooldown, min strength, runner toggle+trigger, daily cap), and **open / closed position tables** with per-row env tags (**red `REAL` / grey `demo`**) and `×` close buttons. Switching to the Real tab (`POST /api/bot/env`) **auto-stops** the bot and colors the card red (`.live-mode`); it never auto-starts.
- **Journal card** (`#journal-card`): a plain-language scoreboard — per-horizon "Ranges / Arrows / Self-correction" rows built from `/api/journal` (`rangeQuality`/`arrowQuality`/`tuneStatus`), a `learnbar` progress toward each `minN`, the BUY/SELL track record from `signalStats`, and an on-demand "AI review of the journal" button (`/api/journal/insight`).
- **Scalp-conditions strip** (`#scalp`): the move÷spread viability readout described in §4(b).

## 5. Model layer (`lib/model.js`, `lib/data.js`)

**Features.** Daily, 11 (`FEATURES`): `ret1/ret5/ret21`, `vol21`, `dxyRet5`, `ovxLvl`, `ovxChg5`, `spreadLvl`, `spreadChg5`, `invChg`, `invZ`. Dropped if <50% coverage. Intraday, 4 (`INTRADAY_FEATURES`): `ret1`, `ret4`, `ret16`, `vol32`. Causal `asOfJoin`; EIA joins at `weekEnd + EIA_RELEASE_LAG_DAYS(5)` (the Wed 10:30 ET WPSR release), no lookahead.

**Targets.** Daily rows carry `fwd1/fwd5/fwd21`; intraday rows carry `fwd1` (next bar) **and `fwd2` (2 bars = 30 min on the 15m series)**, so the same walk-forward machinery produces both the 15m and 30m target models. `HORIZON_BARS = {fwd1:1, fwd2:2, fwd5:5, fwd21:21}` drives both label causality and evaluation stride.

**Ridge (`fitRidge`).** Standardize + winsorize at ±5σ (`CLIP_Z`), closed-form normal equations (`ridgeSolve` → `solveLinear` Gaussian elimination). λ ∈ {1,10,100,1000} chosen by MSE on the last 20% of each window, refit on full window. `explain()` → top-3 `drivers`.

**Forest (`fitForest`).** `ml-random-forest`: 24 trees, depth 5, seed 42, window capped at `FOREST_MAX_TRAIN=1250`. **Pure-JS — walk-forward takes minutes and would freeze the HTTP event loop**, so every bundle computes in a worker thread. Never call `computeBundle` with `kind='forest'` on the main thread. Forest retrains every 252 rows vs 21 for ridge.

**Walk-forward causality (`walkForward`).** Expanding window, first 60% seeds, retrain every `step`. At index `i`, training rows are `slice(0, i−h+1)` where `h = HORIZON_BARS[horizonKey]` — an h-bar forward return only enters training h bars after it forms. Min 100 training rows.

**Evaluation (`evaluate`).** OOS with `stride = HORIZON_BARS[horizonKey]` — non-overlapping windows for multi-bar horizons. Emits `hitRate` *and* `baseRateUp` (coin-flips can't hide), `mae` vs `maeNaive` (zero-return forecast), `ic`, `sharpeNoCosts` (sign strategy, payoff/h daily slices), `maxDrawdown`, equity curves, scatter. Intraday bundles run `computeBundle` with `lite:true`, which drops the equity/scatter/weights payloads to keep the dashboard JSON small.

**Bucket calibration (`calibrateBuckets`/`bucketFor`).** Quantiles of OOS |pred|: dead zone q0.20, Lean/Moderate/Strong at q0.60/q0.87, each carrying its realized OOS hit rate (needs ≥60 OOS points). `|pred| < deadZone` → `NEUTRAL` → FLAT. `targets.js:bucketHit` shows a hit rate only with n≥20; `edgeTag` prints "edge +Xpts vs base" only above +5pts.

## 6. Database schema (`lib/journal.js`)

**`predictions`** — one row per logged target:

| Column | Meaning |
|---|---|
| `id` | identity PK (pg `GENERATED ALWAYS AS IDENTITY`; sqlite `AUTOINCREMENT`) |
| `made_at`, `due_at` | epoch ms logged / matures (`made_at + HORIZONS[h].ms`) |
| `horizon` | `m15|m30|h1|d1|w1|mo1` |
| `spot` | anchor price at log time |
| `mu`, `mu_raw` | displayed expected return (bias-adjusted) / raw model μ |
| `sigma`, `sigma_raw` | displayed half-band (=σ·k·newsFactor) / raw σ |
| `news_factor`, `news_level` | band multiplier and tape level at log time |
| `k_used`, `bias_used` | calibration values baked into this prediction (§7) |
| `direction`, `bucket`, `model` | BULLISH/BEARISH/FLAT, confidence bucket, `'ridge'` |
| `resolved_at`, `realized`, `realized_ret` | resolution timestamp, price, return vs spot |
| `dir_correct` | 1/0; **null** for FLAT or a sub-noise move (`|ret| ≤ NOISE_RET`) — excluded from hit rates |
| `band_hit` | 1 if `|realized_ret − mu| ≤ sigma` |
| `status` | `open` → `resolved` \| `unresolvable` |

Indexes: `idx_pred_open(status, due_at)`, `idx_pred_h(horizon, status, resolved_at)`.

**`price_log`** — `ts` (epoch ms, PK), `mid`, `source` (`capital|yahoo`). The resolver's primary lookup table.
**`calibration_history`** — `at`, `horizon`, `k`, `bias`, `n`, `active`; appended only when k moves >2% or bias >1e-4.
**`signals`** — `at` (PK), `signal`, `bias`, `confidence`, `tape`, `price`, `ret_1h`, `hit_1h`, `ret_1d`, `hit_1d`. Logged every tick by `logSignal`; scored by `resolveSignals` at +1h (30m window) and +1d (3.5d window). HOLD / sub-noise → `hit` null; unresolvable → `ret` 0 / `hit` null, parked. `signalStats()` aggregates buys/holds/sells and the +1h/+1d hit rates for the UI and `/api/journal`.

**Dual-driver adapter (`getDriver`).** `DATABASE_URL` → `pg.Pool` (max 3, `ssl:{rejectUnauthorized:false}`) against **Neon project `rough-unit-12935854`**; else `node:sqlite` `DatabaseSync` at `data/journal.db`. Shared DDL (`ddl(idLine)`); `?`→`$n` translation (`toPg`); the one non-portable statement is isolated as `upsertPrice` (pg `ON CONFLICT` vs sqlite `INSERT OR REPLACE`).

## 7. The self-calibration loop

Three layers, per horizon from the last `CALIB_WINDOW=400` resolved predictions (`computeCalibration`), applied in `lib/targets.js:one`:

- **L1 — band k**: `z = |realized_ret − mu_raw − bias| / (sigma_raw × news_factor)`; `k` = **68th percentile** of sorted z, clamped to `K_BOUNDS=[0.5, 2.5]`. Applied as `s = sigma × k × bandFactor`.
- **L2 — bias**: `bias = mean(realized_ret − mu_raw)` clamped to ±0.5× mean `sigma_raw`. Applied as `mu = muRaw − bias`.
- **L3 — lean gate**: `stats()` computes `leanVerdict` per horizon once `dirN ≥ minN`: base = `max(baseUp, 1−baseUp)`; `dirHitRate > base+0.03` → "keep leans", `< base−0.03` → "suppress leans", else "no edge — treat as flat". Report-only for the target cards, but **actively gates the signal combiner** (`signal.js:verdictGate`).

**Economic lean floor (`minMu`)**: on top of the statistical dead zone, `buildTargets` passes `spreadPct` (live CFD spread from `liveSpreadPct()`, ~4 bps fallback) and each horizon marks a lean FLAT unless `|mu| ≥ max(spreadPct, 0.0002)` — a lean must predict a move that at least covers the round-trip spread, or scoring it just feeds the journal coin-flip noise. Paired with `NOISE_RET=0.0002` (2 bps), which excludes sub-noise realized moves from direction scoring.

**Min-n shadow gates**: `HORIZONS[h].minN` — m15:100, **m30:80**, h1:60, d1:40, w1:20, mo1:12. Below minN, `active:false`: k/bias are computed and *shown* ("shadow") but `targets.js:one` falls back to `{k:1, bias:0}`.

**Why it's recursively testable**: `logPredictions` stores `k_used`/`bias_used`/`mu_raw`/`sigma_raw`/`news_factor` on every row. Resolution scores the *adjusted* prediction; recalibration recomputes from the *raw* values — each adjustment is itself scored by the next round, and `calibration_history` records every move. No runaway: raw values are the fixed reference frame.

**Logging cadences** (`HORIZONS[h].logEveryMs`): m15 5m, **m30 10m**, h1 15m, d1 2h, w1 12h, mo1 24h. **Resolve windows** (`resolveWindowMs`): m15 20m, **m30 40m**, h1 2h, d1/w1 3.5d, mo1 4d.

## 8. HTTP API (all in `server.js`)

| Route | Req | Resp (sketch) |
|---|---|---|
| `GET /api/price` | — | `{source:'capital-cfd'\|'yahoo-delayed', mid, at, bid?, offer?, pctChange?, marketStatus?, env?, epic?, high?, low?}` |
| `GET /api/signal` | — | `{signal, bias, confidence, tape, deadZone:0.15, components:[{key,label,score,weight,gated}], at, price, caveat}` (5 components incl. `curve`) |
| `GET /api/news` | — | `{fetchedAt, items:[…,ai?], activity:{level,points,keywordPoints}, lanes:{rss,parallel}, llm:{ok,model?,lean?,summary?}\|{ok:false,reason}}` |
| `GET /api/config` | — | `{newsModel, llmKeyPresent, parallelKeyPresent, capitalConfigured}` |
| `POST /api/config` | `{newsModel}` (regex `^[\w.-]+\/[\w.:-]+$`) | `{ok, newsModel}`; persists + re-scores news |
| `GET /api/dashboard?model=ridge\|forest` | — | `{builtAt, health[], price, news, targets[6], kpis(incl curve), series, correlations[], models:{h1,h5,h21,i15,i15f2,i60}, sampleInfo}` |
| `POST /api/refresh` | — | `{ok:true}` — drops `state.data`, `clearCache()`, full refetch + retrain |
| `GET /api/journal` | — | `{stats, signals, calibration, horizons, storage}` |
| `GET /api/journal/insight` | — | `{markdown, model}` — LLM quant-review of `await journal.stats()` via `chatText` (502 on LLM upstream failure) |
| `GET /api/bot` | — | reconciles, then `{running, env, halted, config, open[], closed[15], events[12], dayPnl, closedCount}` |
| `POST /api/bot/config` | `{…patch}` | `{ok, config}` (400 on validation) |
| `POST /api/bot/env` | `{env:'demo'\|'live'}` | `{ok}` — auto-stops the bot, loads that env's state |
| `POST /api/bot/start` \| `/stop` | — | `{ok}` (start 400s if the live guard refuses) |
| `POST /api/bot/manual` | `{dir:'BUY'\|'SELL'}` | `{ok}` (400 on guard / no live quote / closed market) |
| `POST /api/bot/close-one` | `{dealId}` | `{ok}` — `capital.closePosition` |
| `POST /api/bot/close-all` | — | `{ok}` — `bot.closeAll` |

Errors: `{error}` with 500/502/400. Static frontend from `public/`. The `forest` model path still exists in `/api/dashboard` and the worker, but **the UI no longer exposes a ridge/forest toggle** (Advanced section removed).

## 9. Configuration & secrets

`.env` at repo root, parsed by `lib/env.js`. Everything optional — each missing key degrades a lane:

| Key | Without it |
|---|---|
| `PARALLEL_API_KEY` | Parallel news lane off; RSS-only |
| `OPENROUTER_API_KEY` | News keyword-only ("AI off"); `/api/journal/insight` errors |
| `CAPITAL_API_KEY` + `CAPITAL_IDENTIFIER` + `CAPITAL_PASSWORD` (+`CAPITAL_ENVIRONMENT=demo\|live`, default demo) | Spot falls back to freshest Yahoo bar ("delayed" badge); the scalp bot has no broker to trade |
| `DATABASE_URL` (Neon, `sslmode=require`) | Journal writes to local `data/journal.db` — still fully functional |
| `PORT` | 4173 |

`data/config.json` (`{ newsModel }`) is the only persistent app config. The bot's account choice persists separately in `data/bot_env.txt`; its per-account settings live in the two `bot_state*.json` files. The UI's news-card slug input → `POST /api/config` → slug regex → `saveConfig()` → `fetchNews(slug)` (raw lanes stay cached; only the LLM pass reruns, keyed by slug) → dashboard reload.

## 10. External service notes (gotchas actually encountered)

- **Capital.com** (`lib/capital.js`): Brent epic is **`OIL_BRENT`** (`EPICS`) — quantedge's `CC.D.LCO.UNC.IP` is stale. Auth: `POST /session` with `X-CAP-API-KEY` + identifier/password → `CST` and `X-SECURITY-TOKEN` **response headers**, sent back on every call. **Sessions are per-environment** (`sessions.demo` / `sessions.live`); switching accounts uses a different base URL *and* a different token set. Idle ~10 min → `snapshot()`/`dealReq()` clear `cst` on 401 and re-login once; `/session` is rate-limited ~1/s so `login()` throttles to one attempt per 2s.
- **Capital.com hedging/netting**: by default the account **nets** — a SELL against an open BUY closes it instead of opening an opposite position. `ensureHedging()` (called by `bot.start`) flips `hedgingMode:true` via `PUT /accounts/preferences` so the banker+runner and opposite-direction entries can coexist. If trades mysteriously vanish, check hedging mode.
- **Trailing stops use `stopDistance`, not `stopLevel`**: `openPosition({trailingStop:true, stopDistance})` sends `guaranteedStop:false, trailingStop:true, stopDistance` and **no** `profitLevel` (runners run uncapped). A fixed ticket sends `stopLevel`+`profitLevel` instead. Mixing the two shapes is rejected by the broker.
- **Market hours**: Brent CFD closes on weekends (Fri ~21–22:00 UTC) and during auctions; `snapshot().marketStatus` reports non-`TRADEABLE` and the bot refuses entries (and `manual` throws). Existing broker-side SL/TP still stand.
- **Bot state corruption**: two server processes writing the same `bot_state*.json` corrupted it once — hence atomic `.tmp`→rename with a `.bak` fallback. **Run exactly one server process.** `clearCache()` deliberately leaves these files alone.
- **Yahoo** (`lib/fetchers.js`): needs a browser-ish `User-Agent` (`UA`) or 403/429. The chart API appends a live bar that can duplicate the last completed daily bar — `yahooSeries` dedupes by keeping the latest value per date key. `lib/curve.js` reuses `yahooSeries` per contract month (`BZ<code><yy>.NYM`, 3-month range) and treats a contract whose last bar is >5 days stale as dead.
- **EIA**: weekly stocks come from `WCESTUS1w.xls` (sheet `Data 1`, Excel serial dates via `excelDate`); features join at `weekEnd + 5d` (the WPSR release), not week-end — joining earlier would leak the future.
- **Google News `source:` queries** (`lib/news.js:RSS_FEEDS`): Bloomberg and Reuters have no public RSS; `source:bloomberg` / `source:reuters` Google News queries carry their headlines. Google News titles arrive as `"title - Source"`, so `parseRss` splits the suffix (only for the `Google News` label) to recover the real outlet name.
- **OpenRouter** (`lib/llm.js`): free reasoning models need `reasoning:{enabled:false}` + generous `max_tokens` (2500) or they burn the budget on monologue and return truncated JSON. Free-tier 429s are routine and harmless — the keyword layer carries the tape.
- **Neon**: `pg.Pool`, `ssl:{rejectUnauthorized:false}`, `max:3`. Tables auto-create on first boot — no migration step.

## 11. Known limitations, bugs & extension points

**Honest results first** (README, 2016→2026): daily horizons ≈ coin flip (hit ≈ base, IC ≈ 0); intraday 1h shows a faint momentum tilt (+1.7pts, IC 0.06) — below the proven-edge bar. The deliverables that survive: the volatility bands, news-aware widening, the curve/physical read, and the journal that measures everything live. The scalp bot inherits this — it is a disciplined executor of an unproven signal, defended by risk rails, not a known-profitable strategy.

Current limitations & bugs:
- **Entry-gate visibility**: every silent gate in `tick()` records `state.waiting` (e.g. "signal is BUY Moderate — needs Strong", "market is closed", "cooldown — 43s left"); surfaced via `/api/bot` and shown bold in the bot-card sentence. The former TDZ bug (size referenced before declaration, which killed all auto-entries) is fixed — size is computed before the worst-case gate.
- **Ops rule — exactly one server process**: `server.js` exits fatally on a failed port bind (`srv.on(error)`). History: lingering bind-failed zombies once served stale code for hours (and concurrent writers corrupted `bot_state.json`, since mitigated by atomic tmp+rename saves with .bak fallback). If behavior ever looks stale, `ps aux | grep "node server.js"` must show one process.
- The bot's reconciled exit price is best-effort (live mid), because the positions endpoint doesn't return a realized close price — booked P/L on TP/SL closes is approximate.
- Model bundles are in-memory promises — every restart retrains (ridge ~1s, forest ~1–2 min if it were ever requested).
- A sqlite journal is never merged into Neon if `DATABASE_URL` appears later; the histories fork.
- `dedupe` keys on the first 60 title chars — distinct stories with identical openings can merge.
- Single process, no auth — deploy behind Caddy basic-auth per `deploy.md`; and it must be single-process anyway (bot state).

Roadmap (README "Ideas for next", with plug-in points):

| Idea | Where it plugs in |
|---|---|
| More EIA series (Cushing, gasoline/distillate, refinery runs) + consensus-surprise | clone `fetchers.js:eiaCrudeStocks` per series; as-of join with release lag in `buildDataset` |
| CFTC COT positioning (weekly free CSV) | new fetcher; join like inventory — **respect the Friday-data/Tuesday-report release lag** |
| Event flags (OPEC calendar, geopolitical-risk regime / OVX percentile) | binary/percentile features in `lib/data.js` |
| Weekly Friday-to-Friday model (cleaner than overlapping 5d) | new `horizonKey` in `model.js:HORIZON_BARS` + weekly rows in `data.js` |
| Bot: real partial-close (TP1) instead of banker/runner split | needs opposite-order handling on Capital; the split is the current workaround |

Already shipped from the original roadmap: the **prediction journal** (`lib/journal.js`) and **term structure** (`lib/curve.js`, the PRD's C1 signal — now both a KPI and the never-damped curve component of the combiner).

## 12. Multi-instrument architecture (2026-07-18)

The app is now instrument-segregated end to end; `brent` and `btc` share code, never state.

- **`lib/instruments.js` is the only home of instrument literals**: Capital epic (`OIL_BRENT` / `BTCUSD`), Yahoo symbols (`BZ=F` / `BTC-USD`), news packs (feeds, keyword tiers — btc tier-1 uses word-boundary RegExps for `sec`/`ban` — LLM persona + prompt version + cache prefixes), bot defaults (btc uses pct-mode TP/SL 0.5%/0.7%: usd-mode's $20 cap can never pass the spread rail at a ~$50 BTC spread), size grid (`sizeDecimals`, brent 0.1 bbl / btc 0.0001 BTC), state-file names, and `liveLocked` (btc is HARD demo-only — live switch throws, `allowLive` patches are neutralized).
- **Models**: btc daily horizons use `data.js:buildGenericDailyRows` (momentum 1/5/21d + vol21); intraday reuses `buildIntradayRows`; btc signal = 4 components (no curve). Oil fundamentals (curve/EIA/OVX/DXY/WTI) never load for btc.
- **Journal**: `instrument` column on all four tables; `price_log` PK `(instrument, ts)`, `signals` PK `(instrument, at)`; idempotent migrations in both drivers (pg information_schema check; sqlite table rebuild); every query instrument-filtered; calibration/stats per instrument. Migration verified: 866 legacy rows tagged `brent`, baseline `/api/journal` identical.
- **Bot**: `bot.js:createBot(inst)` factory — per-instrument state objects, files (`bot_state_btc*.json`, `bot_env_btc.txt`), tick loops, env selection. All-time `stats` {pnl, trades, winRate} from the full persisted history (cap 1000) — always in `/api/bot`; full list via `/api/bot/history`.
- **Server/UI**: every relevant route takes `?instrument=` (default `brent`, old URLs unchanged); per-instrument model caches, price memos, journal ticks. UI: Brent|Bitcoin nav beside the h1 → full refetch; oil-only cards hide on null payload fields; per-instrument price decimals (`priceDp`); bot card gains the always-visible stats strip + "view full history" fold.
- **Stats gotcha**: `stats` reads the *current env's* state file — the Brent live tab shows 0 trades until real trades exist; the demo history lives on the Demo tab.

## 13. Operating rules & latest additions (2026-07-18)

- **HUMAN-ONLY LIVE ARMING (owner's standing order):** no automation, agent, or restart sequence may ever start a live-env bot. Only the user's own Start click arms real money. After any restart/rebuild: re-start demo bots if they were running; leave live bots STOPPED and report their state. (Bots already never auto-resume; this rule additionally forbids programmatic re-arming.)
- **Aggregate unrealized P/L**: `status()` returns top-level `unrealizedPnl` and `stats.unrealizedPnl` (sum of open trades' live mark-to-market, 0 when flat/no spot); rendered null-safely in the bot stats strip next to all-time realized figures.
- **Perth timestamps**: trade history + activity log render via `perthTime()` (Australia/Perth, 24h) regardless of browser locale.
- **In flight**: "CrudeSignal Terminal" premium reskin (comp in ~/Downloads zip) being implemented as a skin over the existing contracts — design law, glance tiers, live-data choreography and all element ids preserved; both themes; palette re-validated.
