import { useState } from 'react';
import type { ProseAudit } from '../types';

/**
 * Every figure in the written summary, traced back to a value that existed
 * before the model was called.
 *
 * The check is report/audit.js on the server; this only shows the result. It
 * is worth showing because it is the one claim in the report a sceptical
 * reader most wants tested: that the AI narration did not invent a
 * measurement.
 *
 * The tooltip is honest about the limit. audit.js documents its own
 * discriminating power - strong against fabricated large or unusual values,
 * close to a coin flip on small integers, because the allowlist is every
 * number that existed before the model ran. It is a net for egregious
 * fabrication, not a proof of grounding, and overselling it here would be the
 * exact failure it exists to catch.
 */
export function ProseAuditBadge({ audit }: { audit: ProseAudit }) {
  const [open, setOpen] = useState(false);
  const clean = audit.clean;

  return (
    <div
      className={`rounded-lg px-3.5 py-2.5 text-sm ring-1 ring-inset ${
        clean ? 'bg-emerald-50 text-emerald-900 ring-emerald-200' : 'bg-amber-50 text-amber-900 ring-amber-200'
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span aria-hidden className={clean ? 'text-emerald-700' : 'text-amber-700'}>
          {clean ? '✓' : '!'}
        </span>
        <span className="font-medium tabular-nums">
          {audit.numbersTraced} of {audit.numbersCited} figures traced to measured findings
        </span>
        <button
          onClick={() => setOpen((o) => !o)}
          className="ml-auto text-xs underline underline-offset-4 opacity-80 hover:opacity-100"
        >
          {open ? 'Hide' : 'What does this mean?'}
        </button>
      </div>

      {!clean && audit.unaccounted.length > 0 && (
        <p className="mt-1.5 tabular-nums">
          Not traced: {audit.unaccounted.join(', ')}
        </p>
      )}
      {audit.contentLeak && (
        <p className="mt-1.5">
          The summary appears to treat differing text content as a defect. It is not — the design and the
          live page legitimately carry different copy.
        </p>
      )}

      {open && (
        <p className="mt-2 border-t border-current/15 pt-2 text-xs leading-relaxed opacity-90">
          The written summary is generated; every number in it is not. After the summary is written, each
          figure it cites is checked against the set of values that existed beforehand. This catches
          invented measurements, and is strongest for large or unusual values — a fabricated small integer
          can still collide with a real one by chance, so treat this as a guard against obvious
          fabrication rather than a proof of correctness.
        </p>
      )}
    </div>
  );
}
