# Architectural Design and Key Components for Voice-Driven Journeys

This document outlines the technical design, underlying code patterns, and active software components that support each of the primary and secondary user journeys of the voice-driven Janus terminal orchestrator (**OrbitalVoiceRunner**).

---

## 1. Modality Architecture & System Overview

Janus operates under a **hands-free, voice-mediated, and eyes-off execution model**.

```
                           [Operator Audio (Streamed 16kHz PCM)]
                                            │
                                            ▼
                               [Half-Duplex Barge-In Gate]
                                            │
                                            ▼
                           [Gemini Live API WebSocket Conduit]
                                 /                     \
                   [Spoken TTS Response]         [Function Call Request]
                             ▲                              │
                             │                              ▼
                  [Synthesized PCM Output]        [Orchestrator Tool Executor]
                                                            │
                                        ┌───────────────────┴───────────────────┐
                                        ▼                                       ▼
                             [PTY Terminal Manager]                  [Project Ledger File]
```

*   **Audio Input Channel:** The browser grabs 16kHz PCM audio frames using the device microphone. Prior to transmission, if Janus is actively speaking, a half-duplex barge-in gate in `App.tsx` suspends frame delivery to prevent audio loopbacks/echo.
*   **Audio and Tool Output Conduit:** The Node.js server acts as an authenticated proxy websocket channel communicating directly with the Gemini Live API. Prompt/responses travel as dual-medium frames (synthesized voice output + structured JSON tool calls).
*   **System State Persistence:** State lives in a **SQLite ledger** — `JanusStore` (`src/store/`), backed by `.janus.db` (override via `JANUS_DB`) — holding user configurations, workspaces, pane hierarchies, active settings, watch automation rules, and notes. Since **dbt3** (2026-07-02) SQLite is the *only* backend: `src/ledger.ts` now defines just the `LedgerLike` surface that `JanusStore` implements and `OrchestratorManager` consumes, the `JANUS_LEDGER_BACKEND=legacy` escape hatch is retired, and a store-init failure is a **fatal boot error** with no fallback. The one-way JSON→SQLite boot migration still runs for operators upgrading from pre-WS-M on-disk data.
*   **Conversational Coherence Substrate:** every journey below rides on a shared turn-taking and truthfulness layer — see [§4](#4-cross-cutting-layer-conversational-coherence-j0).

---

## 2. Core Components Supporting Primary Journeys

### Journey 1: Fan-out / Delegate in Parallel
*Start multiple agent panes on independent tasks, switching attention dynamically.*

*   **Workspace Ledger Partitioning (the `LedgerLike` surface in `/src/ledger.ts`, implemented by `JanusStore`):** Workspaces are segmented via distinct project configurations containing directories, notes, and specific terminal panes.
*   **Virtual Dynamic PTY Panes (`OrchestratorManager` inside `/src/terminal.ts`):** Supports launching and executing multiple non-blocking sub-processes using instances of `UniversalTerminal`. PTY processes run concurrently to complete tasks independently (e.g., launching an API compiler and testing script in separate panes).
*   **Context Switching Mechanism (`switch_context` in `/src/actions/defs/orient.ts`):**
    Janus triggers the `switch_context` function. This backgrounds the current workspace, loads the target project's path as the system CWD, and dynamically generates a rich **Project Briefing** incorporating the project summary, files, historical project notes, and absolute states of related active panes.

---

### Journey 2: Supervisor / "Air-Traffic Control" (ATC)
*Keep agents in Human-in-the-Loop; approve or redirect commands as they surface.*

*   **Graduated Safety Gating Model (`propose_command`, registered in `/src/actions/registry.ts`, enforced at the capability gate in `/src/gating/index.ts`):**
    Each project pane has an assigned `permissionsMode` attribute defined in `/src/types.ts`:
    *   `Full Auto`: Commands run immediately inside the active terminal process.
    *   `Human-in-the-Loop`: Commands are intercepted, a unique `call.id` is allocated, and the execution is paused pending operator sign-off.
    *   `Read-Only`: Writing commands is strictly prevented; a clear write block exception is returned.
*   **State-Preserved Pending Map (`pendingApprovals` in `/src/pendingApprovals.ts`, consumed by `/server.ts`):**
    Holds intercepted commands along with their session context, target destination pane, and triggering human rationale.

---

### Journey 3: Review & Approve Code Across Panes
*Move between panes and approve/reject commands by voice or visual dialog.*

*   **Intent Parsing (`parseApprovalIntent` in `/src/approvalIntent.ts`):**
    A transcribed operator utterance is classified into one of four actionable intents — **approve**, **reject**, **defer** ("later", "not now", "hold that"), or **clarify** — rather than substring-matched against a flat keyword list. (Ambient speech returns `none` and resolves nothing; `ApprovalIntent` is the five-valued union in `src/approvalIntent.ts`.) Negation and approve/reject collisions resolve to `clarify` instead of silently firing: the operator is asked *"I heard both approve and reject — which of the N did you mean?"*
*   **Target Selection (`selectApprovalTarget` / `selectPendingAction`, same module):**
    Resolution is **targeted, not blind-FIFO**. When more than one item is staged and nothing disambiguates, `narrateAmbiguous` reads back the redacted summaries and asks which one — it does not silently resolve the oldest entry.
*   **Resolution Routing (`/src/voiceApprovalRouting.ts`):**
    `handleApprove` (`confirm()` → run side effect → broadcast `action_resolved`), `handleReject` (`cancel()` claims and removes without running), and `handleDefer` (re-arms the TTL window in place, capped at `MAX_DEFERRALS` so an item cannot be parked forever).
*   **Lifecycle & Gate Enforcement (`/src/gating/index.ts`):**
    The staged-item clock — **TTL → last-call → grace → expire** — plus the stop-all brake, running through the capability-gate choke point.
*   **The Approval Dialog Component (`/src/components/ApprovalDialog.tsx`):**
    A polished, animated modal overlays on top of the screen when a command is queued, presenting the exact proposed command string, its target pane, and AI rationale.

---

### Journey 4: Knowledge Capture & Continuity
*Log decisions, rationale, and notes securely; re-brief Janus when returning to workspaces.*

*   **Durable Note Capture (`add_project_note` / `add_pane_note` in `/src/actions/defs/notes.ts`):**
    Captures unstructured spoken notes or Walkthrough narrations and appends them to the persistent configuration ledger.
*   **History Simplification Engine (`get_pane_command_history` in `/src/actions/defs/reads.ts`):**
    Instead of passing large, messy and token-expensive stdout streams to the LLM context, it maintains a concise history log containing the precise command executed and its condensed high-level outcome.
*   **Dynamic System Prompt Reconstruction:**
    Each time Janus resumes a workspace session, the system instruction is reconstructed with only the active project ID and the available workspaces (ID/name pairs). Live pane status/CWD is deliberately *not* injected — it would go stale — and is read on demand via `list_panes` (see `src/voice/systemPrompt.ts` §5). Project notes and file trees are likewise not injected; notes re-enter context via the `switch_context` briefing — see `docs/review/BUG_LOG.md` BUG-033.

---

### Journey 5: Adjust Autonomy Mid-Session
*Verbally promote or demote pane safety permissions dynamically on-the-fly.*

*   **Autonomy Transition Hook (`set_pane_permissions` in `/src/actions/defs/locks.ts`):**
    Modifies the active permissions mode of an ongoing terminal pane instance.
*   **State Alignment Logging (`LedgerLike.updatePane`, implemented by `JanusStore.updatePane`):**
    Once an autonomy update is triggered via voice, the permissions value is saved directly to the database file. If the process is rebooted or cloned, it preserves the defined autonomy scope.

---

### Journey 6: On-Demand Status Check
*Ask "what's busy or done?" across all panes for spoken system reports.*

*   **State Synchronization Loop (`syncLedger` in `/src/terminal.ts`):**
    Aggregates active values from live operating processes. Map parameters include:
    *   `is_busy`: Set to `true` if the shell process is executing a command.
    *   `alive`: Set to `false` if the background terminal process has exited.
*   **Orientation Index (`list_panes`, registered in `/src/actions/registry.ts`):**
    Retrieves all organized workspaces and active terminal pane entities, enabling Janus to provide spoken summaries to the operator.

---

## 3. Secondary Journeys Supporting Elements

The two secondary journeys are numbered **J7** and **J8** — the same identifiers used by
`tests/test_journeys.ts` and `docs/README.md`. Counting both tiers, the product has **eight**
journeys total (J1–J6 primary, J7–J8 secondary).

| # | Secondary Journey | Core API Tool Hooks | Action Profile |
| :--- | :--- | :--- | :--- |
| **J7** | **Dictate Specifications** | `add_project_note` & `add_pane_note` | Speech-to-text notes are written directly to ledger. |
| **J8** | **Narrate Terminal Walk-through** | `get_pane_summary` | Recent terminal output (ANSI-stripped, secret-redacted via WS-B's `redactSecrets`) is read back; the operator dictates notes for needed changes. *(No semantic analysis yet — see `docs/review/IMPLEMENTATION_PLAN.md` WS-J.)* |

---

## 4. Cross-Cutting Layer: Conversational Coherence (J0)

Journeys 1–8 describe *what the operator is trying to do*. All of them ride on one shared
substrate: **the assistant's turn-taking and its truthfulness about state.** This layer is not a
journey — it is the floor every journey stands on, and it owns a defect class none of J1–J8 can
express.

**The defect class: utterance ⇄ state divergence.** A spoken line is composed and queued when a
staged item is in one state; the state then changes before the line is delivered. The ledger is
correct, the speech is not. Mental model: the arbiter is an **outbox of pre-written letters** — when
the situation changes you must reach into the outbox and pull the letter, not merely update your own
records.

**Components:**

*   **Turn Arbiter (`/src/voice/turnArbiter.ts`):** the single conversation scheduler owning *all*
    model-bound sends — priority classes plus one coalesced drain — so two subsystems cannot talk
    over each other. `factsForDrain` re-derives an item's facts at drain time rather than trusting
    the text composed at queue time.
*   **Staged-item clock (`/src/gating/index.ts`):** TTL → last-call → grace → expire, plus the
    defer re-arm — `applyDeferral` here for approvals, `handleDefer` in
    `/src/voiceApprovalRouting.ts` for staged actions, both capped by `MAX_DEFERRALS` — and the
    stop-all brake.
*   **Speech admission (`/src/voice/speakGate.ts`, `correctionLedger.ts`, `recentTurns.ts`):** the
    silence gate, bounded live-claim set, and correction/retraction bookkeeping.

**The invariant (learned the hard way — `p19o`, `okes`, then the `3tx3`/`y9tj` sweep):**

> Any code path that **re-arms, cancels, or resolves** a staged item MUST also **retract or re-word
> the already-queued arbiter utterance** for it. Updating the record alone leaves a letter in the
> outbox describing a world that no longer exists.

Three seams implement it, and which one you want depends on whether the queued fact became **false**
or merely **finished**:

| Seam | Use when | Sites |
|---|---|---|
| `turnArbiter.remove('last-call:<id>')` | the queued fact is now **false** — the item resolved, or its TTL was reset | `removeStaleLastCallOnTtlReset` (approval defer + reattach), `onResolved`, and `handleDefer`'s `onDeferred` sink for the staged-**action** leg (`3tx3`) |
| Re-submit under the **same** `coalesceKey` | the fact is finished but a **truthful replacement** must still be spoken | `renderExpired`'s expiry/brake collapse (`y9tj` threads the *cause* so a brake never claims a timeout), `collapseBrakedActionLastCall` (`okes`) |
| `turnArbiter.releaseFloorPause('last-call:<id>')` | ledger-only cleanup at a **terminal** site — drop the floor-pause credit *without* eating the replacement utterance | both collapse sites (`rz7k`) |

Do not reach for `remove()` at a collapse site: it would delete the true replacement you just
submitted. Do not rely on item *shape* to detect terminality either — a resubmitted undelivered
digest is also deadline-less but still live and still owed its credit.

**Fixed.** The six beads that motivated this section: `3tx3`, `y9tj`, `7qb1` (interrupt arm now
re-derives facts through `factsForDrain`), `rz7k` (**endpoint-gated** pause credit + ledger released
at every terminal site), `vwld` (absent `severityRank` is a FIFO tie, not `exception`), `r59t`
(`arbiter_drain.delivered`).

**Still open in this layer** — found by the adversarial review of that same sweep, so read the
invariant as *enforced at the audited sites*, not *proven everywhere*:

| Bead | Hole |
|---|---|
| `02wz` (P2) | **Full-Auto promotion** hard-drains staged *approvals* (`drainPaneOnPromotion` → `drainForPane`) with **no** arbiter retraction, so a queued last-call can still say "approve now" for an approval drained as moot. The *actions* half of the same function is covered via `cancel()` → `onResolved`; the asymmetry is the tell. |
| `hyly` (P3) | The action leg's own TTL drop is **silent** when its last-call already drained live — told-*less*, not stale. The approvals leg always re-submits truth; this one does not. |
| `drxp` (P3) | `rz7k(b)` residual: because the drain-tick cadence equals the floor-hold window, one `floorHeld=false` jitter tick voids **two** spans, so a genuine monologue can accrue as little as half the promised D1 extension. |
| `idd1` (P3) | `y9tj` made the *spoken* channel honest; the same brake-cancelled approval still tells the UI/attention surface it timed out. |

Note the ledger is bounded **only** because every terminal site calls `releaseFloorPause` — a new
terminal exit that forgets it re-opens the leak, and the shape of a queued item cannot tell you it is
terminal. `02wz` is one such site today.

Program stability for the layer remains gated on the `v02l` telemetry watch:
`npm run telemetry:arbiter` must show `jump_over` at structurally ~zero. `r59t` is what makes its
drain-size distribution trustworthy — it now measures rows that actually landed and reports
undelivered attempts separately.

---

## 5. Maintenance and Validation Strategy

Journey coverage lives in several layers (not just the journey suite):

*   **Journey suite (`/tests/test_journeys.ts`):** Journeys 1–8 at the noun level (real PTY panes, real ledger). Its J2/J3/J6 verb logic is locally mocked — the real verbs are covered by the purpose-built suites below.
*   **Purpose-built unit/integration suites:** the real approval parser/routing/durability (`test_approvals_wse`, `test_voice_approval_routing`, `test_pendingApprovals_durable`), the real status machine (`test_status_machine`), notes + recall with redaction (`test_notes_recall`, `test_c55_12_notes`), capability gates (`test_capability_gate`, `test_c55_16_set_pane_gates`), and `get_pane_summary` redaction at the real method (`test_redaction`) — covering the J7/J8 components.
*   **Live e2e lane (`e2e/live_*.spec.ts`, `npm run test:e2e:live`):** real server + real PTYs, no mock harness — pane lifecycle through the capability gate, archive/restore, per-pane gate behavior, keyboard-only operation, draft durability, stop-all.
*   **Coherence layer (J0, §4):** the turn arbiter and speech-admission substrate have their own suites — `test_turn_arbiter_core`, `_journeys`, `_deadlines`, `_corrections`, `_briefs`, `_completions`, `_matrix`, plus `test_speak_gate`, `test_correction_ledger_eviction` / `_query`, `test_vcd_journeys`, and `test_arbiter_telemetry`.
*   **Drift guards:** every registry action must be referenced by at least one test (`tests/test_action_test_presence.ts`); voice/REST surface asymmetries are allowlist-gated (`tests/test_action_coverage.ts`).

CI runs the lint + unit suite plus both Playwright lanes (mock and live) — see `.github/workflows/ci.yml`.

To verify locally:
```bash
npm run lint            # tsc --noEmit
npm test                # unit suite (tsx --test --test-force-exit)
npm run test:e2e        # Playwright mock lane (?mock=1)
npm run test:e2e:live   # Playwright live lane (real server, fresh temp DB)
```
