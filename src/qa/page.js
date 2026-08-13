/**
 * E7 - the full-page report.
 *
 * AGGREGATES ONLY. It never reruns E1-E6: everything it needs is already on
 * disk from those stages, and re-deriving would risk a page report that
 * disagrees with the section reports beside it.
 */

/** Top issues across the whole page, in E5's order. */
export function fixFirst(sectionReports, limit = 10) {
  return sectionReports
    .flatMap((s) => s.issues.map((i) => ({ ...i, section: s.label, webIndex: s.webIndex })))
    .sort((a, b) => (b.visualSeverity ?? 0) - (a.visualSeverity ?? 0))
    .slice(0, limit);
}

export function sectionSummary(sectionReports) {
  return sectionReports.map((s) => ({
    section: `${s.figmaIndex + 1}→${s.webIndex + 1}`,
    label: s.label,
    headline: s.headline,
    issues: s.issueCount,
    critical: s.bySeverity.critical ?? 0,
    high: s.bySeverity.high ?? 0,
    medium: s.bySeverity.medium ?? 0,
    low: s.bySeverity.low ?? 0,
  }));
}

/**
 * Build the page report from already-generated section reports.
 *
 * `summary` is the one place prose is welcome, and it is still only allowed to
 * describe numbers computed here.
 */
export function buildPageReport(sectionReports, systemic, confidence, meta = {}) {
  const all = sectionReports.flatMap((s) => s.issues);
  const bySeverity = {};
  for (const i of all) bySeverity[i.severity] = (bySeverity[i.severity] ?? 0) + 1;

  const affected = all.reduce((n, i) => n + (i.affectedElements ?? 1), 0);
  const structural = all.filter((i) => i.kind === 'structural').length;

  return {
    generatedAt: new Date().toISOString(),
    pageUrl: meta.pageUrl ?? null,
    figmaFileKey: meta.figmaFileKey ?? null,
    totals: {
      sections: sectionReports.length,
      issues: all.length,
      affectedElements: affected,
      structuralClaims: structural,
      bySeverity,
      systemicGroups: systemic.length,
      sharedFixes: systemic.filter((g) => g.sharedFix).length,
    },
    // Deterministic summary. A model may replace the wording later; the numbers
    // are computed here and never move.
    summary:
      `${all.length} issues across ${sectionReports.length} sections, affecting ${affected} elements. ` +
      `${systemic.filter((g) => g.sharedFix).length} of ${systemic.length} systemic groups look like a shared token or component fix. ` +
      (structural ? `${structural} structural claim${structural === 1 ? '' : 's'}.` : 'No structural claims.'),
    fixFirst: fixFirst(sectionReports, meta.fixFirstLimit ?? 10),
    systemic,
    sections: sectionSummary(sectionReports),
    confidence,
  };
}
