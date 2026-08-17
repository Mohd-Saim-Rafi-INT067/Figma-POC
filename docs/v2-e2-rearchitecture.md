# E2 re-architecture — shortlist adjudication

**Status:** implementation plan, written before any code. Supersedes the Tier-1/Tier-2 split in
`v2-tier2-contract.md` §1 and §6; the boundary in §1 ("the model decides IDENTITY, code decides
VALUES") is **unchanged and still non-negotiable**.

Branch: `v2`. Companion to `v2-architecture.md` §6, `v2-hld.md` §5.2, `v2-implementation-plan.md`
Phase 2.

Every number below is measured against the six hand-scored sheets in `fixtures/spike/` (161 true
matches) using the code as it stands at `58820c2`. Nothing here is estimated.

---

## 1. Why this exists

Phase 2's gate fails: **precision 60% (9/15) at confidence ≥ 0.85, recall 33.5% (54/161)**. The
diagnosis on record is that ranking, not candidate generation, is the bottleneck. That diagnosis is
correct. The remedy on record — send Tier 1's leftovers to a vision model — does not follow from it,
and four measurements say so.

### 1.1 A residue-only Tier 2 is capped at 52.2% recall

Tier 1 does not merely miss pairs. When it makes a wrong claim it **consumes both elements**, so the
true partners never reach the residue the model is shown.

| sheet | true | Tier 1 ok | recoverable | poisoned (figma / web / both) |
|---|---|---|---|---|
| f12-w13 | 16 | 8 | 5 | 1 / 1 / 1 |
| f14-w15 | 20 | 14 | 5 | 0 / 1 / 0 |
| f15-w16 | 50 | 15 | 8 | 3 / 19 / 5 |
| f17-w18 | 17 | 2 | 4 | 10 / 1 / 0 |
| f6-w7 | 28 | 5 | 1 | 8 / 7 / 7 |
| f8-w9 | 30 | 10 | 7 | 8 / 3 / 2 |
| **total** | **161** | **54 (33.5%)** | **30 (18.6%)** | **77 (47.8%)** |

**A perfect oracle on the residue reaches 52.2%.** That bound is a property of the pipeline shape,
not of the model, and no prompt can move it.

### 1.2 Tier 1 confidence is anti-calibrated

Retaining only Tier 1 pairs at confidence ≥ *t*:

| t | kept | correct | Tier 1 precision | residue ceiling |
|---|---|---|---|---|
| 0 | 116 | 54 | 46.6% | 52.2% |
| 0.5 | 69 | 43 | 62.3% | 69.6% |
| **0.6** | 50 | 35 | **70.0%** | 80.7% |
| 0.7 | 27 | 18 | 66.7% | 92.5% |
| **0.85** *(the gate)* | 15 | 9 | **60.0%** | 93.8% |
| 0.95 | 2 | 1 | 50.0% | 98.8% |

Precision **peaks at 0.6 and falls as confidence rises**. The reporting gate selects pairs that are
worse than the mid band. The Phase 2 note that "confidence is well calibrated — all nine wrong
pairings scored 0.305–0.616 and nothing reached 0.85" was drawn from three sections and **does not
survive the extension to six**. It must be withdrawn from the progress report.

### 1.3 Seeds are not beyond argument

The strict pass produces 29 seeds, of which **19 are correct — 67.9%**. Seeds build the y-warp
(`buildYWarp`, `anchors.js:114`), so roughly one seed in three bends every later decision in its
section around a wrong knot.

### 1.4 But geometry ranks well — it only decides badly

Ranking every web element against each design element, no filters, no claiming:

| k | true partner in top-k |
|---|---|
| 1 | **36.0%** ← this is essentially what Tier 1 achieves |
| 3 | 65.8% |
| 5 | 75.8% |
| **8** | **86.3%** |
| 12 | 91.3% |
| 20 | 93.2% |

The gap from 36% to 86% is the entire opportunity. Geometry already knows where the answer is; it
cannot pick which one it is.

### 1.5 Strict one-to-one caps recall at 82%

| sheet | true | distinct web targets | unreachable under 1:1 |
|---|---|---|---|
| f15-w16 | 50 | 28 | 22 |
| f8-w9 | 30 | 23 | 7 |
| *(other four)* | 81 | 81 | 0 |
| **total** | **161** | | **29 (18.0%)** |

`resolve()` is greedy one-to-one (`anchors.js:230`) and `verifyProposals` rejects double assignment
(`verify.js:93`). 29 true matches are therefore unreachable by construction, and **any recall target
must be stated against 82%, not 100%**, until §3.3 is resolved.

---

## 2. The change

**Tier 1 stops claiming. It becomes a candidate generator, and the model's task becomes multiple
choice rather than open search.**

```
Figma IR + Web IR
        ↓  (S1/S2 unchanged)
   section pairs
        ↓
E2a  candidate generation     top-k web candidates per design element, ranked.
                              Nothing claimed. Filters score; they never eliminate.
        ↓
E2b  warp anchors             mutual-best + margin only. Used ONLY to build the
                              y-warp. Never published as a match.
        ↓
E2c  adjudication             one model call per section pair. Both crops + the
                              shortlist table. Returns an INDEX into the supplied
                              candidate list, or null.
        ↓
E2d  assignment               deterministic validation, conflict resolution,
                              constrained many-to-one, confidence gate.
        ↓
E3 → E4 → E5 → E6 → E7        unchanged
```

### 2.1 Why index-based output is the load-bearing detail

The model returns `pick: 3` — an offset into a list handed to it — never an id it types.

| | consequence |
|---|---|
| **Phantom ids** | **structurally impossible.** The worst failure mode in `v2-tier2-contract.md` §7.2 stops being a check and becomes an invariant |
| **Cost** | bounded at *n×k* rows per section, not *n×m* free search |
| **Ceiling is knowable in advance** | recall@k is a no-model experiment. Already measured: 86.3% at k=8 |
| **Targets the measured defect** | ranking, and nothing else |

### 2.2 What does not change

- The identity/values boundary. The model still never sees a style value, never emits a number other
  than `confidence`, never decides severity, tolerance, issue identity or evidence.
- E3, E4, E5, E6, E7. This plan touches `src/correspond/**` and one rule in `src/elements/collapse.js`.
- The `descriptor` screen (`llm.js:34`) and the no-text rule — **unless X2 says otherwise** (§4).
- `fixtures/spike/*.json`. The sheets are the benchmark; they are not edited to suit a result.

---

## 3. Contracts

### 3.1 Shortlist record — E2a → E2c

Per design element, its ranked candidates. Section-relative boxes, as E1 already emits.

```
DESIGN f:2743:7244 | text | x=221 y=258 w=493 h=64 | has-text | tpl A#3
  [0] .footer__col:nth-child(1) h3 | text | x=582 y=48 w=366 h=58 | has-text | tpl A#3
  [1] .footer__col:nth-child(2) h3 | text | x=972 y=48 w=366 h=58 | has-text | tpl A#4
  [2] ...
```

Fields are exactly the E1 record's, minus everything the contract already forbids: **no text string,
no colour, no radius, no font size, no Tier-1 confidence**. `tpl A#3` is `templateId` reduced to a
per-section letter plus `templateIndex` — the full `tpl:<parentId>:<n>` ids are long and carry no
information the model can use.

### 3.2 Output schema — E2c

```json
{
  "assignments": [
    { "f": "2743:7244", "pick": 0,    "confidence": 0.92, "descriptor": "footer column heading" },
    { "f": "2743:7251", "pick": null, "confidence": 0.80, "reason": "not_built" }
  ]
}
```

| field | rule |
|---|---|
| `f` | must be one of the design ids asked about in this call |
| `pick` | integer in `[0, k)` **or** `null`. Any other value is a rejected assignment, not a repaired one |
| `confidence` | the only numeric field the model may originate |
| `reason` | enum `not_built \| ambiguous \| none_plausible`, required when `pick` is null |
| `descriptor` | short human name; measurement-screened as today |

`reason: not_built` is **advisory to E3, never a structural verdict**. E3 decides what "missing"
means; a model assertion cannot create one.

### 3.3 Many-to-one

The ground truth documents exactly why this is needed (`f15-w16._manyToOne`): *"the design expresses
each form field as several stacked nodes — a control frame, its inner states and its label — where
the page builds one `<input>`. Hence figma 11/12/13/15 all → web 12."* `f8-w9` records the same
shape: *"a designed container plus its label where the page builds a single element carrying both."*

**That is an E1 collapse asymmetry, not a correspondence problem.** The design side is emitting
elements the web side never can. Fixing it in E2 by permitting arbitrary many-to-one would also hand
E4 four design elements pointing at one `<input>` and produce four duplicate findings on it.

So, in order:

1. **X3 first** — make collapse symmetric and re-measure how many of the 29 survive.
2. Whatever survives is permitted **only** when the competing design elements lie on one ancestor
   chain (`parentId` walk), capped at `manyToOne.maxFanIn`.
3. **E4 must compare a fan-in group once**, against the design element nearest the web element's role
   — not once per member. Recorded here as a requirement on E4; it is the reason §5 Phase C cannot
   ship without a matching E4 change.

---

## 4. Task list by phase

### Phase A — measure before building ⛔ **GATE** — ✅ **PASSED 2026-08-14**

Everything here is free. It can invalidate the whole design before a token is spent.

- [x] `src/correspond/candidates.js` — ranking extracted out of `anchorSection` as a pure
      `shortlist(figmaEl, webEls, cfg, ctx, k) → [{ webIndex, score, features }]`, ordered and
      unfiltered. `anchors.js` re-exports `xOverlap`/`xAlignment` for its existing importers and
      keeps every FILTER; the scoring maths now exists once. **Verified behaviour-identical** —
      Tier 1 still scores 60.0% (9/15) precision and 33.5% recall after the extraction
- [x] `src/correspond/score.js` — `recall@k`, `ceilingUtilisation`, and the reachable/poisoned split
      now print on every run, with a reconciliation warning if the buckets stop summing to truth
- [x] **X1** — recall@k sweep, pooled and per-sheet
- [x] **X2** — text ablation, `src/correspond/ablate-text.js`
- [x] **X3** — collapse symmetry, `src/correspond/ablate-collapse.js`
- [x] E1 gate re-measured with the collapse rule off and on — **no regression**
- [x] 12 new unit tests (`test/candidates.test.js`, three added to `test/elements.test.js`); suite
      78 → 90, all passing

#### X1 — the gate

| k | pooled recall@k |
|---|---|
| 1 | 46.0% |
| 3 | 67.1% |
| 5 | 77.6% |
| **8** | **85.7%** ← gate |
| 12 | 88.2% |
| 20 | 91.9% |

**Ceiling utilisation @8 = 0.391.** Tier 1 converts 54 of the 138 correct answers its own ranker
already surfaces in the top 8. That single number is the bottleneck stated exactly: the shortlist
is not the problem, the choosing is.

The poison breakdown reproduces §1.1 exactly (reachable 30, figma-consumed 30, web-consumed 32,
both 15 — residue ceiling 52.2%), so the metric is now part of the standing report rather than a
one-off script.

#### X2 — text ablation: **adopt**

| textWeight | @1 | @8 | held-out @1 | held-out @8 |
|---|---|---|---|---|
| **0** *(baseline)* | 46.0% | 85.7% | 45.6% | 82.4% |
| **1.0** *(adopted)* | 60.2% | 90.7% | 59.2% | 88.8% |
| 1.5 | 63.4% | 90.7% | 62.4% | 88.8% |

Text coverage is only 34.9% of design elements and 55.7% of page elements, and just **42.2% of true
pairs have text on both sides** — so the feature moves 68 rows and cannot touch the other 93. The
gain nevertheless transfers to the four held-out sheets almost undiminished, which is what
distinguishes a real signal from a fitted one.

**The entire effect is one section.** `f17→w18`, the rearranged footer that previously scored zero,
goes **17.6% → 58.8%** @8. Every other sheet moves by ≤ 3.3 points, and **none regresses** — including
`f6→w7`, whose twelve identically-labelled cards were the predicted failure case. Identical copy
gives every instance the same bonus, so the geometric ordering survives intact.

`textWeight: 1` is committed to the tolerance profile. It is **dormant in production**: `candidates.js`
computes the feature only when a caller supplies `textOf`, and today only the ablation harness does.
Activating it means adding a normalized `textKey` to the E1 record — a deliberate contract amendment
for Phase C, now with a measurement behind it rather than an assertion against it.

#### X3 — collapse symmetry: **partial, as expected**

| | before | after |
|---|---|---|
| Unreachable under one-to-one | 29 of 161 (18.0%) | **19 of 151 (12.6%)** |
| **One-to-one ceiling** | **82.0%** | **87.4%** |
| Elements removed | — | 10 design, 4 page |

Truth sheets were remapped **through element ids**, because they key on `orderIndex` and
`f6-w7._whyRescored` already records what index drift costs: **10 rows merged, 43 moved, 0 lost.**

It fixes `f15→w16` (22 → 12) and leaves `f8→w9` at 7, correctly. That sheet's shape is a 201×60 button
container holding a 161×20 label — **padding, not a shell.** Merging those two would change what E4
compares, so the rule is deliberately scoped not to reach it, and a test pins that boundary. The
residual 19 rows are the workload for constrained many-to-one in E2d (§3.3).

`collapseCoincidentChain` ships **default off**: enabling it renumbers every element and invalidates
all six sheets until they are re-keyed, so it lands with Phase C rather than on its own.

#### Verdict

| | required | measured | |
|---|---|---|---|
| Pooled recall@8 | ≥ 85% | **85.7%** | ✅ |
| E1 gate, collapse off → on | no regression | ceiling 90.7%/87.5% → 90.5%/87.3%, anchor coverage 0.392 → **0.396** | ✅ |

**Pass, and narrowly.** 85.7% against an 85% bar is not comfortable, and the honest reading is that
the architecture survives on the geometry ranker alone. With X2's text feature the same measurement
is **90.7%**, which is the margin the design actually wants — so adopting `textKey` in Phase C is not
an optimisation, it is what moves the gate from marginal to sound.

---

### Phase B — recalibrate what already exists — ✅ **DONE 2026-08-14**

Independent of the model. Makes the current numbers honest whether or not Phase C ever ships.

- [x] Diagnosed the curve with `src/correspond/calibrate.js` — the failure is **not** general
      anti-calibration
- [x] Added a decisiveness term to the confidence (`correspond.decisiveness`), default **on**
- [x] Re-derived `confidenceGate.report`; it stays at 0.85, now on evidence rather than inheritance
- [x] Made the gate in `score.js` a **conjunction**, so a refusal can no longer present as a pass
- [x] `v2-progress-report.md` — calibration claim withdrawn in place; the stale status table, which
      still read "Not started" for phases 4–7, corrected against commit `58820c2`
- [x] `v2-tier2-contract.md` — per-section supersession table added at the head
- [x] 3 more unit tests (93 total)

#### The diagnosis was sharper than §1.2 assumed

§1.2 called the curve anti-calibrated. Binned empirically over all six sheets it is not — it is well
ordered for five of six bins and then falls off a cliff:

| bin | 0–0.30 | 0.30–0.50 | 0.50–0.60 | 0.60–0.70 | 0.70–0.85 | **0.85–1.00** |
|---|---|---|---|---|---|---|
| precision | 25.0% | 25.7% | 53.3% | 77.3% | 81.8% | **60.0%** |
| n | 8 | 35 | 15 | 22 | 11 | 15 |

**The cause is near-ties, and it is legible in the raw data.** Every wrong assertion above 0.85 beat
its runner-up by ≤ 0.464, four of the six by ≤ 0.130 — all of them stacked, near-identical form fields
in `f15→w16` where every candidate aligns perfectly. The formula reads only the chosen pair, so it
cannot distinguish a pair that won by a mile from one that edged out an equally plausible rival.

| margin | 0.052 | 0.062 | 0.129 | 0.130 | 0.193 | 0.371 | 0.464 | 0.470 | 0.748 | 0.776 | 0.886 | 1.279 | 1.491 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| correct? | no | no | no | no | yes | yes | no | yes | yes | yes | yes | yes | yes |

#### The fix, and one thing that did not work

`confidence × (marginFloor + (1 − marginFloor) · min(1, margin ÷ marginFullCredit))` at 0.5 / 0.5.
It multiplies in last, so like class compatibility it can only ever mark a pair **down**:

| bin | 0–0.30 | 0.30–0.50 | 0.50–0.60 | 0.60–0.70 | 0.70–0.85 | 0.85–1.00 |
|---|---|---|---|---|---|---|
| **after** | 27% | 56% | 57% | 75% | 89% | **100%** |
| before | 25% | 26% | 53% | 77% | 82% | 60% |

**A logistic refit was tried and rejected.** Fitting `{confidence, margin, mutual-best, was-top}` on
the two dev sheets gives 25 training rows for 5 parameters, and it scored **47.9% precision in its own
top bin** on held-out data — worse than changing nothing. Recorded because the failure is the useful
part: the dev/held-out split that is right for *evaluating* a model is far too small for *fitting*
one, and the next person to reach for a learned confidence should know that before spending the day.

`marginFloor` is **inert at the gate** — a margin at or above `marginFullCredit` saturates the
multiplier and one below it fails regardless — so it was chosen on the shape of the whole curve.

#### Exit — and the gate still fails

| | before | after |
|---|---|---|
| Precision at ≥0.85 | 60.0% (9/15) | **100% (6/6)** |
| **Recall at ≥0.85** | 5.6% (9/161) | **3.7% (6/161)** |

That precision now *looks* like a pass and **is not one.** Six assertions against 161 true matches is
the same failure the original gate committed at four. `score.js` therefore gates on a conjunction:

```
precision at confidence>=0.85: 100.0% (6/6)   required >95%   ok
recall AT that threshold:  3.7% (6/161)   required >=15%   FAIL
FAIL  — precise, but it is declining to answer
```

**No threshold on Tier 1 alone can pass this gate**, which is the finding the re-architecture exists
to act on. Phase B made the number honest; only Phase C can make it good.

---

### Phase C — the adjudicator — 🟡 **BUILT 2026-08-14; X4 PARTIAL, X6 NOT RUN (quota)**

Code complete and tested. The benchmark could not be finished: Gemini free-tier quota was exhausted
partway through X4, after transient 503s had already consumed part of the allowance.

#### What landed

- [x] **Sheets re-keyed** onto the collapse-enabled element set (`rekey-truth.js`, `remap.js`).
      Dry-run by default, refuses to write if any row would be lost. **108 kept, 43 moved, 10 merged,
      0 lost**, every row verified to resolve on both sides. Originals preserved verbatim in each
      sheet under `_truthBeforeRekey` with a row-by-row `_rekeyTrace`
- [x] `elements.collapseCoincidentChain` **enabled**
- [x] **`textKey` added to the E1 record** — normalized, 120-capped, ranker-only
- [x] `llm.js` rewritten: index-based schema, shortlist prompt, batching, transient-error retry
- [x] `verify.js` rewritten: index validation, conflict resolution, constrained fan-in
- [x] **Proximity veto retired** — config keys and `veto-experiment.js` deleted, reasoning kept
- [x] 11 new tests (`test/adjudicate.test.js`); suite 95 → **106**

#### The re-key cost a point of recall@8, and that is the honest number

| | before re-key | after |
|---|---|---|
| True matches | 161 | 151 |
| **recall@8** | 85.7% | **84.8%** |

All 10 merged rows were already inside the top 8, so the old 85.7% was inflated by duplicate truth
rows scoring the same underlying match up to three times. **84.8% is the de-duplicated figure**, and
it fails the Phase A gate on geometry alone — which is what made `textKey` load-bearing rather than
optional, exactly as Phase A predicted.

#### `textKey` lifts Tier 1 itself, not just the shortlist

| | before | after |
|---|---|---|
| **recall@8** | 84.8% ❌ | **90.1%** ✅ |
| Tier 1 recall, any confidence | 35.8% | **46.4%** |
| Residue ceiling | 53.6% | **66.9%** |
| Precision @0.85 | 100% (6/6) | 92.9% (13/14) |

Tier 1 correct went 54 → 70 without the model being involved at all, because the ranker feeds
`anchorSection`'s scoring. Precision at the gate fell from 100% to 92.9% on **more than double** the
assertions — a better operating point that reads worse, which is why the gate is a conjunction.

#### X4 — the prompt bug, and why the assertion earned its place

The first live run returned **45 of 47 answers unresolvable**. The cause was mine, not the model's:
the design row read `DESIGN 2743:6912 | text | …`, so the model answered `"DESIGN 2743:6912"` —
copying the label with the id, a fair reading of the text it was shown.

`verify.js` counted these as `phantomId` and printed **`*** HARNESS BUG, results are suspect ***`**.
Without that counter the run would have looked like a model that declines almost everything, and the
architecture would have been blamed for a formatting mistake.

**Fix: the model no longer types ids at all.** `f` became an integer index alongside `pick`, so both
halves of every answer are positions in lists the harness supplied. The prompt now carries no raw
element id, and a test asserts it.

#### X4 results — ✅ **COMPLETE 2026-08-14**, both dev sheets, all 4 batches

| pair | Tier 1 recall | adjudicated | precision @0.85 |
|---|---|---|---|
| f12-w13 | 0.625 | **0.875** | 1/1 → **9/9** |
| f14-w15 | 0.750 | **0.950** | 3/3 → 0/0 |
| **pooled** | **69.4%** (25/36) | **91.7%** (33/36) | 4/4 → **9/9** |

**Incremental recall +22.2 points**, against the >15 the Phase D gate asks for. Precision at the
reporting threshold is 9/9.

| hallucination mode | rate |
|---|---|
| Phantom id | **0** — structurally impossible, and confirmed so |
| Pick out of range | **0** |
| Class incompatible | **0** |
| Below confidence floor | **0** |
| Measurement leak | **0** |
| **Semantic false positive** | **0** — never asserted a match where truth says missing/decor/extra |
| Template mismatch | 1 (2.1%) |
| Wrong pairing | 2 |

**Shortlist-position bias — the plan's named risk — did not appear.** On the sheet measured in
detail the pick distribution was `[0]×14, [1]×3, [2]×1, [3]×1`: the model takes geometry's first
suggestion most of the time *and* overrides it roughly a quarter of the time, which is where the gain
comes from. Rubber-stamping would have reproduced Tier 1's recall, not beaten it by 22 points.

**One interaction worth noting before Phase D.** `f14-w15` reaches 0.95 recall but reports **0/0** at
the 0.85 threshold, because effective confidence is `model × sectionConfidence` and that sheet's
section match is 0.751 — so nothing clears the gate however good the pairing is. The threshold is
doing what §5 of the old contract specified, but on a lower-confidence section it suppresses every
assertion. Phase D must report recall alongside precision or it will read this as a failure.

#### Cost

~12,194 input tokens per section pair (20-element batches, both crops), extrapolating to
**~219k per 18-section audit**.

#### Provider note

Run on `gemini-flash-latest`. Three alternatives were evaluated 2026-08-14 when quota ran out:

| | vision | enforced schema | full payload | verdict |
|---|---|---|---|---|
| **Gemini** | ✅ | ✅ | ✅ | the only one meeting the contract |
| Nexus / `gemma-4-e4b-it-8bit` | ✅ | ❌ `format` ignored | ✅ cheap images (~256 tok) | usable only with a tolerant parser; latency 10–300s+ |
| Groq / `qwen3.6-27b` | ✅ | ✅ | ❌ 8,000 TPM vs 14,465 needed | structure-only arm at best |
| xAI | — | — | — | zero credits |

Nexus is the notable near-miss: it ignored both `format: <schema>` and `format: "json"`, returned
markdown-fenced text, put prose in the `reason` enum and leaked page copy into `descriptor`. That is
precisely the class of failure the index-based schema exists to make impossible, so it cannot carry a
gated run.

#### Still outstanding

| | |
|---|---|
| **X6 image ablation** | not run |
| **Phase D held-out run** | unblocked — X4 complete, prompt frozen |

---

### Phase C — original task list *(~3 days, needs Gemini quota)*

- [ ] `src/correspond/llm.js`
  - [ ] Replace `RESPONSE_SCHEMA` with §3.2. `pick` is `INTEGER`; `confidence` stays the only `NUMBER`
  - [ ] Replace `buildPrompt` with the §3.1 shortlist table. Anchored context is no longer a separate
        block — E2b's warp pairs appear as ordinary shortlist rows whose top candidate is obvious
  - [ ] Keep `MEASUREMENT_LIKE` screening and the `thinkingConfig: { thinkingBudget: 0 }` setting
  - [ ] Batch by element count, not by section, so a large section cannot truncate its own JSON —
        the measured E7 failure mode (255 issues overflowing the ceiling) applies here identically
- [ ] `src/correspond/verify.js`
  - [ ] `pick` range and `f` membership validation — replaces the phantom-id check, which becomes
        structurally unreachable and should be **retained as an assertion** that fires if the harness
        is ever wired wrongly
  - [ ] Conflict resolution: two design elements picking one web element resolve by model confidence,
        unless §3.3's shared-ancestor test permits the fan-in
  - [ ] Class floor, template-instance consistency and order consistency, as `v2-tier2-contract.md`
        §4 already specifies
  - [ ] Retire `proximityVeto` — measured to remove correct pairs and already rejected
        (contract §4.2, "unseen validation")
- [ ] `src/correspond/tier2-run.js` — drive the new path; keep the `HELD_OUT` set at line 106 exactly
      as it is
- [ ] **X4** — adjudication on the two dev sheets (`f12-w13`, `f14-w15`). **Prompt iteration happens
      here and only here**
- [ ] **X6** — image ablation on the dev sheets: shortlist with both crops, with the page crop only,
      with neither

**Exit:** dev-sheet recall and precision recorded, prompt frozen, thresholds written into
`config/tolerance-default.json` **and committed** before Phase D begins.

---

### Phase D — the honest run ⛔ **GATE** — ✅ **PASSED 2026-08-14**

Run with the prompt frozen after X4 and every threshold already committed to
`config/tolerance-default.json`. All six sheets executed; the gate is computed on the four held-out
sheets alone, because the dev pair is what the prompt was iterated against.

#### The gate

| | measured | required | |
|---|---|---|---|
| Recall, held-out | 39.1% → **63.5%** (45 → 73 of 115) | — | |
| **Incremental recall** | **+24.3 points** | > 15 | ✅ |
| **Precision @0.85** | **100.0% (45/45)** | ≥ 95% | ✅ |

**PASS.** Pooled across all six sheets: recall 46.4% → **70.2%**, precision @0.85 **46/46**.

| pair | Tier 1 | adjudicated | precision @0.85 |
|---|---|---|---|
| f12-w13 | 0.625 | 0.875 | 1/1 |
| f14-w15 | 0.750 | 0.950 | 0/0 |
| f15-w16 * | 0.500 | **0.850** | 13/13 |
| f17-w18 * | 0.294 | **0.588** | 9/9 |
| **f6-w7** * | 0.179 | **0.107** ⚠️ | 0/0 |
| f8-w9 * | 0.500 | **0.867** | 23/23 |

`f17→w18` — the rearranged footer that scored **zero** in the original Phase 2 benchmark — now reaches
0.588 with 9/9 reportable pairs.

| hallucination mode | count of 208 answers |
|---|---|
| **Phantom id** | **0** |
| **Pick out of range** | **0** |
| Class incompatible | 0 |
| Below confidence floor | 0 |
| Measurement leak | 0 |
| Template mismatch | 4 (1.9%) |
| Semantic false positive | 2 |
| Wrong pairing | 11 |

#### 🔴 f6→w7 regressed, and the cause is upstream of E2

Recall fell 0.179 → 0.107. The model answered **`not_built` 28 times out of 34, at mean confidence
0.85**, on a section where the ground truth records exactly **one** genuine missing element (the
thirteenth card, `f6-w7._pattern`).

**It was not hallucinating. It was reading the picture it was given.** The web crop for this section
shows a heading, a paragraph, a button and **one** avatar card. The element list describes **twelve**
cards. So the model was asked to match twelve things it could not see, and said so.

This is the defect already on record in `v2-progress-report.md` Phase 6 — *"the pinned fix broke
'pixels and measurements agree' — for pinned sections"*. The pinned pass re-measures scroll-driven
sections **after** their animation settles, taking f6→w7's 24 card elements from 2 distinct positions
to 24; the full-page capture still shows the section at scroll-rest. Measurements and pixels describe
different moments. There it cost 2 of 20 landing-view issues. Here it costs an entire section's
correspondence.

**The safety boundary held, and this is the run that proves it.** Twenty-eight confident `not_built`
assertions produced **zero** structural claims, because `reason` is advisory to E3 and never a
verdict (§3.2). Had E3 trusted the model, this run would have manufactured 28 "designed but not
built" findings about a section that builds every one of them — the exact catastrophic false-positive
mode the architecture was designed to prevent, arriving on the first held-out run and being contained
by construction.

**Consequence:** the E6 pinned-capture fix is now a prerequisite for E2 quality, not an evidence
nicety. Until pixels and measurements agree for pinned sections, the adjudicator is being lied to
about them. Excluding f6→w7, held-out recall is 46.0% → **80.5%** across 87 true matches.

---

### Phase D re-run — after the pinned-capture fix ✅ **2026-08-17**

The fix was **one shared function, not new capture code.** `capturePinnedSections` already existed and
its output was already on disk; E6 evidence had been selecting it since the pinned fix landed. E2
correspondence had its own copy of the section→image rule that only ever cropped the scroll-top
full-page image. `pinnedForSection` now lives in `capture.js` and both stages call it.

#### The gate, re-measured

| | before fix | **after fix** | required |
|---|---|---|---|
| Held-out recall | 63.5% | **67.8%** (45 → 78 of 115) | — |
| **Incremental recall** | +24.3 | **+28.7 points** | > 15 ✅ |
| **Precision @0.85** | 100% (45/45) | **100% (37/37)** | ≥ 95% ✅ |
| Pooled recall | 70.2% | **73.5%** | — |
| Semantic false positives | 2 | **1** | — |
| Wrong pairings | 11 | **7** | — |

**PASS**, and cleaner on every axis that matters.

#### f6→w7: no longer a regression

| | before fix | after fix |
|---|---|---|
| `not_built` answers | **28 of 34** | **7** |
| `matched` answers | 5 | **24** |
| Recall | 0.107 (below Tier 1's 0.179) | **0.25** |

The model can now see the twelve cards it is being asked about. What remains is a genuinely hard
case rather than a broken input.

#### What still limits it — and a hypothesis that was wrong

Of the 24 matches the model proposed, **15 were rejected on template-instance mismatch**, in what
looked like a systematic permutation: `instance 2→0`, `3→2`, `4→1`. That pattern suggested our own
bug — that `templateIndex` is assigned by reading order independently per side, and a fanned stack
interleaves columns where a design grid does not, so instance-for-instance would be comparing two
unrelated orderings.

**Tested, and false.** All 15 rejected pairs are wrong against ground truth, and `templateIndex`
ordering is identical on both sides (`0,0,1,1,2,2,3,3`). The constraint is not destroying correct
answers; it is catching every bad one. f6→w7 finishes with **7 correct, 1 wrong** and 0/0 at the
reporting threshold — nothing false escaped.

So the residual limitation is the one the original brief asked about under "repeated components":
**twelve near-identical avatar cards, fanned, are beyond what the model can individually
disambiguate from the image.** It knows they are cards and picks a card; it cannot reliably tell
*which*. The template check converts that from 15 false findings into 15 declines, which is the
correct trade and the reason precision stays at 100%.

Improving it is a candidate-generation problem, not a prompt problem: `templateIndex` is already
carried in the prompt, and the fix would be to constrain the shortlist to the matching instance
before the model ever sees it. That is a Phase 8 item, not a gate blocker.

#### Cost

Unchanged at ~16,893 input tokens per section pair; 15 calls, 0 failures, 208s.

Two smaller regressions worth tracking, both contained: **template mismatches rose 4 → 18** (15 of
them f6→w7's, i.e. the check doing its job on a section it previously never got to see), and
**4 measurement leaks** appeared in descriptors, dropped by the existing screen.

#### Cost

~16,893 input tokens per section pair, extrapolating to **~304k per 18-section audit**. Higher than
X4's estimate because the held-out sections are larger (62 and 41 elements against 20–22).
15 calls, 0 failures, 253s wall clock.

- [ ] **X5** — the four held-out sheets (`f15-w16`, `f17-w18`, `f6-w7`, `f8-w9`), nothing tuned
- [ ] Record all four hallucination modes from contract §7.2 separately. Phantom rate must be 0; a
      non-zero value means the harness is broken, not that the model misbehaved
- [ ] Record cost: tokens and USD per section pair, and extrapolated to an 18-section audit
- [ ] Write the results into this document **whether or not they are good**

**Exit / GATE:** stated as a pair, because a single number hid the failure last time —
**precision ≥ 95% at the refitted gate, AND incremental recall over Tier 1 > 15 points on held-out
sheets.** Precision alone passes trivially by declining everything, which is exactly how the previous
gate read 100% on four assertions against 54 real matches.

---

### Integration — from benchmark to product ✅ **2026-08-17**

Phases A–D measured the architecture. They did not ship it: `anchorSection` was called inside
E3 and the adjudicator existed only in `tier2-run.js`, so **every report the tool had ever
produced used Tier 1 alone** while the benchmark reported 67.8%. Measuring a thing and
shipping it are different, and only one had happened.

#### Three changes

**E4 fan-in (`2fcda62`).** Enabling `manyToOne` in Phase C without the matching E4 change was
a bug I shipped: `compareElementPairs` iterated the aligned list flat, so a page element
claimed by several design elements collected the same verdict repeatedly. The Phase D run
accepted **17 fan-in groups**, each of which would have doubled its findings — and E5 would
have read the duplicates as a systemic pattern. Both members are still compared, because they
carry different properties (the frame has fill and border, the label has typography); members
are ordered by correspondence quality and the first to claim a (page element, property) keeps
it.

**E2 as a stage (`4422d95`).** Correspondence is established once, E3 consumes it, E4 reuses
what E3 aligned. E3 no longer computes its own and **throws** rather than falling back,
because a silent Tier 1 fallback there is precisely how this went unnoticed. The stage is
degradable by design — a missing key, exhausted quota or failed batch drops to Tier 1 **and
says so**, since a 46% report and a 68% report are different claims and must not look alike.
Cached on the element sets, so a tolerance edit costs nothing and an extraction change costs
exactly what it should.

**`replay.js`.** Runs E2–E7 from a completed run's artifacts. Extraction is the expensive,
quota-bound, non-deterministic half — M2 spends Figma requests from roughly six a month, M1
re-measures a page that has moved on — and none of it is needed to iterate on comparison or
reporting. Holding measurements fixed also makes it the controlled comparison.

#### Measured end to end, against the 2026-08-13 report

| | before (Tier 1) | after | |
|---|---|---|---|
| Aligned pairs | 308 | **318** | +10 |
| **Element findings** | 739 | **644** | **−95 (−13%)** |
| **Systemic groups** | 155 | **127** | **−28 (−18%)** |
| Issues | 249 | 253 | +4 |
| **Findings per aligned pair** | 2.40 | **2.03** | **−15%** |

**More correspondence produced fewer findings.** That is the claim the whole re-architecture
rested on, and it is the first time it has been tested on the report rather than on a
benchmark. Had the extra pairs been noise, findings would have risen; density fell 15%
instead, which says the old Tier-1 pairs were manufacturing differences by matching elements
that were not counterparts.

Structural claims rose 6 → 11, and that was the number worth checking, because a broader
correspondence turning into more absence assertions would be the dangerous direction. It is
not: three of the four increases are in sections where correspondence *improved* (f2→w3 went
11 → 20 aligned pairs). E3 asserts absence only where correspondence is healthy, so better
matching unlocks claims it was previously right to suppress.

**Caveat, and it is not small: this run is 11 of 18 sections adjudicated.** Quota ran out
mid-run and 7 sections fell back to Tier 1, so the improvement above comes from roughly 60%
of the page. E7's prose synthesis failed for the same reason; the report shipped on
deterministic wording, which is the designed behaviour and worth noting as the second time
that fallback has proven itself.

#### One more invisible-report bug (`c028a0a`)

`get` cold-loaded a run by id but `list` read only memory, so after a restart the gallery was
empty while every report sat on disk reachable only by guessing its id. The module header had
promised restart safety; half of it was true.

---

### Phase E — generalization ⛔ **GATE** *(blocked on the user)*

- [ ] Second Figma file + live page (already on the blocked list in `v2-progress-report.md`)
- [ ] Re-run X1 and X5 against it, thresholds frozen

**Exit:** only after this does "Phase 2 gate passed" mean anything. Six sections of one page is one
sample, not six.

---

## 5. Config additions

New keys in `config/tolerance-default.json` under `correspond`, each with its `_key` prose sibling
per house convention:

```jsonc
"shortlist": { "k": 8, "minScore": 0.0 },
"adjudicator": {
  "enabled": true,
  "maxElementsPerCall": 40,
  "confidenceFloor": 0.6
},
"manyToOne": {
  "enabled": true,
  "requireSharedAncestor": true,
  "maxFanIn": 4
}
```

`k = 8` is chosen from X1's measured 86.3%, not from taste. `orderBands` (currently 3, explicitly
untuned) should be **re-derived against ground truth in Phase B**, since the note on it says coverage
always rises with band count and only truth distinguishes a recovered match from a wrong one.

---

## 6. What this plan deliberately does not do

### 6.1 It does not assume the no-text rule is wrong — it measures it

The rule exists so design copy can never leak into a finding, and that reasoning is sound for
**values**. It is not obviously sound for **identity**, where text is the strongest signal available.
X2 settles it with no model calls. If text buys recall, the containment argument is unchanged: it
enters the ranker, the model still never emits a value, and `descriptor` is still screened.

If X2 shows no gain — plausible, since design copy is often placeholder — the rule stands on evidence
rather than on assertion, which is worth the half day either way.

### 6.2 It does not replace E2 with the model

Geometry at recall@8 = 86.3% is the cheapest and most explainable filter in the system. Replacing it
means paying tokens to re-derive it and reopening the phantom-id surface.

### 6.3 It does not tune on the held-out sheets

Two dev, four held out, thresholds committed before Phase D. `tier2-run.js:106` already encodes this;
the set must not be rebalanced to improve a number.

### 6.4 It does not treat the six sheets as six samples

They are six sections of one page (quokkalabs.com). Phase E is a gate, not a follow-up.

### 6.5 It does not fix score instability (N7)

Still deferred to Phase 8, unchanged by this work.

---

## 7. Risks

| Risk | Handling |
|---|---|
| **Shortlist-position bias** — model always picks `[0]` | Measure pick-index distribution in X4. A distribution matching Tier 1's top-1 rate (36%) means the model added nothing |
| **X1 fails at 85%** | Architecture is wrong. Stop at Phase A; the fix is ranking features, not a model |
| **Gemini quota** | The 2026-08-12 run died on a 429 with three sheets unscored. Phase C/D need headroom; batching per §4 reduces call count but not token volume |
| **Template-instance off-by-one** | Instance *i* → instance *i* constraint in E2d, tested on `f6-w7` (twelve cards, one designed thirteenth) |
| **E4 fan-in duplication** | §3.3 makes the E4 change a precondition for shipping many-to-one, not a follow-up |
| **Recall rises, precision falls** | The Phase D gate is a conjunction for exactly this reason |

---

## 8. Decisions — settled

1. ~~**Run X2 (text ablation)?**~~ **Yes, run 2026-08-14. Adopt.** +14.2 points recall@1 and +5.0
   recall@8 pooled, transferring to held-out sheets. The no-text rule stands for values and is
   amended for identity in Phase C.
2. ~~**Phase A before anything else?**~~ **Yes, done.** One day, no model calls, gate passed.
3. ~~**X3 scope.**~~ **Scoped to the coincident-shell shape only.** The second documented shape
   (button + inset label) is padding rather than nesting; collapsing it would change what E4
   compares, so it is left to constrained many-to-one and pinned by a test.

### Open for Phase B

4. **`textKey` in the E1 record.** X2 justifies it, but it is a change to the contract in
   `v2-tier2-contract.md` §2 and to the `Element` shape in `v2-hld.md` §5.1. Recommended: add it as a
   normalized, 120-character-capped field, ranker-only, with the existing `hasText` boolean retained
   so nothing downstream has to change.
5. **When to enable `collapseCoincidentChain`.** It invalidates all six sheets by renumbering.
   Recommended: enable it and re-key the sheets in one deliberate step at the start of Phase C, since
   Phase C's shortlist work needs a stable element set anyway.
