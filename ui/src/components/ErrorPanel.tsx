import { downloadUrl } from '../api';
import type { RunRecord } from '../types';

/**
 * What a failed run shows.
 *
 * Two things this gets right that a bare error page does not:
 *
 * 1. It names WHICH stage failed, in the reader's vocabulary. "Failed" is
 *    useless; "failed while extracting the website" tells a developer where to
 *    look and tells everyone else that the design side was fine.
 * 2. It offers whatever the run did produce. A run that dies at the report
 *    stage still wrote its findings, and handing those over beats throwing the
 *    work away because the last step failed.
 */

/** Engine stage ids in the demo's vocabulary — same map the progress panel uses. */
const STAGE_LABEL: Record<string, string> = {
  M2: 'extracting the Figma design',
  M4: 'normalizing the design',
  M1: 'extracting the website',
  M3: 'normalizing the website',
  DET: 'the determinism check',
  P5: 'pruning',
  P6: 'deriving spacing',
  S1: 'detecting sections',
  S2: 'matching sections',
  S3: 'comparing sections',
  S4: 'assembling findings',
  S5: 'generating the report',
};

/**
 * Turn the engine's message into something a reader can act on.
 *
 * Only for causes we can identify with confidence — everything else falls
 * through to the raw message, which is better than a confidently wrong guess.
 */
function guidanceFor(record: RunRecord): { what: string; next: string } | null {
  const msg = record.error?.message ?? '';
  const stage = record.error?.stage;

  if (/\b429\b|rate limit/i.test(msg)) {
    return {
      what: 'Figma is rate-limiting this account.',
      next:
        'Rate limits are per user and per plan, so a different token on the same account will not help. ' +
        'Either wait for the window to reset, or run against a frame already in the cache.',
    };
  }
  if (/is a \w+, not a FRAME/i.test(msg)) {
    return {
      what: 'That link points at something other than a frame.',
      next:
        'The comparison unit is a frame. In Figma, select the frame itself — not a group or a component ' +
        'inside it — then right-click → Copy link to selection.',
    };
  }
  if (stage === 'M1' && /timeout|ERR_|net::|navigat/i.test(msg)) {
    return {
      what: 'The page could not be loaded.',
      next: 'Check the URL opens in a browser, and that it is reachable from this machine.',
    };
  }
  if (/FIGMA_TOKEN/i.test(msg)) {
    return {
      what: 'The server has no Figma token.',
      next: 'Set FIGMA_TOKEN in .env and restart the server.',
    };
  }
  return null;
}

export function ErrorPanel({ record }: { record: RunRecord }) {
  const error = record.error;
  if (!error) return null;

  const where = error.stage ? STAGE_LABEL[error.stage] ?? error.stageLabel ?? error.stage : null;
  const guidance = guidanceFor(record);
  const artifacts = record.artifacts ?? record.result?.files ?? null;
  const hasAny = artifacts && (artifacts.findings || artifacts.markdown || artifacts.html);

  const completed = record.stages.filter((s) => s.status === 'ok');

  return (
    <div className="rounded-xl border border-rose-200 bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-rose-900">
        {where ? `The audit stopped while ${where}` : 'The audit could not start'}
      </h2>

      {guidance ? (
        <>
          <p className="mt-2 text-slate-800">{guidance.what}</p>
          <p className="mt-1.5 text-sm text-slate-600">{guidance.next}</p>
        </>
      ) : (
        <p className="mt-2 text-slate-800">{error.message}</p>
      )}

      {guidance && (
        <details className="mt-3">
          <summary className="cursor-pointer text-sm text-slate-500 hover:text-slate-800">
            Technical detail
          </summary>
          <p className="mt-1.5 font-mono text-xs text-slate-600">
            {error.name}: {error.message}
          </p>
          {error.hint && <p className="mt-1 text-xs text-slate-500">{error.hint}</p>}
        </details>
      )}
      {!guidance && error.hint && <p className="mt-2 text-sm text-slate-500">{error.hint}</p>}

      {completed.length > 0 && (
        <p className="mt-4 border-t border-slate-100 pt-3 text-sm text-slate-500">
          {completed.length} stage{completed.length === 1 ? '' : 's'} completed before this
          {where ? ' — everything up to that point ran clean.' : '.'}
        </p>
      )}

      {hasAny && (
        <div className="mt-4 border-t border-slate-100 pt-4">
          <p className="text-sm text-slate-600">
            The run still produced these before it stopped:
          </p>
          <div className="mt-2 flex flex-wrap gap-2.5">
            {artifacts!.findings && (
              <a
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                href={downloadUrl(record.id, 'findings.json')}
                download
              >
                Findings JSON
              </a>
            )}
            {artifacts!.markdown && (
              <a
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                href={downloadUrl(record.id, 'report.md')}
                download
              >
                Report Markdown
              </a>
            )}
            {artifacts!.html && (
              <a
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                href={downloadUrl(record.id, 'report.html')}
                download
              >
                Report HTML
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
