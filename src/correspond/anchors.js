/**
 * E2 Tier 1 - deterministic anchors. No model, no cost, no variance.
 *
 * The axes are NOT symmetric, and treating them as if they were is the single
 * biggest way this stage goes wrong:
 *
 *   x, width   both sides render at the same frame width, so x is directly
 *              comparable. Width is NOT - elements size to their content, and a
 *              hard +/-10% width filter was measured to cost more than half of
 *              all achievable anchors (19% coverage against 43%). Width scores;
 *              it never rejects.
 *
 *   y          worthless absolutely. Section heights differ by up to 4.93x, so
 *              the same element can sit at y=200 in the design and y=900 on the
 *              page. Y is used for ORDER, and for a LOCAL expectation derived
 *              from the warp below.
 *
 * The warp is what makes y usable. Anchor the unambiguous elements first, then
 * interpolate between those anchors to predict where an unanchored design
 * element should appear on the page. It is the technique S2 already applies at
 * section level, applied within a section - and it is why this runs in two
 * passes rather than one.
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
 * This is what ranks candidates, because `xOverlap` cannot tell alignment from
 * containment and that difference decides real cases. Measured on the
 * testimonials section: a 54px design avatar at x=244 scored a perfect 1.000
 * against a 350px decorative blob spanning x=46..396, and 0.384 against the
 * 56px avatar that is actually its counterpart. The matcher took the blob.
 * Under this measure the same pair reads 0.153 against the blob and 0.231
 * against the avatar, and the ranking comes out right.
 *
 * Kept separate rather than replacing `xOverlap` so the candidate FILTER stays
 * generous - narrowing it would cost recall that Tier 2 could otherwise
 * recover, and a candidate never seen is a candidate the model never gets to
 * judge.
 */
export function xAlignment(a, b) {
  const lo = Math.max(a.box.x, b.box.x);
  const hi = Math.min(a.box.x + a.box.w, b.box.x + b.box.w);
  const inter = Math.max(0, hi - lo);
  const union = Math.max(a.box.x + a.box.w, b.box.x + b.box.w) - Math.min(a.box.x, b.box.x);
  return inter / Math.max(1, union);
}

/** 0 when widths match, approaching 1 as they diverge. A score, never a gate. */
function widthPenalty(a, b, band) {
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
 *
 * So `glyph` is the promiscuous class, and text-to-control is the other
 * plausible pair (a label built as a <button>). Everything else stays
 * expensive without being fatal.
 */
function classCompatibility(a, b, table) {
  if (a.cls === b.cls) return 1;
  const key = [a.cls, b.cls].sort().join('~');
  return table[key] ?? table.default;
}

/** Longest increasing subsequence - drops pairings that cross in reading order. */
function longestMonotonic(pairs) {
  if (!pairs.length) return [];
  const sorted = [...pairs].sort((p, q) => p.fi - q.fi || p.wi - q.wi);
  const tails = [], back = new Array(sorted.length).fill(-1), idx = [];

  for (let i = 0; i < sorted.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[idx[mid]].wi < sorted[i].wi) lo = mid + 1; else hi = mid;
    }
    if (lo > 0) back[i] = idx[lo - 1];
    idx[lo] = i;
    if (lo === tails.length) tails.push(i); else tails[lo] = i;
  }

  const out = [];
  let k = idx[tails.length - 1];
  while (k !== undefined && k !== -1) { out.push(sorted[k]); k = back[k]; }
  return out.reverse();
}

/**
 * Piecewise-linear map from design y to page y, built from anchors already
 * trusted. Outside the anchor range it falls back to proportional scaling -
 * the honest answer when there is nothing to interpolate between.
 */
export function buildYWarp(anchorPairs, figma, web, figmaHeight, webHeight) {
  const knots = anchorPairs
    .map((p) => ({ f: figma[p.fi].box.y, w: web[p.wi].box.y }))
    .sort((a, b) => a.f - b.f);

  // Collapse duplicate design positions so the map stays a function.
  const dedup = [];
  for (const k of knots) {
    if (dedup.length && Math.abs(dedup.at(-1).f - k.f) < 0.5) continue;
    if (dedup.length && k.w < dedup.at(-1).w) continue;   // never invert
    dedup.push(k);
  }

  const scale = webHeight / Math.max(1, figmaHeight);

  return function warp(y) {
    if (!dedup.length) return y * scale;
    if (y <= dedup[0].f) return dedup[0].w + (y - dedup[0].f) * scale;
    const last = dedup.at(-1);
    if (y >= last.f) return last.w + (y - last.f) * scale;

    for (let i = 1; i < dedup.length; i++) {
      const a = dedup[i - 1], b = dedup[i];
      if (y > b.f) continue;
      const span = b.f - a.f;
      const t = span < 0.5 ? 0 : (y - a.f) / span;
      return a.w + t * (b.w - a.w);
    }
    return last.w;
  };
}

function candidatesFor(figma, web, cfg, { strict, warp, sectionHeight, rearranged }) {
  const out = [];
  // When the two layouts have been rearranged relative to each other, x says
  // nothing and must not eliminate anything. See anchorSection.
  const xFloor = strict ? cfg.xOverlapStrict : (rearranged ? cfg.rearranged.xOverlapFloor : cfg.xOverlapFloor);
  const yWindow = rearranged ? cfg.rearranged.yResidualWindow : cfg.yResidualWindow;
  const yRelWindow = rearranged ? cfg.rearranged.yRelWindow : cfg.yRelWindow;

  for (let i = 0; i < figma.length; i++) {
    for (let j = 0; j < web.length; j++) {
      const a = figma[i], b = web[j];

      // Class SCORES, it no longer filters - except for seeds, which define the
      // warp and must be beyond argument. `classIsFilter` restores the old
      // behaviour so before/after can be measured rather than remembered.
      const classCompat = classCompatibility(a, b, cfg.classCompatibility);
      if ((strict || cfg.classIsFilter) && classCompat < 1) continue;

      // Generous filter, discriminating score - see xAlignment.
      const ov = xOverlap(a, b);
      if (ov < xFloor) continue;
      const align = xAlignment(a, b);

      const wp = widthPenalty(a, b, cfg.widthRatioScoreBand);
      if (strict && wp >= 1) continue;   // seeds must agree on width; later passes need not

      // Y agreement. Pass 1 has no warp and falls back to relative position;
      // pass 2 measures against the interpolated expectation instead.
      let yScore;
      if (warp) {
        const expected = warp(a.box.y);
        const residual = Math.abs(b.box.y - expected) / Math.max(1, sectionHeight);
        if (residual > yWindow) continue;
        yScore = 1 - residual / yWindow;
      } else {
        const dy = Math.abs(a.yRel - b.yRel);
        if (dy > (strict ? cfg.yRelStrict : yRelWindow)) continue;
        yScore = 1 - dy / yRelWindow;
      }

      // A same-class pair scores exactly as it did before this became a score,
      // so nothing that already worked is perturbed; only cross-class pairs,
      // which previously could not exist at all, are penalised.
      out.push({
        fi: i, wi: j,
        score: align + yScore - cfg.widthWeight * wp - cfg.classWeight * (1 - classCompat),
        xOverlap: ov, xAlignment: align, widthPenalty: wp, yScore, classCompat,
      });
    }
  }
  return out;
}

/**
 * Reading order is enforced WITHIN a column band, not across the whole section.
 *
 * A section is a 2-D layout and `orderIndex` flattens it to 1-D by (y, then x).
 * In a two-column block the design may serialise L1,R1,L2,R2 where the page
 * gives L1,L2,R1,R2 — identical layouts, mutually crossing sequences. A global
 * LIS reads that as inconsistency and discards half of it.
 *
 * Measured across the reference page: greedy one-to-one reaches 66.2% of the
 * smaller side, a global LIS cuts it to 45.2%, and banding recovers most of the
 * difference. Elements in different columns simply have no required y-ordering
 * relative to each other.
 */
function bandedMonotonic(chosen, figma, bands) {
  if (bands <= 1) return longestMonotonic(chosen);

  const buckets = new Map();
  for (const c of chosen) {
    const el = figma[c.fi];
    const centre = el.box.x + el.box.w / 2;
    const key = Math.floor((centre / Math.max(1, FRAME_WIDTH)) * bands);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(c);
  }
  return [...buckets.values()].flatMap((list) => longestMonotonic(list));
}

/** Both sides render at the frame width by construction (parent doc §3.1). */
const FRAME_WIDTH = 1920;

/** Greedy one-to-one by score, then enforce order within column bands. */
function resolve(candidates, figma, cfg, taken = { figma: new Set(), web: new Set() }) {
  const chosen = [];
  for (const c of [...candidates].sort((p, q) => q.score - p.score)) {
    if (taken.figma.has(c.fi) || taken.web.has(c.wi)) continue;
    taken.figma.add(c.fi); taken.web.add(c.wi);
    chosen.push(c);
  }
  return bandedMonotonic(chosen, figma, cfg.orderBands);
}

/**
 * Anchor one section pair.
 *
 * @returns pairs, plus the leftovers Tier 2 will be asked about.
 */
export function anchorSection(figmaSet, webSet, cfg) {
  const figma = figmaSet.elements, web = webSet.elements;
  const figmaHeight = figmaSet.origin.h, webHeight = webSet.origin.h;

  // Pass 1 - seeds. Strict on every axis, because these define the warp and a
  // wrong seed bends every later decision around it.
  const seeds = resolve(candidatesFor(figma, web, cfg, { strict: true }), figma, cfg);

  /**
   * Has the layout been REARRANGED between design and build?
   *
   * Detected from the matcher's own failure rather than from any property of a
   * particular page: the strict pass demands x-overlap, width agreement and
   * class identity, so when a section is built the way it was designed it
   * yields seeds readily. Almost none means the two sides do not share an
   * arrangement, and x - the signal Tier 1 trusts most - is then meaningless.
   *
   * Measured cause on the reference page: the footer is designed stacked
   * (heading above three cards) and built side by side, at the same 1920px
   * viewport. Eight of seventeen true pairs were eliminated by the x filter and
   * seven more by the y window before ranking ever ran.
   *
   * This deliberately uses no page-specific signal. It cannot be, and must not
   * become, "is this the footer".
   */
  const seedDensity = seeds.length / Math.max(1, Math.min(figma.length, web.length));
  const rearranged = cfg.rearranged.enabled !== false && seedDensity < cfg.rearranged.seedDensityFloor;

  // Pass 2 - everything else, judged against the warp the seeds imply.
  const warp = buildYWarp(seeds, figma, web, figmaHeight, webHeight);
  const taken = { figma: new Set(seeds.map((s) => s.fi)), web: new Set(seeds.map((s) => s.wi)) };
  const rest = candidatesFor(figma, web, cfg, { strict: false, warp, sectionHeight: webHeight, rearranged });

  // Seeds are already consistent; re-running the order check over the union
  // keeps the whole set consistent rather than letting pass 2 add a crossing.
  const merged = bandedMonotonic([...seeds, ...resolve(rest, figma, cfg, taken)], figma, cfg.orderBands);

  const pairs = merged.map((m) => ({
    figmaId: figma[m.fi].sourceRef.figmaNodeId ?? figma[m.fi].id,
    webId: web[m.wi].sourceRef.webSelector ?? web[m.wi].id,
    figmaIndex: m.fi,
    webIndex: m.wi,
    tier: 'anchor',
    classCompat: m.classCompat,
    // Confidence keys on ALIGNMENT, not containment: a pair whose only claim is
    // that one box swallows the other must not present as certain.
    //
    // Class compatibility MULTIPLIES rather than adds. A same-class pair scores
    // exactly what it scored before class became a signal - so the gate's
    // existing behaviour is untouched - while a cross-class pair can only ever
    // be marked down. Adding it as a term would have inflated every same-class
    // confidence and risked pushing wrong pairs above the report threshold.
    confidence: +Math.max(0, Math.min(1,
      (0.5 * m.xAlignment + 0.3 * m.yScore + 0.2 * (1 - m.widthPenalty)) * m.classCompat
    )).toFixed(3),
    seed: seeds.includes(m),
  }));

  const matchedF = new Set(pairs.map((p) => p.figmaIndex));
  const matchedW = new Set(pairs.map((p) => p.webIndex));

  return {
    pairs,
    unresolvedFigma: figma.filter((_, i) => !matchedF.has(i)).map((e) => e.id),
    unresolvedWeb: web.filter((_, i) => !matchedW.has(i)).map((e) => e.id),
    stats: {
      figma: figma.length,
      web: web.length,
      seeds: seeds.length,
      anchored: pairs.length,
      coverage: +(pairs.length / Math.max(1, Math.min(figma.length, web.length))).toFixed(3),
      seedDensity: +seedDensity.toFixed(3),
      rearranged,
      crossClass: pairs.filter((p) => p.classCompat < 1).length,
    },
  };
}
