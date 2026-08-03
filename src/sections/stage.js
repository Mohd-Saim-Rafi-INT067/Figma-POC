/**
 * S1 stage wiring + the human-readable section tables.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { segmentSnapshot } from './segment.js';
import { alignSections } from './match.js';
import { compareSections } from './compare.js';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m', yellow: '\x1b[33m' };

function printTable(result) {
  const pct = (v) => (v * 100).toFixed(1).padStart(5) + '%';
  console.log(`\n  ${C.bold}${result.side.toUpperCase()}${C.reset} ${C.dim}— ${result.sections.length} sections, total height ${Math.round(result.totalHeight)}px${result.unwrappedTo ? `, unwrapped to ${result.unwrappedTo}` : ''}${C.reset}`);
  console.log(`  ${C.dim}  #  y%      h%      height  nodes  txt  colors  sizes  headline${C.reset}`);
  for (const s of result.sections) {
    const d = s.digest;
    console.log(
      `  ${String(s.index + 1).padStart(3)}  ${pct(s.normalizedY)}  ${pct(s.normalizedHeight)}  ` +
      `${String(Math.round(s.height)).padStart(6)}  ${String(d.nodeCount).padStart(5)}  ` +
      `${String(d.textNodes).padStart(3)}  ${String(d.colorSet.length).padStart(6)}  ` +
      `${String(d.fontSizeSet.length).padStart(5)}  ${C.dim}${s.headline ?? '(no text)'}${C.reset}`
    );
  }
  const r = result.rejected;
  if (r.thin || r.narrow) {
    console.log(`  ${C.dim}rejected: ${r.thin} thin/decorative, ${r.narrow} narrow (floating widgets)${C.reset}`);
  }
}

export async function stageSegment(ctx) {
  const cfg = ctx.config.tolerance.segmentation;
  const out = {};

  for (const side of ['figma', 'web']) {
    const snap = ctx.snapshots[side];
    if (!snap) continue;
    out[side] = segmentSnapshot(snap, cfg);
  }

  ctx.sections = out;
  writeFileSync(join(ctx.config.outDir, 'sections.json'), JSON.stringify(out, null, 2));

  if (out.figma) printTable(out.figma);
  if (out.web) printTable(out.web);
  console.log('');

  ctx.stageInfo = {
    figma: out.figma ? out.figma.sections.length : null,
    web: out.web ? out.web.sections.length : null,
    out: 'out/sections.json',
  };
}

const conf = (c) => (c >= 0.75 ? '\x1b[32m' : c >= 0.55 ? '\x1b[33m' : '\x1b[31m');

function printAlignment(alignment) {
  console.log(`\n  ${C.bold}SECTION ALIGNMENT${C.reset}`);
  console.log(`  ${C.dim}  figma                              web                                conf${C.reset}`);

  for (const p of alignment.pairs) {
    const fLabel = p.figma
      ? `#${String(p.figma.index + 1).padStart(2)} ${String(Math.round(p.figma.height)).padStart(5)}px ${(p.figma.headline || '').slice(0, 20).padEnd(20)}`
      : ' '.repeat(30);
    const wLabel = p.web
      ? `#${String(p.web.index + 1).padStart(2)} ${String(Math.round(p.web.height)).padStart(5)}px ${(p.web.headline || '').slice(0, 20).padEnd(20)}`
      : ' '.repeat(30);

    if (p.figma && p.web) {
      const ratio = (p.web.height / p.figma.height).toFixed(2);
      const flag = ratio > 1.5 || ratio < 0.67 ? ` ${C.yellow}h×${ratio}${C.reset}` : ` ${C.dim}h×${ratio}${C.reset}`;
      console.log(`  ${fLabel} ${C.dim}<->${C.reset} ${wLabel} ${conf(p.confidence)}${p.confidence.toFixed(2)}${C.reset}${flag}`);
    } else if (p.figma) {
      console.log(`  ${fLabel} ${C.dim}---${C.reset} ${C.yellow}${'(missing in web)'.padEnd(30)}${C.reset}`);
    } else {
      console.log(`  ${' '.repeat(30)} ${C.dim}---${C.reset} ${wLabel} ${C.yellow}(extra in web)${C.reset}`);
    }
  }

  const s = alignment.stats;
  console.log(
    `  ${C.dim}matched ${s.matched}, missing-in-web ${s.missingInWeb}, extra-in-web ${s.extraInWeb}` +
    `${s.demoted ? `, demoted ${s.demoted}` : ''}, mean confidence ${s.meanConfidence}${C.reset}`
  );
}

/** S2 - align the two section lists. */
export async function stageMatch(ctx) {
  const { figma, web } = ctx.sections || {};
  if (!figma || !web) throw new Error('S2 requires both sides; run the full pipeline.');

  const alignment = alignSections(figma.sections, web.sections, ctx.config.tolerance.matching);
  ctx.alignment = alignment;

  writeFileSync(
    join(ctx.config.outDir, 'section-alignment.json'),
    JSON.stringify(
      {
        stats: alignment.stats,
        pairs: alignment.pairs.map((p) => ({
          figmaIndex: p.figma ? p.figma.index : null,
          figmaLabel: p.figma ? p.figma.label : null,
          figmaHeadline: p.figma ? p.figma.headline : null,
          figmaHeight: p.figma ? p.figma.height : null,
          webIndex: p.web ? p.web.index : null,
          webLabel: p.web ? p.web.label : null,
          webHeadline: p.web ? p.web.headline : null,
          webHeight: p.web ? p.web.height : null,
          confidence: p.confidence,
          cost: p.cost,
          parts: p.parts ?? null,
          demoted: p.demoted ?? false,
        })),
      },
      null,
      2
    )
  );

  printAlignment(alignment);
  console.log('');
  ctx.stageInfo = { ...alignment.stats, out: 'out/section-alignment.json' };
}

/** S3 - compare matched section pairs. */
export async function stageCompare(ctx) {
  if (!ctx.alignment) throw new Error('S3 requires S2 output.');

  const findings = compareSections(ctx.alignment, ctx.sections, ctx.config.tolerance);
  ctx.findings = findings;

  writeFileSync(join(ctx.config.outDir, 'findings.json'), JSON.stringify(findings, null, 2));

  const bySeverity = {};
  const byCategory = {};
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
    byCategory[f.category] = (byCategory[f.category] || 0) + 1;
  }

  // Guard the V1 contract structurally, not by convention: no finding may carry
  // text content. A regression here would be silent and would undo the whole
  // "design copy and live copy legitimately differ" premise.
  const textLeak = findings.filter(
    (f) => typeof f.actual === 'string' && f.actual.length > 60 && /\s/.test(f.actual)
  );
  if (textLeak.length) {
    throw new Error(
      `S3 produced ${textLeak.length} findings that look like they carry text content. ` +
        'V1 must never report text. First: ' + JSON.stringify(textLeak[0]).slice(0, 200)
    );
  }

  ctx.stageInfo = {
    findings: findings.length,
    ...bySeverity,
    out: 'out/findings.json',
  };
  ctx.diagnostics.findingCounts = { bySeverity, byCategory };
}
