import { describe, it } from "node:test";
import assert from "node:assert";
import { buildLaunchCommand, UniversalTerminal } from "../src/terminal";

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

/**
 * B2 BUGFIX — per-preset bypass-flag injection (the point of the AgentAdapter
 * extraction, spec §5). The constructor now mutates shellCmd via the pane adapter's
 * OWN bypass flag, NOT a hardcoded Claude flag for every agent:
 *   - Claude  Full Auto → --dangerously-skip-permissions            (unchanged)
 *   - agy     Full Auto → --dangerously-skip-permissions            (agy's own flag)
 *   - Codex   Full Auto → --dangerously-bypass-approvals-and-sandbox (NOT Claude's)
 *   - Custom  Full Auto → no flag                                   (unchanged)
 * Promotion via setPermissionsMode add/strips the SAME per-adapter flag.
 */
describe("constructor bypass-flag injection (B2 regression)", () => {
  const CLAUDE_SKIP = "--dangerously-skip-permissions";
  const CODEX_BYPASS = "--dangerously-bypass-approvals-and-sandbox";
  const ctor = (cmd: string, preset: any, mode: any) =>
    new UniversalTerminal("b2-" + Math.random().toString(16).slice(2), ".", cmd, preset, mode, "", "p");

  it("Claude Full Auto carries --dangerously-skip-permissions (unchanged)", () => {
    assert.ok(ctor("claude", "Claude Code", "Full Auto").shellCmd.includes(CLAUDE_SKIP));
  });
  it("Claude HITL carries no bypass flag (unchanged)", () => {
    assert.ok(!ctor("claude", "Claude Code", "Human-in-the-Loop").shellCmd.includes(CLAUDE_SKIP));
  });

  it("Codex Full Auto uses its OWN bypass flag, NOT Claude's Anthropic-only flag", () => {
    const cmd = ctor("codex", "Codex", "Full Auto").shellCmd;
    assert.ok(cmd.includes(CODEX_BYPASS), `Codex bypass flag: ${cmd}`);
    assert.ok(!cmd.includes(CLAUDE_SKIP), `Codex must NOT inherit Claude's flag: ${cmd}`);
  });
  it("Codex HITL carries no bypass flag", () => {
    const cmd = ctor("codex", "Codex", "Human-in-the-Loop").shellCmd;
    assert.ok(!cmd.includes(CODEX_BYPASS) && !cmd.includes(CLAUDE_SKIP), `no bypass under HITL: ${cmd}`);
  });

  it("Antigravity Full Auto uses --dangerously-skip-permissions (its own flag)", () => {
    const cmd = ctor("agy", "Antigravity", "Full Auto").shellCmd;
    assert.ok(cmd.includes(CLAUDE_SKIP), `agy bypass flag: ${cmd}`);
    assert.ok(!cmd.includes(CODEX_BYPASS), `agy must not use Codex's flag: ${cmd}`);
  });

  it("Custom never carries any bypass flag, even under Full Auto", () => {
    const cmd = ctor("bash", "Custom", "Full Auto").shellCmd;
    assert.ok(!cmd.includes(CLAUDE_SKIP) && !cmd.includes(CODEX_BYPASS), `Custom stays bare: ${cmd}`);
  });

  it("setPermissionsMode promotes/demotes the SAME per-adapter flag (Codex)", () => {
    const t = ctor("codex", "Codex", "Human-in-the-Loop");
    t.setPermissionsMode("Full Auto");
    assert.ok(t.shellCmd.includes(CODEX_BYPASS) && !t.shellCmd.includes(CLAUDE_SKIP), `promote: ${t.shellCmd}`);
    t.setPermissionsMode("Read-Only");
    assert.ok(!t.shellCmd.includes(CODEX_BYPASS), `demote strips it: ${t.shellCmd}`);
  });
});
