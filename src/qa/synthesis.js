/**
 * E7 - the LLM as a PRESENTATION layer, and nothing else.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  The model may choose WORDS. It may never choose FACTS.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Every measurement, severity, confidence, affected-element count and issue
 * identity comes from E3-E6 and is written into the report before the model is
 * called. The model returns three short strings per issue - a title, an impact
 * line, a fix line - and those are the only fields that can change.
 *
 * That is enforced three ways, because "we told it not to" is not enforcement:
 *
 *   1. SCHEMA        the response carries no numeric field at all, so a
 *                    measurement cannot come back as data.
 *   2. GROUNDING     any number appearing in the returned TEXT must already
 *                    exist in that issue's own values. Measured in Phase 2:
 *                    denied a typed field, the model packs geometry into free
 *                    text instead - every time.
 *   3. ABSENCE GUARD wording that asserts something is missing is rejected
 *                    unless E3 actually produced an absence claim. "Not
 *                    aligned" means correspondence was not established; it is a
 *                    statement about the tool, not the page.
 *
 * A field failing any check is DISCARDED and the deterministic default stands.
 * The report is complete and correct without the model ever being called.
 */

const MODEL = process.env.LLM_MODEL?.trim() || 'gemini-3.5-flash';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

const RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      ref: { type: 'STRING' },
      title: { type: 'STRING' },
      impact: { type: 'STRING' },
      fix: { type: 'STRING' },
    },
    required: ['ref', 'title', 'impact', 'fix'],
  },
};

const SYSTEM = `
You write terse copy for a developer visual-QA dashboard.

You are given issues that have ALREADY been measured and ranked. Your only job
is wording. For each, return:

  title   <= 60 chars. What is wrong, in plain words. No numbers.
  impact  <= 90 chars. What a visitor sees. No numbers.
  fix     <= 90 chars. What a developer should change. No numbers.

Rules:
- NEVER state a measurement, size, colour value, count or percentage. Those are
  printed beside your text from measured data; repeating them risks contradiction.
- NEVER say something is "missing", "absent", "not built" or "removed" unless the
  issue is explicitly typed as a structural absence. An unmatched element means
  the tool could not align it, not that the page lacks it.
- NEVER invent a cause you were not given.
- Write like a bug tracker, not an essay. No hedging, no "appears to be", no
  "the analysis indicates".

Good:  title "Form fields wider than designed"
       impact "Fields overflow the intended column"
       fix "Update the shared form-field width token"
Bad:   "The analysis indicates a potential 172px discrepancy which may affect..."
`.trim();

/**
 * Thinking budget, only when explicitly configured.
 *
 * Models disagree about this field: some accept it, `gemini-flash-latest`
 * returns 400 for it. Sending it unconditionally makes the whole synthesis
 * layer model-specific for no benefit.
 */
function thinkingConfig() {
  const raw = process.env.LLM_THINKING_BUDGET;
  if (raw === undefined || raw.trim() === '') return {};
  const budget = Number(raw);
  return Number.isFinite(budget) ? { thinkingConfig: { thinkingBudget: budget } } : {};
}

/** Numbers in prose must already exist in the issue's own measured values. */
const NUMBER_RE = /\d+(?:\.\d+)?/g;

/** Wording that asserts absence - only legal for a real structural claim. */
const ABSENCE_RE = /\b(missing|absent|not built|never built|removed|omitted|does not exist|doesn'?t exist)\b/i;

function allowedNumbers(issue) {
  const allowed = new Set();
  const add = (v) => {
    if (v == null) return;
    for (const m of String(v).match(NUMBER_RE) ?? []) {
      allowed.add(m);
      allowed.add(String(Math.round(Number(m))));
    }
  };
  for (const p of issue.properties ?? []) { add(p.expected); add(p.actual); add(p.delta); }
  add(issue.affectedElements);
  add(issue.templateInstances);
  return allowed;
}

/**
 * Keep a synthesised string only if it earns its place.
 * @returns {string|null} null when the deterministic default should stand
 */
export function guardText(text, issue, { maxLength, allowAbsence }) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > maxLength * 1.5) return null;

  if (!allowAbsence && ABSENCE_RE.test(trimmed)) return null;

  const allowed = allowedNumbers(issue);
  for (const n of trimmed.match(NUMBER_RE) ?? []) {
    if (!allowed.has(n) && !allowed.has(String(Math.round(Number(n))))) return null;
  }
  return trimmed.slice(0, maxLength);
}

/**
 * Merge synthesised copy onto deterministic issues.
 *
 * Never mutates a measured field. Only `title`, `impact` and `fix` can change,
 * and only when they pass the guard.
 */
export function applySynthesis(issues, synthesised, stats = { accepted: 0, rejected: 0 }) {
  const byRef = new Map((synthesised ?? []).map((s) => [String(s.ref), s]));

  return issues.map((issue) => {
    const s = byRef.get(String(issue.ref));
    if (!s) return issue;

    // Absence wording is legal only where E3 actually claimed absence.
    const allowAbsence = issue.kind === 'structural';
    const title = guardText(s.title, issue, { maxLength: 60, allowAbsence });
    const impact = guardText(s.impact, issue, { maxLength: 90, allowAbsence });
    const fix = guardText(s.fix, issue, { maxLength: 90, allowAbsence });

    for (const v of [title, impact, fix]) (v ? stats.accepted++ : stats.rejected++);

    return {
      ...issue,
      title: title ?? issue.title,
      impact: impact ?? issue.impact,
      fix: fix ?? issue.fix,
      synthesised: { title: !!title, impact: !!impact, fix: !!fix },
    };
  });
}

/**
 * Parse the response, salvaging complete entries from a truncated array.
 *
 * Hitting the output ceiling mid-string throws on `JSON.parse` and discards
 * everything - including the twenty issues the model had already worded
 * correctly. Since each entry is independent, trimming back to the last
 * complete object recovers them at no risk: an entry is either whole and
 * guarded like any other, or it never existed.
 */
function parseMaybeTruncated(text) {
  try {
    return JSON.parse(text);
  } catch {
    const lastComplete = text.lastIndexOf('},');
    if (lastComplete === -1) return [];
    try {
      return JSON.parse(`${text.slice(0, lastComplete + 1)}]`);
    } catch {
      return [];
    }
  }
}

/** The compact record the model sees - no severity to change, no ids to invent. */
function promptFor(issues) {
  return issues.map((i) => ({
    ref: i.ref,
    what: i.properties.map((p) => p.property).join(', '),
    element: i.element.cls,
    kind: i.kind ?? 'property',
  }));
}

/**
 * Call the model. Returns `{ok:false}` on any failure - the caller keeps its
 * deterministic text and the report is unaffected.
 */
/**
 * Batched, because one call for a whole page does not fit.
 *
 * Measured: 255 issues in a single request truncated mid-JSON at the output
 * ceiling, and a truncated response is a failed one - the parse throws and the
 * entire page falls back to deterministic wording. Batching turns an
 * all-or-nothing call into per-batch degradation: a batch that fails costs its
 * own issues their copy and nothing else.
 */
export async function synthesiseAll(issues, { apiKey, model = MODEL, batchSize = 20 } = {}) {
  if (!apiKey) return { ok: false, reason: 'no API key', items: [], batches: 0 };
  if (!issues.length) return { ok: true, items: [], batches: 0 };

  const items = [];
  const failures = [];
  let batches = 0;

  for (let i = 0; i < issues.length; i += batchSize) {
    const batch = issues.slice(i, i + batchSize);
    const res = await synthesise(batch, { apiKey, model });
    batches++;
    if (res.ok) items.push(...res.items);
    else failures.push(res.reason);
  }

  return {
    ok: items.length > 0,
    items,
    batches,
    failed: failures.length,
    reason: failures.length ? `${failures.length}/${batches} batches failed: ${failures[0]}` : null,
  };
}

export async function synthesise(issues, { apiKey, model = MODEL } = {}) {
  if (!apiKey) return { ok: false, reason: 'no API key', items: [] };
  if (!issues.length) return { ok: true, items: [] };

  const body = {
    system_instruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: JSON.stringify(promptFor(issues), null, 1) }] }],
    generationConfig: {
      // Three short strings per issue adds up: 40 issues truncated the JSON
      // mid-string at 4096, losing the whole batch.
      maxOutputTokens: 8192,
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      // Only sent when LLM_THINKING_BUDGET is set, mirroring report/llm.js.
      // Not every model accepts it: `gemini-flash-latest` rejects the field
      // outright with HTTP 400 "invalid argument", and hardcoding it silently
      // limited synthesis to one model family. Unset means the model decides.
      ...thinkingConfig(),
    },
  };

  try {
    const res = await fetch(`${ENDPOINT}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || json?.error) {
      return { ok: false, reason: `${res.status} ${String(json?.error?.message ?? '').slice(0, 120)}`, items: [] };
    }
    const text = (json.candidates?.[0]?.content?.parts ?? []).map((p) => p.text).filter(Boolean).join('').trim();
    const items = parseMaybeTruncated(text);
    return { ok: Array.isArray(items), items: Array.isArray(items) ? items : [], usage: json.usageMetadata };
  } catch (err) {
    return { ok: false, reason: err.message, items: [] };
  }
}
