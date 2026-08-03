/**
 * M3 - Web normalizer. Serializer output -> IR (plan 3.1).
 *
 * Mirrors the Figma normalizer: after this, nothing downstream knows what a
 * `display: flex` or a `border-top-left-radius` is.
 */

import { makeNode, makeSnapshot } from '../ir/schema.js';
import { parseCssColor, splitTopLevel, makeColor } from '../ir/color.js';
import { parseCssFontFamily, normalizeCssWeight, familyKey } from '../ir/fonts.js';
import { normalizeText, resolveTextTransform } from '../ir/text.js';

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

const TAG_ROLE = {
  img: 'image', svg: 'icon', picture: 'image', video: 'image', canvas: 'image',
  button: 'button', input: 'input', textarea: 'input', select: 'input',
  hr: 'divider',
};

const ARIA_ROLE = {
  button: 'button', textbox: 'input', searchbox: 'input', combobox: 'input',
  img: 'image', separator: 'divider',
};

function inferRole(n) {
  if (n.isPseudo) {
    // A painting pseudo-element is a decorative bar or an icon glyph.
    const thin = n.rect.h <= 4 || n.rect.w <= 4;
    return { role: thin ? 'divider' : 'icon', roleConfidence: 0.5 };
  }
  if (ARIA_ROLE[n.role]) return { role: ARIA_ROLE[n.role], roleConfidence: 0.9 };
  if (TAG_ROLE[n.tag]) return { role: TAG_ROLE[n.tag], roleConfidence: 0.9 };
  if (n.text) return { role: 'text', roleConfidence: 0.9 };
  if (n.styles['background-image'] && n.styles['background-image'] !== 'none') {
    return { role: 'image', roleConfidence: 0.6 };
  }
  const thin = (n.rect.h <= 2 && n.rect.w > 8) || (n.rect.w <= 2 && n.rect.h > 8);
  if (thin) return { role: 'divider', roleConfidence: 0.5 };
  return { role: 'container', roleConfidence: 0.8 };
}

/**
 * Computed `line-height` can be the keyword `normal`, which has no px value.
 * Chromium's own heuristic is ~1.2x font-size; using that keeps the value
 * comparable to Figma's resolved lineHeightPx rather than emitting null.
 */
function resolveLineHeight(value, fontSizePx) {
  if (!value || value === 'normal') return fontSizePx * 1.2;
  return num(value);
}

/** `letter-spacing: normal` means 0. */
function resolveLetterSpacing(value) {
  if (!value || value === 'normal') return 0;
  return num(value);
}

/**
 * Computed box-shadow: `<color> <x> <y> <blur> <spread>`, possibly `inset`,
 * possibly several comma-separated. Commas inside rgba() make naive splitting
 * wrong, hence splitTopLevel.
 */
function parseShadows(value) {
  if (!value || value === 'none') return [];
  return splitTopLevel(value, ',').map((part) => {
    const inset = /\binset\b/.test(part);
    const body = part.replace(/\binset\b/, '').trim();

    const colorMatch = body.match(/(rgba?\([^)]+\))/i);
    const color = colorMatch ? parseCssColor(colorMatch[1]) : makeColor(0, 0, 0, 1);
    const rest = colorMatch ? body.replace(colorMatch[1], '').trim() : body;

    const lengths = rest.split(/\s+/).filter(Boolean).map(num);
    return {
      type: inset ? 'inner-shadow' : 'drop-shadow',
      x: lengths[0] ?? 0,
      y: lengths[1] ?? 0,
      blur: lengths[2] ?? 0,
      spread: lengths[3] ?? 0,
      color: color ?? makeColor(0, 0, 0, 1),
    };
  });
}

/** `border-radius` can be elliptical ("8px 12px"); the first value is the horizontal radius. */
const radiusOf = (v) => num(String(v || '0').split(/\s+/)[0]);

/**
 * Rendered family per declared signature, from the CDP pass.
 * Keyed the same way the sampler grouped them.
 */
function buildRenderedFontIndex(renderedFonts) {
  const index = new Map();
  for (const g of renderedFonts?.signatures || []) {
    index.set(g.signature, g);
  }
  return index;
}

const sigOf = (s) => [s['font-family'], s['font-weight'], s['font-style']].join(' | ');

export function normalizeWeb(raw, meta = {}) {
  const byId = new Map(raw.nodes.map((n) => [n.id, n]));
  const renderedIndex = buildRenderedFontIndex(raw.renderedFonts);
  const nodes = [];
  const warnings = [];
  let unresolvedRendered = 0;

  const root = byId.get(raw.rootId);
  const origin = root ? { x: root.rect.x, y: root.rect.y } : { x: 0, y: 0 };

  for (const n of raw.nodes) {
    const s = n.styles;
    const { role, roleConfidence } = inferRole(n);

    const parent = n.parentId ? byId.get(n.parentId) : null;
    const boxAbsolute = {
      x: n.rect.x - origin.x,
      y: n.rect.y - origin.y,
      w: n.rect.w,
      h: n.rect.h,
    };
    const boxRelative = parent
      ? { x: n.rect.x - parent.rect.x, y: n.rect.y - parent.rect.y, w: n.rect.w, h: n.rect.h }
      : { x: 0, y: 0, w: boxAbsolute.w, h: boxAbsolute.h };

    const fontSizePx = num(s['font-size']);
    const textTransform = resolveTextTransform(s['text-transform']);
    const declaredFamily = parseCssFontFamily(s['font-family']);

    const rendered = renderedIndex.get(sigOf(s));
    if (n.text && !rendered) unresolvedRendered++;

    const type = n.text
      ? {
          fontFamily: declaredFamily,
          // Parent doc 4.1.4 - the whole point of the CDP pass. null means
          // "not probed", which the audit must treat as reduced coverage
          // rather than as a mismatch.
          renderedFontFamily: rendered?.renderedFamily ?? null,
          renderedIsCustomFont: rendered?.isCustomFont ?? null,
          fontWeight: normalizeCssWeight(s['font-weight']),
          fontStyle: s['font-style'] === 'italic' ? 'italic' : 'normal',
          fontSizePx,
          lineHeightPx: resolveLineHeight(s['line-height'], fontSizePx),
          letterSpacingPx: resolveLetterSpacing(s['letter-spacing']),
          // Retained: feeds text normalization for section-matching anchors (S2).
          textTransform,
          color: parseCssColor(s.color),
          familyKey: familyKey(declaredFamily),
        }
      : null;

    const bg = parseCssColor(s['background-color']);
    const borderColor = parseCssColor(s['border-top-color']);

    nodes.push(
      makeNode({
        id: n.id,
        parentId: n.parentId,
        role,
        roleConfidence,
        sourceRef: {
          webPath: n.webPath,
          webSelector: n.webPath,
        },
        boxAbsolute,
        boxRelative,
        // Shadows and outlines paint outside the border box; Phase 3 refines
        // this. For now render box equals layout box.
        renderBox: boxAbsolute,
        rotation: 0, // Baked into getBoundingClientRect (parent doc 4.1.3).
        text: normalizeText(n.text, { textTransform }),
        type,
        fill: {
          backgroundColor: bg,
          gradients: [],
          imageRef: s['background-image'] !== 'none' ? s['background-image'] : null,
          paints: bg && bg.a > 0 ? [bg] : [],
        },
        border: {
          width: [
            num(s['border-top-width']), num(s['border-right-width']),
            num(s['border-bottom-width']), num(s['border-left-width']),
          ],
          color: borderColor,
          radius: [
            radiusOf(s['border-top-left-radius']), radiusOf(s['border-top-right-radius']),
            radiusOf(s['border-bottom-right-radius']), radiusOf(s['border-bottom-left-radius']),
          ],
          // CSS borders are always inside border-box (parent doc 6.5).
          inset: true,
          strokeAlign: 'INSIDE',
          strokeOutset: 0,
        },
        effects: parseShadows(s['box-shadow']),
        layout: {
          direction: s.display?.includes('flex')
            ? (s['flex-direction']?.startsWith('column') ? 'column' : 'row')
            : 'none',
          gapMeasured: null,
          paddingMeasured: [null, null, null, null],
          declared: {
            display: s.display,
            gap: s.gap,
            padding: [
              num(s['padding-top']), num(s['padding-right']),
              num(s['padding-bottom']), num(s['padding-left']),
            ],
          },
        },
        opacity: num(s.opacity || '1'),
        children: n.children,
        // Extractor-private - pruning inputs (parent doc 6.1). Never compared.
        _web: {
          tag: n.tag,
          display: s.display,
          visibility: s.visibility,
          overflowX: s['overflow-x'],
          overflowY: s['overflow-y'],
          position: s.position,
          isPseudo: n.isPseudo,
          context: n.context,
          ariaName: n.ariaName,
          ariaRole: n.role,
          // Still mutating at capture time - a JS animation CSS freezing cannot
          // stop. Findings on these nodes are not trustworthy.
          unstable: n.unstable === true,
        },
      })
    );
  }

  if (unresolvedRendered) {
    warnings.push(
      `${unresolvedRendered} text nodes had no CDP rendered-font probe ` +
        '(shadow DOM, iframes, or probe failure). Reported as reduced coverage, ' +
        'never as a design finding.'
    );
  }
  if (raw.stats.skippedCrossOriginIframes) {
    warnings.push(
      `${raw.stats.skippedCrossOriginIframes} cross-origin iframes skipped ` +
        '(out of scope - parent doc 14.5). Counted so their absence is visible.'
    );
  }

  return makeSnapshot({
    side: 'web',
    sourceVersion: meta.sourceVersion ?? null,
    rootId: raw.rootId,
    nodes,
    meta: {
      pageUrl: raw.page.url,
      title: raw.page.title,
      viewportWidth: meta.viewportWidth ?? null,
      viewportHeight: meta.viewportHeight ?? null,
      scrollHeight: raw.page.scrollHeight,
      stats: raw.stats,
      quiescence: raw.quiescence ?? null,
      loadedFonts: raw.loadedFonts,
      renderedFontCoverage: {
        signatures: raw.renderedFonts?.signatures.length ?? 0,
        probes: raw.renderedFonts?.probes ?? 0,
        failures: raw.renderedFonts?.failures ?? 0,
      },
      warnings,
    },
  });
}
