/**
 * The pipeline runner - the stage list and the loop that drives it.
 *
 * This lived in cli.js until the demo UI needed the same twelve stages driven
 * from an HTTP request. Rather than reimplement the ordering there - which is
 * the one part of this system where a mistake is silent and expensive, because
 * M2 must precede M1 (see below) - the loop moved here and the CLI became one
 * of its two callers.
 *
 * Presentation is not this module's job. It emits events; a caller renders
 * them. cli.js turns them into the ANSI progress lines it always printed, and
 * the server turns them into SSE.
 */

import { stageFigmaExtract, stageFigmaNormalize } from '../figma/stage.js';
import { stageWebExtract, stageWebNormalize, stageDeterminismCheck } from '../web/stage.js';
import { stagePrune, stageSpacing } from './stage.js';
import { stageSegment, stageMatch, stageCompare } from '../sections/stage.js';
import { stageAssemble, stageReport } from '../report/index.js';

export class NotImplemented extends Error {
  constructor(stage, file, phase) {
    super(`Stage ${stage} is not implemented yet`);
    this.name = 'NotImplemented';
    this.stage = stage;
    this.file = file;
    this.phase = phase;
  }
}

export const pending = (file, phase) => (ctx, stage) => {
  throw new NotImplemented(stage.id, file, phase);
};

/**
 * `sides` marks which of --web-only / --figma-only a stage belongs to.
 * 'both' stages are skipped when either flag narrows the run.
 *
 * The order is load-bearing and is NOT the order a reader expects: the Figma
 * side runs first because a frame is fixed-width and that width becomes the
 * browser viewport (config.js applyFrameWidth, figma/stage.js). Measuring a
 * 1920 frame against a browser at 1280 compares two different layouts and
 * every finding is noise. Do not reorder these to read more naturally.
 */
export const STAGES = [
  { id: 'M2',  side: 'figma', phase: 1, label: 'Figma extraction (REST + cache)',   run: stageFigmaExtract },
  { id: 'M4',  side: 'figma', phase: 1, label: 'Figma normalizer -> IR',            run: stageFigmaNormalize },
  { id: 'M1',  side: 'web',   phase: 2, label: 'Web extraction (Playwright + CDP)', run: stageWebExtract },
  { id: 'M3',  side: 'web',   phase: 2, label: 'Web normalizer -> IR',              run: stageWebNormalize },
  { id: 'DET', side: 'web',   phase: 2, label: 'Determinism self-check (re-extract)', run: stageDeterminismCheck, optional: true },
  { id: 'P5',  side: 'both',  phase: 'B', label: 'Pruning & canonicalization',      run: stagePrune },
  { id: 'P6',  side: 'both',  phase: 'B', label: 'Measured spacing derivation',     run: stageSpacing },
  { id: 'S1',  side: 'both',  phase: 'C', label: 'Section segmentation',            run: stageSegment },
  { id: 'S2',  side: 'both',  phase: 'D', label: 'Section matching (aligned)',      run: stageMatch },
  { id: 'S3',  side: 'both',  phase: 'E', label: 'Section comparison (aggregates)', run: stageCompare },
  { id: 'S4',  side: 'both',  phase: 'F', label: 'Finding assembly',                run: stageAssemble },
  { id: 'S5',  side: 'both',  phase: 'F', label: 'Report (console + json + LLM)',   run: stageReport },
];

export function selectStages(flags) {
  let stages = STAGES;
  if (flags.figmaOnly) stages = stages.filter((s) => s.side === 'figma');
  else if (flags.webOnly) stages = stages.filter((s) => s.side === 'web');
  // The determinism check re-extracts the whole page, so it roughly doubles
  // web-side runtime. On by default because it is the Phase 2 exit criterion.
  if (flags.noDeterminism) stages = stages.filter((s) => s.id !== 'DET');
  return stages;
}

/**
 * Run the selected stages in order.
 *
 * Returns the finished ctx, carrying `ctx.outcome`. Two stop conditions are
 * distinguished because they mean different things to a caller:
 *
 *   - NotImplemented is a clean early return, not a failure. Everything before
 *     it ran fine and the caller reports where the build reached.
 *   - A stage throwing IS a failure. The event fires first so a caller that
 *     only listens to events still learns which stage died, then the error
 *     rethrows so a caller that only uses try/catch sees it too.
 *
 * @param {object} config    from resolveConfig()
 * @param {object} flags     { webOnly, figmaOnly, noCache, noDeterminism, verbose }
 * @param {(event: object) => void} [onEvent]
 */
export async function runPipeline(config, flags = {}, { onEvent = () => {} } = {}) {
  const stages = selectStages(flags);
  const ctx = { config, flags, snapshots: {}, findings: [], diagnostics: {} };
  const startedAll = Date.now();

  onEvent({
    type: 'run:start',
    stages: stages.map((s) => ({ id: s.id, label: s.label })),
    config: {
      pageUrl: config.pageUrl,
      figmaFileKey: config.figmaFileKey,
      figmaNodeId: config.figmaNodeId,
      viewportWidth: config.viewportWidth,
      viewportWidthOverride: config.viewportWidthOverride,
      viewportHeight: config.viewportHeight,
      tolerance: `${config.tolerance.name} v${config.tolerance.version}`,
      outDir: config.outDir,
    },
  });

  for (const [index, stage] of stages.entries()) {
    onEvent({ type: 'stage:start', id: stage.id, label: stage.label, index, total: stages.length });
    ctx.stageInfo = null;
    const startedAt = Date.now();

    try {
      await stage.run(ctx, stage);
      onEvent({
        type: 'stage:ok',
        id: stage.id,
        label: stage.label,
        ms: Date.now() - startedAt,
        info: ctx.stageInfo,
      });
    } catch (err) {
      if (err instanceof NotImplemented) {
        onEvent({
          type: 'stage:pending',
          id: stage.id,
          label: stage.label,
          file: err.file,
          phase: err.phase,
        });
        ctx.outcome = { ok: false, stopped: 'pending', stage: stage.id };
        return ctx;
      }

      onEvent({
        type: 'stage:fail',
        id: stage.id,
        label: stage.label,
        ms: Date.now() - startedAt,
        error: { name: err.name, message: err.message, status: err.status ?? null },
      });
      ctx.outcome = { ok: false, stopped: 'failed', stage: stage.id, error: err };
      throw err;
    }
  }

  ctx.outcome = { ok: true, stopped: 'complete', ms: Date.now() - startedAll };
  onEvent({ type: 'run:done', ok: true, ms: Date.now() - startedAll });
  return ctx;
}
