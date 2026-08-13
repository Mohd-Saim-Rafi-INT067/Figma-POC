/**
 * Capture web evidence without touching Figma.
 *
 *   node src/evidence/capture-only.js [outDir] [--width 1920]
 *
 * Runs the real extraction — the whole 12-step stabilization sequence — and
 * takes the full-page screenshot through the same `onStabilized` hook the
 * pipeline uses, then crops sections using the `sections.json` already on disk.
 *
 * Why this exists: the full pipeline spends a Figma request on the version check
 * even when every node payload is cached, and the account has roughly six a
 * month. Web evidence needs refreshing far more often than that budget allows.
 *
 * The viewport width normally comes from the Figma frame (parent doc §3.1).
 * Here it is read from the existing run's `sections.json`, so captures stay at
 * the width the measurements were taken at — passing a different one silently
 * compares two different layouts.
 */

import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { resolveConfig } from '../config.js';
import { extractWeb } from '../web/extract.js';
import { captureFullPage, cropSections, evidencePaths } from './capture.js';

const args = process.argv.slice(2);
const outDir = args.find((a) => !a.startsWith('--')) ?? 'out';
const widthArg = args.includes('--width') ? Number(args[args.indexOf('--width') + 1]) : null;

const sectionsPath = join(outDir, 'sections.json');
if (!existsSync(sectionsPath)) {
  console.error(`No ${sectionsPath}. Run the pipeline once first so sections exist to crop.`);
  process.exit(1);
}
const sections = JSON.parse(readFileSync(sectionsPath, 'utf8'));

const config = resolveConfig({ outDir });
config.viewportWidth = widthArg ?? sections.web.rootWidth ?? sections.figma.rootWidth;
if (!config.viewportWidth) {
  console.error('Could not determine a viewport width from sections.json; pass --width.');
  process.exit(1);
}

console.log(`\n  capture-only — ${config.pageUrl} at ${config.viewportWidth}px (no Figma requests)\n`);

const browser = await chromium.launch({ headless: true });
try {
  let capture = null;
  const paths = evidencePaths(outDir);

  await extractWeb(config, {
    browser,
    log: console,
    // Extraction still runs in full: the point is that the pixels come from the
    // same stabilized state the measurements would have come from.
    skipFonts: true,
    onStabilized: async (page) => { capture = await captureFullPage(page, paths.fullPage); },
  });

  console.log(`  full page   ${capture.width}x${capture.height}  ->  ${capture.path}`);

  const written = await cropSections(browser, capture, sections.web.sections, paths.sections, { side: 'web' });
  console.log(`  sections    ${written.length} crops -> ${paths.sections}\n`);
  for (const w of written) {
    console.log(`    ${String(w.index).padStart(2)}  y=${String(w.box.y).padStart(5)}  h=${String(w.box.height).padStart(4)}  ${w.path}`);
  }
  console.log('');
} finally {
  await browser.close();
}
