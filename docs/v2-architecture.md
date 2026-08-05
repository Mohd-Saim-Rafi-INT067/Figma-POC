# Figma Design Parity — V2 Architecture

**Status:** proposal, for review.
**Supersedes:** the comparison half of `v1-architecture.md`. Extraction is unchanged.

---

## 1. Why V2 exists

V1 is correspondence-free: it compares **aggregates over matched sections** — colour sets, type sets,
spacing distributions, section geometry. That was a deliberate trade to avoid the hardest module, and
it works: the findings are deterministic, defensible, and cheap.

But it cannot say *which element is wrong*, and that is what a user needs. "This section's palette
contains a colour the design doesn't have, 35 times" is a true statement that leaves a developer
exactly where they started. V1's own trade-off table admitted this:

> *"Coarser findings — 'this section's spacing distribution differs', not 'the CTA button's padding
> is 4px off'. Less immediately actionable."*

**V2 accepts the hard module.** Element-level correspondence, element-level comparison, and a report
built around visual evidence rather than tables of numbers.

### 1.1 What carries over

| Component | Lines | Status |
|---|---|---|
| M1/M2 extraction (`web/`, `figma/`) | 2,041 | **unchanged** |
| M5 IR (`ir/`) | 627 | **unchanged** |
| P5/P6 pruning + measured spacing (`pipeline/`) | 589 | **unchanged** |
| S1 segmentation, S2 section matching | 486 | **unchanged** — V2 runs inside its output |
| Tolerance profile | — | **unchanged**, and finally used in full |
| Knowledge base (`report/knowledge.js`) | 289 | extended with element-level entries |
| **S3 aggregate comparison (`compare.js`)** | **338** | **replaced** |
| Analysis + HTML report | 608 | **reworked** for the new report model |
| Server / run orchestration | 863 | mostly unchanged |

Roughly **75% of the engine is untouched**, including everything that took longest to get right —
colour compositing, font mapping, the 12-step stabilization sequence, the CDP rendered-font check,
version-keyed Figma caching. V2 replaces the layer that made the aggregate trade.

---

## 2. Requirements

| # | Requirement |
|---|---|
| **R1** | Compare section by section, then element by element within each section |
| **R2** | Structural comparison — every designed element accounted for; missing and extra both reported |
| **R3** | CSS/style comparison per element, not per section |
| **R4** | Report pinpoints each difference with a screenshot, the element outlined, and a label naming what mismatches |
| **R5** | Explain ΔE in human terms |
| **R6** | Higher accuracy and capability generally |

LLM use in the comparison path is accepted for V2.

---

## 3. The one boundary I recommend keeping

> **The LLM decides identity. Code decides values.**

The model answers *"are these the same element?"* — a judgement call requiring vision and semantics,
which code does badly. It never answers *"is this colour correct?"* or produces a number, because:

- Every value is already measured exactly, on both sides. A model can only degrade that.
- Findings must be reproducible. If values come from a model, the same page yields different numbers
  on different runs, and baselines, CI gating, and trust all collapse.
- The failure mode is invisible. A wrong measurement looks exactly like a right one.

This is not a restriction on capability — correspondence is the part that genuinely needs a model,
and it is the part V2 gives it. The response schema carries **no field capable of holding a
measurement**, so a model ignoring instructions still cannot inject one.

If you want the model to make style *judgements* too, that is a separate decision and I would take it
after seeing V2 run, not before.

---

## 4. Pipeline

Unchanged through S2. V2 replaces S3 with a six-stage per-section loop.

```
M2 ─ M4 ─ M1 ─ M3 ─ P5 ─ P6 ─ S1 ─ S2 ─┐
                                        │
        ┌───────────────────────────────┘
        │   for each matched section pair:
        ├─ E1  Comparable element set      deterministic
        ├─ E2  Element correspondence      LLM + geometry, verified, cached
        ├─ E3  Structural verdict          deterministic
        ├─ E4  Element property compare    deterministic
        └─ E5  Issue prioritisation        deterministic (+ optional LLM fix text)
                                        │
                                        ├─ E6  Evidence render ─ deterministic
                                        └─ E7  Report assembly ─ S5 prose
```

Only **E2** is non-deterministic, and it is cached.

**Note the ordering.** Prioritisation runs *before* evidence, not after. A merged issue is the unit a
reader acts on, so it is also the unit that gets one screenshot. Rendering per raw finding first
would produce four images of the same button and discard three.

---

## 5. E1 — The comparable element set

**The most important stage, and the one most likely to be underestimated.**

Do not compare raw trees. A Figma frame has 1,613 nodes and the page has 1,224; most are wrappers,
masks, and vector fragments that no human would point at. Comparing them produces noise on both
sides and makes correspondence impossible.

Reduce each side to **elements a person would actually point at**:

**Keep**
- text runs (a paragraph, not per-line fragments)
- images, icons, media
- controls — buttons, inputs, links
- any node painting something: background, border, shadow
- layout containers holding ≥2 kept children (they carry the spacing)

**Drop or collapse**
- Figma vector clusters → **one icon node** with the union box and dominant fill
  *(measured: 743 `icon` nodes on the reference file, 57% under 24×24, one parent holding 126 — these
  are decomposed paths, and on the web the same icon is a single `<svg>`)*
- web wrappers with no visual output and a single child — div soup
- zero-area, hidden, or fully-clipped nodes
- nodes outside the section bounds

**Output** — a flat ordered list per side:

```js
{ id, parentId, depth, role, roleConfidence,
  box,               // section-relative, both sides at the same width
  styleSignature,    // fill, border, radius, shadow, fontSize, fontWeight, fontFamily
  hasText,           // presence only - never the string
  childCount, orderIndex }
```

**Target: 20–80 elements per side per section.** That is tractable for correspondence, cheap for the
LLM, and — not coincidentally — the granularity a report can present without drowning the reader.

> **Gate.** After E1, node-count ratios per section pair must approach 1.0. On the reference file
> today they range **0.35 – 2.48** (pair 12→13 is 380 vs 142). If collapse does not fix that, the two
> trees are not comparable and E2 will fail. **This is the go/no-go measurement for the whole design,
> and it costs 2–3 days to find out.**

---

## 6. E2 — Element correspondence

Three tiers, cheapest first.

### 6.1 Tier 1 — Deterministic anchors (no cost)

Pair elements that are unambiguous: exactly one candidate on each side with `IoU ≥ 0.8` on the
section-relative box **and** a compatible style signature **and** consistent reading order. Expect
this to resolve the majority of elements on a well-built page. Anything ambiguous falls through.

### 6.2 Tier 2 — LLM adjudication (vision)

For the remainder only. Input:

- both section renders (PNG, same width)
- the unresolved elements from both sides, plus already-anchored neighbours for context
- each element as its compact E1 record

Output — schema-constrained:

```json
[{ "figmaId": "1:234", "webId": "body>main>section:nth-child(3)>div>button",
   "decision": "match" | "missing_in_web" | "extra_in_web",
   "confidence": 0.0,
   "descriptor": "primary CTA button" }]
```

Vision is the right tool here precisely because the trees are not: a screenshot does not care that
the design's button was never named "button" *(measured: 1 detected Figma button vs 40 on the page)*,
nor that its icon is 126 vector paths.

### 6.3 Tier 3 — Verification (code, always)

Every proposed pairing is checked against measured IR before it is allowed to exist:

- both ids resolve to real elements in this section
- neither is already assigned
- `IoU` above the floor, or an explicit size-change finding is produced
- reading order not inverted beyond threshold
- style signatures not wildly incompatible (a text run cannot match an image)

Rejected proposals are logged, never reported. **The model proposes; the engine disposes.**

### 6.4 Confidence gating

| Confidence | Action |
|---|---|
| ≥ 0.85 | Compare and report normally |
| 0.60 – 0.85 | Compare; findings tagged `low-confidence`, non-gating in CI |
| < 0.60 | Do not compare. Counted as "N elements could not be matched" |

Section-match confidence multiplies in. Pairs at 0.669 and 0.68 in the current run are weak; element
claims derived from them must not carry full severity.

### 6.5 Determinism through caching

```
correspondenceCacheKey = hash( figmaFileVersion, figmaNodeId,
                               webStructuralHash, irSchemaVersion,
                               promptVersion, matcherVersion )
```

`webStructuralHash` covers pruned tree shape only — roles, hierarchy, box topology — **excluding
style values**, so a colour change does not invalidate the mapping. On a hit, E2 is skipped entirely:
zero LLM calls, fully deterministic run. In steady state most runs hit, because design↔page structure
is stable across deploys while styles are not.

---

## 7. E3 — Structural verdict

Per section, every element resolves to `matched`, `missing-in-web`, or `extra-in-web`.

### 7.1 The repeated-group rule

**Mandatory, not an optimisation.** Figma files carry dummy content — three sample cards where
production renders twelve real ones. Without this rule that is twelve false findings, and the report
is dead on arrival.

Detect repeated sibling groups content-free: N siblings with near-identical style signatures and
consistent box sizes. Then compare the **template, not the count**:

| Situation | Verdict |
|---|---|
| Design has 3 dummy cards, page renders 12 real ones | **Not a finding** — data volume, not a defect |
| Design's card template has 2 buttons, page's template has 1 | **Finding, reported once** — not twelve times |

### 7.2 Text is still not compared

Design copy and live copy legitimately differ — placeholder names, lorem text, dummy dates. `hasText`
is a boolean used for correspondence; the string never reaches a finding. This survives from V1 and
should not be revisited.

---

## 8. E4 — Element property comparison

For each matched pair, run the tolerance rules **at element level**, using `boxRelative` — geometry
measured against the *matched parent*, so one mis-sized hero produces one finding instead of
cascading through everything beneath it.

This finally activates the nine rules the tolerance profile already defines and no code has ever
called:

`lineHeightPx` · `letterSpacingPx` · `paddingMeasured` · `boxRelative.size` · `boxRelative.pos` ·
`border.width` · `shadow.geometry` · `shadow.color` · `opacity`

Plus the existing colour, font family/size/weight, radius and measured-gap rules — now per element
rather than per section. Thresholds are already chosen; no new tuning design is needed to start.

### 8.1 Noise is the primary risk

V1 produced 95 findings from aggregates. Element-level comparison across 1,224 web elements can
produce thousands. **A 2,000-finding report is worse UX than the aggregate report it replaces** —
which is the actual complaint V2 exists to fix.

Four controls, all mandatory:

1. **Template grouping** — one finding per repeated component, never per instance (§7.1)
2. **Property grouping** — one finding per (property, value-pair) across elements, carrying the
   element list; V1's `groupKey` already does this and carries over
3. **Cascade suppression** — a parent size mismatch suppresses derived child position findings
4. **Severity gating with progressive disclosure** — default view shows what needs attention; the
   full list is one click away, never the landing page

**Design target: a first-time reader sees fewer than 20 things.** If the design cannot hit that, it
has failed regardless of how accurate the findings are.

---

## 9. E5 — Issue prioritisation

The stage that turns a finding list into a report a person will read. Raw findings are
property-shaped; people are element-shaped. Nobody fixes "a radius"; they fix "the CTA button".

**Merge all findings on one element into a single issue:**

```
Primary CTA Button                                    4 issues · visual severity HIGH
┌──────────────────────────────────────┐
│  [ screenshot, element outlined ]    │   Background   #835CF5   →  #A855F7   ΔE 6.38
│                                      │   Radius       8px       →  12px      +4px
└──────────────────────────────────────┘   Padding      24/16     →  16/12     −8/−4
                                            Font         600       →  500       −100
  figma:1:234  ·  main > section:nth-child(3) > button

  Suggested fix — this element differs on four properties at once, consistent with
  a different component variant rather than four separate mistakes.
```

### 9.1 Two grouping axes, and the conflict between them

V1 already groups **by property across elements** — "this colour is wrong in 13 sections". E5 groups
**by element across properties**. These are orthogonal, and a finding belongs to both, so one of them
has to be the primary view or the same finding gets reported twice.

Resolution — **the same finding set, two projections, neither duplicating data**:

| View | Groups by | Answers | Default |
|---|---|---|---|
| **Needs attention** | element | *what do I fix?* | ✅ landing view |
| **Systemic** | property | *what is the root cause?* | secondary tab |

The systemic view is what catches "this off-palette colour appears on 40 elements" — a token problem,
one fix, not 40. V1's `oneFix` and `systemic` flags already compute exactly this and carry over
unchanged.

### 9.2 Visual severity

Distinct from technical severity, and the right ranking for a human. A 4px padding error on an
800px-wide hero button matters more than the same error on a footer link. All inputs are measured:

```
visualSeverity = f( maxTechnicalSeverity,      // worst single property
                    issueCount,                 // 4 problems > 1 problem
                    elementArea,                // how much of the viewport it occupies
                    viewportPosition,           // above the fold weighs more
                    templateInstanceCount,      // a repeated component multiplies impact
                    matchConfidence )           // a weak correspondence must not shout
```

Weights live in the tolerance profile as data, never as constants in code — same rule as every other
threshold in the system.

### 9.3 Suggested fix

The one place in E5 where a model earns its place. Four properties differing at once on a single
element is not four mistakes; it is usually one wrong component variant. Code can detect the pattern
(*n* properties differ on one element, and a design component with matching values exists nearby);
phrasing the conclusion is a language task.

**Grounding rule:** a suggestion may only cite values already present in the finding set. The
existing prose auditor (`report/audit.js`, which today reports *"50/50 numbers traced to findings"*)
applies unchanged — any suggestion citing an untraceable value is dropped, not shown.

Where `sourceRef.componentName` is meaningful, name it. On the reference file it is not — 45 of 1613
nodes, named "Component 3" — so the fallback is descriptive: *"consistent with a different button
variant"*, never an invented component name.

### 9.4 The volume cap lives here

§8.1 sets the target: **a first-time reader sees fewer than 20 things.** E5 is where that is
enforced — rank merged issues by visual severity, show the top N, collapse the remainder behind
"show all". The cap applies to *merged issues*, not raw findings, which is what makes it achievable:
a button with 4 problems costs one slot, not four.

---

## 10. E6 — Evidence

### 9.1 Draw from measured geometry, never from the model

Verified on the current run: **1613/1613** Figma nodes carry `figmaNodeId`; **1224/1224** web nodes
carry `webPath` and `webSelector`. After E2, every finding is anchored to elements whose boxes are
known to the pixel.

| | Engine draws | Model draws |
|---|---|---|
| Coordinates | exact | approximate — a known vision weakness |
| Determinism | identical every run | varies |
| Cost | zero extra calls | one call per annotation |
| Failure mode | none | boxes around elements that do not exist |

The label keyword — `colour`, `text size`, `spacing`, `radius`, `missing` — comes from the finding's
own `category`/`property`. No model involved.

### 9.2 Annotation spec

- Element outlined on the section render, colour-coded by severity.
- **Label immediately above the outline**, left-aligned to it: `<keyword> · <one-line delta>`
  — e.g. `colour · ΔE 7.43`, `padding · 4px tight`, `missing · primary CTA`.
- Flip below or right when the label would leave the canvas or collide; leader line when displaced.
- Deterministic placement: labels laid out in severity order, so a rerun produces an identical image.
- Node boxes are page-absolute and section captures are crops — translate by section origin before
  drawing.
- A finding spanning many elements outlines the **largest 3 by area** and notes `+N more`.

### 9.3 Capture

- **Web** — Playwright `page.screenshot({ clip })` per section, in the same stabilized state as
  extraction, so pixels and measurements agree.
- **Figma** — `GET /v1/images/:fileKey?ids=<nodeId>&format=png`, cached by
  `(fileKey, nodeId, fileVersion)`; renders are immutable per version.
- Both sides already render at the same width (`applyFrameWidth`), so captures are directly
  comparable.

> **Quota risk.** `/v1/images` is an additional endpoint on an account already returning 429s. Its
> rate-limit tier must be confirmed; the render cache is mandatory.

### 9.4 Side-by-side for geometry

A section rendering 3,150px against a designed 639px is best shown as both thumbnails at matched
scale with the delta bracketed. Reading "4.93×" and seeing it are different experiences.

---

## 11. E7 — The report

The report is the product. Structured for *"what needs my attention"*, not *"here is everything
we measured"*.

The unit of the report is the **merged element issue** from E5 — never the raw finding.

```
PAGE
 ├─ verdict · score · confidence · what was excluded and why
 ├─ NEEDS ATTENTION — top N merged issues by visual severity      ◄ landing view
 ├─ SYSTEMIC — property-grouped: "one token, 40 elements"          ◄ secondary tab
 │
 └─ SECTION  (thumbnail, annotated with every issue it contains)
     ├─ verdict: N matched · N missing · N extra · N with differences
     │
     └─ ELEMENT ISSUE  ── one card, one screenshot
         ├─ identity      "Primary CTA Button"  ·  visual severity  ·  N issues
         ├─ evidence      cropped screenshot, element outlined, labelled
         ├─ properties    background · radius · padding · font
         │                  each: design value → page value · delta · ΔE band
         ├─ structural    present / missing / extra
         ├─ links         figma:1:234   ·   main > section:nth-child(3) > button
         └─ suggested fix grounded in the finding set, never invented
```

Every level answers one question. Every card carries an image and two links — a Figma `?node-id=`
deep link and a `webSelector` that pastes into devtools. Both are free; identifier coverage is
already 100%.

**Progressive disclosure is the rule at every level.** Landing view shows merged issues above the
severity cut. Everything else — full property tables, low-confidence matches, excluded dynamic
regions — remains reachable and is never the first thing a reader meets.

### 11.1 R5 — Explaining ΔE

Ship the band beside every number, not only in a legend:

| ΔE | Meaning |
|---|---|
| < 1 | Invisible |
| 1 – 2 | Visible only side by side. *At tolerance; not reported* |
| 2 – 5 | Noticeable at a glance |
| 5 – 10 | Clearly a different colour |
| > 10 | Obviously different colours |

So `ΔE 3.31 · noticeable at a glance` (a near-miss — almost certainly a hand-typed hex that should be
the token) reads very differently from `ΔE 7.43 · clearly a different colour` (likely a third-party
component). Show both swatches adjacent and most readers will not need the number at all.

> Calibration: these are the standard CIE bands. `deltaEOK` is OKLab euclidean ×100 and reads on
> roughly the same scale, but validate against known pairs before presenting as authoritative.

---

## 12. R6 — Accuracy and capability

Beyond the architecture, ranked by value per unit of effort.

| # | Item | Why |
|---|---|---|
| 1 | **Baselines / regression mode** | Evertest is a *test* product. "3 new findings since your last deploy" beats "95 findings" — and findings already carry stable fingerprints, so the diff is cheap |
| 2 | **Suppressions** | A user must permanently accept a deviation. Without it, report fatigue kills adoption in week two regardless of accuracy |
| 3 | **Score stability** | The same page scored 64 and 65 minutes apart. A score that drifts without a code change cannot gate anything |
| 4 | **Determinism check on by default** | Currently opt-in because it doubles web runtime. Any gating run needs it, and unstable nodes should be *excluded*, not merely flagged |
| 5 | **Match-confidence propagation** | Section confidence ranges 0.669–0.938; findings from both are presented identically today |
| 6 | **Design hygiene gate** | A file with 1 detectable button and 45 auto-named components should be told what the tool can and cannot conclude *before* running |
| 7 | **Multi-breakpoint** | One frame = one width, so most responsive defects are invisible. Run per breakpoint and merge |
| 8 | **Figma role inference from the render** | Layer names are useless on real files; roles come free as an extra field on the E2 call, cached per file version |

---

## 13. Phasing

| Phase | Contents | Estimate |
|---|---|---|
| **0** | ΔE bands · deep links · determinism default · confidence propagation — ships against V1 today | 2–3 days |
| **1** | **E1 comparable element set + the ratio gate (§5).** Go/no-go for everything after | 3–4 days |
| **2** | E2 correspondence — all three tiers, verification, cache | 2–3 weeks |
| **3** | E3 structural verdict + repeated-group rule | ~1 week |
| **4** | E4 element property comparison + the nine dormant rules + noise controls (§8.1) | 2–3 weeks |
| **5** | E5 issue prioritisation — element merge, visual severity, volume cap, suggested fixes | ~1 week |
| **6** | E6 evidence capture and annotation | ~1.5 weeks |
| **7** | E7 report rebuild | ~2 weeks |
| **8** | Baselines + suppressions | ~1.5 weeks |

**Realistically 10–14 weeks**, and then:

> Budget **4–8 weeks of tolerance tuning after the code works.** The gap between "the comparison
> runs" and "the findings are trustworthy" is where tools like this live or die. It is not polish;
> it is the product.

### 12.1 Two checkpoints that can stop the project cheaply

- **After Phase 1 (~4 days):** if collapsing vectors does not bring per-section node ratios near 1.0,
  the trees are not comparable and E2 will not work. Stop and rethink for four days spent.
- **After a 1-day spike inside Phase 2:** run tier-2 correspondence by hand on 3 section pairs —
  including 12→13, the worst — and score against ground truth established by eye. If the model
  hallucinates matches, that is one day, not three weeks.

I would run both before committing to the full plan.

---

## 14. Open decisions

1. **Does the model judge style, or only identity?** §3 recommends identity only. Revisit after V2
   runs, not before.
2. **LLM cost per audit** — ~18 section pairs × (2 images + element lists). Needs a measured estimate
   before pricing, and the cache makes steady-state cost far lower than first-run cost.
3. **`/v1/images` rate-limit tier** — unknown, on an already-throttled account.
4. **Evidence storage** — ~36 renders plus annotations per run. Needs a retention policy.
5. **Re-measure §5 and §6.2 on a second Figma file.** Every number in this document comes from one
   file. The vector inflation and role asymmetry are probably general; "probably" is not measured.
6. **Ship V1 or hold?** V2 is 3+ months. V1 plus Phase 0 is deployable in days and answers style
   questions well, if coarsely. Recommend shipping it as an interim rather than going dark.
