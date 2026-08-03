/**
 * Validation harness. `npm run validate`
 *
 * Two runs against a page generated from the Figma design itself:
 *
 *   1. CLEAN    — the fixture reproduces the design. Whatever it reports is the
 *                 engine's false-positive floor, measured rather than assumed.
 *   2. MUTATED  — known deviations injected. Findings must be exactly
 *                 baseline + the expected set: no misses, no extras.
 *
 * Diffing against the measured baseline rather than asserting a hard zero is
 * deliberate. The fixture cannot load the design's webfonts, so a handful of
 * font findings are unavoidable and would otherwise drown the signal. The
 * baseline number is itself a result worth reporting.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveConfig } from '../src/config.js';
import { stageFigmaExtract, stageFigmaNormalize } from '../src/figma/stage.js';
import { extractWeb } from '../src/web/extract.js';
import { normalizeWeb } from '../src/web/normalize.js';
import { pruneSnapshot } from '../src/pipeline/prune.js';
import { measureSpacing } from '../src/pipeline/spacing.js';
import { segmentSnapshot } from '../src/sections/segment.js';
import { alignSections } from '../src/sections/match.js';
import { compareSections } from '../src/sections/compare.js';
import { assembleFindings } from '../src/report/findings.js';
import { generateFixture } from './generate.js';
import { buildMutations, toMutationMap } from './mutations.js';

const C = { r: '\x1b[0m', d: '\x1b[2m', b: '\x1b[1m', g: '\x1b[32m', y: '\x1b[33m', red: '\x1b[31m' };

const prep = (snapshot) => measureSpacing(pruneSnapshot(snapshot).snapshot).snapshot;

async function auditFixture(html, name, config, figmaSections, figmaSegments) {
  const dir = resolve(config.root, 'out', 'fixtures');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.html`);
  writeFileSync(file, html);

  const raw = await extractWeb(
    { ...config, pageUrl: pathToFileURL(file).href },
    { skipFonts: true }  // no webfonts in a local fixture; nothing to probe
  );
  const web = prep(normalizeWeb(raw, { viewportWidth: config.viewportWidth, viewportHeight: config.viewportHeight }));
  const webSegments = segmentSnapshot(web, config.tolerance.segmentation);

  const alignment = alignSections(figmaSections, webSegments.sections, config.tolerance.matching);
  const sections = { figma: figmaSegments, web: webSegments };
  const findings = compareSections(alignment, sections, config.tolerance);
  const assembled = assembleFindings(findings, config.tolerance);

  return { file, alignment, assembled, sectionCount: webSegments.sections.length };
}

/** Identity of a finding for set-difference purposes. */
const key = (f) =>
  `${f.category}|${f.property}|${f.expected}|${f.actual}|` +
  f.sections.map((s) => `${s.figmaIndex}`).sort().join(',');

async function main() {
  const config = resolveConfig();

  // --- figma side (cached; unchanged across both runs) ---------------------
  const ctx = { config, flags: {}, snapshots: {}, diagnostics: {} };
  await stageFigmaExtract(ctx);
  await stageFigmaNormalize(ctx);
  const figma = prep(ctx.snapshots.figma);
  const figmaSegments = segmentSnapshot(figma, config.tolerance.segmentation);
  const figmaSections = figmaSegments.sections;

  console.log(`\n${C.b}VALIDATION HARNESS${C.r}`);
  console.log(`${C.d}design: ${figmaSections.length} sections, ${Math.round(figmaSegments.totalHeight)}px${C.r}\n`);

  // --- 1. clean ------------------------------------------------------------
  const cleanHtml = generateFixture(figmaSections, { width: config.viewportWidth });
  const clean = await auditFixture(cleanHtml, 'clean', config, figmaSections, figmaSegments);

  const sectionsMatch = clean.sectionCount === figmaSections.length;
  console.log(
    `  ${C.b}CLEAN${C.r}    sections ${clean.sectionCount}/${figmaSections.length} ` +
    `${sectionsMatch ? C.g + 'ok' : C.red + 'MISMATCH'}${C.r}   ` +
    `matched ${clean.alignment.stats.matched}   ` +
    `baseline findings ${C.b}${clean.assembled.findings.length}${C.r}`
  );
  const byCat = clean.assembled.counts.byCategory;
  if (clean.assembled.findings.length) {
    console.log(`  ${C.d}baseline by category: ${Object.entries(byCat).map(([k, v]) => `${k}:${v}`).join('  ')}${C.r}`);
  }

  // --- 2. mutated ----------------------------------------------------------
  const mutations = buildMutations(figmaSections);
  const mutatedHtml = generateFixture(figmaSections, {
    width: config.viewportWidth,
    mutations: toMutationMap(mutations),
  });
  const mutated = await auditFixture(mutatedHtml, 'mutated', config, figmaSections, figmaSegments);

  console.log(
    `  ${C.b}MUTATED${C.r}  sections ${mutated.sectionCount}/${figmaSections.length}   ` +
    `findings ${C.b}${mutated.assembled.findings.length}${C.r}\n`
  );

  // --- assert --------------------------------------------------------------
  const baseline = new Set(clean.assembled.findings.map(key));
  const introduced = mutated.assembled.findings.filter((f) => !baseline.has(key(f)));

  console.log(`  ${C.b}INJECTED DEVIATIONS${C.r}`);
  let misses = 0;
  const claimed = new Set();
  for (const m of mutations) {
    const hit = introduced.find((f) => m.expect(f));
    if (hit) claimed.add(key(hit));
    else misses++;
    console.log(
      `   ${hit ? C.g + 'FOUND ' : C.red + 'MISSED'}${C.r}  ${m.id.padEnd(20)} ${C.d}${m.describe}${C.r}`
    );
  }

  const extras = introduced.filter((f) => !claimed.has(key(f)));
  console.log(`\n  ${C.b}UNEXPECTED FINDINGS${C.r} ${C.d}(introduced by mutation but not asked for)${C.r}`);
  if (!extras.length) {
    console.log(`   ${C.g}none${C.r}`);
  } else {
    for (const f of extras.slice(0, 12)) {
      console.log(
        `   ${C.y}${f.severity.padEnd(8)}${C.r} ${f.property.padEnd(26)} ` +
        `design ${String(f.expected).slice(0, 14).padEnd(15)} page ${String(f.actual).slice(0, 14)} ` +
        `${C.d}§${f.sections.map((s) => s.figmaIndex + 1).join(',')}${C.r}`
      );
    }
    if (extras.length > 12) console.log(`   ${C.d}… and ${extras.length - 12} more${C.r}`);
  }

  const ok = misses === 0 && extras.length === 0 && sectionsMatch;
  console.log(
    `\n  ${ok ? C.g + C.b + 'PASS' : C.red + C.b + 'FAIL'}${C.r}  ` +
    `${mutations.length - misses}/${mutations.length} deviations detected, ` +
    `${extras.length} unexpected, baseline ${clean.assembled.findings.length}\n`
  );

  writeFileSync(
    join(config.outDir, 'validation.json'),
    JSON.stringify(
      {
        baseline: { findings: clean.assembled.findings.length, byCategory: byCat, sections: clean.sectionCount },
        mutated: { findings: mutated.assembled.findings.length, introduced: introduced.length },
        deviations: mutations.map((m) => ({ id: m.id, describe: m.describe, detected: introduced.some((f) => m.expect(f)) })),
        unexpected: extras.map((f) => ({ property: f.property, expected: f.expected, actual: f.actual, severity: f.severity })),
        pass: ok,
      },
      null,
      2
    )
  );

  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n${C.red}harness failed:${C.r} ${err.stack}\n`);
  process.exit(2);
});
