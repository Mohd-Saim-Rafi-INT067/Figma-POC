/**
 * E7 stage wiring + the "Generate Full Page Report" action.
 *
 * The action deliberately does NOT rerun E1-E6. It aggregates what those stages
 * already wrote, so the page report can never disagree with the section reports
 * beside it.
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildSectionReports, buildSystemic, confidenceNote } from './build.js';
import { buildPageReport } from './page.js';
import { renderPageReport, renderSectionReport } from './html.js';
import { synthesiseAll, applySynthesis } from './synthesis.js';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', yellow: '\x1b[33m' };

/** Measured correspondence quality — six hand-scored sections. */
const QUALITY = { recall: 0.335, precisionAtGate: 0.60, gate: 0.85, sections: 6 };

export async function stageQaReport(ctx) {
  if (!ctx.issues) throw new Error('E7 requires E5 output.');

  const outDir = ctx.config.outDir;
  const cfg = ctx.config.tolerance.qa ?? { systemicMinOccurrences: 3, synthesise: true };

  const evidenceIndexPath = join(outDir, 'evidence', 'index.json');
  const evidenceIndex = existsSync(evidenceIndexPath)
    ? JSON.parse(readFileSync(evidenceIndexPath, 'utf8'))
    : [];

  const meta = {
    figmaFileKey: ctx.config.figmaFileKey,
    pageUrl: ctx.config.pageUrl,
    fixFirstLimit: cfg.fixFirstLimit ?? 10,
  };

  let sectionReports = buildSectionReports(
    ctx.issues.issues, ctx.structural, ctx.sections, evidenceIndex, meta
  );
  const systemic = buildSystemic(ctx.issues.systemic, { minOccurrences: cfg.systemicMinOccurrences ?? 3 });
  const confidence = confidenceNote(QUALITY);

  // --- synthesis: wording only, and entirely optional -----------------------
  let synth = { ok: false, reason: 'disabled', items: [] };
  const stats = { accepted: 0, rejected: 0 };
  if (cfg.synthesise !== false && process.env.GEMINI_API_KEY) {
    // Only the issues a reader actually meets get synthesised copy.
    //
    // Rewording all 255 costs seven requests against a free-tier ceiling of
    // TWENTY PER DAY PER MODEL - so a single audit consumes a third of the
    // day's budget to reword issues nobody scrolls to. The landing view shows
    // ten; the rest keep their deterministic wording, which is complete and
    // correct on its own.
    const all = sectionReports.flatMap((s) => s.issues);
    const flat = [...all]
      .sort((a, b) => (b.visualSeverity ?? 0) - (a.visualSeverity ?? 0))
      .slice(0, cfg.synthesiseTop ?? 40);

    synth = await synthesiseAll(flat, { apiKey: process.env.GEMINI_API_KEY });
    if (synth.ok) {
      const applied = new Map(applySynthesis(flat, synth.items, stats).map((i) => [i.ref, i]));
      sectionReports = sectionReports.map((s) => ({ ...s, issues: s.issues.map((i) => applied.get(i.ref) ?? i) }));
    }
  }

  const page = buildPageReport(sectionReports, systemic, confidence, meta);

  mkdirSync(join(outDir, 'qa'), { recursive: true });
  writeFileSync(join(outDir, 'qa', 'report.json'), JSON.stringify({ page, sections: sectionReports }, null, 2));
  writeFileSync(join(outDir, 'qa', 'report.html'), renderPageReport(page, sectionReports));
  for (const s of sectionReports) {
    writeFileSync(join(outDir, 'qa', `section-${String(s.webIndex).padStart(2, '0')}.html`),
      renderSectionReport(s, confidence, meta));
  }

  const withEvidence = sectionReports.flatMap((s) => s.issues).filter((i) => i.evidence).length;
  const total = page.totals.issues;

  console.log(`\n  ${C.bold}E7 VISUAL QA REPORT${C.reset}`);
  console.log(`  ${total} issues across ${page.totals.sections} sections · ${page.totals.affectedElements} elements affected`);
  console.log(`  ${page.totals.systemicGroups} systemic groups, ${page.totals.sharedFixes} look like a shared token fix`);
  console.log(`  ${withEvidence}/${total} issues carry a side-by-side screenshot`);
  console.log(`  synthesis: ${synth.ok
    ? `${C.green}on${C.reset} — ${stats.accepted} strings accepted, ${stats.rejected} rejected by the guard`
    : `${C.yellow}off${C.reset} (${synth.reason}) — deterministic wording used throughout`}`);
  console.log(`  ${C.dim}${confidence.text.split('.')[0]}.${C.reset}`);
  console.log(`  ${C.dim}out/qa/report.html · out/qa/section-*.html · out/qa/report.json${C.reset}\n`);

  ctx.qa = { page, sections: sectionReports };
  ctx.stageInfo = {
    issues: total,
    sections: page.totals.sections,
    systemic: page.totals.systemicGroups,
    withEvidence,
    synthesis: synth.ok ? 'applied' : `skipped: ${synth.reason}`,
    out: 'out/qa/report.html',
  };
}

/**
 * "Generate Full Page Report" — the standalone action.
 *
 * Reads what E5/E6 already produced and rebuilds only the page-level view. No
 * extraction, no correspondence, no comparison, no screenshots.
 */
export async function generateFullPageReport(outDir, config, { synthesise: wantSynth = true } = {}) {
  const read = (p) => JSON.parse(readFileSync(join(outDir, p), 'utf8'));
  const issues = read('issues.json');
  const structural = existsSync(join(outDir, 'structural.json')) ? read('structural.json') : [];
  const sections = read('sections.json');
  const evidenceIndex = existsSync(join(outDir, 'evidence', 'index.json'))
    ? read(join('evidence', 'index.json')) : [];

  const meta = { figmaFileKey: config.figmaFileKey, pageUrl: config.pageUrl };
  let sectionReports = buildSectionReports(issues.issues, structural, sections, evidenceIndex, meta);
  const systemic = buildSystemic(issues.systemic, { minOccurrences: 3 });
  const confidence = confidenceNote(QUALITY);

  if (wantSynth && process.env.GEMINI_API_KEY) {
    // Same budget discipline as the stage - see the note there.
    const flat = sectionReports.flatMap((s) => s.issues)
      .sort((a, b) => (b.visualSeverity ?? 0) - (a.visualSeverity ?? 0))
      .slice(0, 40);
    const synth = await synthesiseAll(flat, { apiKey: process.env.GEMINI_API_KEY });
    if (synth.ok) {
      const applied = new Map(applySynthesis(flat, synth.items).map((i) => [i.ref, i]));
      sectionReports = sectionReports.map((s) => ({ ...s, issues: s.issues.map((i) => applied.get(i.ref) ?? i) }));
    }
  }

  const page = buildPageReport(sectionReports, systemic, confidence, meta);
  mkdirSync(join(outDir, 'qa'), { recursive: true });
  writeFileSync(join(outDir, 'qa', 'report.html'), renderPageReport(page, sectionReports));
  writeFileSync(join(outDir, 'qa', 'report.json'), JSON.stringify({ page, sections: sectionReports }, null, 2));
  return { page, sections: sectionReports };
}
