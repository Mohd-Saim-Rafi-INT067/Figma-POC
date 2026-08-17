/**
 * E2c - shortlist adjudication. Contract: docs/v2-e2-rearchitecture.md §3.
 *
 * The model decides IDENTITY. It never produces a measurement, never sees a
 * style value, and never invents an element.
 *
 * THE CHANGE FROM THE PREVIOUS TIER 2, and it is the load-bearing one: the
 * model no longer types ids. It is given, per design element, a numbered list of
 * candidate page elements that geometry already ranked, and it returns AN INDEX
 * INTO THAT LIST. Three consequences follow, and none of them depend on the
 * model cooperating:
 *
 *   - a phantom id is structurally impossible. The worst failure mode in the old
 *     contract (§7.2, "fatal - the model invented an element") stops being a
 *     check and becomes an invariant;
 *   - the payload is bounded at n*k rows rather than n*m free search;
 *   - the ceiling is knowable before spending anything. Measured: the true
 *     partner is in the top 8 for 90.1% of true matches.
 *
 * Why a shortlist rather than the residue the old design sent: Tier 1 consumed
 * both elements of every wrong pair it made, so 47.8% of true matches never
 * reached the residue at all and a perfect model was capped at 52.2% recall.
 */

import { readFileSync } from 'node:fs';

const MODEL = process.env.LLM_MODEL?.trim() || 'gemini-3.5-flash';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * `pick` is an INTEGER, and -1 rather than null means "no correspondence".
 *
 * The plan specified null. Provider schema support for nullable integers is not
 * something to discover mid-benchmark, and a sentinel is trivially validated
 * where a null is not, so the deviation is deliberate and recorded here.
 */
const NO_MATCH = -1;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    assignments: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          f: { type: 'INTEGER', description: 'The number in brackets beside the design element.' },
          pick: { type: 'INTEGER', description: 'Index of the chosen candidate, or -1 for no correspondence.' },
          confidence: { type: 'NUMBER' },
          reason: { type: 'STRING', enum: ['not_built', 'ambiguous', 'none_plausible', 'matched'] },
          descriptor: { type: 'STRING', description: 'A short human name, e.g. "primary CTA button". Never numbers.' },
        },
        required: ['f', 'pick', 'confidence', 'reason', 'descriptor'],
      },
    },
  },
  required: ['assignments'],
};

/** Anything that looks like a measurement. Descriptors matching this lose the label. */
const MEASUREMENT_LIKE = /#[0-9a-f]{3,8}\b|\b\d+(\.\d+)?\s*(px|pt|em|rem|%)\b|\b[xywh]\s*=\s*-?\d|\b\d{3,}\b/i;

const SYSTEM = `
You match elements between a DESIGN (Figma) and the BUILT WEB PAGE of the same section.

You are given two images of the same section - the design and the live page - and
a list of design elements. Each design element comes with NUMBERED CANDIDATES:
page elements that geometry considers plausible, best guess first.

For each design element, choose which candidate is the same thing.

Rules:
- Identify the design element by the number in ITS brackets, like DESIGN (12) -> f: 12.
  Answer with the candidate's number in square brackets, like [3] -> pick: 3.
  Both are plain integers. Never write an id, a label or any other text in them.
- Never answer with a candidate number that is not in that element's own list.
- Geometry ordered the candidates but is often wrong about which is correct - that
  is why you are being asked. Candidate 0 is a suggestion, not an answer.
- Judge by what the images show. The lists give ids, boxes and text; the images
  tell you what things ARE.
- The two sides legitimately differ: copy is real on the page and placeholder in
  the design, layouts get rearranged during the build, and one designed card may
  be built as twelve. Corresponding elements need not look identical - they need
  to be the same THING.
- An icon in the design is frequently built as a text character, a button or an
  image. Do not reject a pairing because the kinds differ.
- If no candidate is the counterpart, answer -1. Use reason "not_built" if the
  design element was never built, "none_plausible" if the right element is simply
  not in the list, and "ambiguous" if several are equally good and you cannot
  separate them.
- Confidence is what we act on. Below 0.6 the answer is discarded entirely, so an
  honest 0.5 is more useful than a hopeful 0.9. A guess between two identical
  candidates should be "ambiguous", not a confident pick.
- descriptor is a SHORT HUMAN NAME, like "testimonial author avatar". Never put
  numbers, coordinates, colours or sizes in it.
`.trim();

const asPart = (path) => ({
  inline_data: { mime_type: 'image/png', data: readFileSync(path).toString('base64') },
});

/**
 * One element as a prompt line.
 *
 * Carries id, kind, box and text - and NOTHING measured. No colour, no radius,
 * no font size, no Tier 1 confidence. A value the model never sees is a value it
 * cannot hand back as a finding, which is what keeps E4's verdicts E4's.
 *
 * Text is included from Phase C onward: it is an identity signal, it is measured
 * to be worth 14 points of recall@1, and it is not a measured VALUE. It is
 * truncated hard here as well as at E1 - a prompt is not the place to discover
 * that a paragraph was long.
 */
const line = (e) => {
  const text = e.textKey ? ` | "${e.textKey.slice(0, 60)}"` : '';
  const tpl = e.templateId ? ` | instance ${e.templateIndex}` : '';
  return `${e.cls} | x=${Math.round(e.box.x)} y=${Math.round(e.box.y)} ` +
    `w=${Math.round(e.box.w)} h=${Math.round(e.box.h)}${text}${tpl}`;
};

/**
 * Build the question for one batch.
 *
 * BOTH sides of the answer are numbers, and neither is an id the model types.
 *
 * The first version of this prompt put the design element's raw id on a line
 * beginning "DESIGN ", and the model answered "DESIGN 2743:6912" - copying the
 * label along with the id, which is a perfectly reasonable reading of the text
 * it was shown. 45 of 47 answers were unresolvable. That is a prompt defect, not
 * a model defect, and the fix is to remove the opportunity rather than to parse
 * around it: an integer index cannot be copied wrongly, and verify.js can check
 * it against the exact list this function was given.
 *
 * @param batch [{ index, figmaEl, candidates: [webEl] }] - candidates ranked
 */
export function buildPrompt(batch) {
  const blocks = batch.map(({ index, figmaEl, candidates }) => {
    const rows = candidates.length
      ? candidates.map((w, i) => `  [${i}] ${line(w)}`).join('\n')
      : '  (no plausible candidates - answer -1)';
    return `DESIGN (${index}) ${line(figmaEl)}\n${rows}`;
  });

  return `${blocks.join('\n\n')}\n\nAnswer once for every design element above, ` +
    'using its bracketed number as "f".';
}

/**
 * One adjudication call for one batch of design elements.
 *
 * @returns {{ok: boolean, assignments: Array, usage: object, reason?: string}}
 */
export async function adjudicate({
  figmaImage, webImage, batch, apiKey, model = MODEL, maxOutputTokens = 8192,
  retries = 4, backoffMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  let attempt = 0;
  for (;;) {
    const call = await attemptOnce();
    // 503 "high demand" and 429 are transient and were observed to cost half of
    // a benchmark run when treated as terminal. A batch is worth retrying; a
    // schema or parse failure is not, because it will fail identically.
    const transient = call.ok ? false : /^(429|500|502|503|504)\b/.test(call.reason ?? '');
    if (call.ok || !transient || attempt >= retries) {
      return attempt ? { ...call, usage: { ...call.usage, attempts: attempt + 1 } } : call;
    }
    await sleep(backoffMs * 2 ** attempt);
    attempt++;
  }

  async function attemptOnce() {
  const started = Date.now();

  const body = {
    system_instruction: { parts: [{ text: SYSTEM }] },
    contents: [{
      role: 'user',
      parts: [
        // The design render can be absent when Figma quota is exhausted. That is
        // a DIFFERENT and weaker experiment and is labelled as such wherever it
        // is reported. It is never the gate.
        ...(figmaImage
          ? [{ text: 'DESIGN (Figma) render of this section:' }, asPart(figmaImage)]
          : [{ text: 'No design render is available for this section; reason from the element lists alone.' }]),
        ...(webImage
          ? [{ text: 'BUILT PAGE render of the same section:' }, asPart(webImage)]
          : [{ text: 'No page render is available for this section.' }]),
        { text: buildPrompt(batch) },
      ],
    }],
    generationConfig: {
      maxOutputTokens,
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const res = await fetch(`${ENDPOINT}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => null);
  const elapsedMs = Date.now() - started;

  if (!res.ok || json?.error) {
    return {
      ok: false,
      reason: `${res.status} ${String(json?.error?.message ?? res.statusText).slice(0, 200)}`,
      usage: { elapsedMs },
    };
  }

  const candidate = json.candidates?.[0];
  const text = (candidate?.content?.parts ?? []).map((p) => p.text).filter(Boolean).join('').trim();
  const u = json.usageMetadata ?? {};
  const usage = {
    model,
    elapsedMs,
    inputTokens: u.promptTokenCount ?? null,
    outputTokens: u.candidatesTokenCount ?? null,
    totalTokens: u.totalTokenCount ?? null,
    finishReason: candidate?.finishReason ?? null,
  };

  if (!text) return { ok: false, reason: `no text (finishReason ${usage.finishReason})`, usage };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // Measured failure mode on the old contract: under pressure the model pads
    // free text until it hits the ceiling and the JSON truncates. Fail the call,
    // never half-parse. Batching exists so one such failure costs its own batch
    // and nothing else.
    return { ok: false, reason: `invalid JSON (${err.message}); finishReason ${usage.finishReason}`, usage };
  }

  const list = parsed?.assignments;
  if (!Array.isArray(list)) return { ok: false, reason: 'response carried no assignments array', usage };

  let descriptorsDropped = 0;
  const assignments = list.map((a) => {
    let descriptor = typeof a.descriptor === 'string' ? a.descriptor.slice(0, 60) : '';
    if (MEASUREMENT_LIKE.test(descriptor)) { descriptor = ''; descriptorsDropped++; }
    return {
      // Left as-is when it is not an integer, so verify.js can count the failure
      // rather than have it silently become element 0.
      f: Number.isInteger(a.f) ? a.f : a.f ?? null,
      // Coerced here so verify.js sees a number or NO_MATCH and never a string
      // that happens to look like one. Anything unparseable becomes "no answer".
      pick: Number.isInteger(a.pick) ? a.pick : NO_MATCH,
      confidence: Number(a.confidence) || 0,
      reason: a.reason ?? 'matched',
      descriptor,
    };
  });

  return { ok: true, assignments, usage: { ...usage, descriptorsDropped } };
  }
}

export { NO_MATCH, RESPONSE_SCHEMA, SYSTEM };
