# E2 Tier 2 — the correspondence contract

> ## ⚠️ PARTIALLY SUPERSEDED — 2026-08-14
>
> `docs/v2-e2-rearchitecture.md` replaces the tier structure this document specifies. Read that
> first; this file remains the record of what was contracted and measured, and three of its parts
> are still load-bearing.
>
> | Section | Status |
> |---|---|
> | **§1** What Tier 2 is for | **Superseded.** Tier 2 was specified as a *residue* pass over what Tier 1 left. Measured, that shape is capped at **52.2% recall** — Tier 1 consumes both elements of a wrong pair, so 47.8% of true matches never reach the residue at all. Tier 1 is being demoted to a candidate generator |
> | **§2** Input contract | **Amended.** The compact element record stands. The **no-text rule is amended for identity only**: X2 measured +14.2 points recall@1 and +5.0 recall@8 from a ranker-side text feature, transferring to held-out sheets. Text still never reaches a proposal, a value or a finding |
> | **§3** Output contract | **Superseded.** Free-typed `figmaId`/`webId` is replaced by an **index into a supplied shortlist**, which makes the phantom-id failure mode structurally impossible rather than merely checked |
> | **§4** Verification | **Survives, and is reused in E2d.** Every check here still runs. The phantom-id check becomes an assertion that should never fire |
> | **§4.1** Repeated-group ordering | Survives — still specified, still not implemented |
> | **§4.2** Proximity veto | **Rejected**, on this document's own unseen validation. Retired in Phase C |
> | **§5** Confidence and gating | **Amended.** The 0.85 threshold was re-derived, not inherited. Tier 1 confidence gained a decisiveness term because the old curve collapsed in its top bin |
> | **§6** Combination with Tier 1 | **Superseded** by the shortlist architecture |
> | **§7** Measurement plan | **Survives and is extended** — recall@k, ceiling utilisation and the reachable/poisoned split are now standing metrics in `score.js` |

**Status:** specification, written before the first model call. Companion to `v2-architecture.md` §6
and `v2-hld.md` §5.2.

Everything here is fixed *before* seeing results, so that what follows is a measurement rather than a
negotiation. Where a number comes from earlier work it is cited; nothing is invented to be
convenient.

---

## 1. What Tier 2 is for, and what it is not for

Tier 1 resolves **31.5%** of true matches (measured, three hand-scored sections), of which only the
top slice is confident enough to report. The candidate ceiling is **78%** — the right answers are in
the candidate set and geometry cannot rank them. Tier 2 exists to close exactly that gap.

> **The boundary is unchanged and non-negotiable: the model decides IDENTITY, code decides VALUES.**

Tier 2 answers one question — *"are these two elements the same thing?"* — for elements Tier 1 could
not resolve. It never produces a measurement, never sees a text string, and never overrides Tier 1.

---

## 2. Input contract

One call per matched section pair. Sent:

| Part | Content | Why |
|---|---|---|
| **Design render** | PNG crop of the Figma frame for this section | the design's arrangement is only legible visually |
| **Page render** | PNG crop of the stabilized full-page capture | same, and pixels agree with measurements (`onStabilized`, extract.js step 14) |
| **Unresolved elements** | both sides, compact E1 records | the actual question |
| **Anchored neighbours** | Tier 1 pairs in this section, marked `anchored` | context: "these two are already known to correspond" |

Both renders are produced at the same frame width, so the two images are directly comparable.

Each element is sent as its E1 record and nothing more:

```
{ id, cls, box: {x, y, w, h},   // section-relative
  hasText,                      // BOOLEAN - the string never leaves E1
  childCount, orderIndex,
  templateId, templateIndex }   // repeated-group membership, when known
```

**Hard input rules**

1. **No text content, ever.** Design copy and live copy legitimately differ; `hasText` is a boolean.
   Enforced structurally — E1 never emits the string (`test/elements.test.js`).
2. **No measured style values.** No colours, radii, font sizes. The model is deciding identity, and a
   value it never sees is a value it cannot echo back as a finding.
3. **No Tier 1 confidence scores.** Anchored pairs are shown as context, not as a prior to defer to.

---

## 3. Output contract

Schema-constrained. **No numeric field other than `confidence`.**

```json
[{ "figmaId": "2743:6912",
   "webId":   "body>footer>section>div>div>div:nth-of-type(1)>h4",
   "decision": "match" | "missing_in_web" | "extra_in_web",
   "confidence": 0.0,
   "descriptor": "primary CTA button" }]
```

**Measured provider behaviour** (probe, 2026-08-11 — `v2-progress-report.md`):

| | |
|---|---|
| Extra measurement **fields** | never appeared, under adversarial prompting |
| `maxLength` on a string | **not enforced** (60 requested, 99 returned) |
| `descriptor` under pressure | **leaked geometry every time** — `"figma(x=100, y=40, w=200, h=24) … #835CF5"` |

So the schema is necessary and **not sufficient**, and `descriptor` is treated as untrusted cosmetic
text:

- truncated client-side to 60 characters;
- **dropped entirely** if it matches a measurement pattern (digits with units, hex colours, coordinate
  syntax). The pairing survives; only the label is discarded.

A descriptor never reaches a finding. It is a label in a report.

---

## 4. Verification — Tier 3, code, always

Every proposal is checked against measured IR **before it is allowed to exist**. The model proposes;
the engine disposes.

| Check | Rejects |
|---|---|
| id resolution | either id not an element in this section pair |
| double assignment | either side already claimed by Tier 1 or an accepted Tier 2 pair |
| Tier 1 conflict | contradicts an anchored pair |
| class compatibility | `classCompatibility` below `default` (0.35) — a text run cannot be an image |
| order inversion | breaks monotonic order beyond `orderBands` tolerance |
| descriptor screen | measurement-shaped text (drops the label, keeps the pair) |

Rejections are **logged, never reported**, and their rate is a headline metric (§7).

### 4.1 Proposed: repeated-group ordering — SPECIFIED, MEASURED INERT, NOT IMPLEMENTED

**The rule.** For a proposed pair `(f, w)` where `f.templateId` and `w.templateId` are both set,
consider every already-accepted pair `(f', w')` with `f'.templateId === f.templateId` and
`w'.templateId === w.templateId`. Reject the proposal when the ordering disagrees:

```
sign(f.templateIndex - f'.templateIndex)  !==  sign(w.templateIndex - w'.templateIndex)
```

Instances of one template must correspond in order — design row 2 cannot map to page row 3 while
design row 1 maps to page row 3. Template ids are per-side and are never compared across sides; only
the *ordering* is. With no established pair between the two groups the proposal sets the precedent
and is accepted, because there is nothing yet to contradict.

**Expected rejections on the current benchmark: ZERO of 23 proposals.** Measured before implementing,
which is the point of writing this down first.

The rule needs template labels on **both** sides. On the reference accordion (f12→w13) only the design
has them:

| | templateId coverage |
|---|---|
| figma elements | 11 of 25 — the glyph column, the label column, the body column |
| **web elements** | **8 of 36 — and none of them are involved in any proposal or anchor** |

`detectRepeatedGroups` buckets **siblings under one parent**. The design's accordion rows are direct
children of the section root, so they group. The page's equivalent spans each sit under their own
`<button>` (`parentId` w2394, w2417, w2438, w2459), two per parent, so no group of three ever forms.
The page's *card containers* do group — but their descendants, which is what the proposals actually
pair, inherit nothing.

**Two changes would be needed, and neither is what was asked for:**

1. **E1 must propagate template membership to descendants of grouped instances.** The card containers
   already form a group; their subtrees should inherit `(groupId + position within instance,
   instance index)`. This is a labelling change in `signature.js`, not a threshold, weight, prompt or
   confidence change — but it does alter E1 output.
2. **Even with labels, the three accordion errors survive this rule.** They are *internally
   consistent*: figma indices 1, 2, 3 map to page instances 0, 1, 2 — a uniform offset of −1, not a
   crossing. Ordering alone cannot see a uniform shift. Only an anchor pinning the offset to 0 would
   expose it, and the anchor covering that group (`f9 → w10`) is **itself wrong**.

**What the errors actually share** is proximity, not ordering. In all three the correct counterpart
sits closer in warped y than the one chosen:

| proposal | chosen `dyRel` | truth `dyRel` |
|---|---|---|
| figma 14 → web 21 (truth 25) | 0.077 | **0.027** |
| figma 18 → web 25 (truth 29) | 0.131 | **0.027** |
| figma 22 → web 29 (truth 33) | 0.185 | **0.081** |

A verification rule of the form *"reject when an unclaimed, same-class, better-aligned alternative
exists"* would catch all three. That is a different rule from the one specified here and is recorded
as a proposal, not adopted.

### 4.2 Proximity veto — EXPERIMENT, behind `proximityVeto.enabled` (default off)

**A plausibility check, not a matcher.** It can only ever *remove* a claim. It never substitutes an
alternative, never re-pairs, and never proposes — because the moment geometry picks the counterpart,
geometry is deciding identity, and that is the boundary the whole architecture rests on. The model
still decides who matches whom; this decides whether a particular claim is credible enough to keep.

**Definitions.** For design element `f` and page element `w`, both section-relative:

```
yGap(f, w)   = |f.yRel − w.yRel|                     vertical distance, fraction of section height
xAlign(f, w) = 1-D IoU of the x extents              alignment, not containment (see anchors.js)
compat(f, w) = classCompatibility table lookup       1.0 identical, lower for cross-class
```

**Alternatives.** For a proposal `(f, w)`, the alternative set is

```
A(f, w) = { w' ∈ webElements :  w' ≠ w
                              ∧ w' not claimed by a TIER 1 ANCHOR
                              ∧ compat(f, w') ≥ compat(f, w) }
```

Only Tier 1 anchors count as claims. Tier 2's own proposals are all under evaluation at once, so
treating them as claims would make the result depend on evaluation order and let a wrong proposal
shield another. Anchors are settled and independent.

**Veto condition.** `(f, w)` is vetoed iff

```
∃ w' ∈ A(f, w) :   yGap(f, w') + marginY  ≤  yGap(f, w)      strictly closer, by a margin
                 ∧ xAlign(f, w')          ≥  xAlign(f, w)     and no worse horizontally
```

**Multiple alternatives:** the existence of *any* qualifying `w'` is sufficient. The count is
recorded but does not change the outcome — one strictly better free candidate already makes the
model's choice implausible.

**`marginY = 0.03`** — 3% of section height. Chosen to sit clearly below the observed error margins
(0.050, 0.104, 0.104) and clearly above measurement noise. It is a parameter of the experiment, not a
tuned threshold, and no other threshold, weight, prompt or confidence rule is touched.

**Expected effect, stated before running:** the three accordion proposals are vetoed — each has a
free, same-class, vertically-nearer alternative that is its own ground truth. `figma 12 → web 13` in
f14→w15 is **not** vetoed and should not be: there the chosen pair aligns *better* than the truth
(`xAlign 0.581` against `0.000`), so no geometric rule can reach it. The open question the run must
answer is how many **correct** pairs are also vetoed.

**Adoption bar.** Even a clean result here is not adoption. The rule was derived from these three
sections, so it must be validated against additional ground truth before it becomes default-on.

#### Measured — A/B on identical cached proposals (`veto-experiment.js`, no model or Figma calls)

| | veto OFF | veto ON |
|---|---|---|
| **Tier 2 precision** | **69.2%** (9/13) | **90.0%** (9/10) |
| Tier 2 pairs accepted | 15 | 10 |
| **Overall recall** | **62.3%** (33/53) | **62.3%** (33/53) — *unchanged* |
| Precision @0.85 | 4/4 | 4/4 — *unchanged* |
| Proposals vetoed | — | 5 of 23 |
| **Correct pairs removed** | — | **0** |

**+21 points of Tier 2 precision at zero recall cost.** Every pair removed was one the model got
wrong or one that is unscoreable; not a single correct pairing was lost.

The prediction written before the run held exactly: the three accordion proposals were vetoed, and
`figma 12 → web 13` was not — there the wrong answer aligns better than the truth, so no geometric
rule reaches it, and the rule correctly declined to try.

**The held-out section did not validate the rule.** f17→w18 produced 2 vetoes, but both landed on rows
whose ground truth is `?` — excluded from scoring — so they are neither confirmed good nor bad. Its
recall is identical either way. **All demonstrated benefit comes from f12→w13, a section the rule was
derived from.** That is precisely the circularity the held-out pair existed to detect, and it did not
clear it.

**Status: experiment, default off.** Adoption requires the additional ground-truth sections, where the
question is specifically whether the veto removes any *correct* pair on data it has never seen.

#### Unseen validation — f6→w7 added. **The veto removes correct pairs. REJECTED.**

| | veto OFF | veto ON |
|---|---|---|
| Tier 2 precision | 71.4% (10/14) | 90.0% (9/10) |
| **Overall recall** | **44.4%** (36/81) | **43.2%** (35/81) — *down* |
| Precision @0.85 | 4/4 | 4/4 |
| Proposals vetoed | — | 6 of 25 |

Vetoes by verdict: **3 known-wrong** (all in f12→w13, the derivation section) · **2 unscoreable `?`**
(f17→w18) · **1 CORRECT pair destroyed** (f6→w7, `figma 11 → web 2`).

**On unseen sections the rule produced zero confirmed benefit and one confirmed harm.** Every good
veto still comes from the section the rule was built on. The apparent precision gain is arithmetic:
it deleted three wrong pairs from one section and one right pair from another.

**Root cause, and it is structural rather than a tuning error.** The veto compares **raw `yRel`** —
and Tier 1 abandoned raw y comparability on purpose, because section heights differ by up to 4.93×;
`anchors.js` interpolates a piecewise-linear **warp** for exactly this reason. The veto reintroduces
the assumption the matcher discarded:

```
figma 11  yRel 0.213     web 2 (TRUTH)  yRel 0.073   yGap 0.140   xAlign 0.551
                         web 30         yRel 0.193   yGap 0.020   xAlign 0.844
```

`web 30` looks nearer and better aligned on both axes — but it is the correct counterpart of
`figma 26`, claimed by another Tier 2 proposal. Under the rule only Tier 1 anchors count as claims,
so it reads as free and vetoes a correct pair.

That exposes a second, unresolvable tension in the design. Counting Tier 2's own claims makes the
outcome order-dependent and lets wrong proposals shield each other — which would have cost all three
good vetoes. Ignoring them lets one correct proposal veto another. Neither setting is right.

**Verdict: reject this formulation.** A variant scoring against the *warped* y expectation rather
than raw `yRel` might behave, but that is a different rule needing its own pre-registered prediction
and its own unseen validation. It is not a reason to carry this one forward.

Note the class rule is *asymmetric on purpose*: class is a hard filter for Tier 1 (measured: relaxing
it costs 17 points of precision) but only a floor here, because arbitrating a design glyph built as a
`<button>` is exactly the semantic judgement the model is for.

---

## 5. Confidence and gating

```
effectiveConfidence = modelConfidence × sectionMatchConfidence
```

Section confidence multiplies in because a claim inherited from a weak section match cannot be
stronger than the match it rests on. The three reference pairs sit at 0.867, 0.751 and 0.869.

| Effective confidence | Action |
|---|---|
| **≥ 0.85** | compare and report normally |
| 0.60 – 0.85 | compare; findings tagged `low-confidence`, non-gating in CI |
| < 0.60 | **not compared.** Counted as "N elements could not be matched" |

The 0.85 threshold is inherited from Tier 1, where it has never yet admitted a wrong pair
(4/4 across three sections and four configurations). It is *not* re-tuned for Tier 2 — the point is to
learn whether the model behaves at a threshold that geometry already respects.

> Note the multiplication is strict: at a section confidence of 0.751, a model claim needs
> **1.13** to reach the report gate — i.e. it cannot. Tier 2 pairs in that section can be compared but
> never gate. This is intended, and its effect is reported in §7 rather than worked around.

---

## 6. Combination with Tier 1

```
Tier 1 anchors            LOCKED. Never revisited, never overridden.
      │
      ├─ unresolved elements ──► Tier 2 ──► Tier 3 verification ──► accepted pairs
      │                                              │
      │                                              └─► rejected (logged)
      ▼
final correspondence = Tier 1 anchors ∪ verified Tier 2 pairs
                       (disjoint by construction - double assignment is a rejection)
```

Tier 1 wins every conflict. Its precision is measured and its confidence has never lied; Tier 2's has
not been measured at all, which is what this exercise is for.

Each final pair carries `tier: 'anchor' | 'llm'` so every downstream finding can be traced to how its
correspondence was established — and so CI can gate on `anchor` only, per HLD §7.1.

---

## 7. Measurement plan

Scored against the same three hand-established sheets in `fixtures/spike/`, by `score.js`, with
**f17→w18 held out** — the prompt and schema are fixed before any pair is run, and no threshold in
this document may be changed after seeing results. If something must change, it is recorded as a
*second experiment*, not folded into the first.

### 7.1 Quality

| Metric | Definition |
|---|---|
| **Precision @0.85** | correct ÷ asserted, effective confidence ≥ 0.85. **The gate: > 95%** |
| Precision, all | correct ÷ asserted at any confidence |
| **Recall** | correct ÷ true matches in the sheet |
| Incremental recall | true matches Tier 2 adds that Tier 1 missed — *the number that justifies Tier 2 existing* |
| Ceiling utilisation | Tier 2 correct ÷ (candidate ceiling − Tier 1 correct) |

### 7.2 Hallucination — four distinct failure modes, counted separately

| Mode | Definition | Severity |
|---|---|---|
| **Phantom id** | `figmaId`/`webId` that does not exist in the section | fatal — the model invented an element |
| **Double assignment** | claims an element already paired | serious |
| **Semantic false positive** | asserts `match` where truth says `missing`, `decor` or `extra` | **the dangerous one** — produces a *false finding* |
| **Measurement leak** | descriptor matches a measurement pattern | contained by design; rate still recorded |

Reported as rates over proposals, not absolute counts, so they compare across sections.

### 7.3 Cost

| Metric | |
|---|---|
| Input tokens per section pair | including both images |
| Output tokens per section pair | |
| USD per section pair, and per 18-section audit | first run |
| Steady-state cost | with the correspondence cache warm (expected: zero calls) |
| Wall time per call | |

The Phase 1 finding stands and is the reason cost is a headline metric: Tier 2's workload is **~68%
of true matches**, not the small remainder the architecture assumed.

---

## 8. Quota

The design render costs **one Figma Tier-1 request** — confirmed from Figma's published rate-limit
documentation (zero quota spent to establish it): `/v1/images/:file_key` is Tier 1, and a View/Collab
seat gets roughly **6 per month**.

Mitigations, all mandatory:

- **one whole-frame render**, cropped locally per section — never one call per section
  *(18 section calls would spend three months of budget in a single run)*;
- **the PIXELS are cached, not the URL.** Figma serves renders from S3 behind a presigned link that
  expires — the file thumbnail carries `X-Amz-Expires=604800`, seven days. An earlier version of
  `getImage` cached the URL and called it indefinite; that entry would have died silently and the
  only recovery is another Tier-1 call. Bytes land at
  `.cache/figma/<fileKey>/<version>/image-<nodeId>@<scale>.png`, written before anything else;
- renders are immutable per file version, so a cache hit is always valid and costs no network call;
- if the export is rejected for size (1920×19,752 is untested), fall back to `scale=0.5` and scale the
  crop maths — **the fallback must not cost a second request**, so the size question is settled by the
  response to the one call we make.

Rate-limit headers are only returned on a 429, so remaining quota cannot be read proactively. There is
no safe way to probe; there is only spending deliberately.
