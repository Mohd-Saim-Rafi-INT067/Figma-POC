/**
 * Severity and score-band tokens.
 *
 * Two rules these encode, both from the visualisation guidance:
 *
 * 1. Severity and health bands are STATUS, not categorical identity. Status
 *    colours are a reserved, ordered set - they never double as "series 4".
 * 2. A status colour never carries meaning alone. Every token here ships with a
 *    label (and the badge renders a shape too), so the encoding survives
 *    colour-blindness, greyscale printing and forced-colors mode.
 *
 * The raw status hues fail contrast as ink on white - measured, not assumed -
 * so each token is a tinted surface with a dark same-hue text step. Every pair
 * below was checked: worst case 6.84:1, all pass WCAG AA.
 */

import type { Severity } from './types';

export interface Token {
  label: string;
  chip: string; // tinted background + dark same-hue text
  bar: string; // solid fill for meters
  rank: number;
}

export const SEVERITY: Record<Severity, Token> = {
  critical: { label: 'Critical', chip: 'bg-rose-50 text-rose-800 ring-rose-200', bar: 'bg-rose-600', rank: 0 },
  high: { label: 'High', chip: 'bg-orange-50 text-orange-800 ring-orange-200', bar: 'bg-orange-500', rank: 1 },
  medium: { label: 'Medium', chip: 'bg-amber-50 text-amber-800 ring-amber-200', bar: 'bg-amber-400', rank: 2 },
  low: { label: 'Low', chip: 'bg-slate-100 text-slate-700 ring-slate-200', bar: 'bg-slate-400', rank: 3 },
};

export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];

/**
 * Health-score bands.
 *
 * These thresholds are NOT chosen here - they mirror analysis.js STATUS
 * exactly (90 / 75 / 55 / 35). The server sends the status word with the
 * score; this only maps that word to ink.
 */
export const SCORE_BAND: Record<string, { text: string; bar: string; ring: string }> = {
  Excellent: { text: 'text-emerald-800', bar: 'bg-emerald-600', ring: 'ring-emerald-200' },
  Good: { text: 'text-teal-800', bar: 'bg-teal-600', ring: 'ring-teal-200' },
  Fair: { text: 'text-amber-800', bar: 'bg-amber-500', ring: 'ring-amber-200' },
  Poor: { text: 'text-orange-800', bar: 'bg-orange-500', ring: 'ring-orange-200' },
  Critical: { text: 'text-rose-800', bar: 'bg-rose-600', ring: 'ring-rose-200' },
};

export const bandFor = (status: string) => SCORE_BAND[status] ?? SCORE_BAND.Fair;

/** Confidence verdicts use the same vocabulary as the score bands. */
export const confidenceBand = (verdict: string) =>
  SCORE_BAND[verdict] ?? (verdict === 'Weak' ? SCORE_BAND.Poor : SCORE_BAND.Fair);
