// tests/test_permission_changed_frame.ts — BUG-018 residual (c): the client-facing permission_changed
// WS frame.
//
// THE GAP: an autonomy transition is audibly + structurally SILENT to clients. applyPaneMode broadcasts
// settings_updated + terminals_updated on a successful switch (src/applyPaneMode.ts:206-207) but emits
// NO dedicated permission_changed frame, so the frontend has nothing to hang a distinct earcon (or a
// "mode changed" surface) on. Eyes-off, the operator cannot hear that autonomy actually changed.
//
// REQUIRED (post-fix) BEHAVIOR pinned here:
//   1. applyPaneMode emits a `permission_changed` frame ALONGSIDE settings_updated/terminals_updated on
//      a confirmed switch, carrying { paneId, from, to } where `from` is the PRE-change mode (fromMode
//      captured at src/applyPaneMode.ts:175, before term.permissionsMode is reassigned) and `to` is the
//      target mode.
//   2. The frame is declared in the WS frame-contract catalog (src/frames/catalog.ts FRAME_SCHEMAS) so
//      validateFrame accepts it — the frame_contracts test (tests/test_frame_contracts.ts §1a/1b/1c)
//      requires every emitted+consumed frame to have a schema.
//   3. The frame type is a consumed observe-lane key (OBSERVE_FRAME_TYPES in
//      src/orbital/useOrbitalDataHelpers.ts), so §1b/§1c stay satisfied and the hook can ring a tone.
//   4. A gate that does NOT run (forbidden/deferred) emits NO permission_changed frame — the frame marks
//      a REAL applied change, never a queued/blocked one.
//
// These are RED until the fix lands. Pure: the scripted-pane + injected-deps idiom from
// tests/test_apply_pane_mode.ts (no server, no PTY, no Gemini).
//
// Runner: npx tsx --test --test-force-exit tests/test_permission_changed_frame.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { applyPaneMode, type PaneModeDeps, type PaneLike } from "../src/applyPaneMode";
import type { Mode } from "../src/agents";
import { ClaudeAdapter } from "../src/agents/claude";
import { PendingApprovalStore } from "../src/pendingApprovals";
import { PendingActionStore } from "../src/pendingActions";
import { FRAME_SCHEMAS, validateFrame } from "../src/frames/catalog";
import { OBSERVE_FRAME_TYPES } from "../src/orbital/useOrbitalDataHelpers";

// The Claude Full-Auto status-bar marker that drives parseCurrentMode past the read-after-write poll
// (pinned identically to tests/test_apply_pane_mode.ts:41).
const FULL_AUTO_MARKER = "⏵⏵ auto mode on";

/** A scripted fake pane (trimmed from tests/test_apply_pane_mode.ts:makeScriptedPane) — records writes
 *  and returns a fixture status frame once a write has landed so the live-signal loop converges. */
function makeScriptedPane(opts: { permissionsMode?: Mode; frameAfterWrite?: string }): PaneLike & { writes: string[] } {
  const writes: string[] = [];
  let landed = false;
  return {
    adapter: new ClaudeAdapter(),
    permissionsMode: opts.permissionsMode ?? "Human-in-the-Loop",
    sessionId: "",
    shellCmd: "claude",
    writes,
    writeRaw(bytes: string) { writes.push(bytes); landed = true; },
    getRecentOutput() { return landed ? (opts.frameAfterWrite ?? "") : ""; },
    async stop() {},
    start() {},
  };
}

const allowGate: PaneModeDeps["gateOrDefer"] = (_c, _p, _s, run) => { run(); return { disposition: "run" }; };

function baseDeps(over: Partial<PaneModeDeps> = {}): PaneModeDeps {
  return {
    gateOrDefer: allowGate,
    pendingApprovals: new PendingApprovalStore(null),
    pendingActions: new PendingActionStore(null),
    broadcast: () => {},
    persistMode: () => {},
    readAfterWriteTimeoutMs: 200,
    readAfterWritePollMs: 5,
    ...over,
  };
}

describe("BUG-018 permission_changed — the frame is declared in the WS frame-contract catalog", () => {
  it("FRAME_SCHEMAS has a permission_changed schema", () => {
    assert.ok(Object.hasOwn(FRAME_SCHEMAS, "permission_changed"),
      "src/frames/catalog.ts FRAME_SCHEMAS must declare a permission_changed schema");
  });

  it("validateFrame accepts a well-formed permission_changed frame", () => {
    assert.doesNotThrow(() =>
      validateFrame({ type: "permission_changed", paneId: "p1", from: "Human-in-the-Loop", to: "Full Auto" }));
  });

  it("permission_changed is a consumed observe-lane frame type (OBSERVE_FRAME_TYPES)", () => {
    assert.ok((OBSERVE_FRAME_TYPES as readonly string[]).includes("permission_changed"),
      "useOrbitalDataHelpers OBSERVE_FRAME_TYPES must list permission_changed so the hook consumes+rings it");
  });
});

describe("BUG-018 permission_changed — applyPaneMode emits it on a confirmed switch", () => {
  it("a live-signal promotion broadcasts permission_changed { paneId, from, to }", async () => {
    const pane = makeScriptedPane({ permissionsMode: "Human-in-the-Loop", frameAfterWrite: `banner\n${FULL_AUTO_MARKER}\n> ` });
    const frames: any[] = [];
    const res = await applyPaneMode("pane_pc", "Full Auto", "voice", pane, baseDeps({ broadcast: (m) => frames.push(m) }));
    assert.strictEqual(res.ok, true, "the switch confirmed");

    const pc = frames.find((m) => m.type === "permission_changed");
    assert.ok(pc, "a permission_changed frame is broadcast alongside settings_updated/terminals_updated");
    assert.strictEqual(pc.paneId, "pane_pc", "frame carries the paneId");
    assert.strictEqual(pc.from, "Human-in-the-Loop", "frame's `from` is the PRE-change mode (fromMode)");
    assert.strictEqual(pc.to, "Full Auto", "frame's `to` is the target mode");
  });

  it("the frame rides the SAME success as settings_updated/terminals_updated (all three present)", async () => {
    const pane = makeScriptedPane({ frameAfterWrite: FULL_AUTO_MARKER });
    const frames: any[] = [];
    await applyPaneMode("pane_trio", "Full Auto", "voice", pane, baseDeps({ broadcast: (m) => frames.push(m) }));
    const types = frames.map((m) => m.type);
    for (const t of ["settings_updated", "terminals_updated", "permission_changed"]) {
      assert.ok(types.includes(t), `${t} broadcast on a confirmed switch (got: ${types.join(", ")})`);
    }
  });

  it("a FORBIDDEN gate emits NO permission_changed frame (marks a real applied change only)", async () => {
    const pane = makeScriptedPane({ frameAfterWrite: FULL_AUTO_MARKER });
    const frames: any[] = [];
    const forbid: PaneModeDeps["gateOrDefer"] = () => ({ disposition: "forbidden" });
    const res = await applyPaneMode("pane_off", "Full Auto", "voice", pane, baseDeps({ gateOrDefer: forbid, broadcast: (m) => frames.push(m) }));
    assert.strictEqual(res.ok, false);
    assert.ok(!frames.some((m) => m.type === "permission_changed"), "no permission_changed on a forbidden (never-applied) change");
  });

  // The spec is "confirmed applied switch ONLY — never on a forbidden OR deferred gate." A DEFERRED
  // gate stashes the run closure for a later operator confirm and never runs execute() now, so no
  // frame may broadcast at deferral time. This pins the other half of the "real applied change only"
  // invariant, guarding against an emit placed OUTSIDE execute()'s success block.
  it("a DEFERRED gate emits NO permission_changed frame (queued, not yet applied)", async () => {
    const pane = makeScriptedPane({ frameAfterWrite: FULL_AUTO_MARKER });
    const frames: any[] = [];
    const defer: PaneModeDeps["gateOrDefer"] = () => ({ disposition: "deferred", actionId: "act_pc", summary: "Set pane pane_def permissions to Full Auto" });
    const res = await applyPaneMode("pane_def", "Full Auto", "voice", pane, baseDeps({ gateOrDefer: defer, broadcast: (m) => frames.push(m) }));
    assert.strictEqual(res.ok, false);
    assert.ok(!frames.some((m) => m.type === "permission_changed"), "no permission_changed on a deferred (not-yet-applied) change");
  });
});
