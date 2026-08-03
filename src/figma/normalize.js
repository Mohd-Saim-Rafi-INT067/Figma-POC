/**
 * M4 - Figma normalizer. Figma node tree -> IR (plan 3.4).
 *
 * Everything downstream sees only IR. Nothing else in the codebase may know what
 * a `RECTANGLE` or a `strokeAlign` is.
 */

import { makeNode, makeSnapshot } from '../ir/schema.js';
import { makeColorFromFigma, makeColor } from '../ir/color.js';
import { resolveFigmaFont } from '../ir/fonts.js';
import { normalizeText, resolveTextTransform } from '../ir/text.js';

const VECTOR_TYPES = new Set([
  'VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'ELLIPSE', 'LINE', 'REGULAR_POLYGON',
]);

const CONTAINER_TYPES = new Set([
  'FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION', 'CANVAS',
]);

const NAME_BUTTON = /\b(button|btn|cta)\b/i;
const NAME_INPUT = /\b(input|field|textbox|textarea|select|dropdown)\b/i;
const NAME_DIVIDER = /\b(divider|separator|rule|hairline)\b/i;
const NAME_ICON = /\b(icon|ico|glyph)\b/i;

/** Infer a Role plus how much we trust it (parent doc 5). */
function inferRole(node) {
  const name = node.name || '';

  if (node.type === 'TEXT') return { role: 'text', roleConfidence: 1 };

  const hasImageFill = (node.fills || []).some((f) => f.type === 'IMAGE' && f.visible !== false);
  if (hasImageFill) return { role: 'image', roleConfidence: 0.9 };

  if (NAME_BUTTON.test(name)) return { role: 'button', roleConfidence: 0.7 };
  if (NAME_INPUT.test(name)) return { role: 'input', roleConfidence: 0.7 };
  if (NAME_DIVIDER.test(name)) return { role: 'divider', roleConfidence: 0.7 };
  if (NAME_ICON.test(name)) return { role: 'icon', roleConfidence: 0.7 };

  if (VECTOR_TYPES.has(node.type)) return { role: 'icon', roleConfidence: 0.6 };

  // A container thin enough to be a rule is one, whatever it is called.
  const box = node.absoluteBoundingBox;
  if (box && (box.height <= 2 || box.width <= 2) && (box.width > 8 || box.height > 8)) {
    return { role: 'divider', roleConfidence: 0.5 };
  }

  if (CONTAINER_TYPES.has(node.type)) return { role: 'container', roleConfidence: 0.9 };
  return { role: 'container', roleConfidence: 0.3 };
}

/**
 * Figma paints are rgba floats 0-1. Alpha composites through the whole ancestor
 * chain (parent doc 6.2):
 *   effectiveAlpha = paint.opacity x node.opacity x PI(ancestor.opacity)
 */
function paintToColor(paint, inheritedOpacity) {
  if (!paint || paint.type !== 'SOLID' || !paint.color) return null;
  const paintOpacity = paint.opacity === undefined ? 1 : paint.opacity;
  const alpha = (paint.color.a ?? 1) * paintOpacity * inheritedOpacity;
  return makeColorFromFigma(paint.color, alpha);
}

/**
 * Collect every visible SOLID paint, plus a single nominated background.
 *
 * All visible solid paints feed the palette histogram - that is correct for a
 * token audit, where every painted color is a used color. The single
 * `backgroundColor` only matters for pairwise comparison (Phase 2+), so the
 * stacking-order assumption below carries no Phase 1 risk.
 *
 * ASSUMPTION (plan 9 Q1, partly open): the last visible SOLID is the topmost.
 * Verified that `visible: false` entries exist and must be filtered; multi-SOLID
 * stacking order still wants a visual check before pairwise comparison ships.
 */
function readFills(node, inheritedOpacity) {
  const fills = Array.isArray(node.fills) ? node.fills : [];
  const paints = [];
  let backgroundColor = null;
  let imageRef = null;
  const gradients = [];

  for (const f of fills) {
    if (f.visible === false) continue;
    if (f.type === 'SOLID') {
      const c = paintToColor(f, inheritedOpacity);
      if (c) {
        paints.push(c);
        backgroundColor = c;
      }
    } else if (f.type === 'IMAGE') {
      imageRef = f.imageRef || imageRef;
    } else if (String(f.type).startsWith('GRADIENT')) {
      gradients.push({
        type: f.type,
        stops: (f.gradientStops || []).map((s) => ({
          position: s.position,
          color: makeColorFromFigma(s.color, (s.color.a ?? 1) * inheritedOpacity),
        })),
      });
    }
  }

  return { backgroundColor, gradients, imageRef, paints };
}

/**
 * Stroke alignment normalization - parent doc 6.5.
 *
 * Figma strokeAlign is INSIDE / CENTER / OUTSIDE; CSS borders are always inside
 * border-box. For CENTER/OUTSIDE the layout box is adjusted so the discrepancy
 * surfaces as ONE border-model finding rather than N spurious geometry findings.
 */
function readBorder(node, inheritedOpacity) {
  const strokes = (node.strokes || []).filter((s) => s.visible !== false);
  const weight = node.strokeWeight || 0;
  const align = node.strokeAlign || 'INSIDE';
  const color = strokes.length ? paintToColor(strokes[0], inheritedOpacity) : null;

  let radius = [0, 0, 0, 0];
  if (Array.isArray(node.rectangleCornerRadii) && node.rectangleCornerRadii.length === 4) {
    radius = node.rectangleCornerRadii.slice();
  } else if (typeof node.cornerRadius === 'number') {
    radius = [node.cornerRadius, node.cornerRadius, node.cornerRadius, node.cornerRadius];
  }

  const w = strokes.length ? weight : 0;
  return {
    width: [w, w, w, w],
    color,
    radius,
    inset: align === 'INSIDE',
    strokeAlign: align,
    // How far the painted box extends beyond the layout box, for geometry adjustment.
    strokeOutset: align === 'OUTSIDE' ? w : align === 'CENTER' ? w / 2 : 0,
  };
}

function readEffects(node, inheritedOpacity) {
  return (node.effects || [])
    .filter((e) => e.visible !== false)
    .map((e) => {
      const type = {
        DROP_SHADOW: 'drop-shadow',
        INNER_SHADOW: 'inner-shadow',
        LAYER_BLUR: 'blur',
        BACKGROUND_BLUR: 'blur',
      }[e.type] || 'blur';
      return {
        type,
        x: e.offset?.x ?? 0,
        y: e.offset?.y ?? 0,
        blur: e.radius ?? 0,
        spread: e.spread ?? 0,
        color: e.color ? makeColorFromFigma(e.color, (e.color.a ?? 1) * inheritedOpacity) : makeColor(0, 0, 0, 0),
      };
    });
}

/**
 * Text metrics - parent doc 6.3.
 *
 * Q3 (spike): lineHeightPx is populated even for INTRINSIC_%, so it is always
 * the value to read. Q2: letterSpacing is already px in REST; the parent doc's
 * "% -> px" conversion applies to the Plugin API only.
 * Q8: weight comes from the PostScript name, never style.fontWeight.
 */
function readType(node, inheritedOpacity) {
  if (node.type !== 'TEXT' || !node.style) return null;
  const s = node.style;
  const font = resolveFigmaFont(s);
  const fills = readFills(node, inheritedOpacity);

  return {
    fontFamily: font.family,
    renderedFontFamily: font.family, // Figma renders what it declares - no webfont-failure equivalent.
    fontWeight: font.weight,
    fontStyle: font.style,
    fontSizePx: s.fontSize ?? null,
    lineHeightPx: s.lineHeightPx ?? null,
    lineHeightUnit: s.lineHeightUnit ?? null,
    letterSpacingPx: s.letterSpacing ?? 0,
    // Retained: feeds text normalization for section-matching anchors (S2).
    textTransform: resolveTextTransform(s.textCase),
    color: fills.backgroundColor,
    weightSource: font.weightSource,
    postScriptName: font.postScriptName,
    unresolvedFigmaWeight: font.unresolvedFigmaWeight ?? null,
  };
}

const rel = (box, parentBox) =>
  !box ? { x: 0, y: 0, w: 0, h: 0 }
    : !parentBox ? { x: 0, y: 0, w: box.w, h: box.h }
      : { x: box.x - parentBox.x, y: box.y - parentBox.y, w: box.w, h: box.h };

/**
 * Normalize a Figma node tree into an IR snapshot.
 *
 * @param {object} figmaNode  the target frame's `document`
 * @param {object} meta       { fileKey, nodeId, version, styles, components }
 */
export function normalizeFigma(figmaNode, meta = {}) {
  const origin = figmaNode.absoluteBoundingBox || { x: 0, y: 0 };
  const nodes = [];
  const warnings = [];
  let missingRenderBounds = 0;

  const walk = (node, parentId, parentBox, inheritedOpacity, depth) => {
    const id = node.id;
    const nodeOpacity = node.opacity === undefined ? 1 : node.opacity;
    const effectiveOpacity = inheritedOpacity * nodeOpacity;

    const abb = node.absoluteBoundingBox;
    // Frame-space, not canvas-space (plan 3.4).
    const boxAbsolute = abb
      ? { x: abb.x - origin.x, y: abb.y - origin.y, w: abb.width, h: abb.height }
      : { x: 0, y: 0, w: 0, h: 0 };

    // Q6: absoluteRenderBounds is present on ~88% of nodes; fall back explicitly.
    const arb = node.absoluteRenderBounds;
    if (!arb && abb) missingRenderBounds++;
    const renderBox = arb
      ? { x: arb.x - origin.x, y: arb.y - origin.y, w: arb.width, h: arb.height }
      : boxAbsolute;

    const { role, roleConfidence } = inferRole(node);
    const fills = readFills(node, effectiveOpacity);
    const border = readBorder(node, effectiveOpacity);
    const type = readType(node, effectiveOpacity);

    const textTransform = type?.textTransform ?? 'none';
    const text = node.type === 'TEXT' ? normalizeText(node.characters, { textTransform }) : null;

    const ir = makeNode({
      id,
      parentId,
      role,
      roleConfidence,
      sourceRef: {
        figmaNodeId: id,
        componentId: node.componentId ?? null,
        componentName: node.type === 'INSTANCE' ? node.name ?? null : null,
      },
      boxAbsolute,
      boxRelative: rel(boxAbsolute, parentBox),
      renderBox,
      rotation: node.rotation ?? 0,
      text,
      type,
      fill: fills,
      border,
      effects: readEffects(node, effectiveOpacity),
      layout: {
        // Declared values are captured for reference only. Comparison uses
        // MEASURED spacing derived from geometry in P6 (parent doc 7.3).
        direction: node.layoutMode === 'HORIZONTAL' ? 'row'
          : node.layoutMode === 'VERTICAL' ? 'column' : 'none',
        gapMeasured: null,
        paddingMeasured: [null, null, null, null],
        declared: {
          itemSpacing: node.itemSpacing ?? null,
          padding: [
            node.paddingTop ?? null, node.paddingRight ?? null,
            node.paddingBottom ?? null, node.paddingLeft ?? null,
          ],
          layoutMode: node.layoutMode ?? null,
        },
      },
      opacity: effectiveOpacity,
      children: [],
      // Retained for pruning (parent doc 6.1) - not comparison.
      _figma: {
        type: node.type,
        name: node.name,
        visible: node.visible !== false,
        clipsContent: node.clipsContent === true,
        styleRefs: node.styles || null,
        boundVariables: node.boundVariables || null,
        depth,
      },
    });

    nodes.push(ir);

    for (const child of node.children || []) {
      const childId = walk(child, id, boxAbsolute, effectiveOpacity, depth + 1);
      if (childId) ir.children.push(childId);
    }
    return id;
  };

  const rootId = walk(figmaNode, null, null, 1, 0);

  if (missingRenderBounds) {
    warnings.push(
      `${missingRenderBounds}/${nodes.length} nodes had no absoluteRenderBounds; ` +
        'fell back to absoluteBoundingBox (plan 9 Q6).'
    );
  }

  const fallbackWeights = nodes.filter((n) => n.type?.weightSource === 'fallback').length;
  if (fallbackWeights) {
    warnings.push(
      `${fallbackWeights} TEXT nodes had an unresolvable font weight - ` +
        'reported as a normalization gap, never as a design finding (plan 9 Q8).'
    );
  }

  return makeSnapshot({
    side: 'figma',
    sourceVersion: meta.version ?? null,
    rootId,
    nodes,
    meta: {
      fileKey: meta.fileKey ?? null,
      nodeId: meta.nodeId ?? null,
      frameName: figmaNode.name ?? null,
      frameWidth: figmaNode.absoluteBoundingBox?.width ?? null,
      frameHeight: figmaNode.absoluteBoundingBox?.height ?? null,
      fileStyles: meta.styles ?? {},
      warnings,
    },
  });
}
