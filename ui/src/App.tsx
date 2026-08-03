import { useCallback, useEffect, useRef, useState } from 'react';
import { AuditForm, type FormValues } from './components/AuditForm';
import { ProgressPanel } from './components/ProgressPanel';
import { getHealth, getRun, openEvents, startAudit, RequestFailed } from './api';
import type { Health, RunEvent, RunRecord, StageRecord } from './types';

type Phase = 'idle' | 'starting' | 'running' | 'done' | 'failed';

interface ServerError {
  field?: string;
  message: string;
  hint: string | null;
}

export default function App() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [health, setHealth] = useState<Health | null>(null);
  const [stages, setStages] = useState<StageRecord[]>([]);
  const [record, setRecord] = useState<RunRecord | null>(null);
  const [serverError, setServerError] = useState<ServerError | null>(null);
  const [retryNotice, setRetryNotice] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number>(Date.now());
  const closeStream = useRef<(() => void) | null>(null);

  useEffect(() => {
    getHealth().then(setHealth).catch(() => setHealth(null));
    return () => closeStream.current?.();
  }, []);

  /** Progress arrives over SSE; the report itself is fetched once at the end. */
  const handleEvent = useCallback((event: RunEvent, runId: string) => {
    switch (event.type) {
      case 'run:start':
        // Also the retry path: a second run:start resets the checklist, which
        // is exactly right - the pipeline genuinely started over.
        setStages(
          event.stages.map((s) => ({
            id: s.id,
            label: s.label,
            status: 'pending',
            ms: null,
            info: null,
            message: null,
          }))
        );
        break;

      case 'run:restored':
        setStages(event.stages);
        break;

      case 'stage:start':
        setStages((prev) => prev.map((s) => (s.id === event.id ? { ...s, status: 'running' } : s)));
        break;

      case 'stage:ok':
        setStages((prev) =>
          prev.map((s) => (s.id === event.id ? { ...s, status: 'ok', ms: event.ms, info: event.info } : s))
        );
        break;

      case 'stage:fail':
        setStages((prev) =>
          prev.map((s) =>
            s.id === event.id ? { ...s, status: 'failed', ms: event.ms, message: event.error.message } : s
          )
        );
        break;

      case 'run:retry':
        setRetryNotice(
          'Figma is rate-limiting this account, so the current design could not be fetched. ' +
            'Retrying against the last cached version of the frame.'
        );
        break;

      case 'run:done':
        getRun(runId)
          .then((r) => {
            setRecord(r);
            setStages(r.stages);
            setPhase(r.status === 'done' ? 'done' : 'failed');
          })
          .catch((err) => {
            setServerError({ message: String(err.message), hint: null });
            setPhase('failed');
          });
        break;

      default:
        break;
    }
  }, []);

  const submit = async (values: FormValues) => {
    setServerError(null);
    setRetryNotice(null);
    setRecord(null);
    setStages([]);
    setPhase('starting');

    try {
      const { runId } = await startAudit(values);
      setStartedAt(Date.now());
      setPhase('running');
      closeStream.current?.();
      closeStream.current = openEvents(runId, {
        onEvent: (e) => handleEvent(e, runId),
        onError: () => {
          // The stream dropped; the run itself may well be fine. Fall back to
          // reading the record rather than declaring failure.
          getRun(runId)
            .then((r) => {
              setRecord(r);
              setStages(r.stages);
              if (r.status === 'done' || r.status === 'failed') setPhase(r.status);
            })
            .catch(() => {
              setServerError({ message: 'Lost contact with the server.', hint: null });
              setPhase('failed');
            });
        },
      });
    } catch (err) {
      if (err instanceof RequestFailed) {
        setServerError({ field: err.field, message: err.message, hint: err.hint });
      } else {
        setServerError({ message: String((err as Error).message), hint: null });
      }
      setPhase('idle');
    }
  };

  const busy = phase === 'starting' || phase === 'running';

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-3xl px-6 py-5">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">Design Parity Audit</h1>
          <p className="mt-1 text-sm text-slate-500">
            Compares a Figma frame against the implemented page — every value measured, never inferred
            from a screenshot.
          </p>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-6 px-6 py-8">
        {phase === 'idle' || phase === 'starting' ? (
          <AuditForm onSubmit={submit} disabled={busy} health={health} serverError={serverError} />
        ) : null}

        {(phase === 'running' || phase === 'starting') && stages.length > 0 && (
          <ProgressPanel stages={stages} startedAt={startedAt} retryNotice={retryNotice} />
        )}

        {phase === 'running' && stages.length === 0 && (
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm">
            Starting…
          </div>
        )}

        {(phase === 'done' || phase === 'failed') && record && (
          <RunSummary record={record} onReset={() => { setPhase('idle'); setRecord(null); setStages([]); }} />
        )}
      </main>
    </div>
  );
}

/**
 * Placeholder completion state for Phase 3.
 *
 * Phase 3's gate is "live stage ticks against a real run", so this shows just
 * enough to prove the run completed and the record arrived. ReportView (Phase
 * 4) replaces it.
 */
function RunSummary({ record, onReset }: { record: RunRecord; onReset: () => void }) {
  const exec = record.result?.exec;
  return (
    <div className="space-y-4">
      {record.warnings.map((w, i) => (
        <div key={i} className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <span className="font-medium">{w.stage}</span> — {w.message}
        </div>
      ))}

      {record.status === 'failed' && record.error && (
        <div className="rounded-xl border border-rose-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-rose-900">
            Audit failed{record.error.stage ? ` at ${record.error.stage}` : ''}
          </h2>
          {record.error.stageLabel && <p className="mt-1 text-sm text-slate-500">{record.error.stageLabel}</p>}
          <p className="mt-3 text-sm text-slate-800">{record.error.message}</p>
          {record.error.hint && <p className="mt-2 text-sm text-slate-500">{record.error.hint}</p>}
        </div>
      )}

      {record.status === 'done' && exec && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Audit complete</h2>
          <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
            {[
              ['Health score', `${exec.overallScore} · ${exec.overallStatus}`],
              ['Match confidence', `${exec.confidence.percent}% · ${exec.confidence.verdict}`],
              ['Sections matched', `${exec.matched} of ${exec.designSections}`],
              ['Duration', record.meta.durationMs ? `${Math.round(record.meta.durationMs / 1000)}s` : '—'],
            ].map(([k, v]) => (
              <div key={k}>
                <dt className="text-slate-500">{k}</dt>
                <dd className="mt-0.5 font-medium text-slate-900">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-5 rounded-lg bg-slate-50 p-3 text-sm text-slate-500">
            The full report view arrives in Phase 4.
          </p>
        </div>
      )}

      <button
        onClick={onReset}
        className="rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
      >
        Run another audit
      </button>
    </div>
  );
}
