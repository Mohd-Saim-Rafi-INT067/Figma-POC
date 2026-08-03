/**
 * Text normalization - parent doc 6.4.
 *
 * "Both sides go through the identical function; a shared implementation is
 * required, not two parallel ones." That requirement is the whole point of this
 * module: two normalizers that drift apart by one Unicode class silently destroy
 * every text anchor, and the failure looks like "the matcher is bad" rather than
 * "the normalizers disagree".
 *
 * Pipeline (in order):
 *   trim -> collapse internal whitespace -> strip zero-width -> unify spaces
 *        -> NFC -> apply resolved text-transform -> casefold
 */

/** Zero-width and invisible formatting characters. */
const ZERO_WIDTH = /[​-‍⁠﻿­]/g;

/** Everything Unicode considers a space, unified to U+0020. */
const UNICODE_SPACES = /[   -   　]/g;

/**
 * Map both sides' text-transform vocabularies onto one enum.
 * Figma: UPPER / LOWER / TITLE / ORIGINAL / SMALL_CAPS
 * CSS:   uppercase / lowercase / capitalize / none
 */
export function resolveTextTransform(value) {
  switch (String(value || '').toUpperCase()) {
    case 'UPPER':
    case 'UPPERCASE':
      return 'uppercase';
    case 'LOWER':
    case 'LOWERCASE':
      return 'lowercase';
    case 'TITLE':
    case 'CAPITALIZE':
      return 'capitalize';
    default:
      return 'none';
  }
}

export function applyTextTransform(text, transform) {
  switch (transform) {
    case 'uppercase':
      return text.toUpperCase();
    case 'lowercase':
      return text.toLowerCase();
    case 'capitalize':
      return text.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
    default:
      return text;
  }
}

/**
 * The shared normalizer. Both extractors call this and nothing else.
 *
 * Note: applying the text-transform before casefolding is a no-op for matching
 * purposes, since casefold subsumes it. It is kept because parent doc 6.4
 * specifies it, and because `display: true` returns the transformed-but-not-
 * casefolded string, which the report needs in order to quote text as the user
 * actually sees it.
 */
export function normalizeText(raw, { textTransform = 'none', display = false } = {}) {
  if (raw === null || raw === undefined) return null;

  let s = String(raw)
    .replace(ZERO_WIDTH, '')
    .replace(UNICODE_SPACES, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFC');

  if (!s) return null;

  s = applyTextTransform(s, textTransform);
  return display ? s : s.toLowerCase();
}

/** Stable short hash for the (webPath, role, textHash) mapping key - parent doc 5.1. */
export function textHash(normalized) {
  if (!normalized) return null;
  // FNV-1a. Not cryptographic - it only needs to be stable and cheap.
  let h = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Dates, prices, counts, times. Parent doc 8.2 down-weights these as anchors
 * because they are the most likely thing to differ between a static design and
 * live content - "1,204 users" in Figma vs "3,981 users" in production.
 */
export function isNumericLike(normalized) {
  if (!normalized) return false;
  const letters = (normalized.match(/\p{L}/gu) || []).length;
  const digits = (normalized.match(/\p{Nd}/gu) || []).length;
  if (digits === 0) return false;
  // Mostly digits, or a recognizable date/time/money/percent shape.
  if (digits >= letters) return true;
  return /^[\p{Sc}]?[\d.,:/\s-]+%?$/u.test(normalized);
}
