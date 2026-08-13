/**
 * E2 Tier 3 - verification. Code, always. Contract: docs/v2-tier2-contract.md §4.
 *
 * The model proposes; the engine disposes. Every proposal is checked against
 * measured IR before it is allowed to exist, and rejections are logged, never
 * reported.
 *
 * Class is a hard filter in Tier 1 (measured: relaxing it costs 17 points of
 * precision) but only a floor here, deliberately - arbitrating a design glyph
 * built as a <button> is exactly the semantic judgement Tier 2 exists to make.
 */

function classCompatibility(a, b, table) {
  if (a.cls === b.cls) return 1;
  return table[[a.cls, b.cls].sort().join('~')] ?? table.default;
}

const yGap = (a, b) => Math.abs(a.yRel - b.yRel);

/** 1-D IoU of the x extents - alignment, not containment. Mirrors anchors.js. */
function xAlign(a, b) {
  const lo = Math.max(a.box.x, b.box.x);
  const hi = Math.min(a.box.x + a.box.w, b.box.x + b.box.w);
  const inter = Math.max(0, hi - lo);
  const union = Math.max(a.box.x + a.box.w, b.box.x + b.box.w) - Math.min(a.box.x, b.box.x);
  return inter / Math.max(1, union);
}

/**
 * Proximity veto - contract §4.2. EXPERIMENT, off by default.
 *
 * A plausibility check, never a matcher. It can only REMOVE a claim; it never
 * substitutes the alternative it found, never re-pairs, never proposes. The
 * moment geometry picks the counterpart, geometry is deciding identity, and
 * that is the boundary the architecture rests on.
 *
 * Only TIER 1 ANCHORS count as claims when looking for alternatives. Tier 2's
 * proposals are all under evaluation simultaneously, so treating them as claims
 * would make the outcome depend on evaluation order and let one wrong proposal
 * shield another.
 */
function proximityVeto(f, w, { webElements, anchorClaimedWeb, cfg, classTable }) {
  const baseCompat = classCompatibility(f, w, classTable);
  const baseY = yGap(f, w);
  const baseX = xAlign(f, w);

  const better = [];
  for (let i = 0; i < webElements.length; i++) {
    const alt = webElements[i];
    if (alt === w) continue;
    if (anchorClaimedWeb.has(i)) continue;
    if (classCompatibility(f, alt, classTable) < baseCompat) continue;
    if (yGap(f, alt) + cfg.marginY > baseY) continue;      // not strictly closer by the margin
    if (xAlign(f, alt) < baseX) continue;                  // worse horizontally
    better.push({ index: i, yGap: +yGap(f, alt).toFixed(3), xAlign: +xAlign(f, alt).toFixed(3) });
  }

  return better.length
    ? { vetoed: true, alternatives: better.length, best: better[0], baseY: +baseY.toFixed(3), baseX: +baseX.toFixed(3) }
    : { vetoed: false };
}

/**
 * @returns {{accepted: Array, rejected: Array, counts: object}}
 */
export function verifyProposals(proposals, { figmaSet, webSet, anchors, sectionConfidence, cfg }) {
  const figmaById = new Map(figmaSet.elements.map((e, i) => [e.sourceRef.figmaNodeId ?? e.id, { el: e, index: i }]));
  const webById = new Map(webSet.elements.map((e, i) => [e.sourceRef.webSelector ?? e.id, { el: e, index: i }]));

  // Tier 1 owns these outright and Tier 2 never revisits them.
  const claimedFigma = new Set(anchors.map((a) => a.figmaIndex));
  const claimedWeb = new Set(anchors.map((a) => a.webIndex));

  const accepted = [];
  const rejected = [];
  const counts = {
    proposals: proposals.length,
    phantomId: 0, doubleAssignment: 0, classIncompatible: 0,
    belowFloor: 0, notAMatch: 0, proximityVetoed: 0, accepted: 0,
  };

  const reject = (proposal, reason) => { rejected.push({ proposal, reason }); return false; };

  for (const p of proposals) {
    if (p.decision !== 'match') { counts.notAMatch++; continue; }   // structural verdicts are E3's

    const f = figmaById.get(p.figmaId);
    const w = webById.get(p.webId);

    // Phantom id - the model invented an element. The fatal failure mode.
    if (!f || !w) { counts.phantomId++; reject(p, !f && !w ? 'both ids unknown' : !f ? 'figmaId unknown' : 'webId unknown'); continue; }

    if (claimedFigma.has(f.index) || claimedWeb.has(w.index)) {
      counts.doubleAssignment++; reject(p, 'element already claimed'); continue;
    }

    const compat = classCompatibility(f.el, w.el, cfg.classCompatibility);
    if (compat < cfg.classCompatibility.default) {
      counts.classIncompatible++; reject(p, `classes incompatible (${f.el.cls} vs ${w.el.cls})`); continue;
    }

    // Section confidence multiplies in: a claim cannot be stronger than the
    // section match it rests on (contract §5).
    const effective = +(p.confidence * sectionConfidence).toFixed(3);
    if (effective < cfg.confidenceGate.lowConfidence) {
      counts.belowFloor++; reject(p, `effective confidence ${effective} below ${cfg.confidenceGate.lowConfidence}`); continue;
    }

    // Plausibility veto - last, so it only ever removes a claim that has already
    // passed every structural check. Experiment; default off.
    if (cfg.proximityVeto?.enabled) {
      const veto = proximityVeto(f.el, w.el, {
        webElements: webSet.elements,
        anchorClaimedWeb: new Set(anchors.map((a) => a.webIndex)),
        cfg: cfg.proximityVeto,
        classTable: cfg.classCompatibility,
      });
      if (veto.vetoed) {
        counts.proximityVetoed++;
        rejected.push({
          proposal: p,
          reason: `proximity veto: ${veto.alternatives} unclaimed same-class alternative(s) closer in y ` +
            `(best yGap ${veto.best.yGap} vs ${veto.baseY}, xAlign ${veto.best.xAlign} vs ${veto.baseX})`,
        });
        continue;
      }
    }

    claimedFigma.add(f.index);
    claimedWeb.add(w.index);
    counts.accepted++;
    accepted.push({
      figmaId: p.figmaId,
      webId: p.webId,
      figmaIndex: f.index,
      webIndex: w.index,
      tier: 'llm',
      modelConfidence: p.confidence,
      confidence: effective,
      descriptor: p.descriptor || null,
      classCompat: compat,
    });
  }

  return { accepted, rejected, counts };
}

/** Tier 1 anchors ∪ verified Tier 2 pairs. Disjoint by construction. */
export function combine(anchors, verified) {
  return [...anchors.map((a) => ({ ...a, tier: 'anchor' })), ...verified];
}
