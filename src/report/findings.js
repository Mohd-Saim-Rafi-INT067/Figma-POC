/**
 * S4 - Finding assembly. V1 plan phase F.
 *
 * Takes S3's raw findings and turns them into a report-ready list: grouped,
 * severity-adjusted, fingerprinted, ordered.
 *
 * Deterministic. Same findings in, byte-identical list out.
 */

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];
const SEVERITY_RANK = Object.fromEntries(SEVERITY_ORDER.map((s, i) => [s, i]));

/**
 * Below this S2 match confidence, findings are demoted one severity step.
 *
 * 0.75 sits between the reference page's two weak pairs (0.669, 0.680) and the
 * rest of the distribution, whose next value up is 0.785. It is a threshold on
 * observed data, not a round number chosen for looking tidy - and it belongs in
 * the tolerance profile once V2 makes confidence a first-class input.
 */
const MATCH_CONFIDENCE_FLOOR = 0.75;

/** FNV-1a. Not cryptographic - it only needs to be stable and cheap. */
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Bucket a value for fingerprinting - parent doc 9.4.
 *
 * Deliberately coarse but not collapsing: accepting "this section is 80px
 * taller than designed" must NOT silently accept a later regression to 800px.
 * Numbers bucket to their rounded value; strings are used as-is.
 */
function bucket(value) {
  if (typeof value === 'number') return String(Math.round(value));
  if (value === null || value === undefined) return '-';
  return String(value).slice(0, 40);
}

/**
 * Fingerprint identifies "the same finding" across runs, so a future baseline
 * feature can mark one accepted. Computed even though V1 has no baselines -
 * it validates the format now, for free.
 */
function fingerprint(f) {
  const loc = f.sectionPair
    ? `f${f.sectionPair.figmaIndex}:w${f.sectionPair.webIndex}`
    : 'page';
  return hash([loc, f.category, f.type, f.property, bucket(f.actual)].join('|'));
}

/**
 * Group findings that are the same problem seen in several sections.
 *
 * Without this, one off-scale spacing value used across six sections reads as
 * six separate problems. Parent doc 9.2 makes the same argument for component
 * instances: "40 findings vs 1" is the difference between a report a designer
 * reads and one they close.
 *
 * Grouping key deliberately excludes the section, and includes `expected` so a
 * value that is wrong in different ways in different places stays separate.
 */
function groupKey(f) {
  return [f.category, f.type, f.property, bucket(f.expected), bucket(f.actual)].join('|');
}

export function assembleFindings(rawFindings, tolerance) {
  const upgradeAt = tolerance.severity?.occurrenceUpgradeThreshold ?? 10;

  // --- group ---------------------------------------------------------------
  const groups = new Map();
  for (const f of rawFindings) {
    const key = groupKey(f);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        ...f,
        id: null,
        sections: f.sectionPair ? [f.sectionPair] : [],
        sectionCount: f.sectionPair ? 1 : 0,
        occurrenceCount: f.occurrenceCount ?? null,
      });
      continue;
    }
    if (f.sectionPair) {
      existing.sections.push(f.sectionPair);
      existing.sectionCount++;
    }
    if (f.occurrenceCount != null) {
      existing.occurrenceCount = (existing.occurrenceCount ?? 0) + f.occurrenceCount;
    }
    // A group is only as trustworthy as its least trustworthy member.
    if (f.lowConfidence) existing.lowConfidence = true;
  }

  // --- severity adjustment + fingerprint -----------------------------------
  const assembled = [...groups.values()].map((f) => {
    let severity = f.severity;
    const reasons = [];

    // Parent doc 9.3: systemic beats incidental. A value used 40 times is a
    // decision; used twice it is a rounding error.
    if ((f.occurrenceCount ?? 0) > upgradeAt || f.sectionCount > 3) {
      const rank = SEVERITY_RANK[severity];
      if (rank > 0) {
        severity = SEVERITY_ORDER[rank - 1];
        reasons.push(
          f.sectionCount > 3
            ? `appears in ${f.sectionCount} sections`
            : `${f.occurrenceCount} occurrences`
        );
      }
    }

    // A finding inside a section that was still moving at capture time cannot
    // support a confident severity claim.
    if (f.lowConfidence) {
      const rank = SEVERITY_RANK[severity];
      if (rank < SEVERITY_ORDER.length - 1) {
        severity = SEVERITY_ORDER[rank + 1];
        reasons.push('section contains dynamic content');
      }
    }

    // Nor can a finding derived from a weak section match.
    //
    // S2 reports a confidence per pair - 0.669 to 0.938 on the reference page -
    // and every finding inherits it through `sectionPair.confidence`. Until now
    // that number was carried and ignored: a finding from a 0.67 match was
    // presented exactly as loudly as one from a 0.94 match, even though the
    // first may be comparing two sections that are not counterparts at all.
    //
    // Below the floor the comparison is not trustworthy enough to shout about,
    // so severity drops one step and the reason says why. It is deliberately
    // NOT suppressed - a weak match is still evidence, just weaker.
    const matchConfidence = f.sections?.length
      ? Math.max(...f.sections.map((s) => s.confidence ?? 1))
      : 1;
    if (matchConfidence < MATCH_CONFIDENCE_FLOOR) {
      const rank = SEVERITY_RANK[severity];
      if (rank < SEVERITY_ORDER.length - 1) {
        severity = SEVERITY_ORDER[rank + 1];
        reasons.push(`section match only ${matchConfidence.toFixed(2)} confident`);
      }
    }

    const out = { ...f, severity, severityReasons: reasons };
    out.fingerprint = fingerprint(out);
    out.id = `${out.category}-${out.fingerprint}`;
    return out;
  });

  // --- order ---------------------------------------------------------------
  // Severity first, then blast radius, then a stable tiebreak so reruns match.
  assembled.sort((a, b) => {
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (s !== 0) return s;
    const occ = (b.occurrenceCount ?? 0) - (a.occurrenceCount ?? 0);
    if (occ !== 0) return occ;
    const sec = b.sectionCount - a.sectionCount;
    if (sec !== 0) return sec;
    return a.id.localeCompare(b.id);
  });

  const counts = { bySeverity: {}, byCategory: {} };
  for (const f of assembled) {
    counts.bySeverity[f.severity] = (counts.bySeverity[f.severity] || 0) + 1;
    counts.byCategory[f.category] = (counts.byCategory[f.category] || 0) + 1;
  }

  return {
    findings: assembled,
    counts,
    grouped: rawFindings.length - assembled.length,
    raw: rawFindings.length,
  };
}

export { SEVERITY_ORDER };
