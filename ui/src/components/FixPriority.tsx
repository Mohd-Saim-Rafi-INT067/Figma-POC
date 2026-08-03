import type { FixOrderEntry } from '../types';
import { SEVERITY } from '../severity';

/**
 * The ranked fix order, rendered IN THE ORDER GIVEN.
 *
 * The ranking is computed server-side (analysis.js fixOrder) and weighs
 * severity, blast radius and effort together - and the written summary cites
 * those rank numbers directly. Re-sorting here would put the list and the
 * narrative into open disagreement, so the rank is shown rather than implied.
 */
export function FixPriority({ order }: { order: FixOrderEntry[] }) {
  if (!order.length) return null;

  return (
    <ol className="space-y-3">
      {order.map((step) => {
        const token = SEVERITY[step.severity] ?? SEVERITY.low;
        return (
          <li
            key={step.rank}
            className="flex gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold tabular-nums text-slate-600">
              {step.rank}
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h4 className="font-medium text-slate-900">{step.label}</h4>
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${token.chip}`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${token.bar}`} aria-hidden />
                  {token.label}
                </span>
                {/*
                  "One fix" and "systemic" are deliberately different claims -
                  analysis.js keeps them apart because conflating them made
                  every category read "fix centrally". Rendered as words; the
                  reader is not looking at the JSON.
                */}
                {step.oneFix && (
                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-inset ring-emerald-200">
                    Single root cause
                  </span>
                )}
                {!step.oneFix && step.systemic && (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 ring-1 ring-inset ring-slate-200">
                    Spread across sections
                  </span>
                )}
              </div>

              <p className="mt-1.5 text-sm text-slate-600">{step.rationale}</p>

              <p className="mt-1.5 text-xs tabular-nums text-slate-400">
                {step.issueCount} issue{step.issueCount === 1 ? '' : 's'} · {step.sectionCount} section
                {step.sectionCount === 1 ? '' : 's'} affected
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
