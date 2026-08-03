/**
 * M2 - Figma extraction. Parent doc 4.2, plan 3.3.
 *
 * Three things this must get right, all of them boring and all of them the
 * difference between a tool that works and one that fails on Tuesdays:
 *
 *   1. Cache by file VERSION. Designs change far less often than deploys, so
 *      without this every run pays a slow, rate-limited call for identical data.
 *   2. Rate limit politely, and back off on 429 with Retry-After.
 *   3. Degrade, never die. A rate-limit stall falls back to the last cached
 *      version plus a warning - it is never a hard run failure.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const API = 'https://api.figma.com/v1';

/**
 * Hard ceiling on any backoff we will actually wait out.
 *
 * Figma has been observed returning `Retry-After: 393733` - 4.5 DAYS - on a 429.
 * Honouring that literally hangs the run forever, which is exactly the "hard run
 * failure" parent doc 4.2 says a rate-limit stall must never become. When the
 * server asks for longer than this, we stop retrying immediately so the caller
 * can degrade to cached data instead of sleeping.
 */
const MAX_BACKOFF_MS = 30_000;

/** `Retry-After` is either delta-seconds or an HTTP-date. Both are legal. */
function parseRetryAfter(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

export class FigmaError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'FigmaError';
    this.status = status;
  }
}

/** ':' is illegal in Windows filenames, and node ids are full of it. */
const safeId = (id) => String(id).replace(/[:\\/]/g, '_');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class FigmaClient {
  /**
   * @param {object}  opts
   * @param {string}  opts.token
   * @param {string}  opts.cacheDir
   * @param {boolean} [opts.noCache]      bypass reads, still writes
   * @param {number}  [opts.minIntervalMs] floor between requests
   */
  constructor({ token, cacheDir, noCache = false, minIntervalMs = 300, log = console }) {
    if (!token) throw new FigmaError('FigmaClient requires a token');
    this.token = token;
    this.cacheDir = resolve(cacheDir, 'figma');
    this.noCache = noCache;
    this.minIntervalMs = minIntervalMs;
    this.log = log;
    this.stats = { requests: 0, cacheHits: 0, retries: 0, bytes: 0 };
    this._lastRequestAt = 0;
    this._queue = Promise.resolve();
  }

  /** Serialize requests and hold a floor between them - a one-slot token bucket. */
  _schedule(fn) {
    const run = this._queue.then(async () => {
      const wait = this.minIntervalMs - (Date.now() - this._lastRequestAt);
      if (wait > 0) await sleep(wait);
      this._lastRequestAt = Date.now();
      return fn();
    });
    // Keep the chain alive even when a link rejects.
    this._queue = run.then(() => {}, () => {});
    return run;
  }

  async _request(path, { maxRetries = 4 } = {}) {
    return this._schedule(async () => {
      let attempt = 0;
      for (;;) {
        this.stats.requests++;
        let res;
        try {
          res = await fetch(`${API}${path}`, { headers: { 'X-Figma-Token': this.token } });
        } catch (err) {
          if (attempt++ >= maxRetries) throw new FigmaError(`Network error: ${err.message}`);
          this.stats.retries++;
          await sleep(2 ** attempt * 500);
          continue;
        }

        if (res.status === 429 || res.status >= 500) {
          const requested = parseRetryAfter(res.headers.get('retry-after'));

          // A server asking us to wait longer than the ceiling is not something
          // to sleep through - bail now so the caller can fall back to cache.
          if (requested !== null && requested > MAX_BACKOFF_MS) {
            throw new FigmaError(
              `Figma API ${res.status}, Retry-After ${Math.round(requested / 1000)}s ` +
                `exceeds the ${MAX_BACKOFF_MS / 1000}s ceiling - not waiting`,
              res.status
            );
          }
          if (attempt++ >= maxRetries) {
            throw new FigmaError(`Figma API ${res.status} after ${maxRetries} retries`, res.status);
          }

          const delay = Math.min(requested ?? 2 ** attempt * 1000, MAX_BACKOFF_MS);
          this.stats.retries++;
          this.log.warn?.(
            `  figma ${res.status}, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt}/${maxRetries})`
          );
          await sleep(delay);
          continue;
        }

        const body = await res.text();
        this.stats.bytes += body.length;

        if (!res.ok) {
          let detail = body.slice(0, 200);
          try { detail = JSON.parse(body).err || detail; } catch { /* keep raw */ }
          throw new FigmaError(`Figma API ${res.status}: ${detail}`, res.status);
        }
        return JSON.parse(body);
      }
    });
  }

  // ---- cache -------------------------------------------------------------

  _cachePath(fileKey, version, name) {
    return join(this.cacheDir, fileKey, String(version), `${name}.json`);
  }

  _readCache(fileKey, version, name) {
    if (this.noCache) return null;
    const p = this._cachePath(fileKey, version, name);
    if (!existsSync(p)) return null;
    try {
      const data = JSON.parse(readFileSync(p, 'utf8'));
      this.stats.cacheHits++;
      return data;
    } catch {
      return null; // Corrupt cache entry is a miss, not a crash.
    }
  }

  _writeCache(fileKey, version, name, data) {
    const p = this._cachePath(fileKey, version, name);
    mkdirSync(join(this.cacheDir, fileKey, String(version)), { recursive: true });
    writeFileSync(p, JSON.stringify(data));
  }

  /** Newest cached version for a file - the degradation path when the API is unreachable. */
  _newestCachedVersion(fileKey) {
    const dir = join(this.cacheDir, fileKey);
    if (!existsSync(dir)) return null;
    const versions = readdirSync(dir).filter((v) => existsSync(join(dir, v)));
    if (!versions.length) return null;
    // Versions are opaque monotonic integers-as-strings; longest-then-lexical
    // ordering is correct for them and avoids float precision loss.
    versions.sort((a, b) => (a.length - b.length) || a.localeCompare(b));
    return versions[versions.length - 1];
  }

  // ---- API ---------------------------------------------------------------

  /**
   * Cheap metadata call - returns `version` without the node payload, which is
   * what makes version-keyed caching possible at all (plan 9 Q5).
   */
  async getFileMeta(fileKey) {
    const meta = await this._request(`/files/${fileKey}?depth=1`);
    return {
      name: meta.name,
      version: meta.version,
      lastModified: meta.lastModified,
      role: meta.role,
      editorType: meta.editorType,
      pages: (meta.document?.children || []).map((c) => ({ id: c.id, name: c.name, type: c.type })),
    };
  }

  /**
   * Resolve the version to work against, degrading to cache when the API is
   * unreachable rather than failing the run (parent doc 4.2).
   *
   * The version check is itself an API call, so an otherwise fully-cached run
   * still costs one request. During development that is the single biggest
   * source of rate-limit pressure - and it is what got this token 429'd with a
   * 4.5-day Retry-After. A short TTL on the check removes it without risking
   * meaningfully stale data: designs do not change second to second.
   */
  async resolveVersion(fileKey, { checkTtlMs = 5 * 60_000 } = {}) {
    const stampPath = join(this.cacheDir, fileKey, 'version-check.json');

    if (!this.noCache && existsSync(stampPath)) {
      try {
        const stamp = JSON.parse(readFileSync(stampPath, 'utf8'));
        if (Date.now() - stamp.checkedAt < checkTtlMs) {
          this.stats.cacheHits++;
          return { ...stamp.meta, version: stamp.version, stale: false, versionCheckSkipped: true };
        }
      } catch { /* corrupt stamp is a miss */ }
    }

    try {
      const meta = await this.getFileMeta(fileKey);
      mkdirSync(join(this.cacheDir, fileKey), { recursive: true });
      writeFileSync(stampPath, JSON.stringify({ version: meta.version, checkedAt: Date.now(), meta }));
      return { ...meta, stale: false };
    } catch (err) {
      const cached = this._newestCachedVersion(fileKey);
      if (!cached) throw err;
      this.log.warn?.(
        `  WARNING: could not reach Figma (${err.message}).\n` +
          `  Falling back to cached version ${cached}. Results may be stale.`
      );
      return { name: null, version: cached, lastModified: null, pages: [], stale: true };
    }
  }

  /**
   * `geometry=paths` doubles response size by returning fillGeometry/strokeGeometry
   * SVG path data. Only needed for icon path-hash comparison (parent doc 9.5),
   * which is Phase 3+ of the product. Default off.
   */
  async getNodes(fileKey, version, nodeIds, { geometry = false } = {}) {
    const ids = Array.isArray(nodeIds) ? nodeIds : [nodeIds];
    const cacheName = `nodes-${ids.map(safeId).join('_')}${geometry ? '-geom' : ''}`;

    const cached = this._readCache(fileKey, version, cacheName);
    if (cached) return cached;

    const q = new URLSearchParams({ ids: ids.join(',') });
    if (geometry) q.set('geometry', 'paths');
    const data = await this._request(`/files/${fileKey}/nodes?${q}`);

    this._writeCache(fileKey, version, cacheName, data);
    return data;
  }

  /**
   * Token authority tier 1. Enterprise-plan-gated, so 403 is a NORMAL outcome
   * and must not be treated as an error (parent doc 14.2, plan 2.3).
   */
  async getLocalVariables(fileKey, version) {
    const cached = this._readCache(fileKey, version, 'variables');
    if (cached) return cached;

    try {
      const data = await this._request(`/files/${fileKey}/variables/local`);
      this._writeCache(fileKey, version, 'variables', data);
      return data;
    } catch (err) {
      if (err.status === 403 || err.status === 404) {
        const miss = { available: false, reason: `HTTP ${err.status} - Variables API requires an Enterprise plan` };
        this._writeCache(fileKey, version, 'variables', miss);
        return miss;
      }
      throw err;
    }
  }
}
