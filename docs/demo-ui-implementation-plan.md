# Demo UI — Implementation Plan

**Goal:** a presentable web UI wrapping the existing audit pipeline, for a senior-management demo.
**Task list / tracker:** `docs/demo-ui-task-list.md`
**Architecture it wraps:** `docs/v1-architecture.md`
**Pipeline it wraps:** `docs/v1-implementation-plan.md` (built, working end-to-end)

**Rule this plan follows:** *the UI is an orchestration layer. The comparison engine is not touched.*

---

## 1. The constraint, stated concretely

"Do not change the comparison logic" is enforceable, not aspirational. These files must have **zero
diff** at the end of this work:

```
src/figma/client.js      src/web/extract.js        src/ir/color.js       src/pipeline/prune.js
src/figma/normalize.js   src/web/serializer.js     src/ir/fonts.js       src/pipeline/spacing.js
src/figma/tokens.js      src/web/normalize.js      src/ir/schema.js      src/pipeline/stage.js
src/figma/stage.js       src/web/fonts-cdp.js      src/ir/text.js        src/sections/*.js
src/report/*.js          config/tolerance-default.json
```

Exactly **two** existing files are edited, both mechanically (§3). Everything else is additive.

A verification step belongs in the task list: after Phase 1, `npm run audit` must produce byte-identical
`out/findings.json` for the same inputs as before the refactor. If it doesn't, the refactor was not
mechanical.

> **Do this first:** the repo is not under version control (`git init` has never been run here). The
> `cli.js` split in §3.2 is the one change with any risk of behavioural drift, and there is currently no
> way to diff or revert it. Initialise git and commit the working state before Phase 1.

---

## 2. Shape

```
ui/  React 18 + Vite + Tailwind        src/server/  Express            src/pipeline/run.js
┌──────────────────────────┐  HTTP   ┌────────────────────┐  calls   ┌──────────────────────┐
│ AuditForm                │ ──────► │ POST /api/audit    │ ───────► │ runPipeline(config,  │
│ ProgressPanel      ◄─SSE─┤ ◄────── │ GET  …/events      │ ◄─events─│   flags, { onEvent })│
│ ReportView               │ ──────► │ GET  …/runs/:id    │          └──────────┬───────────┘
│ RawFindings              │ ──────► │ GET  …/:file       │                     │ unchanged
└──────────────────────────┘         └────────────────────┘                     ▼
                                                                    M2 M4 M1 M3 DET P5 P6
                                                                    S1 S2 S3 S4 S5
```

Four layers, one of which already exists and stays frozen.

| Layer | Status | Owns |
|---|---|---|
| `src/{figma,web,ir,pipeline,sections,report}` | **frozen** | the comparison engine |
| `src/pipeline/run.js` | **new** | the stage list + the run loop, lifted out of `cli.js` |
| `src/server/` | **new** | HTTP, run registry, SSE, per-run artifacts |
| `ui/` | **new** | React demo app |

`src/cli.js` becomes one of *two* consumers of `runPipeline`. That is what makes "reuse the existing
pipeline" literally true rather than a claim: there is one stage list, and both front-ends run it.

---

## 3. Changes to existing files — 2 files

### 3.1 `src/config.js` — accept per-request overrides

Today `resolveConfig()` reads `FIGMA_FRAME_URL` and `PAGE_URL` from `process.env` (`config.js:108-116`).
The UI supplies both per request. Mutating `process.env` per request would be a race condition waiting
to happen, so the signature takes them instead:

```js
export function resolveConfig({
  toleranceProfile = 'default',
  figmaFrameUrl,          // falls back to process.env.FIGMA_FRAME_URL
  pageUrl,                // falls back to process.env.PAGE_URL
  outDir,                 // falls back to <root>/out
  viewportWidth,          // falls back to process.env.VIEWPORT_WIDTH
} = {}) { … }
```

Every field falls back to the env var it uses today, so **the CLI passes nothing and behaves
identically**. The body changes from `process.env.PAGE_URL` to `pageUrl ?? process.env.PAGE_URL`, three
times, plus an `outDir` parameter on the existing `mkdirSync`.

**Security line, worth writing down:** `FIGMA_TOKEN`, `GEMINI_API_KEY` and `ANTHROPIC_API_KEY` stay
**env-only**. They are never accepted from an HTTP request and never returned in a response. The UI
gets to choose *what* to audit, not *whose credentials* to audit it with.

**`outDir` is the whole of per-run isolation.** Every artifact write in the pipeline already goes
through `ctx.config.outDir` — verified at `figma/stage.js:81`, `web/stage.js:50,164`,
`pipeline/stage.js:60`, `sections/stage.js:43,97,133`, `report/index.js:20,69,73`. Pointing `outDir` at
`out/runs/<runId>/` therefore isolates a run's artifacts with **zero edits to any stage**. The Figma
cache (`.cache/`) stays shared, which is what we want — a second demo run against the same file is
near-instant.

### 3.2 `src/cli.js` — split orchestration from presentation

Move, unchanged in behaviour, into `src/pipeline/run.js`:

- the `STAGES` array (`cli.js:42-55`)
- `class NotImplemented` (`cli.js:24-36`)
- `selectStages()` (`cli.js:107-115`)
- the stage loop (`cli.js:144-170`), with `process.stdout.write` / `console.log` replaced by
  `onEvent(...)` calls

`cli.js` keeps `parseArgs`, `usage`, the ANSI colour constants and the header block, and subscribes to
the same events to print exactly what it prints today. Console output must be indistinguishable —
including the `ok (123ms) nodes=3183 …` suffix built from `ctx.stageInfo` and the yellow
`not implemented` path.

---

## 4. New — `src/pipeline/run.js`

```js
export const STAGES = [ … ];                       // moved verbatim
export class NotImplemented extends Error { … }    // moved verbatim
export function selectStages(flags) { … }          // moved verbatim

/** Runs the stages; returns the finished ctx. Never throws for stage failures —
 *  those arrive as a 'stage:fail' event and stop the run. */
export async function runPipeline(config, flags = {}, { onEvent = () => {} } = {}) { … }
```

### Event contract

| Event | Payload |
|---|---|
| `run:start` | `{ stages: [{ id, label }], config: { pageUrl, figmaFileKey, figmaNodeId, viewportWidth, tolerance } }` |
| `stage:start` | `{ id, label, index, total }` |
| `stage:ok` | `{ id, ms, info }` — `info` is `ctx.stageInfo` |
| `stage:warn` | `{ id, message }` — e.g. the Figma-429-fell-back-to-cache case |
| `stage:fail` | `{ id, error: { name, message, hint } }` |
| `stage:pending` | `{ id, file, phase }` — the `NotImplemented` path |
| `run:done` | `{ ok, ms }` |

The config echo on `run:start` is what lets the UI show "viewport 1920 (derived from the frame)" before
anything else finishes — a good demo beat, because it makes the frame-width rule visible.

### What deliberately stays as-is

`sections/stage.js` and `pipeline/stage.js` print formatted ANSI tables directly to `console.log`
(`sections/stage.js:15-122`, `pipeline/stage.js:39-40`), as does `report/console.js`. Under the server
this goes to the server terminal. **Leave it.** Capturing it means editing frozen files, and the UI
does not need it — everything those tables show is available structurally from `ctx`. The server
terminal doubles as a live debug view during the demo.

---

## 5. New — `src/server/`

```
src/server/
  index.js      entry: reads PORT, starts app
  app.js        express app, routes, static serving of ui/dist
  runs.js       run registry (in-memory Map + run.json on disk)
  validate.js   request validation
  prose.js      splits report.md into its ## sections
```

### Routes

| Method | Path | Returns |
|---|---|---|
| `POST` | `/api/audit` | `202 { runId }` — body `{ figmaFrameUrl, pageUrl, determinism?: boolean }` |
| `GET` | `/api/runs/:id` | the run record (§5.2) |
| `GET` | `/api/runs/:id/events` | `text/event-stream` — the §4 events, plus a replay of everything already emitted so a late/reconnecting client isn't stuck on an empty progress list |
| `GET` | `/api/runs/:id/report.md` | `text/markdown`, `Content-Disposition: attachment` |
| `GET` | `/api/runs/:id/report.html` | `text/html`, attachment — the existing self-contained report from `report/html.js` |
| `GET` | `/api/runs/:id/findings.json` | `application/json` — raw findings |
| `GET` | `/api/health` | `{ ok, figmaToken: boolean, llm: 'gemini'\|'anthropic'\|null }` — credential presence only, never values. Lets the UI warn *before* a 45-second run that the prose step will be skipped. |
| `GET` | `/*` | `ui/dist` static (demo mode, §9) |

### 5.1 Concurrency: one run at a time

A second `POST /api/audit` while a run is active returns `409` with the active `runId`. Reasons, in
order of importance: Playwright + two full IR snapshots is memory-heavy; concurrent writes into
`.cache/figma` are not coordinated; and a demo has exactly one operator. The UI disables the button and
shows "an audit is already running" rather than surfacing a raw 409.

### 5.2 Run record

```js
{
  id, status,                 // 'queued' | 'running' | 'done' | 'failed'
  input:  { figmaFrameUrl, pageUrl, determinism },
  meta:   { pageUrl, figmaFileKey, figmaNodeId, viewportWidth, toleranceProfile,
            startedAt, finishedAt, durationMs, figmaCacheStale },
  stages: [ { id, label, status, ms, info, message } ],   // status: pending|running|ok|failed|skipped
  warnings: [ { stage, message } ],
  error:  { stage, name, message, hint } | null,
  result: {                    // present when status === 'done'
    exec, sectionScores, issues, fixOrder,   // from ctx.analysis  (analysis.js)
    counts, alignmentStats,                  // from ctx.assembled / ctx.alignment
    prose: { ok, sections?, reason?, audit?, usage? },
    files: { markdown, html, findings }      // booleans: which artifacts exist
  }
}
```

Written to `out/runs/<id>/run.json` as well as held in memory, so a server restart mid-demo doesn't
lose a completed report.

### 5.3 Where the report data comes from — the load-bearing design point

The pipeline produces the report in **two independent halves**, and the UI must respect that split:

- **Every number** comes from `ctx.analysis` (`src/report/analysis.js`) — health scores, match
  confidence, per-section scores, issue groupings, fix order. All computed, deterministic, identical
  across runs.
- **All prose** comes from `ctx.prose.markdown` — LLM-generated, **optional by design**
  (`report/llm.js:5-8`), and it never produces a number (`report/audit.js` exists to enforce this).

So: **the report view must render fully with prose absent.** No LLM key, a Gemini 429, a refusal — the
run still succeeds and every card still has its content, minus the narrative paragraphs. This is not
defensive coding, it is mirroring a property the engine already guarantees; building the UI so that a
missing key blanks the report would throw that property away.

Nothing in `src/report/` changes to support this. The server reads `ctx.analysis`, `ctx.assembled`,
`ctx.alignment` and `ctx.prose` off the returned ctx and serialises them into `run.json`.

### 5.4 Mapping the seven required blocks

| UI block | Structured source (always present) | Prose source (when available) |
|---|---|---|
| Executive Assessment | `exec.structuralIntact`, `exec.designSections`/`pageSections`/`matched`, `exec.dominantIssues` | `## Executive Assessment` |
| Overall Health Score | `exec.overallScore` + `exec.overallStatus` | — |
| Match Confidence | `exec.confidence.{percent, verdict, notes}` | — |
| Fix Priority | `fixOrder[]` — `rank`, `label`, `severity`, `issueCount`, `sectionCount`, `rationale`, `oneFix`, `systemic` | `## What To Fix First` |
| Key Issues | `issues[]` — `knowledge.{title,why,causes,impact,investigate,intent}`, `severity`, `occurrences`, `sections` | `## Key Issues` |
| Section Notes | `sectionScores[]` — `label`, `score`, `status`, `confidence`, `designHeight`/`pageHeight`/`heightRatio`, `bySeverity`, `problems` | `## Section Notes` |
| Conclusion | — (prose-only; hidden when prose is unavailable) | `## Conclusion` |

**Prose splitting happens server-side** (`src/server/prose.js`): split `report.md` on `^## `, key the
blocks by heading. The headings are fixed by the system prompt in `llm.js:38-60`, so this is a
lookup, not parsing. A heading that fails to appear degrades that one block to structured-only. The UI
never inspects markdown structure — it receives `prose.sections['Key Issues']` as a string.

**Show the prose audit.** `report/audit.js` already computes `{ numbersCited, numbersTraced, clean }`.
Surfacing it as a small badge — *"48 / 48 figures traced to measured findings"* — is the single
strongest credibility artifact in the demo: it is the UI saying, checkably, that the AI narration did
not invent any measurement. Amber when `clean` is false, with the untraced values listed. Note honestly
in the talk track what `audit.js:17-33` documents about its own discriminating power; don't oversell it
as proof of grounding.

---

## 6. Validation

**Figma frame URL** — reuse `parseFigmaUrl` from `config.js:35` verbatim. It already produces the exact
errors a demo audience will trigger, including the one that matters:

> *"That URL points at a file, not a frame — it has no node-id. In Figma: right-click the frame →
> Copy/Paste as → Copy link to selection. Note `t=` is a share token, not a node id."*

Reimplementing this in the UI would produce a worse message. The server returns `{ error, hint }` split
on the existing `\n  → ` convention, and the form renders the hint under the field.

**Page URL** — `new URL()`, protocol must be `http:` or `https:`.

Client-side validation is cheap-and-instant (non-empty, parses as a URL, has a `node-id`); the server
is authoritative and returns `400 { error, hint, field }`. Both URLs are validated **before** the run
starts, so a typo costs a second, not forty-five.

---

## 7. Error handling — the real failure modes

Taken from the code, not imagined:

| Failure | Origin | Run status | UI |
|---|---|---|---|
| Bad Figma URL / missing `node-id` | `config.js:35-77` | never starts | `400`, inline under the field, with hint |
| `FIGMA_TOKEN` unset | `config.js:99` | never starts | `400` + setup hint; also pre-warned by `/api/health` |
| Figma API 429 / unreachable | `figma/client.js` — **currently warns and falls back to cache** | continues | amber banner: "Figma data served from cache, may be stale". **This is the current live state, not a hypothetical** — see §8.1 |
| Node is not a `FRAME` | `figma/stage.js:33` | `failed` at M2 | error card naming the stage and the actual node type |
| Page navigation timeout / DNS | `web/extract.js` | `failed` at M1 | error card + the page URL |
| Viewport width override disagrees with the frame | `config.js:150-168` | continues | warning banner — the "every finding is noise" case is worth showing, not hiding |
| No LLM key, or LLM error | `report/llm.js:257-290` | **`done`** | report renders in full; prose panels show the reason inline. **Not an error state.** |
| Prose audit not clean | `report/audit.js` | `done` | amber badge listing untraced figures |
| Stage not implemented | `run.js` `NotImplemented` | `failed` | shouldn't occur — all 12 stages are built — but keep the path; it's the reason the stage list exists |

**Rule:** a stage failure stops the run and reports *which* stage, with the raw message. Artifacts
already written to `out/runs/<id>/` stay downloadable — a run that dies at S5 still has `findings.json`,
and offering it is more useful than a bare error page.

---

## 8. Progress

The twelve stages, with demo-facing labels:

| Stage | Engine label | UI label | Measured |
|---|---|---|---|
| M2 | Figma extraction (REST + cache) | Extracting Figma | 0.9 s cached · up to ~3 s cold |
| M4 | Figma normalizer → IR | Normalizing design | 53 ms |
| M1 | Web extraction (Playwright + CDP) | Extracting Website | **14.0 s** |
| M3 | Web normalizer → IR | Normalizing website | 113 ms |
| DET | Determinism self-check | Determinism check *(off by default)* | **~14 s** |
| P5 | Pruning & canonicalization | Pruning | 15 ms |
| P6 | Measured spacing derivation | Spacing derivation | 87 ms |
| S1 | Section segmentation | Section Detection | 25 ms |
| S2 | Section matching (aligned) | Matching | 15 ms |
| S3 | Section comparison | Comparison | 4 ms |
| S4 | Finding assembly | Findings | 2 ms |
| S5 | Report (console + json + LLM) | Report Generation | **23 s – 90 s** |

Measured from `out/runO.log` (full run with prose, 2026-08-03) and `out/timing_0.log` (same run,
prose failed). **Total: ~105 s with prose, ~38 s without.** Three consequences for the UI:

1. **S5 is the longest stage, not M1.** The LLM call dominates: 90.1 s on the last successful run
   (11,203 in / 1,921 out on `gemini-3.5-flash`), and 23.4 s even on the run where the call *failed*
   with a 503. Any design that treats web extraction as "the slow bit" and S5 as a quick finish will
   look broken. See §8.1 for the lever that shortens it.

2. **Figma is extracted before the website, and the UI must show it in that order.** It looks
   backwards, but the frame's own width sets the browser viewport (`config.js:143-168`,
   `figma/stage.js:51-53`) — M2 *must* precede M1. Reordering the display to "look right" would
   misrepresent the pipeline in a demo where someone may well ask why.

3. **No percentage-of-stages progress bar.** Nine of the twelve stages finish in under 120 ms; a
   stage-count bar jumps to ~85% and then sits still for a minute and a half, which reads as a hang.
   Instead: a stage checklist, ticks appearing instantly for the fast ones, and an indeterminate
   spinner with a live elapsed counter on M1, DET and S5. Attach each stage's `info` (`nodes=3183`,
   `scrollHeight=23991`, `findings=97`) next to the tick as it completes — that detail is what makes
   the progress panel look like a real engine rather than a loading animation. On S5 specifically, say
   what it is waiting for ("generating the written summary"), because a silent 90-second spinner at the
   very end of a demo is the worst place to have one.

**Determinism check:** off by default (`--no-determinism`), exposed as an "Advanced" checkbox. When
enabled, show its result as its own card — `identicalOutsideUnstable`, stable vs unstable diff counts
(`web/stage.js:150-161`). That states the static-content-first position honestly — "identical except for
N nodes we flagged as animated" — and it is a better story than a number claiming perfection.

### 8.1 Two live conditions to settle before the demo

Both are current state on this machine, found while checking readiness. Neither is a code defect and
neither blocks implementation, but both shape the demo.

**The Figma token is rate-limited.** The two most recent runs both hit `Figma API 429` with
`Retry-After ≈ 66,751 s` (~18.5 hours), and completed only because `figma/client.js` fell back to the
cached file — `cached=true stale=true`. The engine degraded exactly as designed, and the demo will keep
working for the cached frame. But a **new** frame URL typed live cannot be fetched, and the amber
"served from cache, may be stale" banner (§7) is not a defensive nicety — it is what the demo will
actually show. Confirm the quota window has reset before presenting, and treat §14.2 as recommended
rather than optional.

**S5's 90 seconds is mostly model thinking, and there is an existing knob for it.** `llm.js:135-156`
reads `LLM_THINKING_BUDGET` from the environment — unset means the model decides, `0` turns thinking
off — and the code comment records 15.2 s with it on versus 3.0 s with it off on an equivalent prompt.
Every fact in the prompt is pre-computed, so the model is composing rather than reasoning. Setting
`LLM_THINKING_BUDGET=0` in `.env` is a **config change, not a code change**, and should be measured
before Phase 3 so the progress UI is built against realistic numbers. The same window also produced a
`Gemini 503 UNAVAILABLE`, which is the other reason the prose-optional path (§5.3) has to be real.

---

## 9. UI

```
ui/
  index.html
  vite.config.ts            proxy /api → http://localhost:5173
  tailwind.config.js
  package.json              react, react-dom, marked, dompurify, vite, tailwind
  src/
    main.tsx
    App.tsx                 idle | validating | running | done | failed
    api.ts                  typed fetch + EventSource client
    types.ts                mirrors the §5.2 run record
    components/
      AuditForm.tsx         two URL fields, advanced toggle, Generate Report
      ProgressPanel.tsx     stage checklist + elapsed + per-stage info
      ReportView.tsx        composes the blocks below
      ScoreCards.tsx        health score, match confidence, severity counts
      FixPriority.tsx       ranked list from fixOrder[]
      KeyIssues.tsx         cards from issues[] + knowledge
      SectionNotes.tsx      table/cards from sectionScores[]
      Prose.tsx             renders one prose block; renders nothing when absent
      ProseAuditBadge.tsx   numbers-traced badge
      RawFindings.tsx       filterable findings table
      DownloadBar.tsx       Markdown / HTML / Raw Findings
      ErrorPanel.tsx        stage-aware failure card
```

**Markdown rendering:** `marked` + `dompurify`. The prose is model output, so it is sanitised before
`dangerouslySetInnerHTML` — no exceptions, even though the LLM is our own call. Both deps live in
`ui/package.json`; the POC root keeps its three dependencies plus Express.

**Raw Findings view:** a table over `findings.json` — severity badge, section pair (`§18→19`), property,
expected, actual, notes (`×52`, `Δ 3`, `ratio 1.4`, `dynamic content`). Filters on severity and
category. Colour findings render an actual swatch; `report/html.js:11-14` already has the six-line
implementation to copy. 97 findings on the reference run, so client-side filtering is fine — no
virtualisation, no pagination.

**Design register:** this is shown to senior management. Light theme, generous whitespace, one accent
colour, severity encoded by colour *and* label (never colour alone). The existing self-contained HTML
report is a reasonable visual reference — and it stays as-is, since it is also the "Download HTML"
artifact.

---

## 10. Running it

**Development** — two processes:

```
npm run server          # Express :5173
cd ui && npm run dev    # Vite :5174, proxying /api → :5173
```

**Demo** — one process, one port, no bundler in the room:

```
npm run build           # vite build → ui/dist
npm start               # Express :5173 serves the API *and* ui/dist
```

Root `package.json` additions:

```json
"server": "node src/server/index.js",
"start":  "node src/server/index.js",
"build":  "npm --prefix ui install && npm --prefix ui run build"
```

Rehearse against the demo machine on `npm start`, not `npm run dev`. Vite's dev server, the proxy and
HMR are three things that can fail in front of an audience for reasons unrelated to this project.

`.gitignore` additions: `ui/node_modules/`, `ui/dist/`. `out/` is already ignored, which covers
`out/runs/`.

---

## 11. Phases

Task-level breakdown with checkboxes: **`docs/demo-ui-task-list.md`**.

| Phase | Work | Est. | Exit criterion |
|---|---|---|---|
| **1** | Extract `run.js`; `resolveConfig` overrides; `cli.js` rewired | 0.5 d | `npm run audit` output byte-identical to today, same inputs; console output visually identical |
| **2** | Express app, run registry, SSE, downloads, validation | 1 d | `curl -X POST /api/audit` completes a full run into `out/runs/<id>/`; SSE shows 12 stages |
| **3** | Vite scaffold, form, validation, progress panel | 1 d | Live stage ticks against a real run |
| **4** | Report view — score cards, fix priority, key issues, section notes, prose, audit badge | 1.5 d | Full report renders; **and renders correctly with `GEMINI_API_KEY` unset** |
| **5** | Raw findings table + the three downloads | 0.5 d | All three files download and open correctly |
| **6** | Error paths, warning banners, empty/edge states, demo rehearsal | 0.5 d | Each row of the §7 table reproduced and checked |

**≈ 5 days.** Phase 1 is the only one that can break existing behaviour; do it first, verify it, commit.

Phase 6 is not padding. Every row in §7 is a live risk in a demo — the Figma 429 already happened once
during development, and the failure the audience sees must be the graceful one.

---

## 12. Out of scope

- Any change to comparison logic, thresholds, tolerances or scoring
- Auth, users, persistence beyond `out/runs/*/run.json`, Supabase
- Concurrent runs, a job queue, cancellation mid-run
- Run history / comparison between runs (`run.json` on disk makes this a later add, not a rewrite)
- Mobile layout — this is a desktop demo
- Capturing the stage-internal ANSI tables into the UI (§4)
- Screenshots or pixel diffs — the parent design's hard constraint stands: every value is measured,
  never inferred from an image

---

## 13. Notes for the Evertest port

The layering is chosen so the port is a move, not a rewrite:

- `src/server/app.js` routes map onto an `evertest-backend` route module — same Express idiom.
- The run registry (`runs.js`) is the piece that becomes a Supabase table. Its shape (§5.2) is
  deliberately flat and serialisable for exactly this reason.
- SSE is the one transport decision to revisit — check what `evertest-backend` already uses for run
  progress before porting it as-is (its webhook work may already answer this).
- `ui/` components map onto shadcn primitives in `evertest-ai-frontend-reactjs`; Tailwind is shared, so
  the layout survives.
- `FIGMA_TOKEN` is a single env-level PAT here. Multi-tenant Evertest needs per-user Figma OAuth — a
  real piece of work, and the reason `resolveConfig` never accepts credentials over HTTP (§3.1): that
  boundary is where OAuth will eventually plug in.

---

## 14. Open decisions

1. **Does the demo need the section-alignment view?** `out/section-alignment.json` (figma§ ↔ web§ with
   confidence, and the missing/extra flags) is arguably the most convincing artifact the engine
   produces — it shows *why* the tool believes a match is a match. Not in the requested block list, so
   it is left out; worth reconsidering as a collapsible panel under Section Notes.
2. **A pre-baked run for the demo — now recommended, not merely optional.** A run takes ~40–105 s
   (§8) and depends on Figma's API, the network, a live site and an LLM endpoint. Of those four, two
   have already failed during development in the last 24 hours: the Figma token is currently
   rate-limited for ~18 hours, and Gemini returned a 503. Loading a previously completed `run.json` by
   id would let the report be shown instantly if the live run fails. Cheap to add — the registry
   already reads from disk (§5.2).
3. **Tolerance profile selection.** `resolveConfig` accepts `toleranceProfile` and only `default`
   exists. Leave it fixed unless a second profile ships.
