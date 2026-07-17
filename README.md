# CrudeSignal Lab

Oil-price target dashboard + prediction-model lab, on localhost. Simple view: Brent spot, **price targets for 15 min / 1 hour / 1 day / 1 week / 1 month** (most-likely price ± an honest volatility band), a keyword-scored news feed with a QUIET/ELEVATED/EVENT tape badge, and the fundamentals (intraday chart, 2y chart, EIA inventories). Advanced fold: the full model bench — bias panels, walk-forward backtests, correlations, weights, scorecard.

Companion to the CrudeSignal realtime dashboard PRD (`~/Projects/oil-radar/PRD.md`): that product is the live tape; this lab is the model bench.

## Quickstart

```bash
npm install
npm start          # -> http://localhost:4173
npm run smoke      # CLI: fetch data, train, print backtest metrics
```

First start fetches ~10y daily + 60d of 15m bars + 730d of 1h bars (a few seconds) and trains all ridge models (<1s, worker threads). The random-forest toggle (Advanced) trains on demand (~1–2 min first time, then cached). Data disk-caches under `data/` (6h daily / 30m intraday+news); "Refresh" refetches everything.

## Price targets — how to read them

- **Target** = spot × (1 + model expected return) for that horizon.
- **Range** = target ± 1σ of trailing realized volatility scaled to the horizon (√t) — about 2-in-3 odds the price lands inside. σ: last 63 daily closes for 1d/1w/1m, last 200 bars for 15m/1h.
- **News widening:** ELEVATED tape ×1.2, EVENT tape ×1.5 — a hot tape makes every range wider and every model lean less trustworthy.
- **Leans** (▲/▼) show only when the model clears its dead zone, always with the bucket's realized OOS hit rate and an edge tag (hit rate vs base rate). Backtests say the models are near coin-flip — **the range is the honest deliverable; the lean is context.**

## Data & news

| Feed | Source | Notes |
|---|---|---|
| Brent `BZ=F`, WTI `CL=F` | Yahoo Finance chart API | daily closes 10y, front-month splice |
| Brent intraday | Yahoo | 15m bars (60d) + 1h bars (730d) for the 15m/1h target models |
| Dollar index `DX-Y.NYB`, `^OVX` | Yahoo Finance | OVX = CBOE crude-oil vol index |
| US crude stocks excl SPR (`WCESTUS1`) | EIA public history workbook (`.xls`) | weekly; joined at release date (week-end Fri + 5d = Wed 10:30 ET) — **no lookahead** |
| **Live spot — Capital.com CFD** | `CAPITAL_*` creds in `.env` (from quantedge; demo env) | `OIL_BRENT` snapshot, browser polls every 5s; session tokens auto-renew on 401; falls back to Yahoo with a "delayed" badge |
| News — Parallel Search API | `PARALLEL_API_KEY` in `.env` (found in quantedge; ~$0.005/sweep, cached 30 min) | optional — drops out cleanly without the key |
| Brent term structure | Yahoo individual contract months (`BZU26.NYM`…) | M1−M2 prompt spread: backwardation/contango KPI + signal component (physical-market confirmation, never news-damped) |
| News — major-outlet RSS | free, keyless | Guardian oil topic feed, CNBC energy feed, Al Jazeera (topic-filtered), OilPrice, Google News general + `source:bloomberg` / `source:reuters` queries. Last 48h only, freshness-weighted ranking, ≤3 items per source |
| **News LLM scoring — OpenRouter** | `OPENROUTER_API_KEY` in `.env` (from quantedge) | default model `poolside/laguna-xs-2.1:free` ($0), **configurable in the UI** (news card → slug input → Apply, persisted in `data/config.json`) |

Headlines are deduped and keyword-scored with the CrudeSignal PRD tier lists (Tier-1: Hormuz, OPEC+ emergency, attack, sanctions, force majeure… = 3pts; Tier-2 = 1pt). The LLM pass (analyst-grade prompt: direction traps like ceasefires and refinery outages, materiality anchored to ">1% Brent move", novelty = new/update/rehash judged from headline ages) adds per-headline direction + materiality + novelty and a one-line market read; materiality-3 items add +3 to the tape score (mat-2 +1), rehash items count 30%. Per the PRD safety rule the keyword layer is never suppressed — LLM down (e.g. free-tier 429) → keyword-only, flagged "AI off" with the reason. Decayed 48h score → tape state: **EVENT ≥ 9, ELEVATED ≥ 4, else QUIET.** Items older than 7 days are dropped (kills evergreen explainers). Reasoning models work: the call sets `reasoning: {enabled: false}` so free reasoners spend tokens on the answer.

Live spot re-anchors all five target cards client-side on every poll (target = live spot × (1 + μ) ± band), so targets track the CFD tick without retraining.

Feed failures degrade gracefully: optional feeds (OVX, EIA, intraday, news) drop their features/cards; required ones error visibly. The header chip summarizes feed health; per-feed chips live in Advanced.

## Models

- **Daily (1d / 1w / 1m targets), 11 features:** Brent momentum (1d/5d/21d), realized vol (21d), DXY 5d return, OVX level + 5d change, WTI−Brent spread level + 5d change, EIA weekly stocks Δ + 52-week z-score. Ridge (λ picked on each training window's tail) + random forest (24 trees, depth 5, rolling ~5y).
- **Intraday (15m / 1h targets):** ridge on bar momentum (1/4/16 bars) + rolling 32-bar vol.
- **Walk-forward:** first 60% seeds, retrain on a schedule, predictions strictly out-of-sample; label causality is index-based (a 5-bar forward return only enters training 5 bars later) so the same engine runs any bar frequency. 5d/21d scored on non-overlapping windows.
- **Honesty rules** (from the CrudeSignal PRD): dead-zone calls display flat; Lean/Moderate/Strong buckets carry realized OOS hit rates; the scorecard prints hit rate *next to the base rate* so a coin-flip model can't hide.

Honest result (2016→2026): daily horizons ≈ coin flip (hit ≈ base, IC ≈ 0); intraday shows a faint momentum tilt (1h: +1.7pts over base, IC 0.06 — below the "proven edge" bar). Matches the literature and the original brief's warning. The dashboard's real value: honest ranges, news-aware widening, fundamentals at a glance, and a no-lookahead rig for testing better features.

## Architecture

```
server.js            express: /api/dashboard, /api/price, /api/config, /api/refresh
lib/env.js           minimal .env loader (PARALLEL / OPENROUTER / CAPITAL_* keys)
lib/fetchers.js      Yahoo (daily+intraday) + EIA fetchers, disk cache (data/)
lib/capital.js       Capital.com CFD session + OIL_BRENT snapshot (live spot)
lib/data.js          as-of joins, release-lag alignment, daily + intraday features
lib/news.js          Parallel Search + RSS lanes, keyword scoring, tape state
lib/llm.js           OpenRouter batch scoring (configurable model, JSON contract)
lib/targets.js       price-target assembly (model μ ± vol σ × news factor)
lib/model.js         ridge, forest, walk-forward, metrics, bucket calibration
lib/model-worker.js  worker-thread wrapper (training never blocks HTTP)
public/              vanilla JS + Chart.js (vendored), light/dark tokens
scripts/smoke.js     CLI smoke test
```

## Ideas for next (roughly in order of expected value)

1. **Term structure** — M1−M2 / M1−M6 spreads from individual contract months (the PRD's C1 signal family; needs a contract-roll table).
2. More EIA series: Cushing stocks, gasoline/distillate, refinery runs — plus a surprise-vs-consensus feature (consensus from ForexFactory JSON).
3. CFTC COT positioning (weekly, free CSV) as a crowdedness/squeeze feature.
4. Event flags: OPEC meeting calendar, binary geopolitical-risk regime (or OVX percentile as its proxy, already partly in).
5. Prediction journal: log every live call with inputs, score against realized returns (the PRD's "signal journal is the moat" idea).
6. Weekly-horizon model on Friday-to-Friday non-overlapping returns (cleaner stats than overlapping 5d).
