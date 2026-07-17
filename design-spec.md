# CrudeSignal Lab — Design Handoff Spec

For the designer taking over visual/UX design. The app is live at `localhost:4173` (`npm start`), one page, no build step. Current implementation: `public/index.html`, `public/style.css` (all tokens at the top), `public/app.js` (rendering + poll loops). Reference screenshots: `~/.gstack/projects/magic-swift/designs/design-audit-20260717/screenshots/`.

## 1. Product & user

A single-user, realtime **Brent crude price-target dashboard for a scalp trader**. The user (the owner) glances at it dozens of times a day and decides in seconds: is the tape hot, which way is the lean, is the typical move big enough to pay the spread. Everything else on the page is supporting evidence. This is an internal instrument panel, not a product with visitors — **APP UI, not marketing**. Density is a feature; decoration is not.

The app's differentiator is **honesty**: every prediction it displays is logged, scored against the real price at maturity, and the results (shown in the journal) automatically correct the ranges. The design must make being wrong look normal and measurable, never hidden.

## 2. Design law (non-negotiable, inherited from the product's PRD)

1. **The range is the product; the arrow is context.** Bands/ranges always visually primary over directional leans.
2. **No naked confidence.** Any accuracy/confidence figure appears with its sample size and its base rate ("84% vs 69% coin flip, n=25"). If a model has no proven edge, the UI must not imply one.
3. **Dead zone = flat.** Weak calls render as "no lean", never as a small arrow.
4. **State the tape.** QUIET / ELEVATED / EVENT is always visible; a hot tape visibly widens ranges and demotes model leans.
5. **"Uncalibrated" labels stay** until the journal has scored enough history.
6. **Color never carries meaning alone** — every up/down/state is also a word or arrow.
7. Plain language over quant jargon everywhere a human reads (the journal card is the reference tone).

## 3. Glance hierarchy (what must be readable at each dwell time)

| Dwell | Must land | Current elements |
|---|---|---|
| 0.5 s | price, direction call, tape state | hero: price card · BUY/HOLD/SELL card · tape card |
| 5 s | six horizon targets + ranges, scalp viability | target cards row, scalp strip |
| 30 s | what's driving it | AI news read banner, headlines, curve KPI, signal components |
| reference | evidence & self-audit | charts, KPI row, prediction journal |

Page order today follows exactly this. A redesign may re-arrange within a dwell tier but not demote across tiers.

## 4. Current tokens (`public/style.css` top block)

**Themes:** light + dark, auto via `prefers-color-scheme`; every color is a CSS custom property; charts read tokens at render time via `getComputedStyle`.

| Role | Light | Dark |
|---|---|---|
| Page plane | `#f9f9f7` | `#0d0d0d` |
| Card surface | `#fcfcfb` | `#1a1a19` |
| Primary ink | `#0b0b0b` | `#ffffff` |
| Secondary ink | `#52514e` | `#c3c2b7` |
| Muted / labels | `#898781` | `#898781` |
| Hairline grid | `#e1e0d9` | `#2c2c2a` |
| Border | `rgba(0,0,0,.10)` | `rgba(255,255,255,.10)` |
| Accent / series-1 (Brent, brand) | `#2a78d6` | `#3987e5` |
| Series-2 (strategy/secondary) | `#1baf7a` | `#199e70` |
| Diverging poles (bull/bear marks) | blue `#2a78d6` / red `#e34948` | `#3987e5` / `#e66767` |
| Delta up / down (text) | `#006300` / `#d03b3b` | `#0ca30c` / `#e66767` |
| Status ok / warn / bad (dots) | `#0ca30c` / `#fab219` / `#d03b3b` | same |

Palette was machine-validated for CVD separation and contrast (both modes) — swaps must be re-validated, not eyeballed.

**Type:** system sans (`system-ui, -apple-system, "Segoe UI"`) — deliberate app-UI choice; replaceable only with a **vendored** typeface (no CDN — the app must run offline). Scale in use: 40px hero price / 34px signal word / 24px card values & h1 / 22px KPI / 13–14px body / 13px card titles (600) / 10.5–11px uppercase micro-labels (letter-spaced). `tabular-nums` mandatory on every live-updating number.

**Space & shape:** 12px section rhythm, 10px grid gaps, 14–16px card padding; radius 10px cards / 8px controls / 999px chips; borders are 1px hairlines, no shadows. Max width 1180px, single breakpoint at 900px (grids collapse to 1–2 cols).

## 5. Component inventory & states

Every component below already exists; states listed are all real and must survive a redesign.

**Hero price card** — live badge `LIVE CFD` (green) vs `delayed` (gray); price + bid/ask + %-today; updates every 5 s (no width jitter allowed).
**Signal card** — word BUY (green) / HOLD (muted) / SELL (red); bias meter −1…+1 with dead-zone center; confidence `Lean/Moderate/Strong (uncalibrated)`; 3 top components with ▲▼ and optional "(muted by journal)"; caveat line always present. Updates 15 s. This is the user's #1 element — currently emphasized with an accent border; a redesign may find a better device.
**Tape card** — QUIET (green dot) / ELEVATED (amber) / EVENT (red) + two-line explanation + lanes/score meta.
**Target cards ×6** (15m/30m/1h/1d/1w/1mo) — target price, range, lean chip (bull green / bear red / "— no lean"), optional edge line (only when a real edge exists), tooltip with bucket hit rate. Re-anchor to live spot every 5 s.
**Scalp strip** — verdict chip good/workable/poor (green/amber/red), spread $, typical 15m/30m move, move÷spread, hot-tape warning; placeholder state "waiting for first live tick…" (reserves height — no CLS).
**News card** — header source list; AI status chip (`AI on` green / `AI off` gray-or-red with reason tooltip); model-slug input + datalist + Apply (posts, re-scores); AI read banner (BULLISH/BEARISH/MIXED, accent-tinted); list of ≤18 items: score badge (3+ red-tint "hot", 1–2 amber "warm", 0 plain), title link, meta line (source · age · keyword tags · AI ▲bull/▼bear/—unclear · mat 2/3 · "rehash"). Internal scroll ~600px; empty state and AI-degraded state exist.
**Charts ×4** (Chart.js, canvas) — 15m intraday, 2y daily, EIA stocks (line + diverging Δ bars + HTML legend), all obey: one axis, hairline grid, 2px lines, no point markers, index-mode tooltips, colors from tokens, re-render on theme flip.
**KPI row** — WTI, spread, DXY, OVX, crude stocks (build/draw), Brent curve M1−M2 (backwardation/contango + tilt sentence).
**Prediction journal** — intro sentence with totals; per-horizon rows: name + learning progress bar + scored/waiting, Ranges sentence with status color, Arrows sentence with verdict, Self-correction sentence (shadow vs active wording is load-bearing); BUY/SELL track-record row (tinted); "AI review of the journal" button → returns a short markdown analysis (needs a display treatment — currently a tinted box).
**Chrome** — data-health chip (data OK / N stale / N down), Refresh button, status banner (info + error variants).

## 6. Live-data choreography (design constraint, not implementation detail)

| Cadence | What changes | Design rule |
|---|---|---|
| 5 s | spot, bid/ask, %-today, all 6 target prices, scalp numbers | numbers may tick; layout may not move (tabular-nums, fixed-width containers) |
| 15 s | signal word/bias/components | word change is the biggest allowed visual event on the page |
| 5 min | news list, tape state, journal rows | list reorders; tape color can flip — the EVENT→QUIET transition should be noticeable but not alarming |
| on demand | Refresh (full refetch ~10s), model Apply, AI journal review | need working/disabled states (exist) |

No entrance animations exist; motion budget if added: state changes only, 150–300ms, `prefers-reduced-motion` respected, never animate layout properties.

## 7. Accessibility floor (already met — do not regress)

Both themes; validated contrast; `:focus-visible` accent ring on all controls; color+word/arrow pairing everywhere; links padded ≥20px targets (44px where feasible); table/text alternatives for chart data exist in cards; no `outline: none`.

## 8. What's fixed vs. open for the designer

**Fixed:** the data semantics and states above; honesty copy rules (§2); glance hierarchy tiers (§3); both themes; offline/self-contained (vendored assets only); single page; canvas charting (Chart.js or equivalent); the journal's plain-language tone.
**Open:** entire visual language (color system — if re-validated, type — if vendored, shape, elevation), layout and grouping within tiers, a top-strip "focus mode" for scalping, in-page navigation/anchors if the page grows, chart styling within the mark rules, motion (per §6), mobile-first rework (current mobile is competent stacking, not designed), the AI-review output presentation, empty/loading skeletons.

## 9. Known design debt (from the 2026-07-17 audit — report alongside screenshots)

- Dark mode is token-correct but has never had a human visual pass.
- News meta line wraps awkwardly on <380px screens.
- Journal on mobile is long; could collapse to a summary + expandable rows.
- Heading scale is flat (24px h1 → 13px card titles, nothing between) — acceptable for density, but a redesign could earn a middle step.
- No skeleton states — first load shows a text status banner while charts pop in (~1s).

## 10. Handoff asks

1. Visual direction (moodboard/comps) for hero+targets+scalp tier first — that's 90% of user dwell.
2. Redlines for the components in §5 in both themes, with the states enumerated there.
3. Any new palette delivered as the token table in §4 (we re-run the contrast/CVD validator on it).
4. Mobile-first pass for the 0.5s/5s tiers.
5. Figma or HTML — either is fine; the implementation side is one CSS file with tokens at the top.
