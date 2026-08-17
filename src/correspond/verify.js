/**
 * E2d - verification and assignment. Code, always.
 *
 * The model proposes; the engine disposes. Every answer is checked against
 * measured IR before it is allowed to exist, and rejections are logged, never
 * reported.
 *
 * The checks from the old contract (v2-tier2-contract.md §4) all survive. What
 * changed is that the FATAL one can no longer happen: the model returns an index
 * into a list this module supplied, so an id it invented has nowhere to go. The
 * phantom check is retained anyway, as an assertion - if it ever fires, the
 * harness is wired wrongly and every number it produced is suspect.
 *
 * The proximity veto is GONE. It was measured on unseen ground truth to remove
 * correct pairs (recall 44.4% -> 43.2%) for a precision gain the shortlist
 * architecture gets for free, and the contract already recorded it as rejected.
 */

import { classCompatibility } from './candidates.js';
import { NO_MATCH } from './llm.js';

/**
 * Do these two design elements sit on one ancestor chain?
 *
 * The permission test for many-to-one. The ground truth's own diagnosis is that
 * legitimate fan-in happens when the design expresses ONE thing as several
 * nested nodes - "a control frame, its inner states and its label" - which the
 * page builds as a single element. That is an ancestor chain. Two unrelated
 * design elements pointing at one page element is not fan-in, it is a mistake,
 * and this is what separates them.
 */
function sharesAncestorChain(aIndex, bIndex, elements) {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const chain = (start) => {
    const out = new Set();
    let el = elements[start];
    while (el) { out.add(el.id); el = el.parentId ? byId.get(el.parentId) : null; }
    return out;
  };
  const up = chain(aIndex);
  return chain(bIndex).has(elements[aIndex].id) || up.has(elements[bIndex].id);
}

/**
 * Verify one section's answers and resolve them into an assignment.
 *
 * @param assignments  what the model returned, already coerced by llm.js
 * @param shortlists   Map<figmaIndex, [{ webIndex }]> - EXACTLY what was sent
 * @param asked        Set<figmaIndex> - the elements actually put to the model
 */
export function verifyAssignments(assignments, {
  figmaSet, webSet, shortlists, asked, sectionConfidence, cfg,
}) {
  const accepted = [];
  const rejected = [];
  const counts = {
    answers: assignments.length,
    phantomId: 0, pickOutOfRange: 0, declined: 0,
    classIncompatible: 0, templateMismatch: 0,
    belowFloor: 0, conflictLost: 0, fanInRefused: 0, accepted: 0,
  };

  const reject = (a, reason) => rejected.push({ answer: a, reason });
  const manyToOne = cfg.manyToOne ?? { enabled: false };

  // --- pass 1: per-answer validity -----------------------------------------
  const valid = [];
  for (const a of assignments) {
    const figmaIndex = a.f;

    // The model was handed these numbers, so this is unreachable when the prompt
    // and the harness agree. Retained as an assertion because it is exactly how
    // the first X4 run was caught: a "DESIGN <id>" label made the model answer
    // with the label attached, and 45 of 47 answers were unresolvable. Without
    // this counter that run would have looked like a model that declines a lot.
    if (!Number.isInteger(figmaIndex) || !asked.has(figmaIndex)) {
      counts.phantomId++;
      reject(a, `design element ${JSON.stringify(a.f)} was never asked about - HARNESS BUG`);
      continue;
    }

    if (a.pick === NO_MATCH) { counts.declined++; continue; }   // a verdict for E3, not a pair

    const list = shortlists.get(figmaIndex) ?? [];
    if (!Number.isInteger(a.pick) || a.pick < 0 || a.pick >= list.length) {
      counts.pickOutOfRange++; reject(a, `pick ${a.pick} outside 0..${list.length - 1}`); continue;
    }

    const webIndex = list[a.pick].webIndex;
    const f = figmaSet.elements[figmaIndex], w = webSet.elements[webIndex];

    const compat = classCompatibility(f, w, cfg.classCompatibility);
    if (compat < cfg.classCompatibility.default) {
      counts.classIncompatible++; reject(a, `classes incompatible (${f.cls} vs ${w.cls})`); continue;
    }

    // Template-instance consistency: instance i should map to instance i. Only
    // enforced when BOTH sides carry template identity, because coverage is
    // partial and absence is not disagreement.
    if (f.templateId && w.templateId && f.templateIndex !== w.templateIndex) {
      counts.templateMismatch++;
      reject(a, `template instance ${f.templateIndex} -> ${w.templateIndex}`);
      continue;
    }

    // A claim cannot be stronger than the section match it rests on.
    const effective = +(a.confidence * sectionConfidence).toFixed(3);
    if (effective < cfg.confidenceGate.lowConfidence) {
      counts.belowFloor++; reject(a, `effective confidence ${effective} below ${cfg.confidenceGate.lowConfidence}`); continue;
    }

    valid.push({ answer: a, figmaIndex, webIndex, compat, effective });
  }

  // --- pass 2: resolve competition for the same page element ----------------
  // Highest effective confidence wins. Ties break on figma index so the outcome
  // does not depend on the order the model happened to answer in.
  const byWeb = new Map();
  for (const v of valid) {
    if (!byWeb.has(v.webIndex)) byWeb.set(v.webIndex, []);
    byWeb.get(v.webIndex).push(v);
  }

  for (const [webIndex, contenders] of byWeb) {
    contenders.sort((p, q) => q.effective - p.effective || p.figmaIndex - q.figmaIndex);
    const [winner, ...rest] = contenders;
    accept(winner);

    for (const loser of rest) {
      const permitted = manyToOne.enabled
        && sharesAncestorChain(winner.figmaIndex, loser.figmaIndex, figmaSet.elements)
        && contenders.length <= (manyToOne.maxFanIn ?? 4);

      if (!permitted) {
        // Distinguish "we do not allow fan-in here" from "this fan-in was not
        // the legitimate kind" - they have different fixes.
        if (manyToOne.enabled) counts.fanInRefused++; else counts.conflictLost++;
        reject(loser.answer, manyToOne.enabled
          ? `fan-in refused: design ${loser.figmaIndex} is not on ${winner.figmaIndex}'s ancestor chain`
          : `page element ${webIndex} already claimed by design ${winner.figmaIndex}`);
        continue;
      }
      accept(loser);
    }
  }

  function accept(v) {
    counts.accepted++;
    accepted.push({
      figmaId: figmaSet.elements[v.figmaIndex].id,
      webId: webSet.elements[v.webIndex].id,
      figmaIndex: v.figmaIndex,
      webIndex: v.webIndex,
      tier: 'llm',
      modelConfidence: v.answer.confidence,
      confidence: v.effective,
      descriptor: v.answer.descriptor || null,
      classCompat: v.compat,
      pick: v.answer.pick,
    });
  }

  return { accepted, rejected, counts };
}

/**
 * Merge deterministic anchors with adjudicated pairs.
 *
 * Under the new architecture Tier 1 does not claim, so there is normally nothing
 * to merge and this is the identity function on the adjudicated set. It is kept
 * because E2b may still hold back mutual-best warp anchors, and because a caller
 * that mixes the two must not silently produce duplicates: an anchor and an
 * adjudicated pair naming the same design element is a real disagreement, and
 * the anchor wins as the deterministic one.
 */
export function combine(anchors, adjudicated) {
  const claimedFigma = new Set(anchors.map((a) => a.figmaIndex));
  const claimedWeb = new Set(anchors.map((a) => a.webIndex));

  const kept = adjudicated.filter((p) => !claimedFigma.has(p.figmaIndex) && !claimedWeb.has(p.webIndex));
  return [...anchors.map((a) => ({ ...a, tier: a.tier ?? 'anchor' })), ...kept];
}
