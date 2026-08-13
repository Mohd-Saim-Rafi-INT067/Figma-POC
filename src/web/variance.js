/**
 * Quantify extraction nondeterminism.
 *
 *   node src/web/variance.js [runs] [runDir]
 *
 * Runs the full web extraction N times in ONE browser session, then pushes each
 * result through the whole offline pipeline - normalize, prune, spacing,
 * segment, align, E1, Tier 1 - and diffs every stage.
 *
 * Exists because the same code produced 100% and then 75% Tier-1 precision on
 * two different extractions of the same page. Until that is understood, no
 * matching or confidence change can be attributed to the algorithm rather than
 * to the page state it happened to see.
 *
 * Uses the cached Figma IR from `runDir`, so it costs no Figma quota.
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { resolveConfig } from '../config.js';
import { extractWeb } from './extract.js';
import { normalizeWeb } from './normalize.js';
import { pruneSnapshot } from '../pipeline/prune.js';
import { measureSpacing } from '../pipeline/spacing.js';
import { segmentSnapshot } from '../sections/segment.js';
import { alignSections } from '../sections/match.js';
import { buildAllElementSets } from '../elements/build.js';
import { anchorSection } from '../correspond/anchors.js';

const N = Number(process.argv[2]) || 3;
const runDir = process.argv[3] || 'out';
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

const tolerance = read('config/tolerance-default.json');
const figmaIr = read(join(runDir, 'figma-ir.json'));
const savedSections = read(join(runDir, 'sections.json'));
const PAIRS = [[12, 13], [14, 15], [17, 18]];

const config = resolveConfig({ outDir: runDir });
config.viewportWidth = figmaIr.meta.frameWidth;

console.log(`\n  EXTRACTION VARIANCE — ${N} extractions, one browser session, ${config.pageUrl}\n`);

const browser = await chromium.launch({ headless: true });
const runs = [];

try {
  for (let i = 0; i < N; i++) {
    const raw = await extractWeb(config, { browser, log: { log() {}, warn() {} }, skipFonts: true });

    let snap = normalizeWeb(raw, { viewportWidth: config.viewportWidth, viewportHeight: config.viewportHeight });
    const rawCount = snap.nodes.length;
    snap = pruneSnapshot(snap).snapshot;
    snap = measureSpacing(snap).snapshot;

    const webSections = segmentSnapshot(snap, tolerance.segmentation);
    const alignment = alignSections(savedSections.figma.sections, webSections.sections, tolerance.matching);

    const elementPairs = buildAllElementSets(
      { figma: figmaIr, web: snap },
      { figma: savedSections.figma, web: webSections },
      alignment,
      tolerance.elements
    );

    const tier1 = {};
    for (const [fi, wi] of PAIRS) {
      const p = elementPairs.find((x) => x.figmaIndex === fi && x.webIndex === wi);
      tier1[`${fi}-${wi}`] = p
        ? anchorSection(p.figma, p.web, tolerance.correspond).pairs
            .map((m) => `${m.figmaIndex}->${m.webIndex}@${m.confidence}`)
        : null;
    }

    runs.push({ raw: rawCount, pruned: snap.nodes.length, snap, webSections, elementPairs, tier1 });
    console.log(`  run ${i + 1}: raw ${rawCount}, pruned ${snap.nodes.length}, sections ${webSections.sections.length}`);
  }
} finally {
  await browser.close();
}

const uniq = (a) => [...new Set(a)];
const spread = (a) => (uniq(a).length === 1 ? `stable (${a[0]})` : `VARIES ${a.join(' / ')}`);

console.log(`\n  ── COUNTS ──────────────────────────────────────────────`);
console.log(`  raw nodes      ${spread(runs.map((r) => r.raw))}`);
console.log(`  pruned nodes   ${spread(runs.map((r) => r.pruned))}`);
console.log(`  web sections   ${spread(runs.map((r) => r.webSections.sections.length))}`);

// --- which node ids come and go ---------------------------------------------
const idSets = runs.map((r) => new Set(r.snap.nodes.map((n) => n.id)));
const inAll = [...idSets[0]].filter((id) => idSets.every((s) => s.has(id)));
const inSome = uniq(runs.flatMap((r) => r.snap.nodes.map((n) => n.id))).filter((id) => !idSets.every((s) => s.has(id)));

console.log(`\n  ── NODE PRESENCE ───────────────────────────────────────`);
console.log(`  present in every run  ${inAll.length}`);
console.log(`  present in only some  ${inSome.length}`);

const byId0 = new Map(runs[0].snap.nodes.map((n) => [n.id, n]));
const sectionOf = (y) => {
  const s = runs[0].webSections.sections.find((x) => y >= x.y && y < x.y + x.height);
  return s ? s.index : '-';
};
if (inSome.length) {
  const bySection = {};
  for (const id of inSome) {
    const n = byId0.get(id) ?? runs.flatMap((r) => r.snap.nodes).find((x) => x.id === id);
    const sec = n ? sectionOf(n.boxAbsolute.y) : '?';
    bySection[sec] = (bySection[sec] || 0) + 1;
  }
  console.log(`  unstable nodes by web section: ${Object.entries(bySection).sort((a, b) => b[1] - a[1]).map(([s, c]) => `#${s}:${c}`).join('  ')}`);
}

// --- which boxes move -------------------------------------------------------
let moved = 0;
const movers = [];
for (const id of inAll) {
  const boxes = runs.map((r) => r.snap.nodes.find((n) => n.id === id)?.boxAbsolute);
  if (boxes.some((b) => !b)) continue;
  const dx = Math.max(...boxes.map((b) => b.x)) - Math.min(...boxes.map((b) => b.x));
  const dy = Math.max(...boxes.map((b) => b.y)) - Math.min(...boxes.map((b) => b.y));
  if (dx > 1 || dy > 1) { moved++; movers.push({ id, dx: Math.round(dx), dy: Math.round(dy), sec: sectionOf(boxes[0].y) }); }
}
console.log(`\n  ── GEOMETRY ────────────────────────────────────────────`);
console.log(`  nodes present in all runs whose box MOVES: ${moved}`);
for (const m of movers.sort((a, b) => (b.dx + b.dy) - (a.dx + a.dy)).slice(0, 12)) {
  console.log(`    ${m.id.padEnd(8)} section #${String(m.sec).padStart(2)}  dx=${m.dx} dy=${m.dy}`);
}

// --- downstream -------------------------------------------------------------
console.log(`\n  ── E1 ELEMENT COUNTS (the three benchmark pairs) ───────`);
for (const [fi, wi] of PAIRS) {
  const counts = runs.map((r) => {
    const p = r.elementPairs.find((x) => x.figmaIndex === fi && x.webIndex === wi);
    return p ? `${p.figma.elements.length}/${p.web.elements.length}` : 'ABSENT';
  });
  console.log(`  f${fi}->w${wi}   ${spread(counts)}`);
}

console.log(`\n  ── TIER 1 MATCHES ──────────────────────────────────────`);
for (const [fi, wi] of PAIRS) {
  const key = `${fi}-${wi}`;
  const sigs = runs.map((r) => (r.tier1[key] ? r.tier1[key].join(',') : 'ABSENT'));
  const counts = runs.map((r) => (r.tier1[key] ? r.tier1[key].length : 0));
  const identical = uniq(sigs).length === 1;
  console.log(`  f${fi}->w${wi}   ${identical ? 'IDENTICAL' : 'DIFFERS'}   pair counts ${counts.join(' / ')}`);
  if (!identical) {
    const all = uniq(runs.flatMap((r) => r.tier1[key] ?? []));
    const common = all.filter((m) => runs.every((r) => (r.tier1[key] ?? []).includes(m)));
    console.log(`      ${common.length} of ${all.length} match+confidence tuples identical across all runs`);
    const varying = all.filter((m) => !common.includes(m));
    for (const v of varying.slice(0, 8)) {
      const present = runs.map((r, i) => ((r.tier1[key] ?? []).includes(v) ? i + 1 : null)).filter(Boolean);
      console.log(`      ${v.padEnd(22)} only in run(s) ${present.join(',')}`);
    }
  }
}
console.log('');
