import { useState } from 'react';

/**
 * The visual QA report: section by section, highest priority first, with the
 * side-by-side evidence from E6 and a button that aggregates everything into a
 * page-level view.
 *
 * Every number rendered here was measured by E3-E6. Nothing on this screen is
 * computed in the browser.
 */

type Property = {
  label: string;
  design: string;
  website: string;
  delta: string | null;
  percent: number | null;
};

type Issue = {
  ref: string;
  kind: 'property' | 'structural';
  severity: 'critical' | 'high' | 'medium' | 'low';
  icon: string;
  title: string;
  impact: string;
  fix: string;
  affectedElements: number;
  matchConfidence?: number | null;
  properties: Property[];
  evidenceRel: string | null;
  locators?: { figmaUrl?: string | null; webSelector?: string | null };
};

type Section = {
  figmaIndex: number;
  webIndex: number;
  label: string;
  headline: string | null;
  issueCount: number;
  bySeverity: Record<string, number>;
  issues: Issue[];
};

type SystemicGroup = {
  ref: string;
  icon: string;
  label: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  design: string;
  website: string;
  affectedElements: number;
  scope: string;
  sharedFix: boolean;
  fix: string;
};

type Page = {
  summary: string;
  totals: {
    sections: number;
    issues: number;
    affectedElements: number;
    systemicGroups: number;
    sharedFixes: number;
    bySeverity: Record<string, number>;
  };
  fixFirst: Issue[];
  systemic: SystemicGroup[];
  sections: Array<{ section: string; headline: string | null; issues: number; critical: number; high: number; medium: number; low: number }>;
  confidence: { text: string };
};

export type QaData = { page: Page; sections: Section[] };

const SEV_CLASS: Record<string, string> = {
  critical: 'qa-critical', high: 'qa-high', medium: 'qa-medium', low: 'qa-low',
};

function IssueCard({ issue, runId }: { issue: Issue; runId: string }) {
  const img = issue.evidenceRel ? `/api/runs/${runId}/${issue.evidenceRel}` : null;

  return (
    <article className={`qa-issue ${SEV_CLASS[issue.severity] ?? 'qa-low'}`}>
      <header>
        <span className="qa-sev">{issue.icon} {issue.severity.toUpperCase()}</span>
        <h4>{issue.title}</h4>
        {issue.affectedElements > 1 && <span className="qa-badge">{issue.affectedElements} elements</span>}
        {issue.kind === 'structural' && <span className="qa-badge qa-structural">structural</span>}
        {issue.matchConfidence != null && (
          <span className="qa-conf" title="correspondence confidence">match {issue.matchConfidence}</span>
        )}
      </header>

      {issue.properties.length > 0 && (
        <table className="qa-values">
          <tbody>
            {issue.properties.map((p, i) => (
              <tr key={i}>
                <td className="qa-prop">{p.label}</td>
                <td className="qa-design">{p.design}</td>
                <td className="qa-arrow">→</td>
                <td className="qa-web">{p.website}</td>
                <td className="qa-delta">
                  {p.delta}{p.percent != null && <span className="qa-pct"> ({p.percent > 0 ? '+' : ''}{p.percent}%)</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {img && (
        <figure>
          <img src={img} alt="design on the left, website on the right" loading="lazy" />
          <figcaption>design ← → website</figcaption>
        </figure>
      )}

      <p className="qa-impact">{issue.impact}</p>
      <p className="qa-fix"><strong>Fix:</strong> {issue.fix}</p>

      <div className="qa-links">
        {issue.locators?.figmaUrl && (
          <a href={issue.locators.figmaUrl} target="_blank" rel="noopener noreferrer">Open in Figma</a>
        )}
        {issue.locators?.webSelector && <code>{issue.locators.webSelector}</code>}
      </div>
    </article>
  );
}

function SystemicCard({ group }: { group: SystemicGroup }) {
  return (
    <article className={`qa-issue ${SEV_CLASS[group.severity] ?? 'qa-low'}`}>
      <header>
        <span className="qa-sev">{group.icon} {group.label}</span>
        <span className="qa-badge">{group.affectedElements} elements</span>
        <span className="qa-scope">{group.scope}</span>
        {group.sharedFix && <span className="qa-badge qa-shared">shared fix</span>}
      </header>
      <p>Figma: <b>{group.design}</b> → Website: <b>{group.website}</b></p>
      <p className="qa-fix"><strong>Fix:</strong> {group.fix}</p>
    </article>
  );
}

export function QaReport({ data, runId }: { data: QaData; runId: string }) {
  const [open, setOpen] = useState<number | null>(data.sections[0]?.webIndex ?? null);
  const [page, setPage] = useState<Page | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function generateFullReport() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/runs/${runId}/full-report`, { method: 'POST' });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? 'Could not build the page report.');
      setPage(json.page);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const shown = page ?? data.page;

  return (
    <section className="qa">
      <div className="qa-head">
        <div>
          <h2>Visual QA — design parity</h2>
          <p className="qa-sub">{shown.summary}</p>
        </div>
        <button className="qa-btn" onClick={generateFullReport} disabled={busy}>
          {busy ? 'Aggregating…' : page ? 'Refresh full page report' : 'Generate full page report'}
        </button>
      </div>
      {error && <p className="qa-error">{error}</p>}

      <div className="qa-stats">
        {[
          ['issues', shown.totals.issues],
          ['elements affected', shown.totals.affectedElements],
          ['high / critical', (shown.totals.bySeverity.critical ?? 0) + (shown.totals.bySeverity.high ?? 0)],
          ['systemic groups', shown.totals.systemicGroups],
          ['shared fixes', shown.totals.sharedFixes],
          ['sections', shown.totals.sections],
        ].map(([label, value]) => (
          <div className="qa-stat" key={label as string}>
            <b>{value as number}</b><span>{label as string}</span>
          </div>
        ))}
      </div>

      {page && (
        <>
          <h3 className="qa-h3">Fix first</h3>
          {page.fixFirst.map((i) => <IssueCard key={i.ref} issue={i} runId={runId} />)}

          <h3 className="qa-h3">Systemic problems</h3>
          {page.systemic.length
            ? page.systemic.slice(0, 12).map((g) => <SystemicCard key={g.ref} group={g} />)
            : <p className="qa-note">None.</p>}
        </>
      )}

      <h3 className="qa-h3">Sections</h3>
      {data.sections.map((s) => {
        const isOpen = open === s.webIndex;
        return (
          <div className="qa-section" key={`${s.figmaIndex}:${s.webIndex}`}>
            <button className="qa-section-head" onClick={() => setOpen(isOpen ? null : s.webIndex)}>
              <span className="qa-caret">{isOpen ? '▾' : '▸'}</span>
              <span className="qa-section-name">{s.headline ?? s.label}</span>
              <span className="qa-section-meta">
                section {s.figmaIndex + 1}→{s.webIndex + 1} · {s.issueCount} issues
                {Object.entries(s.bySeverity).map(([k, v]) => ` · ${v} ${k}`).join('')}
              </span>
            </button>
            {isOpen && (
              <div className="qa-section-body">
                {s.issues.map((i) => <IssueCard key={i.ref} issue={i} runId={runId} />)}
              </div>
            )}
          </div>
        );
      })}

      <div className="qa-limits">
        <b>Confidence &amp; limitations</b>
        {shown.confidence.text}
      </div>
    </section>
  );
}
