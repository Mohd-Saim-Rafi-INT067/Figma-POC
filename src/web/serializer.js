/**
 * In-page DOM serializer - parent doc 4.1.2 / 4.1.3, plan 3.6.
 *
 * IMPORTANT: `serializePage` is stringified and executed inside the browser.
 * It must be entirely self-contained - no imports, no closures over Node scope,
 * no optional chaining on host objects that may not exist in older engines.
 * It returns plain JSON.
 *
 * It walks the DOM once, collecting only the 4.1.3 allowlist (never all ~340
 * computed properties - the payload would be enormous and 90% of it is noise).
 */

/**
 * The property allowlist - parent doc 4.1.3.
 *
 * Deliberately excluded from COMPARISON: transition, animation, cursor,
 * pointer-events, filter, scroll-behavior, transform, all vendor prefixes.
 *
 * `transform` is safe to exclude because getBoundingClientRect() already returns
 * the POST-transform box, so translate/scale/rotate are baked into the geometry
 * we do compare - reading the property too would double-count.
 *
 * `overflow` is excluded from comparison but COLLECTED, because pruning needs it
 * to drop nodes clipped out of existence by an ancestor.
 *
 * `margin` is deliberately absent - parent doc 7.3. Spacing is compared as
 * measured geometry, never as declared properties. Figma has no margin concept.
 */
export const STYLE_ALLOWLIST = [
  // Typography
  'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
  'letter-spacing', 'text-transform', 'text-decoration-line', 'text-align', 'color',
  // Box
  'width', 'height', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  // Layout
  'display', 'flex-direction', 'justify-content', 'align-items',
  'gap', 'row-gap', 'column-gap', 'position',
  // Border
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-left-radius', 'border-top-right-radius',
  'border-bottom-right-radius', 'border-bottom-left-radius',
  // Background
  'background-color', 'background-image', 'background-size', 'background-position',
  // Effects
  'box-shadow', 'text-shadow',
  // Compositing
  'opacity', 'visibility',
  // Pruning only - never compared
  'overflow-x', 'overflow-y',
];

/**
 * @param {object} opts
 * @param {string[]} opts.allowlist
 * @param {number} opts.precision  decimal places for geometry
 */
export function serializePage(opts) {
  const ALLOW = opts.allowlist;
  const PRECISION = opts.precision;

  const nodes = [];
  const stats = {
    elements: 0,
    skippedCrossOriginIframes: 0,
    shadowRoots: 0,
    sameOriginIframes: 0,
    pseudoPromoted: 0,
    unstable: 0,
  };

  // Populated by the mutation observer installed during stabilization. Elements
  // still changing at capture time are inherently unstable - a JS typewriter or
  // carousel that CSS freezing cannot stop. Flagged, not hidden.
  const unstableSet = window.__parityUnstable instanceof Set ? window.__parityUnstable : new Set();

  let nextId = 0;

  /**
   * getBoundingClientRect returns sub-pixel floats that can carry float dust.
   * Rounding to 2dp is far below the tightest tolerance in the profile (0.5px)
   * so it cannot mask a real finding, and it removes a determinism hazard.
   */
  function round(n) {
    const f = Math.pow(10, PRECISION);
    return Math.round(n * f) / f;
  }

  function readStyles(el, pseudo) {
    const cs = window.getComputedStyle(el, pseudo || null);
    const out = {};
    for (let i = 0; i < ALLOW.length; i++) {
      out[ALLOW[i]] = cs.getPropertyValue(ALLOW[i]);
    }
    if (pseudo) out.content = cs.getPropertyValue('content');
    return out;
  }

  /**
   * Structural path - parent doc 5.1.
   * Generated class names (CSS-in-JS, Tailwind JIT, CSS modules) change per
   * build and cannot key a stable mapping, so identity is positional.
   * The result is also a valid CSS selector, which the CDP font sampler reuses.
   */
  function pathSegment(el) {
    const tag = el.tagName.toLowerCase();
    const parent = el.parentElement;
    if (!parent) return tag;
    let index = 0;
    let seen = 0;
    const kids = parent.children;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].tagName === el.tagName) {
        seen++;
        if (kids[i] === el) index = seen;
      }
    }
    return seen > 1 ? tag + ':nth-of-type(' + index + ')' : tag;
  }

  /** Own text nodes only - never descendants'. Concatenating descendant text
   *  makes every ancestor look like a text node and destroys role inference. */
  function directText(el) {
    let s = '';
    const kids = el.childNodes;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].nodeType === 3) s += kids[i].nodeValue;
    }
    return s.trim() ? s : null;
  }

  function accessibleName(el) {
    const label = el.getAttribute('aria-label');
    if (label) return label;
    const alt = el.getAttribute('alt');
    if (alt) return alt;
    const title = el.getAttribute('title');
    if (title) return title;
    return null;
  }

  /** Does a pseudo-element actually paint? Most don't and must not become nodes. */
  function pseudoPaints(styles) {
    const content = styles.content;
    if (!content || content === 'none' || content === 'normal') return false;
    const bg = styles['background-color'];
    const hasBg = bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
    const hasImg = styles['background-image'] && styles['background-image'] !== 'none';
    const hasBorder = ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width']
      .some(function (k) { return parseFloat(styles[k]) > 0; });
    const hasShadow = styles['box-shadow'] && styles['box-shadow'] !== 'none';
    // A content string that is not empty paints text.
    const hasText = content !== '""' && content !== "''";
    return !!(hasBg || hasImg || hasBorder || hasShadow || hasText);
  }

  function walk(el, parentId, pathPrefix, scrollX, scrollY, frameOffset, context) {
    if (!el || el.nodeType !== 1) return null;

    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript' ||
        tag === 'meta' || tag === 'link' || tag === 'title' || tag === 'head') {
      return null;
    }

    stats.elements++;

    const styles = readStyles(el, null);
    const r = el.getBoundingClientRect();
    const id = 'w' + (nextId++);
    const webPath = pathPrefix ? pathPrefix + '>' + pathSegment(el) : pathSegment(el);

    const node = {
      id: id,
      parentId: parentId,
      tag: tag,
      webPath: webPath,
      role: el.getAttribute('role') || null,
      ariaName: accessibleName(el),
      text: directText(el),
      styles: styles,
      // Document space, plus any iframe offset so all coordinates share an origin.
      rect: {
        x: round(r.left + scrollX + frameOffset.x),
        y: round(r.top + scrollY + frameOffset.y),
        w: round(r.width),
        h: round(r.height),
      },
      context: context,
      children: [],
      isPseudo: false,
      // True when this element (or a descendant) was still mutating at capture.
      unstable: unstableSet.has(el),
    };
    if (node.unstable) stats.unstable++;
    nodes.push(node);

    // ::before / ::after - decorative bars, icon fonts and counters live here
    // constantly (parent doc 4.1.2). Promote the painting ones to real nodes.
    ['::before', '::after'].forEach(function (pseudo) {
      const ps = readStyles(el, pseudo);
      if (!pseudoPaints(ps)) return;
      stats.pseudoPromoted++;
      const pid = 'w' + (nextId++);
      nodes.push({
        id: pid,
        parentId: id,
        tag: pseudo,
        webPath: webPath + pseudo,
        role: null,
        ariaName: null,
        // Pseudo content is a quoted CSS string.
        text: ps.content && ps.content !== 'none' ? ps.content.replace(/^["']|["']$/g, '') || null : null,
        styles: ps,
        // Pseudo-elements have no independent box via the DOM API; they inherit
        // the host's box. Geometry findings on them would be meaningless, so
        // they are marked and the audit uses them for paint values only.
        rect: { x: node.rect.x, y: node.rect.y, w: node.rect.w, h: node.rect.h },
        context: context,
        children: [],
        isPseudo: true,
      });
      node.children.push(pid);
    });

    // Open shadow roots - closed ones are invisible to any script by design.
    if (el.shadowRoot) {
      stats.shadowRoots++;
      const kids = el.shadowRoot.children;
      for (let i = 0; i < kids.length; i++) {
        const cid = walk(kids[i], id, webPath + '::shadow', scrollX, scrollY, frameOffset, context + '/shadow');
        if (cid) node.children.push(cid);
      }
    }

    // Same-origin iframes. Cross-origin are COUNTED rather than silently
    // skipped, so their absence is visible in the report (plan 3.6).
    if (tag === 'iframe') {
      let doc = null;
      try {
        doc = el.contentDocument;
      } catch (e) {
        doc = null;
      }
      if (doc && doc.body) {
        stats.sameOriginIframes++;
        const off = { x: node.rect.x, y: node.rect.y };
        const cid = walk(doc.body, id, webPath + '::frame', 0, 0, off, context + '/iframe');
        if (cid) node.children.push(cid);
      } else {
        stats.skippedCrossOriginIframes++;
      }
      return id;
    }

    const kids = el.children;
    for (let i = 0; i < kids.length; i++) {
      const cid = walk(kids[i], id, webPath, scrollX, scrollY, frameOffset, context);
      if (cid) node.children.push(cid);
    }
    return id;
  }

  const sx = window.scrollX || window.pageXOffset || 0;
  const sy = window.scrollY || window.pageYOffset || 0;
  const rootId = walk(document.body, null, '', sx, sy, { x: 0, y: 0 }, 'main');

  // Corroborates the CDP rendered-font check - which faces the page believes
  // it loaded, versus what actually rendered.
  const loadedFonts = [];
  try {
    document.fonts.forEach(function (f) {
      if (f.status === 'loaded') {
        loadedFonts.push({ family: f.family.replace(/^["']|["']$/g, ''), weight: f.weight, style: f.style });
      }
    });
  } catch (e) { /* FontFaceSet unsupported */ }

  return {
    rootId: rootId,
    nodes: nodes,
    stats: stats,
    page: {
      url: location.href,
      title: document.title,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      devicePixelRatio: window.devicePixelRatio,
    },
    loadedFonts: loadedFonts,
  };
}
