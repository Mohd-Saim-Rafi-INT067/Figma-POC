/**
 * E3 stage wiring + the structural table.
 *
 * Runs Tier 1 correspondence only. Tier 2 needs an LLM call per section and E3
 * must stay deterministic and free to run; Tier 2 pairs are folded in by the
 * benchmark harness when they exist.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { anchorSection } from '../correspond/anchors.js';
import { structuralVerdict } from './structural.js';
import { compareElementPairs } from './properties.js';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m' };
const tint = (v) => (v >= 0.6 ? C.green : v >= 0.35 ? C.yellow : C.red);
const pct = (v) => `${(v * 100).toFixed(0)}%`;

export async function stageStructural(ctx) {
  if (!ctx.elements?.pairs?.length) throw new Error('E3 requires E1 output.');

  const cfg = ctx.config.tolerance;
  const results = [];

  for (const pair of ctx.elements.pairs) {
    const tier1 = anchorSection(pair.figma, pair.web, cfg.correspond);
    const verdict = structuralVerdict(pair.figma, pair.web, tier1.pairs, cfg.structural);
    results.push({ figmaIndex: pair.figmaIndex, webIndex: pair.webIndex, sectionConfidence: pair.confidence, ...verdict });
  }

  ctx.structural = results;
  writeFileSync(join(ctx.config.outDir, 'structural.json'), JSON.stringify(results, null, 2));

  const sum = (f) => results.reduce((n, r) => n + f(r), 0);
  const alignedPairs = sum((r) => r.coverage.alignedPairs);
  const figmaEls = sum((r) => r.coverage.figmaElements);
  const webEls = sum((r) => r.coverage.webElements);
  const dummy = sum((r) => r.coverage.dummyInstances);
  const suppressed = sum((r) => r.suppressedCountDifferences.length);
  const claims = sum((r) => r.findings.length);

  console.log(`\n  ${C.bold}E3 STRUCTURAL VERDICT${C.reset}  ${C.dim}aligned / not-aligned — never "missing"${C.reset}`);
  console.log(`  ${C.dim}  pair    aligned  design cov  page cov   dummy  suppressed  claims${C.reset}`);
  for (const r of results) {
    console.log(
      `  ${String(r.figmaIndex + 1).padStart(2)}->${String(r.webIndex + 1).padEnd(2)}  ${String(r.coverage.alignedPairs).padStart(7)}  ` +
      `${tint(r.coverage.figma)}${pct(r.coverage.figma).padStart(9)}${C.reset}  ${tint(r.coverage.web)}${pct(r.coverage.web).padStart(8)}${C.reset}  ` +
      `${String(r.coverage.dummyInstances).padStart(6)}  ${String(r.suppressedCountDifferences.length).padStart(10)}  ${String(r.findings.length).padStart(6)}`
    );
  }

  console.log(
    `\n  ${C.bold}TOTAL${C.reset}  ${alignedPairs} aligned pairs · ` +
    `design coverage ${tint(alignedPairs / figmaEls)}${pct(alignedPairs / figmaEls)}${C.reset} (${alignedPairs}/${figmaEls}) · ` +
    `page coverage ${tint(alignedPairs / webEls)}${pct(alignedPairs / webEls)}${C.reset} (${alignedPairs}/${webEls})`
  );
  console.log(`         ${figmaEls - alignedPairs} design elements NOT ALIGNED ${C.dim}— not a defect claim; correspondence was not established${C.reset}`);
  console.log(`         ${dummy} explained as surplus instances of a repeated group ${C.dim}(dummy content, suppressed by design)${C.reset}`);
  console.log(`         ${suppressed} group count differences suppressed ${C.dim}(three designed cards vs twelve built is data, not a defect)${C.reset}`);
  console.log(`         ${claims === 0 ? C.dim : C.yellow}${claims} structural claim(s)${C.reset} ${C.dim}— absence asserted only where absence is evidence${C.reset}\n`);

  ctx.stageInfo = {
    pairs: results.length,
    aligned: alignedPairs,
    notAligned: figmaEls - alignedPairs,
    dummyInstances: dummy,
    suppressed,
    claims,
    out: 'out/structural.json',
  };
}

/** E4 - per-element property comparison across every aligned pair. */
export async function stageProperties(ctx) {
  if (!ctx.structural) throw new Error('E4 requires E3 output.');
  if (!ctx.snapshots?.figma || !ctx.snapshots?.web) throw new Error('E4 requires both IR snapshots.');

  const tol = ctx.config.tolerance;
  const nodes = {
    figma: new Map(ctx.snapshots.figma.nodes.map((n) => [n.id, n])),
    web: new Map(ctx.snapshots.web.nodes.map((n) => [n.id, n])),
  };

  const findings = [];
  const perSection = [];

  for (const [i, pair] of ctx.elements.pairs.entries()) {
    const aligned = ctx.structural[i].aligned;
    const got = compareElementPairs(pair, aligned, nodes, tol);
    findings.push(...got);
    perSection.push({ figmaIndex: pair.figmaIndex, webIndex: pair.webIndex, aligned: aligned.length, findings: got.length });
  }

  ctx.elementFindings = findings;
  writeFileSync(join(ctx.config.outDir, 'element-findings.json'), JSON.stringify(findings, null, 2));

  const byProperty = {};
  const bySeverity = {};
  for (const f of findings) {
    byProperty[f.property] = (byProperty[f.property] || 0) + 1;
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  }
  const folded = findings.filter((f) => f.instanceCount > 1);
  const foldedAway = folded.reduce((n, f) => n + f.instanceCount - 1, 0);

  console.log(`\n  ${C.bold}E4 ELEMENT PROPERTY COMPARISON${C.reset}`);
  console.log(`  ${C.dim}  pair   aligned  findings${C.reset}`);
  for (const s of perSection) {
    console.log(`  ${String(s.figmaIndex + 1).padStart(2)}->${String(s.webIndex + 1).padEnd(2)}  ${String(s.aligned).padStart(7)}  ${String(s.findings).padStart(8)}`);
  }

  console.log(`\n  ${C.bold}TOTAL${C.reset}  ${findings.length} element findings from ${sumAligned(ctx)} aligned pairs`);
  console.log(`         ${C.dim}${foldedAway} instance duplicates folded into ${folded.length} component findings${C.reset}`);
  console.log(`         ${Object.entries(bySeverity).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  const top = Object.entries(byProperty).sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`         ${C.dim}${top.map(([k, v]) => `${k} ${v}`).join(' · ')}${C.reset}\n`);

  ctx.stageInfo = {
    findings: findings.length,
    folded: folded.length,
    foldedAway,
    ...bySeverity,
    out: 'out/element-findings.json',
  };
}

const sumAligned = (ctx) => ctx.structural.reduce((n, s) => n + s.aligned.length, 0);
