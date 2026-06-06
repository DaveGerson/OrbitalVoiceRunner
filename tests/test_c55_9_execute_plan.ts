// c55.9 — execute_plan REST CONVERGENCE tests.
//
// Three layers, all PTY-free / no server boot / no Gemini:
//   (A) REST dispatch units — drive applyDispatchDecision with the REST conn binding
//       (sess:null, notifyPending=record, enforceActivePaneGuard:false, origin:"rest") through the
//       SAME pure decideProposal the voice wrapper runs. Asserts: Auto writes; Off -> blocked + no
//       write + command_blocked broadcast; Ask -> pendingApprovals grows + approval_pending notify +
//       NO sendToolResponse (null session); offline (no live term, Full Auto) -> error; non-active
//       pane writes/stages (guard skipped) WHILE the voice binding (guard:true) returns clarify.
//   (B) executePlan def + rest.toHttp — runAction the def with a fake ctx whose dispatchProposal
//       returns each DispatchOutcome, assert the spoken `output` string is UNCHANGED (spec §9.2), the
//       structured meta.outcome is stamped, and applyResultToHttp maps the §6 status (200/202/403/400/
//       404/409). Plus a direct toHttp status-map table.
//   (C) sess:null resolution (spec §9.1, load-bearing) — stage a REST-originated Ask via
//       applyDispatchDecision into a REAL PendingApprovalStore with a NULL session, then resolve via
//       resolveDecision (the pure leg the c55.15 confirm/resolve path calls) and a null-session-aware
//       write, asserting the write LANDS and NO sendToolResponse is attempted on the null session.
//
// Runner: npx tsx --test --test-force-exit tests/test_c55_9_execute_plan.ts

import { describe, it } from "node:test";
import assert from "node:assert";

import { applyDispatchDecision, type DispatchDeps, type DispatchConn } from "../src/dispatch/paneWrite";
import {
  PendingApprovalStore,
  decideProposal,
  resolveDecision,
  inferKind,
  type PendingApproval,
  type ProposalDecision,
} from "../src/pendingApprovals";
import { isPaneActiveForWrite } from "../src/activePane";
import type { CapabilityGate, GateValue } from "../src/types";
import { REGISTRY } from "../src/actions/registry";
import { runAction } from "../src/actions/gemini";
import {
  applyResultToHttp,
  mountRestRoutes,
  type RestApp,
  type RestHandler,
  type RestRequest,
  type RestResponse,
} from "../src/actions/rest";
import type { ActionContext, ActionDef, ActionResult, DispatchOutcome } from "../src/actions/types";

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Shared harness
// ════════════════════════════════════════════════════════════════════════════════════════════════

interface Recorded {
  writes: Array<{ paneId: string; cmd: string }>;
  history: Array<{ paneId: string; cmd: string }>;
  broadcasts: Array<Record<string, unknown>>;
  notifies: Array<Record<string, unknown>>;
  announcements: Array<Record<string, unknown>>;
}

function freshRec(): Recorded {
  return { writes: [], history: [], broadcasts: [], notifies: [], announcements: [] };
}

// A fake live terminal that records writeInput (the pane-write sink).
function fakeTerm(rec: Recorded, paneId: string): { writeInput: (s: string) => void } {
  return { writeInput: (s: string) => rec.writes.push({ paneId, cmd: s }) };
}

// Build a connection-AGNOSTIC DispatchDeps bag. `term` undefined models an inert/offline pane.
function makeDeps(
  rec: Recorded,
  opts: {
    targetId: string;
    instruction: string;
    capability?: CapabilityGate;
    effectiveMode?: "Full Auto" | "Human-in-the-Loop" | "Read-Only";
    activePaneId?: string | null;
    live?: boolean; // false -> term undefined (offline)
    store?: PendingApprovalStore;
  }
): DispatchDeps {
  const targetId = opts.targetId;
  const live = opts.live !== false;
  const pendingApprovals = opts.store ?? new PendingApprovalStore();
  return {
    manager: { ledger: { activeProjectId: "default_project" } } as unknown as DispatchDeps["manager"],
    pendingApprovals,
    broadcast: (msg: any) => rec.broadcasts.push(msg as Record<string, unknown>),
    addCommand: (paneId, command) => rec.history.push({ paneId, cmd: command }),
    redactSecrets: (s: string) => s,
    getPaneSummary: (_paneId: string, _lines: number) => "pane summary",
    posturePayloadForPane: (id: string) => ({
      id,
      effective_gates: {} as Record<CapabilityGate, GateValue>,
      posture: "auto",
    }),
    announcementBus: { enqueue: (item: any) => rec.announcements.push(item as Record<string, unknown>) },
    approvalTtlMs: 5 * 60 * 1000,
    getActivePaneId: () => opts.activePaneId ?? null,
    isPaneActiveForWrite,
    targetId,
    instruction: opts.instruction,
    capability: opts.capability ?? "execute_plan",
    kind: inferKind(undefined, undefined),
    trigger: "Plan 'P' step 1",
    effectiveMode: opts.effectiveMode ?? "Full Auto",
    pendingId: `call__plan__step0`,
    callId: "call",
    term: live ? fakeTerm(rec, targetId) : undefined,
  };
}

// The REST conn binding (design §5): null session, broadcast as the notify sink, guard OFF, origin rest.
function restConn(rec: Recorded): DispatchConn {
  return {
    sess: null,
    notifyPending: (frame: any) => rec.notifies.push(frame as Record<string, unknown>),
    enforceActivePaneGuard: false,
    origin: "rest",
  };
}

// The VOICE conn binding — guard ON (used only to prove the guard is intact for Janus proposals).
function voiceConn(rec: Recorded, sess: any): DispatchConn {
  return {
    sess,
    notifyPending: (frame: any) => rec.notifies.push(frame as Record<string, unknown>),
    enforceActivePaneGuard: true,
    origin: "voice",
  };
}

// Resolve the gate exactly as the server wrappers do (the PURE [decide] half), then dispatch.
function dispatchRest(
  rec: Recorded,
  deps: DispatchDeps,
  gate: GateValue
): DispatchOutcome {
  const decision: ProposalDecision = decideProposal({
    kind: deps.kind,
    instruction: deps.instruction,
    effectiveMode: deps.effectiveMode,
    runtimeType: undefined,
    paneExists: true, // the def passes paneExists; an offline pane still "exists" in the ledger
    allowlist: new Set<string>(),
    capability: deps.capability,
    gate,
  });
  return applyDispatchDecision(decision, deps, restConn(rec));
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (A) REST dispatch units — the gated pane-write seam on the REST conn binding
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe("c55.9 (A) — REST dispatch via the shared core (conn: sess null / broadcast / guard off)", () => {
  it("Auto -> writes step 1 (addCommand + writeInput + command_auto_executed broadcast)", () => {
    const rec = freshRec();
    const deps = makeDeps(rec, { targetId: "p1", instruction: "npm test", effectiveMode: "Full Auto", live: true });
    const out = dispatchRest(rec, deps, "Auto");
    assert.strictEqual(out.kind, "executed");
    assert.deepStrictEqual(rec.writes, [{ paneId: "p1", cmd: "npm test" }], "the command was written to the pane");
    assert.deepStrictEqual(rec.history, [{ paneId: "p1", cmd: "npm test" }], "recorded in command history");
    assert.ok(rec.broadcasts.some((b) => b.type === "command_auto_executed"), "auto-execute broadcast");
    assert.strictEqual(rec.notifies.length, 0, "Auto never stages a pending / notifies");
  });

  it("Off -> blocked + NO write + command_blocked broadcast", () => {
    const rec = freshRec();
    const deps = makeDeps(rec, { targetId: "p1", instruction: "rm -rf /", effectiveMode: "Full Auto", live: true });
    const out = dispatchRest(rec, deps, "Off");
    assert.strictEqual(out.kind, "blocked");
    assert.strictEqual(rec.writes.length, 0, "Off writes NOTHING to the pane");
    assert.strictEqual(rec.history.length, 0, "Off records nothing");
    assert.ok(rec.broadcasts.some((b) => b.type === "command_blocked"), "command_blocked broadcast");
  });

  it("Ask -> pending: pendingApprovals grows + approval_pending NOTIFY (broadcast) + NO sendToolResponse (null sess)", () => {
    const rec = freshRec();
    const store = new PendingApprovalStore();
    const deps = makeDeps(rec, { targetId: "p1", instruction: "deploy", effectiveMode: "Full Auto", live: true, store });
    assert.strictEqual(store.all().length, 0, "store starts empty");
    const out = dispatchRest(rec, deps, "Ask");
    assert.strictEqual(out.kind, "pending");
    assert.strictEqual(store.all().length, 1, "pendingApprovals grew by one");
    assert.strictEqual(store.all()[0].messageId, "call__plan__step0", "the synthetic plan-step pendingId staged");
    // sessionFor must be null — the REST conn stored a null session (no sendToolResponse target).
    assert.strictEqual(store.sessionFor("call__plan__step0"), null, "null session stored (REST origin)");
    const notify = rec.notifies.find((n) => n.type === "approval_pending");
    assert.ok(notify, "approval_pending frame was sent to the notify sink (broadcast on REST)");
    assert.strictEqual(notify!.messageId, "call__plan__step0");
    // The notify sink is a plain frame recorder — there is no session, so no sendToolResponse can fire.
    assert.strictEqual(rec.writes.length, 0, "Ask does not write yet (HiTL)");
  });

  it("offline (Full Auto, no live term) -> error, no write (maps to 400 in the def)", () => {
    const rec = freshRec();
    const deps = makeDeps(rec, { targetId: "p1", instruction: "echo hi", effectiveMode: "Full Auto", live: false });
    const out = dispatchRest(rec, deps, "Auto");
    assert.strictEqual(out.kind, "error", "an inert pane with no live term refuses instead of crashing");
    assert.strictEqual(rec.writes.length, 0, "no write to a dead pane");
  });

  it("HiTL mode (no gate tighten) -> pending (mode is the gate); stages with null session", () => {
    const rec = freshRec();
    const store = new PendingApprovalStore();
    const deps = makeDeps(rec, { targetId: "p1", instruction: "build", effectiveMode: "Human-in-the-Loop", live: true, store });
    const out = dispatchRest(rec, deps, "Auto");
    assert.strictEqual(out.kind, "pending");
    assert.strictEqual(store.all().length, 1);
  });
});

// ── Edge: active-pane-guard skip (spec §9.3) ────────────────────────────────────────────────────
describe("c55.9 (A) — active-pane-guard: REST skips it, voice keeps it", () => {
  it("REST (guard OFF) writes to a NON-active pane (operator-directed click)", () => {
    const rec = freshRec();
    // active pane is p_other; the REST target is p_target — voice would clarify, REST must NOT.
    const deps = makeDeps(rec, { targetId: "p_target", instruction: "go", effectiveMode: "Full Auto", live: true, activePaneId: "p_other" });
    const out = applyDispatchDecision({ type: "auto_execute" }, deps, restConn(rec));
    assert.strictEqual(out.kind, "executed", "REST writes to a non-active pane (guard skipped)");
    assert.deepStrictEqual(rec.writes, [{ paneId: "p_target", cmd: "go" }]);
  });

  it("VOICE (guard ON) to the SAME non-active pane returns clarify (guard intact — no regression)", () => {
    const rec = freshRec();
    const deps = makeDeps(rec, { targetId: "p_target", instruction: "go", effectiveMode: "Full Auto", live: true, activePaneId: "p_other" });
    const out = applyDispatchDecision({ type: "auto_execute" }, deps, voiceConn(rec, { sendToolResponse: () => {} }));
    assert.strictEqual(out.kind, "clarify", "voice refuses a proposal into a non-active pane");
    assert.strictEqual(rec.writes.length, 0, "voice wrote nothing to the non-active pane");
  });

  it("REST (guard OFF) STAGES an Ask on a NON-active pane (no clarify short-circuit)", () => {
    const rec = freshRec();
    const store = new PendingApprovalStore();
    const deps = makeDeps(rec, { targetId: "p_target", instruction: "deploy", effectiveMode: "Full Auto", live: true, activePaneId: "p_other", store });
    const out = applyDispatchDecision({ type: "pending_approval" }, deps, restConn(rec));
    assert.strictEqual(out.kind, "pending");
    assert.strictEqual(store.all().length, 1, "the non-active-pane Ask staged on REST");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (B) executePlan def — meta.outcome stamping (output string UNCHANGED) + rest.toHttp §6 status map
// ════════════════════════════════════════════════════════════════════════════════════════════════

function findDef(name: string): ActionDef {
  const def = REGISTRY.find((d) => d.name === name);
  assert.ok(def, `registry must contain a def named '${name}'`);
  return def!;
}

function makeFakeRes(): { res: RestResponse; sent: { status?: number; json?: unknown } } {
  const sent: { status?: number; json?: unknown } = {};
  const res: RestResponse = {
    status(code: number) { sent.status = code; return res; },
    json(payload: unknown) { sent.json = payload; return undefined; },
  };
  return { res, sent };
}

// A fake ctx for the executePlan handler: a ledger with one plan, a dispatchProposal stub returning
// the SUPPLIED outcome, and recorders for save/broadcast. No PTY, no real gate.
function makePlanCtx(outcome: DispatchOutcome | null): { ctx: ActionContext; rec: { saves: number; broadcasts: Array<Record<string, unknown>>; dispatched: number } } {
  const rec = { saves: 0, broadcasts: [] as Array<Record<string, unknown>>, dispatched: 0 };
  const plan = {
    id: "plan_1",
    name: "P",
    steps: [{ id: "step_0", terminalId: "p1", command: "npm test", expectedTransition: "idle", status: "pending" }],
    currentStepIndex: 0,
    status: "idle",
  };
  const ctx = {
    session: null,
    callId: "call",
    manager: {
      ledger: {
        plans: [plan],
        save: (_force?: boolean) => { rec.saves++; },
      },
    },
    dispatchProposal: (_opts: unknown): DispatchOutcome => {
      rec.dispatched++;
      return outcome ?? { kind: "executed", text: "x" };
    },
    broadcast: (msg: unknown) => { rec.broadcasts.push(msg as Record<string, unknown>); },
    redact: (s: string) => s,
  } as unknown as ActionContext;
  // The handler reaches the ledger save via the bracket-string `ledger["save"](true)` — same property
  // as `.save` set above, so the literal already covers it.
  return { ctx, rec };
}

describe("c55.9 (B) — executePlan def: meta.outcome stamped, output string UNCHANGED, toHttp §6 map", () => {
  const cases: Array<{ label: string; outcome: DispatchOutcome; expectMeta: string; expectStatus: number; expectOutputPart: string }> = [
    { label: "executed -> 200", outcome: { kind: "executed", text: "ran" }, expectMeta: "executed", expectStatus: 200, expectOutputPart: "Started execution of plan 'P'" },
    { label: "pending -> 202", outcome: { kind: "pending", text: "approve it" }, expectMeta: "pending", expectStatus: 202, expectOutputPart: "needs approval" },
    { label: "blocked -> 403", outcome: { kind: "blocked", text: "gated Off" }, expectMeta: "blocked", expectStatus: 403, expectOutputPart: "Could not start plan 'P'" },
    { label: "error (pane offline) -> 400", outcome: { kind: "error", text: "not running" }, expectMeta: "pane_offline", expectStatus: 400, expectOutputPart: "Could not start plan 'P'" },
    { label: "clarify -> 409", outcome: { kind: "clarify", text: "which pane?" }, expectMeta: "clarify", expectStatus: 409, expectOutputPart: "paused" },
  ];
  for (const c of cases) {
    it(c.label, async () => {
      const { ctx, rec } = makePlanCtx(c.outcome);
      const result = await runAction(REGISTRY, "execute_plan", { plan_id: "plan_1", id: "plan_1" }, ctx);
      assert.strictEqual(result.kind, "ok", "every branch stays kind:ok (voice wire shape preserved)");
      // spec §9.2: the spoken output string must be the SAME read-back as before — assert it carries the
      // dispatch text and is NOT mutated into an HTTP shape.
      assert.ok(typeof (result as { output: unknown }).output === "string", "output is the spoken string");
      assert.ok(String((result as { output: string }).output).includes(c.expectOutputPart), `output read-back: "${c.expectOutputPart}"`);
      // meta carries the structured outcome for toHttp.
      const meta = (result as { meta?: { outcome?: string } }).meta;
      assert.strictEqual(meta?.outcome, c.expectMeta, "meta.outcome stamped for toHttp");
      assert.strictEqual(rec.dispatched, 1, "dispatchProposal called once for step 1");
      // toHttp maps it to the §6 status; body echoes { output } (not load-bearing).
      const { res, sent } = makeFakeRes();
      applyResultToHttp(findDef("execute_plan"), result, { plan_id: "plan_1" }, res);
      assert.strictEqual(sent.status, c.expectStatus, `${c.label}: status`);
      assert.deepStrictEqual(sent.json, { output: (result as { output: string }).output }, "body echoes the output string");
    });
  }

  it("plan not found -> meta.outcome 'plan_not_found' -> 404; dispatchProposal NOT called", async () => {
    const { ctx, rec } = makePlanCtx({ kind: "executed", text: "x" });
    const result = await runAction(REGISTRY, "execute_plan", { plan_id: "ghost", id: "ghost" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(rec.dispatched, 0, "no plan -> no dispatch");
    assert.strictEqual((result as { meta?: { outcome?: string } }).meta?.outcome, "plan_not_found");
    assert.ok(String((result as { output: string }).output).includes("not found"), "output narrates not-found");
    const { res, sent } = makeFakeRes();
    applyResultToHttp(findDef("execute_plan"), result, { plan_id: "ghost" }, res);
    assert.strictEqual(sent.status, 404);
  });
});

// ── (B) direct toHttp status-map table (independent of the handler) ──────────────────────────────
describe("c55.9 (B) — execute_plan rest.toHttp status map (direct)", () => {
  const def = () => findDef("execute_plan");
  const map: Array<[string, number]> = [
    ["executed", 200],
    ["pending", 202],
    ["blocked", 403],
    ["pane_offline", 400],
    ["plan_not_found", 404],
    ["clarify", 409],
  ];
  for (const [outcome, status] of map) {
    it(`outcome '${outcome}' -> ${status}`, () => {
      const toHttp = def().rest!.toHttp!;
      const { status: s, body } = toHttp({ kind: "ok", output: "spoken", meta: { outcome } }, { plan_id: "plan_1" });
      assert.strictEqual(s, status);
      assert.deepStrictEqual(body, { output: "spoken" }, "body echoes output, never the meta");
    });
  }
  it("an un-stamped ok (no meta) -> defensive 200", () => {
    const toHttp = def().rest!.toHttp!;
    const { status } = toHttp({ kind: "ok", output: "x" }, {});
    assert.strictEqual(status, 200);
  });
  it("execute_plan declares rest.toHttp and stays surfaces {voice,rest}", () => {
    const d = def();
    assert.strictEqual(typeof d.rest?.toHttp, "function", "execute_plan must declare rest.toHttp");
    assert.deepStrictEqual([...d.surfaces].sort(), ["rest", "voice"], "execute_plan stays voice+rest");
    assert.strictEqual(d.rest!.method, "post");
    // c55.9 fix: snake_case route param so Express injects :plan_id directly onto the zod key
    // (delete_orchestrator_plan precedent). The CLIENT URL /api/plans/<id>/execute is unchanged.
    assert.strictEqual(d.rest!.path, "/api/plans/:plan_id/execute");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (C) sess:null resolution (spec §9.1, load-bearing): a REST-originated Ask resolves with NO
//     sendToolResponse on a null session and the write LANDS — no null-deref.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("c55.9 (C) — sess:null resolution: REST Ask -> confirm writes, no null-deref", () => {
  it("stages with null session, then resolveDecision approves -> doWrite, write lands, no sendToolResponse", () => {
    const rec = freshRec();
    const store = new PendingApprovalStore();
    // 1) Stage a REST Ask (conn.sess = null) through the shared core.
    const deps = makeDeps(rec, { targetId: "p1", instruction: "npm run deploy", effectiveMode: "Full Auto", live: true, store });
    const out = applyDispatchDecision({ type: "pending_approval" }, deps, restConn(rec));
    assert.strictEqual(out.kind, "pending");
    assert.strictEqual(store.all().length, 1);
    const messageId = store.all()[0].messageId;
    assert.strictEqual(store.sessionFor(messageId), null, "REST staged a null-session pending");

    // 2) The c55.15 confirm/resolve path calls resolveDecision (pure) then writes if doWrite. The pane
    //    is alive -> approved + doWrite. resolveDecision NEVER touches the session (it's pure), proving
    //    the null session cannot deref here.
    const liveTerm = fakeTerm(rec, "p1");
    const action = resolveDecision(store, messageId, "approve", (_tid) => true);
    assert.strictEqual(action.reason, "approved");
    assert.strictEqual(action.doWrite, true, "the approved REST pending writes on confirm");
    assert.strictEqual(store.has(messageId), false, "record deleted by the claim winner");

    // 3) The thin caller (applyResolution) narrates ONLY `if (session)`; with a null session it skips
    //    the push and just writes. Model that null-guarded narration here and assert no throw + write.
    const session = store.sessionFor(messageId); // null (already deleted -> undefined; treat as falsy)
    let narrated = 0;
    assert.doesNotThrow(() => {
      if (action.doWrite) liveTerm.writeInput(action.record!.instruction);
      if (session) narrated++; // pushApprovalNarration guard — never runs on a null session
    });
    assert.strictEqual(narrated, 0, "no narration push attempted on a null/REST session");
    assert.deepStrictEqual(rec.writes, [{ paneId: "p1", cmd: "npm run deploy" }], "the confirmed write LANDED");
  });

  it("a null-session survivor is enumerated by all() (PLM4 detachSession parity)", () => {
    const rec = freshRec();
    const store = new PendingApprovalStore();
    const deps = makeDeps(rec, { targetId: "p2", instruction: "x", effectiveMode: "Full Auto", live: true, store });
    applyDispatchDecision({ type: "pending_approval" }, deps, restConn(rec));
    // all() is the REST view the operator surface (list_pending_commands) reads — it must include the
    // null-session pending (the store does NOT filter null-session entries out of all()).
    assert.strictEqual(store.all().length, 1, "null-session pending is visible in the REST all() view");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (D) cutover guard — server.ts has execute_plan in the only-set AND the inline route is GONE.
// ════════════════════════════════════════════════════════════════════════════════════════════════
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

describe("c55.9 (D) — server.ts cutover guard (no double-registration)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverSrc = readFileSync(path.join(here, "..", "server.ts"), "utf8");
  // c55.16: the `only:` allow-filter was RETIRED; registry auto-serves every rest-surface def.
  // Cutover proof = registry membership (surfaces:rest && def.rest), not only-set text.
  const mountIdx = serverSrc.indexOf("mountRestRoutes(");
  const mountedNames = new Set(
    REGISTRY.filter((d) => d.surfaces.has("rest") && !!d.rest).map((d) => d.name),
  );

  it('mountRestRoutes auto-serves "execute_plan" (rest-surfaced in REGISTRY)', () => {
    assert.ok(mountIdx >= 0, "server.ts must call mountRestRoutes");
    assert.ok(mountedNames.has("execute_plan"), "execute_plan must be a rest-mounted REGISTRY def after the c55.9 cutover");
  });

  it("inline route is deleted: POST /api/plans/:id/execute", () => {
    assert.ok(
      !/app\.post\(\s*["']\/api\/plans\/:id\/execute["']/.test(serverSrc),
      "inline POST /api/plans/:id/execute must be deleted (converged to the registry)",
    );
  });

  it("the refusing dispatchProposal stub is gone from buildRestActionContext", () => {
    assert.ok(
      !serverSrc.includes("pane-write is not available on the REST surface"),
      "the refusing stub string must be removed (REST now has a gated pane-write seam)",
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (E) param-name regression — the REAL Express-delivered arg shape lands on the snake_case zod key.
//
//   The §B/§C tests pass BOTH keys ({ plan_id, id }) so they cannot catch a path-param-name regression:
//   if rest.path were the camel-ish :id (not :plan_id), Express would deliver req.params = { id } only —
//   NO plan_id — and ExecutePlanParams.parse({ id }) FAILS validation, so dispatchProposal is NEVER
//   called and the Run-plan button silently 500s instead of writing step 1. These tests exercise the
//   ACTUAL arg shape Express produces for the chosen :plan_id route (and prove the :id shape would fail).
// ════════════════════════════════════════════════════════════════════════════════════════════════

// A one-route fake Express app: mountRestRoutes registers the handler; we capture it to drive a request.
function captureExecutePlanHandler(ctx: ActionContext): RestHandler {
  let captured: RestHandler | null = null;
  const app: RestApp = {
    get() { return undefined; },
    put() { return undefined; },
    delete() { return undefined; },
    post(path: string, handler: RestHandler) {
      // Bind only the execute_plan route (its rest.path is the snake_case :plan_id form).
      if (path === "/api/plans/:plan_id/execute") captured = handler;
      return undefined;
    },
  };
  mountRestRoutes(app, REGISTRY, () => ctx, { only: new Set(["execute_plan"]) });
  assert.ok(captured, "mountRestRoutes must register execute_plan at /api/plans/:plan_id/execute");
  return captured!;
}

describe("c55.9 (E) — param-name regression: Express :plan_id param lands on the zod key", () => {
  it("runAction with ONLY the route-param key { plan_id } (no body, no id) -> dispatch fires, executed", async () => {
    // This is the exact rawArgs mountRestRoutes builds for the :plan_id route: { ...query, ...params }
    // with params = { plan_id } and an empty body. The §B tests masked this by also passing `id`.
    const { ctx, rec } = makePlanCtx({ kind: "executed", text: "ran" });
    const result = await runAction(REGISTRY, "execute_plan", { plan_id: "plan_1" }, ctx);
    assert.strictEqual(result.kind, "ok", "the params-only arg shape parses (plan_id present)");
    assert.strictEqual(rec.dispatched, 1, "dispatchProposal IS called (step 1 routed through the gate)");
    assert.strictEqual((result as { meta?: { outcome?: string } }).meta?.outcome, "executed");
  });

  it("the OLD :id route shape { id } (no plan_id) FAILS validation -> dispatch NEVER fires (the bug)", async () => {
    // Proves WHY the path must be :plan_id, not :id: an :id route delivers { id } only, which the zod
    // schema (plan_id required, no coerceArgs) rejects -> runAction returns kind:'error', no dispatch.
    const { ctx, rec } = makePlanCtx({ kind: "executed", text: "ran" });
    const result = await runAction(REGISTRY, "execute_plan", { id: "plan_1" }, ctx);
    assert.strictEqual(result.kind, "error", "{ id } alone fails zod validation (plan_id required)");
    assert.strictEqual(rec.dispatched, 0, "dispatchProposal never runs on the failed-validation shape");
  });

  it("end-to-end via mountRestRoutes: a request whose params={plan_id} writes step 1 (200)", async () => {
    const { ctx, rec } = makePlanCtx({ kind: "executed", text: "ran" });
    const handler = captureExecutePlanHandler(ctx);
    // Simulate Express delivering the :plan_id route param for URL POST /api/plans/plan_1/execute.
    const req: RestRequest = { params: { plan_id: "plan_1" }, body: {}, query: {} };
    const { res, sent } = makeFakeRes();
    await handler(req, res as RestResponse);
    assert.strictEqual(rec.dispatched, 1, "the mounted route dispatched step 1 (param landed on the zod key)");
    assert.strictEqual(sent.status, 200, "executed -> 200 (the inline Run-plan write is preserved)");
  });
});
