/**
 * Unit tests for E7 - the visual QA report.
 *
 * The load-bearing guarantee is the LLM boundary: the model may choose WORDS,
 * never FACTS. Most of these tests exist to prove it cannot cross that line,
 * because a presentation layer that can quietly alter a measurement is worse
 * than no presentation layer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSectionReports, buildSystemic, confidenceNote } from '../src/qa/build.js';
import { buildPageReport, fixFirst } from '../src/qa/page.js';
import { guardText, applySynthesis } from '../src/qa/synthesis.js';
import { figmaUrl, devtoolsSnippet } from '../src/qa/locators.js';

const issue = (over = {}) => ({
  key: over.key ?? `0:0:${over.figmaIndex ?? 0}`,
  sectionPair: { figmaIndex: over.section ?? 0, webIndex: over.section ?? 0, confidence: 0.9 },
  element: {
    figmaIndex: over.figmaIndex ?? 0, webIndex: 0, cls: over.cls ?? 'control',
    figmaNodeId: over.figmaNodeId ?? '2743:7650', webSelector: 'form>input', area: 1000,
  },
  tier: 'anchor',
  matchConfidence: 0.9,
  templateInstances: over.instances ?? 1,
  maxSeverity: over.severity ?? 'high',
  visualSeverity: over.visualSeverity ?? 0.5,
  properties: over.properties ?? [
    { property: 'boxRelative.size.w', category: 'geometry', severity: 'high', expected: 528, actual: 700, delta: 172 },
  ],
});

const SECTIONS = { web: { sections: [{ index: 0, label: 'section', headline: 'Contact us' }] } };
const META = { figmaFileKey: 'ABC123', pageUrl: 'https://example.com' };

test('E7: a section report carries counts, severity breakdown and exact values', () => {
  const [report] = buildSectionReports([issue()], [], SECTIONS, [], META);
  assert.equal(report.issueCount, 1);
  assert.deepEqual(report.bySeverity, { high: 1 });

  const [i] = report.issues;
  assert.equal(i.properties[0].design, '528px');
  assert.equal(i.properties[0].website, '700px');
  assert.equal(i.properties[0].delta, '172px');
  assert.equal(i.properties[0].percent, 32.6, 'percentage difference where meaningful');
});

test("E7: E5's priority ordering is preserved, never recomputed", () => {
  const ordered = [
    issue({ figmaIndex: 0, visualSeverity: 0.9 }),
    issue({ figmaIndex: 1, visualSeverity: 0.5 }),
    issue({ figmaIndex: 2, visualSeverity: 0.1 }),
  ];
  const [report] = buildSectionReports(ordered, [], SECTIONS, [], META);
  assert.deepEqual(report.issues.map((i) => i.visualSeverity), [0.9, 0.5, 0.1]);

  // …and the page view ranks across sections without reordering within them.
  const top = fixFirst([report], 2);
  assert.deepEqual(top.map((i) => i.visualSeverity), [0.9, 0.5]);
});

test('E7: the E6 screenshot is attached to the right issue', () => {
  const a = issue({ figmaIndex: 0, key: 'k-a' });
  const b = issue({ figmaIndex: 1, key: 'k-b' });
  const [report] = buildSectionReports([a, b], [], SECTIONS, [
    { issue: 'k-b', path: 'out/evidence/issues/issue-01.png' },
    { issue: 'k-a', path: 'out/evidence/issues/issue-00.png' },
  ], META);

  assert.equal(report.issues.find((i) => i.key === 'k-a').evidence, 'out/evidence/issues/issue-00.png');
  assert.equal(report.issues.find((i) => i.key === 'k-b').evidence, 'out/evidence/issues/issue-01.png');
});

test('E7: deep links resolve to both the Figma node and a devtools selector', () => {
  assert.equal(figmaUrl('ABC', '2743:7650'), 'https://www.figma.com/design/ABC?node-id=2743-7650');
  assert.equal(devtoolsSnippet('form>input'), 'document.querySelector("form>input")');
  const [report] = buildSectionReports([issue()], [], SECTIONS, [], META);
  assert.match(report.issues[0].locators.figmaUrl, /node-id=2743-7650/);
  assert.equal(report.issues[0].locators.scope, 'element');
});

test('E7: systemic issues are reported ONCE, not per element', () => {
  const groups = buildSystemic([
    { property: 'border.width', expected: 0, actual: 1, occurrences: 26, sections: 9, severity: 'medium', oneFix: true, withinComponent: false },
  ], { minOccurrences: 3 });

  assert.equal(groups.length, 1, '26 elements, one row');
  assert.equal(groups[0].affectedElements, 26);
  assert.equal(groups[0].sharedFix, true);
  assert.match(groups[0].fix, /shared/i);
});

// ---------------------------------------------------------- the LLM boundary ---

test('E7: the LLM cannot invent a measurement', () => {
  const i = issue();
  assert.equal(guardText('Fields are 999px too wide', i, { maxLength: 60 }), null,
    '999 appears nowhere in the measured values');
  assert.ok(guardText('Fields wider than designed', i, { maxLength: 60 }),
    'the same claim without a number is fine');
});

test('E7: numbers that DO come from the finding are allowed through', () => {
  const i = issue();   // expected 528, actual 700, delta 172
  assert.ok(guardText('Width is 172 off', i, { maxLength: 60 }));
});

test('E7: the LLM cannot turn "not aligned" into "missing"', () => {
  const i = issue();
  for (const text of ['Field is missing from the page', 'The button was removed', 'Element does not exist']) {
    assert.equal(guardText(text, i, { maxLength: 60 }), null, `must reject: ${text}`);
  }
  // …but a genuine E3 structural claim may say so.
  assert.ok(guardText('Field is missing from the page', i, { maxLength: 60, allowAbsence: true }));
});

test('E7: the LLM cannot change severity, values, counts or identity', () => {
  const [report] = buildSectionReports([issue({ instances: 3 })], [], SECTIONS, [], META);
  const before = report.issues[0];

  const [after] = applySynthesis([before], [{
    ref: before.ref,
    title: 'Form fields wider than designed',
    impact: 'Fields overflow their column',
    fix: 'Update the shared width token',
    // Everything below is an attempt to overwrite measured data.
    severity: 'low',
    affectedElements: 99,
    properties: [{ design: '1px', website: '2px' }],
    matchConfidence: 0.1,
    visualSeverity: 0.01,
  }]);

  assert.equal(after.severity, 'high', 'severity is untouchable');
  assert.equal(after.affectedElements, 3);
  assert.equal(after.properties[0].design, '528px');
  assert.equal(after.properties[0].website, '700px');
  assert.equal(after.matchConfidence, 0.9);
  assert.equal(after.visualSeverity, before.visualSeverity);
  assert.equal(after.title, 'Form fields wider than designed', 'only the wording changed');
  assert.equal(after.synthesised.title, true);
});

test('E7: the LLM cannot create an issue that does not exist', () => {
  const [report] = buildSectionReports([issue()], [], SECTIONS, [], META);
  const out = applySynthesis(report.issues, [
    { ref: report.issues[0].ref, title: 'Real one', impact: 'x', fix: 'y' },
    { ref: 'GHOST', title: 'Invented issue', impact: 'x', fix: 'y' },
  ]);
  assert.equal(out.length, 1, 'a ref with no matching issue is ignored entirely');
  assert.equal(out[0].title, 'Real one');
});

test('E7: a rejected string falls back to the deterministic text', () => {
  const [report] = buildSectionReports([issue()], [], SECTIONS, [], META);
  const deterministic = report.issues[0].title;
  const [after] = applySynthesis(report.issues, [
    { ref: report.issues[0].ref, title: 'Off by 4096px', impact: 'ok impact', fix: 'ok fix' },
  ]);
  assert.equal(after.title, deterministic, 'guard rejected it, deterministic wording stands');
  assert.equal(after.synthesised.title, false);
  assert.equal(after.impact, 'ok impact');
});

// --------------------------------------------------------------- page level ---

test('E7: the full page report aggregates every section', () => {
  const sections = {
    web: { sections: [{ index: 0, label: 's1', headline: 'One' }, { index: 1, label: 's2', headline: 'Two' }] },
  };
  const reports = buildSectionReports([
    issue({ section: 0, figmaIndex: 0, visualSeverity: 0.9 }),
    issue({ section: 1, figmaIndex: 1, visualSeverity: 0.8, severity: 'medium' }),
    issue({ section: 1, figmaIndex: 2, visualSeverity: 0.7, instances: 4 }),
  ], [], sections, [], META);

  assert.equal(reports.length, 2, 'multi-section aggregation');

  const page = buildPageReport(reports, buildSystemic([], {}), confidenceNote(), META);
  assert.equal(page.totals.sections, 2);
  assert.equal(page.totals.issues, 3);
  assert.equal(page.totals.affectedElements, 1 + 1 + 4, 'instance counts roll up');
  assert.deepEqual(page.sections.map((s) => s.issues), [1, 2]);
  assert.deepEqual(page.fixFirst.map((i) => i.visualSeverity), [0.9, 0.8, 0.7]);
});

test('E7: the confidence limitation is always present and states the real numbers', () => {
  const page = buildPageReport([], [], confidenceNote(), META);
  assert.match(page.confidence.text, /33\.5% recall/);
  assert.match(page.confidence.text, /60% precision/);
  assert.match(page.confidence.text, /0\.85 confidence gate/);
  assert.match(page.confidence.text, /NOT ALIGNED, never as missing/);
});

test('E7: only a genuine E3 claim is presented as structural', () => {
  const structural = [{
    figmaIndex: 0, webIndex: 0,
    findings: [{ kind: 'slot-absent-in-web', cls: 'control', instances: 4, severity: 'medium', evidence: 'measured' }],
  }];
  const [report] = buildSectionReports([issue()], structural, SECTIONS, [], META);

  const claims = report.issues.filter((i) => i.kind === 'structural');
  assert.equal(claims.length, 1);
  assert.match(claims[0].title, /not built/);

  // The ordinary property issue must not acquire absence language.
  const property = report.issues.find((i) => i.kind === 'property');
  assert.doesNotMatch(property.title + property.impact, /missing|absent|not built/i);
});
