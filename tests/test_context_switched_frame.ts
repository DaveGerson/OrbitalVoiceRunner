// tests/test_context_switched_frame.ts — BUG-012 (residual): after a voice `switch_context` the UI
// sidebar keeps highlighting the PREVIOUS project. Root cause: switch_context
// (src/actions/defs/orient.ts:139-171) emits only broadcastLedgerUpdate(); the classic UI's
// ledger_updated handler (src/appHelpers.ts:580) only calls setLedger, never setActiveProjectId,
// and there is no `context_switched` frame anywhere in source.
//
// REQUIRED post-fix behavior this suite pins (all node:test-safe — no React, no server boot):
//   (a) switch_context ADDITIONALLY broadcasts { type:"context_switched", activeProjectId } after
//       broadcastLedgerUpdate() — the ledger_updated frame is still emitted.
//   (b) src/appHelpers.ts WS_HANDLERS gains a `context_switched` handler that calls
//       ctx.setActiveProjectId(msg.activeProjectId) (WsHandlerCtx threads setActiveProjectId).
//   (c) The frame is REGISTERED in the src/frames/catalog.ts catalog (validateFrame accepts it) and
//       CONSUMED by a frontend surface (the WS_HANDLERS key) — the two invariants
//       tests/test_frame_contracts.ts §1a/§1c enforce for every emitted frame type.
//
// Runner: npx tsx --test --test-force-exit tests/test_context_switched_frame.ts

import { describe, it } from "node:test";
import assert from "node:assert";

import { switchContext } from "../src/actions/defs/orient";
import { WS_HANDLERS, dispatchWsMessage, type WsHandlerCtx } from "../src/appHelpers";
import { FRAME_SCHEMAS, validateFrame } from "../src/frames/catalog";
import type { ActionContext } from "../src/actions/types";

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (a) switch_context broadcasts a context_switched frame carrying the new activeProjectId — AFTER
//     the ledger_updated broadcast (so the client repaints the ledger first, then re-focuses).
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("switch_context — emits context_switched (BUG-012)", () => {
  function makeCtx(order: string[], frames: Array<Record<string, unknown>>): ActionContext {
    const manager = {
      refreshLedger: () => {},
      listPanes: () => [],
      settings: { projects: { activeContext: "", localWorkspacePath: "" } },
      saveSettings: () => {},
      ledger: {
        switchContext: (_id: string) => {},
        workspaces: { proj_b: { directory: "/tmp/proj_b" } },
        getProjectBriefing: (_id: string) => ({ project_id: "proj_b", panes: [], notes: [] }),
      },
    } as unknown as ActionContext["manager"];
    return {
      manager,
      broadcastLedgerUpdate: () => { order.push("ledger_updated"); },
      broadcast: (msg: Record<string, unknown>) => {
        order.push(String(msg.type));
        frames.push(msg);
      },
      effectiveCapabilityGateFor: () => "Auto",
      injectMemoryBrief: () => {},
      // WS3 (voice-followups-tdd): switch_context now consults the focused-pane seam to detect a
      // stale focus (src/actions/defs/orient.ts resolveSwitchContextHonesty). This fixture has no
      // focused pane to begin with, so `null` keeps this suite's assertions (which predate WS3 and
      // don't exercise the honesty branch) unaffected.
      getActivePaneId: () => null,
    } as unknown as ActionContext;
  }

  it("broadcasts { type:'context_switched', activeProjectId } in addition to ledger_updated", () => {
    const order: string[] = [];
    const frames: Array<Record<string, unknown>> = [];
    const ctx = makeCtx(order, frames);

    const res = switchContext.handler({ project_id: "proj_b" }, ctx);
    assert.strictEqual((res as { kind: string }).kind, "ok", "switch_context still answers kind:ok");

    const cs = frames.find((f) => f.type === "context_switched");
    assert.ok(cs, "switch_context must broadcast a context_switched frame (none today)");
    assert.strictEqual(cs!.activeProjectId, "proj_b", "the frame carries the newly-active project id");
  });

  it("emits context_switched AFTER the ledger_updated broadcast (ordering)", () => {
    const order: string[] = [];
    const frames: Array<Record<string, unknown>> = [];
    const ctx = makeCtx(order, frames);

    switchContext.handler({ project_id: "proj_b" }, ctx);
    assert.ok(order.includes("ledger_updated"), "the ledger update still fires");
    assert.ok(order.includes("context_switched"), "the context_switched frame fires");
    assert.ok(
      order.indexOf("ledger_updated") < order.indexOf("context_switched"),
      `context_switched must follow the ledger update (order was: ${order.join(" -> ")})`,
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (b) the classic WS_HANDLERS route context_switched -> ctx.setActiveProjectId(msg.activeProjectId)
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("WS_HANDLERS — context_switched moves the sidebar focus (BUG-012)", () => {
  it("dispatchWsMessage(context_switched) calls setActiveProjectId with the frame's id", () => {
    let activeProjectId: string | null = null;
    let terminalId: string | null = null;
    const ctx = {
      setActiveProjectId: (id: string) => { activeProjectId = id; },
      setActiveTerminalId: (id: string) => { terminalId = id; },
      // handleEventBusFallback reads effectForEvent for UNMAPPED types; provide a no-op so the
      // pre-fix path (context_switched unmapped -> fallback) doesn't throw and simply no-ops.
      effectForEvent: () => null,
    } as unknown as WsHandlerCtx;

    dispatchWsMessage({ type: "context_switched", activeProjectId: "proj_b" }, ctx);
    assert.strictEqual(activeProjectId, "proj_b", "the server-originated context switch must move the UI's active project");
    // The pane-level focus is UI/other-frame driven; the context_switched handler must not clobber it.
    assert.strictEqual(terminalId, null, "context_switched drives the PROJECT focus, not the pane focus");
  });

  it("WS_HANDLERS has a context_switched entry (a frontend consumer for §1c)", () => {
    assert.ok(
      Object.prototype.hasOwnProperty.call(WS_HANDLERS, "context_switched"),
      "context_switched must be a first-class WS_HANDLERS key so dispatchWsMessage routes it (not the eventBus fallback)",
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (c) frame catalog registration — tests/test_frame_contracts.ts §1a requires every emitted frame
//     to have a catalog schema; validateFrame must accept the real shape.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("frame catalog — context_switched is registered (BUG-012)", () => {
  it("FRAME_SCHEMAS has a context_switched schema", () => {
    assert.ok(
      Object.prototype.hasOwnProperty.call(FRAME_SCHEMAS, "context_switched"),
      "context_switched must be added to src/frames/catalog.ts FRAME_SCHEMAS (with the EMITTED_FRAME_TYPES entry in test_frame_contracts.ts)",
    );
  });

  it("validateFrame accepts { type:'context_switched', activeProjectId }", () => {
    assert.doesNotThrow(() => validateFrame({ type: "context_switched", activeProjectId: "proj_b" }));
  });
});
