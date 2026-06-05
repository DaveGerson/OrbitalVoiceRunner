// P4 — the live mode-switch choke point (applyPaneMode), the per-pane drain helpers, and the
// restart_pane voice tool (multi-cli adapter spec §6, §11; bead wsm-e2e-pinned-1y8).
//
// THE BUG (B1 / bead 1y8): setPermissionsMode() only mutates the NEXT spawn's command string; the
// RUNNING process is unaffected, so a Full-Auto promotion never reaches the live pane. The fix is a
// single async choke point — applyPaneMode — that EVERY mode-change caller (voice set_pane_permissions,
// voice restart_pane, the UI <select>) routes through. It:
//   1. gates on "set_pane_permissions" (it IS a lock change);
//   2. asks the pane's adapter how to change the mode (planModeChange):
//        - live-signal    => writeRaw(step.bytes) then READ-AFTER-WRITE (parseCurrentMode, bounded
//                            timeout) — never blind cycle-counting;
//        - restart-resume => rebuild shellCmd from adapter.buildResumeCommand, await stop(); start();
//        - unsupported    => Custom has no permission model;
//   3. on promotion to Full Auto, DRAINS pending approvals + pending actions FOR THAT PANE (§11);
//   4. persists the mode (persist-wins) + broadcasts settings_updated / terminals_updated.
//
// These tests use injected SEAMS only (no real CLI, no real PTY, no Gemini): a scripted fake pane that
// records writeRaw bytes + stop/start order and exposes a fixture status frame, a fake gate, and the
// real PendingApprovalStore / PendingActionStore drain helpers. We do NOT depend on real CLI status
// strings (unknown — verification bead); the fixture marker drives the read-after-write loop.
//
// Runner: npx tsx --test --test-force-exit tests/test_apply_pane_mode.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { applyPaneMode, type PaneModeDeps, type PaneLike } from "../src/applyPaneMode";
import type { Mode } from "../src/agents";
import { ClaudeAdapter } from "../src/agents/claude";
import { CodexAdapter } from "../src/agents/codex";
import { CustomAdapter } from "../src/agents/custom";
import { PendingApprovalStore } from "../src/pendingApprovals";
import { PendingActionStore } from "../src/pendingActions";

// Shift+Tab = ESC [ Z = 0x1b 0x5b 0x5a — Claude's live mode-cycle key.
const SHIFT_TAB = "\x1b\x5b\x5a";
// A fixture status-bar marker the ClaudeAdapter.parseCurrentMode recognizes as Full Auto.
const FULL_AUTO_MARKER = "⏵⏵ accept edits on";

/**
 * A scripted fake pane that records every writeRaw byte, the stop->start ORDER, and lets a test
 * stage the status frame getRecentOutput() returns AFTER the first writeRaw (so the read-after-write
 * loop converges on a fixture marker). Implements exactly the PaneLike surface applyPaneMode touches.
 */
function makeScriptedPane(opts: {
  adapter: PaneLike["adapter"];
  permissionsMode?: Mode;
  sessionId?: string;
  /** The frame getRecentOutput returns once a writeRaw has landed (drives read-after-write). */
  frameAfterWrite?: string;
}): PaneLike & {
  writes: string[];
  lifecycle: string[];
  shellCmd: string;
} {
  const writes: string[] = [];
  const lifecycle: string[] = [];
  let landed = false;
  return {
    adapter: opts.adapter,
    permissionsMode: opts.permissionsMode ?? "Human-in-the-Loop",
    sessionId: opts.sessionId ?? "",
    shellCmd: "claude",
    writes,
    lifecycle,
    writeRaw(bytes: string) {
      writes.push(bytes);
      landed = true;
    },
    getRecentOutput() {
      return landed ? (opts.frameAfterWrite ?? "") : "";
    },
    async stop() {
      lifecycle.push("stop");
    },
    start() {
      lifecycle.push("start");
    },
  };
}

/** A gate seam that always allows (the run closure executes inline). */
const allowGate: PaneModeDeps["gateOrDefer"] = (_cap, _pane, _summary, run) => {
  run();
  return { disposition: "run" };
};

/** Minimal deps with no-op broadcast + persist + a tiny read-after-write budget for fast tests. */
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

describe("applyPaneMode — the live mode-switch choke point (spec §6, bead 1y8)", () => {
  // ── live-signal (Claude): writeRaw steps + read-after-write to a FIXTURE marker ──────────────
  it("Claude live-signal drives writeRaw(ESC[Z) and converges read-after-write on the fixture marker", async () => {
    const pane = makeScriptedPane({
      adapter: new ClaudeAdapter(),
      permissionsMode: "Human-in-the-Loop",
      frameAfterWrite: `some banner\n${FULL_AUTO_MARKER}\n> `,
    });
    const broadcasts: any[] = [];
    const res = await applyPaneMode(
      "pane_live",
      "Full Auto",
      "voice",
      pane,
      baseDeps({ broadcast: (m) => broadcasts.push(m) }),
    );

    assert.strictEqual(res.ok, true, "live-signal path resolves ok");
    assert.strictEqual(res.kind, "live-signal");
    assert.deepStrictEqual(
      pane.writes,
      [SHIFT_TAB],
      "the Claude live-signal wrote exactly the ESC[Z ring step (0x1b 0x5b 0x5a)",
    );
    assert.deepStrictEqual(
      [...pane.writes[0]].map((c) => c.charCodeAt(0)),
      [0x1b, 0x5b, 0x5a],
      "raw bytes are Shift+Tab",
    );
    assert.strictEqual(pane.permissionsMode, "Full Auto", "the pane's mode reached Full Auto");
    assert.strictEqual(pane.lifecycle.length, 0, "live-signal never restarts the process (no stop/start)");
    assert.ok(
      broadcasts.some((m) => m.type === "settings_updated"),
      "settings_updated broadcast on success",
    );
    assert.ok(
      broadcasts.some((m) => m.type === "terminals_updated"),
      "terminals_updated broadcast on success",
    );
  });

  it("live-signal that never reaches the marker reports a timeout (not a false success)", async () => {
    const pane = makeScriptedPane({
      adapter: new ClaudeAdapter(),
      frameAfterWrite: "no status bar here\n> ", // parseCurrentMode never returns Full Auto
    });
    const res = await applyPaneMode("pane_to", "Full Auto", "voice", pane, baseDeps());
    assert.strictEqual(res.ok, false, "an unconfirmed live switch is NOT reported as success");
    assert.strictEqual(res.kind, "live-signal");
    assert.match(String(res.reason), /confirm|timeout|read/i, "reason names the read-after-write failure");
  });

  // ── restart-resume (Codex/agy): rebuild shellCmd + stop->start in ORDER ──────────────────────
  it("Codex restart-resume rebuilds the launch command and calls stop -> start (in order)", async () => {
    const pane = makeScriptedPane({
      adapter: new CodexAdapter(),
      permissionsMode: "Human-in-the-Loop",
      sessionId: "rollout-abc-123",
    });
    const res = await applyPaneMode("pane_codex", "Full Auto", "restart_pane", pane, baseDeps());

    assert.strictEqual(res.ok, true, "restart-resume resolves ok");
    assert.strictEqual(res.kind, "restart-resume");
    assert.deepStrictEqual(pane.lifecycle, ["stop", "start"], "stop ran BEFORE start (lossless restart-resume)");
    assert.strictEqual(pane.writes.length, 0, "restart-resume never writes a live signal");
    assert.ok(
      pane.shellCmd.includes("rollout-abc-123"),
      `the rebuilt shellCmd resumes the captured session: ${pane.shellCmd}`,
    );
    assert.ok(
      pane.shellCmd.includes("--dangerously-bypass-approvals-and-sandbox"),
      `the rebuilt shellCmd re-arms Codex's OWN bypass (not Claude's flag): ${pane.shellCmd}`,
    );
    assert.strictEqual(pane.permissionsMode, "Full Auto", "the pane's persisted mode reached Full Auto");
  });

  // ── unsupported (Custom): no permission model ────────────────────────────────────────────────
  it("Custom => unsupported: no writes, no restart, ok:false with a clear reason", async () => {
    const pane = makeScriptedPane({ adapter: new CustomAdapter() });
    const res = await applyPaneMode("pane_custom", "Full Auto", "ui", pane, baseDeps());
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.kind, "unsupported");
    assert.strictEqual(pane.writes.length, 0, "no live signal on an unsupported pane");
    assert.strictEqual(pane.lifecycle.length, 0, "no restart on an unsupported pane");
  });

  // ── gate forbidden / deferred honored ────────────────────────────────────────────────────────
  it("gate forbidden short-circuits — no writes, no restart, ok:false kind:forbidden", async () => {
    const pane = makeScriptedPane({ adapter: new ClaudeAdapter(), frameAfterWrite: FULL_AUTO_MARKER });
    const forbidGate: PaneModeDeps["gateOrDefer"] = () => ({ disposition: "forbidden" });
    const res = await applyPaneMode("pane_off", "Full Auto", "voice", pane, baseDeps({ gateOrDefer: forbidGate }));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.kind, "forbidden");
    assert.strictEqual(pane.writes.length, 0, "a forbidden gate never reaches the live process");
    assert.strictEqual(pane.lifecycle.length, 0, "a forbidden gate never restarts the process");
  });

  it("gate deferred (Ask) does NOT execute now — no writes, no restart, kind:deferred", async () => {
    const pane = makeScriptedPane({ adapter: new ClaudeAdapter(), frameAfterWrite: FULL_AUTO_MARKER });
    const deferGate: PaneModeDeps["gateOrDefer"] = (_cap, _pane, summary) => ({
      disposition: "deferred",
      actionId: "act_defer",
      summary,
    });
    const res = await applyPaneMode("pane_ask", "Full Auto", "voice", pane, baseDeps({ gateOrDefer: deferGate }));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.kind, "deferred");
    assert.strictEqual(pane.writes.length, 0, "a deferred change waits for operator confirm — no live write now");
    assert.strictEqual(pane.lifecycle.length, 0, "no restart until the deferred action is confirmed");
  });

  // ── drain-on-promotion: ONLY that pane (spec §11) ────────────────────────────────────────────
  it("Full-Auto promotion drains pending approvals + actions for ONLY the promoted pane", async () => {
    const approvals = new PendingApprovalStore(null);
    const actions = new PendingActionStore(null);
    const fakeSession = { sendClientContent() {} };

    // Two approvals on the promoted pane, one on a different pane.
    approvals.add(
      { messageId: "ap_keep_a", instruction: "echo a", kind: "agent_instruction", terminalId: "pane_promo", callId: "ap_keep_a", timestamp: Date.now() } as any,
      fakeSession as any,
    );
    approvals.add(
      { messageId: "ap_keep_b", instruction: "echo b", kind: "agent_instruction", terminalId: "pane_promo", callId: "ap_keep_b", timestamp: Date.now() } as any,
      fakeSession as any,
    );
    approvals.add(
      { messageId: "ap_other", instruction: "echo o", kind: "agent_instruction", terminalId: "pane_other", callId: "ap_other", timestamp: Date.now() } as any,
      fakeSession as any,
    );

    // Two actions targeting the promoted pane (params.paneId), one targeting another pane.
    let ran = 0;
    actions.add({ id: "act_p1", capability: "set_pane_permissions", summary: "x", timestamp: Date.now(), params: { paneId: "pane_promo" }, run: () => { ran++; return "x"; } });
    actions.add({ id: "act_p2", capability: "write_to_pane", summary: "y", timestamp: Date.now(), params: { paneId: "pane_promo" }, run: () => { ran++; return "y"; } });
    actions.add({ id: "act_other", capability: "write_to_pane", summary: "z", timestamp: Date.now(), params: { paneId: "pane_other" }, run: () => { ran++; return "z"; } });

    const drainBroadcasts: any[] = [];
    const pane = makeScriptedPane({ adapter: new ClaudeAdapter(), frameAfterWrite: FULL_AUTO_MARKER });

    const res = await applyPaneMode(
      "pane_promo",
      "Full Auto",
      "voice",
      pane,
      baseDeps({
        pendingApprovals: approvals,
        pendingActions: actions,
        broadcast: (m: any) => drainBroadcasts.push(m),
      }),
    );
    assert.strictEqual(res.ok, true);

    // Approvals: the two on pane_promo are gone; the other pane's survives.
    assert.strictEqual(approvals.has("ap_keep_a"), false, "promoted pane's approval drained");
    assert.strictEqual(approvals.has("ap_keep_b"), false, "promoted pane's second approval drained");
    assert.strictEqual(approvals.has("ap_other"), true, "OTHER pane's approval is untouched");

    // Each drained approval broadcasts approval_resolved keyed by messageId.
    for (const id of ["ap_keep_a", "ap_keep_b"]) {
      assert.ok(
        drainBroadcasts.some((m) => m.type === "approval_resolved" && m.messageId === id),
        `approval_resolved broadcast for drained ${id}`,
      );
    }
    assert.ok(
      !drainBroadcasts.some((m) => m.type === "approval_resolved" && m.messageId === "ap_other"),
      "no approval_resolved for the untouched other-pane approval",
    );

    // Actions: the two on pane_promo are cancelled (NOT run — promotion means the agent self-approves);
    // the other pane's survives.
    assert.strictEqual(actions.has("act_p1"), false, "promoted pane's action drained");
    assert.strictEqual(actions.has("act_p2"), false, "promoted pane's second action drained");
    assert.strictEqual(actions.has("act_other"), true, "OTHER pane's action is untouched");
    assert.strictEqual(ran, 0, "drained actions are CANCELLED, never run");
  });

  it("a NON-Full-Auto change (revert) does NOT drain pending", async () => {
    const approvals = new PendingApprovalStore(null);
    const fakeSession = { sendClientContent() {} };
    approvals.add(
      { messageId: "ap_x", instruction: "echo", kind: "agent_instruction", terminalId: "pane_rev", callId: "ap_x", timestamp: Date.now() } as any,
      fakeSession as any,
    );
    // Reverting Claude to Read-Only is a live-signal too; stage a frame the Read-Only parse accepts is
    // unnecessary — assert only that the pending is NOT drained regardless of switch outcome.
    const pane = makeScriptedPane({ adapter: new ClaudeAdapter(), permissionsMode: "Full Auto", frameAfterWrite: "plan mode" });
    await applyPaneMode("pane_rev", "Read-Only", "voice", pane, baseDeps({ pendingApprovals: approvals }));
    assert.strictEqual(approvals.has("ap_x"), true, "drain happens ONLY on promotion to Full Auto");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The per-pane drain HELPERS on the two stores (spec §11). Unit-tested directly.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("PendingApprovalStore.drainForPane (spec §11)", () => {
  it("removes ONLY the target pane's approvals and returns the drained records", () => {
    const store = new PendingApprovalStore(null);
    const sess = { sendClientContent() {} };
    store.add({ messageId: "a", instruction: "1", kind: "agent_instruction", terminalId: "P", callId: "a", timestamp: 1 } as any, sess as any);
    store.add({ messageId: "b", instruction: "2", kind: "agent_instruction", terminalId: "P", callId: "b", timestamp: 2 } as any, sess as any);
    store.add({ messageId: "c", instruction: "3", kind: "agent_instruction", terminalId: "Q", callId: "c", timestamp: 3 } as any, sess as any);

    const drained = store.drainForPane("P");
    assert.deepStrictEqual(drained.map((r) => r.messageId).sort(), ["a", "b"], "returns the two P records");
    assert.strictEqual(store.has("a"), false);
    assert.strictEqual(store.has("b"), false);
    assert.strictEqual(store.has("c"), true, "Q's approval is untouched");
  });

  it("returns [] for a pane with no pending approvals", () => {
    const store = new PendingApprovalStore(null);
    assert.deepStrictEqual(store.drainForPane("none"), []);
  });
});

describe("PendingActionStore.drainForPane (spec §11)", () => {
  it("cancels ONLY the target pane's actions (never runs them) and returns the drained records", () => {
    const store = new PendingActionStore(null);
    let ran = 0;
    store.add({ id: "a", capability: "write_to_pane", summary: "x", timestamp: 1, params: { paneId: "P" }, run: () => { ran++; return ""; } });
    store.add({ id: "b", capability: "write_to_pane", summary: "y", timestamp: 2, params: { paneId: "P" }, run: () => { ran++; return ""; } });
    store.add({ id: "c", capability: "write_to_pane", summary: "z", timestamp: 3, params: { paneId: "Q" }, run: () => { ran++; return ""; } });

    const drained = store.drainForPane("P");
    assert.deepStrictEqual(drained.map((r) => r.id).sort(), ["a", "b"]);
    assert.strictEqual(store.has("a"), false);
    assert.strictEqual(store.has("b"), false);
    assert.strictEqual(store.has("c"), true, "Q's action is untouched");
    assert.strictEqual(ran, 0, "drained actions are CANCELLED, never run");
  });

  it("ignores actions whose params carry no paneId", () => {
    const store = new PendingActionStore(null);
    store.add({ id: "g", capability: "set_global_permissions", summary: "global", timestamp: 1, params: { permissionsMode: "Full Auto" }, run: () => "" });
    const drained = store.drainForPane("P");
    assert.deepStrictEqual(drained, [], "a global (no paneId) action is never pane-drained");
    assert.strictEqual(store.has("g"), true);
  });

  it("returns [] for a pane with no pending actions", () => {
    const store = new PendingActionStore(null);
    assert.deepStrictEqual(store.drainForPane("none"), []);
  });
});
