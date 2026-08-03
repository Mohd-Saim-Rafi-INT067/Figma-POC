/**
 * S2 - Section matching. V1 plan phase D. Replaces M8 (node matching).
 *
 * This is the module that made the original design a 3-4 week, 60%-of-total-risk
 * proposition. At section level it becomes a 1-D ordered sequence alignment over
 * ~18x19 candidates instead of a tree alignment over 1615x1314 nodes.
 *
 * Two properties do the heavy lifting:
 *
 *   1. Sections do not reorder. Header above hero above footer, on both sides.
 *      That makes Needleman-Wunsch exact and correct here, where a general tree
 *      matcher would need heuristics.
 *   2. Insertions and deletions are first-class. A designed-but-unbuilt section,
 *      or a page section with no design, becomes a GAP - it does not shift and
 *      corrupt everything after it.
 *
 * Text is used here and ONLY here. No finding downstream may carry text content.
 */

/** Overlap as a fraction of the union. */
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const v of a) if (b.has(v)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Word-level overlap, as a softer companion to exact-string Jaccard.
 *
 * Design copy and live copy drift constantly - "Hire forward-deployed engineers
 * for AI-native teams" becomes "Hire for AI-native execution". Exact-string
 * matching scores that 0; word overlap still sees the relationship. Using both
 * means a section survives a copy edit without losing its anchor.
 */
function wordOverlap(aStrings, bStrings) {
  const words = (arr) => {
    const s = new Set();
    for (const t of arr) for (const w of t.split(/\s+/)) if (w.length > 3) s.add(w);
    return s;
  };
  const wa = words(aStrings);
  const wb = words(bStrings);
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  // Overlap coefficient, not Jaccard: one side legitimately carries more copy.
  return shared / Math.min(wa.size, wb.size);
}

const ratioSimilarity = (a, b) => {
  if (!a || !b) return 0;
  return Math.min(a, b) / Math.max(a, b);
};

/** Aggregate similarity of the non-text digest fields. */
function digestSimilarity(da, db) {
  const set = (arr) => new Set(arr.map(String));
  const parts = [
    jaccard(set(da.colorSet), set(db.colorSet)),
    jaccard(set(da.fontSizeSet), set(db.fontSizeSet)),
    jaccard(set(da.fontWeightSet), set(db.fontWeightSet)),
    ratioSimilarity(da.nodeCount, db.nodeCount),
  ];
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

/** Rank-distance tolerance before positional cost saturates. */
const POSITION_SCALE = 0.25;

/**
 * Positional cost from RANK, not from pixel offset.
 *
 * Pixel-normalized position accumulates error: on the real page two sections are
 * 3.7x and 4.9x their design height, which pushes everything below them far down
 * in normalized terms. Correct pairs late in the document then scored position
 * costs of 0.8-0.9 while their height and text costs were near zero - the exact
 * cascade parent doc 7.4 describes ("a 4px error near the top of the page shifts
 * every element below it").
 *
 * Rank is immune to that: section 10 of 18 and section 11 of 19 are at the same
 * relative depth no matter how tall the intervening sections are.
 */
function rankCost(fs, ws, figmaCount, webCount) {
  const fr = figmaCount > 1 ? fs.index / (figmaCount - 1) : 0;
  const wr = webCount > 1 ? ws.index / (webCount - 1) : 0;
  return Math.min(1, Math.abs(fr - wr) / POSITION_SCALE);
}

/**
 * Pairwise cost in [0,1]. Lower is a better match.
 *
 * HEIGHT USES ABSOLUTE PIXELS, not normalized. Both sides render at the same
 * viewport width (enforced by config, parent doc 3.1), so pixel heights are
 * directly comparable. Measured on the real page: median absolute ratio 1.06
 * versus median normalized 0.87 - normalizing folds the 21% total-height
 * difference into every section and makes almost everything look wrong.
 */
export function pairCost(fs, ws, weights, counts) {
  const positionCost = rankCost(fs, ws, counts.figma, counts.web);
  const heightCost = 1 - ratioSimilarity(fs.height, ws.height);

  const exact = jaccard(new Set(fs.digest.textAnchors), new Set(ws.digest.textAnchors));
  const soft = wordOverlap(fs.digest.textAnchors, ws.digest.textAnchors);
  // Take the stronger signal - exact matches are better evidence when present,
  // but their absence must not be read as evidence of a mismatch.
  const textCost = 1 - Math.max(exact, soft);

  const dCost = 1 - digestSimilarity(fs.digest, ws.digest);

  const cost =
    weights.position * positionCost +
    weights.height * heightCost +
    weights.textAnchors * textCost +
    weights.digest * dCost;

  return {
    cost,
    parts: {
      position: +positionCost.toFixed(3),
      height: +heightCost.toFixed(3),
      text: +textCost.toFixed(3),
      digest: +dCost.toFixed(3),
      textExact: +exact.toFixed(3),
      textSoft: +soft.toFixed(3),
    },
  };
}

/**
 * Order-preserving alignment via Needleman-Wunsch.
 *
 * Known V1 limitation: this produces a strict 1:1 alignment with gaps, so a
 * design section split into two page sections (the confirmed header case here)
 * surfaces as "extra section in web" rather than "section 1 is split in two".
 * Coarser than ideal, but honest. Merge detection is V1.5.
 */
export function alignSections(figmaSections, webSections, cfg) {
  const { weights, gapPenalty, confidenceFloor } = cfg;
  const n = figmaSections.length;
  const m = webSections.length;

  // Precompute the cost matrix - tiny at this scale (~18x19).
  const costs = Array.from({ length: n }, (_, i) =>
    Array.from({ length: m }, (_, j) => pairCost(figmaSections[i], webSections[j], weights, { figma: n, web: m }))
  );

  // D[i][j] = best total cost aligning first i figma sections with first j web ones.
  const D = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  const from = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(null));

  for (let i = 1; i <= n; i++) { D[i][0] = i * gapPenalty; from[i][0] = 'up'; }
  for (let j = 1; j <= m; j++) { D[0][j] = j * gapPenalty; from[0][j] = 'left'; }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = D[i - 1][j - 1] + costs[i - 1][j - 1].cost;
      const up = D[i - 1][j] + gapPenalty;      // figma section unmatched
      const left = D[i][j - 1] + gapPenalty;    // web section unmatched
      const best = Math.min(diag, up, left);
      D[i][j] = best;
      from[i][j] = best === diag ? 'diag' : best === up ? 'up' : 'left';
    }
  }

  // Traceback.
  const pairs = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const dir = i === 0 ? 'left' : j === 0 ? 'up' : from[i][j];
    if (dir === 'diag') {
      const c = costs[i - 1][j - 1];
      pairs.push({
        figma: figmaSections[i - 1],
        web: webSections[j - 1],
        cost: +c.cost.toFixed(3),
        confidence: +(1 - c.cost).toFixed(3),
        parts: c.parts,
      });
      i--; j--;
    } else if (dir === 'up') {
      pairs.push({ figma: figmaSections[i - 1], web: null, cost: gapPenalty, confidence: 0 });
      i--;
    } else {
      pairs.push({ figma: null, web: webSections[j - 1], cost: gapPenalty, confidence: 0 });
      j--;
    }
  }
  pairs.reverse();

  // Demote weak pairs rather than reporting a confident wrong answer. Parent doc
  // 8.6: a 45% and a 97% cannot be treated identically.
  const result = [];
  for (const p of pairs) {
    if (p.figma && p.web && p.confidence < confidenceFloor) {
      result.push({ figma: p.figma, web: null, cost: p.cost, confidence: p.confidence, demoted: true });
      result.push({ figma: null, web: p.web, cost: p.cost, confidence: p.confidence, demoted: true });
    } else {
      result.push(p);
    }
  }

  const matched = result.filter((p) => p.figma && p.web);
  const missingInWeb = result.filter((p) => p.figma && !p.web);
  const extraInWeb = result.filter((p) => !p.figma && p.web);

  return {
    pairs: result,
    stats: {
      figmaSections: n,
      webSections: m,
      matched: matched.length,
      missingInWeb: missingInWeb.length,
      extraInWeb: extraInWeb.length,
      demoted: result.filter((p) => p.demoted).length / 2,
      meanConfidence: matched.length
        ? +(matched.reduce((a, p) => a + p.confidence, 0) / matched.length).toFixed(3)
        : 0,
      totalCost: +D[n][m].toFixed(3),
    },
  };
}
