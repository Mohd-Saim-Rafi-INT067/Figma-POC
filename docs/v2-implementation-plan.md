# Figma Design Parity V2 — Implementation Plan

**Companion documents:** `v2-architecture.md` (rationale) · `v2-hld.md` (structure, contracts, NFRs)

---

## 0. How this plan is built

Three rules, taken from what worked and what did not on V1:

1. **Every phase ends in something runnable.** No phase depends on a later one.
2. **Three phases are gates, not milestones.** Phases 1, 2 and 5 each answer a question that can
   invalidate the remaining schedule. If a gate fails, stop and re-plan — that is the point of
   putting them early and making them cheap.
3. **The engine stays portable.** No credential, storage path, or HTTP concern enters the comparison
   layer. This is what makes the Evertest port wiring rather than rewriting.

### 0.1 Decisions already locked

Engineering:

- LLM decides **identity**; code decides **values**. The E2 response schema carries no numeric field
  but `confidence`.
- **No finding carries text content.** `hasText` is a boolean; strings stop at E1.
- Tolerance thresholds live in `config/tolerance-*.json` as data, never as constants in code.
- V1's aggregate comparison (`sections/compare.js`) is replaced, not extended.
- Extraction, IR, pruning, S1 and S2 are **not touched**.

Confirmed with the user, 2026-08-05:

| Decision | Value | Consequence |
|---|---|---|
| Screenshots to LLM | **allowed** | E2 Tier 2 is viable; no opt-out path needed for the POC |
| LLM provider | **Gemini** for development | vision + structured output; revisit for production |
| Reference target | quokkalabs.com home page; more pages later | second-file validation deferred, not cancelled |
| Correspondence ground truth | **manual, by the user** | Phase 2 gate needs ~half a day of their time |
| Figma seat | **View/Collab — ~6 Tier-1 requests per month** | drives §0.3 entirely |
| Build location | **POC repo** | port to Evertest after V2 |
| Interim release | **no** — complete V2, then ship | Phase 0 is groundwork, not a release |
| Breakpoints | **desktop only** | forced by quota, not chosen — see §0.3 |

### 0.2 The width/height asymmetry — load-bearing

Measured on the reference run:

| | Figma | Web | |
|---|---|---|---|
| Root width | 1920 | 1920 | **18/18 sections identical** |
| Total height | 19,752 | 23,991 | ratio **1.21** |
| Section height ratio | | | median 1.06, range **0.59 – 4.93**, only 7/18 within ±10% |

Width matches **by construction** — `applyFrameWidth` forces the browser viewport to the frame width
(parent doc §3.1). Height cannot be forced and must not be: it differs because text wraps differently,
real content replaces dummy content, and sections reflow. That difference **is** a finding, not noise.

**Therefore, axes are treated asymmetrically everywhere in E1/E2:**

| Axis | Trust | Used for |
|---|---|---|
| X + width | high — identical viewport | direct comparison; **primary anchor signal** |
| Y | none absolutely | ordering only; local position after anchoring |
| Height | none | a *finding*, never a matching signal |

A Tier 1 anchor is therefore **not** plain box IoU. It requires:

```
xOverlap(a, b)      ≥ 0.8
widthRatio(a, b)    within ±10%
readingOrder        monotonic (no inversion)
styleSignature      compatible
```

plus a **piecewise-linear Y warp** interpolated between already-anchored elements, giving unanchored
elements a local Y expectation. This is the same technique S2 applies at section level, applied
within a section.

> Plain `IoU ≥ 0.8` on section-relative boxes — the earlier draft of this spec — **fails** on pair
> 6→7, where heights differ 4.93×. Do not reintroduce it.

Also fix while here: one section reports width `1920.0002021495602`. Clamp float artifacts.

### 0.3 Quota strategy — mandatory, not an optimisation

A View/Collab seat allows roughly **6 Tier-1 Figma requests per month**. Everything below follows
from that number.

- [ ] **Never call `/v1/files/:key`.** The version check is pure overhead; the `/nodes` response
      already carries `version`, `name`, `lastModified`. Removing it halves per-run consumption.
- [ ] **One render per frame, not per section.** Render the whole frame once and **crop sections
      locally** using the `y`/`height` already in `sections.json`. Eighteen API calls become one.
      *(Rendering 18 sections individually would consume three months of quota in a single run.)*
- [ ] **Confirm the `/v1/images` rate-limit tier before Phase 2.** If it is Tier 1, the whole-frame
      strategy above is the only viable approach.
- [ ] Check Figma's export size limit for a 1920×19,752 PNG; fall back to `scale=0.5` or vertical
      chunking if rejected.
- [ ] Cache frame JSON and renders **indefinitely**, keyed by `(fileKey, nodeId, version)`; refresh
      only on explicit user request.
- [ ] Development works from cached fixtures by default. Live Figma calls require an explicit flag.

**Multi-breakpoint is arithmetically impossible on this quota** — each breakpoint is another frame
fetch. Desktop-only is forced. Revisit if the account is upgraded to a Dev/Full seat.

### 0.2 Target file layout

```
src/
  elements/
    collapse.js        vector clusters, wrapper chains, hidden/zero-area
    signature.js       styleSignature + repeated-template detection
    build.js           E1 - comparable element set
  correspond/
    anchors.js         Tier 1 - deterministic geometric/style anchors
    llm.js             Tier 2 - vision call, schema-constrained
    verify.js          Tier 3 - IR verification of every proposal
    cache.js           structure-hash keyed correspondence cache
    index.js           tier orchestration + confidence gating
  compare/
    structural.js      E3 - matched / missing / extra
    repeated.js        repeated-group rule
    properties.js      E4 - per-element property comparison
  issues/
    merge.js           E5 - merge findings by element
    severity.js        visual severity model
    fix.js             suggested fix (LLM, grounded + audited)
  evidence/
    capture.js         E6 - web clips + Figma renders + cache
    annotate.js        box drawing, label layout, side-by-side
  report/              reworked for the issue-centric model
```

---

## 1. Task list by phase

### Phase 0 — Ship-now improvements against V1 *(2–3 days)*

Independent of everything below. Deployable immediately; makes the current report materially better
while V2 is built.

- [ ] `src/report/knowledge.js` — ΔE band helper: `<1` invisible · `1–2` side-by-side only ·
      `2–5` noticeable at a glance · `5–10` clearly different · `>10` obviously different
- [ ] Render the band beside every ΔE value in `report/html.js` and the UI, not only in a legend
- [ ] Validate the bands against `deltaEOK` on a set of known colour pairs; adjust if OKLab×100
      diverges from the CIE scale, and record the calibration in the tolerance profile
- [ ] Deep links on every finding — Figma `?node-id=<figmaNodeId>`, plus `webSelector` for devtools
      *(identifier coverage is already 100% on both sides — no extraction change needed)*
- [ ] Determinism self-check **on by default**; exclude unstable nodes from findings rather than
      only flagging them; report the excluded count
- [ ] Propagate section-match confidence into finding severity and into the report header
- [ ] Investigate score instability — the same page scored 64 and 65 minutes apart (NFR N7)

**Exit:** a rerun of the reference page produces a report where every colour finding reads
`ΔE 7.43 · clearly different`, every finding links to both sides, and two consecutive runs produce
the same score.

---

### Phase 1 — E1 comparable element set ⛔ **GATE** *(3–4 days)*

The cheapest possible test of whether the whole architecture is viable.

- [ ] `src/elements/collapse.js`
  - [ ] Figma vector-cluster collapse — sibling vector nodes under one parent become a single `icon`
        node with union bounding box and dominant fill
        *(current file: 743 `icon` nodes, 57% under 24×24, one parent holding 126)*
  - [ ] Web wrapper collapse — single-child containers with no visual output
  - [ ] Drop zero-area, hidden, fully-clipped, and out-of-section nodes
  - [ ] Per-reason counts retained for the audit trail
- [ ] `src/elements/signature.js` — `styleSignature` over fill · border · radius · shadow ·
      fontFamily/Size/Weight
- [ ] `src/elements/build.js` — emit the `Element` contract (HLD §5.1), boxes **section-relative**
- [ ] Write `out/runs/<id>/elements.json`
- [ ] **Measurement harness: per-section-pair node-count ratio, before and after collapse**
- [ ] Re-run against a **second Figma file + live page** and record the same table

**Exit / GATE:** per-section node-count ratios move from today's **0.35 – 2.48** toward ~1.0, and
element counts land in the **20–80 per side per section** band.

> If ratios stay wide, the two trees are not comparable and E2 will not work. **Stop and re-plan.**
> Four days spent instead of three months.

---

### Phase 2 — E2 element correspondence ⛔ **GATE** *(2–3 weeks)*

- [ ] **Day-1 spike, before any code:** hand-run Tier 2 on 3 section pairs — including 12→13, the
      worst ratio — and score against ground truth established by eye. Precision > 95% or stop.
- [ ] `src/correspond/anchors.js` — Tier 1 per the **axis-asymmetric** rule in §0.2: X-overlap ≥ 0.8,
      width ratio ±10%, monotonic reading order, compatible signature. **Not plain box IoU.**
- [ ] Piecewise-linear **Y warp** between anchored elements, giving unanchored elements a local Y
      expectation despite section height ratios of 0.59–4.93
- [ ] `src/evidence/capture.js` *(brought forward — Tier 2 needs renders)*
  - [ ] Web: Playwright `page.screenshot({ clip })` per section, in the stabilized state
  - [ ] Figma: **one whole-frame render**, cropped locally per §0.3 — never one call per section
  - [ ] Render cache keyed `(fileKey, nodeId, version)`, indefinite
  - [ ] **Confirm the `/v1/images` rate-limit tier before relying on it**
- [ ] `src/correspond/llm.js` — vision call, unresolved elements + anchored neighbours for context,
      schema-constrained output (no numeric field but `confidence`)
- [ ] `src/correspond/verify.js` — reject proposals failing: id resolution · double assignment ·
      IoU floor · order inversion · incompatible signature. Log rejections; never report them.
- [ ] `src/correspond/cache.js` — `correspondenceCacheKey` per HLD §7.1; `webStructuralHash` excludes
      style values
- [ ] `src/correspond/index.js` — tier orchestration, confidence gating (≥0.85 / 0.60–0.85 / <0.60),
      section-confidence multiplication
- [ ] Budget cap with graceful degradation to Tier 1 only
- [ ] Metrics: tier distribution, cache hit rate, rejected-proposal rate
- [ ] Write `out/runs/<id>/correspondence.json`

**Exit / GATE:** correspondence precision **> 95%** on high-confidence pairs across 3 hand-scored
sections; a second run with a warm cache is byte-identical and makes zero LLM calls.

---

### Phase 3 — E3 structural verdict *(1 week)*

- [ ] `src/compare/repeated.js` — detect repeated sibling groups content-free (N siblings, near-identical
      signatures, consistent box sizes); extract the template
- [ ] `src/compare/structural.js` — matched / missing-in-web / extra-in-web per element
- [ ] **Repeated-group rule**: count differences inside a group are suppressed; template differences
      are reported **once**
- [ ] Structural findings carry `descriptor`, both ids, and confidence
- [ ] Fixture: a page where the design has 3 dummy cards and the page renders 12 real ones

**Exit:** dummy-vs-real card counts produce **zero** findings; a deliberately removed button inside a
card template produces **exactly one**.

---

### Phase 4 — E4 element property comparison *(2–3 weeks)*

- [ ] `src/compare/properties.js` — replaces `sections/compare.js`; runs per matched pair
- [ ] Geometry via `boxRelative` against the **matched parent** (no cascade)
- [ ] Wire the nine dormant tolerance rules: `lineHeightPx` · `letterSpacingPx` · `paddingMeasured` ·
      `boxRelative.size` · `boxRelative.pos` · `border.width` · `shadow.geometry` · `shadow.color` ·
      `opacity`
- [ ] Port the existing colour / font / radius / measured-gap rules to element level
- [ ] Retain V1's `fingerprint`, `groupKey`, severity model and occurrence upgrade
- [ ] **Noise controls (all mandatory):** template grouping · property grouping · cascade suppression
- [ ] Section-level checks that remain valid at section scope stay (background, height, width)
- [ ] Delete `sections/compare.js`

**Exit:** findings on the reference page are element-anchored, and raw finding count is within an
order of magnitude of the Phase 5 target rather than in the thousands.

---

### Phase 5 — E5 issue prioritisation ⛔ **GATE** *(1 week)*

- [ ] `src/issues/merge.js` — merge all findings on one element into a single `ElementIssue`
- [ ] Systemic projection — the same finding set grouped by property; reuse V1's `oneFix` / `systemic`
- [ ] `src/issues/severity.js` — visual severity from max property severity · issue count ·
      element area · viewport position · template instance count · match confidence; **weights in the
      tolerance profile**
- [ ] Volume cap and ranking; remainder collapsed behind "show all"
- [ ] `src/issues/fix.js` — suggested fix text, grounded: may cite only values present in the finding
      set; audited by the existing prose auditor; **never invents a component name**
- [ ] Write `out/runs/<id>/issues.json`

**Exit / GATE:** landing view shows **fewer than 20 issues** on the reference page (NFR N3), each
naming an element and listing its properties.

---

### Phase 6 — E6 evidence *(1.5 weeks)*

- [ ] Thumbnails (~600px) alongside full-resolution section renders
- [ ] `src/evidence/annotate.js`
  - [ ] Box outline from measured geometry, translated by section origin, severity-coloured
  - [ ] **Label immediately above the outline**, left-aligned; flip/leader-line on collision or
        canvas edge
  - [ ] Deterministic placement — labels laid out in severity order
  - [ ] Multi-element issues outline the largest 3 by area, note `+N more`
  - [ ] Side-by-side composite for section geometry findings, matched scale, delta bracketed
- [ ] One image per **merged issue**, not per finding
- [ ] Degrade cleanly when Figma renders are unavailable

**Exit:** 100% of high and critical issues carry an image in which the offending element is outlined
and labelled (NFR N6).

---

### Phase 7 — E7 report rebuild *(2 weeks)*

- [ ] Issue-centric `report.html`: page verdict → **Needs attention** (default) / **Systemic** (tab)
      → section cards → element issue cards
- [ ] Element issue card: identity · visual severity · evidence image · property table with ΔE bands ·
      structural verdict · both deep links · suggested fix
- [ ] Progressive disclosure at every level; full tables never the landing view
- [ ] `findings.json` schema v2 — the machine contract for CI and baselines
- [ ] Update `report/llm.js` prose prompt for the issue-centric model; prose auditor unchanged
- [ ] Update the demo UI (`ui/`) to the same model
- [ ] Update `src/server/app.js` `buildResult()` for the new shape

**Exit:** a reader who has never seen the tool can name the top three things to fix, and reach the
element in Figma and in devtools in one click each.

---

### Phase 8 — Regression capability *(1.5 weeks)*

- [ ] Baseline capture and storage (`design_baselines`)
- [ ] Run-vs-baseline diff — new / resolved / unchanged, keyed on `fingerprint`
- [ ] Suppressions by fingerprint, persisted, surfaced as "N suppressed"
- [ ] CI gating policy: gate only on new findings, and only where correspondence tier is `anchor` or
      the cache was hit (determinism requirement, HLD §7.1)
- [ ] Design hygiene gate — score auto-layout usage, component ratio, layer-name quality; warn before
      running when the file cannot support element-level comparison

**Exit:** a second run against an unchanged page reports zero new findings; a deliberate CSS change
reports exactly one.

---

## 2. Dependencies

```
Phase 0 ──────────────────────────────────── independent, ships anytime

Phase 1 (GATE) ─► Phase 2 (GATE) ─┬─► Phase 3 ─┐
                                  │            ├─► Phase 5 (GATE) ─► Phase 6 ─► Phase 7 ─► Phase 8
                                  └─► Phase 4 ─┘

Phase 2 pulls evidence/capture.js forward — Tier 2 needs section renders.
Phases 3 and 4 are parallelisable if two people are on it.
```

---

## 3. Testing strategy

| Level | What |
|---|---|
| **Unit** | collapse rules · signature equality · IoU · repeated-group detection · severity model · label layout |
| **Fixture** | hand-built Figma/web pairs with known defects: one missing button in a card template · one colour off by ΔE 3 · one padding off by 4px · a 3-vs-12 card count |
| **Golden** | reference page findings snapshot; any diff must be explained in the PR |
| **Determinism** | run twice with a warm cache, assert byte-identical `findings.json` |
| **Correspondence precision** | 3 hand-scored section pairs, re-scored whenever the prompt or matcher version changes |
| **Volume** | assert landing view < 20 issues on the reference page |

The fixture suite is the one that pays for itself. Every gate above is also a permanent test.

---

## 4. Release strategy

**Decided: complete V2 before shipping anything.** No interim V1 release.

Consequences to hold to:

1. Phase 0 is **groundwork, not a release** — ΔE bands, deep links and determinism carry into V2
   unchanged, so the work is not wasted, but it does not need release polish.
2. The Evertest integration (`figma-integration.md`) waits for `findings.json` **v2**, which lands in
   Phase 7. Building the integration against V1's contract would mean reworking it.
3. Nothing is demonstrable to stakeholders until Phase 5–6. **Use the phase gates as the progress
   narrative** — each produces a concrete, checkable result — rather than going quiet for a quarter.

---

## 5. Open items carried into the build

Answered, but with work attached:

- [ ] **Second Figma file** — deferred, not cancelled. Every measurement driving this design comes
      from one file. Re-run the Phase 1 gate on the second page when the user supplies it.
- [ ] **`/v1/images` rate-limit tier** — unknown, and on a ~6-request/month account. Establish before
      Phase 2 (§0.3).
- [ ] **Gemini vision + structured output** — confirm the exact model, that JSON-schema-constrained
      output is enforced (not merely requested), and measure per-run token cost on one section pair
      before building the full tier.
- [ ] **User time for the Phase 2 gate** — roughly half a day of manual correspondence scoring on
      3 section pairs. Schedule it; the gate is meaningless without it.
- [ ] **Production LLM provider** — Gemini is a development decision. Revisit before the Evertest
      port, since data egress terms may differ per provider.
