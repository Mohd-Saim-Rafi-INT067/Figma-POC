/**
 * E6 - evidence annotation.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  EVERY COORDINATE HERE IS MEASURED. The model draws nothing.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Identifier coverage is 100% on both sides, so after correspondence every
 * issue is anchored to elements whose boxes are known to the pixel. Asking a
 * model to place the box instead would buy approximate coordinates, a call per
 * annotation, variance between runs, and a failure mode - boxes around elements
 * that do not exist - that looks exactly like success.
 *
 * The label keyword comes from the finding's own `property`. No model involved
 * in that either.
 *
 * Rendering is done by Chromium rather than an image library, for the same
 * reason cropping is: Playwright is already a dependency, and HTML gives text
 * rendering and box drawing for free.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pngSize } from './capture.js';

const SEVERITY_COLOUR = {
  critical: '#dc2626',
  high: '#ea580c',
  medium: '#ca8a04',
  low: '#6b7280',
};

/** The one-word keyword a reader scans for, from the property itself. */
export function keywordFor(property) {
  if (property.startsWith('boxRelative.size')) return 'size';
  if (property.startsWith('boxRelative.pos')) return 'position';
  if (property.includes('Color') || property === 'color') return 'colour';
  if (property.startsWith('font') || property === 'renderedFontFamily') return 'type';
  if (property.includes('lineHeight') || property.includes('letterSpacing')) return 'type';
  if (property.startsWith('border')) return 'border';
  if (property.startsWith('shadow')) return 'shadow';
  if (property.includes('padding') || property.includes('gap')) return 'spacing';
  if (property === 'opacity') return 'opacity';
  return 'style';
}

/** `colour · ΔE 7.43`, `size · +172px` - one line, scannable. */
export function labelFor(finding) {
  const kw = keywordFor(finding.property);
  if (finding.delta == null) return `${kw} · ${trim(finding.expected)} → ${trim(finding.actual)}`;
  if (kw === 'colour') return `${kw} · ΔE ${finding.delta}`;
  const sign = Number(finding.actual) > Number(finding.expected) ? '+' : '−';
  return `${kw} · ${sign}${Math.abs(finding.delta)}px`;
}

const trim = (v) => {
  const s = String(v);
  return s.length > 18 ? `${s.slice(0, 17)}…` : s;
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * One side of the evidence: an image, cropped around the element, with the
 * element outlined and labelled.
 *
 * The label sits immediately ABOVE the outline, left-aligned to it, and flips
 * below when that would leave the canvas - deterministic in both cases, so a
 * rerun produces an identical image.
 */
function panel({ imageUrl, imgW, imgH, box, sx, sy, pad, label, colour, caption }) {
  const x = box.x * sx, y = box.y * sy, w = Math.max(2, box.w * sx), h = Math.max(2, box.h * sy);

  // Crop window around the element, clamped to the image.
  const cx = Math.max(0, Math.min(x - pad, imgW - 1));
  const cy = Math.max(0, Math.min(y - pad, imgH - 1));
  const cw = Math.min(imgW - cx, w + pad * 2);
  const ch = Math.min(imgH - cy, h + pad * 2);

  const relX = x - cx, relY = y - cy;
  const labelAbove = relY > 22;          // room above? otherwise flip below
  const labelTop = labelAbove ? relY - 22 : relY + h + 4;

  return {
    width: Math.round(cw),
    height: Math.round(ch),
    html: `
<div class="panel" style="width:${cw}px;height:${ch}px">
  <img src="${imageUrl}" style="left:${-cx}px;top:${-cy}px;width:${imgW}px;height:${imgH}px">
  <div class="box" style="left:${relX}px;top:${relY}px;width:${w}px;height:${h}px;border-color:${colour}"></div>
  <div class="label" style="left:${relX}px;top:${labelTop}px;background:${colour}">${esc(label)}</div>
  <div class="caption">${esc(caption)}</div>
</div>`,
  };
}

/**
 * Side-by-side evidence for one merged issue: design on the left, page on the
 * right, at matched scale. Reading "172px wider" and seeing it are different
 * experiences.
 *
 * Degrades to the page alone when no design render is available - the whole
 * report should survive a Figma outage with numbers intact.
 */
export async function annotateIssue(page, issue, ctx, outPath) {
  const { figmaImage, webImage, figmaBox, webBox, figmaLogical, webLogical, pad = 48 } = ctx;

  const colour = SEVERITY_COLOUR[issue.maxSeverity] ?? SEVERITY_COLOUR.low;
  const label = labelFor(issue.properties[0]);

  const panels = [];
  if (figmaImage && figmaBox) {
    const size = pngSize(figmaImage);
    if (size) {
      panels.push(panel({
        imageUrl: pathToFileURL(resolve(figmaImage)).href,
        imgW: size.width, imgH: size.height,
        box: figmaBox,
        sx: size.width / figmaLogical.w, sy: size.height / figmaLogical.h,
        pad, label, colour, caption: 'DESIGN',
      }));
    }
  }
  if (webImage && webBox) {
    const size = pngSize(webImage);
    if (size) {
      // A pinned capture is NOT a scaled section crop. It photographs the
      // settled viewport - a 900px window, sometimes only part of the section's
      // width - while the section's logical box is the whole scroll container,
      // up to 3,495px. Scaling by the section would shrink the mapping to about
      // a quarter and put every box in the wrong place.
      //
      // So a pinned image maps 1:1 to document pixels, and the element is
      // located by shifting from the section's origin to the image's.
      const offset = ctx.webImageOrigin
        ? { x: ctx.webSectionOrigin.x - ctx.webImageOrigin.x, y: ctx.webSectionOrigin.y - ctx.webImageOrigin.y }
        : { x: 0, y: 0 };
      const logical = ctx.webImageOrigin ? { w: size.width, h: size.height } : webLogical;

      panels.push(panel({
        imageUrl: pathToFileURL(resolve(webImage)).href,
        imgW: size.width, imgH: size.height,
        box: { ...webBox, x: webBox.x + offset.x, y: webBox.y + offset.y },
        sx: size.width / logical.w, sy: size.height / logical.h,
        pad, label, colour, caption: 'PAGE',
      }));
    }
  }
  if (!panels.length) return null;

  const gap = 16;
  const width = panels.reduce((n, p) => n + p.width, 0) + gap * (panels.length - 1) + 24;
  const height = Math.max(...panels.map((p) => p.height)) + 40;

  const html = `<!doctype html><meta charset="utf-8"><style>
    *{box-sizing:border-box}
    body{margin:0;padding:12px;background:#f8fafc;font:12px/1.4 ui-sans-serif,system-ui,sans-serif;display:flex;gap:${gap}px;align-items:flex-start}
    .panel{position:relative;overflow:hidden;background:#fff;border:1px solid #e2e8f0;border-radius:6px;flex:none}
    .panel img{position:absolute;display:block;max-width:none}
    .box{position:absolute;border:2px solid;border-radius:2px;box-shadow:0 0 0 9999px rgba(15,23,42,.28)}
    .label{position:absolute;color:#fff;font-weight:600;font-size:11px;padding:2px 6px;border-radius:3px;white-space:nowrap}
    .caption{position:absolute;left:6px;bottom:4px;color:#0f172a;background:rgba(255,255,255,.85);
      font-size:10px;font-weight:700;letter-spacing:.06em;padding:1px 5px;border-radius:3px}
  </style>${panels.map((p) => p.html).join('')}`;

  // The HTML goes to DISK and is navigated to, rather than injected with
  // setContent. A setContent page has an about:blank origin and Chromium will
  // not let it load file:// images - the panels render as empty grey boxes with
  // the outline drawn over nothing. Same constraint that shapes cropSections.
  mkdirSync(dirname(outPath), { recursive: true });
  const htmlPath = `${outPath}.html`;
  writeFileSync(htmlPath, html);

  await page.setViewportSize({ width: Math.round(width), height: Math.round(height) });
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))));
  await page.screenshot({ path: outPath });

  return { path: outPath, panels: panels.length, label, colour };
}
