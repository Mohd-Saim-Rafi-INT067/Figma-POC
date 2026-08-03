/**
 * Color normalization - doc section 6.2.
 *
 * Both sides converge on a single Color shape:
 *   { r, g, b, a, oklch: [L, C, H] }
 * where r/g/b are 0-255 integers and a is 0-1.
 *
 * Comparison is always via deltaEOK, never hex equality: Figma stores paints as
 * 0-1 floats and CSS reports 0-255 integers, so float round-tripping alone makes
 * exact comparison generate permanent false findings.
 */

/** sRGB 0-1 channel -> linear-light. */
function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** linear-light channel -> sRGB 0-1. */
function linearToSrgb(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/**
 * sRGB (0-255) -> OKLab. Bjorn Ottosson's matrices.
 * Returns [L, a, b] where L is 0-1.
 */
export function rgbToOklab(r, g, b) {
  const lr = srgbToLinear(r / 255);
  const lg = srgbToLinear(g / 255);
  const lb = srgbToLinear(b / 255);

  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
  ];
}

/** OKLab -> sRGB (0-255, clamped). Used to render swatches in the report. */
export function oklabToRgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  const lr = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;

  const clamp = (c) => Math.max(0, Math.min(255, Math.round(linearToSrgb(c) * 255)));
  return [clamp(lr), clamp(lg), clamp(lb)];
}

/**
 * OKLab -> OKLCH. Hue in degrees 0-360.
 *
 * Below the achromatic threshold BOTH chroma and hue are pinned to 0. Pinning
 * only the hue leaves chroma carrying float dust - #808080 comes out at
 * 2.24e-8 rather than 0 - which makes "is this grey" platform-dependent and
 * turns any exact comparison on the channel into a coin flip.
 */
const ACHROMATIC = 1e-6;

export function oklabToOklch(L, a, b) {
  const C = Math.sqrt(a * a + b * b);
  if (C < ACHROMATIC) return [L, 0, 0];
  return [L, C, ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360];
}

/** Build the canonical Color object from sRGB 0-255 + alpha 0-1. */
export function makeColor(r, g, b, a = 1) {
  const ri = Math.max(0, Math.min(255, Math.round(r)));
  const gi = Math.max(0, Math.min(255, Math.round(g)));
  const bi = Math.max(0, Math.min(255, Math.round(b)));
  const [L, A, B] = rgbToOklab(ri, gi, bi);
  return {
    r: ri,
    g: gi,
    b: bi,
    a: Math.max(0, Math.min(1, a)),
    oklch: oklabToOklch(L, A, B),
  };
}

/** Figma paint colors are rgba floats 0-1. */
export function makeColorFromFigma({ r, g, b, a = 1 }, effectiveAlpha = null) {
  return makeColor(r * 255, g * 255, b * 255, effectiveAlpha === null ? a : effectiveAlpha);
}

/**
 * Perceptual color distance in OKLab, scaled by 100.
 *
 * Raw OKLab euclidean distance puts a just-noticeable difference around 0.02,
 * which makes for awkward tolerance values. Scaling by 100 puts the numbers on
 * roughly the same footing as classic CIE deltaE units, so the doc's
 * "deltaE_OK <= 2.0" default reads as a small-but-visible difference.
 */
export function deltaEOK(c1, c2) {
  const [l1, a1, b1] = rgbToOklab(c1.r, c1.g, c1.b);
  const [l2, a2, b2] = rgbToOklab(c2.r, c2.g, c2.b);
  const dL = l1 - l2;
  const da = a1 - a2;
  const db = b1 - b2;
  return 100 * Math.sqrt(dL * dL + da * da + db * db);
}

/**
 * Composite a foreground color over a backdrop - doc section 6.2.
 * Where alpha < 1 we judge the color the user actually sees, not the declared one.
 */
export function compositeOver(fg, bg) {
  if (fg.a >= 1) return fg;
  if (fg.a <= 0) return bg;
  const a = fg.a;
  return makeColor(
    fg.r * a + bg.r * (1 - a),
    fg.g * a + bg.g * (1 - a),
    fg.b * a + bg.b * (1 - a),
    1
  );
}

/** Stable key for grouping identical colors in the palette histogram. */
export function colorKey(c) {
  return `${c.r},${c.g},${c.b},${c.a.toFixed(3)}`;
}

export function toHex(c) {
  const h = (n) => n.toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`.toUpperCase();
}

/** Human-readable form used throughout the report. */
export function formatColor(c) {
  return c.a >= 1 ? toHex(c) : `${toHex(c)} @ ${Math.round(c.a * 100)}%`;
}

export function isTransparent(c) {
  return !c || c.a <= 0.001;
}

/**
 * Parse a CSS *computed* color value.
 *
 * `getComputedStyle` always resolves to `rgb(...)` / `rgba(...)` in Chromium,
 * so this deliberately does NOT handle named colors, hex, hsl(), or var() -
 * those never appear in computed values. Modern Chromium also emits the space-
 * separated `rgb(r g b / a)` form, so both syntaxes are accepted.
 *
 * `transparent` computes to `rgba(0, 0, 0, 0)`, which parses correctly and
 * yields alpha 0 - the caller decides whether that means "no paint".
 */
export function parseCssColor(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (s === 'transparent' || s === 'none') return makeColor(0, 0, 0, 0);

  const m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (!m) return null;

  // "0, 0, 0, 0.5" or "0 0 0 / 50%"
  const parts = m[1].split('/');
  const rgb = parts[0].trim().split(/[\s,]+/).filter(Boolean);
  if (rgb.length < 3) return null;

  const num = (t) => (t.endsWith('%') ? (parseFloat(t) / 100) * 255 : parseFloat(t));
  const r = num(rgb[0]);
  const g = num(rgb[1]);
  const b = num(rgb[2]);

  let a = 1;
  const alphaToken = parts.length > 1 ? parts[1].trim() : rgb[3];
  if (alphaToken !== undefined) {
    a = alphaToken.endsWith('%') ? parseFloat(alphaToken) / 100 : parseFloat(alphaToken);
  }
  if (![r, g, b, a].every(Number.isFinite)) return null;

  return makeColor(r, g, b, a);
}

/**
 * Split a comma-separated CSS list without breaking inside parentheses.
 * `box-shadow: rgba(0,0,0,.1) 0 1px 2px, rgba(0,0,0,.2) 0 2px 4px` must split
 * into two shadows, not five fragments.
 */
export function splitTopLevel(value, separator = ',') {
  const out = [];
  let depth = 0;
  let current = '';
  for (const ch of String(value)) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === separator && depth === 0) {
      out.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}
