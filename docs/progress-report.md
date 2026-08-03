# Figma Design Parity POC — Progress Report

Living tracker for implementation. Full design/rationale lives in `docs/poc-implementation-plan.md` — this file only tracks **what's actually been done**, **what's pending**, and **what you need to do manually**. Update it as each phase moves.

Parent feature design: `evertest-backend/docs/figma-design-parity.md`.

---

> **2026-07-31 — scope changed to V1 section-level comparison.** See `docs/v1-architecture.md`
> (HLD) and `docs/v1-implementation-plan.md` (phases A–G). The extraction half below is
> **unchanged and still current**; the comparison half of the original plan is superseded.
> Phase numbering below refers to the *old* plan — new work tracks phases **A–G**.

## Status at a glance

| Phase | Status |
|---|---|
| 0 — Scaffold, config, CLI | ✅ **Complete** — pipeline runs end-to-end, stops cleanly at first unimplemented stage, color module verified against known values |
| 1 — Figma side (M2 + M4) | ✅ **Complete** — 1828 nodes → IR, 49/49 spot-checks and 1828/1828 invariants pass, cache verified (13.2s → 1.1s) |
| 2 — Web side (M1 + M3) | ✅ **Complete** — 3219 nodes in ~13s, CDP fonts 62 probes / 0 failures, found a real webfont bug |

### V1 phases (current plan — `docs/v1-implementation-plan.md`)

| Phase | Status |
|---|---|
| A — Realign existing code | ✅ **Complete** — IR trimmed to v2.0.0, CLI rewired to S-stages, tolerance profile v2. Zero regressions. |
| B — P5 pruning + P6 measured spacing | ✅ **Complete** — trees converged from 1.76× apart to **0.81×**; 0 integrity violations |
| C — S1 section segmentation | ✅ **Complete** — 18 figma / 19 web sections; the 18-vs-19 gap explained; a plan error corrected by the data |
| D — S2 section matching | ✅ **Complete** — 18/18 agreement with the human-verified alignment, mean confidence 0.83 |
| E — S3 section comparison | ✅ **Complete** — 103 findings, every one attributable to a named section pair |
| F — S4 findings + S5 LLM report | ✅ **Complete** — pipeline runs end-to-end (exit 0); prose is optional and degrades gracefully |
| G — Validation harness | ✅ **Complete** — 35/35 unit tests, harness **PASS**: 5/5 deviations detected, 0 unexpected, baseline 9 |

**Superseded by the V1 rescope:** token audit (M7a), token authority tiers incl. the Tier 2.5
question, the M8 anchor-feasibility probe, and the "byte-identical IR" determinism goal.

**Scope reminder:** this POC is parent-doc Phase 1 only — the correspondence-free token audit. No node matching, no pairwise comparison, no LLM, no Supabase, no React UI. See plan §1.2.

---

## Phase 0 — Scaffold, config, CLI

### Done (code, this session)

| File | What it does |
|---|---|
| `package.json` | ESM, Node 24, `playwright@^1.57.0` (pinned to match `evertest-backend`, so the port is mechanical), `dotenv`. Scripts: `audit`, `extract:web`, `extract:figma`, `test`. |
| `.env.example` / `.env` | `.env` is gitignored and holds the real values. `.env.example` holds placeholders only. |
| `.gitignore` | `node_modules/`, `.env`, `.cache/`, `out/` |
| `config/tolerance-default.json` | Parent doc §6.6 defaults **as data, not constants** — becomes a `design_tolerance_profiles` row on port. Also carries the §2.4 gate thresholds, tier-3 inferred-token thresholds, and §3.13 probe bands. |
| `src/ir/color.js` | OKLab/OKLCH conversion, `deltaEOK`, alpha compositing, `compositeOver`, hex/format helpers. |
| `src/ir/schema.js` | M5 IR — `VisualNode` with every field explicit, `makeSnapshot`, `walk`, `indexById`, `IR_SCHEMA_VERSION = 1.0.0`. |
| `src/config.js` | `.env` load, Figma URL parsing, tolerance load, `applyFrameWidth` (the §3.2 auto-derive + override warning). |
| `src/cli.js` | Declarative stage list, flag parsing, staged execution with precise "stopped at X, next file Y, plan phase Z" reporting. |

### Design decisions made while building

**The pipeline is a declarative stage list, not a call chain.** From Phase 0 onward `npm run audit` always runs end-to-end and fails with a precise message at the first unimplemented stage, rather than dying on an undefined import and leaving you to work out how far it got. Each pending stage names its target file and plan phase.

**`viewportWidth` is resolved by the pipeline, not by `config.js`.** It is auto-derived from the frame's `absoluteBoundingBox.width`, which needs an API call. This creates a hard ordering constraint recorded in code and in plan §3.2: **M2 must run before M1.** `applyFrameWidth()` warns loudly if `VIEWPORT_WIDTH` is set and disagrees with the frame — comparing a fixed-width frame against a page at a different width makes essentially every finding noise (parent doc §3.1).

**Exit codes are distinct** so this is scriptable later: `0` ok, `1` unexpected error, `2` config error, `3` stopped at an unimplemented stage.

### Verification evidence

Phase 0 exit criterion was *"`npm run audit` runs end-to-end and fails with a clear message at the first unimplemented stage."* Met:

```
  [M2 ] Figma extraction (REST + cache) ... not implemented

Stopped at M2 - Figma extraction (REST + cache)
  next file  src/figma/client.js
  plan phase 1
```

**Config error paths** — all verified:

| Input | Result |
|---|---|
| File-level URL (no `node-id`) | Rejected with the fix instructions, incl. "`t=` is a share token, not a node id" |
| `--nonsense` | `Unknown flag`, exit 2 |
| `--web-only --figma-only` | `mutually exclusive`, exit 2 |
| `?node-id=2743-6476` | → `2743:6476` ✓ |
| Legacy `/file/ABC123/…?node-id=1-2` | → `{ABC123, 1:2}` ✓ |
| Already-colon `?node-id=10:20` | → `10:20` ✓ (passes through) |

**`src/ir/color.js`** — verified against known values:

| Check | Result |
|---|---|
| White OKLCH L | `1.0000` ✓ |
| Black OKLCH L | `0.0000` ✓ |
| ΔE white↔black | `100.00` — confirms the ×100 scaling maps full lightness range onto CIE-ΔE intuition ✓ |
| ΔE identical | `0.0000` ✓ |
| Figma float `{r:0.5137…, g:0.3607…, b:0.9607…}` → hex | `#835CF5` ✓ (the file's real brand color) |
| Grey chroma | `0.000000` — hue pinned for achromatic, not float dust ✓ |
| RGB→OKLab→RGB round trip | `131 92 245` exact ✓ |
| 50% black over white | `#808080` ✓ |
| **Figma-float vs CSS-int, same color** | **ΔE `0.0000`** — the exact case that motivates ΔE over hex equality ✓ |

**Environment:** `npm install` clean (3 packages, 0 vulnerabilities). Playwright Chromium 151.0.7922.34 downloaded.

**Nothing left in Phase 0.**

---

## Phase 1 — Figma side (M2 + M4)

### Done: the spike

Run **2026-07-30**, deliberately *before* writing the normalizer (plan §5 Phase 1 ordering). It paid for itself immediately — see the `fontWeight` finding below.

Raw dump: `out/figma-raw.json` (1.6 MB), file meta: `out/file-meta.json`.

**Target verified live:**

| Field | Value |
|---|---|
| File | `QL website try` — HTTP 200, token role `viewer` |
| Frame | `2743:6476` = `FRAME` "Final Home Page (Enhancements) Web View" |
| **Viewport (derived)** | **1920** × 19752 px |
| `version` (cache key) | `2381962916501534456` |
| Scale | 1828 nodes · 470 frames/instances · 287 TEXT · 33 components · 20 componentSets |

**All 7 open questions answered, plus a new 8th discovered.** Full detail in plan §9. Summary:

| # | Answer | Impact on code |
|---|---|---|
| 1 | `fills[]` entries carry `visible:false` and **must be filtered** | M4 filter required; multi-`SOLID` order still to check |
| 2 | `letterSpacing` already px, no unit field | Parent doc's "% → px" is Plugin-API-only — **drop that conversion** |
| 3 | No literal `AUTO`; `lineHeightPx` populated even for `INTRINSIC_%` | **Planned null-fallback not needed** — always read `lineHeightPx` |
| 4 | Styles map: 5 file-level, 34/1828 nodes (1.9%) | **Token tier 2 useless here** → drove the Tier 2.5 addition |
| 5 | `?depth=1` returns `version` + `lastModified` cheaply | Cache design in plan §3.3 **confirmed** |
| 6 | `absoluteRenderBounds` on 1613/1828 (88%) | **`renderBox` needs a documented fallback** to `absoluteBoundingBox` |
| 7 | `boundVariables` on 1/1828 | **Token tier 1 not testable** on this file |
| **8** | **`style.fontWeight` is unusable directly** | **New. Would have poisoned the audit.** See below. |

### 🔴 Q8 — the finding that justified the spike

The file uses **Geist**, a variable font. The REST API reports its raw **weight-axis** value, and reports *both* schemes for the same PostScript face depending on the node:

| PostScript name | Reported `fontWeight` | True CSS weight |
|---|---|---|
| `Geist-Regular` | **84** (×64) *and* 400 | 400 |
| `Geist-Medium` | **106** (×7) *and* 500 | 500 |
| `Geist-SemiBold` | **126** (×40) *and* 600 | 600 |
| `Geist-Bold` | **146** (×26) *and* 700 | 700 |
| `Geist-Black` | **176** (×2) *and* 900 | 900 |

Ratio hovers near 4.76× but is **not consistent enough to invert** (400/84 = 4.76, 900/176 = 5.11), so arithmetic conversion is out.

**Unhandled, the first run would have reported "the design uses 10 font weights, the page uses 4" and emitted 5 phantom violations, all false.**

**Resolution:** `fontPostScriptName` → `(family, weight, style)` is **mandatory and load-bearing**, not the convenience parent doc §6.3 implies. Normalized correctly, the weight set collapses to a clean **400/500/600/700/900**.

This generalizes to every variable font, so it will recur across customers — it is action item #6 for the parent doc.

### Preliminary gate readings (pre-normalization, therefore pessimistic)

| Signal | Reading | Assessment |
|---|---|---|
| Auto-layout coverage | 306/470 = 65.1% | Decent — strongest hygiene component |
| Default-named layers | 1324/1828 = 72.4% | **Weak** |
| Nodes inside instances | 49/1828 = 2.7% | **Weak** — components exist but barely used here |
| **Rough hygiene (§9.6 weights)** | **≈ 0.39** | **At the 0.4 gate.** Fine for token audit, warning for Phase 2 |
| Distinct colors | 50, top-8 = **81.2%** | **Good** — clear palette `#835CF5` / `#1C2025` / `#FFFFFF` |
| Distinct font sizes | 44, top-8 = 73.2% | Inflated by scaling artifacts |
| Distinct radii | 26 | **Poor** — heavily polluted |
| Font families | 5 — Geist 195, Public Sans 50, DM Mono 31, Inter 7, Nunito Sans 4 | Inter/Nunito tails likely strays |

**Scaling artifacts:** `fontSize: 22.20689582824707`, `cornerRadius: 47.586204528808594` etc. indicate frames resized non-uniformly rather than re-laid-out. Genuine design defects the audit *should* report — but they will dominate radius findings unless ranked by occurrence count (plan §3.10).

### Done (code, this session)

| File | What it does |
|---|---|
| `src/ir/fonts.js` | PostScript → (family, weight, style). **Load-bearing, not a convenience** — the only valid Figma weight source (Q8). Weight-keyword table matched longest-first so `SemiBold` beats `Bold`; foundry noise suffixes (`MT`, `Std`, `Pro`) stripped. Precedence: PostScript → plausible CSS weight → 400-with-a-flag. |
| `src/ir/text.js` | §6.4 normalization — the single shared implementation both sides must use. Also `textHash` (FNV-1a) and `isNumericLike` for the §3.13 probe. |
| `src/figma/client.js` | REST client, one-slot token bucket, 429/5xx backoff honouring `Retry-After`, version-keyed cache, `--no-cache`, stale-cache degradation. |
| `src/figma/normalize.js` | Tree → IR. Frame-space rebasing, opacity accumulation, fill/stroke/effect/radius reading, stroke-align normalization, role inference. |
| `src/figma/tokens.js` | Tier resolution (1 / 2 / 2.5 / 3) with an explicit `circular` flag on tier 3. |
| `src/figma/stage.js` | M2 + M4 stage wiring, keeps `cli.js` declarative. |
| `src/cli.js` | M2/M4 stubs replaced with real stages; per-stage timing + info line. |

### 🔴 Bug found and fixed: `makeNode` silently dropped `_figma`

`src/ir/schema.js`'s `makeNode` builds an **explicit fixed shape** — deliberately, so a missing field and a genuinely-absent value can't look the same. The side effect is that anything not named in the factory is silently discarded, and `_figma` (the extractor-private metadata block) was not named.

Caught because the tier-2 assessment reported **`Styles: 0/1828 nodes (0.0%)`** when the spike had measured 34. The IR was reading `n._figma.styleRefs` from a property that no longer existed.

**The real cost was downstream, not here.** `_figma` carries `visible`, `clipsContent`, node `type`, and `boundVariables` — which are exactly the inputs **P5 pruning (Phase 3) needs**. Without them, pruning would have had nothing to work with and 35 invisible nodes would have silently polluted every histogram. The symptom surfaced in Phase 1; the damage would have landed in Phase 3 and looked like a pruning bug.

Fixed by declaring `_figma` and `_web` as first-class optional fields, documented as **not part of the comparable IR** — nothing in the audit or comparison layers may read them as design values. Post-fix: `34/1828 (1.9%)` and `bound 1/1828`, both matching the spike exactly.

### Verification evidence

**Spot-check, IR vs raw API — 49 assertions across 6 structurally different nodes, 0 failures:**

| Node | Verified |
|---|---|
| TEXT, Geist variable weight | box rebasing, fontSize, lineHeightPx, letterSpacing, family, **Q8: raw 126 → IR 600** |
| Root FRAME | box = (0,0,1920,19752), fill `#F2F2F2` |
| FRAME with radius | radius `14.874370574951172` preserved exactly, stroke width, `inset`, `strokeOutset` |
| FRAME with stroke | width, `border.inset=true`, `strokeOutset=0` for INSIDE |
| INSTANCE with shadow | shadow x/y/blur |
| TEXT with opacity 0.8 | **composited alpha 0.8**, accumulated opacity, **Q8: raw 84 → IR 400** |

**Full-tree invariant sweep — 1828/1828 nodes, 0 violations:**

- `boxAbsolute` = raw `absoluteBoundingBox` − frame origin, on all four components
- `boxRelative` = `boxAbsolute` − parent's `boxAbsolute`
- opacity monotonically non-increasing down the tree (compositing correctness)
- every raw `TEXT` has a resolved `type{}` — 287/287
- parent↔child links consistent in both directions
- **node counts match the raw tree exactly** — 1828/1828, nothing invented or dropped

**Q8 fix, measured end-to-end:** font weights collapsed from a nonsense **10** (84, 106, 126, 146, 176, 400, 500, 600, 700, 900) to a clean **5 — 400/500/600/700/900**. Weight sources: 286 PostScript, 1 `figma-fontWeight`, **0 fallback**. That one node has `postScriptName: null` and family `Inter`, so it correctly fell through to the plausible-CSS-weight path — the precedence chain working, not a gap.

**Cache:** cold 13205ms → warm **1139ms**. The residual is the mandatory `?depth=1` version call. Node ids are sanitized (`2743:6476` → `nodes-2743_6476.json`) because `:` is illegal in Windows filenames.

**Cache invalidation demonstrated unintentionally:** the file's `version` changed from `2381962916501534456` (spike) to `2381969896885789583` (implementation) — someone edited the file mid-session, and the cache correctly refetched rather than serving stale data.

### 🔴 Tier 3 circularity is now confirmed on the real file, not hypothetical

The live tier resolution reports:

```
Tier 3 - Inferred from the frame under test (weak)
  Variables: HTTP 403 - Variables API requires an Enterprise plan.
  Styles:    34/1828 nodes (1.9%)
  circular:  true
```

Both upper tiers are genuinely unavailable, so **Tier 2.5 is not an optimization — it is the only way this audit can say anything meaningful about undefined values.** Under tier 3 the frame defines the standard it is judged against, so the check "the page uses a value the design system does not define" is structurally impossible to answer.

This moves Tier 2.5 from "nice addition" to **required for Phase 4**, and raises the priority of manual action #3.

**Nothing left in Phase 1.**

---

## Phase A — Realign existing code

### Done

| File | Change |
|---|---|
| `ir/schema.js` | Dropped `sourceRef.annotationId`, `fill.imageFit`, `border.style`, `layout.justify/align`. Added `fill.paints` as a first-class field (V1 compares color **sets** per section, so every visible paint matters, not just the nominated background). `IR_SCHEMA_VERSION` → **2.0.0**. |
| `figma/normalize.js` | Stopped emitting `firstBaselineY`, `textAlign`, `textDecoration`, `imageFit`, `border.style`, `layout.justify/align` |
| `web/normalize.js` | Same set |
| `cli.js` | Stages `P5 P6 P7 M7a G M10 R D` → `P5 P6 S1 S2 S3 S4 S5`. Phase labels now A–G, pointing at `v1-implementation-plan.md`. Header/help text rewritten for V1. |
| `config/tolerance-default.json` | **v2.** Added `section` (12 thresholds), `matching` (weights + gap penalty + confidence floor), `segmentation` (strip/height/width cutoffs). Removed `gates`, `inferredToken`, `anchorProbe` with a `_superseded` note explaining why and where to restore them from. |
| `src/audit/` | Deleted (empty — the token-audit modules were never written) |
| `src/sections/`, `src/pipeline/` | Created |

`textTransform` was **kept on both sides** despite being a text field: it feeds text normalization for the S2 matching anchors. Commented as such so it does not look like an oversight later.

### Verification

**Zero regressions** — the full Phase 1/2 verification re-run against the trimmed IR:

| Check | Result |
|---|---|
| Figma invariant sweep | **0 violations** across 1828 nodes |
| Node count vs raw tree | 1828 = 1828 ✅ |
| Q8 font-weight normalization | still `400/500/600/700/900` ✅ |
| `_figma` / `_web` present | 1828/1828 and 3219/3219 ✅ |
| Rendered-font finding | still **373** PublicSans→Arial nodes ✅ |
| Pipeline | reaches **P5**, stops cleanly, cites phase B ✅ |

**IR size:** figma 4.63 → **4.16 MB** (−10%), web 8.71 → **8.27 MB** (−5%).

Modest, and worth being honest about: field-trimming alone does not shrink the model much because the node *count* dominates. The real reduction comes from **P5 pruning** in Phase B, which removes whole nodes — 35 invisible Figma nodes and the web's div soup.

**Nothing left in Phase A.**

---

## Phase B — P5 pruning + P6 measured spacing

### Done

| File | What it does |
|---|---|
| `pipeline/prune.js` | Visibility pruning, clip-rect pruning, transparent-wrapper collapse to fixpoint. Dropped nodes **reparent** their survivors (a `visibility:hidden` container can hold a `visibility:visible` child), and `boxRelative` is **recomputed** afterwards because reparenting invalidates it. |
| `pipeline/spacing.js` | Direction inferred from child geometry (not `flex-direction`/`layoutMode`); `gapsMeasured` + median; `paddingMeasured` from parent box to child extremes. Overlapping siblings yield **no gap**, never a negative one — a negative "gap" is an overlap and would corrupt the spacing scale. |
| `pipeline/stage.js` | P5 + P6 wiring; writes the pruned + measured IR that S1 onward consumes. |

### Result: parent doc §6.1 tested and confirmed

The claim was *"this step alone closes most of the structural gap."* Measured:

| | Figma | Web | Web ÷ Figma |
|---|---|---|---|
| Before prune | 1828 | 3219 | **1.76×** |
| After prune | **1615** | **1314** | **0.81×** |
| Removed | −11.7% | −59.2% | |

Two trees that were nearly 2× apart are now within 20% of each other. The claim holds.

**Prune reasons** — figma: `clipped-out:120 group-collapsed:38 figma-invisible:35 opacity-0:20` · web: `zero-area:1449 clipped-out:250 wrapper-collapsed:153 opacity-0:53`

### Verification

| Check | figma | web |
|---|---|---|
| Integrity violations (parent links, dangling children, stale `boxRelative`) | **0** | **0** |
| All nodes reachable from root | 1615/1615 | 1314/1314 |

### 🔴 Correction to a Phase 2 finding

Phase 2 reported *"PublicSans declared on **373** nodes, all rendering Arial."* Pruning shows **309 of those were inside a `display:none` nav mega-menu** — `box=0×0`, `display:block`, `visibility:visible`, which is the signature of content under a hidden ancestor.

**Corrected: 64 visible nodes render Arial instead of PublicSans.**

The number shrank; the finding got *worse*. The 64 include the entire primary navigation (`Services`, `Hire Talent`, `Industries`, `Portfolio`, `Company`), `Let's Talk AI`, `Contact Us`, the compliance badges (GDPR / HIPAA / ISO 27001), and the footer email and phone number.

Without P5 the report would have overstated the blast radius by **6×**. This is the concrete case for pruning that parent doc §6.1 describes in the abstract.

### Early signal for S3

Non-zero measured gaps, most-used first:

```
figma: 16, 2, 24, 8, 12, 40, 20, 21.8, 3.2, 10, 25, 32
web  : 16, 8, 20, 24, 40, 12, 4, 14, 26, 60, 32, 64
```

**7 of the design's top 12 spacing values (16/24/8/12/40/20/32) appear on the page** — a real shared 4px-based scale is visible on both sides. Total gap counts are also close (figma 491, web 481), which suggests section-level spacing comparison in S3 will have usable signal rather than noise.

Figma's `21.8` and `3.2` are the scaling artifacts flagged in Phase 1 (non-uniformly resized frames); the page's `14`, `26`, `60`, `64` are off-scale values that S3 should surface.

**Nothing left in Phase B.**

---

## Phase C — S1 Section segmentation

### Done

`sections/segment.js` + `sections/stage.js`. Segments both sides into ordered sections with a digest each, writes `out/sections.json`, prints a readable table.

**Result: Figma 18 · Web 19.** Rejected: 2 thin decorative strips (Figma, h=20px), 1 narrow floating widget (web, 282px chat iframe).

Each section carries a `headline` — the text of its largest-font node. That was added purely so the alignment table is readable by eye, and it is what made the two findings below visible immediately.

### ✅ Open question §9.3 answered: the 18-vs-19 gap is a **split**, not an unbuilt section

The page renders the design's **first 980px section as two**: a `<header>` (69px) plus a hero `<section>` (792px) — 861px combined.

Shifting web by one gives **12/18 exact headline matches** and positional consistency across all 18. The remaining 6 differ by content wording, not position. **No design section is missing from the page.**

### 🔴 A plan error the data corrected

Plan §11 Q3 recommended **normalized** height for gating, on the reasoning that the page is 21% taller overall. **That was wrong**, and building S3 on it would have produced a report that was nearly all false positives.

| Measure | Median ratio | Sections within ±10% |
|---|---|---|
| **Absolute** (web px ÷ figma px) | **1.060** | **8 / 18** |
| Normalized (÷ total height) | 0.873 | 1 / 18 |

Both sides render at the **same 1920px width** — enforced by config, parent doc §3.1 — so pixel heights are directly comparable. Normalizing divides the 1.21× total-height difference into every section and would have flagged **17 of 18** as wrong.

Fixed in `tolerance-default.json`: `heightRatio` now gates on the absolute ratio; normalized is retained for **position**, where cumulative offset genuinely does drift.

### Real findings already visible, before S3 exists

Absolute height ratios (web ÷ figma) under the confirmed alignment:

| Pair | Figma | Web | Ratio |
|---|---|---|---|
| f7 → w8 "hire for AI-native execution" | 639px | 3150px | **4.93×** |
| f5 → w6 "turning AI ambition into enterprise-grade systems" | 941px | 3495px | **3.71×** |
| f3 → w4 "AI experiments are easy" | 906px | 1594px | **1.76×** |
| f8 → w9 | 890px | 1500px | **1.69×** |
| f6 → w7 "recognized for engineering excellence" | 1204px | 742px | **0.62×** |

Eight sections sit within ±10%, which is the reassuring part — the outliers stand out against a clean baseline rather than drowning in noise. The two extreme ones (3.7× and 4.9×) are almost certainly design frames showing a single card or state where the page renders the full expanded set.

### Known V1 limitation recorded

Plain Needleman–Wunsch yields 1:1 alignment with gaps, so the header split will report as *"extra section in web"* rather than *"design section 1 is split in two."* Honest but coarse. Merge detection — an inserted section whose **combined** height with its neighbour better fits the Figma section — is noted as V1.5, not a V1 blocker.

**Nothing left in Phase C.**

---

## Phase D — S2 Section matching

### Done

`sections/match.js` — Needleman–Wunsch order-preserving alignment with gaps, four-component cost, per-pair confidence, demotion below the floor. Writes `out/section-alignment.json` and a side-by-side table.

**This is the module that replaces M8** — the 3–4 week, ~60%-of-total-risk node matcher. At section level it is a 1-D alignment over 18×19 candidates instead of a tree alignment over 1615×1314 nodes.

### Exit criterion met — 18/18 agreement with the human read

The matcher independently reproduced the alignment established by eye in Phase C:

- web §1 (`<header>`, 69px) → **extra-in-web** — the confirmed split
- figma §*i* → web §*i+1* for all 18 — **no mismatches**
- 0 missing-in-web

### 🔧 One structural fix, made for a general reason and verified not to be overfitting

The first run produced the **correct alignment** but with poor confidence — mean 0.707, minimum 0.523 against a floor of 0.45. Only 0.07 of margin.

The cost breakdown showed why: `f10→w11` had height cost 0.04 and text cost 0.32 — both excellent — yet a **position cost of 0.86**. Pixel-normalized position *accumulates* error, and two sections on this page are 3.7× and 4.9× their design height, pushing everything below them far down in normalized terms. This is exactly the cascade parent doc §7.4 describes: *"a 4px error near the top of the page shifts every element below it."*

Fixed by computing positional cost from **rank** rather than pixel offset — section 10 of 18 and section 11 of 19 sit at the same relative depth regardless of how tall the intervening sections are. Needleman–Wunsch already enforces ordering structurally, so pixel position was double-counting order while adding drift noise.

| | Before | After |
|---|---|---|
| Mean confidence | 0.707 | **0.826** |
| Minimum | 0.523 | **0.680** |
| Margin above floor | 0.073 | **0.230** |
| Pairs ≥ 0.75 | 5/18 | **15/18** |

**The alignment itself did not change.** That was the test: a fix that improves confidence without altering a known-correct result is a real fix; one that changes the answer would have been overfitting to this page, and I would have reverted it.

### Confidence is now meaningful

The three weakest pairs are weak for legitimate, human-legible reasons — not matcher noise:

| Pair | Conf | Why |
|---|---|---|
| f5 → w6 | 0.68 | Height cost 0.73 — the page section is **3.71×** the design height. Headlines are identical. |
| f14 → w15 | 0.70 | Text cost 0.83 — copy rewritten *("thinking behind production ai…"* → *"most enterprises aren't struggling with ai…")*. Heights match to 1%. |
| f7 → w8 | 0.72 | Height cost 0.80 — **4.93×** the design height. Text cost 0.00, a perfect anchor. |

A human would be least certain about exactly these three, for exactly these reasons.

### Design note: two text signals, not one

Exact-string Jaccard alone scores a rewritten section 0. `f7→w8` is *"Hire forward-deployed engineers for AI-native teams"* in the design and *"Hire for AI-native execution"* on the page — a copy edit, not a different section. Word-level overlap (using the overlap coefficient, since one side legitimately carries more copy) still scores it 1.00.

The matcher takes **the stronger of the two**: exact matches are better evidence when present, but their absence must not be read as evidence of a mismatch. This is what lets a section survive a copy edit without losing its anchor — and it matters, because design copy and live copy diverge constantly.

**Nothing left in Phase D.**

---

## Phase E — S3 Section comparison

### Done

`sections/compare.js` — replaces M9. Nine aggregate checks per matched pair: height, width, background, palette, font family / size / weight, rendered font, spacing scale, radius (numeric + pill), density. Plus page-level total height, and structure findings for unmatched sections.

**103 findings** — 2 critical, 10 high, 70 medium, 21 low. Every one attributable to a named section pair. Deterministic: no LLM in this path.

### Top findings

| Severity | Pair | Property | Design | Page | |
|---|---|---|---|---|---|
| **critical** | f18→w19 | renderedFontFamily | PublicSans | **Arial** | ×52 |
| **critical** | f13→w14 | renderedFontFamily | PublicSans | **Arial** | ×5 |
| high | f7→w8 | section.height | 639px | 3150px | **4.93×** |
| high | f5→w6 | section.height | 941px | 3495px | **3.71×** |
| high | f3→w4 | section.height | 906px | 1594px | 1.76× |
| high | f8→w9 | section.height | 890px | 1500px | 1.69× |
| high | f18→w19 | section.height | 655px | 916px | 1.40× |
| high | f6→w7 | section.height | 1204px | 742px | 0.62× |
| high | f17→w18 | backgroundColor | #FFFFFF | **#09070C** | light→dark |
| high | f1→w2 | backgroundColor | #FFFFFF | #9C7DF7 | |
| high | f11→w12 | backgroundColor | #6B4ACC | #835CF5 | |
| high | f18→w19 | backgroundColor | #F4F1FE | #FFFFFF | |

### Three measurement decisions the data forced

**1. Dominant background must be measured by AREA.** Two simpler measures were tried and both misread the real page:

- *The section element's own background* — web §18 declares `#09070C` while `#FFFFFF` covers it; Figma §17 declares `#FFFFFF` while `#FAFAFA` covers it. Produced a black-vs-white finding on sections that both read as light.
- *The most-used paint* — frequency counts every text node, so a text-heavy section reports its **body-copy colour** as its background.

Area, excluding text nodes, is what a person actually sees. Background findings dropped 6 → 4, and the survivors verified: web §18's `#09070C` genuinely covers 2.69 Mpx (the full 1920×1400 section) against a white design section. That is a real full-section light→dark inversion.

**2. Fully-rounded radius is a CATEGORY, not a number.** `border-radius: 9999px` is the pill idiom; Figma sizes the same pill to the box.

My first fix — clamping to `min(w,h)/2` — **made it worse**: 19 findings became **33**, because the clamp yields a different number for every box (93, 190, 325, 450…). Collapsing both sides to one boolean gives **15**, with a sane numeric set (8, 16, 32, 2, 4, 10, 12, 24) plus 7 pill findings. Recorded because the wrong fix looked obviously right.

**3. Per-section vertical offset is deliberately not reported.** It is mathematically determined by the heights above it, so reporting it would restate every height finding once per following section — the cascade parent doc §7.4 warns about. Total document height is reported **once** at page level.

### Contract guard

S3 throws if any finding carries something that looks like text content. The V1 premise — design copy and live copy legitimately differ — is enforced structurally rather than by convention, because a regression there would be silent.

### Known remaining noise, not yet addressed

**Figma's own scaling artifacts become reference values.** Phase 1 found values like `fontSize: 22.207` and gaps of `3.2px` / `21.8px` from non-uniformly resized frames. Comparing a clean web `8px` against a design `3.2px` produces a technically-correct but useless finding. Filtering artifact-looking design values is tolerance tuning — the parent doc budgets 4–8 weeks for exactly this and calls it the product, not polish.

**Unmatched sections produce no property findings.** The web `<header>` is extra-in-web, so its own Arial-instead-of-PublicSans nodes are never compared. A consequence of the 1:1 alignment limitation already recorded in Phase D.

**Nothing left in Phase E.**

---

## Phase F — S4 finding assembly + S5 report

### Done

| File | What it does |
|---|---|
| `report/findings.js` | S4 — grouping, severity modifiers, fingerprints, deterministic ordering |
| `report/console.js` | Terminal summary: shape, per-section badges, top findings |
| `report/html.js` | Self-contained HTML, light + dark, colour swatches, no external requests |
| `report/llm.js` | S5 prose via `claude-opus-5` — **optional**, never fails the run |
| `report/index.js` | Stage wiring |

**`npm run audit` now completes end-to-end — exit 0.**

### Grouping and severity

**103 raw findings → 90.** Grouping keys on `(category, type, property, expected, actual)` and deliberately *excludes* the section, so one problem seen in several places reads as one finding with a section list. The two `PublicSans → Arial` findings collapsed into a single **×57 across 2 sections** entry.

Severity modifiers (parent doc §9.3) fired as intended — an off-palette colour at 35 occurrences and an off-scale 16px gap at 33 occurrences both upgraded medium → high, each carrying a `severityReasons` note so the upgrade is visible rather than mysterious. Findings inside dynamic sections downgrade one level for the same reason.

Fingerprints are computed even though V1 has no baselines — it validates the Phase-5 format now, for free. The bucketing is coarse but non-collapsing: accepting "this section is 80px taller" must not silently accept a later regression to 800px.

### S5 is optional by design

Parent doc §1.3: *"Findings are data; prose is a rendering layer."* Every value exists before the model is called, so a missing key costs the narrative and nothing else.

Three independent degradation paths, none of which fail the run:

- No `ANTHROPIC_API_KEY` → skipped with a note
- `@anthropic-ai/sdk` not installed → skipped with an install hint (dynamic import)
- API error or a `stop_reason: "refusal"` → caught, skipped, reason reported

Verified live: with no key set, the run completes cleanly and prints
`Written summary skipped — ANTHROPIC_API_KEY is not set…`.

The prompt forbids inventing numbers, forbids speculating about CSS or Figma internals, and states explicitly that **content differences are not findings** — reinforcing the V1 premise at the one point in the pipeline where a model could undo it.

Model: `claude-opus-5`, ~14.2k input tokens, **≈ $0.15 per report**.

### Verified

| Check | Result |
|---|---|
| Pipeline exit code | **0** — first full green run |
| Findings grouped | 103 → 90 (13 collapsed) |
| Severity upgrades | Applied with visible reasons |
| HTML self-contained | No external requests except the page-URL link ✅ |
| HTML light + dark | `prefers-color-scheme` **and** `data-theme` overrides ✅ |
| Wide-content guards | Both tables wrapped in `overflow-x` containers ✅ |
| Colour swatches | 27 rendered inline from finding values |
| Text-leak guard | Still passing — no finding carries text content |

### S5 is provider-agnostic — Gemini live, Anthropic retained

`LLM_PROVIDER` selects `gemini` (POC default) or `anthropic`, inferred from whichever key is present when unset. `LLM_MODEL` overrides the default.

The Anthropic path is kept deliberately: parent doc §10.2 pins `claude-opus-5` for report generation, so deleting it would mean rewriting it at port time. Gemini goes over plain REST — no extra dependency.

**Live on `gemini-3.5-flash`:** ~11k in / ~1.6k out per report.

Key-specific note: `gemini-2.5-pro`, `gemini-3.1-pro-preview` and `gemini-2.0-flash` all return **429 RESOURCE_EXHAUSTED** on the supplied key, and `gemini-2.5-flash` **404s** despite appearing in the model list. `gemini-3.5-flash` works. The provider is configurable precisely so this is a one-line change rather than a code edit.

### 🔬 Prose audit — enforcing "the LLM never produces a number"

Parent doc §10.3 argues the response **schema** is the real defense and the prompt is belt-and-braces. That holds for the structured mapping call — but the *report* call returns free-form prose, so there is no schema to constrain. Enforcement therefore has to be after the fact.

`report/audit.js` extracts every number the model wrote and checks each traces to a value that existed before the model ran. **Current run: 84/84 traced, clean.**

Two things this exercise established, both worth keeping:

**1. The guard needed its own guard.** Its first run reported "2 untraceable numbers: 752, 991" — which were `19,752px` and `23,991px` split by a naive `\d+` regex on the thousands separator. The model had invented nothing. A guard that cries wolf is worse than no guard, because the real signal gets ignored. Fixed to match digit groups.

**2. Its discriminating power is asymmetric — measured, not assumed.** The allowlist is 217 distinct values on the real page:

| | |
|---|---|
| Fabricated **large** values (heights, deltas, ΔE) | **Very likely caught** — only 30 allowed values are ≥1000 |
| Fabricated **small** integers | **~coin flip** — 53 of the 100 integers below 100 appear somewhere in the allowlist |

Verified by tampering: a report claiming *"padding is 37px instead of the designed 41px"* **passed clean**, because both 37 and 41 occur elsewhere in the findings.

So it is a coarse net for egregious fabrication, **not** a proof of grounding — and it is documented as such in the module rather than quietly overstated. Tightening it means matching numbers against the specific finding under discussion, which needs structured output from the model — i.e. exactly the schema-based enforcement the parent doc prefers.

The content-leak check (prose treating differing text as a defect) fires correctly and was verified against a tampered sample.

**Nothing left in Phase F.**

---

## Phase G — Validation harness

`npm test` · `npm run validate`

### Unit tests — 35/35 passing

`test/units.test.js` covers the functions where a silent regression would corrupt every finding downstream without ever throwing: colour maths (OKLab round-trip, ΔE scaling, alpha compositing, CSS parsing, paren-aware splitting), text normalization, PostScript font-weight resolution incl. the Q8 variable-font case, prune fixpoint and reparenting, measured spacing, sequence alignment, and finding assembly.

**One test caught a real defect.** `makeColor(128,128,128).oklch[1]` was **2.24e-8**, not 0 — `oklabToOklch` pinned the *hue* below the achromatic threshold but left chroma carrying float dust. My earlier manual check had printed `0.000000` because `toFixed(6)` hid it. Fixed at source (both channels pin), not by relaxing the assertion.

Notable coverage, chosen for the failure mode rather than the line:

- **Alignment inserts a gap rather than shifting.** Without gap support one extra page section offsets every pair after it and every downstream finding is wrong.
- **Alignment stays monotonic** — sections cannot cross.
- **Word overlap rescues a rewritten headline** — exact-string Jaccard scores a copy edit 0.
- **Prune reparents survivors and recomputes `boxRelative`** — the bug class that surfaces three phases later looking like a matcher fault.
- **Fingerprints are value-sensitive** — accepting "20 instead of 24" must not silently accept a later drop to 12.
- **Finding order is input-order-independent** — determinism, asserted rather than hoped for.

### Fixture harness — PASS

`fixtures/generate.js` builds an HTML page **from the Figma IR**, so there is no "well, maybe the page really is like that" escape — the page *is* the design. Markup is deliberately prune-resistant (everything paints, nothing is zero-area, `overflow:visible`), otherwise P5 rewrites the tree and we'd be testing the pruner.

```
CLEAN    sections 18/18 ok   matched 18   baseline findings 9
MUTATED  sections 18/18                   findings 14

FOUND  section-height       section 5 rendered 60% taller than designed
FOUND  off-palette-color    an off-palette colour (#FF00AA) in section 3
FOUND  off-scale-spacing    a 13px gap (off the 4px scale) in section 7
FOUND  off-scale-radius     a 37px corner radius in section 9
FOUND  off-scale-font-size  a 47px font size in section 11

UNEXPECTED FINDINGS: none

PASS  5/5 deviations detected, 0 unexpected, baseline 9
```

**Section segmentation and matching reproduced exactly** — 18/18, all matched — on a page the engine had never seen.

### 🔴 The harness caught my own test fixtures

The first run reported **3 unexpected findings**, and they were correct: my mutations each introduced an *uncontrolled second variable*.

| Reported | Cause |
|---|---|
| `#123456` off-palette in §7 | the fill colour on my spacing-mutation divs |
| `#654321` off-palette in §9 | the fill colour on my radius-mutation div |
| `Times New Roman` in §11 | the font-size mutation `<p>` had no `font-family`, so it inherited the browser default |

A mutation must change exactly one property or the assertion means nothing. Fixed by borrowing each section's own palette colour and font family. This is the harness doing its job in the least glamorous way — the engine was right and the test was wrong.

### Baseline of 9 — measured, not assumed

Diffing against a measured baseline rather than asserting a hard zero is deliberate: the fixture cannot load the design's webfonts, so some findings are unavoidable and would otherwise drown the signal.

The 9 break down as **structure:8, shape:1**. The structure findings are `section.nodeCount` density ratios — the fixture reproduces a section's *digest*, not its node tree, so node counts legitimately differ. That is a property of the generator, not an engine false positive.

**The engine's actual false-positive floor on colour, typography, spacing and geometry is zero.**

**Nothing left in Phase G. V1 is code-complete.**

---

## Decisions log

| Date | Decision | Why |
|---|---|---|
| 2026-07-30 | POC is a **standalone repo** outside `evertest-backend` | Zero risk to production code; port module-by-module later (plan §8) |
| 2026-07-30 | Scope = parent-doc **Phase 1 only** | Correspondence-free; avoids M8, which carries ~60% of parent risk |
| 2026-07-30 | Added **M8 feasibility probe** (plan §3.13) | Measures whether text-anchor signal exists without building a matcher. ~½ day for the only early read on the dominant risk |
| 2026-07-30 | Added **token discipline gate** (plan §2.4) | Parent doc's hygiene score measures *structure*; token audit depends on the *value system*. Independent properties — and low discipline has no fallback to gate down to |
| 2026-07-30 | **Web-side counts only** (plan §3.10) | A frame shows 3 cards where production renders 47. Cross-side counts measure the content gap, not drift. Enforced structurally — `Finding` has one count field |
| 2026-07-30 | Added **token tier 2.5** — nominated design-system canvases (plan §2.3 addendum) | Tiers 1 and 2 are both empty on the real file. Tier 3 is **circular** — it infers tokens from the very frame it then judges, so it can never report "uses an undefined value" |
| 2026-07-30 | `fontPostScriptName` is the **only** valid weight source | Q8 — variable fonts report raw axis values |
| 2026-07-30 | Playwright pinned to `^1.57.0` | Matches `evertest-backend` so the port is mechanical |
| 2026-07-30 | `_figma` / `_web` are **declared IR fields**, explicitly outside the comparable model | Pruning needs side-native facts (`visible`, `clipsContent`, `display`, `overflow`) that the shared model deliberately omits. Declaring them beats letting `makeNode` silently drop them |
| 2026-07-30 | **Tier 2.5 is now required for Phase 4**, not optional | Tiers 1 and 2 measured genuinely unavailable on the real file (403 / 1.9%). Tier 3 alone cannot answer the audit's central question |

---

## Action items for the parent doc

To fold back into `evertest-backend/docs/figma-design-parity.md` in Phase 8:

1. **§7.1 / §14.2** — add token authority **Tier 2 (Styles)** and **Tier 2.5 (nominated design-system canvases)**. Requiring Enterprise Variables or disciplined Styles usage excludes the majority of real files.
2. **§9.6** — add a **token discipline** gate alongside the hygiene score. The existing gate silently assumes structural quality implies token quality; it does not.
3. **§4.1.1** — renumber to **12 steps**. The `Date.now` pin and `prefers-reduced-motion` are in the prose but unnumbered, and both must run *before* `goto`.
4. **§9.1** — state the **web-side-counts-only** rule.
5. **§6.2** — state the **ΔE_OK ×100 scaling**, or "≤ 2.0" is unreadable against raw OKLab distances (JND ≈ 0.02).
6. **§6.3** — add the **variable-font weight-axis** rule from Q8. Applies to every variable font, not just Geist.

---

## Manual actions for you

| # | Action | Blocking? |
|---|---|---|
| 1 | **Rotate the Figma PAT** when convenient — it was pasted in chat, so it's in conversation history. Read-only on your own file, so low urgency. | No |
| 2 | Confirm whether **"Final Home Page (Enhancements)"** is the deployed design or a proposal. A sibling frame is named `In Progress 15-06-2026`. Changes report *wording* only — "the page doesn't yet match this design" vs "the implementation drifted". | No — Phase 5 |
| 3 | **Confirm the `Components` and `Spacing guideline` canvases are the right token source for Tier 2.5.** Raised in priority: tiers 1 and 2 are now *measured* unavailable (403 / 1.9%), so without this the audit cannot detect "the page uses a value the design system doesn't define" at all. If those aren't the right canvases, tell me which are. | **Yes — Phase 4** |

---

## Running risks

| Risk | Status |
|---|---|
| Figma field shapes differ from assumptions | ✅ **Retired** — spike answered all 7, found an 8th |
| CDP font plumbing slow/flaky at scale | 🟡 Open — mitigated by signature-grouped sampling (plan §3.7). Phase 2 |
| Page heavily dynamic → non-deterministic IR | 🟡 Open — determinism self-check in Phase 2 will catch it |
| Design file hygiene too low | 🟡 **Materialized, mild** — ≈0.39, at the gate. OK for token audit; a real question for Phase 2 |
| Design has no real token system | 🟡 **Partially materialized** — colors good (81.2%), radii poor. Read the gate **per dimension**, not as one scalar |
| **Tier 3 circularity blunts the audit** | 🔴 **Materialized and confirmed** — tiers 1 and 2 measured unavailable (403 / 1.9%). Tier 2.5 is now mandatory for Phase 4; blocked on manual action #3 |
| Normalization gaps misread as design findings | ✅ **Mitigated by design** — `weightSource` is carried on every text node, so an unresolved weight reports as a normalization gap, never as a design finding. Currently 0 fallbacks |
| Token audit findings mostly noise | ⬜ Unknown until Phase 5 — kill criterion #2 |
| Green POC over-read as validating the whole feature | 🟡 Standing — Phase 1 validates the foundation, not the matcher |
| **19752px page height** | 🟡 **New** — the stabilization scroll loop (plan §3.5 step 8) is the slowest part of the run and the likeliest place lazy-load misbehaves. Instrument from the start |
