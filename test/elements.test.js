/**
 * Unit tests for E1 - the comparable element set.
 *
 * These cover the rules where a silent regression would corrupt correspondence
 * without ever throwing: the icon-cluster rule, wrapper reparenting, signature
 * tolerance, and the text-never-escapes contract.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeColor } from '../src/ir/color.js';
import { makeNode } from '../src/ir/schema.js';
import {
  elementClass, isIconOnlySubtree, unionBox, isElement, paintsSomething,
} from '../src/elements/collapse.js';
import { styleSignature } from '../src/elements/signature.js';
import { buildElementSet } from '../src/elements/build.js';

const CFG = {
  minAreaPx: 0.5,
  keepDividers: true,
  targetCountMin: 20,
  targetCountMax: 80,
  repeatedGroup: { minSiblings: 3, sizeBucketPx: 8 },
};

const box = (x, y, w, h) => ({ x, y, w, h });

/** A tiny IR snapshot. First node is the section root; children derive from parentId. */
function snapshot(side, nodes) {
  const built = nodes.map((n) => makeNode(n));
  for (const n of built) n.children = built.filter((c) => c.parentId === n.id).map((c) => c.id);
  return { side, rootId: built[0].id, nodes: built };
}

test('E1: class collapses the icon/image split the two sides disagree on', () => {
  // 1 detected Figma button against 40 on the page - role equality would reject
  // correct pairs wholesale, so correspondence keys on class.
  assert.equal(elementClass('icon'), elementClass('image'));
  assert.equal(elementClass('button'), elementClass('input'));
  assert.notEqual(elementClass('text'), elementClass('icon'));
});

test('E1: an icon cluster is the MAXIMAL subtree, not the immediate parent', () => {
  // The reference file's decorative illustration is a 273-node icon-only
  // subtree three levels deep. A rule keyed on "children are all icon leaves"
  // misses it entirely - measured, it catches 361 of 731 icon leaves.
  const snap = snapshot('figma', [
    { id: 'sec', role: 'container', boxAbsolute: box(0, 0, 100, 100) },
    { id: 'group', parentId: 'sec', role: 'container', boxAbsolute: box(10, 10, 40, 40) },
    { id: 'inner', parentId: 'group', role: 'container', boxAbsolute: box(10, 10, 20, 20) },
    { id: 'v1', parentId: 'inner', role: 'icon', boxAbsolute: box(10, 10, 20, 20) },
    { id: 'v2', parentId: 'inner', role: 'icon', boxAbsolute: box(15, 15, 10, 10) },
    { id: 'v3', parentId: 'group', role: 'icon', boxAbsolute: box(30, 30, 20, 20) },
    { id: 'cap', parentId: 'sec', role: 'text', text: 'caption', boxAbsolute: box(10, 60, 40, 10) },
  ]);
  const byId = new Map(snap.nodes.map((n) => [n.id, n]));

  assert.ok(isIconOnlySubtree('group', byId), 'the whole group is vector art');
  assert.ok(!isIconOnlySubtree('sec', byId), 'the section root also holds text');

  const { elements, stats } = buildElementSet(snap, 'sec', CFG);
  assert.deepEqual(elements.map((e) => e.role), ['icon', 'cap'].map((r) => (r === 'icon' ? 'icon' : 'text')));
  assert.equal(elements.length, 2, 'five vector nodes collapse to one icon, plus the caption');
  assert.equal(elements[0].collapsedFrom, 5);
  assert.equal(stats.dropped.iconCollapsed, 4);
});

test('E1: a collapsed icon takes the union box, ignoring 1x1 path fragments', () => {
  // Real clusters carry zero-area "Vector" nodes; a naive union drags the box
  // back to the origin and the element lands nowhere near its own ink.
  const snap = snapshot('figma', [
    { id: 'sec', role: 'container', boxAbsolute: box(0, 0, 100, 100) },
    { id: 'g', parentId: 'sec', role: 'container', boxAbsolute: box(0, 0, 100, 100) },
    { id: 'dot', parentId: 'g', role: 'icon', boxAbsolute: box(0, 0, 1, 1) },
    { id: 'a', parentId: 'g', role: 'icon', boxAbsolute: box(20, 30, 10, 10) },
    { id: 'b', parentId: 'g', role: 'icon', boxAbsolute: box(40, 30, 10, 20) },
  ]);
  const byId = new Map(snap.nodes.map((n) => [n.id, n]));
  assert.deepEqual(unionBox('g', byId), { x: 20, y: 30, w: 30, h: 20 });
});

test('E1: layout containers are dropped, painting ones kept', () => {
  // Keeping containers on child count preserves exactly the div-soup-versus-
  // auto-layout asymmetry E1 exists to remove.
  const plain = makeNode({ id: 'a', role: 'container', boxAbsolute: box(0, 0, 10, 10) });
  assert.ok(!paintsSomething(plain));
  assert.ok(!isElement(plain, CFG));

  const carded = makeNode({
    id: 'b', role: 'container', boxAbsolute: box(0, 0, 10, 10),
    fill: { backgroundColor: makeColor(255, 0, 0) },
  });
  assert.ok(isElement(carded, CFG));
});

test('E1: a dropped wrapper reparents its survivors rather than losing them', () => {
  const snap = snapshot('web', [
    { id: 'sec', role: 'container', boxAbsolute: box(0, 0, 100, 100) },
    { id: 'wrap', parentId: 'sec', role: 'container', boxAbsolute: box(0, 0, 100, 50) },
    { id: 'card', parentId: 'wrap', role: 'container', boxAbsolute: box(0, 0, 100, 50), fill: { backgroundColor: makeColor(1, 2, 3) } },
    { id: 'label', parentId: 'card', role: 'text', text: 'hello', boxAbsolute: box(5, 5, 40, 10) },
  ]);
  const { elements } = buildElementSet(snap, 'sec', CFG);
  assert.deepEqual(elements.map((e) => e.id).sort(), ['card', 'label']);
  assert.equal(elements.find((e) => e.id === 'label').parentId, 'card', 'reparented past the dropped wrapper');
});

test('E1: boxes are section-relative and text never leaves as a string', () => {
  const snap = snapshot('figma', [
    { id: 'sec', role: 'container', boxAbsolute: box(0, 400, 200, 100) },
    { id: 't', parentId: 'sec', role: 'text', text: 'Enterprise Software', boxAbsolute: box(20, 450, 80, 20) },
  ]);
  const el = buildElementSet(snap, 'sec', CFG).elements[0];
  assert.deepEqual(el.box, { x: 20, y: 50, w: 80, h: 20 });
  assert.equal(el.hasText, true);
  assert.ok(!JSON.stringify(el).includes('Enterprise'), 'the string must stop at E1');
});

test('E1: an empty text node is not an element', () => {
  const snap = snapshot('web', [
    { id: 'sec', role: 'container', boxAbsolute: box(0, 0, 100, 100) },
    { id: 'blank', parentId: 'sec', role: 'text', text: '   ', boxAbsolute: box(0, 0, 10, 10) },
  ]);
  assert.equal(buildElementSet(snap, 'sec', CFG).elements.length, 0);
});

test('E1: signature tolerates the differences that ARE the finding', () => {
  const mk = (bg, radius) => makeNode({
    id: 'x', role: 'button', boxAbsolute: box(0, 0, 100, 40),
    fill: { backgroundColor: bg }, border: { radius: [radius, radius, radius, radius] },
  });
  // #835CF5 against #A855F7 is a real colour finding at deltaE 6.4. The two must
  // still match as the same button, or that finding can never be reported.
  assert.equal(
    styleSignature(mk(makeColor(131, 92, 245), 8), 'control'),
    styleSignature(mk(makeColor(168, 85, 247), 12), 'control')
  );
  // A text run and a glyph are not the same element.
  assert.notEqual(
    styleSignature(mk(makeColor(0, 0, 0), 0), 'text'),
    styleSignature(mk(makeColor(0, 0, 0), 0), 'glyph')
  );
});

test('E1: repeated sibling groups are labelled, never suppressed', () => {
  // Design shows 3 dummy cards where production renders 12. E1 labels the
  // template; deciding what the count difference MEANS belongs to E3.
  const cards = [1, 2, 3, 4].map((i) => ({
    id: `c${i}`, parentId: 'sec', role: 'container', boxAbsolute: box(0, i * 60, 100, 50),
    fill: { backgroundColor: makeColor(10, 10, 10) },
  }));
  const snap = snapshot('web', [{ id: 'sec', role: 'container', boxAbsolute: box(0, 0, 100, 400) }, ...cards]);
  const { elements, repeatedGroups } = buildElementSet(snap, 'sec', CFG);

  assert.equal(elements.length, 4, 'labelling must not remove instances');
  assert.equal(repeatedGroups.length, 1);
  assert.equal(repeatedGroups[0].count, 4);
  assert.equal(new Set(elements.map((e) => e.templateId)).size, 1);
  assert.deepEqual(elements.map((e) => e.templateIndex), [0, 1, 2, 3]);
});

test('E1: two builds over the same snapshot are identical, in reading order', () => {
  const nodes = [
    { id: 'sec', role: 'container', boxAbsolute: box(0, 0, 100, 100) },
    { id: 'b', parentId: 'sec', role: 'text', text: 'b', boxAbsolute: box(0, 40, 10, 10) },
    { id: 'a', parentId: 'sec', role: 'text', text: 'a', boxAbsolute: box(0, 10, 10, 10) },
  ];
  const one = buildElementSet(snapshot('web', nodes), 'sec', CFG);
  const two = buildElementSet(snapshot('web', nodes), 'sec', CFG);
  assert.deepEqual(one, two);
  assert.deepEqual(one.elements.map((e) => e.id), ['a', 'b'], 'reading order, not tree order');
});
