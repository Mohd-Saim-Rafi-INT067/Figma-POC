/**
 * Deterministic interpretation: scores, root-cause issues, fix order.
 *
 * Everything here is computed, never inferred. That is deliberate - a health
 * score the model invents would vary between runs and could never gate CI, and
 * a "fix this first" ordering that shuffles run to run is worse than none.
 *
 * The LLM's job downstream is to narrate THIS combination of facts. It does not
 * produce any of the numbers on this page.
 */

import { interpret } from './knowledge.js';

const SEVERITY_WEIGHT = { critical: 25, high: 10, medium: 3, low: 1 };

/**
 * Health score 0-100.
 *
 * An exponential decay rather than a linear subtraction: linear bottoms out at
 * zero for any section with a few high findings, which throws away the
 * distinction between "bad" and "much worse". The curve keeps the whole range
 * usable - penalty 10 -> 80, 25 -> 57, 50 -> 33, 100 -> 11.
 */
const DECAY = 45;
const scoreFrom = (penalty) => Math.round(100 * Math.exp(-penalty / DECAY));

const STATUS = [
  [90, 'Excellent'],
  [75, 'Good'],
  [55, 'Fair'],
  [35, 'Poor'],
  [0, 'Critical'],
];
const statusFor = (score) => STATUS.find(([min]) => score >= min)[1];

/**
 * Confidence bands for section matching. A bare "0.827" tells a reader nothing
 * about whether that is good.
 */
export function interpretConfidence(stats) {
  const pct = Math.round(stats.meanConfidence * 100);
  let verdict;
  if (stats.meanConfidence >= 0.8) verdict = 'Excellent';
  else if (stats.meanConfidence >= 0.65) verdict = 'Good';
  else if (stats.meanConfidence >= 0.5) verdict = 'Fair';
  else verdict = 'Weak';

  const notes = [];
  notes.push(
    stats.missingInWeb === 0
      ? 'Every design section was found on the page.'
      : `${stats.missingInWeb} design section${stats.missingInWeb > 1 ? 's were' : ' was'} not found on the page.`
  );
  if (stats.extraInWeb > 0) {
    notes.push(
      `${stats.extraInWeb} page section${stats.extraInWeb > 1 ? 's have' : ' has'} no design counterpart ` +
      '(commonly a header or footer designed in a separate frame).'
    );
  }
  if (stats.demoted > 0) {
    notes.push(`${stats.demoted} pair${stats.demoted > 1 ? 's were' : ' was'} too weak to trust and left unmatched.`);
  }

  return { percent: pct, verdict, notes };
}

/** Per-section score, status, and its own finding breakdown. */
export function scoreSections(findings, alignment) {
  const bySection = new Map();

  for (const pair of alignment.pairs) {
    if (!pair.figma || !pair.web) continue;
    bySection.set(pair.web.index, {
      figmaIndex: pair.figma.index,
      webIndex: pair.web.index,
      label: pair.web.headline || pair.figma.headline || `section ${pair.web.index + 1}`,
      confidence: pair.confidence,
      designHeight: Math.round(pair.figma.height),
      pageHeight: Math.round(pair.web.height),
      heightRatio: +(pair.web.height / pair.figma.height).toFixed(2),
      findings: [],
      penalty: 0,
      bySeverity: {},
    });
  }

  for (const f of findings) {
    for (const s of f.sections) {
      const entry = bySection.get(s.webIndex);
      if (!entry) continue;
      entry.findings.push(f);
      entry.penalty += SEVERITY_WEIGHT[f.severity] ?? 1;
      entry.bySeverity[f.severity] = (entry.bySeverity[f.severity] || 0) + 1;
    }
  }

  return [...bySection.values()]
    .map((s) => {
      const score = scoreFrom(s.penalty);
      // Name the problem areas rather than listing every finding.
      const problems = [...new Set(s.findings.map((f) => interpret(f).title))];
      return { ...s, score, status: statusFor(score), problems };
    })
    .sort((a, b) => a.webIndex - b.webIndex);
}

/**
 * Root-cause issues: collapse findings to the thing a developer would actually
 * fix. "57 Arial findings across 2 sections" is one job, not fifty-seven.
 */
export function buildIssues(findings) {
  const byProperty = new Map();

  for (const f of findings) {
    const key = f.property;
    if (!byProperty.has(key)) {
      byProperty.set(key, {
        property: key,
        category: f.category,
        severity: f.severity,
        findings: [],
        sections: new Set(),
        occurrences: 0,
      });
    }
    const issue = byProperty.get(key);
    issue.findings.push(f);
    issue.occurrences += f.occurrenceCount ?? 0;
    for (const s of f.sections) issue.sections.add(s.webIndex);
    if (SEVERITY_WEIGHT[f.severity] > SEVERITY_WEIGHT[issue.severity]) issue.severity = f.severity;
  }

  return [...byProperty.values()]
    .map((issue) => {
      const representative = issue.findings[0];
      const knowledge = interpret(representative);
      const variants = issue.findings.length;

      // Two DIFFERENT properties, deliberately not collapsed into one flag.
      //
      // "one fix" means a single root cause resolves the whole issue - one
      // distinct deviation repeated, like a font that failed to load.
      // "systemic" means it is spread widely, which points at a process or
      // discipline gap rather than isolated bugs.
      //
      // Conflating them made every issue read "fix centrally", which told the
      // reader nothing: eleven sections each a different height is eleven
      // investigations, not one fix.
      const oneFix = variants === 1 || issue.property === 'type.renderedFontFamily';
      const systemic = issue.sections.size >= 5;

      return {
        ...issue,
        sections: [...issue.sections].sort((a, b) => a - b),
        variants,
        knowledge,
        oneFix,
        systemic,
        // A one-fix issue is worth more than its raw size suggests: the effort
        // is a fraction of a systemic one and the payoff is immediate. Without
        // this the ordering put a critical font failure below a diffuse colour
        // problem, and the model kept silently reordering to compensate.
        weight:
          (SEVERITY_WEIGHT[issue.severity] ?? 1) *
          (1 + Math.log10(1 + issue.occurrences)) *
          (1 + issue.sections.size / 6) *
          (oneFix ? 1.6 : 1),
      };
    })
    .sort((a, b) => b.weight - a.weight);
}

/**
 * Recommended fix order.
 *
 * Ordered by aggregate weight, not by severity alone: one critical issue fixed
 * once globally outranks a dozen isolated low-severity ones, and a medium issue
 * spanning ten sections outranks a high issue in one.
 */
export function fixOrder(issues) {
  const byCategory = new Map();
  for (const issue of issues) {
    if (!byCategory.has(issue.category)) {
      byCategory.set(issue.category, { category: issue.category, weight: 0, issues: [], sections: new Set(), oneFix: false, systemic: false });
    }
    const c = byCategory.get(issue.category);
    c.weight += issue.weight;
    c.issues.push(issue);
    issue.sections.forEach((s) => c.sections.add(s));

  }

  const LABEL = {
    font: 'Typography — rendered font',
    typography: 'Typography — scale and weights',
    color: 'Colour and theming',
    geometry: 'Section geometry',
    spacing: 'Spacing scale',
    shape: 'Corner radius',
    structure: 'Structural differences',
  };

  return [...byCategory.values()]
    .sort((a, b) => b.weight - a.weight)
    .map((c, i) => ({
      rank: i + 1,
      category: c.category,
      label: LABEL[c.category] ?? c.category,
      issueCount: c.issues.length,
      sectionCount: c.sections.size,
      severity: c.issues[0].severity,
      // A category takes the character of its HEAVIEST issue, not of any
      // member. "any issue is a one-fix" made every category read "fix
      // centrally" again, including ones dominated by a systemic problem.
      oneFix: c.issues[0].oneFix,
      systemic: c.issues[0].systemic,
      rationale: c.issues[0].oneFix
        ? `A single root cause accounts for this — one fix resolves all ${c.sections.size} affected section${c.sections.size > 1 ? 's' : ''}.`
        : c.issues[0].systemic
          ? `Spread across ${c.sections.size} sections with a different value each time — this is a discipline gap, not one bug. Expect per-section work.`
          : `Localised to ${c.sections.size} section${c.sections.size > 1 ? 's' : ''}.`,
    }));
}

/** Facts for the executive assessment. Prose is written downstream. */
export function executiveFacts(assembled, alignment, sections, sectionScores, issues) {
  const scores = sectionScores.map((s) => s.score);
  const mean = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 100;
  const worst = [...sectionScores].sort((a, b) => a.score - b.score).slice(0, 3);
  const best = [...sectionScores].sort((a, b) => b.score - a.score).slice(0, 3);

  const structuralIntact =
    alignment.stats.missingInWeb === 0 && alignment.stats.matched === alignment.stats.figmaSections;

  return {
    overallScore: mean,
    overallStatus: statusFor(mean),
    structuralIntact,
    confidence: interpretConfidence(alignment.stats),
    totals: {
      findings: assembled.findings.length,
      issues: issues.length,
      ...assembled.counts.bySeverity,
    },
    designSections: alignment.stats.figmaSections,
    pageSections: alignment.stats.webSections,
    matched: alignment.stats.matched,
    missingInWeb: alignment.stats.missingInWeb,
    extraInWeb: alignment.stats.extraInWeb,
    designHeight: Math.round(sections.figma.totalHeight),
    pageHeight: Math.round(sections.web.totalHeight),
    worstSections: worst.map((s) => ({ section: s.webIndex + 1, label: s.label, score: s.score })),
    bestSections: best.map((s) => ({ section: s.webIndex + 1, label: s.label, score: s.score })),
    dominantIssues: issues.slice(0, 3).map((i) => ({
      title: i.knowledge.title,
      severity: i.severity,
      sections: i.sections.length,
      occurrences: i.occurrences,
      oneFix: i.oneFix,
      systemic: i.systemic,
    })),
  };
}

export function analyse(assembled, alignment, sections) {
  const sectionScores = scoreSections(assembled.findings, alignment);
  const issues = buildIssues(assembled.findings);
  const order = fixOrder(issues);
  const exec = executiveFacts(assembled, alignment, sections, sectionScores, issues);
  return { sectionScores, issues, fixOrder: order, exec };
}
