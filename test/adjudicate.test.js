/**
 * Unit tests for E2c/E2d - shortlist adjudication and verification.
 *
 * The properties here are the ones the architecture's safety rests on: that the
 * model cannot name an element it was not offered, that a measured value cannot
 * reach the prompt, and that fan-in is permitted only for the shape the ground
 * truth documents.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPrompt, NO_MATCH, RESPONSE_SCHEMA } from '../src/correspond/llm.js';
import { verifyAssignments, combine } from '../src/correspond/verify.js';

const CFG = {
  classCompatibility: { 'glyph~text': 0.6, default: 0.35 },
  confidenceGate: { report: 0.85, lowConfidence: 0.6 },
  manyToOne: { enabled: true, maxFanIn: 4 },
};

const el = (id, cls, x, y, w, h, extra = {}) => ({
  id, cls, box: { x, y, w, h }, yRel: 0, parentId: null,
  textKey: null, templateId: null, templateIndex: null, ...extra,
});

/** figmaSet/webSet/shortlists/askedBy for a section, from plain element arrays. */
function section(figmaEls, webEls, picks) {
  return {
    figmaSet: { elements: figmaEls },
    webSet: { elements: webEls },
    shortlists: new Map(picks.map((list, i) => [i, list.map((webIndex) => ({ webIndex }))])),
    asked: new Set(figmaEls.map((_, i) => i)),
    sectionConfidence: 1,
    cfg: CFG,
  };
}

const answer = (f, pick, confidence = 0.9, extra = {}) =>
  ({ f, pick, confidence, reason: 'matched', descriptor: 'thing', ...extra });

test('E2c: the only numbers the model may return are two indices and a confidence', () => {
  // The boundary is "the model decides identity, code decides values". Both `f`
  // and `pick` are positions in lists this code supplied - they address elements,
  // they do not measure them - and `confidence` is the one quantity the model is
  // entitled to originate. Anything else appearing here would be a field a
  // measurement could arrive in.
  const props = RESPONSE_SCHEMA.properties.assignments.items.properties;
  const numeric = Object.entries(props).filter(([, v]) => v.type === 'NUMBER' || v.type === 'INTEGER');
  assert.deepEqual(numeric.map(([k]) => k).sort(), ['confidence', 'f', 'pick']);
  assert.equal(props.f.type, 'INTEGER', 'an index cannot be mistyped the way an id can');
  assert.equal(props.pick.type, 'INTEGER');
});

test('E2c: the prompt carries text and geometry but never a measured value', () => {
  const figmaEl = el('f1', 'text', 10, 20, 100, 30, { textKey: 'get started' });
  const candidate = el('w1', 'text', 12, 22, 98, 28, {
    textKey: 'get started free',
    // Fields a measured record carries that must not reach the model.
    fill: { backgroundColor: { r: 131, g: 92, b: 245, a: 1 } },
    styleSignature: 'text|bg|-|-|-|round|-|Inter|2|2',
  });

  const prompt = buildPrompt([{ index: 12, figmaEl, candidates: [candidate] }]);

  assert.ok(prompt.includes('get started'), 'text is an identity signal and is sent');
  assert.ok(prompt.includes('DESIGN (12)'), 'the design element is addressed by number, never by id');
  assert.ok(!prompt.includes('f1'), 'the raw element id is not in the prompt at all — it cannot be copied wrongly');
  assert.ok(prompt.includes('[0]'), 'candidates are numbered so the answer can be an index');
  assert.ok(!prompt.includes('835CF5') && !prompt.includes('245'), 'no colour reaches the prompt');
  assert.ok(!prompt.includes('styleSignature') && !prompt.includes('Inter'), 'no style value reaches the prompt');
});

test('E2d: a pick outside the offered list is rejected, not clamped', () => {
  const ctx = section([el('f0', 'text', 0, 0, 10, 10)], [el('w0', 'text', 0, 0, 10, 10)], [[0]]);
  const { accepted, counts } = verifyAssignments([answer(0, 7)], ctx);
  assert.equal(accepted.length, 0);
  assert.equal(counts.pickOutOfRange, 1);
});

test('E2d: a design element never asked about is a harness bug, and is counted as one', () => {
  const ctx = section([el('f0', 'text', 0, 0, 10, 10)], [el('w0', 'text', 0, 0, 10, 10)], [[0]]);
  const { counts, rejected } = verifyAssignments([answer(99, 0)], ctx);
  assert.equal(counts.phantomId, 1);
  assert.match(rejected[0].reason, /HARNESS BUG/);
});

test('E2d: -1 declines without producing a pair', () => {
  const ctx = section([el('f0', 'text', 0, 0, 10, 10)], [el('w0', 'text', 0, 0, 10, 10)], [[0]]);
  const { accepted, counts } = verifyAssignments([answer(0, NO_MATCH)], ctx);
  assert.equal(accepted.length, 0);
  assert.equal(counts.declined, 1);
  assert.equal(counts.pickOutOfRange, 0, 'declining is not an invalid index');
});

test('E2d: two unrelated design elements cannot claim one page element', () => {
  const figmaEls = [el('f0', 'text', 0, 0, 10, 10), el('f1', 'text', 500, 0, 10, 10)];
  const ctx = section(figmaEls, [el('w0', 'text', 0, 0, 10, 10)], [[0], [0]]);

  const { accepted, counts } = verifyAssignments(
    [answer(0, 0, 0.9), answer(1, 0, 0.7)], ctx,
  );
  assert.equal(accepted.length, 1, 'only the more confident claim survives');
  assert.equal(accepted[0].figmaIndex, 0);
  assert.equal(counts.fanInRefused, 1);
});

test('E2d: fan-in IS permitted along one ancestor chain', () => {
  // The documented shape: a button container and its label, where the page
  // builds a single element carrying both. They are on one chain, and they
  // carry different comparable properties, so both must survive.
  const figmaEls = [
    el('btn', 'control', 520, 401, 201, 60),
    el('label', 'text', 540, 421, 161, 20, { parentId: 'btn' }),
  ];
  const ctx = section(figmaEls, [el('w0', 'control', 540, 438, 195, 64)], [[0], [0]]);

  const { accepted, counts } = verifyAssignments(
    [answer(0, 0, 0.9), answer(1, 0, 0.8)], ctx,
  );
  assert.equal(accepted.length, 2, 'both design elements legitimately map to the one built element');
  assert.equal(counts.fanInRefused, 0);
});

test('E2d: conflict resolution does not depend on the order the model answered in', () => {
  const figmaEls = [el('f0', 'text', 0, 0, 10, 10), el('f1', 'text', 500, 0, 10, 10)];
  const mk = () => section(figmaEls, [el('w0', 'text', 0, 0, 10, 10)], [[0], [0]]);

  const forward = verifyAssignments([answer(0, 0, 0.7), answer(1, 0, 0.9)], mk());
  const reverse = verifyAssignments([answer(1, 0, 0.9), answer(0, 0, 0.7)], mk());

  assert.equal(forward.accepted[0].figmaIndex, 1);
  assert.deepEqual(forward.accepted.map((a) => a.figmaIndex), reverse.accepted.map((a) => a.figmaIndex));
});

test('E2d: section confidence multiplies in and can sink a claim', () => {
  const ctx = section([el('f0', 'text', 0, 0, 10, 10)], [el('w0', 'text', 0, 0, 10, 10)], [[0]]);
  const { accepted, counts } = verifyAssignments([answer(0, 0, 0.7)], { ...ctx, sectionConfidence: 0.5 });
  assert.equal(accepted.length, 0, '0.7 * 0.5 = 0.35, below the 0.6 floor');
  assert.equal(counts.belowFloor, 1);
});

test('E2d: template instances must correspond index for index', () => {
  const figmaEls = [el('f0', 'text', 0, 0, 10, 10, { templateId: 'tpl:a', templateIndex: 0 })];
  const webEls = [el('w0', 'text', 0, 0, 10, 10, { templateId: 'tpl:b', templateIndex: 3 })];
  const ctx = section(figmaEls, webEls, [[0]]);

  const { accepted, counts } = verifyAssignments([answer(0, 0)], ctx);
  assert.equal(accepted.length, 0, 'card 1 must not pair with card 4');
  assert.equal(counts.templateMismatch, 1);
});

test('E2d: a deterministic anchor beats an adjudicated pair for the same element', () => {
  const anchors = [{ figmaIndex: 0, webIndex: 0, confidence: 0.9, tier: 'anchor' }];
  const adjudicated = [
    { figmaIndex: 0, webIndex: 5, confidence: 0.95, tier: 'llm' },
    { figmaIndex: 2, webIndex: 7, confidence: 0.8, tier: 'llm' },
  ];
  const merged = combine(anchors, adjudicated);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((p) => p.figmaIndex), [0, 2]);
  assert.equal(merged[0].tier, 'anchor');
});

test('E6/E2: a scroll-driven section is matched to its settled-scroll capture', async () => {
  const { pinnedForSection } = await import('../src/evidence/capture.js');

  // Shapes taken from the reference run: the pinned capture is the settled
  // sticky viewport (900px) while the section is the scroll container that
  // houses it (3,495px). Matching on height would reject exactly these.
  const manifest = [
    { path: 'pinned-00.png', originY: 4055, width: 615, height: 900 },
    { path: 'pinned-02.png', originY: 8263, width: 1920, height: 900 },
  ];

  assert.equal(pinnedForSection(manifest, { y: 8263, height: 900 })?.path, 'pinned-02.png');
  assert.equal(pinnedForSection(manifest, { y: 4055, height: 3495 })?.path, 'pinned-00.png',
    'height must not be part of the match');
  assert.equal(pinnedForSection(manifest, { y: 4060, height: 3495 })?.path, 'pinned-00.png',
    'origins within tolerance still match');
  assert.equal(pinnedForSection(manifest, { y: 12913, height: 1116 }), null,
    'an ordinary section gets no pinned capture');
  assert.equal(pinnedForSection([], { y: 8263 }), null);
});

test('E6/E2: where pinned containers nest, the outermost viewport wins', () => {
  const manifest = [
    { path: 'inner.png', originY: 4055, width: 615, height: 900 },
    { path: 'outer.png', originY: 4055, width: 1920, height: 900 },
  ];
  // Not cosmetic: the section corresponds to the outermost pinned viewport, and
  // picking the inner one would crop most of the section out of its own evidence.
  return import('../src/evidence/capture.js').then(({ pinnedForSection }) => {
    assert.equal(pinnedForSection(manifest, { y: 4055 }).path, 'outer.png');
  });
});
