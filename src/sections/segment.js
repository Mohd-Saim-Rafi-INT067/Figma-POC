/**
 * S1 - Section segmentation. V1 plan phase C.
 *
 * Turns each side's pruned IR into an ORDERED list of sections, each carrying a
 * digest of what it contains. Everything downstream compares digests, never
 * individual nodes - which is what keeps V1 correspondence-free below the
 * section boundary.
 *
 * The one non-obvious rule, and the one that silently breaks everything if
 * missed: the Figma API returns a frame's children in ARBITRARY order. On the
 * real file the first child sits at y=2490 and the third at y=0. Sections must
 * be sorted by y before anything else happens.
 */

import { colorKey, isTransparent } from '../ir/color.js';
import { isNumericLike } from '../ir/text.js';

/**
 * Unwrap a root whose only real child is a full-width container.
 *
 * Many sites wrap everything in <div id="__next"> or <div class="app">. Without
 * unwrapping, the whole page reads as ONE section and there is nothing to align.
 */
function resolveSectionParent(root, byId, minWidthFraction) {
  let node = root;
  for (let depth = 0; depth < 4; depth++) {
    const kids = node.children.map((id) => byId.get(id)).filter(Boolean);
    const wide = kids.filter((k) => k.boxAbsolute.w >= root.boxAbsolute.w * minWidthFraction);
    // Exactly one full-width child and nothing else meaningful -> it is a wrapper.
    if (kids.length === 1 && wide.length === 1) {
      node = kids[0];
      continue;
    }
    break;
  }
  return node;
}

/** Collect every node in a section's subtree. */
function subtree(rootNode, byId) {
  const out = [];
  const stack = [rootNode.id];
  while (stack.length) {
    const n = byId.get(stack.pop());
    if (!n) continue;
    out.push(n);
    for (const c of n.children) stack.push(c);
  }
  return out;
}

/** A short human label so the alignment table is readable by eye. */
function deriveHeadline(nodes) {
  let best = null;
  for (const n of nodes) {
    if (!n.text || !n.type) continue;
    if (isNumericLike(n.text)) continue;
    if (!best || (n.type.fontSizePx ?? 0) > (best.type.fontSizePx ?? 0)) best = n;
  }
  return best ? best.text.slice(0, 46) : null;
}

/**
 * The digest is the unit of comparison. Everything here is a SET or a
 * DISTRIBUTION over the section - never a per-node value - so no correspondence
 * is needed inside the section.
 */
function buildDigest(sectionNode, nodes, side) {
  const textAnchors = new Set();
  const fontFamilySet = new Set();
  const fontSizeSet = new Set();
  const fontWeightSet = new Set();
  const radiusSet = new Set();
  const shadowSet = new Set();
  let pillRadius = false;
  const spacing = {};
  const renderedFonts = new Map();
  let unstable = 0;
  let textNodes = 0;

  // Colors are kept as OBJECTS WITH COUNTS, not as a set of keys. Comparison is
  // by deltaE (parent doc 6.2) - exact key equality would report #835CF5 against
  // #835CF6 as a different color, which float round-tripping alone guarantees
  // will happen. The counts are web-side blast radius for ranking findings.
  const colorTally = new Map();
  const addColor = (c) => {
    if (isTransparent(c)) return;
    const k = colorKey(c);
    const prev = colorTally.get(k);
    if (prev) prev.count++;
    else colorTally.set(k, { key: k, r: c.r, g: c.g, b: c.b, a: c.a, oklch: c.oklch, count: 1 });
  };

  for (const n of nodes) {
    // Text feeds MATCHING only. No finding may ever carry text content.
    if (n.text && !isNumericLike(n.text)) textAnchors.add(n.text);
    if (n.text) textNodes++;

    if (n._web?.unstable) unstable++;

    // A node that was still moving at capture time cannot contribute a style
    // VALUE. Whatever colour, size or radius it happened to hold at the instant
    // of the snapshot is an artifact of timing, and comparing it against the
    // design reports motion as a defect.
    //
    // Excluded from the value sets, deliberately NOT from `textAnchors`,
    // `textNodes` or `nodeCount`: those feed S2 section matching, and the
    // typewriter hero on the reference page is both unstable and one of the
    // strongest anchors available. Dropping it would degrade matching to fix
    // a comparison problem.
    //
    // Section geometry is still affected - a section containing a carousel is
    // genuinely taller - so geometry findings keep the `lowConfidence` tag
    // applied in compare.js. This removes the value findings, not the tag.
    if (n._web?.unstable) continue;

    for (const p of n.fill.paints || []) addColor(p);
    addColor(n.fill.backgroundColor);
    if (n.border.width.some((w) => w > 0)) addColor(n.border.color);

    if (n.type) {
      if (n.type.fontFamily) fontFamilySet.add(n.type.fontFamily);
      if (n.type.fontSizePx) fontSizeSet.add(Math.round(n.type.fontSizePx * 10) / 10);
      if (n.type.fontWeight) fontWeightSet.add(n.type.fontWeight);
      addColor(n.type.color);

      if (side === 'web' && n.type.renderedFontFamily) {
        const key = `${n.type.fontFamily}→${n.type.renderedFontFamily}`;
        renderedFonts.set(key, (renderedFonts.get(key) || 0) + 1);
      }
    }

    // "Fully rounded" is a CATEGORY, not a measurement.
    //
    // `border-radius: 9999px` is the ubiquitous pill idiom; Figma expresses the
    // same pill as a real number sized to the box. Comparing 9999 to 20 is a
    // guaranteed false positive - but clamping to min(w,h)/2 is worse, because
    // it yields a different number for every box size (measured: 19 findings
    // became 33, spread across 93/190/325/450...). Both sides collapse to one
    // boolean instead, and the numeric set keeps only genuine corner radii.
    const halfMin = Math.min(n.boxAbsolute.w, n.boxAbsolute.h) / 2;
    for (const r of n.border.radius || []) {
      if (r <= 0) continue;
      if (halfMin > 0 && r >= halfMin - 0.5) pillRadius = true;
      else radiusSet.add(Math.round(r * 10) / 10);
    }
    for (const e of n.effects || []) {
      if (e.type === 'blur') continue;
      shadowSet.add(`${Math.round(e.x)},${Math.round(e.y)},${Math.round(e.blur)},${Math.round(e.spread)}`);
    }
    for (const g of n.layout.gapsMeasured || []) {
      if (g > 0) spacing[g] = (spacing[g] || 0) + 1;
    }
  }

  // Dominant surface colour, by PAINTED AREA.
  //
  // Two simpler measures were tried against the real page and both misread it:
  //
  //   - The section element's own background. Web section 18 declares #09070C
  //     while #FFFFFF actually covers it; Figma section 17 declares #FFFFFF
  //     while #FAFAFA covers it. Reported as a black-vs-white mismatch when both
  //     sections read as light.
  //   - The most frequently used paint. Frequency counts every text node, so a
  //     text-heavy section reports its body-copy colour as its background.
  //
  // Area is what a person actually sees. Text nodes are excluded because glyph
  // colour is not surface colour, and the section's own background seeds the
  // tally with its full box so a genuinely-empty section still reports it.
  const areaTally = new Map();
  const addArea = (c, area) => {
    if (isTransparent(c) || !(area > 0)) return;
    const k = colorKey(c);
    const prev = areaTally.get(k);
    if (prev) prev.area += area;
    else areaTally.set(k, { c, area });
  };

  if (!isTransparent(sectionNode.fill.backgroundColor)) {
    addArea(sectionNode.fill.backgroundColor, sectionNode.boxAbsolute.w * sectionNode.boxAbsolute.h);
  }
  for (const n of nodes) {
    if (n.text) continue; // glyph colour is not surface colour
    addArea(n.fill.backgroundColor, n.boxAbsolute.w * n.boxAbsolute.h);
  }

  const dominant = [...areaTally.values()].sort((a, b) => b.area - a.area)[0];
  const background = dominant ? dominant.c : sectionNode.fill.backgroundColor || null;
  const declaredBackground = sectionNode.fill.backgroundColor || null;

  const colors = [...colorTally.values()].sort((a, b) => b.count - a.count);

  return {
    nodeCount: nodes.length,
    textNodes,
    textAnchors: [...textAnchors],
    colors,
    colorSet: colors.map((c) => c.key),
    shadowSet: [...shadowSet],
    fontFamilySet: [...fontFamilySet].sort(),
    fontSizeSet: [...fontSizeSet].sort((a, b) => a - b),
    fontWeightSet: [...fontWeightSet].sort((a, b) => a - b),
    radiusSet: [...radiusSet].sort((a, b) => a - b),
    pillRadius,
    spacingHistogram: spacing,
    background,
    declaredBackground,
    renderedFonts: Object.fromEntries(renderedFonts),
    unstableNodes: unstable,
  };
}

/**
 * @param {object} snapshot  pruned + spacing-measured IR
 * @param {object} cfg       tolerance.segmentation
 */
export function segmentSnapshot(snapshot, cfg) {
  const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const root = byId.get(snapshot.rootId);
  if (!root) throw new Error(`segment: root ${snapshot.rootId} not found on the ${snapshot.side} side`);

  const parent = resolveSectionParent(root, byId, cfg.minWidthFraction);
  const totalHeight = root.boxAbsolute.h || 1;
  const rootWidth = root.boxAbsolute.w || 1;

  const rejected = { thin: 0, narrow: 0, empty: 0 };
  const candidates = parent.children.map((id) => byId.get(id)).filter(Boolean);

  const sections = candidates
    // THE critical line: Figma returns children in arbitrary order.
    .sort((a, b) => a.boxAbsolute.y - b.boxAbsolute.y)
    .filter((n) => {
      const b = n.boxAbsolute;
      // Decorative full-width rules and hairlines are not sections.
      if (b.h <= cfg.decorativeStripMaxHeight) { rejected.thin++; return false; }
      if (b.h < cfg.minSectionHeight) { rejected.thin++; return false; }
      // Floating widgets (chat bubbles, cookie pills) are not sections.
      if (b.w < rootWidth * cfg.minWidthFraction) { rejected.narrow++; return false; }
      return true;
    })
    .map((node, index) => {
      const nodes = subtree(node, byId);
      const b = node.boxAbsolute;
      return {
        index,
        id: node.id,
        side: snapshot.side,
        label: snapshot.side === 'figma'
          ? (node._figma?.name || node._figma?.type || 'section')
          : (node._web?.tag || 'section'),
        headline: deriveHeadline(nodes),
        y: b.y,
        height: b.h,
        width: b.w,
        // Normalized against total document height - the page is 21% taller
        // than the frame, so absolute pixels are not comparable across sides.
        normalizedY: +(b.y / totalHeight).toFixed(4),
        normalizedHeight: +(b.h / totalHeight).toFixed(4),
        digest: buildDigest(node, nodes, snapshot.side),
      };
    });

  if (!sections.length) {
    throw new Error(
      `segment: no sections found on the ${snapshot.side} side. ` +
        `Root had ${root.children.length} children; after unwrapping, ${candidates.length} candidates. ` +
        'Check segmentation thresholds in the tolerance profile.'
    );
  }

  return {
    side: snapshot.side,
    totalHeight,
    rootWidth,
    unwrappedTo: parent.id === root.id ? null : parent.id,
    rejected,
    sections,
  };
}
