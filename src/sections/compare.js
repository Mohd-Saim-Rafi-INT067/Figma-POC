/**
 * S3 - Section comparison. V1 plan phase E. Replaces M9 (per-node comparison).
 *
 * Every check here compares an AGGREGATE or a DISTRIBUTION over a matched
 * section pair - never one node against another. That is the property that keeps
 * V1 correspondence-free below the section boundary, and it is what makes the
 * whole thing tractable without a node matcher.
 *
 * Deterministic throughout: no LLM anywhere in this path. Same inputs produce
 * byte-identical findings.
 *
 * NO FINDING MAY CARRY TEXT CONTENT. Text was used in S2 to match sections and
 * is not referenced here at all - design copy and live copy legitimately differ.
 */

import { deltaEOK, toHex, formatColor } from '../ir/color.js';
import { familyKey } from '../ir/fonts.js';

/**
 * CSS generic families resolve to a system font BY DESIGN - `ui-monospace`
 * rendering as Consolas is correct behaviour, not a failed webfont. Observed as
 * a false positive on the first live run.
 */
const CSS_GENERICS = new Set([
  'uimonospace', 'uisansserif', 'uiserif', 'uirounded', 'systemui',
  'sansserif', 'serif', 'monospace', 'cursive', 'fantasy',
  'appplesystem', 'applesystem', 'blinkmacsystemfont', 'inherit', 'initial',
]);

/**
 * Does the rendered family satisfy the declared one?
 *
 * CDP reports the concrete FACE, not the family - "DM Mono" declared can render
 * as "DM Mono Medium". Also observed as a false positive on the first live run.
 */
function renderedFontMatches(declared, rendered) {
  const d = familyKey(declared);
  const r = familyKey(rendered);
  if (!d || !r) return true;            // nothing probed - not a finding
  if (CSS_GENERICS.has(d)) return true; // generic resolving to a system font
  return r === d || r.startsWith(d) || d.startsWith(r);
}

/** Nearest value in a list, plus the distance to it. */
function nearest(value, list) {
  let best = null;
  let dist = Infinity;
  for (const v of list) {
    const d = Math.abs(v - value);
    if (d < dist) { dist = d; best = v; }
  }
  return { value: best, distance: dist };
}

/** Nearest color by perceptual distance, never by hex equality (parent doc 6.2). */
function nearestColor(color, list) {
  let best = null;
  let dist = Infinity;
  for (const c of list) {
    const d = deltaEOK(color, c);
    if (d < dist) { dist = d; best = c; }
  }
  return { color: best, deltaE: dist };
}

const ratio = (a, b) => (a && b ? b / a : null);

/**
 * Findings never carry text. `sample` fields carry only style values.
 */
function makeFinding(pair, category, type, property, fields) {
  return {
    sectionPair: {
      figmaIndex: pair.figma ? pair.figma.index : null,
      webIndex: pair.web ? pair.web.index : null,
      figmaLabel: pair.figma ? pair.figma.label : null,
      webLabel: pair.web ? pair.web.label : null,
      confidence: pair.confidence,
    },
    category,
    type,
    property,
    ...fields,
  };
}

/** Compare one matched section pair. */
function comparePair(pair, tol) {
  const findings = [];
  const f = pair.figma;
  const w = pair.web;
  const df = f.digest;
  const dw = w.digest;
  const sec = tol.section;

  // Sections containing content that was still moving at capture time cannot
  // support trustworthy geometry findings.
  const unstable = dw.unstableNodes > 0;
  const tag = (finding) => (unstable ? { ...finding, lowConfidence: true, reason: 'section contains dynamic content' } : finding);

  // --- geometry ----------------------------------------------------------
  // ABSOLUTE height ratio, not normalized: both sides render at the same
  // viewport width, so pixel heights are directly comparable. See plan 11 Q3 -
  // normalizing folds the total-height difference into every section.
  const hRatio = ratio(f.height, w.height);
  if (hRatio !== null && Math.abs(hRatio - 1) > sec.heightRatio.tolerance) {
    findings.push(tag(makeFinding(pair, 'geometry', 'mismatch', 'section.height', {
      expected: Math.round(f.height),
      actual: Math.round(w.height),
      delta: Math.round(w.height - f.height),
      ratio: +hRatio.toFixed(2),
      tolerance: sec.heightRatio.tolerance,
      severity: Math.abs(hRatio - 1) > sec.heightRatio.tolerance * 3 ? 'high' : sec.heightRatio.severity,
    })));
  }

  const wRatio = ratio(f.width, w.width);
  if (wRatio !== null && Math.abs(wRatio - 1) > 0.02) {
    findings.push(makeFinding(pair, 'geometry', 'mismatch', 'section.width', {
      expected: Math.round(f.width),
      actual: Math.round(w.width),
      delta: Math.round(w.width - f.width),
      severity: 'medium',
    }));
  }

  // NOTE: per-section vertical OFFSET is deliberately not reported. It is
  // mathematically determined by the heights of everything above it, so
  // reporting it would restate every height finding once per following section -
  // the cascade parent doc 7.4 warns about. Total document height is reported
  // once at page level instead.

  // --- background --------------------------------------------------------
  if (df.background && dw.background) {
    const dE = deltaEOK(df.background, dw.background);
    if (dE > sec.backgroundColor.tolerance) {
      findings.push(makeFinding(pair, 'color', 'mismatch', 'section.backgroundColor', {
        expected: formatColor(df.background),
        actual: formatColor(dw.background),
        delta: +dE.toFixed(2),
        tolerance: sec.backgroundColor.tolerance,
        severity: sec.backgroundColor.severity,
      }));
    }
  }

  // --- palette -----------------------------------------------------------
  // A web color with no perceptually-near counterpart in the matched design
  // section. Counts are WEB-SIDE ONLY - the design frame and the live page
  // contain different volumes of content, so cross-side counts are meaningless.
  const figmaColors = df.colors || [];
  const webColors = dw.colors || [];
  const extras = [];
  for (const c of webColors) {
    if (c.count < 2) continue; // a single use is as likely a one-off as a decision
    const { color, deltaE } = nearestColor(c, figmaColors);
    if (!color || deltaE > sec.backgroundColor.tolerance) {
      extras.push({ color: c, deltaE: color ? +deltaE.toFixed(2) : null, nearest: color });
    }
  }
  for (const e of extras.slice(0, 6)) {
    findings.push(makeFinding(pair, 'color', 'extra-in-web', 'section.palette', {
      actual: formatColor(e.color),
      // `expected` stays null deliberately. report/findings.js groupKey() includes
      // it, so putting the per-section nearest colour here would split one
      // off-palette colour seen in 13 sections into 13 separate issues - exactly
      // the fragmentation the grouping exists to prevent. The nearest colour is
      // reported alongside instead, where it informs without regrouping.
      expected: null,
      nearestColorInDesign: e.nearest ? formatColor(e.nearest) : null,
      nearestInDesign: e.deltaE,
      occurrenceCount: e.color.count,
      severity: sec.paletteExtra.severity,
    }));
  }
  if (extras.length > 6) {
    findings.push(makeFinding(pair, 'color', 'extra-in-web', 'section.palette.summary', {
      actual: `${extras.length} colors not in the design section`,
      occurrenceCount: extras.reduce((a, e) => a + e.color.count, 0),
      severity: sec.paletteExtra.severity,
    }));
  }

  // --- typography --------------------------------------------------------
  const figmaFamilies = new Set(df.fontFamilySet.map(familyKey));
  for (const fam of dw.fontFamilySet) {
    if (CSS_GENERICS.has(familyKey(fam))) continue;
    if (!figmaFamilies.has(familyKey(fam))) {
      findings.push(makeFinding(pair, 'typography', 'extra-in-web', 'type.fontFamily', {
        actual: fam,
        expected: df.fontFamilySet.join(', ') || null,
        severity: sec.fontFamilySet.severity,
      }));
    }
  }

  for (const size of dw.fontSizeSet) {
    const { value, distance } = nearest(size, df.fontSizeSet);
    if (value === null || distance > sec.fontSizeSet.tolerance) {
      findings.push(makeFinding(pair, 'typography', 'extra-in-web', 'type.fontSizePx', {
        actual: size,
        expected: value,
        delta: value === null ? null : +(size - value).toFixed(1),
        tolerance: sec.fontSizeSet.tolerance,
        severity: sec.fontSizeSet.severity,
      }));
    }
  }

  const figmaWeights = new Set(df.fontWeightSet);
  for (const weight of dw.fontWeightSet) {
    if (!figmaWeights.has(weight)) {
      findings.push(makeFinding(pair, 'typography', 'extra-in-web', 'type.fontWeight', {
        actual: weight,
        expected: df.fontWeightSet.join('/') || null,
        severity: sec.fontWeightSet.severity,
      }));
    }
  }

  // --- rendered fonts ----------------------------------------------------
  // The highest-value check in the system: a webfont that silently failed to
  // load is invisible to every other method here (parent doc 4.1.4).
  for (const [key, count] of Object.entries(dw.renderedFonts || {})) {
    const [declared, rendered] = key.split('→');
    if (renderedFontMatches(declared, rendered)) continue;
    findings.push(makeFinding(pair, 'font', 'mismatch', 'type.renderedFontFamily', {
      expected: declared,
      actual: rendered,
      occurrenceCount: count,
      severity: 'critical',
    }));
  }

  // --- spacing -----------------------------------------------------------
  const figmaSpacing = Object.keys(df.spacingHistogram || {}).map(Number);
  for (const [valueStr, count] of Object.entries(dw.spacingHistogram || {})) {
    const value = Number(valueStr);
    if (count < 2) continue;
    const { value: near, distance } = nearest(value, figmaSpacing);
    if (near === null || distance > sec.spacingScale.tolerance) {
      findings.push(tag(makeFinding(pair, 'spacing', 'extra-in-web', 'layout.gapMeasured', {
        actual: value,
        expected: near,
        delta: near === null ? null : +(value - near).toFixed(1),
        tolerance: sec.spacingScale.tolerance,
        occurrenceCount: count,
        severity: sec.spacingScale.severity,
      })));
    }
  }

  // --- shape -------------------------------------------------------------
  for (const r of dw.radiusSet) {
    const { value, distance } = nearest(r, df.radiusSet);
    if (value === null || distance > sec.radiusSet.tolerance) {
      findings.push(makeFinding(pair, 'shape', 'extra-in-web', 'border.radius', {
        actual: r,
        expected: value,
        delta: value === null ? null : +(r - value).toFixed(1),
        tolerance: sec.radiusSet.tolerance,
        severity: sec.radiusSet.severity,
      }));
    }
  }

  if (dw.pillRadius && !df.pillRadius) {
    findings.push(makeFinding(pair, 'shape', 'extra-in-web', 'border.radius.pill', {
      actual: 'fully rounded',
      expected: 'no fully-rounded elements in the design section',
      severity: sec.radiusSet.severity,
    }));
  }

  // --- density -----------------------------------------------------------
  const dRatio = ratio(df.nodeCount, dw.nodeCount);
  if (dRatio !== null && Math.abs(dRatio - 1) > sec.densityRatio.tolerance) {
    findings.push(makeFinding(pair, 'structure', 'drift', 'section.nodeCount', {
      expected: df.nodeCount,
      actual: dw.nodeCount,
      ratio: +dRatio.toFixed(2),
      tolerance: sec.densityRatio.tolerance,
      severity: sec.densityRatio.severity,
    }));
  }

  return findings;
}

/**
 * @param {object} alignment  output of S2
 * @param {object} sections   output of S1 (for page-level totals)
 * @param {object} tol        tolerance profile
 */
export function compareSections(alignment, sections, tol) {
  const findings = [];

  // Page-level: total height, reported ONCE rather than smeared across every
  // section as a cumulative offset error.
  const fTotal = sections.figma.totalHeight;
  const wTotal = sections.web.totalHeight;
  const totalRatio = wTotal / fTotal;
  if (Math.abs(totalRatio - 1) > tol.section.heightRatio.tolerance) {
    findings.push({
      sectionPair: null,
      category: 'geometry',
      type: 'mismatch',
      property: 'document.height',
      expected: Math.round(fTotal),
      actual: Math.round(wTotal),
      delta: Math.round(wTotal - fTotal),
      ratio: +totalRatio.toFixed(2),
      severity: 'medium',
    });
  }

  for (const pair of alignment.pairs) {
    if (pair.figma && pair.web) {
      findings.push(...comparePair(pair, tol));
    } else if (pair.figma) {
      findings.push(makeFinding(pair, 'structure', 'missing-in-web', 'section', {
        expected: `${Math.round(pair.figma.height)}px section`,
        actual: null,
        // Reduced severity: much of this gap is legitimately dynamic or
        // restructured content, not an unbuilt design (parent doc 8.6).
        severity: 'medium',
      }));
    } else {
      findings.push(makeFinding(pair, 'structure', 'extra-in-web', 'section', {
        expected: null,
        actual: `${Math.round(pair.web.height)}px section`,
        severity: 'low',
      }));
    }
  }

  return findings;
}
