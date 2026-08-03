/**
 * Rendered-font detection via CDP - parent doc 4.1.4, plan 3.7.
 *
 * ## Why this exists
 *
 * getComputedStyle returns the DECLARED family list. `font-family: Inter,
 * sans-serif` computes to that literal string even when Inter failed to load and
 * the user is staring at Arial. A silently-failed webfont is invisible to every
 * other method in this system, and it is a real, frequent production bug.
 *
 * ## Why it is more work than the parent doc implies
 *
 * `CSS.getPlatformFontsForNode` takes a CDP *DOM node id*, which a Playwright
 * ElementHandle does not give you. The parent doc (4.1.4) implies the handle
 * route:
 *
 *     handle -> DOM.describeNode(objectId) -> backendNodeId
 *            -> DOM.pushNodesByBackendIdsToFrontend -> nodeId
 *
 * That route does NOT work from Playwright: `objectId` is not part of its public
 * API, and reaching for `handle._objectId` silently yields undefined, so every
 * call fails with "Either nodeId, backendNodeId or objectId must be specified".
 * Verified the hard way - 0/75 probes succeeded on the first run.
 *
 * We stay entirely inside CDP instead:
 *
 *     DOM.getDocument -> root nodeId
 *     DOM.querySelector(root, webPath) -> nodeId
 *     CSS.getPlatformFontsForNode(nodeId)
 *
 * This works because `webPath` (parent doc 5.1) is a structural path built from
 * tag names and :nth-of-type - which is already a valid CSS selector. A design
 * decision made for stable node identity turns out to pay for itself here.
 *
 * `CSS.enable` is still required first, and is easy to miss because omitting it
 * fails with an unhelpful protocol error rather than a clear message.
 *
 * ## Cost control
 *
 * One round trip per text node is far too slow on a real page. The rendered-font
 * question is per FONT-FACE, not per node: if Inter-600 failed to load, it
 * failed everywhere it is used. So text nodes are grouped by their declared
 * signature and only a few nodes per signature are probed. Thousands of round
 * trips become tens.
 */

const SAMPLES_PER_SIGNATURE = 5;

/**
 * Whole-pass wall-clock budget. This check is valuable but it is NOT worth
 * hanging a run for: if it overruns we report reduced coverage and move on.
 * Same "degrade, never die" rule the Figma client follows for rate limits.
 */
const BUDGET_MS = 60_000;
const PER_CALL_MS = 5_000;

/** Reject rather than hang if a single CDP call stalls. */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Declared identity of a text run - the unit a webfont actually fails at. */
function signatureOf(styles) {
  return [
    styles['font-family'],
    styles['font-weight'],
    styles['font-style'],
  ].join(' | ');
}

function hasVisibleText(node) {
  if (!node.text || !node.text.trim()) return false;
  if (node.rect.w <= 0 || node.rect.h <= 0) return false;
  const s = node.styles;
  if (s.visibility === 'hidden' || s.display === 'none') return false;
  if (parseFloat(s.opacity) === 0) return false;
  return true;
}

/**
 * @returns {{signatures: Array, probes: number, failures: number}}
 */
export async function sampleRenderedFonts(page, raw, opts = {}) {
  const log = opts.log ?? console;

  // Group text-bearing nodes by declared signature.
  const groups = new Map();
  for (const node of raw.nodes) {
    if (node.isPseudo) continue;
    // Only main-document nodes are reachable by CSS selector; shadow DOM and
    // iframe nodes are counted but not probed.
    if (node.context !== 'main') continue;
    if (!hasVisibleText(node)) continue;

    const sig = signatureOf(node.styles);
    if (!groups.has(sig)) {
      groups.set(sig, {
        signature: sig,
        declaredFamily: node.styles['font-family'],
        fontWeight: node.styles['font-weight'],
        fontStyle: node.styles['font-style'],
        nodeCount: 0,
        samples: [],
      });
    }
    const g = groups.get(sig);
    g.nodeCount++;
    if (g.samples.length < SAMPLES_PER_SIGNATURE) g.samples.push(node.webPath);
  }

  const signatures = [...groups.values()];
  let probes = 0;
  let failures = 0;

  if (!signatures.length) return { signatures: [], probes: 0, failures: 0 };

  const startedAt = Date.now();
  let budgetExhausted = false;

  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable'); // required - omitting it fails obscurely

    // depth 1, NOT depth -1 with pierce. DOM.querySelector resolves server-side,
    // so only the root nodeId is needed. Asking for the full tree serializes
    // every node into one CDP message - on a 3200-node page that stalled the run
    // for minutes before producing anything.
    const { root } = await withTimeout(
      cdp.send('DOM.getDocument', { depth: 1 }),
      PER_CALL_MS * 2,
      'DOM.getDocument'
    );

    for (const g of signatures) {
      const tally = new Map();

      for (const selector of g.samples) {
        if (Date.now() - startedAt > BUDGET_MS) { budgetExhausted = true; break; }
        try {
          const { nodeId } = await withTimeout(
            cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector }),
            PER_CALL_MS,
            'DOM.querySelector'
          );
          // 0 means "no match" - a stale path, not an error.
          if (!nodeId) continue;

          const { fonts } = await withTimeout(
            cdp.send('CSS.getPlatformFontsForNode', { nodeId }),
            PER_CALL_MS,
            'CSS.getPlatformFontsForNode'
          );
          probes++;

          for (const f of fonts || []) {
            const prev = tally.get(f.familyName) || { familyName: f.familyName, glyphCount: 0, isCustomFont: f.isCustomFont };
            prev.glyphCount += f.glyphCount || 0;
            tally.set(f.familyName, prev);
          }
        } catch (err) {
          failures++;
          if (opts.verbose) log.warn?.(`      font probe failed for ${selector}: ${err.message}`);
        }
      }

      const ranked = [...tally.values()].sort((a, b) => b.glyphCount - a.glyphCount);
      g.renderedFonts = ranked;
      g.renderedFamily = ranked.length ? ranked[0].familyName : null;
      g.isCustomFont = ranked.length ? ranked[0].isCustomFont : null;

      if (budgetExhausted) break;
    }
  } finally {
    await cdp.detach().catch(() => {});
  }

  if (budgetExhausted) {
    log.warn?.(
      `      WARNING: font sampling hit its ${BUDGET_MS / 1000}s budget. ` +
        'Coverage is partial - reported as reduced coverage, never as design findings.'
    );
  }
  if (failures && !opts.verbose) {
    log.warn?.(
      `      WARNING: ${failures} font probes failed. Rendered-font findings will be ` +
        'incomplete - reported as reduced coverage, never as design findings.'
    );
  }

  const resolved = signatures.filter((g) => g.renderedFamily).length;
  return { signatures, probes, failures, resolved, budgetExhausted, elapsedMs: Date.now() - startedAt };
}
