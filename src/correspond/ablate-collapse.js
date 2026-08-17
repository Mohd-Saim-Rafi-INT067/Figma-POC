/**
 * X3 - collapse symmetry, and its effect on the one-to-one ceiling.
 * docs/v2-e2-rearchitecture.md §3.3.
 *
 *   node src/correspond/ablate-collapse.js [runDir]
 *
 * 29 of 161 true matches (18.0%) are many-to-one and therefore unwinnable under
 * a one-to-one matcher. The ground truth diagnoses them as a DESIGN-SIDE
 * ARTEFACT - stacked control frames and container+label pairs the page builds as
 * one element - which makes them an E1 collapse problem, not a correspondence
 * problem. This measures whether collapsing coincident shells removes them.
 *
 * THE TRAP, and the reason this file is longer than the rule it tests:
 *
 *   The truth sheets are keyed by `orderIndex`. Changing the element set
 *   renumbers every element, so scoring a new element set against an old sheet
 *   silently compares unrelated elements. The repo has already been bitten:
 *   f6-w7._whyRescored records 24 elements moving and concludes "counts are not
 *   sufficient to validate index stability - element identity must be checked."
 *
 * So the sheets are REMAPPED THROUGH ELEMENT IDS, which are IR node ids and
 * stable across collapse rules, and every row that cannot be remapped is
 * reported rather than dropped.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildAllElementSets } from '../elements/build.js';
import { irIndex, remapTruth, oneToOneLoss } from './remap.js';

const TRUTH_DIR = 'fixtures/spike';
const runDir = process.argv[2] || 'out';
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

const tolerance = read('config/tolerance-default.json');
const snapshots = { figma: read(join(runDir, 'figma-ir.json')), web: read(join(runDir, 'web-ir.json')) };
const sections = read(join(runDir, 'sections.json'));
const saved = read(join(runDir, 'section-alignment.json'));

const alignment = {
  pairs: saved.pairs.map((p) => ({
    figma: p.figmaIndex == null ? null : { index: p.figmaIndex },
    web: p.webIndex == null ? null : { index: p.webIndex },
    confidence: p.confidence,
  })),
};

const build = (elementsCfg) => buildAllElementSets(snapshots, sections, alignment, elementsCfg);

const baseline = build({ ...tolerance.elements, collapseCoincidentChain: false });
const collapsed = build({ ...tolerance.elements, collapseCoincidentChain: true, coincidenceTolPx: 2 });

const ir = { figma: irIndex(snapshots.figma), web: irIndex(snapshots.web) };

// --- report ------------------------------------------------------------------
console.log('\n  X3 — COLLAPSE SYMMETRY (coincident single-child shells)\n');

const files = readdirSync(TRUTH_DIR).filter((f) => f.endsWith('.json')).sort();
const tot = {
  baseTrue: 0, baseExcess: 0, newTrue: 0, newExcess: 0,
  merged: 0, lost: 0, moved: 0, fDrop: 0, wDrop: 0,
};

console.log('  sheet        elements f/w      -> after      1:1 loss   after   merged/lost');
for (const file of files) {
  const truth = read(join(TRUTH_DIR, file));
  const basePair = baseline.find((p) => p.figmaIndex === truth.figmaIndex && p.webIndex === truth.webIndex);
  const newPair = collapsed.find((p) => p.figmaIndex === truth.figmaIndex && p.webIndex === truth.webIndex);
  if (!basePair || !newPair) { console.log(`  ${file}: pair not in this run; skipped`); continue; }

  const before = oneToOneLoss(truth.truth);
  const { truth: remapped, stats } = remapTruth(truth, basePair, newPair, ir);
  const after = oneToOneLoss(remapped);

  const fb = basePair.figma.elements.length, fa = newPair.figma.elements.length;
  const wb = basePair.web.elements.length, wa = newPair.web.elements.length;

  console.log(`  ${file.replace('.json', '').padEnd(10)} ${String(fb).padStart(3)}/${String(wb).padEnd(3)}` +
    ` -> ${String(fa).padStart(3)}/${String(wa).padEnd(3)}` +
    `   ${String(before.excess).padStart(6)}  ${String(after.excess).padStart(6)}` +
    `      ${stats.merged}/${stats.lost}`);

  tot.baseTrue += before.total; tot.baseExcess += before.excess;
  tot.newTrue += after.total;   tot.newExcess += after.excess;
  tot.merged += stats.merged;   tot.lost += stats.lost;   tot.moved += stats.moved;
  tot.fDrop += fb - fa;         tot.wDrop += wb - wa;
}

const pct = (n, d) => `${(n / Math.max(1, d) * 100).toFixed(1)}%`;
console.log(`\n  ── ELEMENT SETS ────────────────────────────────────`);
console.log(`  design elements removed  ${tot.fDrop}`);
console.log(`  page elements removed    ${tot.wDrop}   (symmetric rule; a design-only effect here means the shape is design-only)`);

console.log(`\n  ── ONE-TO-ONE CEILING ──────────────────────────────`);
console.log(`  before   ${tot.baseExcess} of ${tot.baseTrue} unreachable (${pct(tot.baseExcess, tot.baseTrue)})   ceiling ${pct(tot.baseTrue - tot.baseExcess, tot.baseTrue)}`);
console.log(`  after    ${tot.newExcess} of ${tot.newTrue} unreachable (${pct(tot.newExcess, tot.newTrue)})   ceiling ${pct(tot.newTrue - tot.newExcess, tot.newTrue)}`);

console.log(`\n  ── TRUTH REMAPPING ─────────────────────────────────`);
console.log(`  rows merged (two design rows became one element)  ${tot.merged}`);
console.log(`  rows moved to a new index                         ${tot.moved}`);
console.log(`  rows LOST (no surviving representative)           ${tot.lost}`);
if (tot.lost) console.log(`  ^ a non-zero loss means the rule deletes elements the truth cares about — investigate before adopting`);
console.log('');
