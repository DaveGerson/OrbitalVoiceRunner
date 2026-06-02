# P0b Keystone 2 — Capability Matrix Surface (`8sq`)

- **Bead:** `wsm-e2e-pinned-8sq` — "Matrix surface (gate chips + settings UI + stop-all + voice tools)" (Locked roadmap §4 P0b)
- **Date:** 2026-06-01
- **Status:** Design — APPROVED in brainstorm (visual companion); proceeding to TDD workflow
- **Depends on (all ✓):** `nzt` (SQLite ledger), `odb` (deferred staging), `alf` (handoff flip)
- **Blocks:** `rbh` (permission truth), `n2r` (eyes-off polish), `bjm` (notes recall)

---

## 1. BLUF

The capability-gate **model** is fully built (16 capabilities × {Auto/Ask/Off}, resolved per-pane override → spotlight → global default; see `src/types.ts`, `src/pendingApprovals.ts`, `server.ts` gate handlers). `8sq` is the **surface**: make that safety dial *visible, editable, and stoppable*. Four sub-surfaces + the minimal backend support they need.

**Governing principle (operator directive): NO PRODUCT JARGON.** Every operator-facing string is plain human language — "Type a command into a pane", never `write_to_pane`. This applies to chips, the editor, popovers, and voice read-backs.

## 2. The four surfaces (locked design)

### A. Per-pane gate chip — *effective* posture
- Each pane card shows ONE chip = the pane's **effective resolved posture** (after per-pane override **and** the spotlight **and** effectiveMode — i.e. "what would actually happen if Janus acted here now"). This deliberately absorbs the *chip half* of bead `rbh`; rbh retains confirmation-text truth + `restart_pane` + persist-wins.
- Form (chosen over worst-wins pill / category heatmap): **one calm posture word + colored dot**, with a focus ★ when the spotlight is loosening it:
  - 🟢 **OPEN** — every relevant capability resolves Auto; Janus acts freely.
  - 🟡 **GUARDED** — not LOCKED, but ≥1 capability resolves Ask **or** a non-write capability is Off (some friction here).
  - 🔴 **LOCKED** — the pane cannot be acted on at all: `write_to_pane` resolves Off **or** effectiveMode is Read-Only (Janus literally can't type here).
- **Detail on demand:** click/hover opens a popover listing all 16 capabilities (plain labels) with each one's effective value + a one-word reason when the spotlight/mode changed it (e.g. "Auto — via focus").
- Colors are the single gate language reused everywhere: Auto = green, Ask = amber, Off = red.

### B. Capability-Matrix editor — new Settings tab
- A new **"Capability Matrix"** sub-tab in the existing `SettingsDialog` form (alongside Voice / CLI profiles / Advanced / Secrets).
- **Layout (chosen): grouped toggles** — sections by intent, one row per plain-labeled action with a 3-way segmented switch [Auto | Ask | Off]. Scrollable, calm.
- **Scope selector** at the top picks WHICH matrix is being edited — **all three** scopes:
  - **Global default** → `settings.advanced.capabilityGates`
  - **A specific pane** → `PaneMeta.capabilityGates` (per-pane override)
  - **A preset** → `CliPreset.capabilityGates` (seed applied to new panes from that preset)
- 🔥 **Landmine fix (in-scope):** `SettingsDialog.getCompiledSettings()` + `parsePresetsSafe()` currently **drop `capabilityGates` on save** (they rebuild `advanced`/presets without it). The editor MUST round-trip gates through form state → save → reload without loss. This is a real data-loss bug the matrix tab necessarily closes.
- Categories + plain labels: see §6.

### C. Global STOP-ALL — two-stage brake
- A STOP-ALL control in the global top bar. **Two stages**, because the freeze is reversible but the process-kill is not:
  - **Stage 1 — instant, reversible (one tap / "stop everything"):** set a global **`frozen`** flag and (a) **freeze Janus** — the gate resolver short-circuits EVERY capability to Off while frozen (the underlying matrix is *never mutated*, so Release is a clean clear, no snapshot/restore); (b) **cancel everything in-flight** — reject all pending approvals, expire all deferred actions, halt running plans + watch-rules. **Panes and their PTYs keep running.** A FROZEN banner appears with a **Release** action.
  - **Stage 2 — deliberate, irreversible:** the banner then asks *"Also kill the N running panes? Can't be undone."* and that button is **hold-to-fire** (~1s filling ring; cancel by releasing). On completion, terminate all running pane PTYs.
- **Release** clears the `frozen` flag (restores the prior matrix exactly, since it was never mutated). It does **not** auto-restart killed panes — those keep their normal per-pane restart affordance (deliberate kill stays killed).
- **Persistence:** the `frozen` flag is **persisted** (a ledger/kv flag) so a process restart stays frozen — you froze for a reason; safety should survive a reboot. Release is the only thing that clears it.
- **Voice mirror:** "stop everything" performs Stage 1 instantly, then Janus asks *"I've frozen myself and cancelled N in-flight items. Also kill the 3 running panes? That can't be undone — say 'kill them' to confirm."* The verbal confirm is Stage 2 (voice has no hold). "Release"/"resume" clears the freeze.

### D. Voice tools — the matrix by voice
Wire/confirm the voice surface (plain-language read-backs throughout):
- **Set a gate** — `set_capability_gate` (exists) — read back in plain language ("Okay, I'll *ask* before typing into pane-1").
- **Query posture** — `get_pane_gates` (exists) — read back the posture word + notable gates, not raw identifiers.
- **Stop-all (Stage 1)** — NEW `stop_all` voice tool → freeze + cancel-in-flight + the spoken kill-confirm prompt.
- **Confirm kill (Stage 2)** — NEW `confirm_stop_all` (verbal "kill them") → terminate PTYs. Only valid while frozen-and-awaiting-confirm.
- **Release** — NEW `release_stop_all` ("release"/"resume") → clear the freeze.

## 3. Backend support (minimal, behind the surfaces)

- **Effective-posture resolver exposed to the client.** A pure function computes, per pane, the 16 effective gate values + the derived posture word (reusing `resolveCapabilityGateWithContext`). The server includes this in the pane state it already broadcasts (extend the `terminals_updated` / ledger-pane payload), so chips and the popover render from server truth (no client re-derivation of policy).
- **`frozen` flag + resolver short-circuit.** A persisted global `frozen` flag; `decideProposal` / the capability-gate resolution path returns Off (capability_forbidden) for every capability while frozen. Single choke-point — do not scatter the check. Legacy path unaffected when not frozen.
- **Stop-all orchestration.** A `stopAll(kill: boolean)` server routine: Stage 1 sets `frozen` + rejects pending approvals (`applyResolution(…, "expire")` per item), expires deferred actions, halts plans/watch-rules, broadcasts a `frozen` WS event. Stage 2 (`kill`) terminates each running terminal PTY via the existing `term.stop()`. `releaseStopAll()` clears the flag + broadcasts.
- **Settings `capabilityGates` round-trip.** Fix `getCompiledSettings()` + `parsePresetsSafe()` (+ JSON tab) to carry `advanced.capabilityGates` and per-preset `capabilityGates` through save/load.

## 4. Components / units (isolation & testability)

- `src/gateSurface.ts` (NEW, pure, frontend-safe): `deriveEffectiveGates(pane, global, isActivePane)` → `Record<CapabilityGate, GateValue>`; `derivePostureWord(effective, effectiveMode)` → `"OPEN"|"GUARDED"|"LOCKED"`; `CAPABILITY_LABELS` + `CAPABILITY_CATEGORIES` (the plain-label map, §6). Pure ⇒ unit-tested without React/PTY/server.
- `src/components/GateChip.tsx` (NEW): posture word + dot + focus ★ + popover. Renders from server-provided effective gates.
- `src/components/CapabilityMatrixTab.tsx` (NEW): the grouped-toggle editor + scope selector; consumes/produces `CapabilityGateMap`.
- `server.ts`: the resolver-exposure, `frozen` short-circuit, `stopAll`/`releaseStopAll`, the three new voice tools, and the settings round-trip fix.
- `src/components/SettingsDialog.tsx`: mount the new tab; fix the capabilityGates round-trip.
- Top-bar STOP-ALL control (in `App.tsx`): the two-stage button + FROZEN banner.

## 5. Data flow

1. Server resolves effective gates per pane (pure fn) → includes them + posture word in the pane-state broadcast.
2. Client renders `GateChip` from that payload; popover shows the 16; no policy logic on the client.
3. Editing in `CapabilityMatrixTab` → `PUT /api/settings` (global/preset) or the per-pane gate path (`set_capability_gate` REST/WS) → server persists → re-broadcast → chips update.
4. STOP-ALL click → Stage 1 endpoint → `frozen` broadcast → banner; hold-to-fire → Stage 2 (kill) endpoint. Voice routes through the new tools to the SAME server routines.

## 6. Plain-language label map (no jargon)

| Capability | Plain label | Category |
|---|---|---|
| `write_to_pane` | Type a command into a pane | Acting in a pane |
| `deliver_handoff` | Hand a prompt to another pane | Acting in a pane |
| `close_pane` | Close a pane | Destructive |
| `restart_pane` | Restart a pane | Destructive |
| `set_pane_permissions` | Change a pane's autonomy mode | Changing the locks |
| `set_global_permissions` | Change the global autonomy mode | Changing the locks |
| `set_capability_gate` | Change these safety gates | Changing the locks |
| `create_pane` | Open a new pane | Spawning work |
| `execute_plan` | Run a multi-step plan | Spawning work |
| `apply_recipe` | Apply a workspace recipe | Spawning work |
| `add_watch_rule` | Add an automation rule | Spawning work |
| `create_project` | Create a project | Orientation (low-risk) |
| `update_metadata` | Update notes & metadata | Orientation (low-risk) |
| `switch_context` | Switch focus | Orientation (low-risk) |
| `set_voice_mute` | Mute or unmute voice | Orientation (low-risk) |
| `dismiss_attention` | Dismiss an alert | Orientation (low-risk) |

A unit test asserts this map is **total** over the `CapabilityGate` union (no capability ever renders as a raw identifier).

## 7. Posture-word derivation (pure, unit-pinned)

```
derivePostureWord(effective, effectiveMode):
  if effectiveMode === "Read-Only" OR effective.write_to_pane === "Off"  -> "LOCKED"
  else if any capability === "Ask" OR any capability === "Off"            -> "GUARDED"
  else                                                                    -> "OPEN"
```
LOCKED is reserved for "Janus can't type here at all" so it stays meaningful; a peripheral Off (e.g. close_pane) reads GUARDED, with the popover showing specifics. The focus ★ is shown when `isActivePane` and the spotlight loosened ≥1 capability.

## 8. Testing strategy (TDD)

**Unit (`tsx --test --test-force-exit`):**
- `derivePostureWord` full table: OPEN/GUARDED/LOCKED incl. boundaries (write Off → LOCKED; peripheral Off → GUARDED; Read-Only → LOCKED; all Auto → OPEN).
- `deriveEffectiveGates` honors override → spotlight → global precedence (mirror existing resolver tests).
- `CAPABILITY_LABELS` totality over the union; `CAPABILITY_CATEGORIES` covers all 16 exactly once.
- `frozen` short-circuit: every capability resolves Off while frozen; clears cleanly on release (matrix unchanged).
- `stopAll` Stage 1 rejects pending approvals + expires deferred actions + halts plans (no PTY kill); Stage 2 kills PTYs; release restores.
- Settings round-trip: `getCompiledSettings()` + `parsePresetsSafe()` preserve `capabilityGates` (global + per-preset) — regression pin for the drop-on-save bug.

**Component / e2e (Playwright, `?mock=1`):**
- Chip renders the right posture word per pane, incl. the spotlight ★ on the focused pane; popover lists 16 plain labels.
- Matrix tab: edit a gate → save → reload → value persists (round-trip), across all three scopes.
- STOP-ALL two-stage: tap → FROZEN banner + chips all read LOCKED + in-flight cleared; hold-to-fire → panes terminated; Release → un-frozen, chips restore.

**Battery before done:** `npm run lint` · `npm test` · `npm run build` · `py -3 -m unittest tests.test_universal_terminal` · `npm run test:e2e`.

## 9. Out of scope / accepted

- **rbh remainder:** confirmation/read-back *text* reflecting effective posture, the `restart_pane` tool, and syncLedger persist-wins stay in `rbh`. We take only the chip's effective-posture rendering here.
- **Per-preset gate runtime application** already exists (seed on spawn); we only add its *editing* surface.
- Auto-restart of killed panes is intentionally NOT done (deliberate kill stays killed).
- Undo for a gate edit beyond normal save — out (YAGNI).

## 10. Success criteria

1. Every pane card shows a plain posture word reflecting **effective** posture (incl. spotlight ★); popover lists all 16 in plain language.
2. The Capability-Matrix tab edits Global + per-pane + per-preset gates and **round-trips through save with zero loss** (drop-on-save bug closed).
3. STOP-ALL Stage 1 freezes Janus + cancels in-flight instantly and reversibly; Stage 2 hold-to-fire kills PTYs; Release restores. Frozen survives a restart.
4. Voice can set/query gates, stop-all (with spoken kill-confirm), and release — all in plain language.
5. No operator-facing string shows a raw capability identifier.
6. Full battery green; e2e pins the chip, the matrix round-trip, and the two-stage stop-all.
