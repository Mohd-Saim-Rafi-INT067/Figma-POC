/**
 * Config resolution - plan section 3.2.
 *
 * Loads .env, parses the Figma frame URL, and loads the tolerance profile.
 *
 * `viewportWidth` is deliberately NOT resolved here. It is auto-derived from the
 * frame's absoluteBoundingBox.width, which requires an API call - so it is filled
 * in by the pipeline after M2 runs. That creates a hard ordering constraint:
 * M2 (Figma) must run before M1 (web). See plan 3.2.
 */

import 'dotenv/config';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export class ConfigError extends Error {
  constructor(message, hint) {
    super(hint ? `${message}\n  → ${hint}` : message);
    this.name = 'ConfigError';
  }
}

/**
 * Parse a Figma frame URL - parent doc 3.2.
 *
 *   https://www.figma.com/design/<fileKey>/<name>?node-id=1-234
 *                                ^^^^^^^^^                ^^^^^
 *
 * Both /design/ and legacy /file/ paths are accepted. The node-id query param
 * uses "-" as separator; the REST API expects ":".
 */
export function parseFigmaUrl(raw) {
  if (!raw) {
    throw new ConfigError(
      'FIGMA_FRAME_URL is not set',
      'Copy .env.example to .env and fill it in.'
    );
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`FIGMA_FRAME_URL is not a valid URL: ${raw}`);
  }

  const m = url.pathname.match(/^\/(?:design|file)\/([A-Za-z0-9]+)/);
  if (!m) {
    throw new ConfigError(
      `Could not find a file key in ${raw}`,
      'Expected https://www.figma.com/design/<fileKey>/<name>?node-id=1-234'
    );
  }
  const fileKey = m[1];

  const rawNodeId = url.searchParams.get('node-id');
  if (!rawNodeId) {
    throw new ConfigError(
      'That URL points at a file, not a frame - it has no node-id.',
      'The comparison unit is a frame (parent doc 3.1). In Figma: right-click the ' +
        'frame → Copy/Paste as → Copy link to selection. Note "t=" is a share token, not a node id.'
    );
  }

  // "2743-6476" (URL form) -> "2743:6476" (REST form). Already-colon input passes through.
  const nodeId = rawNodeId.replace('-', ':');
  if (!/^\d+:\d+$/.test(nodeId)) {
    throw new ConfigError(
      `node-id "${rawNodeId}" is not in the expected <num>-<num> form`
    );
  }

  return { fileKey, nodeId };
}

function loadTolerance(name = 'default') {
  const path = resolve(ROOT, 'config', `tolerance-${name}.json`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(`Could not load tolerance profile "${name}" from ${path}`, err.message);
  }
}

/** Positive-integer env var, or null when unset/blank. */
function intOrNull(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ConfigError(`${label} must be a positive number, got "${value}"`);
  }
  return Math.round(n);
}

/**
 * @param {object} [opts]
 * @param {string} [opts.toleranceProfile]
 * @param {string} [opts.figmaFrameUrl]  overrides FIGMA_FRAME_URL - the UI supplies this per request
 * @param {string} [opts.pageUrl]        overrides PAGE_URL
 * @param {string} [opts.outDir]         overrides <root>/out - one directory per run, so concurrent
 *                                       or successive runs cannot overwrite each other's artifacts
 * @param {number} [opts.viewportWidth]  overrides VIEWPORT_WIDTH (still only an override; null
 *                                       auto-derives from the frame after M2)
 *
 * Every option falls back to the environment variable it replaces, so a caller
 * that passes nothing - the CLI - behaves exactly as before.
 *
 * CREDENTIALS ARE NOT PARAMETERS. FIGMA_TOKEN and the LLM keys are read from the
 * environment only, and deliberately so: the HTTP layer must be able to choose
 * WHAT to audit without being able to choose WHOSE credentials to audit it with.
 * That boundary is where per-user Figma OAuth plugs in when this ports to
 * Evertest - see docs/demo-ui-implementation-plan.md §3.1 and §13.1.
 */
export function resolveConfig({
  toleranceProfile = 'default',
  figmaFrameUrl,
  pageUrl: pageUrlOverride,
  outDir: outDirOverride,
  viewportWidth,
} = {}) {
  const token = process.env.FIGMA_TOKEN;
  if (!token) {
    throw new ConfigError(
      'FIGMA_TOKEN is not set',
      'Figma → Settings → Security → Personal access tokens, scope "File content" (read). ' +
        'Put it in .env (gitignored), never in .env.example.'
    );
  }

  const pageUrl = pageUrlOverride ?? process.env.PAGE_URL;
  if (!pageUrl) throw new ConfigError('PAGE_URL is not set');
  try {
    new URL(pageUrl);
  } catch {
    throw new ConfigError(`PAGE_URL is not a valid URL: ${pageUrl}`);
  }

  const { fileKey, nodeId } = parseFigmaUrl(figmaFrameUrl ?? process.env.FIGMA_FRAME_URL);

  const outDir = outDirOverride ? resolve(outDirOverride) : resolve(ROOT, 'out');
  const cacheDir = resolve(ROOT, '.cache');
  mkdirSync(outDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  return {
    figmaToken: token,
    figmaFileKey: fileKey,
    figmaNodeId: nodeId,
    pageUrl,

    // null => auto-derive from the frame after M2. See plan 3.2.
    viewportWidthOverride: intOrNull(viewportWidth ?? process.env.VIEWPORT_WIDTH, 'VIEWPORT_WIDTH'),
    viewportWidth: null,
    viewportHeight: intOrNull(process.env.VIEWPORT_HEIGHT, 'VIEWPORT_HEIGHT') ?? 900,
    deviceScaleFactor: 1,

    tolerance: loadTolerance(toleranceProfile),
    outDir,
    cacheDir,
    root: ROOT,
  };
}

/**
 * Apply the frame width to the config - parent doc 3.1.
 *
 * A Figma frame is fixed-width; a web page is responsive. Measuring a 1920 frame
 * against a browser at 1280 compares two different layouts and every finding is
 * noise. So the frame wins unless the user explicitly overrode it, and an
 * override that disagrees is warned about loudly.
 */
export function applyFrameWidth(config, frameWidth, log = console) {
  const derived = Math.round(frameWidth);

  if (config.viewportWidthOverride === null) {
    config.viewportWidth = derived;
    return config;
  }

  config.viewportWidth = config.viewportWidthOverride;
  if (config.viewportWidthOverride !== derived) {
    log.warn(
      `WARNING: VIEWPORT_WIDTH=${config.viewportWidthOverride} but the Figma frame is ${derived}px wide.\n` +
        '  A frame is fixed-width and a page is responsive - comparing them at different\n' +
        '  widths measures two different layouts, and essentially every finding will be\n' +
        '  noise. This is almost always a mistake. (parent doc 3.1)'
    );
  }
  return config;
}
