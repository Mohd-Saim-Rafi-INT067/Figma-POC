/**
 * E6 evidence capture, brought forward into Phase 2 because Tier 2 needs
 * renders to look at.
 *
 * Both sides follow the SAME strategy, and not by coincidence:
 *
 *     capture the whole thing once, crop sections locally.
 *
 * On the Figma side that is forced by quota - a View/Collab seat allows roughly
 * six Tier-1 requests a month, and rendering 18 sections individually would
 * spend three months of it in one run. On the web side it is forced by ordering:
 * sections are not known until S1, which runs long after extraction, and the one
 * moment the page is guaranteed to be in the state its measurements describe is
 * inside the extraction session. So the web side captures one full-page PNG
 * through the `onStabilized` hook and crops afterwards, exactly as Figma does.
 *
 * Cropping is done by Chromium rather than an image library. The project already
 * depends on Playwright and on nothing else that can decode a PNG; adding a
 * native image dependency to move rectangles around is not worth it.
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Capture the stabilized page in full. Call from `extractWeb`'s `onStabilized`.
 *
 * Deliberately one image rather than per-section clips: at this point in the
 * run, sections do not exist yet.
 */
export async function captureFullPage(page, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  await page.screenshot({ path: outPath, fullPage: true, animations: 'disabled' });
  const size = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
  }));
  return { path: outPath, ...size };
}

/**
 * Photograph each scroll-driven section at the moment its geometry was measured.
 *
 * A full-page screenshot is taken at scroll top, but `extract.js` step 13
 * re-measures pinned sections at their SETTLED scroll. The two then describe
 * different moments, and evidence for those sections shows an empty region with
 * an outline drawn over nothing - the `onStabilized` hook was placed last
 * precisely to guarantee pixels and measurements agree, and the pinned fix
 * silently broke that guarantee for exactly the sections it repaired.
 *
 * So: return to each settled scroll and clip the pinned viewport. The resulting
 * image maps 1:1 onto the settled geometry, because both are anchored at the
 * container's top.
 *
 * Runs after the full-page capture and restores scroll afterwards, so it cannot
 * disturb anything already photographed.
 */
export async function capturePinnedSections(page, pinned, outDir) {
  if (!pinned?.length) return [];
  mkdirSync(outDir, { recursive: true });
  const written = [];

  for (const [i, p] of pinned.entries()) {
    if (!p.stickyViewportRect) continue;
    await page.evaluate((y) => window.scrollTo(0, y), p.settledAtScroll);
    await page.waitForTimeout(500);

    const path = join(outDir, `pinned-${String(i).padStart(2, '0')}.png`);
    const r = p.stickyViewportRect;
    await page.screenshot({ path, clip: { x: r.x, y: r.y, width: r.w, height: r.h } });

    written.push({
      path,
      // Document-space origin of this image, matching how the settled geometry
      // was anchored (see extract.js step 13).
      originX: p.containerX ?? r.x,
      originY: p.containerTop,
      width: r.w,
      height: r.h,
      settledAtScroll: p.settledAtScroll,
    });
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  return written;
}

/** The settled-scroll captures written by `capturePinnedSections`, if any. */
export function loadPinnedManifest(outDir) {
  const path = evidencePaths(outDir).pinnedManifest;
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * The settled-scroll capture for a section, or null if it is not scroll-driven.
 *
 * Match on ORIGIN only, never on height. A pinned capture is the settled sticky
 * viewport - 900px - while the section is the scroll container that houses it,
 * up to 3,495px. Requiring the heights to agree rejects exactly the sections
 * this exists for. Where containers nest, the widest wins: that is the outermost
 * pinned viewport and the one the section corresponds to.
 *
 * SHARED, and that is the point. E6 evidence has selected images this way since
 * the pinned fix landed; E2 correspondence did not, and cropped scroll-driven
 * sections out of the scroll-top full-page image like any other. Phase D
 * measured what that costs: on f6->w7 the model was shown one card, told about
 * twelve, and answered `not_built` 28 times at 0.85 confidence. It was reading
 * the picture correctly. Two copies of this rule is how that happened, so there
 * is now one.
 */
export function pinnedForSection(manifest, section, tolerancePx = 8) {
  if (!manifest?.length || !section) return null;
  return manifest
    .filter((m) => Math.abs(m.originY - section.y) <= tolerancePx)
    .sort((a, b) => b.width - a.width)[0] ?? null;
}

/**
 * Crop section rectangles out of a full-page capture.
 *
 * `sections` are S1 sections, whose `y`/`height` are absolute document
 * coordinates - the same space the screenshot is in, provided
 * deviceScaleFactor is 1. It is, and this asserts rather than assumes it.
 */
/** PNG dimensions straight from the IHDR chunk - no image library needed. */
export function pngSize(path) {
  const head = readFileSync(path).subarray(0, 33);
  if (head.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

export async function cropSections(browser, fullPage, sections, outDir, opts = {}) {
  const { side = 'web', log = console, scale = 1, origin = { x: 0, y: 0 } } = opts;
  mkdirSync(outDir, { recursive: true });

  // Map from the LOGICAL coordinate space that sections live in (the frame /
  // document, e.g. 1920 wide) to the actual pixels of this PNG, per axis.
  //
  // Never assume the renderer honoured the size asked for. Figma returned 961px
  // for a requested 960, rounding up - harmless on its own, but the same code
  // path handles a frame large enough for Figma to clamp the export, and there
  // a wrong assumption silently shifts every crop. Reading the header costs 33
  // bytes and removes the assumption entirely.
  const actual = pngSize(fullPage.path) ?? { width: fullPage.width, height: fullPage.height };
  const sx = actual.width / Math.max(1, fullPage.width);
  const sy = actual.height / Math.max(1, fullPage.height);

  if (Math.abs(sx - sy) > 0.005) {
    log.warn?.(`  capture: ${side} render aspect differs per axis (sx=${sx.toFixed(4)} sy=${sy.toFixed(4)}); ` +
      'the export was probably clamped. Crops follow the actual pixels.');
  }

  // `scale` shrinks relative to the ACTUAL pixels, so a render already produced
  // at half size is displayed 1:1 and never resampled.
  const displayW = Math.round(actual.width * scale);
  const displayH = Math.round(actual.height * scale);
  const X = (v) => Math.round(v * sx * scale);
  const Y = (v) => Math.round(v * sy * scale);

  // file:// -> file:// so the image is same-origin; an about:blank page is not
  // allowed to load a local file as a subresource.
  // The image is positioned by a negative offset inside a viewport sized to the
  // section, so each screenshot IS the crop. `page.screenshot({ clip })` cannot
  // do this: clip is viewport-relative, and every section past the first sits
  // outside an 800px viewport.
  const wrapper = resolve(dirname(fullPage.path), `.crop-${basename(fullPage.path)}.html`);
  writeFileSync(
    wrapper,
    `<!doctype html><style>html,body{margin:0;padding:0;overflow:hidden;background:#fff}` +
    `img{position:absolute;display:block;width:${displayW}px;height:${displayH}px}</style>` +
    `<img id="page" src="${basename(fullPage.path)}">`
  );

  const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
  const written = [];
  try {
    await page.goto(pathToFileURL(wrapper).href, { waitUntil: 'load' });
    await page.evaluate(() => document.getElementById('page')?.decode?.());

    for (const section of sections) {
      // Sections carry document/frame-absolute coordinates; `origin` shifts them
      // into the render's own space (a Figma frame does not start at 0,0).
      const y = Math.max(0, Y(section.y - origin.y));
      const x = Math.max(0, X((section.x ?? origin.x) - origin.x));
      const height = Math.min(Y(section.height), displayH - y);
      const width = Math.min(X(section.width ?? fullPage.width), displayW - x);

      if (height <= 0 || width <= 0) {
        log.warn?.(`  capture: section ${section.index} lies outside the capture; skipped`);
        continue;
      }
      if (height > MAX_CROP_HEIGHT) {
        log.warn?.(`  capture: section ${section.index} is ${height}px tall; truncated to ${MAX_CROP_HEIGHT}`);
      }
      const clipped = Math.min(height, MAX_CROP_HEIGHT);

      await page.setViewportSize({ width, height: clipped });
      await page.evaluate(({ x, y }) => {
        const img = document.getElementById('page');
        img.style.left = `${-x}px`;
        img.style.top = `${-y}px`;
      }, { x, y });

      const path = join(outDir, `${side}-${String(section.index).padStart(2, '0')}.png`);
      await page.screenshot({ path });
      written.push({ index: section.index, path, box: { x, y, width, height: clipped }, truncated: clipped < height });
    }
  } finally {
    await page.close();
  }
  return written;
}

/** Chromium tops out well below this, but a runaway section should warn, not throw. */
const MAX_CROP_HEIGHT = 12000;

/**
 * The Figma side - NOT IMPLEMENTED, and deliberately so.
 *
 * The strategy is settled (`v2-implementation-plan.md` §0.3): one
 * `GET /v1/images/:fileKey?ids=<frameNodeId>&format=png` for the whole frame,
 * cached indefinitely by `(fileKey, nodeId, version)` because renders are
 * immutable per version, then `cropSections` locally against the frame render
 * exactly as the web side does.
 *
 * What is missing is not code, it is a number: **the `/v1/images` rate-limit
 * tier is unconfirmed**, on an account with roughly six Tier-1 requests a month.
 * If it is Tier 1, one exploratory call is a sixth of the monthly budget, and a
 * failed experiment is unrecoverable for weeks. Confirm the tier before wiring
 * this up.
 *
 * Also unresolved: Figma's export size limit against a 1920x19,752 frame. If the
 * render is rejected, fall back to `scale=0.5` or vertical chunking - both of
 * which change the crop maths, which is the other reason not to guess now.
 */
export async function captureFigmaFrame(client, { fileKey, version, nodeId, outPath, scale = 1, cacheDir = '.cache', log = console }) {
  // Cache the PIXELS, not the URL.
  //
  // Figma serves renders from S3 behind a presigned link that EXPIRES - the
  // file thumbnail carries X-Amz-Expires=604800, seven days. Caching the URL
  // and calling that "indefinite" is wrong: the entry dies silently and the
  // only way to recover is another /v1/images call, from a budget of about six
  // per month. Renders are immutable per file version, so once the bytes are on
  // disk under (fileKey, version, nodeId, scale) they never need fetching again.
  const pngPath = resolve(cacheDir, 'figma', fileKey, String(version), `image-${nodeId.replace(/[^\w.-]+/g, '_')}@${scale}.png`);

  if (existsSync(pngPath)) {
    mkdirSync(dirname(outPath), { recursive: true });
    copyFileSync(pngPath, outPath);
    log.log?.('  figma render CACHE HIT — pixels on disk, 0 requests spent');
    return { path: outPath, scale, cacheHit: true, cachedBytes: pngPath };
  }

  const { url } = await client.getImage(fileKey, version, nodeId, { scale });
  log.log?.('  figma render FETCHED — 1 Tier-1 request spent');

  // The S3 download is not itself a Tier-1 request; only /v1/images is metered.
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Figma render download failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());

  mkdirSync(dirname(pngPath), { recursive: true });
  writeFileSync(pngPath, bytes);          // durable copy first
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, bytes);

  log.log?.(`  figma render cached to ${pngPath} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
  return { path: outPath, scale, cacheHit: false, cachedBytes: pngPath };
}

/** Where a run keeps its captures. */
export function evidencePaths(outDir) {
  return {
    fullPage: join(outDir, 'evidence', 'web-full.png'),
    sections: join(outDir, 'evidence', 'sections'),
    pinned: join(outDir, 'evidence', 'pinned'),
    pinnedManifest: join(outDir, 'evidence', 'pinned', 'manifest.json'),
  };
}

export function hasCapture(outDir) {
  return existsSync(evidencePaths(outDir).fullPage);
}
