/**
 * X4/X6 - run the shortlist adjudicator against the hand-scored sheets.
 *
 *   node src/correspond/tier2-run.js [runDir] [--no-figma-render] [--no-images] [--dev-only]
 *
 * Contract: docs/v2-e2-rearchitecture.md §3. Every threshold used here is fixed
 * in that document and in config/tolerance-default.json, committed before the
 * held-out sheets are touched.
 *
 * QUOTA: the design render costs ONE Figma Tier-1 request on an account with
 * roughly six a month, and only on the first run - it is cached indefinitely by
 * (fileKey, nodeId, version) because renders are immutable per version.
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { resolveConfig } from '../config.js';
import { FigmaClient } from '../figma/client.js';
import {
  captureFigmaFrame, cropSections, evidencePaths, loadPinnedManifest, pinnedForSection,
} from '../evidence/capture.js';
import { shortlist } from './candidates.js';
import { adjudicate } from './llm.js';
import { verifyAssignments, combine } from './verify.js';
import { scorePair } from './score.js';

const RENDER_SCALE = 0.5;
const runDir = process.argv.find((a) => !a.startsWith('--') && a !== process.argv[0] && a !== process.argv[1]) || 'out';
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

const skipRender = process.argv.includes('--no-figma-render');
const noImages = process.argv.includes('--no-images');   // X6 ablation
const devOnly = process.argv.includes('--dev-only');     // X4 - prompt iteration

const tolerance = read('config/tolerance-default.json');
const cfg = tolerance.correspond;
const elements = read(join(runDir, 'elements.json'));
const sections = read(join(runDir, 'sections.json'));
const figmaIr = read(join(runDir, 'figma-ir.json'));

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) { console.error('GEMINI_API_KEY not set'); process.exit(1); }

const config = resolveConfig({ outDir: runDir });
const paths = evidencePaths(runDir);
const figmaFramePath = join(runDir, 'evidence', 'figma-frame.png');
const figmaSectionsDir = join(runDir, 'evidence', 'figma-sections');
const webModelDir = join(runDir, 'evidence', 'web-model');

const HELD_OUT = new Set(['f17-w18', 'f6-w7', 'f8-w9', 'f15-w16']);
const SHEETS = readdirSync('fixtures/spike').filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, '')).sort()
  .filter((s) => !devOnly || !HELD_OUT.has(s));

console.log(`\n  E2c — SHORTLIST ADJUDICATION  (k=${cfg.shortlist.k}, batch ${cfg.adjudicator.maxElementsPerCall})`);
if (devOnly) console.log('  MODE: X4, dev sheets only — prompt iteration happens here and ONLY here');
if (noImages) console.log('  MODE: X6, no images — structure-only ablation, NOT the contracted experiment');
console.log('');

// --- 1. renders --------------------------------------------------------------
let figmaCrops = [], webCrops = [], render = { skipped: true };
if (!noImages) {
  const client = new FigmaClient({ token: config.figmaToken, cacheDir: '.cache', log: console });
  const { fileKey, nodeId, frameWidth, frameHeight } = figmaIr.meta;

  if (!skipRender) {
    try {
      render = await captureFigmaFrame(client, {
        fileKey, version: figmaIr.sourceVersion, nodeId, outPath: figmaFramePath, scale: RENDER_SCALE,
      });
    } catch (err) {
      console.error(`  Figma render unavailable: ${err.message}`);
      console.error('  Re-run with --no-figma-render for the weaker page-only variant.\n');
      process.exit(1);
    }
  }

  const browser = await chromium.launch({ headless: true });
  try {
    figmaCrops = skipRender ? [] : await cropSections(
      browser, { path: figmaFramePath, width: frameWidth, height: frameHeight },
      sections.figma.sections, figmaSectionsDir, { side: 'figma', scale: 1 },
    );
    if (!existsSync(paths.fullPage)) throw new Error(`No web capture at ${paths.fullPage}; run capture-only.js first.`);
    webCrops = await cropSections(
      browser, { path: paths.fullPage, width: sections.web.rootWidth, height: sections.web.totalHeight },
      sections.web.sections, webModelDir, { side: 'web', scale: RENDER_SCALE },
    );
  } finally {
    await browser.close();
  }
  console.log(`  crops: ${figmaCrops.length} design, ${webCrops.length} page, at scale ${RENDER_SCALE}\n`);
}

// --- 2. adjudicate each sheet ------------------------------------------------
const pinnedManifest = noImages ? [] : loadPinnedManifest(runDir);
if (pinnedManifest.length) {
  console.log(`  ${pinnedManifest.length} settled-scroll capture(s) available for scroll-driven sections\n`);
}

const results = [];
const totalUsage = { inputTokens: 0, outputTokens: 0, elapsedMs: 0, calls: 0, failedCalls: 0, descriptorsDropped: 0 };

for (const sheet of SHEETS) {
  const truth = read(join('fixtures/spike', `${sheet}.json`));
  const pair = elements.pairs.find((p) => p.figmaIndex === truth.figmaIndex && p.webIndex === truth.webIndex);
  if (!pair) { console.log(`  ${sheet}: pair not in this run; skipped`); continue; }

  const heldOut = HELD_OUT.has(sheet);
  const fEls = pair.figma.elements, wEls = pair.web.elements;

  // EVERY design element gets a shortlist. Tier 1 no longer claims anything, so
  // nothing is withheld from the model on the strength of a geometry guess -
  // that shape was measured to cap recall at 52.2%.
  const shortlists = new Map();
  for (const [i, f] of fEls.entries()) {
    shortlists.set(i, shortlist(f, wEls, cfg, {}, cfg.shortlist.k));
  }

  const asked = new Set(fEls.map((_, i) => i));
  const figmaImage = noImages ? null : figmaCrops.find((c) => c.index === truth.figmaIndex)?.path;

  // A scroll-driven section's measurements come from its SETTLED scroll, so its
  // picture must too. Cropping it out of the scroll-top full-page capture shows
  // the animation's first frame - one stacked card where the element list
  // describes twelve - and the model is then asked to match things that are not
  // in the image it was given.
  const webSection = sections.web.sections.find((s) => s.index === truth.webIndex);
  const pinnedShot = pinnedForSection(pinnedManifest, webSection);
  const webImage = noImages
    ? null
    : (pinnedShot?.path ?? webCrops.find((c) => c.index === truth.webIndex)?.path);

  // Batch, so one oversized section cannot truncate its own JSON.
  const batches = [];
  const size = cfg.adjudicator.maxElementsPerCall;
  for (let i = 0; i < fEls.length; i += size) {
    batches.push(fEls.slice(i, i + size).map((figmaEl, j) => ({
      // The bracketed number the model answers with is the element's index in
      // the SECTION, not in the batch, so batching stays invisible to it and a
      // re-batch cannot silently renumber the answers.
      index: i + j,
      figmaEl,
      candidates: (shortlists.get(i + j) ?? []).map((c) => wEls[c.webIndex]),
    })));
  }

  console.log(`  ${sheet}${heldOut ? '  [HELD OUT]' : ''} — ${fEls.length} design elements, ${batches.length} call(s)` +
    `${pinnedShot ? '  [settled-scroll capture]' : ''}`);

  const answers = [];
  let failed = 0;
  for (const [n, batch] of batches.entries()) {
    const call = await adjudicate({ figmaImage, webImage, batch, apiKey });
    if (!call.ok) {
      failed++; totalUsage.failedCalls++;
      console.log(`    batch ${n + 1}/${batches.length} FAILED: ${call.reason}`);
      totalUsage.elapsedMs += call.usage.elapsedMs ?? 0;
      continue;
    }
    answers.push(...call.assignments);
    totalUsage.inputTokens += call.usage.inputTokens ?? 0;
    totalUsage.outputTokens += call.usage.outputTokens ?? 0;
    totalUsage.elapsedMs += call.usage.elapsedMs ?? 0;
    totalUsage.descriptorsDropped += call.usage.descriptorsDropped ?? 0;
    totalUsage.calls++;
  }

  if (!answers.length) {
    console.log(`    no answers survived; sheet skipped\n`);
    results.push({ sheet, heldOut, failed: 'all batches failed' });
    continue;
  }

  const verified = verifyAssignments(answers, {
    figmaSet: pair.figma, webSet: pair.web, shortlists, asked,
    sectionConfidence: truth.sectionConfidence, cfg,
  });

  // Tier 1 contributes nothing to claim under the new architecture; combine is
  // called with an empty anchor set so the merge path stays exercised.
  const merged = combine([], verified.accepted);

  const before = scorePair(truth, pair, cfg);
  const after = scoreMerged(truth, merged, cfg);

  const c = verified.counts;
  console.log(`    answers ${c.answers} -> accepted ${c.accepted}   ` +
    `(declined ${c.declined}, out-of-range ${c.pickOutOfRange}, class ${c.classIncompatible}, ` +
    `template ${c.templateMismatch}, below-floor ${c.belowFloor}, conflict ${c.conflictLost}, fan-in refused ${c.fanInRefused})`);
  if (c.phantomId) console.log(`    *** PHANTOM ID x${c.phantomId} — HARNESS BUG, results are suspect ***`);
  console.log(`    recall ${before.recall} -> ${after.recall}   precision@0.85 ` +
    `${before.reportable.correct}/${before.reportable.asserted} -> ${after.reportable.correct}/${after.reportable.asserted}`);
  if (failed) console.log(`    ${failed} batch(es) failed`);
  console.log('');

  results.push({ sheet, heldOut, truth, verified, merged, before, after, answers });
}

/** Score an already-merged pair list against truth (mirrors scorePair's rules). */
function scoreMerged(truth, merged, cfg) {
  const byFigma = new Map(merged.map((p) => [p.figmaIndex, p]));
  const buckets = { correct: [], wrong: [], missed: [], assertedOnNonMatch: [], excluded: [] };

  for (const [key, want] of Object.entries(truth.truth)) {
    const fi = Number(key);
    const got = byFigma.get(fi);
    if (want === '?') { buckets.excluded.push(fi); continue; }
    const isMatch = typeof want === 'number';
    if (!got) { if (isMatch) buckets.missed.push({ fi, want }); continue; }
    if (!isMatch) { buckets.assertedOnNonMatch.push({ fi, want, got: got.webIndex, confidence: got.confidence, tier: got.tier }); continue; }
    (got.webIndex === want ? buckets.correct : buckets.wrong).push({ fi, want, got: got.webIndex, confidence: got.confidence, tier: got.tier });
  }

  const at = (floor) => {
    const keep = (l) => l.filter((x) => x.confidence >= floor);
    const correct = keep(buckets.correct).length;
    const wrong = keep(buckets.wrong).length + keep(buckets.assertedOnNonMatch).length;
    return { asserted: correct + wrong, correct, wrong, precision: correct + wrong ? +(correct / (correct + wrong)).toFixed(3) : null };
  };
  const truthMatches = Object.values(truth.truth).filter((v) => typeof v === 'number').length;

  return {
    truthMatches, all: at(0), reportable: at(cfg.confidenceGate.report),
    recall: +(buckets.correct.length / Math.max(1, truthMatches)).toFixed(3), buckets,
  };
}

mkdirSync(join(runDir, 'tier2'), { recursive: true });
writeFileSync(join(runDir, 'tier2', 'results.json'), JSON.stringify({ render, totalUsage, results }, null, 2));

// --- 3. summary --------------------------------------------------------------
const ok = results.filter((r) => !r.failed);
if (!ok.length) { console.log('  no sheet completed; nothing to summarise\n'); process.exit(1); }
const sum = (f) => ok.reduce((n, r) => n + f(r), 0);

console.log('  ── TIER 1 vs ADJUDICATED ───────────────────────────────');
console.log('  pair        recall            precision@0.85');
for (const r of ok) {
  console.log(`  ${r.sheet}${r.heldOut ? '*' : ' '}  ${String(r.before.recall).padEnd(6)} -> ${String(r.after.recall).padEnd(6)}` +
    `   ${String(`${r.before.reportable.correct}/${r.before.reportable.asserted}`).padEnd(7)} -> ${r.after.reportable.correct}/${r.after.reportable.asserted}`);
}
console.log('  * held out\n');

const tm = sum((r) => r.after.truthMatches);
const c1 = sum((r) => r.before.buckets.correct.length);
const c2 = sum((r) => r.after.buckets.correct.length);
console.log(`  recall          ${(c1 / tm * 100).toFixed(1)}%  ->  ${(c2 / tm * 100).toFixed(1)}%   (${c1} -> ${c2} of ${tm})`);
console.log(`  incremental     ${c2 - c1>= 0 ? '+' : ''}${((c2 - c1) / tm * 100).toFixed(1)} points  <- the number that justifies the tier existing`);
console.log(`  precision@0.85  ${sum((r) => r.before.reportable.correct)}/${sum((r) => r.before.reportable.asserted)}  ->  ${sum((r) => r.after.reportable.correct)}/${sum((r) => r.after.reportable.asserted)}`);

console.log('\n  ── HALLUCINATION ───────────────────────────────────────');
const answers = sum((r) => r.verified.counts.answers);
const rate = (n) => `${n} (${answers ? (n / answers * 100).toFixed(1) : '0.0'}%)`;
console.log(`  answers                 ${answers}`);
console.log(`  phantom id              ${rate(sum((r) => r.verified.counts.phantomId))}   <- must be 0 by construction`);
console.log(`  pick out of range       ${rate(sum((r) => r.verified.counts.pickOutOfRange))}`);
console.log(`  class incompatible      ${rate(sum((r) => r.verified.counts.classIncompatible))}`);
console.log(`  template mismatch       ${rate(sum((r) => r.verified.counts.templateMismatch))}`);
console.log(`  below confidence floor  ${rate(sum((r) => r.verified.counts.belowFloor))}`);
console.log(`  measurement leaks       ${totalUsage.descriptorsDropped}`);
const semantic = sum((r) => r.after.buckets.assertedOnNonMatch.length);
console.log(`  semantic false positive ${semantic}  <- asserted a match where truth says missing/decor/extra`);
console.log(`  wrong pairing           ${sum((r) => r.after.buckets.wrong.length)}`);

// --- the Phase D gate, held-out only -----------------------------------------
//
// Reported separately from the pooled figures because the dev sheets are the
// ones the prompt was iterated against, and mixing them in is how a tuned result
// gets to look like a general one. The gate is a CONJUNCTION: precision alone
// passes trivially by declining everything, which is exactly how the original
// Phase 2 gate came to read 100% on four assertions.
const heldSheets = ok.filter((r) => r.heldOut);
if (heldSheets.length) {
  const h = (f) => heldSheets.reduce((n, r) => n + f(r), 0);
  const htm = h((r) => r.after.truthMatches);
  const hc1 = h((r) => r.before.buckets.correct.length);
  const hc2 = h((r) => r.after.buckets.correct.length);
  const hAsserted = h((r) => r.after.reportable.asserted);
  const hCorrect = h((r) => r.after.reportable.correct);

  const precision = hAsserted ? hCorrect / hAsserted : null;
  const incremental = (hc2 - hc1) / Math.max(1, htm) * 100;
  const precisionOk = precision !== null && precision >= 0.95;
  const incrementalOk = incremental > 15;

  console.log('\n  ══ PHASE D GATE — HELD-OUT SHEETS ONLY ═════════════════');
  console.log(`  sheets: ${heldSheets.map((r) => r.sheet).join(', ')}`);
  console.log(`  recall            ${(hc1 / htm * 100).toFixed(1)}%  ->  ${(hc2 / htm * 100).toFixed(1)}%   (${hc1} -> ${hc2} of ${htm})`);
  console.log(`  incremental recall  ${incremental >= 0 ? '+' : ''}${incremental.toFixed(1)} points   required >15    ${incrementalOk ? 'ok' : 'FAIL'}`);
  console.log(`  precision @${cfg.confidenceGate.report}     ${precision === null ? 'n/a — nothing asserted' : `${(precision * 100).toFixed(1)}% (${hCorrect}/${hAsserted})`}   required >=95%   ${precisionOk ? 'ok' : 'FAIL'}`);
  console.log(`\n  ${precisionOk && incrementalOk ? 'PASS' : 'FAIL'}`);
  if (precision === null) {
    console.log('  NOTE: no held-out pair cleared the reporting threshold. Effective confidence is');
    console.log('  model x sectionConfidence, so a section matched at 0.75 cannot produce a 0.85 pair');
    console.log('  however good the pairing is. Read this as a threshold interaction, not as a matcher');
    console.log('  failure - the recall line above is the one carrying information.');
  }
}

console.log('\n  ── COST ────────────────────────────────────────────────');
console.log(`  calls ${totalUsage.calls} ok, ${totalUsage.failedCalls} failed   input ${totalUsage.inputTokens} tok   output ${totalUsage.outputTokens} tok   ${(totalUsage.elapsedMs / 1000).toFixed(1)}s`);
const perSheet = totalUsage.inputTokens / Math.max(1, ok.length);
console.log(`  per section pair: ~${Math.round(perSheet)} input tok`);
console.log(`  extrapolated to 18 pairs: ~${Math.round(perSheet * 18).toLocaleString()} input tok per full audit\n`);
