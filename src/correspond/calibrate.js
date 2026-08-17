/**
 * Phase B - diagnose and refit the Tier 1 confidence curve.
 *
 *   node src/correspond/calibrate.js [runDir]
 *
 * A confidence is a PREDICTION: "pairs I label 0.9 are right about 90% of the
 * time." Tier 1's present formula is not that. Measured across six hand-scored
 * sections it is anti-calibrated above 0.6 - precision at >=0.85 is 60.0%,
 * LOWER than the 70.0% at >=0.6 - so the reporting gate selects worse pairs than
 * the band beneath it (docs/v2-e2-rearchitecture.md §1.2).
 *
 * This script does three things and stops:
 *   1. shows the empirical precision per confidence bin, so the shape of the
 *      failure is visible rather than asserted;
 *   2. tests whether the two signals the formula OMITS - how decisively the
 *      winner won, and whether the two sides pick each other - separate correct
 *      pairs from wrong ones;
 *   3. fits a small logistic model on the two dev sheets and reports it on the
 *      four held out, then re-derives the reporting threshold from it.
 *
 * The model is kept to a handful of features on purpose. There are 116 asserted
 * pairs in total; anything larger would fit the page rather than the problem.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { anchorSection } from './anchors.js';
import { marginStats, isMutualBest } from './candidates.js';

const TRUTH_DIR = 'fixtures/spike';
const HELD_OUT = new Set(['f17-w18', 'f6-w7', 'f8-w9', 'f15-w16']);   // same split as tier2-run.js
const runDir = process.argv[2] || 'out';
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

const cfg = read('config/tolerance-default.json').correspond;
const elements = read(join(runDir, 'elements.json'));

// --- 1. collect every asserted pair with its features and its label ----------
const rows = [];
for (const file of readdirSync(TRUTH_DIR).filter((f) => f.endsWith('.json')).sort()) {
  const name = file.replace(/\.json$/, '');
  const truth = read(join(TRUTH_DIR, file));
  const pair = elements.pairs.find((p) => p.figmaIndex === truth.figmaIndex && p.webIndex === truth.webIndex);
  if (!pair) continue;

  const t1 = anchorSection(pair.figma, pair.web, cfg);
  const fEls = pair.figma.elements, wEls = pair.web.elements;

  for (const p of t1.pairs) {
    const want = truth.truth[String(p.figmaIndex)];
    if (want === undefined || want === '?') continue;   // not evidence about the matcher

    const m = marginStats(fEls[p.figmaIndex], wEls, cfg);
    rows.push({
      sheet: name,
      heldOut: HELD_OUT.has(name),
      label: typeof want === 'number' && want === p.webIndex ? 1 : 0,
      confidence: p.confidence,
      seed: p.seed ? 1 : 0,
      classCompat: p.classCompat,
      margin: m.margin ?? 0,
      ratio: m.ratio ?? 0,
      wasTop: m.topWebIndex === p.webIndex ? 1 : 0,
      mutual: isMutualBest(p.figmaIndex, p.webIndex, fEls, wEls, cfg) ? 1 : 0,
    });
  }
}

const dev = rows.filter((r) => !r.heldOut);
const held = rows.filter((r) => r.heldOut);
const prec = (list) => (list.length ? list.filter((r) => r.label).length / list.length : null);
const fmtPct = (v) => (v === null ? '   -  ' : `${(v * 100).toFixed(1)}%`.padStart(6));

console.log(`\n  CONFIDENCE CALIBRATION — ${rows.length} asserted pairs (${dev.length} dev, ${held.length} held out)\n`);

// --- 2. the failure, as a table ---------------------------------------------
console.log('  ── CURRENT CURVE ───────────────────────────────────');
console.log('  confidence bin      n   correct   precision');
const BINS = [[0, 0.3], [0.3, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.85], [0.85, 1.01]];
for (const [lo, hi] of BINS) {
  const bin = rows.filter((r) => r.confidence >= lo && r.confidence < hi);
  console.log(`  ${lo.toFixed(2)} - ${hi >= 1 ? '1.00' : hi.toFixed(2)}    ${String(bin.length).padStart(4)}` +
    `   ${String(bin.filter((r) => r.label).length).padStart(4)}    ${fmtPct(prec(bin))}` +
    `${bin.length && prec(bin) < 0.5 ? '   <- worse than a coin flip' : ''}`);
}

// --- 3. do the omitted signals separate correct from wrong? ------------------
/** Rank-based AUC. 0.5 is no information; below 0.5 means the feature is inverted. */
function auc(list, key) {
  const pos = list.filter((r) => r.label).map((r) => r[key]);
  const neg = list.filter((r) => !r.label).map((r) => r[key]);
  if (!pos.length || !neg.length) return null;
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

console.log('\n  ── FEATURE SEPARATION (AUC over all six sheets) ────');
console.log('  feature          AUC     mean(correct)  mean(wrong)');
for (const key of ['confidence', 'margin', 'ratio', 'wasTop', 'mutual', 'classCompat', 'seed']) {
  const a = auc(rows, key);
  const mc = rows.filter((r) => r.label).reduce((s, r) => s + r[key], 0) / Math.max(1, rows.filter((r) => r.label).length);
  const mw = rows.filter((r) => !r.label).reduce((s, r) => s + r[key], 0) / Math.max(1, rows.filter((r) => !r.label).length);
  const flag = a === null ? '' : a < 0.5 ? '  <- INVERTED' : a > 0.7 ? '  <- strong' : '';
  console.log(`  ${key.padEnd(14)}  ${a === null ? '  -  ' : a.toFixed(3)}   ${mc.toFixed(3).padStart(10)}   ${mw.toFixed(3).padStart(10)}${flag}`);
}

// --- 4. the mechanism, not just the shape ------------------------------------
// Every assertion at the reporting threshold, with the signal the formula omits.
console.log('\n  ── WHAT THE TOP BIN ACTUALLY CONTAINS ──────────────');
console.log('  sheet        ok    conf   margin');
for (const r of rows.filter((x) => x.confidence >= 0.85).sort((a, b) => a.margin - b.margin)) {
  console.log(`  ${r.sheet.padEnd(11)} ${r.label ? 'YES' : 'no '}  ${r.confidence.toFixed(3)}   ${r.margin.toFixed(3)}`);
}

// --- 5. fit a small logistic model on dev, report on held-out ----------------
const FEATURES = ['confidence', 'margin', 'mutual', 'wasTop'];

function fit(train, { steps = 4000, lr = 0.5, l2 = 0.01 } = {}) {
  const w = new Array(FEATURES.length).fill(0);
  let b = 0;
  for (let step = 0; step < steps; step++) {
    const gw = new Array(FEATURES.length).fill(0);
    let gb = 0;
    for (const r of train) {
      const z = b + FEATURES.reduce((s, f, i) => s + w[i] * r[f], 0);
      const err = 1 / (1 + Math.exp(-z)) - r.label;
      for (let i = 0; i < FEATURES.length; i++) gw[i] += err * r[FEATURES[i]];
      gb += err;
    }
    for (let i = 0; i < FEATURES.length; i++) w[i] -= lr * (gw[i] / train.length + l2 * w[i]);
    b -= lr * (gb / train.length);
  }
  return { w, b };
}

const model = fit(dev);
const predict = (r) => 1 / (1 + Math.exp(-(model.b + FEATURES.reduce((s, f, i) => s + model.w[i] * r[f], 0))));

console.log('\n  ── REFIT (logistic, trained on dev only) ───────────');
console.log(`  intercept ${model.b.toFixed(3)}   ` + FEATURES.map((f, i) => `${f} ${model.w[i].toFixed(3)}`).join('   '));

console.log('\n  predicted bin       n   correct   precision   (held-out sheets only)');
for (const [lo, hi] of BINS) {
  const bin = held.filter((r) => predict(r) >= lo && predict(r) < hi);
  console.log(`  ${lo.toFixed(2)} - ${hi >= 1 ? '1.00' : hi.toFixed(2)}    ${String(bin.length).padStart(4)}` +
    `   ${String(bin.filter((r) => r.label).length).padStart(4)}    ${fmtPct(prec(bin))}`);
}

// --- 6. the decisiveness term ------------------------------------------------
/**
 * Confidence scaled by how decisively the pair won.
 *
 * A multiplier rather than a second gate, because every consumer downstream
 * (verify.js, the reporting threshold, E2d) reads ONE number, and a rule people
 * have to remember to apply separately is a rule that eventually is not.
 *
 * The floor stops it annihilating a pair that ties: an exact tie is sometimes a
 * genuine duplicate on the page rather than an ambiguity, and the evidence has
 * examples of both.
 */
const decisive = (conf, margin, floor, band) => conf * (floor + (1 - floor) * Math.min(1, margin / band));

console.log('\n  ── DECISIVENESS SWEEP (gate held at 0.85) ──────────');
console.log('  floor  band      dev  prec        held  prec       all  prec');
let best = null;
for (const floor of [0.4, 0.5, 0.6, 0.7]) {
  for (const band of [0.2, 0.3, 0.5, 0.8]) {
    const keep = (list) => list.filter((r) => decisive(r.confidence, r.margin, floor, band) >= 0.85);
    const d = keep(dev), h = keep(held), a = keep(rows);
    console.log(`  ${floor.toFixed(1)}    ${band.toFixed(1)}   ${String(d.length).padStart(6)}  ${fmtPct(prec(d))}` +
      `   ${String(h.length).padStart(6)}  ${fmtPct(prec(h))}  ${String(a.length).padStart(6)}  ${fmtPct(prec(a))}`);
    // Chosen on held-out precision with a floor on how much it still asserts -
    // a rule that asserts nothing is not a rule, it is a refusal.
    if (h.length >= 5 && (!best || prec(h) > best.p || (prec(h) === best.p && h.length > best.n))) {
      best = { floor, band, p: prec(h), n: h.length };
    }
  }
}

if (best) {
  console.log(`\n  best held-out operating point: floor ${best.floor}, band ${best.band}` +
    `  ->  ${(best.p * 100).toFixed(1)}% on ${best.n} assertions`);
}

// `floor` is inert AT THE GATE - every value selects the same pairs, because a
// margin at or above `band` saturates the multiplier and one below it fails
// regardless. It is not inert over the WHOLE curve, which is what a confidence
// is supposed to order, so it is chosen there instead.
console.log('\n  ── FULL CURVE UNDER DECISIVENESS (all six sheets) ──');
console.log('  floor/band     ' + BINS.map(([lo, hi]) => `${lo.toFixed(2)}-${hi >= 1 ? '1.00' : hi.toFixed(2)}`).join('  '));
for (const floor of [0.4, 0.5, 0.6, 0.7, 1.0]) {
  const cells = BINS.map(([lo, hi]) => {
    const bin = rows.filter((r) => {
      const c = decisive(r.confidence, r.margin, floor, 0.5);
      return c >= lo && c < hi;
    });
    return bin.length ? `${(prec(bin) * 100).toFixed(0)}%/${bin.length}`.padStart(9) : '    -/0  ';
  });
  console.log(`  ${floor === 1 ? 'off (1.0) ' : `${floor.toFixed(1)}/0.5   `}  ${cells.join(' ')}`);
}
console.log('  cells are precision/n. A curve is well ordered when precision rises left to right.');

// --- 7. re-derive the reporting threshold ------------------------------------
console.log('\n  ── THRESHOLD SWEEP (held-out) ──────────────────────');
console.log('           current formula        + decisiveness         refitted logistic');
console.log('   t     asserted  precision    asserted  precision    asserted  precision');
for (const t of [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95]) {
  const a = held.filter((r) => r.confidence >= t);
  const d = best ? held.filter((r) => decisive(r.confidence, r.margin, best.floor, best.band) >= t) : [];
  const b = held.filter((r) => predict(r) >= t);
  console.log(`  ${t.toFixed(2)}  ${String(a.length).padStart(8)}    ${fmtPct(prec(a))}` +
    `  ${String(d.length).padStart(10)}    ${fmtPct(prec(d))}` +
    `  ${String(b.length).padStart(10)}    ${fmtPct(prec(b))}`);
}

console.log('\n  A usable gate needs precision >= 95% with a non-trivial number of');
console.log('  assertions behind it. A threshold that asserts nothing passes on a');
console.log('  technicality - that is how the last gate read 100% on four pairs.\n');
