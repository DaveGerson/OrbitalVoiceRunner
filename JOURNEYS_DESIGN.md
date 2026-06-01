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
| **Narrate Terminal Walk-through** | `get_pane_summary` | Recent terminal output (ANSI-stripped) is read back; the operator dictates notes for needed changes. *(Output is not yet redacted or semantically analyzed — see `docs/review/IMPLEMENTATION_PLAN.md` WS-B/WS-J.)* |

---

## 4. Maintenance and Validation Strategy

To prevent functional regression, the primary developer journeys are tested inside `/tests/test_journeys.ts` (Journeys 1–6). *(The two secondary journeys, 7 and 8, are not yet covered — tracked in `docs/review/BUG_LOG.md` BUG-038.)*

To verify and run all validation tests:
```bash
# Compile and run the complete test suite
npx tsx --test tests/*.ts
```
