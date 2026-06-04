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
import type { ActionContext, ActionDef, ActionResult, GateDisposition } from "../src/actions/types";
import {
  CAPABILITY_DEFS,
  deriveCapabilities,
  spotlightCapabilities,
} from "../src/actions/capabilities";
import { toGeminiDeclarations, runAction, resultToToolResponse, zodToGeminiSchema } from "../src/actions/gemini";
import { redactSecrets } from "../src/terminal";

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

/** Build a stub ctx. `disposition` controls what the injected gateOrDefer returns. */
function makeCtx(opts: {
  disposition?: GateDisposition;
  manager?: Partial<ActionContext["manager"]>;
  redact?: (s: string) => string;
  gateSpy?: { count: number };
  broadcasts?: unknown[];
} = {}): ActionContext {
  const disposition = opts.disposition ?? { disposition: "run" };
  const broadcasts = opts.broadcasts ?? [];
  return {
    manager: (opts.manager ?? {}) as ActionContext["manager"],
    session: null,
    callId: "call_test",
    trigger: "test",
    broadcast: (msg) => { broadcasts.push(msg); },
    gateOrDefer: (_cap, _pane, summary, _run) => {
      if (opts.gateSpy) opts.gateSpy.count += 1;
      // The deferred disposition needs an actionId/summary; thread the summary through.
      if (disposition.disposition === "deferred") {
        return { disposition: "deferred", actionId: disposition.actionId, summary };
      }
      return disposition;
    },
    redact: opts.redact ?? ((s) => s),
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
// §8.3 — runAction gate + redaction
// ─────────────────────────────────────────────────────────────────────────────
describe("§8.3 runAction gate + redaction", () => {
  // A tiny gated test action whose handler records whether it ran (the "side effect").
  function gatedAction(ran: { value: boolean }): ActionDef<z.ZodObject<Record<string, never>>> {
    return {
      name: "test_gated",
      description: "test gated action",
      params: z.object({}),
      capability: "update_metadata",
      readOnly: false,
      surfaces: new Set(["voice"]),
      handler: (): ActionResult => {
        ran.value = true;
        return { kind: "ok", output: "did the thing" };
      },
    };
  }

  it("a gated action with capability=Auto runs the handler", async () => {
    const ran = { value: false };
    const reg = [gatedAction(ran)];
    const result = await runAction(reg, "test_gated", {}, makeCtx({ disposition: { disposition: "run" } }));
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(ran.value, true);
  });

  it("a gated action with capability=Ask returns pending and does not mutate", async () => {
    const ran = { value: false };
    const reg = [gatedAction(ran)];
    const result = await runAction(
      reg, "test_gated", {},
      makeCtx({ disposition: { disposition: "deferred", actionId: "act_42", summary: "x" } })
    );
    assert.strictEqual(result.kind, "pending");
    assert.strictEqual((result as { messageId: string }).messageId, "act_42");
    assert.strictEqual(ran.value, false, "handler side-effect must be absent when deferred");
  });

  it("a gated action with capability=Off returns blocked (handler not called)", async () => {
    const ran = { value: false };
    const reg = [gatedAction(ran)];
    const result = await runAction(reg, "test_gated", {}, makeCtx({ disposition: { disposition: "forbidden" } }));
    assert.strictEqual(result.kind, "blocked");
    assert.strictEqual(ran.value, false);
  });

  it("ALWAYS_ALLOWED bypasses the gate (gateOrDefer never consulted)", async () => {
    const gateSpy = { count: 0 };
    // Even with a forbidden disposition configured, the brake must run because the gate is bypassed.
    const result = await runAction(
      REGISTRY, "stop_all", {},
      makeCtx({ disposition: { disposition: "forbidden" }, gateSpy })
    );
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(gateSpy.count, 0, "gateOrDefer must NOT be consulted for ALWAYS_ALLOWED");
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
