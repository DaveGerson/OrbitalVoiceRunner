import { test } from "node:test";
import assert from "node:assert";
import type { ActionContext } from "../src/actions/types";
import { closePane } from "../src/actions/defs/panes_write";

// wsm-e2e-pinned-5h0 (A-voice): close_pane terminates + archives a pane (recoverable), gated Ask by
// default — the voice path the operator's "exit it and archive it" should route to (instead of
// degrading to a shell `exit`). Unit-pins the three gate dispositions + that the Auto effect calls
// the EXISTING manager.stopAndArchivePane and clears the active-pane WRITE pointer when the closing
// pane was the active one (so a stale pointer can't refuse the operator's next command).

interface Spy {
  stopArchiveCalls: Array<{ projectId: string; paneId: string }>;
  activated: string | null;
  broadcasts: any[];
}

function freshSpy(active: string | null = null): Spy {
  return { stopArchiveCalls: [], activated: active, broadcasts: [] };
}

function makeCtx(disposition: "run" | "deferred" | "forbidden", spy: Spy, activePane: string | null): ActionContext {
  const ctx: Partial<ActionContext> = {
    manager: {
      ledger: { getActiveProject: () => ({ id: "p" }) },
      stopAndArchivePane: (projectId: string, paneId: string) => {
        spy.stopArchiveCalls.push({ projectId, paneId });
        return Promise.resolve(true);
      },
    } as unknown as ActionContext["manager"],
    gateOrDefer: (_cap, _pane, summary) =>
      disposition === "run"
        ? { disposition: "run" }
        : disposition === "forbidden"
        ? { disposition: "forbidden" }
        : { disposition: "deferred", actionId: "act_x", summary },
    broadcast: (m: any) => spy.broadcasts.push(m),
    broadcastLedgerUpdate: () => {},
    broadcastTerminalsUpdated: () => {},
    setActivePane: (id) => { spy.activated = id; },
    getActivePaneId: () => activePane,
  };
  return ctx as ActionContext;
}

test("close_pane (Auto) terminates + archives the named pane via manager.stopAndArchivePane", async () => {
  const spy = freshSpy("other");
  const ctx = makeCtx("run", spy, "other");
  const res = await closePane.handler({ pane_id: "doomed", project_id: "p" } as never, ctx);
  assert.strictEqual(res.kind, "ok");
  assert.strictEqual(spy.stopArchiveCalls.length, 1, "an Auto close runs the effect exactly once");
  assert.deepStrictEqual(spy.stopArchiveCalls[0], { projectId: "p", paneId: "doomed" });
});

test("close_pane (Auto) clears the active WRITE pointer when the closing pane was active", async () => {
  const spy = freshSpy("doomed");
  const ctx = makeCtx("run", spy, "doomed");
  await closePane.handler({ pane_id: "doomed", project_id: "p" } as never, ctx);
  assert.strictEqual(spy.activated, null, "the active pointer is cleared (the pane is going away)");
});

test("close_pane (Auto) leaves a DIFFERENT active pane untouched", async () => {
  const spy = freshSpy("keep");
  const ctx = makeCtx("run", spy, "keep");
  await closePane.handler({ pane_id: "doomed", project_id: "p" } as never, ctx);
  assert.strictEqual(spy.activated, "keep", "closing a non-active pane does not move focus");
});

test("close_pane (Ask) DEFERS — stages a confirmation and does NOT terminate the pane", async () => {
  const spy = freshSpy();
  const ctx = makeCtx("deferred", spy, null);
  const res = await closePane.handler({ pane_id: "doomed", project_id: "p" } as never, ctx);
  assert.strictEqual(res.kind, "ok");
  assert.match(String((res as any).output), /confirm/i, "the operator is asked to confirm");
  assert.strictEqual(spy.stopArchiveCalls.length, 0, "a deferred close must NOT terminate the pane");
});

test("close_pane (Off) is forbidden — no termination", async () => {
  const spy = freshSpy();
  const ctx = makeCtx("forbidden", spy, null);
  const res = await closePane.handler({ pane_id: "doomed", project_id: "p" } as never, ctx);
  assert.strictEqual(res.kind, "ok");
  assert.match(String((res as any).output), /Off|forbidden/i);
  assert.strictEqual(spy.stopArchiveCalls.length, 0, "an Off-gated close must NOT terminate the pane");
});
