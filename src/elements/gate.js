/**
 * The Phase 1 gate - MEASUREMENT ONLY.
 *
 * This is not the Phase 2 matcher and must not become it. Its whole job is to
 * answer one question cheaply, before three months are spent on correspondence:
 *
 *     Can these two element sets be put into correspondence at all?
 *
 * Two numbers answer it:
 *
 *   CEILING - the fraction of elements having ANY class-compatible,
 *     x-overlapping counterpart inside their section. This bounds what ANY
 *     matcher could achieve, however clever. If the ceiling is low, the trees
 *     are genuinely incomparable and E2 cannot work.
 *
 *   ANCHOR - what the deterministic Tier-1 rule actually resolves today. The
 *     gap between anchor and ceiling is matcher quality, and is Tier 2's
 *     workload.
 *
 * Measured on the reference run: ceiling 89% figma / 87% web against an anchor
 * of 19%. That combination is the finding - the data is comparable and the
 * original Tier-1 rule was simply too strict.
 *
 * The node-count RATIO is also reported, because the plan originally made it
 * the gate. It is retained as context and not as a verdict: a section whose
 * design shows 11 footer links against the page's 52 real ones has a ratio near
 * 2.9 and is perfectly comparable. Content volume is E3's problem, not
 * evidence of incomparability.
 */

/** Shared horizontal extent, as a fraction of the narrower element. */
export function xOverlap(a, b) {
  const lo = Math.max(a.box.x, b.box.x);
  const hi = Math.min(a.box.x + a.box.w, b.box.x + b.box.w);
  return Math.max(0, hi - lo) / Math.max(1, Math.min(a.box.w, b.box.w));
}

/** Longest increasing subsequence - removes pairings that cross in reading order. */
function longestMonotonic(pairs) {
  if (!pairs.length) return [];
  const sorted = [...pairs].sort((p, q) => p.fi - q.fi);
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

/** How many elements even HAVE a plausible counterpart. Bounds every matcher. */
function ceiling(from, to, cfg) {
  let hit = 0;
  for (const a of from) {
    const found = to.some((b) => (!cfg.requireClassMatch || a.cls === b.cls) && xOverlap(a, b) >= cfg.xOverlapFloor);
    if (found) hit++;
  }
  return { hit, total: from.length, fraction: from.length ? +(hit / from.length).toFixed(3) : 0 };
}

/**
 * Tier-1 style anchoring, width SCORED rather than filtered.
 *
 * The original spec made width a hard +/-10% filter on the grounds that width
 * "matches by construction". That holds for sections (18/18 at 1920px) and
 * fails for elements, which size to their content. Measured: the filter alone
 * costs more than half of all achievable anchors.
 */
function anchor(figma, web, cfg) {
  const candidates = [];
  for (let i = 0; i < figma.length; i++) {
    for (let j = 0; j < web.length; j++) {
      const a = figma[i], b = web[j];
      if (cfg.requireClassMatch && a.cls !== b.cls) continue;
      const ov = xOverlap(a, b);
      if (ov < cfg.xOverlapFloor) continue;
      if (Math.abs(a.yRel - b.yRel) > cfg.yRelWindow) continue;

      const widthRatio = a.box.w / Math.max(1, b.box.w);
      const widthPenalty = Math.min(1, Math.abs(Math.log(widthRatio)) / cfg.widthRatioScoreBand);
      candidates.push({ fi: i, wi: j, score: ov - Math.abs(a.yRel - b.yRel) - 0.25 * widthPenalty });
    }
  }

  candidates.sort((p, q) => q.score - p.score);
  const usedF = new Set(), usedW = new Set(), chosen = [];
  for (const c of candidates) {
    if (usedF.has(c.fi) || usedW.has(c.wi)) continue;
    usedF.add(c.fi); usedW.add(c.wi);
    chosen.push(c);
  }

  const monotonic = longestMonotonic(chosen);
  const smaller = Math.max(1, Math.min(figma.length, web.length));
  return {
    candidates: candidates.length,
    anchored: monotonic.length,
    coverage: +(monotonic.length / smaller).toFixed(3),
  };
}

/** Run the gate over every matched pair's element sets. */
export function measureGate(pairs, cfg) {
  const rows = [];
  let totalFigma = 0, totalWeb = 0, totalAnchored = 0;
  let ceilF = { hit: 0, total: 0 }, ceilW = { hit: 0, total: 0 };

  for (const pair of pairs) {
    const F = pair.figma.elements, W = pair.web.elements;
    const cf = ceiling(F, W, cfg.ceiling);
    const cw = ceiling(W, F, cfg.ceiling);
    const an = anchor(F, W, cfg.anchor);

    ceilF.hit += cf.hit; ceilF.total += cf.total;
    ceilW.hit += cw.hit; ceilW.total += cw.total;
    totalFigma += F.length; totalWeb += W.length; totalAnchored += an.anchored;

    rows.push({
      figmaIndex: pair.figmaIndex,
      webIndex: pair.webIndex,
      sectionConfidence: pair.confidence,
      irNodes: { figma: pair.figma.stats.irNodes, web: pair.web.stats.irNodes },
      elements: { figma: F.length, web: W.length },
      ratioBefore: +(pair.web.stats.irNodes / Math.max(1, pair.figma.stats.irNodes)).toFixed(2),
      ratioAfter: +(W.length / Math.max(1, F.length)).toFixed(2),
      ceilingFigma: cf.fraction,
      ceilingWeb: cw.fraction,
      ...an,
    });
  }

  const band = cfg.ratioBand;
  const inBand = rows.filter((r) => r.ratioAfter >= 1 - band && r.ratioAfter <= 1 + band).length;
  const inCountBand = rows.filter(
    (r) => [r.elements.figma, r.elements.web].every((n) => n >= cfg.targetCountMin && n <= cfg.targetCountMax)
  ).length;

  return {
    rows,
    summary: {
      pairs: rows.length,
      totalElements: { figma: totalFigma, web: totalWeb },
      ceiling: {
        figma: +(ceilF.hit / Math.max(1, ceilF.total)).toFixed(3),
        web: +(ceilW.hit / Math.max(1, ceilW.total)).toFixed(3),
      },
      anchorCoverage: +(totalAnchored / Math.max(1, Math.min(totalFigma, totalWeb))).toFixed(3),
      anchored: totalAnchored,
      tier2Workload: { figma: totalFigma - totalAnchored, web: totalWeb - totalAnchored },
      ratioInBand: `${inBand}/${rows.length}`,
      countInTargetBand: `${inCountBand}/${rows.length}`,
    },
  };
}
