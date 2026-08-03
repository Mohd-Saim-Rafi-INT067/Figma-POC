/**
 * S5 - LLM prose report. V1 plan phase F.
 *
 * OPTIONAL BY DESIGN. Parent doc 1.3: "Findings are data; prose is a rendering
 * layer." Every value in every finding exists before this runs, so a missing key
 * costs you the narrative and nothing else - findings.json, the HTML report and
 * the console summary are all complete without it. Nothing here may fail a run.
 *
 * The model's job is explanation and prioritisation. It never produces a number:
 * the prompt says so, and the input already contains every measurement, so there
 * is nothing for it to compute.
 *
 * Two providers:
 *   - gemini    (POC default - REST, no SDK dependency)
 *   - anthropic (what the parent doc 10.2 specifies for the product)
 *
 * The Anthropic path is kept deliberately: the design doc pins claude-opus-5 for
 * report generation, and dropping it here would mean rewriting it at port time.
 */

const DEFAULT_MODEL = {
  gemini: 'gemini-3.5-flash',
  anthropic: 'claude-opus-5',
};

const SYSTEM = `You are writing a design-parity AUDIT comparing a Figma design against a live website. Your readers are a mix of developers, designers, QA engineers and engineering managers.

Everything measurable has ALREADY been computed: findings, health scores, root-cause groupings, fix order, probable causes and impacts are all supplied to you. Your job is judgement and narrative - turning that structure into something a reader can act on.

HARD RULES
- Never invent, estimate or recompute a number. Every figure you cite must appear verbatim in the input.
- Never invent a cause or an impact. Use the supplied "causes" and "impact" lists; you may select among them and rephrase, but not extend.
- Content differences are NOT defects. The design and live page legitimately carry different copy, images and data. Never treat differing text as a problem.
- Do not restate the findings table. If a reader wanted the table they would read the table.
- Where a section is flagged as containing dynamic content, say the finding is less certain rather than presenting it as fact.
- Never expose the input's field names, keys or boolean values in your prose. Write "a single fix resolves this" or "spread across many sections", never "Systemic: True" or "fixCentrally: false". The reader is not looking at the JSON.

WRITE THIS STRUCTURE, in markdown:

## Executive Assessment
Three to five sentences. Lead with overall health and whether the STRUCTURE holds - were all design sections found on the page? Then name where the problems concentrate. Then say plainly whether this reads as visual refinement work or as structural implementation failure. Interpret the match-confidence figure for a reader who has no idea what a good value looks like.

## What To Fix First
Walk the supplied fix order IN THE ORDER GIVEN - the ranking is already computed and weighs severity, blast radius and effort. Do not reorder it or your numbering will contradict the rank you cite. For each entry: what it is, why it ranks there, and whether it is one central fix ("fixCentrally": true) or many local ones ("systemic": true).

## Key Issues
For the most significant issues only (roughly the top four to six). For each, use exactly this shape:

### <issue title>
**Expected vs found** - one line, citing the supplied values.
**Why this matters** - the user-visible consequence, not a restatement of the measurement.
**Likely cause** - the one or two most plausible from the supplied causes, and say which you would check first.
**Impact** - who or what this affects.
**Intent** - deliberate or accidental, where the input indicates it.

## Section Notes
Only sections that need attention. One short paragraph each: how it scored, what is wrong, and whether its problems share a single cause.

## Conclusion
One paragraph a manager could read alone: is the implementation structurally faithful, what class of work remains, and how concentrated it is.`;

/**
 * Trim findings to what the model needs. Sending the raw JSON wastes tokens on
 * fields that exist for machines (fingerprints, ids) and adds nothing to prose.
 */
function toPayload(assembled, alignment, sections, analysis) {
  return {
    scope: {
      note: 'Section-level comparison. Text content is used only to align sections and is never itself a finding.',
      designTotalHeight: Math.round(sections.figma.totalHeight),
      pageTotalHeight: Math.round(sections.web.totalHeight),
    },

    // Pre-computed. The model narrates these; it must not recompute them.
    assessment: analysis.exec,
    fixOrder: analysis.fixOrder,

    issues: analysis.issues.map((i) => ({
      title: i.knowledge.title,
      property: i.property,
      category: i.category,
      severity: i.severity,
      affectedSections: i.sections.map((s) => s + 1),
      occurrences: i.occurrences,
      fixCentrally: i.oneFix,
      systemic: i.systemic,
      examples: i.findings.slice(0, 4).map((f) => ({
        design: f.expected,
        page: f.actual,
        delta: f.delta ?? undefined,
        ratio: f.ratio ?? undefined,
        sections: f.sections.map((s) => `${s.figmaIndex + 1}->${s.webIndex + 1}`),
        lowConfidence: f.lowConfidence || undefined,
      })),
      // Supplied interpretation - select from these, never extend them.
      why: i.knowledge.why,
      causes: i.knowledge.causes,
      impact: i.knowledge.impact,
      investigate: i.knowledge.investigate,
      intent: i.knowledge.intent,
    })),

    sections: analysis.sectionScores.map((s) => ({
      pair: `${s.figmaIndex + 1}->${s.webIndex + 1}`,
      label: s.label,
      score: s.score,
      status: s.status,
      matchConfidence: s.confidence,
      designHeight: s.designHeight,
      pageHeight: s.pageHeight,
      heightRatio: s.heightRatio,
      findingCount: s.findings.length,
      bySeverity: s.bySeverity,
      problems: s.problems,
    })),

    unmatchedSections: alignment.pairs
      .filter((p) => !p.figma || !p.web)
      .map((p) => ({
        side: p.figma ? 'design-only' : 'page-only',
        label: (p.figma ?? p.web).headline,
        height: Math.round((p.figma ?? p.web).height),
      })),
  };
}

const userPrompt = (payload) =>
  'Write the design-parity report for this run.\n\n```json\n' +
  JSON.stringify(payload, null, 2) +
  '\n```';

// --- gemini ---------------------------------------------------------------

async function callGemini(payload, model, apiKey) {
  const raw = process.env.LLM_THINKING_BUDGET;
  const budget = raw === undefined || raw.trim() === '' ? null : Number(raw);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt(payload) }] }],
      // Generous ceiling: this model counts reasoning against the output budget,
      // so a tight cap truncates the report before any prose is emitted.
      generationConfig: {
        maxOutputTokens: 65536,
        temperature: 0.4,
        // Latency control. Thinking dominates wall time on this model - measured
        // 15.2s with it on versus 3.0s with it off on an equivalent prompt.
        // Every fact is pre-computed here, so the model is composing rather than
        // reasoning; a smaller budget costs less than it would on an open task.
        // Unset = model decides. 0 = off.
        ...(budget === null ? {} : { thinkingConfig: { thinkingBudget: budget } }),
      },
    }),
  });

  const body = await res.json().catch(() => null);

  if (!res.ok || body?.error) {
    const e = body?.error;
    return {
      ok: false,
      reason: `Gemini ${res.status}${e ? ` ${e.status}` : ''}: ${String(e?.message ?? res.statusText).slice(0, 180)}`,
    };
  }

  const candidate = body?.candidates?.[0];
  const text = (candidate?.content?.parts ?? [])
    .map((p) => p.text)
    .filter(Boolean)
    .join('')
    .trim();

  if (!text) {
    // MAX_TOKENS here means reasoning consumed the whole budget - worth naming,
    // because "no text" and "budget exhausted" need different fixes.
    return {
      ok: false,
      reason: `Gemini returned no text (finishReason: ${candidate?.finishReason ?? 'unknown'})`,
    };
  }

  const u = body.usageMetadata ?? {};
  return {
    ok: true,
    markdown: text,
    usage: {
      model,
      provider: 'gemini',
      inputTokens: u.promptTokenCount ?? null,
      outputTokens: u.candidatesTokenCount ?? null,
      totalTokens: u.totalTokenCount ?? null,
    },
  };
}

// --- anthropic ------------------------------------------------------------

async function callAnthropic(payload, model) {
  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch {
    return { ok: false, reason: '@anthropic-ai/sdk is not installed. Run: npm install @anthropic-ai/sdk' };
  }

  const client = new Anthropic();
  const response = await client.messages.create({
    model,
    max_tokens: 16000,
    system: SYSTEM,
    messages: [{ role: 'user', content: userPrompt(payload) }],
  });

  if (response.stop_reason === 'refusal') {
    return { ok: false, reason: `Model declined: ${response.stop_details?.category ?? 'unspecified'}` };
  }

  const markdown = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  if (!markdown) return { ok: false, reason: 'Model returned no text content.' };

  return {
    ok: true,
    markdown,
    usage: {
      model: response.model,
      provider: 'anthropic',
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}

// --- dispatch -------------------------------------------------------------

/** Explicit LLM_PROVIDER wins; otherwise infer from whichever key is present. */
function resolveProvider() {
  const explicit = (process.env.LLM_PROVIDER || '').trim().toLowerCase();
  if (explicit) return explicit;
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}

/**
 * @returns {{ok: boolean, markdown?: string, reason?: string, usage?: object}}
 */
export async function generateProseReport(assembled, alignment, sections, analysis) {
  const provider = resolveProvider();
  if (!provider) {
    return {
      ok: false,
      reason:
        'No LLM key configured (set GEMINI_API_KEY or ANTHROPIC_API_KEY in .env). ' +
        'Findings, HTML and console output are complete without it.',
    };
  }

  const model = process.env.LLM_MODEL?.trim() || DEFAULT_MODEL[provider];
  if (!model) return { ok: false, reason: `Unknown LLM_PROVIDER "${provider}" (expected gemini or anthropic).` };

  const payload = toPayload(assembled, alignment, sections, analysis);

  try {
    if (provider === 'gemini') {
      const key = process.env.GEMINI_API_KEY;
      if (!key) return { ok: false, reason: 'LLM_PROVIDER=gemini but GEMINI_API_KEY is not set.' };
      return await callGemini(payload, model, key);
    }
    if (provider === 'anthropic') {
      if (!process.env.ANTHROPIC_API_KEY) {
        return { ok: false, reason: 'LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set.' };
      }
      return await callAnthropic(payload, model);
    }
    return { ok: false, reason: `Unknown LLM_PROVIDER "${provider}" (expected gemini or anthropic).` };
  } catch (err) {
    // A failed prose call must never fail the run - the findings are the product.
    return { ok: false, reason: `${err.name ?? 'Error'}: ${err.message}` };
  }
}
