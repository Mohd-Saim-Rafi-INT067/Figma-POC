/**
 * E1 collapse rules - V2 phase 1.
 *
 * Do not compare raw trees. A Figma frame has 1,613 nodes and the page 1,224;
 * most are wrappers, masks and vector fragments no human would ever point at.
 * Comparing them produces noise on both sides and makes correspondence
 * impossible.
 *
 * This module holds the PREDICATES only - what to drop, what to collapse, and
 * how a node is classified. The traversal that applies them lives in build.js.
 *
 * The one rule that matters more than the rest, and the one the plan originally
 * got wrong:
 *
 *   A Figma vector cluster is a MAXIMAL SUBTREE WHOSE EVERY LEAF IS AN ICON -
 *   not "a parent whose children are all icon leaves".
 *
 * Measured on the reference file: the narrow rule catches 361 of 731 icon
 * leaves. The decorative illustration in section 12 is a 273-node icon-only
 * subtree nested three levels deep, and the narrow rule does not touch it -
 * leaving that section at 380 nodes against the page's 142. The maximal rule
 * takes it to 41.
 */

import { isTransparent } from '../ir/color.js';

/**
 * The comparison class. Deliberately coarser than `role`.
 *
 * Figma draws an icon as vector paths; the browser renders the same icon as an
 * <img> or an <svg>. They are the same thing to a reader, and role counts
 * disagree wildly across the two sides (1 detected Figma button against 40 on
 * the page), so correspondence must never be gated on role equality.
 */
export function elementClass(role) {
  if (role === 'icon' || role === 'image') return 'glyph';
  if (role === 'text') return 'text';
  if (role === 'button' || role === 'input') return 'control';
  return 'box';
}

/** Does this node paint anything of its own? Mirrors P5's rule, minus text. */
export function paintsSomething(node) {
  const fill = node.fill || {};
  if (!isTransparent(fill.backgroundColor)) return true;
  if (fill.imageRef) return true;
  if (fill.gradients?.length) return true;
  if (fill.paints?.length) return true;
  if (node.border?.width?.some((w) => w > 0) && !isTransparent(node.border.color)) return true;
  if (node.effects?.length) return true;
  return false;
}

export function isZeroArea(node, minAreaPx) {
  const b = node.boxAbsolute;
  return !(b.w > minAreaPx && b.h > minAreaPx);
}

/**
 * Hidden on either side. Note P5 has already removed most of these; this is a
 * backstop for nodes that survive pruning with opacity 0.
 */
export function isHidden(node) {
  if (node.opacity === 0) return true;
  if (node._web) return node._web.visibility === 'hidden' || node._web.display === 'none';
  return node._figma?.visible === false;
}

/**
 * Every leaf under `id` is an icon - so the whole subtree is one piece of vector
 * art and collapses to a single element.
 *
 * Applied top-down (see build.js), the FIRST id satisfying this is the maximal
 * one, which is exactly what we want: collapse the illustration, not each of its
 * 273 paths.
 */
export function isIconOnlySubtree(id, byId) {
  const node = byId.get(id);
  if (!node) return false;
  if (!node.children.length) return node.role === 'icon';

  const stack = [...node.children];
  let sawLeaf = false;
  while (stack.length) {
    const child = byId.get(stack.pop());
    if (!child) continue;
    if (!child.children.length) {
      if (child.role !== 'icon') return false;
      sawLeaf = true;
    } else {
      stack.push(...child.children);
    }
  }
  return sawLeaf;
}

/**
 * Where the collapsed cluster's ink actually is.
 *
 * Unions the LEAVES only. Intermediate groups and frames can be far larger than
 * anything they draw - a Figma frame is sized by its layout, not its content -
 * and including them puts the element's box somewhere no ink appears, which
 * then poisons every x-overlap decision downstream.
 */
export function unionBox(id, byId) {
  const leaves = [];
  const stack = [id];
  while (stack.length) {
    const node = byId.get(stack.pop());
    if (!node) continue;
    if (node.children.length) { stack.push(...node.children); continue; }
    leaves.push(node.boxAbsolute);
  }

  // Vector art carries 1x1 "Vector" control points. Filtering them on a fixed
  // pixel threshold is guesswork - a 10x10 fragment is noise beside a 364x210
  // illustration and is the whole icon beside a 24x24 glyph. Scale the cut to
  // the cluster's own largest leaf instead.
  const maxArea = leaves.reduce((m, b) => Math.max(m, b.w * b.h), 0);
  const floor = Math.max(1, maxArea * 0.01);
  const ink = leaves.filter((b) => b.w * b.h >= floor);

  if (!ink.length) {
    const b = byId.get(id).boxAbsolute;
    return { x: b.x, y: b.y, w: b.w, h: b.h };
  }
  const x0 = Math.min(...ink.map((b) => b.x));
  const y0 = Math.min(...ink.map((b) => b.y));
  const x1 = Math.max(...ink.map((b) => b.x + b.w));
  const y1 = Math.max(...ink.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The dominant fill of a collapsed cluster - the colour a reader would name. */
export function dominantFill(id, byId) {
  const area = new Map();
  const stack = [id];
  while (stack.length) {
    const node = byId.get(stack.pop());
    if (!node) continue;
    const c = node.fill?.backgroundColor;
    const b = node.boxAbsolute;
    if (c && !isTransparent(c) && b.w > 0.5 && b.h > 0.5) {
      const key = `${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)}`;
      const prev = area.get(key);
      const weight = b.w * b.h;
      if (!prev || weight > prev.weight) area.set(key, { color: c, weight });
      else prev.weight += weight;
    }
    stack.push(...node.children);
  }
  let best = null;
  for (const entry of area.values()) if (!best || entry.weight > best.weight) best = entry;
  return best ? best.color : null;
}

/** How many IR nodes sit in this subtree - the audit trail for a collapse. */
export function subtreeSize(id, byId) {
  let count = 0;
  const stack = [id];
  while (stack.length) {
    const node = byId.get(stack.pop());
    if (!node) continue;
    count++;
    stack.push(...node.children);
  }
  return count;
}

/**
 * Is this node an element in its own right?
 *
 * Layout containers are deliberately NOT kept on the strength of child count.
 * The two sides nest layout differently - Figma auto-layout frames against div
 * soup - and keeping them preserves exactly the asymmetry E1 exists to remove.
 * Measured: keeping containers with >=2 kept children leaves 18 sections at a
 * 0.34-3.72 ratio spread; keeping only those that paint gives 0.36-2.88 with a
 * far tighter element count. Spacing is recovered from the kept elements'
 * geometry in E4, not from the wrapper that declared it.
 */
export function isElement(node, cfg) {
  switch (node.role) {
    case 'text':    return !!(node.text && node.text.trim());
    case 'image':
    case 'button':
    case 'input':   return true;
    case 'divider': return cfg.keepDividers;
    default:        return paintsSomething(node);
  }
}
