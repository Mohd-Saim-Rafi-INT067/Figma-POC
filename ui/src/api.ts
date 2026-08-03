/**
 * The only module that knows about HTTP. Everything else takes typed values.
 */

import type { ApiError, FindingsFile, Health, RunEvent, RunRecord } from './types';

export class RequestFailed extends Error {
  field?: string;
  hint: string | null;
  status: number;
  activeRunId?: string;

  constructor(status: number, body: ApiError) {
    super(body.error ?? `Request failed (${status})`);
    this.name = 'RequestFailed';
    this.status = status;
    this.hint = body.hint ?? null;
    this.field = body.field;
    this.activeRunId = body.activeRunId;
  }
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    throw new RequestFailed(res.status, (body as ApiError) ?? { error: text || res.statusText, hint: null });
  }
  return body as T;
}

export interface AuditRequest {
  figmaFrameUrl: string;
  pageUrl: string;
  determinism: boolean;
}

export async function startAudit(req: AuditRequest): Promise<{ runId: string }> {
  const res = await fetch('/api/audit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
  });
  return parse<{ runId: string }>(res);
}

export async function getRun(id: string): Promise<RunRecord> {
  return parse<RunRecord>(await fetch(`/api/runs/${encodeURIComponent(id)}`));
}

export async function getHealth(): Promise<Health> {
  return parse<Health>(await fetch('/api/health'));
}

export const downloadUrl = (id: string, file: 'report.md' | 'report.html' | 'findings.json') =>
  `/api/runs/${encodeURIComponent(id)}/${file}`;

/**
 * The raw findings, for the in-app table.
 *
 * Same URL the download button uses. The Content-Disposition header only
 * affects navigation, not fetch, so one endpoint serves both - a second
 * "inline" route would be two things to keep in step for no gain.
 *
 * Fetched on demand: it is ~77 kB on the reference run and most viewers never
 * open the table.
 */
export async function getFindings(id: string): Promise<FindingsFile> {
  return parse<FindingsFile>(await fetch(downloadUrl(id, 'findings.json')));
}

/**
 * Subscribe to a run's progress.
 *
 * The server replays every event so far before streaming live ones, so this is
 * safe to open at any point in a run - including after a reload.
 *
 * EventSource retries on its own, which is wrong here: the server closes the
 * stream deliberately on run:done, and an automatic reconnect would replay the
 * whole run and re-fire the completion handler. So we close it ourselves.
 */
export function openEvents(
  id: string,
  handlers: { onEvent: (e: RunEvent) => void; onError?: () => void }
): () => void {
  const source = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
  let done = false;

  source.onmessage = (msg) => {
    let event: RunEvent;
    try {
      event = JSON.parse(msg.data) as RunEvent;
    } catch {
      return;
    }
    if (event.type === 'run:done') {
      done = true;
      source.close();
    }
    handlers.onEvent(event);
  };

  source.onerror = () => {
    // A close after run:done arrives here too - not an error.
    if (done) return;
    source.close();
    handlers.onError?.();
  };

  return () => {
    done = true;
    source.close();
  };
}
