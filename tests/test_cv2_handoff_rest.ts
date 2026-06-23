/**
 * tests/test_cv2_handoff_rest.ts — CV2 (cv2, operator decision D5): the FIVE handoff write voice tools
 * gain a REST twin under the canonical POST /api/<resource>/:id/<verb> family. compose/revise/stage/reject
 * are pure LEDGER ops (no pane write, no session use) — SAFE on the REST path (session:null). deliver
 * WRITES to a live pane but routes through ctx.dispatchProposal (the gated seam), so its twin enforces the
 * gate on REST via status-via-kinds. The twins are the CONTRACT the handoff-drawer UI buttons consume:
 *   propose_handoff -> POST   /api/handoffs                        (compose: create a 'composing' draft)
 *   revise_handoff  -> POST   /api/handoffs/:handoff_id/revise     (rewrite the composed prompt)
 *   stage_handoff   -> POST   /api/handoffs/:handoff_id/stage      (freeze -> staged)
 *   reject_handoff  -> POST   /api/handoffs/:handoff_id/reject     (cancel)
 *   deliver_handoff -> POST   /api/handoffs/:handoff_id/deliver    (gated write: 200/202/403 via kinds)
 *
 * Same doctrine as the c55 batches: run the REAL voice choke-point (runAction) with a fake ctx, then
 * assert applyResultToHttp maps the ActionResult to {status, body}. The PARITY assertion (the heart of
 * D5) is that the REST path routes to the SAME registry action object the voice path uses — there is
 * ONE handler, ONE gate, ONE redaction per action; REST and voice are two surfaces over it.
 *
 * Runner: npx tsx --test --test-force-exit tests/test_cv2_handoff_rest.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert";

import { REGISTRY } from "../src/actions/registry";
import { runAction } from "../src/actions/gemini";
import { applyResultToHttp, type RestResponse } from "../src/actions/rest";
import { INTENTIONAL_ASYMMETRY, surfaceCoverage } from "../src/actions/coverage";
import type { ActionContext, ActionDef } from "../src/actions/types";

function makeFakeRes(): { res: RestResponse; sent: { status?: number; json?: unknown } } {
  const sent: { status?: number; json?: unknown } = {};
  const res: RestResponse = { status(c: number) { sent.status = c; return res; }, json(p: unknown) { sent.json = p; return undefined; } };
  return { res, sent };
}
function findDef(name: string): ActionDef {
  const def = REGISTRY.find((d) => d.name === name);
  assert.ok(def, `registry must contain a def named '${name}'`);
  return def!;
}
async function runToHttp(name: string, args: Record<string, unknown>, ctx: ActionContext) {
  const def = findDef(name);
  const result = await runAction(REGISTRY, name, args, ctx);
  const { res, sent } = makeFakeRes();
  applyResultToHttp(def, result, args, res);
  return { result, status: sent.status, json: sent.json };
}

/**
 * A fake ctx with a minimal in-memory handoff store. session is NULL (the REST path), so this also
 * proves session:null is handled — none of these four handlers touch ctx.session.
 */
function makeCtx(opts: { gateOff?: boolean; dispatch?: (o: any) => any } = {}): {
  ctx: ActionContext;
  calls: string[];
  store: any;
  gateArgs: Array<{ pane: unknown; cap: unknown }>;
} {
  const calls: string[] = [];
  const gateArgs: Array<{ pane: unknown; cap: unknown }> = [];
  const rows = new Map<string, any>();
  let seq = 0;
  const store: any = {
    createHandoff: (h: any) => {
      const id = `h${++seq}`;
      const row = { id, revision_count: 0, ...h };
      rows.set(id, row);
      calls.push(`createHandoff:${h.to_pane}`);
      return row;
    },
    updateHandoffCargo: (id: string, text: string) => {
      const row = rows.get(id);
      if (!row) return null;
      row.composed_prompt = text;
      row.revision_count = (row.revision_count ?? 0) + 1;
      calls.push(`updateHandoffCargo:${id}`);
      return row;
    },
    getHandoff: (id: string) => { calls.push(`getHandoff:${id}`); return rows.get(id) ?? null; },
    updateHandoffState: (id: string, state: string, _o?: unknown) => {
      const row = rows.get(id);
      if (row) row.state = state;
      calls.push(`updateHandoffState:${id}:${state}`);
      return row ?? null;
    },
    setGateApprovalId: (id: string, gid: string) => { calls.push(`setGateApprovalId:${id}:${gid}`); },
    recordActivity: (a: any) => { calls.push(`recordActivity:${a.summary}`); },
  };
  const ledger: any = { activeProjectId: "proj", getProject: () => ({ id: "proj", panes: [{ id: "p1" }, { id: "p9" }] }) };
  // Seed the target panes as LIVE terminals so stage_handoff's existence guard (terminals[to_pane] ||
  // findPaneOwningProject) passes — staging requires the target pane to still exist.
  const terminals: Record<string, any> = {
    p1: { runtimeType: "agent" },
    p9: { runtimeType: "agent" },
  };
  const ctx = {
    manager: { ledger, terminals, getPaneSummary: () => "", settings: { advanced: {} } },
    store,
    session: null,
    surface: "rest",
    callId: "",
    broadcast: (m: any) => { calls.push(`broadcast:${m?.type}`); },
    broadcastLedgerUpdate: () => { calls.push("ledger_broadcast"); },
    redact: (s: string) => s,
    isFrozen: () => false,
    // Capture every (pane, capability) the handler asks the gate about — so the Off-veto parity test can
    // assert the compose composers gate on EXACTLY (pane===null, cap==="compose_draft"), not some other key.
    effectiveCapabilityGateFor: (pane: unknown, cap: unknown) => {
      gateArgs.push({ pane, cap });
      return (opts.gateOff ? "Off" : "Auto");
    },
    pendingApprovals: { has: () => false } as any,
    applyResolution: () => ({}) as any,
    // deliver_handoff routes its pane write through ctx.dispatchProposal (restDispatchProposal on REST).
    // Default fake: an "executed" outcome (Full Auto). Tests override via opts.dispatch to exercise
    // pending (HiTL -> 202) and blocked (Off -> 403).
    dispatchProposal: (o: any) => {
      calls.push(`dispatchProposal:${o?.capability}:${o?.targetId}`);
      return opts.dispatch ? opts.dispatch(o) : { kind: "executed", text: "ok" };
    },
  } as unknown as ActionContext;
  return { ctx, calls, store, gateArgs };
}

// ── the four CV2 compose/revise/stage/reject twins, with their canonical POST .../:id/<verb> bindings.
// deliver_handoff is the FIFTH twin but is exercised separately (its capability is ALWAYS_ALLOWED and it
// routes through ctx.dispatchProposal, so it does not share these pure-ledger compose_draft assertions).
const SHAPE: Array<{ name: string; method: "get" | "post" | "put" | "delete"; path: string; capability: string }> = [
  { name: "propose_handoff", method: "post", path: "/api/handoffs", capability: "compose_draft" },
  { name: "revise_handoff", method: "post", path: "/api/handoffs/:handoff_id/revise", capability: "compose_draft" },
  { name: "stage_handoff", method: "post", path: "/api/handoffs/:handoff_id/stage", capability: "compose_draft" },
  { name: "reject_handoff", method: "post", path: "/api/handoffs/:handoff_id/reject", capability: "compose_draft" },
];

describe("cv2 — handoff compose/revise/stage/reject gain a REST twin (shape + parity)", () => {
  for (const { name, method, path: p, capability } of SHAPE) {
    it(`${name} is voice+rest capability:${capability}, binds ${method.toUpperCase()} ${p}, NOT allow-listed`, () => {
      const def = findDef(name);
      assert.strictEqual(def.capability, capability);
      assert.strictEqual(def.readOnly, false);
      // The twin is multi-surface now (voice AND rest) — the heart of the convergence.
      assert.ok(def.surfaces.has("voice"), `${name} stays on voice`);
      assert.ok(def.surfaces.has("rest"), `${name} gains a REST twin`);
      assert.strictEqual(def.rest?.method, method, `${name} rest method`);
      assert.strictEqual(def.rest?.path, p, `${name} rest path (registry-canonical, derived from /api/handoffs)`);
      // Multi-surface tools are NEVER allow-listed (isMultiSurface skips them) — removing the entry
      // from INTENTIONAL_ASYMMETRY is exactly how the Convergence track forced the twin to exist.
      assert.strictEqual(INTENTIONAL_ASYMMETRY[name], undefined, `${name} must be OFF the allow-list now that it is multi-surface`);
    });
  }

  it("surfaceCoverage reports voice:true AND rest:true for all four converged twins", () => {
    const byName = new Map(surfaceCoverage(REGISTRY).map((r) => [r.name, r]));
    for (const { name } of SHAPE) {
      const row = byName.get(name);
      assert.ok(row, `${name} missing from surfaceCoverage`);
      assert.strictEqual(row.voice, true, `${name} voice`);
      assert.strictEqual(row.rest, true, `${name} rest`);
    }
  });
});

describe("cv2 — REST path routes to the SAME registry action the voice path uses (one handler, session:null)", () => {
  it("propose_handoff (POST /api/handoffs) -> createHandoff + broadcast, 200, returns the composing draft", async () => {
    const { ctx, calls } = makeCtx();
    const { status, json } = await runToHttp("propose_handoff", { to_pane: "p1", draft_text: "do the thing" }, ctx);
    assert.strictEqual(status, 200);
    assert.ok(calls.some((c) => c.startsWith("createHandoff:p1")), "the REST twin ran the SAME createHandoff path");
    assert.ok(calls.includes("broadcast:handoffs_updated"), "broadcasts handoffs_updated");
    const out = (json as { output?: any }).output;
    assert.strictEqual(out.state, "composing");
    assert.strictEqual(out.to_pane, "p1");
  });

  it("propose_handoff accepts the camelCase UI body (toPane/draftText) — drawer contract", async () => {
    const { ctx, calls } = makeCtx();
    const { status } = await runToHttp("propose_handoff", { toPane: "p9", draftText: "hi" }, ctx);
    assert.strictEqual(status, 200);
    assert.ok(calls.some((c) => c.startsWith("createHandoff:p9")), "camelCase toPane was aliased to to_pane");
  });

  it("revise_handoff (PUT /api/handoffs/:handoff_id) -> updateHandoffCargo + broadcast, 200", async () => {
    const { ctx, calls } = makeCtx();
    await runToHttp("propose_handoff", { to_pane: "p1", draft_text: "v1" }, ctx);
    const { status, json } = await runToHttp("revise_handoff", { handoff_id: "h1", new_draft_text: "v2" }, ctx);
    assert.strictEqual(status, 200);
    assert.ok(calls.includes("updateHandoffCargo:h1"), "ran the SAME updateHandoffCargo path");
    const out = (json as { output?: any }).output;
    assert.strictEqual(out.revision_count, 1);
  });

  it("revise_handoff accepts the camelCase UI body (newDraftText) — drawer contract", async () => {
    const { ctx, store } = makeCtx();
    await runToHttp("propose_handoff", { to_pane: "p1", draft_text: "v1" }, ctx);
    const { status } = await runToHttp("revise_handoff", { handoff_id: "h1", newDraftText: "edited" }, ctx);
    assert.strictEqual(status, 200);
    assert.strictEqual(store.getHandoff("h1").composed_prompt, "edited", "camelCase newDraftText was aliased to new_draft_text");
  });

  it("stage_handoff (POST /api/handoffs/:handoff_id/stage) -> staged + broadcast, 200", async () => {
    const { ctx, calls } = makeCtx();
    await runToHttp("propose_handoff", { to_pane: "p1", draft_text: "ship it" }, ctx);
    const { status } = await runToHttp("stage_handoff", { handoff_id: "h1" }, ctx);
    assert.strictEqual(status, 200);
    assert.ok(calls.includes("updateHandoffState:h1:staged"), "ran the SAME staging path");
  });

  it("reject_handoff (POST /api/handoffs/:handoff_id/reject) -> rejected + broadcast, 200", async () => {
    const { ctx, calls } = makeCtx();
    await runToHttp("propose_handoff", { to_pane: "p1", draft_text: "nope" }, ctx);
    const { status, json } = await runToHttp("reject_handoff", { handoff_id: "h1" }, ctx);
    assert.strictEqual(status, 200);
    assert.ok(calls.includes("updateHandoffState:h1:rejected"), "ran the SAME reject path");
    assert.strictEqual((json as { output?: any }).output.state, "rejected");
  });

  it("compose_draft Off veto blocks the REST twin EXACTLY as it blocks voice (one gate, asserted args)", async () => {
    const { ctx, gateArgs } = makeCtx({ gateOff: true });
    const { status, json } = await runToHttp("propose_handoff", { to_pane: "p1", draft_text: "x" }, ctx);
    // The handler returns kind:"ok" with an error narration (veto-class), -> 200 {output:"Error: ...Off..."}.
    assert.strictEqual(status, 200);
    assert.match(String((json as { output?: unknown }).output), /gated Off/, "the SAME veto string the voice path emits");
    // Tighten: the veto is taken because the handler asked the gate about the EXACT (pane, capability) the
    // compose_draft veto is keyed on — pane===null (handoffs are workspace-scoped, not pane-scoped) and
    // cap==="compose_draft". A drift to a pane id or a different capability would silently mis-gate.
    assert.ok(
      gateArgs.some((g) => g.pane === null && g.cap === "compose_draft"),
      `propose_handoff must veto on effectiveCapabilityGateFor(null, "compose_draft"); got ${JSON.stringify(gateArgs)}`,
    );
  });
});

// ── cutover guard: the registry auto-serves each twin; no inline twin shadows it ───────────────────
describe("cv2 — registry auto-serves the five handoff write twins", () => {
  const mountedNames = new Set(
    REGISTRY.filter((d) => d.surfaces.has("rest") && !!d.rest).map((d) => d.name),
  );
  for (const name of [...SHAPE.map((s) => s.name), "deliver_handoff"]) {
    it(`mountRestRoutes auto-serves "${name}" (rest-surfaced in REGISTRY)`, () => {
      assert.ok(mountedNames.has(name), `"${name}" must be a rest-mounted REGISTRY def after the cv2 convergence`);
    });
  }
});

// ── verb/param drift guard: each WRITE twin's rest.path param token must be a key in its zod schema ──
// A path like POST /api/handoffs/:handoff_id/revise carries a `:handoff_id` token; Express injects it as
// args.handoff_id, so the def's zod schema MUST have a `handoff_id` key or the route param silently
// vanishes (validation drops the unknown key). This pins verb+path against the schema so a rename of the
// schema key (or a typo in the path token) fails loudly. Collection routes (no `:token`) trivially pass.
describe("cv2 — each handoff write twin's rest.path param tokens are keys in its zod schema", () => {
  const WRITE_TWINS = [...SHAPE.map((s) => s.name), "deliver_handoff"];
  for (const name of WRITE_TWINS) {
    it(`${name}: every :token in rest.path is a key of the def's params schema`, () => {
      const def = findDef(name);
      assert.ok(def.rest, `${name} must declare a rest binding`);
      const tokens = def.rest!.path.split("/").filter((s) => s.startsWith(":")).map((s) => s.slice(1));
      // The zod object's declared keys (ZodObject.shape) — the args the handler/validator accept.
      const shape = (def.params as unknown as { shape?: Record<string, unknown> }).shape ?? {};
      const keys = new Set(Object.keys(shape));
      for (const tok of tokens) {
        assert.ok(keys.has(tok), `${name} rest.path param :${tok} has no matching key in its zod schema (keys: ${[...keys].join(", ")})`);
      }
    });
  }
});

// ── deliver_handoff: the FIFTH twin. It WRITES via ctx.dispatchProposal, so status-via-kinds maps the
// DispatchOutcome to HTTP at PARITY with voice: executed->200, pending(HiTL)->202, blocked(Off)->403. ──
describe("cv2 — deliver_handoff gains a gated REST twin (status-via-kinds parity)", () => {
  it("is voice+rest, ALWAYS_ALLOWED, binds POST /api/handoffs/:handoff_id/deliver, NOT allow-listed", () => {
    const def = findDef("deliver_handoff");
    assert.strictEqual(def.readOnly, false);
    assert.ok(def.surfaces.has("voice"), "deliver_handoff stays on voice");
    assert.ok(def.surfaces.has("rest"), "deliver_handoff gains a REST twin");
    assert.strictEqual(def.rest?.method, "post", "deliver rest method");
    assert.strictEqual(def.rest?.path, "/api/handoffs/:handoff_id/deliver", "deliver canonical POST .../:id/<verb> path");
    assert.strictEqual(INTENTIONAL_ASYMMETRY["deliver_handoff"], undefined, "deliver must be OFF the allow-list now that it is multi-surface");
  });

  it("Full Auto (dispatch executed) -> 200, flips the row to delivered via the SAME handler", async () => {
    const { ctx, calls } = makeCtx({ dispatch: () => ({ kind: "executed", text: "ok" }) });
    await runToHttp("propose_handoff", { to_pane: "p1", draft_text: "go" }, ctx);
    await runToHttp("stage_handoff", { handoff_id: "h1" }, ctx);
    const { status } = await runToHttp("deliver_handoff", { handoff_id: "h1" }, ctx);
    assert.strictEqual(status, 200, "executed dispatch -> 200");
    assert.ok(calls.includes("dispatchProposal:deliver_handoff:p1"), "routed through the gated dispatchProposal seam with the deliver_handoff capability");
    assert.ok(calls.includes("updateHandoffState:h1:delivered"), "flipped the row to delivered");
  });

  it("HiTL (dispatch pending) -> 202 pending_approval (the gate staged an approval to read back)", async () => {
    const { ctx } = makeCtx({ dispatch: () => ({ kind: "pending", text: "approve?" }) });
    await runToHttp("propose_handoff", { to_pane: "p1", draft_text: "go" }, ctx);
    await runToHttp("stage_handoff", { handoff_id: "h1" }, ctx);
    const { status, json } = await runToHttp("deliver_handoff", { handoff_id: "h1" }, ctx);
    assert.strictEqual(status, 202, "pending dispatch -> 202");
    assert.strictEqual((json as { status?: string }).status, "pending_approval");
  });

  it("gate Off (dispatch blocked) -> 403, records the blocked_read_only row (status-via-kinds)", async () => {
    const { ctx, calls } = makeCtx({ dispatch: () => ({ kind: "blocked", text: "blocked: deliver_handoff is Off" }) });
    await runToHttp("propose_handoff", { to_pane: "p1", draft_text: "go" }, ctx);
    await runToHttp("stage_handoff", { handoff_id: "h1" }, ctx);
    const { status, json } = await runToHttp("deliver_handoff", { handoff_id: "h1" }, ctx);
    assert.strictEqual(status, 403, "blocked dispatch -> 403 (status-via-kinds, NOT a 200 narration)");
    assert.match(String((json as { error?: unknown }).error), /blocked/, "the blocked dispatch text rides resultToHttp's { error } body");
    assert.ok(calls.includes("updateHandoffState:h1:blocked_read_only"), "recorded the blocked_read_only row");
  });

  it("a non-staged handoff -> 200 narration (cannot deliver), no dispatch", async () => {
    const { ctx, calls } = makeCtx();
    await runToHttp("propose_handoff", { to_pane: "p1", draft_text: "go" }, ctx);
    const { status } = await runToHttp("deliver_handoff", { handoff_id: "h1" }, ctx);
    assert.strictEqual(status, 200, "not-staged is a plain narration -> 200");
    assert.ok(!calls.some((c) => c.startsWith("dispatchProposal:")), "never reached the gated seam for a non-staged handoff");
  });
});
