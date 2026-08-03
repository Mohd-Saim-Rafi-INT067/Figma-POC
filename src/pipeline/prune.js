/**
 * P5 - Pruning & canonicalization. Parent doc 6.1.
 *
 * "This step alone closes most of the structural gap - after it, a well-built
 * page and a well-built frame look startlingly similar."
 *
 * Under V1 this matters for a specific reason: section digests are built from
 * SETS (colors, font sizes, radii) and distributions. A `display:none` mega-menu
 * injects a dozen phantom colors straight into its section's palette, and every
 * transparent wrapper div contributes a phantom 0px gap to the spacing
 * histogram. Pruning is what makes those digests mean anything.
 *
 * Two rules that are easy to get wrong and are handled explicitly here:
 *
 *   1. Dropped nodes REPARENT their survivors rather than dropping the subtree.
 *      A `visibility:hidden` container can hold a `visibility:visible` child,
 *      and dropping the subtree would lose it.
 *   2. Reparenting invalidates `boxRelative`, which is measured against the
 *      parent. It is recomputed after the tree is rebuilt - not doing so leaves
 *      every collapsed node's relative geometry silently wrong.
 */

import { isTransparent } from '../ir/color.js';

const EPS = 1;

/** Do two boxes overlap at all? */
function intersects(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
}

/** Does this node paint anything of its own? */
function paintsSomething(node) {
  if (!isTransparent(node.fill.backgroundColor)) return true;
  if (node.fill.imageRef) return true;
  if (node.fill.gradients?.length) return true;
  if (node.border.width.some((w) => w > 0) && !isTransparent(node.border.color)) return true;
  if (node.effects?.length) return true;
  if (node.text) return true;
  return false;
}

function isInvisible(node, side) {
  if (node.opacity <= 0.001) return 'opacity-0';
  if (node.boxAbsolute.w <= 0 && node.boxAbsolute.h <= 0) return 'zero-area';

  if (side === 'web') {
    const w = node._web || {};
    if (w.display === 'none') return 'display-none';
    if (w.visibility === 'hidden' || w.visibility === 'collapse') return 'visibility-hidden';
  } else {
    if (node._figma && node._figma.visible === false) return 'figma-invisible';
  }
  return null;
}

function clipsContent(node, side) {
  if (side === 'web') {
    const w = node._web || {};
    return w.overflowX === 'hidden' || w.overflowX === 'clip'
      || w.overflowY === 'hidden' || w.overflowY === 'clip';
  }
  return node._figma?.clipsContent === true;
}

/**
 * @param {object} snapshot  an IR snapshot (mutated into a new one, not in place)
 * @returns {{snapshot: object, stats: object}}
 */
export function pruneSnapshot(snapshot, opts = {}) {
  const side = snapshot.side;
  const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const dropped = new Map(); // id -> reason
  const stats = {
    before: snapshot.nodes.length,
    after: 0,
    reasons: {},
    collapsePasses: 0,
  };
  const drop = (id, reason) => {
    if (dropped.has(id)) return;
    dropped.set(id, reason);
    stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
  };

  // --- Pass 1: visibility -------------------------------------------------
  for (const node of snapshot.nodes) {
    const reason = isInvisible(node, side);
    if (reason) drop(node.id, reason);
  }

  // --- Pass 2: clipping ---------------------------------------------------
  // Walk down carrying the tightest clip rect. A node with no overlap at all
  // is invisible no matter what its own styles say.
  const walkClip = (id, clip) => {
    const node = byId.get(id);
    if (!node) return;

    if (clip && !intersects(node.boxAbsolute, clip)) {
      drop(node.id, 'clipped-out');
      // Descendants are inside this box, so they are clipped out too.
      const dropSubtree = (cid) => {
        const c = byId.get(cid);
        if (!c) return;
        drop(cid, 'clipped-out');
        c.children.forEach(dropSubtree);
      };
      node.children.forEach(dropSubtree);
      return;
    }

    let next = clip;
    if (clipsContent(node, side)) {
      const b = node.boxAbsolute;
      next = clip
        ? {
            x: Math.max(clip.x, b.x),
            y: Math.max(clip.y, b.y),
            w: Math.min(clip.x + clip.w, b.x + b.w) - Math.max(clip.x, b.x),
            h: Math.min(clip.y + clip.h, b.y + b.h) - Math.max(clip.y, b.y),
          }
        : { ...b };
    }
    node.children.forEach((cid) => walkClip(cid, next));
  };
  walkClip(snapshot.rootId, null);

  // --- Pass 3: collapse transparent wrappers, to fixpoint ------------------
  //
  // An element whose box matches its single surviving child and which paints
  // nothing itself is pure structure. This is what deletes the div soup - and
  // for the spacing histogram specifically, it is what stops thousands of
  // phantom 0px gaps.
  //
  // Figma gets the narrower rule (single-child GROUP only) per parent doc 6.1:
  // a FRAME that wraps one child is usually a deliberate layout container,
  // whereas a GROUP is almost always incidental.
  const survivingChildren = (node) => node.children.filter((c) => !dropped.has(c));

  for (let pass = 0; pass < 12; pass++) {
    let collapsed = 0;
    for (const node of snapshot.nodes) {
      if (dropped.has(node.id) || node.id === snapshot.rootId) continue;

      const kids = survivingChildren(node);
      if (kids.length !== 1) continue;
      const child = byId.get(kids[0]);
      if (!child) continue;

      if (side === 'figma') {
        if (node._figma?.type !== 'GROUP') continue;
      } else {
        if (paintsSomething(node)) continue;
        const a = node.boxAbsolute;
        const b = child.boxAbsolute;
        const sameBox = Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS
          && Math.abs(a.w - b.w) <= EPS && Math.abs(a.h - b.h) <= EPS;
        if (!sameBox) continue;
      }

      drop(node.id, side === 'figma' ? 'group-collapsed' : 'wrapper-collapsed');
      collapsed++;
    }
    stats.collapsePasses = pass + 1;
    if (!collapsed) break;
  }

  // --- Rebuild the tree ---------------------------------------------------
  // Dropped nodes splice their surviving children into the nearest surviving
  // ancestor, preserving document order.
  const liveChildren = (id) => {
    const node = byId.get(id);
    if (!node) return [];
    const out = [];
    for (const cid of node.children) {
      if (dropped.has(cid)) out.push(...liveChildren(cid));
      else out.push(cid);
    }
    return out;
  };

  if (dropped.has(snapshot.rootId)) {
    // The root going is always a bug in the rules, not a property of the page.
    throw new Error(
      `prune: root node ${snapshot.rootId} was dropped (${dropped.get(snapshot.rootId)}) on the ${side} side`
    );
  }

  const kept = [];
  const rebuild = (id, parentId) => {
    const node = byId.get(id);
    const children = liveChildren(id);
    const rebuilt = { ...node, parentId, children };
    kept.push(rebuilt);
    children.forEach((cid) => rebuild(cid, id));
  };
  rebuild(snapshot.rootId, null);

  // Reparenting changed who the parent is, so parent-relative geometry - which
  // is what every geometry comparison uses - must be recomputed.
  const keptById = new Map(kept.map((n) => [n.id, n]));
  for (const node of kept) {
    const parent = node.parentId ? keptById.get(node.parentId) : null;
    node.boxRelative = parent
      ? {
          x: +(node.boxAbsolute.x - parent.boxAbsolute.x).toFixed(2),
          y: +(node.boxAbsolute.y - parent.boxAbsolute.y).toFixed(2),
          w: node.boxAbsolute.w,
          h: node.boxAbsolute.h,
        }
      : { x: 0, y: 0, w: node.boxAbsolute.w, h: node.boxAbsolute.h };
  }

  stats.after = kept.length;
  stats.removed = stats.before - stats.after;
  stats.removedPct = +((stats.removed / stats.before) * 100).toFixed(1);

  return {
    snapshot: { ...snapshot, nodes: kept, meta: { ...snapshot.meta, pruneStats: stats } },
    stats,
  };
}
