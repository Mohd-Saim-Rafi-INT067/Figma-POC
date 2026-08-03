# V1 Implementation Plan — Section-Level Design Parity

**Architecture:** `docs/v1-architecture.md`
**Progress tracker:** `docs/progress-report.md`
**Supersedes:** the comparison half of `docs/poc-implementation-plan.md` (its extraction half stands, and is built)

**Rule this plan follows:** *Compare sections as whole units. Use text to match, never to report.*

---

## 1. What changes from what exists today

3,078 lines are built. **Nothing is rewritten.** The delta is small and mostly rewiring.

### 1.1 Unchanged — 11 files, no edits

`figma/client.js` · `figma/normalize.js` · `figma/stage.js` · `web/extract.js` · `web/serializer.js` · `web/normalize.js` · `web/fonts-cdp.js` · `web/stage.js` · `ir/color.js` · `ir/fonts.js` · `config.js`

`ir/text.js` is also unedited, but its **role changes**: it now feeds section matching only. No finding may ever carry text content.

### 1.2 Modified — 3 files

| File | Change | Why |
|---|---|---|
| `ir/schema.js` | Drop IR fields V1 never compares | Shrinks the model (your point 4). See §1.5 for what goes. |
| `cli.js` | Replace stages `P5 P6 P7 M7a G M10 R D` with `P5 P6 S1 S2 S3 S4 S5` | New comparison half |
| `config/tolerance-default.json` | Add a `section` block; keep per-property tolerances | Section-level thresholds are new |

### 1.3 Deferred — 1 file

`figma/tokens.js` (123 lines) — kept in the repo, unwired. V1 compares a web section against **its matched Figma section**, so the Figma side *is* the reference. No abstracted token set, no authority tier, and the Tier 2.5 circularity problem does not arise. Returns only if a standalone token-conformance audit is wanted later.

### 1.4 Deleted — nothing

`src/audit/` and `src/report/` are empty directories; the token-audit modules were never written. Fortunate timing.

### 1.5 IR fields dropped in the trim

| Dropped | Reason |
|---|---|
| `type.firstBaselineY` | Only meaningful for per-node text comparison (V2) |
| `type.textDecoration`, `type.textAlign` | Not compared at section level |
| `sourceRef.annotationId` | `data-figma-node` mode is V2 |
| `layout.justify`, `layout.align` | Declared values; V1 compares measured geometry |
| `border.style` | Not compared at section level |
| `fill.imageFit` | Image comparison is V2 |

**Kept deliberately:** `layout.declared.*` (useful for debugging even though never compared) and `_figma` / `_web` (pruning inputs — dropping these caused a real bug once already).

---

## 2. Phases at a glance

| Phase | What | Est. | Blocks |
|---|---|---|---|
| **A** | Realign existing code | 0.5 d | — |
| **B** | P5 pruning + P6 measured spacing | 2 d | A |
| **C** | S1 section segmentation | 1.5 d | B |
| **D** | S2 section matching | 2 d | C |
| **E** | S3 section comparison | 3 d | D |
| **F** | S4 findings + S5 LLM report | 2 d | E |
| **G** | Validation harness | 2 d | F |
| | | **~13 d** | |

Each phase ends in something runnable with a stated exit criterion.

---

## 3. Phase A — Realign existing code

Small, mechanical, unblocks everything. **Do this first.**

- [ ] `ir/schema.js` — remove the §1.5 fields from `makeNode`
- [ ] `figma/normalize.js`, `web/normalize.js` — stop populating the removed fields
- [ ] `cli.js` — new stage list:
      `M2 → M4 → M1 → M3 → [DET] → P5 → P6 → S1 → S2 → S3 → S4 → S5`
- [ ] `cli.js` — retire the `D` (anchor probe) stage; §3.13 of the old plan is moot now that
      text anchors are used directly by S2 rather than probed for feasibility
- [ ] `config/tolerance-default.json` — add the `section` block (§3.1)
- [ ] Decide the unstable-node machinery (§11 Q1); default is **keep**
- [ ] Re-run `npm run audit`, confirm it reaches P5 and stops cleanly

**Exit:** pipeline runs end-to-end, IR is smaller, first unimplemented stage is P5.

### 3.1 New tolerance block

```jsonc
"section": {
  "heightRatio":      { "tolerance": 0.10, "severity": "medium" },  // normalized, not px
  "heightAbsolutePx": { "tolerance": 40,   "severity": "low"    },  // reported alongside
  "offsetRatio":      { "tolerance": 0.05, "severity": "medium" },
  "backgroundColor":  { "match": "deltaEOK", "tolerance": 2.0, "severity": "high" },
  "paletteExtra":     { "severity": "medium" },   // color in web, not in matched figma section
  "paletteMissing":   { "severity": "low"    },
  "fontFamilySet":    { "match": "exact",  "severity": "high"   },
  "fontSizeSet":      { "tolerance": 1,    "severity": "medium" },
  "fontWeightSet":    { "match": "exact",  "severity": "medium" },
  "spacingScale":     { "tolerance": 2,    "severity": "medium" },
  "radiusSet":        { "tolerance": 1,    "severity": "low"    },
  "densityRatio":     { "tolerance": 0.35, "severity": "low"    }
},
"matching": {
  "weights": { "position": 0.35, "height": 0.25, "textAnchors": 0.30, "digest": 0.10 },
  "gapPenalty": 0.6,
  "confidenceFloor": 0.45
}
```

> The page is 21% taller than the design overall, so height **must** be compared as a ratio.
> The absolute delta is reported alongside for human sanity, never gated on.

---

## 4. Phase B — P5 pruning + P6 measured spacing

Both were always required and are unchanged by the rescope. Pruning matters more now, not less: a `display:none` mega-menu injects phantom colors straight into a section's palette digest.

### P5 — `src/pipeline/prune.js`

- [ ] **Web:** drop `display:none`, `visibility:hidden`, `opacity:0`, zero-area
- [ ] **Web:** drop nodes fully outside an `overflow:hidden` ancestor's clip rect
- [ ] **Web:** collapse transparent wrappers to fixpoint — box within 1px of a single element
      child *and* painting nothing itself (no background, border, shadow, background-image, own text)
- [ ] **Figma:** drop `visible:false`, zero-area, `opacity:0`
- [ ] **Figma:** drop nodes outside a `clipsContent` ancestor's bounds
- [ ] **Figma:** collapse single-child `GROUP` nodes
- [ ] Record a per-reason prune count; surface in the report

### P6 — `src/pipeline/spacing.js`

- [ ] Infer stack direction from child geometry, **not** from `flex-direction` / `layoutMode`
- [ ] `gapMeasured` = gap between consecutive sibling boxes
- [ ] `paddingMeasured` = first/last child edges vs parent content box
- [ ] Overlapping siblings → `null`, never a negative gap

**Exit:** pruned node counts within the same order of magnitude on both sides — the parent doc's §6.1 claim, tested. Prune stats printed.

---

## 5. Phase C — S1 Section Segmentation

`src/sections/segment.js`

- [ ] **Figma:** take direct children of the target frame
- [ ] **Figma: sort by `y`** — the API returns them in arbitrary order (verified: real file's
      first child is at y=2490, third at y=0). Getting this wrong silently breaks all of S2.
- [ ] **Figma:** drop invisible, zero-area, and decorative full-width strips (height < 24px)
- [ ] **Web:** direct children of `<body>`, unwrapping a single wrapper element if present
- [ ] **Web:** drop `display:none`, zero-area, and non-full-width floaters (chat widgets)
- [ ] Build a **section digest** per section:
      `{ index, y, normalizedY, height, normalizedHeight, width, nodeCount,
         textAnchors: Set, colorSet, fontFamilySet, fontSizeSet, fontWeightSet,
         radiusSet, spacingHistogram, backgroundColor, containsUnstable }`
- [ ] Write `out/sections.json` + a readable console table

**Exit:** Figma ≈ 18 and web ≈ 19 sections listed with y/height/digest. Matches the measured
values in `v1-architecture.md` §3.

---

## 6. Phase D — S2 Section Matching

`src/sections/match.js` — replaces M8. The riskiest V1 module, which is the point: it is
*far* smaller than what it replaces (342 candidate pairs vs 5.9M).

- [ ] Normalize both sides: y and height as fractions of total document/frame height
- [ ] Pairwise cost:
      ```
      cost = w₁·|Δ normalizedY|
           + w₂·(1 − heightRatioSimilarity)
           + w₃·(1 − jaccard(textAnchors))     ← the ONLY use of text
           + w₄·(1 − digestSimilarity)
      ```
- [ ] **Order-preserving alignment** (Needleman–Wunsch) with gap penalty, so a designed-but-
      unbuilt section reports as a gap instead of corrupting the whole alignment
- [ ] **Known V1 limitation — many-to-one merges.** Plain Needleman–Wunsch produces a 1:1
      alignment with gaps, so the confirmed header split (Figma §1 = web `<header>` + hero
      `<section>`) will surface as *"extra section in web"* rather than *"the design's section 1
      is split in two"*. That is honest and reportable, just coarser than ideal. Detecting
      merges — an inserted section adjacent to a matched one whose **combined** height fits the
      Figma section better — is a V1.5 addition, not a V1 blocker.
- [ ] Confidence per pair; below `confidenceFloor` → `unmatched`, not a bad match
- [ ] Unmatched → `missing-in-web` / `extra-in-web` findings at reduced severity
- [ ] Write `out/section-alignment.json` + a side-by-side console table

**Exit:** a human can read the alignment table and agree with it. This is also what answers
`v1-architecture.md` §9.3 — whether the 18 vs 19 gap is an unbuilt section or a split one.

> **Do not tune the weights before reading the first alignment.** Fitting weights to a guess
> about that gap is how matchers get quietly overfitted to one page.

---

## 7. Phase E — S3 Section Comparison

`src/sections/compare.js` — replaces M9. Deterministic; no LLM anywhere in this path.

Per matched pair, **aggregates only — never a per-node claim**:

- [ ] **Geometry** — normalized height, normalized offset, width; absolute deltas reported alongside
- [ ] **Background** — dominant background color, ΔE_OK
- [ ] **Palette** — color *sets*: extra-in-web and missing-in-web, each with web-side usage counts
- [ ] **Typography** — family / size / weight *sets*
- [ ] **Spacing** — measured-spacing distribution (from P6), never declared `margin`/`gap`
- [ ] **Shape** — radius and shadow *sets*
- [ ] **Density** — node-count ratio, as a structural-richness proxy
- [ ] **Rendered fonts** — declared vs CDP-resolved family, per section
- [ ] Exempt CSS generic families (`ui-monospace`, `system-ui`, `sans-serif`) from the
      rendered-font check — they resolve to a system font *by design* (observed:
      `ui-monospace → Consolas`, a false positive)
- [ ] Treat a CDP face name that starts with the declared family as a match
      (`DM Mono` → `DM Mono Medium` is not a mismatch)
- [ ] Skip or flag sections where `containsUnstable` is set

**Exit:** `out/findings.json` for the real page, with every finding attributable to a named
section pair.

---

## 8. Phase F — S4 Findings + S5 Report

`src/report/findings.js`, `src/report/console.js`, `src/report/llm.js`, `src/report/html.js`

- [ ] Finding shape: `{ id, sectionPair, category, type, property, expected, actual, delta,
      tolerance, severity, occurrenceCount, fingerprint }`
- [ ] Severity from tolerance profile; upgrade one level when `occurrenceCount > 10`
- [ ] **Assert no finding carries text content** — a test, not a convention
- [ ] Console summary: per-section pass/fail table
- [ ] `out/findings.json` — the contract; everything else renders from it
- [ ] **S5 LLM report** — `claude-opus-5`, structured findings in, prose out.
      The model never produces a number; every value exists before it is called.
- [ ] `out/report.html` — self-contained, section-by-section, light/dark

**Exit:** `npm run audit` produces findings + a readable report in one command.

---

## 9. Phase G — Validation

The exercise that separates "it ran" from "it is correct".

- [ ] `fixtures/generate.js` — build an HTML page **from the Figma IR**, so it is near-perfect
      by construction. A clean run must produce **zero findings** — any finding is a false
      positive with nowhere to hide.
- [ ] `fixtures/mutations.js` — inject known deviations: resize a section, add an off-palette
      color, shift a spacing scale, change a radius, break an `@font-face`
- [ ] Assert the audit finds **exactly** the injected set — no misses, no extras
- [ ] Unit tests: `color`, `text` normalization, `fonts` PostScript resolution, prune fixpoint,
      Needleman–Wunsch alignment
- [ ] Determinism: two consecutive runs produce identical findings

**Exit:** zero findings on the unmutated fixture; exact match on the mutated one.

---

## 10. What to do right now

**Phase A, then Phase B.** Concretely, in order:

1. Trim `ir/schema.js` and stop populating the dropped fields
2. Rewire the `cli.js` stage list to `… P5 → P6 → S1 → S2 → S3 → S4 → S5`
3. Add the `section` + `matching` blocks to the tolerance profile
4. Build `pipeline/prune.js` and `pipeline/spacing.js`
5. Run, confirm prune stats look sane on both sides

That is roughly 2.5 days and unblocks C–G. It also requires **no decisions from you** — every
open question below sits in Phase C or later.

---

## 11. Open decisions

| # | Question | Needed by | Recommendation |
|---|---|---|---|
| 1 | Keep the unstable-node machinery (mutation observer + motion probe, ~40 lines)? | Phase A | **Keep.** Cheap, and lets the report flag dynamic sections rather than silently mis-reporting them. |
| 2 | Section granularity — top-level only, or split very tall sections (web §6 is 3495px)? | Phase C | ✅ **Answered: top-level only.** Web §6 being 3.7× its design height is a *finding*, not a segmentation problem. Splitting it would hide the very thing we want reported. |
| 3 | Height comparison — normalized, absolute, or both? | Phase C | ✅ **Answered by data: ABSOLUTE gates, normalized is context only.** My original recommendation (normalized) was wrong. Both sides render at the same 1920px width, so pixel heights are directly comparable; normalizing divides the 1.21× total difference into every section. Measured: median absolute ratio **1.06** (8/18 within ±10%) vs median normalized **0.87** (1/18). Normalized would have flagged 17 of 18 sections. |
| 4 | Is the 18 vs 19 section gap an unbuilt section or a split one? | Phase D | ✅ **Answered: a split.** The page renders the design's first 980px section as a separate `<header>` (69px) plus a hero `<section>` (792px). Everything after is 1:1 — shifting web by one gives 12/18 exact headline matches and positional consistency throughout. **No design section is unbuilt.** |
| 5 | Should S5 use `claude-opus-5` or `claude-sonnet-5` for the report? | Phase F | **Opus 5.** It is one call per run, and the report is the user-facing artifact. |

Carried over, no longer blocking: the Tier 2.5 token-source question dissolves under V1 (§1.3).

---

## 12. What V1 explicitly does not do

Restated so it stays visible during implementation:

❌ Per-node matching inside sections · per-node property comparison · **text content
comparison** · dynamic-content handling (flagged and excluded, not solved) · SVG overlay UI ·
baselines · CI gating · `data-figma-node` annotations · multi-breakpoint · token-conformance
audit against an abstracted design system
