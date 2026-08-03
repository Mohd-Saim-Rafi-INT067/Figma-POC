# Figma Design Parity — V1 Architecture (Section-Level)

**Status:** Proposal, for review
**Supersedes:** the token-audit scope in `poc-implementation-plan.md` §1.1 (that plan's extraction half stands unchanged)
**Parent design:** `evertest-backend/docs/figma-design-parity.md`

---

## 1. The one-line summary

> Compare **sections as whole units**, not their internal nodes. Use text to **match**, never to **report**.

Everything below follows from those two rules.

---

## 2. Is this an architectural change?

**No. It is a scope change to one stage.**

The pipeline shape is unchanged: *extract → normalize → common model → compare → report*. Both extractors, both normalizers, and the common UI model are untouched and already built.

```
                    UNCHANGED (built & verified)          CHANGED
        ┌──────────────────────────────────────────┐  ┌─────────────┐
Figma ─►│ M2 Extract ─► M4 Normalize ─┐            │  │             │
        │                              ├─► M5 IR ──┼─►│  Comparison │─► Report
Web ───►│ M1 Extract ─► M3 Normalize ─┘            │  │             │
        └──────────────────────────────────────────┘  └─────────────┘
```

| Module | V1 status |
|---|---|
| M1 Web extraction | **Unchanged** — built, 3219 nodes in ~13s |
| M2 Figma extraction + cache | **Unchanged** — built, cold 13.2s → warm 1.1s |
| M3 Web normalizer | **Unchanged** — built |
| M4 Figma normalizer | **Unchanged** — built, 1828/1828 invariants pass |
| M5 Common UI Model | **Unchanged** shape; trimmed of fields V1 does not compare |
| **S1 Section segmentation** | **NEW** — small module, ~150 lines |
| **S2 Section matching** | **REPLACES** M8 node matching |
| **S3 Section comparison** | **REPLACES** M9 pairwise node comparison |
| S4 Finding assembly | Reduced form of M10 |
| S5 LLM report | Unchanged in principle (M11) |

One new module, two replaced. Nothing before the common model moves.

---

## 3. Why sections work — measured on the real file

Not theoretical. Both sides already expose a clean section list:

| | Top-level children | After pruning | Pruned |
|---|---|---|---|
| **Figma** frame `2743:6476` | 20 | **18** | 2 decorative groups (h=20px) |
| **Web** `quokkalabs.com` | 21 | **19** | 1 `display:none` iframe, 1 floating widget (282×253) |

18 vs 19. Both naturally ordered top-to-bottom.

**The scale of the risk reduction:**

```
Node-level matching (original):  1828 × 3219  =  5,884,332 candidate pairs
Section-level matching (V1):        18 × 19   =        342 candidate pairs
                                                   ~17,000x smaller
```

Two further properties make section matching qualitatively easier, not just smaller:

1. **Sections do not reorder.** The header is above the hero is above the footer, on both sides. That turns tree matching into **1-D ordered sequence alignment**, which is a solved problem with an exact algorithm.
2. **Below the section boundary, nothing needs correspondence.** Every V1 comparison is an aggregate or a distribution over a section — which is the same correspondence-free technique the parent doc (§7.1) calls "nearly impossible to get wrong."

> ⚠ **Measured caveat.** The Figma frame is **19752px** tall; the live page is **23939px** — the page is **21% taller than the design**. Section matching must therefore align on *normalized* position and *order*, never absolute pixels. Section heights also do not map 1:1 (web section 6 is 3495px; Figma's tallest is 1380px), so the aligner must support insertions and deletions rather than assuming equal counts.

---

## 4. Data flow

```
  Figma frame URL                              Page URL
        │                                          │
        ▼                                          ▼
  ┌───────────────┐                        ┌───────────────┐
  │ M2 Extract    │  REST + version cache  │ M1 Extract    │  Playwright + CDP
  │               │  (one call, reused)    │               │  12-step stabilization
  └───────┬───────┘                        └───────┬───────┘
          ▼                                        ▼
  ┌───────────────┐                        ┌───────────────┐
  │ M4 Normalize  │                        │ M3 Normalize  │
  └───────┬───────┘                        └───────┬───────┘
          └──────────────────┬─────────────────────┘
                             ▼
                  ┌──────────────────────┐
                  │  M5 Common UI Model  │   one schema, both sides
                  └──────────┬───────────┘
                             ▼
                  ┌──────────────────────┐
                  │  S1 Segmentation     │   IR ─► ordered section list (both sides)
                  └──────────┬───────────┘
                             ▼
                  ┌──────────────────────┐
                  │  S2 Section Matching │   ordered sequence alignment
                  │  + confidence        │   text anchors as tiebreaker only
                  └──────────┬───────────┘
                             ▼
                  ┌──────────────────────┐
                  │  S3 Section Compare  │   DETERMINISTIC. aggregates only.
                  │                      │   no per-node claims.
                  └──────────┬───────────┘
                             ▼
                  ┌──────────────────────┐
                  │  S4 Finding Assembly │   severity, grouping, counts
                  └──────────┬───────────┘
                             ▼
                  ┌──────────────────────┐
                  │  S5 LLM Report       │   prose only. never a number.
                  └──────────┬───────────┘
                             ▼
                  findings.json  +  report.md/html
```

---

## 5. Module responsibilities

### S1 — Section Segmentation *(new)*

Turns each side's IR into an **ordered list of sections**.

- **Figma:** direct children of the target frame. *Must be sorted by `y`* — the API returns them in arbitrary order (verified: the real file's first child is at y=2490, third at y=0). Drop invisible, zero-area, and decorative strips (full-width dividers under ~24px).
- **Web:** direct children of `<body>` (unwrapping a single wrapper element if present). Drop `display:none`, zero-area, and non-full-width floaters like chat widgets.

Each section carries: index, normalized y, height, width, and a **content digest** (text-anchor set, color set, type set, node count).

### S2 — Section Matching *(replaces M8)*

**Order-preserving sequence alignment** (Needleman–Wunsch) over the two section lists, allowing insert/delete so a designed-but-unbuilt section reports rather than corrupting the alignment.

```
cost(figmaSection, webSection) =
      w₁ · |Δ normalized y|
    + w₂ · (1 − heightRatioSimilarity)
    + w₃ · (1 − jaccard(textAnchors))      ← text used HERE, and only here
    + w₄ · (1 − contentDigestSimilarity)
```

Every pair carries a confidence. Unmatched sections become `missing-in-web` / `extra-in-web` findings at reduced severity.

### S3 — Section Comparison *(replaces M9)*

For each matched pair, compare **aggregates over the section** — never node to node:

| Category | Compared |
|---|---|
| Geometry | section height (normalized), relative offset, width |
| Color | dominant background; palette **set** used within the section |
| Typography | family / size / weight **sets** used within the section |
| Spacing | measured-spacing distribution (never declared `margin`/`gap`) |
| Shape | radius and shadow **sets** |
| Density | node-count ratio — a structural-richness proxy |
| Fonts | rendered vs declared family (the CDP check) |

**This is the load-bearing design decision:** because every check is a set or a distribution over the section, V1 needs **zero correspondence below the section boundary**.

### S4 / S5

S4 assembles findings with severity and occurrence counts. S5 hands the finished findings to the LLM, which writes prose and **never produces a number** — every value exists before it is called.

---

## 6. Scope

### In V1

✅ Section segmentation and alignment · section geometry · color palettes · typography sets · measured spacing · radius/shadow sets · rendered-font check · missing/extra sections · deterministic comparison · LLM-written report

### Explicitly deferred to V2

❌ **Per-node matching inside sections** — the hard module, now optional rather than foundational
❌ **Per-node property comparison** — "this button's padding is 4px off"
❌ **Text content comparison** — text is extracted and used for matching, never reported
❌ **Dynamic content handling** — flagged and excluded, not solved
❌ SVG overlay UI · baselines · CI gating · `data-figma-node` annotations · multi-breakpoint

---

## 7. Why this is lower risk

### Complexity removed

| Removed | Was |
|---|---|
| Tree-to-tree node matching | 3–4 weeks, ~60% of total project risk |
| Hungarian assignment, upward propagation, confidence gating | Parent doc §8.3–8.6 |
| LLM adjudication of ambiguous pairs | Parent doc §8.5 — no LLM in the comparison path at all now |
| Mapping cache, learned mappings, mapping review UI | Parent doc §8.7, §12 |
| Text-content false positives | "John Doe" vs "Saim" can no longer be a finding |

### Risks reduced

1. **The dominant risk is deferred, not merely reduced.** V1 does not depend on M8 succeeding.
2. **Failure is legible.** A mis-aligned section is visible to a human in seconds; a mis-matched node among 3219 is not.
3. **Failure is localized.** Sequence alignment means a bad footer match cannot corrupt the hero.
4. **More robust to dynamic content.** The carousel found on the live page shifts its children's x-positions by 327px between runs — but the *section's* height, background, and palette are unaffected. Aggregate comparison is naturally immune to motion that per-node comparison is not.
5. **Deterministic.** No LLM in the comparison path, so identical inputs give byte-identical findings.

### Trade-offs we are accepting

Stated plainly, because they are real:

| Trade-off | Consequence |
|---|---|
| **Coarser findings** | "This section's spacing distribution differs" — not "the CTA button's padding is 4px off." Less immediately actionable. |
| **Compensating errors can cancel** | One element too wide and another too narrow may leave the aggregate unchanged. |
| **Internally-wrong sections can pass** | Correct height, palette and type sets, but wrong internal arrangement, will not be caught. |
| **Depends on sane top-level structure** | A page built as one giant `<div>` soup with no sectioning degrades badly. (Measured fine here: 19 clean sections.) |
| **Section-count mismatch is a blunt signal** | 18 vs 19 needs human interpretation; V1 reports the alignment, it does not explain it. |

### Extensibility — the key property

**V1's output is exactly V2's input.** This is not a rewrite path; it is the intended growth path.

Parent doc §8.8 already prescribes **section-level chunking** as the way to make node matching tractable: *"matching runs per top-level section rather than whole-page… this bounds every matrix, bounds LLM context, parallelizes cleanly, and localizes failure."*

So S2 is not throwaway scaffolding for V1 — **it is the module M8 needs anyway**. V2 adds node matching *inside* each already-matched section pair:

```
V1:   S1 ─► S2 ─► S3 (aggregate) ─► S4 ─► S5

V2:   S1 ─► S2 ─┬► S3 (aggregate) ──┬► S4 ─► S5
                └► M8 (node match)  │
                   inside each pair ─┘
                   └► M9 (node compare)
```

Nothing above is rewritten. M8 slots in as a consumer of S2's matched pairs, and M9's per-node findings join S3's aggregate findings in the same S4 assembly.

---

## 8. Implementation status

| | |
|---|---|
| **Already built and verified** | M1, M2, M3, M4, M5 — the entire extraction half |
| **To build for V1** | S1, S2, S3, S4, S5 |
| **Estimate** | ~1.5–2 weeks, versus 10–14 weeks for the original full design |

Work already completed that carries over unchanged: Figma REST client with version-keyed cache and rate-limit degradation; the 12-step stabilization sequence; the CDP rendered-font check; PostScript font-weight normalization; OKLCH/ΔE color comparison; unstable-region detection.

---

## 9. Open questions for review

1. **Section granularity.** Top-level children only, or should a very tall section (web §6 is 3495px) be split further? Recommend: top-level only for V1, revisit with real findings.
2. **Height tolerance.** The page is 21% taller than the design overall. Should section height comparison be absolute, normalized to total height, or reported both ways? Recommend: normalized, with the absolute delta shown alongside.
3. **Section-count mismatch (18 vs 19).** Is one design section unbuilt, or does the page split one design section into two? Needs a human look at the alignment output before we tune weights.
4. **Tier 2.5 token source** (carried over): are `Components` and `Spacing guideline` the right canvases? Still blocking the palette/type comparisons in S3.
