/**
 * E6 stage wiring.
 *
 * One image per MERGED ISSUE, never per finding - which is why E5 runs before
 * E6. Rendering per raw finding would produce four images of the same button
 * and discard three.
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  cropSections, evidencePaths, captureFigmaFrame, loadPinnedManifest, pinnedForSection,
} from './capture.js';
import { annotateIssue } from './annotate.js';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', yellow: '\x1b[33m' };

export async function stageEvidence(ctx) {
  if (!ctx.issues) throw new Error('E6 requires E5 output.');

  const cfg = ctx.config.tolerance.evidence ?? { scale: 0.5, pad: 48, annotateTop: 20 };
  const outDir = join(ctx.config.outDir, 'evidence', 'issues');
  mkdirSync(outDir, { recursive: true });

  const paths = evidencePaths(ctx.config.outDir);
  const figmaFrame = join(ctx.config.outDir, 'evidence', 'figma-frame.png');
  const haveWeb = existsSync(paths.fullPage);

  // Every run gets its own directory, so a fresh run has no design render even
  // though the PIXELS are cached under .cache/figma/<file>/<version>/. Ask for
  // it: captureFigmaFrame serves the cached bytes and spends no Figma request.
  // Without this the report silently degrades to page-only panels, which is the
  // documented fallback for a Figma outage - not something to accept when the
  // render is sitting on disk.
  if (!existsSync(figmaFrame) && ctx.snapshots?.figma?.meta && ctx.config.figmaToken) {
    try {
      const { FigmaClient } = await import('../figma/client.js');
      const client = new FigmaClient({ token: ctx.config.figmaToken, cacheDir: '.cache', log: { log() {}, warn() {} } });
      await captureFigmaFrame(client, {
        fileKey: ctx.snapshots.figma.meta.fileKey,
        version: ctx.snapshots.figma.sourceVersion,
        nodeId: ctx.snapshots.figma.meta.nodeId,
        outPath: figmaFrame,
        scale: 0.5,
        log: { log() {} },
      });
    } catch (err) {
      console.log(`  ${C.dim}design render unavailable (${err.message.slice(0, 60)}); evidence will be page-only${C.reset}`);
    }
  }
  const haveFigma = existsSync(figmaFrame);

  if (!haveWeb) {
    console.log(`\n  ${C.yellow}E6 skipped: no web capture. Run with --capture.${C.reset}\n`);
    ctx.stageInfo = { skipped: 'no web capture' };
    return;
  }

  const sections = ctx.sections;
  const browser = await chromium.launch({ headless: true });
  const written = [];
  let usedPinnedTotal = 0;

  try {
    // Section crops on both sides, at one scale, so panels sit at matched size.
    const figmaCrops = haveFigma ? await cropSections(
      browser,
      { path: figmaFrame, width: ctx.snapshots.figma.meta.frameWidth, height: ctx.snapshots.figma.meta.frameHeight },
      sections.figma.sections, join(ctx.config.outDir, 'evidence', 'figma-sections'), { side: 'figma', scale: 1 }
    ) : [];
    const webCrops = await cropSections(
      browser,
      { path: paths.fullPage, width: sections.web.rootWidth, height: sections.web.totalHeight },
      sections.web.sections, join(ctx.config.outDir, 'evidence', 'web-sections'), { side: 'web', scale: cfg.scale }
    );

    // Scroll-driven sections were measured at their settled scroll, so their
    // evidence must come from the image taken THERE, not from the scroll-top
    // full-page capture. Without this the box is drawn over the animation's
    // first frame and the panel looks empty.
    // The matching rule lives in capture.js so E2 correspondence and E6 evidence
    // cannot disagree about which image a scroll-driven section is shown as -
    // they did, and Phase D measured the cost.
    const pinnedManifest = loadPinnedManifest(ctx.config.outDir);
    const pinnedFor = (section) => pinnedForSection(pinnedManifest, section);

    const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
    const pairByKey = new Map(ctx.elements.pairs.map((p) => [`${p.figmaIndex}:${p.webIndex}`, p]));

    let usedPinned = 0;
    const targets = ctx.issues.landing.shown.slice(0, cfg.annotateTop);
    for (const [n, issue] of targets.entries()) {
      const pair = pairByKey.get(`${issue.sectionPair.figmaIndex}:${issue.sectionPair.webIndex}`);
      if (!pair) continue;

      const fEl = pair.figma.elements[issue.element.figmaIndex];
      const wEl = pair.web.elements[issue.element.webIndex];
      const fImg = figmaCrops.find((c) => c.index === issue.sectionPair.figmaIndex)?.path;
      // A pinned section's evidence comes from its settled-scroll capture.
      const webSection = sections.web.sections[issue.sectionPair.webIndex];
      const pinnedImg = webSection ? pinnedFor(webSection) : null;
      const wImg = pinnedImg ? pinnedImg.path : webCrops.find((c) => c.index === issue.sectionPair.webIndex)?.path;
      if (pinnedImg) usedPinned++;

      const outPath = join(outDir, `issue-${String(n).padStart(2, '0')}.png`);
      const result = await annotateIssue(page, issue, {
        figmaImage: fImg, webImage: wImg,
        figmaBox: fEl?.box, webBox: wEl?.box,
        figmaLogical: { w: pair.figma.origin.w, h: pair.figma.origin.h },
        webLogical: { w: pair.web.origin.w, h: pair.web.origin.h },
        // Set only for pinned captures: tells annotate to map 1:1 and shift from
        // the section origin to the image origin.
        webImageOrigin: pinnedImg ? { x: pinnedImg.originX, y: pinnedImg.originY } : null,
        webSectionOrigin: { x: pair.web.origin.x, y: pair.web.origin.y },
        pad: cfg.pad,
      }, outPath);

      if (result) {
        issue.evidence = { path: outPath, panels: result.panels, label: result.label };
        written.push({ issue: issue.key, ...result });
      }
    }
    await page.close();
    usedPinnedTotal = usedPinned;
  } finally {
    await browser.close();
  }

  writeFileSync(join(ctx.config.outDir, 'evidence', 'index.json'), JSON.stringify(written, null, 2));

  const targets = ctx.issues.landing.shown.slice(0, cfg.annotateTop);
  const serious = targets.filter((i) => i.maxSeverity === 'high' || i.maxSeverity === 'critical');
  const seriousWithImage = serious.filter((i) => i.evidence);
  const bothPanels = written.filter((w) => w.panels === 2).length;

  console.log(`\n  ${C.bold}E6 EVIDENCE${C.reset}`);
  console.log(`  ${written.length} annotated images for the top ${targets.length} issues ${C.dim}(one per merged issue, never per finding)${C.reset}`);
  if (usedPinnedTotal) console.log(`  ${C.dim}${usedPinnedTotal} from settled-scroll captures (scroll-driven sections)${C.reset}`);
  console.log(`  ${bothPanels} side-by-side (design + page), ${written.length - bothPanels} page-only ${C.dim}${haveFigma ? '' : '- no design render available'}${C.reset}`);
  const pct = serious.length ? (seriousWithImage.length / serious.length) * 100 : 100;
  console.log(`  ${pct === 100 ? C.green : C.yellow}NFR N6: ${seriousWithImage.length}/${serious.length} high+critical issues carry an image (${pct.toFixed(0)}%)${C.reset}\n`);

  ctx.stageInfo = { images: written.length, sideBySide: bothPanels, seriousCovered: `${seriousWithImage.length}/${serious.length}`, out: 'out/evidence/issues' };
}
