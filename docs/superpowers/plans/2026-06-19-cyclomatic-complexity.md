# Cyclomatic Complexity — Phased Work Plan

> **For agentic workers:** implement task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Companion spec:** [`docs/superpowers/specs/2026-06-19-cyclomatic-complexity-design.md`](../specs/2026-06-19-cyclomatic-complexity-design.md) — read it first; this plan executes that design.

**Goal:** Stand up a per-function **cyclomatic-complexity gate** (ESLint `complexity` @ max 10) plus a **cognitive-complexity advisory** and a **churn × complexity report**, rolled out with a **baseline + ratchet** so CI is green on day one over the existing 1K+ LOC hotspots while new/changed code is held to the limit immediately — then **refactor the top 3 hotspot files** under the limit and leave a burn-down plan for the rest.

**Locked decisions (operator interview, 2026-06-19 — see spec §9):**
- **D-1 Toolchain:** ESLint stack — `eslint` + `typescript-eslint` + `eslint-plugin-sonarjs`.
- **D-2 CI:** separate `complexity.yml` lane first, fold into `ci.yml` once stable.
- **D-3 Threshold:** cyclomatic `error` @ 10; cognitive `warn` @ 15 (advisory).
- **D-4 Enforcement:** baseline legacy, fail on new/changed violations immediately.
- **D-5 Refactor scope:** measure first → refactor violating functions in the **top 3 files** (by churn × complexity); next-step plan for the rest.
- **D-6 Safety net:** characterization tests first for `server.ts` + `src/terminal.ts`; existing suite for lower-risk files; refactors strictly behavior-preserving.

**Tech stack:** TypeScript, `node:test` via `tsx --test --test-force-exit`. New dev deps: `eslint`, `typescript-eslint`, `eslint-plugin-sonarjs`, `code-complexity`.

---

## Bead structure (create on the Windows host — `bd` is not available in the web/Linux remote)

`bd` is a Windows-local tool and isn't installed in this remote container, so this plan is the source of truth until the beads are filed. On the Windows host, create one **parent epic** + the child beads, then claim them in order:

```
bd create "Cyclomatic complexity: gate, baseline, refactor top 3" --type epic   # -> PARENT
bd create "P1 Fixtures + failing gate tests (red)"          --parent PARENT
bd create "P2 Wire ESLint complexity + cognitive (green)"   --parent PARENT
bd create "P3 Baseline legacy via bulk suppressions"        --parent PARENT
bd create "P4 Ratchet guard + churn×complexity report"      --parent PARENT
bd create "P5 CI lane (complexity.yml)"                      --parent PARENT
bd create "P6 Measure & rank: pick top 3 refactor targets"  --parent PARENT
bd create "P7 Refactor top 3 hotspots under CC 10"          --parent PARENT
bd create "P8 Docs + burn-down plan for remaining hotspots" --parent PARENT
```

**Dependency chain:** P1 → P2 → P3 → P4 → P5 → P6 → P7 → P8. (Phase 0 from the spec is resolved — decisions are locked above, no decision bead needed.)

## Platform / worktree notes (read first)

- This project runs on **Windows 11**. Work in a dedicated worktree (e.g. `OrbitalVoiceRunner-wt/cyclomatic-complexity`) on branch `claude/cyclomatic-complexity-spec-k3x4nz` (or a child feature branch). Never edit the main checkout for commits.
- Shell routing: **PowerShell tool** for npm (PS 5.1, no `&&` — chain with `;`; set `$env:PYTHONIOENCODING='utf-8'`). **Bash tool** (Git Bash) for git only. Never mix shells in one call.
- **Any `package.json` change requires `npm ci`** before lint/test, then `node scripts/check-deps.mjs` to confirm `node_modules` is in sync.
- Tests: `npm test` = `tsx --test --test-force-exit`. Judge by the runner summary (`# pass N / # fail 0`) + exit code; node-pty `NativeCommandError` lines are display artifacts.
- ESLint **runs alongside** `tsc --noEmit`, it does not replace it. `npm run lint` must stay green throughout.

---

## Phase 1 — Fixtures + failing gate tests (red)  · bead: `P1 Fixtures`

Write the verification harness *first*, before any analyzer exists, so the gate is proven, not assumed. Independent of tool wiring — can start immediately.

- [ ] Create `tests/fixtures/complexity/` with hand-counted fixtures: `cc-01.ts`, `cc-10.ts`, `cc-11.ts`, `cc-15.ts`, `cc-16.ts` (each function's McCabe value computed by "1 + decision points", documented in a comment, bracketing the warn/error boundaries).
- [ ] Create `tests/test_complexity_gate.ts`: run ESLint via its Node API (`new ESLint({ overrideConfigFile })`) against each fixture and assert the **exact** reported number (`/complexity of N/`) and that sub-threshold fixtures produce **zero** `complexity` messages.
- [ ] Run `npm test` — these fail (no config yet). Commit red.

**Acceptance:** the new test file exists, fails for the right reason (no ESLint config / module), and is committed.

---

## Phase 2 — Wire the analyzer (green)  · bead: `P2 Wire`

- [ ] `npm i -D eslint typescript-eslint eslint-plugin-sonarjs`; run `npm ci` + `node scripts/check-deps.mjs`.
- [ ] Add `eslint.config.js` (flat): `complexity: ['error', 10]` and `sonarjs/cognitive-complexity: ['warn', 15]`, scoped to `server.ts`, `src/**/*.ts`, `scripts/**/*.ts`; ignore `tests/**`, `dist/**`, `*.generated.ts`, Python. Scope the sonarjs plugin to just the one rule (don't adopt its full rule set as policy).
- [ ] Add a **test-only** ESLint config (`max:4`) used by `tests/test_complexity_gate.ts` so fixture assertions are stable regardless of the production threshold.
- [ ] Add `"complexity": "eslint ."` to `package.json` scripts.
- [ ] Run `npm test` (Phase 1 tests now pass) and `npm run lint` (tsc still green).

**Acceptance:** §6 tests pass; `tsc --noEmit` unaffected; `npm run complexity` runs (it will report legacy violations — expected, handled in Phase 3).

---

## Phase 3 — Baseline the legacy  · bead: `P3 Baseline`

- [ ] `npx eslint . --suppress-all` → generates `eslint-suppressions.json` capturing every current violation in the hotspots (`useOrbitalData.ts`, `terminal.ts`, `server.ts`, `voice/index.ts`, `sqliteStore.ts`, `gating/index.ts`, `pendingApprovals.ts`, …).
- [ ] Commit `eslint-suppressions.json`.
- [ ] Confirm `npx eslint .` now exits **0** on the current tree.
- [ ] Add a deliberately-overcomplex throwaway change locally to confirm a **new** violation makes `eslint .` exit non-zero, then revert it.

**Acceptance:** `eslint .` exits 0 on `HEAD`; a fresh violation fails it. (If not on ESLint ≥ 9.24, implement `scripts/complexity-gate.mjs` + `complexity-baseline.json` instead — see Phase 4.)

---

## Phase 4 — Ratchet guard + evaluation report  · bead: `P4 Ratchet+Report`

- [ ] **Ratchet:** ensure the committed suppression count can only shrink — rely on ESLint's `--prune-suppressions` workflow + a CI assertion that suppressions didn't grow, **or** (fallback path) build `scripts/complexity-gate.mjs` that diffs current counts against `complexity-baseline.json`, fails on any per-file increase, and rewrites the baseline downward on improvement.
- [ ] If the fallback script is used, add `tests/test_complexity_ratchet.ts`: regress-above-baseline → exit non-zero; improvement → exit 0 + baseline rewritten down; boundary (count == threshold) explicit.
- [ ] **Report:** add `npm run complexity:report` → `code-complexity . --sort score --limit 30 --complexity cyclomatic --format json`.
- [ ] **Smoke:** one test that runs the *actual* gate command against an overcomplex fixture and asserts non-zero exit (proves config discovery + glob + exit wiring).

**Acceptance:** ratchet provably blocks regressions and only moves down; report emits JSON; smoke passes.

---

## Phase 5 — CI  · bead: `P5 CI`

- [ ] Add `.github/workflows/complexity.yml` per spec §7: `checkout` with `fetch-depth: 0` (churn needs history), `npm ci`, `eslint . --max-warnings 0` (hard gate), `code-complexity … > complexity-report.json` (`if: always()`), upload as artifact. (Separate lane per D-2; fold into `ci.yml` later once stable.)
- [ ] Open a throwaway PR that adds an overcomplex function → confirm the lane goes **red**; revert → confirm **green** + artifact present.

**Acceptance:** lane green on a clean PR, red on an intentionally-complex one, report artifact attached.

---

## Phase 6 — Measure & rank: pick the top 3 refactor targets  · bead: `P6 Measure`

The gate is now live; this phase turns its output into a concrete, evidence-based target list (D-5).

- [ ] Run `npm run complexity:report` and `eslint . --format json` on `HEAD`; extract every function over CC 10 with its file, name, and value.
- [ ] Rank files by **churn × complexity** (the `code-complexity` score) — recent-change frequency × complexity, so we fix what's both hard *and* actively edited.
- [ ] Select the **top 3 files**. Expected front-runners from current LOC + centrality: `server.ts` (WS/REST hub), `src/terminal.ts` (PTY lifecycle), `src/orbital/useOrbitalData.ts` (dashboard hook) — but **let the ranking decide**, not LOC alone.
- [ ] Record the chosen 3 + their specific offending functions + target end-state on the bead.

**Acceptance:** a written, ranked target list of 3 files and their violating functions, justified by the report (not by file size).

---

## Phase 7 — Refactor the top 3 hotspots under CC 10  · bead: `P7 Refactor`

Per-file, behavior-preserving, one PR per file for reviewability (D-5, D-6). For each of the 3 targets:

- [ ] **Safety net (D-6):** for `server.ts` and `src/terminal.ts`, **write characterization tests first** that pin the current behavior of the functions being changed (request routing, message dispatch, pane lifecycle/teardown) before touching them. For lower-risk targets, confirm existing coverage is adequate; add tests only where thin.
- [ ] Refactor the offending functions below CC 10 using behavior-preserving moves: extract helper functions, replace nested conditionals with early returns / guard clauses, lift `switch`/dispatch tables, decompose long `&&`/`||` chains. **No functional changes.**
- [ ] After each file: `npm test` + `npm run test:e2e` green; `npx eslint . --prune-suppressions` to drop the now-fixed entries; commit the shrunk `eslint-suppressions.json` alongside the refactor.
- [ ] Confirm the file's functions now pass the gate without suppressions.

**Acceptance:** the 3 target files have zero remaining `complexity` suppressions; full test + e2e suites green; behavior unchanged (characterization tests still pass).

---

## Phase 8 — Docs + burn-down plan for the remaining hotspots  · bead: `P8 Docs+Plan`

- [ ] Update `CLAUDE.md` "Build & Test" with `npm run complexity` / `npm run complexity:report` and a one-line note on the baseline/ratchet.
- [ ] Write a **next-step burn-down plan** (new doc under `docs/superpowers/plans/`) for the hotspots NOT addressed in Phase 7: list the remaining files with suppressions, ranked by churn × complexity, each as a future refactor bead with a rough estimate. This is the "develop a next-step plan for the rest" deliverable.
- [ ] File the remaining refactor beads under the epic, prioritized by that ranking.
- [ ] Optionally wire the gate into the opt-in `.githooks` pre-commit (advisory locally) via `scripts/install-wt-lock.sh`'s install path.

**Acceptance:** docs updated; burn-down plan committed; remaining refactor beads filed and linked to the epic.

---

## Definition of done (epic)

- New/changed code is gated at cyclomatic 10 in CI; legacy violations are baselined and only ratchet down.
- The gate is proven by hand-counted fixtures and a failing-case smoke test.
- A churn × complexity report is produced each CI run as an artifact.
- The top 3 hotspot files (by churn × complexity) are refactored under CC 10 with zero remaining suppressions, behavior-preserving and test-backed.
- A prioritized burn-down plan + beads exist for every remaining hotspot, linked to the epic.
