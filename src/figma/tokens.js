/**
 * Token authority tier resolution - plan 2.3 and its addendum.
 *
 *   Tier 1   Variables            Enterprise-gated.   Authoritative.
 *   Tier 2   Published Styles     Any plan.           Near-authoritative.
 *   Tier 2.5 Nominated canvases   Any plan.           Independent reference.   [Phase 4]
 *   Tier 3   Inferred from frame  Always.             Weak, and CIRCULAR.
 *
 * The circularity of tier 3 is the reason 2.5 exists: inferring tokens from the
 * very frame being audited means the frame defines the standard it is judged
 * against, so it can never report "this uses a value the system does not define".
 *
 * Phase 1 scope: detect and report which tier is available. Building the actual
 * token set (and fetching nominated canvases for 2.5) is Phase 4.
 */

/** Was the Variables API reachable, and did it return anything usable? */
export function assessVariables(variablesResponse) {
  if (!variablesResponse || variablesResponse.available === false) {
    return { available: false, reason: variablesResponse?.reason || 'not fetched', count: 0 };
  }
  const collections = variablesResponse.meta?.variableCollections || {};
  const variables = variablesResponse.meta?.variables || {};
  const count = Object.keys(variables).length;
  return {
    available: count > 0,
    reason: count ? null : 'Variables API reachable but the file defines none',
    count,
    collectionCount: Object.keys(collections).length,
  };
}

/**
 * Styles coverage across the frame.
 *
 * Presence of a file-level styles map is not enough - what matters is how many
 * NODES actually reference a style. On the target file that was 34/1828 (1.9%),
 * which is why tier 2 does not survive there (plan 9 Q4).
 */
export function assessStyles(snapshot) {
  const fileStyles = snapshot.meta?.fileStyles || {};
  const total = snapshot.nodes.length;
  let referencing = 0;
  for (const n of snapshot.nodes) {
    const refs = n._figma?.styleRefs;
    if (refs && Object.keys(refs).length) referencing++;
  }
  const coverage = total ? referencing / total : 0;
  return {
    fileStyleCount: Object.keys(fileStyles).length,
    referencingNodes: referencing,
    totalNodes: total,
    coverage,
    // Below this, a "design system via styles" is a handful of strays rather
    // than a system, and inferring from it would be worse than not using it.
    available: coverage >= 0.15 && Object.keys(fileStyles).length > 0,
  };
}

export function assessBoundVariables(snapshot) {
  let bound = 0;
  for (const n of snapshot.nodes) {
    const bv = n._figma?.boundVariables;
    if (bv && Object.keys(bv).length) bound++;
  }
  return { boundNodes: bound, totalNodes: snapshot.nodes.length };
}

/**
 * Decide which tier is operative and say why - the "why" goes in the report,
 * because "your palette has 9 tokens" and "we guessed your palette has 9 tokens"
 * warrant very different levels of trust.
 */
export function resolveTokenAuthority({ variables, snapshot, nominatedCanvases = [] }) {
  const vars = assessVariables(variables);
  const styles = assessStyles(snapshot);
  const bound = assessBoundVariables(snapshot);

  if (vars.available && bound.boundNodes > 0) {
    return {
      tier: 'variables',
      label: 'Tier 1 - Variables (authoritative)',
      detail: `${vars.count} variables in ${vars.collectionCount} collections; ${bound.boundNodes} bound nodes`,
      circular: false,
      vars, styles, bound,
    };
  }

  if (styles.available) {
    return {
      tier: 'styles',
      label: 'Tier 2 - Published Styles (near-authoritative)',
      detail: `${styles.fileStyleCount} styles, referenced by ${styles.referencingNodes}/${styles.totalNodes} nodes (${(styles.coverage * 100).toFixed(1)}%)`,
      circular: false,
      vars, styles, bound,
    };
  }

  if (nominatedCanvases.length) {
    return {
      tier: 'canvases',
      label: 'Tier 2.5 - Nominated design-system canvases',
      detail: `token source: ${nominatedCanvases.join(', ')}`,
      circular: false,
      vars, styles, bound,
    };
  }

  return {
    tier: 'inferred',
    label: 'Tier 3 - Inferred from the frame under test (weak)',
    detail:
      `Variables: ${vars.available ? 'yes' : vars.reason}. ` +
      `Styles: ${styles.referencingNodes}/${styles.totalNodes} nodes (${(styles.coverage * 100).toFixed(1)}%).`,
    // The flag the report must surface loudly.
    circular: true,
    circularWarning:
      'Tokens are inferred from the same frame being audited, so the frame defines ' +
      'the standard it is judged against. This CANNOT detect "the page uses a value ' +
      'the design system does not define". Nominate design-system canvases for tier 2.5.',
    vars, styles, bound,
  };
}
