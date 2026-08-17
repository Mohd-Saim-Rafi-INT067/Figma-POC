/**
 * E1 - the comparable element set. V2 phase 1.
 *
 * Reduces one section's IR subtree to a flat, ordered list of elements a person
 * would actually point at, on both sides, under identical rules.
 *
 * Everything downstream depends on this being SYMMETRIC. Any rule that fires on
 * one side but not the other reintroduces exactly the structural asymmetry that
 * makes correspondence impossible - which is why the rules live in collapse.js
 * as side-agnostic predicates and this traversal never branches on `side`.
 *
 * Contract per v2-hld.md 5.1. `hasText` is a BOOLEAN: the string stops here.
 * Design copy and live copy legitimately differ, so text may inform matching
 * (S2 uses it at section level) but must never reach a finding.
 */

import {
  elementClass,
  isElement,
  isZeroArea,
  isHidden,
  isIconOnlySubtree,
  isCoincidentPassthrough,
  unionBox,
  dominantFill,
  subtreeSize,
} from './collapse.js';
import { styleSignature, detectRepeatedGroups } from './signature.js';
import { normalizeText } from '../ir/text.js';

/**
 * Build the element set for one section.
 *
 * @param snapshot  a pruned IR snapshot (P5/P6 output)
 * @param sectionId the section's root node id, from S1
 * @param cfg       tolerance profile `elements` block
 */
export function buildElementSet(snapshot, sectionId, cfg) {
  const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const root = byId.get(sectionId);
  if (!root) throw new Error(`E1: section root ${sectionId} not found on the ${snapshot.side} side`);

  const origin = root.boxAbsolute;
  const dropped = { zeroArea: 0, hidden: 0, iconCollapsed: 0, wrapper: 0, emptyText: 0, coincidentShell: 0 };
  const elements = [];

  /**
   * Walk top-down. Top-down is load-bearing for the icon rule: the first node
   * satisfying isIconOnlySubtree is the MAXIMAL one, so a 273-node decorative
   * illustration collapses once rather than into its 273 paths.
   */
  function visit(id, parentId, depth) {
    const node = byId.get(id);
    if (!node) return;

    if (id !== sectionId) {
      if (isZeroArea(node, cfg.minAreaPx)) { dropped.zeroArea += subtreeSize(id, byId); return; }
      if (isHidden(node)) { dropped.hidden += subtreeSize(id, byId); return; }

      if (isIconOnlySubtree(id, byId)) {
        const size = subtreeSize(id, byId);
        if (size > 1) dropped.iconCollapsed += size - 1;
        emit(node, parentId, depth, {
          role: 'icon',
          box: unionBox(id, byId),
          collapsedFrom: size,
          fillOverride: dominantFill(id, byId),
        });
        return;   // the cluster is one element; its paths are gone
      }
    }

    // A coincident shell is skipped rather than emitted, and its single child is
    // visited as usual - so the chain yields one element instead of N. See
    // isCoincidentPassthrough; off unless the tolerance profile enables it.
    const passthrough = id !== sectionId && isCoincidentPassthrough(id, byId, cfg);
    const keep = id !== sectionId && !passthrough && isElement(node, cfg);
    if (keep) {
      emit(node, parentId, depth, { role: node.role, box: node.boxAbsolute, collapsedFrom: 1, fillOverride: null });
    } else if (id !== sectionId) {
      if (passthrough) dropped.coincidentShell++;
      else if (node.role === 'text') dropped.emptyText++;
      else dropped.wrapper++;
    }

    // A dropped wrapper reparents its survivors rather than losing them - the
    // same rule P5 applies, and for the same reason.
    const nextParent = keep ? id : parentId;
    const nextDepth = keep ? depth + 1 : depth;
    for (const childId of node.children) visit(childId, nextParent, nextDepth);
  }

  function emit(node, parentId, depth, { role, box, collapsedFrom, fillOverride }) {
    const cls = elementClass(role);
    const shaped = fillOverride
      ? { ...node, fill: { ...node.fill, backgroundColor: fillOverride } }
      : node;

    elements.push({
      id: node.id,
      parentId,
      depth,
      role,
      cls,
      roleConfidence: node.roleConfidence ?? null,
      // Section-relative. Both sides render at the same frame width, so x is
      // directly comparable; y is not, and is used for ordering and for a local
      // expectation only (v2-implementation-plan.md 0.2).
      box: {
        x: +(box.x - origin.x).toFixed(2),
        y: +(box.y - origin.y).toFixed(2),
        w: +box.w.toFixed(2),
        h: +box.h.toFixed(2),
      },
      yRel: origin.h ? +((box.y - origin.y) / origin.h).toFixed(4) : 0,
      area: +(box.w * box.h).toFixed(1),
      styleSignature: styleSignature(shaped, cls),
      hasText: !!(node.text && node.text.trim()),   // presence only
      /**
       * Normalized text, for MATCHING ONLY. Contract amendment, Phase C.
       *
       * The Tier 2 contract §2 banned text outright. That ban is correct for
       * VALUES - design copy and live copy legitimately differ, so a string that
       * reached a finding would manufacture one - and it was never measured for
       * IDENTITY, which is a different question. X2 measured it: feeding text to
       * the RANKER moves shortlist recall@1 from 46.0% to 60.2% and recall@8
       * from 85.7% to 90.7%, holding up on held-out sheets, with the whole gain
       * in the one section whose layout was rearranged during the build.
       *
       * The containment is unchanged and enforced elsewhere:
       *   - the Tier 2 prompt never includes it (test/candidates.test.js)
       *   - no comparison stage reads it; E4 compares measured values
       *   - `hasText` is retained so nothing downstream had to change
       *
       * Capped at 120 characters because a design paragraph and its built
       * counterpart agree at the start and diverge later far more often than the
       * reverse, and an uncapped body string dominates every bigram set it meets.
       */
      textKey: (node.text ? normalizeText(node.text) : null)?.slice(0, 120) || null,
      collapsedFrom,
      childCount: 0,
      orderIndex: 0,
      templateId: null,
      templateIndex: null,
      templateSlot: null,
      sourceRef: {
        figmaNodeId: node.sourceRef?.figmaNodeId ?? null,
        webSelector: node.sourceRef?.webSelector ?? null,
      },
    });
  }

  visit(sectionId, null, 0);

  // Reading order, then the derived counts that depend on it.
  elements.sort((a, b) => (a.box.y - b.box.y) || (a.box.x - b.box.x));
  elements.forEach((el, i) => { el.orderIndex = i; });

  const childCounts = new Map();
  for (const el of elements) {
    if (el.parentId) childCounts.set(el.parentId, (childCounts.get(el.parentId) || 0) + 1);
  }
  for (const el of elements) el.childCount = childCounts.get(el.id) || 0;

  const repeatedGroups = detectRepeatedGroups(elements, cfg.repeatedGroup);

  return {
    side: snapshot.side,
    sectionId,
    origin: { x: origin.x, y: origin.y, w: origin.w, h: origin.h },
    elements,
    repeatedGroups,
    stats: {
      irNodes: subtreeSize(sectionId, byId),
      elements: elements.length,
      dropped,
      byClass: elements.reduce((acc, el) => { acc[el.cls] = (acc[el.cls] || 0) + 1; return acc; }, {}),
    },
  };
}

/** Build every matched section pair's element sets. */
export function buildAllElementSets(snapshots, sections, alignment, cfg) {
  const figmaByIndex = new Map(sections.figma.sections.map((s) => [s.index, s]));
  const webByIndex = new Map(sections.web.sections.map((s) => [s.index, s]));
  const pairs = [];

  for (const pair of alignment.pairs) {
    const fIndex = pair.figma ? pair.figma.index : null;
    const wIndex = pair.web ? pair.web.index : null;
    if (fIndex == null || wIndex == null) continue;   // gaps are S2's verdict, not E1's

    pairs.push({
      figmaIndex: fIndex,
      webIndex: wIndex,
      confidence: pair.confidence,
      figma: buildElementSet(snapshots.figma, figmaByIndex.get(fIndex).id, cfg),
      web: buildElementSet(snapshots.web, webByIndex.get(wIndex).id, cfg),
    });
  }
  return pairs;
}
