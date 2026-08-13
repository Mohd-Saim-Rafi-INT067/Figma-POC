/**
 * Run Tier 2 against the hand-scored ground-truth sheets and measure it.
 *
 *   node src/correspond/tier2-run.js [runDir]
 *
 * Contract: docs/v2-tier2-contract.md. Every threshold used here is fixed in
 * that document, written before the first call.
 *
 * QUOTA: the design render costs ONE Figma Tier-1 request on an account with
 * roughly six a month, and only on the first run - it is cached indefinitely by
 * (fileKey, nodeId, version) because renders are immutable per version. The
 * version is read from the existing run's IR rather than resolved over the
 * network, because /files/:key is itself Tier 1 and resolving it would double
 * the cost. Requested at scale 0.5 deliberately: a 1920x19,752 export may
 * exceed Figma's size limit and discovering that must not cost a second call.
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { resolveConfig } from '../config.js';
import { FigmaClient } from '../figma/client.js';
import { captureFigmaFrame, cropSections, evidencePaths } from '../evidence/capture.js';
import { anchorSection } from './anchors.js';
import { proposeCorrespondence } from './llm.js';
import { verifyProposals, combine } from './verify.js';
import { scorePair } from './score.js';

const RENDER_SCALE = 0.5;
const runDir = process.argv[2] || 'out';
const read = (p) => JSON.parse(readFileSync(p, 'utf8'));

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

console.log('\n  TIER 2 — vision correspondence\n');

// --- 1. Design render: one Figma request, then cached forever ---------------
const client = new FigmaClient({ token: config.figmaToken, cacheDir: '.cache', log: console });
const version = figmaIr.sourceVersion;
const { fileKey, nodeId, frameWidth, frameHeight } = figmaIr.meta;

// --no-figma-render runs the STRUCTURE-ONLY variant: no design image, element
// lists only. It is a weaker experiment than the contract specifies and can
// never satisfy the gate; it exists because the account can be rate-limited for
// a day at a time and hallucination rate and cost are still worth measuring.
const skipRender = process.argv.includes('--no-figma-render');
let render = { cacheHit: true, skipped: true };
if (!skipRender) {
  try {
    render = await captureFigmaFrame(client, {
      fileKey, version, nodeId, outPath: figmaFramePath, scale: RENDER_SCALE,
    });
  } catch (err) {
    console.error(`\n  Figma render unavailable: ${err.message}`);
    console.error('  Re-run with --no-figma-render for the structure-only variant, or wait for quota.\n');
    process.exit(1);
  }
}
if (skipRender) console.log('  MODE: structure-only (no design render) — NOT the contracted experiment\n');

// --- 2. Crops, both sides, at the same scale --------------------------------
const browser = await chromium.launch({ headless: true });
let figmaCrops, webCrops;
try {
  // The render is ALREADY at RENDER_SCALE, so the wrapper displays it at its
  // natural size and no resampling happens; the web capture is full-size and is
  // scaled down to match.
  // The design render is ALREADY at RENDER_SCALE, so scale 1 displays it at its
  // true pixel size and nothing is resampled; cropSections derives the
  // logical->pixel mapping from the PNG header itself.
  figmaCrops = skipRender ? [] : await cropSections(
    browser,
    { path: figmaFramePath, width: frameWidth, height: frameHeight },
    sections.figma.sections, figmaSectionsDir,
    { side: 'figma', scale: 1 }
  );
  if (!existsSync(paths.fullPage)) throw new Error(`No web capture at ${paths.fullPage}; run capture-only.js first.`);
  webCrops = await cropSections(
    browser,
    { path: paths.fullPage, width: sections.web.rootWidth, height: sections.web.totalHeight },
    sections.web.sections, webModelDir,
    { side: 'web', scale: RENDER_SCALE }
  );
} finally {
  await browser.close();
}
console.log(`  crops: ${figmaCrops.length} design, ${webCrops.length} page, at scale ${RENDER_SCALE}\n`);

// --- 3. Tier 2 per ground-truth pair ----------------------------------------
// Every hand-scored sheet on disk, so extending the benchmark needs no code change.
const SHEETS = readdirSync('fixtures/spike').filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
const HELD_OUT = new Set(['f17-w18', 'f6-w7', 'f8-w9', 'f15-w16']);   // not used to derive the veto
const results = [];
const totalUsage = { inputTokens: 0, outputTokens: 0, elapsedMs: 0, calls: 0, descriptorsDropped: 0 };

for (const sheet of SHEETS) {
  const truth = read(join('fixtures/spike', `${sheet}.json`));
  const pair = elements.pairs.find((p) => p.figmaIndex === truth.figmaIndex && p.webIndex === truth.webIndex);
  const heldOut = HELD_OUT.has(sheet);

  const tier1 = anchorSection(pair.figma, pair.web, cfg);
  const matchedF = new Set(tier1.pairs.map((p) => p.figmaIndex));
  const matchedW = new Set(tier1.pairs.map((p) => p.webIndex));

  const figmaUnresolved = pair.figma.elements
    .filter((_, i) => !matchedF.has(i))
    .map((e) => ({ ...e, id: e.sourceRef.figmaNodeId ?? e.id }));
  const webUnresolved = pair.web.elements
    .filter((_, i) => !matchedW.has(i))
    .map((e) => ({ ...e, id: e.sourceRef.webSelector ?? e.id }));

  const figmaImage = figmaCrops.find((c) => c.index === truth.figmaIndex)?.path;
  const webImage = webCrops.find((c) => c.index === truth.webIndex)?.path;

  console.log(`  ${sheet}${heldOut ? '  [HELD OUT]' : ''} — Tier 1 resolved ${tier1.pairs.length}, asking about ${figmaUnresolved.length} design / ${webUnresolved.length} page`);

  const call = await proposeCorrespondence({
    figmaImage, webImage, figmaUnresolved, webUnresolved,
    anchored: tier1.pairs.map((p) => ({ figmaId: p.figmaId, webId: p.webId })),
    apiKey,
  });

  if (!call.ok) {
    console.log(`    CALL FAILED: ${call.reason}\n`);
    results.push({ sheet, heldOut, failed: call.reason, usage: call.usage });
    continue;
  }

  const verified = verifyProposals(call.proposals, {
    figmaSet: pair.figma, webSet: pair.web, anchors: tier1.pairs,
    sectionConfidence: truth.sectionConfidence, cfg,
  });

  const merged = combine(tier1.pairs, verified.accepted);

  // Score Tier 1 alone and Tier 1 + Tier 2, so the INCREMENT is visible.
  const before = scorePair(truth, pair, cfg);
  const after = scoreMerged(truth, merged, cfg);

  totalUsage.inputTokens += call.usage.inputTokens ?? 0;
  totalUsage.outputTokens += call.usage.outputTokens ?? 0;
  totalUsage.elapsedMs += call.usage.elapsedMs ?? 0;
  totalUsage.descriptorsDropped += call.usage.descriptorsDropped ?? 0;
  totalUsage.calls++;

  results.push({ sheet, heldOut, truth, tier1, call, verified, merged, before, after });

  console.log(`    proposals ${verified.counts.proposals} -> accepted ${verified.counts.accepted}` +
    `  (phantom ${verified.counts.phantomId}, double ${verified.counts.doubleAssignment}, ` +
    `class ${verified.counts.classIncompatible}, below-floor ${verified.counts.belowFloor}, non-match ${verified.counts.notAMatch})`);
  console.log(`    recall ${before.recall} -> ${after.recall}   |  >=0.85 ${before.reportable.correct}/${before.reportable.asserted} -> ${after.reportable.correct}/${after.reportable.asserted}`);
  console.log(`    tokens in ${call.usage.inputTokens} out ${call.usage.outputTokens}  ${(call.usage.elapsedMs / 1000).toFixed(1)}s\n`);
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
    truthMatches,
    all: at(0),
    reportable: at(cfg.confidenceGate.report),
    recall: +(buckets.correct.length / Math.max(1, truthMatches)).toFixed(3),
    buckets,
  };
}

mkdirSync(join(runDir, 'tier2'), { recursive: true });
writeFileSync(join(runDir, 'tier2', 'results.json'), JSON.stringify({ render, totalUsage, results }, null, 2));

// --- 4. Summary --------------------------------------------------------------
const ok = results.filter((r) => !r.failed);
const sum = (f) => ok.reduce((n, r) => n + f(r), 0);

console.log('  ── TIER 1 vs TIER 1+2 ──────────────────────────────────');
console.log('  pair        recall           >=0.85 precision      incremental');
for (const r of ok) {
  const inc = r.after.buckets.correct.filter((c) => c.tier === 'llm').length;
  console.log(`  ${r.sheet}${r.heldOut ? '*' : ' '}  ${String(r.before.recall).padEnd(6)} -> ${String(r.after.recall).padEnd(6)}` +
    `   ${String(r.before.reportable.correct + '/' + r.before.reportable.asserted).padEnd(6)} -> ${String(r.after.reportable.correct + '/' + r.after.reportable.asserted).padEnd(6)}` +
    `      +${inc} true pairs`);
}
console.log('  * held out\n');

const tm = sum((r) => r.after.truthMatches);
const c1 = sum((r) => r.before.buckets.correct.length);
const c2 = sum((r) => r.after.buckets.correct.length);
console.log(`  recall          ${(c1 / tm * 100).toFixed(1)}%  ->  ${(c2 / tm * 100).toFixed(1)}%   (${c1} -> ${c2} of ${tm} true matches)`);
console.log(`  precision @0.85 ${sum((r) => r.before.reportable.correct)}/${sum((r) => r.before.reportable.asserted)}  ->  ${sum((r) => r.after.reportable.correct)}/${sum((r) => r.after.reportable.asserted)}`);

console.log('\n  ── HALLUCINATION ───────────────────────────────────────');
const props = sum((r) => r.verified.counts.proposals);
const rate = (n) => `${n} (${props ? (n / props * 100).toFixed(1) : '0.0'}%)`;
console.log(`  proposals              ${props}`);
console.log(`  phantom id             ${rate(sum((r) => r.verified.counts.phantomId))}`);
console.log(`  double assignment      ${rate(sum((r) => r.verified.counts.doubleAssignment))}`);
console.log(`  class incompatible     ${rate(sum((r) => r.verified.counts.classIncompatible))}`);
console.log(`  below confidence floor ${rate(sum((r) => r.verified.counts.belowFloor))}`);
console.log(`  measurement leaks      ${totalUsage.descriptorsDropped}`);
const semantic = sum((r) => r.after.buckets.assertedOnNonMatch.filter((x) => x.tier === 'llm').length);
const wrong = sum((r) => r.after.buckets.wrong.filter((x) => x.tier === 'llm').length);
console.log(`  semantic false positive ${semantic}  (asserted a match where truth says missing/decor/extra)`);
console.log(`  wrong pairing           ${wrong}`);

console.log('\n  ── COST ────────────────────────────────────────────────');
console.log(`  calls ${totalUsage.calls}   input ${totalUsage.inputTokens} tok   output ${totalUsage.outputTokens} tok   ${(totalUsage.elapsedMs / 1000).toFixed(1)}s total`);
const perPair = totalUsage.inputTokens / Math.max(1, totalUsage.calls);
console.log(`  per section pair: ~${Math.round(perPair)} input tok, ~${Math.round(totalUsage.outputTokens / Math.max(1, totalUsage.calls))} output tok`);
console.log(`  extrapolated to 18 pairs: ~${Math.round(perPair * 18).toLocaleString()} input tok per full audit`);
console.log(`  figma render: ${render.cacheHit ? 'cache hit, 0 requests' : '1 Tier-1 request spent'}\n`);
