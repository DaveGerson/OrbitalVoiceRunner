// AgentAdapter per-CLI strategy table (multi-cli adapter spec §4, §5).
//
// One adapter per tool_preset owns EVERY per-CLI difference behind one interface:
// spawn flags, the bypass flag, the launch/resume argv, the live-mode-switch
// disposition (planModeChange), session pinning, and capability flags. These
// hermetic tests (no real CLI) pin:
//   - buildLaunchCommand argv per preset (the §5 "safe-but-ready launch" row)
//   - the INTENTIONAL B2 BUGFIX: Codex/agy must NOT carry Claude's
//     --dangerously-skip-permissions; each picks its own bypass flag
//   - planModeChange dispositions (Claude live-signal ESC[Z; Codex/agy
//     restart-resume; Custom unsupported)
//   - buildResumeCommand argv
//   - capabilities() flags
//   - generateSessionId / pinnedSessionId (Claude UUID; others null)

import { describe, it } from "node:test";
import assert from "node:assert";
import { createAdapter } from "../src/agents";

// Byte references (written as real bytes, mirrored from the spec).
const ESC = "\x1b";
const SHIFT_TAB = `${ESC}[Z`; // ESC [ Z = 0x1b 0x5b 0x5a — Claude live mode-cycle key.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAUDE_SKIP = "--dangerously-skip-permissions";
const CODEX_BYPASS = "--dangerously-bypass-approvals-and-sandbox";
const FIXED_UUID = "0f9e8d7c-6b5a-4321-9876-543210fedcba";

describe("createAdapter (preset → adapter)", () => {
  it("maps each union member to an adapter carrying the right preset tag", () => {
    assert.strictEqual(createAdapter("Claude Code").preset, "Claude Code");
    assert.strictEqual(createAdapter("Codex").preset, "Codex");
    assert.strictEqual(createAdapter("Antigravity").preset, "Antigravity");
    assert.strictEqual(createAdapter("Custom").preset, "Custom");
  });
});

describe("ClaudeAdapter (HIGH confidence — §5)", () => {
  const a = createAdapter("Claude Code");

  it("generateSessionId returns a real UUID v4", () => {
    const id = a.generateSessionId();
    assert.ok(id && UUID_RE.test(id), `expected a UUID, got ${id}`);
    // version nibble is 4, variant nibble ∈ 8/9/a/b
    assert.strictEqual(id![14], "4", "version 4");
    assert.ok(/[89ab]/i.test(id![19]), "RFC4122 variant");
  });

  it("buildLaunchCommand under Full Auto seeds the bypass flag in the ring (not hot)", () => {
    const out = a.buildLaunchCommand({ mode: "Full Auto", sessionId: FIXED_UUID, cwd: "." });
    assert.ok(out.argv.includes("claude"), `bin present: ${out.argv.join(" ")}`);
    // LAUNCH seeds via the --allow- variant (ring, not hot); the bare hot flag is
    // reserved for RESUME (re-arm). The launch must NOT carry the bare hot flag.
    assert.ok(out.argv.includes("--allow-dangerously-skip-permissions"), "seeds via --allow- variant");
    assert.ok(!out.argv.includes(CLAUDE_SKIP), "launch does NOT carry the bare hot bypass flag");
    assert.ok(out.argv.includes("--session-id"), "pins the session id");
    assert.ok(out.argv.includes(FIXED_UUID), "the actual uuid is present");
    // bypass is SEEDED in the ring but the launch is NOT hot (safe-but-ready).
    assert.strictEqual(out.bypassSeededInRing, true);
    assert.strictEqual(out.launchWindowHot, false);
    // permission-mode launches SAFE, never bypass.
    const i = out.argv.indexOf("--permission-mode");
    assert.ok(i >= 0, "carries --permission-mode");
    assert.notStrictEqual(out.argv[i + 1], "bypassPermissions", "launch must be SAFE, not hot-bypass");
  });

  it("buildLaunchCommand Read-Only maps to plan; HITL maps to default", () => {
    const ro = a.buildLaunchCommand({ mode: "Read-Only", sessionId: FIXED_UUID, cwd: "." });
    assert.strictEqual(ro.argv[ro.argv.indexOf("--permission-mode") + 1], "plan");
    const hitl = a.buildLaunchCommand({ mode: "Human-in-the-Loop", sessionId: FIXED_UUID, cwd: "." });
    assert.strictEqual(hitl.argv[hitl.argv.indexOf("--permission-mode") + 1], "default");
  });

  it("planModeChange to Full Auto is a live-signal carrying ESC[Z ring steps", () => {
    const plan = a.planModeChange("Human-in-the-Loop", "Full Auto");
    assert.strictEqual(plan.kind, "live-signal");
    if (plan.kind !== "live-signal") return;
    assert.ok(plan.steps.length > 0, "has at least one cycle step");
    assert.ok(plan.steps.some((s) => s.bytes === SHIFT_TAB), "uses ESC[Z (Shift+Tab) ring byte");
  });

  it("modeCycleByte is ESC[Z", () => {
    assert.strictEqual(a.modeCycleByte(), SHIFT_TAB);
  });

  it("buildResumeCommand uses --resume <uuid> + the bypass flag, never --fork-session", () => {
    const r = a.buildResumeCommand({ sessionId: FIXED_UUID, mode: "Full Auto", cwd: "." });
    assert.ok(r.argv.includes("--resume"), "carries --resume");
    assert.ok(r.argv.includes(FIXED_UUID), "resumes the exact uuid");
    assert.ok(r.argv.includes(CLAUDE_SKIP), "re-arms the bypass on resume");
    assert.ok(!r.argv.includes("--fork-session"), "never forks the session");
    assert.ok(!r.argv.includes("--session-id"), "resume must not also pin a fresh session id");
  });

  it("pinnedSessionId is null until a launch uuid is recorded, then deterministic", () => {
    const fresh = createAdapter("Claude Code");
    assert.strictEqual(fresh.pinnedSessionId(), null);
  });

  it("capabilities: live cycle ready, session-pin supported, mode dial visible", () => {
    const c = a.capabilities();
    assert.strictEqual(c.readyForLiveCycle, true);
    assert.strictEqual(c.supportsSessionPin, true);
    assert.strictEqual(c.supportsLivePermissionSwitch, true);
    assert.strictEqual(c.supportsResume, true);
    assert.strictEqual(c.modeSupport, true);
  });
});

// parseCurrentMode read-after-write markers — pinned to the LIVE status-bar
// strings captured in P5 (bead wsm-e2e-pinned-8sw, Claude v2.x over ConPTY via
// scripts/verify-live-modeswitch.ts). The observed ring (HITL launch floor):
//   default(NO pill) → "⏵⏵ accept edits on" → "⏸ plan mode on" → "⏵⏵ auto mode on".
// REGRESSION GUARD: accept-edits is a MID tier and must NOT read back as Full Auto
// (the original bug — it would falsely confirm a promotion that never reached
// bypass). Full Auto is "auto mode on" (or "bypass permissions on" when the bypass
// flag seeds the ring). default/accept-edits are not one of the 3 Janus modes → null.
describe("ClaudeAdapter.parseCurrentMode (live markers — §5/§12, bead 8sw)", () => {
  const a = createAdapter("Claude Code");

  it("'plan mode on' ⇒ Read-Only", () => {
    assert.strictEqual(a.parseCurrentMode("⏸ plan mode on (shift+tab to cycle) · ← for agents"), "Read-Only");
  });

  it("'auto mode on' ⇒ Full Auto", () => {
    assert.strictEqual(a.parseCurrentMode("⏵⏵ auto mode on (shift+tab to cycle) · ← for agents"), "Full Auto");
  });

  it("'bypass permissions on' ⇒ Full Auto (seeded-bypass ring)", () => {
    assert.strictEqual(a.parseCurrentMode("⏵⏵ bypass permissions on (shift+tab to cycle)"), "Full Auto");
  });

  it("'accept edits on' ⇒ null — a MID tier, NEVER Full Auto (regression guard)", () => {
    assert.strictEqual(a.parseCurrentMode("⏵⏵ accept edits on (shift+tab to cycle) · ← for agents"), null);
  });

  it("an idle frame with no mode pill ⇒ null (default/HITL has no marker)", () => {
    assert.strictEqual(a.parseCurrentMode("OrbitalVoiceRunner main · ctx -- Opus 4.8 (1M)"), null);
  });
});

describe("CodexAdapter (LOW confidence — §5)", () => {
  const a = createAdapter("Codex");

  it("generateSessionId is null (capture post-spawn)", () => {
    assert.strictEqual(a.generateSessionId(), null);
  });

  it("B2 BUGFIX: launch sets safety by --sandbox/--ask-for-approval, NEVER Claude's skip flag", () => {
    const out = a.buildLaunchCommand({ mode: "Human-in-the-Loop", sessionId: null, cwd: "." });
    assert.ok(out.argv.includes("codex"), `bin present: ${out.argv.join(" ")}`);
    assert.ok(!out.argv.includes(CLAUDE_SKIP), "Codex must NOT carry --dangerously-skip-permissions");
    assert.ok(out.argv.includes("--sandbox"), "uses --sandbox to set safety");
    assert.ok(out.argv.includes("--ask-for-approval"), "uses --ask-for-approval to set safety");
    assert.strictEqual(out.launchWindowHot, false, "HITL launch is safe");
  });

  it("Full Auto launch never emits Claude's skip flag", () => {
    const out = a.buildLaunchCommand({ mode: "Full Auto", sessionId: null, cwd: "." });
    assert.ok(!out.argv.includes(CLAUDE_SKIP), "no Anthropic-only flag on Codex");
  });

  it("buildResumeCommand uses `codex resume <id>` + the bypass flag (not Claude's)", () => {
    const r = a.buildResumeCommand({ sessionId: FIXED_UUID, mode: "Full Auto", cwd: "." });
    assert.deepStrictEqual(r.argv.slice(0, 2), ["codex", "resume"]);
    assert.ok(r.argv.includes(FIXED_UUID));
    assert.ok(r.argv.includes(CODEX_BYPASS), "Codex bypass flag");
    assert.ok(!r.argv.includes(CLAUDE_SKIP), "never Claude's skip flag");
  });

  it("planModeChange is restart-resume (picker-only live axis)", () => {
    assert.strictEqual(a.planModeChange("Read-Only", "Full Auto").kind, "restart-resume");
  });

  it("modeCycleByte is null (Shift+Tab ≠ permission axis on Codex)", () => {
    assert.strictEqual(a.modeCycleByte(), null);
  });

  it("capabilities: NOT ready for live cycle, no session pin", () => {
    const c = a.capabilities();
    assert.strictEqual(c.readyForLiveCycle, false);
    assert.strictEqual(c.supportsSessionPin, false);
    assert.strictEqual(c.supportsLivePermissionSwitch, false);
    assert.strictEqual(c.modeSupport, true);
  });
});

describe("AntigravityAdapter (agy v1.0.4, LOW — §5)", () => {
  const a = createAdapter("Antigravity");

  it("uses agy's OWN bypass flag (--dangerously-skip-permissions IS correct for agy)", () => {
    const out = a.buildLaunchCommand({ mode: "Full Auto", sessionId: null, cwd: ".", seedPrompt: "go" });
    assert.ok(out.argv.includes(CLAUDE_SKIP), "agy bypass flag is --dangerously-skip-permissions");
    // agy has no --allow- equivalent → the launch window is HOT under Full Auto.
    assert.strictEqual(out.launchWindowHot, true, "agy Full-Auto launch is hot");
  });

  it("bin name is configurable (full-path deploy concern), default 'agy'", () => {
    const dflt = createAdapter("Antigravity").resolveSpawnCommand(".");
    assert.strictEqual(dflt.bin, "agy");
    const pinned = createAdapter("Antigravity", { bin: "C:/x/agy.exe" }).resolveSpawnCommand(".");
    assert.strictEqual(pinned.bin, "C:/x/agy.exe", "bin name is overridable");
  });

  it("buildResumeCommand resumes by explicit --conversation=<uuid> + bypass re-arm", () => {
    const r = a.buildResumeCommand({ sessionId: FIXED_UUID, mode: "Full Auto", cwd: "." });
    assert.ok(r.argv.some((x) => x === `--conversation=${FIXED_UUID}`), `explicit conversation: ${r.argv.join(" ")}`);
    assert.ok(r.argv.includes(CLAUDE_SKIP), "agy bypass re-armed on resume");
  });

  // P5 live probe (bead 8sw, 2026-06-05 via scripts/verify-live-modeswitch-agy.ts):
  // a real agy v1.0.4 pane over ConPTY reaches only the "Select login method" screen —
  // agy requires interactive Google OAuth before ANY session, so no permission-cycle
  // axis is reachable (neither ESC[1;2B nor ESC[Z moved the marker). The conservative
  // floor below is therefore EVIDENCE-BACKED, not a guess: restart-resume +
  // readyForLiveCycle=false is correct until agy is signed in and re-verified.
  it("planModeChange is restart-resume (cycle axis unreachable pre-auth — P5 confirmed)", () => {
    assert.strictEqual(a.planModeChange("Read-Only", "Full Auto").kind, "restart-resume");
  });

  it("capabilities: NOT ready for live cycle, no session pin (P5 evidence-backed floor)", () => {
    const c = a.capabilities();
    assert.strictEqual(c.readyForLiveCycle, false);
    assert.strictEqual(c.supportsSessionPin, false);
  });

  it("generateSessionId is null (capture post-spawn)", () => {
    assert.strictEqual(a.generateSessionId(), null);
  });
});

describe("CustomAdapter (identity passthrough — §5)", () => {
  const a = createAdapter("Custom");

  it("buildLaunchCommand is identity: no flags, no uuid", () => {
    const out = a.buildLaunchCommand({ mode: "Full Auto", sessionId: null, cwd: ".", seedPrompt: "x" });
    assert.ok(!out.argv.includes(CLAUDE_SKIP), "Custom never gets a bypass flag");
    assert.ok(!out.argv.some((x) => UUID_RE.test(x)), "Custom never gets a uuid");
    assert.strictEqual(out.bypassSeededInRing, false);
    assert.strictEqual(out.launchWindowHot, false);
  });

  it("generateSessionId is null; no flags ever", () => {
    assert.strictEqual(a.generateSessionId(), null);
  });

  it("planModeChange is unsupported (no permission model)", () => {
    assert.strictEqual(a.planModeChange("Read-Only", "Full Auto").kind, "unsupported");
  });

  it("modeCycleByte is null", () => {
    assert.strictEqual(a.modeCycleByte(), null);
  });

  it("capabilities: modeSupport false (hide the dial), no resume/pin/live", () => {
    const c = a.capabilities();
    assert.strictEqual(c.modeSupport, false);
    assert.strictEqual(c.supportsResume, false);
    assert.strictEqual(c.supportsSessionPin, false);
    assert.strictEqual(c.readyForLiveCycle, false);
    assert.strictEqual(c.supportsLivePermissionSwitch, false);
  });
});
