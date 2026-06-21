// tests/test_paneswrite_complexity_refactor.ts
//
// CC-burndown pin for src/actions/defs/panes_write.ts — the create_pane `coerceArgs` method
// (flagged at CC 14). These tests pin the CURRENT behavior of coerceArgs across every branch and
// edge BEFORE the verbatim, behavior-preserving extraction, then keep it GREEN after.
//
// coerceArgs contract (server-side REST/voice shape normalizer):
//   - REST shape is identified by presence of a camelCase alias key (terminalId / toolPreset).
//   - camel->snake aliasing ONLY fills a snake key that is ABSENT (== null), never clobbers a
//     present snake key (a voice call carrying snake_case is preserved).
//   - the camel keys (terminalId/projectId/toolPreset/permissionsMode) are always deleted.
//   - cwd / sessionId are always dropped (inline-only REST resolution inputs).
//   - REST-only: a `command` is dropped ONLY when isRestShape && command present &&
//     normalizePreset(tool_preset) !== "Custom" (mirrors the inline ignore). The VOICE path keeps
//     a bogus agent-preset command so the superRefine can REJECT it (the §5.4 guardrail).
//
// Doctrine: pure unit calls of createPane.coerceArgs — no ctx, no server boot, no PTY.

import { describe, it } from "node:test";
import assert from "node:assert";

import { createPane } from "../src/actions/defs/panes_write";

const coerce = (raw: Record<string, unknown>): Record<string, unknown> => {
  assert.ok(createPane.coerceArgs, "createPane must expose coerceArgs");
  return createPane.coerceArgs!(raw) as Record<string, unknown>;
};

describe("panes_write create_pane coerceArgs — CC-burndown behavior pin", () => {
  // ── REST shape: full camelCase aliasing ──────────────────────────────────────
  it("REST: aliases all camelCase keys to snake_case and deletes the camel keys", () => {
    const out = coerce({
      terminalId: "p1",
      projectId: "proj1",
      toolPreset: "claudeCode",
      permissionsMode: "Full Auto",
    });
    assert.strictEqual(out.pane_id, "p1");
    assert.strictEqual(out.project_id, "proj1");
    assert.strictEqual(out.tool_preset, "claudeCode");
    assert.strictEqual(out.permissions_mode, "Full Auto");
    assert.ok(!("terminalId" in out));
    assert.ok(!("projectId" in out));
    assert.ok(!("toolPreset" in out));
    assert.ok(!("permissionsMode" in out));
  });

  it("REST shape detected via terminalId alone (toolPreset absent)", () => {
    // isRestShape = terminalId != null -> command drop logic engages for non-Custom.
    const out = coerce({ terminalId: "p1", tool_preset: "claudeCode", command: "evil" });
    assert.strictEqual(out.pane_id, "p1");
    assert.ok(!("command" in out), "REST + non-Custom + command -> dropped");
  });

  it("REST shape detected via toolPreset alone (terminalId absent)", () => {
    const out = coerce({ pane_id: "p1", toolPreset: "codex", command: "evil" });
    assert.strictEqual(out.tool_preset, "codex");
    assert.ok(!("command" in out), "REST + non-Custom + command -> dropped");
  });

  // ── Aliasing only fills ABSENT snake keys (never clobbers present ones) ───────
  it("does NOT clobber a present snake key when a camel alias is also present", () => {
    const out = coerce({
      pane_id: "snake",
      terminalId: "camel",
      project_id: "snakeP",
      projectId: "camelP",
      tool_preset: "Custom",
      toolPreset: "claudeCode",
      permissions_mode: "Read-Only",
      permissionsMode: "Full Auto",
    });
    assert.strictEqual(out.pane_id, "snake");
    assert.strictEqual(out.project_id, "snakeP");
    assert.strictEqual(out.tool_preset, "Custom");
    assert.strictEqual(out.permissions_mode, "Read-Only");
    // camel keys still deleted regardless
    assert.ok(!("terminalId" in out));
    assert.ok(!("projectId" in out));
    assert.ok(!("toolPreset" in out));
    assert.ok(!("permissionsMode" in out));
  });

  // ── cwd / sessionId always dropped ───────────────────────────────────────────
  it("always drops cwd and sessionId", () => {
    const out = coerce({
      pane_id: "p1",
      tool_preset: "Custom",
      cwd: "/some/dir",
      sessionId: "sess-123",
    });
    assert.ok(!("cwd" in out), "cwd dropped");
    assert.ok(!("sessionId" in out), "sessionId dropped");
  });

  // ── REST-only command drop matrix ────────────────────────────────────────────
  it("REST + Custom preset + command -> command KEPT (Custom escape hatch)", () => {
    const out = coerce({ terminalId: "p1", toolPreset: "Custom", command: "htop" });
    assert.strictEqual(out.command, "htop");
  });

  it("REST + non-Custom preset + NO command -> nothing to drop, no crash", () => {
    const out = coerce({ terminalId: "p1", toolPreset: "claudeCode" });
    assert.ok(!("command" in out));
  });

  it("REST + display-name preset that normalizes to non-Custom + command -> dropped", () => {
    // normalizePreset("Claude Code") !== "Custom"
    const out = coerce({ terminalId: "p1", toolPreset: "Claude Code", command: "evil" });
    assert.ok(!("command" in out));
  });

  it("REST + display-name 'Custom' preset + command -> KEPT", () => {
    const out = coerce({ terminalId: "p1", toolPreset: "Custom", command: "htop" });
    assert.strictEqual(out.command, "htop");
  });

  // ── VOICE shape: snake-only, NOT rest -> command is NEVER dropped ─────────────
  it("VOICE (snake-only): a bogus agent-preset command is PRESERVED for the superRefine", () => {
    // No camel keys -> isRestShape=false -> command survives so the zod guardrail can reject it.
    const out = coerce({
      pane_id: "p1",
      project_id: "proj1",
      tool_preset: "claudeCode",
      command: "evil",
    });
    assert.strictEqual(out.command, "evil", "voice path keeps command for superRefine to reject");
  });

  it("VOICE (snake-only) Custom + command -> command preserved", () => {
    const out = coerce({ pane_id: "p1", tool_preset: "Custom", command: "htop" });
    assert.strictEqual(out.command, "htop");
  });

  // ── Edge: command present but tool_preset not a string (non-rest, no drop path) ─
  it("non-string preset on REST shape does not trip the string-guarded drop", () => {
    // presetRaw not a string -> typeof guard short-circuits -> command kept.
    const out = coerce({ terminalId: "p1", tool_preset: 123 as unknown as string, command: "x" });
    assert.strictEqual(out.command, "x");
  });

  // ── Edge: empty input -> no aliasing, no crash, returns a fresh object ────────
  it("empty input returns an object with no leaked alias keys", () => {
    const raw = {};
    const out = coerce(raw);
    assert.notStrictEqual(out, raw, "returns a copy, not the same ref");
    assert.deepStrictEqual(out, {});
  });

  // ── Edge: command == null explicitly on REST non-Custom -> not deleted (no-op) ─
  it("REST non-Custom with command:null is a no-op (null != null is false)", () => {
    const out = coerce({ terminalId: "p1", toolPreset: "claudeCode", command: null });
    // command was null; the != null guard means it is NOT the drop target, but it also was never
    // a meaningful value. Assert it remains whatever it was (null) — i.e. no exception.
    assert.strictEqual(out.command, null);
  });
});
