/**
 * Score a matcher against hand-established ground truth.
 *
 *   node src/correspond/score.js [runDir]
 *
 * The gate is PRECISION, not coverage, and the asymmetry is deliberate: a
 * declined element costs a true finding, while a wrong pairing manufactures a
 * false one — and a report that cries wolf is worse than a quiet one. Coverage
 * is reported because it is interesting, never because it is the target.
 *
 * `?` rows are excluded from both numerator and denominator. An element the
 * person scoring could not decide by eye is not evidence about the matcher.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { anchorSection } from './anchors.js';
import { shortlist } from './candidates.js';

const TRUTH_DIR = 'fixtures/spike';

/**
 * Is a true match Tier 1 missed still REACHABLE by a later stage, or has Tier 1
 * already consumed one of its two elements?
 *
 * This is the measurement that decided the V2 re-architecture
 * (docs/v2-e2-rearchitecture.md §1.1): a residue-only second pass can only ever
 * recover the reachable ones, and on this benchmark 47.8% of true matches are
 * poisoned rather than merely missed. A second pass cannot be evaluated against
 * 100% when its own input caps it at 52.2%.
 */
function poisonOf(fi, want, claimedFigma, claimedWeb) {
  const f = claimedFigma.has(fi);          // Tier 1 gave this design element to someone else
  const w = claimedWeb.has(want);          // Tier 1 gave the true page element to someone else
  if (f && w) return 'both';
  if (f) return 'figma';
  if (w) return 'web';
  return null;                             // reachable
}

export function scorePair(truth, pair, cfg) {
  const result = anchorSection(pair.figma, pair.web, cfg);
  const asserted = new Map(result.pairs.map((p) => [p.figmaIndex, p]));
  const claimedFigma = new Set(result.pairs.map((p) => p.figmaIndex));
  const claimedWeb = new Set(result.pairs.map((p) => p.webIndex));

  const buckets = {
    correct: [], wrong: [], missed: [],
    assertedOnNonMatch: [],   // matcher paired something truth calls missing/decor
    excluded: [],
    reachable: [],            // missed, but both sides still free
    poisoned: [],             // missed because Tier 1 consumed one side
  };

  for (const [key, want] of Object.entries(truth.truth)) {
    const fi = Number(key);
    const got = asserted.get(fi);

    if (want === '?') { buckets.excluded.push(fi); continue; }

    const isRealMatch = typeof want === 'number';
    if (!got) {
      if (isRealMatch) {
        buckets.missed.push({ fi, want });
        const poison = poisonOf(fi, want, claimedFigma, claimedWeb);
        (poison ? buckets.poisoned : buckets.reachable).push({ fi, want, poison });
      }
      continue;                                    // declining a missing/decor is correct
    }
    if (!isRealMatch) { buckets.assertedOnNonMatch.push({ fi, want, got: got.webIndex, confidence: got.confidence }); continue; }
    if (got.webIndex === want) {
      buckets.correct.push({ fi, want, got: got.webIndex, confidence: got.confidence });
    } else {
      buckets.wrong.push({ fi, want, got: got.webIndex, confidence: got.confidence });
      // A wrong assertion consumes BOTH elements, so the true pair it displaced
      // is poisoned too - counted here so the totals reconcile against truth.
      const poison = poisonOf(fi, want, claimedFigma, claimedWeb);
      (poison ? buckets.poisoned : buckets.reachable).push({ fi, want, poison });
    }
  }

  const at = (floor) => {
    const keep = (list) => list.filter((x) => x.confidence >= floor);
    const correct = keep(buckets.correct).length;
    const wrong = keep(buckets.wrong).length + keep(buckets.assertedOnNonMatch).length;
    const total = correct + wrong;
    return { asserted: total, correct, wrong, precision: total ? +(correct / total).toFixed(3) : null };
  };

  const truthMatches = Object.values(truth.truth).filter((v) => typeof v === 'number').length;

  return {
    figmaIndex: truth.figmaIndex,
    webIndex: truth.webIndex,
    truthMatches,
    excluded: buckets.excluded.length,
    all: at(0),
    reportable: at(cfg.confidenceGate.report),
    recall: truthMatches ? +(buckets.correct.length / truthMatches).toFixed(3) : null,
    // The ceiling any residue-only second pass could reach on this sheet.
    residueCeiling: truthMatches
      ? +((buckets.correct.length + buckets.reachable.length) / truthMatches).toFixed(3)
      : null,
    buckets,
  };
}

/**
 * X1 - is the true partner inside the top k by geometry score?
 *
 * Ranking only. Nothing is claimed, nothing is filtered, and Tier 1's
 * one-to-one constraint does not apply, so this measures what the RANKER knows
 * rather than what the matcher does with it. It is the ceiling for any design
 * where a later stage chooses from a shortlist, and it costs no model calls.
 *
 * @param ctx  passed through to candidates.js - `textOf` enables X2's feature
 */
export function shortlistRecall(truth, pair, cfg, { ks = [1, 3, 5, 8, 12, 20], ctx = {} } = {}) {
  const hits = Object.fromEntries(ks.map((k) => [k, 0]));
  const ranks = [];
  let total = 0, unreachable = 0;

  for (const [key, want] of Object.entries(truth.truth)) {
    if (typeof want !== 'number') continue;
    const fi = Number(key);
    const f = pair.figma.elements[fi];
    // A truth row whose design element no longer exists means the element set
    // moved under the sheet - loudly counted, never silently skipped.
    if (!f) { unreachable++; continue; }

    total++;
    const ranked = shortlist(f, pair.web.elements, cfg, ctx);
    const rank = ranked.findIndex((r) => r.webIndex === want);
    ranks.push(rank);
    for (const k of ks) if (rank >= 0 && rank < k) hits[k]++;
  }

  return { total, hits, ks, ranks, unreachable };
}

/**
 * How much of what the ranker offers does the matcher actually convert?
 *
 * Separates "the shortlist did not contain the answer" from "the shortlist
 * contained it and we picked wrong" - the two have completely different fixes.
 */
export function ceilingUtilisation(correct, recallAtK) {
  return recallAtK ? +(correct / recallAtK).toFixed(3) : null;
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('src/correspond/score.js');
if (invokedDirectly) {
  const runDir = process.argv[2] || 'out';
  const cfg = JSON.parse(readFileSync('config/tolerance-default.json', 'utf8')).correspond;
  const data = JSON.parse(readFileSync(join(runDir, 'elements.json'), 'utf8'));

  if (!existsSync(TRUTH_DIR)) { console.error(`No ${TRUTH_DIR}`); process.exit(1); }
  const files = readdirSync(TRUTH_DIR).filter((f) => f.endsWith('.json'));
  if (!files.length) { console.error(`No ground-truth files in ${TRUTH_DIR}`); process.exit(1); }

  console.log(`\n  CORRESPONDENCE SCORE — Tier 1 only (no LLM)\n`);
  const KS = [1, 3, 5, 8, 12, 20];
  const totals = { asserted: 0, correct: 0, wrong: 0, truthMatches: 0, correctAll: 0 };
  const poison = { reachable: 0, figma: 0, web: 0, both: 0 };
  const shortlistTotals = { total: 0, hits: Object.fromEntries(KS.map((k) => [k, 0])), unreachable: 0 };

  for (const file of files) {
    const truth = JSON.parse(readFileSync(join(TRUTH_DIR, file), 'utf8'));
    const pair = data.pairs.find((p) => p.figmaIndex === truth.figmaIndex && p.webIndex === truth.webIndex);
    if (!pair) { console.log(`  ${file}: pair f${truth.figmaIndex}->w${truth.webIndex} not in this run; skipped`); continue; }

    const s = scorePair(truth, pair, cfg);
    console.log(`  f${s.figmaIndex}->w${s.webIndex}   ${s.truthMatches} real matches in truth, ${s.excluded} excluded as '?'`);
    console.log(`    all anchors        ${String(s.all.correct).padStart(3)}/${String(s.all.asserted).padEnd(3)} correct   precision ${s.all.precision ?? '-'}`);
    console.log(`    at confidence>=${cfg.confidenceGate.report}  ${String(s.reportable.correct).padStart(3)}/${String(s.reportable.asserted).padEnd(3)} correct   precision ${s.reportable.precision ?? '-'}`);
    console.log(`    recall             ${s.recall} (${s.buckets.correct.length}/${s.truthMatches})`);

    if (s.buckets.wrong.length) {
      console.log(`    WRONG PAIRINGS:`);
      for (const w of s.buckets.wrong) console.log(`      figma ${w.fi} -> web ${w.got} (truth: ${w.want})  conf ${w.confidence}`);
    }
    if (s.buckets.assertedOnNonMatch.length) {
      console.log(`    PAIRED SOMETHING TRUTH CALLS ${'missing/decor'}:`);
      for (const w of s.buckets.assertedOnNonMatch) console.log(`      figma ${w.fi} -> web ${w.got} (truth: ${w.want})  conf ${w.confidence}`);
    }
    if (s.buckets.missed.length) {
      console.log(`    missed (declined a real match): ${s.buckets.missed.map((m) => `${m.fi}->${m.want}`).join(', ')}`);
    }
    if (truth.conflicts?.length) {
      console.log(`    NOTE: ${truth.conflicts.length} unresolved conflict(s) in the truth file — see its _conflicts field`);
    }

    const sl = shortlistRecall(truth, pair, cfg, { ks: KS });
    console.log(`    shortlist recall   ${KS.map((k) => `@${k} ${(sl.hits[k] / Math.max(1, sl.total) * 100).toFixed(0)}%`).join('  ')}`);
    console.log(`    reachable ${s.buckets.reachable.length}, poisoned ${s.buckets.poisoned.length} — residue ceiling ${s.residueCeiling}`);
    console.log('');

    totals.asserted += s.reportable.asserted;
    totals.correct += s.reportable.correct;
    totals.wrong += s.reportable.wrong;
    totals.truthMatches += s.truthMatches;
    totals.correctAll += s.buckets.correct.length;

    poison.reachable += s.buckets.reachable.length;
    for (const p of s.buckets.poisoned) poison[p.poison]++;
    shortlistTotals.total += sl.total;
    shortlistTotals.unreachable += sl.unreachable;
    for (const k of KS) shortlistTotals.hits[k] += sl.hits[k];
  }

  const precision = totals.asserted ? totals.correct / totals.asserted : null;
  const pooled = (k) => shortlistTotals.hits[k] / Math.max(1, shortlistTotals.total);

  console.log(`  ── X1 · SHORTLIST RECALL@k (ranking only, nothing claimed) ──`);
  for (const k of KS) {
    console.log(`  k=${String(k).padStart(2)}   ${String(shortlistTotals.hits[k]).padStart(3)}/${shortlistTotals.total}   ${(pooled(k) * 100).toFixed(1).padStart(5)}%`);
  }
  if (shortlistTotals.unreachable) {
    console.log(`  WARNING: ${shortlistTotals.unreachable} truth rows reference a design element that no longer exists`);
  }
  console.log(`\n  ceiling utilisation @8: ${ceilingUtilisation(totals.correctAll, shortlistTotals.hits[8]) ?? '-'}` +
    `   (Tier 1 converts ${totals.correctAll} of the ${shortlistTotals.hits[8]} answers the top-8 contains)`);

  console.log(`\n  ── WHERE THE MISSES GO ─────────────────────────────`);
  const missTotal = poison.reachable + poison.figma + poison.web + poison.both;
  const pct = (n) => `${(n / Math.max(1, totals.truthMatches) * 100).toFixed(1)}%`;
  console.log(`  reachable (both sides free)  ${String(poison.reachable).padStart(3)}  ${pct(poison.reachable)}`);
  console.log(`  poisoned — figma consumed    ${String(poison.figma).padStart(3)}  ${pct(poison.figma)}`);
  console.log(`  poisoned — web consumed      ${String(poison.web).padStart(3)}  ${pct(poison.web)}`);
  console.log(`  poisoned — both consumed     ${String(poison.both).padStart(3)}  ${pct(poison.both)}`);
  console.log(`  residue-only ceiling         ${((totals.correctAll + poison.reachable) / Math.max(1, totals.truthMatches) * 100).toFixed(1)}%` +
    `   (correct ${totals.correctAll} + reachable ${poison.reachable} of ${totals.truthMatches})`);
  if (totals.correctAll + missTotal !== totals.truthMatches) {
    console.log(`  WARNING: ${totals.correctAll} + ${missTotal} != ${totals.truthMatches} — buckets do not reconcile`);
  }

  // The gate is a CONJUNCTION, and it has to be.
  //
  // Precision alone passes trivially by declining almost everything: a matcher
  // that asserts six pairs out of 161 true matches and gets them right reads
  // 100%, which is how the previous gate came to be reported as passed on four
  // assertions. Coverage at the reporting threshold is therefore gated too, so
  // a refusal cannot present as a result.
  const reportableRecall = totals.correct / Math.max(1, totals.truthMatches);
  const COVERAGE_BAR = 0.15;
  const precisionOk = precision !== null && precision > 0.95;
  const coverageOk = reportableRecall >= COVERAGE_BAR;

  console.log(`\n  ── GATE ────────────────────────────────────────────`);
  console.log(`  precision at confidence>=${cfg.confidenceGate.report}: ${precision === null ? 'n/a' : (precision * 100).toFixed(1) + '%'} (${totals.correct}/${totals.asserted})   required >95%   ${precisionOk ? 'ok' : 'FAIL'}`);
  console.log(`  recall AT that threshold:  ${(reportableRecall * 100).toFixed(1)}% (${totals.correct}/${totals.truthMatches})   required >=${COVERAGE_BAR * 100}%   ${coverageOk ? 'ok' : 'FAIL'}`);
  console.log(`  ${precisionOk && coverageOk ? 'PASS' : 'FAIL'}${precisionOk && !coverageOk ? '  — precise, but it is declining to answer' : ''}`);
  console.log(`  recall at any confidence (context only): ${(totals.correctAll / Math.max(1, totals.truthMatches) * 100).toFixed(1)}%`);
  console.log(`\n  ── PHASE A GATE (docs/v2-e2-rearchitecture.md §4) ───`);
  console.log(`  recall@8 >= 85%: ${(pooled(8) * 100).toFixed(1)}%   ${pooled(8) >= 0.85 ? 'PASS' : 'FAIL'}`);
  console.log(`  scored ${files.length} pairs, ${totals.truthMatches} true matches\n`);
}
