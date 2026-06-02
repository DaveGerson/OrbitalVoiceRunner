import { describe, it } from "node:test";
import assert from "node:assert";
import { buildLaunchCommand } from "../src/terminal";

/**
 * BUG-032 regression pins. The launch string Janus hands the PTY must:
 *   (1) carry NO invented flags / NO npx — bare binary otherwise;
 *   (2) append --resume ONLY for a genuine UUID session id;
 *   (3) NEVER attach --resume to a synthetic "<tool>-session-<hex>" tracking id.
 * The helper owns ONLY the resume-flag decision; the
 * --dangerously-skip-permissions mutation is the constructor's concern (out of scope).
 */
describe("buildLaunchCommand (BUG-032 regression surface)", () => {
  const UUID = "0f9e8d7c-6b5a-4321-9876-543210fedcba";

  // MODE 1 — no invented flags / no npx: bare command returned verbatim.
  it("returns the bare command unchanged when there is no resumable session", () => {
    assert.strictEqual(buildLaunchCommand("claude", "Claude Code", ""), "claude");
    assert.strictEqual(buildLaunchCommand("codex", "Codex", ""), "codex");
    assert.strictEqual(buildLaunchCommand("antigravity", "Antigravity", ""), "antigravity");
  });
  it("never introduces npx or invented flags", () => {
    const out = buildLaunchCommand("claude", "Claude Code", UUID);
    assert.ok(!out.includes("npx"), "must never prefix npx");
    assert.ok(!out.includes("--resume-previous-session"), "no invented resume flag");
    assert.ok(!out.includes("--with-open-textbox"), "no invented textbox flag");
  });

  // MODE 2 — UUID-guarded --resume: appended only with a real UUID.
  it("appends --resume <uuid> for a genuine UUID session id", () => {
    assert.strictEqual(
      buildLaunchCommand("claude", "Claude Code", UUID),
      `claude --resume ${UUID}`
    );
  });
  it("is case-insensitive on the UUID and preserves the id verbatim", () => {
    const upper = UUID.toUpperCase();
    assert.strictEqual(
      buildLaunchCommand("claude", "Claude Code", upper),
      `claude --resume ${upper}`
    );
  });

  // MODE 3 — synthetic tracking id is NOT resumable: never appended.
  it("does NOT append --resume for a synthetic <tool>-session-<hex> id", () => {
    assert.strictEqual(
      buildLaunchCommand("claude", "Claude Code", "claude-code-session-3f9a1c2b"),
      "claude"
    );
  });
  it("does NOT append --resume for a non-UUID free-form id", () => {
    assert.strictEqual(
      buildLaunchCommand("codex", "Codex", "not-a-uuid"),
      "codex"
    );
  });

  // GUARDS — Custom panes & double-append.
  it("never touches a Custom pane, even with a UUID", () => {
    assert.strictEqual(buildLaunchCommand("bash", "Custom", UUID), "bash");
    assert.strictEqual(buildLaunchCommand("cmd.exe", "Custom", ""), "cmd.exe");
  });
  it("does not double-append when --resume is already present", () => {
    const pre = `claude --resume ${UUID}`;
    assert.strictEqual(buildLaunchCommand(pre, "Claude Code", UUID), pre);
  });
  it("does not append when --session is already present", () => {
    const pre = "claude --session abc";
    assert.strictEqual(buildLaunchCommand(pre, "Claude Code", UUID), pre);
  });

  // PRESERVES pre-existing flags (e.g. --dangerously-skip-permissions from the ctor).
  it("preserves a pre-built flag and still appends --resume after it", () => {
    assert.strictEqual(
      buildLaunchCommand("claude --dangerously-skip-permissions", "Claude Code", UUID),
      `claude --dangerously-skip-permissions --resume ${UUID}`
    );
  });
});
