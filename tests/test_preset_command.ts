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
