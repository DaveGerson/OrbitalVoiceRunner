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
*   **System State Persistence:** The `Ledger` class processes, saves, and reloads user configurations, workspaces, pane hierarchies, active settings, watch automation rules, and notes atomically into `.janus_ledger.json`.

---

## 2. Core Components Supporting Primary Journeys

### Journey 1: Fan-out / Delegate in Parallel
*Start multiple agent panes on independent tasks, switching attention dynamically.*

*   **Workspace Ledger Partitioning (`Ledger` inside `/src/ledger.ts`):** Workspaces are segmented via distinct project configurations containing directories, notes, and specific terminal panes.
*   **Virtual Dynamic PTY Panes (`OrchestratorManager` inside `/src/terminal.ts`):** Supports launching and executing multiple non-blocking sub-processes using instances of `UniversalTerminal`. PTY processes run concurrently to complete tasks independently (e.g., launching an API compiler and testing script in separate panes).
*   **Context Switching Mechanism (`switch_context` inside `/server.ts`):** 
    Janus triggers the `switch_context` function. This backgrounds the current workspace, loads the target project's path as the system CWD, and dynamically generates a rich **Project Briefing** incorporating the project summary, files, historical project notes, and absolute states of related active panes.

---

### Journey 2: Supervisor / "Air-Traffic Control" (ATC)
*Keep agents in Human-in-the-Loop; approve or redirect commands as they surface.*

*   **Graduated Safety Gating Model (`propose_command` inside `/server.ts`):**
    Each project pane has an assigned `permissionsMode` attribute defined in `/src/types.ts`:
    *   `Full Auto`: Commands run immediately inside the active terminal process.
    *   `Human-in-the-Loop`: Commands are intercepted, a unique `call.id` is allocated, and the execution is paused pending operator sign-off.
    *   `Read-Only`: Writing commands is strictly prevented; a clear write block exception is returned.
*   **State-Preserved Pending Map (`pendingApprovals` inside `/server.ts`):**
    Holds intercepted commands along with their session context, target destination pane, and triggering human rationale.

---

### Journey 3: Review & Approve Code Across Panes
*Move between panes and approve/reject commands by voice or visual dialog.*

*   **Voice Interception Parser (Intercept in `/server.ts` on websocket audio feed):**
    When Janus transcribes a human utterance, a regex voice parser checks for active commands containing natural trigger keywords:
    *   *Approvals:* `["approve", "go ahead", "execute", "run it", "yes run", "approve command"]`
    *   *Rejections:* `["reject", "cancel", "deny", "don't run", "reject command"]`
    If a pending approval matches a voice trigger, the server automatically dispatches the earliest corresponding command to the target pane or cancels it, sending the correct function response feedback to the Gemini model and rendering it on the web interface.
*   **The Approval Dialog Component (`/src/components/ApprovalDialog.tsx`):**
    A polished, animated modal overlays on top of the screen when a command is queued, presenting the exact proposed command string, its target pane, and AI rationale.

---

### Journey 4: Knowledge Capture & Continuity
*Log decisions, rationale, and notes securely; re-brief Janus when returning to workspaces.*

*   **Durable Note Capture (`add_project_note` / `add_pane_note` inside `/server.ts`):**
    Captures unstructured spoken notes or Walkthrough narrations and appends them to the persistent configuration ledger.
*   **History Simplification Engine (`get_pane_command_history` inside `/server.ts`):**
    Instead of passing large, messy and token-expensive stdout streams to the LLM context, it maintains a concise history log containing the precise command executed and its condensed high-level outcome.
*   **Dynamic System Prompt Reconstruction:**
    Each time Janus resumes a workspace session, the system instruction is reconstructed with the active project ID, the available workspaces (ID/name), and the live status and CWD of each terminal pane. (Note: project notes and file trees are *not* injected into the system instruction today; notes re-enter context via the `switch_context` briefing — see `docs/review/BUG_LOG.md` BUG-033.)

---

### Journey 5: Adjust Autonomy Mid-Session
*Verbally promote or demote pane safety permissions dynamically on-the-fly.*

*   **Autonomy Transition Hook (`set_pane_permissions` inside `/server.ts`):**
    Modifies the active permissions mode of an ongoing terminal pane instance.
*   **State Alignment Logging (`Ledger.updatePane`):**
    Once an autonomy update is triggered via voice, the permissions value is saved directly to the database file. If the process is rebooted or cloned, it preserves the defined autonomy scope.

---

### Journey 6: On-Demand Status Check
*Ask "what's busy or done?" across all panes for spoken system reports.*

*   **State Synchronization Loop (`syncLedger` in `/src/terminal.ts`):**
    Aggregates active values from live operating processes. Map parameters include:
    *   `is_busy`: Set to `true` if the shell process is executing a command.
    *   `alive`: Set to `false` if the background terminal process has exited.
*   **Orientation Index (`list_panes` in `/server.ts`):**
    Retrieves all organized workspaces and active terminal pane entities, enabling Janus to provide spoken summaries to the operator.

---

## 3. Secondary Journeys Supporting Elements

| Secondary Journey | Core API Tool Hooks | Action Profile |
| :--- | :--- | :--- |
| **Dictate Specifications** | `add_project_note` & `add_pane_note` | Speech-to-text notes are written directly to ledger. |
| **Narrate Terminal Walk-through** | `get_pane_summary` | Recent terminal output (ANSI-stripped, secret-redacted via WS-B's `redactSecrets`) is read back; the operator dictates notes for needed changes. *(No semantic analysis yet — see `docs/review/IMPLEMENTATION_PLAN.md` WS-J.)* |

---

## 4. Maintenance and Validation Strategy

Journey coverage lives in several layers (not just the journey suite):

*   **Journey suite (`/tests/test_journeys.ts`):** Journeys 1–6 at the noun level (real PTY panes, real ledger). Its J2/J3/J6 verb logic is locally mocked — the real verbs are covered by the purpose-built suites below.
*   **Purpose-built unit/integration suites:** the real approval parser/routing/durability (`test_approvals_wse`, `test_voice_approval_routing`, `test_pendingApprovals_durable`), the real status machine (`test_status_machine`), notes + recall with redaction (`test_notes_recall`, `test_c55_12_notes`), capability gates (`test_capability_gate`, `test_c55_16_set_pane_gates`), and `get_pane_summary` redaction at the real method (`test_redaction`) — covering the J7/J8 components.
*   **Live e2e lane (`e2e/live_*.spec.ts`, `npm run test:e2e:live`):** real server + real PTYs, no mock harness — pane lifecycle through the capability gate, archive/restore, per-pane gate behavior, keyboard-only operation, draft durability, stop-all.
*   **Drift guards:** every registry action must be referenced by at least one test (`tests/test_action_test_presence.ts`); voice/REST surface asymmetries are allowlist-gated (`tests/test_action_coverage.ts`).

CI runs the lint + unit suite plus both Playwright lanes (mock and live) — see `.github/workflows/ci.yml`.

To verify locally:
```bash
npm run lint            # tsc --noEmit
npm test                # unit suite (tsx --test --test-force-exit)
npm run test:e2e        # Playwright mock lane (?mock=1)
npm run test:e2e:live   # Playwright live lane (real server, fresh temp DB)
```
