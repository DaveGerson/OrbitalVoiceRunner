// U4 (wsm-e2e-pinned-ckf) — pure-function pins for the deterministic create_pane fix.
//
// These two helpers are the single source of truth that makes voice `create_pane`
// deterministic: `normalizePreset` collapses whatever the model emits (a preset .id
// like "codex", a display .name like "Codex CLI", or an already-union "Codex") onto
// the addTerminal union; `presetCommand` derives the launch command from that union
// (honoring a director-renamed binary via settings.presets[].command).
//
// No server boot — these are pure functions, the cheapest red.

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  normalizePreset,
  presetCommand,
  parsePresetsSafe,
  type ToolPresetUnion,
} from "../src/terminal";
import type { CliPreset } from "../src/types";

// The seeded default presets (parsePresetsSafe(undefined) returns the canonical trio:
// {claudeCode->claude}, {codex->codex}, {antigravity->agy} — the Antigravity/Gemini CLI
// installs as `agy`; there is no `antigravity` binary (demo regression 2026-08-18).
const seeded: CliPreset[] = parsePresetsSafe(undefined);

describe("U4 normalizePreset — id|name|union -> addTerminal union", () => {
  it("maps the preset .id onto the union (the misclassification case)", () => {
    assert.strictEqual(normalizePreset("claudeCode"), "Claude Code");
    assert.strictEqual(normalizePreset("codex"), "Codex");
    assert.strictEqual(normalizePreset("antigravity"), "Antigravity");
  });

  it("maps the display .name onto the union (Codex CLI / Antigravity Agent drift)", () => {
    assert.strictEqual(normalizePreset("Claude Code"), "Claude Code");
    assert.strictEqual(normalizePreset("Codex CLI"), "Codex");
    assert.strictEqual(normalizePreset("Antigravity Agent"), "Antigravity");
  });

  it("maps the Gemini/agy spellings onto Antigravity (demo 2026-08-18: 'a Gemini pane' guessed Codex)", () => {
    assert.strictEqual(normalizePreset("gemini"), "Antigravity");
    assert.strictEqual(normalizePreset("Gemini"), "Antigravity");
    assert.strictEqual(normalizePreset("agy"), "Antigravity");
  });

  it("passes an already-union value through unchanged", () => {
    assert.strictEqual(normalizePreset("Codex"), "Codex");
    assert.strictEqual(normalizePreset("Antigravity"), "Antigravity");
    assert.strictEqual(normalizePreset("Custom"), "Custom");
  });

  it("fails safe to Custom on empty / unknown (never a mis-spawned agent)", () => {
    assert.strictEqual(normalizePreset(""), "Custom");
    assert.strictEqual(normalizePreset("   "), "Custom");
    assert.strictEqual(normalizePreset("garbage"), "Custom");
    assert.strictEqual(normalizePreset(undefined), "Custom");
    assert.strictEqual(normalizePreset(null), "Custom");
  });
});

describe("U4 presetCommand — union -> launch command", () => {
  it("derives the seeded agent binaries from settings.presets", () => {
    assert.strictEqual(presetCommand("Claude Code", seeded, undefined), "claude");
    assert.strictEqual(presetCommand("Codex", seeded, undefined), "codex");
    assert.strictEqual(presetCommand("Antigravity", seeded, undefined), "agy");
  });

  it("Custom -> defaultShellCommand when provided", () => {
    assert.strictEqual(presetCommand("Custom", [], "pwsh.exe"), "pwsh.exe");
  });

  it("Custom -> platform default bare shell when no defaultShellCommand", () => {
    const expected = process.platform === "win32" ? "cmd.exe" : "bash";
    assert.strictEqual(presetCommand("Custom", [], undefined), expected);
    assert.strictEqual(presetCommand("Custom", [], ""), expected);
  });

  it("honors a director-renamed binary (settings.presets[].command override)", () => {
    const renamed: CliPreset[] = [
      { id: "claudeCode", name: "Claude Code", command: "claude-next", enabled: true },
    ];
    assert.strictEqual(presetCommand("Claude Code", renamed, undefined), "claude-next");
  });

  it("migrates the broken legacy 'antigravity' persisted command to 'agy' (array + object forms)", () => {
    // Every install seeded before the 2026-08-18 demo fix persisted command:"antigravity" — a
    // binary that never existed under that name (the CLI installs as `agy`). That value is a
    // bad shipped default, not a director rename, so parsePresetsSafe rewrites EXACTLY that
    // value; any other explicit rename is still honored verbatim.
    const arr = parsePresetsSafe([{ id: "antigravity", name: "Antigravity Agent", command: "antigravity" }]);
    assert.strictEqual(arr[0].command, "agy", "array form: stale seeded default migrates");
    const obj = parsePresetsSafe({ antigravity: { command: "antigravity" } });
    assert.strictEqual(obj[0].command, "agy", "object form: stale seeded default migrates");
    assert.strictEqual(presetCommand("Antigravity", arr, undefined), "agy", "spawn derives agy post-migration");
  });

  it("preserves a deliberate Antigravity rename (only the exact broken default migrates)", () => {
    const custom = parsePresetsSafe([{ id: "antigravity", name: "Antigravity Agent", command: "C:/tools/agy-pinned.exe" }]);
    assert.strictEqual(custom[0].command, "C:/tools/agy-pinned.exe");
    const otherId = parsePresetsSafe([{ id: "myTool", name: "MyTool", command: "antigravity" }]);
    assert.strictEqual(otherId[0].command, "antigravity", "a NON-antigravity preset keeps its command even if it happens to be the string 'antigravity'");
  });

  it("falls back to the canonical binary when no preset matches the id", () => {
    // empty presets list -> no .command override -> canonical fallback name.
    assert.strictEqual(presetCommand("Claude Code", [], undefined), "claude");
    assert.strictEqual(presetCommand("Codex", undefined, undefined), "codex");
    assert.strictEqual(presetCommand("Antigravity", [], undefined), "agy");
  });
});

// Type-level sanity: the union export exists and is the four expected members.
const _t: ToolPresetUnion[] = ["Claude Code", "Codex", "Antigravity", "Custom"];
void _t;
