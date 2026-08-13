/**
 * Proximity-veto A/B — contract §4.2.
 *
 *   node src/correspond/veto-experiment.js [runDir]
 *
 * Re-verifies the SAME cached Tier-2 proposals from out/tier2/results.json with
 * the veto off and on. No model calls, no Figma calls - so the only variable is
 * the rule itself.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { anchorSection } from './anchors.js';
import { verifyProposals, combine } from './verify.js';
import { pinnedFromRun } from '../sections/pinned.js';

const runDir = process.argv[2] || 'out';
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const tolerance = read('config/tolerance-default.json');
const baseCfg = tolerance.correspond;
const elements = read(join(runDir, 'elements.json'));
const prior = read(join(runDir, 'tier2', 'results.json'));

// Scroll-driven sections are measured pre-animation, so their geometry is not
// the intended layout. Flagged, never silently mixed into the aggregate.
const pinned = pinnedFromRun(
  read(join(runDir, 'web-ir.json')),
  read(join(runDir, 'sections.json')),
  read(join(runDir, 'section-alignment.json'))
);
const isPinned = (webIndex) => pinned.get(webIndex)?.pinned === true;

function scoreMerged(truth, merged, cfg) {
  const byFigma = new Map(merged.map((p) => [p.figmaIndex, p]));
  const b = { correct: [], wrong: [], assertedOnNonMatch: [], missed: [] };
  for (const [key, want] of Object.entries(truth.truth)) {
    const fi = Number(key);
    const got = byFigma.get(fi);
    if (want === '?') continue;
    const isMatch = typeof want === 'number';
    if (!got) { if (isMatch) b.missed.push({ fi, want }); continue; }
    if (!isMatch) { b.assertedOnNonMatch.push({ fi, want, got: got.webIndex, tier: got.tier, confidence: got.confidence }); continue; }
    (got.webIndex === want ? b.correct : b.wrong).push({ fi, want, got: got.webIndex, tier: got.tier, confidence: got.confidence });
  }
  const at = (floor) => {
    const keep = (l) => l.filter((x) => x.confidence >= floor);
    const c = keep(b.correct).length, w = keep(b.wrong).length + keep(b.assertedOnNonMatch).length;
    return { asserted: c + w, correct: c, wrong: w };
  };
  const truthMatches = Object.values(truth.truth).filter((v) => typeof v === 'number').length;
  return { truthMatches, buckets: b, reportable: at(cfg.confidenceGate.report), recall: b.correct.length / Math.max(1, truthMatches) };
}

function runMode(enabled) {
  const cfg = { ...baseCfg, proximityVeto: { ...baseCfg.proximityVeto, enabled } };
  const out = [];
  for (const r of prior.results) {
    if (r.failed) continue;
    const pair = elements.pairs.find((p) => p.figmaIndex === r.truth.figmaIndex && p.webIndex === r.truth.webIndex);
    const tier1 = anchorSection(pair.figma, pair.web, cfg);
    const verified = verifyProposals(r.call.proposals, {
      figmaSet: pair.figma, webSet: pair.web, anchors: tier1.pairs,
      sectionConfidence: r.truth.sectionConfidence, cfg,
    });
    const merged = combine(tier1.pairs, verified.accepted);
    out.push({ sheet: r.sheet, heldOut: r.heldOut, pinned: isPinned(r.truth.webIndex), truth: r.truth, tier1, verified, score: scoreMerged(r.truth, merged, cfg) });
  }
  return out;
}

const off = runMode(false);
const on = runMode(true);

const tier2Stats = (rows) => {
  let correct = 0, wrong = 0, accepted = 0;
  for (const r of rows) {
    accepted += r.verified.counts.accepted;
    correct += r.score.buckets.correct.filter((x) => x.tier === 'llm').length;
    wrong += r.score.buckets.wrong.filter((x) => x.tier === 'llm').length
           + r.score.buckets.assertedOnNonMatch.filter((x) => x.tier === 'llm').length;
  }
  return { accepted, correct, wrong, precision: correct + wrong ? correct / (correct + wrong) : null };
};
const totals = (rows) => {
  const tm = rows.reduce((n, r) => n + r.score.truthMatches, 0);
  const c = rows.reduce((n, r) => n + r.score.buckets.correct.length, 0);
  return {
    recall: c / tm, correct: c, truthMatches: tm,
    rc: rows.reduce((n, r) => n + r.score.reportable.correct, 0),
    ra: rows.reduce((n, r) => n + r.score.reportable.asserted, 0),
  };
};

console.log('\n  PROXIMITY VETO — A/B on identical cached proposals\n');
console.log('  pair        veto OFF                    veto ON');
console.log('              recall  T2 ok/wrong  >=.85   recall  T2 ok/wrong  >=.85   vetoed');
for (let i = 0; i < off.length; i++) {
  const a = off[i], b = on[i];
  const t2 = (r) => `${r.score.buckets.correct.filter((x) => x.tier === 'llm').length}/${r.score.buckets.wrong.filter((x) => x.tier === 'llm').length + r.score.buckets.assertedOnNonMatch.filter((x) => x.tier === 'llm').length}`;
  console.log(
    `  ${a.sheet}${a.heldOut ? "*" : " "}${a.pinned ? "P" : " "} ${a.score.recall.toFixed(3).padEnd(7)} ${t2(a).padEnd(12)} ${String(a.score.reportable.correct + '/' + a.score.reportable.asserted).padEnd(7)} ` +
    `${b.score.recall.toFixed(3).padEnd(7)} ${t2(b).padEnd(12)} ${String(b.score.reportable.correct + '/' + b.score.reportable.asserted).padEnd(7)} ${b.verified.counts.proximityVetoed}`
  );
}
console.log('  * held out\n');

const [a2, b2] = [tier2Stats(off), tier2Stats(on)];
const [aT, bT] = [totals(off), totals(on)];
console.log(`  Tier 2 precision   ${(a2.precision * 100).toFixed(1)}% (${a2.correct}/${a2.correct + a2.wrong})  ->  ${(b2.precision * 100).toFixed(1)}% (${b2.correct}/${b2.correct + b2.wrong})`);
console.log(`  Tier 2 accepted    ${a2.accepted}  ->  ${b2.accepted}`);
console.log(`  overall recall     ${(aT.recall * 100).toFixed(1)}% (${aT.correct}/${aT.truthMatches})  ->  ${(bT.recall * 100).toFixed(1)}% (${bT.correct}/${bT.truthMatches})`);
console.log(`  precision @0.85    ${aT.rc}/${aT.ra}  ->  ${bT.rc}/${bT.ra}`);
console.log(`  proposals vetoed   ${on.reduce((n, r) => n + r.verified.counts.proximityVetoed, 0)} of ${on.reduce((n, r) => n + r.verified.counts.proposals, 0)}\n`);

// Exactly which pairs changed, and whether each was right or wrong to lose.
console.log('  ── WHAT THE VETO REMOVED ───────────────────────────────');
for (let i = 0; i < off.length; i++) {
  const before = new Map(off[i].verified.accepted.map((p) => [p.figmaIndex, p]));
  const after = new Set(on[i].verified.accepted.map((p) => p.figmaIndex));
  for (const [fi, p] of before) {
    if (after.has(fi)) continue;
    const want = off[i].truth.truth[String(fi)];
    const verdict = want === p.webIndex ? 'WAS CORRECT — bad veto' : `was wrong (truth ${want}) — good veto`;
    console.log(`  ${off[i].sheet}  figma ${fi} -> web ${p.webIndex}   ${verdict}`);
  }
}
console.log('');
