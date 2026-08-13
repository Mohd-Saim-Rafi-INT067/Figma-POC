/**
 * Detect scroll-driven ("pinned") sections.
 *
 * A pinned section is a tall scroll container holding a `position: sticky`
 * viewport, inside which an animation plays as the user scrolls. The section's
 * HEIGHT is scroll distance, not layout: on the reference page one such section
 * is 3,150px tall to animate content that occupies about 900px on screen.
 *
 * Two consequences, and both corrupt correspondence silently:
 *
 *   1. Extraction measures at scrollTop, so the animation is captured in its
 *      INITIAL state. Twelve cards that spread into a 3x4 grid are all recorded
 *      stacked at one coordinate.
 *   2. Even measured at the settled scroll position, section-relative y is
 *      meaningless, because it is normalised against scroll distance rather
 *      than visual height. The design's cards span 100% of a 639px section; the
 *      page's occupy the bottom 17% of a 3,150px one.
 *
 * No extraction change is needed to find them - the IR already carries
 * `_web.position`. This is a derived signal over existing data.
 *
 * Deliberately DETECTION ONLY. Capturing the settled state means measuring each
 * pinned section at its own scroll offset and normalising against the sticky
 * viewport rather than the scroll container - a real change to how geometry is
 * defined, which should not be attempted while its effect is unmeasured. Naming
 * the sections honestly comes first.
 */

/** Nodes in a subtree, by id. */
function subtree(rootId, byId) {
  const out = [];
  const stack = [rootId];
  while (stack.length) {
    const node = byId.get(stack.pop());
    if (!node) continue;
    out.push(node);
    for (const c of node.children) stack.push(c);
  }
  return out;
}

/**
 * @param webIr      pruned web IR snapshot
 * @param webSections S1 output for the web side
 * @param heightRatios map of webIndex -> web/figma section height ratio
 * @param cfg        { minHeightRatio, minSticky }
 * @returns Map webIndex -> { sticky, heightRatio, pinned }
 */
export function detectPinnedSections(webIr, webSections, heightRatios, cfg = {}) {
  const minHeightRatio = cfg.minHeightRatio ?? 2;
  const minSticky = cfg.minSticky ?? 1;
  const byId = new Map(webIr.nodes.map((n) => [n.id, n]));
  const out = new Map();

  for (const section of webSections) {
    const nodes = subtree(section.id, byId);
    const sticky = nodes.filter((n) => n._web && (n._web.position === 'sticky' || n._web.position === 'fixed')).length;
    const heightRatio = heightRatios[section.index] ?? null;

    // Sticky alone is not enough - a sticky header is not a scroll animation.
    // It is the COMBINATION of a pinned child and a section far taller than its
    // design counterpart that identifies scroll distance masquerading as layout.
    const pinned = sticky >= minSticky && heightRatio !== null && heightRatio > minHeightRatio;
    out.set(section.index, { sticky, heightRatio, pinned });
  }
  return out;
}

/** Convenience: load from a completed run directory. */
export function pinnedFromRun(webIr, sections, alignment, cfg) {
  const ratios = {};
  for (const p of alignment.pairs) {
    if (p.figmaIndex == null || p.webIndex == null) continue;
    ratios[p.webIndex] = p.webHeight / Math.max(1, p.figmaHeight);
  }
  return detectPinnedSections(webIr, sections.web.sections, ratios, cfg);
}
