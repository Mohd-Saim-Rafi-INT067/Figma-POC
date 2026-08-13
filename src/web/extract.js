/**
 * M1 - Web extraction. Parent doc 4.1, plan 3.5.
 *
 * The stabilization sequence is NORMATIVE. Parent doc 4.1.1 calls this the
 * single largest source of flakiness in this kind of tool, so the steps run in
 * order and each one is logged - when a run is non-deterministic you need to
 * know which step let the page move.
 *
 * The parent doc numbers 10 steps but describes two more in the prose that
 * immediately follows (the Date.now pin and prefers-reduced-motion), and BOTH
 * must run before goto. They are numbered explicitly here as steps 2-3.
 */

import { chromium } from 'playwright';
import { serializePage, STYLE_ALLOWLIST } from './serializer.js';
import { sampleRenderedFonts } from './fonts-cdp.js';

/** Injected at step 5 - parent doc 4.1.1. */
const FREEZE_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  caret-color: transparent !important;
  scroll-behavior: auto !important;
}
`;

/**
 * Best-effort overlay dismissal (step 7). A cookie banner covering the hero
 * makes every geometry finding below it wrong, so this matters more than it
 * looks. Deliberately conservative - it only clicks things that are
 * unambiguously consent/close controls.
 */
const OVERLAY_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '.ot-sdk-container #onetrust-accept-btn-handler',
  '[aria-label="Accept cookies"]',
  '[aria-label="Accept all"]',
  'button#hs-eu-confirmation-button',
  '.cc-btn.cc-dismiss',
  '.cookie-consent button.accept',
  '#cookie-accept',
  'button[data-cookiebanner="accept_button"]',
];

/** Pinned at step 2, before any page script runs. */
const DETERMINISM_INIT = `
(() => {
  const FIXED = 1700000000000;
  // Keep a handle on real wall-clock BEFORE pinning. Our own stabilization code
  // runs inside this page too, and anything measuring elapsed time against the
  // pinned clock sees 0ms forever and loops until the run is killed.
  window.__parityRealNow = Date.now.bind(Date);
  Date.now = () => FIXED;
  try {
    const D = Date;
    window.Date = class extends D {
      constructor(...a) { super(...(a.length ? a : [FIXED])); }
      static now() { return FIXED; }
    };
    window.Date.prototype = D.prototype;
  } catch (e) {}
  try { performance.now = () => 0; } catch (e) {}
  // Deterministic but still varied - a constant would break shuffles that
  // assume distinct values, and a fixed seed makes reruns identical.
  let seed = 42;
  Math.random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

  // Block LONG-DELAY timers.
  //
  // Pinning Date.now does not stop a carousel: the browser schedules timers on
  // real elapsed time regardless of what the page can read from the clock. The
  // testimonials carousel on the reference page advances during the ~20s the
  // stabilization sequence takes, so which slide is showing - and therefore the
  // height of every card and the y of everything below it - depends on how long
  // extraction happened to take. Measured across three same-session runs: 19
  // nodes moved, twelve of them in that one section by dy=36.
  //
  // Measured, not assumed: setInterval is NOT the driver (disabling it changes
  // nothing) and rAF is not either. setTimeout is. Blocking setTimeout outright
  // is not acceptable - pages defer real layout work with it - but the delays
  // separate cleanly: auto-advance uses SECOND-scale delays, content-critical
  // deferral is millisecond-scale. At a 2000ms threshold exactly 16 timers are
  // blocked, the DOM is identical at 3,270 nodes, and the carousel holds still.
  //
  // 2000 is the most conservative value that works; 250ms also stabilises and
  // blocks 40. Raise it if a site's content depends on a slow timer.
  const LONG_TIMER_MS = 2000;
  window.__parityBlockedTimers = 0;
  const rawSetTimeout = window.setTimeout.bind(window);
  const rawSetInterval = window.setInterval.bind(window);
  window.__parityRawSetTimeout = rawSetTimeout;
  window.setTimeout = function (fn, delay, ...rest) {
    if (Number(delay) >= LONG_TIMER_MS) { window.__parityBlockedTimers++; return 0; }
    return rawSetTimeout(fn, delay, ...rest);
  };
  window.setInterval = function (fn, delay, ...rest) {
    if (Number(delay) >= LONG_TIMER_MS) { window.__parityBlockedTimers++; return 0; }
    return rawSetInterval(fn, delay, ...rest);
  };
})();
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} config
 * @param {object} [opts]
 * @param {boolean} [opts.headless]
 * @param {number}  [opts.settleMs]
 * @param {boolean} [opts.skipFonts]  skip the CDP pass (used by the determinism re-run)
 */
export async function extractWeb(config, opts = {}) {
  const settleMs = opts.settleMs ?? 400;
  const log = opts.log ?? console;
  const steps = [];
  const mark = (n, label) => {
    steps.push({ step: n, label, at: Date.now() });
    if (opts.verbose) log.log(`      ${String(n).padStart(2)}. ${label}`);
  };

  if (!config.viewportWidth) {
    throw new Error(
      'viewportWidth is not set. M2 must run before M1 so the width can be derived ' +
        'from the Figma frame (parent doc 3.1, plan 3.2).'
    );
  }

  const browser = opts.browser ?? (await chromium.launch({ headless: opts.headless ?? true }));
  const ownsBrowser = !opts.browser;

  const context = await browser.newContext({
    viewport: { width: config.viewportWidth, height: config.viewportHeight },
    deviceScaleFactor: config.deviceScaleFactor ?? 1,
    // 3. prefers-reduced-motion: reduce
    reducedMotion: 'reduce',
  });
  mark(1, `viewport ${config.viewportWidth}x${config.viewportHeight}`);
  mark(3, 'emulateMedia reducedMotion=reduce');

  // 2. Pin time and randomness BEFORE any page script runs.
  await context.addInitScript(DETERMINISM_INIT);
  mark(2, 'init script: Date.now / performance.now / Math.random pinned, long timers blocked');

  const page = await context.newPage();

  try {
    // 4. Navigate.
    await page.goto(config.pageUrl, { waitUntil: 'networkidle', timeout: 90_000 });
    mark(4, 'goto (networkidle)');

    // 5. Freeze animations and transitions.
    await page.addStyleTag({ content: FREEZE_CSS });
    mark(5, 'freeze CSS injected');

    // 6. Fonts.
    await page.evaluate(() => document.fonts.ready);
    mark(6, 'document.fonts.ready');

    // 7. Dismiss known overlays.
    let dismissed = 0;
    for (const sel of OVERLAY_SELECTORS) {
      try {
        const el = await page.$(sel);
        if (el && (await el.isVisible())) {
          await el.click({ timeout: 2000 });
          dismissed++;
          await sleep(150);
        }
      } catch { /* best effort by design */ }
    }
    mark(7, `overlay dismissal (${dismissed} dismissed)`);

    // 8. Scroll to the bottom in viewport steps, forcing lazy-load and
    //    IntersectionObserver to fire. On a ~20k px page this is the slowest
    //    part of the run and the likeliest place content misbehaves.
    const scrollPasses = await page.evaluate(async (step) => {
      let passes = 0;
      const max = 400;
      let y = 0;
      while (y < document.documentElement.scrollHeight && passes < max) {
        y += step;
        window.scrollTo(0, y);
        passes++;
        await new Promise((r) => setTimeout(r, 60));
      }
      return passes;
    }, config.viewportHeight);
    mark(8, `lazy-load scroll (${scrollPasses} passes)`);

    // 9. Back to the top so geometry is measured from a known scroll position.
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(200);
    mark(9, 'scroll to top');

    // 10. Re-check fonts - lazy content brings new faces with it.
    await page.evaluate(() => document.fonts.ready);
    mark(10, 'document.fonts.ready (re-check)');

    // 11. Settle, then wait for DOM mutation quiescence.
    //
    // The freeze CSS stops CSS animations and transitions, but it cannot stop
    // JavaScript. A typewriter effect or carousel driven by setInterval keeps
    // mutating textContent regardless, and capturing mid-cycle is the single
    // largest remaining source of non-determinism.
    //
    // Waiting for quiescence handles pages that eventually settle. Pages with a
    // PERPETUAL animation never will, so the wait is capped and every element
    // still mutating is recorded as unstable rather than silently captured
    // mid-flight. Honest partial stability beats a false claim of determinism.
    await sleep(settleMs);
    const quiescence = await page.evaluate(
      async ({ quietMs, capMs }) => {
        // Real clock, not the pinned one - see DETERMINISM_INIT.
        const now = window.__parityRealNow || (() => new Date().getTime());
        window.__parityUnstable = new Set();
        let lastMutation = now();

        const observer = new MutationObserver((records) => {
          lastMutation = now();
          for (const r of records) {
            const target = r.target.nodeType === 1 ? r.target : r.target.parentElement;
            if (!target) continue;
            // Mark the element and its ancestors - a text change resizes the
            // whole chain above it, so their geometry is unstable too.
            let el = target;
            let hops = 0;
            while (el && hops < 6) {
              window.__parityUnstable.add(el);
              el = el.parentElement;
              hops++;
            }
          }
        });
        observer.observe(document.body, {
          childList: true, subtree: true, characterData: true, attributes: true,
        });

        const started = now();
        while (now() - started < capMs) {
          await new Promise((r) => setTimeout(r, 100));
          if (now() - lastMutation >= quietMs) break;
        }
        observer.disconnect();

        return {
          quiet: now() - lastMutation >= quietMs,
          waitedMs: now() - started,
          unstableElements: window.__parityUnstable.size,
        };
      },
      { quietMs: 600, capMs: 4000 }
    );
    mark(11, `settle ${settleMs}ms + quiescence (quiet=${quiescence.quiet}, waited=${quiescence.waitedMs}ms, unstable=${quiescence.unstableElements})`);

    // 11b. Motion probe.
    //
    // The mutation observer above catches content that CHANGES, but it is blind
    // to content that MOVES: a CSS-transform marquee or a scrollLeft carousel
    // mutates no DOM at all, so there is nothing to observe. On the target page
    // that blind spot hid a logo carousel whose ~35 nodes shifted by exactly
    // 327.33px between runs.
    //
    // Measuring geometry twice catches motion regardless of mechanism - DOM
    // mutation, CSS transform, or scroll. This is what makes "audit the static
    // content, skip the dynamic" implementable rather than aspirational.
    const motion = await page.evaluate(async ({ gapMs }) => {
      const key = (el) => {
        const r = el.getBoundingClientRect();
        // 1dp: well below the tightest tolerance in the profile (0.5px), and
        // coarse enough that sub-pixel float dust is not mistaken for motion.
        return [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 10) / 10).join(',');
      };
      const els = Array.from(document.querySelectorAll('*'));
      const before = new Map();
      for (const el of els) before.set(el, key(el));

      await new Promise((r) => setTimeout(r, gapMs));

      if (!(window.__parityUnstable instanceof Set)) window.__parityUnstable = new Set();
      let moved = 0;
      for (const el of els) {
        if (before.get(el) === key(el)) continue;
        moved++;
        // Mark ancestors too - a moving child drags its container's box with it.
        let n = el;
        let hops = 0;
        while (n && hops < 6) { window.__parityUnstable.add(n); n = n.parentElement; hops++; }
      }
      return { moved, total: els.length, flagged: window.__parityUnstable.size };
    }, { gapMs: 700 });

    mark(12, `motion probe (${motion.moved} moved, ${motion.flagged} flagged unstable)`);
    if (!quiescence.quiet) {
      log.warn?.(
        `      NOTE: page never reached DOM quiescence (${quiescence.unstableElements} elements still ` +
          'mutating). Those nodes are flagged unstable; findings on them are not trustworthy.'
      );
    }

    // 13. Settle scroll-driven ("pinned") sections.
    //
    // A pinned section is a tall scroll container holding a position:sticky
    // viewport, inside which an animation plays as the user scrolls. Its HEIGHT
    // is scroll distance, not layout: on the reference page one is 3,150px tall
    // to animate content occupying about 900px on screen.
    //
    // Measuring at scrollTop therefore captures the animation's FIRST FRAME.
    // Measured on that page: twelve cards that spread into a 3x4 grid were all
    // recorded stacked at a single coordinate, and correspondence for the whole
    // section collapsed (Tier 1 recall 0.071).
    //
    // Two corrections are applied together, and neither works alone:
    //
    //   1. Scroll each pinned container to the end of its animation and
    //      re-measure its subtree there.
    //   2. Re-express those rects against the STICKY VIEWPORT rather than the
    //      scroll container. Section-relative geometry is otherwise normalised
    //      against scroll distance - the design's cards span 100% of a 639px
    //      section while the page's would occupy the bottom 17% of a 3,150px
    //      one, and no matcher can reconcile that.
    //
    // The result is a compact band, the height of what a reader actually sees,
    // anchored at the container's top.
    const pinned = await page.evaluate(async ({ settleMs }) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const out = [];
      const vh = window.innerHeight;

      // Group by container: a section can hold several sticky children (the
      // reference page has one with six), and processing each would scroll and
      // re-tag the same subtree repeatedly. Keep the tallest sticky per
      // container - that is the viewport the animation plays inside.
      const byContainer = new Map();
      for (const el of document.querySelectorAll('*')) {
        if (getComputedStyle(el).position !== 'sticky') continue;
        const container = el.parentElement;
        if (!container || container === document.body || container === document.documentElement) continue;
        const prev = byContainer.get(container);
        if (!prev || el.getBoundingClientRect().height > prev.getBoundingClientRect().height) {
          byContainer.set(container, el);
        }
      }

      for (const [container, sticky] of byContainer) {

        const cRect0 = container.getBoundingClientRect();
        const sRect0 = sticky.getBoundingClientRect();
        // A scroll-driven container is much taller than the thing pinned inside
        // it, and taller than the viewport. A sticky nav is neither.
        if (cRect0.height < vh * 1.5) continue;
        if (cRect0.height < sRect0.height * 2) continue;

        const containerTop = cRect0.top + window.scrollY;

        // End of the animation: the container's bottom edge reaches the
        // viewport's bottom edge.
        const target = Math.max(0, containerTop + cRect0.height - vh);
        window.scrollTo(0, target);
        await sleep(settleMs);

        const sRect = sticky.getBoundingClientRect();
        let tagged = 0;
        for (const el of [container, ...container.querySelectorAll('*')]) {
          const r = el.getBoundingClientRect();
          el.__paritySettled = {
            x: Math.round((r.left + window.scrollX) * 10) / 10,
            // Anchor the sticky viewport at the container's top, so the section
            // occupies the space a reader sees rather than the scroll distance.
            y: Math.round((containerTop + (r.top - sRect.top)) * 10) / 10,
            w: Math.round(r.width * 10) / 10,
            h: Math.round(r.height * 10) / 10,
          };
          tagged++;
        }
        // The container itself becomes the VISUAL section: the sticky viewport's
        // height, not the scroll distance.
        container.__paritySettled = {
          x: Math.round((cRect0.left + window.scrollX) * 10) / 10,
          y: Math.round(containerTop * 10) / 10,
          w: Math.round(cRect0.width * 10) / 10,
          h: Math.round(sRect.height * 10) / 10,
        };

        out.push({
          containerTop: Math.round(containerTop),
          scrollHeight: Math.round(cRect0.height),
          visualHeight: Math.round(sRect.height),
          settledAtScroll: Math.round(target),
          nodes: tagged,
          // Where the pinned viewport sits ON SCREEN at the settled scroll.
          // The capture pass needs this to photograph the same moment the
          // geometry was measured in - without it, boxes describe the settled
          // state while pixels show the animation's first frame.
          stickyViewportRect: {
            x: Math.round(sRect.left), y: Math.round(sRect.top),
            w: Math.round(sRect.width), h: Math.round(sRect.height),
          },
          containerX: Math.round(cRect0.left + window.scrollX),
        });
      }

      window.scrollTo(0, 0);
      await sleep(settleMs);
      return out;
    }, { settleMs: 600 });

    if (pinned.length) {
      mark(13, `pinned sections settled (${pinned.length}: ${pinned.map((p) => `${p.scrollHeight}px->${p.visualHeight}px`).join(', ')})`);
      log.log?.(
        `      ${pinned.length} scroll-driven section(s) re-measured after their animation: ` +
        pinned.map((p) => `${p.nodes} nodes, ${p.scrollHeight}px scroll -> ${p.visualHeight}px visual`).join('; ')
      );
    }

    // 12. Extract.
    const raw = await page.evaluate(serializePage, {
      allowlist: STYLE_ALLOWLIST,
      precision: 1,
    });
    mark(12, `serialize (${raw.nodes.length} nodes)`);

    // The highest-value check in the system (parent doc 4.1.4) - a webfont that
    // silently failed to load is invisible to every other method here.
    if (!opts.skipFonts) {
      raw.renderedFonts = await sampleRenderedFonts(page, raw, { log, verbose: opts.verbose });
      mark(13, `CDP rendered fonts (${raw.renderedFonts.signatures.length} signatures, ${raw.renderedFonts.probes} probes)`);
    } else {
      raw.renderedFonts = { signatures: [], probes: 0, skipped: true };
    }

    // 14. Hand the stabilized page to a caller that wants pixels from it.
    //
    // DELIBERATELY LAST. Capturing a full page means scrolling, and scrolling is
    // not free on a real site - the logo carousel on the reference page advances
    // only while it is in view, so a screenshot pass run before extraction would
    // change what extraction then measures. Running it here means the hook can
    // perturb nothing: every number is already taken.
    //
    // This is the only way "pixels and measurements agree" can be guaranteed.
    // Re-running the stabilization sequence in a second browser session would
    // drift from this one silently.
    // Attach the pinned manifest BEFORE the hook runs. The hook is what
    // photographs those sections at their settled scroll, so handing it a `raw`
    // that does not yet carry `pinned` silently skips exactly that work.
    raw.pinned = pinned;

    if (opts.onStabilized) {
      await opts.onStabilized(page, raw);
      mark(14, 'onStabilized hook');
    }

    raw.steps = steps;
    raw.quiescence = quiescence;
    raw.motion = motion;
    return raw;
  } finally {
    await context.close();
    if (ownsBrowser) await browser.close();
  }
}
