/**
 * Deliberate, known deviations injected into the generated fixture.
 *
 * Each mutation states what it changes AND what finding it must produce. The
 * harness then asserts on both directions:
 *
 *   - every expected finding appeared   -> no blind spots
 *   - no unexpected finding appeared    -> no false positives
 *
 * A mutation that is "obviously" detectable is still worth injecting: the
 * failure mode this guards against is a check that silently stopped running.
 */

const px = (n) => `${n}px`;

/**
 * Every mutation must change exactly ONE property.
 *
 * The first version of this file used arbitrary hex fills (#123456) and left
 * font-family unset, so a spacing mutation also introduced an off-palette
 * colour and a font-size mutation also introduced Times New Roman. The harness
 * dutifully reported all of them as unexpected findings - correctly, because
 * they *were* deviations, just not the ones under test.
 *
 * Borrowing the section's own colour and family keeps each mutation isolated.
 */
const paletteFill = (section) => {
  const c = section.digest.colors?.[0];
  if (!c) return '#000000';
  const h = (n) => n.toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
};

const nativeFamily = (section) => section.digest.fontFamilySet?.[0] ?? 'sans-serif';

export function buildMutations(figmaSections) {
  // Pick well-separated sections so one mutation cannot mask another.
  const pick = (i) => figmaSections[Math.min(i, figmaSections.length - 1)];

  const tall = pick(4);
  const palette = pick(2);
  const spacing = pick(6);
  const radius = pick(8);
  const type = pick(10);

  return [
    {
      id: 'section-height',
      describe: `section ${tall.index + 1} rendered 60% taller than designed`,
      sectionIndex: tall.index,
      apply: () => ({ height: Math.round(tall.height * 1.6) }),
      expect: (f) =>
        f.property === 'section.height' &&
        f.sections.some((s) => s.figmaIndex === tall.index),
    },
    {
      id: 'off-palette-color',
      describe: `an off-palette colour (#FF00AA) painted in section ${palette.index + 1}`,
      sectionIndex: palette.index,
      apply: () => ({
        extraHtml: Array.from({ length: 6 })
          .map(() => '<div style="width:40px;height:40px;background:#FF00AA"></div>')
          .join(''),
      }),
      expect: (f) =>
        f.property.startsWith('section.palette') &&
        f.sections.some((s) => s.figmaIndex === palette.index),
    },
    {
      id: 'off-scale-spacing',
      describe: `a 13px gap (off the 4px scale) in section ${spacing.index + 1}`,
      sectionIndex: spacing.index,
      apply: () => ({
        extraHtml:
          `<div style="display:flex;flex-direction:column;gap:${px(13)};align-items:flex-start">` +
          Array.from({ length: 7 })
            .map(() => `<div style="width:30px;height:8px;background:${paletteFill(spacing)}"></div>`)
            .join('') +
          '</div>',
      }),
      expect: (f) =>
        f.property === 'layout.gapMeasured' &&
        Number(f.actual) === 13 &&
        f.sections.some((s) => s.figmaIndex === spacing.index),
    },
    {
      id: 'off-scale-radius',
      describe: `a 37px corner radius in section ${radius.index + 1}`,
      sectionIndex: radius.index,
      apply: () => ({
        extraHtml:
          `<div style="width:120px;height:120px;background:${paletteFill(radius)};border-radius:37px"></div>`,
      }),
      expect: (f) =>
        f.property === 'border.radius' &&
        Number(f.actual) === 37 &&
        f.sections.some((s) => s.figmaIndex === radius.index),
    },
    {
      id: 'off-scale-font-size',
      describe: `a 47px font size in section ${type.index + 1}`,
      sectionIndex: type.index,
      apply: () => ({
        extraHtml:
          `<p style="margin:0;font-family:'${nativeFamily(type)}',sans-serif;font-size:47px;font-weight:${type.digest.fontWeightSet[0] ?? 400};color:${paletteFill(type)};line-height:1.2">Oversized</p>`,
      }),
      expect: (f) =>
        f.property === 'type.fontSizePx' &&
        Number(f.actual) === 47 &&
        f.sections.some((s) => s.figmaIndex === type.index),
    },
  ];
}

/** Merge per-section mutations into the shape generate.js expects. */
export function toMutationMap(mutations) {
  const map = new Map();
  for (const m of mutations) {
    const prev = map.get(m.sectionIndex) ?? {};
    const next = m.apply();
    map.set(m.sectionIndex, {
      ...prev,
      ...next,
      extraHtml: (prev.extraHtml ?? '') + (next.extraHtml ?? ''),
    });
  }
  return map;
}
