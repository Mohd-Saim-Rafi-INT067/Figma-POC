# Figma Design Parity — POC Implementation Plan

**Status:** Plan approved, implementation not started
**Parent design:** `evertest-backend/docs/figma-design-parity.md` (the full 14-week feature design)
**This document:** the standalone POC that de-risks that design before any Evertest integration
**Location:** `C:\Users\admin\source\repos\figma-parity-poc` — separate repo, no Evertest dependency
**Target:** Phase 1 of the parent doc (§13.2) — **token audit only, correspondence-free**

---

## 0. Decisions already locked

| Decision | Value | Rationale |
|---|---|---|
| Scope | Parent doc Phase 1 only: M1, M2, M3, M4, M5, M7a | Correspondence-free. No matcher, which is where ~60% of the parent design's risk lives. |
| Test targets | Real Figma file + PAT + page URL, supplied by the user | Fixtures never validate the real extractors or the API's actual field shapes. |
| Location | Standalone repo outside `evertest-backend` | Zero risk to production code; port module-by-module later. |
| Stack | Node 24 ESM, Playwright 1.57, zero runtime deps beyond `playwright` + `dotenv` | Matches `evertest-backend`'s Playwright version so the port is mechanical. |
| Persistence | Local filesystem (`.cache/`, `out/`) | No Supabase in the POC. Storage shape mirrors the eventual tables so the port is a swap, not a rewrite. |

---

## 1. What this POC proves, and what it does not

### 1.1 The three questions this POC answers

1. **Can we extract exact, stable, complete style data from both sides?**
   Everything in the parent design rests on this. If the extractors are wrong, every later module is
   built on sand — and the parent doc's own phasing (§13.2) exists precisely so this is discovered in
   week 4 rather than week 12.

2. **Is a correspondence-free audit actually useful on its own?**
   The parent doc claims token audit "catches the majority of real-world design drift" (§7.1). That is
   an assertion. This POC tests it against a real page and reports whether the findings are things a
   designer would act on or noise they would close.

3. **What does the real Figma API return?**
   Several field-shape assumptions in the parent doc are unverified against a live file (§9 below lists
   them). Cheap to confirm now, expensive to discover mid-integration.

4. **Is M8 (matching) likely to be feasible at all?**
   Phase 1 does not build a matcher — but it can *measure* whether the signal a matcher would need
   exists. See §3.13. This costs roughly half a day and is the highest-information-per-hour item in the
   POC, because M8 carries ~60% of the parent design's total risk and nothing else here touches it.

### 1.2 Explicit non-goals for the POC

- **No node matching.** No text anchors, no upward propagation, no Hungarian assignment. Parent doc §8
  is entirely out of scope.
- **No pairwise comparison.** Nothing compares "this Figma node to that DOM node". Parent doc §7.2 is
  out of scope.
- **No LLM.** Zero model calls anywhere. Phase 1 is fully deterministic by construction.
- **No screenshots, no pixel diffing.** Inherited hard constraint from parent doc §1.1.
- **No database, no API, no auth profiles, no CI gating, no baselines.**
- **No React UI.** Report output is a self-contained HTML file plus JSON.

### 1.3 Kill criteria

State these up front so the POC can honestly fail rather than quietly expand:

| Signal | Meaning |
|---|---|
| Extractors disagree with manually-measured ground truth on the validation fixture | Stop. The foundation is wrong; fix before anything else. |
| Token audit on the real page produces >70% findings the user judges as noise | The parent doc's Phase 1 "ships standalone" claim is false. Re-plan before building M6/M8. |
| Figma file hygiene score < 0.4 on the supplied file | Not a failure of the code — but it means this file cannot validate anything beyond token audit, and we need a second file before Phase 2. |
| **Token discipline score < 0.4** (§2.5) | The design itself has no consistent token system. Token audit is measuring drift against a moving target; findings will be noise on *both* sides. Needs a better file, not better code. |
| **Unique text-anchor rate < 40%** (§3.13) | Serious warning on M8 feasibility. Not a Phase 1 failure — Phase 1 still ships — but re-plan Phase 2 before committing 3–4 weeks to the matcher. |
| Rendered-font check finds nothing and colors/spacing all conform | Either the page is genuinely good (great — but then we need a worse page to validate against) or the extractors are silently empty. Distinguish before declaring success. |

---

## 2. High-Level Design (HLD)

### 2.1 Pipeline

The POC implements the left branch of the parent doc's pipeline (§2.1) and stops there.

```
                     .env  +  tolerance-profile.json
                                    │
                       ┌────────────┴────────────┐
                       │   POC Config            │
                       │   figmaFileKey          │
                       │   figmaNodeId           │
                       │   pageUrl               │
                       │   viewportWidth ◄── auto-derived from frame
                       └────────────┬────────────┘
                                    ▼
            ┌───────────────────────┴───────────────────────┐
            ▼                                               ▼
   M2. Figma Extraction                            M1. Web Extraction
   REST /v1/files/:key/nodes                       Playwright + CDP
   + version-keyed disk cache                      + 10-step stabilization
            │                                               │
            ▼                                               ▼
   M4. Figma Normalizer                            M3. Web Normalizer
            │                                               │
            └───────────────────────┬───────────────────────┘
                                    ▼
                       M5. Common UI Model (IR)
                       one flat node array per side
                                    │
                                    ▼
                       P5. Pruning & Canonicalization
                       (parent doc §6.1 — visibility, clip,
                        wrapper collapse, to fixpoint)
                                    │
                                    ▼
                       P6. Measured Spacing Derivation
                       (parent doc §7.3 — geometry, not
                        declared gap/margin/padding)
                                    │
                                    ▼
                       P7. Token Set Builder
                       3-tier authority — see §2.3
                                    │
                                    ▼
                       M7a. Token Audit
                       distribution comparison, no correspondence
                                    │
                                    ▼
                       M10'. Finding Assembly (reduced)
                       severity + dedup + occurrence counts
                                    │
                       ┌────────────┼────────────┐
                       ▼            ▼            ▼
                  findings.json  report.html  console summary
```

### 2.2 Why the audit needs no correspondence

Every check compares a **distribution against a set**, never a node against a node:

> "The page renders 15 distinct font sizes. The design defines 8. These 7 are not in the design:
> 13px (×42 nodes), 15px (×8), 17px (×3)…"

There is no claim about *which* node should have been which size. That claim requires matching, and
matching is Phase 2. This is exactly why Phase 1 is safe to build first, and why it is nearly
impossible to get wrong.

### 2.3 Token authority — a refinement on the parent doc

The parent doc (§7.1, and open question §14.2) presents a binary: **Variables** (authoritative,
Enterprise-gated) or **inferred** (fallback). There is a third tier it misses, available on every plan:

| Tier | Source | Availability | Authority |
|---|---|---|---|
| **1** | Variables — `GET /v1/files/:key/variables/local`, node `boundVariables` | Enterprise plan only | Authoritative. Named tokens with explicit values. |
| **2** | **Published/local Styles** — file response `styles` map + per-node `styles: { fill, text, effect }` refs | **Any plan** | Near-authoritative. Named color/text/effect styles are a real design system, just not Variables. |
| **3** | Inferred from usage frequency across the frame | Always | Weak. A value used once may be a mistake; a value used 40× is probably intentional. |

The builder resolves the highest available tier and records which tier it used. This matters because
the difference between "your palette has 9 tokens" and "we guessed your palette has 9 tokens" changes
how much a user should trust every color finding — and Tier 2 is free signal the parent doc leaves on
the table.

**Action item for the parent doc:** fold Tier 2 into §7.1 and open question §14.2 after the POC
confirms the `styles` map is populated on the real file.

#### Addendum after the 2026-07-30 spike — Tier 2 is empty here, so add Tier 2.5

The spike (§9 Q4/Q7) settled both upper tiers on the target file, and neither survives:

- **Tier 1 (Variables):** 1 of 1828 nodes carries `boundVariables`. Not testable.
- **Tier 2 (Styles):** 5 file-level styles, 34 of 1828 nodes (1.9%) carrying a `styles` ref. Architecturally
  sound, practically empty.

That drops us to **Tier 3 (inferred from the home-page frame)** — the weakest tier, and the one most
vulnerable to the marketing-site problem flagged in §11.

But the file itself suggests a better source. Its page list includes dedicated **`Components`**,
**`Spacing guideline`**, and **`Raw`** canvases. A design system expressed as a *page of components*
rather than as Variables or Styles is extremely common — arguably the most common form in practice —
and the parent doc has no tier for it.

**Tier 2.5 — design-system pages.** Build the token set from one or more explicitly-nominated
canvases (`Components`, `Spacing guideline`) instead of inferring it from the frame under test.

| | Tier 3 (infer from frame under test) | **Tier 2.5 (nominated system pages)** |
|---|---|---|
| Source | The same frame being audited | Separate, curated canvases |
| Circularity | **Yes** — the frame defines the tokens it is then judged against, so its own one-off values look canonical | **No** — an independent reference |
| Captures | Only what this page happens to use | The system as designed, including tokens this page doesn't use |

The circularity point is the important one: Tier 3 cannot ever report *"this page uses a value the
design system does not define"*, because the page **is** the definition. Tier 2.5 restores the
independent reference that makes the whole audit meaningful.

Cost is low — a config field naming the token-source canvases, and the same normalizer already being
written. It is added to the Phase 4 task list, with Tier 3 retained as the fallback for files that have
no such page.

**Second action item for the parent doc:** add Tier 2.5 to §7.1. Requiring Enterprise Variables or
disciplined Styles usage excludes the majority of real design files.

### 2.4 Two interpretation gates — hygiene *and* token discipline

The parent doc has one pre-flight gate: the **hygiene score** (§9.6), which weighs auto-layout usage,
component instance coverage, layer naming, and absolute-positioning depth. Every one of those measures
**structure**.

A token audit does not depend on structure. It depends on whether the design has a consistent **value
system** — and those are independent properties. A file can score 0.9 on hygiene (beautifully
auto-laid-out, fully componentized, every layer named) while still using 22 arbitrary font sizes and
40 unrelated greys. Against such a file, *"the page renders 15 sizes, the design defines 22"* is not a
finding. It is noise on both sides, and no amount of tolerance tuning fixes it.

So the POC adds a second, cheap signal computed from the Figma IR alone:

```
tokenDiscipline = weighted mean of per-dimension concentration, over
                  { colors, fontSizes, fontWeights, spacing, radii, shadows }

concentration(d) = share of usages covered by the smallest set of distinct
                   values that accounts for >= 80% of usages in dimension d,
                   normalized against a reference of ~6-8 values per dimension
```

Intuition: a design system with 8 font sizes covering 95% of text nodes scores high. A design where
the top-8 sizes cover only 40% of text nodes has no scale — it has 30 one-off values.

**Both gates are reported before any finding**, because both change how much a user should trust the
list that follows:

| Gate | Measures | Low score means |
|---|---|---|
| Hygiene (§9.6) | Structure — auto-layout, components, naming | Structural and spacing findings unreliable. Gates *down to* token audit in the product. |
| **Token discipline (new)** | Value system — distribution concentration | **Token audit itself** is unreliable. Nothing left to gate down to. |

That second row is the important one: it is the failure mode with no fallback, which is exactly why it
deserves to be measured rather than assumed. It is also kill criterion #3 (§1.3).

**Action item for the parent doc:** add token discipline alongside the hygiene score in §9.6. The
existing gate silently assumes structural quality implies token quality, and it does not.

### 2.5 Module map

| # | Module | Source in parent doc | Determinism | POC risk |
|---|---|---|---|---|
| M1 | Web extraction | §4.1 | Deterministic given stabilization | **Medium** — CDP font plumbing (§4.3) |
| M2 | Figma extraction + cache | §4.2 | Deterministic | Low |
| M3 | Web normalizer | §5 | Deterministic | Low |
| M4 | Figma normalizer | §5, §6.2, §6.3, §6.5 | Deterministic | **Medium** — field shapes unverified (§9) |
| M5 | IR schema | §5 | — (schema) | Low |
| P5 | Pruning & canonicalization | §6.1 | Deterministic | Medium — wrapper collapse to fixpoint |
| P6 | Measured spacing | §7.3 | Deterministic | Low |
| P7 | Token set builder | §7.1 + §2.3 above | Deterministic | Low |
| M7a | Token audit | §7.1 | Deterministic | Low |
| G | Interpretation gates — hygiene + token discipline | §9.6 + §2.4 above | Deterministic | Low |
| M10' | Finding assembly | §9.1, §9.3 (reduced) | Deterministic | Low |
| R | Report | §12 (reduced — no SVG overlay) | Deterministic | Low |
| **D** | **M8 feasibility probe** (diagnostic, builds nothing) | §8.2 — *measured, not implemented* | Deterministic | Low |

---

## 3. Low-Level Design (LLD)

### 3.1 File layout

```
figma-parity-poc/
├── .env                       # gitignored — user fills from .env.example
├── .env.example
├── .gitignore
├── package.json
├── docs/
│   └── poc-implementation-plan.md      # this file
├── config/
│   └── tolerance-default.json          # parent doc §6.6 defaults, as data
├── .cache/                    # gitignored — figma responses keyed by file version
├── out/                       # gitignored — findings.json, report.html, snapshots
├── fixtures/
│   ├── generate.js            # IR -> HTML generator (validation harness, §6)
│   └── mutations.js           # deliberate known deviations
├── test/
│   ├── color.test.js
│   ├── normalize-text.test.js
│   ├── prune.test.js
│   └── audit.test.js
└── src/
    ├── cli.js                 # entry point, flag parsing, orchestration
    ├── config.js              # .env + figma URL parsing + viewport auto-derive
    ├── ir/
    │   ├── schema.js          # M5 - VisualNode, snapshot, walk helpers   [DONE]
    │   ├── color.js           # OKLab/OKLCH, deltaEOK, compositing        [DONE]
    │   ├── text.js            # §6.4 normalization, shared by both sides
    │   └── fonts.js           # §6.3 PostScript -> (family, weight, style)
    ├── figma/
    │   ├── client.js          # M2 - REST + token bucket + version cache
    │   ├── normalize.js       # M4 - Figma node tree -> IR
    │   └── tokens.js          # Variables + Styles extraction (tiers 1-2)
    ├── web/
    │   ├── extract.js         # M1 - Playwright driver + stabilization
    │   ├── serializer.js      # in-page DOM walker (runs in page context)
    │   ├── fonts-cdp.js       # §4.1.4 - CSS.getPlatformFontsForNode
    │   └── normalize.js       # M3 - raw serializer output -> IR
    ├── pipeline/
    │   ├── prune.js           # P5 - §6.1
    │   └── spacing.js         # P6 - §7.3
    ├── audit/
    │   ├── index.js           # M7a orchestration
    │   ├── palette.js         # color conformance
    │   ├── typography.js      # size/weight/family/line-height scales
    │   ├── spacing.js         # spacing scale
    │   ├── shape.js           # radius + shadow sets
    │   ├── rendered-font.js   # webfont-failure check
    │   ├── hygiene.js         # §9.6 pre-flight structural score
    │   └── discipline.js      # §2.4 token-discipline score (new)
    ├── probe/
    │   └── anchors.js         # §3.13 M8 feasibility probe - measures, builds nothing
    └── report/
        ├── findings.js        # M10' - assembly, severity, dedup
        ├── html.js            # self-contained HTML report
        └── console.js         # terminal summary
```

### 3.2 Config resolution (`src/config.js`)

```js
resolveConfig() -> {
  figmaToken, figmaFileKey, figmaNodeId,
  pageUrl, viewportWidth, viewportHeight, deviceScaleFactor,
  tolerance, cacheDir, outDir
}
```

**Figma URL parsing** — parent doc §3.2:

```
https://www.figma.com/design/<fileKey>/<name>?node-id=1-234
                             ^^^^^^^^^                ^^^^^
```
- Accept both `/design/` and legacy `/file/` paths.
- `node-id` uses `-` in URLs; the REST API expects `:`. Convert.
- Reject early with a clear message if `node-id` is absent — a file-level URL has no frame to compare.

**Viewport auto-derivation** — parent doc §3.1. `viewportWidth` is *mandatory* but *derived*: fetch the
frame, read `absoluteBoundingBox.width`, use it. Only if `VIEWPORT_WIDTH` is explicitly set in `.env`
does the user override — and then we warn loudly, because a 1440 frame measured at 1280 makes every
finding noise. This creates a **hard ordering constraint: M2 must run before M1.**

### 3.3 M2 — Figma extraction (`src/figma/client.js`)

```js
class FigmaClient {
  constructor({ token, cacheDir })
  async getFileMeta(fileKey)                  // GET /v1/files/:key?depth=1
  async getNodes(fileKey, nodeIds, opts)      // GET /v1/files/:key/nodes?ids=...
  async getLocalVariables(fileKey)            // GET /v1/files/:key/variables/local
}
```

**Cache (parent doc §4.2 — mandatory).** Keyed on the file's `version`:

```
.cache/figma/<fileKey>/<version>/<nodeId>.json
```

Cache check is a two-call dance: `GET /v1/files/:key?depth=1` is cheap and returns `version` +
`lastModified` without the node payload. On a version hit, the full node call is skipped entirely.
Designs change far less often than deploys, so in steady state this is one cheap call per run.

**Rate limiting.** Token-bucket queue, exponential backoff on 429 (respect `Retry-After` when present).
Per parent doc: a rate-limit stall degrades to "use last cached version + warn", **never** a hard run
failure. The POC implements this degradation path from day one because it is also the offline-dev path.

**`geometry=paths` stays off.** Doubles response size; only needed for icon path-hash comparison
(parent doc §9.5) which is Phase 3+. Flag exists, default false.

**Variables (Tier 1) is expected to 403** on non-Enterprise plans. That is a normal outcome, not an
error: catch it, record `tokenAuthority: 'styles'` or `'inferred'`, continue.

### 3.4 M4 — Figma normalizer (`src/figma/normalize.js`)

Walks the node tree from the target frame, emitting IR. Per parent doc §5 + §6.

| Concern | Rule | Parent doc |
|---|---|---|
| Coordinate space | `absoluteBoundingBox` is canvas-space. Subtract the target frame's origin → frame space. | §5 |
| Opacity | `effectiveAlpha = paint.opacity × node.opacity × Π(ancestor.opacity)` — accumulate on the way down. | §6.2 |
| Background fill | Last visible `SOLID` paint in `fills[]`. **Paint stacking order must be verified against the live file (§9).** | §6.2 |
| Text | `characters` + `style{fontFamily, fontPostScriptName, fontWeight, fontSize, lineHeightPx, lineHeightUnit, letterSpacing, textCase, textDecoration, textAlignHorizontal}` | §6.3 |
| Font identity | `fontPostScriptName` ("Inter-SemiBold") → `(family, weight, style)` via lookup table. This is the Figma side's `renderedFontFamily`. | §6.3, §4.1.4 |
| **Font weight** | **`style.fontWeight` is NOT usable directly** — derive weight from `fontPostScriptName`. See §9 Q8; verified on the target file. | §6.3 |
| Line height | `lineHeightUnit` may be `AUTO` / `PIXELS` / `FONT_SIZE_%`. Resolve all to px. `AUTO` needs the font's intrinsic metrics — POC records it as `null` + a warning rather than guessing. | §6.3 |
| Stroke alignment | `INSIDE` → box unchanged. `CENTER` → inset by `strokeWeight/2`. `OUTSIDE` → inset by `strokeWeight`. Set `border.inset = false` for the latter two. | §6.5 |
| Radius | `cornerRadius` (uniform) or `rectangleCornerRadii` ([tl,tr,br,bl]) — normalize to the 4-tuple always. | §5 |
| Effects | `DROP_SHADOW`/`INNER_SHADOW`/`LAYER_BLUR` → `{type, x, y, blur, spread, color}` from `offset{x,y}`, `radius`, `spread`. | §5 |
| Component identity | Preserve `componentId` + `componentName` through `INSTANCE` flattening. Unused in Phase 1, but free to capture and required by Phase 4 grouping. | §6.1, §9.2 |
| Role inference | Heuristic on node type + name: `TEXT`→text, vector cluster→icon, `RECTANGLE` with image fill→image, name matches `/button/i`→button. Record `roleConfidence`. | §5 |

**Deliberately deferred to Phase 2:** vector cluster collapsing (§6.1). For a token audit, individual
vector fills contributing to the palette histogram is *correct* behavior — collapsing them would hide
real palette usage. Noted so it is not mistaken for an oversight.

### 3.5 M1 — Web extraction (`src/web/extract.js`)

**Stabilization is normative** — parent doc §4.1.1 calls this the single largest source of flakiness,
so the 10 steps are implemented in order, with each step logged:

```
1.  setViewportSize({ width: viewportWidth, height: viewportHeight })
2.  addInitScript: pin Date.now / performance.now / Math.random
3.  emulateMedia({ reducedMotion: 'reduce' })
4.  goto(url, { waitUntil: 'networkidle' })
5.  addStyleTag: freeze CSS (animations, transitions, caret, scroll-behavior)
6.  evaluate(() => document.fonts.ready)
7.  dismiss known overlays via selector list  (config-driven, best-effort)
8.  scroll to bottom in viewport-sized steps -> force lazy-load / IntersectionObserver
9.  scroll back to top
10. evaluate(() => document.fonts.ready)   // re-check: lazy content brings new fonts
11. settle delay (default 400ms)
12. extract
```

> Note: the parent doc lists 10 steps; the init-script pin and `emulateMedia` are called out in its
> prose immediately after the list (§4.1.1) but not numbered. They must run **before** `goto`, so the
> POC numbers them explicitly as steps 2–3 rather than leaving them as a footnote.
> **Action item for the parent doc:** renumber §4.1.1 to 12 steps.

**Determinism self-check.** The POC extracts twice in the same session and diffs the two IR snapshots.
Any non-empty diff is a stabilization bug and is reported prominently. This is cheap and it is the only
honest way to claim the extractor is deterministic.

### 3.6 In-page serializer (`src/web/serializer.js`)

Runs entirely inside one `page.evaluate()`. Constraints: no imports, no closures over Node scope,
returns plain JSON.

Per element, collects:
- `getComputedStyle(el)` — **the §4.1.3 allowlist only**, never all ~340 properties (payload size).
- `getBoundingClientRect()` + scroll offset → document-space box.
- `getComputedStyle(el, '::before')` and `'::after'` — decorative bars, icon fonts and counters live
  here constantly. Promoted to synthetic `icon`/`divider` nodes when they paint anything.
- `tagName`, ARIA role, accessible name.
- **Direct text only** — own text nodes, not descendants'. Concatenating descendant text makes every
  ancestor look like a text node.
- `webPath`: structural path, e.g. `body>div:nth-of-type(1)>main>section:nth-of-type(2)>button`.
  Generated class names (CSS-in-JS, Tailwind JIT, CSS modules) change per build and cannot key
  anything stable (parent doc §5.1).

**Traversal pierces** open shadow roots and same-origin iframes. Cross-origin iframes are out of scope
(parent doc open question §14.5) — but the serializer **counts** them and reports "N cross-origin
iframes skipped" so their absence is visible rather than silent.

### 3.7 CDP rendered fonts (`src/web/fonts-cdp.js`) — the highest-value check

Parent doc §4.1.4: `getComputedStyle` returns the **declared** family list. `font-family: Inter,
sans-serif` computes to that literal string even when Inter failed to load and the user is staring at
Arial. A silently-failed webfont is invisible to every other method in the system and is a real,
frequent production bug.

**The plumbing is the hard part, and the parent doc understates it.** `CSS.getPlatformFontsForNode`
takes a CDP *DOM node id*, which a Playwright `ElementHandle` does not give you. The working sequence:

```js
await cdp.send('DOM.enable');
await cdp.send('CSS.enable');                       // required, easy to miss
const { object } = await cdp.send('Runtime.evaluate', ...)   // or handle.evaluateHandle
const { node } = await cdp.send('DOM.describeNode', { objectId });
const { nodeIds } = await cdp.send('DOM.pushNodesByBackendIdsToFrontend',
                                   { backendNodeIds: [node.backendNodeId] });
const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: nodeIds[0] });
// -> [{ familyName: "Arial", glyphCount: 214, isCustomFont: false }]
```

**Cost control.** One round trip per text node is far too slow on a real page (thousands of nodes).
The rendered-font question is per *font-face*, not per *node*: group text nodes by their declared
signature `(fontFamily, fontWeight, fontStyle)` and sample up to **N=5** nodes per distinct signature.
If Inter-600 failed to load, it failed for every node using it. This turns thousands of round trips
into tens.

Store the dominant family (highest `glyphCount`) as `type.renderedFontFamily`.

### 3.8 P5 — Pruning (`src/pipeline/prune.js`)

Parent doc §6.1: "this step alone closes most of the structural gap." For a token audit it serves a
narrower but critical purpose — **keeping invisible nodes out of the histograms**. A `display:none`
mega-menu otherwise injects a dozen phantom colors into the page's palette.

**Web:**
- Drop `display:none`, `visibility:hidden`, `opacity:0`, zero-area.
- Drop nodes fully outside the clip rect of an `overflow:hidden` ancestor. (`overflow` is excluded from
  *comparison* but used for *pruning* — parent doc §4.1.3.)
- **Collapse transparent wrappers to fixpoint:** an element whose box is within 1px of its single
  element child's box *and* which paints nothing itself (no non-transparent background, no border, no
  shadow, no background-image, no own text node). This is what deletes the div soup — and for the
  spacing histogram specifically, it is what stops thousands of phantom `0px` gaps.
- Collapse inline text runs into their block parent.

**Figma:**
- Drop `visible: false`, zero-area, `opacity: 0`.
- Drop nodes outside a `clipsContent` ancestor's bounds.
- Collapse `GROUP` nodes with a single child.
- (Vector cluster collapse deferred — see §3.4.)

Every prune records a reason; the counts go in the report. If pruning removes 95% of nodes, that is
either div soup or a bug, and the user needs to be able to tell which.

### 3.9 P6 — Measured spacing (`src/pipeline/spacing.js`)

Parent doc §7.3 — the single rule that removes an entire class of false positives. A developer who
writes `margin-bottom: 24px` where the designer set `itemSpacing: 24` renders **identically**; comparing
declared properties flags it as a mismatch anyway. Figma has no margin concept at all.

Both sides compute identically, from geometry only:

```
gapMeasured     = sibling[n+1].box.top  − sibling[n].box.bottom      (column direction)
                  sibling[n+1].box.left − sibling[n].box.right       (row direction)
paddingMeasured = [ firstChild.box.top      − parent.contentBox.top,
                    parent.contentBox.right − lastChild.box.right,
                    parent.contentBox.bottom− lastChild.box.bottom,
                    firstChild.box.left     − parent.contentBox.left ]
```

Direction is inferred from child arrangement (dominant axis of sibling centers), not from
`flex-direction` / `layoutMode` — the same "measured, not declared" principle. Negative and
overlapping-sibling cases yield `null`, not a negative gap.

### 3.10 P7 + M7a — Token set and audit (`src/audit/`)

**Token set builder** resolves the highest tier available (§2.3) and emits:

```js
TokenSet {
  authority: 'variables' | 'styles' | 'inferred',
  colors:      [{ value: Color, name?: string, usageCount: number }],
  fontSizes:   [{ value: number, name?, usageCount }],
  fontWeights: [...], fontFamilies: [...], lineHeights: [...],
  spacing:     [...], radii: [...], shadows: [...]
}
```

For `inferred`, a value must appear **≥2 times** or on **≥1% of nodes** to count as a token — a
one-off value in the design is as likely to be a designer's mistake as a token.

**Audit checks.** Each takes `(webHistogram, figmaTokenSet, tolerance)` and emits findings:

| Check | Method | Example finding |
|---|---|---|
| `palette` | For each web color, nearest Figma token by `deltaEOK`. Beyond tolerance → violation. | `#3B82F6 (×42 nodes) is not in the design palette; nearest is #3B82F7 (ΔE 0.3)` — note this one is *within* tolerance and would not fire |
| `typography` | Exact-set comparison on sizes/weights/families; nearest-value on line-heights | `Figma defines 8 font sizes; the page renders 15. Not in the design: 13px (×42), 15px (×8), 17px (×3)` |
| `spacing` | Nearest-token on the measured-spacing histogram | `Figma uses 4/8/12/16/24/32; the page uses 13px (×6), 18px (×11), 26px (×3)` |
| `shape` | Radius and shadow sets | `Radius 6px used on 14 nodes is not in the design (design uses 4/8/16)` |
| `rendered-font` | `renderedFontFamily` ≠ declared family root | **critical** — `Inter declared but Arial rendered on 12 nodes` |
| `hygiene` | Parent doc §9.6 structural score | `Hygiene 0.31 — structural findings will be unreliable` |
| `discipline` | §2.4 — Figma-side distribution concentration | `Token discipline 0.28 — the design defines no consistent scale; findings below are low-confidence on both sides` |

**Every finding carries `occurrenceCount`.** A value used once is a rounding error; used 40× it is
systemic. Without this the report is an unreadable wall (parent doc §9.2 makes the same point about
component grouping).

#### Counts are web-side only — a normative rule

> **Compare *sets* across sides. Report *counts* from the web side only. Never compare a count on one
> side to a count on the other.**

A Figma frame shows 3 cards where production renders 47. It uses placeholder copy where production has
real content. The two sides therefore describe **different content volumes**, and every count is scaled
by that difference.

This makes cross-side count comparisons meaningless in a way that is easy to miss because the numbers
*look* comparable:

- ✗ *"The design uses 16px on 4 nodes but the page uses it on 61"* — measures the content gap, not drift.
- ✗ Weighting a color's importance by its Figma-side usage — a token used once in a frame may be the
  primary CTA color across the whole product.
- ✓ *"13px is not in the design's size set"* — a set membership question. Content volume is irrelevant.
- ✓ *"13px appears on 42 page nodes"* — a web-side count, used only to rank findings by blast radius.

The one place Figma-side counts are legitimate is **inside** the Figma side: the Tier 3 inferred-token
threshold (≥2 uses) and the token-discipline score (§2.4) both compare Figma counts to other Figma
counts. That is a within-side comparison and is fine.

Enforced structurally rather than by convention: the `Finding` shape (§3.11) has exactly one count
field, `occurrenceCount`, and it is documented and populated as web-side only. There is no field a
Figma-side count could be written into.

**Hygiene gate** (parent doc §9.6): score < 0.4 → prominent warning. In the full product this gates
*down to* token-audit-only; in the POC we are already token-audit-only, so it becomes an advisory that
this file cannot validate Phase 2.

### 3.11 M10' — Finding assembly (`src/report/findings.js`)

Reduced form of parent doc §9.1. Phase-1 findings are always `type: 'token-violation'`, so the fields
that require matching are structurally absent rather than null-filled:

```ts
interface Finding {
  id, category, type: 'token-violation' | 'drift' | 'info',
  property, expected, actual, delta, tolerance,
  severity, occurrenceCount, sampleNodes: string[],   // up to 5, for drill-down
  fingerprint                                          // §9.4 shape, unused in POC
}
```

Severity from the tolerance profile, then parent doc §9.3 modifiers that apply without matching:
`occurrenceCount > 10` → upgrade one level. (`matchConfidence` downgrade is inapplicable — nothing is
matched.) `fingerprint` is computed even though the POC has no baselines, so the Phase-5 baseline
format is validated early and for free.

### 3.12 Report (`src/report/`)

- **`findings.json`** — the contract. Everything else is a rendering of this. Machine-checkable, diffable
  between runs, and the thing that ports into `design_findings` later.
- **`report.html`** — single self-contained file, no external requests. Color swatches, histogram bars,
  side-by-side design-vs-page scales, findings grouped by category and sorted by severity then
  occurrence count. Light and dark via `prefers-color-scheme`.
- **console** — a summary table for the CLI run, plus the hygiene score and token authority tier.

### 3.13 M8 feasibility probe (`src/probe/anchors.js`) — diagnostic only

> **This builds no matcher.** It measures whether the signal a matcher would need exists. Read the
> non-goals in §1.2 as unchanged: no propagation, no assignment, no confidence gating, nothing
> downstream consumes the output. It is a number in the report, not a stage in the pipeline.

**Why it earns its place in a POC that explicitly excludes matching.** M8 carries ~60% of the parent
design's risk and 3–4 weeks of its schedule, and Phase 1 otherwise touches none of it. Parent doc §8.2
makes text anchors the foundation the entire matcher propagates from — §8.3 derives container
correspondence from anchor sets, and §8.4 only runs *inside* already-matched parents. If text anchors
are weak, everything above them is weak, and no amount of Hungarian assignment recovers it.

That foundation is measurable **today**, from IR both extractors already produce, using the text
normalizer (§6.4) already required for other reasons. Cost is roughly half a day.

**Method.** Normalize all `TEXT` strings on both sides through the shared §6.4 function, then bucket:

```js
probeAnchors(figmaIR, webIR) -> {
  figmaTextNodes, webTextNodes,
  unique:        n,   // string appears exactly once on BOTH sides -> free high-confidence anchor
  ambiguous:     n,   // appears on both sides, but 2+ times on at least one
  figmaOnly:     n,   // no web match  -> placeholder copy, or genuinely missing implementation
  webOnly:       n,   // no figma match -> dynamic/CMS content, or design is stale
  numericLike:   n,   // dates, prices, counts - down-weighted per parent doc §8.2
  uniqueRate:    0.0, // unique / min(figmaTextNodes, webTextNodes)
  samples: { unique: [...5], ambiguous: [...5], figmaOnly: [...5], webOnly: [...5] }
}
```

**Interpretation.** These bands are a first read, not a validated rubric — the POC's job is to produce
the number, and one data point does not calibrate a threshold:

| `uniqueRate` | Read |
|---|---|
| ≥ 0.70 | Strong. Anchors alone will carry most of the tree; M8 likely tractable as designed. |
| 0.40 – 0.70 | Workable. Expect real dependence on §8.4 assignment and §8.5 LLM adjudication. Budget accordingly. |
| < 0.40 | **Warning.** Re-plan Phase 2 before committing 3–4 weeks. Kill criterion #4 (§1.3). |

The `samples` are as valuable as the rate. If `webOnly` is full of CMS content and `figmaOnly` is full
of `Lorem ipsum`, the low rate is a **content** problem (the frame is not a faithful stand-in for the
page) and is fixable by choosing a better frame. If both sides show the same real strings failing to
match, it is a **normalization** bug in §6.4 and is fixable in code. Those two look identical in the
rate alone and completely different in the samples — which is why the probe reports both.

---

## 4. Tolerance profile

Parent doc §6.6 — first-class, versioned data, **not constants in code**. In the POC it is
`config/tolerance-default.json`; in the product it becomes a `design_tolerance_profiles` row. Same
shape, so the port is a read-source swap.

Phase-1-relevant subset (the geometry entries are carried but unused until Phase 3):

| Property | Default | Severity if exceeded |
|---|---|---|
| `renderedFontFamily` | exact | **critical** |
| `fontSizePx` | exact | high |
| `fontWeight` | exact | high |
| `color` (text) | ΔE_OK ≤ 2.0 | high |
| `backgroundColor` | ΔE_OK ≤ 2.0 | high |
| `lineHeightPx` | ±1.5px | medium |
| `letterSpacingPx` | ±0.2px | low |
| `gapMeasured` | ±2px | medium |
| `paddingMeasured` | ±2px | medium |
| `border.radius` | ±1px | low |
| `border.width` | ±0.5px | medium |
| shadow offset/blur/spread | ±2px | low |
| shadow color | ΔE_OK ≤ 3.0 | low |
| `opacity` | ±0.02 | low |

Each property also has a **warn band at 2× tolerance** producing `drift` findings — surfaced in the
report, non-gating.

> **ΔE_OK units, stated once.** Raw OKLab euclidean distance puts a just-noticeable difference near
> 0.02, which makes the doc's "≤ 2.0" unreadable. The implementation scales by 100 so the numbers sit
> on roughly the same footing as classic CIE ΔE units. `src/ir/color.js` documents this at the
> definition. **Action item for the parent doc:** state the scaling in §6.2.

---

## 5. Task list by phase

Each phase ends in something runnable. No phase depends on a later one.

### Phase 0 — Scaffold *(partially complete)*

- [x] Directory tree, `package.json` (ESM, Node 24, Playwright 1.57)
- [x] `.env.example`, `.gitignore`
- [x] `src/ir/color.js` — OKLab/OKLCH, `deltaEOK`, alpha compositing
- [x] `src/ir/schema.js` — `VisualNode`, snapshot, `walk`, `IR_SCHEMA_VERSION`
- [ ] `config/tolerance-default.json` — §4 table as data
- [ ] `src/config.js` — env load, Figma URL parse (`/design/` + `/file/`, `-` → `:`), viewport derive
- [ ] `src/cli.js` — flag parsing (`--web-only`, `--figma-only`, `--no-cache`, `--out`), orchestration
- [ ] `npm install` + Playwright chromium download
- [ ] **User: fill `.env`** with `FIGMA_TOKEN`, `FIGMA_FRAME_URL`, `PAGE_URL`

**Exit:** `npm run audit` runs end-to-end and fails with a clear message at the first unimplemented stage.

### Phase 1 — Figma side (M2 + M4)

- [ ] `src/figma/client.js` — REST client, token-bucket rate limiter, 429 backoff w/ `Retry-After`
- [ ] Version-keyed disk cache + `--no-cache` bypass + stale-cache degradation path
- [ ] **Spike: dump one real node response to `out/figma-raw.json` and verify §9's open questions**
- [ ] `src/ir/fonts.js` — PostScript → (family, weight, style), seeded with ~40 common families
- [ ] `src/ir/text.js` — §6.4 normalization (shared by both sides, single implementation)
- [ ] `src/figma/normalize.js` — tree → IR: coords, opacity accumulation, fills, strokes, text, effects, radius, roles
- [ ] `src/figma/tokens.js` — Variables (tier 1, tolerate 403) + Styles map (tier 2)
- [ ] `npm run extract:figma` writes `out/figma-ir.json`

**Exit:** a real frame produces IR with plausible colors, sizes and boxes, spot-checked against Figma's
own inspect panel on 5 nodes.

### Phase 2 — Web side (M1 + M3)

- [ ] `src/web/extract.js` — Playwright driver, 12-step stabilization, freeze CSS, overlay dismissal
- [ ] `src/web/serializer.js` — in-page walker, allowlist, pseudo-elements, shadow DOM, same-origin iframes, `webPath`
- [ ] `src/web/fonts-cdp.js` — CDP plumbing + signature-grouped sampling (N=5 per signature)
- [ ] `src/web/normalize.js` — serializer output → IR
- [ ] Determinism self-check: extract twice, diff, report any delta as a bug
- [ ] `npm run extract:web` writes `out/web-ir.json`

**Exit:** two consecutive extractions of the real page produce byte-identical IR.

### Phase 3 — Pipeline (P5 + P6)

- [ ] `src/pipeline/prune.js` — both sides, to fixpoint, with per-reason counts
- [ ] `src/pipeline/spacing.js` — measured gap + padding, direction inferred from geometry
- [ ] Report prune stats (before/after node counts per reason)

**Exit:** pruned web tree and pruned Figma tree have node counts within the same order of magnitude —
the parent doc's claim (§6.1) that pruning alone closes most of the structural gap, tested.

### Phase 4 — Audit (P7 + M7a)

- [ ] `src/figma/tokens.js` wired into `src/audit/` — tier resolution + reporting which tier
- [ ] **Tier 2.5 support (§2.3 addendum)** — config field naming token-source canvases; on the target
      file, point it at `Components` + `Spacing guideline`. Tier 3 stays as the fallback.
- [ ] Fetch and normalize the nominated canvases; compare their token set against the Tier 3 inferred
      set and report the divergence — that delta *is* the "page uses undefined values" signal
- [ ] `src/audit/palette.js`, `typography.js`, `spacing.js`, `shape.js`, `rendered-font.js`
- [ ] `src/audit/hygiene.js` — §9.6 weighted structural score
- [ ] `src/audit/discipline.js` — §2.4 token-discipline score, per-dimension concentration
- [ ] Enforce the web-side-count-only rule (§3.10) — single `occurrenceCount` field, no Figma-side counts
- [ ] `src/report/findings.js` — assembly, severity, §9.3 occurrence upgrade, fingerprints

**Exit:** `out/findings.json` on the real page, with both interpretation gates reported above the findings.

### Phase 5 — Report

- [ ] `src/report/console.js` — terminal summary
- [ ] `src/report/html.js` — self-contained, swatches, histograms, light/dark
- [ ] `npm run audit` produces all three outputs in one command

**Exit:** the user can open `out/report.html` and judge whether the findings are actionable — which is
POC question #2 (§1.1).

### Phase 6 — Validation harness

This is what separates "it ran" from "it is correct", and the parent doc has no equivalent.

- [ ] `fixtures/generate.js` — generate an HTML page **from the Figma IR**, so it is near-perfect by construction
- [ ] `fixtures/mutations.js` — inject N known deviations: off-palette color, off-scale font size,
      13px spacing, wrong radius, and a deliberately-broken `@font-face` (the critical check)
- [ ] Assert the audit finds **exactly** the injected set — no misses (blind spots), no extras (false positives)
- [ ] `test/` unit tests: color conversion round-trip, text normalization, prune fixpoint, audit thresholds

**Exit:** a clean run on the unmutated fixture (zero findings) and an exact-match run on the mutated one.

### Phase 7 — M8 feasibility probe *(diagnostic, ~half a day)*

- [ ] `src/probe/anchors.js` — normalize both sides' text via the shared §6.4 function, bucket into
      unique / ambiguous / figmaOnly / webOnly / numericLike
- [ ] Report `uniqueRate` **plus 5 samples per bucket** — the samples distinguish a content problem
      from a normalization bug, and the rate alone cannot
- [ ] Surface in the report as a clearly-labelled *diagnostic*, not a finding — nothing downstream consumes it

**Exit:** a number and its supporting samples, interpreted against the §3.13 bands. This is the POC's
only read on the risk that dominates the parent project.

### Phase 8 — Findings write-up

- [ ] Answer POC questions #1–#4 (§1.1) with evidence
- [ ] Record verified answers to §9's open questions
- [ ] Feed the five **action items for the parent doc** — flagged in §2.3 (Styles as token tier 2),
      §2.4 (token discipline gate), §3.5 (12-step stabilization), §3.10 (web-side-counts-only rule),
      and §4 (ΔE_OK scaling) — back into `evertest-backend/docs/figma-design-parity.md`
- [ ] Port plan: module-by-module mapping into `evertest-backend` (§8)

---

## 6. Validation strategy

The POC cannot validate itself against the user's real page — we do not know that page's ground truth,
and the *point* of running against it is that we do not know what is wrong with it. So there are two
distinct exercises and they must not be confused:

| Exercise | Target | Question answered |
|---|---|---|
| **Correctness** | Generated fixture with injected known deviations | Does the audit find exactly what is wrong, and nothing else? |
| **Usefulness** | The user's real Figma frame + real page | Are the findings things a designer would act on? |

The fixture is generated *from the Figma IR itself*, which means a clean run must produce **zero
findings**. Any finding on the unmutated fixture is a false positive with nowhere to hide — no "well,
maybe the page really is like that". This is the strongest correctness signal available without
manually measuring a real page by hand.

---

## 7. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Figma field shapes differ from the parent doc's assumptions | **High** | Medium | The Phase 1 spike dumps a real response and verifies §9 before the normalizer is written |
| CDP font plumbing is slow or flaky at scale | Medium | **High** — this is the highest-value check | Signature-grouped sampling (§3.7); degrade to declared-family-only with an explicit warning rather than failing the run |
| Page is heavily dynamic (A/B, personalization) → non-deterministic IR | Medium | High | Determinism self-check catches it in Phase 2; pinned `Date.now`/`Math.random` mitigates some of it |
| Figma file hygiene too low to be a useful target | Medium | Medium | Hygiene score reports it honestly rather than emitting garbage; may need a second file |
| Token audit findings are mostly noise | Medium | **High** — invalidates the parent doc's phasing | This is kill criterion #2 (§1.3), and finding it out now is the POC succeeding, not failing |
| **The design file has no real token system** | Medium | **High** — no fallback; token audit is the fallback | Token discipline score (§2.4) measures it directly rather than assuming structural quality implies it |
| **A green POC is over-read as validating the whole feature** | **High** | High | Stated plainly in §1.1: Phase 1 validates the foundation, not the matcher. The §3.13 probe is the only M8 signal, and it is explicitly a *diagnostic*, not a proof |
| Scope creep into matching | **High** | High | §1.2 non-goals are explicit; matching is Phase 2 of the *product*, not of the POC |
| Cross-origin iframes hide content | Low | Low | Counted and reported, so absence is visible rather than silent |

---

## 8. Port path into Evertest

Built so the port is mechanical, not a rewrite:

| POC | Evertest |
|---|---|
| `src/ir/*`, `src/figma/*`, `src/web/*`, `src/pipeline/*`, `src/audit/*` | Move to `src/modules/design-parity/` largely unchanged |
| Standalone Playwright launch | Reuse the existing runner's browser context in `src/automation.js` — **authenticated pages then work for free**, inheriting the run's session state (parent doc §4.1) |
| `.env` Figma token | `src/modules/integrations/` alongside existing integration credentials |
| `.cache/figma/` | `figma_cache[fileKey][version][nodeId]` in Supabase Storage |
| `config/tolerance-default.json` | `design_tolerance_profiles` row |
| `out/*-ir.json` | `design_snapshots` + IR blobs in Supabase Storage (large, read whole — never table columns) |
| `out/findings.json` | `design_findings` rows |
| `report.html` | React report UI in `evertest-ai-frontend-reactjs` |
| — | `design_runs.module_run_id` FKs into the existing module-run grain. **A run is a module run, not a test case.** |

Two POC modules are deliberately *not* ported as-is: the standalone CLI orchestration (replaced by the
module runner) and the HTML report (replaced by React). Everything else moves.

---

## 9. Open questions — **spike run 2026-07-30, answers below**

These were field-shape assumptions the parent doc makes that were unverified against a live file. The
spike ran against the real target frame (§11) *before* the normalizer was written, exactly as planned.

| # | Question | **Verified answer** |
|---|---|---|
| 1 | `fills[]` stacking order | **Partly answered.** Confirmed that entries carry `visible: false` and **must be filtered** — the target file has invisible IMAGE fills sitting in front of live ones. Multi-`SOLID` stacking order still needs a targeted check during M4. |
| 2 | `letterSpacing` units | **Answered — already px.** No `letterSpacingUnit` field appears; the REST value is a resolved number. Parent doc §6.3's "convert % → px" is unnecessary for REST (it applies to the Plugin API). |
| 3 | `lineHeightUnit: 'AUTO'` | **Answered, and better than feared.** Real values are `INTRINSIC_%` (167), `FONT_SIZE_%` (73), `PIXELS` (47) — no literal `AUTO`. Critically, **`lineHeightPx` is populated even for `INTRINSIC_%`**, so the planned `null` + warning fallback is not needed. Always read `lineHeightPx`. |
| 4 | `styles` map population | **Answered — effectively empty.** File-level map has 5 entries; only **34 of 1828 nodes (1.9%)** carry a `styles` ref. Token authority **Tier 2 is architecturally sound but useless on this file**. See §2.3 addendum. |
| 5 | `version` vs `lastModified` | **Answered.** `GET /v1/files/:key?depth=1` returns both cheaply. `version` (`2381962916501534456`) is the stable opaque cache key; `lastModified` is human-facing. Cache design in §3.3 is confirmed. |
| 6 | `absoluteRenderBounds` | **Answered — present but not universal.** 1613/1828 nodes (88%). The IR's `renderBox` **needs a documented fallback to `absoluteBoundingBox`** for the other 12%. |
| 7 | `boundVariables` presence | **Answered — absent.** 1/1828 nodes. Token authority **Tier 1 is not testable on this file.** Not a blocker; Tier 3 is the operative path. |
| **8** | **`style.fontWeight` reliability** *(new — discovered by the spike)* | **Answered — the field is unusable directly.** See below. This one would have silently poisoned the audit. |

### Q8 — `style.fontWeight` cannot be compared to CSS `font-weight`

The target file uses **Geist**, a variable font. The REST API reports its raw **weight-axis** value, not
a CSS weight — and reports *both schemes* for the same PostScript face depending on the node:

| `fontPostScriptName` | Reported `fontWeight` values | True CSS weight |
|---|---|---|
| `Geist-Regular` | **84** (×64) *and* 400 | 400 |
| `Geist-Medium` | **106** (×7) *and* 500 | 500 |
| `Geist-SemiBold` | **126** (×40) *and* 600 | 600 |
| `Geist-Bold` | **146** (×26) *and* 700 | 700 |
| `Geist-Black` | **176** (×2) *and* 900 | 900 |

The axis-to-CSS ratio hovers around 4.76× but is **not consistent enough to invert numerically**
(400/84 = 4.76, 900/176 = 5.11), so arithmetic conversion is not an option.

**Consequence if unhandled:** the audit would report *"the design uses 10 font weights — 84, 106, 126,
146, 176, 400, 500, 600, 700, 900 — the page uses 4"* and emit **five phantom violations, all false**.
That is precisely the class of bug that destroys trust in a tool on its first run.

**Resolution:** `fontPostScriptName` → `(family, weight, style)` is **mandatory and load-bearing**, not
the convenience the parent doc §6.3 implies. It was already in the plan (§3.4) for font *identity*; it
is now also the only valid source of font *weight*.

**Payoff:** once normalized through PostScript names, the design's weight set collapses from a nonsense
10 to a clean **5 — 400/500/600/700/900** — which is a perfectly sane design system. The file looks far
more disciplined after correct normalization than before it, which is a good reminder that early
"the design is a mess" readings are often extractor bugs.

**Action item for the parent doc:** add this to §6.3 as a normalization rule. It applies to every
variable font, not just Geist, so it will recur across customers.

---

## 10. Deferred to the product, not the POC

Listed so their absence is a decision rather than an oversight — every one is specified in the parent
doc and none is needed to answer the POC's three questions:

M6 tolerance normalization beyond the flat profile · M8 candidate mapping, all layers · M9 pairwise
comparison · M11 LLM analyzer · SVG box overlay · mapping review UI · baselines and fingerable
acceptance · CI gating policy · `data-figma-node` annotation mode · learned mappings · multi-breakpoint
configs · OAuth (POC uses a PAT, matching the parent doc's own §14.1 recommendation for Phase 1) ·
icon path-hash comparison (`geometry=paths`) · cross-origin iframes.

---

## 11. Target configuration

**All inputs verified against the live API on 2026-07-30. No blockers remain.**

| Field | Value | Status |
|---|---|---|
| Page URL | `https://quokkalabs.com/` | Confirmed — public, no auth needed |
| Figma file | `QL website try` | Confirmed, HTTP 200 |
| `figmaFileKey` | `gGFC7zUkdsCuLkAr6qTle6` | Verified |
| `figmaNodeId` | `2743:6476` | Verified — **`FRAME`**, "Final Home Page (Enhancements) Web View" |
| `viewportWidth` | **1920** | Auto-derived from `absoluteBoundingBox.width` |
| Frame height | 19752px | Long page — ~20k px of scroll to stabilize |
| `FIGMA_TOKEN` | set in gitignored `.env` | Working. **Token was pasted in chat — rotate when convenient.** |
| Token role | `viewer` | Sufficient for read-only extraction |
| File `version` | `2381962916501534456` | Confirmed as the cache key (§9 Q5) |

### 11.1 Frame shape

```
1828 nodes total (1793 visible)  ·  470 frames/instances  ·  287 TEXT nodes
49 INSTANCE nodes  ·  33 components  ·  20 componentSets
1.6 MB raw JSON without geometry=paths
```

Comfortably within any size limit, and small enough that the whole pipeline can run in seconds.

### 11.2 Preliminary gate readings

Computed from the raw dump, **before** normalization — so these are pessimistic, and Q8 shows exactly
how much normalization moves them.

| Signal | Raw reading | Assessment |
|---|---|---|
| Auto-layout coverage | 306/470 = **65.1%** | Decent. The strongest hygiene component. |
| Multi-child containers without auto-layout | 70 | Moderate absolute positioning. |
| Default-named layers | 1324/1828 = **72.4%** | **Weak** — only 27.6% carry real names. |
| Nodes inside instances | 49/1828 = **2.7%** | **Weak** — components exist but are barely used in this frame. |
| **Rough hygiene score (§9.6 weights)** | **≈ 0.39** | **Right at the 0.4 gate.** Fine for token audit; a warning sign for Phase 2. |
| Distinct font sizes | 44, top-8 covering 73.2% | Inflated by scaling artifacts — see below. |
| Distinct solid colors | 50, top-8 covering **81.2%** | **Good.** A clear primary palette: `#835CF5`, `#1C2025`, `#FFFFFF`. |
| Distinct font families | 5 — Geist (195), Public Sans (50), DM Mono (31), Inter (7), Nunito Sans (4) | Reasonable; the Inter/Nunito tails are likely strays. |
| Distinct radii | 26 | **Poor** — heavily polluted by scaling artifacts. |
| Font weights | 10 raw → **5 after PostScript normalization** | Was a false alarm. See §9 Q8. |

**Scaling artifacts.** Values like `fontSize: 22.20689582824707`, `20.000436782836914`, and
`cornerRadius: 47.586204528808594` / `7.972027778625488` indicate frames resized non-uniformly rather
than re-laid-out. These are genuine design-hygiene defects and the audit *should* report them — but
they will dominate the radius findings, so the report must rank by occurrence count (§3.10) or they
will bury the real signal.

### 11.3 Text-anchor pre-read (Figma side only)

287 TEXT nodes · 253 distinct strings · **232 unique (80.8%)**

Most-repeated: `"04"` ×5, `"explore service →"` ×5, `"this is a hint text to h…"` ×5.

This is the Figma half of the §3.13 probe and it is a **strong** number — well above the 0.70 band.
It does not yet include the web side, where the real test is, but it does confirm the design frame has
rich unique-text signal rather than being a wall of `Lorem ipsum`. Encouraging for M8.

### 11.4 Confirmed target-specific risks

- **"Final Home Page (Enhancements) Web View"** — the frame name says *Enhancements*, and a sibling
  frame is literally named `In Progress 15-06-2026`. This is likely a **proposed/in-flight design**, not
  a record of what is deployed. Findings should therefore be framed as *"the live page does not yet
  match this design"* rather than *"the implementation has drifted"*. Worth confirming, but it does not
  change the code — only the report's wording.
- **1920px is a wide viewport.** quokkalabs.com will be extracted at 1920 to match the frame. Correct
  per parent doc §3.1, but note that 1920 is not the most common real-world viewport, so findings
  describe the site's widest layout.
- **19752px of page height** means the stabilization scroll loop (§3.5 step 8) is the slowest part of
  the run and the most likely place lazy-loaded content misbehaves. Worth instrumenting from the start.
- **Marketing sites are the weakest case for token discipline.** Confirmed only partially here — colors
  are disciplined (81.2%), radii are not. The §2.4 gate should be read per-dimension, not as a single
  scalar, and the plan's per-dimension breakdown already supports that.
