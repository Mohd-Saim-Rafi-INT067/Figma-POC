/**
 * S4 + S5 stage wiring.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleFindings } from './findings.js';
import { printReport } from './console.js';
import { renderHtml } from './html.js';
import { generateProseReport } from './llm.js';
import { auditProse } from './audit.js';
import { analyse } from './analysis.js';

/** S4 - assemble findings. */
export async function stageAssemble(ctx) {
  const assembled = assembleFindings(ctx.findings, ctx.config.tolerance);
  ctx.assembled = assembled;

  writeFileSync(
    join(ctx.config.outDir, 'findings.json'),
    JSON.stringify(
      {
        meta: {
          pageUrl: ctx.config.pageUrl,
          figmaFileKey: ctx.config.figmaFileKey,
          figmaNodeId: ctx.config.figmaNodeId,
          viewportWidth: ctx.config.viewportWidth,
          generatedAt: new Date().toISOString(),
          toleranceProfile: `${ctx.config.tolerance.name} v${ctx.config.tolerance.version}`,
        },
        alignment: ctx.alignment.stats,
        counts: assembled.counts,
        findings: assembled.findings,
      },
      null,
      2
    )
  );

  ctx.stageInfo = {
    findings: assembled.findings.length,
    raw: assembled.raw,
    grouped: assembled.grouped || null,
    ...assembled.counts.bySeverity,
  };
}

/** S5 - report: console + HTML always; LLM prose when a key is available. */
export async function stageReport(ctx) {
  const { config, assembled, alignment, sections } = ctx;

  // The narrative is optional by design - parent doc 1.3, "findings are data;
  // prose is a rendering layer". A missing key costs the narrative and nothing
  // else, so it must never fail the run.
    // Deterministic interpretation first: scores, root-cause issues and fix
  // order are computed, never inferred. The model narrates them.
  const analysis = analyse(assembled, alignment, sections);
  ctx.analysis = analysis;

  const prose = await generateProseReport(assembled, alignment, sections, analysis);
  ctx.prose = prose;

  // The report call returns free-form prose, so there is no schema to constrain
  // it. Auditing after the fact is the enforcement for "the LLM never produces
  // a number" - an invented measurement is invisible otherwise.
  if (prose.ok) {
    prose.audit = auditProse(prose.markdown, assembled, alignment, sections, analysis);
    ctx.diagnostics.proseAudit = prose.audit;
    writeFileSync(join(config.outDir, 'report.md'), prose.markdown + '\n');
  }

  writeFileSync(
    join(config.outDir, 'report.html'),
    renderHtml({ assembled, alignment, sections, config, prose, analysis })
  );

  printReport(assembled, alignment, sections, analysis);

  if (prose.ok) {
    const a = prose.audit;
    const verdict = a.clean
      ? `\x1b[32m${a.numbersTraced}/${a.numbersCited} numbers traced to findings\x1b[0m`
      : `\x1b[31maudit FAILED\x1b[0m — ${a.unaccounted.length} untraceable number(s): ${a.unaccounted.join(', ')}` +
        (a.contentLeak ? '; prose treats content differences as findings' : '');
    console.log(
      `  \x1b[2mwritten summary: out/report.md ` +
      `(${prose.usage.inputTokens} in / ${prose.usage.outputTokens} out · ${prose.usage.provider}/${prose.usage.model})\x1b[0m\n` +
      `  \x1b[2mprose audit:\x1b[0m ${verdict}\n`
    );
  } else {
    console.log(`  \x1b[33mWritten summary skipped\x1b[0m \x1b[2m— ${prose.reason}\x1b[0m\n`);
  }

  ctx.stageInfo = {
    html: 'out/report.html',
    json: 'out/findings.json',
    prose: prose.ok ? 'out/report.md' : 'skipped',
  };
}
