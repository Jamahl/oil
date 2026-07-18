# Research protocol — the autoresearch loop

Automated feature research for the CrudeSignal Lab models: an agent (or human)
implements a candidate feature, scores it with `scripts/research.js`, and the
journal + holdout discipline below decides what survives. The loop exists to burn
through the feature backlog faster — it cannot create signal that isn't there,
and without these rules a search loop **manufactures fake edge by selection**
(best-of-N on noise). The rules are the product.

## The law

1. **Locked holdout.** Trials see the tune window only.
   - Daily horizons (`fwd1`/`fwd5`/`fwd21`): tune < **2024-07-01**, holdout ≥ 2024-07-01.
   - 1h: tune < **2026-01-15**, holdout ≥ 2026-01-15 (730d rolling feed — window
     shrinks over time; revisit the boundary when bars age out).
   - 15m is excluded from formal research (60d of data, rolling — nothing to lock).
   - The runner also nulls any tune-row label whose forward window crosses the
     boundary, so no holdout price ever leaks into a tune label.
2. **One-shot holdout.** `holdout <trialId>` runs once per candidate. KILL is
   final for that candidate family — iterate on the tune window, never re-roll
   holdout until the candidate is materially different (new feature, not a retune).
   The runner refuses duplicate holdout runs; total holdout count is printed
   because every look leaks.
3. **Kill bar (pre-declared, in `research.js`):** holdout IC ≥ 0.03 **and**
   hit-rate edge ≥ +2pts over base **and** Sharpe net of costs > 0. All three or KILL.
4. **Every run is journaled** to `research/journal.jsonl` (append-only, committed).
   Trial count is the multiple-comparisons denominator — after N trials, compare
   the best tune IC against `research.js noise` (best-of-N |IC| on label-shifted
   data). If the real best doesn't clearly beat the noise best, it's selection, not signal.
5. **Costs are on by default** (3bps/side, conservative for Brent CFD spread).
   `sharpeNoCosts` stays for continuity; decisions use `sharpeNet`.
6. **Hourly/live feedback is monitoring, not training signal.** New bars arrive
   ~24/day against ~17k history — chasing recent hits is micro-regime overfitting.
   Research reruns on full history (weekly/monthly cadence); the prediction
   journal (README idea #5) watches live decay.

## Loop cadence (agent workflow)

```
pick candidate from backlog (README "Ideas for next")
  -> implement feature in lib/data.js (+ fetcher in lib/fetchers.js if new series)
  -> node scripts/research.js trial --desc "cushing stocks z-score, as-of release date"
  -> compare vs baseline t001 + noise bar; iterate or kill
  -> only if tune says clearly better AND idea is fundamentals-grounded:
       node scripts/research.js holdout tNNN   (one shot)
  -> PROMOTE -> feature ships to the dashboard models; KILL -> journal why, next candidate
```

Causality rules for new features (non-negotiable, README has precedent): join on
**release/availability date** not period date (EIA pattern in `lib/data.js`),
as-of joins only, no same-bar future info. A feature that needs a lookahead to
work is a bug, not an edge.

## Sandbox (for automated loop runs)

- May edit: `lib/data.js`, `lib/model.js`, `lib/fetchers.js`, `scripts/`.
- Never: `lib/capital.js`, `.env`, anything credential-bearing; never any
  live-trading surface. Live trading is human-only, always.
- Worktree-isolate experiments; the journal is the shared state.

## Current state

- `t001` = baseline (11 daily features, ridge) — the comparator every candidate
  must beat. Holdout-scored once as the reference point.
- Backlog priority (expected value order, from README): term structure (M1−M2,
  M1−M6) > EIA extras (Cushing, products, runs) + surprise-vs-consensus > CFTC
  COT > event flags.
