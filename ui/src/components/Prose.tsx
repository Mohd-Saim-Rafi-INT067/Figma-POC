import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * Renders one block of the generated report.
 *
 * Sanitised unconditionally. This is language-model output, and the fact that
 * we made the call ourselves does not make the text trusted - it is the one
 * string in the whole app that nobody wrote and nobody reviewed.
 *
 * Renders NOTHING when its block is absent. That is the point of the
 * structured/prose split: every number on the page comes from the computed
 * analysis, so a missing narrative leaves a slightly quieter report rather
 * than a hole with an error in it.
 */
export function Prose({ markdown }: { markdown?: string }) {
  const html = useMemo(() => {
    if (!markdown?.trim()) return null;
    const raw = marked.parse(markdown, { async: false }) as string;
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  }, [markdown]);

  if (!html) return null;

  return (
    <div
      className="prose-report max-w-none text-[15px] leading-relaxed text-slate-700"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * Shown once, calmly, when the narrative is unavailable.
 *
 * Deliberately not an error banner. The findings ARE the product; prose is a
 * rendering layer over them (report/llm.js says so in as many words). A run
 * with no model key is a complete run.
 */
export function ProseUnavailable({ reason }: { reason?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
      <span className="font-medium text-slate-700">No written summary for this run.</span>{' '}
      Every score, issue and finding below is computed from the measurements, so the report is
      complete without it.
      {reason && <span className="mt-1 block text-slate-500">{reason}</span>}
    </div>
  );
}
