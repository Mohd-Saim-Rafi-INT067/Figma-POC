#!/usr/bin/env node
/**
 * POC entry point.
 *
 * The pipeline itself lives in pipeline/run.js - this file is the console
 * rendering of it. It parses flags, prints the header, and turns the runner's
 * events into the progress lines below. The demo UI server is the other caller
 * of the same runner, so the stage list has exactly one definition.
 */

import { resolveConfig, ConfigError } from './config.js';
import { runPipeline } from './pipeline/run.js';

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m',
};

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

/** Renders runner events as the progress lines this CLI has always printed. */
function printEvent(event) {
  switch (event.type) {
    case 'stage:start':
      process.stdout.write(`  ${C.dim}[${event.id.padEnd(3)}]${C.reset} ${event.label} ... `);
      break;

    case 'stage:ok': {
      const info = event.info
        ? ' ' + C.dim + Object.entries(event.info)
            .filter(([, v]) => v !== null && v !== undefined && v !== false)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ') + C.reset
        : '';
      console.log(`${C.green}ok${C.reset} ${C.dim}(${event.ms}ms)${C.reset}${info}`);
      break;
    }

    case 'stage:pending':
      console.log(`${C.yellow}not implemented${C.reset}\n`);
      console.log(`${C.yellow}${C.bold}Stopped at ${event.id} - ${event.label}${C.reset}`);
      console.log(`  next file  ${C.bold}${event.file}${C.reset}`);
      console.log(`  plan phase ${C.bold}${event.phase}${C.reset} ${C.dim}(docs/v1-implementation-plan.md)${C.reset}`);
      console.log(`\n${C.dim}Everything before this stage ran clean.${C.reset}\n`);
      break;

    case 'stage:fail':
      console.log(`${C.red}failed${C.reset}\n`);
      break;

    default:
      break;
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    usage();
    return 0;
  }

  const config = resolveConfig();

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

  const ctx = await runPipeline(config, flags, { onEvent: printEvent });

  if (ctx.outcome.stopped === 'pending') return 3;

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
