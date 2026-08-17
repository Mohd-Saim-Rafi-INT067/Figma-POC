/**
 * Unit tests for E3 - the structural verdict.
 *
 * The rule under test is a SEMANTIC one, and it is the reason this stage was
 * rewritten: an element without a counterpart is NOT ALIGNED, never "missing".
 * At 33.5% measured correspondence recall, the original vocabulary would have
 * asserted that two thirds of every design was absent from a page that builds
 * it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { structuralVerdict } from '../src/compare/structural.js';
import { correspondGroups } from '../src/compare/repeated.js';

const CFG = { minCoverageForClaims: 0.6, minGroupSizeForClaim: 3, minComponentWitnesses: 3, minInstancesForSlotClaim: 2, maxChanceOfSlotClaim: 0.05 };

/** Minimal E1-shaped element. */
const el = (i, over = {}) => ({
  id: `e${i}`,
  cls: over.cls ?? 'box',
  box: { x: over.x ?? 0, y: over.y ?? i * 50, w: 100, h: 40 },
  yRel: 0,
  hasText: false,
  templateId: over.templateId ?? null,
  templateIndex: over.templateIndex ?? null,
  sourceRef: { figmaNodeId: `f${i}`, webSelector: `sel${i}` },
});

const set = (elements, groups = []) => ({ elements, repeatedGroups: groups });
const group = (templateId, count) => ({ templateId, count, memberIds: [] });

test('E3: an unaligned element is "not-aligned", never "missing"', () => {
  const figma = set([el(0), el(1), el(2)]);
  const web = set([el(0)]);
  const v = structuralVerdict(figma, web, [{ figmaIndex: 0, webIndex: 0, tier: 'anchor', confidence: 0.9 }], CFG);

  assert.equal(v.aligned.length, 1);
  assert.equal(v.unalignedFigma.length, 2);
  for (const u of v.unalignedFigma) assert.equal(u.reason, 'not-aligned');

  // The whole point: no claim is made about the page.
  assert.equal(v.findings.length, 0);
  const json = JSON.stringify(v);
  assert.ok(!/missing/i.test(json), 'the verdict must not contain the word "missing"');
});

test('E3: dummy-vs-real instance counts produce ZERO findings', () => {
  // The plan's exit criterion. Design shows 3 sample cards; production renders 12.
  const figmaCards = [0, 1, 2].map((i) => el(i, { templateId: 'F', templateIndex: i }));
  const webCards = Array.from({ length: 12 }, (_, i) => el(i, { templateId: 'W', templateIndex: i }));
  const figma = set(figmaCards, [group('F', 3)]);
  const web = set(webCards, [group('W', 12)]);

  // All three designed cards aligned to the first three built ones.
  const pairs = [0, 1, 2].map((i) => ({ figmaIndex: i, webIndex: i, tier: 'anchor', confidence: 0.9 }));
  const v = structuralVerdict(figma, web, pairs, CFG);

  assert.equal(v.findings.length, 0, 'a count difference is data volume, not a defect');
  assert.equal(v.suppressedCountDifferences.length, 1);
  assert.deepEqual(
    { f: v.suppressedCountDifferences[0].figmaCount, w: v.suppressedCountDifferences[0].webCount },
    { f: 3, w: 12 }
  );
});

test('E3: surplus DESIGN instances are labelled dummy, not absent', () => {
  // The mirror case: design shows 5, page builds 2. The three unaligned design
  // cards are surplus dummy content, and saying so is different from saying the
  // page is missing three cards.
  const figma = set([0, 1, 2, 3, 4].map((i) => el(i, { templateId: 'F', templateIndex: i })), [group('F', 5)]);
  const web = set([0, 1].map((i) => el(i, { templateId: 'W', templateIndex: i })), [group('W', 2)]);
  const pairs = [0, 1].map((i) => ({ figmaIndex: i, webIndex: i, tier: 'anchor', confidence: 0.9 }));

  const v = structuralVerdict(figma, web, pairs, CFG);
  const dummies = v.unalignedFigma.filter((u) => u.reason === 'dummy-instance');
  assert.equal(dummies.length, 3);
  assert.equal(v.coverage.dummyInstances, 3);
  assert.equal(v.findings.length, 0);
});

test('E3: group correspondence is inferred from element correspondence', () => {
  const figma = set([0, 1, 2].map((i) => el(i, { templateId: 'F', templateIndex: i })), [group('F', 3)]);
  const web = set([0, 1, 2].map((i) => el(i, { templateId: 'W', templateIndex: i })), [group('W', 3)]);
  const links = correspondGroups(figma, web, [
    { figmaIndex: 0, webIndex: 0 }, { figmaIndex: 1, webIndex: 1 },
  ]);
  assert.equal(links.linked.length, 1);
  assert.equal(links.linked[0].witnesses, 2, 'two aligned members witness the group pairing');
  assert.deepEqual([links.linked[0].figmaGroup, links.linked[0].webGroup], ['F', 'W']);
});

test('E3: a claim needs healthy coverage AND a whole absent group', () => {
  const figmaCards = [0, 1, 2].map((i) => el(i, { templateId: 'F', templateIndex: i }));
  const others = [el(3), el(4), el(5), el(6)];
  const figma = set([...figmaCards, ...others], [group('F', 3)]);
  const web = set([el(0), el(1), el(2), el(3)]);

  // Coverage 4/7 = 0.57, below the floor: the matcher is struggling, so absence
  // is not evidence and nothing is claimed.
  const weak = structuralVerdict(figma, web, [
    { figmaIndex: 3, webIndex: 0 }, { figmaIndex: 4, webIndex: 1 },
    { figmaIndex: 5, webIndex: 2 }, { figmaIndex: 6, webIndex: 3 },
  ], CFG);
  assert.ok(weak.coverage.figma < CFG.minCoverageForClaims);
  assert.equal(weak.findings.length, 0, 'no claims while correspondence is weak');

  // Same absent group, but with coverage above the floor: now it is evidence.
  const big = [...figmaCards, ...Array.from({ length: 8 }, (_, i) => el(10 + i))];
  const strong = structuralVerdict(
    set(big, [group('F', 3)]),
    set(Array.from({ length: 8 }, (_, i) => el(i))),
    Array.from({ length: 8 }, (_, i) => ({ figmaIndex: 3 + i, webIndex: i, tier: 'anchor', confidence: 0.9 })),
    CFG
  );
  assert.ok(strong.coverage.figma >= CFG.minCoverageForClaims);
  assert.equal(strong.findings.length, 1);
  assert.equal(strong.findings[0].kind, 'group-absent-in-web');
});

test('E3: coverage is reported honestly on both sides', () => {
  const figma = set([el(0), el(1), el(2), el(3)]);
  const web = set([el(0), el(1)]);
  const v = structuralVerdict(figma, web, [{ figmaIndex: 0, webIndex: 0, tier: 'anchor', confidence: 0.9 }], CFG);
  assert.equal(v.coverage.figma, 0.25);
  assert.equal(v.coverage.web, 0.5);
  assert.equal(v.coverage.alignedPairs, 1);
});

test('E3: a button removed from a card template produces EXACTLY ONE finding', () => {
  // The plan's second exit criterion. The design's card has a title AND a
  // button; the page builds only the title - across all four instances.
  // Without template propagation the buttons carry no group identity and this
  // is undetectable; with it, the slot never aligns and is reported ONCE.
  const N = 4;
  const figma = [], web = [], pairs = [];
  const groups = { figma: [], web: [] };

  for (let i = 0; i < N; i++) {
    const cardF = el(i * 10, { templateId: 'F', templateIndex: i });
    const titleF = { ...el(i * 10 + 1, { cls: 'text' }), parentId: cardF.id, templateId: 'F', templateIndex: i, templateSlot: '0' };
    const buttonF = { ...el(i * 10 + 2, { cls: 'control' }), parentId: cardF.id, templateId: 'F', templateIndex: i, templateSlot: '1' };
    figma.push(cardF, titleF, buttonF);

    const cardW = el(i * 10, { templateId: 'W', templateIndex: i });
    const titleW = { ...el(i * 10 + 1, { cls: 'text' }), parentId: cardW.id, templateId: 'W', templateIndex: i, templateSlot: '0' };
    web.push(cardW, titleW);

    // Cards and titles align; the button has nothing to align to.
    pairs.push({ figmaIndex: i * 3, webIndex: i * 2, tier: 'anchor', confidence: 0.9 });
    pairs.push({ figmaIndex: i * 3 + 1, webIndex: i * 2 + 1, tier: 'anchor', confidence: 0.9 });
  }
  groups.figma.push({ templateId: 'F', count: N, memberIds: [] });
  groups.web.push({ templateId: 'W', count: N, memberIds: [] });

  const v = structuralVerdict(set(figma, groups.figma), set(web, groups.web), pairs, CFG);
  const slotFindings = v.findings.filter((f) => f.kind === 'slot-absent-in-web');

  assert.equal(slotFindings.length, 1, 'one finding for the slot, not one per instance');
  assert.equal(slotFindings[0].cls, 'control');
  assert.equal(slotFindings[0].instances, N, 'the finding knows it affects all four instances');
  assert.equal(v.findings.length, 1, 'and nothing else is claimed');
});

test('E3: a slot that aligns in ANY instance is not a composition finding', () => {
  // Correspondence is imperfect; a slot matching in only some instances means
  // the matcher struggled, not that the component differs.
  const figma = [], web = [], pairs = [];
  for (let i = 0; i < 3; i++) {
    const cardF = el(i * 10, { templateId: 'F', templateIndex: i });
    const titleF = { ...el(i * 10 + 1, { cls: 'text' }), parentId: cardF.id, templateId: 'F', templateIndex: i, templateSlot: '0' };
    const btnF = { ...el(i * 10 + 2, { cls: 'control' }), parentId: cardF.id, templateId: 'F', templateIndex: i, templateSlot: '1' };
    figma.push(cardF, titleF, btnF);
    const cardW = el(i * 10, { templateId: 'W', templateIndex: i });
    const titleW = { ...el(i * 10 + 1, { cls: 'text' }), parentId: cardW.id, templateId: 'W', templateIndex: i, templateSlot: '0' };
    const btnW = { ...el(i * 10 + 2, { cls: 'control' }), parentId: cardW.id, templateId: 'W', templateIndex: i, templateSlot: '1' };
    web.push(cardW, titleW, btnW);
    pairs.push({ figmaIndex: i * 3, webIndex: i * 3, tier: 'anchor', confidence: 0.9 });
    pairs.push({ figmaIndex: i * 3 + 1, webIndex: i * 3 + 1, tier: 'anchor', confidence: 0.9 });
  }
  // Only ONE of the three buttons aligned.
  pairs.push({ figmaIndex: 2, webIndex: 2, tier: 'anchor', confidence: 0.9 });

  const v = structuralVerdict(
    set(figma, [{ templateId: 'F', count: 3, memberIds: [] }]),
    set(web, [{ templateId: 'W', count: 3, memberIds: [] }]),
    pairs, CFG
  );
  assert.equal(v.findings.filter((f) => f.kind === 'slot-absent-in-web').length, 0);
});

test('E4: fan-in does not make one page element collect a finding twice', async () => {
  const { compareElementPairs } = await import('../src/compare/properties.js');

  // The documented shape: a design button frame and its label, both correctly
  // corresponding to one built <button> (E2d manyToOne). Both carry a radius
  // that disagrees with the page, so without deduplication the page element
  // collects the same finding twice.
  const mk = (id, cls, w, h, extra = {}) => ({
    id, cls, box: { x: 0, y: 0, w, h }, yRel: 0, parentId: null,
    sourceRef: { figmaNodeId: id, webSelector: id }, ...extra,
  });
  const node = (id, radius) => ({
    id, role: 'container', text: null, type: null,
    fill: { backgroundColor: null, gradients: [], imageRef: null, paints: [] },
    border: { width: [0, 0, 0, 0], color: null, radius: [radius, radius, radius, radius], inset: true },
    effects: [], opacity: 1, children: [],
  });

  const pair = {
    figmaIndex: 0, webIndex: 0, confidence: 1,
    figma: { sectionId: 'fsec', elements: [mk('btn', 'control', 200, 60), mk('label', 'text', 160, 20)] },
    web: { sectionId: 'wsec', elements: [mk('w0', 'control', 195, 64)] },
  };
  const nodes = {
    figma: new Map([['btn', node('btn', 24)], ['label', node('label', 24)]]),
    web: new Map([['w0', node('w0', 4)]]),
  };
  const tol = {
    rules: { 'border.radius': { match: 'abs', tolerance: 1, severity: 'medium' } },
    elementCompare: {},
  };

  const aligned = [
    { figmaIndex: 0, webIndex: 0, confidence: 0.9 },
    { figmaIndex: 1, webIndex: 0, confidence: 0.8 },
  ];
  const findings = compareElementPairs(pair, aligned, nodes, tol);
  const radius = findings.filter((f) => f.property === 'border.radius');

  assert.equal(radius.length, 1, 'one page element, one radius verdict');
  assert.equal(radius[0].element.figmaIndex, 0, 'attributed to the class-matching member, not the label');
});
