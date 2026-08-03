/**
 * P5 + P6 stage wiring.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pruneSnapshot } from './prune.js';
import { measureSpacing } from './spacing.js';

const fmtReasons = (reasons) =>
  Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');

/** P5 - prune both sides. */
export async function stagePrune(ctx) {
  const out = {};
  for (const side of ['figma', 'web']) {
    const snap = ctx.snapshots[side];
    if (!snap) continue;
    const { snapshot, stats } = pruneSnapshot(snap);
    ctx.snapshots[side] = snapshot;
    out[side] = stats;
  }
  ctx.diagnostics.prune = out;

  const f = out.figma;
  const w = out.web;
  ctx.stageInfo = {
    figma: f ? `${f.before}->${f.after} (-${f.removedPct}%)` : null,
    web: w ? `${w.before}->${w.after} (-${w.removedPct}%)` : null,
    // Parent doc 6.1 claims pruning alone closes most of the structural gap.
    // This ratio is the test of that claim.
    ratio: f && w ? (w.after / f.after).toFixed(2) : null,
  };

  if (ctx.flags.verbose) {
    if (f) console.log(`      figma reasons: ${fmtReasons(f.reasons)}`);
    if (w) console.log(`      web   reasons: ${fmtReasons(w.reasons)}`);
  }
}

/** P6 - measured spacing on both sides. */
export async function stageSpacing(ctx) {
  const out = {};
  for (const side of ['figma', 'web']) {
    const snap = ctx.snapshots[side];
    if (!snap) continue;
    const { snapshot, stats } = measureSpacing(snap);
    ctx.snapshots[side] = snapshot;
    out[side] = stats;
  }
  ctx.diagnostics.spacing = out;

  // Persist the pruned + measured IR - this is what S1 onward consumes.
  for (const side of ['figma', 'web']) {
    if (!ctx.snapshots[side]) continue;
    writeFileSync(
      join(ctx.config.outDir, `${side}-ir.json`),
      JSON.stringify(ctx.snapshots[side], null, 2)
    );
  }

  ctx.stageInfo = {
    figmaGaps: out.figma ? out.figma.totalGaps : null,
    webGaps: out.web ? out.web.totalGaps : null,
  };
}
