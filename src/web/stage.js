/**
 * M1 + M3 stage wiring, plus the determinism self-check.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractWeb } from './extract.js';
import { normalizeWeb } from './normalize.js';

/** M1 - extract. */
export async function stageWebExtract(ctx) {
  const { config } = ctx;

  // --web-only skips M2, so there is no frame width to derive from.
  if (!config.viewportWidth) {
    if (!config.viewportWidthOverride) {
      throw new Error(
        '--web-only needs a viewport width, and M2 (which derives it from the Figma ' +
          'frame) was skipped.\n  Set VIEWPORT_WIDTH in .env, or run the full pipeline.'
      );
    }
    config.viewportWidth = config.viewportWidthOverride;
  }

  ctx.webRaw = await extractWeb(config, {
    verbose: ctx.flags.verbose,
    log: console,
  });

  ctx.stageInfo = {
    nodes: ctx.webRaw.nodes.length,
    scrollHeight: ctx.webRaw.page.scrollHeight,
    fontSignatures: ctx.webRaw.renderedFonts.signatures.length,
    probes: ctx.webRaw.renderedFonts.probes,
    xOriginIframes: ctx.webRaw.stats.skippedCrossOriginIframes || null,
  };
}

/** M3 - normalize. */
export async function stageWebNormalize(ctx) {
  const { config } = ctx;

  const snapshot = normalizeWeb(ctx.webRaw, {
    viewportWidth: config.viewportWidth,
    viewportHeight: config.viewportHeight,
  });

  ctx.snapshots.web = snapshot;

  const path = join(config.outDir, 'web-ir.json');
  writeFileSync(path, JSON.stringify(snapshot, null, 2));
  ctx.stageInfo = { nodes: snapshot.nodes.length, out: path };
}

/**
 * Determinism self-check - plan 3.5.
 *
 * Extract a second time and diff the IR. Any non-empty diff is a stabilization
 * bug. This is cheap, and it is the only honest way to claim the extractor is
 * deterministic - "it looked the same twice" is not a claim, it is a hope.
 *
 * The `capturedAt` timestamp is excluded because it is a snapshot header field,
 * not extracted data.
 */
export async function stageDeterminismCheck(ctx) {
  const { config } = ctx;

  const raw2 = await extractWeb(config, {
    // The CDP pass is skipped: it samples up to 5 nodes per signature and is
    // slow, and it does not participate in the geometry/style determinism
    // question this check exists to answer.
    skipFonts: true,
    log: console,
  });
  const second = normalizeWeb(raw2, {
    viewportWidth: config.viewportWidth,
    viewportHeight: config.viewportHeight,
  });

  const first = ctx.snapshots.web;
  const strip = (snap) => {
    const clone = JSON.parse(JSON.stringify(snap));
    delete clone.capturedAt;
    delete clone.meta.renderedFontCoverage;
    delete clone.meta.warnings;
    clone.nodes.forEach((n) => {
      if (n.type) {
        delete n.type.renderedFontFamily;
        delete n.type.renderedIsCustomFont;
      }
    });
    return clone;
  };

  const strippedFirst = strip(first);
  const strippedSecond = strip(second);

  const a = JSON.stringify(strippedFirst);
  const b = JSON.stringify(strippedSecond);

  if (a === b) {
    ctx.diagnostics.determinism = { identical: true, nodes: first.nodes.length };
    ctx.stageInfo = { identical: true, nodes: first.nodes.length };
    return;
  }

  // A node flagged unstable in EITHER run is one the extractor already told us
  // it could not stabilize (a JS animation). Counting those as determinism
  // failures would be double-reporting a known, disclosed limitation - but
  // ignoring them silently would be worse. Both numbers are reported.
  const unstableIds = new Set();
  for (const snap of [first, second]) {
    for (const n of snap.nodes) if (n._web?.unstable) unstableIds.add(n.id);
  }

  // Diff the STRIPPED snapshots, not the raw ones. Diffing raw nodes surfaces
  // the fields strip() exists to ignore (renderedFontFamily is absent from the
  // second run by design) and masks the real divergence behind them.
  const byId = new Map(strippedSecond.nodes.map((n) => [n.id, n]));
  const diffs = [];
  let unstableDiffs = 0;
  let stableDiffs = 0;

  for (const n1 of strippedFirst.nodes) {
    const n2 = byId.get(n1.id);
    const isUnstable = unstableIds.has(n1.id);

    if (!n2) {
      diffs.push({ id: n1.id, path: n1.sourceRef.webPath, issue: 'missing in second run', unstable: isUnstable });
      isUnstable ? unstableDiffs++ : stableDiffs++;
      continue;
    }
    for (const key of ['boxAbsolute', 'text', 'type', 'fill', 'border', 'opacity']) {
      const s1 = JSON.stringify(n1[key]);
      const s2 = JSON.stringify(n2[key]);
      if (s1 !== s2) {
        isUnstable ? unstableDiffs++ : stableDiffs++;
        // Cap only the recorded samples; keep counting all of them.
        if (diffs.length < 40) {
          diffs.push({
            id: n1.id, path: n1.sourceRef.webPath, field: key, unstable: isUnstable,
            first: s1?.slice(0, 90), second: s2?.slice(0, 90),
          });
        }
        break;
      }
    }
  }

  ctx.diagnostics.determinism = {
    identical: false,
    // The claim that actually matters: everything the extractor did NOT flag as
    // unstable reproduced exactly.
    identicalOutsideUnstable: stableDiffs === 0,
    nodeCountFirst: first.nodes.length,
    nodeCountSecond: second.nodes.length,
    flaggedUnstableNodes: unstableIds.size,
    unstableDiffs,
    stableDiffs,
    diffs,
  };

  writeFileSync(
    join(config.outDir, 'determinism-diff.json'),
    JSON.stringify(ctx.diagnostics.determinism, null, 2)
  );

  ctx.stageInfo = {
    identical: false,
    stableDiffs,
    unstableDiffs,
    flaggedUnstable: unstableIds.size,
    out: 'out/determinism-diff.json',
  };
}
