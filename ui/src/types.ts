/**
 * Mirrors the run record the server returns.
 *
 * Hand-written, because the source of truth is src/report/analysis.js on the
 * server side - these are the shapes it computes, reshaped by
 * src/server/app.js buildResult(). If a field here disagrees with analysis.js,
 * analysis.js is right.
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type RunStatus = 'queued' | 'running' | 'done' | 'failed';
export type StageStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';

export interface StageRecord {
  id: string;
  label: string;
  status: StageStatus;
  ms: number | null;
  info: Record<string, string | number | boolean | null> | null;
  message: string | null;
}

export interface Confidence {
  percent: number;
  verdict: string;
  notes: string[];
}

export interface ExecFacts {
  overallScore: number;
  overallStatus: string;
  structuralIntact: boolean;
  confidence: Confidence;
  totals: Record<string, number>;
  designSections: number;
  pageSections: number;
  matched: number;
  missingInWeb: number;
  extraInWeb: number;
  designHeight: number;
  pageHeight: number;
  worstSections: { section: number; label: string; score: number }[];
  bestSections: { section: number; label: string; score: number }[];
  dominantIssues: {
    title: string;
    severity: Severity;
    sections: number;
    occurrences: number;
    oneFix: boolean;
    systemic: boolean;
  }[];
}

export interface SectionScore {
  figmaIndex: number;
  webIndex: number;
  label: string;
  confidence: number;
  designHeight: number;
  pageHeight: number;
  heightRatio: number;
  score: number;
  status: string;
  problems: string[];
  bySeverity: Partial<Record<Severity, number>>;
  findings: unknown[];
}

export interface Knowledge {
  title: string;
  why?: string;
  causes?: string[];
  impact?: string[];
  investigate?: string;
  intent?: string;
}

export interface Issue {
  property: string;
  category: string;
  severity: Severity;
  occurrences: number;
  sections: number[];
  variants: number;
  oneFix: boolean;
  systemic: boolean;
  knowledge: Knowledge;
  examples: {
    expected: string | number | null;
    actual: string | number | null;
    delta: number | null;
    ratio: number | null;
    occurrenceCount: number | null;
  }[];
}

export interface FixOrderEntry {
  rank: number;
  category: string;
  label: string;
  issueCount: number;
  sectionCount: number;
  severity: Severity;
  oneFix: boolean;
  systemic: boolean;
  rationale: string;
}

export interface ProseAudit {
  numbersCited: number;
  numbersTraced: number;
  unaccounted: string[];
  contentLeak: boolean;
  clean: boolean;
}

export interface Prose {
  ok: boolean;
  sections?: Record<string, string>;
  audit?: ProseAudit | null;
  usage?: { model: string; provider: string; inputTokens: number; outputTokens: number } | null;
  reason?: string;
}

export interface RunResult {
  exec: ExecFacts | null;
  sectionScores: SectionScore[];
  issues: Issue[];
  fixOrder: FixOrderEntry[];
  counts: { bySeverity: Record<string, number>; byCategory: Record<string, number> } | null;
  alignmentStats: Record<string, number> | null;
  determinism: Record<string, unknown> | null;
  prose: Prose;
  files: { markdown: boolean; html: boolean; findings: boolean };
}

export interface RunRecord {
  id: string;
  status: RunStatus;
  input: { figmaFrameUrl: string; pageUrl: string; determinism: boolean; noCache: boolean };
  meta: {
    pageUrl: string;
    figmaFileKey: string | null;
    figmaNodeId: string | null;
    frameName?: string | null;
    viewportWidth: number | null;
    toleranceProfile: string | null;
    startedAt: string;
    finishedAt: string | null;
    durationMs: number | null;
    figmaCacheStale: boolean;
  };
  stages: StageRecord[];
  warnings: { stage: string; message: string }[];
  error: {
    stage: string | null;
    stageLabel?: string | null;
    name: string;
    message: string;
    hint: string | null;
  } | null;
  result: RunResult | null;
}

// ---- events --------------------------------------------------------------

export type RunEvent =
  | { type: 'run:start'; stages: { id: string; label: string }[]; config: Record<string, unknown> }
  | { type: 'stage:start'; id: string; label: string; index: number; total: number }
  | { type: 'stage:ok'; id: string; label: string; ms: number; info: StageRecord['info'] }
  | { type: 'stage:fail'; id: string; label: string; ms: number; error: { name: string; message: string } }
  | { type: 'stage:pending'; id: string; label: string; file: string; phase: string }
  | { type: 'run:retry'; reason: string; message: string }
  | { type: 'run:restored'; status: RunStatus; stages: StageRecord[] }
  | { type: 'run:done'; ok: boolean; ms?: number }
  | { type: 'run:unknown' };

// ---- raw findings --------------------------------------------------------

/** One row of out/runs/<id>/findings.json — the engine's own output, unreshaped. */
export interface Finding {
  id: string;
  category: string;
  type: string;
  property: string;
  expected: string | number | null;
  actual: string | number | null;
  delta?: number | null;
  ratio?: number | null;
  occurrenceCount?: number | null;
  sectionCount?: number;
  severity: Severity;
  severityReasons?: string[];
  lowConfidence?: boolean;
  fingerprint?: string;
  sections: {
    figmaIndex: number;
    webIndex: number;
    figmaLabel: string;
    webLabel: string;
    confidence: number;
  }[];
}

export interface FindingsFile {
  meta: {
    pageUrl: string;
    figmaFileKey: string;
    figmaNodeId: string;
    viewportWidth: number;
    generatedAt: string;
    toleranceProfile: string;
  };
  counts: { bySeverity: Record<string, number>; byCategory: Record<string, number> };
  findings: Finding[];
}

export interface Health {
  ok: boolean;
  figmaToken: boolean;
  llm: 'gemini' | 'anthropic' | null;
  activeRunId: string | null;
}

export interface ApiError {
  error: string;
  hint: string | null;
  field?: string;
  activeRunId?: string;
}
