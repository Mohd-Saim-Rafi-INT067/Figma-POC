# Demo UI — Phase-wise Task List

**Plan:** `docs/demo-ui-implementation-plan.md` — read it first; this file is the execution tracker.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done · `[!]` blocked

**Ordering rule:** phases are sequential. Phase 1 is the only one that can break existing behaviour —
finish and verify it before anything else starts. Within a phase, tasks are ordered by dependency.

| Phase | Est. | Gate to the next phase |
|---|---|---|
| 0 · Baseline | 0.5 h | working tree committed, reference outputs captured |
| 1 · Extract the runner | 0.5 d | ✅ tests + fixture validation identical, CLI output unchanged |
| 2 · Server | 1 d | ✅ full run drivable by `curl` alone |
| 3 · Shell, form, progress | 1 d | ✅ live stage ticks against a real run |
| 4 · Report view | 1.5 d | ✅ renders with **and without** an LLM key |
| 5 · Raw findings + downloads | 0.5 d | all three artifacts download and open |
| 6 · Errors + rehearsal | 0.5 d | every §7 failure row reproduced and handled |

---

## Phase 0 — Baseline (0.5 h)

Nothing here is optional. Phase 1 is a refactor of working code with no version control behind it.

- [x] **T0.1** `git init`; add `ui/node_modules/`, `ui/dist/` to `.gitignore` (`out/`, `.env`, `.cache/`,
      `node_modules/` are already covered). Commit the current working tree as the baseline.
      *(Done — pushed to `github.com/Mohd-Saim-Rafi-INT067/Figma-POC`.)*
- [x] **T0.2** Capture a reference baseline.
      **The original wording — "byte-identical `findings.json`" — was wrong and has been replaced.**
      `PAGE_URL` is a live site with dynamic content, so two runs minutes apart legitimately differ
      (measured: web nodes pruned to 1273 vs 1224, 97 vs 95 findings, mean confidence 0.828 vs 0.827).
      Demanding byte-equality there would fail for reasons unrelated to any refactor — the same point
      the determinism check already makes about unstable nodes.
      **The deterministic gate is instead:**
  - `npm test` → 35/35 pass
  - `npm run validate` → fixture harness, `out/validation.json` **byte-identical** to
    `out/baseline/validation.json`. This builds its page *from the Figma design itself*, so it has no
    live-site variance at all: PASS, 5/5 deviations detected, 0 unexpected, baseline 9.
  - `out/figma-ir.json` identical to baseline **except `capturedAt`** (the Figma side is cache-backed
    and deterministic; `capturedAt` is a header timestamp, already stripped by the determinism check)
  - CLI console output structurally line-for-line unchanged
- [x] **T0.3** Reference inputs: `FIGMA_FRAME_URL` = `…/QL-website-try?node-id=2743-6476`,
      `PAGE_URL` = `https://quokkalabs.com/`. Figma side is stable across runs (1828 nodes → 1613
      pruned, 491 gaps); the web side is not, and that is expected.
- [ ] **T0.4** Confirm `node --version` on the machine that will run the demo, and that
      `npx playwright install chromium` has been run there. *(Dev machine: Node v24.18.0, Playwright
      installed, `FIGMA_TOKEN` + `GEMINI_API_KEY` set, `LLM_PROVIDER=gemini`, `ANTHROPIC_API_KEY`
      empty — verified 2026-08-03.)*
- [x] **T0.5** `LLM_THINKING_BUDGET=0` set in `.env`. **Measured: it does not fix S5.** The setting is
      honoured (thought tokens → 0) but buys ~0.9 s; a full run with it on still spent 92.5 s in S5,
      versus 90.1 s with thinking enabled. Build the progress UI around a ~90 s S5. Plan §8.1.
- [x] **T0.6** Figma 429 re-checked with a **new token**: still limited, `Retry-After ≈ 58,465 s`
      (~16.2 h). The limit is scoped to the **account and endpoint**, not the token — only
      `/v1/files/:key` (the version check) is blocked; `/v1/files/:key/nodes` returns `200`. Plan §8.1.
- [x] **T0.7** Decided and implemented: the server defaults to `noCache: true`, **plus a fallback the
      flag itself does not provide.** During Phase 2 the nodes endpoint started returning 429 as well,
      and `--no-cache` then has nothing to fall back on — the run died at M2. So `executeRun` catches a
      Figma rate-limit failure at M2, re-runs with the cache enabled, and records a loud warning. Fresh
      design data when Figma allows it, a stale-but-honest report when it does not, never a dead run.
      Implemented in the orchestration layer; `client.js` untouched.

---

## Phase 1 — Extract the runner (0.5 d)

Goal: one stage list, two consumers. No behavioural change of any kind.

- [x] **T1.1** Create `src/pipeline/run.js`. Move `STAGES`, `class NotImplemented` and `selectStages()`
      across **verbatim**. All three exported. *(Verified: stage-selection matrix identical across all
      five flag combinations; 12 stages, order unchanged.)*
- [x] **T1.2** Add `runPipeline(config, flags, { onEvent })` to `run.js`, emitting the plan §4 events.
      Returns the finished `ctx`.
- [x] **T1.3** `NotImplemented` → emits `stage:pending` and returns cleanly (`ctx.outcome.stopped =
      'pending'`), because it is not a failure — everything before it ran. A real stage throw emits
      `stage:fail` **and then rethrows**.
      *Deviation from the plan, deliberate:* the plan said neither should rethrow. Rethrowing preserves
      the CLI's existing exit-code and stack-trace behaviour exactly, which is this phase's gate, and
      costs the server nothing — it gets the stage id from the event and the error from `try/catch`.
      `ctx.outcome` carries the same information for callers that prefer to inspect it.
- [x] **T1.4** `cli.js` rewritten as a console renderer of the events. `parseArgs`, `usage`, the ANSI
      constants and the header block all retained verbatim; `printEvent` rebuilds the
      `ok (123ms) nodes=3183 …` suffix from `event.info`.
- [x] **T1.5** Verified — see T0.2 for the gate as actually applied. Console output structurally
      line-for-line unchanged against the pre-refactor run.
- [x] **T1.6** Narrow paths verified: `--figma-only` (exit 0, IR identical), `--web-only` (exit 1 via
      the real `stage:fail` path, message preserved), `--help` (exit 0), `--no-determinism`,
      `--bogus` (exit 2, `ConfigError` formatting intact), `--web-only --figma-only` (exit 2).
- [x] **T1.7** `resolveConfig` takes `figmaFrameUrl`, `pageUrl`, `outDir`, `viewportWidth`, each
      `?? process.env.X`. `cacheDir` stays shared and is **not** parameterised, so per-run isolation
      does not cost the Figma cache.
- [x] **T1.8** Credentials confirmed un-injectable: passing `{ figmaToken, geminiApiKey }` is ignored;
      `config.figmaToken` still comes from `process.env`. This is the seam Evertest OAuth plugs into.
- [x] **T1.9** Committed.

> **Gate — met.** `npm test` 35/35 · `out/validation.json` byte-identical to baseline · `figma-ir.json`
> identical but for `capturedAt` · stage matrix identical · CLI output and all six exit-code paths
> unchanged.

---

## Phase 2 — Server (1 d)

Goal: a full audit drivable with `curl` and nothing else. No UI work until this is true.

- [x] **T2.1** `npm install express` (v5). Created `src/server/index.js` (reads `PORT`, default 5173)
      and `src/server/app.js`. `"server"` / `"start"` scripts added.
- [x] **T2.2** `src/server/validate.js` — validate `{ figmaFrameUrl, pageUrl, determinism }`. Reuse
      `parseFigmaUrl` (`config.js:35`) verbatim for the Figma URL; `new URL()` + `http:`/`https:` for
      the page URL. On `ConfigError`, split the message on `\n  → ` into `{ error, hint }` and return
      `400 { error, hint, field }`.
- [x] **T2.3** `src/server/runs.js` — the registry. `create()`, `get(id)`, `update(id, patch)`,
      `activeRun()`. In-memory `Map`, mirrored to `out/runs/<id>/run.json` on every status transition.
      Record shape per plan §5.2. Run ids: short, URL-safe, sortable (timestamp + 4 random chars).
- [x] **T2.4** `POST /api/audit` — validate, reject with `409 { activeRunId }` if a run is live,
      create the record, respond `202 { runId }` **immediately**, then start the run in the background.
      Do not await the pipeline inside the handler.
- [x] **T2.5** Wire the run: `resolveConfig({ figmaFrameUrl, pageUrl, outDir: out/runs/<id> })` →
      `runPipeline(config, { noDeterminism: !determinism })` with an `onEvent` that updates the record.
      Verify `out/runs/<id>/` fills with `figma-ir.json`, `web-ir.json`, `sections.json`,
      `section-alignment.json`, `findings.json`, `report.md`, `report.html` and nothing lands in `out/`
      root.
- [x] **T2.6** `src/server/prose.js` — split `ctx.prose.markdown` on `^## ` into a map keyed by
      heading. The five headings are fixed by the system prompt (`llm.js:38-60`): *Executive
      Assessment*, *What To Fix First*, *Key Issues*, *Section Notes*, *Conclusion*. A missing heading
      yields `undefined` for that key, never an error.
- [x] **T2.7** On `run:done`, build `result` from the returned ctx: `ctx.analysis` →
      `{ exec, sectionScores, issues, fixOrder }`; `ctx.assembled.counts`; `ctx.alignment.stats`;
      `ctx.prose` → `{ ok, sections, reason, audit, usage }`. Persist to `run.json`.
- [x] **T2.8** `GET /api/runs/:id` — the record. `404` on unknown id. On a cold start, fall back to
      reading `out/runs/<id>/run.json` from disk.
- [x] **T2.9** `GET /api/runs/:id/events` — SSE. **Replay every event already emitted for that run
      before streaming live ones**, so a client that connects late or reconnects still sees the full
      stage list. Send a keepalive comment every 15 s. Close the stream on `run:done` / `stage:fail`.
- [x] **T2.10** `GET /api/runs/:id/report.md|report.html|findings.json` — serve from the run's out dir
      with the right content type and `Content-Disposition: attachment`. Whitelist the three filenames;
      never interpolate `:file` into a path. `404` when the artifact doesn't exist (a run that failed
      before S5 has no `report.md` but does have `findings.json`).
- [x] **T2.11** `GET /api/health` — `{ ok, figmaToken: boolean, llm: 'gemini'|'anthropic'|null }`.
      Presence booleans only; no key values, no prefixes, no lengths.
- [x] **T2.12** Serve `ui/dist` statically with an SPA fallback, guarded so it doesn't shadow `/api/*`.
      Harmless before `ui/` exists.
- [x] **T2.13** Verify by `curl` alone: POST an audit, follow `/events` with `curl -N`, GET the record,
      download all three files. Compare that run's `findings.json` against the Phase 0 baseline for the
      same inputs — must be identical.
- [x] **T2.14** Verify the 409: POST twice in quick succession. Commit.

> **Gate — met.** A full audit is drivable by `curl` alone: `POST /api/audit` → `202 {runId}`,
> `curl -N …/events` streams all 28 events to `run:done`, `GET …/runs/:id` returns the complete record,
> and all three artifacts download. Score 65 Fair, confidence 83%, prose 38/38 numbers traced, clean.
> Engine files still show zero diff; `npm test` 35/35; `validation.json` still byte-identical.

### Two bugs found by the curl-only gate — both would have surfaced in front of the audience

- **The server crashed on a completed run.** The SSE keepalive timer and the event listener both
  outlive `res.end()`; a write after end throws asynchronously, which is an uncaught exception, which
  kills the process. Symptom was every later request returning an empty body. Fixed with a `closed`
  guard and a single `cleanup()` that clears the timer, unsubscribes, and ends once. Verified against
  three paths: replay of a finished run, a client disconnecting mid-stream, and reconnect-to-completion.
- **`meta.viewportWidth` was always `null`.** It was captured at `run:start`, but the width does not
  exist until M2 derives it from the frame — which is the whole reason M2 precedes M1. Now captured
  from M2's `stage:ok` info (1920, with the frame name alongside it).

This is why the phase gate was "drivable by curl alone" rather than "the code is written".

---

## Phase 3 — Shell, form, progress (1 d)

- [x] **T3.1** Scaffold `ui/` — Vite + React 18 + TypeScript + Tailwind. `vite.config.ts` proxies
      `/api` → `http://localhost:5173`. Add root `"build"` script per plan §10.
- [x] **T3.2** `ui/src/types.ts` — mirror the §5.2 run record and the `exec` / `sectionScores` /
      `issues` / `fixOrder` shapes from `report/analysis.js`. Hand-written; the source of truth is
      `analysis.js`, so cite it in a comment.
- [x] **T3.3** `ui/src/api.ts` — `startAudit()`, `getRun()`, `openEvents()` (EventSource wrapper),
      `getHealth()`, download URL builders. One place that knows about HTTP.
- [x] **T3.4** `App.tsx` — state machine `idle → validating → running → done | failed`. SSE drives
      transitions; on `run:done` fetch the full record once (the events carry progress, not the report).
- [x] **T3.5** `AuditForm.tsx` — Figma frame URL, website URL, **Generate Report**. Client-side checks:
      non-empty, parses as a URL, Figma URL has a `node-id`. Instant feedback; the server stays
      authoritative. Disable the button while a run is live.
- [x] **T3.6** Field-level server errors: render `{ error, hint }` under the offending field. Verify the
      "that URL points at a file, not a frame" hint (`config.js:60-66`) renders in full — it is the most
      likely live mistake in the demo and the existing wording is better than anything we'd write.
- [x] **T3.7** Advanced disclosure with the **determinism check** checkbox, default **off**. Label it
      with its real cost ("re-extracts the page to prove the extractor is deterministic; adds ~15 s").
- [x] **T3.8** `ProgressPanel.tsx` — the twelve stages with the demo-facing labels from plan §8,
      **in engine order: Figma before Website.** Add a one-line note in the component explaining why
      (frame width sets the viewport, `config.js:143-168`) so nobody "fixes" it later.
- [x] **T3.9** Progress behaviour: instant ticks for the fast stages; indeterminate spinner + live
      elapsed counter on M1, DET and S5. **No percentage bar** — see plan §8.
- [x] **T3.10** Render each stage's `info` next to its tick as it lands (`nodes=3183`,
      `scrollHeight=23991`, `findings=97`). This is what makes the panel read as an engine rather than a
      loading animation.
- [x] **T3.11** Call `/api/health` on mount; if `llm` is `null`, warn *before* the run that the
      narrative will be skipped. A 30-second wait followed by a surprise is a bad demo moment.
- [x] **T3.12** Verify against a real run end-to-end. Commit.

> **Gate — met.** Verified in a real browser against `http://localhost:5173` (the demo path: Express
> serving `ui/dist`, one port, no Vite). Client-side validation caught both a file-link-instead-of-frame
> and a scheme-less page URL instantly. A live run ticked through all 11 stages with per-stage timings
> and info, the spinner and explanation appeared on the slow stages, the rate-limit retry reset the
> checklist and showed its banner, and the run completed at **66 Fair / 83% confidence / 18 of 18
> sections matched / 37 s**. No console errors.

**Stack note:** Vite 8, React 18, Tailwind 4, TypeScript 5.9. The plan's `@vitejs/plugin-react@4` no
longer exists in a form compatible with current Vite — v6 requires Vite 8, so both moved up together.
Project references were dropped in favour of a single `tsconfig.json` (`tsc --noEmit && vite build`);
the referenced-project setup demands `composite: true`, which buys nothing for an app this size.

**Deferred to Phase 4:** the completion state is currently a four-tile placeholder
(`RunSummary` in `App.tsx`) showing score, confidence, sections matched and duration. `ReportView`
replaces it.

---

## Phase 4 — Report view (1.5 d)

The load-bearing phase. Every number comes from `result.exec` / `sectionScores` / `issues` / `fixOrder`;
prose is a separate, optional layer (plan §5.3).

- [x] **T4.1** `ReportView.tsx` — composes the blocks below and renders the run header (page URL, Figma
      frame, viewport width, tolerance profile, duration, timestamp).
- [x] **T4.2** `Prose.tsx` — renders one prose block via `marked` → `dompurify` → `dangerouslySetInnerHTML`.
      Sanitise unconditionally; it is model output. Renders **nothing** (not an error, not a placeholder
      box) when its block is absent.
- [x] **T4.3** `ScoreCards.tsx` — **Overall Health Score** (`exec.overallScore` + `exec.overallStatus`)
      and **Match Confidence** (`exec.confidence.percent` + `.verdict`, with `.notes` listed beneath).
      The notes are the interesting part — "every design section was found on the page" is the sentence
      that answers a manager's actual question.
- [x] **T4.4** Severity counts strip from `result.counts.bySeverity` / `.byCategory`. Colour **and**
      label for severity, never colour alone.
- [x] **T4.5** **Executive Assessment** — `Prose` block plus the structured facts that survive without
      it: `exec.structuralIntact`, design vs page section counts, `exec.matched` /
      `missingInWeb` / `extraInWeb`, design vs page total height.
- [x] **T4.6** `FixPriority.tsx` — ranked list from `fixOrder[]`: `rank`, `label`, `severity`,
      `issueCount`, `sectionCount`, `rationale`. Render in the given order and show `rank` — the
      ordering is computed (`analysis.js:180-223`) and the prose cites it, so re-sorting in the UI would
      contradict the narrative. Pair with the *What To Fix First* prose block.
- [x] **T4.7** `KeyIssues.tsx` — cards from `issues[]`: title, severity, affected sections, occurrences,
      and the `knowledge` fields (`why`, `causes`, `impact`, `investigate`, `intent`). Render the
      one-fix / systemic distinction as words, never as raw booleans — `analysis.js:139-150` explains
      why those two flags are deliberately not the same thing. Pair with the *Key Issues* prose block.
- [x] **T4.8** `SectionNotes.tsx` — from `sectionScores[]`: label, score, status, match confidence,
      design vs page height + ratio, severity breakdown, `problems[]`. Sorted by section index; worst
      scores visually marked. Pair with the *Section Notes* prose block.
- [x] **T4.9** **Conclusion** — prose-only; the whole block is hidden when prose is unavailable.
- [x] **T4.10** `ProseAuditBadge.tsx` — from `prose.audit`: green *"48 / 48 figures traced to measured
      findings"* when `clean`, amber listing `unaccounted` otherwise. Also flag `contentLeak`. Keep the
      tooltip honest about what this does and does not prove (`report/audit.js:17-33`).
- [x] **T4.11** Prose-unavailable state: when `prose.ok === false`, show `prose.reason` once, inline and
      calm — the report is complete, the narrative is not. Not an error banner.
- [x] **T4.12** **Verify with `GEMINI_API_KEY` and `ANTHROPIC_API_KEY` unset.** Every block except
      Conclusion must render with full content. This is the phase gate.
- [x] **T4.13** Verify with the LLM enabled: prose blocks land under the right headings, no duplication
      against the structured content. Commit.

> **Gate — met, and not by contrivance.** Gemini's quota ran out mid-phase
> (`429 RESOURCE_EXHAUSTED`), so the no-narrative path was verified against a real failure rather than a
> deliberately unset key: the report rendered complete — scores, confidence, severity counts, dominant
> issues, full fix order, all 13 issues, all 18 section rows — with one calm line explaining the summary
> was unavailable. The prose path was then verified against an earlier run carrying all five blocks and a
> clean **42 of 42 figures traced** badge. No horizontal overflow; disclosures work.

**Colour was computed, not chosen.** Severity and health bands are *status* encodings, so they use a
reserved ordered set and never double as categorical identity — and every one ships with a written label
plus a shape, so nothing depends on colour alone. The raw status hues fail contrast as ink on white, so
each token is a tinted surface with a dark same-hue text step; all eleven pairs were measured against
WCAG AA, worst case **4.76:1**. The score readouts are meters (one ratio against a limit), not charts,
and 18 section scores are a table rather than 18 colours.

**Added ahead of schedule: `?run=<id>`.** Needed to verify the prose path once the live quota was gone,
and it is also plan §14.2 / T6.8 — the pre-baked-run fallback that makes the demo safe when Figma, the
network, the site or the model endpoint misbehaves. Three of those four have failed at least once during
this build.

---

## Phase 5 — Raw findings + downloads (0.5 d)

- [ ] **T5.1** `RawFindings.tsx` — table over `findings.json`: severity badge, section pair (`§18→19`),
      property, expected, actual, notes (`×52`, `Δ 3`, `ratio 1.4`, `dynamic content`). ~97 rows on the
      reference run, so client-side only — no virtualisation, no pagination.
- [ ] **T5.2** Filters on severity and category, with live counts. Default: everything shown.
- [ ] **T5.3** Colour swatches for hex values — copy the six-line `swatch` from `report/html.js:11-14`
      rather than reinventing the regex.
- [ ] **T5.4** Surface `meta` from `findings.json` above the table (viewport width, tolerance profile,
      generated-at) — it is what makes the numbers reproducible.
- [ ] **T5.5** `DownloadBar.tsx` — **Download Markdown**, **Download HTML**, **View Raw Findings**.
      Markdown/HTML hit the download endpoints; Raw Findings opens the table, with a JSON download
      alongside it.
- [ ] **T5.6** Hide (don't disable-with-no-explanation) a download whose artifact doesn't exist —
      `result.files` carries the booleans.
- [ ] **T5.7** Verify all three download and open correctly, and that `report.html` still renders
      standalone with no network. Commit.

---

## Phase 6 — Errors and rehearsal (0.5 d)

Not padding. Every row below is a live risk; the Figma 429 already happened once during development
(`out/timing_0.log`).

- [ ] **T6.1** `ErrorPanel.tsx` — stage-aware failure card: which stage, its label, the message, and any
      hint. Offer whatever artifacts the run did produce before it died.
- [ ] **T6.2** Warning banners, distinct from errors: Figma served from cache / stale, viewport-width
      override disagreeing with the frame (`config.js:159-165`), cross-origin iframes skipped.
- [ ] **T6.3** Reproduce and check each plan §7 row:
  - [ ] bad Figma URL (no `node-id`) → `400` inline, with the Figma copy-link hint
  - [ ] `FIGMA_TOKEN` unset → blocked before the run, setup hint shown
  - [ ] Figma 429 → run continues, stale-cache banner (force by clearing `.cache/` and hammering, or
        stub the client response in a scratch branch)
  - [ ] node id pointing at a non-FRAME → `failed` at M2, actual node type named
  - [ ] unreachable page URL → `failed` at M1
  - [ ] no LLM key → status **`done`**, report complete, reason shown inline
  - [ ] second POST during a live run → 409 handled as a message, not a raw error
- [ ] **T6.4** Determinism check enabled: verify the result card renders
      `identicalOutsideUnstable` plus stable/unstable diff counts (`web/stage.js:150-161`). State it
      honestly — "identical except N nodes flagged as animated".
- [ ] **T6.5** Layout pass at 1920 and 1440. Desktop only. Check the report at both the reference run
      (97 findings) and a near-clean run if one is available.
- [ ] **T6.6** Build the demo path and rehearse on it: `npm run build && npm start`, one port, no Vite.
      **Rehearse on `npm start`, not `npm run dev`** — the dev server, the proxy and HMR are three
      things that can fail in front of an audience for reasons unrelated to this project.
- [ ] **T6.7** Time a cold run and a warm (Figma-cached) run on the demo machine, with and without
      `LLM_THINKING_BUDGET=0`. Know all the numbers before you present. Baseline to beat: ~105 s with
      prose, ~38 s without (plan §8).
- [ ] **T6.8** Implement plan §14.2 — load a pre-baked completed `run.json` by id as a fallback if the
      live run fails. Upgraded from optional: of the four external dependencies a live run has (Figma
      API, network, live site, LLM endpoint), two failed during development in the last 24 hours.
- [ ] **T6.9** Update `docs/progress-report.md`. Commit.

---

## Definition of done

- [ ] `npm run audit` behaves exactly as it did at the Phase 0 baseline
- [ ] The 20 engine files listed in plan §1 have zero diff
- [ ] `npm start` serves the whole demo on one port with no build step at run time
- [ ] A full audit runs from the form and renders all seven required blocks
- [ ] The report renders correctly with **no LLM key configured**
- [ ] All three downloads work; `report.html` opens standalone offline
- [ ] Every plan §7 failure mode has been reproduced and handled
