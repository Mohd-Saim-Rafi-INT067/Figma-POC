/**
 * M2 + M4 stage wiring. Keeps cli.js declarative.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FigmaClient } from './client.js';
import { normalizeFigma } from './normalize.js';
import { resolveTokenAuthority } from './tokens.js';
import { applyFrameWidth } from '../config.js';

/** M2 - extract. */
export async function stageFigmaExtract(ctx) {
  const { config } = ctx;
  const client = new FigmaClient({
    token: config.figmaToken,
    cacheDir: config.cacheDir,
    noCache: ctx.flags.noCache,
    log: ctx.log ?? console,
  });
  ctx.figmaClient = client;

  const meta = await client.resolveVersion(config.figmaFileKey);
  const res = await client.getNodes(config.figmaFileKey, meta.version, config.figmaNodeId);

  const entry = res.nodes?.[config.figmaNodeId];
  if (!entry?.document) {
    throw new Error(
      `Figma returned no node for ${config.figmaNodeId}. ` +
        'Check the node-id belongs to this file and is a frame you can access.'
    );
  }
  if (entry.document.type !== 'FRAME' && entry.document.type !== 'COMPONENT') {
    throw new Error(
      `Node ${config.figmaNodeId} is a ${entry.document.type}, not a FRAME. ` +
        'The comparison unit is a frame (parent doc 3.1).'
    );
  }

  ctx.figma = {
    meta,
    document: entry.document,
    styles: entry.styles || {},
    components: entry.components || {},
    componentSets: entry.componentSets || {},
  };

  // Variables is tier 1; a 403 here is a normal outcome, not a failure.
  ctx.figma.variables = await client.getLocalVariables(config.figmaFileKey, meta.version);

  // Parent doc 3.1 - the frame is fixed-width, so it defines the viewport.
  // This is why M2 must run before M1.
  applyFrameWidth(config, entry.document.absoluteBoundingBox?.width ?? 0, ctx.log ?? console);

  ctx.stageInfo = {
    frame: entry.document.name,
    width: config.viewportWidth,
    cached: client.stats.cacheHits > 0,
    stale: meta.stale,
  };
}

/** M4 - normalize. */
export async function stageFigmaNormalize(ctx) {
  const { config, figma } = ctx;

  const snapshot = normalizeFigma(figma.document, {
    fileKey: config.figmaFileKey,
    nodeId: config.figmaNodeId,
    version: figma.meta.version,
    styles: figma.styles,
  });

  snapshot.meta.tokenAuthority = resolveTokenAuthority({
    variables: figma.variables,
    snapshot,
  });

  ctx.snapshots.figma = snapshot;

  const path = join(config.outDir, 'figma-ir.json');
  writeFileSync(path, JSON.stringify(snapshot, null, 2));
  ctx.stageInfo = { nodes: snapshot.nodes.length, out: path };
}
