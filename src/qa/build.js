/**
 * E7 - the deterministic report.
 *
 * Everything here is derived from E3-E6. The report is complete, correct and
 * shippable before the model is ever called; synthesis only rewords it.
 *
 * The semantic rule from E3 carries through unchanged and is enforced again at
 * the presentation boundary, because this is the last place it could be lost:
 *
 *     NOT ALIGNED  =  correspondence was not established (about the tool)
 *     MISSING      =  E3 produced an absence claim       (about the page)
 */

import { attachLocators } from './locators.js';

const SEVERITY_ICON = { critical: '🔴', high: '🔴', medium: '🟠', low: '🟡' };
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

/** Human property names. Data, not prose. */
const PROPERTY_LABEL = {
  'boxRelative.size.w': 'Width',
  'boxRelative.size.h': 'Height',
  'boxRelative.pos.x': 'Horizontal position',
  'boxRelative.pos.y': 'Vertical position',
  backgroundColor: 'Background colour',
  color: 'Text colour',
  fontFamily: 'Font',
  renderedFontFamily: 'Rendered font',
  fontSizePx: 'Font size',
  fontWeight: 'Font weight',
  lineHeightPx: 'Line height',
  letterSpacingPx: 'Letter spacing',
  'border.width': 'Border width',
  'border.radius': 'Corner radius',
  'shadow.geometry': 'Shadow',
  'shadow.color': 'Shadow colour',
  gapMeasured: 'Gap',
  paddingMeasured: 'Padding',
  opacity: 'Opacity',
};

const UNIT = { px: new Set(['boxRelative.size.w', 'boxRelative.size.h', 'boxRelative.pos.x', 'boxRelative.pos.y', 'fontSizePx', 'lineHeightPx', 'letterSpacingPx', 'border.width', 'border.radius', 'shadow.geometry', 'gapMeasured', 'paddingMeasured']) };
const withUnit = (property, v) => {
  if (UNIT.px.has(property) && typeof v === 'number') return `${v}px`;
  // '#000000 @ 0%' is how a fully transparent colour formats. A reader should
  // see what it means, not how it is stored.
  const s = String(v);
  return /@ 0%$/.test(s) ? 'transparent' : s;
};

/** Percentage difference, where one is meaningful. */
function percentDelta(property, expected, actual) {
  if (typeof expected !== 'number' || typeof actual !== 'number' || expected === 0) return null;
  if (!UNIT.px.has(property)) return null;
  return +(((actual - expected) / Math.abs(expected)) * 100).toFixed(1);
}

/**
 * A deterministic title. The model may improve the wording; it may not be
 * needed at all, and the report must read properly without it.
 */
function deterministicTitle(issue) {
  const primary = issue.properties[0];
  const label = PROPERTY_LABEL[primary.property] ?? primary.property;
  const noun = issue.element.cls === 'text' ? 'Text' : issue.element.cls === 'control' ? 'Control' : issue.element.cls === 'glyph' ? 'Icon' : 'Container';

  if (issue.properties.length > 1) return `${noun}: ${issue.properties.length} style differences`;
  if (typeof primary.delta === 'number' && UNIT.px.has(primary.property)) {
    const dir = Number(primary.actual) > Number(primary.expected) ? 'larger' : 'smaller';
    return `${noun} ${label.toLowerCase()} is ${primary.delta}px ${dir}`;
  }
  return `${noun} ${label.toLowerCase()} differs`;
}

/** A deterministic fix hint, keyed on what kind of property it is. */
function deterministicFix(issue) {
  const p = issue.properties[0].property;
  if (p === 'fontFamily' || p === 'renderedFontFamily') return 'Check the webfont loads, and the font-family stack.';
  if (p === 'color' || p === 'backgroundColor' || p === 'shadow.color') return 'Update the shared colour token.';
  if (p === 'border.width' || p === 'border.radius') return 'Update the shared border token.';
  if (p.startsWith('boxRelative.size')) return 'Match the element size to the design.';
  if (p.startsWith('boxRelative.pos')) return 'Check the container layout and spacing.';
  if (p === 'gapMeasured' || p === 'paddingMeasured') return 'Align spacing with the design scale.';
  if (p.startsWith('font') || p === 'lineHeightPx' || p === 'letterSpacingPx') return 'Update the shared type style.';
  return 'Compare this element against the design.';
}

function deterministicImpact(issue) {
  const p = issue.properties[0].property;
  if (p === 'fontFamily' || p === 'renderedFontFamily') return 'Text renders in the wrong typeface.';
  if (p === 'color' || p === 'backgroundColor') return 'Colour differs from the design.';
  if (p.startsWith('boxRelative.size')) return 'Element occupies a different amount of space.';
  if (p.startsWith('boxRelative.pos')) return 'Element sits away from its designed position.';
  if (p === 'border.radius') return 'Corner shape differs from the design.';
  return 'Visual detail differs from the design.';
}

/**
 * `C:\run\evidence\issues\issue-00.png` -> `evidence/issues/issue-00.png`
 *
 * A server needs a path relative to the run directory to serve the image over
 * HTTP; it has no business knowing where on disk the run lives.
 */
function relEvidence(p) {
  if (!p) return null;
  const norm = String(p).split('\\').join('/');
  const at = norm.indexOf('evidence/');
  return at === -1 ? null : norm.slice(at);
}

/** One issue, presentation-ready and fully measured. */
function buildIssue(issue, index, evidenceByKey) {
  const properties = issue.properties.map((p) => ({
    label: PROPERTY_LABEL[p.property] ?? p.property,
    property: p.property,
    design: withUnit(p.property, p.expected),
    website: withUnit(p.property, p.actual),
    delta: p.delta == null ? null
      : UNIT.px.has(p.property) ? `${p.delta}px`
      // Colour deltas are deltaE. An unlabelled "18.09" beside two hex values
      // reads as pixels.
      : /color$/i.test(p.property) ? `ΔE ${p.delta}`
      : String(p.delta),
    percent: percentDelta(p.property, p.expected, p.actual),
    severity: p.severity,
  }));

  return {
    ref: `I${index}`,
    key: issue.key,
    kind: 'property',
    severity: issue.maxSeverity,
    icon: SEVERITY_ICON[issue.maxSeverity] ?? '🟡',
    visualSeverity: issue.visualSeverity,
    matchConfidence: issue.matchConfidence,
    tier: issue.tier,
    sectionPair: issue.sectionPair,
    element: issue.element,
    properties,
    // How many elements this one issue speaks for - a repeated component
    // reported once carries its instance count rather than N duplicate rows.
    affectedElements: issue.templateInstances ?? 1,
    evidence: evidenceByKey.get(issue.key)?.path ?? issue.evidence?.path ?? null,
    // Path relative to the run directory, so a server can serve it over HTTP
    // without knowing where the run lives on disk.
    evidenceRel: relEvidence(evidenceByKey.get(issue.key)?.path ?? issue.evidence?.path ?? null),
    title: deterministicTitle(issue),
    impact: deterministicImpact(issue),
    fix: deterministicFix(issue),
    synthesised: { title: false, impact: false, fix: false },
  };
}

/** Structural claims from E3 - the ONLY issues allowed to say "missing". */
function buildStructuralIssues(structural, startIndex) {
  const out = [];
  let i = startIndex;
  for (const section of structural ?? []) {
    for (const f of section.findings ?? []) {
      out.push({
        ref: `S${i++}`,
        kind: 'structural',
        severity: f.severity ?? 'medium',
        icon: SEVERITY_ICON[f.severity ?? 'medium'],
        visualSeverity: 0.5,
        sectionPair: { figmaIndex: section.figmaIndex, webIndex: section.webIndex },
        element: { cls: f.cls ?? 'component', figmaNodeId: null, webSelector: null },
        properties: [],
        affectedElements: f.instances ?? f.instanceCount ?? 1,
        evidence: null,
        title: f.kind === 'slot-absent-in-web'
          ? `A ${f.cls} in this component is not built`
          : f.kind === 'slot-absent-in-design'
            ? `The page builds a ${f.cls} the design does not have`
            : 'A designed component group has no counterpart',
        impact: 'Structural difference between design and build.',
        fix: 'Confirm whether this part of the component was intended.',
        evidenceNote: f.evidence,
        chanceOfCoincidence: f.chanceOfCoincidence ?? null,
        synthesised: { title: false, impact: false, fix: false },
      });
    }
  }
  return out;
}

/**
 * Section reports: issue counts, severity breakdown, highest priority first.
 *
 * E5's ordering is preserved exactly. E7 groups by section and presents; it
 * never re-ranks.
 */
export function buildSectionReports(issues, structural, sections, evidenceIndex, meta) {
  const evidenceByKey = new Map((evidenceIndex ?? []).map((e) => [e.issue, e]));

  const presented = attachLocators(
    issues.map((issue, i) => buildIssue(issue, i, evidenceByKey)),
    meta
  );
  const structuralIssues = buildStructuralIssues(structural, presented.length);

  const bySection = new Map();
  for (const issue of [...presented, ...structuralIssues]) {
    const key = `${issue.sectionPair.figmaIndex}:${issue.sectionPair.webIndex}`;
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key).push(issue);
  }

  const reports = [];
  for (const [key, list] of bySection) {
    const [figmaIndex, webIndex] = key.split(':').map(Number);
    const bySeverity = {};
    for (const s of SEVERITY_ORDER) {
      const n = list.filter((i) => i.severity === s).length;
      if (n) bySeverity[s] = n;
    }
    const web = sections?.web?.sections?.[webIndex];

    reports.push({
      figmaIndex,
      webIndex,
      label: web?.label ?? `section ${webIndex + 1}`,
      headline: web?.headline ?? null,
      issueCount: list.length,
      bySeverity,
      // E5's order, untouched.
      issues: list,
    });
  }

  reports.sort((a, b) => a.webIndex - b.webIndex);
  return reports;
}

/**
 * Systemic issues - reported ONCE, never repeated per element.
 *
 * `oneFix` marks the ones a shared token or component would resolve, which is
 * the whole reason this projection exists.
 */
export function buildSystemic(systemic, cfg) {
  return (systemic ?? [])
    .filter((g) => g.occurrences >= (cfg?.minOccurrences ?? 3))
    .map((g, i) => ({
      ref: `Y${i}`,
      severity: g.severity,
      icon: SEVERITY_ICON[g.severity] ?? '🟡',
      label: PROPERTY_LABEL[g.property] ?? g.property,
      property: g.property,
      design: withUnit(g.property, g.expected),
      website: withUnit(g.property, g.actual),
      affectedElements: g.occurrences,
      sections: g.sections,
      sharedFix: g.oneFix || g.withinComponent,
      scope: g.withinComponent ? 'one component' : g.sections > 1 ? `${g.sections} sections` : 'one section',
      // A font substitution is not a token to retype - it usually means the
      // webfont did not load at all.
      fix: /font/i.test(g.property)
        ? 'Check the webfont loads, and the font-family stack.'
        : g.oneFix
        ? `Update the shared ${(PROPERTY_LABEL[g.property] ?? g.property).toLowerCase()} token.`
        : g.withinComponent
          ? 'Fix once in the shared component.'
          : 'Review these together.',
    }));
}

/** The limitation the report must always carry. */
export function confidenceNote(quality) {
  return {
    recall: quality?.recall ?? 0.335,
    precisionAtGate: quality?.precisionAtGate ?? 0.60,
    gate: quality?.gate ?? 0.85,
    text:
      `Correspondence quality: ${((quality?.recall ?? 0.335) * 100).toFixed(1)}% recall, ` +
      `${((quality?.precisionAtGate ?? 0.6) * 100).toFixed(0)}% precision at the ${quality?.gate ?? 0.85} confidence gate ` +
      `(measured against ${quality?.sections ?? 6} hand-scored sections). ` +
      'Elements that could not be aligned are reported as NOT ALIGNED, never as missing — ' +
      'that is a statement about this tool, not about the page.',
  };
}
