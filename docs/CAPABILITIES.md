# Capability Catalog

The one-page map of everything this system can do. Every row is **generated** from the canonical action registry (`src/actions/registry.ts`) and the capability matrix (`src/actions/capabilities.ts`) — it is the single source of truth, not hand-maintained prose.

> Regenerate with `npm run catalog`. CI runs `CATALOG_CHECK=1` (or `tsx scripts/catalog.ts --check`) to fail the build if this file drifts from the registry.

**54** actions across **17** gated capabilities, plus the always-allowed group.

- **Surfaces** — where the action is exposed: `voice` (Gemini Live tool), `rest` (HTTP), `ws` (WebSocket).
- **Read-only** — `yes` means the result text is secret-redacted before it leaves the process.
- **Gate** — the *default* per-capability policy (`Auto` runs, `Ask` confirms, `Off` forbids). Tunable globally and per pane.

## Always allowed (emergency brake)

These bypass the capability gate entirely — they work even while the system is frozen. The brake trio (`stop_all` → `confirm_stop_all` → `release_stop_all`) is the hard kill-switch.

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `add_watch_rule` | rest | no | Create a watch-automation rule that fires a command on another pane when a trigger pane transitions |
| `clear_exited` | rest | no | Archive all exited panes in the active project (recoverable, not a hard delete) |
| `clear_history` | rest | no | Clear a terminal pane's recorded command history |
| `confirm_stop_all` | voice / rest / ws | no | EMERGENCY BRAKE Stage 2 (always allowed) |
| `delete_orchestrator_plan` | rest | no | Delete a multi-step orchestrator plan by its id, removing it from the plan board |
| `deliver_handoff` | voice | no | Deliver a STAGED handoff into the target pane's live session (GATED by the deliver_handoff capability + the pane's effective mode) |
| `get_stop_all_status` | rest | no | Read the live STOP-ALL freeze state {frozen, running} so a fresh page load can restore the FROZEN banner |
| `list_watch_rules` | rest | no | List all configured watch-automation rules |
| `release_stop_all` | voice / rest / ws | no | Clear the freeze (always allowed) |
| `remove_watch_rule` | rest | no | Delete a watch-automation rule by its id |
| `resize_pane` | rest | no | Resize a terminal pane's PTY grid to match the operator's viewport |
| `send_keys` | rest | no | Write a command directly to a terminal pane's input |
| `stop_all` | voice / rest / ws | no | EMERGENCY BRAKE Stage 1 (always allowed) |

## Apply a workspace recipe

- **Capability:** `apply_recipe`
- **Default gate:** Ask
- **Category:** Spawning work

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `apply_orchestration_recipe` | voice / rest | no | Apply a pre-configured template layout suite (such as full-stack-web or python-worker) to standard workspaces |

## Compose a draft or handoff

- **Capability:** `compose_draft`
- **Default gate:** Auto
- **Category:** Orientation (low-risk)

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `handoff_context_between_panes` | voice / rest | no | Gather context from a source CLI pane and package summaries/learnings to prime a model agent in another target pane |
| `propose_handoff` | voice | no | Draft a first-class handoff to a target pane (UNGATED — never touches the pane) |
| `reject_handoff` | voice | no | Reject/cancel a handoff (UNGATED pre-gate flip; if a delivery is pending at the gate, routes through the gate's reject path) |
| `revise_handoff` | voice | no | Rewrite a handoff's composed prompt (UNGATED co-authoring; increments revision_count) |
| `stage_handoff` | voice | no | Freeze a handoff draft and mark it 'staged' (UNGATED; validates the target pane is live) |
| `update_draft_prompt` | voice | no | Compose or refine the WIP draft prompt for the pane the operator currently has open, so they can review/edit and send it |

## Open a new pane

- **Capability:** `create_pane`
- **Default gate:** Ask
- **Category:** Spawning work

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `create_pane` | voice / rest | no | Create a new terminal pane inside a project and start its agent |

## Create a project

- **Capability:** `create_project`
- **Default gate:** Auto
- **Category:** Orientation (low-risk)

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `create_project` | voice / rest | no | Create a new project workspace directory context block |

## Dismiss an alert

- **Capability:** `dismiss_attention`
- **Default gate:** Auto
- **Category:** Orientation (low-risk)

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `dismiss_attention` | voice / rest | no | Dismiss one attention item by its id (or all items if id is omitted) once the operator has acknowledged it, so it stops appearing in the digest and proactive n… |

## Run a multi-step plan

- **Capability:** `execute_plan`
- **Default gate:** Ask
- **Category:** Spawning work

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `create_orchestrator_plan` | voice / rest | no | Synthesize a multi-step sequence of chained commands spanning multiple panes that run sequentially with automatic state verification of previous outputs |
| `execute_plan` | voice / rest | no | Starts running a synthesized multi-step plan recipe |

## Switch which pane is open

- **Capability:** `focus_pane`
- **Default gate:** Auto
- **Category:** Orientation (low-risk)

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `switch_active_pane` | voice | no | Change which pane is open on the operator's screen |

## Read notes & handoffs

- **Capability:** `read_notes`
- **Default gate:** Auto
- **Category:** Reading

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `get_action_log` | voice / rest | yes | Read the unified action log |
| `get_attention_digest` | voice | yes | Speak a structured summary of items needing the operator's attention |
| `get_health` | voice / rest | yes | Report a one-glance health snapshot |
| `get_pane_gates` | voice / rest | yes | Read the resolved capability-gate matrix for a pane (or global if pane_id omitted) |
| `get_project_notes` | voice | yes | Recall the durable notes saved for a project (decisions, todos, warnings) |
| `list_capabilities` | voice / rest | yes | List every gateable capability name |
| `list_handoffs` | voice / rest | yes | List handoffs in the active workspace, optionally filtered by state (UNGATED, redacted output) |
| `list_pending_approvals` | voice | yes | List the commands/instructions currently awaiting the operator's spoken approval (pane, kind, distilled instruction, rationale, count) |
| `read_handoff` | voice / rest | yes | Read a single handoff (UNGATED, redacted output) |
| `search_notes` | voice | yes | Full-text search the saved NOTES for a phrase ('find the note about auth', 'what did we say about retries') |

## Read a pane's output

- **Capability:** `read_pane`
- **Default gate:** Auto
- **Category:** Reading

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `get_pane_command_history` | voice / rest | yes | Return the list of recently executed commands in this pane with their concise, high-level final responses/outcomes, rather than raw/messy terminal outputs |
| `get_pane_delta` | voice | yes | Return ONLY the pane output that is new since you last read this pane (true incremental delta; ANSI-stripped, secret-redacted) |
| `get_pane_summary` | voice / rest | yes | Return the last ~20 lines of one pane's recent terminal output (ANSI-stripped and secret-redacted) |
| `get_terminal_history` | rest | yes | Return the RAW recorded command history array for one pane (full command + timestamp + output + finalResponse per entry) for the UI history panel |
| `list_panes` | voice / rest | yes | List all projects and their panes with runtime_type, is_busy, alive, a one-line state, and live timing |

## Restart a pane

- **Capability:** `restart_pane`
- **Default gate:** Ask
- **Category:** Destructive

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `restart_pane` | rest | no | Restart a terminal pane (stop its process and start it again) |

## Change these safety gates

- **Capability:** `set_capability_gate`
- **Default gate:** Ask
- **Category:** Changing the locks

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `set_capability_gate` | voice / rest | no | Set a capability gate to Auto, Ask, or Off — globally or for one pane (meta capability) |

## Change the global autonomy mode

- **Capability:** `set_global_permissions`
- **Default gate:** Ask
- **Category:** Changing the locks

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `set_global_permissions` | voice | no | Set the system wide voice execution permission mode |

## Change a pane's autonomy mode

- **Capability:** `set_pane_permissions`
- **Default gate:** Ask
- **Category:** Changing the locks

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `set_pane_permissions` | voice / rest | no | Set the safety permission policy mode for a specific terminal pane |

## Mute or unmute voice

- **Capability:** `set_voice_mute`
- **Default gate:** Auto
- **Category:** Orientation (low-risk)

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `set_voice_mute` | voice | no | Set microphone muted status |

## Switch focus

- **Capability:** `switch_context`
- **Default gate:** Auto
- **Category:** Orientation (low-risk)

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `switch_context` | voice / rest | no | Make a project the active focus |

## Update notes & metadata

- **Capability:** `update_metadata`
- **Default gate:** Auto
- **Category:** Orientation (low-risk)

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `add_pane_note` | voice | no | Add a durable note to a pane |
| `add_project_note` | voice | no | Add a durable note to a project |
| `amend_note` | voice | no | Edit the text of an existing note by its id (get the id from get_project_notes or search_notes) |
| `delete_note` | voice | no | Delete a note permanently by its id (get the id from get_project_notes or search_notes) |
| `rename_pane` | voice / rest | no | Rename a pane |
| `rename_project` | voice / rest | no | Rename a project |

## Type a command into a pane

- **Capability:** `write_to_pane`
- **Default gate:** Ask · spotlight-eligible
- **Category:** Acting in a pane

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `propose_command` | voice | no | Direct work to the pane the operator currently has OPEN (the active pane) |

## Capabilities without actions (matrix-only)

These capability rows exist in the matrix (so they are tunable and reserved) but have no action wired to them in the current registry.

| Capability | Label | Default gate | Category |
| --- | --- | --- | --- |
| `add_watch_rule` | Add an automation rule | Ask | Spawning work |
| `archive_pane` | Archive an exited pane | Auto | Orientation (low-risk) |
| `clear_history` | Clear a pane's history | Ask | Destructive |
| `close_pane` | Close a pane | Ask | Destructive |
| `deliver_handoff` | Hand a prompt to another pane | Ask | Acting in a pane |
