# Cyclomatic Complexity — Burn-Down Plan for Remaining Hotspots

> **For agentic workers:** implement file-by-file, highest churn × complexity first. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Companion spec:** [`docs/superpowers/specs/2026-06-19-cyclomatic-complexity-design.md`](../specs/2026-06-19-cyclomatic-complexity-design.md)
> **Parent plan:** [`docs/superpowers/plans/2026-06-19-cyclomatic-complexity.md`](./2026-06-19-cyclomatic-complexity.md) — this doc is the Phase 8 "next-step burn-down plan for the rest" deliverable (spec §9 D-5).

**Goal:** Pay down the ~110 cyclomatic-complexity violations that the gate baselined into
`eslint-suppressions.json`, file-by-file, highest **churn × complexity** first, until the
baseline is empty and the gate enforces CC ≤ 10 over the *entire* tree with no suppressions.

---

## Where we are (state at start of Phase 8)

The gate from the main plan is **live and CI-enforced** (`.github/workflows/complexity.yml`):

- `complexity: ['error', 10]` (cyclomatic, hard gate) + `sonarjs/cognitive-complexity: ['warn', 15]` (advisory).
- A **baseline + ratchet**: every pre-existing violation is recorded in `eslint-suppressions.json`;
  new/changed code is held to CC ≤ 10 immediately.
- A **per-file ratchet guard** (`scripts/check-suppressions-ratchet.mjs`) plus a total-count ceiling
  asserted by `tests/test_complexity_ratchet.ts` (`RATCHET_CEILING`, currently **119**). The count is
  a one-way ratchet — it may only shrink.
- A **churn × complexity hotspot report** (`scripts/complexity-report.mjs`) via `npm run complexity` /
  `npm run complexity:report`.
- Scope covers `.ts`/`.tsx` (incl. React components) and `.ts`/`.mjs` scripts.

**Already paid down** (out of scope here): `src/voice/index.ts` (Phase 7a) and `src/terminal.ts`
(Phase 7b, in progress). This plan covers everything that still carries suppressions.

## The burn-down model

The gate **stops new complexity**; it does not erase the legacy debt — it parks it in the baseline.
Burn-down is the scheduled paydown of that parked debt:

1. Pick the highest **churn × complexity** file still carrying suppressions (refactor what is both
   hard *and* actively edited first).
2. Refactor its offending functions below CC 10 — behavior-preserving moves only: extract helpers,
   early-return / guard clauses, lift `switch`/dispatch tables, decompose long `&&`/`||` chains.
3. Prune the now-fixed entries: `npx eslint . --prune-suppressions`, commit the smaller
   `eslint-suppressions.json`.
4. **Lower `RATCHET_CEILING`** in `tests/test_complexity_ratchet.ts` to the new total so the gate
   locks in the gain and can never regress back up.
5. Repeat until the baseline is empty and `RATCHET_CEILING` is `0`.

Each file is one `bd` bead and (ideally) one PR for reviewability.

## ⚠️ CRITICAL — top targets are React/hook code with NO unit coverage

The highest-ranked remaining targets are **`.tsx` components and hooks**: `src/App.tsx`,
`src/orbital/useOrbitalData.ts`, `src/components/SettingsDialog.tsx`, `src/orbital/OrbitalApp.tsx`.
These have **little or no unit-test coverage** — they are exercised by the **Playwright e2e lanes**
(`?mock=1` harness + live), not the `node:test` unit suite.

**Per D-6, refactors of these files MUST be verified with `npm run test:e2e` (and ideally
`npm run test:e2e:live`), which need the full Windows/CI environment — NOT just `npm test`.**
Do **not** refactor a hook or component on the unit suite alone: the unit suite will pass while a
broken render, effect, or event wiring ships undetected. Treat a green e2e (mock + live) as the
acceptance gate for every `.tsx`/hook bead below. Only the pure-TS targets (`src/gating/index.ts`,
`src/store/sqliteStore.ts`) may rely primarily on the unit suite, and only where existing coverage
is adequate — add characterization tests where it is thin.

---

## Ranked targets (churn × complexity)

Ranked by the `npm run complexity:report` score (recent change frequency × complexity). Size is a
rough estimate from violation count + max CC: **small** ≈ 1 violation / shallow; **medium** ≈ 4–7
violations; **large** ≈ 7+ violations on a high-churn, low-coverage file.

| # | File | Score | Violations | Size | Verify with | Notes |
|---|---|---:|---:|---|---|---|
| 1 | `src/App.tsx` | 2088 | 11 | **large** | **e2e (mock + live)** | Root React component; highest churn, most violations, no unit coverage. |
| 2 | `src/orbital/useOrbitalData.ts` | 1950 | 7 | **large** | **e2e (mock + live)** | Dashboard data hook; effect/state heavy, e2e-only coverage. |
| 3 | `src/gating/index.ts` | 1192 | 7 | **medium** | unit suite | Capability-gate matrix — core safety choke-point; pure TS, unit-testable. Add characterization tests for the gate-decision paths first. |
| 4 | `src/components/SettingsDialog.tsx` | 1015 | 7 | **medium** | **e2e (mock + live)** | Settings UI; form/branch heavy, no unit coverage. |
| 5 | `src/store/sqliteStore.ts` | 638 | 4 | **medium** | unit suite | SQLite ledger; covered by store unit tests — extend where thin. |
| 6 | `src/orbital/OrbitalApp.tsx` | 592 | 1 | **small** | **e2e (mock + live)** | Single violation; quick win once the bigger orbital work lands. |
| 7 | *long tail* | — | ~remainder | small each | per-file | Remaining files holding the rest of the ~110 baselined suppressions; sweep last, smallest-first, lowering `RATCHET_CEILING` each time. |

> The total across the named targets (≈37 violations) plus the long tail accounts for the ~110
> baselined suppressions (`RATCHET_CEILING` = 119 at start). Re-run `npm run complexity:report`
> before claiming each bead — the ranking shifts as files churn and as terminal.ts/voice prune out.

---

## Per-target tasks (repeat for each file, in rank order)

- [ ] Run `npm run complexity:report`; confirm the file is still the top remaining target (ranking may shift).
- [ ] List the file's offending functions from `eslint . --format json` (file, function, CC value).
- [ ] **Safety net:** for `.tsx`/hook targets, confirm the e2e lanes exercise the affected UI paths; for pure-TS targets (`gating/index.ts`, `sqliteStore.ts`) add/confirm unit characterization tests for the functions being changed.
- [ ] Refactor each offending function below CC 10 — behavior-preserving only (extract helpers, guard clauses, dispatch tables, decompose boolean chains). **No functional changes.**
- [ ] **Verify:** `.tsx`/hook → `npm run test:e2e` **and** `npm run test:e2e:live` green; pure-TS → `npm test` green. Always keep `npm run lint` (tsc) green.
- [ ] `npx eslint . --prune-suppressions`; commit the shrunk `eslint-suppressions.json`.
- [ ] Lower `RATCHET_CEILING` in `tests/test_complexity_ratchet.ts` to the new total; re-run `npm test` to confirm the ratchet holds.
- [ ] Confirm the file now passes the gate with **zero** remaining `complexity` suppressions.

---

## Bead structure (create on the Windows host — `bd` is Windows-local; this doc is the source of truth until filed)

`bd` is not available in the web/Linux remote, so file these on the Windows host under the existing
epic (`PARENT` = "Cyclomatic complexity: gate, baseline, refactor top 3"), prioritized by the
ranking above. Mirrors the bead block in the [main plan](./2026-06-19-cyclomatic-complexity.md).

```
bd create "Burndown: src/App.tsx under CC 10 (verify e2e mock+live)"            --parent PARENT
bd create "Burndown: src/orbital/useOrbitalData.ts under CC 10 (verify e2e)"    --parent PARENT
bd create "Burndown: src/gating/index.ts under CC 10 (unit char tests)"         --parent PARENT
bd create "Burndown: src/components/SettingsDialog.tsx under CC 10 (verify e2e)" --parent PARENT
bd create "Burndown: src/store/sqliteStore.ts under CC 10 (unit)"               --parent PARENT
bd create "Burndown: src/orbital/OrbitalApp.tsx under CC 10 (verify e2e)"       --parent PARENT
bd create "Burndown: long-tail complexity suppressions to zero"                 --parent PARENT
```

**Dependency note:** these are independent and can be claimed in any order, but work them
**highest-score first** so the most-edited, riskiest hotspots clear soonest. Lower `RATCHET_CEILING`
on each close so progress is locked.

---

## Definition of done

- Every named target and the long tail are refactored under CC 10; `eslint-suppressions.json` has
  **zero** `complexity` entries (an empty baseline).
- `RATCHET_CEILING` in `tests/test_complexity_ratchet.ts` is **0**.
- `npm run complexity` (i.e. `eslint .`) passes the whole tree with CC ≤ 10 and no suppressions —
  the gate now enforces the limit everywhere, not just on new/changed code.
- All `.tsx`/hook refactors were verified green on `npm run test:e2e` (mock) and
  `npm run test:e2e:live`; all pure-TS refactors green on `npm test`; behavior unchanged throughout.
- Every burn-down bead is closed and linked to the epic.
