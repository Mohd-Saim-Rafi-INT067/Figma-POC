/**
 * Phase 2 day-1 spike - ground-truth sheets for hand-scoring correspondence.
 *
 *   node src/correspond/spike.js [runDir]
 *
 * The plan is emphatic that this runs BEFORE any matcher code: if the model
 * hallucinates matches, that is one day spent instead of three weeks. Scoring
 * needs a human deciding what the right answer IS, element by element, and this
 * generates the sheet they fill in.
 *
 * Three pairs, chosen for what each one stresses rather than for being
 * representative - a matcher that handles these handles the page:
 *
 *   f12->w13  the pair the plan named as worst (380 vs 142 IR nodes). Collapse
 *             took it to 25/36, so this asks whether E1 actually fixed it.
 *   f17->w18  worst ratio at 2.88 - a footer designed with 11 links and built
 *             with 52. Stresses extra-in-web and the repeated-group boundary.
 *   f14->w15  worst ceiling at 0.64/0.40 - the pair most likely to fail. If
 *             correspondence works here it works anywhere.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_PAIRS = [
  { figmaIndex: 12, webIndex: 13, why: 'the plan\'s named worst case - 380 vs 142 IR nodes before collapse' },
  { figmaIndex: 17, webIndex: 18, why: 'worst ratio (2.88) - designed with 11 footer links, built with 52' },
  { figmaIndex: 14, webIndex: 15, why: 'worst ceiling (0.64/0.40) - the pair most likely to fail' },
];

const short = (s, n) => (!s ? '-' : s.length <= n ? s : `...${s.slice(-(n - 3))}`);

function table(elements, side) {
  const lines = [
    `| # | id | class | x | y | w | h | text | tpl | truth |`,
    `|---|---|---|--:|--:|--:|--:|:--:|---|---|`,
  ];
  for (const el of elements) {
    const id = side === 'figma' ? el.sourceRef.figmaNodeId : short(el.sourceRef.webSelector, 46);
    const tpl = el.templateId ? `${el.templateId.split(':').at(-1)}.${el.templateIndex}` : '';
    lines.push(
      `| ${el.orderIndex} | \`${id}\` | ${el.cls} | ${Math.round(el.box.x)} | ${Math.round(el.box.y)} | ` +
      `${Math.round(el.box.w)} | ${Math.round(el.box.h)} | ${el.hasText ? 'Y' : ''} | ${tpl} |  |`
    );
  }
  return lines.join('\n');
}

function sheet(pair, why) {
  const { figma, web, figmaIndex, webIndex, confidence } = pair;
  return `# Spike ground truth — figma section ${figmaIndex} → web section ${webIndex}

**Why this pair:** ${why}

Section match confidence ${confidence}. Elements: **${figma.elements.length} figma / ${web.elements.length} web**.
Boxes are section-relative; both sides rendered at the same 1920px width, so \`x\` and \`w\` are
directly comparable and \`y\` is not — sections differ in height by up to 4.93×.

## How to fill this in

For every FIGMA row, write the \`#\` of the web element it corresponds to in the **truth** column,
or one of:

- \`missing\` — designed but not built
- \`decor\` — design-only decoration a developer would never build (background blobs, vector art)

Then for any WEB row left unclaimed, mark it \`extra\` (built but not designed) in its own truth
column. Leave anything you genuinely cannot decide as \`?\` — those are excluded from scoring rather
than counted against the matcher, and knowing how many there are is itself a result.

**Judge by eye, from the Figma frame and the live page — not from this table.** The table exists so
you can write ids down, not so you can match rows by comparing numbers. A matcher that agrees with
your arithmetic but disagrees with your eyes is not the one we want.

## Figma → web

${table(figma.elements, 'figma')}

## Web elements (mark any unclaimed as \`extra\`)

${table(web.elements, 'web')}

## Scoring, once filled in

Precision is measured over pairs the matcher asserts with confidence ≥ 0.85:

    precision = correct matches / all asserted matches

**The gate is precision > 95%.** Recall is recorded but does not gate — a matcher that declines an
element costs a finding, while a matcher that pairs the wrong two elements produces a *false*
finding, and a report that cries wolf is worse than one that stays quiet.
`;
}

export function generateSpikeSheets(runDir, pairsWanted = DEFAULT_PAIRS) {
  const data = JSON.parse(readFileSync(join(runDir, 'elements.json'), 'utf8'));
  const outDir = join(runDir, 'spike');
  mkdirSync(outDir, { recursive: true });

  const written = [];
  for (const want of pairsWanted) {
    const pair = data.pairs.find((p) => p.figmaIndex === want.figmaIndex && p.webIndex === want.webIndex);
    if (!pair) {
      console.warn(`  skipped f${want.figmaIndex}->w${want.webIndex}: not a matched pair in this run`);
      continue;
    }
    const file = join(outDir, `pair-f${want.figmaIndex}-w${want.webIndex}.md`);
    writeFileSync(file, sheet(pair, want.why));
    written.push({ file, figma: pair.figma.elements.length, web: pair.web.elements.length });
  }
  return written;
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('src/correspond/spike.js');
if (invokedDirectly) {
  const runDir = process.argv[2] || 'out';

  // Extra pairs as `f8-w9 f15-w16 ...`, for extending the benchmark beyond the
  // three sections the original spike used.
  const extra = process.argv.slice(3)
    .map((a) => /^f(\d+)-w(\d+)$/.exec(a.trim()))
    .filter(Boolean)
    .map((m) => ({ figmaIndex: Number(m[1]), webIndex: Number(m[2]), why: 'benchmark extension - unseen validation for the proximity veto' }));

  const written = generateSpikeSheets(runDir, extra.length ? extra : undefined);
  console.log(`\n  Spike sheets for hand-scoring (${written.length}):`);
  for (const w of written) console.log(`    ${w.file}  ${w.figma} figma / ${w.web} web elements`);
  const total = written.reduce((n, w) => n + w.figma + w.web, 0);
  console.log(`\n  ${total} elements to judge. Budget roughly half a day.\n`);
}
