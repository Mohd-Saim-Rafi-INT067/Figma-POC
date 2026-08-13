/**
 * E3 - structural verdict.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE SEMANTIC RULE THIS MODULE EXISTS TO ENFORCE
 *
 *  An element without a counterpart is  NOT ALIGNED.
 *  It is NOT "missing from the page".
 * ══════════════════════════════════════════════════════════════════════════
 *
 * The architecture originally specified `matched / missing-in-web /
 * extra-in-web`. Measured correspondence recall is 33.5% across six
 * hand-scored sections, so that vocabulary would have this stage assert that
 * roughly two thirds of every design is absent from a page that in fact builds
 * it - stated as a defect, with a severity, a screenshot and a place in the
 * report.
 *
 * "Not aligned" is what the evidence supports: we could not establish
 * correspondence. It is a statement about the TOOL, not about the page, and it
 * costs nothing in trust. "Missing" is a claim about the page and must be
 * earned.
 *
 * So absence becomes a finding only when absence is evidence (§ absenceIsEvidence),
 * and never merely because the matcher gave up. Everything else is reported as
 * coverage: "N aligned, M not aligned" - honest, actionable, and it lets the
 * remaining phases be built on numbers that do not lie.
 */

import { correspondGroups, explainedByInstanceCount, compositionDifferences } from './repeated.js';

/**
 * When does a missing counterpart justify a structural CLAIM?
 *
 * Deliberately narrow. The only case currently accepted: an entire design
 * repeated group whose page counterpart does not exist at all, while
 * correspondence in this section is otherwise healthy. A designed card grid
 * with no grid on the page is a real structural difference; one unaligned
 * element among many is just a matcher that gave up.
 *
 * Template COMPOSITION differences - "the design's card has two buttons, the
 * page's has one" - are the other qualifying case, and are handled separately
 * by compositionDifferences(): a slot that never aligns in ANY instance, while
 * its sibling slots align, was not built. That evidence is per-component rather
 * than per-section, so it carries its own gate.
 */
function absenceIsEvidence(group, sectionCoverage, cfg) {
  if (sectionCoverage < cfg.minCoverageForClaims) return false;
  return group.count >= cfg.minGroupSizeForClaim;
}

/**
 * @param figmaSet/webSet  E1 element sets for one matched section pair
 * @param pairs            established correspondence (Tier 1 anchors + verified Tier 2)
 * @param cfg              tolerance profile `structural` block
 */
export function structuralVerdict(figmaSet, webSet, pairs, cfg) {
  const alignedFigma = new Set(pairs.map((p) => p.figmaIndex));
  const alignedWeb = new Set(pairs.map((p) => p.webIndex));
  const groupLinks = correspondGroups(figmaSet, webSet, pairs);

  const coverageFigma = figmaSet.elements.length ? alignedFigma.size / figmaSet.elements.length : 0;
  const coverageWeb = webSet.elements.length ? alignedWeb.size / webSet.elements.length : 0;

  const aligned = pairs.map((p) => ({
    figmaIndex: p.figmaIndex,
    webIndex: p.webIndex,
    tier: p.tier,
    confidence: p.confidence,
    descriptor: p.descriptor ?? null,
  }));

  // Everything unaligned, with WHY it is unaligned where that is known. The
  // reason is diagnostic; none of these are findings.
  const unalignedFigma = [];
  for (const [i, el] of figmaSet.elements.entries()) {
    if (alignedFigma.has(i)) continue;
    const explained = explainedByInstanceCount(el, groupLinks);
    unalignedFigma.push({
      index: i,
      cls: el.cls,
      figmaNodeId: el.sourceRef.figmaNodeId,
      templateId: el.templateId,
      // 'dummy-instance' = a surplus design instance of a group the page builds
      // fewer of. Data volume, explicitly not a defect (the repeated-group rule).
      reason: explained ? 'dummy-instance' : 'not-aligned',
      detail: explained ?? null,
    });
  }

  const unalignedWeb = webSet.elements
    .map((el, i) => ({ index: i, cls: el.cls, webSelector: el.sourceRef.webSelector, templateId: el.templateId }))
    .filter((_, i) => !alignedWeb.has(i))
    .map((e) => ({ ...e, reason: 'not-aligned' }));

  // Structural CLAIMS - the narrow set where absence is evidence.
  const findings = [];
  for (const group of groupLinks.unlinkedFigma) {
    const full = figmaSet.repeatedGroups.find((g) => g.templateId === group.templateId);
    if (!full || !absenceIsEvidence(full, coverageFigma, cfg)) continue;
    findings.push({
      category: 'structural',
      kind: 'group-absent-in-web',
      templateId: group.templateId,
      instanceCount: group.count,
      severity: 'medium',
      evidence: `a repeated group of ${group.count} design elements has no counterpart group on the page, ` +
        `in a section where ${(coverageFigma * 100).toFixed(0)}% of design elements did align`,
    });
  }

  // Composition: reported ONCE per slot, never once per instance.
  for (const diff of compositionDifferences(figmaSet, webSet, pairs, groupLinks, cfg)) {
    findings.push({ category: 'structural', severity: 'medium', ...diff });
  }

  return {
    aligned,
    unalignedFigma,
    unalignedWeb,
    groups: groupLinks,
    // Instance-count differences between LINKED groups are suppressed by design:
    // three designed cards against twelve built ones is data, not a defect.
    suppressedCountDifferences: groupLinks.linked
      .filter((l) => l.figmaCount !== l.webCount)
      .map((l) => ({ ...l, suppressed: true })),
    findings,
    coverage: {
      figma: +coverageFigma.toFixed(3),
      web: +coverageWeb.toFixed(3),
      alignedPairs: pairs.length,
      figmaElements: figmaSet.elements.length,
      webElements: webSet.elements.length,
      dummyInstances: unalignedFigma.filter((u) => u.reason === 'dummy-instance').length,
    },
  };
}
