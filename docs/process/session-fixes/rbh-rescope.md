# rbh re-scope — permission-truth confirmation dialogs vs. current main (#26 + #27)

**Bead:** `wsm-e2e-pinned-rbh` — WS-G rescoped P1: "never confirm a permission change the gate will ignore."
**Re-scope branch:** `feat/session-fixes-rescope` (base = current main `a38a3cc`).
**Original impl:** `feat/session-fixes` commits `cdf5c07` (feature) + `fa504c3` (remediation).

---

## BLUF

**Recommendation: `implement-delta`. rbh is NOT superseded by #26.**

#26 (capability-matrix surface) shipped the per-pane **chip** + matrix tab + the posture payload on
`/api/terminals` and the `terminals_updated` broadcast. It **never touched the two confirmation
DIALOGS** (`ActionConfirmDialog`, `ApprovalDialog`), and it **never enriched** the `action_pending`
/ `approval_pending` frames. On current main both dialogs still render only the nominal `summary` /
`cmd` string — the exact BUG-003 silent-no-op truthfulness hole rbh closes. The whole point of rbh
(effective posture *inside the dialogs*, plus the divergence "heads-up") is genuine, additive value.

The original rbh slice was built on top of U2 (pre-#26 chip work). On current main the chip-side
infrastructure rbh leaned on is **already present and richer** (`posturePayloadForPane`,
`effectiveModeFor`, `effectiveCapabilityGateFor`, `deriveEffectiveGates`, `derivePostureWord`,
`setPostureMock`, the frozen short-circuit). So the re-scope is mostly a **clean re-base** of rbh's
own additions, with **one substantive correction** (frozen-aware posture) and **one dedup decision**
(palette extraction is still needed; the pure resolver should reuse main's frozen-aware path).

---

## What #26/#27 ALREADY put on main (the redundancy ledger)

Anchored by reading the real current-main files in the worktree:

| Concern | On main today | Source | rbh must NOT redo |
|---|---|---|---|
| Per-pane posture chip + popover (16 caps, plain labels) | `src/components/GateChip.tsx` | #26 (8sq) | ✅ leave as-is |
| `POSTURE_STYLE` / `GATE_STYLE` palette | **inside `GateChip.tsx`** (lines 31-43), NOT shared | #26 | rbh MOVES these to `gateSurface.ts` (still needed) |
| `deriveEffectiveGates` / `derivePostureWord` / `CAPABILITY_LABELS` / `ALL_CAPABILITIES` | `src/gateSurface.ts` | #26 | ✅ reuse verbatim |
| Server posture resolvers `effectiveModeFor`, `effectiveCapabilityGateFor`, `effectiveGatesForPane`, `posturePayloadForPane` | `server.ts:1573-1677` | #26 | ✅ reuse — do NOT re-add |
| Posture on `/api/terminals` + `terminals_updated` | `server.ts` `allPanePostures()` / `broadcastTerminalsUpdated()` | #26 | ✅ unrelated to dialogs |
| STOP-ALL / `frozen` + `applyFrozenShortCircuit` | `server.ts:421-430, 1595-1597, 1664-1668` | #26 | ⚠️ **rbh's pure resolver omits this — must fix** |
| `Terminal.effective_gates` / `Terminal.posture` types | `src/types.ts:101-102` | #26 | ✅ reuse the union literals |
| e2e harness `setPostureMock`, `PendingActionEntry`, `injectPendingAction/Approval` | `src/e2e/harness.ts`, `e2e/fixtures.ts` | #26 | rbh EXTENDS the inject signatures (additive) |
| e2e specs `gate_chip.spec.ts`, `capability_matrix.spec.ts`, `action.spec.ts`, `approval.spec.ts` | `e2e/` | #26 | action/approval specs get rbh's posture cases appended |
| #27 notes-recall (`amend_note`, deferred-action voice tools, durable notes) | `tests/test_notes_recall.ts` etc. | #27 | ✅ **zero overlap** — rbh touches neither notes nor those tools |

**Bottom line on redundancy:** the chip + posture resolvers + frozen + harness scaffolding are all on
main already (richer than the U2 base rbh was written against). rbh adds **dialogs + frame
enrichment + the shared palette + the divergence helper**, none of which exist on main.

---

## Genuine delta to apply (the only NEW value)

Five tight pieces. All optional/degrade-safe — no schema bump, no behavior change when posture is absent.

### 1. `src/gateSurface.ts` — extract the shared palette + add the pure divergence helper
- **Move** `POSTURE_STYLE` and `GATE_STYLE` OUT of `GateChip.tsx` and INTO `gateSurface.ts` (exported),
  so the chip AND both dialogs import ONE copy → dialog == chip == engine, zero drift. `GateChip.tsx`
  then imports them from `gateSurface` (pure re-export; chip render unchanged, `gate_chip.spec.ts`
  stays green).
- **Add** `deriveActionDivergence(requestedMode, effectiveMode, effectiveGate, globalOverrides?)` —
  the pure, unit-testable "the operator asked for X, will the engine apply it?" decision.
  - Precedence: `"global"` (global mode dominates) > `"gate"` (bare gate Off) > `"none"`.
  - Ship the **remediated 4-arg signature directly** (concern-3 precision): the `"global"` branch
    requires the explicit `globalOverrides` signal (`globalMode !== "Inherit"`), defaulting to the
    raw mode mismatch for back-compat. This avoids mislabeling a staged-but-not-yet-applied mode
    change (under Inherit) as a global override. Do NOT ship the 3-arg version then re-edit it.
- Add `export type ActionDivergence = "none" | "global" | "gate";`

### 2. `src/actionPendingPayload.ts` — NEW pure module (server-truth seam)
- `resolveActionPendingPosture(input)` → `{ effective_gate, effective_mode, posture?, effective_gates? }`,
  mirroring `effectiveModeFor` / `effectiveCapabilityGateFor` / `posturePayloadForPane` against the
  shared `gateSurface` resolvers. Global actions (`paneId === null`) return mode + gate only (D2).
- **WHY a separate module:** `server.ts` boots a listener at module load, so `gateOrDefer` can't be
  imported by a unit test (same rationale as `src/restGate.ts` for G6). This module is the testable
  seam that proves the engine *derives* the BUG-003 divergence at its source, not from a hand-fed mock.
- **⚠️ FROZEN CORRECTION (see Integration Risks #1):** the original rbh module is a pure mirror with
  **no `frozen` argument**, so a dialog raised while STOP-ALL is engaged would show non-frozen posture
  — directly contradicting rbh's own "dialog == engine" invariant. The re-scope MUST make the server
  call frozen-aware. Two acceptable options (pick **Option A**):
  - **Option A (preferred):** add an optional `frozen?: boolean` to `ActionPostureInput`; inside
    `resolveActionPendingPosture`, after computing `effective_gate` and `effective_gates`, overlay
    `applyFrozenShortCircuit(frozen, …)` over every value (re-derive `posture` from the frozen map).
    Keeps the resolver pure (frozen is just an input) and unit-testable, and keeps it in lockstep with
    main's `effectiveGatesForPane`. server passes the live `frozen`.
  - **Option B:** keep the pure module frozen-agnostic; in `gateOrDefer`, when `frozen` is true,
    overwrite the resolved fields by calling the existing `posturePayloadForPane(paneId)` (already
    frozen-aware) for the per-pane case. Rejected: splits the resolution across two code paths and
    leaves the global-action gate non-frozen.

### 3. `server.ts` — enrich `gateOrDefer` (`action_pending`) + the `approval_pending` frame
- `gateOrDefer`: add a `requestedMode?: string` trailing param. On the `Ask` branch, call
  `resolveActionPendingPosture({ paneId, capability, globalMode, paneMode, paneGates, globalGates,
  isActivePane, frozen })` and spread the result onto the `broadcast({ type: "action_pending", … })`
  along with `pane_id`, `requested_mode` (only when present), and
  `global_override: manager.globalPermissionsMode !== "Inherit"`.
- The two permission tool handlers (`set_global_permissions` ~`server.ts:2441`,
  `set_pane_permissions` ~`server.ts:2966`) pass `permissions_mode` as the new `requestedMode` arg —
  **structurally, never parsed from the summary** (R5). `create_pane` and other callers pass nothing
  → no mode rider (correct).
- `approval_pending` frame (~`server.ts:2146`): the target pane's `effectiveMode` + `capability` are
  already in scope. Call `posturePayloadForPane(targetId)` (frozen-aware on main — good) and add
  `effective_gates`, `posture`, `effective_mode`, `capability` to the `clientWs.send({ type:
  "approval_pending", … })`.

### 4. `src/types.ts` — carry posture on the two view types
- `PendingCommand`: add optional `effective_gates?: CapabilityGateMap`, `posture?`, `effective_mode?`,
  `capability?: CapabilityGate`.
- NEW `PendingActionView` interface: `actionId/capability/summary` + optional `effective_gate`,
  `effective_mode`, `posture`, `effective_gates`, `pane_id`, `requested_mode`, `global_override`.
  (`CapabilityGate` / `GateValue` / `CapabilityGateMap` already exported from this file — no new imports.)

### 5. `src/App.tsx` + the two dialog components — render the riders
- `App.tsx`: switch the `pendingActions` state from the inline shape to `PendingActionView`; thread the
  new fields through the `approval_pending` and `action_pending` handlers (~lines 1224, 1237) and pass
  them as props at the two dialog render sites (~lines 2680, 2691).
- `ActionConfirmDialog.tsx`: import `POSTURE_STYLE/GATE_STYLE/CAPABILITY_LABELS/deriveActionDivergence`
  from `gateSurface`; render `data-testid="action-effective"` (scope label `action-scope` + posture +
  gate) and `data-testid="action-divergence"` (the "heads up" when `deriveActionDivergence !== "none"`,
  using `globalOverride`). Ship the remediated version with `paneId`→scope-label and the `globalOverride`
  prop consumed. Degrade-safe: no posture → today's dialog.
- `ApprovalDialog.tsx`: render `data-testid="approval-effective"` ("Approving into:" posture + write
  gate + `approval-mode` from `effectiveMode`). Degrade-safe.

### Tests (TDD, fail-first each)
- `tests/test_dialog_posture.ts` (NEW): palette totality (`POSTURE_STYLE`/`GATE_STYLE` exported from
  gateSurface, total over their unions, canonical plain words) + the full `deriveActionDivergence`
  truth table **including the concern-3 precision + back-compat rows**. Fails first because the symbols
  don't exist in gateSurface yet.
- `tests/test_action_pending_payload.ts` (NEW): `resolveActionPendingPosture` derives the BUG-003 case
  (global Read-Only + pane Full Auto ⇒ posture LOCKED / effective_mode Read-Only), the gate-veto case,
  the global-action (`pane_id` null) D2 case, **and a NEW frozen case** (frozen ⇒ every gate Off ⇒
  LOCKED) to lock the Integration-Risk-#1 fix. Fails first because the module doesn't exist.
- e2e `action.spec.ts` / `approval.spec.ts`: append posture-seed cases (divergence rider fires for
  LOCKED/Read-Only; clean case shows none; degrade-safe; concern-3 precision). Extend the harness
  inject signatures additively (`src/e2e/harness.ts`, `e2e/fixtures.ts`).

---

## Integration risks (how this could regress #26 / #27)

1. **[HIGH — must fix] Frozen posture divergence (regresses the #26 STOP-ALL invariant).**
   #26's `posturePayloadForPane`/`effectiveGatesForPane` apply `applyFrozenShortCircuit`; the original
   rbh `resolveActionPendingPosture` does **not** (it predates STOP-ALL landing on main). If left
   as-is, an `action_pending` dialog raised while frozen shows the *pre-freeze* posture/gate — the chip
   would say LOCKED while the dialog says OPEN, breaking the very "dialog == chip == engine" promise
   rbh exists to deliver. **Fix:** Option A in delta #2 (frozen as a resolver input). Pin with a frozen
   unit case in `test_action_pending_payload.ts`. The `approval_pending` path already routes through
   main's frozen-aware `posturePayloadForPane`, so it's safe — only the action path needs the fix.

2. **[MED] Palette move must be a pure re-export (regresses #26 `gate_chip.spec.ts`).**
   Moving `POSTURE_STYLE`/`GATE_STYLE` out of `GateChip.tsx` must preserve the exact class strings and
   keys. Any drift repaints the chip and breaks `gate_chip.spec.ts` (5 assertions on chip color/word).
   **Mitigation:** copy the maps verbatim; have `GateChip` import them; run `gate_chip.spec.ts` +
   `capability_matrix.spec.ts` green before commit.

3. **[MED] `action_pending` / `approval_pending` are wire contracts touched by #26's broadcast plumbing
   and #27's deferred-action voice tools.** #27's `amend_note` and deferred voice tools share the
   `action_pending` → `PendingActionStore` → `action_resolved` lifecycle. All rbh additions are
   **optional fields** on the frame; the action-resolved/confirm/cancel REST + voice paths are
   untouched, and the `PendingAction` *store* shape is unchanged (posture is computed at broadcast time,
   not persisted). **Mitigation:** keep `tests/test_notes_recall.ts` green; do not alter
   `pendingActions.add()` payload keys or `buildActionRun`.

4. **[MED] `gateOrDefer` signature change ripples to every caller.** Adding `requestedMode` as a
   trailing optional param after `kzt`'s `params?` arg means non-permission callers (`create_pane`,
   `apply_recipe`, the WS-F restore loop at ~`server.ts:2020`) keep working unchanged (they omit it).
   **Mitigation:** keep it strictly optional and last; `tsc --noEmit` catches any positional mismatch.
   Note the `action_pending` re-broadcast on the WS-F restore path (~`server.ts:2020`) currently emits
   the **bare** frame — acceptable (degrade-safe), but note it as a known gap: a restored deferred
   action shows no posture rider until resolved. Out of rbh scope; do not expand here.

5. **[LOW] `global_override` precision must not over-fire.** Threading `globalMode !== "Inherit"` as
   `global_override` is the concern-3 fix; the dialog's `deriveActionDivergence` 4-arg form gates the
   "global" rider on it. Risk is a *false* "global mode is X" rider on an ordinary staged change under
   Inherit. **Mitigation:** the concern-3 precision + back-compat unit rows in `test_dialog_posture.ts`
   pin exactly this; include them.

6. **[LOW] Harness/fixtures signature extension.** Extending `injectPendingAction/Approval` with an
   optional `posture` arg must stay backward-compatible so existing #26 specs that call them 2-arg keep
   passing. **Mitigation:** trailing optional param; run the full Playwright suite.

---

## Explicitly OUT of scope (fence held — RECONCILIATION §6)

rbh is **UI-confirmation-truth only**. The three engine residuals stay carved out and are already
tracked as separate beads (do NOT pull them in here):
- `restart_pane` voice tool — Full-Auto must reach the LIVE process + drain pending (BUG-015) →
  **`wsm-e2e-pinned-1y8`**.
- `syncLedger` persist-wins — a sync must not revert operator permission intent (N-4) →
  **`wsm-e2e-pinned-gpd`**.
- No spoken rider, no stop-all/frozen *engine* changes (only the frozen-*read* fix in delta #2),
  no per-path policy / per-command risk badges / RBAC.

---

## Green-bar definition (do not regress; baseline 538 pass)

```
cd "C:/Users/gerso/PycharmProjects/OrbitalVoiceRunner-wt/session-fixes"
npm run lint                 # tsc --noEmit, exit 0
npm test                     # 538 baseline + new (test_dialog_posture, test_action_pending_payload); 0 fail
npx playwright test e2e/action.spec.ts e2e/approval.spec.ts e2e/gate_chip.spec.ts e2e/capability_matrix.spec.ts
py -3 -m unittest tests.test_universal_terminal
```
`tests/test_notes_recall.ts` (#27) and `gate_chip`/`capability_matrix` e2e (#26) MUST stay green.
