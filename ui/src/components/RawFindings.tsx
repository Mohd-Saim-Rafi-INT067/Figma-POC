import { useEffect, useMemo, useState } from 'react';
import { getFindings, downloadUrl } from '../api';
import type { Finding, FindingsFile, Severity } from '../types';
import { SEVERITY, SEVERITY_ORDER } from '../severity';

/**
 * A colour finding carries a hex value; show the actual swatch beside it.
 * Same six-line idea as report/html.js - a reader comparing #6B4ACC against
 * #835CF5 cannot do it from the text alone.
 */
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
    <span className="text-slate-300">—</span>
  ) : (
    <span className="font-mono text-[13px] text-slate-700">
      <Swatch value={v} />
      {String(v)}
    </span>
  );

/** Where a finding applies: one section pair, several sections, or the page. */
function where(f: Finding): string {
  if (!f.sections?.length) return 'page';
  if (f.sections.length === 1) {
    const s = f.sections[0];
    return `§${s.figmaIndex + 1}→§${s.webIndex + 1}`;
  }
  return `${f.sections.length} sections`;
}

function notes(f: Finding): string[] {
  const reasons = f.severityReasons ?? [];
  // The engine's severity reasons sometimes already state the occurrence count
  // as its justification ("35 occurrences"). Printing "×35 · 35 occurrences"
  // says the same thing twice, so the count yields to the reason that explains it.
  const countStated = reasons.some((r) => /occurrence/i.test(r));

  return [
    f.occurrenceCount && !countStated ? `×${f.occurrenceCount}` : null,
    f.ratio != null ? `ratio ${f.ratio}` : null,
    f.delta != null ? `Δ ${f.delta}` : null,
    ...reasons,
    f.lowConfidence ? 'dynamic content' : null,
  ].filter(Boolean) as string[];
}

const FilterChip = ({
  active,
  onClick,
  children,
  className = '',
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
}) => (
  <button
    onClick={onClick}
    aria-pressed={active}
    className={[
      'rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset transition',
      active ? className : 'bg-white text-slate-500 ring-slate-200 hover:bg-slate-50',
    ].join(' ')}
  >
    {children}
  </button>
);

export function RawFindings({ runId }: { runId: string }) {
  const [data, setData] = useState<FindingsFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [severities, setSeverities] = useState<Set<Severity>>(new Set());
  const [categories, setCategories] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    getFindings(runId)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(String(e.message)));
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const categoryList = useMemo(
    () => (data ? Object.keys(data.counts.byCategory).sort() : []),
    [data]
  );

  const rows = useMemo(() => {
    if (!data) return [];
    return data.findings
      .filter((f) => (severities.size === 0 ? true : severities.has(f.severity)))
      .filter((f) => (categories.size === 0 ? true : categories.has(f.category)))
      .sort((a, b) => SEVERITY[a.severity].rank - SEVERITY[b.severity].rank);
  }, [data, severities, categories]);

  const toggle = <T,>(set: Set<T>, value: T, apply: (s: Set<T>) => void) => {
    const next = new Set(set);
    next.has(value) ? next.delete(value) : next.add(value);
    apply(next);
  };

  if (error) {
    return (
      <div className="rounded-xl border border-rose-200 bg-white p-5 text-sm text-rose-800 shadow-sm">
        Could not load the findings: {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-500 shadow-sm">
        Loading findings…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* The provenance line: what makes these numbers reproducible. */}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-xl border border-slate-200 bg-white p-5 text-sm shadow-sm sm:grid-cols-4">
        {[
          ['Viewport', `${data.meta.viewportWidth}px`],
          ['Tolerance profile', data.meta.toleranceProfile],
          ['Generated', new Date(data.meta.generatedAt).toLocaleString()],
          ['Total findings', String(data.findings.length)],
        ].map(([k, v]) => (
          <div key={k}>
            <dt className="text-slate-500">{k}</dt>
            <dd className="mt-0.5 font-medium tabular-nums text-slate-800">{v}</dd>
          </div>
        ))}
      </dl>

      {/* Filters in one row above the table, with live counts. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        <span className="mr-1 text-xs font-medium uppercase tracking-wide text-slate-400">Severity</span>
        {SEVERITY_ORDER.map((sev) => {
          const token = SEVERITY[sev];
          const n = data.counts.bySeverity[sev] ?? 0;
          if (!n) return null;
          return (
            <FilterChip
              key={sev}
              active={severities.has(sev)}
              onClick={() => toggle(severities, sev, setSeverities)}
              className={token.chip}
            >
              <span className="inline-flex items-center gap-1.5">
                <span className={`h-1.5 w-1.5 rounded-full ${token.bar}`} aria-hidden />
                {token.label} <span className="tabular-nums opacity-70">{n}</span>
              </span>
            </FilterChip>
          );
        })}

        <span className="ml-3 mr-1 text-xs font-medium uppercase tracking-wide text-slate-400">
          Category
        </span>
        {categoryList.map((cat) => (
          <FilterChip
            key={cat}
            active={categories.has(cat)}
            onClick={() => toggle(categories, cat, setCategories)}
            className="bg-indigo-50 text-indigo-800 ring-indigo-200"
          >
            {cat} <span className="tabular-nums opacity-70">{data.counts.byCategory[cat]}</span>
          </FilterChip>
        ))}

        {(severities.size > 0 || categories.size > 0) && (
          <button
            onClick={() => {
              setSeverities(new Set());
              setCategories(new Set());
            }}
            className="ml-auto text-xs text-slate-500 underline underline-offset-4 hover:text-slate-800"
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
          <p className="text-sm tabular-nums text-slate-500">
            Showing {rows.length} of {data.findings.length} findings
          </p>
          <a
            href={downloadUrl(runId, 'findings.json')}
            className="text-sm text-indigo-700 underline-offset-4 hover:underline"
          >
            Download JSON
          </a>
        </div>

        {/* 97 rows on the reference run - client-side filtering, no pagination. */}
        <div className="max-h-[36rem] overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 z-10 bg-slate-50 text-xs uppercase tracking-wide text-slate-500 shadow-[0_1px_0_theme(colors.slate.200)]">
              <tr>
                <th className="px-4 py-2.5 font-medium">Severity</th>
                <th className="px-4 py-2.5 font-medium">Where</th>
                <th className="px-4 py-2.5 font-medium">Property</th>
                <th className="px-4 py-2.5 font-medium">In the design</th>
                <th className="px-4 py-2.5 font-medium">On the page</th>
                <th className="px-4 py-2.5 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((f) => {
                const token = SEVERITY[f.severity];
                return (
                  <tr key={f.id} className="align-top">
                    <td className="whitespace-nowrap px-4 py-2.5">
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${token.chip}`}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full ${token.bar}`} aria-hidden />
                        {token.label}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs text-slate-500">
                      {where(f)}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-600">{f.property}</td>
                    <td className="px-4 py-2.5"><Value v={f.expected} /></td>
                    <td className="px-4 py-2.5"><Value v={f.actual} /></td>
                    <td className="px-4 py-2.5 text-xs text-slate-500">{notes(f).join(' · ') || '—'}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-500">
                    No findings match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
