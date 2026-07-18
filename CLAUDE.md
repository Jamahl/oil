# CrudeSignal Lab — agent notes

Oil-price target dashboard + model research lab. Architecture and data feeds: `README.md`.

## Model research

All feature/model experiments follow `RESEARCH.md` — non-negotiable points:

- Score with `npm run research -- trial --desc "..."` (tune window only).
- Holdout is locked (daily ≥ 2024-07-01, 1h ≥ 2026-01-15) and one-shot per
  candidate via `research.js holdout <id>`. Never evaluate on holdout ad hoc.
- Every run journals to `research/journal.jsonl` — append-only, keep it committed.
- Causality: features join on release/availability date (see EIA pattern in
  `lib/data.js`). No lookahead, ever.

## Hard rules

- Never touch `lib/capital.js` credentials flow or `.env` (live Capital.com keys).
- Nothing in this repo auto-trades. Live trading is human-only, always.
- Honesty rules from the README stand: hit rate prints next to base rate,
  dead-zone calls display flat, coin-flip models don't get to hide.
