# Cyclomatic Complexity — Gate, Implementation & Burn-Down

- **Date:** 2026-06-19 (completed 2026-06-22) · **Status:** ✅ **COMPLETE.** Gate shipped & CI-enforced; the full burn-down is done — suppressions baseline **78 → 0**, `RATCHET_CEILING` = **0**, every first-party function ≤ CC 10 with **zero suppressions**. Cognitive-complexity was later promoted from advisory to a hard gate, and `react-hooks` was adopted. See **§9 Completion**.
- **Supersedes:** the separate design / phased-plan / burn-down docs (consolidated here 2026-06-19).
- **Source of truth in code:** `eslint.config.js`, `eslint-suppressions.json`, `scripts/check-suppressions-ratchet.mjs`, `scripts/complexity-report.mjs`, `.github/workflows/complexity.yml`, `tests/test_complexity_*.ts`.

## 1. Goal

Test for, gate, and evaluate per-function **cyclomatic complexity** (McCabe) across the first-party TypeScript, so new code stays simple and existing hotspots are paid down over time — without a big-bang refactor. North star: *simple and accurate, extensible.*

## 2. Locked decisions (operator interview, 2026-06-19)

- **D-1 Toolchain:** ESLint stack — `eslint` + `typescript-eslint` + `eslint-plugin-sonarjs`. (No ESLint existed before; `npm run lint` was `tsc --noEmit` only.)
- **D-2 CI:** a dedicated `complexity.yml` lane, separate from the main CI lane.
- **D-3 Thresholds:** cyclomatic `complexity: ['error', 10]` (McCabe/NIST limit); cognitive `sonarjs/cognitive-complexity: ['warn', 15]` (advisory only). *(2026-06-22: cognitive later promoted to `['error', 15]` — now a hard gate. See §9.)*
- **D-4 Enforcement:** baseline the legacy violations, fail CI on any **new/changed** violation immediately.
- **D-5 Refactor appetite:** measure first, refactor the top hotspots by churn × complexity, then schedule the rest (this burn-down, §7).
- **D-6 Safety net:** characterization tests **first** for core machinery (`server.ts`, `terminal.ts`); `.tsx`/hook refactors must be verified on the **e2e lanes**, not the unit suite (they have little/no unit coverage).

## 3. Why cyclomatic (and how it differs from cognitive)

Cyclomatic = `1 + #decision points` (`if`/`else-if`, loops, each `case`, `catch`, each `&&`/`||`, ternary). It equals the minimum branch-coverage test count — standardized, deterministic, hand-verifiable, so it's the **hard gate**. Cognitive complexity (SonarSource) weights nesting and rewards readable shorthand; it's a better *readability* proxy. It originally rode along as an **advisory `warn`**, but as of 2026-06-22 it is **also a hard gate** (`['error', 15]`, §9) — we now gate on both.

## 4. What shipped

- **Gate** (`eslint.config.js`): `complexity ['error', 10]` + cognitive `['warn', 15]` *(since 2026-06-22: `['error', 15]`, §9)* + later `react-hooks/rules-of-hooks` (error). Matched **by file extension** (`**/*.{ts,tsx,mts,cts,mjs,cjs,jsx}` minus explicit `ignores`) so new dirs/extensions can't silently escape; test code (`tests/**`, `e2e/**`) is exempt by explicit decision.
- **Baseline + ratchet:** every pre-existing violation is recorded in `eslint-suppressions.json` (a generated, committed baseline). New/changed code is held to CC ≤ 10 immediately. The baseline may only **shrink** (§5).
- **Hotspot report** (`scripts/complexity-report.mjs`): ranks files by **churn × complexity** (git commit count × Σ CC of over-limit functions), built only from the ESLint API + git — no extra deps.
- **CI lane** (`.github/workflows/complexity.yml`): runs the gate, the ratchet guard, and uploads the report artifact.
- **Refactors:** `src/voice/index.ts` (Phase 7a, the CC-57 `onmessage` handler) and `src/terminal.ts` (Phase 7b, 9 functions incl. two CC-26) decomposed under CC 10, behavior-preserving, each with characterization tests.
- **Self-proving tests:** `tests/test_complexity_gate.ts` asserts ESLint reports the exact hand-counted CC of one realistic fixture (`username-validator.ts`, CC 6) and that the gate fires at `> max`; coverage guard asserts non-test source is gated and test code is exempt.

## 5. The ratchet (how regressions are blocked)

`eslint .` exit-code contract:

| Exit | Meaning | Action |
|---|---|---|
| 0 | clean | — |
| 1 | a new/changed function exceeds CC 10 | fix it (or, with justification, inline-disable) |
| 2 | a suppression is now unused (code improved) | `npx eslint . --prune-suppressions`, commit the smaller baseline, lower `RATCHET_CEILING` |

Two guards, defense-in-depth:
- **Per-file guard** (`scripts/check-suppressions-ratchet.mjs`): diffs the baseline against the base branch and **fails closed** on any per-file count increase or new file key — catching the `--suppress-all` re-baseline bypass. Unresolvable base ref ⇒ fail closed (opt out only via `ALLOW_MISSING_BASE=1`).
- **Total ceiling** (`RATCHET_CEILING` in `tests/test_complexity_ratchet.ts`): a one-way total that may only be lowered (or raised once for a deliberate, reviewed scope expansion).

## 6. Commands

```bash
npm run complexity          # the gates: eslint complexity<=10 + cognitive-complexity<=15 + react-hooks/rules-of-hooks (all error)
npm run complexity:report   # churn × complexity hotspot ranking (table or --format json)
npx eslint . --prune-suppressions   # after refactoring: shrink the baseline
node scripts/check-suppressions-ratchet.mjs --base origin/main   # ratchet guard
```

## 7. Burn-down — remaining hotspots — ✅ COMPLETE (2026-06-22)

> **All hotspots below are done.** The baseline went **78 → 0** and `RATCHET_CEILING` is now `0`; every first-party function is ≤ CC 10 with zero suppressions (see **§9** for the PR arc). The plan and table are retained below as the historical record.

The gate **stops new** complexity; it parks the ~110 legacy violations in the baseline. Pay them down file-by-file, **highest churn × complexity first**: refactor under CC 10 (behavior-preserving), `--prune-suppressions`, lower `RATCHET_CEILING`, repeat until the baseline is empty and `RATCHET_CEILING` is `0`. Each file is one `bd` bead under the epic, ideally one PR. **Re-run `npm run complexity:report` before each — the ranking shifts as files churn and as targets prune out.**

> ⚠️ **The top remaining targets are `.tsx`/hook code with little/no unit coverage** (`App.tsx`, `useOrbitalData.ts`, `SettingsDialog.tsx`, `OrbitalApp.tsx`). Per D-6 their refactors **must** be verified with `npm run test:e2e` (+ `test:e2e:live`), **not** the unit suite — a green unit run will hide a broken render/effect/event. Only pure-TS targets (`gating/index.ts`, `sqliteStore.ts`) may rely on the unit suite, adding characterization tests where coverage is thin.

| # | File | Score | Violations | Verify with |
|---|---|---:|---:|---|
| 1 | `src/App.tsx` | 2088 | 11 | **e2e (mock + live)** |
| 2 | `src/orbital/useOrbitalData.ts` | 1950 | 7 | **e2e (mock + live)** |
| 3 | `src/gating/index.ts` | 1192 | 7 | unit (add char tests first) |
| 4 | `src/components/SettingsDialog.tsx` | 1015 | 7 | **e2e (mock + live)** |
| 5 | `src/store/sqliteStore.ts` | 638 | 4 | unit |
| 6 | `src/orbital/OrbitalApp.tsx` | 592 | 1 | **e2e (mock + live)** |
| 7 | *long tail* | — | remainder | per-file, smallest first |

`bd` is Windows-local (unavailable in the web/Linux remote), so file these on the Windows host under the epic until then:

```
bd create "Burndown: src/App.tsx under CC 10 (verify e2e mock+live)"             --parent PARENT
bd create "Burndown: src/orbital/useOrbitalData.ts under CC 10 (verify e2e)"     --parent PARENT
bd create "Burndown: src/gating/index.ts under CC 10 (unit char tests)"          --parent PARENT
bd create "Burndown: src/components/SettingsDialog.tsx under CC 10 (verify e2e)" --parent PARENT
bd create "Burndown: src/store/sqliteStore.ts under CC 10 (unit)"                --parent PARENT
bd create "Burndown: src/orbital/OrbitalApp.tsx under CC 10 (verify e2e)"        --parent PARENT
bd create "Burndown: long-tail complexity suppressions to zero"                  --parent PARENT
```

**Definition of done** — ✅ *achieved 2026-06-22 (except beads; see §9):* `eslint-suppressions.json` has zero `complexity` entries; `RATCHET_CEILING` is `0`; `eslint .` passes the whole tree at CC ≤ 10 with no suppressions; every `.tsx`/hook refactor was verified green on the e2e lanes; every bead closed.

## 8. Key numbers & sources

- McCabe / NIST SP 500-235 limit: **10** (up to 15 with strong practices). ESLint `complexity` default is 20 → set to 10. sonarjs cognitive default 15. ESLint bulk suppressions shipped v9.24.
- ESLint `complexity` rule — https://eslint.org/docs/latest/rules/complexity · Bulk suppressions — https://eslint.org/docs/latest/use/suppressions · sonarjs cognitive-complexity — https://github.com/SonarSource/eslint-plugin-sonarjs · NIST/McCabe — https://www.mccabe.com/nist/nist_pub.php

## 9. Completion (2026-06-22)

**The burn-down is complete and the gate was hardened beyond the original spec.** Delivered across PRs **#76–#87** — parallel isolated-worktree refactors, each behavior-preserving, adversarially reviewed (Opus-model reviewer), and verified green on `e2e-live` + `e2e-mock` per D-6.

- **Baseline `78 → 0`.** Every first-party function is ≤ CC 10; `eslint-suppressions.json` is empty; `RATCHET_CEILING` is `0` — the ratchet is now a **hard zero** (any newly-introduced complexity suppression fails CI). McCabe gate DoD fully met.
  - **Arc:** #76 gate+baseline → #77 pure-TS long tail → #78 quick wins (server + scripts) → #79 non-`.tsx` tail → #80–#82 `.tsx` leaves/containers → #83 giants (`StationCard`/`OrbitalApp`/`server.startServer`) → #84 monsters (`App.tsx` incl. `AppRaw` at CC **102**, `SettingsDialog`, `useOrbitalData`).
- **Cognitive-complexity promoted to a hard gate** (#87): `sonarjs/cognitive-complexity: ['error', 15]` — was advisory `warn` per D-3. A self-proving smoke test (`tests/test_complexity_ratchet.ts`) asserts it fires at error severity on deeply-nested code, so it can't silently regress to `warn`.
- **`react-hooks` adopted** (#85 — *not* in the original spec): `react-hooks/rules-of-hooks: 'error'`, which **caught and fixed a real conditional-hook bug** (`App.tsx` `GenericPromptModal` called `useState` after an early `return null` while rendered unconditionally). `react-hooks/exhaustive-deps` is advisory `warn` — deliberately not escalated, because the codebase's unstable-body-fn idiom would make `error` force a disable on nearly every effect.
- **All advisory lint warnings cleared to zero** (#86): dead `eslint-disable` directives removed, the 6 `exhaustive-deps` cases resolved/justified, the 3 cognitive hotspots refactored. `eslint .` → **0 errors, 0 warnings**.

**Active gates** (`eslint.config.js`): `complexity` ≤10 (error) · `sonarjs/cognitive-complexity` ≤15 (error) · `react-hooks/rules-of-hooks` (error) · `react-hooks/exhaustive-deps` (warn).

**Remaining (operator-side only):** the burn-down `bd` beads should be marked closed on the Windows host — `bd` is unavailable from the Linux web/remote environment (per the §7 note); no code or doc work remains.
