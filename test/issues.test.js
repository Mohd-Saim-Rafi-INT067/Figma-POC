/**
 * Unit tests for E5 - issue prioritisation.
 *
 * The contracts here are about READABILITY, which is why the architecture calls
 * the volume controls mandatory rather than optimisations: a 2,000-finding
 * report is worse UX than the aggregate report V2 replaces.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeByElement, systemicGroups, landingView } from '../src/issues/merge.js';
import { visualSeverity } from '../src/issues/severity.js';

const CFG = {
  weights: { severity: 0.4, issueCount: 0.2, area: 0.15, position: 0.15, instances: 0.1 },
  issueCountSaturation: 3,
  instanceSaturation: 4,
  landingViewCap: 20,
  maxExemplars: 3,
  oneFixThreshold: 10,
  systemicMinOccurrences: 2,
  viewportWidth: 1920,
  viewportHeight: 900,
};

const finding = (over = {}) => ({
  sectionPair: { figmaIndex: over.section ?? 0, webIndex: over.section ?? 0, confidence: 0.9 },
  category: 'element',
  property: over.property ?? 'color',
  severity: over.severity ?? 'high',
  expected: over.expected ?? '#000000',
  actual: over.actual ?? '#111111',
  delta: over.delta ?? 3,
  instanceCount: over.instanceCount ?? 1,
  element: {
    figmaIndex: over.figmaIndex ?? 0,
    webIndex: over.webIndex ?? 0,
    cls: 'box',
    figmaNodeId: `f${over.figmaIndex ?? 0}`,
    webSelector: `sel${over.figmaIndex ?? 0}`,
    tier: 'anchor',
    matchConfidence: over.matchConfidence ?? 0.9,
    templateId: over.templateId ?? null,
    templateSlot: over.templateSlot ?? null,
  },
});

const pairs = [{
  figmaIndex: 0, webIndex: 0,
  web: { origin: { y: 0 }, elements: [{ area: 10000, box: { y: 0 } }, { area: 10000, box: { y: 0 } }] },
}];

test('E5: four problems on one element become ONE issue', () => {
  const findings = ['color', 'border.radius', 'fontSizePx', 'opacity'].map((property) => finding({ property }));
  const issues = mergeByElement(findings, pairs, CFG);
  assert.equal(issues.length, 1, 'nobody fixes "a radius"; they fix "the button"');
  assert.equal(issues[0].properties.length, 4);
  assert.equal(issues[0].maxSeverity, 'high');
});

test('E5: the same element index in different sections stays separate', () => {
  // figmaIndex is only unique WITHIN a section - element 3 of section 1 and
  // element 3 of section 9 are different elements.
  const issues = mergeByElement([finding({ section: 0 }), finding({ section: 5 })], [
    ...pairs, { figmaIndex: 5, webIndex: 5, web: { origin: { y: 0 }, elements: [{ area: 1, box: { y: 0 } }] } },
  ], CFG);
  assert.equal(issues.length, 2);
});

test('E5: match confidence can only mark an issue DOWN', () => {
  const strong = mergeByElement([finding({ matchConfidence: 1.0 })], pairs, CFG)[0];
  const weak = mergeByElement([finding({ matchConfidence: 0.4 })], pairs, CFG)[0];
  assert.ok(weak.visualSeverity < strong.visualSeverity, 'a weak correspondence must not shout');
  assert.ok(weak.visualSeverity <= strong.visualSeverity * 0.45);
});

test('E5: visual severity rises with problem count and repeated instances', () => {
  const base = { element: { area: 1000 }, properties: [{ severity: 'medium' }], matchConfidence: 1, templateInstances: 1 };
  const ctx = { viewportArea: 1920 * 900, viewportHeight: 900, absoluteY: 0 };

  const one = visualSeverity(base, ctx, CFG);
  const four = visualSeverity({ ...base, properties: Array(4).fill({ severity: 'medium' }) }, ctx, CFG);
  assert.ok(four > one);

  const repeated = visualSeverity({ ...base, templateInstances: 12 }, ctx, CFG);
  assert.ok(repeated > one, 'a fault in a component built twelve times has twelve times the surface');
});

test('E5: the same problem lower down the page ranks lower', () => {
  const issue = { element: { area: 1000 }, properties: [{ severity: 'high' }], matchConfidence: 1, templateInstances: 1 };
  const top = visualSeverity(issue, { viewportArea: 1920 * 900, viewportHeight: 900, absoluteY: 0 }, CFG);
  const deep = visualSeverity(issue, { viewportArea: 1920 * 900, viewportHeight: 900, absoluteY: 9000 }, CFG);
  assert.ok(deep < top, 'above the fold weighs more');
});

test('E5: systemic view groups one wrong value across many elements', () => {
  const findings = Array.from({ length: 12 }, (_, i) =>
    finding({ figmaIndex: i, webIndex: i, property: 'color', expected: '#835CF5', actual: '#A855F7' }));
  const groups = systemicGroups(findings, CFG);
  assert.equal(groups.length, 1, 'one token, twelve elements, one fix');
  assert.equal(groups[0].occurrences, 12);
  assert.equal(groups[0].oneFix, true);
  assert.equal(groups[0].elements.length, CFG.maxExemplars, 'exemplars are capped');
});

test('E5: a value wrong in DIFFERENT ways stays separate', () => {
  // Two distinct faults, each seen twice - so both clear the systemic floor and
  // the grouping key must keep them apart. Same property, different `actual`.
  const groups = systemicGroups([
    finding({ figmaIndex: 0, actual: '#A855F7' }),
    finding({ figmaIndex: 1, actual: '#A855F7' }),
    finding({ figmaIndex: 2, actual: '#CC0000' }),
    finding({ figmaIndex: 3, actual: '#CC0000' }),
  ], CFG);
  assert.equal(groups.length, 2, 'a property wrong in two ways is two problems');
  assert.deepEqual(groups.map((g) => g.occurrences), [2, 2]);
});

test('E5: a one-off is not systemic', () => {
  // The systemic view answers "what is the root cause", so a fault seen once
  // does not belong in it - it is already in the element view.
  assert.equal(systemicGroups([finding({ figmaIndex: 0 })], CFG).length, 0);
});

test('E5: a fault confined to one component is marked withinComponent', () => {
  // The pattern found validating E4: three form fields all 172px too wide.
  // Different elements in different slots, so per-element merging keeps them
  // apart and a reader sees three lines where one would do.
  const findings = [0, 1, 2].map((i) => finding({
    figmaIndex: i, webIndex: i, property: 'boxRelative.size.w',
    expected: 528, actual: 700, templateId: 'tpl:A', templateSlot: `${i}`,
  }));
  const groups = systemicGroups(findings, CFG);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].withinComponent, true);
  assert.equal(groups[0].occurrences, 3);
});

test('E5: the landing view is capped and the remainder is counted, not lost', () => {
  const issues = Array.from({ length: 57 }, (_, i) => ({ visualSeverity: 1 - i / 100 }));
  const view = landingView(issues, CFG);
  assert.equal(view.shown.length, 20);
  assert.equal(view.remainder, 37);
  assert.equal(view.shown[0].visualSeverity, 1, 'ranked by visual severity');
});
