/**
 * Interpretation layer: what each finding MEANS.
 *
 * A measurement without interpretation is a diff log. "Design 639, page 3150"
 * is correct and useless; "roughly five times taller, so the page is probably
 * rendering an expanded list where the design showed one state" tells a
 * developer where to look.
 *
 * ## Why this is a static table and not an LLM prompt
 *
 * The probable causes of a webfont falling back to Arial are the same every
 * run. Regenerating them per-run would cost tokens, vary between runs, and
 * make the report non-deterministic for no gain. Encoding them once means they
 * are reviewable, correctable, and identical every time - and it leaves the
 * model doing what it is actually good at: prioritising and narrating THIS
 * run's particular combination.
 *
 * Entries may be a function of the finding when the interpretation genuinely
 * differs by direction or magnitude (taller vs shorter is not the same bug).
 */

/** @typedef {{title,why,causes:string[],impact:string[],investigate:string,intent?:string}} Entry */

const HEIGHT = (f) => {
  const ratio = Number(f.ratio) || (Number(f.actual) / Number(f.expected)) || 1;
  const taller = ratio > 1;
  const extreme = ratio > 2.5 || ratio < 0.5;

  return {
    title: taller ? 'Section renders taller than designed' : 'Section renders shorter than designed',
    why: taller
      ? `The implementation is approximately ${ratio.toFixed(1)}× the designed height. ` +
        (extreme
          ? 'A difference this large is rarely spacing — it usually means substantially more content is being rendered than the design accounted for.'
          : 'This is large enough to shift everything below it and change how much of the page a visitor sees before scrolling.')
      : `The implementation is roughly ${Math.round((1 - ratio) * 100)}% shorter than designed. ` +
        'Content the design allowed room for may be missing, collapsed, or rendering at a smaller size.',
    causes: taller
      ? (extreme
          ? ['More cards, rows, or list items rendered than the design showed',
             'An accordion or tab panel rendering permanently expanded',
             'A carousel rendered as a full stacked list rather than one slide',
             'Repeated component rendering driven by real data volume']
          : ['Extra padding or margin on the section container',
             'Text wrapping onto more lines than the design allowed for',
             'An additional element inside the section',
             'A larger line-height than designed'])
      : ['Content not yet implemented',
         'A collapsed or hidden sub-component',
         'Tighter padding than designed',
         'Fewer items rendered than the design showed'],
    impact: taller
      ? ['Increased scrolling to reach later content',
         'Everything below this point shifts down the page',
         'Visual rhythm between sections is broken']
      : ['Content may be missing or truncated',
         'Section reads as cramped relative to its neighbours'],
    investigate: taller
      ? 'Compare the number of child items rendered against the design frame. If they match, check the section container for padding and gap overrides.'
      : 'Confirm every element in the design frame is present in the DOM before treating this as a spacing issue.',
    intent: extreme
      ? 'Most likely a deliberate content decision (real data vs a design placeholder) rather than a styling bug — worth confirming before changing CSS.'
      : 'Ambiguous — could be either a styling regression or an intentional content change.',
  };
};

/** @type {Record<string, Entry | ((f:object)=>Entry)>} */
export const KNOWLEDGE = {
  'section.height': HEIGHT,
  'document.height': (f) => ({
    title: 'Overall page height differs from the design',
    why:
      `The whole page is ${Number(f.ratio) > 1 ? 'taller' : 'shorter'} than the design frame ` +
      `(${f.expected}px → ${f.actual}px). This is the sum of the per-section differences below, ` +
      'not an independent problem — fixing the individual sections resolves it.',
    causes: ['Accumulated per-section height differences', 'Additional content rendered across several sections'],
    impact: ['Total scroll length differs from what was designed'],
    investigate: 'Work through the per-section height findings; this figure will follow.',
    intent: 'Derived — not a defect in its own right.',
  }),

  'section.width': {
    title: 'Section width differs from the design',
    why:
      'Both sides are measured at the same viewport width, so a width difference means the section ' +
      'is not filling its container as designed.',
    causes: ['A max-width constraint on the section', 'Unexpected horizontal padding or margin', 'A container that is not full-bleed'],
    impact: ['Content is narrower or wider than intended', 'Horizontal alignment with neighbouring sections breaks'],
    investigate: 'Check the section container for max-width, margin auto, or a wrapper constraining it.',
  },

  'section.backgroundColor': (f) => ({
    title: 'Section background differs from the design',
    why:
      `The dominant surface colour changed from ${f.expected} to ${f.actual} ` +
      `(ΔE ${f.delta}). ` +
      (Number(f.delta) > 40
        ? 'A difference this large is a theme change — light to dark or similar — not a shade tweak.'
        : 'This is a visible shade difference rather than a theme change.'),
    causes: Number(f.delta) > 40
      ? ['A different theme variant applied to this section',
         'A dark-mode or inverted style leaking into the default theme',
         'The wrong background token referenced']
      : ['A hardcoded hex instead of the design-system token',
         'An opacity or overlay compositing over the intended colour',
         'A near-miss colour copied by eye rather than from the design'],
    impact: Number(f.delta) > 40
      ? ['Substantial contrast change against surrounding sections',
         'Text and control contrast ratios may no longer meet accessibility targets',
         'Brand consistency across the page is broken']
      : ['Subtle inconsistency with the rest of the palette',
         'Section reads as slightly "off" without an obvious cause'],
    investigate: 'Compare the section background against the design token. If it is a large change, check whether a theme class is being applied.',
    intent: Number(f.delta) > 40
      ? 'Large enough that it is likely intentional — confirm against the current design intent before changing.'
      : 'Likely accidental — small deviations are usually hand-entered values.',
  }),

  'section.palette': {
    title: 'Colour used on the page is not in the matched design section',
    why:
      'A colour is painted on the live page that has no perceptual counterpart in the corresponding ' +
      'design section. Off-palette colours accumulate quietly and are the usual mechanism by which a ' +
      'design system erodes.',
    causes: ['A hardcoded hex rather than a design token',
             'A third-party or embedded component bringing its own styles',
             'A hover, focus, or state colour not represented in the design frame',
             'A gradient or overlay compositing to an unplanned value'],
    impact: ['Palette drift away from the design system',
             'Inconsistent colour between similar components',
             'Harder to re-theme later'],
    investigate: 'Search the stylesheet for the literal hex. If it comes from a component library, decide whether to token-ise or accept it.',
    intent: 'Usually accidental — deliberate colours normally make it into the design file.',
  },

  'section.palette.summary': {
    title: 'Multiple off-palette colours concentrated in one section',
    why:
      'Several colours in this section have no counterpart in the design. A cluster like this usually ' +
      'points at one source rather than many separate mistakes.',
    causes: ['An embedded third-party widget with its own stylesheet',
             'A component built before the design system existed',
             'An image or icon set contributing unplanned colours'],
    impact: ['This section is visually inconsistent with the rest of the page'],
    investigate: 'Look for a single shared ancestor or component responsible for most of them before treating them individually.',
  },

  'type.renderedFontFamily': (f) => ({
    title: `Declared font is not the font actually rendering`,
    why:
      `The browser rendered ${f.actual} where ${f.expected} was declared, across ${f.occurrenceCount ?? 'several'} ` +
      'visible elements. This is invisible to CSS inspection — the computed style still reports the intended ' +
      'family — so it can persist unnoticed for a long time. It changes letterforms, text width, and rhythm ' +
      'everywhere the font is used.',
    causes: ['The webfont file failed to load (404, CORS, or blocked request)',
             'An @font-face src path or format mismatch',
             'The font-family name in CSS not matching the @font-face declaration',
             'Missing preload causing the fallback to win and never be replaced',
             'The font not licensed or not deployed to the production host'],
    impact: ['Typography and brand identity differ from the design',
             'Text occupies different width, changing wrapping and spacing',
             'Visual hierarchy weakens where weights differ between the two families',
             'Affects every page using this font, not only this section'],
    investigate: 'Open the network panel and confirm the font file loads. Then check the @font-face family name matches the CSS exactly.',
    intent: 'Almost certainly accidental. This is a load failure, not a design decision.',
  }),

  'type.fontFamily': {
    title: 'Font family used on the page is not in the design section',
    why: 'A typeface appears on the page that the matched design section does not use.',
    causes: ['A component library shipping its own font stack',
             'A fallback chain resolving differently than intended',
             'Content pasted with inline font styling'],
    impact: ['Typographic inconsistency within the section'],
    investigate: 'Trace which element declares the family and whether it should inherit instead.',
  },

  'type.fontSizePx': {
    title: 'Font size is off the design type scale',
    why:
      'A size is rendering that has no near equivalent in the design section. Sizes off the scale ' +
      'weaken the visual hierarchy — headings and body text stop reading as distinct tiers.',
    causes: ['A hardcoded px value instead of a scale token',
             'A rem/px conversion rounding differently than expected',
             'Browser-default sizing on an unstyled element',
             'A responsive clamp() resolving to an intermediate value at this viewport'],
    impact: ['Visual hierarchy is less clear', 'Type scale drifts from the design system'],
    investigate: 'Check whether the element uses a scale token. If it uses clamp() or a fluid size, confirm the value at this exact viewport width.',
  },

  'type.fontWeight': {
    title: 'Font weight is not used in the design section',
    why: 'A weight is rendering that the design section does not use, which changes emphasis relationships.',
    causes: ['The requested weight not being available in the loaded font, so the browser synthesises or substitutes',
             'A hardcoded numeric weight rather than a token',
             'A variable-font axis not wired up'],
    impact: ['Emphasis and hierarchy differ from the design',
             'Synthetic bolding looks visibly different from a true bold cut'],
    investigate: 'Confirm the weight exists in the loaded font files — a missing cut is the most common cause.',
  },

  'layout.gapMeasured': {
    title: 'Spacing value is off the design scale',
    why:
      'A measured gap does not match any spacing value in the design section. This is measured from ' +
      'rendered geometry, so it is independent of whether the developer used gap, margin, or padding — ' +
      'the rendered result genuinely differs.',
    causes: ['A hardcoded px value instead of a spacing token',
             'Margin collapsing producing an unintended effective gap',
             'A default component margin not overridden',
             'Line-height contributing to the space between blocks'],
    impact: ['Rhythm and density differ from the design',
             'Small inconsistencies compound over a long page'],
    investigate: 'Check whether the spacing comes from a token. Watch for collapsed margins, which often explain a gap no single rule accounts for.',
    intent: 'Usually accidental — off-scale values are rarely deliberate.',
  },

  'border.radius': {
    title: 'Corner radius is off the design scale',
    why: 'A radius is rendering that has no near equivalent in the design section.',
    causes: ['A hardcoded value rather than a radius token',
             'A component library default',
             'A percentage radius resolving differently at this size'],
    impact: ['Inconsistent component shape language'],
    investigate: 'Check the element against the radius scale.',
  },

  'border.radius.pill': {
    title: 'Fully-rounded element where the design has none',
    why:
      'The page renders a fully-rounded (pill) shape in a section where the design uses only finite radii. ' +
      'Compared as a category rather than a number, because a pill is expressed as border-radius: 9999px ' +
      'in CSS and as a real value in Figma.',
    causes: ['A pill-shaped variant used where a rounded-rect was designed',
             'A component default rounding'],
    impact: ['Shape language differs from the design'],
    investigate: 'Confirm the correct component variant is being used.',
  },

  'section.nodeCount': {
    title: 'Section contains substantially more or fewer elements than designed',
    why:
      'A density signal, not a defect on its own. A large difference usually corroborates a height ' +
      'finding in the same section and points at content volume rather than styling.',
    causes: ['More or fewer items rendered from real data',
             'Additional wrapper markup',
             'Content not yet implemented'],
    impact: ['Usually corroborating evidence for another finding rather than an issue in itself'],
    investigate: 'Read alongside the height finding for the same section.',
    intent: 'Frequently intentional — real content volume rarely matches a design placeholder.',
  },

  section: (f) => (f.type === 'missing-in-web'
    ? {
        title: 'Design section not found on the page',
        why: 'A section present in the design has no counterpart on the live page.',
        causes: ['Not yet implemented', 'Conditionally rendered and not shown in this state', 'Removed deliberately after the design was made'],
        impact: ['Designed content is absent for visitors'],
        investigate: 'Confirm whether this section is intentionally omitted or still outstanding.',
        intent: 'Needs a human decision — the tool cannot tell "unbuilt" from "deliberately dropped".',
      }
    : {
        title: 'Page section not present in the design',
        why:
          'The page renders a top-level section the design frame does not contain. Commonly a header, ' +
          'banner, or region designed elsewhere rather than a genuine addition.',
        causes: ['Designed in a separate frame (headers and footers usually are)',
                 'Added after the design was finalised',
                 'A component the design shows merged into an adjacent section'],
        impact: ['Usually none — worth confirming rather than fixing'],
        investigate: 'Check whether this section is designed in another Figma frame before treating it as unplanned.',
        intent: 'Usually benign.',
      }),
};

/** Resolve the interpretation for a finding. Always returns an entry. */
export function interpret(finding) {
  const entry = KNOWLEDGE[finding.property];
  const resolved = typeof entry === 'function' ? entry(finding) : entry;
  return (
    resolved ?? {
      title: finding.property,
      why: 'No interpretation is registered for this property yet.',
      causes: [],
      impact: [],
      investigate: 'Inspect the element manually.',
    }
  );
}
