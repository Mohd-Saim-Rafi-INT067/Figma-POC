/**
 * Unit tests for the deterministic core.
 *
 * These cover the functions where a silent regression would corrupt every
 * finding downstream without ever throwing: colour maths, text normalization,
 * font-weight resolution, prune fixpoint, and sequence alignment.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeColor, makeColorFromFigma, rgbToOklab, oklabToRgb, deltaEOK,
  compositeOver, parseCssColor, splitTopLevel, toHex, isTransparent,
} from '../src/ir/color.js';
import { normalizeText, isNumericLike, resolveTextTransform, textHash } from '../src/ir/text.js';
import { parsePostScriptName, resolveFigmaFont, isPlausibleCssWeight, familyKey } from '../src/ir/fonts.js';
import { pruneSnapshot } from '../src/pipeline/prune.js';
import { measureSpacing } from '../src/pipeline/spacing.js';
import { alignSections } from '../src/sections/match.js';
import { assembleFindings } from '../src/report/findings.js';
import { makeNode, makeSnapshot } from '../src/ir/schema.js';

// ---------------------------------------------------------------- colour ---

test('color: OKLCH lightness anchors', () => {
  assert.ok(Math.abs(makeColor(255, 255, 255).oklch[0] - 1) < 1e-6);
  assert.ok(Math.abs(makeColor(0, 0, 0).oklch[0]) < 1e-6);
});

test('color: grey is achromatic — hue pinned, not float dust', () => {
  assert.equal(makeColor(128, 128, 128).oklch[1], 0);
  assert.equal(makeColor(128, 128, 128).oklch[2], 0);
});

test('color: RGB -> OKLab -> RGB round-trips exactly', () => {
  for (const [r, g, b] of [[131, 92, 245], [28, 32, 37], [250, 249, 255], [0, 0, 0], [255, 255, 255]]) {
    assert.deepEqual(oklabToRgb(...rgbToOklab(r, g, b)), [r, g, b]);
  }
});

test('color: deltaEOK scaling puts full lightness range at 100', () => {
  assert.ok(Math.abs(deltaEOK(makeColor(255, 255, 255), makeColor(0, 0, 0)) - 100) < 0.01);
  assert.equal(deltaEOK(makeColor(10, 20, 30), makeColor(10, 20, 30)), 0);
});

test('color: Figma float and CSS int for the same colour are perceptually identical', () => {
  // The exact case that motivates deltaE over hex equality.
  const figma = makeColorFromFigma({ r: 0.5137254901960784, g: 0.36078431372549019, b: 0.9607843137254902, a: 1 });
  const css = parseCssColor('rgb(131, 92, 245)');
  assert.equal(toHex(figma), '#835CF5');
  assert.ok(deltaEOK(figma, css) < 0.001);
});

test('color: alpha composites over a backdrop', () => {
  assert.equal(toHex(compositeOver(makeColor(0, 0, 0, 0.5), makeColor(255, 255, 255))), '#808080');
});

test('color: parses both computed CSS syntaxes, and transparent', () => {
  assert.equal(toHex(parseCssColor('rgb(255, 0, 0)')), '#FF0000');
  assert.equal(parseCssColor('rgba(0, 0, 0, 0.25)').a, 0.25);
  assert.equal(parseCssColor('rgb(0 128 255 / 50%)').a, 0.5);
  assert.ok(isTransparent(parseCssColor('rgba(0, 0, 0, 0)')));
  assert.equal(parseCssColor('not-a-color'), null);
});

test('color: splitTopLevel does not break inside rgba()', () => {
  // A naive split on "," turns one shadow into five fragments.
  const shadows = splitTopLevel('rgba(0,0,0,.1) 0 1px 2px, rgba(0,0,0,.2) 0 2px 4px');
  assert.equal(shadows.length, 2);
  assert.ok(shadows[1].startsWith('rgba(0,0,0,.2)'));
});

// ------------------------------------------------------------------ text ---

test('text: both sides normalize identically across unicode noise', () => {
  const a = normalizeText('  Get Started​  ');
  const b = normalizeText('get started');
  assert.equal(a, b, 'nbsp + zero-width + case must collapse to the same anchor');
});

test('text: transform is applied before casefold', () => {
  assert.equal(normalizeText('get started', { textTransform: 'uppercase' }), 'get started');
  assert.equal(normalizeText('Get Started', { display: true }), 'Get Started');
});

test('text: figma and CSS transform vocabularies map to one enum', () => {
  assert.equal(resolveTextTransform('UPPER'), 'uppercase');
  assert.equal(resolveTextTransform('uppercase'), 'uppercase');
  assert.equal(resolveTextTransform('TITLE'), 'capitalize');
  assert.equal(resolveTextTransform(undefined), 'none');
});

test('text: numeric-like strings are identified for anchor down-weighting', () => {
  assert.ok(isNumericLike('1,204'));
  assert.ok(isNumericLike('$549'));
  assert.ok(isNumericLike('12/03/2026'));
  assert.ok(!isNumericLike('ai-native transformation'));
  assert.ok(!isNumericLike(null));
});

test('text: hash is stable and differs on different input', () => {
  assert.equal(textHash('hello'), textHash('hello'));
  assert.notEqual(textHash('hello'), textHash('hellp'));
});

// ----------------------------------------------------------------- fonts ---

test('fonts: PostScript names resolve weight and style', () => {
  assert.deepEqual(parsePostScriptName('Geist-SemiBold'), { weight: 600, italic: false, source: 'postscript' });
  assert.deepEqual(parsePostScriptName('Inter-BoldItalic'), { weight: 700, italic: true, source: 'postscript' });
  assert.equal(parsePostScriptName('Arial-BoldMT').weight, 700, 'foundry suffix MT must not defeat matching');
  assert.equal(parsePostScriptName('DMMono-Regular').weight, 400);
  assert.equal(parsePostScriptName('Inter-Italic').weight, 400);
  assert.equal(parsePostScriptName('Helvetica'), null);
});

test('fonts: longest keyword wins — SemiBold is not Bold', () => {
  assert.equal(parsePostScriptName('X-SemiBold').weight, 600);
  assert.equal(parsePostScriptName('X-ExtraBold').weight, 800);
  assert.equal(parsePostScriptName('X-ExtraLight').weight, 200);
  assert.equal(parsePostScriptName('X-UltraBlack').weight, 950);
});

test('fonts: Q8 — variable-font axis values are rejected, PostScript wins', () => {
  // Geist reports its raw weight axis. Taken at face value this emits phantom
  // "the design uses 10 font weights" findings.
  assert.ok(!isPlausibleCssWeight(84));
  assert.ok(!isPlausibleCssWeight(126));
  assert.ok(isPlausibleCssWeight(400));
  assert.ok(isPlausibleCssWeight(600));

  const resolved = resolveFigmaFont({ fontFamily: 'Geist', fontPostScriptName: 'Geist-SemiBold', fontWeight: 126 });
  assert.equal(resolved.weight, 600);
  assert.equal(resolved.weightSource, 'postscript');
});

test('fonts: falls back to the declared weight only when plausible', () => {
  const ok = resolveFigmaFont({ fontFamily: 'Inter', fontPostScriptName: null, fontWeight: 500 });
  assert.equal(ok.weight, 500);
  assert.equal(ok.weightSource, 'figma-fontWeight');

  const bad = resolveFigmaFont({ fontFamily: 'X', fontPostScriptName: null, fontWeight: 137 });
  assert.equal(bad.weight, 400);
  assert.equal(bad.weightSource, 'fallback', 'an unresolved weight must be flagged, never silently reported');
});

test('fonts: familyKey collapses spacing differences', () => {
  assert.equal(familyKey('DM Mono'), familyKey('DMMono'));
  assert.equal(familyKey('Public Sans'), familyKey('PublicSans'));
});

// ----------------------------------------------------------------- prune ---

const webNode = (id, parentId, box, over = {}) =>
  makeNode({
    id, parentId,
    boxAbsolute: box, boxRelative: box,
    children: over.children ?? [],
    fill: { backgroundColor: over.bg ?? null, paints: over.bg ? [over.bg] : [] },
    text: over.text ?? null,
    _web: { tag: 'div', display: over.display ?? 'block', visibility: over.visibility ?? 'visible', overflowX: 'visible', overflowY: 'visible' },
    opacity: over.opacity ?? 1,
  });

test('prune: drops invisible nodes and reparents their surviving children', () => {
  const box = { x: 0, y: 0, w: 100, h: 100 };
  const snap = makeSnapshot({
    side: 'web', rootId: 'r', sourceVersion: null,
    nodes: [
      webNode('r', null, box, { bg: makeColor(255, 255, 255), children: ['hidden'] }),
      webNode('hidden', 'r', box, { display: 'none', children: ['kid'] }),
      webNode('kid', 'hidden', { x: 0, y: 0, w: 50, h: 50 }, { bg: makeColor(1, 2, 3) }),
    ],
  });
  const { snapshot } = pruneSnapshot(snap);
  const ids = snapshot.nodes.map((n) => n.id);
  assert.ok(!ids.includes('hidden'));
  assert.ok(ids.includes('kid'), 'a visible child of a hidden parent must survive');
  assert.equal(snapshot.nodes.find((n) => n.id === 'kid').parentId, 'r', 'must reparent to nearest survivor');
});

test('prune: collapses transparent wrappers to fixpoint', () => {
  const box = { x: 0, y: 0, w: 100, h: 100 };
  const snap = makeSnapshot({
    side: 'web', rootId: 'r', sourceVersion: null,
    nodes: [
      webNode('r', null, box, { bg: makeColor(255, 255, 255), children: ['w1'] }),
      webNode('w1', 'r', box, { children: ['w2'] }),   // paints nothing
      webNode('w2', 'w1', box, { children: ['leaf'] }), // paints nothing
      webNode('leaf', 'w2', box, { bg: makeColor(9, 9, 9) }),
    ],
  });
  const { snapshot, stats } = pruneSnapshot(snap);
  assert.deepEqual(snapshot.nodes.map((n) => n.id).sort(), ['leaf', 'r']);
  assert.ok(stats.reasons['wrapper-collapsed'] >= 2);
});

test('prune: recomputes boxRelative after reparenting', () => {
  // Reparenting silently invalidates parent-relative geometry, which is what
  // every geometry comparison uses.
  const snap = makeSnapshot({
    side: 'web', rootId: 'r', sourceVersion: null,
    nodes: [
      webNode('r', null, { x: 0, y: 0, w: 200, h: 200 }, { bg: makeColor(255, 255, 255), children: ['gone'] }),
      webNode('gone', 'r', { x: 10, y: 10, w: 100, h: 100 }, { display: 'none', children: ['kid'] }),
      webNode('kid', 'gone', { x: 40, y: 60, w: 20, h: 20 }, { bg: makeColor(1, 1, 1) }),
    ],
  });
  const { snapshot } = pruneSnapshot(snap);
  const kid = snapshot.nodes.find((n) => n.id === 'kid');
  assert.deepEqual({ x: kid.boxRelative.x, y: kid.boxRelative.y }, { x: 40, y: 60 });
});

test('prune: a rule that would drop the root throws rather than corrupting', () => {
  const snap = makeSnapshot({
    side: 'web', rootId: 'r', sourceVersion: null,
    nodes: [webNode('r', null, { x: 0, y: 0, w: 0, h: 0 })],
  });
  assert.throws(() => pruneSnapshot(snap), /root node/);
});

// --------------------------------------------------------------- spacing ---

test('spacing: infers direction from geometry and measures gaps', () => {
  const kids = ['a', 'b', 'c'].map((id, i) =>
    webNode(id, 'r', { x: 0, y: i * 60, w: 100, h: 40 }, { bg: makeColor(1, 1, 1) })
  );
  const snap = makeSnapshot({
    side: 'web', rootId: 'r', sourceVersion: null,
    nodes: [webNode('r', null, { x: 0, y: 0, w: 100, h: 200 }, { bg: makeColor(2, 2, 2), children: ['a', 'b', 'c'] }), ...kids],
  });
  const { snapshot } = measureSpacing(snap);
  const root = snapshot.nodes.find((n) => n.id === 'r');
  assert.equal(root.layout.direction, 'column');
  assert.deepEqual(root.layout.gapsMeasured, [20, 20]);
  assert.equal(root.layout.gapMeasured, 20);
});

test('spacing: overlapping siblings yield no gap, never a negative one', () => {
  const kids = ['a', 'b'].map((id, i) =>
    webNode(id, 'r', { x: 0, y: i * 10, w: 100, h: 40 }, { bg: makeColor(1, 1, 1) })
  );
  const snap = makeSnapshot({
    side: 'web', rootId: 'r', sourceVersion: null,
    nodes: [webNode('r', null, { x: 0, y: 0, w: 100, h: 100 }, { bg: makeColor(2, 2, 2), children: ['a', 'b'] }), ...kids],
  });
  const { snapshot } = measureSpacing(snap);
  const gaps = snapshot.nodes.find((n) => n.id === 'r').layout.gapsMeasured;
  assert.ok(gaps.every((g) => g >= 0), 'a negative "gap" is an overlap and would corrupt the spacing scale');
});

// --------------------------------------------------------------- matching ---

const section = (index, height, anchors = [], count = 10) => ({
  index, id: `s${index}`, height, width: 1920,
  normalizedY: index / 10, normalizedHeight: height / 10000,
  label: `s${index}`, headline: anchors[0] ?? null,
  digest: {
    textAnchors: anchors, colorSet: ['1,1,1,1'], colors: [], fontSizeSet: [16],
    fontWeightSet: [400], fontFamilySet: ['X'], radiusSet: [], spacingHistogram: {},
    nodeCount: count, background: null, renderedFonts: {}, unstableNodes: 0,
  },
});

const MATCH_CFG = {
  weights: { position: 0.35, height: 0.25, textAnchors: 0.3, digest: 0.1 },
  gapPenalty: 0.6, confidenceFloor: 0.45,
};

test('matching: aligns identical section lists 1:1', () => {
  const list = [section(0, 500, ['alpha']), section(1, 600, ['beta']), section(2, 700, ['gamma'])];
  const { pairs, stats } = alignSections(list, list.map((s) => ({ ...s })), MATCH_CFG);
  assert.equal(stats.matched, 3);
  assert.equal(stats.missingInWeb + stats.extraInWeb, 0);
  pairs.forEach((p) => assert.equal(p.figma.index, p.web.index));
});

test('matching: an inserted page section becomes a gap, not a shift', () => {
  // The real failure mode this guards: without gap support, one extra section
  // offsets every pair after it and every finding downstream is wrong.
  const figma = [section(0, 500, ['alpha']), section(1, 600, ['beta']), section(2, 700, ['gamma'])];
  const web = [
    section(0, 90, ['header']),
    section(1, 500, ['alpha']), section(2, 600, ['beta']), section(3, 700, ['gamma']),
  ];
  const { pairs, stats } = alignSections(figma, web, MATCH_CFG);
  assert.equal(stats.extraInWeb, 1);
  assert.equal(stats.matched, 3);
  const matched = pairs.filter((p) => p.figma && p.web);
  matched.forEach((p) => assert.equal(p.web.index, p.figma.index + 1));
});

test('matching: a designed-but-unbuilt section reports missing-in-web', () => {
  const figma = [section(0, 500, ['alpha']), section(1, 600, ['beta']), section(2, 700, ['gamma'])];
  const web = [section(0, 500, ['alpha']), section(1, 700, ['gamma'])];
  const { stats } = alignSections(figma, web, MATCH_CFG);
  assert.equal(stats.missingInWeb, 1);
  assert.equal(stats.matched, 2);
});

test('matching: order is preserved — sections cannot cross', () => {
  const figma = [section(0, 500, ['alpha']), section(1, 600, ['beta'])];
  const web = [section(0, 600, ['beta']), section(1, 500, ['alpha'])];
  const { pairs } = alignSections(figma, web, MATCH_CFG);
  const matched = pairs.filter((p) => p.figma && p.web);
  for (let i = 1; i < matched.length; i++) {
    assert.ok(matched[i].web.index > matched[i - 1].web.index, 'alignment must stay monotonic');
  }
});

test('matching: word overlap rescues a rewritten headline', () => {
  // Exact-string Jaccard scores a copy edit 0; the section is still the same one.
  const figma = [section(0, 600, ['hire forward-deployed engineers for ai-native teams'])];
  const web = [section(0, 600, ['hire engineers for ai-native execution'])];
  const { pairs } = alignSections(figma, web, MATCH_CFG);
  assert.ok(pairs[0].figma && pairs[0].web);
  assert.ok(pairs[0].confidence > 0.6, `expected a confident match, got ${pairs[0].confidence}`);
});

// --------------------------------------------------------------- findings ---

const rawFinding = (over = {}) => ({
  sectionPair: { figmaIndex: 0, webIndex: 1, figmaLabel: 'f', webLabel: 'w', confidence: 0.9 },
  category: 'spacing', type: 'extra-in-web', property: 'layout.gapMeasured',
  expected: 16, actual: 13, severity: 'medium', occurrenceCount: 2, ...over,
});

test('findings: identical problems across sections group into one', () => {
  const raw = [
    rawFinding(),
    rawFinding({ sectionPair: { figmaIndex: 2, webIndex: 3, figmaLabel: 'f', webLabel: 'w', confidence: 0.9 } }),
  ];
  const { findings } = assembleFindings(raw, { severity: { occurrenceUpgradeThreshold: 10 } });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].sectionCount, 2);
  assert.equal(findings[0].occurrenceCount, 4, 'web-side counts sum across the group');
});

test('findings: a different value stays a separate finding', () => {
  const { findings } = assembleFindings(
    [rawFinding({ actual: 13 }), rawFinding({ actual: 18 })],
    { severity: { occurrenceUpgradeThreshold: 10 } }
  );
  assert.equal(findings.length, 2);
});

test('findings: high occurrence upgrades severity, with a stated reason', () => {
  const { findings } = assembleFindings(
    [rawFinding({ occurrenceCount: 40 })],
    { severity: { occurrenceUpgradeThreshold: 10 } }
  );
  assert.equal(findings[0].severity, 'high');
  assert.ok(findings[0].severityReasons.some((r) => /occurrence/.test(r)));
});

test('findings: dynamic-content flag downgrades severity', () => {
  const { findings } = assembleFindings(
    [rawFinding({ severity: 'high', lowConfidence: true })],
    { severity: { occurrenceUpgradeThreshold: 10 } }
  );
  assert.equal(findings[0].severity, 'medium');
});

test('findings: fingerprints are stable but value-sensitive', () => {
  const a = assembleFindings([rawFinding({ actual: 20 })], { severity: {} }).findings[0];
  const b = assembleFindings([rawFinding({ actual: 20 })], { severity: {} }).findings[0];
  const c = assembleFindings([rawFinding({ actual: 12 })], { severity: {} }).findings[0];
  assert.equal(a.fingerprint, b.fingerprint);
  // Accepting "20 instead of 24" must not silently accept a later drop to 12.
  assert.notEqual(a.fingerprint, c.fingerprint);
});

test('findings: ordering is deterministic across runs', () => {
  const raw = [
    rawFinding({ severity: 'low', actual: 1 }),
    rawFinding({ severity: 'critical', actual: 2 }),
    rawFinding({ severity: 'medium', actual: 3 }),
  ];
  const one = assembleFindings(raw, { severity: {} }).findings.map((f) => f.id);
  const two = assembleFindings([...raw].reverse(), { severity: {} }).findings.map((f) => f.id);
  assert.deepEqual(one, two, 'input order must not affect output order');
  assert.equal(assembleFindings(raw, { severity: {} }).findings[0].severity, 'critical');
});
