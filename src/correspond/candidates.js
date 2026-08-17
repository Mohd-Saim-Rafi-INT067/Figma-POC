/**
 * E2a - candidate generation. The RANKING half of correspondence.
 *
 * Extracted from anchors.js so that one set of scoring maths serves both
 * consumers and they cannot drift apart:
 *
 *   Tier 1 (anchors.js)   applies filters on top of these features and CLAIMS
 *                         the survivors one-to-one.
 *   E2a    (this module)  claims nothing. It ranks every web element against a
 *                         design element and hands back the ordered list.
 *
 * The distinction is the whole point of the V2 re-architecture. Measured on the
 * six hand-scored sections (docs/v2-e2-rearchitecture.md §1.4), geometry places
 * the true partner first only 36.0% of the time but inside the top 8 in 86.3%.
 * Geometry is a good ranker and a bad decider, so the ranking is kept and the
 * deciding is what moves.
 *
 * NOTHING HERE ELIMINATES. A filter belongs to the caller, because a candidate
 * this module never emits is a candidate no later stage can recover.
 */

/**
 * Shared horizontal extent as a fraction of the NARROWER element.
 *
 * Deliberately generous, and used only to decide whether a pair is worth
 * considering at all: any element horizontally contained by another scores 1.0.
 */
export function xOverlap(a, b) {
  const lo = Math.max(a.box.x, b.box.x);
  const hi = Math.min(a.box.x + a.box.w, b.box.x + b.box.w);
  return Math.max(0, hi - lo) / Math.max(1, Math.min(a.box.w, b.box.w));
}

/**
 * Shared horizontal extent as a fraction of the COMBINED extent - a 1-D IoU.
 *
 * This is what RANKS candidates, because `xOverlap` cannot tell alignment from
 * containment and that difference decides real cases. Measured on the
 * testimonials section: a 54px design avatar at x=244 scored a perfect 1.000
 * against a 350px decorative blob spanning x=46..396, and 0.384 against the
 * 56px avatar that is actually its counterpart. The matcher took the blob.
 * Under this measure the same pair reads 0.153 against the blob and 0.231
 * against the avatar, and the ranking comes out right.
 */
export function xAlignment(a, b) {
  const lo = Math.max(a.box.x, b.box.x);
  const hi = Math.min(a.box.x + a.box.w, b.box.x + b.box.w);
  const inter = Math.max(0, hi - lo);
  const union = Math.max(a.box.x + a.box.w, b.box.x + b.box.w) - Math.min(a.box.x, b.box.x);
  return inter / Math.max(1, union);
}

/** 0 when widths match, approaching 1 as they diverge. A score, never a gate. */
export function widthPenalty(a, b, band) {
  const ratio = a.box.w / Math.max(1, b.box.w);
  return Math.min(1, Math.abs(Math.log(ratio)) / band);
}

/**
 * How plausible is it that these two classes are the same element? 1.0 = same.
 *
 * Class was a hard filter until it was measured against ground truth, where it
 * rejected 6 of 16 true pairs in one section on its own. EVERY disagreement
 * observed was `glyph -> something`: a design draws an icon as vector art and
 * the page builds it as a text character (the accordion +/- indicator), as a
 * button, or as an image. The design side simply has no way to express which.
 */
export function classCompatibility(a, b, table) {
  if (a.cls === b.cls) return 1;
  const key = [a.cls, b.cls].sort().join('~');
  return table[key] ?? table.default;
}

/**
 * Dice coefficient over word bigrams, with an exact-match shortcut.
 *
 * X2 ONLY - see docs/v2-e2-rearchitecture.md §6.1. Text is not part of the E1
 * element record and this feature is inert unless the caller supplies a
 * `textOf` accessor, which only the experiment harness does. Bigrams rather
 * than tokens because design copy is routinely a truncated or reworded version
 * of the live string ("Get started" vs "Get started free"), and token Jaccard
 * scores those pairs the same as unrelated ones.
 */
export function textSimilarity(a, b) {
  if (!a || !b) return null;
  if (a === b) return 1;

  const grams = (s) => {
    const t = s.split(/\s+/).filter(Boolean);
    if (t.length < 2) return new Set(t);
    const out = new Set();
    for (let i = 0; i < t.length - 1; i++) out.add(`${t[i]} ${t[i + 1]}`);
    return out;
  };

  const ga = grams(a), gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let hits = 0;
  for (const g of ga) if (gb.has(g)) hits++;
  return (2 * hits) / (ga.size + gb.size);
}

/**
 * Every signal this pair produces, with no judgement applied.
 *
 * `yScore` has two derivations and the caller chooses by supplying a warp:
 *
 *   with a warp   the anchors already trusted predict where this design element
 *                 should land on the page; the residual from that prediction is
 *                 what scores. Needs `sectionHeight`.
 *   without one   fall back to relative position within the section, which is
 *                 the honest answer when there is nothing to interpolate between.
 *
 * Y is never used absolutely. Section heights differ by up to 4.93x, so the same
 * element sits at y=200 in the design and y=900 on the page.
 */
/**
 * Where the ranker reads text from.
 *
 * Defaults to the E1 record's own `textKey` (added in Phase C), so callers get
 * the measured behaviour without opting in. A caller may still pass its own
 * `textOf` - the ablation harness does, to compare against a run whose records
 * predate the field - and passing `textOf: null` disables the feature outright,
 * which is what makes the weight-0 baseline a real baseline.
 */
const defaultTextOf = (el) => el.textKey ?? null;

export function candidateFeatures(f, w, cfg, ctx = {}) {
  const { warp, sectionHeight } = ctx;
  const textOf = 'textOf' in ctx ? ctx.textOf : defaultTextOf;
  // The score's denominators are overridable because Tier 1 widens them when it
  // detects a rearranged layout, and the SCORE must use the same window the
  // caller filtered on or the two disagree about what "just inside" means.
  const yWindow = ctx.yWindow ?? cfg.yResidualWindow;
  const yRelWindow = ctx.yRelWindow ?? cfg.yRelWindow;

  let yScore, yResidual = null, yRelGap = null;
  if (warp) {
    const expected = warp(f.box.y);
    yResidual = Math.abs(w.box.y - expected) / Math.max(1, sectionHeight);
    yScore = Math.max(0, 1 - yResidual / yWindow);
  } else {
    yRelGap = Math.abs(f.yRel - w.yRel);
    yScore = Math.max(0, 1 - yRelGap / yRelWindow);
  }

  return {
    xOverlap: xOverlap(f, w),
    xAlignment: xAlignment(f, w),
    widthPenalty: widthPenalty(f, w, cfg.widthRatioScoreBand),
    classCompat: classCompatibility(f, w, cfg.classCompatibility),
    yScore,
    yResidual,
    yRelGap,
    textSim: textOf ? textSimilarity(textOf(f), textOf(w)) : null,
  };
}

/**
 * Collapse features to one number.
 *
 * The same-class, no-text form is byte-identical to the expression anchors.js
 * used before this module existed, so Tier 1's behaviour is unchanged by the
 * extraction and any movement in the benchmark is attributable to a real change
 * rather than to the refactor.
 *
 * `textWeight` defaults to 0, which makes the text term vanish rather than
 * merely shrink - X2 must be able to prove the feature is inert when disabled.
 */
export function scoreFeatures(x, cfg) {
  const base =
    x.xAlignment +
    x.yScore -
    cfg.widthWeight * x.widthPenalty -
    cfg.classWeight * (1 - x.classCompat);

  const textWeight = cfg.textWeight ?? 0;
  if (!textWeight || x.textSim === null) return base;
  return base + textWeight * x.textSim;
}

/**
 * Rank every web element against one design element. Unfiltered and unclaimed.
 *
 * @param figmaEl  one design element (E1 record)
 * @param webEls   every web element in the same section
 * @param cfg      the `correspond` tolerance block
 * @param ctx      { warp, sectionHeight, textOf } - all optional
 * @param k        keep only the top k; omit for the full ranking
 * @returns [{ webIndex, score, features }] descending by score
 */
export function shortlist(figmaEl, webEls, cfg, ctx = {}, k = Infinity) {
  const ranked = webEls.map((w, webIndex) => {
    const features = candidateFeatures(figmaEl, w, cfg, ctx);
    return { webIndex, score: scoreFeatures(features, cfg), features };
  });

  // Ties broken by web index so the ordering is stable across runs - a shortlist
  // whose contents depend on array order would make recall@k unreproducible.
  ranked.sort((p, q) => q.score - p.score || p.webIndex - q.webIndex);
  return Number.isFinite(k) ? ranked.slice(0, k) : ranked;
}

/**
 * How DECISIVELY did the winner win?
 *
 * The confidence formula in anchors.js is a function of the chosen pair alone,
 * so it cannot tell a candidate that won by a mile from one that edged out an
 * equally plausible rival by 0.01. Measured, that omission is why confidence is
 * anti-calibrated above 0.6 (docs/v2-e2-rearchitecture.md §1.2): a design
 * element horizontally contained by a large page element scores highly on
 * alignment whether or not it is the right one, and being contained by TWO such
 * elements does not lower the score at all.
 *
 * `margin` is the raw gap to the runner-up; `ratio` normalises it against the
 * winner so the two are comparable across sections whose scores sit at
 * different absolute levels.
 *
 * @returns {{top, second, margin, ratio, topWebIndex}} - `second` is null when
 *          the element has only one candidate, which is itself a strong signal.
 */
export function marginStats(figmaEl, webEls, cfg, ctx = {}) {
  const ranked = shortlist(figmaEl, webEls, cfg, ctx);
  if (!ranked.length) return { top: null, second: null, margin: null, ratio: null, topWebIndex: null };

  const top = ranked[0].score;
  const second = ranked.length > 1 ? ranked[1].score : null;
  const margin = second === null ? null : top - second;

  return {
    top,
    second,
    margin,
    // Guarded: scores can be negative once penalties bite, and a ratio against a
    // negative or near-zero winner is noise rather than a signal.
    ratio: margin === null || Math.abs(top) < 1e-6 ? null : margin / Math.abs(top),
    topWebIndex: ranked[0].webIndex,
  };
}

/**
 * Do the two sides pick each other?
 *
 * A design element's best candidate naming it back is a far stronger claim than
 * either side's preference alone, and it costs one extra ranking pass. This is
 * the signal E2b should anchor the y-warp on, rather than the strict pass -
 * whose seeds measured only 67.9% precise (§1.3).
 */
export function isMutualBest(figmaIndex, webIndex, figmaEls, webEls, cfg, ctx = {}) {
  const forward = shortlist(figmaEls[figmaIndex], webEls, cfg, ctx, 1);
  if (!forward.length || forward[0].webIndex !== webIndex) return false;

  // The reverse direction ranks design elements for one page element. Feature
  // computation is asymmetric in y only when a warp is supplied, and a warp maps
  // design y -> page y, so the reverse pass deliberately runs without one.
  const back = figmaEls
    .map((f, i) => ({ i, score: scoreFeatures(candidateFeatures(f, webEls[webIndex], cfg, {}), cfg) }))
    .sort((p, q) => q.score - p.score || p.i - q.i);

  return back.length > 0 && back[0].i === figmaIndex;
}

/**
 * Shortlists for a whole section pair, keyed by design element index.
 *
 * @returns Map<figmaIndex, [{ webIndex, score, features }]>
 */
export function shortlistSection(figmaSet, webSet, cfg, ctx = {}, k = 8) {
  const out = new Map();
  for (const [figmaIndex, f] of figmaSet.elements.entries()) {
    out.set(figmaIndex, shortlist(f, webSet.elements, cfg, ctx, k));
  }
  return out;
}
