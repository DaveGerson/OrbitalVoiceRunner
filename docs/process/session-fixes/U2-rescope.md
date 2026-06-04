# U2 re-scope vs current main — `wsm-e2e-pinned-cbo`

> **Bead:** `wsm-e2e-pinned-cbo` · **Priority:** P1 · **Type:** feature (UI) · **Kind:** ui
> **Re-scope base (current main):** `a38a3cc` — already contains the 9 landed session-fixes **+ PR#26 (8sq+ce7) capability-matrix surface** (commit `208dc3b`) **+ PR#27 notes-recall**.
> **Original impl:** branch `feat/session-fixes` (READ-ONLY — never checked out).
> **Supersedes the pre-#26 spec** `docs/process/session-fixes/U2-plan.md` (whose entire "MISSING on main" premise is now false — see §4).

---

## BLUF

**RECOMMENDATION: `superseded-close`.** PR#26 (commit `208dc3b`, "feat(8sq+ce7): capability-matrix surface + mock Live test harness") already landed the **identical** 8sq surface that bead `cbo` was scoped to deliver — same files, same durable PUT, same Save-preservation, same e2e pins (byte-identical specs). Every acceptance criterion on the bead is satisfied on main today. There is **no genuine delta attributable to U2/cbo**. Do **not** invent work; close `cbo` as superseded by #26.

The only net-new code in the `main..feat/session-fixes` diff for the matrix files is **not U2's** — it is the palette-extraction + `deriveActionDivergence` work authored under bead **rbh** (`wsm-e2e-pinned-rbh`) and the crash-safety normalizers + `gate_chip_crashsafe.spec.ts` authored under bead **n2r** (`wsm-e2e-pinned-n2r`). Both are separate OPEN beads with their own plans (`rbh-plan.md`, `n2r-plan.md`). Folding that code in under the `cbo` label would mis-attribute and double-count two other tracks.

---

## 1. What the bead asked for vs. what main already has

The bead's acceptance criteria, each checked against current main (`a38a3cc`):

| Acceptance criterion (bead `cbo`) | On current main? | Evidence (current-main file:line) |
|---|---|---|
| `src/gateSurface.ts` pure surface (`deriveEffectiveGates`, labels, categories) | **YES** | `git cat-file -e main:src/gateSurface.ts` → exists; core derivations byte-identical to U2 branch (diff shows only rbh/n2r *additions*, no edits to the U2 core) |
| `src/components/GateChip.tsx` (per-pane chip) | **YES** | `main:src/components/GateChip.tsx` exists; `POSTURE_STYLE`/`GATE_STYLE` inlined at lines 32/39 |
| `src/components/CapabilityMatrixTab.tsx` (16-cap editor) | **YES** | `main:src/components/CapabilityMatrixTab.tsx` exists; `gatesForScope` for global/preset/pane |
| Matrix reachable from **Settings** | **YES** | `main:src/components/SettingsDialog.tsx:945-960` wires `CapabilityMatrixTab` with `globalGates` / `paneGatesFor` / `onSavePaneGates` |
| Per-pane gate **persists across reload** (durable write) | **YES** | `main:server.ts:1116` — PUT uses `manager.ledger.updatePane(projectId, pane, true)` (the durable both-backends path; explicit comment that a bare `save()` is a SQLite no-op), + `recordActivity` + `broadcastLedgerUpdate` + `broadcastTerminalsUpdated` |
| **Save does not erase** `advanced.capabilityGates` | **YES** | `main:src/components/SettingsDialog.tsx:3` imports `preservePresetGates, withAdvancedGates, normalizeGateMap` from `src/settingsGatesRoundTrip.ts`; save path uses `withAdvancedGates(... , capabilityGates)` at line 242; per-preset preserved at lines 52/77 |
| Posture payload on `/api/terminals` | **YES** | `main:server.ts:777-794` (`posturePayloadForPane` → `effective_gates` + `posture`) |
| `terminals_updated` broadcast carries postures | **YES** | `main:server.ts:1670-1681` (`allPanePostures` / `broadcastTerminalsUpdated`) |
| Ported e2e pins green | **YES** | `main:e2e/capability_matrix.spec.ts` and `main:e2e/gate_chip.spec.ts` are **byte-identical** to the U2 branch versions (`diff` → IDENTICAL); `main:tests/test_pane_gates_rest.ts` present; `main:e2e/stop_all.spec.ts` present |

**Every single acceptance line is already true on main.** The matrix is reachable, the per-pane chip exists, the per-pane PUT persists durably, Save preserves gates, the pins are green.

---

## 2. The candidate "genuine deltas" from the dossier — all already on main

The context note flagged three things U2 *might* have over #26. **All three are already present on main**, so none is a delta:

- **(a) Frozen-overlay STRIPPED (U2 decision D2)** — **NOT a delta; and the premise is inverted.**
  U2's plan said "strip the frozen overlay because stop-all is out of scope." But main *landed* the stop-all/frozen subsystem (`main:server.ts:26` imports `applyFrozenShortCircuit`; the `frozen` KV + `/api/stop-all/*` endpoints live at `server.ts:421-895`). Main's `effectiveGatesForPane` (`server.ts:1658-1666`) **deliberately keeps** the frozen overlay so the surface stays in lockstep with the resolver. So U2's "strip it" decision is **moot and would be a regression** if applied — frozen IS in scope on main. Nothing to do.

- **(b) Net-new SettingsDialog Save-preservation for `capability_gates`** — **NOT a delta; already on main, and better-factored.**
  The pre-#26 U2 plan asserted "main has 0 matches for `capabilityGates` in SettingsDialog → save-preservation is NET-NEW." That is now **false**: #26 added it. Main not only has the preservation, it extracted the helpers into a dedicated module `src/settingsGatesRoundTrip.ts` (`preservePresetGates` / `withAdvancedGates` / `normalizeGateMap`) — a cleaner factoring than U2's inline version. U2 carries no improvement over this.

- **(c) Per-pane PUT persisting via `ledger.updatePane(...,true)` durable-write** — **NOT a delta; already on main.**
  Main's PUT at `server.ts:1116` already calls `manager.ledger.updatePane(projectId, pane, true)` with the exact durable-path rationale in the comment. Identical to U2's intent. Nothing to add.

---

## 3. What IS net-new in the diff — and why it is NOT U2

`git diff main..feat/session-fixes -- src/gateSurface.ts src/components/CapabilityMatrixTab.tsx e2e/gate_chip_crashsafe.spec.ts` shows real additions, but they are explicitly authored under **other beads**:

| Net-new symbol / file (in the diff) | Authored under bead | Belongs to plan |
|---|---|---|
| `POSTURE_STYLE` / `GATE_STYLE` **moved** from `GateChip.tsx` into `gateSurface.ts` (one shared palette) | **rbh** (D4: "dialog == chip == voice, one copy") | `rbh-plan.md` |
| `deriveActionDivergence` + `ActionDivergence` type | **rbh** (confirm-dialog divergence as a pure fn) | `rbh-plan.md` |
| `normalizePostureWord` / `normalizeGateValue` / `normalizeEffectiveGates` / `sanitizePartialGateMap` (crash-safe normalizers) | **n2r** (gate-UI crash-safety) | `n2r-plan.md` |
| `CapabilityMatrixTab.gatesForScope` wrapping branches in `sanitizePartialGateMap` | **n2r** (D7) | `n2r-plan.md` |
| `e2e/gate_chip_crashsafe.spec.ts` | **n2r** | `n2r-plan.md` |

The diff also shows `posturePayloadForPane` "moving" lines and the `action_pending` payload gaining `effective_gate`/`effective_mode`/`posture` — again **rbh** (enrich confirm-dialog payload with effective posture). The `src/components/SettingsDialog.tsx` diff is a **single trailing-whitespace change** — proof the U2 branch made no functional SettingsDialog change over main.

**Net of all this: zero lines in the diff are attributable to the `cbo`/U2 matrix-surface scope.** They all carry rbh/n2r provenance and have their own OPEN beads + plans.

---

## 4. Why the existing `U2-plan.md` is obsolete

`docs/process/session-fixes/U2-plan.md` (and the `cbo` bead description) were written **before** PR#26 merged. Their core table (U2-plan §1.1, lines 25-34) lists `gateSurface.ts`, `settingsGatesRoundTrip.ts`, `GateChip.tsx`, `CapabilityMatrixTab.tsx`, the SettingsDialog gates tab, the `/api/terminals` posture payload, and the PUT as **"MISSING on main."** §1.2 explicitly claims "`grep capabilityGates src/components/SettingsDialog.tsx` on main → 0 matches → save-preservation is NET-NEW."

All of those are now present on main via #26 (verified §1–§2 above). The plan's premise is fully inverted; it should not be executed. This re-scope doc supersedes it.

---

## 5. Recommendation & disposition

- **Disposition: `superseded-close`.** Close `wsm-e2e-pinned-cbo` with a reason pointing at PR#26 / commit `208dc3b` (8sq surface) as the superseding work. Do **not** open or do any matrix-surface implementation under `cbo`.
- **Do NOT fold the diff's net-new code in under U2.** The palette-extraction + `deriveActionDivergence` + normalizers + `gate_chip_crashsafe.spec.ts` are **rbh** and **n2r** deliverables. Route them through `rbh-plan.md` / `n2r-plan.md` when those beads are worked — keep the provenance clean so we don't double-count or regress #26.
- **No source edits, no failing test, no commit** for U2 itself (pure docs outcome). The only artifact is this doc.

---

## 6. Integration risks (how a mistaken "port" of U2 could regress #26 / #27)

If someone ignored this finding and re-ported the U2 slice wholesale onto current main, the concrete regressions are:

1. **Frozen-overlay regression (#26 / stop-all).** U2's decision D2 *strips* the frozen overlay from `effectiveGatesForPane`. Main intentionally keeps it (`server.ts:1658-1666`) because the stop-all/frozen subsystem IS live on main. Re-applying D2 would make `effective_gates`/`posture` **diverge from the resolver while frozen** — chips would show OPEN/Allowed for a pane that the gate resolver is actually short-circuiting to Off. Silent safety-surface lie. Direct regression of #26 posture-truth and the `e2e/stop_all.spec.ts` pin.

2. **Duplicate-symbol / palette divergence (#26 GateChip).** Main inlines `POSTURE_STYLE`/`GATE_STYLE` in `GateChip.tsx`. The U2 diff *also* defines them (exported from `gateSurface.ts`, the rbh refactor). A naive port would create **two copies** — a TS redeclaration error if both land, or worse, two drifting palettes (chip vs dialog), which is exactly the divergence rbh's D4 exists to kill.

3. **SettingsDialog save-preservation collision (#26).** Main's preservation lives in the extracted `settingsGatesRoundTrip.ts` (`withAdvancedGates`/`preservePresetGates`). U2 inlined an older variant. Porting U2's SettingsDialog over main's would either reintroduce the inline version (drift from the shared module) or, if merged carelessly, drop main's `preservePresetGates` per-preset carry → **re-open the drop-on-save data-loss bug** #26 fixed. The `tests/test_pane_gates_rest.ts` + settings-roundtrip pins would be the tripwire.

4. **`test_pane_gates_rest.ts` shape mismatch.** The bead's old note said to *trim* the stop-all leg from this test "since stop-all is out of scope." On main stop-all IS in scope, so main's `test_pane_gates_rest.ts` is the canonical shape — trimming it (per the stale plan) would delete a legitimate assertion and could mask a real PUT/posture regression. Leave main's version untouched.

5. **rbh/n2r double-landing (#26 surface + future beads).** Pulling the rbh `deriveActionDivergence` + `action_pending` enrichment in under the U2 label now means when bead `rbh` is later worked, its plan re-adds the same symbols → merge conflicts / duplicate exports on the shared `gateSurface.ts` that #26 owns. Same for n2r's normalizers + `gate_chip_crashsafe.spec.ts`. Keeping U2 closed-as-superseded avoids touching the #26-owned surface twice.

6. **#27 notes-recall blast radius.** The U2 branch diff also rewrites large swaths of `server.ts` (782 changed lines) tied to the unmerged stop-all + push-observation harness. Several of those touch the same `server.ts` action/permission choke-point that #27's deferred-action voice tools (`amend_note`) route through. A wholesale U2 port risks clobbering #27's `action_pending`/notes wiring and the `tests/test_notes_recall.ts` pin (the U2 branch even *deletes* `tests/test_notes_recall.ts`, 290 lines — a direct #27 regression). This is the strongest reason to keep U2 scoped to **nothing** here.

---

## 7. Verification trail (commands run against current main `a38a3cc`)

- `git cat-file -e main:src/gateSurface.ts | GateChip.tsx | CapabilityMatrixTab.tsx` → all **exist** on main; `main:src/paneGates.ts` → absent (paneGates is a U2-branch-only helper, not required).
- `git grep -n "capability-gates" main -- server.ts` → PUT present at `server.ts:1097`; durable `updatePane(...,true)` at `server.ts:1116`.
- `git grep -nE "posture|effective_gates" main -- server.ts` → posture payload at `server.ts:777-794`; `posturePayloadForPane`/`allPanePostures`/`broadcastTerminalsUpdated` at `server.ts:1670-1681`; frozen overlay at `server.ts:1658-1666`.
- `git show main:src/components/SettingsDialog.tsx | grep withAdvancedGates|preservePresetGates|normalizeGateMap|paneGateOverrides|onSavePaneGates` → save-preservation + matrix wiring present (lines 3, 52, 77, 115, 156, 207, 242, 945-960).
- `diff main:e2e/gate_chip.spec.ts feat/session-fixes:e2e/gate_chip.spec.ts` → **IDENTICAL**; same for `e2e/capability_matrix.spec.ts` → **IDENTICAL**.
- `git grep -nE "POSTURE_STYLE|deriveActionDivergence|normalizePostureWord|sanitizePartialGateMap" main -- src/gateSurface.ts` → **no matches** (confirms the diff's net-new is rbh/n2r, not yet on main, not U2's).
- `git log --oneline main -- src/gateSurface.ts` → top commit `208dc3b feat(8sq+ce7): capability-matrix surface + mock Live test harness (#26)`.
