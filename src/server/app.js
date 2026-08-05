/**
 * HTTP layer for the demo UI.
 *
 * This is an orchestration layer and nothing more: it validates two URLs,
 * drives the existing pipeline via runPipeline, and serialises what comes back.
 * It contains no comparison logic and must never grow any - the engine is the
 * product, this is a way to look at it.
 *
 * Express rather than node:http because evertest-backend is Express, so these
 * handlers port as a route module rather than a rewrite (plan §13).
 */

import express from 'express';
import { existsSync, createReadStream } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveConfig, ConfigError } from '../config.js';
import { runPipeline } from '../pipeline/run.js';
import { validateAuditRequest } from './validate.js';
import { splitProse } from './prose.js';
import * as runs from './runs.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UI_DIST = join(ROOT, 'ui', 'dist');

/** The three artifacts the UI offers for download. Whitelisted, never interpolated. */
const DOWNLOADS = {
  'report.md': { type: 'text/markdown; charset=utf-8' },
  'report.html': { type: 'text/html; charset=utf-8' },
  'findings.json': { type: 'application/json; charset=utf-8' },
};

/**
 * Turn runner events into the run record.
 *
 * Every event is also pushed to the run's stream for SSE. The record is what a
 * late-joining client gets in one shot; the stream is what a live client
 * watches.
 */
function makeEventHandler(id) {
  return (event) => {
    const record = runs.get(id);
    if (!record) return;

    switch (event.type) {
      case 'run:start':
        record.stages = event.stages.map((s) => ({
          id: s.id,
          label: s.label,
          status: 'pending',
          ms: null,
          info: null,
          message: null,
        }));
        runs.patchMeta(id, {
          figmaFileKey: event.config.figmaFileKey,
          figmaNodeId: event.config.figmaNodeId,
          viewportWidth: event.config.viewportWidth,
          toleranceProfile: event.config.tolerance,
        });
        break;

      case 'stage:start': {
        const stage = record.stages.find((s) => s.id === event.id);
        if (stage) stage.status = 'running';
        break;
      }

      case 'stage:ok': {
        const stage = record.stages.find((s) => s.id === event.id);
        if (stage) {
          stage.status = 'ok';
          stage.ms = event.ms;
          stage.info = event.info ?? null;
        }
        // The viewport width is not known at run:start - it is derived from the
        // frame's own width during M2 (config.js applyFrameWidth), which is why
        // M2 runs before M1 at all. Capture it when it actually exists.
        if (event.id === 'M2' && event.info?.width) {
          runs.patchMeta(id, { viewportWidth: event.info.width, frameName: event.info.frame ?? null });
        }

        // Cross-origin iframes cannot be measured - the browser will not let
        // us read into them. That is a silent gap in coverage, so it is
        // reported rather than left for someone to discover by noticing a
        // region with suspiciously few findings.
        if (event.id === 'M1' && event.info?.xOriginIframes) {
          const n = event.info.xOriginIframes;
          record.warnings.push({
            stage: 'M1',
            message:
              `${n} cross-origin iframe${n === 1 ? '' : 's'} could not be measured - the browser does not ` +
              'allow reading into them. Anything rendered inside is excluded from this audit.',
          });
        }

        // M2 reports whether the Figma data came from a stale cache. The UI
        // needs this prominently: a stale design means the audit compared
        // against something other than what is on screen in Figma.
        //
        // Only once, though. When the rate-limit retry has already explained
        // this, adding a second near-identical banner just makes the report
        // look noisy - the reader learns nothing from the repetition.
        if (event.id === 'M2' && event.info?.stale) {
          runs.patchMeta(id, { figmaCacheStale: true });
          if (!record.warnings.some((w) => w.stage === 'M2')) {
            record.warnings.push({
              stage: 'M2',
              message:
                'Figma data was served from cache and may be stale - the live file could not be reached ' +
                '(rate limit). Findings may reflect an older version of the design.',
            });
          }
        }
        break;
      }

      case 'stage:fail': {
        const stage = record.stages.find((s) => s.id === event.id);
        if (stage) {
          stage.status = 'failed';
          stage.ms = event.ms;
          stage.message = event.error.message;
        }
        break;
      }

      case 'stage:pending': {
        const stage = record.stages.find((s) => s.id === event.id);
        if (stage) {
          stage.status = 'pending';
          stage.message = `Not implemented (${event.file}, phase ${event.phase})`;
        }
        break;
      }

      default:
        break;
    }

    runs.emit(id, event);
  };
}

/**
 * Which artifacts exist on disk for a run.
 *
 * Needed on the FAILURE path as much as the success one: a run that died at S5
 * still wrote findings.json, and offering it is more use to a developer than a
 * bare error page. `result` is null when a run fails, so this is reported
 * separately.
 */
function artifactsOnDisk(dir) {
  return {
    markdown: existsSync(join(dir, 'report.md')),
    html: existsSync(join(dir, 'report.html')),
    findings: existsSync(join(dir, 'findings.json')),
  };
}

/** Build the client-facing result from the finished ctx. */
function buildResult(ctx) {
  const { analysis, assembled, alignment, prose, config } = ctx;
  const dir = config.outDir;

  const proseOut = prose?.ok
    ? {
        ok: true,
        sections: splitProse(prose.markdown).sections,
        audit: prose.audit ?? null,
        usage: prose.usage ?? null,
      }
    : { ok: false, reason: prose?.reason ?? 'The written summary was not generated.' };

  return {
    exec: analysis?.exec ?? null,
    sectionScores: analysis?.sectionScores ?? [],
    issues:
      analysis?.issues?.map((i) => ({
        property: i.property,
        category: i.category,
        severity: i.severity,
        occurrences: i.occurrences,
        sections: i.sections,
        variants: i.variants,
        oneFix: i.oneFix,
        systemic: i.systemic,
        knowledge: i.knowledge,
        // A few concrete values so the UI can show expected-vs-found without
        // making the reader open the raw findings table.
        examples: i.findings.slice(0, 4).map((f) => ({
          expected: f.expected,
          actual: f.actual,
          delta: f.delta ?? null,
          ratio: f.ratio ?? null,
          occurrenceCount: f.occurrenceCount ?? null,
          // An extra-in-web colour has no `expected` by definition, but the
          // engine did find its closest design counterpart. Without these two
          // the UI can only render a dash, and a near-miss (deltaE 3.3, almost
          // certainly a hand-typed hex) looks identical to a genuinely foreign
          // colour (deltaE 6.4, usually a third-party component).
          nearestColorInDesign: f.nearestColorInDesign ?? null,
          nearestInDesign: f.nearestInDesign ?? null,
        })),
      })) ?? [],
    fixOrder: analysis?.fixOrder ?? [],
    counts: assembled?.counts ?? null,
    alignmentStats: alignment?.stats ?? null,
    determinism: ctx.diagnostics?.determinism ?? null,
    prose: proseOut,
    files: artifactsOnDisk(dir),
  };
}

/**
 * Is this the Figma rate limit rather than a real problem with the request?
 *
 * Figma returns Retry-After values measured in hours, so the client refuses to
 * wait and throws (client.js MAX_BACKOFF_MS). That is correct behaviour, but it
 * means a rate-limited demo cannot fetch fresh design data at all.
 */
const isFigmaRateLimit = (err) =>
  err?.name === 'FigmaError' && (err.status === 429 || /\b429\b|rate limit/i.test(err.message ?? ''));

/**
 * Drive one audit to completion. Never throws - failure is recorded on the run.
 *
 * Runs default to noCache so the audit compares against the design that is
 * actually in Figma right now; a stale cached frame produces findings that do
 * not match what a reviewer sees on screen, which is the worse failure. But
 * bypassing the cache removes the safety net, and when the nodes endpoint is
 * ALSO rate-limited the run dies at M2 with nothing to fall back on.
 *
 * So the orchestration layer supplies the fallback the flag takes away: try
 * fresh, and if Figma refuses, run again from cache and say so loudly. This is
 * the same "degrade, never die" rule client.js applies to the version check -
 * applied here, at the layer that owns the retry policy, rather than by
 * changing the engine.
 */
async function executeRun(record) {
  const id = record.id;
  const onEvent = makeEventHandler(id);
  const startedAt = Date.now();

  runs.update(id, { status: 'running' });

  let config;
  try {
    config = resolveConfig({
      figmaFrameUrl: record.input.figmaFrameUrl,
      pageUrl: record.input.pageUrl,
      outDir: runs.runDir(id),
      viewportWidth: record.input.viewportWidth,
    });
  } catch (err) {
    // Almost always a missing FIGMA_TOKEN - the URL shapes were checked before
    // the run was created.
    runs.update(id, {
      status: 'failed',
      error: { stage: null, name: err.name, message: String(err.message).split('\n')[0], hint: null },
    });
    runs.patchMeta(id, { finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAt });
    runs.emit(id, { type: 'run:done', ok: false });
    return;
  }

  const flags = { noCache: record.input.noCache, noDeterminism: !record.input.determinism };

  try {
    let ctx;
    try {
      ctx = await runPipeline(config, flags, { onEvent });
    } catch (err) {
      const failedAtFigma = runs.get(id)?.stages.find((s) => s.status === 'failed')?.id === 'M2';
      if (!(flags.noCache && failedAtFigma && isFigmaRateLimit(err))) throw err;

      // M2 fails in about a second, so retrying the whole pipeline costs
      // essentially nothing - and the alternative is no report at all.
      record.warnings.push({
        stage: 'M2',
        message:
          'Figma is rate-limiting this account, so the current design could not be fetched. ' +
          'The audit re-ran against the last cached version of the frame - findings may reflect ' +
          'an older design than the one in Figma now.',
      });
      runs.patchMeta(id, { figmaCacheStale: true });
      runs.emit(id, {
        type: 'run:retry',
        reason: 'figma-rate-limit',
        message: 'Figma rate limit - retrying from cached design data',
      });

      ctx = await runPipeline(config, { ...flags, noCache: false }, { onEvent });
      record.input.noCache = false;
    }

    runs.update(id, { status: 'done', result: buildResult(ctx) });
    runs.patchMeta(id, {
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    });
    runs.emit(id, { type: 'run:done', ok: true, ms: Date.now() - startedAt });
  } catch (err) {
    const failed = runs.get(id)?.stages.find((s) => s.status === 'failed');
    runs.update(id, {
      status: 'failed',
      // Whatever the run managed to write before it died stays downloadable.
      artifacts: artifactsOnDisk(runs.runDir(id)),
      error: {
        stage: failed?.id ?? null,
        stageLabel: failed?.label ?? null,
        name: err.name,
        message: String(err.message).split('\n')[0],
        hint: String(err.message).split('\n').slice(1).join(' ').trim() || null,
      },
    });
    runs.patchMeta(id, { finishedAt: new Date().toISOString(), durationMs: Date.now() - startedAt });
    runs.emit(id, { type: 'run:done', ok: false, ms: Date.now() - startedAt });
  }
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  // ---- health ------------------------------------------------------------
  // Presence booleans only. Never a key, a prefix, or a length.
  app.get('/api/health', (_req, res) => {
    const llm =
      (process.env.LLM_PROVIDER || '').trim().toLowerCase() ||
      (process.env.GEMINI_API_KEY ? 'gemini' : process.env.ANTHROPIC_API_KEY ? 'anthropic' : null);
    const keyPresent =
      llm === 'gemini' ? !!process.env.GEMINI_API_KEY
      : llm === 'anthropic' ? !!process.env.ANTHROPIC_API_KEY
      : false;

    res.json({
      ok: true,
      figmaToken: !!process.env.FIGMA_TOKEN,
      llm: keyPresent ? llm : null,
      activeRunId: runs.activeRun()?.id ?? null,
    });
  });

  // ---- start a run -------------------------------------------------------
  app.post('/api/audit', (req, res) => {
    const check = validateAuditRequest(req.body);
    if (!check.ok) {
      return res.status(400).json({ field: check.field, error: check.error, hint: check.hint });
    }

    // One run at a time: Playwright plus two full IR snapshots is memory-heavy,
    // and concurrent writes into .cache/figma are not coordinated.
    const active = runs.activeRun();
    if (active) {
      return res.status(409).json({
        error: 'An audit is already running.',
        hint: 'Wait for it to finish, or open its progress.',
        activeRunId: active.id,
      });
    }

    const record = runs.create(check.value);
    res.status(202).json({ runId: record.id });

    // Deliberately not awaited: the response is already sent and the client
    // follows progress over SSE.
    executeRun(record);
  });

  // ---- read a run --------------------------------------------------------
  app.get('/api/runs', (_req, res) => res.json({ runs: runs.list() }));

  app.get('/api/runs/:id', (req, res) => {
    const record = runs.get(req.params.id);
    if (!record) return res.status(404).json({ error: `No run with id ${req.params.id}` });
    res.json(record);
  });

  // ---- progress stream ---------------------------------------------------
  app.get('/api/runs/:id/events', (req, res) => {
    const id = req.params.id;
    if (!runs.get(id)) return res.status(404).json({ error: `No run with id ${id}` });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx and friends buffer event-streams into uselessness otherwise.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    // Every write goes through the `closed` guard.
    //
    // This is not defensiveness for its own sake: the keepalive timer and the
    // event listener both outlive res.end(), and a write after end throws
    // asynchronously - which is an uncaught exception, which kills the whole
    // server. Found exactly that way: one completed run took the process down
    // and every later request returned an empty body.
    let keepalive = null;
    let unsubscribe = null;
    let closed = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (keepalive) clearInterval(keepalive);
      if (unsubscribe) unsubscribe();
      if (!res.writableEnded) res.end();
    };

    const send = (event) => {
      if (closed || res.writableEnded) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === 'run:done') cleanup();
    };

    // subscribe() replays the backlog first, so a client that joins late - or
    // reconnects - still sees every stage rather than an empty list. For a run
    // that is already finished it replays and then sends run:done, which calls
    // cleanup() synchronously - hence the null-guards above.
    unsubscribe = runs.subscribe(id, send);

    if (!closed) {
      keepalive = setInterval(() => {
        if (closed || res.writableEnded) return cleanup();
        res.write(': keepalive\n\n');
      }, 15_000);
    }

    req.on('close', cleanup);
  });

  // ---- artifact downloads ------------------------------------------------
  app.get('/api/runs/:id/:file', (req, res) => {
    const { id, file } = req.params;
    const spec = DOWNLOADS[file];
    if (!spec) return res.status(404).json({ error: `Unknown artifact "${file}"` });
    if (!runs.get(id)) return res.status(404).json({ error: `No run with id ${id}` });

    const path = join(runs.runDir(id), file);
    if (!existsSync(path)) {
      return res.status(404).json({
        error: `${file} was not produced by this run.`,
        hint: 'A run that failed before the report stage still has its findings.',
      });
    }

    res.setHeader('Content-Type', spec.type);
    res.setHeader('Content-Disposition', `attachment; filename="${id}-${file}"`);
    createReadStream(path).pipe(res);
  });

  // ---- static UI ---------------------------------------------------------
  // Present only after `npm run build`; harmless before ui/ exists.
  if (existsSync(UI_DIST)) {
    app.use(express.static(UI_DIST));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(join(UI_DIST, 'index.html')));
  }

  // ---- errors ------------------------------------------------------------
  app.use((err, _req, res, _next) => {
    if (err instanceof ConfigError) {
      const [error, ...rest] = String(err.message).split('\n');
      return res.status(400).json({ error, hint: rest.join(' ').replace(/^\s*→\s*/, '').trim() || null });
    }
    console.error('  [server]', err);
    res.status(500).json({ error: err.message ?? 'Internal error' });
  });

  return app;
}
