/**
 * E5 - issue prioritisation.
 *
 * The stage that turns a finding list into a report a person will read. Raw
 * findings are property-shaped; people are element-shaped. Nobody fixes "a
 * radius"; they fix "the CTA button".
 *
 * Two projections of the SAME finding set, neither duplicating the other:
 *
 *   NEEDS ATTENTION  grouped by element    - what do I fix?      (landing view)
 *   SYSTEMIC         grouped by property   - what is the cause?  (secondary)
 *
 * A finding belongs to both, which is why one has to be primary or the same
 * problem gets reported twice. The element view leads because it is the unit a
 * developer acts on.
 */

import { visualSeverity } from './severity.js';

const RANK = { critical: 4, high: 3, medium: 2, low: 1 };
const worst = (a, b) => ((RANK[a] ?? 0) >= (RANK[b] ?? 0) ? a : b);

/** Float dust: 0.800000011920929 is 0.8, and a reader should not have to know that. */
function tidy(v) {
  if (typeof v !== 'number') return v;
  return +v.toFixed(3);
}

/**
 * `fontFamily` and `renderedFontFamily` describe ONE fault.
 *
 * The declared family says what the CSS asked for; the rendered family says
 * what the browser actually painted. When both report the same substitution -
 * measured on the reference page: `Public Sans → Geist`, 26 occurrences each -
 * a reader sees two lines for one problem.
 *
 * They are folded into a single entry keeping the RENDERED severity, which is
 * `critical` rather than `high`: a webfont that silently failed to load is the
 * more serious statement and the one a developer must act on. When they
 * disagree - declared one thing, rendered another - both are kept, because that
 * is genuinely two pieces of information.
 */
function foldFontProperties(properties) {
  const declared = properties.find((p) => p.property === 'fontFamily');
  const rendered = properties.find((p) => p.property === 'renderedFontFamily');
  if (!declared || !rendered) return properties;

  const same = String(declared.expected).toLowerCase().replace(/\s+/g, '')
      === String(rendered.expected).toLowerCase().replace(/\s+/g, '')
    && String(declared.actual).toLowerCase().replace(/\s+/g, '')
      === String(rendered.actual).toLowerCase().replace(/\s+/g, '');
  if (!same) return properties;

  return properties
    .filter((p) => p.property !== 'fontFamily')
    .map((p) => (p.property === 'renderedFontFamily'
      ? { ...p, property: 'fontFamily', declaredAndRendered: true }
      : p));
}

/**
 * Merge every finding on one element into a single issue.
 *
 * `element.figmaIndex` is only unique within a section, so the key carries the
 * section too - otherwise element 3 of section 1 and element 3 of section 9
 * collapse into one nonsensical issue.
 */
export function mergeByElement(findings, pairs, cfg) {
  const byElement = new Map();

  for (const f of findings) {
    const key = `${f.sectionPair.figmaIndex}:${f.sectionPair.webIndex}:${f.element.figmaIndex}`;
    let issue = byElement.get(key);
    if (!issue) {
      issue = {
        key,
        sectionPair: f.sectionPair,
        element: {
          figmaIndex: f.element.figmaIndex,
          webIndex: f.element.webIndex,
          cls: f.element.cls,
          figmaNodeId: f.element.figmaNodeId,
          webSelector: f.element.webSelector,
          area: 0,
        },
        tier: f.element.tier,
        matchConfidence: f.element.matchConfidence,
        templateId: f.element.templateId,
        templateSlot: f.element.templateSlot,
        templateInstances: f.instanceCount ?? 1,
        properties: [],
        maxSeverity: 'low',
      };
      byElement.set(key, issue);
    }
    issue.properties.push({
      property: f.property,
      category: f.category,
      severity: f.severity,
      expected: tidy(f.expected),
      actual: tidy(f.actual),
      delta: tidy(f.delta),
    });
    issue.maxSeverity = worst(issue.maxSeverity, f.severity);
    issue.templateInstances = Math.max(issue.templateInstances, f.instanceCount ?? 1);
  }

  // Geometry and viewport context, needed for visual severity.
  const pairByKey = new Map(pairs.map((p) => [`${p.figmaIndex}:${p.webIndex}`, p]));
  const viewportArea = cfg.viewportWidth * cfg.viewportHeight;

  for (const issue of byElement.values()) {
    issue.properties = foldFontProperties(issue.properties);
    const pair = pairByKey.get(`${issue.sectionPair.figmaIndex}:${issue.sectionPair.webIndex}`);
    const el = pair?.web?.elements?.[issue.element.webIndex];
    issue.element.area = el?.area ?? 0;

    const absoluteY = (pair?.web?.origin?.y ?? 0) + (el?.box?.y ?? 0);
    issue.visualSeverity = visualSeverity(issue, {
      viewportArea,
      viewportHeight: cfg.viewportHeight,
      absoluteY,
    }, cfg);
    issue.absoluteY = Math.round(absoluteY);
  }

  return [...byElement.values()].sort((a, b) => b.visualSeverity - a.visualSeverity);
}

/**
 * The systemic projection: one problem, many places.
 *
 * Catches the token case the element view cannot express - "this off-palette
 * colour appears on 40 elements" is one fix, not forty. Grouped on the property
 * AND both values, so a property wrong in different ways in different places
 * stays separate.
 *
 * Also catches the pattern found while validating E4: three form fields all
 * 172px wider than designed. Those are different elements in different template
 * slots, so per-element merging keeps them apart and a reader sees three lines
 * where one would do. When every occurrence sits inside one component, the
 * group is marked `withinComponent` and can be presented as a single
 * component-wide statement.
 */
export function systemicGroups(findings, cfg) {
  const groups = new Map();

  // Fold declared+rendered font findings here as well. The element view folds
  // per element; the systemic view sees raw findings, so without this the same
  // substitution appears twice at the top of the list - measured, 26 each.
  const rendered = new Set(
    findings.filter((f) => f.property === 'renderedFontFamily')
      .map((f) => `${f.sectionPair.figmaIndex}:${f.sectionPair.webIndex}:${f.element.figmaIndex}`)
  );

  for (const f of findings) {
    if (f.property === 'fontFamily'
      && rendered.has(`${f.sectionPair.figmaIndex}:${f.sectionPair.webIndex}:${f.element.figmaIndex}`)) continue;
    const key = [f.property, String(f.expected), String(f.actual)].join('|');
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        property: f.property,
        category: f.category,
        severity: f.severity,
        expected: tidy(f.expected),
        actual: tidy(f.actual),
        delta: tidy(f.delta),
        occurrences: 0,
        elements: [],
        sections: new Set(),
        templates: new Set(),
      };
      groups.set(key, g);
    }
    g.occurrences += f.instanceCount ?? 1;
    g.severity = worst(g.severity, f.severity);
    g.sections.add(`${f.sectionPair.figmaIndex}:${f.sectionPair.webIndex}`);
    g.templates.add(f.element.templateId ?? null);
    if (g.elements.length < cfg.maxExemplars) {
      g.elements.push({ figmaNodeId: f.element.figmaNodeId, webSelector: f.element.webSelector });
    }
  }

  return [...groups.values()]
    .map((g) => ({
      ...g,
      sections: g.sections.size,
      // One value, one property, many elements - fix the token, not the elements.
      oneFix: g.occurrences >= cfg.oneFixThreshold,
      // Every occurrence inside a single component: report it as one
      // component-wide statement rather than N element lines.
      withinComponent: g.templates.size === 1 && [...g.templates][0] !== null && g.occurrences > 1,
      templates: undefined,
    }))
    .filter((g) => g.occurrences >= cfg.systemicMinOccurrences)
    .sort((a, b) => b.occurrences - a.occurrences);
}

/**
 * The volume cap, enforced here because this is where merged issues exist.
 *
 * The target is a first-time reader seeing fewer than 20 things. The cap
 * applies to MERGED ISSUES, not raw findings, which is what makes it
 * achievable: a button with four problems costs one slot, not four.
 */
export function landingView(issues, cfg) {
  const cap = cfg.landingViewCap;
  return {
    shown: issues.slice(0, cap),
    remainder: Math.max(0, issues.length - cap),
  };
}
