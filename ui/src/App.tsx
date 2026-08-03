import { useCallback, useEffect, useRef, useState } from 'react';
import { AuditForm, type FormValues } from './components/AuditForm';
import { ProgressPanel } from './components/ProgressPanel';
import { ReportView } from './components/ReportView';
import { ErrorPanel } from './components/ErrorPanel';
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

    /*
      ?run=<id> opens a completed run directly.
      A live audit depends on Figma's API, the network, the site and a model
      endpoint; three of those have failed at least once during development. A
      previously completed run is the fallback that makes the demo safe, and it
      costs one URL parameter because runs.js already rehydrates from disk.
    */
    const wanted = new URLSearchParams(window.location.search).get('run');
    if (wanted) {
      getRun(wanted)
        .then((r) => {
          setRecord(r);
          setStages(r.stages);
          setPhase(r.status === 'failed' ? 'failed' : 'done');
        })
        .catch((err) => {
          setServerError({ message: `Could not open run ${wanted}: ${err.message}`, hint: null });
        });
    }

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

      <main
        className={`mx-auto space-y-6 px-6 py-8 ${
          phase === 'done' ? 'max-w-5xl' : 'max-w-3xl'
        }`}
      >
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

function RunSummary({ record, onReset }: { record: RunRecord; onReset: () => void }) {
  return (
    <div className="space-y-6">
      {record.warnings.map((w, i) => (
        <div key={i} className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {w.message}
        </div>
      ))}

      {record.status === 'failed' && <ErrorPanel record={record} />}

      {record.status === 'done' && <ReportView record={record} />}

      <button
        onClick={onReset}
        className="rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50"
      >
        Run another audit
      </button>
    </div>
  );
}
