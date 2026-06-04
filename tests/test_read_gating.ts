// igc — the READ-GATING LEVER (promoted read capabilities actually gate, behavior-preservingly).
//
// These are PURE handler tests (no server boot, no Gemini key, no PTY). They prove the lever:
//   (a) read_pane="Auto"  -> get_pane_summary / get_pane_delta / get_pane_command_history PROCEED
//       (they hit the real manager read method and return its output shape);
//   (b) read_pane="Off"   -> all 3 return the verbatim forbidden kind:"ok" Error string and DO NOT
//       touch the manager read method (the Off veto bites BEFORE the read);
//   (c) read_notes="Off"  -> the note-content reads (get_project_notes / search_notes) return the
//       forbidden string; read_notes="Auto" -> they PROCEED (real output shape);
//   (d) the INSPECTION reads (get_pane_gates / list_capabilities) are UNAFFECTED by read_notes="Off"
//       (they still return their normal output) — proving inspection stays UNGATED.
//
// PRINCIPLE: an unseeded capability resolves to "Auto" (gateSurface.ts:73 fallback), so a gate that
// blocks ONLY on "Off" changes nothing until the operator explicitly sets Off. The Auto cases here are
// the behavior-preserving proof; the goldens (test_voice_tool_goldens.ts) are the byte-identical proof.
//
// Runner: npx tsx --test --test-force-exit tests/test_read_gating.ts

import { describe, it } from "node:test";
import assert from "node:assert";

import {
  getPaneSummary,
  getPaneDelta,
  getPaneCommandHistory,
  getPaneGates,
  listCapabilities,
} from "../src/actions/defs/reads";
import { getProjectNotes, searchNotes } from "../src/actions/defs/notes";
import { readHandoff, listHandoffs } from "../src/actions/defs/handoff";
import { ALL_CAPABILITIES } from "../src/gateSurface";
import type { ActionContext } from "../src/actions/types";
import type { CapabilityGate, GateValue } from "../src/types";
import { PendingApprovalStore } from "../src/pendingApprovals";

const FORBID_PANE =
  "Error: the 'read_pane' capability is gated Off; reading pane content is forbidden by policy.";
const FORBID_NOTES =
  "Error: the 'read_notes' capability is gated Off; reading note content is forbidden by policy.";
const FORBID_HANDOFF =
  "Error: the 'read_notes' capability is gated Off; reading handoff content is forbidden by policy.";

// ─────────────────────────────────────────────────────────────────────────────
// Spy counters so we can assert the Off veto bites BEFORE the manager read method runs.
// ─────────────────────────────────────────────────────────────────────────────
interface Calls {
  summary: number;
  delta: number;
  getNotes: number;
  search: number;
  getHandoff: number;
  listHandoffs: number;
}

/**
 * Build a stubbed ActionContext (mirrors makeCtx from tests/test_action_timeout.ts) whose
 * effectiveCapabilityGateFor returns a CONTROLLABLE gate per (paneId, capability). The manager stub
 * implements only the read surface the gated handlers touch and bumps `calls` so we can prove the
 * read method was (or was NOT) reached. Every other injected closure is an inert no-op/null.
 *
 * `gates` maps a capability id -> the GateValue effectiveCapabilityGateFor should hand back.
 * Anything unset falls back to "Auto" (the real gateSurface fallback), keeping it behavior-preserving.
 */
function makeCtx(
  gates: Partial<Record<string, GateValue>>,
  calls: Calls,
  opts: { frozen?: boolean } = {}
): ActionContext {
  const manager = {
    settings: { advanced: { historyMaxCommands: 50 } },
    getPaneSummary: (_id: string): string => {
      calls.summary++;
      return "```\nrecent pane output\n```";
    },
    getPaneDelta: (_id: string): string => {
      calls.delta++;
      return "```\nnew pane output\n```";
    },
    ledger: {
      activeProjectId: "proj_a",
      getNotes: (_q: { projectId: string }): Array<{
        id: string;
        pane_id: string | null;
        type: string;
        created_at: string;
        text: string;
      }> => {
        calls.getNotes++;
        return [
          { id: "n1", pane_id: null, type: "decision", created_at: "2026-01-01", text: "we chose A" },
        ];
      },
      search: (
        _query: string,
        _opts: { limit: number; source: string }
      ): Array<{ id: string; snippet: string; source: string }> => {
        calls.search++;
        return [{ id: "n1", snippet: "we chose A", source: "note" }];
      },
    },
  } as unknown as ActionContext["manager"];

  // Minimal store stub for the two gated handoff CONTENT reads (read_handoff / list_handoffs). Only
  // getHandoff / listHandoffs are exercised; each bumps `calls` so we can prove the read ran (when the
  // gate is skipped during a freeze) or did NOT run (the gate fires the forbidden string first).
  const store = {
    getHandoff: (id: string) => {
      calls.getHandoff++;
      return {
        id,
        workspace_id: "proj_a",
        from_pane: "p0",
        to_pane: "p1",
        kind: "agent_instruction",
        composed_prompt: "do the thing",
        source_context: "{}",
        source_context_refs: "[]",
        state: "composing",
        gate_approval_id: null,
        approved_by: null,
        approved_via: null,
        revision_count: 0,
        created_at: 0,
        staged_at: null,
        delivered_at: null,
        consumed_at: null,
        terminal_at: null,
        expires_at: null,
      };
    },
    listHandoffs: (_filter: { workspaceId?: string; state?: string }) => {
      calls.listHandoffs++;
      return [
        {
          id: "h1",
          workspace_id: "proj_a",
          from_pane: "p0",
          to_pane: "p1",
          kind: "agent_instruction",
          composed_prompt: "do the thing",
          source_context: "{}",
          source_context_refs: "[]",
          state: "composing",
          gate_approval_id: null,
          approved_by: null,
          approved_via: null,
          revision_count: 0,
          created_at: 0,
          staged_at: null,
          delivered_at: null,
          consumed_at: null,
          terminal_at: null,
          expires_at: null,
        },
      ];
    },
  } as unknown as ActionContext["store"];

  return {
    manager,
    session: null,
    callId: "call_test",
    trigger: "test",
    surface: "voice",
    userUtterance: "",
    broadcast: () => {},
    broadcastLedgerUpdate: () => {},
    gateOrDefer: () => ({ disposition: "run" }),
    dispatchProposal: (a) => ({ kind: "executed", text: `executed on ${a.targetId}` }),
    gateCapability: () => ({ forbidden: false, gate: "Auto" }),
    redact: (s) => s,
    getActivePaneId: () => null,
    setActivePane: () => {},
    activeDraftTarget: () => null,
    broadcastDraft: () => {},
    broadcastTerminalsUpdated: () => {},
    // The controllable resolver under test. Falls back to "Auto" for any unset capability — exactly
    // the gateSurface unseeded behavior, so unset == behavior-preserving.
    effectiveCapabilityGateFor: (_paneId: string | null | undefined, capability: CapabilityGate): GateValue =>
      gates[capability] ?? "Auto",
    pruneAttention: () => {},
    pendingApprovals: new PendingApprovalStore(null),
    applyResolution: () => ({ reason: "not_found", doWrite: false }),
    store,
    sanitizeSettingsForClient: (settings) => settings,
    recipes: [],
    stopAll: async () => [],
    releaseStopAll: () => {},
    // Controllable freeze flag. When true, the read-gating guards short-circuit OUT (reads stay
    // available during a STOP-ALL freeze — the behavior-preserving guarantee).
    isFrozen: () => opts.frozen ?? false,
  };
}

function freshCalls(): Calls {
  return { summary: 0, delta: 0, getNotes: 0, search: 0, getHandoff: 0, listHandoffs: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) read_pane="Auto" -> the 3 pane-content reads PROCEED (real output shape).
// ─────────────────────────────────────────────────────────────────────────────
describe("igc read-gating lever — read_pane", () => {
  it("(a) Auto -> get_pane_summary / get_pane_delta / get_pane_command_history proceed", async () => {
    const calls = freshCalls();
    const ctx = makeCtx({ read_pane: "Auto" }, calls);

    const s = await getPaneSummary.handler({ pane_id: "p1" }, ctx);
    assert.strictEqual(s.kind, "ok");
    assert.strictEqual((s as { output: unknown }).output, "```\nrecent pane output\n```");
    assert.strictEqual(calls.summary, 1, "the real getPaneSummary read must have run");

    const d = await getPaneDelta.handler({ pane_id: "p1" }, ctx);
    assert.strictEqual(d.kind, "ok");
    assert.strictEqual((d as { output: unknown }).output, "```\nnew pane output\n```");
    assert.strictEqual(calls.delta, 1, "the real getPaneDelta read must have run");

    const h = await getPaneCommandHistory.handler({ pane_id: "p1" }, ctx);
    assert.strictEqual(h.kind, "ok");
    // No .janus_history.json fixture -> empty history array (faithful loadHistory behavior).
    assert.deepStrictEqual((h as { output: unknown }).output, []);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // (b) read_pane="Off" -> all 3 return the forbidden string AND never touch the read method.
  // ───────────────────────────────────────────────────────────────────────────
  it("(b) Off -> all 3 return the forbidden string and do NOT touch the manager read method", async () => {
    const calls = freshCalls();
    const ctx = makeCtx({ read_pane: "Off" }, calls);

    const s = await getPaneSummary.handler({ pane_id: "p1" }, ctx);
    assert.strictEqual(s.kind, "ok");
    assert.strictEqual((s as { output: unknown }).output, FORBID_PANE);

    const d = await getPaneDelta.handler({ pane_id: "p1" }, ctx);
    assert.strictEqual(d.kind, "ok");
    assert.strictEqual((d as { output: unknown }).output, FORBID_PANE);

    const h = await getPaneCommandHistory.handler({ pane_id: "p1" }, ctx);
    assert.strictEqual(h.kind, "ok");
    assert.strictEqual((h as { output: unknown }).output, FORBID_PANE);

    // The Off veto must bite BEFORE the read — neither domain read method may have run.
    assert.strictEqual(calls.summary, 0, "getPaneSummary read must NOT run when read_pane is Off");
    assert.strictEqual(calls.delta, 0, "getPaneDelta read (cursor mutation) must NOT run when read_pane is Off");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) read_notes Off -> note-content reads forbidden; Auto -> proceed.
// ─────────────────────────────────────────────────────────────────────────────
describe("igc read-gating lever — read_notes", () => {
  it("(c) Off -> get_project_notes / search_notes return the forbidden string and skip the ledger", async () => {
    const calls = freshCalls();
    const ctx = makeCtx({ read_notes: "Off" }, calls);

    const n = await getProjectNotes.handler({ project_id: "proj_a" }, ctx);
    assert.strictEqual(n.kind, "ok");
    assert.strictEqual((n as { output: unknown }).output, FORBID_NOTES);

    const s = await searchNotes.handler({ query: "A" }, ctx);
    assert.strictEqual(s.kind, "ok");
    assert.strictEqual((s as { output: unknown }).output, FORBID_NOTES);

    assert.strictEqual(calls.getNotes, 0, "getNotes must NOT run when read_notes is Off");
    assert.strictEqual(calls.search, 0, "search must NOT run when read_notes is Off");
  });

  it("(c) Auto -> get_project_notes / search_notes proceed (real output shape)", async () => {
    const calls = freshCalls();
    const ctx = makeCtx({ read_notes: "Auto" }, calls);

    const n = await getProjectNotes.handler({ project_id: "proj_a" }, ctx);
    assert.strictEqual(n.kind, "ok");
    assert.deepStrictEqual((n as { output: unknown }).output, {
      project_id: "proj_a",
      count: 1,
      notes: [{ id: "n1", pane_id: null, type: "decision", created_at: "2026-01-01", text: "we chose A" }],
    });
    assert.strictEqual(calls.getNotes, 1, "the real getNotes read must have run");

    const s = await searchNotes.handler({ query: "A" }, ctx);
    assert.strictEqual(s.kind, "ok");
    assert.deepStrictEqual((s as { output: unknown }).output, {
      query: "A",
      count: 1,
      results: [{ id: "n1", snippet: "we chose A" }],
    });
    assert.strictEqual(calls.search, 1, "the real search read must have run");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) inspection reads stay UNGATED — read_notes="Off" must NOT affect them.
// ─────────────────────────────────────────────────────────────────────────────
describe("igc read-gating lever — inspection reads stay ungated", () => {
  it("(d) get_pane_gates / list_capabilities are UNAFFECTED by read_notes=Off", async () => {
    const calls = freshCalls();
    // read_notes Off AND read_pane Off: an inspection read must still answer its normal shape.
    const ctx = makeCtx({ read_notes: "Off", read_pane: "Off" }, calls);

    const lc = await listCapabilities.handler({}, ctx);
    assert.strictEqual(lc.kind, "ok");
    assert.deepStrictEqual((lc as { output: unknown }).output, [...ALL_CAPABILITIES]);

    const gp = await getPaneGates.handler({ pane_id: "p1" }, ctx);
    assert.strictEqual(gp.kind, "ok");
    const out = (gp as { output: { pane_id: string | null; gates: Record<string, GateValue> } }).output;
    assert.strictEqual(out.pane_id, "p1");
    // The full matrix is reported; read_pane/read_notes appear with their resolved Off value, NOT a
    // forbidden Error string (proving get_pane_gates reads the matrix rather than being gated by it).
    assert.strictEqual(out.gates.read_pane, "Off");
    assert.strictEqual(out.gates.read_notes, "Off");
    for (const c of ALL_CAPABILITIES) {
      assert.ok(c in out.gates, `get_pane_gates must report capability ${c}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (ii) read_notes="Off" (NOT frozen) -> the handoff CONTENT reads are gated too.
// read_handoff + list_handoffs return the forbidden ok-string and never touch the store.
// ─────────────────────────────────────────────────────────────────────────────
describe("igc read-gating lever — handoff content reads", () => {
  it("(ii) Off (not frozen) -> read_handoff / list_handoffs return the forbidden string and skip the store", async () => {
    const calls = freshCalls();
    const ctx = makeCtx({ read_notes: "Off" }, calls);

    const r = await readHandoff.handler({ handoff_id: "h1" }, ctx);
    assert.strictEqual(r.kind, "ok");
    assert.strictEqual((r as { output: unknown }).output, FORBID_HANDOFF);

    const l = await listHandoffs.handler({}, ctx);
    assert.strictEqual(l.kind, "ok");
    assert.strictEqual((l as { output: unknown }).output, FORBID_HANDOFF);

    // The Off veto must bite BEFORE the store read.
    assert.strictEqual(calls.getHandoff, 0, "getHandoff must NOT run when read_notes is Off");
    assert.strictEqual(calls.listHandoffs, 0, "listHandoffs must NOT run when read_notes is Off");
  });

  it("(ii) Auto -> read_handoff / list_handoffs proceed (real store content)", async () => {
    const calls = freshCalls();
    const ctx = makeCtx({ read_notes: "Auto" }, calls);

    const r = await readHandoff.handler({ handoff_id: "h1" }, ctx);
    assert.strictEqual(r.kind, "ok");
    const ro = (r as { output: { handoff_id: string; composed_prompt: string } }).output;
    assert.strictEqual(ro.handoff_id, "h1");
    assert.strictEqual(ro.composed_prompt, "do the thing");
    assert.strictEqual(calls.getHandoff, 1, "the real getHandoff read must have run");

    const l = await listHandoffs.handler({}, ctx);
    assert.strictEqual(l.kind, "ok");
    const lo = (l as { output: Array<{ handoff_id: string }> }).output;
    assert.strictEqual(lo.length, 1);
    assert.strictEqual(lo[0].handoff_id, "h1");
    assert.strictEqual(calls.listHandoffs, 1, "the real listHandoffs read must have run");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (i) FREEZE-PATH (behavior-preserving): with isFrozen()=TRUE the STOP-ALL short-circuit makes
// effectiveCapabilityGateFor resolve EVERY capability to "Off". The read-gating guards MUST be
// skipped while frozen -> EVERY gated read (pane + notes + the two handoffs) PROCEEDS exactly as
// legacy (legacy reads were UNGATED and worked during a freeze). The lever blocks ONLY on an
// EXPLICIT operator Off, never merely because a freeze is active.
// ─────────────────────────────────────────────────────────────────────────────
describe("igc read-gating lever — freeze does NOT suppress reads (behavior-preserving)", () => {
  it("(i) frozen=TRUE + every cap resolving Off -> all gated reads PROCEED", async () => {
    const calls = freshCalls();
    // Mirror the STOP-ALL frozen short-circuit: every capability resolves Off, but isFrozen() is true.
    const ctx = makeCtx({ read_pane: "Off", read_notes: "Off" }, calls, { frozen: true });

    // Pane-content reads proceed (real manager output, NOT the forbidden string).
    const s = await getPaneSummary.handler({ pane_id: "p1" }, ctx);
    assert.strictEqual(s.kind, "ok");
    assert.strictEqual((s as { output: unknown }).output, "```\nrecent pane output\n```");
    assert.strictEqual(calls.summary, 1, "getPaneSummary must run during a freeze (reads stay available)");

    const d = await getPaneDelta.handler({ pane_id: "p1" }, ctx);
    assert.strictEqual(d.kind, "ok");
    assert.strictEqual((d as { output: unknown }).output, "```\nnew pane output\n```");
    assert.strictEqual(calls.delta, 1, "getPaneDelta must run during a freeze (reads stay available)");

    const h = await getPaneCommandHistory.handler({ pane_id: "p1" }, ctx);
    assert.strictEqual(h.kind, "ok");
    assert.deepStrictEqual((h as { output: unknown }).output, []);

    // Note-content reads proceed.
    const n = await getProjectNotes.handler({ project_id: "proj_a" }, ctx);
    assert.strictEqual(n.kind, "ok");
    assert.deepStrictEqual((n as { output: unknown }).output, {
      project_id: "proj_a",
      count: 1,
      notes: [{ id: "n1", pane_id: null, type: "decision", created_at: "2026-01-01", text: "we chose A" }],
    });
    assert.strictEqual(calls.getNotes, 1, "getNotes must run during a freeze (reads stay available)");

    const sn = await searchNotes.handler({ query: "A" }, ctx);
    assert.strictEqual(sn.kind, "ok");
    assert.deepStrictEqual((sn as { output: unknown }).output, {
      query: "A",
      count: 1,
      results: [{ id: "n1", snippet: "we chose A" }],
    });
    assert.strictEqual(calls.search, 1, "search must run during a freeze (reads stay available)");

    // Handoff-content reads proceed.
    const r = await readHandoff.handler({ handoff_id: "h1" }, ctx);
    assert.strictEqual(r.kind, "ok");
    assert.strictEqual(
      (r as { output: { composed_prompt: string } }).output.composed_prompt,
      "do the thing"
    );
    assert.strictEqual(calls.getHandoff, 1, "getHandoff must run during a freeze (reads stay available)");

    const l = await listHandoffs.handler({}, ctx);
    assert.strictEqual(l.kind, "ok");
    assert.strictEqual((l as { output: Array<{ handoff_id: string }> }).output.length, 1);
    assert.strictEqual(calls.listHandoffs, 1, "listHandoffs must run during a freeze (reads stay available)");
  });
});
