// tests/test_session_pool.ts — z5c design (spec 2026-07-07-z5c-session-pool-design.md), Slice 2/3.
//
// SessionPool is the pure DECISION layer for the per-project session pool: entry state machine
// (D2), switching-flow decisions (D4), per-project resumption-handle KV persistence + legacy
// migration (D5), hot-slot config (D7), and the pool.plan client integration with the D6
// fail-closed floor. No live Gemini socket, no daemon process — a hand-built KV double and a
// stubbed PythonPolicyClient are enough to exercise every edge.
//
// Runner: npx tsx --test --test-force-exit tests/test_session_pool.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  SessionPool,
  resolveHotSlotBudget,
  floorPlan,
  DEFAULT_HOT_SLOT_BUDGET,
  MIN_HOT_SLOT_BUDGET,
  MAX_HOT_SLOT_BUDGET,
  type PoolKVSource,
} from "../src/voice/sessionPool";
import { InjectGateRegistry } from "../src/memory/injectGate";
import { ContextVersionRegistry } from "../src/memory/contextVersions";
import {
  LEGACY_RESUME_HANDLE_KV_KEY,
  resumptionHandleKvKeyFor,
  wrapHandleForPersist,
  shouldClearHandleOnClose,
} from "../src/voiceResumption";
import { createPythonPolicyClient, POLICY_OP_TIMEOUT_MS, type PythonPolicyClient, type PoolPlan } from "../src/voice/policyClient";
import type { PythonModuleClient, ModuleResponse } from "../src/memory/pythonClient";
import { WIRE_VERSION } from "../src/memory/types";

function makeKv(): PoolKVSource & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getKV: (k) => map.get(k) ?? null,
    setKV: (k, v) => { map.set(k, v); },
    deleteKV: (k) => { map.delete(k); },
    dump: () => Object.fromEntries(map),
  };
}

function makePool(overrides: Partial<{ store: PoolKVSource | null; now: () => number; hotSlotBudget: number; sessionId: string | null }> = {}) {
  const store = "store" in overrides ? overrides.store! : makeKv();
  return new SessionPool({
    store,
    gates: new InjectGateRegistry(() => 3000),
    contextVersions: new ContextVersionRegistry(null),
    sessionId: overrides.sessionId ?? "vsess-1",
    hotSlotBudget: overrides.hotSlotBudget ?? 1,
    now: overrides.now ?? (() => 1_000_000),
  });
}

describe("resolveHotSlotBudget (D7 config surface)", () => {
  it("defaults to 1 when absent/non-numeric", () => {
    assert.strictEqual(resolveHotSlotBudget(undefined), DEFAULT_HOT_SLOT_BUDGET);
    assert.strictEqual(resolveHotSlotBudget(null), DEFAULT_HOT_SLOT_BUDGET);
    assert.strictEqual(resolveHotSlotBudget("2"), DEFAULT_HOT_SLOT_BUDGET);
    assert.strictEqual(resolveHotSlotBudget(NaN), DEFAULT_HOT_SLOT_BUDGET);
  });
  it("clamps to [0, 3]", () => {
    assert.strictEqual(resolveHotSlotBudget(-5), MIN_HOT_SLOT_BUDGET);
    assert.strictEqual(resolveHotSlotBudget(0), 0);
    assert.strictEqual(resolveHotSlotBudget(3), MAX_HOT_SLOT_BUDGET);
    assert.strictEqual(resolveHotSlotBudget(99), MAX_HOT_SLOT_BUDGET);
  });
  it("truncates a fractional value", () => {
    assert.strictEqual(resolveHotSlotBudget(2.9), 2);
  });
});

describe("SessionPool — entry state machine (D2)", () => {
  it("an unknown project starts cold", () => {
    const pool = makePool();
    assert.strictEqual(pool.stateFor("proj_a"), "cold");
    assert.strictEqual(pool.isForegroundProject("proj_a"), false);
    assert.strictEqual(pool.isLiveDeliverable("proj_a"), false);
  });

  it("noteSwitch promotes the target to hot-foreground and demotes the prior foreground", () => {
    const pool = makePool();
    pool.noteSwitch("proj_a", 1000);
    assert.strictEqual(pool.stateFor("proj_a"), "hot-foreground");
    assert.strictEqual(pool.isForegroundProject("proj_a"), true);
    assert.strictEqual(pool.isLiveDeliverable("proj_a"), true);

    pool.noteSwitch("proj_b", 2000);
    assert.strictEqual(pool.stateFor("proj_b"), "hot-foreground");
    assert.strictEqual(pool.stateFor("proj_a"), "handle", "the prior foreground freezes to handle tier");
    assert.strictEqual(pool.isForegroundProject("proj_a"), false);
    assert.strictEqual(pool.isLiveDeliverable("proj_a"), false);
  });

  it("re-affirming the SAME foreground project is a harmless no-op demotion", () => {
    const pool = makePool();
    pool.noteSwitch("proj_a", 1000);
    pool.noteSwitch("proj_a", 5000); // e.g. session_start/reconnect re-affirming
    assert.strictEqual(pool.stateFor("proj_a"), "hot-foreground");
  });
});

describe("SessionPool — switching flows (D4): A -> B -> A", () => {
  it("A->B->A: A is instant while foreground, resume-or-fresh once backgrounded, and A regains state on return", () => {
    const pool = makePool();

    // A is a brand-new project: no handle yet -> fresh.
    const planA1 = pool.planSwitch("proj_a", 1000);
    assert.strictEqual(planA1.flow, "fresh");
    pool.noteSwitch("proj_a", 1000);

    // While A is foreground, planning a switch back to A itself is instant.
    const planAInstant = pool.planSwitch("proj_a", 1500);
    assert.strictEqual(planAInstant.flow, "instant");

    // Switch to B: B has never been seen either -> fresh.
    const planB1 = pool.planSwitch("proj_b", 2000);
    assert.strictEqual(planB1.flow, "fresh");
    pool.noteSwitch("proj_b", 2000);
    assert.strictEqual(pool.stateFor("proj_a"), "handle", "A backgrounded, no hot-warm slot in today's single socket");

    // A has no persisted handle (this pool never persisted one for it) -> switching back is fresh, not resume.
    const planBackToA = pool.planSwitch("proj_a", 3000);
    assert.strictEqual(planBackToA.flow, "fresh");
    assert.strictEqual(planBackToA.fromState, "handle");
  });

  it("a project with a FRESH persisted handle resumes instead of starting fresh", () => {
    const pool = makePool({ now: () => 1000 });
    pool.persistHandle("proj_a", { newHandle: "h-1" }, 1000);
    // proj_a was never noteSwitch'd hot in THIS pool instance (e.g. a browser refresh mid-project) —
    // its handle survived in durable KV even though the transient entry map starts cold.
    const plan = pool.planSwitch("proj_a", 1500);
    assert.strictEqual(plan.flow, "resume");
    assert.strictEqual(plan.fromState, "cold");
  });

  it("an EXPIRED persisted handle reads as fresh=false -> fresh flow, not resume (fail-closed age guard)", () => {
    const pool = makePool({ now: () => 0 });
    pool.persistHandle("proj_a", { newHandle: "h-old" }, 0);
    const farFuture = 0 + 999_999_999_999; // long past the default 1h TTL
    const plan = pool.planSwitch("proj_a", farFuture);
    assert.strictEqual(plan.flow, "fresh");
  });

  it("planSwitch's sinceContextVersion sources from ContextVersionRegistry (the catch-up anchor)", () => {
    const cv = new ContextVersionRegistry(null);
    const pool = new SessionPool({
      store: makeKv(),
      gates: new InjectGateRegistry(() => 3000),
      contextVersions: cv,
      sessionId: "vsess-1",
      hotSlotBudget: 1,
      now: () => 1000,
    });
    // Nothing acknowledged yet for proj_a/vsess-1.
    assert.strictEqual(pool.planSwitch("proj_a", 1000).sinceContextVersion, null);
    const delivery = cv.recordDelivery({
      projectId: "proj_a", sessionId: "vsess-1", trigger: "project_switch",
      includedSourceIds: [], droppedSourceIds: [], snapshotHash: null, briefHash: null,
    });
    cv.acknowledgeDelivery(delivery.deliveryId);
    assert.strictEqual(pool.planSwitch("proj_a", 2000).sinceContextVersion, delivery.contextVersion);
  });

  it("planSwitch NEVER touches a socket — it is a pure computation with no observable side effect on state()", () => {
    const pool = makePool();
    pool.noteSwitch("proj_a", 1000);
    const before = pool.stateFor("proj_b");
    pool.planSwitch("proj_b", 2000);
    pool.planSwitch("proj_b", 2000);
    assert.strictEqual(pool.stateFor("proj_b"), before, "computing a plan twice must not itself transition state");
  });
});

describe("SessionPool — per-project handle KV persistence + legacy migration (D5)", () => {
  it("persists and reads back a project's own handle, independent of another project's", () => {
    const pool = makePool({ now: () => 1000 });
    pool.persistHandle("proj_a", { newHandle: "h-a" }, 1000);
    pool.persistHandle("proj_b", { newHandle: "h-b" }, 1000);
    assert.deepStrictEqual(pool.readHandle("proj_a", 1500)?.token, { newHandle: "h-a" });
    assert.deepStrictEqual(pool.readHandle("proj_b", 1500)?.token, { newHandle: "h-b" });
  });

  it("readHandle fails closed to null once past the TTL", () => {
    const pool = makePool({ now: () => 0 });
    pool.persistHandle("proj_a", { newHandle: "h-a" }, 0);
    assert.strictEqual(pool.readHandle("proj_a", 999_999_999_999), null);
  });

  it("persistHandle(null) deletes the slot", () => {
    const store = makeKv();
    const pool = makePool({ store });
    pool.persistHandle("proj_a", { newHandle: "h-a" }, 1000);
    assert.ok(store.getKV(resumptionHandleKvKeyFor("proj_a")));
    pool.persistHandle("proj_a", null, 1500);
    assert.strictEqual(store.getKV(resumptionHandleKvKeyFor("proj_a")), null);
  });

  it("readHandle/persistHandle degrade to null/no-op with no store attached (never throw)", () => {
    const pool = makePool({ store: null });
    assert.doesNotThrow(() => pool.persistHandle("proj_a", { newHandle: "h" }, 1000));
    assert.strictEqual(pool.readHandle("proj_a", 1000), null);
  });

  it("migrateLegacyHandle: the ONE-WAY move of the pre-pool single slot into the foreground project's own slot", () => {
    const store = makeKv();
    store.setKV(LEGACY_RESUME_HANDLE_KV_KEY, wrapHandleForPersist({ newHandle: "legacy" }, 1000));
    const pool = makePool({ store, now: () => 1000 });
    pool.migrateLegacyHandle("proj_a");
    assert.strictEqual(store.getKV(LEGACY_RESUME_HANDLE_KV_KEY), null, "legacy slot is deleted");
    assert.deepStrictEqual(pool.readHandle("proj_a", 1500)?.token, { newHandle: "legacy" });
  });

  it("migrateLegacyHandle never clobbers a project that already has its own handle", () => {
    const store = makeKv();
    store.setKV(LEGACY_RESUME_HANDLE_KV_KEY, wrapHandleForPersist({ newHandle: "legacy" }, 1000));
    store.setKV(resumptionHandleKvKeyFor("proj_a"), wrapHandleForPersist({ newHandle: "own" }, 1000));
    const pool = makePool({ store, now: () => 1000 });
    pool.migrateLegacyHandle("proj_a");
    assert.deepStrictEqual(pool.readHandle("proj_a", 1500)?.token, { newHandle: "own" });
  });

  it("migrateLegacyHandle runs at most once per pool instance (idempotent)", () => {
    const store = makeKv();
    store.setKV(LEGACY_RESUME_HANDLE_KV_KEY, wrapHandleForPersist({ newHandle: "legacy" }, 1000));
    const pool = makePool({ store, now: () => 1000 });
    pool.migrateLegacyHandle("proj_a");
    // A second legacy write appears (shouldn't happen in practice, but prove idempotency anyway).
    store.setKV(LEGACY_RESUME_HANDLE_KV_KEY, wrapHandleForPersist({ newHandle: "second" }, 2000));
    pool.migrateLegacyHandle("proj_b");
    assert.strictEqual(pool.readHandle("proj_b", 2500), null, "second call is a no-op — already migrated once");
  });

  it("migrateLegacyHandle is a no-op with nothing to migrate or no target project", () => {
    const pool = makePool();
    assert.doesNotThrow(() => pool.migrateLegacyHandle(null));
    assert.doesNotThrow(() => pool.migrateLegacyHandle("proj_a"));
  });
});

describe("SessionPool — per-project inject gate isolation (D5)", () => {
  it("gateFor(projectId) returns independent gate state per project, not shared across projects", () => {
    const pool = makePool();
    const gateA = pool.gateFor("proj_a");
    const gateB = pool.gateFor("proj_b");
    assert.notStrictEqual(gateA, gateB);
    gateA.noteInjected("H", 1000);
    assert.deepStrictEqual(gateA.evaluate("H", "pane-switch", 1001), { inject: false, skip: "unchanged-brief" });
    assert.deepStrictEqual(gateB.evaluate("H", "pane-switch", 1001), { inject: true, skip: null });
  });

  it("gateFor(null) maps to the same stable default key as today's single-session behavior", () => {
    const pool = makePool();
    assert.strictEqual(pool.gateFor(null), pool.gateFor(null));
  });

  it("the SAME project id always resolves to the SAME gate instance (debounce state actually persists)", () => {
    const pool = makePool();
    assert.strictEqual(pool.gateFor("proj_a"), pool.gateFor("proj_a"));
  });
});

describe("SessionPool — pool.plan integration + D6 fail-closed floor", () => {
  it("floorPlan(): foreground only, no hot-warm slots, no actions", () => {
    assert.deepStrictEqual(floorPlan("proj_a"), { foregroundProjectId: "proj_a", hotSlots: ["proj_a"], actions: [] });
    assert.deepStrictEqual(floorPlan(null), { foregroundProjectId: null, hotSlots: [], actions: [] });
  });

  it("planPool() with no policies client at all falls to the floor", async () => {
    const pool = makePool();
    pool.noteSwitch("proj_a", 1000);
    const plan = await pool.planPool(undefined, ["proj_a"]);
    assert.deepStrictEqual(plan, floorPlan("proj_a"));
  });

  it("planPool() with a client that resolves null (daemon miss) falls to the floor", async () => {
    const pool = makePool();
    pool.noteSwitch("proj_a", 1000);
    const policies: PythonPolicyClient = {
      available: () => true,
      dispose: () => {},
      resolveFocus: async () => null,
      rankSitrep: async () => null,
      planPool: async () => null,
    };
    const plan = await pool.planPool(policies, ["proj_a"]);
    assert.deepStrictEqual(plan, floorPlan("proj_a"));
  });

  it("planPool() with a client that THROWS is not caught here (contract: PythonPolicyClient NEVER rejects) — but a well-behaved client resolving null still floors", async () => {
    const pool = makePool();
    pool.noteSwitch("proj_a", 1000);
    const policies: PythonPolicyClient = {
      available: () => true,
      dispose: () => {},
      resolveFocus: async () => null,
      rankSitrep: async () => null,
      planPool: async () => null, // well-behaved: resolves null instead of throwing, per the facade contract
    };
    const plan = await pool.planPool(policies, ["proj_a"]);
    assert.deepStrictEqual(plan.hotSlots, ["proj_a"]);
  });

  it("planPool() with a real answer passes it through untouched", async () => {
    const pool = makePool();
    pool.noteSwitch("proj_a", 1000);
    const realPlan: PoolPlan = {
      foregroundProjectId: "proj_a",
      hotSlots: ["proj_a", "proj_b"],
      actions: [{ type: "resume", projectId: "proj_b", reason: "fresh handle" }],
    };
    const policies: PythonPolicyClient = {
      available: () => true,
      dispose: () => {},
      resolveFocus: async () => null,
      rankSitrep: async () => null,
      planPool: async (snapshot) => {
        assert.strictEqual(snapshot.foregroundProjectId, "proj_a");
        assert.strictEqual(snapshot.hotSlotBudget, 1);
        assert.ok("proj_a" in snapshot.entries);
        return realPlan;
      },
    };
    const plan = await pool.planPool(policies, ["proj_a", "proj_b"]);
    assert.deepStrictEqual(plan, realPlan);
  });

  it("snapshotFor composes handleAgeMs from the persisted handle and reflects entry state", () => {
    const pool = makePool({ now: () => 5000 });
    pool.noteSwitch("proj_a", 1000);
    pool.persistHandle("proj_b", { newHandle: "h" }, 4000);
    const snap = pool.snapshotFor(["proj_a", "proj_b", "proj_c"], 5000);
    assert.strictEqual(snap.entries.proj_a.state, "hot-foreground");
    assert.strictEqual(snap.entries.proj_b.state, "cold");
    assert.strictEqual(snap.entries.proj_b.handleAgeMs, 1000);
    assert.strictEqual(snap.entries.proj_c.handleAgeMs, null);
    assert.strictEqual(snap.hotSlotBudget, 1);
  });
});

describe("SessionPool — hot/warm/handle transitions from a resolved pool.plan (D2/D3 bounded planning)", () => {
  it("a plan naming a project in hotSlots that this pool has never seen is representable without throwing", async () => {
    const pool = makePool();
    pool.noteSwitch("proj_a", 1000);
    const policies: PythonPolicyClient = {
      available: () => true,
      dispose: () => {},
      resolveFocus: async () => null,
      rankSitrep: async () => null,
      planPool: async () => ({
        foregroundProjectId: "proj_a",
        hotSlots: ["proj_a", "proj_c"],
        actions: [{ type: "resume", projectId: "proj_c", reason: "fresh handle" }],
      }),
    };
    const plan = await pool.planPool(policies, ["proj_a", "proj_c"]);
    assert.deepStrictEqual(plan.hotSlots, ["proj_a", "proj_c"]);
    // The pool's OWN transient state is unaffected by a plan until the caller acts on it — proving
    // planPool (like planSwitch) is a pure read, matching D2's "TS keeps mechanics" seam: this
    // module hands back a plan, it does not mutate itself into hot-warm on the daemon's say-so.
    assert.strictEqual(pool.stateFor("proj_c"), "cold");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Phase 2 Step 2.4 — cross-project journeys 6/7/8/9/11 (docs/superpowers/specs/
// 2026-07-07-z5c-session-pool-design.md). These stay at the SessionPool/policyClient unit seam
// (no full server boot) because the production wiring only calls `planSwitch`/`noteSwitch`/
// `gateFor`/`noteEvent` today — `SessionPool.planPool` itself has NO live call site yet in
// src/voice/index.ts (syncSessionPoolOnTrigger only calls planSwitch+noteSwitch; grep confirms no
// `sessionPool.planPool(` in src/voice/index.ts). That is a documented Slice-3 deferral (the
// module doc: "EXECUTING that decision... is Slice 3 scope"), not a gap introduced by this test
// suite — so "daemon death mid-journey" / "pool.plan timeout" are exercised exactly where the
// feature actually lives (this seam), using the REAL `createPythonPolicyClient` facade (the
// genuine 300ms race + zod validation) rather than a hand-rolled stub, and we additionally prove
// the REST of the pool machinery (planSwitch/noteSwitch/gateFor) is completely unaffected by a
// dead/hung/malformed policies daemon — which is the actual end-to-end guarantee "the voice loop
// continues" reduces to at this slice.
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** A hand-built PythonModuleClient core whose `request` is fully scriptable: hang forever, resolve
 *  a canned response, or resolve null (simulating "daemon absent/unavailable" at the transport
 *  layer) — lets these tests drive `createPythonPolicyClient`'s REAL 300ms race + zod validation
 *  rather than re-implementing the fallback contract by hand. */
function makeFakeCore(opts: { hang?: boolean; respond?: ModuleResponse; available?: boolean }): PythonModuleClient {
  return {
    async request(): Promise<ModuleResponse> {
      if (opts.hang) return new Promise(() => { /* never resolves — exercises the timeout race */ });
      return opts.respond ?? null;
    },
    available: () => opts.available ?? true,
    state: () => "python",
    dispose() { /* no child process to tear down in this fake */ },
  };
}

describe("SessionPool — poisoned handle (1008-close) journey (journey 6)", () => {
  it("a handle poisoned by a real 1008 self-heal is cleared from KV; the next planSwitch yields fresh, never resume; the journey continues without crashing", () => {
    const store = makeKv();
    const pool = makePool({ store, now: () => 1000 });
    pool.persistHandle("proj_a", { newHandle: "h-a" }, 1000);

    // Before poisoning: a fresh persisted handle resumes (D4).
    assert.strictEqual(pool.planSwitch("proj_a", 1500).flow, "resume");

    // The REAL 1008 decision (src/voiceResumption.ts, the production self-heal used by
    // src/voice/index.ts's connect-failure/onclose handlers): a connect attempt that FED this
    // handle closed with Gemini's "session expired" code — the handle is poisoned.
    assert.strictEqual(shouldClearHandleOnClose(1008, /* usedHandle */ true), true, "1008 on an attempt that fed a handle IS the poison signal");
    // The self-heal's own clear step, mirrored here at the per-project KV slot (persistHandle(null)
    // deletes the slot — SessionPool's own documented null-deletes-the-slot contract).
    pool.persistHandle("proj_a", null, 2000);

    const plan = pool.planSwitch("proj_a", 2500);
    assert.strictEqual(plan.flow, "fresh", "a poisoned/cleared handle must NEVER resume");
    assert.strictEqual(plan.fromState, "cold");

    // No crash; the pool keeps functioning for this (and other) projects afterward.
    assert.doesNotThrow(() => pool.noteSwitch("proj_a", 2500));
    assert.strictEqual(pool.stateFor("proj_a"), "hot-foreground");
    assert.doesNotThrow(() => pool.noteSwitch("proj_b", 3000));
    assert.strictEqual(pool.stateFor("proj_a"), "handle", "proj_a demotes normally on the next switch, exactly as an unpoisoned project would");
  });

  it("a NON-1008 close never poisons the handle — a legitimate reconnect can still resume", () => {
    assert.strictEqual(shouldClearHandleOnClose(1006, true), false, "a transient drop must not poison a good handle");
    const pool = makePool({ now: () => 1000 });
    pool.persistHandle("proj_a", { newHandle: "h-a" }, 1000);
    assert.strictEqual(pool.planSwitch("proj_a", 1500).flow, "resume", "handle survives a non-1008 close");
  });
});

describe("SessionPool.planPool via the REAL policy facade — daemon death / hung daemon (journeys 7 & 8)", () => {
  it("no policies client at all (daemon never configured) floors immediately; planSwitch/noteSwitch/gateFor are unaffected (journey 7)", async () => {
    const pool = makePool();
    pool.noteSwitch("proj_a", 1000);
    const plan = await pool.planPool(undefined, ["proj_a"]);
    assert.deepStrictEqual(plan, floorPlan("proj_a"));

    // The REST of the pool machinery — what the live voice loop actually depends on today — keeps
    // working exactly as if nothing happened. This is what "the voice loop continues, briefs still
    // deliver" reduces to at this slice (planPool has no production call site yet — see file header).
    assert.strictEqual(pool.planSwitch("proj_b", 1500).flow, "fresh");
    pool.noteSwitch("proj_b", 1500);
    assert.strictEqual(pool.stateFor("proj_a"), "handle");
    const gate = pool.gateFor("proj_a");
    assert.deepStrictEqual(gate.evaluate("H", "pane-switch", 1600), { inject: true, skip: null });
    gate.noteInjected("H", 1600);
    assert.deepStrictEqual(gate.evaluate("H", "pane-switch", 1601), { inject: false, skip: "unchanged-brief" });
  });

  it("a daemon core that never responds loses the REAL 300ms race -> resolves null -> the pool floors; no unhandled rejection (journey 8)", async () => {
    const core = makeFakeCore({ hang: true });
    const policies = createPythonPolicyClient(core); // uses the production POLICY_OP_TIMEOUT_MS (300ms)
    const pool = makePool();
    pool.noteSwitch("proj_a", 1000);

    // raceRequest's own timeout timer is deliberately UNREF'd (production: a hung daemon must never
    // keep the real server process alive). In this isolated unit test there is nothing else on the
    // event loop, so an unref'd-only timer would never actually fire before the process considers
    // itself idle — keep a trivial REF'd interval alive for the duration of the await so the
    // process has a reason to keep ticking long enough for the real timer to fire, exactly as it
    // would in the live server (which always has other ref'd handles — the HTTP server, sockets).
    const keepAlive = setInterval(() => { /* keep the event loop alive */ }, 25);
    let plan: PoolPlan;
    let elapsed: number;
    try {
      const start = Date.now();
      plan = await pool.planPool(policies, ["proj_a"]);
      elapsed = Date.now() - start;
    } finally {
      clearInterval(keepAlive);
    }

    assert.deepStrictEqual(plan, floorPlan("proj_a"), "the pool falls to the D6 floor on a hung daemon");
    assert.ok(elapsed >= POLICY_OP_TIMEOUT_MS - 50, `expected the ~${POLICY_OP_TIMEOUT_MS}ms race to actually elapse (bounded, not instant), got ${elapsed}ms`);
    assert.ok(elapsed < POLICY_OP_TIMEOUT_MS + 2000, `the race must not hang far past its own timeout, got ${elapsed}ms`);

    // No crash / continues functioning after the timeout resolves.
    assert.doesNotThrow(() => pool.noteSwitch("proj_b", 2000));
    assert.strictEqual(pool.stateFor("proj_b"), "hot-foreground");
  });

  it("a daemon that answers ok:false (malformed/refused) ALSO floors — not just absence/timeout", async () => {
    const core = makeFakeCore({
      respond: { id: "x", v: WIRE_VERSION, ok: false, error: { code: "POOL_FAILED", message: "bad snapshot" } },
    });
    const policies = createPythonPolicyClient(core);
    const pool = makePool();
    pool.noteSwitch("proj_a", 1000);
    const plan = await pool.planPool(policies, ["proj_a"]);
    assert.deepStrictEqual(plan, floorPlan("proj_a"));
  });

  it("a daemon that answers ok:true with an off-schema plan (fails zod validation) ALSO floors, never throws", async () => {
    const core = makeFakeCore({ respond: { id: "x", v: WIRE_VERSION, ok: true, plan: { foregroundProjectId: 42 } } as unknown as ModuleResponse });
    const policies = createPythonPolicyClient(core);
    const pool = makePool();
    pool.noteSwitch("proj_a", 1000);
    await assert.doesNotReject(async () => {
      const plan = await pool.planPool(policies, ["proj_a"]);
      assert.deepStrictEqual(plan, floorPlan("proj_a"));
    });
  });
});

describe("SessionPool — per-project gate debounce isolation under rapid A/B alternation (journey 9)", () => {
  it("each project's gate runs its OWN debounce clock — no cross-project suppression under rapid alternation", () => {
    let now = 1000;
    const debounceMs = () => 3000;
    const pool = new SessionPool({
      store: makeKv(),
      gates: new InjectGateRegistry(debounceMs),
      contextVersions: new ContextVersionRegistry(null),
      sessionId: "vsess-alt",
      hotSlotBudget: 1,
      now: () => now,
    });
    const gateA = pool.gateFor("proj_a");
    const gateB = pool.gateFor("proj_b");

    // A injects at t=1000 (its own gate had never fired — always injects on the first call).
    assert.deepStrictEqual(gateA.evaluate("A-hash-1", "pane-switch", now), { inject: true, skip: null });
    gateA.noteInjected("A-hash-1", now);

    // B injects at t=1010 — a DIFFERENT project's gate, unaffected by A having just fired.
    now = 1010;
    assert.deepStrictEqual(gateB.evaluate("B-hash-1", "pane-switch", now), { inject: true, skip: null }, "B is not suppressed by A's just-fired debounce");
    gateB.noteInjected("B-hash-1", now);

    // Rapid alternation, both still inside their OWN 3000ms floors with genuinely CHANGED hashes:
    // both debounce — on their OWN clocks, not each other's.
    now = 1500;
    assert.deepStrictEqual(gateA.evaluate("A-hash-2", "pane-switch", now), { inject: false, skip: "debounce" });
    assert.deepStrictEqual(gateB.evaluate("B-hash-2", "pane-switch", now), { inject: false, skip: "debounce" });

    // Push past A's OWN floor (1000+3000=4000) but still inside B's (1010+3000=4010) — prove the
    // two clocks clear INDEPENDENTLY, proving no cross-project suppression in either direction.
    now = 4001;
    assert.deepStrictEqual(gateA.evaluate("A-hash-2", "pane-switch", now), { inject: true, skip: null }, "A's debounce cleared on A's own clock");
    assert.deepStrictEqual(gateB.evaluate("B-hash-2", "pane-switch", now), { inject: false, skip: "debounce" }, "B's debounce is still running on B's OWN clock (not yet 4010)");
    gateA.noteInjected("A-hash-2", now);

    now = 4011;
    assert.deepStrictEqual(gateB.evaluate("B-hash-2", "pane-switch", now), { inject: true, skip: null }, "B's debounce clears on ITS own clock, unaffected by A having already fired again");
  });
});

describe("SessionPool — single-session floor regression (journey 11)", () => {
  it("with no durable store and no policies daemon, ONE project's briefs/versions/gate behave exactly as the pre-pool single-session world", async () => {
    const cv = new ContextVersionRegistry(null);
    const pool = new SessionPool({
      store: null,
      gates: new InjectGateRegistry(() => 3000),
      contextVersions: cv,
      sessionId: "vsess-floor",
      hotSlotBudget: 1,
      now: () => 1000,
    });

    pool.noteSwitch("proj_solo", 1000);
    assert.strictEqual(pool.isForegroundProject("proj_solo"), true);
    assert.strictEqual(pool.isLiveDeliverable("proj_solo"), true);

    // context_version registry still mints/acks correctly with no store attached.
    const d1 = cv.recordDelivery({
      projectId: "proj_solo", sessionId: "vsess-floor", trigger: "session_start",
      includedSourceIds: ["project"], droppedSourceIds: [], snapshotHash: null, briefHash: null,
    });
    assert.strictEqual(d1.contextVersion, "1");
    assert.strictEqual(cv.acknowledgeDelivery(d1.deliveryId), true);
    assert.strictEqual(cv.currentAcknowledgedVersion("proj_solo", "vsess-floor"), "1");

    // gate: first inject always fires, an identical repeat skips as unchanged, exactly pre-pool.
    const gate = pool.gateFor("proj_solo");
    assert.deepStrictEqual(gate.evaluate("H1", "pane-switch", 1000), { inject: true, skip: null });
    gate.noteInjected("H1", 1000);
    assert.deepStrictEqual(gate.evaluate("H1", "pane-switch", 1001), { inject: false, skip: "unchanged-brief" });

    // planPool still resolves the D6 floor with no daemon configured — a single-project floor plan
    // is INDISTINGUISHABLE from "the pool doesn't exist" (byte-identical shape).
    const plan = await pool.planPool(undefined, ["proj_solo"]);
    assert.deepStrictEqual(plan, floorPlan("proj_solo"));
  });
});
