# Capability Catalog

The one-page map of everything this system can do. Every row is **generated** from the canonical action registry (`src/actions/registry.ts`) and the capability matrix (`src/actions/capabilities.ts`) — it is the single source of truth, not hand-maintained prose.

> Regenerate with `npm run catalog`. CI runs `CATALOG_CHECK=1` (or `tsx scripts/catalog.ts --check`) to fail the build if this file drifts from the registry.

**91** actions across **26** gated capabilities, plus the always-allowed group.

- **Surfaces** — where the action is exposed: `voice` (Gemini Live tool), `rest` (HTTP), `ws` (WebSocket).
- **Read-only** — `yes` means the result text is secret-redacted before it leaves the process.
- **Gate** — the *default* per-capability policy (`Auto` runs, `Ask` confirms, `Off` forbids). Tunable globally and per pane.

## Always allowed (emergency brake)

These bypass the capability gate entirely — they work even while the system is frozen. The brake trio (`stop_all` → `confirm_stop_all` → `release_stop_all`) is the hard kill-switch.

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `add_pane_context` | rest | no | Operator-UI |
| `approve_pending_command` | rest | no | Approve or reject a pending spoken-command approval by messageId (approved=true approves, false rejects) |
| `cancel_pending_action` | rest | no | Cancel (discard, no side effect) a pending NON-PTY deferred action by id |
| `clear_exited` | rest | no | Archive all exited panes in the active project (recoverable, not a hard delete) |
| `confirm_pending_action` | rest | no | Confirm (run) a pending NON-PTY deferred action by id |
| `confirm_stop_all` | voice / rest / ws | no | EMERGENCY BRAKE Stage 2 (always allowed) |
| `create_pane_note` | rest | no | Operator-UI |
| `create_project_note` | rest | no | Operator-UI |
| `delete_archived_pane` | rest | no | Permanently delete an archived pane record from the restore tray (operator-UI, ungated) |
| `edit_note` | rest | no | Operator-UI |
| `get_attention_queue` | rest | no | Read the raw attention/alert queue (panes that transitioned to error/exit) |
| `get_ledger` | rest | no | Read the full workspaces ledger (project/pane tree the UI loads on page open) |
| `get_stop_all_status` | rest | no | Read the live STOP-ALL freeze state {frozen, running} so a fresh page load can restore the FROZEN banner |
| `list_archived_panes` | rest | no | List archived (exited+cleared) panes for the UI restore tray (pane_id/name/project/preset/last_command/archived_at) |
| `list_orchestration_recipes` | rest | no | Read the orchestration recipe templates (suggested multi-pane suites the UI offers) |
| `list_orchestrator_plans` | rest | no | Read the multi-step orchestrator plans board (id/status/steps per plan) |
| `list_pending_actions` | rest | no | List the pending NON-PTY deferred actions (gated-Ask staging) with their age |
| `list_pending_commands` | rest | no | List the pending spoken-command approvals (the HiTL queue the ApprovalDialog renders) |
| `list_watch_rules` | rest | no | List all configured watch-automation rules |
| `read_project_notes` | rest | no | Operator-UI |
| `release_stop_all` | voice / rest / ws | no | Clear the freeze (always allowed) |
| `remove_note` | rest | no | Operator-UI |
| `resize_pane` | rest | no | Resize a terminal pane's PTY grid to match the operator's viewport |
| `stop_all` | voice / rest / ws | no | EMERGENCY BRAKE Stage 1 (always allowed) |
| `stop_pane` | rest | no | Gracefully stop a pane and archive it (recoverable) |
| `update_project` | rest | no | Update a project's directory/summary/keyTerms/name (operator-UI, ungated) |

## Internally gated actions

These use the registry's `ALWAYS_ALLOWED` sentinel only to avoid double-gating in `runAction`. Their handlers still route through the named capability gate before doing privileged work.

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `deliver_handoff` | voice / rest | no | Deliver a STAGED handoff into the target pane's live session (GATED by the deliver_handoff capability + the pane's effective mode) |

## Add an automation rule

- **Capability:** `add_watch_rule`
- **Default gate:** Ask
- **Category:** Spawning work

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `add_watch_rule` | rest | no | Create a watch-automation rule that fires a command on another pane when a trigger pane transitions |

## Apply a workspace recipe

- **Capability:** `apply_recipe`
- **Default gate:** Ask
- **Category:** Spawning work

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `apply_layout` | voice / rest | no | Re-materialize a saved pane layout into the active project |
| `apply_orchestration_recipe` | voice / rest | no | Apply a pre-configured template layout suite (such as full-stack-web or python-worker) to standard workspaces |

## Archive an exited pane

- **Capability:** `archive_pane`
- **Default gate:** Auto
- **Category:** Orientation (low-risk)

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `archive_pane` | rest | no | Archive a single pane's record into the recoverable archive (does NOT terminate its process) |

## Clear a pane's history

- **Capability:** `clear_history`
- **Default gate:** Ask
- **Category:** Destructive

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `clear_history` | rest | no | Clear a terminal pane's recorded command history |

## Close a pane

- **Capability:** `close_pane`
- **Default gate:** Ask
- **Category:** Destructive

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `close_pane` | voice | no | Exit (terminate) a pane's agent/process and ARCHIVE the pane — recoverable; the operator can restore it from the archive later |

## Compose a draft or handoff

- **Capability:** `compose_draft`
- **Default gate:** Auto
- **Category:** Orientation (low-risk)

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `apply_prompt_template` | voice / rest | no | Instantiate a saved prompt template (filling its {{slot}} values) into a pane's WIP draft for the operator to review and send |
| `handoff_context_between_panes` | voice / rest | no | Gather context from a source CLI pane and package summaries/learnings to prime a model agent in another target pane |
| `propose_handoff` | voice / rest | no | Draft a first-class handoff to a target pane (UNGATED — never touches the pane) |
| `reject_handoff` | voice / rest | no | Reject/cancel a handoff (UNGATED pre-gate flip; if a delivery is pending at the gate, routes through the gate's reject path) |
| `revise_handoff` | voice / rest | no | Rewrite a handoff's composed prompt (UNGATED co-authoring; increments revision_count) |
| `stage_handoff` | voice / rest | no | Freeze a handoff draft and mark it 'staged' (UNGATED; validates the target pane is live) |
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

## Delete an orchestrator plan

- **Capability:** `delete_orchestrator_plan`
- **Default gate:** Ask
- **Category:** Destructive

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `delete_orchestrator_plan` | rest | no | Delete a multi-step orchestrator plan by its id, removing it from the plan board |

## Delete a pane permanently

- **Capability:** `delete_pane`
- **Default gate:** Ask
- **Category:** Destructive

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `delete_pane` | rest | no | Permanently delete a pane record (hard delete; not the recoverable stop_pane) |

## Delete a project

- **Capability:** `delete_project`
- **Default gate:** Ask
- **Category:** Destructive

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `delete_project` | rest | no | Permanently delete a project workspace |

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
| `list_layouts` | voice / rest | yes | List the saved pane layouts (name, source project, and the panes each would spawn) |
| `list_pending_approvals` | voice | yes | List the commands/instructions currently awaiting the operator's spoken approval (pane, kind, distilled instruction, rationale, count) |
| `list_prompt_templates` | voice / rest | yes | List the saved prompt templates (name, description, and the {{slot}} parameters each one needs) |
| `read_handoff` | voice / rest | yes | Read a single handoff (UNGATED, redacted output) |
| `search_notes` | voice | yes | Full-text search the saved NOTES for a phrase ('find the note about auth', 'what did we say about retries') |

## Read a pane's output

- **Capability:** `read_pane`
- **Default gate:** Auto
- **Category:** Reading

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `get_dispatch_status` | voice / rest | yes | Check a multi-pane dispatch group |
| `get_pane_command_history` | voice / rest | yes | Return the list of recently executed commands in this pane with their concise, high-level final responses/outcomes, rather than raw/messy terminal outputs |
| `get_pane_delta` | voice | yes | Return ONLY the pane output that is new since you last read this pane (true incremental delta; ANSI-stripped, secret-redacted) |
| `get_pane_summary` | voice / rest | yes | Return the last ~20 lines of one pane's recent terminal output (ANSI-stripped and secret-redacted) |
| `get_terminal_history` | rest | yes | Return the RAW recorded command history array for one pane (full command + timestamp + output + finalResponse per entry) for the UI history panel |
| `list_panes` | voice / rest | yes | List all projects and their panes with runtime_type, is_busy, alive, a one-line state, and live timing |

## Remove an automation rule

- **Capability:** `remove_watch_rule`
- **Default gate:** Ask
- **Category:** Spawning work

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `remove_watch_rule` | rest | no | Delete a watch-automation rule by its id |

## Restart a pane

- **Capability:** `restart_pane`
- **Default gate:** Ask
- **Category:** Destructive

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `respawn_pane` | rest | no | Respawn a terminal pane (stop its process and start it again) |
| `restore_archived_pane` | rest | no | Restore an archived pane back into its project AND respawn its terminal from the persisted identity (cwd/preset/permissions) |

## Send keystrokes to a pane

- **Capability:** `send_keys`
- **Default gate:** Ask
- **Category:** Acting in a pane

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `send_keys` | rest | no | Write a command directly to a terminal pane's input |

## Change these safety gates

- **Capability:** `set_capability_gate`
- **Default gate:** Ask
- **Category:** Changing the locks

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `set_capability_gate` | voice | no | Set a capability gate to Auto, Ask, or Off — globally or for one pane (meta capability) |
| `set_pane_gates` | rest | no | Set the per-pane capability-gate OVERRIDE map from the matrix editor (bulk, whole-map, loosening allowed — the deliberate operator-direct UI sibling of the voi… |

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
| `restart_pane` | voice | no | Apply a permission mode to a LIVE terminal pane, reaching the running CLI |
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
| `create_prompt_template` | voice / rest | no | Save a reusable prompt template |
| `delete_layout` | voice / rest | no | Delete a saved pane layout by its id |
| `delete_note` | voice | no | Delete a note permanently by its id (get the id from get_project_notes or search_notes) |
| `delete_prompt_template` | voice / rest | no | Delete a saved prompt template by its id |
| `rename_pane` | voice / rest | no | Rename a pane |
| `rename_project` | voice / rest | no | Rename a project |
| `save_project_layout` | voice / rest | no | Snapshot the current project's running panes (launch command, directory, preset, permission mode) as a named layout you can re-apply later with apply_layout |
| `update_prompt_template` | voice / rest | no | Edit a saved prompt template's name, description, or body by its id |

## Type a command into a pane

- **Capability:** `write_to_pane`
- **Default gate:** Ask · spotlight-eligible
- **Category:** Acting in a pane

| Action | Surfaces | Read-only | Description |
| --- | --- | --- | --- |
| `dispatch_to_panes` | voice / rest | no | Send one instruction (raw text or a prompt template with slot values) to SEVERAL panes at once |
| `propose_command` | voice | no | Direct work to the pane the operator currently has OPEN (the active pane) |
