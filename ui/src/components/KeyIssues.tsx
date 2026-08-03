import { useState } from 'react';
import type { Issue } from '../types';
import { SEVERITY } from '../severity';

/** Colour findings carry a hex; show the actual swatch beside the value. */
function Swatch({ value }: { value: unknown }) {
  const m = /^#([0-9A-Fa-f]{6})/.exec(String(value ?? ''));
  if (!m) return null;
  return (
    <span
      className="mr-1.5 inline-block h-3 w-3 shrink-0 rounded-sm align-[-1px] ring-1 ring-inset ring-black/15"
      style={{ background: `#${m[1]}` }}
      aria-hidden
    />
  );
}

const Value = ({ v }: { v: unknown }) =>
  v === null || v === undefined || v === '' ? (
    <span className="text-slate-400">—</span>
  ) : (
    <span className="font-mono text-[13px]">
      <Swatch value={v} />
      {String(v)}
    </span>
  );

function IssueCard({ issue }: { issue: Issue }) {
  const [open, setOpen] = useState(false);
  const token = SEVERITY[issue.severity] ?? SEVERITY.low;
  const k = issue.knowledge;

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="p-5">
        <div className="flex flex-wrap items-start gap-2">
          <h4 className="flex-1 font-medium text-slate-900">{k.title}</h4>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${token.chip}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${token.bar}`} aria-hidden />
            {token.label}
          </span>
        </div>

        <p className="mt-1 text-xs tabular-nums text-slate-400">
          {issue.occurrences > 0 && <>{issue.occurrences} occurrences · </>}
          {issue.sections.length} section{issue.sections.length === 1 ? '' : 's'} ·{' '}
          <span className="font-mono">{issue.property}</span>
        </p>

        {/* Expected vs found, from the supplied values. */}
        {issue.examples.length > 0 && (
          <div className="mt-3 overflow-hidden rounded-lg border border-slate-200">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">In the design</th>
                  <th className="px-3 py-2 font-medium">On the page</th>
                  <th className="px-3 py-2 font-medium">Difference</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {issue.examples.map((ex, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2"><Value v={ex.expected} /></td>
                    <td className="px-3 py-2"><Value v={ex.actual} /></td>
                    <td className="px-3 py-2 tabular-nums text-slate-500">
                      {ex.delta !== null ? `Δ ${ex.delta}` : ex.ratio !== null ? `ratio ${ex.ratio}` : '—'}
                      {ex.occurrenceCount ? <span className="text-slate-400"> · ×{ex.occurrenceCount}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {k.why && <p className="mt-3 text-sm text-slate-600">{k.why}</p>}

        <button
          onClick={() => setOpen((o) => !o)}
          className="mt-3 text-sm text-indigo-700 underline-offset-4 hover:underline"
        >
          {open ? 'Hide' : 'Show'} likely cause and impact
        </button>

        {open && (
          <dl className="mt-3 space-y-3 border-t border-slate-100 pt-3 text-sm">
            {k.causes?.length ? (
              <div>
                <dt className="font-medium text-slate-700">Likely cause</dt>
                <dd className="mt-1 text-slate-600">
                  <ul className="list-disc space-y-1 pl-5">
                    {k.causes.map((c, i) => <li key={i}>{c}</li>)}
                  </ul>
                  {k.investigate && <p className="mt-2 text-slate-500">Check first: {k.investigate}</p>}
                </dd>
              </div>
            ) : null}
            {k.impact?.length ? (
              <div>
                <dt className="font-medium text-slate-700">Impact</dt>
                <dd className="mt-1 text-slate-600">{k.impact.join(' · ')}</dd>
              </div>
            ) : null}
            {k.intent && (
              <div>
                <dt className="font-medium text-slate-700">Deliberate or accidental</dt>
                <dd className="mt-1 text-slate-600">{k.intent}</dd>
              </div>
            )}
          </dl>
        )}
      </div>
    </div>
  );
}

export function KeyIssues({ issues }: { issues: Issue[] }) {
  const [showAll, setShowAll] = useState(false);
  if (!issues.length) return null;

  // The issues arrive already weighted; the top handful is the story.
  const shown = showAll ? issues : issues.slice(0, 6);

  return (
    <div className="space-y-3">
      {shown.map((issue) => (
        <IssueCard key={issue.property} issue={issue} />
      ))}
      {issues.length > 6 && (
        <button
          onClick={() => setShowAll((s) => !s)}
          className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
        >
          {showAll ? 'Show top 6 only' : `Show all ${issues.length} issues`}
        </button>
      )}
    </div>
  );
}
