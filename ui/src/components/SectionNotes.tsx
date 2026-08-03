import type { SectionScore } from '../types';
import { bandFor, SEVERITY, SEVERITY_ORDER } from '../severity';

/**
 * Eighteen sections, each with a score - past the point where colour can carry
 * identity, so this is a table with a per-row meter. Length carries magnitude,
 * the band colour carries state, and both the number and the status word are
 * written out.
 */
export function SectionNotes({ sections }: { sections: SectionScore[] }) {
  if (!sections.length) return null;

  const ordered = [...sections].sort((a, b) => a.webIndex - b.webIndex);

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">Section</th>
              <th className="px-4 py-2.5 font-medium">Score</th>
              <th className="px-4 py-2.5 font-medium">Findings</th>
              <th className="px-4 py-2.5 font-medium">Height design → page</th>
              <th className="px-4 py-2.5 font-medium">Problems</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {ordered.map((s) => {
              const band = bandFor(s.status);
              return (
                <tr key={`${s.figmaIndex}-${s.webIndex}`} className="align-top">
                  <td className="px-4 py-3">
                    <span className="block font-medium text-slate-800">{s.label}</span>
                    <span className="mt-0.5 block text-xs tabular-nums text-slate-400">
                      §{s.figmaIndex + 1} → §{s.webIndex + 1} · match {Math.round(s.confidence * 100)}%
                    </span>
                  </td>

                  <td className="px-4 py-3 w-40">
                    <span className="flex items-baseline gap-1.5">
                      <span className={`text-base font-semibold tabular-nums ${band.text}`}>{s.score}</span>
                      <span className={`text-xs ${band.text}`}>{s.status}</span>
                    </span>
                    <span
                      className="mt-1.5 block h-1.5 w-full overflow-hidden rounded-full bg-slate-100"
                      role="img"
                      aria-label={`Score ${s.score} of 100, ${s.status}`}
                    >
                      <span
                        className={`block h-full rounded-full ${band.bar}`}
                        style={{ width: `${Math.max(2, s.score)}%` }}
                      />
                    </span>
                  </td>

                  <td className="px-4 py-3">
                    <span className="flex flex-wrap gap-1">
                      {SEVERITY_ORDER.filter((sev) => s.bySeverity[sev]).map((sev) => {
                        const token = SEVERITY[sev];
                        return (
                          <span
                            key={sev}
                            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium tabular-nums ring-1 ring-inset ${token.chip}`}
                            title={token.label}
                          >
                            <span className={`h-1.5 w-1.5 rounded-full ${token.bar}`} aria-hidden />
                            {token.label} {s.bySeverity[sev]}
                          </span>
                        );
                      })}
                      {!SEVERITY_ORDER.some((sev) => s.bySeverity[sev]) && (
                        <span className="text-xs text-slate-400">none</span>
                      )}
                    </span>
                  </td>

                  <td className="px-4 py-3 tabular-nums text-slate-600">
                    {s.designHeight} → {s.pageHeight}px
                    <span
                      className={`mt-0.5 block text-xs ${
                        s.heightRatio > 1.15 || s.heightRatio < 0.85 ? 'text-orange-800' : 'text-slate-400'
                      }`}
                    >
                      ×{s.heightRatio}
                    </span>
                  </td>

                  <td className="px-4 py-3 text-slate-600">
                    {s.problems.length ? (
                      <ul className="space-y-0.5">
                        {s.problems.slice(0, 3).map((p, i) => (
                          <li key={i} className="text-xs">{p}</li>
                        ))}
                        {s.problems.length > 3 && (
                          <li className="text-xs text-slate-400">+{s.problems.length - 3} more</li>
                        )}
                      </ul>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
