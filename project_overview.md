# CrudeSignal Lab — Technical Onboarding

Single-user localhost web app: Brent crude price targets at 5 horizons (15m/1h/1d/1w/1m) with honest volatility bands, a realtime BUY/HOLD/SELL combiner, LLM-scored news, live Capital.com CFD spot, EIA fundamentals, and a self-calibrating prediction journal. Companion "model bench" to the CrudeSignal PRD (`~/Projects/oil-radar/PRD.md`), inheriting its honesty rules: dead zones, calibrated confidence buckets, hit rates always shown next to base rates. Known honest result (README): the statistical models are near coin-flip at daily horizons — **the bands and the journal are the real product**.

## 1. System overview

One Node/Express process (`server.js`, port 4173, no build step) serves a vanilla-JS + Chart.js frontend from `public/`. Data comes from free/keyless feeds (Yahoo, EIA, RSS) plus three keyed services (Parallel, OpenRouter, Capital.com), all disk-cached under `data/`. Model training (ridge closed-form, pure-JS random forest) runs in worker threads so the event loop never blocks. A 5-minute background tick logs predictions to Neon Postgres (or local SQLite), resolves matured ones, and feeds calibration back into the bands.

```
   Yahoo Finance    EIA dnav .xls    RSS x12 lanes      Parallel        OpenRouter        Capital.com          Neon PG
   chart API        WCESTUS1w.xls    GoogleNews etc.   /v1beta/search  chat/completions  /session /markets    DATABASE_URL
       |                 |                |                 |               |                 |                   |
       v                 v                v                 v               v                 v                   |
  +--------------------------------------------------------------------------------------------------+          |
  | server.js  (express :4173)                                                                        |          |
  |   lib/fetchers.js  ---- disk cache data/*.json (per-feed TTL)                                     |          |
  |   lib/data.js      buildDataset (11 daily features) / buildIntradayRows (4)                       |          |
  |   lib/news.js ----> lib/llm.js scoreNews (keyword tiers + LLM pass, tape state)                   |          |
  |   lib/capital.js   CFD session (CST/X-SECURITY-TOKEN) + OIL_BRENT snapshot                        |          |
  |   lib/targets.js   buildTargets: spot x (1 + mu-bias) +/- sigma*k*newsFactor                      |          |
  |   lib/signal.js    computeSignal: 4-component BUY/HOLD/SELL, journal-gated                        |          |
  |   lib/journal.js   dual driver: pg Pool (Neon) | node:sqlite  <--------------------------------------------- +
  |                                                                                                   |
  |   state.models (promise cache) --> worker_threads: lib/model-worker.js -> lib/model.js            |
  |      (walk-forward ridge/forest; pure-JS forest takes minutes -> MUST stay off the event loop)    |
  |                                                                                                   |
  |   background: journalTick() on boot then every 5 min                                              |
  |      log price -> resolve due preds+signals -> recompute calibration -> log new preds + signal    |
  +--------------------------------------------------------------------------------------------------+
     ^ 5s /api/price    ^ 15s /api/signal    ^ 5min /api/news    ^ 5min /api/journal    ^ /api/dashboard on load
  +--------------------------------------------------------------------------------------------------+
  | public/app.js  polls, renders; re-anchors all 5 target cards client-side on each live-price tick |
  +--------------------------------------------------------------------------------------------------+
```

## 2. Repository map

| Path | Owns |
|---|---|
| `server.js` | Express app, all routes, `FEEDS` registry, `loadData`, model-bundle cache, `getLiveSpot`, `currentSignal`, `journalTick`, boot warmup |
| `lib/env.js` | Minimal `.env` loader (KEY=VALUE, existing env wins); required first via `require('./lib/env')` |
| `lib/fetchers.js` | Yahoo chart API (`yahooDaily`/`yahooSeries`), EIA XLS (`eiaCrudeStocks`), disk cache (`readCache`/`writeCache`/`clearCache`), `fetchWithRetry` |
| `lib/capital.js` | Capital.com CFD session lifecycle + `snapshot()`; epic map `EPICS` |
| `lib/data.js` | Causal feature engineering: `asOfJoin`, `buildDataset` (daily), `buildIntradayRows`, `recentVol`, `pearson`, `FEATURES` |
| `lib/news.js` | RSS + Parallel lanes, `parseRss`, `dedupe`, keyword tiers (`scoreText`), item selection/ranking, `fetchNews`, tape `levelFor`, `newsBandFactor` |
| `lib/llm.js` | OpenRouter calls: `scoreNews` (batched headline scoring, versioned prompt, title-hash cache) and `chatText`; `DEFAULT_MODEL` |
| `lib/targets.js` | `buildTargets`/`one`: target = spot×(1+μ) ± band, applies journal calibration, `edgeTag`, `bucketHit` |
| `lib/model.js` | `fitRidge` (closed-form + λ selection), `fitForest`, `walkForward`, `evaluate`, `calibrateBuckets`, `computeBundle` |
| `lib/model-worker.js` | 8-line worker-thread shim: `computeBundle(workerData)` → `parentPort.postMessage` |
| `lib/journal.js` | Prediction journal: dual pg/sqlite driver, DDL, `logPredictions`, `resolveDue`, `computeCalibration`, `stats`, signal logging/scoring, `HORIZONS` |
| `lib/curve.js` | Brent term structure: `fetchCurve` picks two live contract months (BZ<code><yy>.NYM), M1−M2 spread + PRD-C1 score — the physical-market input to the signal |
| `lib/signal.js` | `computeSignal`: BUY/HOLD/SELL combiner with tape-dependent weights and journal verdict gates |
| `public/index.html` | Dashboard skeleton: hero row (price/signal/tape), target cards, news card + LLM config, charts, journal card |
| `public/app.js` | All rendering + the four poll loops; client-side target re-anchoring (`renderTargets`) |
| `public/style.css` | Design tokens (light + dark via `prefers-color-scheme`), all component styles |
| `public/vendor/chart.umd.min.js` | Vendored Chart.js (no CDN, no build) |
| `scripts/smoke.js` | CLI: fetch → build features → ridge walk-forward fwd1/fwd5 → print metrics (`npm run smoke`) |
| `package.json` | Deps: `express`, `ml-random-forest`, `pg`, `xlsx`. Scripts: `start`, `smoke`. Node ≥22.12 (uses `node:sqlite`, global `fetch`) |
| `README.md` | Product doc: target semantics, feed table, model honesty rules, roadmap |
| `deploy.md` | Hetzner VPS runbook: systemd + Caddy basic-auth, Neon project `rough-unit-12935854`, troubleshooting table |
| `data/` | Disk cache (disposable) + `config.json` (persistent) + `journal.db` (sqlite fallback journal) |
| `.env` | Secrets, gitignored (see §9) |

## 3. Runtime state

**In memory (server.js):**

| Var | Contents |
|---|---|
| `state.data` | `{ raw, ds, intraday, vols, health, builtAt }` — raw feed payloads, aligned dataset from `buildDataset`, intraday row bundles, trailing vols (`bar15`/`bar60` over 200 bars, `daily` over 63 closes), per-feed health. Rebuilt by `loadData()`; requires ≥300 aligned rows |
| `state.loading` | In-flight `loadData` promise (dedupes concurrent loads) |
| `state.models` | `Map<key, Promise<bundle>>` — **keys**: `` `${kind}:${horizonKey}` `` for daily (`ridge:fwd1`, `forest:fwd21`, …) and `` `ridge:${id}` `` for intraday (`ridge:i15`, `ridge:i60`). Set via `getModelBundle` (failed promises self-delete); wiped whole when `loadData` rebuilds |
| `config` | `{ newsModel }` — loaded from/saved to `data/config.json` (`saveConfig`) |
| `journalCalib` | Per-horizon `{ k, bias, n, active }` from `journal.computeCalibration()`; `{}` until first tick |
| `journalStatsCache` | `journal.stats()` result refreshed each tick; feeds the signal combiner's verdict gates |
| `priceCache` | `{ at, data }` 3s memo in `getLiveSpot` — a 5s-polling browser costs ≤1 upstream call/3s |
| `capital.js session` | `{ cst, token, lastLoginAt }` module-level; tokens reused until 401 |
| `journal.js driverPromise` | Memoized DB driver (pg pool or sqlite handle) |

**On disk (`data/`, written by `lib/fetchers.js`):** default TTL 6h (`TTL_MS`); `clearCache()` deletes all `*.json` **except `config.json`**.

| File | Feed (`server.js FEEDS`) | TTL | staleDays (health) |
|---|---|---|---|
| `yahoo_BZ_F_10y_1d.json` | `brent` (required) | 6h | 7 |
| `yahoo_CL_F_10y_1d.json` | `wti` (required) | 6h | 7 |
| `yahoo_DX_Y_NYB_10y_1d.json` | `dxy` (required) | 6h | 7 |
| `yahoo__OVX_10y_1d.json` | `ovx` (optional) | 6h | 10 |
| `eia_wcestus1.json` | `inv` (optional) | 6h | 14 |
| `yahoo_BZ_F_60d_15m.json` | `i15` (optional) | 30m | 4 |
| `yahoo_BZ_F_730d_1h.json` | `i60` (optional) | 2h | 4 |
| `news_raw.json` | RSS lanes + keyword layer | 5m (`NEWS_TTL_MS`) | 2 |
| `news_parallel.json` | Parallel lane | 30m (`PARALLEL_TTL_MS`) | — |
| `news_llm_v2_{slug}_{hash}.json` | LLM scores per (prompt-version, model, title-set) | 30m (`LLM_TTL_MS`) | — |
| `config.json` | runtime config, survives clearCache | ∞ | — |
| `journal.db` | sqlite journal (only without `DATABASE_URL`) | ∞ | — |

**In Neon** (when `DATABASE_URL` set): tables `predictions`, `price_log`, `calibration_history`, `signals` (§6). `data/` is disposable; the journal is the only state that matters (deploy.md).

## 4. Data flows

### (a) Dashboard request → targets payload
1. Browser `load('ridge')` (`public/app.js:load`) → `GET /api/dashboard?model=ridge|forest` (`server.js`).
2. `server.js:loadData` — `Promise.allSettled` over the 8-entry `FEEDS` table; required-feed failure throws, optional ones drop out; per-feed staleness → `health`. Then `lib/data.js:buildDataset` (as-of joins, features, forward returns) and `buildIntradayRows`, plus `recentVol` for the three sigmas.
3. `server.js:freshNews` — refetch news if the cached bundle is >5 min old (dashboard always ships a tape ≤5 min).
4. `Promise.all`: `dailyBundle(kind, fwd1|fwd5|fwd21)` + `intradayBundle('i15'|'i60')` → `getModelBundle` cache → `runWorker` → `lib/model-worker.js` → `lib/model.js:computeBundle`. Intraday needs ≥500 rows or resolves `null`.
5. `lib/targets.js:buildTargets` with `vols`, `newsBandFactor(news.activity.level)`, and `journalCalib`.
6. Response: `price`, `news`, `targets`, `kpis`, `series` (last 504 daily rows, last 320 intraday bars, last 260 inventory weeks), per-feature `correlations` (`lib/data.js:pearson` vs fwd1/fwd5), `models` (full bundles), `sampleInfo`.

### (b) Live price poll → client-side target re-anchoring
1. `public/app.js:pollPrice` every **5s** → `GET /api/price`.
2. `server.js:getLiveSpot` — 3s `priceCache` memo; `lib/capital.js:snapshot('brent')` if configured, else newest Yahoo bar with `source:'yahoo-delayed'`.
3. Client updates hero badge (LIVE CFD vs delayed), price, bid/ask, pctChange, then calls `renderTargets(lastData, liveSpot)`: each card recomputes `target = spot×(1+expectedReturn)`, `low/high = spot×(1+expectedReturn∓bandPct)` — targets track every CFD tick with **no server round-trip and no retraining**.

### (c) News pipeline
1. `lib/news.js:fetchNews(model)` → `fetchRawNews` (5-min disk cache `news_raw` — a model switch re-scores instantly because raw lanes are cached separately from the LLM pass).
2. **Lanes**: 7 `RSS_FEEDS` via `fetchRss`/`parseRss` — Google News general + `source:bloomberg` + `source:reuters` queries (Bloomberg/Reuters have no public RSS; Google News titles are split `"title - source"`), Guardian oil, CNBC energy, Al Jazeera (firehose, kept only if `OIL_TOPIC` regex matches), OilPrice. Plus `fetchParallel` if `PARALLEL_API_KEY` (own 30-min cache, ~$0.24/day).
3. `dedupe` — normalized first-60-chars title key.
4. Keyword tiers (`scoreText`): `TIER1` hits +3 (hormuz, opec+, attack, sanction, force majeure…), `TIER2` +1, capped at 9, ≤4 tags.
5. Selection: last 48h only (7d fallback if <6 items), ranked by `rank() = (1+score)·e^(−age/18h)`, ≤3 per source, max 16; presented newest-first. `keywordPoints = Σ score·e^(−age/12h)`.
6. **LLM pass** (`lib/llm.js:scoreNews`): one batched OpenRouter call. Cache key `news_llm_{PROMPT_VERSION}_{slug}_{djb2(titles)}` — `PROMPT_VERSION='v2'` means editing `SYSTEM` invalidates cached scores; the djb2 title-hash means an unchanged headline set costs nothing. Request: `temperature:0`, `max_tokens:2500`, **`reasoning:{enabled:false}`** — free reasoning models (laguna etc.) otherwise burn the whole budget on monologue and return truncated JSON. `extractJson` strips fences; enums (`direction`/`materiality`/`novelty`, `overall.lean`) validated defensively.
7. Tape score: `points = keywordPoints + Σ matPts·noveltyFactor·e^(−age/12h)` where mat3→+3, mat2→+1, `rehash`→×0.3 (`fetchNews`). Keyword layer is **never suppressed** (PRD safety rule) — LLM failure ships `llm:{ok:false,reason}` and the UI shows "AI off".
8. `levelFor(points)`: **EVENT ≥9, ELEVATED ≥4, else QUIET** → `newsBandFactor`: ×1.5 / ×1.2 / ×1.0, multiplied into every target band in `lib/targets.js:one`.

### (d) The 5-minute journal tick (`server.js:journalTick`)
Boot warmup runs it once, then `setInterval(journalTick, 5*60*1000)`; `ticking` flag prevents overlap.
1. Get spot (`capital.snapshot`, else freshest Yahoo bar) → `journal.logPrice(now, spot, src)` into `price_log`.
2. `server.js:resolverFallbackSeries` — merged 15m bars (60d) + daily closes stamped `T20:00:00Z` (settle), sorted; lets the resolver score predictions that matured while the server was down or the DB had no price row.
3. `journal.resolveDue(fallback)` — for each `status='open'` row past `due_at`: `lookupRealized` (first `price_log` row in `[due, due+resolveWindowMs]`, else fallback series) → `realized_ret`, `dir_correct` (null for FLAT), `band_hit = |ret−mu| ≤ sigma`, `status='resolved'`. Window fully elapsed with no price → `'unresolvable'`.
4. `journal.resolveSignals(fallback)` — scores signals at +1h and +1d (`ret_1h/hit_1h`, `ret_1d/hit_1d`; HOLD rows keep hit null).
5. `journalCalib = journal.computeCalibration()`; `journalStatsCache = journal.stats()`.
6. Rebuild ridge bundles + `buildTargets` with the fresh calibration → `journal.logPredictions(targets, spot, 'ridge', newsLevel)` — one row per horizon whose `logEveryMs` cadence is due. **Always the ridge system**, regardless of the UI model toggle, so the journal measures one consistent policy.
7. `journal.logSignal(await currentSignal())` — one combiner row per tick (PK on `at`).

### (e) BUY/HOLD/SELL combiner (`lib/signal.js:computeSignal`, served by `/api/signal`, computed fresh per request)
Four components, each a score in [−1,+1] via `tanh(μ/σ)` (`tanhScore`/`modelScore`; NEUTRAL predictions score 0):

| Component | Score | Weight | Gate |
|---|---|---|---|
| `intraday` | avg of i15 (÷bar15 vol) + i60 (÷bar60) | 0.25 | `modelDamp × avg(verdictGate(m15), verdictGate(h1))` |
| `daily` | avg of h1 (÷daily) + h5 (÷daily·√5) | 0.25 | `modelDamp × avg(verdictGate(d1), verdictGate(w1))` |
| `news` | LLM lean (±1/0) × heat (EVENT 1, ELEVATED 0.7, QUIET 0.35) | QUIET 0.12, else 0.3 | 1 |
| `momentum` | tanh((live/priceHourAgo−1)/(bar60×1.5)) | 0.2 | 1 |

`modelDamp = 0.5` on EVENT tape (headlines rule; models take the back seat). `verdictGate` maps journal L3 verdicts: `suppress leans`→0, `no edge`→0.3, `keep leans`→1, `collecting`→0.7. Then `bias = Σ(w·gate·s)/Σ(w·gate)`; **dead zone |bias| < 0.15 → HOLD**. Confidence from `strength = |bias|·(0.5+0.5·agreement)`: Strong ≥0.5, Moderate ≥0.3, else Lean; always shipped with the "uncalibrated bias meter" caveat, and the UI labels it `(uncalibrated)` until signal history accrues.

## 5. Model layer (`lib/model.js`, `lib/data.js`)

**Features.** Daily, 11 (`lib/data.js:FEATURES`): `ret1/ret5/ret21`, `vol21`, `dxyRet5`, `ovxLvl`, `ovxChg5`, `spreadLvl`, `spreadChg5`, `invChg`, `invZ` (52w z-score). A feature is dropped if <50% non-null coverage (dead optional feed degrades cleanly). Intraday, 4 (`INTRADAY_FEATURES`): `ret1`, `ret4`, `ret16`, `vol32`. Everything is causal: `asOfJoin` takes the latest value ≤ spine date within a max gap; EIA joins at **release date** (`weekEnd + EIA_RELEASE_LAG_DAYS(5)` = the Wednesday 10:30 ET WPSR release), not week-end — no lookahead.

**Targets.** Daily rows carry `fwd1/fwd5/fwd21` forward returns; intraday rows reuse the key `fwd1` = next-bar return, so the identical walk-forward machinery runs any bar frequency.

**Ridge (`fitRidge`).** Standardize + winsorize at ±5σ (`CLIP_Z`, Apr-2020 outliers), closed-form normal equations (`ridgeSolve` builds XᵀX+λI, `solveLinear` Gaussian elimination with partial pivoting). λ ∈ {1,10,100,1000} (`RIDGE_LAMBDAS`) chosen by MSE on the last 20% of each training window, then refit on the full window. `explain()` returns per-feature contributions → the bundle's top-3 `drivers`.

**Forest (`fitForest`).** `ml-random-forest`: 24 trees, depth 5, seed 42, training window capped at `FOREST_MAX_TRAIN=1250` rows (~5y rolling). **Pure-JS — a walk-forward backtest takes minutes and would freeze the HTTP event loop**, which is why every bundle computes inside a worker thread (`server.js:runWorker` → `lib/model-worker.js`). This is load-bearing: never call `computeBundle` with `kind='forest'` on the main thread. Forest retrains every 252 rows in walk-forward vs 21 for ridge (`computeBundle` step defaults).

**Walk-forward causality (`walkForward`).** Expanding window, first 60% seeds (`initialFrac`), retrain every `step` rows. Index-based label causality: at prediction index `i`, training rows are `rows.slice(0, i−h+1)` where `h = HORIZON_BARS[horizonKey]` ({fwd1:1, fwd5:5, fwd21:21}) — a 5-bar forward return only enters training 5 bars after it forms. Min 100 training rows.

**Evaluation (`evaluate`).** Scored on the OOS segment with `stride = HORIZON_BARS[horizonKey]` — **non-overlapping windows are the honest number for multi-day horizons**. Emits `hitRate` *and* `baseRateUp` (coin-flips can't hide), `mae` vs `maeNaive` (zero-return forecast), `ic`, `sharpeNoCosts` (sign strategy, payoff/h daily slices), `maxDrawdown`, equity curves, scatter.

**Bucket calibration (`calibrateBuckets`/`bucketFor`).** Quantiles of the OOS |pred| distribution: dead zone = q0.20, Lean/Moderate/Strong thresholds at q0.60/q0.87, each bucket carrying its realized OOS hit rate (needs ≥60 OOS points). `|prediction| < deadZone` → `NEUTRAL` → displayed FLAT. `lib/targets.js:bucketHit` only shows a bucket hit rate with n≥20; `edgeTag` prints "edge +Xpts vs base" only above +5pts.

## 6. Database schema (`lib/journal.js`)

**`predictions`** — one row per logged target:

| Column | Meaning |
|---|---|
| `id` | identity PK (pg: `GENERATED ALWAYS AS IDENTITY`; sqlite: `AUTOINCREMENT`) |
| `made_at`, `due_at` | epoch ms logged / matures (`made_at + HORIZONS[h].ms`) |
| `horizon` | `m15|h1|d1|w1|mo1` |
| `spot` | anchor price at log time |
| `mu`, `mu_raw` | displayed expected return (bias-adjusted) / raw model μ |
| `sigma`, `sigma_raw` | displayed half-band (=σ·k·newsFactor) / raw σ |
| `news_factor`, `news_level` | band multiplier and tape level at log time |
| `k_used`, `bias_used` | calibration values baked into this prediction (see §7) |
| `direction`, `bucket`, `model` | BULLISH/BEARISH/FLAT, confidence bucket, `'ridge'` |
| `resolved_at`, `realized`, `realized_ret` | resolution timestamp, price, return vs spot |
| `dir_correct` | 1/0; **null** for FLAT or zero return (excluded from hit rates) |
| `band_hit` | 1 if `|realized_ret − mu| ≤ sigma` |
| `status` | `open` → `resolved` \| `unresolvable` |

Indexes: `idx_pred_open(status, due_at)`, `idx_pred_h(horizon, status, resolved_at)`.

**`price_log`** — `ts` (epoch ms, PK), `mid`, `source` (`capital|yahoo`). The resolver's primary lookup table.
**`calibration_history`** — `at`, `horizon`, `k`, `bias`, `n`, `active`; appended only when k moves >2% or bias >1e-4 (audit trail of the learning loop).
**`signals`** — `at` (PK), `signal`, `bias`, `confidence`, `tape`, `price`, `ret_1h`, `hit_1h`, `ret_1d`, `hit_1d` (HOLD → hit null; unresolvable → ret 0 / hit null, parked).

**Dual-driver adapter (`getDriver`).** `DATABASE_URL` set → `pg.Pool` (max 3, `ssl:{rejectUnauthorized:false}`) against **Neon project `rough-unit-12935854`** (deploy.md); else `node:sqlite` `DatabaseSync` at `data/journal.db`. Three tricks make one SQL surface work on both:
1. **Shared DDL** (`ddl(idLine)`) — sqlite's type affinity happily accepts Postgres type names (`BIGINT`, `DOUBLE PRECISION`); only the identity-column line is parameterized.
2. **Placeholder translation** — all call sites write `?`; the pg driver's `toPg` rewrites `?` → `$1,$2,…`.
3. **Upsert divergence** — the one non-portable statement is isolated as a driver method `upsertPrice`: pg `ON CONFLICT (ts) DO UPDATE` vs sqlite `INSERT OR REPLACE`.

## 7. The self-calibration loop

Three layers, computed per horizon from the last `CALIB_WINDOW=400` resolved predictions (`journal.computeCalibration`), applied in `lib/targets.js:one`:

- **L1 — band k**: normalized errors `z = |realized_ret − mu_raw − bias| / (sigma_raw × news_factor)`; `k` = **68th percentile** of sorted z, clamped to `K_BOUNDS=[0.5, 2.5]`. If realized coverage was 68% already, k≈1; too-narrow bands push k up. Applied as `s = sigma × k × bandFactor`.
- **L2 — bias**: `bias = mean(realized_ret − mu_raw)` clamped to ±0.5× mean `sigma_raw`. Applied as `mu = muRaw − bias`.
- **L3 — lean gate**: `journal.stats()` computes `leanVerdict` per horizon once `dirN ≥ minN`: base = `max(baseUp, 1−baseUp)`; `dirHitRate > base+0.03` → "keep leans", `< base−0.03` → "suppress leans", else "no edge — treat as flat". Report-only for the target cards, but **actively gates the signal combiner** (`lib/signal.js:verdictGate`).

**Min-n shadow gates**: `HORIZONS[h].minN` — m15:100, h1:60, d1:40, w1:20, mo1:12. Below minN, `active:false`: the k/bias are computed and *shown* (UI "shadow (n=…)") but `targets.js:one` falls back to `{k:1, bias:0}`.

**Why it's recursively testable**: `logPredictions` stores `k_used`/`bias_used`/`mu_raw`/`sigma_raw`/`news_factor` on every row. Resolution scores the *adjusted* prediction (`mu`, `sigma`), while recalibration always recomputes from the *raw* values — so each round of adjustment is itself scored by the next round of resolved predictions, and `calibration_history` records every parameter move. No feedback runaway: raw values are the fixed reference frame.

**Logging cadences** (`HORIZONS[h].logEveryMs`): m15 every 5m, h1 15m, d1 2h, w1 12h, mo1 24h. **Resolve windows** (`resolveWindowMs`, tolerance for weekends/downtime): m15 20m, h1 2h, d1/w1 3.5d, mo1 4d.

## 8. HTTP API (all in `server.js`)

| Route | Req | Resp (sketch) |
|---|---|---|
| `GET /api/price` | — | `{source:'capital-cfd'\|'yahoo-delayed', mid, at, bid?, offer?, pctChange?, marketStatus?, env?, epic?, high?, low?}` |
| `GET /api/signal` | — | `{signal:'BUY'\|'HOLD'\|'SELL', bias, confidence, tape, deadZone:0.15, components:[{key,label,score,weight,gated}], at, price, caveat}` |
| `GET /api/news` | — | `{fetchedAt, items:[{title,url,source,publishedAt,score,tags,ai?:{direction,materiality,novelty}}], activity:{level,points,keywordPoints}, lanes:{rss,parallel}, llm:{ok,model?,lean?,summary?}\|{ok:false,reason}}` |
| `GET /api/config` | — | `{newsModel, llmKeyPresent, parallelKeyPresent, capitalConfigured}` |
| `POST /api/config` | `{newsModel:'vendor/slug'}` (regex `^[\w.-]+\/[\w.:-]+$`) | `{ok, newsModel}`; persists + re-scores news |
| `GET /api/dashboard?model=ridge\|forest` | — | `{builtAt, health[], price, news, targets[5], kpis, series, correlations[], models:{h1,h5,h21,i15,i60}, sampleInfo}` |
| `POST /api/refresh` | — | `{ok:true}` — drops `state.data`, `clearCache()`, full refetch + retrain |
| `GET /api/journal` | — | `{stats:{horizons,totals,recent,calibrationHistory}, signals, calibration, horizons, storage:'neon'\|'sqlite'}` |
| `GET /api/journal/insight` | — | `{markdown, model}` — LLM quant-review of journal stats via `lib/llm.js:chatText` |

Errors: `{error: string}` with 500 (502 for LLM upstream failure on insight). Static frontend served from `public/`.

## 9. Configuration & secrets

`.env` at repo root, parsed by `lib/env.js` (no quotes/expansion; real environment wins). Everything is optional — each missing key degrades a lane:

| Key | Without it |
|---|---|
| `PARALLEL_API_KEY` | Parallel news lane off; RSS-only (`lanes.parallel:false`) |
| `OPENROUTER_API_KEY` | News is keyword-only (UI "AI off"); `/api/journal/insight` returns error |
| `CAPITAL_API_KEY` + `CAPITAL_IDENTIFIER` + `CAPITAL_PASSWORD` (+`CAPITAL_ENVIRONMENT=demo\|live`, default demo) | Spot falls back to freshest Yahoo bar with "delayed" badge |
| `DATABASE_URL` (Neon, `sslmode=require`) | Journal writes to local `data/journal.db` via `node:sqlite` — still fully functional |
| `PORT` | 4173 |

`data/config.json`: `{ newsModel }` — the only persistent config; survives `clearCache()` and restarts.

**UI-configurable LLM model slug flow**: news-card input `#inp-llm` (datalist of free slugs in `public/index.html`) → `public/app.js` `btn-llm` handler → `POST /api/config` → slug regex validation → `saveConfig()` → `fetchNews(slug)` (raw lanes ride their 5-min cache; only the LLM pass reruns, and its cache is keyed by slug so switching back to a recent model is instant) → client reloads the dashboard.

## 10. External service notes (gotchas actually encountered)

- **Capital.com** (`lib/capital.js`): the Brent epic is **`OIL_BRENT`** (`EPICS`) — quantedge's `CC.D.LCO.UNC.IP` mapping is stale, don't copy it. Auth: `POST /session` with `X-CAP-API-KEY` header + identifier/password body → `CST` and `X-SECURITY-TOKEN` **response headers**, sent back on every `/markets/{epic}` call. Sessions idle out after ~10 min → `snapshot()` clears `session.cst` on 401 and re-logins exactly once. The session endpoint is rate-limited ~1 req/s → `login()` throttles to one attempt per 2s. Demo vs live are different base URLs (`BASES`).
- **Yahoo** (`lib/fetchers.js`): requires a browser-ish `User-Agent` header (`UA`) or you get 403/429. The chart API appends a live bar that can duplicate the last completed daily bar — `yahooSeries` dedupes by keeping the latest value for a repeated date key.
- **EIA** (`fetchers.js:eiaCrudeStocks` + `data.js:buildDataset`): weekly stocks come from the public dnav workbook `WCESTUS1w.xls` (sheet `Data 1`, Excel serial dates — `excelDate`). The week ends Friday but the WPSR releases the following Wednesday 10:30 ET, so features join at `weekEnd + 5d` (`EIA_RELEASE_LAG_DAYS`) — joining at week-end would leak 5 days of the future.
- **OpenRouter** (`lib/llm.js`): free reasoning models must have `reasoning:{enabled:false}` plus generous `max_tokens` (2500), or they spend the budget thinking and return truncated/empty JSON. Free-tier 429s are routine — harmless, the keyword layer carries the tape and the UI flags the reason.
- **Google News `source:` queries** (`lib/news.js:RSS_FEEDS`): Bloomberg and Reuters have no public RSS; `source:bloomberg` / `source:reuters` Google News queries carry their headlines. `parseRss` splits the `"title - Source"` suffix to recover the real outlet name for Google News items.
- **Neon**: `pg.Pool` with `ssl:{rejectUnauthorized:false}`, `max:3`. Tables auto-create on first boot (`getDriver` runs the DDL) — no migration step.

## 11. Known limitations & extension points

**Honest results first** (README, 2016→2026 backtests): daily horizons ≈ coin flip (hit ≈ base rate, IC ≈ 0); intraday 1h shows a faint momentum tilt (+1.7pts over base, IC 0.06) — below the proven-edge bar. The deliverables that survive this honesty are the volatility bands, news-aware widening, and the journal that measures everything live.

Current limitations:
- **Bug**: `GET /api/journal/insight` calls `const s = journal.stats()` **without await** (`server.js:~462`) — `s.horizons` is `undefined` in the prompt, so the LLM reviews only `journalCalib`. One-line fix.
- Model bundles are in-memory promises — every restart retrains (ridge ~1s, forest ~1–2 min on first toggle).
- A sqlite journal is never merged into Neon if `DATABASE_URL` appears later; the histories fork.
- `dedupe` keys on the first 60 title chars — distinct stories with identical openings can merge.
- Single process, no auth — deploy behind Caddy basic-auth per `deploy.md`.

Roadmap (README "Ideas for next", with plug-in points):

| Idea | Where it plugs in |
|---|---|
| 1. Term structure (M1−M2 / M1−M6 from contract months; needs a roll table) | new fetcher in `lib/fetchers.js` (per-contract Yahoo symbols); features + `FEATURES` entries in `lib/data.js:buildDataset` |
| 2. More EIA series (Cushing, gasoline/distillate, refinery runs) + consensus-surprise | clone `fetchers.js:eiaCrudeStocks` per series; as-of join with release lag in `buildDataset` (surprise needs a consensus source, e.g. ForexFactory JSON) |
| 3. CFTC COT positioning (weekly free CSV) | new fetcher; join exactly like inventory — **respect the Friday-data/Tuesday-report release lag** |
| 4. Event flags (OPEC meeting calendar, geopolitical-risk regime / OVX percentile) | binary/percentile features in `lib/data.js`; OVX level is already a feature |
| 5. Weekly Friday-to-Friday model (cleaner than overlapping 5d) | new `horizonKey` in `model.js:HORIZON_BARS` + weekly row construction in `data.js`; `walkForward`/`evaluate` need no changes |

Journal (roadmap item 5 in README) is already shipped — `lib/journal.js` is it.
