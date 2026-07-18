# CrudeSignal Lab

Oil-price target dashboard + prediction-model lab, on localhost. Simple view: Brent spot, **price targets for 15 min / 1 hour / 1 day / 1 week / 1 month** (most-likely price ± an honest volatility band), a keyword-scored news feed with a QUIET/ELEVATED/EVENT tape badge, and the fundamentals (intraday chart, 2y chart, EIA inventories). Advanced fold: the full model bench — bias panels, walk-forward backtests, correlations, weights, scorecard.

On top of the bench sits an **autoresearch loop** (`RESEARCH.md`): candidate features are scored on a tune window, promoted only through a one-shot locked holdout with a pre-declared kill bar, and every trial is journaled — so automated feature search can't manufacture fake edge by selection.

Companion to the CrudeSignal realtime dashboard PRD (`~/Projects/oil-radar/PRD.md`): that product is the live tape; this lab is the model bench.

## Quickstart

```bash
npm install
npm start          # -> http://localhost:4173
npm run smoke      # CLI: fetch data, train, print backtest metrics
npm run research   # research loop: trial / holdout / noise / list (see RESEARCH.md)
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
| WPSR extras: Cushing, gasoline, distillate, refinery utilization, SPR | EIA history workbooks via `eiaWeeklySeries(id)` | **research-only** until a candidate promotes (see `RESEARCH.md`); same release-date join |
| CFTC COT — WTI non-commercial net/OI | CFTC public Socrata API, keyless | **research-only**; Tuesday as-of, joined at Friday-publish (+3d) |
| **Live spot — Capital.com CFD** | `CAPITAL_*` creds in `.env` (from quantedge; demo env) | `OIL_BRENT` snapshot, browser polls every 5s; session tokens auto-renew on 401; falls back to Yahoo with a "delayed" badge |
| News — Parallel Search API | `PARALLEL_API_KEY` in `.env` (found in quantedge; ~$0.005/sweep, cached 30 min) | optional — drops out cleanly without the key |
| News — major-outlet RSS | free, keyless | Guardian oil topic feed, CNBC energy feed, Al Jazeera (topic-filtered), OilPrice, Google News general + `source:bloomberg` / `source:reuters` queries. Last 48h only, freshness-weighted ranking, ≤3 items per source |
| **News LLM scoring — OpenRouter** | `OPENROUTER_API_KEY` in `.env` (from quantedge) | default model `poolside/laguna-xs-2.1:free` ($0), **configurable in the UI** (news card → slug input → Apply, persisted in `data/config.json`) |

Headlines are deduped and keyword-scored with the CrudeSignal PRD tier lists (Tier-1: Hormuz, OPEC+ emergency, attack, sanctions, force majeure… = 3pts; Tier-2 = 1pt). The LLM pass (analyst-grade prompt: direction traps like ceasefires and refinery outages, materiality anchored to ">1% Brent move", novelty = new/update/rehash judged from headline ages) adds per-headline direction + materiality + novelty and a one-line market read; materiality-3 items add +3 to the tape score (mat-2 +1), rehash items count 30%. Per the PRD safety rule the keyword layer is never suppressed — LLM down (e.g. free-tier 429) → keyword-only, flagged "AI off" with the reason. Decayed 48h score → tape state: **EVENT ≥ 9, ELEVATED ≥ 4, else QUIET.** Items older than 7 days are dropped (kills evergreen explainers). Reasoning models work: the call sets `reasoning: {enabled: false}` so free reasoners spend tokens on the answer.

Live spot re-anchors all five target cards client-side on every poll (target = live spot × (1 + μ) ± band), so targets track the CFD tick without retraining.

Feed failures degrade gracefully: optional feeds (OVX, EIA, intraday, news) drop their features/cards; required ones error visibly. The header chip summarizes feed health; per-feed chips live in Advanced.

## Models

- **Daily (1d / 1w / 1m targets), 11 features:** Brent momentum (1d/5d/21d), realized vol (21d), DXY 5d return, OVX level + 5d change, WTI−Brent spread level + 5d change, EIA weekly stocks Δ + 52-week z-score. Ridge (λ picked on each training window's tail) + random forest (24 trees, depth 5, rolling ~5y).
- **Intraday (15m / 1h targets):** ridge on bar momentum (1/4/16 bars) + rolling 32-bar vol.
- **Walk-forward:** first 60% seeds, retrain on a schedule, predictions strictly out-of-sample; label causality is index-based (a 5-bar forward return only enters training 5 bars later) so the same engine runs any bar frequency. 5d/21d scored on non-overlapping windows.
- **Costs:** backtests report `sharpeNet` alongside gross — sign-strategy P&L charged 3bps/side on every position change (conservative for Brent CFD spread). Decisions use the net number.
- **Honesty rules** (from the CrudeSignal PRD): dead-zone calls display flat; Lean/Moderate/Strong buckets carry realized OOS hit rates; the scorecard prints hit rate *next to the base rate* so a coin-flip model can't hide.

Honest result (2016→2026): daily horizons ≈ coin flip (hit ≈ base, IC ≈ 0); intraday shows a faint momentum tilt (1h: +1.7pts over base, IC 0.06 — below the "proven edge" bar). The research loop's locked holdout (2024-07→2026) sharpened this: the baseline **fails the kill bar on every horizon**, the 1h tilt dies net of costs, and the first three candidate feature families (WPSR fundamentals, SPR flow, COT positioning) were killed on the tune window without spending a holdout look. Matches the literature and the original brief's warning. The dashboard's real value: honest ranges, news-aware widening, fundamentals at a glance, and a no-lookahead rig that makes failed ideas cheap.

## Architecture

```
server.js             express: /api/dashboard, /api/price, /api/config, /api/refresh
lib/env.js            minimal .env loader (PARALLEL / OPENROUTER / CAPITAL_* keys)
lib/fetchers.js       Yahoo (daily+intraday), EIA workbooks (any weekly series),
                      CFTC COT (Socrata) — disk cache (data/)
lib/capital.js        Capital.com CFD session + OIL_BRENT snapshot (live spot)
lib/data.js           as-of joins, release-lag alignment, daily + intraday features
lib/news.js           Parallel Search + RSS lanes, keyword scoring, tape state
lib/llm.js            OpenRouter batch scoring (configurable model, JSON contract)
lib/targets.js        price-target assembly (model μ ± vol σ × news factor)
lib/model.js          ridge, forest, walk-forward, metrics (incl. cost-aware
                      Sharpe), bucket calibration
lib/model-worker.js   worker-thread wrapper (training never blocks HTTP)
public/               vanilla JS + Chart.js (vendored), light/dark tokens
scripts/smoke.js      CLI smoke test
scripts/research.js   research runner: tune trials, one-shot holdout, noise bar
RESEARCH.md           research protocol: holdout law, kill bar, backlog, results
research/journal.jsonl  append-only trial journal (committed)
CLAUDE.md             agent guardrails (sandbox, causality, no live trading)
```

## Research backlog

Lives in `RESEARCH.md` (single source of truth) with per-trial results in the
journal. Current top: term structure (blocked on curve-history data), event
flags, Friday-to-Friday weekly model. Still open from the PRD: the live
prediction journal ("signal journal is the moat") — log every live call with
inputs and score against realized returns; that one is product work, not a
model trial.
