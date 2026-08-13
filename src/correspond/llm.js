/**
 * E2 Tier 2 - vision correspondence. Contract: docs/v2-tier2-contract.md.
 *
 * The model decides IDENTITY. It never produces a measurement, never sees a
 * text string, and never overrides Tier 1.
 *
 * The schema is enforced at field level by the provider (measured), so no
 * numeric field but `confidence` can come back. It is NOT enforced for string
 * length, and `descriptor` absorbs geometry under pressure - also measured - so
 * that field is screened here rather than trusted.
 */

import { readFileSync } from 'node:fs';

const MODEL = process.env.LLM_MODEL?.trim() || 'gemini-3.5-flash';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

const RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      figmaId:    { type: 'STRING' },
      webId:      { type: 'STRING' },
      decision:   { type: 'STRING', enum: ['match', 'missing_in_web', 'extra_in_web'] },
      confidence: { type: 'NUMBER' },
      descriptor: { type: 'STRING', description: 'A short human name for the element, e.g. "primary CTA button". Never numbers.' },
    },
    required: ['figmaId', 'webId', 'decision', 'confidence', 'descriptor'],
  },
};

/** Anything that looks like a measurement. Descriptors matching this lose the label. */
const MEASUREMENT_LIKE = /#[0-9a-f]{3,8}\b|\b\d+(\.\d+)?\s*(px|pt|em|rem|%)\b|\b[xywh]\s*=\s*-?\d|\b\d{3,}\b/i;

const SYSTEM = `
You match elements between a DESIGN (Figma) and the BUILT WEB PAGE of the same section.

You are given two images of the same section - the design and the live page - and
lists of elements from each that have not yet been matched by geometry.

Decide which design elements correspond to which page elements.

Rules:
- Judge by what the images show. The element lists give you ids and boxes; the
  images tell you what things ARE.
- The two sides often differ: content is real on the page and placeholder in the
  design, layouts get rearranged during build, and one designed card may be
  built as twelve. Corresponding elements need not look identical - they need to
  be the same THING.
- An icon in the design is frequently built as a text character, a button or an
  image. Do not reject a pairing because the classes differ.
- If a design element was not built, say missing_in_web. If a page element was
  never designed, say extra_in_web. Use the empty string for the id that does
  not exist.
- Only claim a match you would defend. Confidence is what we act on: below 0.6
  the pair is discarded entirely, so an honest 0.5 is more useful than a
  hopeful 0.9.
- descriptor is a SHORT HUMAN NAME, like "testimonial author avatar". Never put
  numbers, coordinates, colours or sizes in it.
`.trim();

const asPart = (path) => ({
  inline_data: { mime_type: 'image/png', data: readFileSync(path).toString('base64') },
});

/** Compact element record - no text, no style values (contract §2). */
const line = (e) =>
  `${e.id} | ${e.cls} | x=${Math.round(e.box.x)} y=${Math.round(e.box.y)} ` +
  `w=${Math.round(e.box.w)} h=${Math.round(e.box.h)}` +
  `${e.hasText ? ' | has-text' : ''}` +
  `${e.templateId ? ` | repeated#${e.templateIndex}` : ''}`;

function buildPrompt({ figmaUnresolved, webUnresolved, anchored }) {
  const anchoredBlock = anchored.length
    ? anchored.map((a) => `  ${a.figmaId}  <->  ${a.webId}`).join('\n')
    : '  (none)';

  return `
Already matched by geometry - use these as reference points, do not re-decide them:
${anchoredBlock}

UNMATCHED DESIGN ELEMENTS (id | class | box):
${figmaUnresolved.map(line).join('\n') || '  (none)'}

UNMATCHED PAGE ELEMENTS (id | class | box):
${webUnresolved.map(line).join('\n') || '  (none)'}

Return one entry per decision you are willing to make.
`.trim();
}

/**
 * One Tier 2 call for one section pair.
 *
 * @returns {{ok: boolean, proposals: Array, usage: object, reason?: string}}
 */
export async function proposeCorrespondence({
  figmaImage, webImage, figmaUnresolved, webUnresolved, anchored, apiKey, model = MODEL,
}) {
  const started = Date.now();

  const body = {
    system_instruction: { parts: [{ text: SYSTEM }] },
    contents: [{
      role: 'user',
      parts: [
        // The design render can be absent when Figma quota is exhausted. That is
        // a DIFFERENT and weaker experiment - structure-only correspondence -
        // and is labelled as such wherever it is reported. It is never the gate.
        ...(figmaImage
          ? [{ text: 'DESIGN (Figma) render of this section:' }, asPart(figmaImage)]
          : [{ text: 'No design render is available for this section; reason from the element lists alone.' }]),
        { text: 'BUILT PAGE render of the same section:' },
        asPart(webImage),
        { text: buildPrompt({ figmaUnresolved, webUnresolved, anchored }) },
      ],
    }],
    generationConfig: {
      maxOutputTokens: 8192,
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
    return { ok: false, reason: `${res.status} ${String(json?.error?.message ?? res.statusText).slice(0, 200)}`, usage: { elapsedMs } };
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
    // Measured failure mode: under pressure the model pads `descriptor` until it
    // hits the ceiling and the JSON truncates. Fail the call, never half-parse.
    return { ok: false, reason: `invalid JSON (${err.message}); finishReason ${usage.finishReason}`, usage };
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: 'response was not an array', usage };

  let descriptorsDropped = 0;
  const proposals = parsed.map((p) => {
    let descriptor = typeof p.descriptor === 'string' ? p.descriptor.slice(0, 60) : '';
    if (MEASUREMENT_LIKE.test(descriptor)) { descriptor = ''; descriptorsDropped++; }
    return {
      figmaId: String(p.figmaId ?? ''),
      webId: String(p.webId ?? ''),
      decision: p.decision,
      confidence: Number(p.confidence) || 0,
      descriptor,
    };
  });

  return { ok: true, proposals, usage: { ...usage, descriptorsDropped } };
}
