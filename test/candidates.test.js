/**
 * Unit tests for E2a - candidate generation.
 *
 * These cover the properties the re-architecture rests on: that ranking never
 * eliminates, that the ordering is reproducible, and that the text feature is
 * genuinely inert until switched on. A silent regression in any of them would
 * change a measured benchmark number without throwing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  xOverlap, xAlignment, widthPenalty, classCompatibility,
  textSimilarity, candidateFeatures, scoreFeatures, shortlist, marginStats, isMutualBest,
} from '../src/correspond/candidates.js';

const CFG = {
  yResidualWindow: 0.15,
  yRelWindow: 0.25,
  widthRatioScoreBand: 0.25,
  widthWeight: 0.35,
  classWeight: 0.5,
  classCompatibility: { 'glyph~text': 0.6, default: 0.35 },
};

const el = (cls, x, y, w, h, yRel = 0) => ({ cls, box: { x, y, w, h }, yRel });

test('E2a: xAlignment separates alignment from containment, xOverlap does not', () => {
  // The measured case: a 54px design avatar at x=244 against a 350px decorative
  // blob spanning x=46..396, and against the 56px avatar that is its real
  // counterpart. Containment scores the blob perfectly; alignment does not.
  const avatar = el('glyph', 244, 0, 54, 54);
  const blob = el('glyph', 46, 0, 350, 350);
  const real = el('glyph', 240, 0, 56, 56);

  assert.equal(xOverlap(avatar, blob), 1, 'containment reads as a perfect overlap');
  assert.ok(xAlignment(avatar, real) > xAlignment(avatar, blob), 'alignment ranks the true pair higher');
});

test('E2a: shortlist ranks every candidate and eliminates none', () => {
  const f = el('text', 0, 0, 100, 20);
  const webEls = [
    el('text', 900, 0, 100, 20),     // far away, but still a candidate
    el('text', 0, 0, 100, 20),
    el('glyph', 400, 0, 100, 20),
  ];
  const ranked = shortlist(f, webEls, CFG);
  assert.equal(ranked.length, webEls.length, 'nothing is filtered out');
  assert.equal(ranked[0].webIndex, 1, 'the coincident same-class element ranks first');
});

test('E2a: k truncates the ranking without reordering it', () => {
  const f = el('text', 0, 0, 100, 20);
  const webEls = [el('text', 500, 0, 100, 20), el('text', 0, 0, 100, 20), el('text', 200, 0, 100, 20)];
  const full = shortlist(f, webEls, CFG);
  const top2 = shortlist(f, webEls, CFG, {}, 2);
  assert.deepEqual(top2.map((r) => r.webIndex), full.slice(0, 2).map((r) => r.webIndex));
});

test('E2a: ties break on web index, so the ordering is reproducible', () => {
  // Two identical candidates must not swap between runs - recall@k would stop
  // being a stable measurement.
  const f = el('text', 0, 0, 100, 20);
  const twins = [el('text', 0, 0, 100, 20), el('text', 0, 0, 100, 20)];
  const a = shortlist(f, twins, CFG);
  const b = shortlist(f, [...twins], CFG);
  assert.deepEqual(a.map((r) => r.webIndex), b.map((r) => r.webIndex));
  assert.equal(a[0].webIndex, 0);
});

test('E2a: the text feature is inert unless a textOf accessor is supplied', () => {
  const f = el('text', 0, 0, 100, 20);
  const w = el('text', 0, 0, 100, 20);

  const without = candidateFeatures(f, w, CFG, {});
  assert.equal(without.textSim, null, 'no accessor, no feature');
  assert.equal(scoreFeatures(without, { ...CFG, textWeight: 5 }), scoreFeatures(without, CFG),
    'a null feature cannot move the score at any weight');

  const withText = candidateFeatures(f, w, CFG, { textOf: () => 'get started' });
  assert.equal(withText.textSim, 1);
  assert.equal(scoreFeatures(withText, { ...CFG, textWeight: 0 }), scoreFeatures(withText, CFG),
    'weight 0 must ignore the term entirely, or the ablation baseline is not a baseline');
});

test('E2a: text similarity rewards shared bigrams, not incidental words', () => {
  assert.equal(textSimilarity('get started', 'get started'), 1);
  assert.ok(textSimilarity('get started free', 'get started') > 0.5, 'a truncated variant still matches');
  assert.equal(textSimilarity('privacy policy', 'contact sales'), 0);
  assert.equal(textSimilarity(null, 'anything'), null, 'a missing side yields no signal, not a zero');
});

test('E2a: class compatibility marks cross-class pairs down without forbidding them', () => {
  const glyph = el('glyph', 0, 0, 50, 50);
  const text = el('text', 0, 0, 50, 50);
  assert.equal(classCompatibility(glyph, glyph, CFG.classCompatibility), 1);
  assert.equal(classCompatibility(glyph, text, CFG.classCompatibility), 0.6);

  // The design cannot express that an icon was built as a text character, so the
  // pair must remain reachable - just cheaper.
  const ranked = shortlist(glyph, [text], CFG);
  assert.equal(ranked.length, 1);
});

test('E2a: width scores and never gates', () => {
  const a = el('box', 0, 0, 100, 20);
  const wide = el('box', 0, 0, 400, 20);
  assert.ok(widthPenalty(a, wide, CFG.widthRatioScoreBand) > 0);
  assert.equal(shortlist(a, [wide], CFG).length, 1, 'a width disagreement never removes a candidate');
});

test('E2a: y is scored against the warp when one is supplied, relatively when not', () => {
  const f = el('text', 0, 100, 100, 20, 0.1);
  const w = el('text', 0, 500, 100, 20, 0.5);

  const rel = candidateFeatures(f, w, CFG, {});
  assert.equal(rel.yResidual, null);
  assert.ok(rel.yRelGap > 0);

  // A warp that predicts exactly where the element landed should score perfectly.
  const warped = candidateFeatures(f, w, CFG, { warp: () => 500, sectionHeight: 1000 });
  assert.equal(warped.yResidual, 0);
  assert.equal(warped.yScore, 1);
});

test('E2a: margin reports how decisively the winner won', () => {
  const f = el('text', 0, 0, 100, 20);

  // A clear winner: one coincident candidate, one far away.
  const decisive = marginStats(f, [el('text', 0, 0, 100, 20), el('text', 800, 0, 100, 20)], CFG);
  // A near-tie: two candidates that are all but identical.
  const ambiguous = marginStats(f, [el('text', 0, 0, 100, 20), el('text', 2, 0, 100, 20)], CFG);

  assert.ok(decisive.margin > ambiguous.margin,
    'a pair that beat its runner-up by a mile must not look like one that edged it out');
  assert.ok(ambiguous.margin < 0.2, 'stacked near-identical elements produce a tiny margin');
});

test('E2a: margin is null, not zero, when there is nothing to compare against', () => {
  const only = marginStats(el('text', 0, 0, 100, 20), [el('text', 0, 0, 100, 20)], CFG);
  assert.equal(only.second, null);
  assert.equal(only.margin, null, 'a single candidate is not a margin of zero — the caller decides');
});

test('E2a: mutual best requires both sides to name each other', () => {
  const figmaEls = [el('text', 0, 0, 100, 20), el('text', 400, 0, 100, 20)];
  const webEls = [el('text', 0, 0, 100, 20), el('text', 400, 0, 100, 20)];

  assert.equal(isMutualBest(0, 0, figmaEls, webEls, CFG), true);
  assert.equal(isMutualBest(0, 1, figmaEls, webEls, CFG), false, 'one-sided preference is not mutual');
});
