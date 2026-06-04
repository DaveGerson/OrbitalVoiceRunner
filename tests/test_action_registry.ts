// REG1 Phase A — ActionDef registry STRUCTURAL tests (registry TDD spec §8.1 / §8.1b / §8.2 / §8.3).
//
// These are PURE structural tests over the registry + its three generators — no server boot, no
// Gemini key, no PTY. They drive runAction with a STUBBED ctx.gateOrDefer (allowed / deferred /
// forbidden) to prove the wrapper's gate/redaction/error contract, and assert the generated Gemini
// surface == the voice-surface action names (parity by construction — this replaces the old regex
// parity guard). The CapabilityDef matrix is checked for derivation + no-orphans + golden defaults.
//
// Runner: npx tsx --test --test-force-exit tests/test_action_registry.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { z } from "zod";

import { REGISTRY } from "../src/actions/registry";
import { ALWAYS_ALLOWED } from "../src/actions/types";
import type {
  ActionContext,
  ActionDef,
  ActionResult,
  DispatchOutcome,
  GateDisposition,
} from "../src/actions/types";
import {
  CAPABILITY_DEFS,
  deriveCapabilities,
  spotlightCapabilities,
} from "../src/actions/capabilities";
import { toGeminiDeclarations, runAction, resultToToolResponse, zodToGeminiSchema } from "../src/actions/gemini";
import { redactSecrets } from "../src/terminal";
import { PendingApprovalStore } from "../src/pendingApprovals";

// ─────────────────────────────────────────────────────────────────────────────
// Test doubles: a stubbed ActionContext whose gateOrDefer disposition is configurable per test.
// ─────────────────────────────────────────────────────────────────────────────

interface SpySession {
  calls: Array<{ name: string; id?: string; response: Record<string, unknown> }>;
  sendToolResponse: (p: { functionResponses: Array<{ name: string; id?: string; response: Record<string, unknown> }> }) => void;
}

function spySession(): SpySession {
  const calls: SpySession["calls"] = [];
  return {
    calls,
    sendToolResponse(p) {
      for (const fr of p.functionResponses) calls.push(fr);
    },
  };
}

/** Records of how the injected gate functions were called (so handler-owned tests can assert them). */
interface GateOrDeferCall {
  capability: string;
  paneId: string | null;
  summary: string;
  run: () => string;
  params?: Record<string, unknown>;
  requestedMode?: string;
}
interface DispatchProposalCall {
  capability?: string;
  targetId: string;
  instruction: string;
  callId: string;
}

/**
 * Build a stub ctx for the HANDLER-OWNED model. The handler is the authority that calls
 * ctx.gateOrDefer / ctx.dispatchProposal — so the stub LETS THE REAL run() CLOSURE EXECUTE on the
 * "run" disposition (mirroring how the live server's Auto branch invokes the staged effect via the
 * caller). `disposition` controls gateOrDefer's verdict; `dispatchOutcome` controls dispatchProposal.
 */
function makeCtx(opts: {
  disposition?: GateDisposition;
  dispatchOutcome?: DispatchOutcome;
  manager?: Partial<ActionContext["manager"]>;
  redact?: (s: string) => string;
  gateSpy?: { count: number };
  gateOrDeferCalls?: GateOrDeferCall[];
  dispatchCalls?: DispatchProposalCall[];
  broadcasts?: unknown[];
  ledgerBroadcasts?: { count: number };
  userUtterance?: string;
  session?: ActionContext["session"];
  callId?: string;
  // REG1 Phase B stub knobs (all optional; default to inert no-op / null / empty).
  activePaneId?: string | null;
  activePaneSet?: Array<string | null>;
  activeDraftTarget?: { projectId: string; paneId: string } | null;
  draftBroadcasts?: Array<{ projectId: string; paneId: string }>;
  terminalsBroadcasts?: { count: number };
  pruneAttentionCalls?: { count: number };
  store?: ActionContext["store"];
  recipes?: ActionContext["recipes"];
} = {}): ActionContext {
  const disposition = opts.disposition ?? { disposition: "run" };
  const broadcasts = opts.broadcasts ?? [];
  return {
    manager: (opts.manager ?? {}) as ActionContext["manager"],
    session: opts.session ?? null,
    callId: opts.callId ?? "call_test",
    trigger: "test",
    userUtterance: opts.userUtterance ?? "",
    broadcast: (msg) => { broadcasts.push(msg); },
    broadcastLedgerUpdate: () => { if (opts.ledgerBroadcasts) opts.ledgerBroadcasts.count += 1; },
    gateOrDefer: (capability, paneId, summary, run, params, requestedMode) => {
      if (opts.gateSpy) opts.gateSpy.count += 1;
      opts.gateOrDeferCalls?.push({ capability, paneId, summary, run, params, requestedMode });
      if (disposition.disposition === "deferred") {
        // The deferred disposition needs an actionId/summary; thread the summary through.
        // CRUCIAL: do NOT invoke run() here (Ask stages the effect; it runs LATER on confirm).
        return { disposition: "deferred", actionId: disposition.actionId, summary };
      }
      if (disposition.disposition === "run") {
        // Auto: the LIVE server caller invokes the effect. Faithful handlers call run() themselves
        // for Auto (amend_note: `return amendEffect()`), so the stub just returns "run".
        return { disposition: "run" };
      }
      return disposition; // forbidden
    },
    dispatchProposal: (a) => {
      opts.dispatchCalls?.push({ capability: a.capability, targetId: a.targetId, instruction: a.instruction, callId: a.callId });
      return opts.dispatchOutcome ?? { kind: "executed", text: `executed on ${a.targetId}` };
    },
    gateCapability: (_cap, _pane) => ({ forbidden: false, gate: "Auto" }),
    redact: opts.redact ?? ((s) => s),

    // ── REG1 Phase B injected closures (no-op / null stubs; real impls live in server.ts) ──────
    getActivePaneId: () => opts.activePaneId ?? null,
    setActivePane: (paneId) => { if (opts.activePaneSet) opts.activePaneSet.push(paneId); },
    activeDraftTarget: () => opts.activeDraftTarget ?? null,
    broadcastDraft: (projectId, paneId) => { opts.draftBroadcasts?.push({ projectId, paneId }); },
    broadcastTerminalsUpdated: () => { if (opts.terminalsBroadcasts) opts.terminalsBroadcasts.count += 1; },
    effectiveCapabilityGateFor: (_pane, _cap) => "Auto",
    pruneAttention: () => { if (opts.pruneAttentionCalls) opts.pruneAttentionCalls.count += 1; },
    pendingApprovals: new PendingApprovalStore(null),
    applyResolution: (_id, _mode, _opts) => ({ reason: "not_found", doWrite: false }),
    store: opts.store ?? null,
    sanitizeSettingsForClient: (settings) => settings, // passthrough (no masking needed in tests)
    recipes: opts.recipes ?? [],
  };
}

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;
const READ_CAPABILITIES = new Set(["read_pane", "read_notes"]);

// ─────────────────────────────────────────────────────────────────────────────
// §8.1 — registry totality & shape
// ─────────────────────────────────────────────────────────────────────────────
describe("§8.1 registry totality & shape", () => {
  it("every ActionDef has name, description, params schema, capability, readOnly, surfaces, handler", () => {
    for (const def of REGISTRY) {
      assert.ok(typeof def.name === "string" && def.name.length, `name missing for ${JSON.stringify(def)}`);
      assert.ok(typeof def.description === "string" && def.description.length, `description missing for ${def.name}`);
      assert.ok(def.params instanceof z.ZodType, `params is not a zod schema for ${def.name}`);
      assert.ok(typeof def.capability === "string" && def.capability.length, `capability missing for ${def.name}`);
      assert.strictEqual(typeof def.readOnly, "boolean", `readOnly not boolean for ${def.name}`);
      assert.ok(def.surfaces instanceof Set && def.surfaces.size > 0, `surfaces empty for ${def.name}`);
      assert.strictEqual(typeof def.handler, "function", `handler not a function for ${def.name}`);
    }
  });

  it("action names are unique and snake_case", () => {
    const names = REGISTRY.map((d) => d.name);
    assert.strictEqual(new Set(names).size, names.length, "duplicate action name");
    for (const n of names) assert.match(n, SNAKE_CASE, `not snake_case: ${n}`);
  });

  it("every action has a non-empty capability (no ungated action)", () => {
    for (const def of REGISTRY) {
      const ok = def.capability === ALWAYS_ALLOWED || (typeof def.capability === "string" && def.capability.length > 0);
      assert.ok(ok, `ungated/empty capability for ${def.name}`);
    }
  });

  it("the emergency brake trio is ALWAYS_ALLOWED", () => {
    for (const name of ["stop_all", "confirm_stop_all", "release_stop_all"]) {
      const def = REGISTRY.find((d) => d.name === name);
      assert.ok(def, `${name} missing from registry`);
      assert.strictEqual(def!.capability, ALWAYS_ALLOWED, `${name} is not ALWAYS_ALLOWED`);
    }
  });

  it("readOnly actions bind only to read capabilities", () => {
    for (const def of REGISTRY) {
      if (!def.readOnly) continue;
      assert.ok(READ_CAPABILITIES.has(def.capability), `readOnly ${def.name} binds non-read capability ${def.capability}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §8.1b — the matrix is DERIVED from the registry (Decision 5)
// ─────────────────────────────────────────────────────────────────────────────
describe("§8.1b matrix derived from registry", () => {
  it("ALL_CAPABILITIES === unique(registry capabilities)", () => {
    const derived = deriveCapabilities(REGISTRY).slice().sort();
    const expected = Array.from(
      new Set(REGISTRY.map((d) => d.capability).filter((c) => c !== ALWAYS_ALLOWED))
    ).sort();
    assert.deepStrictEqual(derived, expected);
  });

  it("every referenced capability has a CapabilityDef, and vice-versa (no orphans)", () => {
    const defIds = new Set(CAPABILITY_DEFS.map((d) => d.id));
    // Every capability referenced by the registry must have a CapabilityDef.
    for (const cap of deriveCapabilities(REGISTRY)) {
      assert.ok(defIds.has(cap), `orphan capability referenced but undefined: ${cap}`);
    }
    // And the CapabilityDef table must have no duplicate ids (totality of the table itself).
    assert.strictEqual(new Set(CAPABILITY_DEFS.map((d) => d.id)).size, CAPABILITY_DEFS.length, "duplicate CapabilityDef id");
    // Every CapabilityDef has the full shape.
    for (const d of CAPABILITY_DEFS) {
      assert.ok(d.label.length, `label missing for ${d.id}`);
      assert.ok(d.category.length, `category missing for ${d.id}`);
      assert.ok(["Auto", "Ask", "Off"].includes(d.defaultGate), `bad defaultGate for ${d.id}`);
    }
  });

  it("defaultGate matches today's behavior (golden)", () => {
    const byId = new Map(CAPABILITY_DEFS.map((d) => [d.id, d.defaultGate] as const));
    const golden: Record<string, "Auto" | "Ask" | "Off"> = {
      // NEW promotions default to today's effective behavior (Decision 6/7).
      read_pane: "Auto",
      read_notes: "Auto",
      focus_pane: "Auto",
      compose_draft: "Auto",
      archive_pane: "Auto",
      clear_history: "Ask",
      // Existing 16 — transcribed from current behavior.
      write_to_pane: "Ask",
      deliver_handoff: "Ask",
      create_pane: "Ask",
      close_pane: "Ask",
      restart_pane: "Ask",
      set_pane_permissions: "Ask",
      set_global_permissions: "Ask",
      set_capability_gate: "Ask",
      add_watch_rule: "Ask",
      execute_plan: "Ask",
      apply_recipe: "Ask",
      create_project: "Auto",
      update_metadata: "Auto",
      switch_context: "Auto",
      set_voice_mute: "Auto",
      dismiss_attention: "Auto",
    };
    for (const [capId, gate] of Object.entries(golden)) {
      assert.strictEqual(byId.get(capId), gate, `defaultGate mismatch for ${capId}: expected ${gate}, got ${byId.get(capId)}`);
    }
    // Every CapabilityDef has a pinned golden default (catches a new capability with no pin).
    for (const d of CAPABILITY_DEFS) {
      assert.ok(Object.prototype.hasOwnProperty.call(golden, d.id), `no golden default pinned for ${d.id}`);
    }
  });

  it("spotlight set == {write_to_pane, deliver_handoff}", () => {
    const spot = Array.from(spotlightCapabilities()).sort();
    assert.deepStrictEqual(spot, ["deliver_handoff", "write_to_pane"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §8.2 — Gemini generation
// ─────────────────────────────────────────────────────────────────────────────
describe("§8.2 Gemini generation", () => {
  it("toGeminiDeclarations emits exactly the voice-surface action names", () => {
    const generated = toGeminiDeclarations(REGISTRY).map((d) => d.name).sort();
    const expected = REGISTRY.filter((d) => d.surfaces.has("voice")).map((d) => d.name).sort();
    assert.deepStrictEqual(generated, expected);
  });

  it("a sampled declaration carries name, description, and params", () => {
    const decls = toGeminiDeclarations(REGISTRY);
    const listPanesDecl = decls.find((d) => d.name === "list_panes");
    assert.ok(listPanesDecl, "list_panes declaration missing");
    assert.ok(listPanesDecl!.description.length, "description empty");
    assert.strictEqual(listPanesDecl!.parameters.type, "OBJECT");
    assert.ok(listPanesDecl!.parameters.properties, "properties missing");
  });

  it("empty-params tools generate an empty properties object", () => {
    const decls = toGeminiDeclarations(REGISTRY);
    for (const name of ["stop_all", "list_panes"]) {
      const d = decls.find((x) => x.name === name);
      assert.ok(d, `${name} declaration missing`);
      assert.deepStrictEqual(d!.parameters.properties, {}, `${name} should have empty properties`);
      assert.strictEqual(d!.parameters.required, undefined, `${name} should have no required[]`);
    }
  });

  it("zodToGeminiSchema covers scalars/enums/optional and throws on unsupported shapes", () => {
    const schema = z.object({
      a: z.string(),
      b: z.number().optional(),
      c: z.enum(["x", "y"]),
      d: z.boolean(),
    });
    const g = zodToGeminiSchema(schema);
    assert.strictEqual(g.type, "OBJECT");
    assert.strictEqual(g.properties!.a.type, "STRING");
    assert.strictEqual(g.properties!.b.type, "NUMBER");
    assert.deepStrictEqual(g.properties!.c.enum, ["x", "y"]);
    assert.strictEqual(g.properties!.d.type, "BOOLEAN");
    assert.deepStrictEqual(g.required!.sort(), ["a", "c", "d"]); // b optional -> not required
    // Unsupported leaf throws at build, not runtime (R4).
    assert.throws(() => zodToGeminiSchema(z.object({ bad: z.array(z.string()) })), /unsupported/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §8.3 — runAction is HANDLER-OWNED (no central gate) + redaction
//
// GATE MODEL = handler-owned (Decision B). runAction applies NO capability gate; each handler calls
// ctx.gateOrDefer / ctx.dispatchProposal / ctx.gateCapability itself (faithful port of server.ts).
// These tests prove: (1) runAction does NOT gate on its own; (2) a handler that DOES call
// ctx.gateOrDefer realizes Off->blocked / Ask->pending(no-mutate) / Auto->ran; (3) a handler that
// routes through ctx.dispatchProposal maps DispatchOutcome correctly; (4) readOnly redaction, the
// unknown-action path, and the throwing-handler path still hold; (5) an intentionally-UNGATED tool
// runs even when the (unconsulted) gate is configured forbidden.
// ─────────────────────────────────────────────────────────────────────────────
describe("§8.3 runAction handler-owned gating + redaction", () => {
  // A fixture handler that OWNS its gate: it calls ctx.gateOrDefer (with a REAL effect closure +
  // durable params), exactly the shape amend_note uses. `ran` records the effect side-effect.
  function handlerGatedAction(ran: { value: boolean }): ActionDef<z.ZodObject<Record<string, never>>> {
    return {
      name: "test_gated",
      description: "a handler-owned gated action",
      params: z.object({}),
      capability: "update_metadata",
      readOnly: false,
      surfaces: new Set(["voice"]),
      handler: (_args, ctx): ActionResult => {
        const effect = (): string => { ran.value = true; return "did the thing"; };
        const g = ctx.gateOrDefer("update_metadata", null, "test summary", effect, { op: "test" });
        if (g.disposition === "forbidden") return { kind: "blocked", reason: "gated Off by policy" };
        if (g.disposition === "deferred") return { kind: "pending", messageId: g.actionId, summary: g.summary };
        return { kind: "ok", output: effect() };
      },
    };
  }

  // An INTENTIONALLY-UNGATED fixture handler — it never calls any gate (mirrors drafts/notes/focus).
  function ungatedAction(ran: { value: boolean }): ActionDef<z.ZodObject<Record<string, never>>> {
    return {
      name: "test_ungated",
      description: "an intentionally-ungated action",
      params: z.object({}),
      capability: "compose_draft", // declared for the matrix; the handler does NOT enforce it
      readOnly: false,
      surfaces: new Set(["voice"]),
      handler: (): ActionResult => { ran.value = true; return { kind: "ok", output: "ungated ran" }; },
    };
  }

  it("handler that gates Auto -> gateOrDefer consulted, effect runs, ok", async () => {
    const ran = { value: false };
    const gateSpy = { count: 0 };
    const reg = [handlerGatedAction(ran)];
    const result = await runAction(reg, "test_gated", {}, makeCtx({ disposition: { disposition: "run" }, gateSpy }));
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(ran.value, true);
    assert.strictEqual(gateSpy.count, 1, "the HANDLER must consult the gate");
  });

  it("handler that gates Ask -> pending, effect NOT run, durable params forwarded", async () => {
    const ran = { value: false };
    const gateOrDeferCalls: GateOrDeferCall[] = [];
    const reg = [handlerGatedAction(ran)];
    const result = await runAction(
      reg, "test_gated", {},
      makeCtx({ disposition: { disposition: "deferred", actionId: "act_42", summary: "x" }, gateOrDeferCalls })
    );
    assert.strictEqual(result.kind, "pending");
    assert.strictEqual((result as { messageId: string }).messageId, "act_42");
    assert.strictEqual(ran.value, false, "Ask must stage the effect, not run it");
    // kzt: the handler must forward the serializable INTENT params (durable-replay lockstep).
    assert.deepStrictEqual(gateOrDeferCalls[0].params, { op: "test" });
  });

  it("handler that gates Off -> blocked, effect not run", async () => {
    const ran = { value: false };
    const reg = [handlerGatedAction(ran)];
    const result = await runAction(reg, "test_gated", {}, makeCtx({ disposition: { disposition: "forbidden" } }));
    assert.strictEqual(result.kind, "blocked");
    assert.strictEqual(ran.value, false);
  });

  it("runAction itself applies NO gate: an ungated handler runs even when the gate is configured forbidden", async () => {
    const ran = { value: false };
    const gateSpy = { count: 0 };
    const reg = [ungatedAction(ran)];
    // Configure a forbidden disposition; since the handler never calls a gate, it must still run.
    const result = await runAction(reg, "test_ungated", {}, makeCtx({ disposition: { disposition: "forbidden" }, gateSpy }));
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(ran.value, true, "an ungated handler must run; runAction must not central-gate");
    assert.strictEqual(gateSpy.count, 0, "no gate is consulted when the handler does not call one");
  });

  it("ALWAYS_ALLOWED brake handler runs without consulting any gate", async () => {
    const gateSpy = { count: 0 };
    // The brake handlers never call a gate; even with a forbidden disposition configured, they run.
    const result = await runAction(
      REGISTRY, "stop_all", {},
      makeCtx({ disposition: { disposition: "forbidden" }, gateSpy })
    );
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(gateSpy.count, 0, "ALWAYS_ALLOWED brake must not consult the gate");
  });

  it("readOnly action output is redacted", async () => {
    const fakeAwsKey = "AKIAIOSFODNN7EXAMPLE";
    const reg: ActionDef[] = [{
      name: "leaky_read",
      description: "returns a fake secret",
      params: z.object({}),
      capability: "read_pane",
      readOnly: true,
      surfaces: new Set(["voice"]),
      handler: (): ActionResult => ({ kind: "ok", output: { note: `key is ${fakeAwsKey}` } }),
    }];
    const result = await runAction(reg, "leaky_read", {}, makeCtx({ redact: redactSecrets }));
    assert.strictEqual(result.kind, "ok");
    const serialized = JSON.stringify((result as { output: unknown }).output);
    assert.ok(!serialized.includes(fakeAwsKey), "fake AWS key must be redacted out of the result");
    assert.ok(serialized.includes("[REDACTED:aws-key]"), "redaction marker expected");
  });

  it("unknown action name yields a single error result (never throws)", async () => {
    const result = await runAction(REGISTRY, "nope_not_a_tool", {}, makeCtx());
    assert.strictEqual(result.kind, "error");
    assert.match((result as { message: string }).message, /unknown action/i);
  });

  it("handler throw is caught -> error, and resultToToolResponse answers exactly once", async () => {
    const reg: ActionDef[] = [{
      name: "boom",
      description: "throws",
      params: z.object({}),
      capability: "update_metadata",
      readOnly: false,
      surfaces: new Set(["voice"]),
      handler: (): ActionResult => { throw new Error("kaboom"); },
    }];
    const result = await runAction(reg, "boom", {}, makeCtx({ disposition: { disposition: "run" } }));
    assert.strictEqual(result.kind, "error");

    const session = spySession();
    resultToToolResponse(result, session, "boom", "call_99");
    assert.strictEqual(session.calls.length, 1, "sendToolResponse must be called exactly once");
    assert.strictEqual(session.calls[0].id, "call_99");
    assert.ok(typeof session.calls[0].response.output === "string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §8.4 — TWO opposite-style migrated tools prove the handler-owned contract end-to-end.
//   propose_command -> the ctx.dispatchProposal (pane-WRITE HiTL) path.
//   amend_note      -> the ctx.gateOrDefer (durable Ask-defer) path.
// Each asserts the FAITHFUL legacy wire payload via resultToToolResponse (the §9 voice mapping).
// ─────────────────────────────────────────────────────────────────────────────
describe("§8.4 migrated proof tools (both gating styles)", () => {
  // ── propose_command: dispatchProposal path ──────────────────────────────────
  it("propose_command routes through ctx.dispatchProposal with the right args", async () => {
    const dispatchCalls: DispatchProposalCall[] = [];
    await runAction(
      REGISTRY, "propose_command",
      { pane_id: "pane-1", instruction: "npm test" },
      makeCtx({ dispatchCalls, dispatchOutcome: { kind: "executed", text: "ran it" }, callId: "call_7", userUtterance: "run the tests" })
    );
    assert.strictEqual(dispatchCalls.length, 1, "dispatchProposal must be the single write choke-point");
    assert.strictEqual(dispatchCalls[0].targetId, "pane-1");
    assert.strictEqual(dispatchCalls[0].instruction, "npm test");
    assert.strictEqual(dispatchCalls[0].callId, "call_7");
  });

  it("propose_command coerces legacy `command` -> `instruction`", async () => {
    const dispatchCalls: DispatchProposalCall[] = [];
    await runAction(
      REGISTRY, "propose_command",
      { pane_id: "pane-1", command: "git status" },
      makeCtx({ dispatchCalls })
    );
    assert.strictEqual(dispatchCalls[0].instruction, "git status", "legacy `command` must alias `instruction`");
  });

  it("propose_command executed -> { output } (legacy else-branch)", async () => {
    const result = await runAction(
      REGISTRY, "propose_command",
      { pane_id: "pane-1", instruction: "ls" },
      makeCtx({ dispatchOutcome: { kind: "executed", text: "Command executed automatically on pane pane-1." } })
    );
    const session = spySession();
    resultToToolResponse(result, session, "propose_command", "call_7");
    assert.strictEqual(session.calls.length, 1);
    assert.deepStrictEqual(session.calls[0].response, { output: "Command executed automatically on pane pane-1." });
  });

  it("propose_command pending -> { status:pending_approval, messageId, pane_id, prompt } (legacy)", async () => {
    const result = await runAction(
      REGISTRY, "propose_command",
      { pane_id: "pane-9", instruction: "rm -rf build" },
      makeCtx({ dispatchOutcome: { kind: "pending", text: "Pending approval: run on pane pane-9." }, callId: "call_88" })
    );
    assert.strictEqual(result.kind, "pending");
    const session = spySession();
    resultToToolResponse(result, session, "propose_command", "call_88");
    assert.deepStrictEqual(session.calls[0].response, {
      status: "pending_approval",
      messageId: "call_88",
      pane_id: "pane-9",
      prompt: "Pending approval: run on pane pane-9.",
    });
  });

  it("propose_command clarify -> { status:clarify, output } (legacy)", async () => {
    const result = await runAction(
      REGISTRY, "propose_command",
      { pane_id: "pane-1", instruction: "sudo reboot" },
      makeCtx({ dispatchOutcome: { kind: "clarify", text: "That's not allowlisted — re-route to the agent." } })
    );
    const session = spySession();
    resultToToolResponse(result, session, "propose_command", "call_5");
    assert.deepStrictEqual(session.calls[0].response, {
      status: "clarify",
      output: "That's not allowlisted — re-route to the agent.",
    });
  });

  // ── amend_note: gateOrDefer durable Ask-defer path ──────────────────────────
  function fakeLedger() {
    const calls: { amended: Array<[string, string]> } = { amended: [] };
    const manager = { ledger: { amendNote: (id: string, text: string) => { calls.amended.push([id, text]); } } } as unknown as Partial<ActionContext["manager"]>;
    return { manager, calls };
  }

  it("amend_note Auto -> amendNote runs with bound text, ledger re-broadcast, exact string", async () => {
    const { manager, calls } = fakeLedger();
    const ledgerBroadcasts = { count: 0 };
    const result = await runAction(
      REGISTRY, "amend_note",
      { note_id: "note-1", text: "new body" },
      makeCtx({ disposition: { disposition: "run" }, manager, ledgerBroadcasts })
    );
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual((result as { output: string }).output, "Note note-1 updated.");
    assert.deepStrictEqual(calls.amended, [["note-1", "new body"]]);
    assert.strictEqual(ledgerBroadcasts.count, 1, "broadcastLedgerUpdate must fan out after the write");
  });

  it("amend_note Ask -> staged (NOT applied) + persists the durable intent { op,noteId,text }", async () => {
    const { manager, calls } = fakeLedger();
    const gateOrDeferCalls: GateOrDeferCall[] = [];
    const result = await runAction(
      REGISTRY, "amend_note",
      { note_id: "note-2", text: "deferred body" },
      makeCtx({ disposition: { disposition: "deferred", actionId: "act_1", summary: "Amend note note-2" }, manager, gateOrDeferCalls })
    );
    assert.strictEqual(result.kind, "ok");
    assert.match((result as { output: string }).output, /needs operator confirmation/i);
    assert.deepStrictEqual(calls.amended, [], "Ask must NOT apply the amend yet");
    // kzt lockstep: the enqueue-bound text + op + noteId are the durable intent buildActionRun reads.
    assert.deepStrictEqual(gateOrDeferCalls[0].params, { op: "amend", noteId: "note-2", text: "deferred body" });
    assert.strictEqual(gateOrDeferCalls[0].capability, "update_metadata");
    // And the staged run() closure, when later invoked (the confirm leg), applies EXACTLY that text.
    const applied = gateOrDeferCalls[0].run();
    assert.strictEqual(applied, "Note note-2 updated.");
    assert.deepStrictEqual(calls.amended, [["note-2", "deferred body"]], "confirm applies the enqueue-bound text");
  });

  it("amend_note Off -> forbidden message, no mutation", async () => {
    const { manager, calls } = fakeLedger();
    const result = await runAction(
      REGISTRY, "amend_note",
      { note_id: "note-3", text: "nope" },
      makeCtx({ disposition: { disposition: "forbidden" }, manager })
    );
    assert.strictEqual(result.kind, "ok");
    assert.match((result as { output: string }).output, /gated Off/i);
    assert.deepStrictEqual(calls.amended, [], "Off must not mutate");
  });
});
