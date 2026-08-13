/**
 * E5 stage wiring + the issue table.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeByElement, systemicGroups, landingView } from './merge.js';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m' };
const sevColour = (s) => (s === 'critical' ? C.red : s === 'high' ? C.yellow : C.dim);

export async function stageIssues(ctx) {
  if (!ctx.elementFindings) throw new Error('E5 requires E4 output.');

  const cfg = ctx.config.tolerance.issues;
  const issues = mergeByElement(ctx.elementFindings, ctx.elements.pairs, cfg);
  const systemic = systemicGroups(ctx.elementFindings, cfg);
  const landing = landingView(issues, cfg);

  ctx.issues = { issues, systemic, landing };
  writeFileSync(join(ctx.config.outDir, 'issues.json'),
    JSON.stringify({ landing: { shown: landing.shown, remainder: landing.remainder }, issues, systemic }, null, 2));

  console.log(`\n  ${C.bold}E5 ISSUE PRIORITISATION${C.reset}`);
  console.log(`  ${C.dim}${ctx.elementFindings.length} findings -> ${issues.length} element issues -> ${landing.shown.length} in the landing view${C.reset}\n`);
  console.log(`  ${C.dim}  vis   sev       props  sect    element${C.reset}`);
  for (const i of landing.shown.slice(0, 12)) {
    const props = i.properties.map((p) => p.property.replace('boxRelative.', '')).slice(0, 4).join(',');
    console.log(
      `  ${i.visualSeverity.toFixed(3)}  ${sevColour(i.maxSeverity)}${i.maxSeverity.padEnd(8)}${C.reset}  ` +
      `${String(i.properties.length).padStart(5)}  ${String(i.sectionPair.figmaIndex + 1).padStart(2)}->${String(i.sectionPair.webIndex + 1).padEnd(2)}  ` +
      `${C.dim}${i.element.cls.padEnd(7)} ${props}${C.reset}`
    );
  }
  if (landing.remainder) console.log(`  ${C.dim}... and ${landing.remainder} more behind "show all"${C.reset}`);

  const oneFix = systemic.filter((g) => g.oneFix);
  const withinComponent = systemic.filter((g) => g.withinComponent);
  console.log(`\n  ${C.bold}SYSTEMIC${C.reset}  ${systemic.length} groups`);
  for (const g of systemic.slice(0, 6)) {
    const tag = g.oneFix ? `${C.yellow}one fix${C.reset}` : g.withinComponent ? `${C.dim}one component${C.reset}` : '';
    console.log(`  ${String(g.occurrences).padStart(3)}x  ${g.property.padEnd(22)} ${String(g.expected).slice(0, 14).padEnd(15)} -> ${String(g.actual).slice(0, 14).padEnd(15)} ${tag}`);
  }
  console.log(`  ${C.dim}${oneFix.length} groups are a single token fix; ${withinComponent.length} are confined to one component${C.reset}`);

  const cap = cfg.landingViewCap;
  const pass = landing.shown.length <= cap;
  console.log(`\n  ${pass ? C.green : C.red}NFR N3: landing view shows ${landing.shown.length} issues (target < ${cap + 1})${C.reset}\n`);

  ctx.stageInfo = {
    findings: ctx.elementFindings.length,
    issues: issues.length,
    landing: landing.shown.length,
    remainder: landing.remainder,
    systemic: systemic.length,
    out: 'out/issues.json',
  };
}
