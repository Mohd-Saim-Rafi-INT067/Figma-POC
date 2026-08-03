/**
 * P6 - Measured spacing. Parent doc 7.3.
 *
 * "A developer who writes `margin-bottom: 24px` where the designer set
 * `itemSpacing: 24` renders IDENTICALLY - but declared-property comparison flags
 * it as a mismatch."
 *
 * Figma has no margin concept at all, so there is nothing to compare a CSS
 * margin against. Both sides therefore derive spacing from geometry alone, with
 * the identical function, and whether the developer used `gap`, `margin`,
 * `padding` or absolute positioning becomes irrelevant. This single rule removes
 * an entire class of false positives.
 *
 * Direction is likewise INFERRED from where the children actually are, never
 * read from `flex-direction` or `layoutMode` - same principle, and it means a
 * CSS grid and a Figma auto-layout column compare cleanly.
 */

const round = (n) => +n.toFixed(1);

/**
 * Which axis are these children stacked along?
 *
 * Counts how many consecutive sibling pairs are cleanly separated on each axis.
 * A column has children that do not overlap vertically; a row has children that
 * do not overlap horizontally. Whichever axis separates more pairs wins.
 *
 * This beats "compare centre variance" because a wide row of short items and a
 * tall column of wide items both have large variance on the wrong axis.
 */
function inferDirection(children) {
  if (children.length < 2) return 'none';

  const countSeparations = (axis) => {
    const pos = axis === 'y' ? (b) => b.y : (b) => b.x;
    const size = axis === 'y' ? (b) => b.h : (b) => b.w;
    const sorted = [...children].sort((a, b) => pos(a.boxAbsolute) - pos(b.boxAbsolute));
    let separated = 0;
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1].boxAbsolute;
      const cur = sorted[i].boxAbsolute;
      if (pos(cur) >= pos(prev) + size(prev) - 0.5) separated++;
    }
    return separated;
  };

  const vertical = countSeparations('y');
  const horizontal = countSeparations('x');

  if (vertical === 0 && horizontal === 0) return 'none'; // stacked/overlapping
  return vertical >= horizontal ? 'column' : 'row';
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : round((s[mid - 1] + s[mid]) / 2);
}

/**
 * Gaps between consecutive siblings along the stack axis.
 * Overlapping siblings yield no gap at all rather than a negative one - a
 * negative "gap" is not a spacing value, it is an overlap, and feeding it into
 * a spacing histogram would corrupt the scale.
 */
function measureGaps(children, direction) {
  if (direction === 'none') return [];
  const pos = direction === 'column' ? (b) => b.y : (b) => b.x;
  const size = direction === 'column' ? (b) => b.h : (b) => b.w;

  const sorted = [...children].sort((a, b) => pos(a.boxAbsolute) - pos(b.boxAbsolute));
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].boxAbsolute;
    const cur = sorted[i].boxAbsolute;
    const gap = pos(cur) - (pos(prev) + size(prev));
    if (gap >= -0.5) gaps.push(round(Math.max(0, gap)));
  }
  return gaps;
}

/**
 * Padding measured as the inset from the parent's box to its children's extremes.
 *
 * Note this measures the parent's BORDER box to the child extremes, so it folds
 * border width in with padding. That is intentional: both sides compute it the
 * same way, so it stays comparable, and it is what a designer actually perceives
 * as the inset.
 */
function measurePadding(parent, children) {
  if (!children.length) return [null, null, null, null];
  const p = parent.boxAbsolute;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of children) {
    const b = c.boxAbsolute;
    if (b.w <= 0 && b.h <= 0) continue;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  if (!Number.isFinite(minX)) return [null, null, null, null];

  // [top, right, bottom, left]
  return [
    round(minY - p.y),
    round(p.x + p.w - maxX),
    round(p.y + p.h - maxY),
    round(minX - p.x),
  ];
}

/**
 * Annotate every node in a snapshot with measured spacing.
 * Must run AFTER pruning - transparent wrappers otherwise contribute thousands
 * of phantom 0px gaps and swamp the real spacing scale.
 */
export function measureSpacing(snapshot) {
  const byId = new Map(snapshot.nodes.map((n) => [n.id, n]));
  const stats = { withGaps: 0, withPadding: 0, totalGaps: 0, directions: { row: 0, column: 0, none: 0 } };

  for (const node of snapshot.nodes) {
    const children = node.children.map((id) => byId.get(id)).filter(Boolean);
    if (!children.length) {
      node.layout = { ...node.layout, direction: 'none', gapMeasured: null, gapsMeasured: [], paddingMeasured: [null, null, null, null] };
      continue;
    }

    const direction = inferDirection(children);
    const gaps = measureGaps(children, direction);
    const padding = measurePadding(node, children);

    stats.directions[direction]++;
    if (gaps.length) { stats.withGaps++; stats.totalGaps += gaps.length; }
    if (padding.some((v) => v !== null)) stats.withPadding++;

    node.layout = {
      ...node.layout,
      direction,
      // Median is the representative value; the full list feeds the section-level
      // spacing histogram in S3, where a single median would hide the scale.
      gapMeasured: median(gaps),
      gapsMeasured: gaps,
      paddingMeasured: padding,
    };
  }

  return { snapshot: { ...snapshot, meta: { ...snapshot.meta, spacingStats: stats } }, stats };
}
