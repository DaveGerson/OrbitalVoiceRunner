# Journey 5 — Adjust Autonomy Mid-Session: Deep Dive

> ⚠️ **HISTORICAL — audited 2026-05-30, NOT maintained.** This deep-dive describes the code as it
> stood in May 2026. The voice/approval stack has since been rewritten: approval routing now lives
> in `src/voiceApprovalRouting.ts` + `src/gating/index.ts` (TTL → last-call → grace → expire,
> defer/hold, stop-all brake) behind the turn arbiter, and persistence is the SQLite `JanusStore`
> — **not** the `.janus_ledger.json` `Ledger`. **Verify every `file:line` citation against current
> code before acting on it.** The companion per-journey gap register (`gaps.md`) was retired on
> 2026-08-05; live defects are tracked in beads (`bd ready`). Context and retrieval instructions:
> [`docs/journeys/README.md`](../README.md).

## 1. Journey Overview & Trigger

**Goal:** A hands-free operator, while mid-session, can verbally promote a trusted terminal pane from Human-in-the-Loop to Full Auto — and later demote it back — without touching a keyboard or mouse.

**Trigger scenarios:**
- "Janus, set pane `pane_api` to Full Auto, I trust the deploy script." (promote)
- "Janus, drop pane `pane_api` back to Human-in-the-Loop, I want to review the next command." (demote)
- "Janus, lock pane `pane_tests` to Read-Only while I read the output." (restrict)

The journey relies entirely on the voice input → Gemini tool-call → `set_pane_permissions` execution pipeline. No keyboard or visual affordance is required on the operator side; the change takes effect immediately for the next `propose_command` call and persists across server restarts via the Ledger.

---

## 2. Current Flow (As Built) — Step-by-Step Hands-Free

### 2a. Voice to tool call

1. Operator speaks a promotion/demotion intent while the `/live` WebSocket session is active.
2. The browser captures 16 kHz PCM audio and forwards it over the `/live` WebSocket (`server.ts` WebSocket upgrade handler).
3. Gemini Live receives the audio-only stream, determines the operator's intent, and emits a `set_pane_permissions` function call, including `project_id`, `pane_id`, and `permissions_mode`.

### 2b. `set_pane_permissions` execution (server.ts:1542–1557)

```
} else if (name === "set_pane_permissions") {
  const { project_id, pane_id, permissions_mode } = args;
  const term = manager.terminals[pane_id];
  if (term) {
    term.setPermissionsMode(permissions_mode);         // live runtime update
  }
  const ws = manager.ledger.getProject(project_id);
  if (ws && ws.panes[pane_id]) {
    ws.panes[pane_id].permissions_mode = permissions_mode;  // ledger write
    manager.ledger["save"]();                               // async persist
  }
  broadcastLedgerUpdate();
  broadcast({ type: "terminals_updated" });
  session.sendToolResponse({ functionResponses: [...] });
```
(`server.ts:1542-1557`)

Two simultaneous effects happen:
- **Runtime:** `term.setPermissionsMode(permissions_mode)` is called (`src/terminal.ts:118-130`), which updates `this.permissionsMode` in the live `UniversalTerminal` instance.
- **Persistence:** The Ledger's in-memory `panes[pane_id].permissions_mode` is updated and the `save()` method enqueues an async write (100 ms debounce) to `.janus_ledger.json` (`src/ledger.ts:59-78`).

### 2c. Effective mode recomputation

On the **next** `propose_command` call to any pane, the effective mode is resolved inline at `server.ts:1271-1275`:

```typescript
let effectivePermissions = manager.globalPermissionsMode;
if (effectivePermissions === "Inherit") {
  const term = manager.terminals[targetId];
  effectivePermissions = term ? term.permissionsMode : "Human-in-the-Loop";
}
```

**Resolution rules (code-verified):**
- If `globalPermissionsMode` is **not** `"Inherit"`, the global value applies to all panes regardless of their individual `permissionsMode`.
- If `globalPermissionsMode` is `"Inherit"`, the pane's own `term.permissionsMode` is used.
- If the global is `"Inherit"` and the pane is missing from `manager.terminals`, the fallback is `"Human-in-the-Loop"`.

This means `set_pane_permissions` only has observable effect on `propose_command` behaviour when the global mode is `"Inherit"`. If the global is pinned to `"Full Auto"` or `"Read-Only"`, a per-pane demotion or promotion via voice will be written to the ledger and runtime object but will have no immediate effect on command gating.

### 2d. Persistence across restart

On restart, `OrchestratorManager` calls `new Ledger()` which calls `load()` (`src/ledger.ts:40-53`), reading `.janus_ledger.json`. The `permissions_mode` for each pane stored in the ledger is restored. When `addTerminal` is called to re-spin a pane (e.g. during recipe restore at `server.ts:897`), the saved `p.permissionsMode` from the ledger is passed as the constructor argument, so `UniversalTerminal.permissionsMode` is initialized to the persisted value.

### 2e. `--dangerously-skip-permissions` flag handling

The flag is tracked per `UniversalTerminal` shell command string. During construction (`src/terminal.ts:95-104`):

```typescript
if (toolPreset !== "Custom") {
  const skipFlag = "--dangerously-skip-permissions";
  if (permissionsMode === "Full Auto") {
    if (!cmd.includes(skipFlag)) {
      cmd = `${cmd} ${skipFlag}`;
    }
  } else {
    cmd = cmd.replace(` ${skipFlag}`, "");
  }
}
```

And during a live `setPermissionsMode` call (`src/terminal.ts:118-130`):

```typescript
public setPermissionsMode(mode: "Full Auto" | "Human-in-the-Loop" | "Read-Only") {
  this.permissionsMode = mode;
  if (this.toolPreset !== "Custom") {
    const skipFlag = "--dangerously-skip-permissions";
    if (mode === "Full Auto") {
      if (!this.shellCmd.includes(skipFlag)) {
        this.shellCmd = `${this.shellCmd} ${skipFlag}`;
      }
    } else {
      this.shellCmd = this.shellCmd.replace(` ${skipFlag}`, "");
    }
  }
}
```

**Important constraint:** `setPermissionsMode` updates `this.shellCmd` (the stored restart command string) but does **not** restart the running child process. The flag change therefore only takes effect when the pane is next restarted, not immediately for the live PTY session. The `Antigravity` preset defaults `dangerouslySkipPermissions: true` and ships with the flag baked into its default command (`src/terminal.ts:51`). `Claude Code` and `Codex` default to `dangerouslySkipPermissions: false` (`src/terminal.ts:49-50`). Custom panes are unaffected by this flag entirely.

**Real or stubbed?** The flag management is real code that modifies `this.shellCmd`, a property that is read by `start()` to launch the subprocess. It is not mocked or stubbed. However, because the live process is not restarted on a mode change, the flag's effect on the running subprocess is deferred until restart.

---

## 3. Ideal End-User Experience

From the operator's perspective, the ideal journey is:

1. **Speak once, take effect immediately.** "Janus, flip the deploy pane to Full Auto" — Janus confirms in audio ("Done, deploy pane is now in Full Auto mode") and the next proposed command on that pane runs without interruption.
2. **Spoken demotion as a panic lever.** "Janus, lock down everything" or "Drop the deploy pane back to review mode" — Janus confirms and every subsequent command on the targeted pane surfaces an approval dialog again.
3. **Persistent intent.** If the operator walks away and the session restarts, the promoted or demoted state is remembered.
4. **Zero-ambiguity audio feedback.** Janus speaks back the current mode of the changed pane and confirms the old state ("Changed from Human-in-the-Loop to Full Auto").
5. **Per-pane granularity.** The operator can keep one pane in Full Auto (a trusted test runner) while keeping a deployment pane in Human-in-the-Loop, all within the same session.

---

## 4. Backend Support

### `set_pane_permissions` (voice tool path)
- **Definition:** `server.ts:1822-1833` (tool declaration), `server.ts:1542-1557` (handler).
- **Effect:** Calls `term.setPermissionsMode(permissions_mode)` on the live `UniversalTerminal` instance and directly mutates `ws.panes[pane_id].permissions_mode` in the Ledger, then triggers `manager.ledger["save"]()` (async, debounced 100 ms).
- **Required args:** `project_id`, `pane_id`, `permissions_mode`. All three are required (`server.ts:1831`).

### REST path (UI-driven)
- **Endpoint:** `PUT /api/projects/:projectId/panes/:paneId/permissions` (`server.ts:655-674`).
- **Effect:** Identical twin of the voice path — calls `term.setPermissionsMode(permissions)` and `ws.panes[paneId].permissions_mode = permissions`, then `manager.ledger["save"]()`.

### Effective-mode resolution (`propose_command`)
- **File:line:** `server.ts:1271-1275`.
- **Algorithm:** Global wins unless it is `"Inherit"`, in which case pane wins, defaulting to `"Human-in-the-Loop"` if the terminal object is missing.
- **Modes for `Full Auto`:** Command is immediately written to the PTY via `term.writeInput(cmd)` (`server.ts:1282`).
- **Mode for `Read-Only`:** Tool response is returned as a write-block error; a `command_blocked` event is broadcast (`server.ts:1304-1317`).
- **Mode for `Human-in-the-Loop`:** Command is placed in `pendingApprovals[messageId]` and a `approval_pending` WebSocket event is sent to the frontend; no response is sent to Gemini until the operator acts (`server.ts:1319-1334`).

### `Ledger.updatePane` and persistence
- `Ledger.updatePane(projectId, paneMeta, shouldSave = true)` (`src/ledger.ts:188-195`) is the general pane-sync path used by `OrchestratorManager.syncLedger` to keep `last_known_state`, `is_busy`, and `alive` fresh. It calls `this.save(false)` (async, debounced).
- The `set_pane_permissions` handler bypasses `updatePane` and instead directly mutates `ws.panes[pane_id].permissions_mode` before calling `manager.ledger["save"]()`. This is a direct property mutation on the Workspace object that Ledger already holds by reference — it is equivalent in outcome to `updatePane` but narrower in scope.
- Ledger writes are atomic: data is written to `<path>.tmp` first and then renamed over the target file (`src/ledger.ts:89-98`, `src/ledger.ts:113-122`), preventing corruption from mid-write failures.

### Preset flag handling — real vs. mocked
The `--dangerously-skip-permissions` append/strip logic in `setPermissionsMode` (`src/terminal.ts:118-130`) is real, executed code. It is not mocked or stubbed anywhere. The caveat, noted above, is that changing the mode on a running pane mutates `this.shellCmd` for future restarts but does not affect the currently running process.

---

## 5. UI Support

### Global permissions selector (App.tsx header)
- **File:line:** `src/App.tsx:2302-2312`.
- A `<select>` labeled "Global Voice Agent Permission" with options: `Inherit`, `Full Auto`, `Human-in-the-Loop`, `Read-Only`. Bound to `globalPermissionsMode` state; changes call `handleUpdateGlobalPermissions()` which PUTs to `/api/settings`.

### Per-pane permissions selector (pane detail card)
- **File:line:** `src/App.tsx:3352-3363`.
- A `<select>` in the pane detail card under a "Security Access" row with a `Shield` icon. Bound to `pane.permissions_mode`; changes call `handleUpdatePermissions(pane.pane_id, e.target.value)` which calls `PUT /api/projects/${activeProjectId}/panes/${paneId}/permissions` (`src/App.tsx:776-786`).
- Current mode is also displayed as inline text in the pane hover tooltip: "Type: `{tool_preset}` • Mode: `{permissions_mode}`" (`src/App.tsx:1512`).

### Preset-level permissions selector (SettingsDialog)
- **File:line:** `src/components/SettingsDialog.tsx:723-733`.
- Each CLI preset card in the "CLI profiles" tab has a "Permissions Policy" dropdown with `Full Auto`, `Human-in-the-Loop`, and `Read-Only` options. This governs the default mode for panes launched from that preset, not live running panes.
- The `--dangerously-skip-permissions` modifier is a separate checkbox per preset card at `src/components/SettingsDialog.tsx:789-800`, labeled "Bypass Permissions / --dangerously-skip-permissions".

### No dedicated per-pane modal or voice confirmation UI
There is no dedicated voice-confirmation overlay for autonomy changes. The only audio feedback to the operator is Janus's spoken tool response (e.g., "Safety permission mode for pane `pane_api` updated to Full Auto successfully."). There is no earcon or visual animated indicator specifically for mode transitions.

---

## 6. Future-State Best-in-Class

### 6a. Time-boxed autonomy
Allow the operator to say "Janus, run Full Auto for the next 5 minutes, then revert to Human-in-the-Loop." This would require:
- A timer field in `PaneMeta` (e.g., `fullAutoExpiresAt: string | null`).
- A server-side timer that calls `setPermissionsMode` and saves to the ledger on expiry.
- A `set_pane_permissions` tool extension with an optional `duration_minutes` arg.
- Janus should give a spoken countdown: "Full Auto active for 5 minutes. I will revert at 14:35."

### 6b. Scoped autonomy by command type
Let the operator say "Auto-approve `npm test` commands but ask for everything else." This requires:
- A pattern-allow-list in `PaneMeta` (e.g., `autoApprovePatterns: string[]`).
- Logic in the `propose_command` handler that evaluates the proposed command against the pattern list before falling through to the standard effective-mode resolution.
- A `set_pane_permissions` extension accepting an `auto_approve_patterns` array.

### 6c. Auto-demote on anomaly
Automatically drop a pane from Full Auto back to Human-in-the-Loop if the terminal output matches an error pattern. This requires:
- Hooking the existing `updateStatusOnOutput` logic in `src/terminal.ts` (or the `WatchRule` engine already in `manager.ledger.watchRules`) to trigger a permissions demotion when `status` transitions to `"error"` or `"build-failed"`.
- Broadcasting a `permission_demoted` WebSocket event and pushing an `AttentionItem` to `manager.attentionQueue` so the operator is notified hands-free via Janus's spoken digest.
- An optional opt-in flag per pane: `autoDemoteOnError: boolean` in `PaneMeta` / `src/types.ts`.

### 6d. Spoken mode confirmation with prior-state echo
Janus should confirm the change and echo the old mode: "Pane `pane_api` was Human-in-the-Loop; now promoted to Full Auto." This is a pure prompt-engineering change to the Gemini system instruction — no backend code change needed.

### 6e. Required capabilities summary

| Feature | Required addition |
|---|---|
| Time-boxed auto | `fullAutoExpiresAt` in `PaneMeta`; server timer; tool arg extension |
| Scoped auto by pattern | `autoApprovePatterns` in `PaneMeta`; `propose_command` pattern check |
| Auto-demote on anomaly | Hook `updateStatusOnOutput` or `WatchRule` engine; `autoDemoteOnError` flag |
| Spoken prior-state echo | System instruction update for Janus (no code change) |
| Immediate `--dangerously-skip-permissions` effect | Restart-on-mode-change option (opt-in) in `setPermissionsMode` |
