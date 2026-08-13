/**
 * E1 style signatures and repeated-group detection - V2 phase 1.
 *
 * The signature answers ONE question: could these two elements plausibly be the
 * same thing? It is a compatibility check for correspondence, never a
 * comparison. E4 compares measured values; if the signature ever starts
 * carrying a verdict, that boundary has been crossed.
 *
 * It deliberately quantises. A design at #835CF5 and a page at #A855F7 must
 * still match as the same button - the colour difference is the FINDING, and a
 * signature strict enough to separate them would hide it.
 */

const hasInk = (c) => !!c && (c.a ?? 1) >= 0.01;

/**
 * Compact, comparable style descriptor.
 *
 * `cls` rather than `role`: the two sides disagree on role by construction
 * (1 Figma button against 40 web buttons), so role equality would reject
 * correct pairs wholesale.
 *
 * COLOUR IS DELIBERATELY ABSENT beyond a presence flag. A design at #835CF5 and
 * a page at #A855F7 differ by deltaE 6.4 - that IS the finding, and any bucket
 * fine enough to be useful for identity eventually splits a pair like it,
 * silently preventing the very difference the tool exists to report. Colour is
 * measured exactly on both sides and compared in E4; it has no business acting
 * as an identity key here.
 */
export function styleSignature(node, cls) {
  const fill = node.fill || {};
  const border = node.border || {};
  const type = node.type || null;

  return [
    cls,
    hasInk(fill.backgroundColor) ? 'bg' : '-',
    fill.gradients?.length ? 'grad' : '-',
    fill.imageRef ? 'img' : '-',
    border.width?.some((w) => w > 0) ? 'brd' : '-',
    // Radius buckets, not values: 8px vs 12px is a finding, pill vs square is identity.
    border.radius?.some((r) => r >= 999) ? 'pill' : border.radius?.some((r) => r > 0) ? 'round' : 'sharp',
    node.effects?.length ? 'shadow' : '-',
    type ? (type.familyKey || type.fontFamily || '?') : '-',
    // Font size in coarse steps - a 4px difference is a finding, a heading vs
    // body distinction is identity.
    type ? Math.round((type.fontSizePx ?? 0) / 8) : '-',
    type ? Math.round((type.fontWeight ?? 400) / 200) : '-',
  ].join('|');
}

/**
 * Detect repeated sibling groups WITHOUT looking at content.
 *
 * Figma files carry dummy content - three sample cards where production renders
 * twelve real ones. E3 needs to know which elements are instances of one
 * template so it can compare the template and not the count; E1's job is only
 * to label them.
 *
 * NOTE this is labelling, not suppression. Normalising counts here was tried
 * and rejected: the two sides group differently (measured - it fixes the pair
 * whose ratio is driven by real-vs-dummy content and distorts six others), so
 * the decision of what a count difference MEANS belongs to E3.
 */
export function detectRepeatedGroups(elements, cfg) {
  const bySibling = new Map();
  for (const el of elements) {
    const key = el.parentId ?? 'ROOT';
    if (!bySibling.has(key)) bySibling.set(key, []);
    bySibling.get(key).push(el);
  }

  const groups = [];
  for (const [parentId, siblings] of bySibling) {
    const buckets = new Map();
    for (const el of siblings) {
      const size = `${Math.round(el.box.w / cfg.sizeBucketPx)}x${Math.round(el.box.h / cfg.sizeBucketPx)}`;
      const key = `${el.styleSignature}#${size}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(el);
    }
    for (const [key, members] of buckets) {
      if (members.length < cfg.minSiblings) continue;
      const templateId = `tpl:${parentId}:${groups.length}`;
      // First in reading order is the template; the rest are instances of it.
      members.sort((a, b) => a.orderIndex - b.orderIndex);
      for (const [i, el] of members.entries()) {
        el.templateId = templateId;
        el.templateIndex = i;
      }
      groups.push({ templateId, parentId, signature: key, count: members.length, memberIds: members.map((m) => m.id) });
    }
  }

  propagateTemplates(elements, groups);
  return groups;
}

/**
 * Push template identity down into each instance's subtree.
 *
 * A repeated group labels the CARDS. Everything a reader actually compares -
 * the card's title, its icon, its button - are the card's descendants, and
 * without this they carry no group identity at all. That is why E3 could
 * detect "three designed cards against twelve built ones" but not "the
 * design's card has two buttons and the page's has one": the buttons were
 * anonymous.
 *
 * Descendants INHERIT the group id and the instance index, and gain a
 * `templateSlot` - their structural position inside the instance, as a path of
 * sibling indices. Two elements occupying the same slot in different instances
 * therefore share `templateId` + `templateSlot` and differ only in
 * `templateIndex`, which is exactly the relation "the same part of the same
 * component".
 *
 * Slot paths are per-side and are never compared across sides: the design's
 * frame tree and the page's DOM nest differently, so a shared path would mean
 * nothing. What crosses sides is CORRESPONDENCE - E3 asks whether a design slot
 * ever aligns to anything, which needs no structural agreement at all.
 *
 * Runs after every sibling group is assigned, so a nested group of its own
 * keeps its identity rather than being overwritten by its parent's.
 */
function propagateTemplates(elements, groups) {
  if (!groups.length) return;

  const childrenOf = new Map();
  for (const el of elements) {
    const key = el.parentId ?? 'ROOT';
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(el);
  }
  for (const list of childrenOf.values()) list.sort((a, b) => a.orderIndex - b.orderIndex);

  const byId = new Map(elements.map((el) => [el.id, el]));

  for (const group of groups) {
    for (const [instance, memberId] of group.memberIds.entries()) {
      const root = byId.get(memberId);
      if (!root) continue;
      const stack = [{ id: root.id, path: [] }];
      while (stack.length) {
        const { id, path } = stack.pop();
        const kids = childrenOf.get(id) ?? [];
        for (const [k, kid] of kids.entries()) {
          if (kid.templateId) continue;   // already owned by a group of its own
          const next = [...path, k];
          kid.templateId = group.templateId;
          kid.templateIndex = instance;
          kid.templateSlot = next.join('.');
          stack.push({ id: kid.id, path: next });
        }
      }
    }
  }
}
