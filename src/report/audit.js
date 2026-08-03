/**
 * Prose audit - enforcement for "the LLM never produces a number".
 *
 * Parent doc 10.3 argues the response SCHEMA is the real defense and the prompt
 * is belt-and-braces. That holds for the structured mapping call, but the report
 * call returns free-form prose - there is no schema to constrain it. So the
 * enforcement has to be after the fact: extract every number the model wrote and
 * check each one traces to a value that existed before the model was called.
 *
 * A finding is data; prose is a rendering layer. If the rendering layer invents
 * a measurement, the whole determinism claim is void - and it would be invisible
 * without this check, because invented numbers look exactly like real ones.
 *
 * Reports, never throws. A questionable narrative is not a reason to fail a run
 * whose findings are sound.
 *
 * ## Measured discriminating power - do not oversell this
 *
 * The allowlist is every number that existed before the model ran. On the real
 * page that is 217 distinct values, which makes the check strong in one
 * direction and weak in the other:
 *
 *   - Fabricated LARGE or unusual values (heights, deltas, deltaE) are very
 *     likely caught: only 30 of the allowed values are >= 1000, so an invented
 *     four-digit number almost certainly has no match.
 *   - Fabricated SMALL integers are close to a coin flip: 53 of the 100 integers
 *     below 100 appear somewhere in the allowlist, so an invented "padding is
 *     37px" collides with a real value about half the time. Verified: a tampered
 *     report claiming "37px instead of 41px" passed clean.
 *
 * So this is a coarse net for egregious fabrication, NOT a proof of grounding.
 * Tightening it means matching numbers against the specific finding being
 * discussed rather than the global set - which needs structured output from the
 * model, i.e. the schema-based enforcement parent doc 10.3 prefers.
 */

/**
 * Digit groups, thousands separators included.
 *
 * A naive `\d+` splits "19,752px" into "19" and "752" and reports both as
 * invented measurements. The first run of this audit did exactly that - a guard
 * that cries wolf is worse than no guard, because the real signal gets ignored.
 */
const NUMBER_RE = /-?\d[\d,]*(?:\.\d+)?/g;

/**
 * Pull every number out of the interpretation strings too.
 *
 * The knowledge base itself contains figures - "404, CORS, or blocked request"
 * is a cause the model is told to quote. Omitting these made the audit flag its
 * own supplied text as fabricated. Any number the model was GIVEN is legitimate
 * for it to repeat, wherever in the payload it appeared.
 */
function addFromKnowledge(add, k) {
  if (!k) return;
  [k.title, k.why, k.investigate, k.intent, ...(k.causes ?? []), ...(k.impact ?? [])]
    .filter(Boolean)
    .forEach(add);
}

function collectAllowed(assembled, alignment, sections, analysis) {
  const allowed = new Set();

  const add = (v) => {
    if (v === null || v === undefined) return;
    const n = Number(v);
    if (Number.isFinite(n)) {
      allowed.add(String(n));
      allowed.add(String(Math.round(n)));
    }
    if (typeof v === 'string') {
      for (const m of v.match(NUMBER_RE) || []) {
        const plain = m.replace(/,/g, '');
        allowed.add(plain);
        allowed.add(String(Math.round(Number(plain))));
      }
    }
  };

  for (const f of assembled.findings) {
    [f.expected, f.actual, f.delta, f.ratio, f.occurrenceCount, f.sectionCount,
     f.tolerance, f.nearestInDesign].forEach(add);
    for (const s of f.sections) {
      add(s.figmaIndex + 1);
      add(s.webIndex + 1);
      add(s.confidence);
    }
  }

  for (const p of alignment.pairs) {
    if (p.figma) { add(Math.round(p.figma.height)); add(p.figma.index + 1); }
    if (p.web) { add(Math.round(p.web.height)); add(p.web.index + 1); }
    add(p.confidence);
  }

  add(Math.round(sections.figma.totalHeight));
  add(Math.round(sections.web.totalHeight));
  // Total-height delta is a page-level finding, so the model may legitimately cite it.
  add(Math.round(sections.web.totalHeight - sections.figma.totalHeight));
  add(sections.figma.sections.length);
  add(sections.web.sections.length);
  add(alignment.stats.meanConfidence);
  Object.values(assembled.counts.bySeverity).forEach(add);
  Object.values(assembled.counts.byCategory).forEach(add);

  // Everything the deterministic analysis layer computed and handed to the
  // model: health scores, the confidence percentage, per-issue counts, and the
  // interpretation text itself.
  if (analysis) {
    add(analysis.exec.overallScore);
    add(analysis.exec.confidence.percent);
    analysis.exec.confidence.notes.forEach(add);
    [analysis.exec.designSections, analysis.exec.pageSections, analysis.exec.matched,
     analysis.exec.missingInWeb, analysis.exec.extraInWeb,
     analysis.exec.designHeight, analysis.exec.pageHeight].forEach(add);
    Object.values(analysis.exec.totals).forEach(add);

    for (const s of analysis.sectionScores) {
      [s.score, s.figmaIndex + 1, s.webIndex + 1, s.confidence,
       s.designHeight, s.pageHeight, s.heightRatio, s.findings.length].forEach(add);
      Object.values(s.bySeverity).forEach(add);
    }
    for (const i of analysis.issues) {
      [i.occurrences, i.sections.length, i.variants].forEach(add);
      i.sections.forEach((n) => add(n + 1));
      addFromKnowledge(add, i.knowledge);
    }
    for (const step of analysis.fixOrder) {
      [step.rank, step.issueCount, step.sectionCount].forEach(add);
      add(step.rationale);
    }
  }

  return allowed;
}

/** Phrasings that would mean the report treated differing content as a defect. */
const CONTENT_LEAK = /\b(?:text|copy|wording|headline|content)\s+(?:differs|mismatch|is wrong|does not match|doesn't match)\b/i;

/**
 * @returns {{numbersCited, numbersTraced, unaccounted: string[], contentLeak: boolean, clean: boolean}}
 */
export function auditProse(markdown, assembled, alignment, sections, analysis) {
  const allowed = collectAllowed(assembled, alignment, sections, analysis);
  const cited = [...new Set((markdown.match(NUMBER_RE) || []).map((m) => m.replace(/,/g, '')))];

  const unaccounted = cited.filter(
    (n) => !allowed.has(n) && !allowed.has(String(Math.round(Number(n))))
  );

  const contentLeak = CONTENT_LEAK.test(markdown);

  return {
    numbersCited: cited.length,
    numbersTraced: cited.length - unaccounted.length,
    unaccounted: unaccounted.slice(0, 12),
    contentLeak,
    clean: unaccounted.length === 0 && !contentLeak,
  };
}
