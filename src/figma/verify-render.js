/**
 * Verify the Figma token can render the target frame — ONE request, no more.
 *
 *   node src/figma/verify-render.js [runDir]
 *
 * Deliberately does not run any experiment. It confirms, in order:
 *   1. the token reaches the file            (cached metadata, no request)
 *   2. /v1/images returns 200 with a URL     (ONE Tier-1 request)
 *   3. the PNG actually downloads            (S3, not metered)
 *   4. the bytes land in .cache/figma/...    (so the request is never re-spent)
 *
 * If the render is already cached, it spends nothing and says so.
 */

import 'dotenv/config';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveConfig } from '../config.js';
import { FigmaClient } from './client.js';
import { captureFigmaFrame } from '../evidence/capture.js';

const RENDER_SCALE = 0.5;
const runDir = process.argv[2] || 'out';
const figmaIr = JSON.parse(readFileSync(join(runDir, 'figma-ir.json'), 'utf8'));
const { fileKey, nodeId, frameWidth, frameHeight } = figmaIr.meta;
const version = figmaIr.sourceVersion;

/** PNG dimensions from the IHDR chunk - no image library needed. */
function pngSize(path) {
  const b = readFileSync(path).subarray(0, 33);
  if (b.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

const config = resolveConfig({ outDir: runDir });
const client = new FigmaClient({ token: config.figmaToken, cacheDir: '.cache', log: console });

const cachedPng = resolve('.cache', 'figma', fileKey, String(version), `image-${nodeId.replace(/[^\w.-]+/g, '_')}@${RENDER_SCALE}.png`);

console.log('\n  FIGMA RENDER VERIFICATION\n');
console.log(`  file      ${fileKey}`);
console.log(`  node      ${nodeId}   (frame ${frameWidth}x${frameHeight})`);
console.log(`  version   ${version}   <- pinned to the IR's version, not current`);
console.log(`  scale     ${RENDER_SCALE}  -> expect ${frameWidth * RENDER_SCALE}x${frameHeight * RENDER_SCALE}`);
console.log(`  cache     ${cachedPng}`);
console.log(`  already cached? ${existsSync(cachedPng) ? 'YES - this run will spend 0 requests' : 'no - this run will spend exactly 1'}\n`);

const outPath = join(runDir, 'evidence', 'figma-frame.png');
const result = await captureFigmaFrame(client, {
  fileKey, version, nodeId, outPath, scale: RENDER_SCALE, cacheDir: '.cache',
});

// The URL the API returned, read back from the client's own cache entry.
const urlEntryPath = resolve('.cache', 'figma', fileKey, String(version), `image-${nodeId.replace(/:/g, '_')}-png@${RENDER_SCALE}.json`);
if (existsSync(urlEntryPath)) {
  const entry = JSON.parse(readFileSync(urlEntryPath, 'utf8'));
  console.log(`\n  returned URL   ${String(entry.url).slice(0, 96)}...`);
  console.log(`  rendered at    ${entry.renderedAt}`);
}

console.log('\n  ── RESULT ──────────────────────────────────────────────');
console.log(`  request spent   ${result.cacheHit ? '0 (served from cached pixels)' : '1'}`);
for (const [label, p] of [['cached PNG', cachedPng], ['working copy', outPath]]) {
  if (!existsSync(p)) { console.log(`  ${label.padEnd(14)} MISSING`); continue; }
  const size = pngSize(p);
  console.log(`  ${label.padEnd(14)} ${(statSync(p).size / 1024 / 1024).toFixed(2)} MB   ${size ? `${size.width}x${size.height}` : 'not a PNG'}   ${p}`);
}

const size = existsSync(cachedPng) ? pngSize(cachedPng) : null;
const expected = { width: Math.round(frameWidth * RENDER_SCALE), height: Math.round(frameHeight * RENDER_SCALE) };
if (size && size.width === expected.width && size.height === expected.height) {
  console.log(`\n  Dimensions match the pinned frame exactly. Render is usable for section cropping.`);
} else if (size) {
  console.log(`\n  WARNING: expected ${expected.width}x${expected.height}, got ${size.width}x${size.height}.` +
    ` Figma may have clamped the export; crop maths must be scaled from the ACTUAL size, not the requested one.`);
}
console.log('');
