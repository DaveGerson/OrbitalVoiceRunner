// tests/test_confirm_path_override_rider.ts — BUG-003 completeness (FB): the global-override honesty
// rider on the DEFAULT deferred paths.
//
// THE DEFECT the first BUG-003 fix MISSED: set_pane_permissions defaults to capability gate "Ask", so
// the COMMON flow is propose → defer → operator confirms → the change applies AT CONFIRM TIME. The
// confirm-time and post-restart-replay success strings did NOT carry the global-override rider the
// immediate (Auto) path grew, so an operator who confirms "lock down the deploy pane" while the GLOBAL
// mode is Full Auto hears an unqualified success at the exact moment the change applies — even though
// the non-Inherit global mode silently nullifies its gating effect.
//
// COVERED HERE (all RED before the FB fix, GREEN after):
//   (1) the live choke-point CONFIRM path (src/applyPaneMode.ts syncRun, replayed at operator confirm)
//       — global != Inherit rides the rider; global == Inherit stays byte-clean.
//   (2) the post-restart REPLAY effects (src/actionEffects.ts buildActionRun) for BOTH shapes — the
//       applyPaneMode-shaped intent (has `source`) AND the legacy locks.ts-shaped intent (has
//       `projectId`, no `source`) — global != Inherit rides the rider; global == Inherit stays clean.
//
// The rider wording is the SINGLE shared leaf (src/globalOverrideRider.ts), identical to the immediate
// path pinned in tests/test_global_override_rider.ts. Pure: injected seams + a fake deps bag, no server,
// no PTY (mirrors tests/test_apply_pane_mode.ts + tests/test_actionEffects.ts idioms).
//
// Runner: npx tsx --test --test-force-exit tests/test_confirm_path_override_rider.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { applyPaneMode, type PaneModeDeps, type PaneLike } from "../src/applyPaneMode";
import type { Mode } from "../src/agents";
import { ClaudeAdapter } from "../src/agents/claude";
import { PendingApprovalStore } from "../src/pendingApprovals";
import { PendingActionStore } from "../src/pendingActions";
import { buildActionRun } from "../src/actionEffects";

// A global mode DIFFERENT from the requested pane mode, so its appearance in the output can ONLY come
// from the rider (the pane target is Full Auto). Mirrors the convention in test_global_override_rider.ts.
const GLOBAL = "Read-Only";
const TARGET: Mode = "Full Auto";
const FULL_AUTO_MARKER = "⏵⏵ auto mode on"; // the fixture frame ClaudeAdapter.parseCurrentMode accepts.

/** Assert `out` carries the required rider semantics for a non-Inherit `globalName` global mode. */
function assertRider(out: string, globalName: string): void {
  const lo = out.toLowerCase();
  assert.ok(out.includes(globalName), `rider NAMES the current global mode (${globalName}): ${out}`);
  assert.ok(lo.includes("global"), `rider mentions the GLOBAL mode as the dominating cause: ${out}`);
  assert.ok(lo.includes("inherit"), `rider tells the operator to return global to Inherit: ${out}`);
  assert.ok(/no .{0,24}effect/.test(lo), `rider states the pane change has NO gating effect: ${out}`);
}

// ── (1) the live choke-point CONFIRM path (src/applyPaneMode.ts syncRun) ───────────────────────────

/** A scripted pane that converges the live-signal read-after-write on the fixture marker. */
function makePane(): PaneLike & { writes: string[] } {
  const writes: string[] = [];
  let landed = false;
  return {
    adapter: new ClaudeAdapter(),
    permissionsMode: "Human-in-the-Loop",
    sessionId: "",
    shellCmd: "claude",
    writes,
    writeRaw(bytes: string) { writes.push(bytes); landed = true; },
    getRecentOutput() { return landed ? `banner\n${FULL_AUTO_MARKER}\n> ` : ""; },
    async stop() {},
    start() {},
  };
}

/**
 * A defer gate that CAPTURES the run() closure (as the real gateOrDefer does when it stages the Ask
 * deferral) and returns disposition:"deferred" WITHOUT running it now. Invoking the captured closure
 * later is exactly what pendingActions.confirm(actionId) does at operator-confirm time — so its return
 * value IS the confirm-time success string the operator hears.
 */
function capturingDeferGate(): { gate: PaneModeDeps["gateOrDefer"]; confirm: () => string } {
  let captured: (() => string) | null = null;
  const gate: PaneModeDeps["gateOrDefer"] = (_cap, _pane, summary, run) => {
    captured = run;
    return { disposition: "deferred", actionId: "act_confirm", summary };
  };
  return { gate, confirm: () => (captured ? captured() : "<<run never captured>>") };
}

function confirmDeps(over: Partial<PaneModeDeps>): PaneModeDeps {
  return {
    gateOrDefer: over.gateOrDefer!,
    pendingApprovals: new PendingApprovalStore(null),
    pendingActions: new PendingActionStore(null),
    broadcast: () => {},
    persistMode: () => {},
    readAfterWriteTimeoutMs: 200,
    readAfterWritePollMs: 5,
    ...over,
  };
}

describe("BUG-003 FB — confirm-time apply path (applyPaneMode syncRun) rides the global-override rider", () => {
  it("global != Inherit → the confirm-time success string carries the rider", async () => {
    const { gate, confirm } = capturingDeferGate();
    const res = await applyPaneMode(
      "pane_conf",
      TARGET,
      "voice",
      makePane(),
      confirmDeps({ gateOrDefer: gate, getGlobalPermissionsMode: () => GLOBAL }),
    );
    assert.strictEqual(res.kind, "deferred", "the default Ask tier defers — no apply yet");
    // Operator confirms: the gate replays the stashed run() closure now.
    const spoken = confirm();
    assert.ok(spoken.startsWith("Setting pane pane_conf permissions to Full Auto."), `base confirm sentence preserved: ${spoken}`);
    assertRider(spoken, GLOBAL);
  });

  it("global == Inherit → the confirm-time success string stays byte-for-byte clean (no rider)", async () => {
    const { gate, confirm } = capturingDeferGate();
    const res = await applyPaneMode(
      "pane_conf_clean",
      TARGET,
      "voice",
      makePane(),
      confirmDeps({ gateOrDefer: gate, getGlobalPermissionsMode: () => "Inherit" }),
    );
    assert.strictEqual(res.kind, "deferred");
    const spoken = confirm();
    assert.strictEqual(spoken, "Setting pane pane_conf_clean permissions to Full Auto.", "Inherit confirm must stay clean");
    const lo = spoken.toLowerCase();
    assert.ok(!lo.includes("global") && !lo.includes("inherit"), "no rider text on a clean Inherit confirm");
  });

  it("getter unwired (default) → treated as Inherit → clean (no rider)", async () => {
    const { gate, confirm } = capturingDeferGate();
    await applyPaneMode("pane_conf_default", TARGET, "voice", makePane(), confirmDeps({ gateOrDefer: gate }));
    assert.strictEqual(confirm(), "Setting pane pane_conf_default permissions to Full Auto.", "an unwired getter never riders");
  });
});

// ── (2) the post-restart REPLAY effects (src/actionEffects.ts buildActionRun) ──────────────────────

/** A fake ActionEffectDeps whose manager exposes a settable globalPermissionsMode + the ledger slice
 *  the two set_pane_permissions replay builders touch (terminals, getProject, getActiveProject, save,
 *  updatePane). Mirrors tests/test_actionEffects.ts fakeDeps, trimmed to this capability. */
function replayDeps(globalMode: string) {
  const pane: any = { permissions_mode: "Human-in-the-Loop" };
  const ws: any = { id: "proj", panes: { pane_r: pane } };
  const manager: any = {
    globalPermissionsMode: globalMode,
    terminals: { pane_r: { setPermissionsMode() {} } },
    ledger: {
      getProject: (id: string) => (id === "proj" ? ws : null),
      getActiveProject: () => ws,
      updatePane: () => {},
      save: () => {},
    },
  };
  return { manager, deps: { manager, broadcast: () => {}, broadcastLedgerUpdate: () => {}, sanitizeSettingsForClient: (s: any) => s } };
}

describe("BUG-003 FB — restart-replay effects (buildActionRun) ride the global-override rider", () => {
  it("applyPaneMode-shaped intent (has `source`) + global != Inherit → rider on the rebuilt string", () => {
    const { deps } = replayDeps(GLOBAL);
    const out = buildActionRun(
      { capability: "set_pane_permissions", params: { paneId: "pane_r", permissionsMode: TARGET, source: "voice" } },
      deps as any,
    )();
    assert.ok(out.includes("updated to Full Auto"), `base success sentence preserved: ${out}`);
    assert.ok(/applied after a restart/i.test(out), `restart caveat preserved: ${out}`);
    assertRider(out, GLOBAL);
  });

  it("legacy locks.ts-shaped intent (has `projectId`, no `source`) + global != Inherit → rider on the rebuilt string", () => {
    const { deps } = replayDeps(GLOBAL);
    const out = buildActionRun(
      { capability: "set_pane_permissions", params: { paneId: "pane_r", projectId: "proj", permissionsMode: TARGET } },
      deps as any,
    )();
    assert.ok(out.includes("updated to Full Auto successfully."), `legacy "successfully." sentence preserved: ${out}`);
    assertRider(out, GLOBAL);
  });

  it("legacy-shaped intent + global == Inherit → byte-for-byte clean (no rider)", () => {
    const { deps } = replayDeps("Inherit");
    const out = buildActionRun(
      { capability: "set_pane_permissions", params: { paneId: "pane_r", projectId: "proj", permissionsMode: TARGET } },
      deps as any,
    )();
    assert.strictEqual(out, "Safety permission mode for pane pane_r updated to Full Auto successfully.", "Inherit replay must stay clean");
  });

  it("applyPaneMode-shaped intent + global == Inherit → no rider (clean restart caveat)", () => {
    const { deps } = replayDeps("Inherit");
    const out = buildActionRun(
      { capability: "set_pane_permissions", params: { paneId: "pane_r", permissionsMode: TARGET, source: "voice" } },
      deps as any,
    )();
    const lo = out.toLowerCase();
    assert.ok(!lo.includes("heads up") && !lo.includes("no gating effect"), `no rider on a clean Inherit replay: ${out}`);
  });
});
