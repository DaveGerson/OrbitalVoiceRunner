# U4 — Deterministic `create_pane` (drop free-form `command`, derive server-side from preset)

**Branch:** `feat/u4-deterministic-create-pane` (off main `a977724`, in worktree `…/OrbitalVoiceRunner-wt/u4`)
**Status:** plan only — implementation pending. All line numbers below verified against the live tree at `a977724`.

---

## BLUF

The voice `create_pane` tool exposes a free-form `command` string **and** an independent `tool_preset`, and the two are never reconciled. `command='claude' + tool_preset='Custom'` makes `UniversalTerminal` infer `runtimeType = "shell"` (terminal.ts:313) and **skip** the `--dangerously-skip-permissions` append (terminal.ts:320), because both gates key off `toolPreset !== "Custom"`, not off the command text. The model picks the wrong `tool_preset` and the agent silently launches without auto-approval.

**Fix:** make `tool_preset` the single source of truth. Drop `command` from the voice tool schema; derive it **server-side** from the preset via one `presetCommand()` helper, reused by the restart path. Normalize the model's `tool_preset` value (which may arrive as a preset `id`, a preset `name`, or the union) onto the `addTerminal` union so persistence + restart stay coherent.

---

## Root-cause chain (verified)

1. **Schema** (`server.ts:3611-3631`): `create_pane` declares `command` (free-form), `tool_preset` (free-form string, description lists `Claude Code, Codex, Antigravity, Custom`), `permissions_mode`. `required: ["project_id", "pane_id", "command"]`.
2. **Handler** (`server.ts:2731-2760`): destructures `{ project_id, pane_id, command, tool_preset, permissions_mode }`; calls `manager.addTerminal(pane_id, …, command, tool_preset || "Custom", permissions_mode || "Human-in-the-Loop", …)`. `command` and `tool_preset` are passed independently — never reconciled.
3. **Constructor** (`terminal.ts:297-345`):
   - `this.runtimeType = toolPreset === "Custom" ? "shell" : "interactive_cli";` (line 313)
   - skip-flag append is gated on `if (toolPreset !== "Custom")` **and** `permissionsMode === "Full Auto"` (lines 320-324).
   - So `tool_preset='Custom'` ⇒ shell runtime **and** no `--dangerously-skip-permissions`, regardless of `command='claude'`.
4. **DOCUMENTED BLOCKER — id vs name vs union mismatch:**
   - `settings.presets` entries are `{ id, name, command, … }` (`CliPreset`, `types.ts:211-226`). Seeded defaults: `id ∈ {claudeCode, codex, antigravity}`, `name ∈ {'Claude Code','Codex CLI','Antigravity Agent'}`, `command ∈ {claude, codex, antigravity}` (`terminal.ts:60-64`, `terminal.ts:827-831`).
   - `addTerminal`'s `toolPreset` union is `'Claude Code' | 'Codex' | 'Antigravity' | 'Custom'` (`terminal.ts:84,258,301,967`).
   - **Restart path** (`server.ts:870-877`) compares `pane.tool_preset === 'Claude Code' / 'Codex' / 'Antigravity'` to rebuild `cmd`. Note `name` for Codex/Antigravity is `'Codex CLI'`/`'Antigravity Agent'`, but the **union** uses `'Codex'`/`'Antigravity'` — so we MUST normalize on `.id`, not `.name`, and persist the union value.

---

## (1) New `create_pane` voice tool schema

Replace the declaration at **`server.ts:3611-3631`**.

```ts
{
  name: "create_pane",
  description: "Create a new terminal pane inside a project and start its agent. The command is "
    + "derived from tool_preset on the server — do NOT pass a raw command.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      project_id: { type: Type.STRING, description: "Project ID context to create under." },
      pane_id: { type: Type.STRING, description: "Unique pane terminal identifier." },
      tool_preset: {
        type: Type.STRING,
        // enum keeps the model deterministic — it can no longer free-form a command.
        enum: ["claudeCode", "codex", "antigravity", "Claude Code", "Codex", "Antigravity", "Custom"],
        description: "Which agent to launch. Claude Code / Codex / Antigravity start that CLI; "
          + "Custom opens a bare shell. The command line is chosen by the server from this preset.",
      },
      permissions_mode: {
        type: Type.STRING,
        enum: ["Full Auto", "Human-in-the-Loop", "Read-Only"],
        description: "Local permission safety policy mode.",
      },
    },
    required: ["project_id", "pane_id", "tool_preset"],
  },
}
```

Decisions:
- **`command` is GONE** from properties and from `required`. This is the deterministic fix — the model can no longer emit a command that disagrees with the preset.
- **`tool_preset` becomes an `enum`** accepting both preset **ids** (`claudeCode/codex/antigravity`) and union **names** (`Claude Code/Codex/Antigravity/Custom`). Accepting both is the robustness hedge: Gemini may echo either the id (matching `settings.presets[].id`) or the display union. `normalizePreset()` (below) collapses both onto the union.
- **`required` = `["project_id", "pane_id", "tool_preset"]`** — `tool_preset` is now load-bearing, so it is required (no silent `|| "Custom"` ambiguity at the schema level; the handler still tolerates a missing value defensively).
- `permissions_mode` gains an `enum` (was free-form). Optional — server defaults `Human-in-the-Loop`.

> Parity guard note: `tests/test_voice_tools.ts:324-355` asserts declaration-name set === handler-name set. We are renaming a property, NOT a tool, so that guard is unaffected. The `enum` additions are inert to that regex (`name:\s*"([a-z_]+)"`).

---

## (2) `presetCommand()` helper

**Where it lives:** `src/terminal.ts`, exported, next to `defaultPresets()` / `parsePresetsSafe()` (top of file, ~after line 65). Co-locating with the preset/launch logic keeps the launch-string family (`buildLaunchCommand`, `parsePresetsSafe`) together and avoids a server→ no-new-module hop. `server.ts` already imports from `./terminal` (e.g. `OrchestratorManager`).

**Signature & contract:**

```ts
/** The voice/restart tool-preset union. */
export type ToolPresetUnion = "Claude Code" | "Codex" | "Antigravity" | "Custom";

/**
 * Map a normalized tool-preset union value to the command line to launch. Single source of
 * truth for "preset -> command", reused by the voice create_pane handler AND the restart path.
 * Custom -> the configured bare shell (advanced.defaultShellCommand), else the platform default.
 *
 * `presets` is settings.presets; we resolve the agent command from the matching preset's `.command`
 * (so a director who renamed the binary is honored), falling back to the canonical binary name.
 */
export function presetCommand(
  preset: ToolPresetUnion,
  presets: CliPreset[] | undefined,
  defaultShellCommand: string | undefined,
): string {
  if (preset === "Custom") {
    return defaultShellCommand || (process.platform === "win32" ? "cmd.exe" : "bash");
  }
  // union name -> preset id, then look up settings.presets[].command (director override honored).
  const idByUnion: Record<Exclude<ToolPresetUnion, "Custom">, string> = {
    "Claude Code": "claudeCode",
    "Codex": "codex",
    "Antigravity": "antigravity",
  };
  const fallbackCmd: Record<Exclude<ToolPresetUnion, "Custom">, string> = {
    "Claude Code": "claude",
    "Codex": "codex",
    "Antigravity": "antigravity",
  };
  const id = idByUnion[preset];
  const match = (presets ?? []).find((p) => p.id === id);
  return (match?.command && match.command.trim()) || fallbackCmd[preset];
}
```

**Reuse — restart path** (`server.ts:870-877`): replace the `if/else if` chain with
```ts
const preset = pane.tool_preset; // already a union value persisted by addTerminal
const cmd = presetCommand(preset, manager.settings.presets, manager.settings.advanced.defaultShellCommand);
```
This kills the `'Claude Code'/'Codex'/'Antigravity'` literal comparisons (the spot most exposed to the id/name drift) and the hardcoded `cmd = "bash"` default — both now flow through the one helper.

---

## (3) `normalizePreset()` — id|name|union → union

Also in `src/terminal.ts` (exported, beside `presetCommand`). Keyed primarily on `.id` per the documented blocker.

```ts
/**
 * Collapse whatever the model emitted for tool_preset (a preset .id like "codex", a display
 * .name like "Codex CLI", or an already-union value like "Codex") onto the addTerminal union.
 * Unknown/empty -> "Custom" (fail-safe: bare shell, never a mis-spawned agent).
 */
export function normalizePreset(raw: string | undefined | null): ToolPresetUnion {
  const v = (raw ?? "").trim();
  switch (v) {
    case "claudeCode":
    case "Claude Code":
      return "Claude Code";
    case "codex":
    case "Codex CLI":
    case "Codex":
      return "Codex";
    case "antigravity":
    case "Antigravity Agent":
    case "Antigravity":
      return "Antigravity";
    case "Custom":
      return "Custom";
    default:
      return "Custom";
  }
}
```

Mapping table (the locked id→union contract):

| settings.presets `.id` | `.name`             | normalized union |
|------------------------|---------------------|------------------|
| `claudeCode`           | `Claude Code`       | `Claude Code`    |
| `codex`                | `Codex CLI`         | `Codex`          |
| `antigravity`          | `Antigravity Agent` | `Antigravity`    |
| (n/a)                  | (n/a)               | `Custom`         |

> Critical: Codex/Antigravity `.name` (`Codex CLI`/`Antigravity Agent`) ≠ union (`Codex`/`Antigravity`). Normalizing on `.id` (and tolerating both name and union) is what keeps the persisted `tool_preset` and the restart-path comparison correct.

---

## Voice handler rewrite (`server.ts:2731-2760`)

```ts
} else if (name === "create_pane") {
  const { project_id, pane_id, tool_preset, permissions_mode } = args; // NOTE: no `command`
  const preset = normalizePreset(tool_preset);
  const command = presetCommand(preset, manager.settings.presets, manager.settings.advanced.defaultShellCommand);
  const createPaneEffect = (): string => {
    if (!manager.ledger.getProject(project_id)) {
      manager.ledger.addProject(project_id, ".", "Co-created with pane");
    }
    const result = manager.addTerminal(
      pane_id,
      manager.ledger.workspaces[project_id]?.directory || process.cwd(),
      command,                                    // derived, not from the model
      preset,                                     // normalized union (was tool_preset || "Custom")
      permissions_mode || "Human-in-the-Loop",
      "",
      project_id,
    );
    broadcastLedgerUpdate();
    broadcastTerminalsUpdated();
    return `Pane ${pane_id} created under project ${project_id}. Result: ${result}`;
  };
  const g = gateOrDefer("create_pane", pane_id ?? null, `Create pane ${pane_id} (${command}) in ${project_id}`, createPaneEffect,
    { origin: "voice", paneId: pane_id, cwd: manager.ledger.workspaces[project_id]?.directory, command, toolPreset: preset, permissionsMode: permissions_mode, projectId: project_id });
  // …forbidden/deferred/run branches unchanged…
}
```

Key points:
- The persisted **intent** (`server.ts:2753`) still carries `command` (now the derived value) and `toolPreset: preset` (now normalized). This keeps `buildActionRun`'s create_pane rebuild (`actionEffects.ts:94-137`) byte-identical — `CreatePaneParams.command` stays populated, so a confirm-after-restart still spawns the right agent. **No actionEffects change required.**
- `addTerminal` now receives the normalized union, so the constructor's `runtimeType` (`interactive_cli`) and the `--dangerously-skip-permissions` append (under Full Auto) are correct.

---

## (4) Failing test FIRST (TDD)

Add to **`tests/test_voice_tools.ts`** a new `describe("U4: deterministic create_pane (preset-derived command)")`. It boots the same headless mock-Live server already in that file. Because `create_pane` defaults to **Ask** (`types.ts:36`, `DEFAULT_CAPABILITY_GATES.create_pane = "Ask"`), each test first flips the gate to **Auto** via the existing voice `set_capability_gate` tool so the effect runs inline:

```ts
async function setCreatePaneAuto() {
  const g = session.emitToolCall("set_capability_gate", { capability: "create_pane", gate: "Auto" });
  await waitFor(() => mock.responseFor(g));
}
```

### Test 4a — Claude preset derives `claude`, persists union, keeps skip-flag under Full Auto
```ts
it("create_pane with a Claude preset derives 'claude', persists 'Claude Code', keeps --dangerously-skip-permissions under Full Auto", async () => {
  clearPanes();
  await setCreatePaneAuto();
  const call = session.emitToolCall("create_pane", {
    project_id: "u4_proj", pane_id: "u4-claude",
    tool_preset: "claudeCode",            // model sends the preset .id (the misclassification case)
    permissions_mode: "Full Auto",
  });
  await waitFor(() => mock.responseFor(call));
  const term = running.manager.terminals["u4-claude"];
  assert.ok(term, "pane was created");
  assert.strictEqual(term.toolPreset, "Claude Code", "persisted the union, not the id");
  assert.strictEqual(term.runtimeType, "interactive_cli", "agent runtime, NOT shell");
  assert.ok(term.shellCmd.startsWith("claude"), `derived the claude command: ${term.shellCmd}`);
  assert.ok(term.shellCmd.includes("--dangerously-skip-permissions"), `Full Auto keeps the skip flag: ${term.shellCmd}`);
});
```
Expected to FAIL pre-fix for the RIGHT reason: with the old schema/handler the model arg `command` is now absent (or, with the old handler still keying off a free-form command, `tool_preset='claudeCode'` is not in the union → constructor treats it as non-Custom only by luck, but `runtimeType`/skip logic compares `!== "Custom"` so it would pass on runtime yet the **command** would be `undefined`). Concretely on `a977724` the handler reads `command` from args (now undefined) and passes `tool_preset='claudeCode'` raw to `addTerminal` → `shellCmd` is `undefined`-derived, not `claude`. Assertion `startsWith("claude")` fails.

### Test 4b — restart rebuilds the right command from the persisted union
```ts
it("restart of a Claude pane rebuilds the 'claude' command via presetCommand", async () => {
  clearPanes();
  await setCreatePaneAuto();
  const call = session.emitToolCall("create_pane", {
    project_id: "u4_proj", pane_id: "u4-restart",
    tool_preset: "Claude Code", permissions_mode: "Full Auto",
  });
  await waitFor(() => mock.responseFor(call));
  // Simulate the persisted-but-not-live restore path: drop the live term, keep the ledger pane,
  // then hit the restart REST endpoint (server.ts:854 branch where manager.terminals[id] is absent).
  delete (running.manager.terminals as any)["u4-restart"];
  const res = await api("/api/terminals/u4-restart/restart", { method: "POST" });
  assert.strictEqual(res.status, 200);
  const term = running.manager.terminals["u4-restart"];
  assert.ok(term, "restart re-created the pane");
  assert.ok(term.shellCmd.startsWith("claude"), `restart derived claude: ${term.shellCmd}`);
  assert.strictEqual(term.toolPreset, "Claude Code");
});
```
> Restart reads the active project's ledger pane (`server.ts:867-877`); ensure the pane's `projectId`/active project is `u4_proj`. If the harness's active project differs, set it first via the ledger (`running.manager.ledger.activeProjectId = "u4_proj"`) or create the pane under the already-active project id. Confirm during implementation by reading `manager.ledger.getActiveProject()` in the test.

### Test 4c — Custom preset → defaultShellCommand, shell runtime, no skip-flag
```ts
it("create_pane with Custom derives defaultShellCommand, stays shell, no skip flag", async () => {
  clearPanes();
  await setCreatePaneAuto();
  const call = session.emitToolCall("create_pane", {
    project_id: "u4_proj", pane_id: "u4-custom",
    tool_preset: "Custom", permissions_mode: "Full Auto",
  });
  await waitFor(() => mock.responseFor(call));
  const term = running.manager.terminals["u4-custom"];
  const expectedShell = running.manager.settings.advanced.defaultShellCommand
    || (process.platform === "win32" ? "cmd.exe" : "bash");
  assert.strictEqual(term.runtimeType, "shell");
  assert.strictEqual(term.shellCmd, expectedShell, "Custom -> bare shell");
  assert.ok(!term.shellCmd.includes("--dangerously-skip-permissions"), "no skip flag on a Custom shell even under Full Auto");
});
```

### Test 4d (unit, fast) — `presetCommand` / `normalizePreset` pure-function pins
Add `tests/test_preset_command.ts` (node:test, no server boot) asserting:
- `normalizePreset("codex") === "Codex"`, `normalizePreset("Codex CLI") === "Codex"`, `normalizePreset("Antigravity Agent") === "Antigravity"`, `normalizePreset("claudeCode") === "Claude Code"`, `normalizePreset("") === "Custom"`, `normalizePreset("garbage") === "Custom"`.
- `presetCommand("Claude Code", defaultPresets(), undefined) === "claude"`.
- `presetCommand("Codex", defaultPresets(), undefined) === "codex"`.
- `presetCommand("Custom", [], "pwsh.exe") === "pwsh.exe"`.
- `presetCommand("Custom", [], undefined) === (win32 ? "cmd.exe" : "bash")`.
- director-rename honored: `presetCommand("Claude Code", [{id:"claudeCode", command:"claude-next", …}], undefined) === "claude-next"`.

Write 4d first (cheapest red), then 4a-4c. Confirm each fails for the stated reason before implementing.

---

## (5) Backward-compat — existing `command` callers

`command` is removed **only from the voice tool schema + voice handler**. Everything else still uses `command` and is untouched:

| Caller | File:line | Status under U4 |
|---|---|---|
| REST `POST /api/terminals` | `server.ts:807-851` | **Unchanged.** Still accepts `command` from request body (it's a direct REST/UI path, not the model). The UI sends a matching `toolPreset` (see `App.tsx:1051/1456/1466…`); deterministic-create is a voice-tool concern. Out of U4 scope. |
| Restart path | `server.ts:870-877` | **Changed** to use `presetCommand()` (reuse, item 2). Behavior-preserving for the seeded presets; more robust for renamed binaries. |
| `apply_orchestration_recipe` (voice) | `server.ts:2901-2922` | **Unchanged.** Spawns a bare shell + records `startupCommand` as a note; passes `p.preset` (already a union from the recipe type `RecipeManifest.panes[].preset`, `types.ts:317`) to `addTerminal`. Not a free-form-command path. |
| `applyRecipe` (REST) | `server.ts:~1431-1461` | **Unchanged**, same as above. |
| `buildActionRun` create_pane rebuild | `actionEffects.ts:94-137` | **Unchanged.** Intent still carries `command` (now the derived value) + `toolPreset` (now normalized). `CreatePaneParams.command` stays required. |
| `tests/test_actionEffects.ts` create_pane cases | `:55-107` | **Unchanged & still green.** They build intents directly with `command:"bash"` — they test the rebuild layer, not the voice schema. No edit needed. |
| `tests/test_voice_tools.ts` | existing cases | **Unchanged.** No existing case calls `create_pane` (the file only exercises stop_all + the parity guard). U4 ADDS the new describe block. |

**No existing test passes a free-form `command` THROUGH the voice `create_pane` tool** — verified: the only `create_pane` voice exerciser added is U4's own. So there is no green test to migrate; we only add coverage. The schema's `required` change (dropping `command`) cannot break a caller because no caller was sending it via the model.

> One forward-compat note for the model contract: removing `command` from the declaration means a stale client/model that still emits `command` will have it ignored by the handler (we no longer destructure it). That is the intended deterministic behavior — the preset wins.

---

## Edit checklist (implementation order)

1. `src/terminal.ts`: add `ToolPresetUnion`, `normalizePreset()`, `presetCommand()` (export all; import `CliPreset` already present at `terminal.ts:3`).
2. `tests/test_preset_command.ts`: write 4d (RED), run `npm test` — confirm red for the right reason.
3. `tests/test_voice_tools.ts`: add the U4 describe block 4a-4c (RED).
4. `server.ts`: rewrite the `create_pane` declaration (`:3611-3631`) and handler (`:2731-2760`); rewrite restart cmd-derivation (`:870-877`) to call `presetCommand`. Import `normalizePreset`/`presetCommand` from `./terminal`.
5. `npm test` → GREEN (all U4 + baseline 596 unchanged). `npm run lint` → exit 0. `npm run build`.
6. Commit with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer. Clean tree.

## Validation gates (must pass before claiming done)
- `cd …/u4 && npm run lint` → exit 0.
- `npm test` → 0 fail, baseline 596 pass not regressed + the new U4 cases green.
- `npm run build` → dist emits clean.
- (Smoke-optional) `npm run smoke:claude` to eyeball a live Claude pane carrying `--dangerously-skip-permissions` under Full Auto.

## Risks / accepted scope
- **R1 (intent fidelity):** kept `command` in the persisted intent so `buildActionRun` + `test_actionEffects` stay byte-identical. Verified the rebuild reads `p.command` (`actionEffects.ts:105`) — populating it with the derived command is correct.
- **R2 (REST not hardened):** REST `POST /api/terminals` still trusts the caller's `command`. Intentional — it's a direct operator/UI path, not the model. If we later want REST-side determinism, file a follow-up bead; out of U4 scope.
- **R3 (enum echo):** `tool_preset` enum lists both ids and union names; `normalizePreset` is the catch-all and defaults unknown → `Custom` (fail to a harmless bare shell, never a mis-spawned agent).
