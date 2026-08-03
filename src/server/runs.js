/**
 * Run registry.
 *
 * Holds every run in memory and mirrors each status transition to
 * out/runs/<id>/run.json, so a server restart mid-demo does not lose a
 * completed report.
 *
 * This is the module that becomes a Supabase table when the demo ports into
 * Evertest, which is why the record is deliberately flat and JSON-serialisable
 * - no class instances, no Maps inside the record, nothing that needs a custom
 * serializer. See docs/demo-ui-implementation-plan.md §5.2 and §13.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RUNS_DIR = resolve(ROOT, 'out', 'runs');

/** In-memory registry. Key: run id. */
const runs = new Map();

/**
 * Per-run event log plus live listeners.
 *
 * The log is what makes SSE reconnection work: a client that connects after
 * the run started - or reconnects after a dropped connection - is replayed
 * every event so far before it starts receiving live ones. Without it, a
 * late-connecting client shows an empty progress list for a 90-second stage
 * and looks hung.
 */
const streams = new Map(); // id -> { events: [], listeners: Set<fn> }

/**
 * Sortable, URL-safe, collision-resistant enough for a single-user demo.
 * Sorting by id sorts by time, which makes `out/runs/` readable.
 */
function makeId() {
  const t = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const r = Math.random().toString(36).slice(2, 6);
  return `${t}-${r}`;
}

export function runDir(id) {
  return join(RUNS_DIR, id);
}

function persist(record) {
  try {
    mkdirSync(runDir(record.id), { recursive: true });
    writeFileSync(join(runDir(record.id), 'run.json'), JSON.stringify(record, null, 2));
  } catch (err) {
    // Persistence is a convenience, not the source of truth. A full disk must
    // not kill a run whose report is already in memory.
    console.warn(`  [runs] could not persist ${record.id}: ${err.message}`);
  }
}

export function create({ figmaFrameUrl, pageUrl, determinism = false, noCache = true }) {
  const id = makeId();
  const record = {
    id,
    status: 'queued',
    input: { figmaFrameUrl, pageUrl, determinism, noCache },
    meta: {
      pageUrl,
      figmaFileKey: null,
      figmaNodeId: null,
      viewportWidth: null,
      toleranceProfile: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
      figmaCacheStale: false,
    },
    stages: [],
    warnings: [],
    error: null,
    result: null,
  };
  runs.set(id, record);
  streams.set(id, { events: [], listeners: new Set() });
  mkdirSync(runDir(id), { recursive: true });
  persist(record);
  return record;
}

export function get(id) {
  const inMemory = runs.get(id);
  if (inMemory) return inMemory;

  // Cold start, or a run from a previous server process.
  const path = join(runDir(id), 'run.json');
  if (!existsSync(path)) return null;
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    runs.set(id, record);
    return record;
  } catch {
    return null;
  }
}

export function update(id, patch) {
  const record = runs.get(id);
  if (!record) return null;
  Object.assign(record, patch);
  persist(record);
  return record;
}

/** Merge into record.meta without clobbering the rest of it. */
export function patchMeta(id, patch) {
  const record = runs.get(id);
  if (!record) return null;
  Object.assign(record.meta, patch);
  persist(record);
  return record;
}

/** The one run currently queued or running, if any. */
export function activeRun() {
  for (const record of runs.values()) {
    if (record.status === 'queued' || record.status === 'running') return record;
  }
  return null;
}

export function list({ limit = 25 } = {}) {
  return [...runs.values()]
    .sort((a, b) => (a.id < b.id ? 1 : -1))
    .slice(0, limit)
    .map((r) => ({
      id: r.id,
      status: r.status,
      pageUrl: r.meta.pageUrl,
      startedAt: r.meta.startedAt,
      durationMs: r.meta.durationMs,
      score: r.result?.exec?.overallScore ?? null,
    }));
}

// ---- event stream --------------------------------------------------------

export function emit(id, event) {
  const stream = streams.get(id);
  if (!stream) return;
  const stamped = { ...event, at: Date.now() };
  stream.events.push(stamped);
  for (const listener of stream.listeners) {
    try {
      listener(stamped);
    } catch {
      // A broken client must not take down the run.
    }
  }
}

/**
 * Replays everything so far, then streams live events.
 * @returns {() => void} unsubscribe
 */
export function subscribe(id, listener) {
  const stream = streams.get(id);
  const record = runs.get(id);

  if (!stream && !record) {
    listener({ type: 'run:unknown', at: Date.now() });
    return () => {};
  }

  if (stream) {
    for (const event of stream.events) listener(event);
  } else {
    // The record exists but its event history does not - this run belongs to a
    // previous server process and was rehydrated from run.json. There is no
    // progress to replay, so hand over the finished stage list instead. The
    // client renders from the record, exactly as it does after run:done.
    listener({
      type: 'run:restored',
      status: record.status,
      stages: record.stages,
      at: Date.now(),
    });
  }

  // Nothing more will ever arrive for a run that is over - or for one orphaned
  // by a restart, which can never resume. Close rather than hold the
  // connection open forever.
  const finished = record && (record.status === 'done' || record.status === 'failed');
  if (finished || !stream) {
    listener({ type: 'run:done', ok: record?.status === 'done', at: Date.now() });
    return () => {};
  }

  stream.listeners.add(listener);
  return () => stream.listeners.delete(listener);
}

export function isFinished(id) {
  const record = runs.get(id);
  return !!record && (record.status === 'done' || record.status === 'failed');
}
