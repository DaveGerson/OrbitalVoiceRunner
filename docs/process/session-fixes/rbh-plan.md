# rbh — Permission truth: confirmations + chips must reflect EFFECTIVE posture

Bead: `wsm-e2e-pinned-rbh` (WS-G rescoped, P1) · Branch: `feat/session-fixes` (builds on the 9 WF-2 fixes; U2 matrix surface already on-branch) · Kind: **UI** (spec design REQUIRED before code)

---

## BLUF

The per-pane **chips** already render EFFECTIVE posture from server truth (U2 landed `posturePayloadForPane` → `effective_gates`+`posture` on every terminal). The **truthfulness hole that remains is the confirmation DIALOGS**: `ActionConfirmDialog` and `ApprovalDialog` ask the operator to confirm a permission/write change while showing only a *nominal* summary string — they never surface the EFFECTIVE gate the engine will actually apply. So Janus can pop "Confirm: Set pane p1 permissions to Full Auto" when global mode (`effectiveModeFor`) or a tighter capability gate (`effectiveCapabilityGateFor`) will silently downgrade or veto it. This is the BUG-003 betrayal, now matrix-aware.

**This bead (rbh) is scoped to the UI truth layer only**: thread the server-resolved EFFECTIVE posture into the two confirmation dialogs and render a "what will actually happen" rider, in lockstep with the chip's posture word and gate language. We do NOT touch the spoken-rider / `restart_pane` voice-tool / `syncLedger` residuals (those are the engine-side residuals 1–3 in the bead body; tracked separately) and we do NOT pull in the stop-all / frozen subsystem (deferred bead `ms7`).

---

## 1. Problem & root cause (code-anchored, CURRENT branch)

### 1.1 What already tells the truth (chips — U2, on-branch)

- `server.ts:1454-1465` — `effectiveGatesForPane()` + `posturePayloadForPane()` resolve the 16 effective gate values (`deriveEffectiveGates`, override→spotlight→global) and the posture word (`derivePostureWord`) per pane.
- `server.ts:711-726` — `/api/terminals` attaches `effective_gates` + `posture` to each terminal; `broadcastTerminalsUpdated()` (`server.ts:1471-1473`) repaints on every pane mutation.
- `src/components/GateChip.tsx:67-143` — renders STRICTLY from those server fields; never re-derives policy. Gate language is fixed: **Auto = green / "Allowed", Ask = amber / "Asks first", Off = red / "Blocked"** (`GATE_STYLE`, `GateChip.tsx:39-43`); posture words OPEN/GUARDED/LOCKED.
- `src/App.tsx:3014-3080` — chips mount on both the pane list and the active pane from `term.effective_gates` / `term.posture`.

**Chips are EFFECTIVE-correct.** The bead's "gate chip / matrix cell render the effective resolved value" criterion is already satisfied on-branch; rbh keeps it green (a regression guard) and extends the SAME truth to the dialogs.

### 1.2 The hole — confirmation dialogs render NOMINAL, not EFFECTIVE

**`ActionConfirmDialog`** (`src/components/ActionConfirmDialog.tsx:9-77`) — the Ask-tier confirm for non-PTY mutators (`create_pane`, `set_pane_permissions`, `set_global_permissions`). It shows:
- `capability` (raw snake_case, `:44`) and a free-text `summary` (`:47`), e.g. *"Set pane p1 permissions to Full Auto"*.
- A static line: *"This action is gated Ask…"* (`:51-53`).

It has **no knowledge of the effective posture** the action would resolve to. If the operator confirms `set_pane_permissions → Full Auto` while `globalPermissionsMode !== "Inherit"` (`effectiveModeFor`, `server.ts:1420-1426`) or a tighter `write_to_pane` gate exists, the pane's EFFECTIVE posture is unchanged/overridden — the dialog confirmed a no-op. The data the dialog renders comes from the `action_pending` broadcast (`server.ts:1519` → `App.tsx:1133-1140`), which carries only `{ actionId, capability, summary }`.

**`ApprovalDialog`** (`src/components/ApprovalDialog.tsx:3-88`) — the HiTL approve/reject for a staged PTY write. It shows `cmd`, `terminalId`, and a `rationale` (heard trigger + pane summary). It does **not** show the target pane's effective posture, so an operator approving a write into a pane has no in-dialog signal of whether that pane is OPEN/GUARDED/LOCKED or which gate (`write_to_pane` / `deliver_handoff`) is in force. The payload (`server.ts:1884` → `App.tsx:1121-1132`) carries `{ messageId, cmd, terminalId, rationale }` — no posture.

### 1.3 Root cause (one sentence)

The confirmation dialogs were built (G1) as nominal "confirm this string" surfaces **before** U2 introduced server-resolved effective posture; the posture truth exists on the server (`posturePayloadForPane`) and on the chips, but was never threaded into the two dialog payloads, so the confirmation surface and the chip surface disagree about what the engine will do.

---

## 2. Design decisions (resolved — chosen option in **bold**)

**D1 — Where is posture resolved? → SERVER, reuse `posturePayloadForPane`.**
Options: (a) re-derive posture client-side in the dialog from `terminals[]`; (b) **server attaches effective posture to the dialog payload.**
Chosen **(b)**. The CLAUDE-MD invariant for U2 is "render from SERVER truth, never client policy re-derivation" (`GateChip.tsx:8-13`). The dialog must show the SAME number the engine will enforce; the only authority is the server resolver. Re-deriving in the client would re-introduce the lockstep-drift risk the U2 spec explicitly warns against (`gateSurface.ts:13-16`). The server already has `posturePayloadForPane(paneId)` — reuse it verbatim.

**D2 — What posture does a GLOBAL action show? → the synthetic "what global resolves to" view, not a pane.**
`set_global_permissions` has `pane_id = null`. We surface the **resolved global mode + the global effective gate for the capability being changed** (via `effectiveModeFor` with the *would-be* global mode and `effectiveCapabilityGateFor(null, capability)`), framed as "applies to all panes that inherit". No per-pane chip; a single global posture line. (Avoids implying a pane scope that doesn't exist.)

**D3 — What does the rider SAY when nominal ≠ effective? → a one-line "EFFECTIVE" rider with the resolved value + the override reason.**
The dialog keeps its nominal summary (operator's intent) AND adds a second line:
- **No divergence:** *"Effective: Full Auto · Janus can act here freely."* (calm confirmation; matches chip OPEN/GUARDED/LOCKED).
- **Overridden by global mode:** *"Heads up — global mode is Read-Only, so this pane stays LOCKED until you change the global mode."*
- **Tightened/vetoed by a gate:** *"Heads up — the '{plain label}' gate is Off, so this stays Blocked even after you confirm."*
The rider reuses `CAPABILITY_LABELS` (plain language, no jargon — `gateSurface.ts:116-133`) and the posture/gate palette, so dialog == chip == voice.

**D4 — Reuse the chip's posture computation, not a parallel one.** The dialog renders a compact `<GateChip>`-style posture badge (the existing posture word + dot) plus the single effective-gate row for the capability in question, NOT the full 16-row popover. We reuse `gateSurface` (`derivePostureWord` semantics already encoded server-side) and the `GATE_STYLE`/`POSTURE_STYLE` maps. One palette, zero divergence.

**D5 — Degrade gracefully.** Older payloads / `?mock=1` harness frames that omit posture render the dialog exactly as today (no rider, no badge) — mirrors `GateChip.tsx:82` (`if (!posture || !effectiveGates) return null`). No hard dependency; the rider is additive.

**D6 — Scope fence.** rbh does NOT add the SPOKEN rider, `restart_pane` voice tool, or `syncLedger` persist-wins (bead residuals 1–3, engine-side) and does NOT port stop-all/frozen (bead `ms7`). It is purely: server payload enrichment + two dialog components + their tests.

---

## 3. Exact changes (file : location : change)

### 3.1 Server — enrich the two dialog payloads with effective posture

**A. `server.ts:1872-1887` (`pending_approval` case in `dispatchProposal`)** — the `approval_pending` frame.
- After computing `rationale`, compute `const postureForDialog = posturePayloadForPane(targetId);` (already in scope; `posturePayloadForPane` defined at `server.ts:1461`).
- Add to the `clientWs.send({ type: "approval_pending", … })` object (`server.ts:1884`):
  ```ts
  effective_gates: postureForDialog.effective_gates,
  posture: postureForDialog.posture,
  effective_mode: effectiveModeFor(targetId),
  capability,            // "write_to_pane" | "deliver_handoff" — already in scope (opts.capability)
  ```
  (`effectiveMode` and `capability` are already local in this case — `server.ts:1839,1841,1877`.)

**B. `server.ts:1503-1524` (`gateOrDefer`)** — the `action_pending` frame, the source for `ActionConfirmDialog`.
- `gateOrDefer` already has `capability` and `paneId`. In the Ask branch (`server.ts:1515-1520`), before `broadcast({ type: "action_pending", … })`, compute the effective posture for the dialog:
  ```ts
  // Effective-posture truth for the confirm dialog (rbh): what the engine WILL apply,
  // not the nominal summary string. paneId may be null for global actions (D2).
  const effGate = effectiveCapabilityGateFor(paneId, capability);
  const effMode = paneId ? effectiveModeFor(paneId) : (manager.globalPermissionsMode as EffectiveMode);
  const posture = paneId ? posturePayloadForPane(paneId).posture : undefined;
  const effectiveGates = paneId ? posturePayloadForPane(paneId).effective_gates : undefined;
  ```
- Extend the broadcast (`server.ts:1519`):
  ```ts
  broadcast({ type: "action_pending", actionId, capability, summary,
              effective_gate: effGate, effective_mode: effMode, posture, effective_gates: effectiveGates,
              pane_id: paneId ?? null });
  ```
- **Lockstep note in code comment:** the proposed-mode rider (D3) — i.e. "you asked for X but global mode is Y" — needs the *target permissions_mode* the operator asked for. For `set_pane_permissions` / `set_global_permissions` the summary already encodes the requested mode; pass it through structurally so the dialog need not parse the string. Add an OPTIONAL `requestedMode?: string` to `gateOrDefer`'s signature (default `undefined`) and have the two permission handlers pass `permissions_mode` (`server.ts:2334`, `server.ts:2808`) into the `gateOrDefer` call (`server.ts:2344`, `server.ts:2834`). Forward it on the broadcast as `requested_mode`. Non-permission capabilities (create_pane) pass nothing → no mode rider, only the gate/posture rider.

> **Why both A and B:** `ApprovalDialog` (PTY write) and `ActionConfirmDialog` (config mutate) are distinct payloads/handlers; the bead's invariant ("chips == voice == engine", "never confirm a posture the engine ignores") must hold for BOTH confirmation surfaces.

### 3.2 Types — extend the dialog payload shapes

**`src/types.ts:105-113` (`PendingCommand`)** — add optional posture fields (degrade-safe):
```ts
effective_gates?: CapabilityGateMap;
posture?: "OPEN" | "GUARDED" | "LOCKED";
effective_mode?: "Full Auto" | "Human-in-the-Loop" | "Read-Only";
capability?: CapabilityGate;   // the write capability gating this approval
```
Add a new exported shape for pending actions (currently inlined at `App.tsx:30`):
```ts
export interface PendingActionView {
  actionId: string;
  capability: string;
  summary: string;
  effective_gate?: GateValue;
  effective_mode?: "Full Auto" | "Human-in-the-Loop" | "Read-Only";
  posture?: "OPEN" | "GUARDED" | "LOCKED";
  effective_gates?: CapabilityGateMap;
  pane_id?: string | null;
  requested_mode?: string;
}
```

### 3.3 App — thread payload → dialog props

- **`src/App.tsx:30`** — retype `pendingActions` state to `PendingActionView[]`.
- **`src/App.tsx:1133-1140`** (`action_pending` handler) — carry the new fields into the state record.
- **`src/App.tsx:1121-1132`** (`approval_pending` handler) — carry `effective_gates`/`posture`/`effective_mode`/`capability` into the `PendingCommand` record.
- **`src/App.tsx:2567-2588`** — pass the new props to `<ApprovalDialog … />` and `<ActionConfirmDialog … />`.

### 3.4 Dialog components — render the EFFECTIVE rider (the deliverable)

**`src/components/ActionConfirmDialog.tsx`** — add props `effectiveGate?`, `effectiveMode?`, `posture?`, `requestedMode?`, `paneId?`. Below the existing `<p data-testid="action-summary">` (`:47-49`), insert an **effective-posture rider** block (`data-testid="action-effective"`):
- A posture badge (word + dot) reusing the `POSTURE_STYLE`/`GATE_STYLE` palette extracted from `GateChip.tsx:32-43` (see D4 — extract these two maps into `gateSurface.ts` so both the chip and the dialog import ONE copy; the chip currently owns them locally).
- One line: the effective gate for `capability` (Allowed / Asks first / Blocked) via `CAPABILITY_LABELS[capability]`.
- A **divergence rider** (`data-testid="action-divergence"`), rendered ONLY when `requestedMode` is present AND the effective resolution would not match it:
  - global override: *"Global mode is {effectiveMode} — this pane will stay {posture} until the global mode changes."*
  - gate veto: when `effectiveGate === "Off"`: *"The '{label}' gate is Off — this stays Blocked even after you confirm."*
- Keep degrade-safe: if `posture`/`effectiveGate` are undefined, render exactly today's dialog.

**`src/components/ApprovalDialog.tsx`** — add props `effectiveGates?`, `posture?`, `effectiveMode?`, `capability?`. Below the `cmd` block (`:47-49`), insert a compact effective-posture rider (`data-testid="approval-effective"`): the posture badge for `terminalId` + the effective gate row for `capability` (the write gate in force). This answers "into what posture am I approving this write?" Degrade-safe per D5.

**`src/gateSurface.ts`** — export `POSTURE_STYLE` and `GATE_STYLE` (move them here from `GateChip.tsx:32-43`; re-import in `GateChip`). Single palette source so the dialog rider and the chip can never drift (extends the lockstep guarantee in the file header `:13-16`). NOTE: these maps currently carry Tailwind class strings — they stay frontend-safe (no React/PTY/fs), consistent with `gateSurface`'s import constraint.

### 3.5 e2e harness — seed posture into the injected dialogs

- **`src/e2e/harness.ts:194-210`** (`injectPendingApproval` / `injectPendingAction`) — extend both injectors to accept optional posture args and stamp them onto the injected record, so the dialog rider can be exercised under `?mock=1`. Mirror the existing `setPostureMock` pattern (`harness.ts:248-250`).
- **`e2e/fixtures.ts:48-60`** — extend the `injectPendingApproval` / `injectPendingAction` helper signatures + the `__ORBITAL_E2E__` global decl (`fixtures.ts:15-16`) to forward the posture args.

---

## 4. Test-first plan (TDD — failing test FIRST, then implement)

Runners: `npm test` (unit, `tsx --test --test-force-exit`), `npx playwright test e2e/<spec>` (Playwright `?mock=1`), `npm run lint` (`tsc --noEmit`). Branch baseline **478 pass / 0 fail** — must not regress.

### 4.1 Unit — posture palette is shared + total (new `tests/test_dialog_posture.ts`)

After moving `POSTURE_STYLE`/`GATE_STYLE` into `gateSurface`, assert:
- `GATE_STYLE` is TOTAL over `GateValue` (`Auto|Ask|Off`) and uses the canonical word map (`Allowed|Asks first|Blocked`).
- `POSTURE_STYLE` is TOTAL over `PostureWord` (`OPEN|GUARDED|LOCKED`).
- **Why it fails first:** the symbols don't exist in `gateSurface` yet → import throws / `tsc` red. Confirms the move actually happened (a test that passed before the move would be worthless).

### 4.2 Unit — server payload carries effective posture (extend `tests/test_pending_actions.ts` + `tests/test_approvals*.ts`)

These suites already exercise `gateOrDefer` / the pending-approval path. Add assertions:
- `gateOrDefer("set_pane_permissions", paneId, …)` on the **Ask** tier emits an `action_pending` broadcast whose payload includes `effective_gate`, `effective_mode`, `posture`, and (when a permission action) `requested_mode`.
- **Divergence case:** with global mode `Read-Only` + a pane asked to `Full Auto`, assert the payload's `posture === "LOCKED"` and `effective_mode === "Read-Only"` (the engine's truth) — proving the dialog will get the overridden value, NOT the nominal "Full Auto".
- **Clean case:** global `Inherit` + no tighter gate → payload posture matches the requested mode's posture; no divergence.
- **Why it fails first:** the broadcast currently omits these fields (`server.ts:1519`).

### 4.3 e2e — ActionConfirmDialog shows the EFFECTIVE rider (`e2e/action.spec.ts`, new cases)

Building on the existing spec (`e2e/action.spec.ts:7-35`):
- **Divergence rider fires:** `injectPendingAction("set_pane_permissions", "Set pane p1 permissions to Full Auto", { posture:"LOCKED", effectiveMode:"Read-Only", effectiveGate:"Off", requestedMode:"Full Auto" })` → `action-effective` visible, `action-divergence` visible, contains "stays" + "LOCKED" (plain language; NO raw `set_pane_permissions` / `write_to_pane`).
- **Clean (no divergence):** posture `OPEN`, effectiveGate `Auto`, requestedMode matches → `action-effective` visible, `action-divergence` has count 0.
- **Degrade:** inject with NO posture args → `action-effective` count 0 (today's dialog).
- **Why it fails first:** `action-effective` / `action-divergence` testids don't exist yet.

### 4.4 e2e — ApprovalDialog shows target posture (`e2e/approval.spec.ts`, new case)

- `injectPendingApproval("rm -rf build", "mock_pane_1", { posture:"GUARDED", effectiveGates: {…write_to_pane:"Ask"}, capability:"write_to_pane" })` → `approval-effective` visible, shows GUARDED badge + "Asks first" for the write gate. Plain-language only.
- Degrade: no posture args → `approval-effective` count 0.

### 4.5 Regression guard — chips stay effective (`e2e/gate_chip.spec.ts` unchanged must stay green)

`npx playwright test e2e/gate_chip.spec.ts` must remain 5/5 green (proves the chip truth — the bead's already-satisfied criterion — didn't regress while we extracted the palette into `gateSurface`).

### 4.6 Full gates before commit

`npm run lint` (exit 0) → `npm test` (≥478 pass, 0 fail) → `npx playwright test e2e/action.spec.ts e2e/approval.spec.ts e2e/gate_chip.spec.ts`. Python suite untouched (no Python changed) but run once for safety: `py -3 -m unittest tests.test_universal_terminal`.

---

## 5. Risks

- **R1 — Palette extraction breaks the chip.** Moving `POSTURE_STYLE`/`GATE_STYLE` out of `GateChip.tsx` could regress chip rendering. *Mitigation:* §4.5 pins the chip e2e green; the move is a pure re-export, classes unchanged.
- **R2 — Lockstep drift (dialog vs chip vs engine).** A second copy of posture logic re-opens the divergence the U2 spec warns against. *Mitigation:* D1/D4 — dialogs render server-supplied posture only; zero client re-derivation; one palette source.
- **R3 — Global-action posture ambiguity (D2).** A global change has no pane to chip. *Mitigation:* render a single global posture line (resolved global mode + global gate), explicitly framed "applies to inheriting panes"; no per-pane badge.
- **R4 — Payload bloat / older clients.** Extra fields on two broadcasts. *Mitigation:* all optional, degrade-safe (D5); no schema bump, no migration.
- **R5 — `requestedMode` string coupling.** Parsing the requested mode out of the summary string would be brittle. *Mitigation:* D3/§3.1 pass `requested_mode` structurally from the handler, never parse the summary.
- **R6 — Scope creep into engine residuals / stop-all.** The bead body lists spoken-rider, `restart_pane`, `syncLedger`; `ms7` lists frozen overlay. *Mitigation:* D6 fence — rbh is UI-confirmation-truth ONLY; engine residuals + frozen stay out, no `applyFrozenShortCircuit`, no new voice tools.

---

## 6. Acceptance criteria (rbh subset of the bead, UI-truth scope)

1. **Confirmation dialogs render EFFECTIVE posture.** `ActionConfirmDialog` shows the server-resolved posture word + the effective gate (plain language) for the capability; `ApprovalDialog` shows the target pane's posture + write-gate. Both render from SERVER truth, never client re-derivation.
2. **Divergence rider fires when nominal ≠ effective.** Operator asks `set_pane_permissions → Full Auto` while global mode is `Read-Only` (or a gate is Off) ⇒ the dialog shows a "heads up, this stays {posture}" rider with the overriding reason. Clean (no override) ⇒ no rider; calm "Effective: …" confirmation only.
3. **Chip ↔ dialog ↔ engine agree.** The posture word in the dialog equals the chip's posture for the same pane equals `posturePayloadForPane(paneId).posture`. Single palette (`gateSurface`), one resolver (server).
4. **No jargon.** Every operator-facing dialog string uses `CAPABILITY_LABELS` / posture words; no raw snake_case identifier surfaces (asserted in e2e).
5. **Degrade-safe.** Payloads without posture render exactly today's dialogs.
6. **Gates green.** `tsc --noEmit` clean; `npm test` ≥478 pass / 0 fail; the new unit + e2e cases pass; `e2e/gate_chip.spec.ts` stays green.
7. **Scope honored.** No spoken rider, no `restart_pane` voice tool, no `syncLedger` change, no stop-all/frozen port (those remain in the bead's engine residuals / `ms7`).

---

## 7. Out of scope (explicit — tracked elsewhere)

- **Engine residual 1** (spoken + text rider on `set_pane_permissions` / `set_global_permissions` *responses* to the model), **residual 2** (`restart_pane` voice tool → live process), **residual 3** (`syncLedger` persist-wins, `terminal.ts:907`) — bead body WHAT items 1–3, engine-side, separate change.
- **Stop-all / frozen overlay** (`applyFrozenShortCircuit`, `EmergencyStop.tsx`, `/api/stop-all*`) — bead `ms7`, do NOT pull in.
- No per-path policy, per-command risk badges, or RBAC (RECONCILIATION §6, single-director).
