/**
 * M5 - Common UI Model (IR). Doc section 5.
 *
 * Both extractors emit this and nothing else. Every downstream module sees only IR.
 *
 * Phase 1 (token audit) only reads a subset of these fields, but the full shape is
 * emitted from the start: the whole point of shipping the extractors first is to
 * find out they are wrong before the matcher depends on them.
 */

/**
 * Bumping this invalidates all cached snapshots. Extractor changes must not
 * silently reuse stale IR.
 */
export const IR_SCHEMA_VERSION = '2.0.0';

/** @typedef {'container'|'text'|'image'|'icon'|'input'|'button'|'divider'} Role */

export const ROLES = ['container', 'text', 'image', 'icon', 'input', 'button', 'divider'];

/**
 * Construct a VisualNode with every field present. Explicit nulls beat absent keys:
 * a missing field and a genuinely-absent value must not look the same downstream.
 */
export function makeNode(partial) {
  return {
    id: partial.id,
    parentId: partial.parentId ?? null,
    role: partial.role ?? 'container',
    roleConfidence: partial.roleConfidence ?? 1,

    sourceRef: {
      figmaNodeId: null,
      componentId: null,
      componentName: null,
      webPath: null,
      webSelector: null,
      ...(partial.sourceRef ?? {}),
    },

    boxAbsolute: partial.boxAbsolute ?? { x: 0, y: 0, w: 0, h: 0 },
    boxRelative: partial.boxRelative ?? { x: 0, y: 0, w: 0, h: 0 },
    renderBox: partial.renderBox ?? partial.boxAbsolute ?? { x: 0, y: 0, w: 0, h: 0 },
    rotation: partial.rotation ?? 0,

    text: partial.text ?? null,
    type: partial.type ?? null,

    fill: {
      backgroundColor: null,
      gradients: [],
      imageRef: null,
      // `paints` is every visible solid paint - V1 compares color SETS per
      // section, so all of them matter, not just the nominated background.
      paints: [],
      ...(partial.fill ?? {}),
    },

    border: {
      width: [0, 0, 0, 0],
      color: null,
      radius: [0, 0, 0, 0],
      inset: true,
      ...(partial.border ?? {}),
    },

    effects: partial.effects ?? [],

    layout: {
      direction: 'none',
      // Measured from geometry in P6 - never the declared gap/margin/padding.
      // Figma has no margin concept, so declared comparison is a false-positive
      // engine (parent doc 7.3).
      gapMeasured: null,
      paddingMeasured: [null, null, null, null],
      ...(partial.layout ?? {}),
    },

    opacity: partial.opacity ?? 1,
    children: partial.children ?? [],

    /**
     * Extractor-private metadata. NOT part of the comparable IR - nothing in the
     * audit or comparison layers may read it as a design value.
     *
     * It exists because pruning (parent doc 6.1) needs facts that are native to
     * each side and deliberately absent from the shared model: Figma's
     * `visible`/`clipsContent`/node type, the web's `display`/`overflow`.
     * Dropping to IR before pruning would throw those away.
     *
     * Declared explicitly because this factory builds a fixed shape - anything
     * not named here is silently discarded, which is exactly what happened to
     * `_figma` on first write and cost the tier-2 styles assessment.
     */
    _figma: partial._figma ?? null,
    _web: partial._web ?? null,
  };
}

/**
 * A snapshot is one side's full extraction for one run.
 * Stored as a flat node array plus a rootId - trees are painful to diff and
 * serialize, and every consumer wants random access by id anyway.
 */
export function makeSnapshot({ side, sourceVersion, rootId, nodes, meta = {} }) {
  return {
    irSchemaVersion: IR_SCHEMA_VERSION,
    side,
    sourceVersion,
    capturedAt: new Date().toISOString(),
    rootId,
    meta,
    nodes,
  };
}

/** Walk a snapshot's nodes depth-first from the root. */
export function* walk(snapshot) {
  const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const stack = [snapshot.rootId];
  while (stack.length) {
    const node = byId.get(stack.pop());
    if (!node) continue;
    yield node;
    // Reversed so siblings come out in document order.
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
}

export function indexById(snapshot) {
  return new Map(snapshot.nodes.map((n) => [n.id, n]));
}
