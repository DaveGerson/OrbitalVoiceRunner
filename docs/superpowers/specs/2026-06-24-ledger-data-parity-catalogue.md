# useLedgerData extraction — parity test catalogue

**Bead:** `wsm-e2e-pinned-4ib` · **Branch:** `dbt4/hooks-ledger-data` · **Base:** `main@86e3737`

## What this change is

The final dbt4 App.tsx decomposition keystone. It lifts the **data spine** — 9 read-only state
slices + the 7 GET fetchers that populate them — out of the 3,259-line `App.tsx` god component into a
focused `src/classic/hooks/useLedgerData.ts`. It is a **pure architectural extraction: zero intended
change to end-user behavior.** The boot effect, the 20s safety-net poll, and every mutation handler
(POST/PUT/DELETE) deliberately **stay in `App.tsx`** — they orchestrate across sibling hooks
(`useApprovalsQueue`, `useComposer`, `useEarcons`) and would create a hook create-order cycle if pulled in.

## The safety contract (why the operator can trust "nothing changed")

Three independent gates, each **proven green against pre-extraction `main` first**, then re-asserted
after the move. A drop, rename, reorder, or visual drift fails at least one of them.

| # | Gate | Tool / lane | What it proves | Catches |
|---|------|-------------|----------------|---------|
| 1 | **Pure-logic characterization** | `tests/test_ledger_data_logic.ts` (node:test) | the 4 response normalizers are byte-for-byte identical | a changed freeze/notes/archive/settings decision |
| 2 | **REST preservation** | `src/ledgerData.rest.test.tsx` (vitest + jsdom) | the exact boot REST endpoint **set** is unchanged | a dropped/renamed/duplicated/new API call |
| 3 | **Pixel parity** | `e2e/ledger_data_pixel_parity.spec.ts` (Playwright, win32-local) | each interaction renders pixel-identical | any visual drift the DOM assertions miss |

Plus the existing **178-spec mock e2e lane** (asserts visible DOM for every interaction) and the full
`tsc` / unit / complexity gate.

---

## Gate 1 — pure-logic characterization (`tests/test_ledger_data_logic.ts`)

Pins the one pure decision inside each fetcher (the I/O wrapper itself is covered by Gate 2). Each
helper in `src/classic/helpers/ledgerDataLogic.ts` is verbatim from the original inline fetcher body.

| Test | Intent |
|---|---|
| `normalizeProjectNotes: passes a real array through untouched` | `fetchProjectNotes` keeps a valid notes array by reference |
| `normalizeProjectNotes: non-array / missing -> []` | malformed `notes` body degrades to `[]`, never throws |
| `normalizeFrozenStatus: coerces frozen to a hard boolean` | **kill-switch** — `frozen` is `!!`-coerced; truthy/undefined map correctly |
| `normalizeFrozenStatus: running falls back to [] for any non-array body` | **kill-switch** — `running` is array-guarded; bad body → `[]` |
| `normalizeArchive: unwraps data.archived, else []` | archive panel reads `data.archived` with `[]` fallback |
| `globalModeFromSettings: applies the mode when advanced present, skips otherwise` | settings' `if (data.advanced)` guard reproduced byte-for-byte via an `{apply, mode}` discriminator |

## Gate 2 — REST preservation (`src/ledgerData.rest.test.tsx`)

Renders the **real** `<App/>` (classic `AppRaw`) in non-mock jsdom with a recording `fetch` stub, then
asserts the deduped boot GET set **equals** the golden set captured from pre-extraction `main`. (The
mock e2e lane can't do this — every fetcher short-circuits on `?mock=1`, suppressing the calls.)

| Test | Intent |
|---|---|
| `issues every ledger-data GET endpoint on boot (non-mock)` | the boot path issues EXACTLY these 9 GETs, no more, no fewer |

**Golden boot GET set** (captured at `86e3737`):
`/api/terminals` · `/api/ledger` · `/api/settings` · `/api/plans` · `/api/archive` ·
`/api/stop-all/status` · `/api/projects/default_project/notes` *(the 7 ledger-data endpoints)* +
`/api/commands/pending` *(useApprovalsQueue)* + `/api/projects/default_project/drafts` *(useComposer)*.
`fetchActiveDraft` is correctly **absent** on boot (no active pane). Stable across 3 consecutive runs.

## Gate 3 — pixel parity (`e2e/ledger_data_pixel_parity.spec.ts`)

Drives each ledger-data-fed interaction through the deterministic `?mock=1` harness and snapshots the
stable component. **Same-machine before/after**: baselines are written on pre-extraction code, then
compared after the move — 0 diff == parity. Baselines are **gitignored** (win32-specific local proof,
not a cross-platform golden). It is an **opt-in tool, not a standing gate** — gated behind
`PIXEL_PARITY=1` (+ win32) so it never trips the shared e2e lane or CI on a worktree without locally
written baselines. **Verified this extraction: 4/4, 0 diff** (post-extraction vs pre-extraction baselines).

| Test (snapshot) | Ledger-data state exercised | Intent |
|---|---|---|
| `boot cockpit` (`boot-terminal-pane.png`) | terminals / ledger / settings / plans / archive | the default cockpit render is unchanged |
| `FROZEN emergency-stop banner` (`frozen-banner.png`) | `frozen` / `frozenRunning` | **safety-critical** — the kill-switch banner is pixel-identical |
| `approval modal` (`approval-dialog.png`) | `pendingCommands` path | a held approval renders unchanged |
| `pending-action dialog` (`action-dialog.png`) | `pendingActions` path | a staged action renders unchanged |

Renders confirmed deterministic (before==before re-run: 4/4, 0 diff) — no timestamp/animation flake.

---

## Reproduce

```bash
# Gate 1 (logic chars)
npx tsx --test --test-force-exit tests/test_ledger_data_logic.ts
# Gate 2 (REST preservation)
npx vitest run src/ledgerData.rest.test.tsx
# Gate 3 (pixel parity — opt-in, Windows; writes baselines on first run, compares thereafter)
PIXEL_PARITY=1 npx playwright test ledger_data_pixel_parity.spec.ts
```
