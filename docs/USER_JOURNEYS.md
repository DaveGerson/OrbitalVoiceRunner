# User journeys

The journeys OrbitalVoiceRunner is designed to support **today**. Each is
grounded in the tool's current capabilities: a voice-driven Gemini Live agent
("Janus") that observes terminal panes, organizes them in a persistent ledger,
and runs commands under a graduated permissions policy.

> **Modality note.** Janus's input is **audio only** (16 kHz PCM in; audio +
> tool calls out). There is no screen/vision input. "Content" that Janus can
> observe means **terminal output** (via `get_pane_summary`), not arbitrary
> on-screen documents. Journeys that need to read a shared screen are tracked
> in [`BACKLOG.md`](../BACKLOG.md), not here.
>
> **Cross-cutting principle.** Every journey below is meant to be drivable
> **hands-free / eyes-off**, which also makes the tool an accessibility-first
> path to terminal work.

## Supported journeys

### 1. Review & approve code across panes
Move between panes and approve or reject agent-proposed commands by voice,
without leaving the conversation.
*Relies on:* Human-in-the-Loop mode + the Approval Dialog.

### 2. Fan-out / delegate in parallel
Start several agent panes (for example Claude Code in one, Codex in another) on
independent tasks and shift attention as each one progresses.
*Relies on:* multiple panes + `switch_context`.

### 3. Supervisor / "air-traffic control"
Keep agents in Human-in-the-Loop and approve or redirect their proposed
commands as they surface — hands-free oversight of autonomous work.
*Relies on:* Human-in-the-Loop + `propose_command`.

### 4. Adjust autonomy mid-session
Verbally promote a trusted pane from Human-in-the-Loop to Full Auto once you
trust the task — and drop it back when you want control again.
*Relies on:* the per-pane permissions model.

### 5. Dictate a specification from knowledge
Talk through a requirement or design you already hold in your head and capture
it as durable project/pane notes.
*Relies on:* `add_project_note` / `add_pane_note`.

### 6. Narrate a terminal walk-through
Review a pane's recent output aloud and capture each needed change as a note as
you go.
*Relies on:* `get_pane_summary` + notes.

### 7. On-demand status check
Ask "what's busy or done?" across all panes whenever you want a spoken status.
*Relies on:* `list_panes` (`is_busy` / `alive`).

### 8. Knowledge capture & continuity
Log decisions, rationale, and TODOs as notes while you work; on return, have
Janus re-brief you from the project summary, notes, and recent history; and
generate a hand-off for the next person (or your future self).
*Relies on:* notes + `switch_context` briefing + command history.

### 9. Locked-down exploration
Browse an unfamiliar or untrusted repository in Read-Only — observe and ask
questions with zero write risk.
*Relies on:* Read-Only mode.

## What's not here yet

Journeys that need new capability — proactive "tell me when a pane finishes"
notifications, proactive failure triage, and reading a document shared on
screen — are tracked in [`BACKLOG.md`](../BACKLOG.md) so core functionality
gets priority first.
