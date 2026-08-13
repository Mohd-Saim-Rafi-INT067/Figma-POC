/**
 * E1 stage wiring + the Phase 1 gate table.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildAllElementSets } from './build.js';
import { measureGate } from './gate.js';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m' };
const tint = (v, good, ok) => (v >= good ? C.green : v >= ok ? C.yellow : C.red);
const pct = (v) => `${(v * 100).toFixed(0)}%`;

export function printGate(gate, cfg) {
  console.log(`\n  ${C.bold}E1 COMPARABLE ELEMENT SET${C.reset}`);
  console.log(`  ${C.dim}  pair    IR nodes      elements     ratio        ceiling f/w   anchored${C.reset}`);

  for (const r of gate.rows) {
    const label = `${String(r.figmaIndex + 1).padStart(2)}->${String(r.webIndex + 1).padEnd(2)}`;
    const counts = `${String(r.elements.figma).padStart(3)}/${String(r.elements.web).padEnd(3)}`;
    const outOfBand = r.ratioAfter < 1 - cfg.ratioBand || r.ratioAfter > 1 + cfg.ratioBand;
    console.log(
      `  ${label}  ${String(r.irNodes.figma).padStart(4)}/${String(r.irNodes.web).padEnd(4)}  ${counts}  ` +
      `${C.dim}${r.ratioBefore.toFixed(2)}->${C.reset}${outOfBand ? C.yellow + r.ratioAfter.toFixed(2) + C.reset : r.ratioAfter.toFixed(2)}  ` +
      `  ${tint(r.ceilingFigma, 0.8, 0.6)}${pct(r.ceilingFigma)}${C.reset}/${tint(r.ceilingWeb, 0.8, 0.6)}${pct(r.ceilingWeb)}${C.reset}` +
      `      ${String(r.anchored).padStart(3)} ${C.dim}(${pct(r.coverage)})${C.reset}`
    );
  }

  const s = gate.summary;
  console.log(
    `\n  ${C.bold}GATE${C.reset}  ceiling ${tint(s.ceiling.figma, 0.8, 0.6)}${pct(s.ceiling.figma)}${C.reset} figma / ` +
    `${tint(s.ceiling.web, 0.8, 0.6)}${pct(s.ceiling.web)}${C.reset} web` +
    `   ${C.dim}- the fraction with any plausible counterpart; bounds every matcher${C.reset}`
  );
  console.log(
    `        anchor  ${tint(s.anchorCoverage, 0.6, 0.35)}${pct(s.anchorCoverage)}${C.reset} deterministic` +
    `   ${C.dim}- Tier 2 would see ~${s.tier2Workload.figma} figma + ~${s.tier2Workload.web} web elements${C.reset}`
  );
  console.log(
    `        counts  ${s.totalElements.figma} figma / ${s.totalElements.web} web` +
    `   ${C.dim}- ${s.countInTargetBand} pairs inside the ${cfg.targetCountMin}-${cfg.targetCountMax} band, ${s.ratioInBand} inside +/-${pct(cfg.ratioBand)} on ratio${C.reset}`
  );
  console.log(
    `  ${C.dim}Ratio is context, not a verdict: a footer designed with 11 links and built with 52 real ones` +
    ` is comparable and still reads ~2.9.${C.reset}`
  );
}

/** E1 - build the comparable element set for every matched section pair. */
export async function stageElements(ctx) {
  if (!ctx.alignment) throw new Error('E1 requires S2 output.');
  if (!ctx.sections?.figma || !ctx.sections?.web) throw new Error('E1 requires both sides; run the full pipeline.');

  const cfg = ctx.config.tolerance.elements;
  const gateCfg = { ...ctx.config.tolerance.elementGate, targetCountMin: cfg.targetCountMin, targetCountMax: cfg.targetCountMax };

  const pairs = buildAllElementSets(ctx.snapshots, ctx.sections, ctx.alignment, cfg);
  const gate = measureGate(pairs, gateCfg);

  ctx.elements = { pairs, gate };

  writeFileSync(
    join(ctx.config.outDir, 'elements.json'),
    JSON.stringify(
      {
        irSchemaVersion: ctx.snapshots.figma?.irSchemaVersion ?? null,
        gate,
        pairs: pairs.map((p) => ({
          figmaIndex: p.figmaIndex,
          webIndex: p.webIndex,
          confidence: p.confidence,
          figma: p.figma,
          web: p.web,
        })),
      },
      null,
      2
    )
  );

  printGate(gate, gateCfg);
  console.log('');

  const s = gate.summary;
  ctx.stageInfo = {
    pairs: s.pairs,
    figmaElements: s.totalElements.figma,
    webElements: s.totalElements.web,
    ceilingFigma: s.ceiling.figma,
    ceilingWeb: s.ceiling.web,
    anchorCoverage: s.anchorCoverage,
    out: 'out/elements.json',
  };
  ctx.diagnostics.elementGate = s;
}
