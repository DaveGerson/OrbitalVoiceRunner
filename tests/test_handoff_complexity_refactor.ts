// tests/test_handoff_complexity_refactor.ts — CHARACTERIZATION tests for the cyclomatic-complexity
// burndown refactor of src/actions/defs/handoff.ts. These pin the CURRENT observable outputs of the
// three over-limit handlers so the behaviour-preserving refactor (extract helpers / guard clauses)
// can be proven not to change a single wire shape, gate decision, or string.
//
//   - proposeHandoff.handler   (CC14): Off-veto, store-null, missing to_pane, the from_pane summary
//     fork (live pane vs history fallback), rationale redaction, and the success object shape.
//   - stageHandoff.handler     (CC11): Off-veto, store-null, not-found, target-exists guard, and the
//     secret-scan high(block)/low(warn)/none(plain) trifurcation.
//   - deliverHandoff.handler   (CC11): store-null, not-found, not-staged, deliver-time secret block,
//     and the deliver_now / await_approval / block / noop dispatch-outcome mapping.
//
// Written GREEN against the UNREFACTORED code FIRST (D-6), then kept green. PURE: imports the defs +
// ../src/terminal redaction; ctx is a hand-built stub (no PTY, no session, no server).
//
// Runner: npx tsx --test --test-force-exit tests/test_handoff_complexity_refactor.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  proposeHandoff,
  stageHandoff,
  deliverHandoff,
} from "../src/actions/defs/handoff";
import type { ActionContext, ActionResult, DispatchOutcome } from "../src/actions/types";

// ── A tiny in-memory handoff store + ctx stub (only the surface these three handlers touch). ──────
interface HandoffRow {
  id: string;
  state: string;
  to_pane: string;
  from_pane: string | null;
  kind: string;
  revision_count: number;
  composed_prompt: string;
  source_context: string;
  staged_at?: number | null;
  gate_approval_id?: string | null;
}

interface CtxOpts {
  gate?: "Auto" | "Ask" | "Off";
  store?: boolean;
  handoffs?: Record<string, HandoffRow>;
  terminals?: Record<string, { runtimeType?: string }>;
  paneSummary?: string;
  owningPane?: boolean; // findPaneOwningProject — but that reads manager; we route via terminals/ledger
  dispatchOutcome?: DispatchOutcome;
  activeProjectId?: string;
  recorded?: unknown[];
  stateChanges?: Array<{ id: string; state: string; opts?: unknown }>;
  broadcasts?: unknown[];
}

function makeCtx(opts: CtxOpts): ActionContext {
  const handoffs = opts.handoffs ?? {};
  const recorded = opts.recorded ?? [];
  const stateChanges = opts.stateChanges ?? [];
  const broadcasts = opts.broadcasts ?? [];
  const storeObj = opts.store === false ? null : {
    getHandoff: (id: string) => handoffs[id],
    createHandoff: (row: Partial<HandoffRow>) => {
      const h: HandoffRow = {
        id: "h_new",
        state: row.state ?? "composing",
        to_pane: row.to_pane ?? "",
        from_pane: row.from_pane ?? null,
        kind: row.kind ?? "agent_instruction",
        revision_count: 0,
        composed_prompt: row.composed_prompt ?? "",
        source_context: row.source_context ?? "",
      };
      handoffs[h.id] = h;
      return h;
    },
    updateHandoffState: (id: string, state: string, o?: unknown) => {
      stateChanges.push({ id, state, opts: o });
      if (handoffs[id]) handoffs[id].state = state;
      return handoffs[id];
    },
    setGateApprovalId: (id: string, gid: string) => { if (handoffs[id]) handoffs[id].gate_approval_id = gid; },
    recordActivity: (r: unknown) => { recorded.push(r); },
  };

  return {
    manager: {
      terminals: opts.terminals ?? {},
      getPaneSummary: (_id: string, _n?: number) => opts.paneSummary ?? "",
      ledger: {
        activeProjectId: opts.activeProjectId ?? "proj1",
        getProject: (_id: string) => (opts.owningPane ? { id: _id, panes: { } } : undefined),
        workspaces: [],
      },
    } as unknown as ActionContext["manager"],
    session: null,
    store: storeObj as unknown as ActionContext["store"],
    effectiveCapabilityGateFor: () => opts.gate ?? "Auto",
    isFrozen: () => false,
    broadcast: (m) => { broadcasts.push(m); },
    broadcastLedgerUpdate: () => { broadcasts.push({ ledger: true }); },
    dispatchProposal: () => opts.dispatchOutcome ?? { kind: "executed", text: "executed" },
    redact: (s) => s,
    pendingApprovals: { has: () => false } as unknown as ActionContext["pendingApprovals"],
    applyResolution: () => ({ reason: "ok", doWrite: true }) as unknown as ReturnType<ActionContext["applyResolution"]>,
    callId: "call1",
  } as unknown as ActionContext;
}

async function run(
  def: { handler: (a: never, c: ActionContext) => Promise<ActionResult> | ActionResult },
  args: unknown,
  ctx: ActionContext,
): Promise<ActionResult> {
  return await def.handler(args as never, ctx);
}

// ═════════════════════════════════════════════════════════════════════════════
// propose_handoff (CC14)
// ═════════════════════════════════════════════════════════════════════════════
describe("handoff refactor — proposeHandoff.handler", () => {
  it("Off veto -> compose_draft forbidden string", async () => {
    const ctx = makeCtx({ gate: "Off" });
    const r = await run(proposeHandoff, { to_pane: "p1", draft_text: "hi" }, ctx);
    assert.deepStrictEqual(r, { kind: "ok", output: "Error: the 'compose_draft' capability is gated Off; composing drafts is forbidden by policy." });
  });

  it("store unavailable -> error string", async () => {
    const ctx = makeCtx({ store: false });
    const r = await run(proposeHandoff, { to_pane: "p1", draft_text: "hi" }, ctx);
    assert.deepStrictEqual(r, { kind: "ok", output: "Error: the persistent store is unavailable; handoffs cannot be created right now." });
  });

  it("missing to_pane -> required string", async () => {
    const ctx = makeCtx({});
    const r = await run(proposeHandoff, { to_pane: "", draft_text: "hi" }, ctx);
    assert.deepStrictEqual(r, { kind: "ok", output: "Error: a target pane (to_pane) is required for a handoff." });
  });

  it("no from_pane -> placeholder summary, agent_instruction kind, success object", async () => {
    const ctx = makeCtx({});
    const r = await run(proposeHandoff, { to_pane: "p1", draft_text: "do it" }, ctx) as { kind: "ok"; output: any };
    assert.strictEqual(r.kind, "ok");
    assert.strictEqual(r.output.handoff_id, "h_new");
    assert.strictEqual(r.output.state, "composing");
    assert.strictEqual(r.output.to_pane, "p1");
    assert.strictEqual(r.output.composed_prompt, "do it");
    assert.match(r.output.message, /^Drafted handoff h_new to pane p1 \(state: composing\)/);
  });

  it("from_pane LIVE -> pane summary captured; shell pane -> kind shell", async () => {
    const handoffs: Record<string, HandoffRow> = {};
    const created: any[] = [];
    const ctx = makeCtx({
      handoffs,
      terminals: { src: { runtimeType: "shell" }, p1: { runtimeType: "shell" } },
      paneSummary: "SUMMARY-LINES",
    });
    // intercept createHandoff to capture source_context + kind
    const store = ctx.store as any;
    const orig = store.createHandoff;
    store.createHandoff = (row: any) => { created.push(row); return orig(row); };
    const r = await run(proposeHandoff, { to_pane: "p1", draft_text: "x", from_pane: "src", rationale: "because" }, ctx) as { kind: "ok"; output: any };
    assert.strictEqual(r.kind, "ok");
    assert.strictEqual(created[0].kind, "shell");
    const sc = JSON.parse(created[0].source_context);
    assert.strictEqual(sc.from_pane, "src");
    assert.strictEqual(sc.rationale, "because");
    assert.strictEqual(sc.summary, "SUMMARY-LINES");
  });

  it("from_pane NOT live -> history fallback summary path (empty -> placeholder)", async () => {
    const created: any[] = [];
    const ctx = makeCtx({ terminals: { p1: {} } });
    const store = ctx.store as any;
    const orig = store.createHandoff;
    store.createHandoff = (row: any) => { created.push(row); return orig(row); };
    const r = await run(proposeHandoff, { to_pane: "p1", draft_text: "x", from_pane: "ghost" }, ctx) as { kind: "ok"; output: any };
    assert.strictEqual(r.kind, "ok");
    const sc = JSON.parse(created[0].source_context);
    // ghost pane not live + no history file -> summary falls back to placeholder
    assert.strictEqual(sc.summary, "[no source context captured]");
    assert.strictEqual(sc.rationale, null);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// stage_handoff (CC11)
// ═════════════════════════════════════════════════════════════════════════════
function baseRow(over: Partial<HandoffRow> = {}): HandoffRow {
  return {
    id: "h1", state: "composing", to_pane: "p1", from_pane: null, kind: "agent_instruction",
    revision_count: 0, composed_prompt: "hello", source_context: "{}", ...over,
  };
}

describe("handoff refactor — stageHandoff.handler", () => {
  it("Off veto -> forbidden", async () => {
    const ctx = makeCtx({ gate: "Off" });
    const r = await run(stageHandoff, { handoff_id: "h1" }, ctx);
    assert.deepStrictEqual(r, { kind: "ok", output: "Error: the 'compose_draft' capability is gated Off; composing drafts is forbidden by policy." });
  });

  it("store null -> unavailable", async () => {
    const ctx = makeCtx({ store: false });
    const r = await run(stageHandoff, { handoff_id: "h1" }, ctx);
    assert.deepStrictEqual(r, { kind: "ok", output: "Error: the persistent store is unavailable." });
  });

  it("not found -> error", async () => {
    const ctx = makeCtx({ handoffs: {} });
    const r = await run(stageHandoff, { handoff_id: "h1" }, ctx);
    assert.deepStrictEqual(r, { kind: "ok", output: "Error: handoff h1 not found." });
  });

  it("target pane gone -> cannot stage", async () => {
    const ctx = makeCtx({ handoffs: { h1: baseRow({ to_pane: "gone" }) }, terminals: {} });
    const r = await run(stageHandoff, { handoff_id: "h1" }, ctx);
    assert.deepStrictEqual(r, { kind: "ok", output: "Cannot stage: target pane gone no longer exists." });
  });

  it("high-confidence secret -> BLOCK + recordActivity refusal", async () => {
    const recorded: unknown[] = [];
    const ctx = makeCtx({
      handoffs: { h1: baseRow({ composed_prompt: "key AKIAIOSFODNN7EXAMPLE" }) },
      terminals: { p1: {} },
      recorded,
    });
    const r = await run(stageHandoff, { handoff_id: "h1" }, ctx) as { kind: "ok"; output: string };
    assert.match(r.output, /^Blocked: the composed prompt for handoff h1 appears to contain a secret/);
    assert.strictEqual(recorded.length, 1);
  });

  it("low-confidence secret -> staged WITH warning suffix", async () => {
    const stateChanges: Array<{ id: string; state: string }> = [];
    const ctx = makeCtx({
      handoffs: { h1: baseRow({ composed_prompt: "password=hunter2" }) },
      terminals: { p1: {} },
      stateChanges,
    });
    const r = await run(stageHandoff, { handoff_id: "h1" }, ctx) as { kind: "ok"; output: any };
    assert.strictEqual(typeof r.output, "object");
    assert.strictEqual(r.output.state, "staged");
    assert.match(r.output.message, /WARNING: the prompt contains a possible credential assignment/);
    assert.deepStrictEqual(stateChanges, [{ id: "h1", state: "staged", opts: undefined }]);
  });

  it("clean prompt -> staged, no warning", async () => {
    const ctx = makeCtx({ handoffs: { h1: baseRow({ composed_prompt: "just a normal prompt" }) }, terminals: { p1: {} } });
    const r = await run(stageHandoff, { handoff_id: "h1" }, ctx) as { kind: "ok"; output: any };
    assert.strictEqual(r.output.state, "staged");
    assert.strictEqual(r.output.message, "Handoff h1 is staged for pane p1. Ask the operator to approve delivery (deliver_handoff).");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// deliver_handoff (CC11)
// ═════════════════════════════════════════════════════════════════════════════
describe("handoff refactor — deliverHandoff.handler", () => {
  it("store null -> unavailable", async () => {
    const ctx = makeCtx({ store: false });
    const r = await run(deliverHandoff, { handoff_id: "h1" }, ctx);
    assert.deepStrictEqual(r, { kind: "ok", output: "Error: the persistent store is unavailable." });
  });

  it("not found -> error", async () => {
    const ctx = makeCtx({ handoffs: {} });
    const r = await run(deliverHandoff, { handoff_id: "h1" }, ctx);
    assert.deepStrictEqual(r, { kind: "ok", output: "Error: handoff h1 not found." });
  });

  it("not staged -> stage-first message", async () => {
    const ctx = makeCtx({ handoffs: { h1: baseRow({ state: "composing" }) } });
    const r = await run(deliverHandoff, { handoff_id: "h1" }, ctx);
    assert.deepStrictEqual(r, { kind: "ok", output: "Handoff h1 is 'composing', not 'staged'. Stage it before delivery." });
  });

  it("deliver-time high secret -> blocked + recordActivity", async () => {
    const recorded: unknown[] = [];
    const ctx = makeCtx({ handoffs: { h1: baseRow({ state: "staged", composed_prompt: "AKIAIOSFODNN7EXAMPLE" }) }, recorded });
    const r = await run(deliverHandoff, { handoff_id: "h1" }, ctx) as { kind: "ok"; output: string };
    assert.match(r.output, /^Blocked: handoff h1's prompt appears to contain a secret/);
    assert.strictEqual(recorded.length, 1);
  });

  it("deliver_now (executed outcome) -> Delivered string + state delivered", async () => {
    const stateChanges: Array<{ id: string; state: string }> = [];
    const ctx = makeCtx({
      handoffs: { h1: baseRow({ state: "staged" }) },
      dispatchOutcome: { kind: "executed", text: "ok" },
      stateChanges,
    });
    const r = await run(deliverHandoff, { handoff_id: "h1" }, ctx);
    assert.deepStrictEqual(r, { kind: "ok", output: "Delivered handoff h1 to pane p1." });
    assert.strictEqual(stateChanges[0].state, "delivered");
  });

  it("await_approval (pending outcome) -> pending result shape", async () => {
    const ctx = makeCtx({
      handoffs: { h1: baseRow({ state: "staged" }) },
      dispatchOutcome: { kind: "pending", text: "read this back" },
    });
    const r = await run(deliverHandoff, { handoff_id: "h1" }, ctx) as any;
    assert.strictEqual(r.kind, "pending");
    assert.strictEqual(r.messageId, "h1");
    assert.strictEqual(r.summary, "read this back");
    assert.deepStrictEqual(r.extra, { pane_id: "p1", prompt: "read this back" });
  });

  it("block (blocked outcome) -> output is outcome text + state blocked_read_only", async () => {
    const stateChanges: Array<{ id: string; state: string }> = [];
    const ctx = makeCtx({
      handoffs: { h1: baseRow({ state: "staged" }) },
      dispatchOutcome: { kind: "blocked", text: "read-only blocks" },
      stateChanges,
    });
    const r = await run(deliverHandoff, { handoff_id: "h1" }, ctx);
    assert.deepStrictEqual(r, { kind: "ok", output: "read-only blocks" });
    assert.strictEqual(stateChanges[0].state, "blocked_read_only");
  });

  it("noop (clarify/error outcome) -> output is outcome text, no row change", async () => {
    const stateChanges: Array<{ id: string; state: string }> = [];
    const ctx = makeCtx({
      handoffs: { h1: baseRow({ state: "staged" }) },
      dispatchOutcome: { kind: "clarify", text: "which one?" },
      stateChanges,
    });
    const r = await run(deliverHandoff, { handoff_id: "h1" }, ctx);
    assert.deepStrictEqual(r, { kind: "ok", output: "which one?" });
    assert.strictEqual(stateChanges.length, 0);
  });
});
