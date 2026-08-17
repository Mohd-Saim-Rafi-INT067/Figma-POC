/**
 * E2 stage - establish correspondence for every matched section pair.
 *
 * Until now this ran nowhere. `anchorSection` was called inside E3, and the
 * shortlist adjudicator existed only in the benchmark harness, so every report
 * the tool has ever produced used Tier 1 alone at 46.4% recall while the
 * measured architecture reached 67.8%. Phases C and D were measured but not
 * connected.
 *
 * The stage is deliberately DEGRADABLE. Correspondence must exist for E3-E7 to
 * run at all, so a missing API key, an exhausted quota or a failed batch drops
 * to deterministic Tier 1 rather than failing the audit. The report then says
 * which tier it used, because a 46% report and a 68% report are different
 * claims and must not look alike.
 *
 * COST is the reason for the cache. A full 18-section audit is ~304k input
 * tokens, and nothing about correspondence changes when only the tolerance
 * profile is edited. The cache is keyed on the element sets themselves, so it
 * survives a re-run and misses exactly when extraction actually moved.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { anchorSection } from './anchors.js';
import { shortlist } from './candidates.js';
import { adjudicate } from './llm.js';
import { verifyAssignments, combine } from './verify.js';
import { cropSections, evidencePaths, loadPinnedManifest, pinnedForSection } from '../evidence/capture.js';

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', yellow: '\x1b[33m' };
const RENDER_SCALE = 0.5;

/**
 * Identity of the QUESTION, not of the run.
 *
 * Element ids and boxes decide what is asked; k and the model decide how. A
 * tolerance edit that touches neither must not invalidate a cached answer, and
 * an extraction that moves an element must.
 */
function questionHash(pair, cfg, model) {
  const side = (set) => set.elements.map((e) =>
    `${e.id}:${Math.round(e.box.x)},${Math.round(e.box.y)},${Math.round(e.box.w)},${Math.round(e.box.h)}:${e.cls}:${e.textKey ?? ''}`).join('|');
  return createHash('sha1')
    .update(`${model}|k=${cfg.shortlist.k}|${side(pair.figma)}||${side(pair.web)}`)
    .digest('hex').slice(0, 16);
}

/** Section crops for both sides, reused when a previous stage already made them. */
async function ensureCrops(ctx, sections) {
  const outDir = ctx.config.outDir;
  const paths = evidencePaths(outDir);
  const figmaDir = join(outDir, 'evidence', 'figma-sections');
  const webDir = join(outDir, 'evidence', 'web-model');
  const framePath = join(outDir, 'evidence', 'figma-frame.png');

  const haveFigma = existsSync(join(figmaDir, 'figma-00.png'));
  const haveWeb = existsSync(join(webDir, 'web-00.png'));
  if (haveFigma && haveWeb) {
    const list = (dir, side) => sections[side].sections
      .map((s) => ({ index: s.index, path: join(dir, `${side === 'figma' ? 'figma' : 'web'}-${String(s.index).padStart(2, '0')}.png`) }))
      .filter((c) => existsSync(c.path));
    return { figma: list(figmaDir, 'figma'), web: list(webDir, 'web'), reused: true };
  }

  if (!existsSync(paths.fullPage)) return { figma: [], web: [], reused: false, missing: 'page capture' };
  if (!existsSync(framePath)) return { figma: [], web: [], reused: false, missing: 'figma frame render' };

  const browser = await chromium.launch({ headless: true });
  try {
    const meta = ctx.snapshots.figma.meta ?? {};
    const figma = await cropSections(
      browser, { path: framePath, width: meta.frameWidth, height: meta.frameHeight },
      sections.figma.sections, figmaDir, { side: 'figma', scale: 1 },
    );
    const web = await cropSections(
      browser, { path: paths.fullPage, width: sections.web.rootWidth, height: sections.web.totalHeight },
      sections.web.sections, webDir, { side: 'web', scale: RENDER_SCALE },
    );
    return { figma, web, reused: false };
  } finally {
    await browser.close();
  }
}

export async function stageCorrespond(ctx) {
  if (!ctx.elements?.pairs?.length) throw new Error('E2 requires E1 output.');

  const cfg = ctx.config.tolerance.correspond;
  const outDir = ctx.config.outDir;
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.LLM_MODEL?.trim() || 'gemini-flash-latest';
  const wanted = cfg.adjudicator?.enabled !== false && !!apiKey;

  const cacheDir = resolve('.cache', 'correspond');
  mkdirSync(cacheDir, { recursive: true });

  let crops = { figma: [], web: [] };
  let pinnedManifest = [];
  let downgrade = null;

  if (wanted) {
    pinnedManifest = loadPinnedManifest(outDir);
    crops = await ensureCrops(ctx, ctx.sections);
    if (crops.missing) downgrade = `no ${crops.missing}`;
  } else {
    downgrade = apiKey ? 'adjudicator disabled' : 'GEMINI_API_KEY not set';
  }

  const results = [];
  const usage = { calls: 0, cached: 0, failed: 0, inputTokens: 0, outputTokens: 0, accepted: 0, declined: 0, rejected: 0 };

  for (const pair of ctx.elements.pairs) {
    const tier1 = anchorSection(pair.figma, pair.web, cfg);
    const base = {
      figmaIndex: pair.figmaIndex,
      webIndex: pair.webIndex,
      sectionConfidence: pair.confidence,
      tier1Pairs: tier1.pairs.length,
    };

    if (downgrade) {
      results.push({ ...base, tier: 'anchor', aligned: tier1.pairs });
      continue;
    }

    const fEls = pair.figma.elements, wEls = pair.web.elements;
    const hash = questionHash(pair, cfg, model);
    const cachePath = join(cacheDir, `${hash}.json`);

    if (existsSync(cachePath)) {
      const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
      usage.cached++;
      usage.accepted += cached.aligned.length;
      results.push({ ...base, tier: 'llm', cached: true, aligned: cached.aligned });
      continue;
    }

    const shortlists = new Map(fEls.map((f, i) => [i, shortlist(f, wEls, cfg, {}, cfg.shortlist.k)]));
    const asked = new Set(fEls.map((_, i) => i));

    const webSection = ctx.sections.web.sections.find((s) => s.index === pair.webIndex);
    const pinnedShot = pinnedForSection(pinnedManifest, webSection);
    const figmaImage = crops.figma.find((c) => c.index === pair.figmaIndex)?.path ?? null;
    const webImage = pinnedShot?.path ?? crops.web.find((c) => c.index === pair.webIndex)?.path ?? null;

    const size = cfg.adjudicator.maxElementsPerCall;
    const answers = [];
    let anyFailure = false;

    for (let i = 0; i < fEls.length; i += size) {
      const batch = fEls.slice(i, i + size).map((figmaEl, j) => ({
        index: i + j,
        figmaEl,
        candidates: (shortlists.get(i + j) ?? []).map((c) => wEls[c.webIndex]),
      }));
      const call = await adjudicate({ figmaImage, webImage, batch, apiKey, model });
      if (!call.ok) { anyFailure = true; usage.failed++; continue; }
      answers.push(...call.assignments);
      usage.calls++;
      usage.inputTokens += call.usage.inputTokens ?? 0;
      usage.outputTokens += call.usage.outputTokens ?? 0;
    }

    // A section whose batches all failed falls back rather than shipping a
    // partial correspondence - half an answer is worse than a deterministic one,
    // because everything downstream reads coverage as meaningful.
    if (!answers.length) {
      results.push({ ...base, tier: 'anchor', fallback: 'all batches failed', aligned: tier1.pairs });
      continue;
    }

    const verified = verifyAssignments(answers, {
      figmaSet: pair.figma, webSet: pair.web, shortlists, asked,
      sectionConfidence: pair.confidence, cfg,
    });
    const aligned = combine([], verified.accepted);

    usage.accepted += verified.counts.accepted;
    usage.declined += verified.counts.declined;
    usage.rejected += verified.rejected.length;

    // Only a complete answer is cached. A section with a failed batch would
    // otherwise freeze its own gap in place for every future run.
    if (!anyFailure) writeFileSync(cachePath, JSON.stringify({ hash, model, aligned }, null, 2));

    results.push({ ...base, tier: 'llm', partial: anyFailure || undefined, aligned });
  }

  ctx.correspondence = results;
  writeFileSync(join(outDir, 'correspondence.json'), JSON.stringify({ model, downgrade, usage, results }, null, 2));

  const llmSections = results.filter((r) => r.tier === 'llm').length;
  const totalAligned = results.reduce((n, r) => n + r.aligned.length, 0);

  if (downgrade) {
    console.log(`  ${C.yellow}Tier 1 only${C.reset} — ${downgrade}. ${totalAligned} pairs across ${results.length} sections.`);
    console.log(`  ${C.dim}Measured, the adjudicator reaches 67.8% recall against Tier 1's 46.4%; this report is the lower number.${C.reset}\n`);
  } else {
    console.log(`  ${C.green}adjudicated${C.reset} ${llmSections}/${results.length} sections — ${totalAligned} pairs ` +
      `${C.dim}(${usage.cached} cached, ${usage.calls} calls, ${usage.failed} failed)${C.reset}`);
    console.log(`  ${C.dim}accepted ${usage.accepted}, declined ${usage.declined}, rejected by verification ${usage.rejected}` +
      `${usage.inputTokens ? `, ${usage.inputTokens.toLocaleString()} input tokens` : ''}${C.reset}\n`);
  }

  ctx.stageInfo = {
    sections: results.length,
    adjudicated: llmSections,
    aligned: totalAligned,
    cached: usage.cached,
    calls: usage.calls,
    inputTokens: usage.inputTokens,
    tier: downgrade ? 'anchor' : 'llm',
    out: 'out/correspondence.json',
  };
}
