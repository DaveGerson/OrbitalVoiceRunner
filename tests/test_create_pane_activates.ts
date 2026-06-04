import { test } from "node:test";
import assert from "node:assert";
import type { ActionContext } from "../src/actions/types";
import { createPane } from "../src/actions/defs/panes_write";

// ── Issue #2 (RCA: voice command never reaches a freshly-created pane) ──────────────────────────
// The single-active-pane WRITE gate (src/activePane.ts: isPaneActiveForWrite) refuses propose_command
// for any pane that is not the server's active write target (server.ts:2387 -> kind:"clarify", never
// writeInput). activePaneId is set ONLY by a UI focus message or switch_active_pane — create_pane
// never sets it. So a voice-created pane is NOT writable by the very next voice command: the command
// is clarified-away ("echoed, no output"), regardless of the PTY working.
//
// FIX CONTRACT: create_pane makes the newly-created pane the active write target (ctx.setActivePane),
// so the operator's immediate follow-up voice command lands in it (subject to the normal mode gate).

function runCtx(spy: { activated: string | null }): ActionContext {
  const ctx: Partial<ActionContext> = {
    manager: {
      settings: { presets: [], advanced: {} },
      ledger: {
        getProject: () => ({ panes: {} }),       // project exists -> no addProject needed
        addProject: () => {},
        workspaces: { p: { directory: "." } },
      },
      addTerminal: () => "Created terminal 'newpane'.",
    } as unknown as ActionContext["manager"],
    // Auto gate -> the handler runs createPaneEffect inline (mirrors the live server's Auto branch).
    gateOrDefer: () => ({ disposition: "run" }),
    broadcast: () => {},
    broadcastLedgerUpdate: () => {},
    broadcastTerminalsUpdated: () => {},
    setActivePane: (id) => { spy.activated = id; },
    getActivePaneId: () => spy.activated,
  };
  return ctx as ActionContext;
}

test("create_pane (Auto) sets the new pane as the active WRITE target", async () => {
  const spy = { activated: null as string | null };
  const ctx = runCtx(spy);
  const res = await createPane.handler(
    { project_id: "p", pane_id: "newpane", tool_preset: "Claude Code", permissions_mode: "Human-in-the-Loop" } as never,
    ctx,
  );
  assert.strictEqual(res.kind, "ok", "Auto create_pane returns ok");
  assert.strictEqual(
    spy.activated,
    "newpane",
    "create_pane must activate the new pane so the operator's next voice command can write to it",
  );
});
