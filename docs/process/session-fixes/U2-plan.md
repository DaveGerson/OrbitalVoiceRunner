# U2 — Per-pane Capability Matrix: finish/merge the worktree surface

> **Bead:** `wsm-e2e-pinned-cbo` · **Priority:** P1 · **Type:** feature (UI) · **Mode:** SPEC (UI fix — user-required spec process)
> **Source-of-truth worktree (READ-ONLY):** `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner/.claude/worktrees/push-observation` (branch `feat/p0b-matrix-live-harness`)
> **Implementation worktree (WRITE here):** `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/session-fixes` (branch `feat/session-fixes`)
> **Integration / current main:** `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner`

---

## BLUF

Main has the **data model** (`src/types.ts` `CapabilityGate` / `CapabilityGateMap` / `DEFAULT_CAPABILITY_GATES`) and the **server resolver** (`effectiveCapabilityGateFor`, `effectiveModeFor`, `resolveCapabilityGateWithContext`), but **zero UI** to read or set the 16-cap Auto/Ask/Off matrix per pane. The full surface is already built and test-pinned in the `push-observation` worktree but is welded to an out-of-scope **stop-all/frozen** subsystem that main does not have.

**Recommendation: PORT the matrix slice (not merge the branch), STRIP the frozen overlay, and ship in two stages.** Stage A discharges the literal "unreachable" complaint (Settings gates tab + per-pane PUT + the net-new save-preservation). Stage B adds the always-visible `GateChip` + the `/api/terminals` posture payload, which is the part that pulls in the frozen coupling.

This spec is **implementation-ready**: every file/line/symbol below was opened and confirmed against the two trees on 2026-06-02.

---

## 1. Problem & root cause (code-anchored)

### 1.1 The matrix is unreachable on main
Verified absences on `C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner` (current main):

| Artifact | Worktree source | On main? |
|---|---|---|
| `src/gateSurface.ts` (pure surface derivations) | 148 L, confirmed | **MISSING** (`Glob src/gateSurface.ts` → no files) |
| `src/settingsGatesRoundTrip.ts` (save-preservation helpers) | 59 L, confirmed | **MISSING** |
| `src/components/GateChip.tsx` | 147 L, confirmed | **MISSING** |
| `src/components/CapabilityMatrixTab.tsx` | 199 L, confirmed | **MISSING** |
| `SettingsDialog` gates tab + `capabilityGates` state | worktree `SettingsDialog.tsx` | **MISSING** — `grep capabilityGates src/components/SettingsDialog.tsx` on main → **0 matches** |
| `/api/terminals` posture payload (`effective_gates`, `posture`) | worktree `server.ts:752-776` | **MISSING** on main's `/api/terminals` |
| `PUT /api/projects/:projectId/panes/:paneId/capability-gates` | worktree `server.ts:1027-1061` | **MISSING** |

So the operator can edit the data model only by hand-writing JSON — there is no surface. That is the "unreachable" complaint.

### 1.2 The dossier's "main already has the seed" claim is FALSE (verified)
The prior analysis flagged a risk that main's `SettingsDialog` already seeds `capabilityGates`. **It does not.** `grep capabilityGates src/components/SettingsDialog.tsx` on main returns **0 matches**. Therefore **save-preservation is NET-NEW work**, not a no-op. Without it, the very first Settings Save would erase `advanced.capabilityGates`, because:

- `SettingsDialog.getCompiledSettings()` rebuilds `advanced` from a **flat literal** that omits `capabilityGates`.
- `parsePresetsSafe()` rebuilds each preset **field-by-field**, dropping per-preset `capabilityGates`.

### 1.3 The drop-on-save bug ALSO lives on the server (scope correction)
This is the one place the dossier under-scoped. The worktree's `tests/test_settings_gates_roundtrip.ts` does **not** test only frontend helpers — it also imports and asserts `parsePresetsSafe` from **`src/terminal.ts`** (the server persistence choke-point: `PUT /api/settings` → `manager.updateSettings` → `parsePresetsSafe`):

```
src/terminal.ts:13  export function parsePresetsSafe(input: any): CliPreset[] {
src/terminal.ts:15-28   // array branch rebuilds field-by-field, NO capabilityGates  ← BUG
src/terminal.ts:39-52   // object branch rebuilds field-by-field, NO capabilityGates ← BUG
```

Main's `src/terminal.ts:parsePresetsSafe` drops `capabilityGates`. The worktree fixed it by wrapping each rebuilt preset in `preservePresetGates(...)` (see worktree `SettingsDialog.tsx:39,64` for the client mirror; the server file applies the same wrap). **If we port `test_settings_gates_roundtrip.ts`, we MUST also patch `src/terminal.ts:parsePresetsSafe`, or the `serverParsePresetsSafe` assertions (test lines 85-105) fail red on main.** Main `src/terminal.ts:722,749-751` already seeds `DEFAULT_CAPABILITY_GATES` into default settings + merges incoming `advanced.capabilityGates`, so the global-default round-trip is partly handled server-side — the **gap is the preset rebuild only**.

### 1.4 The frozen coupling (the welding the dossier calls out)
The worktree posture helpers depend on a subsystem main does not have. Confirmed in worktree `server.ts`:

- `server.ts:26` imports `applyFrozenShortCircuit`
- `server.ts:404` `function persistFrozen(value)`
- `server.ts:1492` resolver: `return applyFrozenShortCircuit(frozen, resolved);`
- `server.ts:1553-1564` `effectiveGatesForPane(paneId)` derives the base via `deriveEffectiveGates(...)` **then overlays the frozen short-circuit** (`if (!frozen) return base;` → else loops `applyFrozenShortCircuit(true, base[cap])`)
- `server.ts:857-872` the whole `POST/GET /api/stop-all*` family
- `tests/test_pane_gates_rest.ts:135-150` exercises `GET /api/stop-all/status`, `POST /api/stop-all`, `/release`

Main has **none** of these (`grep applyFrozenShortCircuit|persistFrozen|stop-all server.ts` on main → 0 matches; main's `effectiveCapabilityGateFor` at `server.ts:1356-1365` returns `resolveCapabilityGateWithContext(...)` **with no frozen overlay**). Porting the posture helper verbatim would drag in the entire stop-all/frozen subsystem — explicitly out of scope for U2.

---

## 2. Resolved design decisions (recommended option chosen)

### D1 — Port the slice vs. merge `feat/p0b-matrix-live-harness` → **PORT** ✅
The branch carries the unmerged stop-all/frozen subsystem **and** a live-harness, both out of scope for "make the matrix reachable." Merging imports that surface area, its tests, and its risk. **Port the 4 files + the 2 server edits + the SettingsDialog/App wiring**, strip the frozen overlay, and file a follow-up bead for stop-all. Cherry-picking the branch is rejected for the same reason as merge: the commits interleave matrix and stop-all work.

### D2 — Frozen coupling → **STRIP the overlay (return base)**, link a follow-up bead ✅
Port `effectiveGatesForPane` as the **pure base only**:

```ts
function effectiveGatesForPane(paneId: string): Record<CapabilityGate, GateValue> {
  const globalGates = manager.settings.advanced?.capabilityGates;
  const proj = manager.ledger.getActiveProject();
  const paneGates = proj?.panes?.[paneId]?.capabilityGates;
  const isActivePane = activePaneId === paneId;
  return deriveEffectiveGates(paneGates, globalGates, isActivePane); // NO frozen overlay on main
}
```

This is **already in lockstep** with main's `effectiveCapabilityGateFor` (`server.ts:1356-1365`), which has no frozen overlay either. The `gateSurface.deriveEffectiveGates` precedence (override → spotlight → global → Auto) exactly mirrors main's `resolveCapabilityGateWithContext` (`src/pendingApprovals.ts:192-199`) and `SPOTLIGHT_CAPABILITIES` (`src/pendingApprovals.ts:177`). **Do NOT import `applyFrozenShortCircuit` / `ALL_CAPABILITIES`-for-freeze / `persistFrozen`.** File follow-up bead **U2-followup-stopall** ("port two-stage stop-all + re-apply frozen overlay to the posture helper") and reference it in a code comment at the strip site.

### D3 — Save-preservation → **port `src/settingsGatesRoundTrip.ts` + wire it in `SettingsDialog` AND patch server `parsePresetsSafe`** ✅ (NET-NEW)
Port the pure helpers verbatim and wire all three call sites the worktree uses:
- `normalizeGateMap` — seed/normalize on load (worktree `SettingsDialog.tsx:118,207,325`)
- `withAdvancedGates` — re-attach global matrix on compile (worktree `SettingsDialog.tsx:242-256`)
- `preservePresetGates` — carry per-preset gates through `parsePresetsSafe` (worktree `SettingsDialog.tsx:39,64`)

Plus the **server-side** mirror in `src/terminal.ts:parsePresetsSafe` (§1.3) so `PUT /api/settings` doesn't re-drop them. Rejected alternative ("frontend-only") is unsafe: the server persistence path would silently erase per-preset gates on the next settings write.

### D4 — Per-pane PUT persistence → **`manager.ledger.updatePane(projectId, pane, true)`**, NOT bare `save()` ✅
Port worktree `server.ts:1027-1061` verbatim. The critical line is **`server.ts:1046`**: `manager.ledger.updatePane(projectId, pane, true)`. A bare `manager.ledger.save()` is a **SQLite no-op** (the default backend as of WS-M) and would silently drop the override; `updatePane` is the durable create/update path that writes the `capability_gates` column for the SQLite store and the JSON map for legacy. Also port: `recordActivity` audit (`server.ts:1047-1057`), `broadcastLedgerUpdate()`, and — **Stage B only** — `broadcastTerminalsUpdated()`. For **Stage A** (no posture payload yet) replace `broadcastTerminalsUpdated()` with nothing (the matrix tab reads its own optimistic mirror; no chip to repaint yet). **Corrected ref:** the existing per-pane `/permissions` PUT this sits beside is at **`server.ts:917-936`** on main (the dossier's earlier 1000-1019 was stale — confirmed).

### D5 — Staging → **two sub-slices** ✅
- **Stage A (discharges "unreachable"):** `gateSurface.ts` + `settingsGatesRoundTrip.ts` + `CapabilityMatrixTab.tsx` + `SettingsDialog` gates tab & save-preservation + `PUT /capability-gates` + `src/terminal.ts` preset fix + `App.tsx` SettingsDialog props (`activeProjectId`, `activePanes`). No `GateChip`, no `/api/terminals` posture payload, **no frozen coupling touched.**
- **Stage B (adds the chip):** `GateChip.tsx` + `/api/terminals` posture payload (`effective_gates`, `posture`) + `effectiveGatesForPane`/`posturePayloadForPane`/`broadcastTerminalsUpdated` (frozen-stripped) + `App.tsx` GateChip mounts + the `?mock` harness `setPostureMock` seed.

Stage A is independently shippable and green; Stage B is where the posture helper (and thus the frozen-strip decision) lands.

---

## 3. The exact changes (file : location : change)

### Stage A

| File | Location | Change |
|---|---|---|
| `src/gateSurface.ts` | NEW FILE | Port verbatim from worktree (148 L). Pure; imports only `./types`. Exports `deriveEffectiveGates`, `derivePostureWord`, `CAPABILITY_LABELS`, `CAPABILITY_CATEGORIES`, `ALL_CAPABILITIES`, `EffectiveMode`, `PostureWord`. |
| `src/settingsGatesRoundTrip.ts` | NEW FILE | Port verbatim from worktree (59 L). Exports `normalizeGateMap`, `preservePresetGates`, `withAdvancedGates`. |
| `src/components/CapabilityMatrixTab.tsx` | NEW FILE | Port verbatim (199 L). Controlled component; `data-testid` hooks (`capability-matrix-tab`, `matrix-scope-select`, `matrix-row-<cap>`, `matrix-<cap>-<Auto\|Ask\|Off>`, `matrix-<cap>-clear`) must survive. |
| `src/components/SettingsDialog.tsx` | top imports | Add `import { preservePresetGates, withAdvancedGates, normalizeGateMap } from "../settingsGatesRoundTrip";`, `import { CapabilityMatrixTab } from "./CapabilityMatrixTab";`, add `CapabilityGateMap, PaneMeta` to the `../types` import, add `Shield` to the lucide import. |
| `src/components/SettingsDialog.tsx` | `parsePresetsSafe` (both array+object branches) | Wrap each rebuilt preset in `preservePresetGates({...}, item/val)` (mirror worktree `:39,64`). |
| `src/components/SettingsDialog.tsx` | props interface | Add `activeProjectId?: string; activePanes?: Record<string, PaneMeta>;` (worktree `:93-96`) + defaults in the destructure (worktree `:108-109`). |
| `src/components/SettingsDialog.tsx` | state | Add `capabilityGates` state (worktree `:156`), `paneGateOverrides` state + seeding `useEffect` (worktree `:115-120`), and `"gates"` to the `formTab` union (worktree `:112`). |
| `src/components/SettingsDialog.tsx` | load effect | `setCapabilityGates(normalizeGateMap(initialSettings.advanced?.capabilityGates));` (worktree `:207`). |
| `src/components/SettingsDialog.tsx` | `getCompiledSettings` | Wrap the `advanced` literal in `withAdvancedGates({...}, capabilityGates)` (worktree `:242-256`). |
| `src/components/SettingsDialog.tsx` | `handleJsonChange` | `if (parsed.advanced.capabilityGates !== undefined) setCapabilityGates(normalizeGateMap(parsed.advanced.capabilityGates));` (worktree `:325`); add `capabilityGates` to the JSON-preview effect deps (worktree `:272`). |
| `src/components/SettingsDialog.tsx` | sidebar + body | Add the "Capability Matrix" sidebar button (`data-testid="settings-tab-gates"`, `Shield` icon — worktree `:471-478`) and the `{formTab === "gates" && <CapabilityMatrixTab .../>}` body block (worktree `:943-967`), including the per-pane `onSavePaneGates` that PUTs to `/api/projects/${activeProjectId}/panes/${paneId}/capability-gates`. |
| `src/App.tsx` | `<SettingsDialog .../>` mount @ **`App.tsx:2513-2524`** | Add `activeProjectId={activeProjectId}` + `activePanes={activeProject?.panes}` (mirror worktree `:2588-2589`). `activeProjectId` state already exists (main `App.tsx:24`); `activeProject` already exists (main `App.tsx:1624`). |
| `server.ts` | after `/permissions` PUT @ **`server.ts:917-936`** | Add `PUT /api/projects/:projectId/panes/:paneId/capability-gates` (port worktree `:1027-1061`) — normalize to `{Auto\|Ask\|Off}`, `pane.capabilityGates = any ? clean : undefined`, persist via `manager.ledger.updatePane(projectId, pane, true)`, `recordActivity`, `broadcastLedgerUpdate()`, 404 on unknown pane, echo `{ success, capabilityGates }`. **Stage A: omit `broadcastTerminalsUpdated()`** (no posture helper yet). |
| `src/terminal.ts` | `parsePresetsSafe` array branch @ **`src/terminal.ts:15-28`** and object branch @ **`:39-52`** | Wrap each rebuilt preset in `preservePresetGates(<rebuilt literal>, item/val)`. Add `import { preservePresetGates } from "./settingsGatesRoundTrip";`. (Required for the ported `serverParsePresetsSafe` test to pass — §1.3.) |

### Stage B

| File | Location | Change |
|---|---|---|
| `src/components/GateChip.tsx` | NEW FILE | Port verbatim (147 L). `data-testid` hooks (`gate-chip`, `gate-chip-trigger`, `gate-chip-popover`, `gate-chip-focus-star`, `gate-row-<cap>`, `data-posture`) must survive. |
| `server.ts` | imports | Add `import { deriveEffectiveGates, derivePostureWord, type EffectiveMode as GateSurfaceMode } from "./src/gateSurface";` (mirror worktree `:41` **minus** `ALL_CAPABILITIES`, which was only needed for the frozen loop). Ensure `GateValue, CapabilityGate` are imported from `./src/types` (main already imports `CapabilityGate`/`GateValue`). |
| `server.ts` | new helpers near `effectiveModeFor` (main `server.ts:1343`) | Add `effectiveGatesForPane` (**frozen-stripped per D2**), `posturePayloadForPane`, `allPanePostures`, `broadcastTerminalsUpdated` (port worktree `:1553-1577`, dropping the `if (!frozen)` overlay block). |
| `server.ts` | `/api/terminals` map @ **`server.ts:752-776`** (main) | Add `effective_gates` + `posture` to each terminal object via `const posture = posturePayloadForPane(id);` (mirror worktree `:757,771-772`). |
| `server.ts` | the new `/capability-gates` PUT (from Stage A) | Add `broadcastTerminalsUpdated();` after `broadcastLedgerUpdate();` (now safe — the helper exists). |
| `src/App.tsx` | import | `import { GateChip } from "./components/GateChip";` (worktree `:13`). |
| `src/App.tsx` | pane-list row + active-pane header | Mount `<GateChip effectiveGates=... posture=... isActivePane=... [compact]/>` at the two worktree sites (`:3065-3072` compact in the pane list, `:3126-3132` in the active header), guarded by `term?.posture` / `activeTerminal.posture`. |
| `e2e/fixtures.ts` + `?mock` harness in `App.tsx` | `__ORBITAL_E2E__` | Port `setPostureMock` (worktree `fixtures.ts:75-85`) and the harness hook that seeds `mock_pane_1` with `posture`/`effective_gates` so `e2e/gate_chip.spec.ts` is deterministic. (`setFrozenMock` is **out of scope** — drop it.) |

---

## 4. Test-first plan (TDD, aligned to repo runners)

Runners: unit = `npm test` (tsx `--test --test-force-exit`); e2e = `npm run test:e2e` (Playwright, `?mock=1`); python = `py -3 -m unittest tests.test_universal_terminal`; lint = `npm run lint`; build = `npm run build`.

### 4.0 The failing test to write FIRST (watch it go red, then green)
**`tests/test_gate_surface.ts`** — the pure-surface unit suite (port from worktree `tests/test_gate_surface.ts`, 207 L). It has **no server, no frozen, no React** dependency, so it is the cleanest first red. Write it (it imports `../src/gateSurface`, which does not yet exist) and run:

```
npm test
```

Expected first run: **fails to resolve `../src/gateSurface`** (module missing). Then create `src/gateSurface.ts` (port) and re-run → green. This pins the contract the rest of the surface renders from before any UI exists.

**Key assertions to confirm green (from the ported suite):**
- `deriveEffectiveGates(undefined, undefined, false)` → every one of the 16 caps `=== "Auto"` (back-compat).
- Global default applies off-context; **spotlight loosens `write_to_pane`/`deliver_handoff` to `Auto` on the active pane but NOT `close_pane`** (precedence mirror of `resolveCapabilityGateWithContext`).
- Explicit per-pane override beats spotlight **both directions** (`write_to_pane:"Off"` stays Off on active pane; `close_pane:"Auto"` beats global `Off`).
- `derivePostureWord`: `write_to_pane:"Off"` → `LOCKED`; `Read-Only` mode → `LOCKED`; a peripheral `close_pane:"Off"` → `GUARDED` (LOCKED reserved for can't-type); any single `Ask` → `GUARDED`; all-Auto → `OPEN`.
- `CAPABILITY_LABELS` is **total over the union** and contains **no raw `_` identifier**; keys equal the union exactly.
- `CAPABILITY_CATEGORIES` covers all 16 **exactly once**, names have no `_`, and match the spec §6 assignment.

### 4.1 Then the save-preservation unit suite
**`tests/test_settings_gates_roundtrip.ts`** (port from worktree). Imports `../src/settingsGatesRoundTrip` (pure) **and** `parsePresetsSafe as serverParsePresetsSafe` from `../src/terminal`. Write it → red (missing module + server `parsePresetsSafe` drops gates) → port `settingsGatesRoundTrip.ts` + patch `src/terminal.ts` → green.

Key assertions: `normalizeGateMap` keeps only `Auto/Ask/Off` and maps empty/`{}`/junk → `undefined`; `preservePresetGates` carries `capabilityGates` through the field-by-field rebuild and injects nothing when absent; `withAdvancedGates` re-attaches the global matrix and omits the key entirely when absent; **`serverParsePresetsSafe` preserves per-preset gates for BOTH array and object input** (lines 85-105 — this is the assertion that forces the `src/terminal.ts` patch).

### 4.2 Then the per-pane REST suite (TRIMMED — drop stop-all)
**`tests/test_pane_gates_rest.ts`** (port, **but delete the `GET /api/stop-all/status` test at worktree lines 135-150 and the `after()` `release` call at line 73** — that subsystem is out of scope per D2). Boots the real server in-process via the ce7/mockLive harness, seeds a ledger pane via `updatePane`, then asserts:
- `PUT .../capability-gates` writes the override and **round-trips with zero loss** (`body.capabilityGates` deep-equals the input; `ledger pane.capabilityGates` deep-equals it).
- The override **flows into the resolved effective posture** (write `Off` → the resolver reads `write_to_pane:"Off"`).
- An empty `{}` **clears** the override → response `capabilityGates: null`, ledger `undefined` (no masking `{}`).
- Unknown pane → **404**.

### 4.3 e2e (Playwright, `?mock=1`) — Stage A and Stage B
- **`e2e/capability_matrix.spec.ts`** (Stage A): opens Settings → `settings-tab-gates`, asserts plain labels render (no raw `write_to_pane`), the scope selector defaults to `global`, toggling `matrix-write_to_pane-Off/Ask/Auto` flips `aria-pressed`, and **all 16 `matrix-row-<cap>` rows render**.
- **`e2e/gate_chip.spec.ts`** (Stage B): seeds posture via `setPostureMock`, asserts `data-posture` = `GUARDED`/`OPEN`/`LOCKED`, the focus ★ shows when the spotlight loosened a write, and the popover lists all 16 caps in plain language. Requires the `setPostureMock` harness hook (§3 Stage B).

### 4.4 Manual live-verify (the `?mock` harness CANNOT catch the durable PUT)
With a real server (`npm run build` then run, or dev server): open Settings → Capability Matrix → scope = a live pane → set `write_to_pane = Off` → **reload the page** → confirm the override persists (Stage B: the pane's `GateChip` repaints to `LOCKED`). This is the only check that proves the SQLite `updatePane` write is durable; `?mock=1` is client-only.

---

## 5. Verify commands

```bash
npm run lint                      # tsc --noEmit — catches missing imports / type drift on the ported files
npm test                          # unit: test_gate_surface + test_settings_gates_roundtrip + test_pane_gates_rest (trimmed)
npm run test:e2e                  # Playwright: capability_matrix.spec (Stage A), gate_chip.spec (Stage B)
npm run build                     # vite + esbuild → dist/server.cjs (confirms server.ts edits compile)
```

Order for a clean TDD loop: write `tests/test_gate_surface.ts` → `npm test` (red) → port `gateSurface.ts` → `npm test` (green) → repeat per §4.1/§4.2/§4.3. Run `npm run lint` after every server.ts / SettingsDialog edit.

---

## 6. Risks

- **R1 — server `parsePresetsSafe` is a hidden second drop-site (HIGH if missed).** Porting only the frontend helper leaves `PUT /api/settings` erasing per-preset gates and the `serverParsePresetsSafe` test red. Mitigation: §3 Stage A patches `src/terminal.ts:15-28,39-52`.
- **R2 — frozen overlay leaks in via copy-paste (MED).** Porting `effectiveGatesForPane` verbatim re-imports `applyFrozenShortCircuit`/`persistFrozen`/stop-all and won't compile on main. Mitigation: D2 strip; lint + build are the tripwire; the trimmed REST test removes the stop-all dependency.
- **R3 — `/api/terminals` shape change ripples (MED).** Adding `effective_gates`/`posture` to every terminal object touches a hot endpoint consumed across `App.tsx`. The `GateChip` degrades gracefully (`if (!posture || !effectiveGates) return null;` — worktree `GateChip.tsx:82`), so older/mocked payloads render nothing rather than crash. Keep Stage B isolated so Stage A can ship if B regresses.
- **R4 — `EffectiveMode` ↔ `derivePostureWord` mode arg (LOW).** `posturePayloadForPane` passes `effectiveModeFor(paneId)` (main `server.ts:1343-1349`) as `GateSurfaceMode`. Main's `EffectiveMode` is `"Full Auto" | "Human-in-the-Loop" | "Read-Only"` — already aligned with `gateSurface.EffectiveMode`. Confirm the cast compiles under `npm run lint`.
- **R5 — e2e harness drift (LOW, Stage B only).** `gate_chip.spec.ts` needs `setPostureMock` + a harness seed for `mock_pane_1`. If the harness hook isn't ported, the spec hangs on `data-e2e-ready`. Mitigation: port `setPostureMock` and the seed; explicitly skip `setFrozenMock`.
- **R6 — `activePanes` shape.** `SettingsDialog` expects `Record<string, PaneMeta>` keyed by pane; `App.tsx:2589` passes `activeProject?.panes`. Confirm main's `activeProject.panes` is that shape (it is — `App.tsx:947` writes `next[activeProjectId].panes[id]`).

---

## 7. Acceptance criteria

1. The per-pane capability matrix is **reachable from Settings** (the "Capability Matrix" gates tab) — Stage A.
2. A per-pane `GateChip` renders the effective posture and opens the 16-cap plain-language popover — Stage B.
3. A per-pane gate set via the tab **persists across a full page reload** (durable `updatePane`, not a SQLite-no-op `save()`).
4. A Settings **Save does NOT erase** `advanced.capabilityGates` or per-preset `capabilityGates` (global + preset round-trip with zero loss, client AND server path).
5. All ported pins green: `tests/test_gate_surface.ts`, `tests/test_settings_gates_roundtrip.ts`, `tests/test_pane_gates_rest.ts` (trimmed), `e2e/capability_matrix.spec.ts`, `e2e/gate_chip.spec.ts`.
6. `npm run lint` and `npm run build` are green; **no `applyFrozenShortCircuit`/`persistFrozen`/`stop-all` symbol enters main** (frozen subsystem deferred to follow-up bead **U2-followup-stopall**).

---

## 8. Follow-up beads to file

- **U2-followup-stopall** — Port the two-stage emergency STOP-ALL + frozen subsystem and re-apply the frozen overlay to `effectiveGatesForPane`/`effectiveCapabilityGateFor`; restore the `GET /api/stop-all/status` leg of `test_pane_gates_rest.ts` and the `setFrozenMock` harness hook. (Carries the part of `feat/p0b-matrix-live-harness` deliberately left behind here.)
- Relates to `wsm-e2e-pinned-rbh` (WS-G permission-truth) and `wsm-e2e-pinned-n2r` (gate UI polish) per the dossier.
