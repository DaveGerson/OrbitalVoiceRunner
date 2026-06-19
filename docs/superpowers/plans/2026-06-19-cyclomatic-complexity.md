# Cyclomatic Complexity — Phased Work Plan

> **For agentic workers:** implement task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Companion spec:** [`docs/superpowers/specs/2026-06-19-cyclomatic-complexity-design.md`](../specs/2026-06-19-cyclomatic-complexity-design.md) — read it first; this plan executes that design.

**Goal:** Stand up a per-function **cyclomatic-complexity gate** (ESLint `complexity` @ max 10) plus a **cognitive-complexity advisory** and a **churn × complexity report**, rolled out with a **baseline + ratchet** so CI is green on day one over the existing 1K+ LOC hotspots while new/changed code is held to the limit immediately.

**Tech stack:** TypeScript, `node:test` via `tsx --test --test-force-exit`. New dev deps: `eslint`, `typescript-eslint`, `eslint-plugin-sonarjs`, `code-complexity` (pending O-1, §Phase 0).

---

## Bead structure (create these on the Windows host — `bd` is not available in the web/Linux remote)

`bd` is a Windows-local tool and isn't installed in this remote container, so this plan is the source of truth until the beads are filed. On the Windows host, create one **parent epic** + seven **child beads**, then claim them in order:

```
bd create "Cyclomatic complexity: measure, gate, evaluate" --type epic   # -> PARENT
bd create "P0 Decide: ESLint vs fallback, lane, threshold" --parent PARENT
bd create "P1 Fixtures + failing gate tests (red)"          --parent PARENT
bd create "P2 Wire ESLint complexity + cognitive (green)"   --parent PARENT
bd create "P3 Baseline legacy via bulk suppressions"        --parent PARENT
bd create "P4 Ratchet guard + churn×complexity report"      --parent PARENT
bd create "P5 CI lane (complexity.yml)"                      --parent PARENT
bd create "P6 Docs + file refactor beads for hotspots"      --parent PARENT
```

**Dependency chain:** P0 → P1 → P2 → P3 → P4 → P5 → P6. P1 may start in parallel with P0 (fixtures don't depend on the tool choice); everything else is strictly sequential.

## Platform / worktree notes (read first)

- This project runs on **Windows 11**. Work in a dedicated worktree (e.g. `OrbitalVoiceRunner-wt/cyclomatic-complexity`) on branch `claude/cyclomatic-complexity-spec-k3x4nz` (or a child feature branch). Never edit the main checkout for commits.
- Shell routing: **PowerShell tool** for npm (PS 5.1, no `&&` — chain with `;`; set `$env:PYTHONIOENCODING='utf-8'`). **Bash tool** (Git Bash) for git only. Never mix shells in one call.
- **Any `package.json` change requires `npm ci`** before lint/test, then `node scripts/check-deps.mjs` to confirm `node_modules` is in sync.
- Tests: `npm test` = `tsx --test --test-force-exit`. Judge by the runner summary (`# pass N / # fail 0`) + exit code; node-pty `NativeCommandError` lines are display artifacts.
- ESLint **runs alongside** `tsc --noEmit`, it does not replace it. `npm run lint` must stay green throughout.

---

## Phase 0 — Decide (blocking)  · bead: `P0 Decide`

Resolve the spec's open questions with the operator before writing config. **No code in this phase.**

- [ ] **O-1** Add ESLint (recommended) or use the zero-dep `cyclomatic-complexity` CLI fallback? Determines the entire toolchain.
- [ ] **O-2** Separate `complexity.yml` CI lane (recommended) or fold into `ci.yml`'s lint step?
- [ ] **O-3** Gate threshold 10 (recommended, NIST) or 15?
- [ ] **O-4** Fail CI on new violations immediately (recommended; suppressions keep legacy green) or advisory-only for one milestone?

**Acceptance:** decisions recorded on the bead; the rest of the plan's "ESLint" steps swap to the fallback if O-1 says so.

---

## Phase 1 — Fixtures + failing gate tests (red)  · bead: `P1 Fixtures`

Write the verification harness *first*, before any analyzer exists, so the gate is proven, not assumed.

- [ ] Create `tests/fixtures/complexity/` with hand-counted fixtures: `cc-01.ts`, `cc-10.ts`, `cc-11.ts`, `cc-15.ts`, `cc-16.ts` (each function's McCabe value computed by "1 + decision points", documented in a comment, bracketing the warn/error boundaries).
- [ ] Create `tests/test_complexity_gate.ts`: run ESLint via its Node API (`new ESLint({ overrideConfigFile })`) against each fixture and assert the **exact** reported number (`/complexity of N/`) and that sub-threshold fixtures produce **zero** `complexity` messages.
- [ ] Run `npm test` — these fail (no config yet). Commit red.

**Acceptance:** the new test file exists, fails for the right reason (no ESLint config / module), and is committed.

---

## Phase 2 — Wire the analyzer (green)  · bead: `P2 Wire`

- [ ] `npm i -D eslint typescript-eslint eslint-plugin-sonarjs` (or the fallback CLI per O-1); run `npm ci` + `node scripts/check-deps.mjs`.
- [ ] Add `eslint.config.js` (flat): `complexity: ['error', 10]` and `sonarjs/cognitive-complexity: ['warn', 15]`, scoped to `server.ts`, `src/**/*.ts`, `scripts/**/*.ts`; ignore `tests/**`, `dist/**`, `*.generated.ts`, Python.
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

- [ ] **Ratchet:** ensure the committed suppression count can only shrink — either rely on ESLint's `--prune-suppressions` workflow + a CI assertion that suppressions didn't grow, **or** (fallback path) build `scripts/complexity-gate.mjs` that diffs current counts against `complexity-baseline.json`, fails on any per-file increase, and rewrites the baseline downward on improvement.
- [ ] If the fallback script is used, add `tests/test_complexity_ratchet.ts`: regress-above-baseline → exit non-zero; improvement → exit 0 + baseline rewritten down; boundary (count == threshold) explicit.
- [ ] **Report:** add an `npm run complexity:report` script: `code-complexity . --sort score --limit 30 --complexity cyclomatic --format json`.
- [ ] **Smoke:** one test that runs the *actual* gate command against an overcomplex fixture and asserts non-zero exit (proves config discovery + glob + exit wiring).

**Acceptance:** ratchet provably blocks regressions and only moves down; report emits JSON; smoke passes.

---

## Phase 5 — CI  · bead: `P5 CI`

- [ ] Add `.github/workflows/complexity.yml` per spec §7: `checkout` with `fetch-depth: 0` (churn needs history), `npm ci`, `eslint . --max-warnings 0` (hard gate), `code-complexity … > complexity-report.json` (`if: always()`), upload as artifact. *(Or fold into `ci.yml` per O-2.)*
- [ ] Open a throwaway PR that adds an overcomplex function → confirm the lane goes **red**; revert → confirm **green** + artifact present.

**Acceptance:** lane green on a clean PR, red on an intentionally-complex one, report artifact attached.

---

## Phase 6 — Docs + hotspot follow-ups  · bead: `P6 Docs`

- [ ] Update `CLAUDE.md` "Build & Test" with `npm run complexity` / `npm run complexity:report` and a one-line note on the baseline/ratchet.
- [ ] Read the Phase 4 report; file one **refactor bead per top hotspot** (start with `useOrbitalData.ts`, `terminal.ts`, `server.ts`), each scoped to drive its worst functions under 10 and prune the corresponding suppressions.
- [ ] Optionally wire the gate into the opt-in `.githooks` pre-commit (advisory locally) via `scripts/install-wt-lock.sh`'s install path.

**Acceptance:** docs updated; refactor beads filed and linked to the epic; suppressions begin shrinking as hotspots are addressed.

---

## Definition of done (epic)

- New/changed code is gated at cyclomatic 10 in CI; legacy violations are baselined and only ratchet down.
- The gate is proven by hand-counted fixtures and a failing-case smoke test.
- A churn × complexity report is produced each CI run as an artifact.
- Refactor beads exist for the top hotspots, linked to this epic.
