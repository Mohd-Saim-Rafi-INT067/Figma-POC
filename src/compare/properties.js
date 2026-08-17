/**
 * E4 - per-element property comparison.
 *
 * Replaces V1's section-level aggregate comparison. Where V1 could say "this
 * section's palette contains a colour the design doesn't have, 35 times", E4
 * says "this button's background is #A855F7 and should be #835CF5".
 *
 * E1 elements deliberately carry no style values - only geometry, a coarse
 * signature and a `hasText` boolean - because correspondence must not be able
 * to see the values it would later be accused of fitting. So E4 joins the
 * established correspondence back to the measured IR, which is where every
 * exact value lives. The model never touched those numbers; it only ever said
 * which element is which.
 *
 * Noise is the primary risk here, not accuracy. 308 aligned pairs times
 * seventeen rules is 5,000 opportunities to say something, and a 2,000-finding
 * report is worse UX than the aggregate report it replaces. Three controls run
 * inside this module (a fourth, property grouping across sections, is V1's
 * `groupKey` and already applies downstream):
 *
 *   1. TEMPLATE GROUPING   one finding per repeated component, never per
 *                          instance. Twelve cards with the same wrong radius is
 *                          one finding that says "x12".
 *   2. CASCADE SUPPRESSION a parent whose size is wrong makes every child's
 *                          position wrong. The parent is the finding; the
 *                          children are its consequence.
 *   3. PARENT-RELATIVE     geometry is compared against the ALIGNED parent, so
 *      GEOMETRY            a section that starts 40px lower does not report
 *                          every element in it as displaced.
 */

import { deltaEOK, isTransparent, formatColor } from '../ir/color.js';
import { familyKey } from '../ir/fonts.js';

/** Apply one tolerance rule. Returns null when within tolerance. */
function applyRule(rule, expected, actual) {
  if (expected == null || actual == null) return null;

  switch (rule.match) {
    case 'exact':
      return expected === actual ? null : { expected, actual, delta: null };

    case 'deltaEOK': {
      if (isTransparent(expected) && isTransparent(actual)) return null;
      if (isTransparent(expected) || isTransparent(actual)) {
        return { expected: formatColor(expected), actual: formatColor(actual), delta: null };
      }
      const d = deltaEOK(expected, actual);
      return d > rule.tolerance
        ? { expected: formatColor(expected), actual: formatColor(actual), delta: +d.toFixed(2) }
        : null;
    }

    case 'abs': {
      const d = Math.abs(actual - expected);
      return d > rule.tolerance ? { expected, actual, delta: +d.toFixed(2) } : null;
    }

    case 'absOrPct': {
      const d = Math.abs(actual - expected);
      const allowed = Math.max(rule.tolerance, Math.abs(expected) * (rule.pct ?? 0));
      return d > allowed ? { expected, actual, delta: +d.toFixed(2) } : null;
    }

    default:
      return null;
  }
}

/**
 * The background a reader actually SEES on this element.
 *
 * E1 collapses wrappers that paint nothing of their own - but "paints nothing"
 * is judged per node, and a page routinely paints a card's background on a
 * wrapper while the design paints it on the card itself. The two sides then
 * report the same visual surface on different nodes, and comparing them
 * produces "design has a fill, page has none".
 *
 * Measured before this existed: 167 backgroundColor findings, of which - on
 * alignments VERIFIED CORRECT against ground truth - 30 of 33 were exactly
 * that shape. Not a colour defect; a representation mismatch.
 *
 * So resolve the effective background by walking up the ancestors E1 collapsed.
 * Three stopping rules keep it honest:
 *
 *   - stop at another KEPT element: it is compared in its own right, and
 *     inheriting from it would report one fill as two findings;
 *   - stop at the section root, or every element in a section inherits the
 *     section's background and nothing ever differs;
 *   - cap the hops, so a deep tree cannot quietly reach far away for a colour.
 *
 * Applied symmetrically to both sides - an asymmetric rule here would
 * manufacture exactly the mismatch it is meant to remove.
 */
function effectiveBackground(nodeId, nodes, keptIds, sectionRootId, maxHops) {
  const own = nodes.get(nodeId)?.fill?.backgroundColor ?? null;
  if (own && !isTransparent(own)) return { color: own, hops: 0, inheritedFrom: null };

  let cur = nodes.get(nodeId);
  let hops = 0;
  while (cur && hops < maxHops) {
    const parentId = cur.parentId;
    if (!parentId || parentId === sectionRootId) break;
    const parent = nodes.get(parentId);
    if (!parent || keptIds.has(parentId)) break;

    hops++;
    const bg = parent.fill?.backgroundColor ?? null;
    if (bg && !isTransparent(bg)) return { color: bg, hops, inheritedFrom: parentId };
    cur = parent;
  }
  return { color: own, hops: 0, inheritedFrom: null };
}

/** Every scalar property read straight from the IR. */
function scalarProperties(node) {
  const type = node.type ?? {};
  const border = node.border ?? {};
  const shadow = (node.effects ?? [])[0] ?? null;

  return {
    renderedFontFamily: type.renderedFontFamily ?? null,
    // BOTH sides normalised through the same function. The web IR carries a
    // precomputed `familyKey` and the Figma IR does not, so reading whichever
    // exists compares "geist" against "Geist" and reports 79 font mismatches
    // that are pure casing.
    fontFamily: type.fontFamily ? familyKey(type.fontFamily) : null,
    fontSizePx: type.fontSizePx ?? null,
    fontWeight: type.fontWeight ?? null,
    lineHeightPx: type.lineHeightPx ?? null,
    letterSpacingPx: type.letterSpacingPx ?? null,
    color: type.color ?? null,
    backgroundColor: node.fill?.backgroundColor ?? null,
    'border.width': border.width ? Math.max(...border.width) : null,
    'border.radius': border.radius ? Math.max(...border.radius) : null,
    'shadow.geometry': shadow ? (shadow.blur ?? shadow.radius ?? null) : null,
    'shadow.color': shadow ? (shadow.color ?? null) : null,
    opacity: node.opacity ?? null,
    gapMeasured: node.layout?.gapMeasured ?? null,
    paddingMeasured: node.layout?.paddingMeasured?.some((v) => v != null)
      ? Math.max(...node.layout.paddingMeasured.filter((v) => v != null))
      : null,
  };
}

/**
 * Geometry relative to the ALIGNED parent.
 *
 * Absolute position cannot be compared: a section 40px taller shifts everything
 * inside it, and reporting that as one finding per element is exactly the
 * cascade this avoids. Returns null when the two parents do not correspond -
 * there is then no shared frame of reference and silence is the honest answer.
 */
function parentRelative(element, set, parentOf) {
  const parent = element.parentId ? parentOf.get(element.parentId) : null;
  if (!parent) return null;
  return {
    x: +(element.box.x - parent.box.x).toFixed(2),
    y: +(element.box.y - parent.box.y).toFixed(2),
    w: element.box.w,
    h: element.box.h,
    parentId: parent.id,
  };
}

/**
 * @param pair        an E1 section pair { figma, web, figmaIndex, webIndex, confidence }
 * @param aligned     correspondence for this section (Tier 1 anchors + verified Tier 2)
 * @param nodes       { figma: Map<id,node>, web: Map<id,node> } from the pruned IR
 * @param tol         the whole tolerance profile
 */
export function compareElementPairs(pair, aligned, nodes, tol) {
  const rules = tol.rules;
  const cfg = tol.elementCompare ?? {};
  const figmaByIndex = pair.figma.elements;
  const webByIndex = pair.web.elements;

  const keptFigma = new Set(figmaByIndex.map((e) => e.id));
  const keptWeb = new Set(webByIndex.map((e) => e.id));
  const maxHops = cfg.backgroundInheritHops ?? 4;

  const figmaParent = new Map(figmaByIndex.map((e) => [e.id, e]));
  const webParent = new Map(webByIndex.map((e) => [e.id, e]));

  // Which design element is aligned to which page element, by element id -
  // needed to decide whether two parents correspond.
  const alignedByFigmaId = new Map();
  for (const a of aligned) {
    alignedByFigmaId.set(figmaByIndex[a.figmaIndex].id, webByIndex[a.webIndex].id);
  }

  const raw = [];
  const sizeMismatchParents = new Set();

  /**
   * Fan-in: several design elements may legitimately correspond to ONE page
   * element (E2d `manyToOne`) - the design draws a button frame and its label
   * where the page builds a single <button> carrying both.
   *
   * Both members must still be compared, because they carry DIFFERENT
   * comparable properties: the frame has the fill, border and box, the label has
   * the typography. Comparing only one loses half the findings.
   *
   * What must not happen is the same page element collecting the same property
   * twice. So members are ordered by how well they correspond - a class match
   * first, then the larger element - and the first to claim a (page element,
   * property) keeps it. Overlap is usually small, since a text run has no
   * background and a frame has no font, but on the stacked-control shape the
   * members are near-identical and every property would otherwise double.
   */
  const areaOf = (el) => (el?.box?.w ?? 0) * (el?.box?.h ?? 0);
  const correspondenceRank = (a) => {
    const f = figmaByIndex[a.figmaIndex], w = webByIndex[a.webIndex];
    return f && w && f.cls === w.cls ? 0 : 1;
  };
  const ordered = [...aligned].sort((p, q) =>
    correspondenceRank(p) - correspondenceRank(q)
    || areaOf(figmaByIndex[q.figmaIndex]) - areaOf(figmaByIndex[p.figmaIndex]));

  const claimed = new Set();
  /** True the first time this page element is judged on this property. */
  const claims = (wElId, property) => {
    const key = `${wElId}::${property}`;
    if (claimed.has(key)) return false;
    claimed.add(key);
    return true;
  };

  // Pass 1: scalars and size. Size is computed first because cascade
  // suppression needs to know which parents are mis-sized before positions are
  // judged.
  for (const a of ordered) {
    const fEl = figmaByIndex[a.figmaIndex];
    const wEl = webByIndex[a.webIndex];
    const fNode = nodes.figma.get(fEl.id);
    const wNode = nodes.web.get(wEl.id);
    if (!fNode || !wNode) continue;

    const fProps = scalarProperties(fNode);
    const wProps = scalarProperties(wNode);

    // Same rule, both sides. See effectiveBackground.
    const fBg = effectiveBackground(fEl.id, nodes.figma, keptFigma, pair.figma.sectionId, maxHops);
    const wBg = effectiveBackground(wEl.id, nodes.web, keptWeb, pair.web.sectionId, maxHops);
    fProps.backgroundColor = fBg.color;
    wProps.backgroundColor = wBg.color;

    for (const [property, rule] of Object.entries(rules)) {
      if (!(property in fProps)) continue;

      // A Figma TEXT node's `fills` is the GLYPH paint, and the normalizer
      // stores it as `fill.backgroundColor` - verified byte-identical to
      // `type.color`. On the web side the same field is the CSS background,
      // which for a text run is transparent. Comparing them pits the design's
      // text colour against the page's background: a guaranteed mismatch, and
      // double-counting, because the glyph colour is already compared as
      // `color`. It was 130 of 167 backgroundColor findings.
      //
      // The deeper fix belongs in the Figma normalizer, which should not put a
      // text paint in a background field; correcting it here keeps M4 untouched
      // and the asymmetry documented where it does damage.
      if (property === 'backgroundColor' && fEl.cls === 'text') continue;
      const hit = applyRule(rule, fProps[property], wProps[property]);
      if (!hit) continue;
      if (!claims(wEl.id, property)) continue;   // fan-in: judged already
      raw.push(makeElementFinding(pair, a, fEl, wEl, 'element', property, rule.severity, hit));
    }

    // Size, against the tolerance profile's boxRelative.size rule.
    //
    // NOT compared for text runs. A text element's width and height are
    // functions of its CONTENT, and design copy legitimately differs from live
    // copy - that rule is older than this stage and survives from V1. Comparing
    // the box of a text run is therefore an indirect text comparison, and it
    // was the single largest bucket of findings on the reference page: 267 of
    // 470 size findings sat on text. Typography is still compared directly
    // (family, size, weight, line height, letter spacing, colour), which is
    // where a real text defect actually shows up.
    const sizeRule = rules['boxRelative.size'];
    if (sizeRule && fEl.cls !== 'text') {
      for (const dim of ['w', 'h']) {
        const hit = applyRule(sizeRule, fEl.box[dim], wEl.box[dim]);
        if (!hit) continue;
        sizeMismatchParents.add(fEl.id);
        if (!claims(wEl.id, `boxRelative.size.${dim}`)) continue;
        raw.push(makeElementFinding(pair, a, fEl, wEl, 'geometry', `boxRelative.size.${dim}`, sizeRule.severity, hit));
      }
    }
  }

  // Pass 2: position, parent-relative, with cascade suppression.
  const posRule = rules['boxRelative.pos'];
  if (posRule) {
    for (const a of ordered) {
      const fEl = figmaByIndex[a.figmaIndex];
      const wEl = webByIndex[a.webIndex];

      const fRel = parentRelative(fEl, pair.figma, figmaParent);
      const wRel = parentRelative(wEl, pair.web, webParent);
      if (!fRel || !wRel) continue;

      // The two parents must themselves correspond, or the offsets are measured
      // from different origins and any comparison is meaningless.
      if (alignedByFigmaId.get(fRel.parentId) !== wRel.parentId) continue;

      // The parent's own size is wrong, so its children's offsets follow. One
      // finding on the parent, not one per child.
      if (sizeMismatchParents.has(fRel.parentId)) continue;

      for (const axis of ['x', 'y']) {
        const hit = applyRule(posRule, fRel[axis], wRel[axis]);
        if (!hit) continue;
        if (!claims(wEl.id, `boxRelative.pos.${axis}`)) continue;
        raw.push(makeElementFinding(pair, a, fEl, wEl, 'geometry', `boxRelative.pos.${axis}`, posRule.severity, hit));
      }
    }
  }

  return collapseTemplateInstances(raw, cfg);
}

function makeElementFinding(pair, a, fEl, wEl, category, property, severity, hit) {
  return {
    sectionPair: {
      figmaIndex: pair.figmaIndex,
      webIndex: pair.webIndex,
      figmaLabel: null,
      webLabel: null,
      confidence: pair.confidence,
    },
    category,
    type: 'element-property',
    property,
    severity,
    ...hit,
    element: {
      figmaIndex: a.figmaIndex,
      webIndex: a.webIndex,
      cls: fEl.cls,
      figmaNodeId: fEl.sourceRef.figmaNodeId,
      webSelector: wEl.sourceRef.webSelector,
      tier: a.tier,
      matchConfidence: a.confidence,
      templateId: fEl.templateId,
      templateSlot: fEl.templateSlot,
    },
    instanceCount: 1,
  };
}

/**
 * One finding per repeated component, never per instance.
 *
 * Twelve cards built with the same wrong radius is ONE problem a developer
 * fixes in one place. Reporting it twelve times is the single fastest way to
 * make a report unreadable - and this is the control the architecture called
 * mandatory rather than an optimisation.
 *
 * Findings are folded when they share a component, a slot, a property and the
 * same wrong value. Different wrong values in different instances stay separate,
 * because that is genuinely a different problem.
 */
function collapseTemplateInstances(raw, cfg) {
  const out = [];
  const folded = new Map();

  for (const f of raw) {
    const { templateId, templateSlot } = f.element;
    if (!templateId) { out.push(f); continue; }

    const key = [templateId, templateSlot ?? 'root', f.property, String(f.expected), String(f.actual)].join('|');
    const seen = folded.get(key);
    if (!seen) {
      folded.set(key, f);
      out.push(f);
      continue;
    }
    seen.instanceCount++;
    // Keep the first instance as the exemplar; record how many share the fault.
    seen.element.alsoAffects = seen.element.alsoAffects ?? [];
    if (seen.element.alsoAffects.length < (cfg.maxExemplars ?? 3)) {
      seen.element.alsoAffects.push({ figmaIndex: f.element.figmaIndex, webIndex: f.element.webIndex });
    }
  }
  return out;
}
