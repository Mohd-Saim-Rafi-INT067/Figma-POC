/**
 * Deep links, at ELEMENT scope.
 *
 * Phase 0 added these at section scope, because V1's findings were aggregates
 * and a section was the most precise honest target. E2 correspondence changed
 * that: every issue now names one design node and one page element, and
 * identifier coverage is 100% on both sides (1613/1613 figma, 1224/1224 web),
 * so element-level links are free.
 *
 * Two links per issue, and both are one click from acting:
 *   - a Figma deep link that opens the file with that node selected;
 *   - a CSS selector that pastes straight into devtools.
 */

/** Figma's URL form uses "-" where the REST API uses ":". */
export function figmaUrl(fileKey, nodeId) {
  if (!fileKey || !nodeId) return null;
  // Component-instance ids look like "I2743:7244;2958:49606". The semicolon is
  // not URL-safe and silently truncates the link at the first one.
  const id = encodeURIComponent(String(nodeId).replace(/:/g, '-'));
  return `https://www.figma.com/design/${fileKey}?node-id=${id}`;
}

/** `document.querySelector(...)` ready to paste. */
export function devtoolsSnippet(selector) {
  if (!selector) return null;
  return `document.querySelector(${JSON.stringify(selector)})`;
}

export function attachLocators(issues, { figmaFileKey, pageUrl }) {
  return issues.map((issue) => ({
    ...issue,
    locators: {
      figmaNodeId: issue.element.figmaNodeId ?? null,
      figmaUrl: figmaUrl(figmaFileKey, issue.element.figmaNodeId),
      webSelector: issue.element.webSelector ?? null,
      devtools: devtoolsSnippet(issue.element.webSelector),
      pageUrl: pageUrl ?? null,
      scope: 'element',
    },
  }));
}
