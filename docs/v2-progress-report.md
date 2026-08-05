# Figma Design Parity V2 — Progress Report

Living tracker for the V2 build. Design and rationale live in `v2-architecture.md`,
`v2-hld.md` and `v2-implementation-plan.md` — **this file tracks only what has actually
been done, what is pending, and what needs manual action.**

Branch: **`v2`** (`origin/v2`) · Baseline: `a8014af` on `main`

---

## Status at a glance

| Phase | Status |
|---|---|
| **0 — Ship-now improvements** | 🟡 **In progress** — ΔE bands and deep links done and verified; determinism default done; 2 items open |
| **1 — E1 comparable element set** ⛔ GATE | ⬜ Not started |
| **2 — E2 correspondence** ⛔ GATE | ⬜ Not started |
| **3 — E3 structural verdict** | ⬜ Not started |
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

### ⬜ Exclude unstable nodes from findings

Still **flagged** (`lowConfidence`) rather than excluded. Deliberately deferred within Phase 0:
it changes finding counts, so it needs its own before/after verification rather than riding
along with cosmetic changes.

### ⬜ Section-match confidence → severity

Not started. Section confidence ranges **0.669 – 0.938** on the reference run and findings from
both extremes are presented identically today.

### ⬜ Score instability (NFR N7)

Not started. The same page scored **64** and **65** minutes apart. Suspected cause is dynamic
content; the determinism default above may itself change the picture, so re-measure before
investigating further.

---

## Verified facts driving the build

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

## Blocked / needs manual action

| Item | Owner | Blocking |
|---|---|---|
| Confirm `/v1/images` rate-limit tier | user | Phase 2 |
| Manual correspondence scoring, 3 section pairs (~½ day) | user | Phase 2 gate |
| Second Figma file + live page | user | re-running the Phase 1 gate |
| Confirm Gemini enforces JSON-schema output (not merely requests it) | me, early Phase 2 | Phase 2 design |

---

## Decisions log

| Date | Decision |
|---|---|
| 2026-08-05 | Screenshots to LLM **allowed**; Gemini for development; POC repo; desktop only; complete V2 before shipping |
| 2026-08-05 | Figma seat is **View/Collab (~6 Tier-1 requests/month)** → render whole frame once and crop locally; never call `/v1/files/:key`; cache indefinitely |
| 2026-08-05 | Tier 1 anchoring is **not** box IoU — X-overlap + width ratio + reading order + signature, with a Y warp between anchors (heights differ up to 4.93×) |
| 2026-08-05 | E5 issue prioritisation runs **before** evidence, so one merged issue gets one screenshot |

---

## Changelog

**2026-08-05**
- Branch `v2` cut from `main` at `a8014af`
- Phase 0: ΔE bands calibrated and shipped to HTML + UI
- Phase 0: section-scoped deep links (Figma + CSS selector) on 95/97 findings
- Phase 0: determinism self-check now default-on in server and UI
