/**
 * E7 - the dashboard.
 *
 * A developer QA surface, not an essay. Every issue is one scannable block:
 * severity, title, the two exact values, the delta, how many elements it speaks
 * for, the evidence image, one line of impact, one line of fix, and two links
 * that go straight to the thing.
 *
 * Images are embedded as data URIs so the file is one self-contained artefact
 * that survives being emailed.
 */

import { readFileSync, existsSync } from 'node:fs';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function dataUri(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return `data:image/png;base64,${readFileSync(path).toString('base64')}`;
  } catch { return null; }
}

const SEV_CLASS = { critical: 'sev-critical', high: 'sev-high', medium: 'sev-medium', low: 'sev-low' };

function issueBlock(issue) {
  const img = dataUri(issue.evidence);
  const rows = issue.properties.map((p) => `
      <tr>
        <td class="prop">${esc(p.label)}</td>
        <td class="design">${esc(p.design)}</td>
        <td class="arrow">→</td>
        <td class="web">${esc(p.website)}</td>
        <td class="delta">${p.delta ? esc(p.delta) : ''}${p.percent != null ? ` <span class="pct">(${p.percent > 0 ? '+' : ''}${p.percent}%)</span>` : ''}</td>
      </tr>`).join('');

  const links = [
    issue.locators?.figmaUrl ? `<a href="${esc(issue.locators.figmaUrl)}" target="_blank" rel="noopener">Open in Figma</a>` : '',
    issue.locators?.webSelector ? `<code class="sel" title="paste into devtools">${esc(issue.locators.webSelector)}</code>` : '',
  ].filter(Boolean).join('');

  return `
  <article class="issue ${SEV_CLASS[issue.severity] ?? 'sev-low'}">
    <header>
      <span class="sev">${issue.icon} ${esc(issue.severity.toUpperCase())}</span>
      <h3>${esc(issue.title)}</h3>
      ${issue.affectedElements > 1 ? `<span class="badge">${issue.affectedElements} elements</span>` : ''}
      ${issue.kind === 'structural' ? '<span class="badge structural">structural</span>' : ''}
      ${issue.matchConfidence != null ? `<span class="conf" title="correspondence confidence">match ${issue.matchConfidence}</span>` : ''}
    </header>
    ${rows ? `<table class="values">${rows}</table>` : ''}
    ${img ? `<figure><img src="${img}" alt="design left, website right"><figcaption>design ← → website</figcaption></figure>` : ''}
    <p class="impact">${esc(issue.impact)}</p>
    <p class="fix"><strong>Fix:</strong> ${esc(issue.fix)}</p>
    ${links ? `<div class="links">${links}</div>` : ''}
  </article>`;
}

function systemicBlock(g) {
  return `
  <article class="systemic ${SEV_CLASS[g.severity] ?? 'sev-low'}">
    <header>
      <span class="sev">${g.icon} ${esc(g.label)}</span>
      <span class="badge">${g.affectedElements} elements</span>
      <span class="scope">${esc(g.scope)}</span>
      ${g.sharedFix ? '<span class="badge shared">shared fix</span>' : ''}
    </header>
    <p class="values-inline">Figma: <b>${esc(g.design)}</b> → Website: <b>${esc(g.website)}</b></p>
    <p class="fix"><strong>Fix:</strong> ${esc(g.fix)}</p>
  </article>`;
}

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--line:#e2e8f0;--ink:#0f172a;--muted:#64748b;
 --crit:#dc2626;--high:#ea580c;--med:#ca8a04;--low:#94a3b8}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
 font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:28px 20px 60px}
h1{font-size:22px;margin:0 0 4px}
h2{font-size:15px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);
 margin:34px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--line)}
h3{font-size:15px;margin:0;font-weight:650}
.sub{color:var(--muted);margin:0 0 18px}
.totals{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px;min-width:104px}
.stat b{display:block;font-size:20px}
.stat span{color:var(--muted);font-size:12px}
.issue,.systemic{background:var(--card);border:1px solid var(--line);border-left-width:4px;
 border-radius:8px;padding:14px 16px;margin:0 0 12px}
.sev-critical{border-left-color:var(--crit)}.sev-high{border-left-color:var(--high)}
.sev-medium{border-left-color:var(--med)}.sev-low{border-left-color:var(--low)}
.issue header,.systemic header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.sev{font-size:11px;font-weight:800;letter-spacing:.05em}
.badge{font-size:11px;background:#eef2ff;color:#3730a3;border-radius:99px;padding:2px 9px;font-weight:650}
.badge.shared{background:#ecfdf5;color:#065f46}
.badge.structural{background:#fef3c7;color:#92400e}
.conf{font-size:11px;color:var(--muted);margin-left:auto}
.scope{font-size:11px;color:var(--muted)}
table.values{border-collapse:collapse;margin:6px 0 10px;font-size:13px}
table.values td{padding:2px 10px 2px 0;vertical-align:top}
td.prop{color:var(--muted);min-width:130px}
td.design,td.web{font-variant-numeric:tabular-nums;font-weight:600}
td.arrow{color:var(--muted)}
td.delta{color:var(--high);font-weight:650;font-variant-numeric:tabular-nums}
.pct{color:var(--muted);font-weight:400}
figure{margin:10px 0}
figure img{max-width:100%;border:1px solid var(--line);border-radius:6px;display:block}
figcaption{font-size:11px;color:var(--muted);margin-top:4px}
p.impact{margin:6px 0 4px;color:#334155}
p.fix{margin:0 0 6px}
p.values-inline{margin:4px 0}
.links{display:flex;gap:12px;align-items:center;flex-wrap:wrap;font-size:12px;margin-top:6px}
.links a{color:#4338ca;text-decoration:none;font-weight:600}
code.sel{background:#f1f5f9;border:1px solid var(--line);border-radius:4px;padding:2px 6px;
 font-size:11px;max-width:100%;overflow-wrap:anywhere}
table.sections{border-collapse:collapse;width:100%;background:var(--card);
 border:1px solid var(--line);border-radius:8px;overflow:hidden;font-size:13px}
table.sections th{text-align:left;background:#f8fafc;color:var(--muted);font-size:11px;
 text-transform:uppercase;letter-spacing:.05em;padding:8px 10px}
table.sections td{padding:7px 10px;border-top:1px solid var(--line)}
table.sections td.n{text-align:right;font-variant-numeric:tabular-nums}
.limits{background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px 14px;margin-top:14px}
.limits b{display:block;margin-bottom:4px}
.note{color:var(--muted);font-size:12px}
`;

export function renderPageReport(page, sectionReports) {
  const t = page.totals;
  const sev = (k) => t.bySeverity[k] ?? 0;

  return `<!doctype html><html lang="en"><meta charset="utf-8">
<title>Visual QA — design parity</title><style>${CSS}</style>
<div class="wrap">
  <h1>Visual QA — design parity</h1>
  <p class="sub">${esc(page.pageUrl ?? '')} · generated ${esc(page.generatedAt.slice(0, 16).replace('T', ' '))}</p>

  <div class="totals">
    <div class="stat"><b>${t.issues}</b><span>issues</span></div>
    <div class="stat"><b>${t.affectedElements}</b><span>elements affected</span></div>
    <div class="stat"><b>${sev('critical') + sev('high')}</b><span>high / critical</span></div>
    <div class="stat"><b>${t.systemicGroups}</b><span>systemic groups</span></div>
    <div class="stat"><b>${t.sharedFixes}</b><span>shared fixes</span></div>
    <div class="stat"><b>${t.sections}</b><span>sections</span></div>
  </div>
  <p>${esc(page.summary)}</p>

  <h2>Fix first</h2>
  ${page.fixFirst.map(issueBlock).join('')}

  <h2>Systemic problems</h2>
  ${page.systemic.length ? page.systemic.map(systemicBlock).join('') : '<p class="note">None.</p>'}

  <h2>Sections</h2>
  <table class="sections">
    <tr><th>Section</th><th>Content</th><th>Issues</th><th>Critical</th><th>High</th><th>Medium</th><th>Low</th></tr>
    ${page.sections.map((s) => `<tr>
      <td>${esc(s.section)}</td>
      <td>${esc(s.headline ?? s.label)}</td>
      <td class="n">${s.issues}</td><td class="n">${s.critical}</td>
      <td class="n">${s.high}</td><td class="n">${s.medium}</td><td class="n">${s.low}</td>
    </tr>`).join('')}
  </table>

  <h2>Confidence &amp; limitations</h2>
  <div class="limits">
    <b>Read these findings with the correspondence quality in mind.</b>
    ${esc(page.confidence.text)}
  </div>
</div></html>`;
}

export function renderSectionReport(report, confidence, meta) {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<title>Visual QA — ${esc(report.headline ?? report.label)}</title><style>${CSS}</style>
<div class="wrap">
  <h1>${esc(report.headline ?? report.label)}</h1>
  <p class="sub">Section ${report.figmaIndex + 1} → ${report.webIndex + 1} · ${report.issueCount} issues ·
    ${esc(Object.entries(report.bySeverity).map(([k, v]) => `${v} ${k}`).join(' · '))}</p>
  ${report.issues.map(issueBlock).join('')}
  <div class="limits">${esc(confidence.text)}</div>
</div></html>`;
}
