/**
 * E5 visual severity.
 *
 * Distinct from technical severity, and the right ranking for a human. A 4px
 * padding error on an 800px-wide hero button matters more than the same error
 * on a footer link, and no per-property rule can express that because it is a
 * fact about the ELEMENT, not the property.
 *
 * Every input is measured. Nothing here is a model's opinion.
 *
 * Weights live in the tolerance profile as data - the same rule as every other
 * threshold in this system.
 */

const RANK = { critical: 1, high: 0.75, medium: 0.5, low: 0.25 };

/** Diminishing returns: four problems is worse than one, not four times worse. */
const saturate = (n, k) => 1 - Math.exp(-n / k);

export function visualSeverity(issue, context, cfg) {
  const w = cfg.weights;

  // Worst single property on this element.
  const severityScore = Math.max(...issue.properties.map((p) => RANK[p.severity] ?? 0.25));

  // More problems on one element is a stronger signal, with diminishing returns.
  const countScore = saturate(issue.properties.length, cfg.issueCountSaturation);

  // How much of a viewport this element occupies. Capped: a full-bleed section
  // background is not ten times more important than a hero image.
  const areaScore = Math.min(1, issue.element.area / (context.viewportArea || 1));

  // Above the fold weighs more, decaying with depth down the page.
  const foldsDown = context.absoluteY / (context.viewportHeight || 1);
  const positionScore = 1 / (1 + foldsDown);

  // A fault in a component rendered twelve times has twelve times the surface,
  // saturating for the same reason as count.
  const instanceScore = saturate(issue.templateInstances ?? 1, cfg.instanceSaturation);

  const raw =
    w.severity * severityScore +
    w.issueCount * countScore +
    w.area * areaScore +
    w.position * positionScore +
    w.instances * instanceScore;

  const total = w.severity + w.issueCount + w.area + w.position + w.instances;

  // Match confidence MULTIPLIES rather than adding. A claim resting on a weak
  // correspondence must not shout, however severe it would be if true - and a
  // multiplier can only ever mark it down.
  return +Math.max(0, Math.min(1, (raw / total) * (issue.matchConfidence ?? 1))).toFixed(4);
}
