/**
 * X2 - the text ablation. docs/v2-e2-rearchitecture.md §6.1.
 *
 *   node src/correspond/ablate-text.js [runDir]
 *
 * The Tier 2 contract states the no-text rule as absolute: "No text content,
 * ever. Design copy and live copy legitimately differ; `hasText` is a boolean."
 * That reasoning is sound for VALUES - a string the model never sees is a string
 * it cannot echo back as a finding - and this experiment does not challenge it.
 *
 * It challenges the rule for IDENTITY, which is a different question. Text is
 * the strongest identity signal either side carries, and the ranker is pure
 * code: nothing it reads can reach a report.
 *
 * So the string is joined back on from the IR snapshots HERE, in the experiment,
 * and E1's element record is left exactly as it is. If the ablation shows a
 * gain, adding `textKey` to E1 becomes a deliberate contract amendment with a
 * measurement behind it. If it does not, the existing rule stands on evidence
 * rather than on assertion, which is worth the same half day.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeText } from '../ir/text.js';
import { shortlistRecall } from './score.js';

const TRUTH_DIR = 'fixtures/spike';
const KS = [1, 3, 5, 8, 12];
const WEIGHTS = [0, 0.25, 0.5, 0.75, 1, 1.5, 2];

const runDir = process.argv[2] || 'out';
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

const cfg = read('config/tolerance-default.json').correspond;
const elements = read(join(runDir, 'elements.json'));

/**
 * id -> normalized text, from the IR snapshots rather than from E1.
 *
 * Capped at 120 characters. A design paragraph and its built counterpart agree
 * in their opening words and diverge later far more often than the reverse, and
 * an uncapped body string lets one long paragraph dominate every bigram set it
 * touches.
 */
function textIndex(snapshot) {
  const map = new Map();
  for (const node of snapshot.nodes) {
    if (!node.text || !node.text.trim()) continue;
    const norm = normalizeText(node.text).slice(0, 120);
    if (norm) map.set(node.id, norm);
  }
  return map;
}

const figmaText = textIndex(read(join(runDir, 'figma-ir.json')));
const webText = textIndex(read(join(runDir, 'web-ir.json')));

/** One accessor for both sides - element ids are unique across a run. */
const textOf = (el) => figmaText.get(el.id) ?? webText.get(el.id) ?? null;

const files = readdirSync(TRUTH_DIR).filter((f) => f.endsWith('.json')).sort();
if (!existsSync(TRUTH_DIR) || !files.length) { console.error(`No ground truth in ${TRUTH_DIR}`); process.exit(1); }

const sheets = files.map((file) => {
  const truth = read(join(TRUTH_DIR, file));
  const pair = elements.pairs.find((p) => p.figmaIndex === truth.figmaIndex && p.webIndex === truth.webIndex);
  return pair ? { name: file.replace(/\.json$/, ''), truth, pair } : null;
}).filter(Boolean);

console.log('\n  X2 — TEXT ABLATION\n');

// --- coverage first. A feature present on a tenth of elements cannot move a
// --- pooled metric, and knowing that before reading the sweep prevents
// --- attributing a flat result to the feature rather than to its absence.
let fCov = 0, fTot = 0, wCov = 0, wTot = 0, bothSides = 0, truthRows = 0;
for (const { truth, pair } of sheets) {
  for (const el of pair.figma.elements) { fTot++; if (textOf(el)) fCov++; }
  for (const el of pair.web.elements) { wTot++; if (textOf(el)) wCov++; }
  for (const [key, want] of Object.entries(truth.truth)) {
    if (typeof want !== 'number') continue;
    const f = pair.figma.elements[Number(key)], w = pair.web.elements[want];
    truthRows++;
    if (f && w && textOf(f) && textOf(w)) bothSides++;
  }
}
console.log(`  text coverage   figma ${fCov}/${fTot} (${(fCov / fTot * 100).toFixed(1)}%)   web ${wCov}/${wTot} (${(wCov / wTot * 100).toFixed(1)}%)`);
console.log(`  true pairs where BOTH sides carry text: ${bothSides}/${truthRows} (${(bothSides / truthRows * 100).toFixed(1)}%)`);
console.log(`  => the ablation can only move those ${bothSides} rows; the rest are unaffected by construction\n`);

// --- the sweep ---------------------------------------------------------------
console.log('  textWeight   ' + KS.map((k) => `@${k}`.padStart(6)).join('  '));

const results = [];
for (const textWeight of WEIGHTS) {
  const tuned = { ...cfg, textWeight };
  const ctx = textWeight ? { textOf } : {};
  const hits = Object.fromEntries(KS.map((k) => [k, 0]));
  let total = 0;

  for (const { truth, pair } of sheets) {
    const sl = shortlistRecall(truth, pair, tuned, { ks: KS, ctx });
    total += sl.total;
    for (const k of KS) hits[k] += sl.hits[k];
  }

  results.push({ textWeight, total, hits });
  console.log(`  ${String(textWeight).padEnd(11)}` +
    KS.map((k) => `${(hits[k] / total * 100).toFixed(1)}%`.padStart(6)).join('  '));
}

// --- dev vs held-out ---------------------------------------------------------
// `textWeight` is a threshold, and this script is where it would be chosen, so
// it is chosen on the dev sheets and REPORTED on the held-out ones. Same split
// as tier2-run.js:106; it must not be rebalanced to improve a number.
const HELD_OUT = new Set(['f17-w18', 'f6-w7', 'f8-w9', 'f15-w16']);

console.log('\n  dev (f12-w13, f14-w15) vs held-out (the other four)\n');
console.log('  textWeight        dev @1     dev @8   |   held @1   held @8');
for (const textWeight of WEIGHTS) {
  const tuned = { ...cfg, textWeight };
  const ctx = textWeight ? { textOf } : {};
  const acc = { dev: { t: 0, 1: 0, 8: 0 }, held: { t: 0, 1: 0, 8: 0 } };

  for (const { name, truth, pair } of sheets) {
    const sl = shortlistRecall(truth, pair, tuned, { ks: [1, 8], ctx });
    const b = HELD_OUT.has(name) ? acc.held : acc.dev;
    b.t += sl.total; b[1] += sl.hits[1]; b[8] += sl.hits[8];
  }

  const p = (b, k) => `${(b[k] / Math.max(1, b.t) * 100).toFixed(1)}%`.padStart(8);
  console.log(`  ${String(textWeight).padEnd(12)}${p(acc.dev, 1)}${p(acc.dev, 8)}   |${p(acc.held, 1)}${p(acc.held, 8)}`);
}

// --- verdict -----------------------------------------------------------------
const base = results[0];
const best = results.slice(1).reduce((a, b) => (b.hits[8] > a.hits[8] ? b : a), results[1]);
const d1 = (best.hits[1] - base.hits[1]) / base.total * 100;
const d8 = (best.hits[8] - base.hits[8]) / base.total * 100;

console.log(`\n  baseline (textWeight 0)   @1 ${(base.hits[1] / base.total * 100).toFixed(1)}%   @8 ${(base.hits[8] / base.total * 100).toFixed(1)}%`);
console.log(`  best (textWeight ${best.textWeight})        @1 ${(best.hits[1] / best.total * 100).toFixed(1)}%   @8 ${(best.hits[8] / best.total * 100).toFixed(1)}%`);
console.log(`  delta                     @1 ${d1 >= 0 ? '+' : ''}${d1.toFixed(1)}pts   @8 ${d8 >= 0 ? '+' : ''}${d8.toFixed(1)}pts`);

// The inert check is not decoration. scoreFeatures must ignore the feature
// entirely at weight 0, or the "baseline" is not a baseline.
const inert = base.hits[8] === results.find((r) => r.textWeight === 0).hits[8];
console.log(`\n  weight-0 inertness: ${inert ? 'confirmed' : 'FAILED — the feature leaks at weight 0'}\n`);
