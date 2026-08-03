import type { ExecFacts, Severity } from '../types';
import { bandFor, confidenceBand, SEVERITY, SEVERITY_ORDER } from '../severity';

/**
 * A single ratio against a limit is a meter, not a chart - one track, one
 * fill, the number stated in full beside it. Both readings here (health out of
 * 100, confidence as a percentage) are exactly that shape.
 */
function Meter({ value, bar, label }: { value: number; bar: string; label: string }) {
  return (
    <div
      className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-100"
      role="img"
      aria-label={label}
    >
      <div className={`h-full rounded-full ${bar}`} style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
    </div>
  );
}

const Card = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">{children}</div>
);

export function ScoreCards({
  exec,
  counts,
}: {
  exec: ExecFacts;
  counts: { bySeverity: Record<string, number> } | null;
}) {
  const band = bandFor(exec.overallStatus);
  const conf = confidenceBand(exec.confidence.verdict);
  const totalFindings = SEVERITY_ORDER.reduce((n, s) => n + (counts?.bySeverity[s] ?? 0), 0);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <p className="text-sm font-medium text-slate-500">Overall health score</p>
        {/* Hero figure: the one number the report leads with. */}
        <p className="mt-1 flex items-baseline gap-2">
          <span className={`text-5xl font-semibold tabular-nums tracking-tight ${band.text}`}>
            {exec.overallScore}
          </span>
          <span className="text-lg text-slate-400">/ 100</span>
          <span className={`ml-auto rounded-full px-2.5 py-1 text-sm font-medium ring-1 ring-inset ${band.ring} ${band.text}`}>
            {exec.overallStatus}
          </span>
        </p>
        <Meter value={exec.overallScore} bar={band.bar} label={`Health score ${exec.overallScore} of 100`} />
        <p className="mt-3 text-sm text-slate-500">
          Mean of the per-section scores. Higher is closer to the design.
        </p>
      </Card>

      <Card>
        <p className="text-sm font-medium text-slate-500">Match confidence</p>
        <p className="mt-1 flex items-baseline gap-2">
          <span className={`text-5xl font-semibold tabular-nums tracking-tight ${conf.text}`}>
            {exec.confidence.percent}
          </span>
          <span className="text-lg text-slate-400">%</span>
          <span className={`ml-auto rounded-full px-2.5 py-1 text-sm font-medium ring-1 ring-inset ${conf.ring} ${conf.text}`}>
            {exec.confidence.verdict}
          </span>
        </p>
        <Meter
          value={exec.confidence.percent}
          bar={conf.bar}
          label={`Match confidence ${exec.confidence.percent} percent`}
        />
        {/*
          The notes are the part that answers a manager's actual question -
          "every design section was found on the page" says more than 83% does.
        */}
        <ul className="mt-3 space-y-1 text-sm text-slate-500">
          {exec.confidence.notes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      </Card>

      <div className="md:col-span-2">
        <Card>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-medium text-slate-500">
              Findings by severity
              <span className="ml-2 text-slate-400">
                {totalFindings} total across {exec.designSections} design sections
              </span>
            </p>
            <p className="text-sm text-slate-500">
              {exec.structuralIntact ? (
                <span className="text-emerald-800">Structure intact — every design section was found</span>
              ) : (
                <span className="text-orange-800">
                  {exec.missingInWeb} design section{exec.missingInWeb === 1 ? '' : 's'} not found on the page
                </span>
              )}
            </p>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {SEVERITY_ORDER.map((sev) => {
              const token = SEVERITY[sev as Severity];
              const n = counts?.bySeverity[sev] ?? 0;
              return (
                <div key={sev} className={`rounded-lg px-3.5 py-3 ring-1 ring-inset ${token.chip}`}>
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${token.bar}`} aria-hidden />
                    {token.label}
                  </span>
                  <span className="mt-0.5 block text-2xl font-semibold tabular-nums">{n}</span>
                </div>
              );
            })}
          </div>

          <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-slate-100 pt-4 text-sm sm:grid-cols-4">
            {[
              ['Design sections', String(exec.designSections)],
              ['Found on page', `${exec.matched} matched`],
              ['Extra on page', String(exec.extraInWeb)],
              ['Design → page height', `${exec.designHeight} → ${exec.pageHeight}px`],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-slate-500">{k}</dt>
                <dd className="mt-0.5 font-medium tabular-nums text-slate-800">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>
    </div>
  );
}
