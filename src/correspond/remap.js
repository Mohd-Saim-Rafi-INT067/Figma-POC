/**
 * Re-key a ground-truth sheet from one element set to another.
 *
 * The sheets in `fixtures/spike/` are keyed by `orderIndex`, which is a position
 * in a list, not an identity. Any change to the collapse rules renumbers every
 * element, and scoring a new element set against an old sheet then silently
 * compares unrelated elements. The repo has already paid for this once:
 *
 *   f6-w7._whyRescored - "Element COUNTS were unchanged at 34/36, but reading
 *   order changed completely, so every web index in the previous file pointed at
 *   a different element. Counts are not sufficient to validate index stability -
 *   element identity must be checked."
 *
 * So remapping goes through element IDS, which are IR node ids and survive any
 * collapse rule, and anything that cannot be remapped is REPORTED rather than
 * dropped. A sheet is hand-scored evidence; losing a row silently is the one
 * outcome worse than not remapping at all.
 */

/** IR parent/child indexes, for resolving an id that no longer survives. */
export function irIndex(snapshot) {
  const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const parentOf = new Map();
  for (const n of snapshot.nodes) for (const c of n.children) parentOf.set(c, n.id);
  return { byId, parentOf };
}

/**
 * Where did this element go?
 *
 * Descendants are searched first because the collapse rules keep the INNERMOST
 * of a coincident chain; ancestors are tried second so the function stays
 * correct if a future rule keeps the outermost instead. Returns null when the
 * element has no representative at all, which is a reportable loss.
 */
export function resolveSurvivor(oldId, surviving, { byId, parentOf }) {
  if (surviving.has(oldId)) return oldId;

  const queue = [...(byId.get(oldId)?.children ?? [])];
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    if (surviving.has(id)) return id;
    queue.push(...(byId.get(id)?.children ?? []));
  }

  let up = parentOf.get(oldId);
  while (up) {
    if (surviving.has(up)) return up;
    up = parentOf.get(up);
  }
  return null;
}

/**
 * Remap one sheet's `truth` object from `basePair` indices to `newPair` indices.
 *
 * @returns {{ truth, stats, trace }} - `trace` records every row's before/after
 *          so a re-keyed sheet carries its own provenance rather than asking the
 *          reader to trust the transform.
 */
export function remapTruth(truth, basePair, newPair, ir) {
  const newIndexOf = (set) => new Map(set.elements.map((e, i) => [e.id, i]));
  const fNew = newIndexOf(newPair.figma), wNew = newIndexOf(newPair.web);
  const fSurv = new Set(fNew.keys()), wSurv = new Set(wNew.keys());

  const out = {};
  const trace = [];
  const stats = { kept: 0, moved: 0, merged: 0, lost: 0 };
  const seen = new Map();

  // Numeric keys sorted numerically so the output order is the reading order of
  // the NEW element set rather than JSON's string-key order.
  const keys = Object.keys(truth.truth).map(Number).sort((a, b) => a - b);

  for (const oldFi of keys) {
    const want = truth.truth[String(oldFi)];
    const oldFid = basePair.figma.elements[oldFi]?.id ?? null;
    if (oldFid == null) { stats.lost++; trace.push({ oldFi, want, lost: 'design index out of range' }); continue; }

    const fid = resolveSurvivor(oldFid, fSurv, ir.figma);
    if (fid == null) { stats.lost++; trace.push({ oldFi, want, lost: 'design element has no survivor' }); continue; }
    const newFi = fNew.get(fid);

    // Non-numeric verdicts ('missing', 'decor', '?') carry no web index. When two
    // collapse into one element the first wins; they always agree in practice,
    // and a disagreement is recorded in the trace rather than resolved silently.
    if (typeof want !== 'number') {
      if (!(newFi in out)) out[newFi] = want;
      else if (out[newFi] !== want) trace.push({ oldFi, newFi, want, conflict: `verdict clash with ${out[newFi]}` });
      continue;
    }

    const oldWid = basePair.web.elements[want]?.id ?? null;
    const wid = oldWid == null ? null : resolveSurvivor(oldWid, wSurv, ir.web);
    if (wid == null) { stats.lost++; trace.push({ oldFi, want, lost: 'page element has no survivor' }); continue; }
    const newWi = wNew.get(wid);

    const sig = `${newFi}->${newWi}`;
    if (seen.has(sig)) {
      stats.merged++;
      trace.push({ oldFi, want, newFi, newWi, merged: `already covered by row ${seen.get(sig)}` });
      continue;
    }
    seen.set(sig, oldFi);
    out[newFi] = newWi;

    if (newFi !== oldFi || newWi !== want) { stats.moved++; trace.push({ oldFi, want, newFi, newWi }); }
    else stats.kept++;
  }

  return { truth: out, stats, trace };
}

/** True matches unreachable under a strict one-to-one assignment. */
export function oneToOneLoss(truthObj) {
  const nums = Object.values(truthObj).filter((v) => typeof v === 'number');
  const counts = new Map();
  for (const v of nums) counts.set(v, (counts.get(v) || 0) + 1);
  let excess = 0;
  for (const n of counts.values()) excess += n - 1;
  return { total: nums.length, distinct: counts.size, excess };
}
