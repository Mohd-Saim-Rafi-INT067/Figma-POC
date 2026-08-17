/**
 * Replay E2 -> E7 against a completed run's artifacts.
 *
 *   node src/pipeline/replay.js [runDir] [--only=E2,E3] [--publish]
 *
 * Extraction is the expensive, quota-bound and non-deterministic half of an
 * audit: M2 costs Figma requests from an account with roughly six Tier-1 a
 * month, and M1 re-measures a live page that has moved on since. Neither is
 * needed to iterate on correspondence, comparison or reporting.
 *
 * So this rebuilds the pipeline context from `<runDir>/*.json` and runs the
 * back half only. Everything it reads was written by a real run; nothing is
 * synthesised. That makes it the CONTROLLED comparison - the measurements are
 * held fixed, and any change in the report is attributable to the stages being
 * replayed rather than to a page that changed underneath.
 */

import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig } from '../config.js';
import { stageCorrespond } from '../correspond/stage.js';
import { stageStructural, stageProperties } from '../compare/stage.js';
import { stageIssues } from '../issues/stage.js';
import { stageEvidence } from '../evidence/stage.js';
import { stageQaReport } from '../qa/stage.js';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', red: '\x1b[31m' };

const STAGES = [
  { id: 'E2', label: 'Element correspondence', run: stageCorrespond },
  { id: 'E3', label: 'Structural verdict', run: stageStructural },
  { id: 'E4', label: 'Element property comparison', run: stageProperties },
  { id: 'E5', label: 'Issue prioritisation', run: stageIssues },
  { id: 'E6', label: 'Evidence', run: stageEvidence, optional: true },
  { id: 'E7', label: 'Visual QA report', run: stageQaReport },
];

export async function buildContext(runDir) {
  const read = (name) => {
    const path = join(runDir, name);
    if (!existsSync(path)) throw new Error(`replay needs ${path}; run a full audit first`);
    return JSON.parse(readFileSync(path, 'utf8'));
  };

  const config = resolveConfig({ outDir: runDir });
  const snapshots = { figma: read('figma-ir.json'), web: read('web-ir.json') };

  // The run's own Figma identity, not the environment's - replaying a stored run
  // must not silently retarget it at whatever FIGMA_FRAME_URL currently says.
  config.figmaFileKey = snapshots.figma.meta?.fileKey ?? config.figmaFileKey;

  return {
    config,
    snapshots,
    sections: read('sections.json'),
    elements: read('elements.json'),
  };
}

/**
 * Copy a replayed run into `out/runs/<id>/` so the UI can show it.
 *
 * The pipeline writes to the run directory it was given; a replay writes to
 * `out/`, which the server never lists. Without this the replayed report exists
 * and is simply invisible - the one thing worse than not producing it.
 *
 * The record is marked `replayed` and carries the ORIGINAL run's inputs, so it
 * cannot be mistaken in the gallery for a fresh audit of the live page.
 */
async function publishAsRun(runDir, ctx) {
  const { cpSync, mkdirSync, writeFileSync, existsSync } = await import('node:fs');
  const { RUNS_DIR } = await import('../server/runs.js');

  const id = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-rply`;
  const dest = join(RUNS_DIR, id);
  mkdirSync(dest, { recursive: true });

  for (const name of ['qa', 'evidence', 'elements.json', 'sections.json', 'section-alignment.json',
    'figma-ir.json', 'web-ir.json', 'structural.json', 'element-findings.json', 'issues.json',
    'findings.json', 'correspondence.json', 'report.html', 'report.md']) {
    const from = join(runDir, name);
    if (existsSync(from)) cpSync(from, join(dest, name), { recursive: true });
  }

  const corr = ctx.correspondence ?? [];
  const record = {
    id,
    status: 'done',
    replayed: true,
    input: {
      figmaFrameUrl: ctx.config.figmaFrameUrl ?? null,
      pageUrl: ctx.config.pageUrl ?? null,
      determinism: false, noCache: false, capture: false,
    },
    meta: {
      pageUrl: ctx.config.pageUrl ?? null,
      figmaFileKey: ctx.config.figmaFileKey ?? null,
      viewportWidth: ctx.config.viewportWidth ?? 1920,
      toleranceProfile: 'default v2',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 0,
      note: 'Replayed E2-E7 from stored extraction — measurements are the original run\'s.',
      correspondenceTier: corr.every((c) => c.tier === 'llm') ? 'llm'
        : corr.some((c) => c.tier === 'llm') ? 'mixed' : 'anchor',
    },
    stages: [],
    result: { files: {} },
  };
  writeFileSync(join(dest, 'run.json'), JSON.stringify(record, null, 2));
  return id;
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('src/pipeline/replay.js');
if (invokedDirectly) {
  const runDir = process.argv[2] || 'out';
  const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1]?.split(',');

  console.log(`\n  ${C.bold}REPLAY${C.reset} ${runDir} ${C.dim}— E2 to E7, no extraction, no Figma requests${C.reset}\n`);

  const ctx = await buildContext(runDir);
  const started = Date.now();

  for (const stage of STAGES) {
    if (only && !only.includes(stage.id)) continue;
    const t = Date.now();
    process.stdout.write(`  ${C.bold}${stage.id}${C.reset} ${stage.label}\n`);
    try {
      ctx.stageInfo = null;
      await stage.run(ctx);
      console.log(`  ${C.dim}   ${((Date.now() - t) / 1000).toFixed(1)}s${C.reset}`);
    } catch (err) {
      if (stage.optional) {
        console.log(`  ${C.red}   skipped: ${err.message}${C.reset}\n`);
        continue;
      }
      console.error(`\n  ${C.red}${stage.id} failed: ${err.message}${C.reset}\n`);
      process.exit(1);
    }
  }

  console.log(`\n  ${C.green}replay complete${C.reset} in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  if (process.argv.includes('--publish')) {
    const id = await publishAsRun(runDir, ctx);
    console.log(`  published as run ${C.bold}${id}${C.reset} — visible at http://localhost:5173`);
  }
  console.log('');
}
