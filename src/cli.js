#!/usr/bin/env node
/**
 * POC entry point.
 *
 * The pipeline is declared as an ordered stage list so that, from Phase 0 onward,
 * `npm run audit` always runs end-to-end and fails with a precise message at the
 * first unimplemented stage - rather than failing on an undefined import and
 * leaving you to work out how far it got.
 */

import { resolveConfig, ConfigError } from './config.js';
import { stageFigmaExtract, stageFigmaNormalize } from './figma/stage.js';
import { stageWebExtract, stageWebNormalize, stageDeterminismCheck } from './web/stage.js';
import { stagePrune, stageSpacing } from './pipeline/stage.js';
import { stageSegment, stageMatch, stageCompare } from './sections/stage.js';
import { stageAssemble, stageReport } from './report/index.js';

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m',
};

class NotImplemented extends Error {
  constructor(stage, file, phase) {
    super(`Stage ${stage} is not implemented yet`);
    this.name = 'NotImplemented';
    this.stage = stage;
    this.file = file;
    this.phase = phase;
  }
}

const pending = (file, phase) => (ctx, stage) => {
  throw new NotImplemented(stage.id, file, phase);
};

/**
 * `sides` marks which of --web-only / --figma-only a stage belongs to.
 * 'both' stages are skipped when either flag narrows the run.
 */
const STAGES = [
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

function parseArgs(argv) {
  const flags = {
    webOnly: false, figmaOnly: false, noCache: false,
    noDeterminism: false, verbose: false, help: false,
  };
  for (const arg of argv) {
    switch (arg) {
      case '--web-only':   flags.webOnly = true; break;
      case '--figma-only': flags.figmaOnly = true; break;
      case '--no-cache':   flags.noCache = true; break;
      case '--no-determinism': flags.noDeterminism = true; break;
      case '-v':
      case '--verbose':    flags.verbose = true; break;
      case '-h':
      case '--help':       flags.help = true; break;
      default:
        throw new ConfigError(`Unknown flag: ${arg}`, 'Run with --help to see valid flags.');
    }
  }
  if (flags.webOnly && flags.figmaOnly) {
    throw new ConfigError('--web-only and --figma-only are mutually exclusive');
  }
  return flags;
}

function usage() {
  console.log(`
${C.bold}figma-parity-poc${C.reset} - V1 section-level design parity

  Compares sections as whole units. Text is used to MATCH sections, never reported
  as a finding - design content and live content legitimately differ.

  ${C.bold}npm run audit${C.reset}                 full pipeline
  ${C.bold}npm run audit -- --figma-only${C.reset} extract + normalize the Figma side only
  ${C.bold}npm run audit -- --web-only${C.reset}   extract + normalize the web side only

Flags:
  --figma-only   stop after M4. Writes out/figma-ir.json
  --web-only     stop after M3. Writes out/web-ir.json
                 (note: needs a viewport width, so it uses VIEWPORT_WIDTH from .env
                  or the last cached frame width - see plan 3.2)
  --no-cache        bypass the Figma version cache and refetch
  --no-determinism  skip the double-extraction self-check (roughly halves web runtime)
  -v, --verbose     log each stabilization step and font-probe failure
  -h, --help        this message

Config comes from .env - see .env.example.
`);
}

function selectStages(flags) {
  let stages = STAGES;
  if (flags.figmaOnly) stages = stages.filter((s) => s.side === 'figma');
  else if (flags.webOnly) stages = stages.filter((s) => s.side === 'web');
  // The determinism check re-extracts the whole page, so it roughly doubles
  // web-side runtime. On by default because it is the Phase 2 exit criterion.
  if (flags.noDeterminism) stages = stages.filter((s) => s.id !== 'DET');
  return stages;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    usage();
    return 0;
  }

  const config = resolveConfig();
  const stages = selectStages(flags);

  console.log(`\n${C.bold}Figma design parity${C.reset} ${C.dim}(V1: section-level)${C.reset}`);
  console.log(`${C.dim}${'-'.repeat(58)}${C.reset}`);
  console.log(`  figma file  ${C.cyan}${config.figmaFileKey}${C.reset}`);
  console.log(`  figma frame ${C.cyan}${config.figmaNodeId}${C.reset}`);
  console.log(`  page        ${C.cyan}${config.pageUrl}${C.reset}`);
  console.log(
    `  viewport    ${C.cyan}${
      config.viewportWidthOverride ?? 'auto'
    }${C.reset}${C.dim} x ${config.viewportHeight}${
      config.viewportWidthOverride ? ' (overridden)' : ' (derived from frame)'
    }${C.reset}`
  );
  console.log(`  tolerance   ${C.cyan}${config.tolerance.name} v${config.tolerance.version}${C.reset}`);
  console.log(`${C.dim}${'-'.repeat(58)}${C.reset}\n`);

  const ctx = { config, flags, snapshots: {}, findings: [], diagnostics: {} };

  for (const stage of stages) {
    process.stdout.write(`  ${C.dim}[${stage.id.padEnd(3)}]${C.reset} ${stage.label} ... `);
    ctx.stageInfo = null;
    const startedAt = Date.now();
    try {
      await stage.run(ctx, stage);
      const ms = Date.now() - startedAt;
      const info = ctx.stageInfo
        ? ' ' + C.dim + Object.entries(ctx.stageInfo)
            .filter(([, v]) => v !== null && v !== undefined && v !== false)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ') + C.reset
        : '';
      console.log(`${C.green}ok${C.reset} ${C.dim}(${ms}ms)${C.reset}${info}`);
    } catch (err) {
      if (err instanceof NotImplemented) {
        console.log(`${C.yellow}not implemented${C.reset}\n`);
        console.log(`${C.yellow}${C.bold}Stopped at ${stage.id} - ${stage.label}${C.reset}`);
        console.log(`  next file  ${C.bold}${err.file}${C.reset}`);
        console.log(`  plan phase ${C.bold}${err.phase}${C.reset} ${C.dim}(docs/v1-implementation-plan.md)${C.reset}`);
        console.log(`\n${C.dim}Everything before this stage ran clean.${C.reset}\n`);
        return 3;
      }
      console.log(`${C.red}failed${C.reset}\n`);
      throw err;
    }
  }

  console.log(`\n${C.green}${C.bold}Done.${C.reset} Output in ${config.outDir}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof ConfigError) {
      console.error(`\n${C.red}${C.bold}Config error:${C.reset} ${err.message}\n`);
      process.exit(2);
    }
    console.error(`\n${C.red}${C.bold}${err.name}:${C.reset} ${err.message}`);
    if (err.stack) console.error(`${C.dim}${err.stack.split('\n').slice(1, 5).join('\n')}${C.reset}`);
    console.error('');
    process.exit(1);
  });
