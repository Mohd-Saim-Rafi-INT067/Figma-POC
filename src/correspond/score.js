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

const TRUTH_DIR = 'fixtures/spike';

export function scorePair(truth, pair, cfg) {
  const result = anchorSection(pair.figma, pair.web, cfg);
  const asserted = new Map(result.pairs.map((p) => [p.figmaIndex, p]));

  const buckets = {
    correct: [], wrong: [], missed: [],
    assertedOnNonMatch: [],   // matcher paired something truth calls missing/decor
    excluded: [],
  };

  for (const [key, want] of Object.entries(truth.truth)) {
    const fi = Number(key);
    const got = asserted.get(fi);

    if (want === '?') { buckets.excluded.push(fi); continue; }

    const isRealMatch = typeof want === 'number';
    if (!got) {
      if (isRealMatch) buckets.missed.push({ fi, want });
      continue;                                    // declining a missing/decor is correct
    }
    if (!isRealMatch) { buckets.assertedOnNonMatch.push({ fi, want, got: got.webIndex, confidence: got.confidence }); continue; }
    (got.webIndex === want ? buckets.correct : buckets.wrong).push({ fi, want, got: got.webIndex, confidence: got.confidence });
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
    buckets,
  };
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
  const totals = { asserted: 0, correct: 0, wrong: 0, truthMatches: 0, correctAll: 0 };

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
    console.log('');

    totals.asserted += s.reportable.asserted;
    totals.correct += s.reportable.correct;
    totals.wrong += s.reportable.wrong;
    totals.truthMatches += s.truthMatches;
    totals.correctAll += s.buckets.correct.length;
  }

  const precision = totals.asserted ? totals.correct / totals.asserted : null;
  console.log(`  ── GATE ────────────────────────────────────────────`);
  console.log(`  precision at confidence>=${cfg.confidenceGate.report}: ${precision === null ? 'n/a' : (precision * 100).toFixed(1) + '%'} (${totals.correct}/${totals.asserted})`);
  console.log(`  required: >95%   ${precision === null ? '' : precision > 0.95 ? 'PASS' : 'FAIL'}`);
  console.log(`  recall (context only): ${(totals.correctAll / Math.max(1, totals.truthMatches) * 100).toFixed(1)}%`);
  console.log(`  scored ${files.length} of 3 planned pairs\n`);
}
