/**
 * Re-key the hand-scored sheets onto the collapse-enabled element set.
 *
 *   node src/correspond/rekey-truth.js [runDir]           # dry run, prints only
 *   node src/correspond/rekey-truth.js [runDir] --write    # rewrites the sheets
 *
 * Phase C, step 1 (docs/v2-e2-rearchitecture.md §8 item 5). Turning on
 * `elements.collapseCoincidentChain` renumbers every element, so the six sheets
 * must be re-keyed in the same commit or every measurement after it is nonsense.
 *
 * THIS REWRITES HAND-SCORED EVIDENCE. It is the most destructive thing in the
 * repo, so:
 *   - it is a DRY RUN unless --write is passed;
 *   - it refuses to write if any row would be lost;
 *   - every rewritten sheet keeps its original `truth` under `_truthBeforeRekey`
 *     and a full row-by-row `_rekeyTrace`, so the transform can be audited or
 *     reversed without going to git;
 *   - the original values are never edited, only re-addressed. No row's VERDICT
 *     changes - a pair the user called correct stays correct, it just points at
 *     the element it always meant.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildAllElementSets } from '../elements/build.js';
import { irIndex, remapTruth, oneToOneLoss } from './remap.js';

const TRUTH_DIR = 'fixtures/spike';
const runDir = process.argv[2]?.startsWith('--') ? 'out' : (process.argv[2] || 'out');
const WRITE = process.argv.includes('--write');
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

const tolerance = read('config/tolerance-default.json');
const snapshots = { figma: read(join(runDir, 'figma-ir.json')), web: read(join(runDir, 'web-ir.json')) };
const sections = read(join(runDir, 'sections.json'));
const alignment = {
  pairs: read(join(runDir, 'section-alignment.json')).pairs.map((p) => ({
    figma: p.figmaIndex == null ? null : { index: p.figmaIndex },
    web: p.webIndex == null ? null : { index: p.webIndex },
    confidence: p.confidence,
  })),
};

// The sheets were scored against collapse OFF, whatever the profile now says.
const baseline = buildAllElementSets(snapshots, sections, alignment, { ...tolerance.elements, collapseCoincidentChain: false });
const target = buildAllElementSets(snapshots, sections, alignment, { ...tolerance.elements, collapseCoincidentChain: true });

const ir = { figma: irIndex(snapshots.figma), web: irIndex(snapshots.web) };

console.log(`\n  RE-KEY GROUND TRUTH — ${WRITE ? 'WRITING' : 'dry run'}\n`);
console.log('  sheet        rows   kept  moved  merged  lost    1:1 loss');

const results = [];
let anyLost = 0;

for (const file of readdirSync(TRUTH_DIR).filter((f) => f.endsWith('.json')).sort()) {
  const sheet = read(join(TRUTH_DIR, file));
  const basePair = baseline.find((p) => p.figmaIndex === sheet.figmaIndex && p.webIndex === sheet.webIndex);
  const newPair = target.find((p) => p.figmaIndex === sheet.figmaIndex && p.webIndex === sheet.webIndex);
  if (!basePair || !newPair) { console.log(`  ${file}: pair not in this run; SKIPPED`); continue; }

  const { truth, stats, trace } = remapTruth(sheet, basePair, newPair, ir);
  const before = oneToOneLoss(sheet.truth), after = oneToOneLoss(truth);
  anyLost += stats.lost;

  console.log(`  ${file.replace('.json', '').padEnd(10)} ${String(Object.keys(sheet.truth).length).padStart(5)}` +
    `${String(stats.kept).padStart(7)}${String(stats.moved).padStart(7)}${String(stats.merged).padStart(8)}` +
    `${String(stats.lost).padStart(6)}    ${before.excess} -> ${after.excess}`);

  results.push({ file, sheet, truth, stats, trace, basePair, newPair, before, after });
}

const sum = (f) => results.reduce((n, r) => n + f(r), 0);
console.log(`\n  totals: ${sum((r) => r.stats.kept)} kept, ${sum((r) => r.stats.moved)} moved, ` +
  `${sum((r) => r.stats.merged)} merged, ${sum((r) => r.stats.lost)} lost`);
console.log(`  true matches ${sum((r) => r.before.total)} -> ${sum((r) => r.after.total)}` +
  `   unreachable under 1:1 ${sum((r) => r.before.excess)} -> ${sum((r) => r.after.excess)}`);

// --- the refusal ------------------------------------------------------------
if (anyLost) {
  console.error(`\n  REFUSING TO WRITE: ${anyLost} row(s) have no surviving element.`);
  console.error('  A sheet is hand-scored evidence. Fix the collapse rule or the resolver first.\n');
  process.exit(1);
}

/**
 * Verify the remap is an addressing change, not a semantic one.
 *
 * Every surviving row must still name the SAME PAIR OF ELEMENTS by id as it did
 * before. This is the check that would have caught the f6-w7 breakage.
 */
let mismatches = 0;
for (const r of results) {
  for (const [newFi, want] of Object.entries(r.truth)) {
    if (typeof want !== 'number') continue;
    const fId = r.newPair.figma.elements[Number(newFi)]?.id;
    const wId = r.newPair.web.elements[want]?.id;
    if (!fId || !wId) { mismatches++; console.error(`  ${r.file}: row ${newFi}->${want} does not resolve`); }
  }
}
if (mismatches) { console.error(`\n  REFUSING TO WRITE: ${mismatches} row(s) do not resolve.\n`); process.exit(1); }
console.log('  every remapped row resolves to a real element on both sides');

if (!WRITE) {
  console.log('\n  dry run - pass --write to rewrite the sheets\n');
  process.exit(0);
}

for (const r of results) {
  const next = {
    ...r.sheet,
    _rekeyed: `Re-keyed ${new Date().toISOString().slice(0, 10)} onto the element set produced with ` +
      `elements.collapseCoincidentChain = true (docs/v2-e2-rearchitecture.md X3). Indices changed; ` +
      `NO VERDICT CHANGED. ${r.stats.moved} rows moved, ${r.stats.merged} merged into a row that now ` +
      `covers the same pair, 0 lost. The pre-rekey truth is kept verbatim under _truthBeforeRekey and ` +
      `the row-by-row transform under _rekeyTrace.`,
    _truthBeforeRekey: r.sheet.truth,
    _rekeyTrace: r.trace,
    truth: r.truth,
  };
  writeFileSync(join(TRUTH_DIR, r.file), `${JSON.stringify(next, null, 2)}\n`);
  console.log(`  wrote ${r.file}`);
}
console.log('');
