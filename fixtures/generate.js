/**
 * Fixture generator - builds an HTML page FROM the Figma IR.
 *
 * The point: a page generated from the design should compare against that same
 * design with (near) nothing to report. Every finding on the unmutated fixture
 * is a false positive with nowhere to hide - there is no "well, maybe the page
 * really is like that" escape, because the page was built from the design.
 *
 * The generated markup is deliberately prune-resistant: every element paints
 * something, nothing is display:none or zero-area, and sections are direct
 * children of <body>. Otherwise P5 would rewrite the tree and we would be
 * testing the generator rather than the comparison engine.
 */

import { toHex } from '../src/ir/color.js';

const px = (n) => `${Math.round(n * 100) / 100}px`;

/** Colours the digest carries, most-used first, capped so markup stays sane. */
function swatches(digest, limit = 14) {
  return (digest.colors || []).slice(0, limit);
}

/**
 * Reproduce a section's spacing histogram literally: a column with gap G and
 * N+1 children yields exactly N measured gaps of G.
 */
function spacingStacks(digest, fill) {
  const entries = Object.entries(digest.spacingHistogram || {})
    .map(([g, n]) => [Number(g), n])
    .filter(([g]) => g > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);

  return entries.map(([gap, count]) => {
    const kids = Array.from({ length: Math.min(count, 12) + 1 })
      .map(() => `<div style="width:24px;height:6px;background:${fill}"></div>`)
      .join('');
    return `<div style="display:flex;flex-direction:column;gap:${px(gap)};align-items:flex-start">${kids}</div>`;
  }).join('');
}

function typography(digest, fill) {
  const families = digest.fontFamilySet.length ? digest.fontFamilySet : ['sans-serif'];
  const sizes = digest.fontSizeSet.length ? digest.fontSizeSet : [16];
  const weights = digest.fontWeightSet.length ? digest.fontWeightSet : [400];

  // One sample per size and per weight - the digest compares SETS, so covering
  // each distinct value once is exactly equivalent to the design's set.
  const bySize = sizes.slice(0, 20).map((s, i) =>
    `<p style="margin:0;font-family:'${families[i % families.length]}',sans-serif;` +
    `font-size:${px(s)};font-weight:${weights[0]};color:${fill};line-height:1.2">Sample copy</p>`
  ).join('');

  const byWeight = weights.slice(0, 10).map((w, i) =>
    `<p style="margin:0;font-family:'${families[i % families.length]}',sans-serif;` +
    `font-size:${px(sizes[0])};font-weight:${w};color:${fill};line-height:1.2">Sample copy</p>`
  ).join('');

  const byFamily = families.slice(0, 8).map((f) =>
    `<p style="margin:0;font-family:'${f}',sans-serif;font-size:${px(sizes[0])};` +
    `font-weight:${weights[0]};color:${fill};line-height:1.2">Sample copy</p>`
  ).join('');

  return bySize + byWeight + byFamily;
}

function shapes(digest, fill) {
  const radii = (digest.radiusSet || []).slice(0, 12).map((r) =>
    `<div style="width:48px;height:48px;background:${fill};border-radius:${px(r)}"></div>`
  ).join('');
  const pill = digest.pillRadius
    ? `<div style="width:96px;height:32px;background:${fill};border-radius:9999px"></div>`
    : '';
  return radii + pill;
}

/** @param {object} section  one entry from S1's section list (figma side) */
export function renderSection(section, mutation = null) {
  const d = section.digest;
  const bg = d.background ? toHex(d.background) : '#ffffff';
  const cols = swatches(d);
  const fill = cols.length ? toHex(cols[0]) : '#111111';
  const height = mutation?.height ?? section.height;

  const colorBlocks = cols.map((c) =>
    `<div style="width:36px;height:36px;background:${toHex(c)}"></div>`
  ).join('');

  const extra = mutation?.extraHtml ?? '';

  // overflow:visible on purpose - overflow:hidden would make P5 clip-prune the
  // content we just generated, and we would be measuring the pruner.
  return `<section data-fixture-section="${section.index}" style="
      box-sizing:border-box;width:100%;height:${px(height)};background:${bg};
      position:relative;overflow:visible;padding:0;margin:0;display:flex;
      flex-wrap:wrap;gap:0;align-content:flex-start">
    <div style="display:flex;gap:0;background:${bg}">${colorBlocks}</div>
    <div style="display:flex;flex-direction:column;gap:0;background:${bg}">${typography(d, fill)}</div>
    <div style="display:flex;gap:0;background:${bg}">${shapes(d, fill)}</div>
    <div style="display:flex;gap:0;background:${bg}">${spacingStacks(d, fill)}</div>
    ${extra}
  </section>`;
}

/**
 * @param {object[]} sections  figma-side sections from S1
 * @param {object}   opts      { width, mutations: Map<sectionIndex, mutation> }
 */
export function generateFixture(sections, opts = {}) {
  const width = opts.width ?? 1920;
  const mutations = opts.mutations ?? new Map();

  const body = sections
    .map((s) => renderSection(s, mutations.get(s.index) ?? null))
    .join('\n');

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>fixture</title>
<style>
  html,body { margin:0; padding:0; }
  body { width:${width}px; }
  * { box-sizing:border-box; }
</style>
</head>
<body>
${body}
</body></html>`;
}
