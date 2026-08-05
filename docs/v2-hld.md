# Figma Design Parity V2 — High-Level Design

**Status:** proposal, for review
**Companion documents**

| Document | Carries |
|---|---|
| `v2-architecture.md` | Rationale — *why* each stage exists, trade-offs, measured evidence |
| **this document** | Structure — components, contracts, data flow, cross-cutting concerns, NFRs |
| `v1-architecture.md` | The shipping design V2 replaces below the section boundary |
| `evertest-backend/docs/figma-design-parity.md` | Parent product design |
| `evertest-backend/docs/figma-integration.md` | How this ships inside Evertest |

---

## 1. Purpose and scope

### 1.1 What V2 does

Given a **Figma frame URL** and a **page URL**, produce a report that names every element whose
implementation differs from its design — structurally (missing, extra) or stylistically (colour,
type, spacing, geometry) — with a screenshot pinpointing each one.

### 1.2 In scope

Section-by-section then element-by-element comparison · structural presence/absence · per-element
style comparison · annotated visual evidence · issue merging and prioritisation · plain-language
metric explanation.

### 1.3 Out of scope

Text content comparison (design copy and live copy legitimately differ) · hover/focus/active states
(a Figma frame is static) · animation · icon artwork below the bounding box · responsive behaviour
beyond explicitly configured breakpoints.

### 1.4 Relationship to V1

V2 replaces the comparison layer only. Extraction, the IR, pruning, measured spacing, section
segmentation and section matching are unchanged — approximately **75% of the engine**, including
every part that required significant tuning.

---

## 2. System context

```
        ┌──────────────┐                          ┌──────────────┐
        │  Figma REST  │                          │  Live page   │
        │  /v1/files   │                          │   (HTTPS)    │
        │  /v1/images  │                          └──────┬───────┘
        └──────┬───────┘                                 │
               │ frame JSON, renders            Playwright + CDP
               ▼                                         ▼
        ╔══════════════════════════════════════════════════════════╗
        ║              Figma Design Parity Engine V2               ║
        ║   extraction → IR → sections → elements → findings       ║
        ╚════════════════════════┬═════════════════════════════════╝
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
        findings.json      report.html        section + evidence
        (machine)          (human)            renders (PNG)
                                 │
                                 ▼
                        ┌────────────────┐
                        │  LLM provider  │  correspondence (E2)
                        │  vision + JSON │  fix text (E5), prose (S5)
                        └────────────────┘
```

**External dependencies**

| Dependency | Used for | Failure mode |
|---|---|---|
| Figma REST `/v1/files/:key/nodes` | design tree | cached fallback + stale warning |
| Figma REST `/v1/images` | section renders | evidence degrades to numbers only |
| Playwright / Chromium | page extraction + web renders | run fails; no partial report |
| LLM provider (vision + structured output) | E2, E5 fix text, S5 prose | E2 falls back to Tier 1 only; report ships without fix text |

**Principle:** every external dependency except Playwright degrades rather than fails. A run that
cannot reach Figma renders still produces every measured finding.

---

## 3. Pipeline

```
                  Figma frame URL  +  page URL  +  tolerance profile
                                    │
                       ┌────────────┴────────────┐
                       │  Config                 │
                       │  fileKey / nodeId       │
                       │  pageUrl                │
                       │  viewportWidth ◄── auto-derived from frame
                       └────────────┬────────────┘
            ┌───────────────────────┴───────────────────────┐
            ▼                                               ▼
   M2  Figma extraction                            M1  Web extraction
       REST + version-keyed cache                      Playwright + CDP
            │                                           12-step stabilization
            ▼                                               ▼
   M4  Figma normalizer                            M3  Web normalizer
            └───────────────────────┬───────────────────────┘
                                    ▼
                       M5  Common UI Model (IR)          ── UNCHANGED FROM V1
                       flat node array per side
                                    ▼
                       P5  Pruning       P6  Measured spacing
                                    ▼
                       S1  Section segmentation
                                    ▼
                       S2  Section matching  (Needleman-Wunsch, order-preserving)
                                    │
        ════════════════════════════╪════════════════════════════  V2 BOUNDARY
                                    ▼
                    ┌───────────────────────────────┐
                    │   FOR EACH MATCHED SECTION    │
                    │                               │
                    │   E1  Comparable element set  │  deterministic
                    │            ▼                  │
                    │   E2  Element correspondence  │  LLM + geometry, cached
                    │            ▼                  │
                    │   E3  Structural verdict      │  deterministic
                    │            ▼                  │
                    │   E4  Property comparison     │  deterministic
                    └───────────────┬───────────────┘
                                    ▼
                       E5  Issue prioritisation      merge by element,
                                    ▼                 visual severity, cap
                       E6  Evidence render           boxes from measured geometry
                                    ▼
                       E7  Report assembly
                                    │
                       ┌────────────┼────────────┬──────────────┐
                       ▼            ▼            ▼              ▼
                 findings.json  report.html  evidence/*.png  S5 prose
```

---

## 4. Module map

| Stage | Responsibility | Deterministic | Status |
|---|---|---|---|
| M1 / M2 | Extraction — page and frame | yes | reused |
| M3 / M4 | Normalizers → IR | yes | reused |
| P5 / P6 | Pruning, measured spacing | yes | reused |
| S1 | Section segmentation | yes | reused |
| S2 | Section matching + confidence | yes | reused |
| **E1** | Reduce each side to comparable elements | yes | **new** |
| **E2** | Element-to-element correspondence | **no** (cached) | **new** |
| **E3** | Structural verdict + repeated-group rule | yes | **new** |
| **E4** | Per-element property comparison | yes | **replaces S3** |
| **E5** | Merge to element issues, rank, cap, fix text | yes (+opt LLM) | **new** |
| **E6** | Section capture + annotation | yes | **new** |
| **E7** | Report assembly | yes | rework |
| S5 | Written summary | no | reused |

---

## 5. Stage contracts

The interfaces between stages. Each is a plain JSON-serialisable value — no class instances — so any
stage boundary can be persisted, cached, or replayed in isolation.

### 5.1 E1 — Comparable element set

```
in:   SectionPair { figma: Section, web: Section, confidence }
      IR nodes for both sides
out:  ElementSet {
        sectionPairId,
        figma: Element[],
        web:   Element[],
        collapsed: { vectorClusters, wrappers, hidden }   // audit trail
      }

Element {
  id, parentId, depth, orderIndex,
  role, roleConfidence,
  box,             // SECTION-RELATIVE; both sides at identical width
  styleSignature,  // fill · border · radius · shadow · fontFamily/Size/Weight
  hasText,         // boolean only — the string never leaves E1
  childCount
}
```

**Target: 20–80 elements per side per section.** Larger means E1 is under-pruning; correspondence
cost and report readability both degrade.

### 5.2 E2 — Correspondence

```
in:   ElementSet, section renders (both sides)
out:  Correspondence {
        pairs:       { figmaId, webId, confidence, tier, descriptor }[],
        unmatchedFigma: { figmaId, confidence }[],
        unmatchedWeb:   { webId,   confidence }[],
        cacheHit: boolean,
        rejected: { proposal, reason }[]      // verification failures, logged not reported
      }

tier: 'anchor' | 'llm' | 'unresolved'
```

The LLM response schema contains **no numeric field other than `confidence`** — structurally
incapable of carrying a measurement.

### 5.3 E3 — Structural verdict

```
out:  StructuralVerdict {
        matched: number,
        missingInWeb: StructuralFinding[],
        extraInWeb:   StructuralFinding[],
        repeatedGroups: { templateId, figmaCount, webCount, suppressed }[]
      }
```

Count differences inside a repeated group are **suppressed by design** — dummy design content vs real
production data is not a defect.

### 5.4 E4 — Property comparison

```
in:   Correspondence.pairs, tolerance profile
out:  PropertyFinding[]

PropertyFinding {
  figmaId, webId, sectionPairId,
  category, property, type,
  expected, actual, delta, ratio, tolerance,
  severity, matchConfidence, lowConfidence,
  fingerprint
}
```

Geometry uses `boxRelative` — measured against the **matched parent**, so one mis-sized ancestor
yields one finding rather than cascading through its subtree.

### 5.5 E5 — Issue prioritisation

```
in:   PropertyFinding[] + StructuralFinding[]
out:  ElementIssue[]  (primary)  +  SystemicIssue[]  (secondary projection)

ElementIssue {
  elementId, descriptor,
  figmaNodeId, webSelector,          // deep links
  issueCount, visualSeverity,
  properties: PropertyFinding[],
  structural: 'present' | 'missing' | 'extra',
  templateInstanceCount,
  suggestedFix: { text, citedFindingIds } | null,
  evidencePath                       // filled by E6
}
```

Both projections read the same finding set; neither duplicates data.

### 5.6 E6 / E7 — Evidence and report

```
out:  evidence/<issueId>.png       annotated crop or side-by-side
      sections/{figma,web}/<i>.png full renders
      sections/thumbs/<i>.png      ~600px
      findings.json                machine-readable, the CI/baseline contract
      report.html                  human-readable
```

---

## 6. Data model

### 6.1 Run artifacts

```
out/runs/<runId>/
  run.json                  status, stages, warnings, meta
  figma-ir.json  web-ir.json
  sections.json  section-alignment.json
  elements.json             E1 output, both sides, all sections
  correspondence.json       E2 output + rejected proposals
  findings.json             E4 + E3, the machine contract
  issues.json               E5 merged issues, ranked
  sections/  evidence/      PNG artifacts
  report.html  report.md
```

### 6.2 Persistent stores (Evertest)

| Store | Key | Purpose |
|---|---|---|
| `correspondence_cache` | structure hash (§7.1) | makes steady-state runs deterministic and free |
| `figma_render_cache` | fileKey + nodeId + fileVersion | renders are immutable per version |
| `design_baselines` | project + frame + breakpoint | regression mode |
| `finding_suppressions` | fingerprint | accepted deviations, permanent |

---

## 7. Cross-cutting concerns

### 7.1 Determinism

**Requirement:** identical inputs produce byte-identical `findings.json`. Baselines, CI gating and
trust all depend on it.

E2 is the only non-deterministic stage. It is contained by cache:

```
correspondenceCacheKey = hash( figmaFileVersion, figmaNodeId,
                               webStructuralHash, irSchemaVersion,
                               promptVersion, matcherVersion )
```

`webStructuralHash` covers pruned tree shape only — roles, hierarchy, box topology — and deliberately
**excludes style values**, so a colour change does not invalidate a mapping. On a hit E2 is skipped:
zero LLM calls, fully deterministic run.

**Policy:** CI gating requires a cache hit, or keys only off findings whose correspondence tier is
`anchor`.

### 7.2 Degradation

| Failure | Behaviour |
|---|---|
| Figma 429 on frame fetch | serve cached frame, warn prominently |
| Figma 429 / error on renders | report ships with numbers, no evidence images |
| LLM unavailable or over budget | E2 falls back to Tier-1 anchors only; unresolved elements counted, not reported |
| Section match confidence < floor | section compared but all findings tagged low-confidence |
| Dynamic content detected | unstable elements excluded from findings, count reported |

No failure below Playwright produces an empty report.

### 7.3 Rate limits and cost

Both `/v1/files/:key/nodes` and `/v1/files/:key` are Figma **Tier 1** — the most restricted tier
(10–20 req/min on Dev seats; as low as 6 per *month* on View/Collab seats). `/v1/images` tier is
**unconfirmed and must be established before build**.

Controls: drop the redundant version-check call (the `/nodes` response already carries `version`);
render cache keyed by file version; correspondence cache; per-run LLM budget cap with graceful
degradation on exhaustion.

### 7.4 Security and privacy

- Figma credentials are **never** request parameters. `resolveConfig` accepts what to audit, never
  whose credentials to audit with. Per-user OAuth tokens are injected at that boundary only.
- Tokens encrypted at rest (AES-256-GCM), decrypted per call, never logged.
- **No finding may carry text content.** `hasText` is a boolean; strings stop at E1. This prevents
  page copy and design copy leaking into reports, findings, or LLM prompts.
- Section renders sent to the LLM contain rendered page content — this is a **data-egress decision**
  requiring explicit customer consent in a multi-tenant deployment, and an opt-out that disables E2
  Tier 2.

### 7.5 Observability

Per-stage timing and outcome events (the existing `run:start` / `stage:*` / `run:done` contract),
plus V2-specific counters: elements before/after E1 collapse, per-section node-count ratio,
correspondence tier distribution, cache hit rate, rejected-proposal count and reasons, LLM tokens
per run, findings before/after E5 merge.

The **node-count ratio** and **rejected-proposal rate** are the two health metrics that predict
whether output can be trusted on a given file.

### 7.6 Concurrency

One audit at a time per tenant. Playwright plus two full IR snapshots is memory-heavy, and the Figma
caches are not write-coordinated. Second concurrent request returns 409 with the active run id.

---

## 8. Non-functional requirements

| # | Requirement | Target | Rationale |
|---|---|---|---|
| N1 | Determinism | byte-identical findings on cache hit | baselines and CI gating |
| N2 | Run duration | < 5 min typical page | interactive-ish UX |
| N3 | **Report volume** | **< 20 issues in landing view** | the failure mode V2 exists to fix |
| N4 | Correspondence precision | > 95% on high-confidence pairs | a wrong match produces confident nonsense |
| N5 | Elements per section after E1 | 20–80 | tractability and readability |
| N6 | Evidence coverage | 100% of high/critical issues | the core UX requirement |
| N7 | Score stability | identical page → identical score | currently violated (64 vs 65) |
| N8 | Degradation | no external failure yields an empty report | §7.2 |

**N3 and N4 are the ones that decide whether V2 succeeds.** Everything else is engineering.

---

## 9. Deployment view

| | POC | Evertest |
|---|---|---|
| Runtime | Node ESM, single process | ESM engine under `integrations/figma/engine/`, loaded by dynamic `import()` from CJS |
| Trigger | HTTP `POST /api/audit` | `POST /integrations/figma/audits` |
| Credentials | `.env` PAT | per-user OAuth, encrypted in `integration_connections` |
| Run state | `out/runs/<id>/run.json` | `figma_audit_runs` table |
| Artifacts | local filesystem | Supabase Storage |
| Progress | SSE | polling (bearer auth cannot ride `EventSource`) |
| Caches | local disk | Supabase tables |

The engine is credential-agnostic and storage-agnostic by construction, so the port is wiring rather
than rewriting.

---

## 10. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Trees remain non-comparable after vector collapse | medium | **fatal** | Phase 1 gate: re-measure node ratios (today 0.35–2.48) before anything else |
| R2 | Correspondence produces confident wrong matches | medium | high | three-tier design, IR verification, confidence gating, rejected-proposal metric |
| R3 | Report volume explodes | **high** | high | E5 merge + template grouping + cascade suppression + hard cap (N3) |
| R4 | LLM cost per run unviable | medium | medium | Tier 1 resolves most pairs free; correspondence cache; budget cap |
| R5 | Figma render endpoint rate-limited | medium | medium | render cache; evidence degrades to numbers |
| R6 | Data egress objection to sending renders | medium | high | explicit consent; opt-out disables Tier 2 only |
| R7 | Tuning cost underestimated | **high** | high | budget 4–8 weeks explicitly; do not treat as polish |
| R8 | Findings measured on one Figma file only | certain | medium | re-measure §4 evidence on a second file before build |

---

## 11. Requirement traceability

| Req | Delivered by | Phase |
|---|---|---|
| R1 section-then-element comparison | E1 · E2 · E4, inside S2 pairs | 1–4 |
| R2 structural comparison | E2 · E3 | 2–3 |
| R3 per-element CSS comparison | E4 + the nine dormant tolerance rules | 4 |
| R4 pinpointed visual evidence | E5 · E6 · E7 | 5–7 |
| R5 explain ΔE | E7 bands + swatch pairs | 0 |
| R6 accuracy and capability | baselines · suppressions · hygiene gate · multi-breakpoint | 0, 8 |

---

## 12. Build sequence and gates

| Phase | Contents | Estimate | Gate |
|---|---|---|---|
| 0 | ΔE bands · deep links · determinism default · confidence propagation | 2–3 d | ships against V1 |
| 1 | **E1 + node-ratio measurement** | 3–4 d | **ratios → ~1.0, else stop** |
| 2 | E2 all tiers + verification + cache | 2–3 w | **precision > 95% on 3 hand-scored sections** |
| 3 | E3 + repeated-group rule | 1 w | dummy-vs-real produces no false findings |
| 4 | E4 + dormant rules + noise controls | 2–3 w | findings/page within an order of magnitude of target |
| 5 | E5 merge, visual severity, cap | 1 w | **landing view < 20 issues** |
| 6 | E6 capture and annotation | 1.5 w | evidence on 100% of high/critical |
| 7 | E7 report rebuild | 2 w | — |
| 8 | Baselines + suppressions | 1.5 w | — |

**~11–14 weeks**, plus **4–8 weeks of tolerance tuning after the code works**.

Phases 1 and 2 carry the project's risk and cost roughly four days and one day respectively to
de-risk. Both gates should be executed before the remaining schedule is committed.
