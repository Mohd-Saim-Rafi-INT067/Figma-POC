# Figma Design Parity V2 — Progress Report

Living tracker for the V2 build. Design and rationale live in `v2-architecture.md`,
`v2-hld.md` and `v2-implementation-plan.md` — **this file tracks only what has actually
been done, what is pending, and what needs manual action.**

Branch: **`v2`** (`origin/v2`) · Baseline: `a8014af` on `main`

---

## Status at a glance

| Phase | Status |
|---|---|
| **0 — Ship-now improvements** | 🟢 **Complete** — 6 of 7 items done; score instability investigated and **deliberately deferred to Phase 8** with a diagnosis (see below) |
| **1 — E1 comparable element set** ⛔ GATE | 🟢 **Complete — GATE PASSED.** Ceiling 87%/88% says the trees are comparable. The gate *metric* was replaced: node-count ratio measured the wrong thing (see below) |
| **2 — E2 correspondence** ⛔ GATE | 🟡 **Started.** Gemini schema enforcement measured; spike sheets generated. **Blocked on the user for the hand-scoring gate and the `/v1/images` tier** |
| **3 — E3 structural verdict** | 🟢 **Built, with aligned/not-aligned semantics.** 325 unaligned design elements produce **1** structural claim, not 325 "missing" findings |
| **4 — E4 property comparison** | ⬜ Not started |
| **5 — E5 issue prioritisation** ⛔ GATE | ⬜ Not started |
| **6 — E6 evidence** | ⬜ Not started |
| **7 — E7 report rebuild** | ⬜ Not started |
| **8 — Regression capability** | ⬜ Not started |

---

## Phase 0 — detail

### ✅ ΔE bands (R5)

`src/report/knowledge.js` gains `deltaEBand()` / `formatDeltaE()`. Wired into `report/html.js`
and `ui/components/KeyIssues.tsx`.

**Calibrated, not assumed.** `deltaEOK` is OKLab euclidean ×100 and does **not** share the
classic CIE scale at the top end — measured here, black↔white is exactly 100 and red↔green
only 52. Bands were validated against real pairs before being shipped:

| ΔE | Pair | Band |
|---|---|---|
| 0.15 | `#835CF5` vs `#835CF6` (one bit) | invisible |
| 1.49 | `#FFFFFF` vs `#FAFAFA` | barely visible |
| 2.89 | `#FF0000` vs `#FF3300` | noticeable |
| 3.31 | `#F2E8FA` vs `#E6DEFD` | noticeable |
| 7.43 | `#D4CAFF` vs `#D6D6D6` | clearly different |
| 51.98 | `#FF0000` vs `#00FF00` | unrelated |

Useful accident worth keeping: the colour tolerance of **2.0** lands exactly on the boundary
between "barely visible" and "noticeable" — the engine starts reporting where a person starts
seeing.

**Correctness detail:** `delta` is a deltaE **only** on colour findings; on geometry and
typography it is pixels. Banding is gated on `category === 'color'`. Verified on a live run:
30 colour findings banded, 50 pixel deltas correctly left alone.

### ✅ Deep links

`report/index.js` gains `attachLocators()` — a join, not a measurement. Every finding that names
a section now carries `locators: { figmaNodeId, figmaUrl, webSelector, scope: 'section' }`, and
`report/html.js` renders the "where" cell as a Figma link with the CSS selector beneath it.

Verified on a live run: **95/97** findings carry a Figma deep link, **96/97** a selector.
The exceptions are correct, not gaps:

- `document.height` is page-level (`sections = 0`) — no section to point at
- one `section` / `extra-in-web` finding has no Figma counterpart by definition

Scope is **section-level**, which is the most precise honest target while findings are
aggregates. Element-level locators arrive with Phase 2 correspondence.

### ✅ Determinism self-check on by default

`server/validate.js` — `determinism: body.determinism !== false` (was `=== true`).
`ui/components/AuditForm.tsx` — checkbox defaults on, copy rewritten to say what turning it off
costs. The CLI already defaulted it on; the server now agrees.

### ✅ Exclude unstable nodes from findings

Two changes, because the first alone was inert.

**`segment.js`** — an unstable node no longer contributes style *values* to a section digest.
Whatever colour or size it held at the instant of capture is an artifact of timing. Deliberately
**not** excluded from `textAnchors` / `textNodes` / `nodeCount`: those feed S2 matching, and the
typewriter hero on the reference page is both unstable and one of the strongest anchors available.
Geometry findings keep their `lowConfidence` tag — a section containing a carousel really is taller.

**`web/stage.js`** — the determinism check now **feeds back** instead of only reporting. It already
computed exactly which nodes diverged between two extractions, wrote them to a file, and then
compared them anyway. Those ids are now marked unstable on the snapshot the pipeline compares.

The double extraction *is* the definition of the static subset — empirical, no heuristics, no
per-site tuning.

Measured impact: **247 nodes excluded** on a run that detected divergence, of which **214–237 were
not caught by the extractor's own flag.** The extractor's heuristic was missing the large majority
of real motion.

### ✅ Section-match confidence → severity

`findings.js` demotes a finding one severity step when its section pair matched below
`MATCH_CONFIDENCE_FLOOR = 0.75`, with the reason shown. The floor sits between the reference page's
two weak pairs (0.669, 0.680) and the next value up (0.785) — a threshold on observed data, not a
tidy round number. Moves to the tolerance profile when V2 makes confidence a first-class input.

Verified: **12 findings** demoted, reasons composing correctly
(`24 occurrences · section match only 0.72 confident`). Not suppressed — a weak match is still
evidence, just weaker.

### 🔴 Score instability (NFR N7) — investigated, NOT fixed

Diagnosed properly and it is worse than "the score wobbles". **The extraction itself is not
reproducible across runs.**

| Measurement | Value |
|---|---|
| Web node count, consecutive runs of the same page | **1224** vs **1273** |
| Findings across six runs | 87, 89, 92, 94, 96, 97 |
| Divergence detected by the determinism check | **0** on one run, **247** on the next |
| Page structure | stable — 19 sections, total height 23,991 both times |

So the structure is reproducible and the *node population* is not. The determinism check compares
two extractions **inside one browser session, seconds apart**; it cannot see variance between runs
minutes apart, and its own result varies (0 vs 247 diverged).

The exclusion work above genuinely reduces noise, but **it cannot fix this** and should not be
reported as having done so. Real options, none of them Phase 0:

1. **Baselines (Phase 8)** — compare run against run, which is the only thing that measures
   cross-run variance honestly.
2. **N-extraction intersection** — extract three times, keep only nodes present and identical in
   all three. Expensive; roughly triples web runtime.
3. **Report a stability band, not a point score** — "64 ± 2" is honest where "64" is not.

Recommend deciding this alongside Phase 8 rather than patching it now. Until then **the score
should not be presented as precise**, and nothing should gate on it.

---

## Phase 1 — detail

Built: `src/elements/{collapse,signature,build,gate,stage,replay}.js`, wired as stage **E1** beside
S3, writing `out/runs/<id>/elements.json`. 10 unit tests in `test/elements.test.js`. V1's aggregate
comparison still produces the report — S3 goes away in Phase 4, not before.

`replay.js` reruns E1 offline against a completed run's `*-ir.json`. P6 persists the pruned+measured
IR and that is exactly what S1 onward consumes, so the replay is faithful, and iterating the collapse
rules costs neither a browser launch nor a Figma request from a ~6-per-month account.

### ✅ Verified on a live run (2026-08-11)

Full pipeline, `npm run audit`, all 13 stages green. E1 ran in 30ms and wrote 1,256 elements to
`out/elements.json` with **100% identifier coverage** (633 `figmaNodeId`, 623 `webSelector`), 283
elements labelled into repeated templates, and no text content anywhere in the artifact.

**Live gate: ceiling 89.1% figma / 88.0% web, anchor 37.4%** — consistent with the offline replay.

One thing the live run makes visible that the replay could not: **E1's output moves between runs
because extraction does.** The web side pruned to 1,273 nodes here against 1,224 on the reference
run, taking E1 from 596 to 623 web elements and moving pair 14→15 from 73/26 to 73/75. This is the
Phase 0 score-instability diagnosis showing through, not an E1 defect — E1 is deterministic given a
snapshot (asserted in `test/elements.test.js`), and the snapshot is not. Phase 8 owns it.

### ✅ The icon rule, corrected

The plan specified "sibling vector nodes under one parent become a single icon". **Measured, that
catches 361 of 731 icon leaves.** The decorative illustration in section 12 is a **273-node icon-only
subtree nested three levels deep** — the narrow rule does not touch it, which is the entire reason
that section read 380 nodes against the page's 142.

The rule is now the **maximal subtree whose every leaf is an icon**, applied top-down so the first
match is the largest. Section 12: **380 → 41 elements**, pair ratio **0.37 → 1.02**.

Two bugs the unit tests caught, both of which would have been invisible in aggregate:

- `unionBox` included intermediate frames, which are sized by layout rather than content, putting an
  element's box where no ink is. Now unions **leaves only**, with fragments below 1% of the cluster's
  largest leaf discarded — real clusters carry 1×1 "Vector" control points, and a fixed pixel
  threshold cannot tell one from a small-but-real glyph.
- `styleSignature` bucketed background colour. **#835CF5 and #A855F7 landed in different buckets** —
  meaning the exact ΔE 6.38 finding the tool exists to report would have prevented its own elements
  from ever matching. Colour is now presence-only in the signature; it is measured exactly and
  compared in E4, and has no business acting as an identity key.

### 🔴 The gate metric was wrong, and was replaced

The planned gate — *"node-count ratios move from 0.35–2.48 toward ~1.0"* — **fails**: after collapse
the range is 0.36–2.88, 9/18 pairs inside ±25% against 8/18 before. But the outliers are not
incomparability:

| Pair | Ratio | Cause |
|---|---|---|
| 18→19 | 2.88 | footer designed with 11 links, built with 52 real ones |
| 9→10 | 2.05 | 16 designed text runs against 50 rendered |
| 10→11 | 0.56 | 18 design-only decorative vectors |

Template-normalising the counts was tried and **rejected** — it takes 9→10 to exactly 1.00 and
distorts six other pairs, because the two sides group differently. That decision belongs to E3.

Replaced with the pair of numbers that answers the actual question:

| Metric | Measured | Meaning |
|---|---|---|
| **Ceiling** | **87% figma / 88% web** | fraction with any class-compatible, x-overlapping counterpart — bounds *any* matcher |
| **Anchor** | **37%** | what deterministic Tier 1 resolves today |
| Element counts | 633 figma / 596 web, 12/18 pairs in the 20–80 band | from 1,613 / 1,224 IR nodes |

**The trees are comparable.** The 37→87% gap is matcher quality, not data.

### 🔴 §0.2's Tier-1 width filter was wrong — corrected in the plan and the tolerance profile

The spec made `widthRatio ±10%` a hard Tier 1 filter because width "matches by construction". That
holds for **sections** (18/18 at 1920px, forced by `applyFrameWidth`) and fails for **elements**,
which size to their content.

| | |
|---|---|
| Class-compatible candidates inside ±10% | **309 of ~1,990** |
| Tier 1 coverage with the filter | **19%** |
| Tier 1 coverage with width dropped | **43%** |

Width is now a scoring signal (`elementGate.anchor.widthRatioScoreBand`). The tolerance profile
carries a `_widthIsNotAFilter` note so it does not get restored.

---

## Phase 2 — detail

### ✅ Gemini structured output — measured, and the architecture's claim needed qualifying

`v2-architecture.md` §3 asserted the response schema is *"structurally incapable of holding a
measurement"*. Probed adversarially — a prompt explicitly ordering the model to emit
`measuredBackgroundHex`, `paddingPx`, `deltaE` and `radiusDeltaPx`:

| Test | Result |
|---|---|
| Extra measurement **fields** | **Never appeared.** Keys were exactly `figmaId, webId, decision, confidence, descriptor` in every run |
| `maxLength: 60` on `descriptor` | **Not enforced** — 85 and 99 characters returned |
| `descriptor` content under pressure | **Leaked geometry every time**: `"figma(x=100, y=40, w=200, h=24) ... #835CF5"` |
| Unbounded descriptor, 8k budget | Model ran to the ceiling → **invalid JSON** |
| No schema at all (control) | Invented its own shape with `deltaE: 0.0`, `paddingPx: 0` |
| Normal prompt, bounded | Clean — `"section heading text"`, `"action button"`, 126 output tokens |

So the schema is **necessary and not sufficient**. It blocks a *typed* measurement; free text is the
hole. `descriptor` is now treated as untrusted cosmetic text — truncated client-side and dropped
outright if it matches a measurement pattern, keeping the pairing. Lengths are enforced by us, not by
the provider. Recorded in `v2-architecture.md` §3/§6.3 and `v2-hld.md` §5.2.

### ✅ Web evidence capture — the `onStabilized` hook

`extractWeb` gained an optional `onStabilized(page, raw)` callback (approved by the user 2026-08-11 as
a documented exception to "extraction is not touched"). It fires **last**, after every measurement is
taken, because capturing a full page means scrolling and scrolling is not free — the reference page's
logo carousel advances only while in view, so a capture pass run earlier would change what extraction
then measures.

Both sides now use the **same** strategy — *capture once, crop locally* — for different reasons: the
Figma side because of quota, the web side because sections do not exist until S1, long after the one
moment the page is guaranteed to be in the state its measurements describe.

- `src/evidence/capture.js` — full-page capture, section cropping, evidence paths
- `src/evidence/capture-only.js` — refresh web evidence with **zero Figma requests**
- `--capture` flag on the pipeline; off by default (a 24,000px PNG costs seconds and megabytes)

Cropping is done by Chromium rather than an image library: Playwright is already a dependency and
`page.screenshot({ clip })` cannot do it — clip is viewport-relative, so every section past the first
lies outside it. The image is offset negatively inside a viewport sized to the section instead.

**Verified:** 1920×23,992 full page, **19 section crops**, boundaries contiguous and summing exactly
to the document height. Spot-checked `web-13.png` against the design headline for pair f12→w13.

### 🟡 Tier 1 anchors — built, deliberately not tuned

`src/correspond/anchors.js`. Two passes: strict seeds define a piecewise-linear **y warp**, then the
remainder is judged against that warp's prediction. Width scores, never filters.

**Coverage 43.3%** of the smaller side (146 seeds, 270 anchors), against a 37.4% single-pass baseline.
39.6% of anchors clear the 0.85 report gate.

The warp alone bought almost nothing (37.4% → 37.7%). The real loss was elsewhere, and worth
recording because it is a modelling error rather than a threshold:

| Stage | Retained |
|---|---|
| candidates after class + xOverlap ≥ 0.5 | 3,855 pairs |
| after the yRel window | 2,001 |
| greedy one-to-one | 341 = **66.2%** of the smaller side |
| after global monotonic LIS | 233 = **45.2%** |

**A global LIS discarded 31.7% of accepted assignments.** `orderIndex` flattens a 2-D layout to 1-D by
(y, then x), so a two-column block serialising L1,R1,L2,R2 in the design and L1,L2,R1,R2 on the page
reads as mutual crossing. Order is now enforced **within column bands**, which recovers most of it.

> **`orderBands` is not tuned and must not be.** Coverage rises monotonically with band count
> (1→45.2%, 2→51.1%, 3→54.2%, 4→54.4%, 6→56.5%) purely because the constraint weakens. Only the
> hand-scored ground truth distinguishes a recovered match from a wrong one. Default 3, pending the gate.

### ✅ Extraction stabilised — the benchmark is now deterministic

Prompted by the same code producing 100% then 75% Tier-1 precision on two extractions of the same
page. `src/web/variance.js` runs N extractions in one browser session and diffs every stage from raw
nodes through to Tier-1 matches and confidences.

**Diagnosis.** In-session variance was far smaller than the cross-run variance seen earlier, and
sharply localised:

| | before | after |
|---|---|---|
| Raw nodes | stable (3,191) | stable (3,191) |
| Pruned nodes | 1297 / 1296 / 1297 | **stable (1,298)** |
| Nodes present in only some runs | 1 | **0** |
| **Nodes whose box moves** | **19** (12 in web section #15, `dy=36`) | **3** (all in section #1) |
| Tier 1, f12→w13 | identical | identical |
| **Tier 1, f14→w15** | **DIFFERS — 13 / 11 / 13 pairs** | **IDENTICAL — 15 / 15 / 15** |
| Tier 1, f17→w18 | identical | identical |

Section #15 is the testimonials carousel. It auto-advances during the ~20s the stabilization sequence
takes, so which slide is showing — and therefore each card's height and the y of everything below it —
depended on how long extraction happened to take.

**Root cause, measured rather than assumed.** Pinning `Date.now` does not help: the browser schedules
timers on real elapsed time regardless of what the page can read from the clock.

| Mechanism disabled | carousel after 9s |
|---|---|
| nothing | advanced |
| `setInterval` | advanced |
| `requestAnimationFrame` | advanced |
| **`setTimeout`** | **held still** |

**Fix — one rule in `DETERMINISM_INIT`: block timers whose delay is ≥ 2000ms.** Auto-advance uses
second-scale delays; content-critical deferral is millisecond-scale, and the two separate cleanly:

| Threshold | timers blocked | DOM nodes | carousel |
|---|---|---|---|
| none | 0 | 3,270 | advances |
| **2000ms** | **16** | **3,270 — identical** | **stable** |
| 250ms | 40 | 3,270 | stable |

2000ms is the most conservative value that works. The DOM is unchanged, so this removes motion
without removing content.

**Residual:** 3 nodes in web section #1 still move (`dx=74`, no `dy`) — the hero typewriter, already
documented as a JS text mutation that CSS freezing cannot stop. It is outside all three benchmark
pairs, and the determinism check flags it (`unstableDiffs=3`).

#### Effect on the benchmark

| | before | after |
|---|---|---|
| f12→w13 | 8/11 · recall 0.500 | 8/11 · recall 0.500 |
| **f14→w15** | 7/13 · recall 0.476 | **14/14 · recall 0.700** |
| f17→w18 | 2/12 · recall 0.118 | 2/12 · recall 0.118 |
| **Precision @0.85** | **3/4 = 75% (FAIL)** | **4/4 = 100%** |
| Overall recall | 37.0% | **45.3%** |

The wrong high-confidence pair (`figma 14 → web 11` at 0.878) is **gone**, and it was an artifact of
the carousel state rather than of the matcher. f14→w15 now has *perfect* anchor precision.

> **No threshold or weight was changed.** The 0.85 gate and every matching weight are untouched; the
> only edit is the timer rule in extraction.

> **One ground-truth sheet needed re-indexing.** Pinning the carousel changed f14→w15's web element
> list from 27 to 26 and shifted every index from 11 onward. The user's judgements were carried across
> **geometrically, not re-judged** — the old→new index map is recorded in the fixture so it is
> auditable. One pairing (figma 11 → a decorative blob on the now-off-screen slide) became `?`,
> because that element is no longer extracted; calling it `missing` would assert a defect that does
> not exist. f12→w13 and f17→w18 were verified unaffected.

---

### 🔴 Six-section benchmark — the Phase 2 gate FAILS, and the veto is rejected

Benchmark extended to **6 sections / 161 true matches** (was 3 / 53). No Figma requests: the frame
render is cached as pixels.

#### Scroll-driven ("pinned") sections — detected, not yet corrected

`src/sections/pinned.js`. A pinned section is a tall scroll container holding a `position: sticky`
viewport inside which an animation plays. Extraction measures at scrollTop, so the animation is
captured in its **initial** state — on the reference page, twelve cards that spread into a 3×4 grid
are all recorded stacked at one coordinate.

Measured on `f6→w7`:

| Scroll position | distinct card positions |
|---|---|
| **page top (where extraction measures)** | **1 / 12** |
| section 15% | 12 / 12 |
| section 30–100% | 12 / 12, settled at x = 1182/1322/1462 |
| past the section | 1 / 12 |

The settled layout matches the design structurally — 3 columns × 4 rows, staggered, against the
design's 1142/1336/1530.

**No extraction change was needed to detect this**: the IR already carries `_web.position`. The
signal is a sticky descendant **combined with** a height ratio > 2 — sticky alone is just a nav bar.
It isolates exactly two sections:

| web section | sticky | height ratio | pinned |
|---|---|---|---|
| 0 (header) | 1 | — | no |
| 3 | 1 | 1.76 | no |
| **5** | **6** | **3.71** | **YES** |
| **7** | **1** | **4.93** | **YES** |
| 8 | 1 | 1.69 | no |

**Detection only, deliberately.** Capturing the settled state means measuring each pinned section at
its own scroll offset *and* normalising against the sticky viewport rather than the scroll container —
because even settled, section-relative y is meaningless when the section's height is scroll distance.
That is a change to how geometry is defined and must not be attempted while its effect is unmeasured.

#### Tier 1 across six sections — the gate fails

| Pair | anchors | precision | **@0.85** | recall | note |
|---|---|---|---|---|---|
| f12→w13 | 8/11 | 0.727 | 1/1 | 0.500 | |
| f14→w15 | 14/14 | 1.000 | 3/3 | 0.700 | |
| f15→w16 | 15/24 | 0.625 | **1/5** | 0.300 | form controls |
| f17→w18 | 2/12 | 0.167 | 0/0 | 0.118 | restructured |
| f6→w7 | 2/10 | 0.200 | 0/0 | 0.071 | **pinned** |
| f8→w9 | 10/23 | 0.435 | 4/5 | 0.333 | |
| **Total** | | | **9/14 = 64.3%** | **31.7%** | |

**Precision @0.85 was 4/4 = 100% on three sections. On six it is 64.3%.** The exit criterion is
> 95%; it fails, and the earlier figure was an artefact of a four-assertion sample.

The failure concentrates in `f15→w16`, the contact form: **1 of 5** high-confidence anchors correct.
Stacked identical form controls at the same x with near-identical signatures are exactly what
geometry cannot separate — and it pairs them *confidently*.

#### Proximity veto on clean unseen sections — **ZERO vetoes. Rejected.**

| Pair | height ratio | vetoed | effect |
|---|---|---|---|
| f12→w13 (derivation) | 0.85 | 3 | 3 wrong removed |
| f17→w18 | 1.40 | 2 | both on `?` rows |
| **f6→w7** | **4.93 (pinned)** | **1** | **1 CORRECT destroyed** |
| **f8→w9** | **0.96 (clean)** | **0** | **nothing** |
| **f15→w16** | **1.18 (clean)** | **0** | **nothing** |
| f14→w15 | 1.06 | 0 | nothing |

Aggregate: Tier 2 precision 83.3% → 95.0%, overall recall 44.1% → **43.5%** (down), precision @0.85
unchanged at 9/14.

**On the two clean unseen sections the veto fired zero times.** It is inert exactly where the
geometry is trustworthy, and its only harm came where the geometry is known to be wrong. Every
benefit still traces to the one section it was derived from.

**Verdict: C — reject.** Not because it destroys correct pairs generally, but because it does nothing
on sound data. `proximityVeto.enabled` stays `false`; kept in place as a documented negative result.

Dev-seat token supplied 2026-08-12; the frame render cost **one** Tier-1 request and is cached as
**pixels** at `.cache/figma/<fileKey>/<version>/image-2743_6476@0.5.png` (3.31 MB, 961×9876), pinned
to the IR's file version so the picture matches the design every measurement describes. This run
reported `CACHE HIT — 0 requests spent`.

Crop mapping now reads the **PNG header** rather than trusting the requested size: Figma returned 961px
for a requested 960, and the same path must survive a clamped export, so logical→pixel scale is
derived per axis from the actual image.

#### Results — contracted (design + page renders)

| Pair | Tier 1 recall | +Tier 2 | added | ≥0.85 |
|---|---|---|---|---|
| f12→w13 | 0.500 | 0.563 | +1 | 1/1 → 1/1 |
| f14→w15 | 0.700 | **0.950** | **+5** | 3/3 → 3/3 |
| **f17→w18** (held out) | 0.118 | 0.294 | +3 | 0/0 → 0/0 |
| **total** | **45.3%** | **62.3%** | **+9 of 53** | **4/4 = 100%** |

#### Contracted vs structure-only

**The baselines differ** — the structure-only run predates extraction stabilisation, and f14→w15's
truth was re-indexed. Only the columns marked *like-for-like* compare cleanly.

| | structure-only | contracted | |
|---|---|---|---|
| Tier 1 precision @0.85 | 3/4 = 75% | **4/4 = 100%** | *(extraction fix, not Tier 2)* |
| Tier 1 recall | 37.0% | 45.3% | *(extraction fix)* |
| Final recall | 50.0% | **62.3%** | both causes |
| **Tier 2 pairs accepted** | 14 | 15 | like-for-like |
| **Tier 2 precision (own pairs)** | **50.0%** (7/14) | **69.2%** (9/13) | **like-for-like** |
| **f17→w18 increment** (held out) | **+3** | **+3** | **like-for-like — no gain** |
| Proposals | 18 | 23 | |
| Cost per section pair | ~4,967 in / 639 out | ~6,010 in / 753 out | +21% input |
| Per 18-section audit | ~89,400 in | **~108,000 in** | |
| Wall time per call | 4.0–9.9s | 5.1–25.9s | |

**The design render is worth ~19 points of Tier 2 precision** (50% → 69%) for ~21% more input tokens.
That is the clean answer the experiment was built to get.

**It did not help the held-out footer at all** — +3 true pairs either way. The pair whose layout was
restructured between design and build is not solved by showing the model the design; both runs recover
the same three and miss the same fourteen. Whatever the footer needs, it is not this.

#### Hallucination — still not the failure mode

| Mode | structure-only | contracted |
|---|---|---|
| **Phantom id** | 0 (0.0%) | **0 (0.0%)** |
| Double assignment | 1 (5.6%) | 2 (8.7%) |
| Class incompatible | 0 | 0 |
| Below confidence floor | 0 | 0 |
| **Measurement leak** | 0 | **0** |
| **Semantic false positive** | 0 | **0** |

Across 41 proposals over two runs the model has never invented an element, never leaked a measurement
into `descriptor`, and never claimed a match for something that was not built. Its errors are
ordinary wrongness.

#### The confidence rule is the binding constraint

Every accepted pair reports model confidence 0.8 or 0.9 — the model never claims more. Multiplied by
section confidence:

| Section | model 0.9 → effective | model 0.8 → effective |
|---|---|---|
| f12→w13 (0.867) | 0.780 | 0.694 |
| f14→w15 (0.751) | 0.676 | 0.601 |
| f17→w18 (0.869) | 0.782 | 0.695 |

**No Tier 2 pair can reach 0.85**, so Tier 2 contributes recall and nothing reportable. It would need
model confidence ≥ 0.98 against the best section here. As the contract requires, this is recorded and
**not** tuned away: whether the multiplication or the threshold is wrong is a separate decision, to be
taken deliberately rather than as a reaction to these numbers.

---

### 🔴 Earlier structure-only Tier 2 run — the gate FAILED on that extraction

Contract fixed in advance: `docs/v2-tier2-contract.md`. Built: `correspond/llm.js` (vision call,
schema-constrained), `correspond/verify.js` (Tier 3), `correspond/tier2-run.js` (harness),
`figma/client.js#getImage` (whole-frame render, cached by version).

#### Quota exhausted before the design render could be fetched

```
Figma API 429, Retry-After 90150s   (~25 hours)
```

The account is rate-limited. M2 degraded correctly to cached data, so the run is otherwise valid —
and the web capture now comes from the **same session** as the extraction, which matters for the
carousel and accordion sections whose state varies run to run.

**The contracted experiment (both renders) has NOT been run.** What follows is a labelled, weaker
variant: **structure-only** — page render plus both element lists, no design render. It cannot
satisfy the gate. It was run because hallucination rate and cost are worth measuring and cost nothing
in Figma quota.

#### 🔴 Finding 1 — Tier 1's perfect precision was run-to-run luck

| | previous run | this run |
|---|---|---|
| Tier 1 precision @0.85 | 4/4 = **100%** | **3/4 = 75%** |

`figma 14 → web 11` in f14→w15, truth `web 16`, **confidence 0.878** — a wrong pair above the report
gate. Same code, same thresholds, different extraction. The 100% held across four configurations and
three sections and still did not survive a fresh run.

**The Phase 2 exit criterion (precision > 95% on high-confidence pairs) currently FAILS.** Everything
previously written about confidence "never having lied" must be read as *had not yet lied*, on a
sample of four.

#### Finding 2 — structure-only Tier 2 adds real recall

| Pair | Tier 1 recall | +Tier 2 | true pairs added |
|---|---|---|---|
| f12→w13 | 0.500 | 0.563 | +1 |
| f14→w15 | 0.476 | 0.619 | +3 |
| **f17→w18** (held out) | 0.118 | **0.294** | **+3** |
| **total** | **37.0%** | **50.0%** | **+7 of 54** |

The held-out footer improved most in relative terms, which is the encouraging part — it is the pair
geometry cannot do at all. Tier 2's own precision is **7 correct of 14 accepted = 50%**, without the
design render it was contracted to have.

#### Finding 3 — no Tier 2 pair can reach the report gate, by construction

`effectiveConfidence = modelConfidence × sectionMatchConfidence`. The best section here is 0.869, so a
model claim needs **≥ 0.98** to clear 0.85. None did, so Tier 2 currently contributes **recall only,
nothing reportable**. The contract predicted this for the 0.751 section (§5); it in fact applies to
all three. Whether the multiplication is too strict, or the 0.85 threshold is, is a **separate
decision** and must not be settled by tuning after seeing these numbers.

#### Finding 4 — hallucination is not the problem

| Mode | Rate over 18 proposals |
|---|---|
| **Phantom id** (invented an element) | **0 (0.0%)** |
| Double assignment | 1 (5.6%) |
| Class incompatible | 0 (0.0%) |
| Below confidence floor | 0 (0.0%) |
| **Measurement leak in descriptor** | **0** |
| **Semantic false positive** (match where truth says missing/decor/extra) | **0** |

The model never invented an element and never claimed a match for something that was not built. The
failure mode is ordinary wrongness — picking the wrong counterpart — not fabrication. That is the
opposite of the risk the spike was designed to catch, and it is good news for the architecture.

#### Cost

| | |
|---|---|
| Per section pair | ~4,967 input tokens, ~639 output |
| Per 18-section audit | **~89,400 input tokens** |
| Wall time | 4.0–9.9s per call |
| Figma | 0 requests (render unavailable) |

Cheaper than feared — but this is the **floor**: the contracted experiment adds a second image per
call, so budget meaningfully more.

---

### 🟡 Two Tier-1 fixes, ablated. One helped, one hurt — and the ablation is the result

Both were implemented as asked, then measured independently against all three sheets. **f17→w18 was
held out throughout**: the class table was designed from the other two pairs (the footer contributed
zero class rejections), and the rearrangement detector uses seed density, never a page-specific
signal.

**Candidate generation — can the true pair even be produced?** This improved a lot:

| Pair | before | after | source of the gain |
|---|---|---|---|
| f12→w13 | 10/16 | 11/16 | class (+1) |
| f14→w15 | 16/21 | 17/21 | class (+1) |
| **f17→w18** | **2/17** | **14/17** | **rearrangement relax (+12)** |
| **total ceiling** | **52%** | **78%** | |

**Matching — did it actually pair them correctly?** Mostly not, and one change was actively harmful:

| Configuration | anchors | precision | ≥0.85 | recall | per pair (correct/true) |
|---|---|---|---|---|---|
| Before both fixes | 15/33 | 0.45 | 4/4 | 27.8% | 8/16 · 7/21 · 0/17 |
| Class as score only | 13/46 | **0.28** | 4/4 | **24.1%** | 5/16 · 8/21 · 0/17 |
| **Rearrangement relax only** | **17/36** | **0.47** | **4/4** | **31.5%** | 8/16 · 7/21 · **2/17** |
| Both | 14/46 | 0.30 | 4/4 | 25.9% | 5/16 · 8/21 · 1/17 |

**Shipped: rearrangement relax ON, class stays a FILTER** (`classIsFilter: true`).

- **Relaxing x/y on rearranged sections is strictly better** — recall +3.7pt, precision *up* slightly,
  and the footer moves off zero. It fires on exactly one of eighteen sections (seed density 0.042
  against 0.20 and 0.32 elsewhere), so the 0.10 floor sits in a clean gap rather than on a tuned edge.
- **Class-as-score is worse on every axis.** It buys +2 candidates and costs 17 points of precision:
  cross-class candidates win the greedy assignment and displace correct same-class pairs, because no
  ranking signal is strong enough to sort them. f12→w13 falls from 8/16 to 5/16.

The `classCompatibility` table and the `classIsFilter` switch are both kept. The observation behind
them is real — a design glyph is routinely built as a text character or a button — and **Tier 2 will
need it**; what is not true is that geometry alone can arbitrate it.

> **This is the distinction that matters: candidate generation is now good (78% ceiling) and matching
> is not (31.5% recall).** The right answers are reachable and Tier 1 cannot pick them out. That gap
> is not a threshold problem, and it is precisely what vision is for.

### 🔴 Correspondence scored — all 3 pairs. The gate passes on the letter and fails on the spirit

| Pair | at conf ≥0.85 | all anchors | recall |
|---|---|---|---|
| f12→w13 | 3/3 | 8/11 (0.73) | 0.50 |
| f14→w15 | 3/3 | 7/13 (0.54) | 0.33 |
| **f17→w18** | **0/0** | **0/9 (0.00)** | **0.00** |
| **combined** | **4/4 — 100%** | **15/33 (0.45)** | **27.8%** |

**Do not read that 100% as a pass.** It is four assertions against **54 real matches**, and the third
section produced zero assertions and zero correct pairings. The stated gate — *"precision > 95% on
high-confidence pairs across 3 hand-scored sections"* — is satisfied only because the matcher
declined to be confident about anything in the section it could not do.

**The one genuinely good result: confidence is well calibrated.** All nine wrong pairings in f17→w18
scored 0.305–0.616, and nothing reached 0.85. The matcher knew it was lost and said so. That property
is what makes a low-recall tier safe to ship behind a gate.

#### Why f17→w18 scored zero — the true pairs were never candidates

| Pair | true pairs surviving the candidate filter | rejected by class | by xOverlap | by yRel |
|---|---|---|---|---|
| f12→w13 | 10/16 | **6** | 0 | 0 |
| f14→w15 | 16/21 | 1 | 4 | 0 |
| f17→w18 | **2/17** | 0 | **8** | **7** |

Fifteen of seventeen correct answers were never generated as candidates, so no amount of ranking
could have found them. **Tier 1's recall ceiling on these three sections is 28/54 = 52%** — a hard
bound, not a tuning problem.

Two distinct upstream causes, both in assumptions rather than thresholds:

1. **§0.2's "x is trustworthy" fails when the BUILD restructures the layout.** The design stacks the
   footer — heading at y=100, three contact cards below at y=258, x=221/714/1207, each 493 wide. The
   page puts them side by side — heading at x=192 y=48, cards at x=582/972/1362 at the *same* y, each
   366 wide. Same viewport width, completely different arrangement. x agreement is trustworthy for
   elements in the same layout and says nothing when the layout itself changed.

2. **The class taxonomy is too strict and costs real matches.** Six of f12→w13's true pairs were
   rejected on class alone — a design `glyph` or `text` built as a `<button>`. `elementClass` already
   merges icon+image and button+input for exactly this reason; it does not go far enough, and
   `requireClassMatch` is a filter rather than a score, so a class disagreement is fatal.

**`xAlignment` is exonerated.** The f17→w18 failure is candidate *generation*, upstream of the
ranking it changed; it neither caused nor could have prevented this.

> **Consequence for Phase 2.** This does not kill the design — it relocates the risk. Tier 1 is far
> weaker than the architecture assumed ("expect it to resolve the majority"; it resolves a quarter,
> reliably). Tier 2 therefore carries more, not less, and the cost estimate must be redone against
> ~75% of elements rather than a remainder. The spike's original question — *does the model
> hallucinate matches?* — remains **completely unanswered**, because the model has still never run.

### 🟡 Earlier scoring notes — 2 of 3 pairs

`src/correspond/score.js`, truth in `fixtures/spike/` (tracked — it is hand-made and irreplaceable).

| Pair | at conf ≥0.85 | all anchors | recall |
|---|---|---|---|
| f12→w13 | **3/3** | 8/11 (0.73) | 0.50 |
| f14→w15 | **3/3** | 7/13 (0.54) | 0.33 |
| **combined** | **4/4 — precision 100%** | | **40.5%** |

**The gate passes, and should not yet be trusted.** Four asserted pairs is four data points, and the
third pair (f17→w18) is deliberately held out.

f14→w15 carries no `missing` and no `decor` at all — every designed element was built — and four of
its pairings cross in naive reading order, making it the sharpest available test of `orderBands`.

#### 🔴 `xOverlap` normalisation was wrong, and the truth data exposed it

The f14→w15 errors were systematic, not random. Overlap normalised by `min(width)` cannot distinguish
alignment from **containment**: a 54px design avatar at x=244 scored a perfect **1.000** against a
350px decorative blob spanning x=46..396, and only 0.384 against the 56px avatar that is genuinely
its counterpart.

`xAlignment` (1-D IoU, normalised by the combined extent) now ranks and scores candidates, while
`xOverlap` stays as the generous candidate *filter* — narrowing that would cost recall Tier 2 could
otherwise recover, and a candidate never generated is one the model never gets to judge.

Effect — **confidence calibration, not pairing**:

| | Before | After |
|---|---|---|
| Worst wrong pairing's confidence | **0.824** (0.026 below the gate) | **0.77** |
| Avatar-vs-blob error | 0.664 | **0.241** |
| Asserted at ≥0.85 | 7 | 4 |
| All-anchor precision, f14→w15 | 7/13 | 7/13 — *unchanged* |
| Page-wide anchor coverage | 43.3% | 44.7% |

Stated plainly: the fix did **not** stop the matcher making those pairings. It stopped them
*presenting as confident*. The pairings themselves need vision, which is what Tier 2 is for and
exactly where the architecture said a model earns its place.

> **Overfitting risk, recorded deliberately.** This change was derived from two scored pairs. It is
> defensible on first principles — a box that merely contains another is not aligned with it — but it
> was *found* by looking at the answers. **f17→w18 is the held-out validation.** If precision drops
> there, suspect this.

### ✅ Spike sheets generated — awaiting the user's half day

`src/correspond/spike.js` writes hand-scoring sheets to `out/spike/`. Three pairs, chosen for what
each stresses rather than for being typical:

| Pair | Elements | Why |
|---|---|---|
| f12→w13 | 25 / 36 | the plan's named worst case, 380 vs 142 IR nodes before collapse — does E1 actually fix it? |
| f17→w18 | 24 / 69 | worst ratio (2.88) — 11 designed footer links against 52 built ones; stresses extra-in-web |
| f14→w15 | 22 / 10 | worst ceiling (0.64/0.40) — the pair most likely to fail |

**186 elements to judge.** Precision gate is >95% on pairs asserted at confidence ≥0.85; recall is
recorded but does not gate, because a wrong pairing produces a false finding while a declined one
only costs a true finding.

> `out/` is gitignored and the next `npm run audit` overwrites it. Copy the filled sheets somewhere
> durable before rerunning, or the half day is spent twice.

---

## 🔴 P5 clipping bug — an entire visible section was being deleted silently

**Found 2026-08-12 while trying to score the f14→w15 spike sheet, and it is the most serious defect
found so far** — not because of its size, but because nothing reported it. No finding, no warning, no
count. The data simply was not there.

Web section 15 is the testimonials carousel: two white cards with quotes, avatars, names and roles.
E1 emitted **10** web elements for it — container, eyebrow, heading, paragraph and six carousel dots.
Searching the whole pruned IR for `faisal`, `jeff gillis`, `radiobuzz`: **zero hits**.

The extractor was innocent — the raw serialization contained all six text nodes with real rects. So
was E1. The loss was in **P5 pass 2, clipping**:

```
w2632 <div> pos=relative box -1916,20030 1414x453   <- carousel track
  w2631 <div> ovx=clip     box   253,20030 1414x503 <- clip window
```

The track's own box spans x −1916…−502 and the clip window x 253…1667, so the track was clipped out —
and the pass then dropped its entire subtree on the stated assumption that *"descendants are inside
this box"*. The track's children were at x 976…1667, fully on screen.

**Root cause:** a JS-driven carousel moves *while the serializer walks the DOM*, so a parent's
`getBoundingClientRect()` comes from one frame and its children's from another. `FREEZE_CSS` cannot
prevent this — it stops CSS animation, not a `requestAnimationFrame` transform. Same class of problem
as the typewriter hero, and it will occur on **any** carousel or slider on any audited page.

**Fix:** the clip pass now computes each subtree's union box and drops a subtree wholesale only when
*nothing beneath it* reaches the clip. A node whose own box misses while its descendants do not is
dropped alone, under a new `clipped-out-parent` reason, and its survivors reparent — which is what
this module's own rule 1 already required and the clip pass alone was violating.

Verified: the on-screen card (x=1000) is recovered; the genuinely off-screen slide (x=1723) stays
dropped. Regression test in `test/units.test.js`.

| | Before | After |
|---|---|---|
| Pruned web nodes | 1,273 | 1,297 |
| `clipped-out` drops | 314 | 229 (+4 `clipped-out-parent`) |
| **f14→w15 web elements** | **10** | **27** |
| **f14→w15 ceiling** | **0.64 / 0.40** | **1.00 / 0.74** |
| Page ceiling | 89% / 88% | **91% / 88%** |
| Pairs in the 20–80 count band | 13/18 | 14/18 |

The pair with the worst ceiling on the page is now the best on the design side. That the metric
pointed straight at a real defect is the strongest evidence so far that the Phase 1 gate measures
something real.

> **The f12→w13 ground truth survives unchanged** — still 25 figma / 36 web, and the web indices
> spot-check to identical elements. The half day already spent is not lost. The **f14→w15 sheet has
> been regenerated** (10 → 27 web rows) and must be scored against the new one.

---

## Phase 3 — E3 structural verdict

`src/compare/{repeated,structural,stage}.js`, wired as stage **E3**, writing `structural.json`.
Deterministic and Tier-1-only, so it runs free and needs no API. 6 unit tests.

### The semantic change, and why it is the whole point

The architecture specified `matched / missing-in-web / extra-in-web`. Measured correspondence recall
is **33.5%**, so that vocabulary would have this stage assert that two thirds of every design is
absent from a page that in fact builds it — as a defect, with a severity, a screenshot and a place in
the report.

> **An element without a counterpart is NOT ALIGNED. It is not "missing".**

"Not aligned" is a statement about the *tool*; "missing" is a claim about the *page* and has to be
earned. A test asserts the verdict object contains no occurrence of the word "missing".

Absence becomes a claim only where absence is evidence (`absenceIsEvidence`), currently one narrow
case: an entire design repeated group with no counterpart group, in a section where correspondence is
otherwise healthy (`minCoverageForClaims: 0.6`). That floor is the dial that decides how much the
tool is willing to assert, and it should rise as recall improves.

### Measured on the reference page

| | |
|---|---|
| Aligned pairs | **308** |
| Design coverage | 49% (308/633) |
| Page coverage | 48% (308/639) |
| **Design elements not aligned** | **325** — reported as coverage, not defects |
| Surplus design instances (dummy content) | 4 |
| Group count differences suppressed | 5 |
| **Structural claims** | **1** |

**Under the original semantics this page would have produced 325 "missing element" findings. It
produces one claim**, on a section where 63% of the design aligned and a whole 3-instance group has
no counterpart — which is worth a human's attention.

The five suppressed count differences are exactly the dummy-vs-real case the plan demanded be
silent: design 13 vs page 12, 3 vs 4, 5 vs 4, 4 vs 3, 7 vs 5.

### ✅ Template propagation + composition differences

`signature.js#propagateTemplates`. A repeated group labels the CARDS; everything a reader compares —
the card's title, icon, button — are its descendants, which previously carried no group identity at
all. Descendants now inherit `templateId` and `templateIndex` and gain a **`templateSlot`**: their
structural position inside the instance, as a path of sibling indices.

Slot paths are per-side and are **never** compared across sides — the design's frame tree and the
page's DOM nest differently. What crosses sides is *correspondence*: E3 asks whether a design slot
ever aligns to anything, in any instance, which needs no structural agreement.

On the reference page: 682 of 1,272 elements carry a `templateId`, 399 of them by inheritance.

**The plan's second exit criterion now passes** — a button removed from a card template rendered four
times produces **exactly one** finding, not four. Tested.

#### 🔴 …and validating it against ground truth immediately caught a real problem

First run produced **18 claims**. Checked against the six hand-scored sections:

| Claim | Truth | |
|---|---|---|
| f15→w16 slot 0 [control ×4] | web 12, 20, 28, 28 | **FALSE** |
| f15→w16 slot 0.0 [control ×4] | web 12, 20, 28, 28 | **FALSE** |
| 3 others | all `?` | unverifiable |

**Zero confirmed defects, two confirmed false.** At ~50% correspondence recall, a slot failing to
align in all four instances happens by chance about 6% of the time. "Never aligned" is not evidence
when the matcher misses half of everything.

**Fix — a chance gate.** A slot claim now requires `(1 − alignmentRate)^instances ≤ 0.05`, where the
rate comes from the component's OTHER slots. Two properties make it sound:

- **Self-calibrating.** A well-matched component supports a claim from few instances; a badly matched
  one supports none. No global threshold to tune.
- **The rate excludes the slot being judged.** Including it is circular — a slot that never aligns
  drags down the very rate used to excuse it. That bug was caught by the exit-criterion test, which
  started failing when the gate was first added.

Result: **18 claims → 6**, and **0 of 0 verifiable claims are false** (was 2). The one claim landing in
a benchmarked section has `chanceOfCoincidence = 0.0024`.

### Final state of E3 on the reference page

| | |
|---|---|
| Aligned pairs | 308 · design coverage 49% |
| Design elements not aligned | 325 — reported as coverage, not defects |
| Surplus design instances (dummy) | 10 |
| Group count differences suppressed | 7 |
| **Structural claims** | **6** |

Under the original `missing/extra` semantics this page would have produced **325 "missing element"
findings**. It produces six claims, each gated on evidence.

---

## Phase 4 — E4 element property comparison

`src/compare/properties.js`, wired as stage **E4**, writing `element-findings.json`.

E1 elements deliberately carry no style values, so E4 joins the established correspondence back to the
measured IR — which is where every exact number lives. The model never touched those values; it only
ever said which element is which.

**All seventeen tolerance rules are now live**, including the nine that had never been called:
`lineHeightPx` · `letterSpacingPx` · `paddingMeasured` · `boxRelative.size` · `boxRelative.pos` ·
`border.width` · `shadow.geometry` · `shadow.color` · `opacity`.

### Noise controls

| Control | Effect on the reference page |
|---|---|
| **Template grouping** | 270 instance duplicates folded into 133 component findings |
| **Cascade suppression** | a parent with a wrong size suppresses its children's position findings |
| **Parent-relative geometry** | positions compared against the *aligned* parent, so a section starting 40px lower is one finding, not one per element |

### Three bugs the first run exposed

**1,226 findings → 869**, by fixing two of them:

- **`fontFamily` compared a normalised key against a raw name.** The web IR carries `familyKey`
  (`"geist"`), the Figma IR does not (`"Geist"`), and reading whichever existed produced **79 font
  findings that were pure casing**. Both sides now normalise through the same function. Remaining: 35 —
  and they match `renderedFontFamily`'s 35 *exactly*, so the declared substitutions are confirmed
  independently by the CDP rendered-font probe. Those are real.
- **Size was compared on text runs.** A text element's width and height are functions of its content,
  and design copy legitimately differs from live copy — so comparing a text box is an indirect text
  comparison, which V1 forbade and this stage inherited. It was the largest single bucket: **267 of
  470 size findings sat on text**. Typography is still compared directly, which is where a real text
  defect shows.

**The third turned out to be a normalizer asymmetry, not a collapsed-wrapper problem.** 167
`backgroundColor` findings were dominated by "design has a fill, the page element reports none", and
it survived on alignments verified correct against ground truth (30 of 33) — so it was not a
correspondence artefact.

Two fixes, in the order the evidence pointed:

1. **Effective background resolution.** E1 collapses wrappers that paint nothing *per node*, but a
   page routinely paints a card's background on a wrapper while the design paints it on the card.
   `effectiveBackground()` walks up the collapsed ancestors, stopping at any kept element (compared
   in its own right), at the section root (or everything inherits the section background), and after
   `backgroundInheritHops`. Symmetric on both sides — an asymmetric rule here manufactures the very
   mismatch it removes.
2. **…which fixed almost none of them, and tracing the ancestors showed why.** Every failing case was
   a **text** element whose ancestors genuinely had no fill. On the Figma side a TEXT node's `fills`
   is the **glyph paint**, and the normalizer stores it in `fill.backgroundColor` — verified
   byte-identical to `type.color`. On the web side that field is the CSS background, transparent for
   a text run. So the comparison pitted the design's *text colour* against the page's *background*:
   a guaranteed mismatch, and double-counting, since the glyph colour is already compared as `color`.
   **130 of the 167.**

`backgroundColor` is no longer compared on text elements. The deeper fix belongs in the Figma
normalizer — a text paint should not live in a background field — but that is M4, which V2 leaves
untouched, so the asymmetry is corrected where it does damage and documented at both ends.

| | before | after |
|---|---|---|
| backgroundColor findings | 167 | **37** (24 box · 12 glyph · 1 control) |
| …on verified-correct alignments | 33 (30 design-has-fill/page-none) | **5** (4) |

### Current state

| | |
|---|---|
| Element findings | **739** from 308 aligned pairs (was 1,226 on the first run) |
| Severity | 243 high · 373 medium · 88 low · 35 critical |
| Largest buckets | size.w 103 · lineHeightPx 102 · size.h 100 · fontSizePx 65 · color 60 · fontWeight 46 |
| Template folding | 227 instance duplicates → 110 component findings |

The plan's exit criterion is "within an order of magnitude of the Phase 5 target rather than in the
thousands". 869 clears "thousands" but is ~40× the <20 landing-view target, so **E5's per-element
merge has to do real work** — 869 findings across at most 308 elements is roughly 3 per element
before ranking.

---

## Phase 5 — E5 issue prioritisation

`src/issues/{merge,severity,stage}.js`, wired as stage **E5**, writing `issues.json`. 10 unit tests.

Two projections of the same finding set, neither duplicating the other: **Needs attention** grouped by
element (*what do I fix?*, the landing view) and **Systemic** grouped by property (*what is the
cause?*).

### Measured on the reference page

```
739 findings  ->  249 element issues  ->  20 in the landing view
```

**NFR N3 passes.** The cap applies to *merged issues*, not raw findings, which is what makes it
achievable — a button with four problems costs one slot, not four.

Visual severity combines max technical severity · problem count · element area · viewport position ·
template instance count, all measured, with weights in the tolerance profile. **Match confidence
multiplies rather than adds**, so a claim resting on weak correspondence can only ever be marked
down — never up, which an additive term would allow.

### The systemic view is where the real value showed up

| occurrences | property | | |
|---|---|---|---|
| 26× | `renderedFontFamily` | Public Sans → Geist | one fix |
| 26× | `fontFamily` | publicsans → geist | one fix |
| 26× | `border.width` | 0 → 1 | one fix |
| 13× | `boxRelative.size.w` | 1600 → 1536 | one fix |
| 12× | `opacity` | 0.8 → 1 | one fix |
| 11× | `fontWeight` | 700 → 600 | one fix |

9 groups are a single token fix; **71 are confined to one component** — including the three form
fields all 172px wider than designed that surfaced while validating E4. Those are different elements
in different template slots, so per-element merging keeps them apart; `withinComponent` lets the
report state them once.

### Known cosmetic issues for E7

- `fontFamily` and `renderedFontFamily` report the **same substitution twice** (26 each). They are two
  properties describing one fault and should collapse in presentation.
- `opacity 0.800000011920 → 1` carries float dust; presentation should round.

Measured on run `20260805T071937Z-m34h` unless noted. Re-measure on a second Figma file when
one is available — every number below comes from one file.

| Fact | Value | Consequence |
|---|---|---|
| Figma vector inflation | 743 `icon` nodes, 57% under 24×24, one parent holding **126** | Phase 1 collapse is mandatory |
| Node-count ratio per section pair | **0.35 – 2.48** | the Phase 1 gate |
| Role disagreement | **1** Figma button vs **40** web | never compare role counts |
| Width agreement | **18/18** sections at 1920px | X is a trustworthy matching signal |
| Height agreement | median 1.06, range **0.59 – 4.93**, 7/18 within ±10% | Y is *not* — ordering only |
| Identifier coverage | 1613/1613 Figma, 1224/1224 web | deep links and annotation are free |
| Section count | 18 Figma / 19 web, mean confidence 0.827 | S2 carries over unchanged |

---

## Phase 6 — E6 evidence

`src/evidence/{annotate,stage}.js`, wired as stage **E6**, writing `out/evidence/issues/`.

**One image per MERGED issue, never per finding** — which is why E5 runs first. Per-finding rendering
would produce four images of the same button and discard three.

Every coordinate is measured. Identifier coverage is 100% on both sides, so after correspondence each
issue is anchored to boxes known to the pixel; a model placing them would buy approximation, variance
between runs, a call per annotation, and a failure mode — boxes around elements that do not exist —
that looks exactly like success. The label keyword comes from the finding's own `property`.

Each image is **side-by-side, design left and page right, at matched scale**, with the element
outlined in severity colour, the surroundings dimmed, and a label immediately above the outline that
flips below when there is no room — deterministic either way, so a rerun is identical.

| | |
|---|---|
| Images | 20, for the top 20 issues |
| Side-by-side | 20 (0 page-only) |
| **NFR N6** | **15/15 high+critical issues carry an image — 100%** |

Rendering is Chromium, not an image library, for the same reason cropping is. One constraint worth
recording: the annotation HTML must be **written to disk and navigated to**, never injected with
`setContent` — a `setContent` page has an `about:blank` origin and Chromium refuses to load `file://`
images, so panels render as empty grey boxes with the outline drawn over nothing. Same constraint
that shapes `cropSections`.

### 🔴 The pinned fix broke "pixels and measurements agree" — for pinned sections

Reviewing a rendered image caught it. Issue 6 pairs a design *eyebrow label* with a page *heading*
(`fontSizePx 18 → 50`, `color #8A8A8A → #FFFFFF`) at confidence **0.873** — above the report gate, and
one of the wrong confident pairs the 60% precision figure already counts. The evidence image makes
that visible instantly, which is the point of evidence.

But its PAGE panel is empty, and that is a **separate defect of my own making**. Web section 5 is
scroll-driven: `extract.js` step 13 re-measures it at its settled scroll, while `web-full.png` is
captured at scroll top. **For pinned sections the geometry and the pixels now describe different
moments.** The `onStabilized` hook was placed last specifically to guarantee they agree, and the
pinned fix silently broke that guarantee for exactly the sections it was meant to repair.

Affects **2 of 20** landing-view issues today. The fix is to capture pinned sections at their settled
scroll during the same session — the hook already runs after the pinned pass, so it is a matter of
capturing per-pinned-container rather than one full-page image. Not attempted here: it changes
capture, and doing that unmeasured is how the last three regressions happened.

---

## Phase 7 — E7 visual QA report

`src/qa/{locators,synthesis,build,page,html,stage}.js`, wired as stage **E7**, writing
`out/qa/report.html`, `out/qa/section-*.html` and `out/qa/report.json`. 14 unit tests.

### The LLM boundary — the load-bearing part

**The model may choose WORDS. It may never choose FACTS.** Every measurement, severity, confidence,
affected-element count and issue identity is written into the report before the model is called; it
returns three short strings per issue and those are the only fields that can change. Enforced three
ways, because "we told it not to" is not enforcement:

| Guard | |
|---|---|
| **Schema** | the response carries no numeric field at all |
| **Grounding** | any number in the returned *text* must already exist in that issue's own values — measured in Phase 2, a model denied a typed field packs geometry into free text instead |
| **Absence** | wording asserting something is missing is rejected unless E3 produced a structural claim |

A field failing any check is discarded and the deterministic text stands. **The report is complete and
correct with the model never called** — proven in practice on the first run, where synthesis failed
(255 issues overflowed the output ceiling, truncating the JSON) and the whole report shipped on
deterministic wording. Synthesis is now batched, so a failing batch costs its own issues their copy
and nothing else.

### Measured on the reference page

| | |
|---|---|
| Issues | 255 across 18 sections, 360 elements affected |
| Systemic groups | 84, of which **50 look like a shared token or component fix** |
| Screenshots | 20 side-by-side (E6 annotates the top 20; **all 10 fix-first issues carry one**) |
| Synthesis | **765 strings accepted, 0 rejected by the guard** |
| Full-page action | rebuilds in **37ms** without rerunning E1–E6 |

Deep links are now **element-scoped** rather than Phase 0's section scope — E2 correspondence made
that possible, and identifier coverage is 100% on both sides. Every issue carries a Figma `?node-id=`
link and a devtools-ready selector.

### Four presentation defects found by reading the output

- `#000000 @ 0%` now reads **transparent**
- colour deltas print as **ΔE 18.09**, not a bare number that reads as pixels
- a font substitution is no longer "update the shared rendered font token" but **"check the webfont
  loads"** — it usually means the font never arrived
- Figma component-instance ids contain `;` (`I2743:7244;2958:49606`), which **silently truncated the
  deep link**; now percent-encoded

---

## Blocked / needs manual action

| Item | Owner | Blocking |
|---|---|---|
| Confirm `/v1/images` rate-limit tier | user | Phase 2 |
| Manual correspondence scoring, 3 section pairs (~½ day) | user | Phase 2 gate |
| Second Figma file + live page | user | re-running the Phase 1 gate |
| ~~Confirm Gemini enforces JSON-schema output~~ | ~~me~~ | **done 2026-08-11** — enforced at field level, not for `maxLength` or free text |
| **Re-estimate Tier 2 LLM cost** — the workload is ~410 figma + 373 web elements across 18 sections, not a small remainder | me, early Phase 2 | Phase 2 budget |

---

## Decisions log

| Date | Decision |
|---|---|
| 2026-08-05 | Screenshots to LLM **allowed**; Gemini for development; POC repo; desktop only; complete V2 before shipping |
| 2026-08-05 | Figma seat is **View/Collab (~6 Tier-1 requests/month)** → render whole frame once and crop locally; never call `/v1/files/:key`; cache indefinitely |
| 2026-08-05 | Tier 1 anchoring is **not** box IoU — X-overlap + width ratio + reading order + signature, with a Y warp between anchors (heights differ up to 4.93×) |
| 2026-08-05 | E5 issue prioritisation runs **before** evidence, so one merged issue gets one screenshot |
| 2026-08-11 | Phase 1 gate metric is **ceiling + anchor coverage**, not node-count ratio — the ratio measures content volume, which is E3's problem |
| 2026-08-11 | Tier 1 width ratio is a **scoring signal, not a filter** — it cost more than half of all achievable anchors |
| 2026-08-11 | `styleSignature` carries **no colour value**, only presence — a colour bucket would block the very findings the tool reports |
| 2026-08-11 | `extractWeb` gains an optional `onStabilized` hook — a documented exception to "extraction is not touched", so pixels and measurements come from one session |
| 2026-08-11 | Reading order is enforced **within column bands**, not across the section — a global LIS discarded 31.7% of accepted assignments on a 2-D layout |
| 2026-08-11 | `orderBands` left at 3 and **explicitly not tuned** — coverage rises with band count only because the constraint weakens |

---

## Changelog

**2026-08-05**
- Branch `v2` cut from `main` at `a8014af`
- Phase 0: ΔE bands calibrated and shipped to HTML + UI
- Phase 0: section-scoped deep links (Figma + CSS selector) on 95/97 findings
- Phase 0: determinism self-check now default-on in server and UI

**2026-08-06**
- Phase 0: unstable nodes excluded from section digests (`segment.js`)
- Phase 0: determinism check made load-bearing — diverged ids fed back into the compared
  snapshot (`web/stage.js`). 247 nodes excluded on a diverging run; 214–237 of them were
  invisible to the extractor's own flag
- Phase 0: section-match confidence demotes severity below 0.75 (`findings.js`) — 12 findings
- Phase 0: **score instability diagnosed, not fixed.** Extraction is not reproducible across
  runs (1224 vs 1273 nodes); deferred to Phase 8 baselines with three options written up
- **Phase 0 closed.** Next: Phase 1 — E1 comparable element set and the node-ratio gate

**2026-08-11**
- Phase 1: `src/elements/` — collapse rules, signatures, element builder, gate harness, offline
  replay. Stage **E1** wired beside S3; writes `elements.json`. 10 unit tests, suite green at 45
- Phase 1: icon-cluster rule corrected to **maximal icon-only subtree** — section 12 goes 380 → 41
  elements, ratio 0.37 → 1.02
- Phase 1: `unionBox` now unions leaves only, with a scale-relative fragment cut; `styleSignature`
  no longer buckets colour. Both bugs were caught by unit tests, not by the aggregate numbers
- Phase 1: **gate metric replaced** — ceiling (87%/88%) + anchor coverage (37%) instead of
  node-count ratio. **GATE PASSED**; the trees are comparable
- Phase 1: §0.2's Tier-1 `widthRatio ±10%` filter measured as wrong at element level (19% vs 43%
  coverage) and demoted to a scoring signal in the plan and the tolerance profile
- **Phase 1 closed** except the second-Figma-file re-run, which is blocked on the user.
  Next: Phase 2 — E2 correspondence, starting with the day-1 hand-scoring spike
