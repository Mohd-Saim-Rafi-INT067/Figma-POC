/**
 * Self-contained HTML report. No external requests, light + dark.
 */

import { formatDeltaE } from './knowledge.js';

/**
 * The deltaE carried by a finding, or null.
 *
 * `delta` is NOT always a deltaE - on geometry and typography findings it is
 * pixels, and labelling "Δ 4" as a colour distance would be a lie. Only colour
 * findings carry one, in `delta` (backgroundColor mismatch) or in
 * `nearestInDesign` (off-palette colour, where there is no expected value).
 */
function colorDeltaE(f) {
  if (f.category !== 'color') return null;
  const v = f.nearestInDesign ?? f.delta;
  return v === undefined || v === null ? null : v;
}

const esc = (s) =>
  String(s ?? '—')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** A colour finding carries a hex string - render the actual swatch. */
const swatch = (v) => {
  const m = String(v ?? '').match(/^#([0-9A-Fa-f]{6})/);
  return m ? `<span class="sw" style="background:#${m[1]}"></span>` : '';
};

/**
 * The design side of a finding row.
 *
 * An extra-in-web finding has no `expected` by definition - the point of the
 * finding is that the design has no counterpart. Rendering an empty cell there
 * reads as missing data, so fall back to the closest colour the engine did find
 * (compare.js nearestColorInDesign), and failing that say why it is empty.
 */
function designSide(f) {
  if (f.expected !== null && f.expected !== undefined && f.expected !== '') {
    return `${swatch(f.expected)}${esc(f.expected)}`;
  }
  if (f.nearestColorInDesign) {
    return (
      `${swatch(f.nearestColorInDesign)}${esc(f.nearestColorInDesign)}` +
      ` <span class="dim small">nearest</span>`
    );
  }
  if (String(f.property).startsWith('border.radius')) return '<span class="dim small">no radii in design</span>';
  if (f.property === 'section') return '<span class="dim small">no matching design section</span>';
  if (String(f.property).startsWith('section.palette')) return '<span class="dim small">no comparable colour</span>';
  return '<span class="dim small">not in design</span>';
}

/**
 * Where the finding is, as two things you can act on rather than one you cannot.
 *
 * "§4→5" tells a reader which section pair without telling them how to reach it.
 * The Figma link opens the exact frame section; the selector pastes into
 * devtools. Both come from report/index.js attachLocators - section-scoped,
 * because V1 findings are section aggregates.
 */
function locatorCell(f, where) {
  const loc = f.locators ?? {};
  const label = loc.figmaUrl
    ? `<a href="${esc(loc.figmaUrl)}" target="_blank" rel="noopener">${esc(where)}</a>`
    : esc(where);
  const selector = loc.webSelector
    ? `<div class="dim small sel" title="${esc(loc.webSelector)}">${esc(loc.webSelector)}</div>`
    : '';
  return `${label}${selector}`;
}

const SEV = ['critical', 'high', 'medium', 'low'];

function findingRow(f) {
  const where = f.sections.length
    ? (f.sections.length === 1
        ? `§${f.sections[0].figmaIndex + 1}→${f.sections[0].webIndex + 1}`
        : `${f.sections.length} sections`)
    : 'page';
  const dE = colorDeltaE(f);
  const notes = [
    f.occurrenceCount ? `×${f.occurrenceCount}` : null,
    f.ratio ? `ratio ${f.ratio}` : null,
    dE !== null
      ? formatDeltaE(dE)
      : f.delta !== undefined && f.delta !== null ? `Δ ${f.delta}` : null,
    ...(f.severityReasons ?? []),
    f.lowConfidence ? 'dynamic content' : null,
  ].filter(Boolean);

  return `<tr class="sev-${f.severity}">
    <td><span class="badge ${f.severity}">${f.severity}</span></td>
    <td class="mono dim">${locatorCell(f, where)}</td>
    <td class="mono">${esc(f.property)}</td>
    <td class="mono">${designSide(f)}</td>
    <td class="mono">${swatch(f.actual)}${esc(f.actual)}</td>
    <td class="dim small">${esc(notes.join(' · '))}</td>
  </tr>`;
}

function alignmentRows(alignment) {
  return alignment.pairs.map((p) => {
    if (p.figma && p.web) {
      const ratio = p.web.height / p.figma.height;
      const flag = ratio > 1.5 || ratio < 0.67 ? ' warn' : '';
      return `<tr>
        <td class="mono">${p.figma.index + 1}</td>
        <td class="mono">${p.web.index + 1}</td>
        <td>${esc(p.web.headline ?? p.figma.headline ?? '')}</td>
        <td class="mono">${Math.round(p.figma.height)}px</td>
        <td class="mono">${Math.round(p.web.height)}px</td>
        <td class="mono${flag}">×${ratio.toFixed(2)}</td>
        <td class="mono">${p.confidence.toFixed(2)}</td>
      </tr>`;
    }
    const side = p.figma ? 'missing in page' : 'extra in page';
    const s = p.figma ?? p.web;
    return `<tr class="gap">
      <td class="mono">${p.figma ? p.figma.index + 1 : '—'}</td>
      <td class="mono">${p.web ? p.web.index + 1 : '—'}</td>
      <td>${esc(s.headline ?? '')}</td>
      <td class="mono" colspan="3">${esc(side)} · ${Math.round(s.height)}px</td>
      <td class="mono dim">—</td>
    </tr>`;
  }).join('');
}

const scoreClass = (s) => (s >= 90 ? 'ok' : s >= 75 ? 'good' : s >= 55 ? 'fair' : s >= 35 ? 'poor' : 'bad');

/** Score as a bar — a shape is faster to scan down a column than a number. */
const scoreBar = (score) =>
  `<span class="meter ${scoreClass(score)}"><i style="width:${score}%"></i></span>`;

function fixOrderRows(order) {
  return order.map((s) => `<tr>
    <td class="mono rank">${s.rank}</td>
    <td><strong>${esc(s.label)}</strong><div class="dim small">${esc(s.rationale)}</div></td>
    <td><span class="badge ${s.severity}">${s.severity}</span></td>
    <td class="mono small">${s.issueCount} issue${s.issueCount > 1 ? 's' : ''}<br>${s.sectionCount} section${s.sectionCount > 1 ? 's' : ''}</td>
    <td>${s.oneFix ? '<span class="chip one">one fix</span>' : s.systemic ? '<span class="chip sys">systemic</span>' : ''}</td>
  </tr>`).join('');
}

function issueCard(issue) {
  const k = issue.knowledge;
  const ex = issue.findings.slice(0, 3).map((f) =>
    `<li class="mono small">${designSide(f)} <span class="dim">→</span> ${swatch(f.actual)}${esc(f.actual)}` +
    (f.ratio ? ` <span class="dim">×${f.ratio}</span>` : '') + '</li>'
  ).join('');

  return `<article class="issue sev-${issue.severity}">
    <header>
      <span class="badge ${issue.severity}">${issue.severity}</span>
      <h3>${esc(k.title)}</h3>
      <div class="dim small">
        ${issue.sections.length} section${issue.sections.length > 1 ? 's' : ''}
        ${issue.occurrences ? ` · ${issue.occurrences} occurrence${issue.occurrences > 1 ? 's' : ''}` : ''}
        ${issue.oneFix ? ' · <span class="chip one">one fix</span>' : issue.systemic ? ' · <span class="chip sys">systemic</span>' : ''}
      </div>
    </header>
    <p>${esc(k.why)}</p>
    ${ex ? `<div class="sub">Examples</div><ul class="ex">${ex}</ul>` : ''}
    ${k.causes?.length ? `<div class="sub">Likely causes</div><ul>${k.causes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
    ${k.impact?.length ? `<div class="sub">Impact</div><ul>${k.impact.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
    ${k.investigate ? `<div class="sub">Where to look</div><p class="small">${esc(k.investigate)}</p>` : ''}
    ${k.intent ? `<div class="sub">Intent</div><p class="small dim">${esc(k.intent)}</p>` : ''}
  </article>`;
}

function sectionHealthRows(scores) {
  return scores.map((s) => `<tr>
    <td class="mono">${s.figmaIndex + 1}→${s.webIndex + 1}</td>
    <td>${esc(s.label)}</td>
    <td class="mono">${scoreBar(s.score)} <span class="${scoreClass(s.score)}">${s.score}</span></td>
    <td class="small">${esc(s.status)}</td>
    <td class="mono small">${s.designHeight} → ${s.pageHeight}<span class="dim"> ×${s.heightRatio}</span></td>
    <td class="small dim">${esc(s.problems.slice(0, 3).join(' · ')) || 'no findings'}</td>
  </tr>`).join('');
}

export function renderHtml({ assembled, alignment, sections, config, prose, analysis }) {
  const { findings, counts, grouped, raw } = assembled;
  const a = alignment.stats;
  const { exec, sectionScores, issues, fixOrder: order } = analysis;

  const sevChips = SEV.filter((s) => counts.bySeverity[s])
    .map((s) => `<span class="badge ${s}">${counts.bySeverity[s]} ${s}</span>`)
    .join(' ');

  const proseBlock = prose?.ok
    ? `<section><h2>Summary</h2><div class="prose">${
        // Minimal markdown: headings, bold, code, paragraphs. The model is
        // instructed to write plain prose with short headings, so a full
        // markdown parser would be more machinery than the content needs.
        esc(prose.markdown)
          .replace(/^### (.+)$/gm, '<h4>$1</h4>')
          .replace(/^## (.+)$/gm, '<h3>$1</h3>')
          .replace(/^# (.+)$/gm, '<h3>$1</h3>')
          .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
          .replace(/`([^`]+)`/g, '<code>$1</code>')
          .replace(/^- (.+)$/gm, '<li>$1</li>')
          .replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>')
          .split(/\n{2,}/).map((p) => (p.startsWith('<') ? p : `<p>${p}</p>`)).join('')
      }</div></section>`
    : `<section><h2>Summary</h2><p class="dim">Written summary not generated — ${esc(prose?.reason ?? 'skipped')}</p></section>`;

  return `<title>Design Parity — ${esc(new URL(config.pageUrl).hostname)}</title>
<style>
  :root {
    --bg:#fff; --fg:#16181d; --dim:#6b7280; --line:#e5e7eb; --panel:#f9fafb;
    --crit:#7c3aed; --high:#dc2626; --med:#d97706; --low:#9ca3af; --ok:#059669;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0d0f13; --fg:#e6e8eb; --dim:#8b94a3; --line:#242830; --panel:#14171d; }
  }
  :root[data-theme="dark"] { --bg:#0d0f13; --fg:#e6e8eb; --dim:#8b94a3; --line:#242830; --panel:#14171d; }
  :root[data-theme="light"] { --bg:#fff; --fg:#16181d; --dim:#6b7280; --line:#e5e7eb; --panel:#f9fafb; }

  body { background:var(--bg); color:var(--fg); font:15px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif;
         margin:0; padding:2rem 1.25rem 4rem; }
  main { max-width:1080px; margin:0 auto; }
  h1 { font-size:1.6rem; margin:0 0 .25rem; }
  h2 { font-size:1.05rem; margin:2.5rem 0 .75rem; padding-bottom:.4rem; border-bottom:1px solid var(--line); }
  h3 { font-size:1rem; margin:1.4rem 0 .4rem; }
  h4 { font-size:.92rem; margin:1rem 0 .3rem; }
  .dim { color:var(--dim); }
  .small { font-size:.82rem; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.85rem; }
  /* Selectors are long and must never widen the table - truncate, full value in the title. */
  .sel { max-width:16ch; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; opacity:.75; }
  td a { color:inherit; text-decoration:underline; text-underline-offset:2px; text-decoration-style:dotted; }
  td a:hover { text-decoration-style:solid; }
  .meta { color:var(--dim); font-size:.88rem; margin:0 0 1.25rem; }
  .meta a { color:inherit; }

  .cards { display:flex; flex-wrap:wrap; gap:.75rem; margin:1rem 0; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:.7rem 1rem; }
  .card .n { font-size:1.35rem; font-weight:650; }
  .card .l { font-size:.78rem; color:var(--dim); text-transform:uppercase; letter-spacing:.04em; }

  .badge { display:inline-block; padding:.1rem .5rem; border-radius:999px; font-size:.74rem;
           font-weight:600; color:#fff; text-transform:uppercase; letter-spacing:.03em; }
  .badge.critical{background:var(--crit)} .badge.high{background:var(--high)}
  .badge.medium{background:var(--med)} .badge.low{background:var(--low)}

  .scroll { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; min-width:660px; }
  th,td { text-align:left; padding:.42rem .6rem; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-size:.76rem; text-transform:uppercase; letter-spacing:.04em; color:var(--dim); font-weight:600; }
  tr.gap td { background:color-mix(in srgb, var(--med) 8%, transparent); }
  .warn { color:var(--high); font-weight:600; }
  .sw { display:inline-block; width:.72rem; height:.72rem; border-radius:3px;
        border:1px solid var(--line); margin-right:.35rem; vertical-align:-1px; }
  code { font-family:ui-monospace,monospace; font-size:.86em; background:var(--panel);
         padding:.08rem .3rem; border-radius:4px; }
  .prose p { margin:.6rem 0; }
  .prose li { margin:.2rem 0; }
  img,svg { max-width:100%; }

  /* score + status */
  .ok{color:var(--ok)} .good{color:#0891b2} .fair{color:var(--med)}
  .poor{color:var(--high)} .bad{color:var(--crit)}
  .hero { display:flex; gap:1.5rem; align-items:center; flex-wrap:wrap;
          background:var(--panel); border:1px solid var(--line); border-radius:10px;
          padding:1.1rem 1.4rem; margin:1.25rem 0; }
  .score { text-align:center; min-width:110px; }
  .score .big { font-size:3rem; font-weight:700; line-height:1; }
  .score .l { font-size:.78rem; color:var(--dim); margin-top:.2rem; }
  .heroNotes { flex:1 1 320px; }
  .heroNotes p { margin:.15rem 0; }
  .verdict { font-weight:600; }
  .heroNotes ul { margin:.3rem 0 0; padding-left:1.1rem; }

  .meter { display:inline-block; width:70px; height:7px; border-radius:4px;
           background:var(--line); overflow:hidden; vertical-align:middle; margin-right:.4rem; }
  .meter i { display:block; height:100%; background:currentColor; }
  td.rank { font-weight:700; font-size:1rem; }

  .chip { display:inline-block; padding:.05rem .45rem; border-radius:4px; font-size:.72rem;
          font-weight:600; border:1px solid currentColor; }
  .chip.one { color:var(--ok); }
  .chip.sys { color:var(--med); }

  .issue { border:1px solid var(--line); border-left:3px solid var(--line);
           border-radius:8px; padding:.9rem 1.1rem; margin:.85rem 0; background:var(--panel); }
  .issue.sev-critical { border-left-color:var(--crit); }
  .issue.sev-high { border-left-color:var(--high); }
  .issue.sev-medium { border-left-color:var(--med); }
  .issue.sev-low { border-left-color:var(--low); }
  .issue header { display:flex; align-items:baseline; gap:.6rem; flex-wrap:wrap; }
  .issue h3 { margin:0; font-size:1rem; }
  .issue header .small { flex-basis:100%; }
  .issue p { margin:.5rem 0; }
  .issue ul { margin:.25rem 0 .6rem; padding-left:1.15rem; }
  .issue ul.ex { list-style:none; padding-left:0; }
  .issue .sub { font-size:.72rem; text-transform:uppercase; letter-spacing:.05em;
                color:var(--dim); font-weight:600; margin-top:.6rem; }
</style>

<main>
  <h1>Design Parity Report</h1>
  <p class="meta">
    <a href="${esc(config.pageUrl)}">${esc(config.pageUrl)}</a>
    &nbsp;·&nbsp; Figma frame <span class="mono">${esc(config.figmaNodeId)}</span>
    &nbsp;·&nbsp; viewport ${config.viewportWidth}px
    &nbsp;·&nbsp; ${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))}
  </p>

  <div class="hero">
    <div class="score ${scoreClass(exec.overallScore)}">
      <div class="big">${exec.overallScore}</div>
      <div class="l">/ 100 · ${esc(exec.overallStatus)}</div>
    </div>
    <div class="heroNotes">
      <p class="verdict ${exec.structuralIntact ? 'ok' : 'poor'}">
        ${exec.structuralIntact
          ? `Structure intact — all ${exec.designSections} design sections were found on the page.`
          : `Structure incomplete — ${exec.missingInWeb} design section(s) not found on the page.`}
      </p>
      <p class="small">Match confidence <strong>${exec.confidence.percent}%</strong> — ${esc(exec.confidence.verdict)}</p>
      <ul class="small dim">${exec.confidence.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>
    </div>
  </div>

  <div class="cards">
    <div class="card"><div class="n">${findings.length}</div><div class="l">findings</div></div>
    <div class="card"><div class="n">${issues.length}</div><div class="l">root-cause issues</div></div>
    <div class="card"><div class="n">${a.matched}/${a.figmaSections}</div><div class="l">sections matched</div></div>
    <div class="card"><div class="n">${Math.round(sections.figma.totalHeight)} → ${Math.round(sections.web.totalHeight)}</div><div class="l">total height px</div></div>
  </div>
  <p>${sevChips || '<span class="dim">No findings.</span>'}
     ${grouped ? `<span class="dim small">&nbsp;·&nbsp;${raw} raw findings, ${grouped} grouped away</span>` : ''}</p>

  <p class="dim small">Section-level comparison. Text content is used only to align sections and is never reported as a finding — design copy and live copy legitimately differ.</p>

  ${proseBlock}

  <section>
    <h2>Recommended fix order</h2>
    <div class="scroll"><table>
      <tr><th></th><th>area</th><th>severity</th><th>scope</th><th></th></tr>
      ${fixOrderRows(order)}
    </table></div>
  </section>

  <section>
    <h2>Key issues <span class="dim small">— grouped by root cause</span></h2>
    ${issues.slice(0, 8).map(issueCard).join('')}
  </section>

  <section>
    <h2>Section health</h2>
    <div class="scroll"><table>
      <tr><th>pair</th><th>section</th><th>score</th><th>status</th><th>height</th><th>problems</th></tr>
      ${sectionHealthRows(sectionScores)}
    </table></div>
  </section>

  <section>
    <h2>Section alignment</h2>
    <div class="scroll"><table>
      <tr><th>design</th><th>page</th><th>section</th><th>design h</th><th>page h</th><th>ratio</th><th>conf</th></tr>
      ${alignmentRows(alignment)}
    </table></div>
  </section>

  <section>
    <h2>All findings <span class="dim small">— the raw measurements</span></h2>
    <div class="scroll"><table>
      <tr><th>severity</th><th>where</th><th>property</th><th>design</th><th>page</th><th>notes</th></tr>
      ${findings.map(findingRow).join('') || '<tr><td colspan="6" class="dim">No findings.</td></tr>'}
    </table></div>
  </section>
</main>`;
}
