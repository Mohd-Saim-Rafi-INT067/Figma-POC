/**
 * Replay E1 against a completed run's artifacts - no browser, no Figma quota.
 *
 *   node src/elements/replay.js [runId]
 *
 * P6 persists the pruned + measured IR as `<side>-ir.json`, and that is exactly
 * what S1 onward consumes, so replaying from it is faithful rather than an
 * approximation. This is how the collapse rules get iterated: a full audit costs
 * a browser launch and Figma requests from an account with roughly six of them a
 * month, and E1 has no business spending either.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildAllElementSets } from './build.js';
import { measureGate } from './gate.js';

const RUNS = 'out/runs';

function latestRun() {
  const dirs = readdirSync(RUNS).filter((d) => existsSync(join(RUNS, d, 'section-alignment.json')));
  if (!dirs.length) throw new Error(`No completed run under ${RUNS} carries section-alignment.json`);
  return dirs.sort().at(-1);
}

export function replayRun(runId, tolerance) {
  const dir = join(RUNS, runId);
  const read = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));

  const snapshots = { figma: read('figma-ir.json'), web: read('web-ir.json') };
  const sections = read('sections.json');
  const saved = read('section-alignment.json');

  // section-alignment.json flattens pairs to indices; buildAllElementSets wants
  // the in-memory shape S2 produces.
  const alignment = {
    pairs: saved.pairs.map((p) => ({
      figma: p.figmaIndex == null ? null : { index: p.figmaIndex },
      web: p.webIndex == null ? null : { index: p.webIndex },
      confidence: p.confidence,
    })),
  };

  const cfg = tolerance.elements;
  const gateCfg = { ...tolerance.elementGate, targetCountMin: cfg.targetCountMin, targetCountMax: cfg.targetCountMax };
  const pairs = buildAllElementSets(snapshots, sections, alignment, cfg);
  return { runId, pairs, gate: measureGate(pairs, gateCfg), gateCfg };
}

const invokedDirectly = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('src/elements/replay.js');
if (invokedDirectly) {
  const tolerance = JSON.parse(readFileSync('config/tolerance-default.json', 'utf8'));
  const runId = process.argv[2] || latestRun();
  const { gate, gateCfg, pairs } = replayRun(runId, tolerance);

  const { printGate } = await import('./stage.js');
  printGate(gate, gateCfg);

  const drops = pairs.reduce((acc, p) => {
    for (const side of ['figma', 'web']) {
      for (const [reason, n] of Object.entries(p[side].stats.dropped)) {
        acc[side][reason] = (acc[side][reason] || 0) + n;
      }
    }
    return acc;
  }, { figma: {}, web: {} });

  const fmt = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ');
  console.log(`  replayed ${runId}`);
  console.log(`  dropped  figma: ${fmt(drops.figma)}`);
  console.log(`           web:   ${fmt(drops.web)}\n`);
}
