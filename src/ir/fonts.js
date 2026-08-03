/**
 * Font identity resolution - parent doc 6.3, and plan section 9 Q8.
 *
 * ## Why this module is load-bearing rather than a convenience
 *
 * The parent doc treats PostScript -> (family, weight, style) as a nicety for
 * matching Figma's "Inter-SemiBold" against CSS `Inter` + `600`. The 2026-07-30
 * spike showed it is the ONLY valid source of font weight on the Figma side.
 *
 * Figma's REST API reports a VARIABLE FONT'S RAW WEIGHT-AXIS VALUE in
 * `style.fontWeight` - and reports both schemes for the same face depending on
 * the node. On the target file (Geist):
 *
 *     Geist-Regular   -> fontWeight 84  (x64)  and 400
 *     Geist-Medium    -> fontWeight 106 (x7)   and 500
 *     Geist-SemiBold  -> fontWeight 126 (x40)  and 600
 *     Geist-Bold      -> fontWeight 146 (x26)  and 700
 *     Geist-Black     -> fontWeight 176 (x2)   and 900
 *
 * The axis-to-CSS ratio hovers near 4.76x but is not consistent enough to invert
 * (400/84 = 4.76, 900/176 = 5.11), so arithmetic conversion is not an option.
 *
 * Taken at face value, `style.fontWeight` would make the audit announce
 * "the design uses 10 font weights, the page uses 4" and emit five phantom
 * violations, all false. So: the PostScript name wins whenever it parses.
 *
 * This generalizes to every variable font, not just Geist.
 */

/**
 * Weight keywords as they appear in PostScript names.
 * Order is irrelevant here - matching sorts by length descending, so
 * "SemiBold" beats "Bold" and "ExtraLight" beats "Light".
 */
const WEIGHT_KEYWORDS = {
  hairline: 100,
  thin: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  normal: 400,
  regular: 400,
  book: 400,
  roman: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  demi: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  black: 900,
  heavy: 900,
  extrablack: 950,
  ultrablack: 950,
};

const KEYWORDS_BY_LENGTH = Object.keys(WEIGHT_KEYWORDS).sort((a, b) => b.length - a.length);

/** Foundry suffixes that are not style information. */
const NOISE_TOKENS = /(mt|ps|std|pro|ce|tt|otf|ttf|variablefont|vf|display|text|caption|subhead)$/;

const ITALIC = /(italic|oblique|ital)/;

/**
 * A CSS font-weight is 1-1000, and in practice always a multiple of 50.
 * Variable-axis values (84, 106, 126, 146, 176) are not, which is exactly the
 * signal we use to reject them.
 */
export function isPlausibleCssWeight(w) {
  return Number.isFinite(w) && w >= 100 && w <= 1000 && w % 50 === 0;
}

/** Strip everything but letters, lowercase. "DM Mono" and "DMMono" collapse to the same key. */
export function familyKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Parse a PostScript name into weight + style.
 * Returns null when nothing recognizable is present ("Arial", "Helvetica").
 *
 *   "Geist-SemiBold"    -> { weight: 600, italic: false }
 *   "Inter-BoldItalic"  -> { weight: 700, italic: true }
 *   "Arial-BoldMT"      -> { weight: 700, italic: false }
 *   "DMMono-Regular"    -> { weight: 400, italic: false }
 */
export function parsePostScriptName(psName) {
  if (!psName) return null;

  const raw = String(psName);
  // Style info lives after the last dash; without one, scan the whole name.
  const dash = raw.lastIndexOf('-');
  let tail = (dash >= 0 ? raw.slice(dash + 1) : raw).toLowerCase().replace(/[^a-z]/g, '');

  const italic = ITALIC.test(tail);
  tail = tail.replace(ITALIC, '');
  tail = tail.replace(NOISE_TOKENS, '');

  for (const kw of KEYWORDS_BY_LENGTH) {
    if (tail.includes(kw)) {
      return { weight: WEIGHT_KEYWORDS[kw], italic, source: 'postscript' };
    }
  }

  // "Inter-Italic" carries style but no weight keyword - that is regular italic.
  if (italic) return { weight: 400, italic: true, source: 'postscript' };
  return null;
}

/**
 * Resolve a Figma TEXT node's font identity.
 *
 * Precedence, and the reason for it:
 *   1. PostScript name  - authoritative (Q8)
 *   2. style.fontWeight - only when plausibly a CSS weight
 *   3. 400              - last resort, flagged so the report can say so
 */
export function resolveFigmaFont(style = {}) {
  const family = style.fontFamily || null;
  const parsed = parsePostScriptName(style.fontPostScriptName);

  if (parsed) {
    return {
      family,
      familyKey: familyKey(family),
      weight: parsed.weight,
      style: parsed.italic ? 'italic' : 'normal',
      weightSource: 'postscript',
      postScriptName: style.fontPostScriptName || null,
    };
  }

  const declared = style.fontWeight;
  if (isPlausibleCssWeight(declared)) {
    return {
      family,
      familyKey: familyKey(family),
      weight: declared,
      style: style.italic ? 'italic' : 'normal',
      weightSource: 'figma-fontWeight',
      postScriptName: style.fontPostScriptName || null,
    };
  }

  return {
    family,
    familyKey: familyKey(family),
    weight: 400,
    style: 'normal',
    // Surfaced in the report: an unresolved weight is a normalization gap,
    // not a design finding, and must never be reported as one.
    weightSource: 'fallback',
    unresolvedFigmaWeight: Number.isFinite(declared) ? declared : null,
    postScriptName: style.fontPostScriptName || null,
  };
}

/**
 * First family from a CSS font-family list.
 * `getComputedStyle` returns the declared list verbatim - "Inter, sans-serif" -
 * so the head of the list is the intended family. What ACTUALLY rendered comes
 * from CDP instead (parent doc 4.1.4).
 */
export function parseCssFontFamily(value) {
  if (!value) return null;
  const first = String(value).split(',')[0].trim();
  return first.replace(/^["']|["']$/g, '') || null;
}

/** CSS keyword weights -> numbers. `getComputedStyle` usually resolves these already. */
export function normalizeCssWeight(value) {
  if (value === 'normal') return 400;
  if (value === 'bold') return 700;
  const n = Number(value);
  return Number.isFinite(n) ? n : 400;
}
