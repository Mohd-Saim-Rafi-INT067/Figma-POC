import { downloadUrl } from '../api';
import type { RunResult } from '../types';

/**
 * The three ways out of the report.
 *
 * A download whose artifact does not exist is HIDDEN rather than shown
 * disabled: a run that failed before the report stage genuinely has no
 * report.md, and a greyed-out button with no explanation is worse than no
 * button. `result.files` carries the booleans, checked on disk by the server.
 */
export function DownloadBar({
  runId,
  files,
  rawOpen,
  onToggleRaw,
}: {
  runId: string;
  files: RunResult['files'];
  rawOpen: boolean;
  onToggleRaw: () => void;
}) {
  const button =
    'inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus:outline-none focus:ring-4 focus:ring-slate-100';

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      {files.markdown && (
        <a className={button} href={downloadUrl(runId, 'report.md')} download>
          <DocIcon />
          Download Markdown
        </a>
      )}

      {files.html && (
        <a className={button} href={downloadUrl(runId, 'report.html')} download>
          <DocIcon />
          Download HTML
        </a>
      )}

      {files.findings && (
        <button className={button} onClick={onToggleRaw} aria-expanded={rawOpen}>
          <TableIcon />
          {rawOpen ? 'Hide raw findings' : 'View raw findings'}
        </button>
      )}

      <p className="ml-auto text-xs text-slate-400">
        The HTML report is self-contained — it opens with no network connection.
      </p>
    </div>
  );
}

const DocIcon = () => (
  <svg className="h-4 w-4 text-slate-400" viewBox="0 0 16 16" fill="none" aria-hidden>
    <path
      d="M9 1.5H4.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5L9 1.5Z"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
    <path d="M9 1.5V5h3.5" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
  </svg>
);

const TableIcon = () => (
  <svg className="h-4 w-4 text-slate-400" viewBox="0 0 16 16" fill="none" aria-hidden>
    <rect x="2" y="3" width="12" height="10" rx="1" stroke="currentColor" strokeWidth="1.3" />
    <path d="M2 6.5h12M6.5 6.5V13" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);
