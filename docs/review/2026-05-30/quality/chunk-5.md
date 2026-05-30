# Chunk 5 — Ledger, Projects/Knowledge, Orchestration Plans & Settings — Quality & Correctness

**Score: 5/10** — Ledger persistence is atomic and well-structured and notes/rename/briefing work, but there are TWO more permission-gate bypasses (REST plan-execute and REST handoff), a credential leak over the settings broadcast, and project-delete orphans live PTYs and resurrects the deleted project.

## Findings

- **`server.ts:990-1004` (`POST /api/plans/:id/execute`) — CRITICAL — Plan step 1 executes via REST WITHOUT the permissions gate.** This route writes `currentStep.command` straight to `targetTerm.writeInput` (1001) with no `effectiveModeFor`/`decideProposal` check. The equivalent TOOL path (`execute_plan`, `server.ts:1769`) correctly routes through `dispatchProposal` (HiTL → pending approval, Read-Only → blocked). So the SAME operation is gated by voice but un-gated by REST — a Read-Only or HiTL pane is written to with no approval if the plan is started from the UI/REST. Tests cover the gated tool path only (`test_approvals_wse`), so this bypass is invisible to the suite. Fix: route this REST handler through the same gate (or remove direct `writeInput`).

- **`server.ts:1058-1075` (`POST /api/handoff`) + `server.ts:1849` (`handoff_context_between_panes`) — CRITICAL — Handoff writes to target stdin bypassing HiTL (REST checks NOTHING; tool checks only Read-Only).** The REST handoff (1075) writes the handoff block to the target pane with no permission check at all. The tool variant (Chunk 3 finding) at least checks Read-Only but still bypasses HiTL. Both inject multi-line, model/operator-controlled content into a target agent pane's stdin without approval. Fix: gate both through `dispatchProposal`.

- **`server.ts:1117-1122, 1697-1702, 1710-1713` (settings broadcast) — HIGH — The full unmasked `geminiApiKey` is broadcast to every WS client.** `GET /api/settings` carefully masks the key (1102-1106), but `broadcast({ type:"settings_updated", settings: manager.settings })` ships `manager.settings` verbatim — including the plaintext `secrets.geminiApiKey` — to all connected clients (and into client React state via `setSettings`). The masking effort is defeated on any settings change, `set_global_permissions`, or `set_voice_mute`. Fix: build a sanitized copy (same masking as GET) before broadcasting.

- **`server.ts:836-857` (`DELETE /api/projects/:id`) — HIGH — Deleting a project with active panes orphans the PTYs and the project resurrects itself.** The route deletes `manager.ledger.workspaces[id]` but never stops/removes the live `manager.terminals` whose `projectId === id`. Those PTY processes keep running and emitting output; `manager.onOutput` then broadcasts `stdout_chunk` for a pane no longer in the ledger, and the next `syncLedger()` (terminal.ts:750-757) AUTO-RECREATES the project from the still-live terminal (`addProject(pId, …, "Auto-created project")`). Net: zombie processes + the "deleted" project reappears. Fix: stop and delete all `manager.terminals` for the project before deleting the workspace.

- **`src/ledger.ts:90-107` (`flushSaveSync`) vs `flushSave` — MED — Sync and async flush can interleave on the same `.tmp` path.** `flushSaveSync` does not check/respect `isSaving`. Because `flushSave` `await`s `fs.promises.writeFile` (a yield point), a `save(true)` → `flushSaveSync` invoked while an async flush is mid-write can both write `${storagePath}.tmp` and `rename` it, racing on the same temp file. The rename is atomic but the temp contents can be a corrupted interleave. Low probability on a single event loop but real under heavy sync+async save mixing. Fix: one shared temp-name-per-write or guard sync flush on `isSaving`.

- **`server.ts:1034-1051` (`/api/recipes/apply`) & `1798-1818` (`apply_orchestration_recipe`) — MED — Recipe panes are created with their recipe-declared `permissionsMode` (often Full Auto) with no operator confirmation.** A recipe can seed `Full Auto` panes; combined with the plan/handoff bypasses, applying a recipe can stand up an unsupervised execution surface in one call. Surface the autonomy level for confirmation.

- **`server.ts:759-774` (`PUT /api/projects/:id`) and several routes — LOW — `manager.ledger["save"]()` is called via bracket-string indexing to reach a method that is not `private`.** `save` is public, so this is just obfuscation, but it signals the persistence API boundary is unclear; a real private method reached this way would be a latent break.

- **`src/App.tsx:933-937` (settings merge) — LOW — Client replaces whole `settings` from broadcast.** `setSettings(msg.settings)` overwrites local settings wholesale on every broadcast; an in-progress edit in SettingsDialog can be clobbered by an unrelated `settings_updated` (e.g. a voice mute) mid-edit. Minor UX/data-loss risk.

## Does-it-do-the-job verdict
Notes, rename, project switching, briefing, and ledger persistence are correct and durable, so the knowledge-capture/continuity journey works. But orchestration's two REST write paths (plan-execute, handoff) bypass the safety gate that the rest of the system enforces, project-delete is broken for active panes, and the settings broadcast leaks the API key — so the orchestration/settings surface is not safe as shipped.

## Top fixes
1. **CRITICAL** — Gate `POST /api/plans/:id/execute` and `POST /api/handoff` (and the handoff tool) through `dispatchProposal`/`effectiveModeFor` so Read-Only/HiTL are honored everywhere.
2. **HIGH** — Sanitize (mask `geminiApiKey`) before any `settings_updated` broadcast.
3. **HIGH** — On project delete, stop and remove all live terminals for the project so PTYs don't orphan and `syncLedger` can't resurrect it.
4. **MED** — Make ledger sync/async flush mutually exclusive (respect `isSaving`).
5. **MED** — Confirm autonomy level when a recipe/`create_pane` seeds Full-Auto panes.
