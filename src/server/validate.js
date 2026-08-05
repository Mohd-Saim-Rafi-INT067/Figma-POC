/**
 * Request validation.
 *
 * The Figma URL check reuses parseFigmaUrl from config.js rather than
 * reimplementing it. That function already produces the error a demo audience
 * is most likely to trigger - pasting a file link instead of a frame link -
 * with instructions for fixing it in Figma. Anything written here would be
 * worse, and would drift from what the CLI reports for the same input.
 */

import { parseFigmaUrl, ConfigError } from '../config.js';

/**
 * ConfigError formats itself as "message\n  → hint" (config.js). Split it back
 * apart so the UI can render the hint under the field rather than as one blob.
 */
function splitConfigError(err) {
  const [message, ...rest] = String(err.message).split('\n');
  const hint = rest.join('\n').replace(/^\s*→\s*/, '').trim();
  return { error: message, hint: hint || null };
}

function checkPageUrl(raw) {
  if (!raw || !String(raw).trim()) {
    return { error: 'Website URL is required', hint: 'Enter the URL of the page to audit.' };
  }
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    return { error: `Not a valid URL: ${raw}`, hint: 'Include the scheme, e.g. https://example.com' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      error: `Unsupported protocol "${url.protocol}"`,
      hint: 'Only http:// and https:// pages can be audited.',
    };
  }
  return null;
}

function checkFigmaUrl(raw) {
  if (!raw || !String(raw).trim()) {
    return { error: 'Figma frame URL is required', hint: 'Paste a link to the frame you want to compare against.' };
  }
  try {
    parseFigmaUrl(String(raw).trim());
    return null;
  } catch (err) {
    if (err instanceof ConfigError) return splitConfigError(err);
    return { error: err.message, hint: null };
  }
}

/**
 * @returns {{ok: true, value: object} | {ok: false, field: string, error: string, hint: string|null}}
 */
export function validateAuditRequest(body = {}) {
  const figmaFrameUrl = body.figmaFrameUrl;
  const pageUrl = body.pageUrl;

  const figmaProblem = checkFigmaUrl(figmaFrameUrl);
  if (figmaProblem) return { ok: false, field: 'figmaFrameUrl', ...figmaProblem };

  const pageProblem = checkPageUrl(pageUrl);
  if (pageProblem) return { ok: false, field: 'pageUrl', ...pageProblem };

  if (body.viewportWidth !== undefined && body.viewportWidth !== null && body.viewportWidth !== '') {
    const n = Number(body.viewportWidth);
    if (!Number.isFinite(n) || n <= 0) {
      return {
        ok: false,
        field: 'viewportWidth',
        error: `Viewport width must be a positive number, got "${body.viewportWidth}"`,
        hint: 'Leave it blank to derive the width from the Figma frame, which is almost always what you want.',
      };
    }
  }

  return {
    ok: true,
    value: {
      figmaFrameUrl: String(figmaFrameUrl).trim(),
      pageUrl: String(pageUrl).trim(),
      // The determinism self-check re-extracts the whole page and roughly
      // doubles web-side runtime. It was opt-in while this was a demo; it is
      // now default-ON, because a run whose dynamic regions were never
      // identified cannot gate anything - it reports motion as defects. The
      // CLI has always defaulted it on; this aligns the server with it.
      determinism: body.determinism !== false,
      // Default ON. Without it a 429 on the version-check endpoint silently
      // serves a stale cached design, and the audit compares against a design
      // that is not the one on screen. See plan §8.1.
      noCache: body.noCache !== false,
      viewportWidth:
        body.viewportWidth === undefined || body.viewportWidth === null || body.viewportWidth === ''
          ? undefined
          : Number(body.viewportWidth),
    },
  };
}
