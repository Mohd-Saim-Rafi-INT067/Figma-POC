import type { RunRecord } from '../types';
import { ScoreCards } from './ScoreCards';
import { FixPriority } from './FixPriority';
import { KeyIssues } from './KeyIssues';
import { SectionNotes } from './SectionNotes';
import { Prose, ProseUnavailable } from './Prose';
import { ProseAuditBadge } from './ProseAuditBadge';

/**
 * The report.
 *
 * Structure and prose are two independent layers, and this component keeps
 * them that way. Every number comes from the computed analysis; the generated
 * narrative sits alongside as an overlay that may simply be absent. A report
 * with no model key is missing paragraphs, not content - which mirrors a
 * property the engine already guarantees rather than inventing one here.
 */

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-base font-semibold tracking-tight text-slate-900">{title}</h3>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

const Card = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">{children}</div>
);

export function ReportView({ record }: { record: RunRecord }) {
  const result = record.result;
  if (!result?.exec) return null;

  const { exec, prose } = result;
  const p = (name: string) => prose.sections?.[name];

  return (
    <div className="space-y-8">
      {/* --- header ------------------------------------------------------ */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">Design parity report</h2>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm md:grid-cols-3">
          {[
            ['Page', record.meta.pageUrl],
            ['Figma frame', record.meta.frameName ?? record.meta.figmaNodeId ?? '—'],
            ['Viewport', record.meta.viewportWidth ? `${record.meta.viewportWidth}px wide` : '—'],
            ['Tolerance profile', record.meta.toleranceProfile ?? '—'],
            [
              'Duration',
              record.meta.durationMs ? `${Math.round(record.meta.durationMs / 1000)}s` : '—',
            ],
            ['Generated', new Date(record.meta.startedAt).toLocaleString()],
          ].map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-slate-500">{k}</dt>
              <dd className="mt-0.5 truncate font-medium text-slate-800" title={String(v)}>
                {v}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 border-t border-slate-100 pt-3 text-sm text-slate-500">
          Sections are compared as whole units. Text is used only to align the design with the page — it is
          never itself reported as a defect, because a design and a live page legitimately carry different
          copy.
        </p>
      </div>

      {/* --- scores ------------------------------------------------------ */}
      <ScoreCards exec={exec} counts={result.counts} />

      {/* --- executive assessment ---------------------------------------- */}
      <Section
        title="Executive assessment"
        subtitle="Whether the structure holds, and where the problems concentrate."
      >
        <Card>
          {prose.ok && prose.audit && <ProseAuditBadge audit={prose.audit} />}
          {!prose.ok && <ProseUnavailable reason={prose.reason} />}

          <div className={prose.ok && prose.audit ? 'mt-4' : 'mt-0'}>
            <Prose markdown={p('Executive Assessment')} />
          </div>

          {/* Present with or without the narrative. */}
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-slate-100 pt-4 text-sm sm:grid-cols-4">
            {[
              ['Structure', exec.structuralIntact ? 'Intact' : 'Sections missing'],
              ['Sections matched', `${exec.matched} of ${exec.designSections}`],
              ['Extra on page', String(exec.extraInWeb)],
              ['Distinct issues', String(exec.totals.issues ?? result.issues.length)],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-slate-500">{k}</dt>
                <dd className="mt-0.5 font-medium tabular-nums text-slate-800">{v}</dd>
              </div>
            ))}
          </dl>

          {exec.dominantIssues.length > 0 && (
            <div className="mt-4 border-t border-slate-100 pt-4">
              <p className="text-sm text-slate-500">Where the problems concentrate</p>
              <ul className="mt-2 space-y-1.5 text-sm text-slate-700">
                {exec.dominantIssues.map((d, i) => (
                  <li key={i}>
                    <span className="font-medium">{d.title}</span>
                    <span className="text-slate-500">
                      {' '}
                      — {d.sections} section{d.sections === 1 ? '' : 's'}
                      {d.occurrences ? `, ${d.occurrences} occurrences` : ''}
                      {d.oneFix ? ' · single root cause' : d.systemic ? ' · spread across sections' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </Section>

      {/* --- fix priority ------------------------------------------------ */}
      <Section
        title="What to fix first"
        subtitle="Ranked by severity, how far it spreads, and how much one fix buys."
      >
        {p('What To Fix First') && (
          <Card>
            <Prose markdown={p('What To Fix First')} />
          </Card>
        )}
        <FixPriority order={result.fixOrder} />
      </Section>

      {/* --- key issues -------------------------------------------------- */}
      <Section title="Key issues" subtitle="Grouped by root cause — one job, not one finding per element.">
        {p('Key Issues') && (
          <Card>
            <Prose markdown={p('Key Issues')} />
          </Card>
        )}
        <KeyIssues issues={result.issues} />
      </Section>

      {/* --- section notes ----------------------------------------------- */}
      <Section title="Section notes" subtitle="How each matched section scored, and what is wrong in it.">
        {p('Section Notes') && (
          <Card>
            <Prose markdown={p('Section Notes')} />
          </Card>
        )}
        <SectionNotes sections={result.sectionScores} />
      </Section>

      {/* --- conclusion --------------------------------------------------- */}
      {/* Prose-only: hidden entirely when there is no narrative. */}
      {p('Conclusion') && (
        <Section title="Conclusion">
          <Card>
            <Prose markdown={p('Conclusion')} />
          </Card>
        </Section>
      )}

      {/* --- determinism -------------------------------------------------- */}
      {result.determinism && (
        <Section
          title="Extraction determinism"
          subtitle="The page was extracted twice and the two measurements compared."
        >
          <Card>
            <p className="text-sm text-slate-700">
              {result.determinism.identical
                ? 'Both extractions produced identical measurements.'
                : result.determinism.identicalOutsideUnstable
                  ? `Identical except for ${result.determinism.flaggedUnstableNodes as number} elements flagged as animated, which are excluded from comparison.`
                  : `${result.determinism.stableDiffs as number} elements differed between runs outside the animated set.`}
            </p>
          </Card>
        </Section>
      )}
    </div>
  );
}
