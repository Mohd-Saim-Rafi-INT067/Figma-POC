/**
 * Terminal summary. Deterministic, no LLM.
 */

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', mag: '\x1b[35m',
};

const SEV_COLOR = {
  critical: C.mag, high: C.red, medium: C.yellow, low: C.dim,
};

const fmt = (v) => (v === null || v === undefined ? '—' : String(v));

const scoreColor = (s) => (s >= 90 ? C.green : s >= 75 ? C.cyan : s >= 55 ? C.yellow : s >= 35 ? C.red : C.mag);

/** 10-cell bar — a score is easier to scan as a shape than as a number. */
const bar = (score) => {
  const filled = Math.round(score / 10);
  return scoreColor(score) + '█'.repeat(filled) + C.dim + '·'.repeat(10 - filled) + C.reset;
};

export function printReport({ findings, counts, grouped, raw }, alignment, sections, analysis) {
  const line = C.dim + '─'.repeat(74) + C.reset;
  const { exec, sectionScores, issues, fixOrder } = analysis;

  console.log(`\n${line}`);
  console.log(`  ${C.bold}DESIGN PARITY AUDIT${C.reset}`);
  console.log(line);

  // --- assessment ----------------------------------------------------------
  console.log(
    `  ${C.bold}Overall ${scoreColor(exec.overallScore)}${exec.overallScore}/100${C.reset}  ` +
    `${bar(exec.overallScore)}  ${C.bold}${exec.overallStatus}${C.reset}`
  );
  console.log(
    `  ${exec.structuralIntact ? C.green + 'Structure intact' : C.yellow + 'Structure incomplete'}${C.reset}` +
    `${C.dim} — all ${exec.designSections} design sections matched on the page${C.reset}`
  );
  console.log(
    `  Match confidence ${C.cyan}${exec.confidence.percent}%${C.reset} ` +
    `${C.bold}${exec.confidence.verdict}${C.reset}`
  );
  for (const note of exec.confidence.notes) console.log(`   ${C.dim}· ${note}${C.reset}`);

  // --- shape ---------------------------------------------------------------
  const a = alignment.stats;
  console.log('');
  console.log(
    `  sections   ${C.cyan}${a.figmaSections}${C.reset} design  ` +
    `${C.cyan}${a.webSections}${C.reset} page  ` +
    `${C.dim}(${a.matched} matched, ${a.missingInWeb} missing, ${a.extraInWeb} extra)${C.reset}`
  );
  console.log(
    `  findings   ${C.bold}${findings.length}${C.reset}` +
    `${grouped ? C.dim + ` (${raw} raw, ${grouped} grouped away)` + C.reset : ''}`
  );

  const sev = ['critical', 'high', 'medium', 'low']
    .filter((s) => counts.bySeverity[s])
    .map((s) => `${SEV_COLOR[s]}${counts.bySeverity[s]} ${s}${C.reset}`)
    .join(C.dim + ' · ' + C.reset);
  console.log(`  severity   ${sev || C.dim + 'none' + C.reset}`);
  console.log(
    `  category   ${C.dim}` +
    Object.entries(counts.byCategory).sort((x, y) => y[1] - x[1])
      .map(([k, v]) => `${k}:${v}`).join('  ') + C.reset
  );

  // --- fix order -----------------------------------------------------------
  console.log(`\n  ${C.bold}RECOMMENDED FIX ORDER${C.reset}`);
  for (const step of fixOrder) {
    console.log(
      `   ${C.bold}${step.rank}.${C.reset} ${step.label.padEnd(32)} ` +
      `${SEV_COLOR[step.severity]}${step.severity}${C.reset} ` +
      `${C.dim}${step.issueCount} issue${step.issueCount > 1 ? 's' : ''}, ` +
      `${step.sectionCount} section${step.sectionCount > 1 ? 's' : ''}${C.reset}` +
      (step.oneFix ? `  ${C.green}one fix${C.reset}` : step.systemic ? `  ${C.yellow}systemic${C.reset}` : '')
    );
  }

  // --- root-cause issues ---------------------------------------------------
  console.log(`\n  ${C.bold}KEY ISSUES${C.reset} ${C.dim}(grouped by root cause)${C.reset}`);
  for (const issue of issues.slice(0, 8)) {
    console.log(
      `   ${SEV_COLOR[issue.severity]}${issue.severity.toUpperCase().padEnd(8)}${C.reset} ` +
      `${issue.knowledge.title}`
    );
    console.log(
      `            ${C.dim}${issue.sections.length} section${issue.sections.length > 1 ? 's' : ''}` +
      (issue.occurrences ? `, ${issue.occurrences} occurrence${issue.occurrences > 1 ? 's' : ''}` : '') +
      (issue.oneFix ? ' · one root cause' : issue.systemic ? ' · systemic' : '') + C.reset
    );
    if (issue.knowledge.causes.length) {
      console.log(`            ${C.dim}likely: ${issue.knowledge.causes[0]}${C.reset}`);
    }
  }

  // --- per-section ---------------------------------------------------------
  console.log(`\n  ${C.bold}SECTION HEALTH${C.reset}`);
  for (const s of sectionScores) {
    const badge = ['critical', 'high', 'medium', 'low']
      .filter((k) => s.bySeverity[k])
      .map((k) => `${SEV_COLOR[k]}${s.bySeverity[k]}${k[0].toUpperCase()}${C.reset}`)
      .join(' ') || `${C.green}clean${C.reset}`;
    console.log(
      `   ${String(s.figmaIndex + 1).padStart(2)}→${String(s.webIndex + 1).padStart(2)}  ` +
      `${bar(s.score)} ${scoreColor(s.score)}${String(s.score).padStart(3)}${C.reset} ` +
      `${C.dim}${(s.label || '').slice(0, 30).padEnd(30)}${C.reset} ${badge}`
    );
  }

  console.log(`\n${line}\n`);
}
