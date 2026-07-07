// f09.2 — timed autonomy windows. The FIRST feature that LOOSENS the safety matrix at runtime, so
// the tests are adversarial about the safety invariants: a window loosens Ask→Auto ONLY, never an
// explicit Off, never a STOP-ALL freeze, is inert the instant its clock passes (no sweep required),
// and NEVER survives a server restart (revoked at boot). Mirrors the createGating harness of
// tests/test_gating_sweep_guard.ts and the JanusStore(":memory:") harness of tests/test_store_projection.ts.

import { describe, it } from "node:test";
import assert from "node:assert";
import { createGating, type GatingDeps } from "../src/gating";
import { applyAutonomyWindow } from "../src/pendingApprovals";
import {
  AutonomyWindowStore,
  clampAutonomyMinutes,
  deserializeAutonomyWindows,
  sanitizeAutonomyCapabilities,
  DEFAULT_AUTONOMY_CAPABILITIES,
  AUTONOMY_WINDOWS_KV,
  AUTONOMY_WARN_LEAD_MS,
  DEFAULT_AUTONOMY_MINUTES,
} from "../src/gating/autonomyWindows";
import { grantAutonomyWindow as grantDef, endAutonomyWindow as endDef } from "../src/actions/defs/locks";
import { JanusStore } from "../src/store/sqliteStore";
import type { CapabilityGate, CapabilityGateMap } from "../src/types";

// ── harness ────────────────────────────────────────────────────────────────────────────────────
interface Harness {
  gating: ReturnType<typeof createGating>;
  broadcasts: any[];
  narrations: string[];
  store: JanusStore | null;
  deps: GatingDeps;
}

function makeHarness(opts: {
  store?: JanusStore | null;
  gates?: CapabilityGateMap;
  frozen?: boolean;
  activePaneId?: string | null;
  liveSession?: any;
  narrate?: (session: any, text: string) => boolean | void;
} = {}): Harness {
  const broadcasts: any[] = [];
  const narrations: string[] = [];
  const manager: any = {
    globalPermissionsMode: "Inherit",
    terminals: {},
    settings: { advanced: { capabilityGates: opts.gates ?? {} } },
    ledger: {
      activeProjectId: "default_project",
      getActiveProject: () => undefined,
      plans: [],
      watchRules: [],
      save: () => {},
    },
  };
  const coreState: any = {
    activeFrontendWs: null,
    activeLiveSession: opts.liveSession ?? null,
    clients: new Set(),
    activePaneId: opts.activePaneId ?? null,
    frozen: !!opts.frozen,
    lastStopAllFailed: [],
    setFrozen: (v: boolean) => { coreState.frozen = v; },
  };
  const deps: GatingDeps = {
    manager,
    store: opts.store ?? null,
    broadcast: (m: any) => broadcasts.push(m),
    broadcastLedgerUpdate: () => {},
    broadcastDraft: () => {},
    coreState,
    announcementBus: { enqueue: () => true, stop: () => {} } as any,
    pushApprovalNarration: opts.narrate ?? ((_s, t) => { narrations.push(t); return true; }),
    sanitizeSettingsForClient: (s: any) => s,
    addCommand: () => {},
  };
  return { gating: createGating(deps), broadcasts, narrations, store: opts.store ?? null, deps };
}

// ── 1. PURE resolution table ─────────────────────────────────────────────────────────────────────
describe("f09.2 pure — applyAutonomyWindow overlay", () => {
  it("loosens Ask→Auto only when the window is live", () => {
    assert.strictEqual(applyAutonomyWindow("Ask", true), "Auto");
    assert.strictEqual(applyAutonomyWindow("Ask", false), "Ask");
  });
  it("NEVER loosens an explicit Off (the veto), live or not", () => {
    assert.strictEqual(applyAutonomyWindow("Off", true), "Off");
    assert.strictEqual(applyAutonomyWindow("Off", false), "Off");
  });
  it("never tightens Auto", () => {
    assert.strictEqual(applyAutonomyWindow("Auto", true), "Auto");
    assert.strictEqual(applyAutonomyWindow("Auto", false), "Auto");
  });
});

describe("f09.2 pure — clampAutonomyMinutes", () => {
  it("clamps 0 and negatives UP to 1", () => {
    assert.strictEqual(clampAutonomyMinutes(0), 1);
    assert.strictEqual(clampAutonomyMinutes(-5), 1);
  });
  it("clamps over-cap DOWN to 120", () => {
    assert.strictEqual(clampAutonomyMinutes(9999), 120);
  });
  it("defaults a missing/NaN duration to the default", () => {
    assert.strictEqual(clampAutonomyMinutes(undefined), DEFAULT_AUTONOMY_MINUTES);
    assert.strictEqual(clampAutonomyMinutes(Number.NaN), DEFAULT_AUTONOMY_MINUTES);
  });
  it("passes an in-range value through (floored)", () => {
    assert.strictEqual(clampAutonomyMinutes(20), 20);
    assert.strictEqual(clampAutonomyMinutes(45.9), 45);
  });
});

// ── BLOCKER (Wave-7): a window can never cover META / DESTRUCTIVE capabilities ────────────────────
// A granted window that covered set_capability_gate would resolve that meta gate to Auto, so every
// subsequent voice grant_autonomy_window would return disposition 'run' and apply SILENTLY — perpetual
// self-renewal + arbitrary widening. The productive-only allowlist closes that at the choke point.
describe("f09.2 blocker — window capability allowlist (no meta/destructive escalation)", () => {
  it("sanitizeAutonomyCapabilities keeps productive writes and DROPS meta/destructive", () => {
    assert.deepStrictEqual(
      sanitizeAutonomyCapabilities(["set_capability_gate", "delete_pane", "write_to_pane"]),
      ["write_to_pane"], "meta + destructive stripped, productive write kept");
  });
  it("an all-ineligible request falls back to the default productive set (never nothing, never meta)", () => {
    assert.deepStrictEqual(
      sanitizeAutonomyCapabilities(["set_capability_gate", "execute_plan"]).sort(),
      [...DEFAULT_AUTONOMY_CAPABILITIES].sort());
  });
  it("an omitted request defaults to the productive writes", () => {
    assert.deepStrictEqual(sanitizeAutonomyCapabilities(undefined).sort(), [...DEFAULT_AUTONOMY_CAPABILITIES].sort());
    assert.deepStrictEqual(sanitizeAutonomyCapabilities([]).sort(), [...DEFAULT_AUTONOMY_CAPABILITIES].sort());
  });
  it("gating.grantAutonomyWindow will NOT loosen set_capability_gate/delete_pane even when asked", () => {
    const h = makeHarness({ gates: { set_capability_gate: "Ask", delete_pane: "Ask", write_to_pane: "Ask" } });
    // The escalation attempt: request a window covering the meta + a destructive capability.
    h.gating.grantAutonomyWindow("p1", 120, ["set_capability_gate", "delete_pane", "write_to_pane"] as any);
    // The meta gate the self-renewal depended on stays Ask — a subsequent grant would DEFER, not run silently.
    assert.strictEqual(h.gating.effectiveCapabilityGateFor("p1", "set_capability_gate"), "Ask",
      "a window can never flip the control surface to Auto");
    assert.strictEqual(h.gating.effectiveCapabilityGateFor("p1", "delete_pane"), "Ask",
      "a window can never flip a destructive capability to Auto");
    // Only the productive write was loosened.
    assert.strictEqual(h.gating.effectiveCapabilityGateFor("p1", "write_to_pane"), "Auto");
  });
});

describe("f09.2 pure — AutonomyWindowStore lazy liveness", () => {
  it("isCapabilityLive is true only before expiry AND only for covered capabilities", () => {
    const s = new AutonomyWindowStore();
    const T0 = 1_000_000;
    s.grant("p1", ["write_to_pane"], T0, 60_000); // expires at T0+60_000
    assert.strictEqual(s.isCapabilityLive("p1", "write_to_pane", T0 + 1), true);
    assert.strictEqual(s.isCapabilityLive("p1", "deliver_handoff", T0 + 1), false, "capability not in window");
    assert.strictEqual(s.isCapabilityLive("p1", "write_to_pane", T0 + 60_000), false, "expired at exactly expires_at");
    assert.strictEqual(s.isCapabilityLive("p2", "write_to_pane", T0 + 1), false, "different pane");
  });
});

// ── 2. GATING integration: the safety invariants at the choke-point ───────────────────────────────
describe("f09.2 gating — effectiveCapabilityGateFor overlay", () => {
  it("a LIVE window loosens Ask→Auto for its capability", () => {
    const h = makeHarness({ gates: { write_to_pane: "Ask" } });
    h.gating.autonomyWindows.grant("p1", ["write_to_pane"], Date.now(), 60_000);
    assert.strictEqual(h.gating.effectiveCapabilityGateFor("p1", "write_to_pane"), "Auto");
  });
  it("an explicit Off is NEVER loosened by a window", () => {
    const h = makeHarness({ gates: { write_to_pane: "Off" } });
    h.gating.autonomyWindows.grant("p1", ["write_to_pane"], Date.now(), 60_000);
    assert.strictEqual(h.gating.effectiveCapabilityGateFor("p1", "write_to_pane"), "Off");
  });
  it("a STOP-ALL freeze wins over a live window (frozen short-circuit is applied LAST)", () => {
    const h = makeHarness({ gates: { write_to_pane: "Ask" }, frozen: true });
    h.gating.autonomyWindows.grant("p1", ["write_to_pane"], Date.now(), 60_000);
    assert.strictEqual(h.gating.effectiveCapabilityGateFor("p1", "write_to_pane"), "Off");
  });
  it("an EXPIRED-BY-CLOCK window is inert immediately in resolution — no sweep run", () => {
    const h = makeHarness({ gates: { write_to_pane: "Ask" } });
    // expires_at deliberately in the past relative to Date.now(): granted 100s ago for 1s.
    h.gating.autonomyWindows.grant("p1", ["write_to_pane"], Date.now() - 100_000, 1_000);
    assert.strictEqual(h.gating.effectiveCapabilityGateFor("p1", "write_to_pane"), "Ask",
      "a dead sweep timer must not keep a pane hot — resolution lazily re-checks expiry");
  });
  it("a non-windowed capability is unaffected by a window on other capabilities", () => {
    const h = makeHarness({ gates: { write_to_pane: "Ask", create_pane: "Ask" } });
    h.gating.autonomyWindows.grant("p1", ["write_to_pane"], Date.now(), 60_000);
    assert.strictEqual(h.gating.effectiveCapabilityGateFor("p1", "create_pane"), "Ask");
  });
});

describe("f09.2 gating — posturePayloadForPane carries autonomy_until", () => {
  it("carries autonomy_until only while a window is live", () => {
    const h = makeHarness({ gates: { write_to_pane: "Ask" } });
    (h.deps.manager as any).terminals = { p1: {} };
    const w = h.gating.autonomyWindows.grant("p1", ["write_to_pane"], Date.now(), 60_000);
    const payload = h.gating.posturePayloadForPane("p1") as any;
    assert.strictEqual(payload.autonomy_until, w.expires_at);
  });
  it("omits autonomy_until when no window is live", () => {
    const h = makeHarness({ gates: { write_to_pane: "Ask" } });
    (h.deps.manager as any).terminals = { p1: {} };
    const payload = h.gating.posturePayloadForPane("p1") as any;
    assert.strictEqual(payload.autonomy_until, undefined);
  });
});

// ── 3. GRANT / END mutators: persist + audit + broadcast ──────────────────────────────────────────
describe("f09.2 gating — grant/end mutators (persist + audit + broadcast)", () => {
  it("grant persists to settings_kv, writes an audit row, and broadcasts terminals_updated", () => {
    const store = new JanusStore(":memory:"); store.init();
    const h = makeHarness({ store });
    const w = h.gating.grantAutonomyWindow("p1", 20);
    assert.ok(w && w.pane_id === "p1");
    const kv = deserializeAutonomyWindows(store.getKV(AUTONOMY_WINDOWS_KV));
    assert.strictEqual(kv.length, 1, "window persisted to settings_kv");
    const audits = store.getEvents({ type: "permission_changed" })
      .filter((e) => (e.payload as any)?.action === "autonomy_window_granted");
    assert.strictEqual(audits.length, 1, "one granted audit row");
    assert.ok(h.broadcasts.some((b) => b.type === "terminals_updated"), "chip repaint broadcast");
  });
  it("end removes the window immediately (tighten), persists, audits, broadcasts", () => {
    const store = new JanusStore(":memory:"); store.init();
    const h = makeHarness({ store });
    h.gating.grantAutonomyWindow("p1", 20);
    const removed = h.gating.endAutonomyWindow("p1");
    assert.ok(removed, "returns the removed window");
    assert.strictEqual(h.gating.autonomyWindows.liveWindowFor("p1", Date.now()), null, "no live window remains");
    assert.strictEqual(deserializeAutonomyWindows(store.getKV(AUTONOMY_WINDOWS_KV)).length, 0, "kv cleared");
    const audits = store.getEvents({ type: "permission_changed" })
      .filter((e) => (e.payload as any)?.action === "autonomy_window_ended");
    assert.strictEqual(audits.length, 1, "one ended audit row");
  });
  it("end on a pane with no window returns null and no-ops", () => {
    const store = new JanusStore(":memory:"); store.init();
    const h = makeHarness({ store });
    assert.strictEqual(h.gating.endAutonomyWindow("nope"), null);
  });
});

// ── 4. SWEEP leg: warn once, then expire (remove + persist + audit + broadcast) ────────────────────
describe("f09.2 sweep — last-call warning + auto-expiry", () => {
  const T0 = 1_700_000_000_000;
  const DUR = 20 * 60_000;

  it("stamps warned_at exactly once via the narration seam at T-minus ~2 min", () => {
    const session = { sendClientContent: () => {} };
    const h = makeHarness({ liveSession: session });
    h.gating.autonomyWindows.grant("p1", ["write_to_pane"], T0, DUR); // expires T0+DUR
    const warnAt = T0 + DUR - AUTONOMY_WARN_LEAD_MS + 1;
    h.gating.sweepExpiredApprovals(warnAt);
    const w1 = h.gating.autonomyWindows.all()[0];
    assert.strictEqual(w1.warned_at, warnAt, "warned_at stamped at the narration tick");
    assert.strictEqual(h.narrations.length, 1, "exactly one spoken warning");
    // A second in-zone tick must NOT re-warn.
    h.gating.sweepExpiredApprovals(warnAt + 30_000);
    assert.strictEqual(h.narrations.length, 1, "warning fires exactly once");
  });

  it("expiry removes the window, persists the removal, audits, and broadcasts", () => {
    const store = new JanusStore(":memory:"); store.init();
    const session = { sendClientContent: () => {} };
    const h = makeHarness({ store, liveSession: session });
    h.gating.autonomyWindows.grant("p1", ["write_to_pane"], T0, DUR);
    // Persist the seeded window so we can prove the sweep CLEARS it from settings_kv.
    store.setKV(AUTONOMY_WINDOWS_KV, h.gating.autonomyWindows.serialize());
    h.gating.sweepExpiredApprovals(T0 + DUR + 1);
    assert.strictEqual(h.gating.autonomyWindows.all().length, 0, "window removed");
    assert.strictEqual(deserializeAutonomyWindows(store.getKV(AUTONOMY_WINDOWS_KV)).length, 0, "removal persisted");
    const audits = store.getEvents({ type: "permission_changed" })
      .filter((e) => (e.payload as any)?.action === "autonomy_window_expired");
    assert.strictEqual(audits.length, 1, "one expiry audit row");
    assert.ok(h.broadcasts.some((b) => b.type === "terminals_updated"), "chip repaint broadcast");
  });

  it("a throwing window sweep is non-fatal (never escapes the tick)", () => {
    const h = makeHarness();
    (h.gating.autonomyWindows as any).all = () => { throw new Error("boom"); };
    assert.doesNotThrow(() => h.gating.sweepExpiredApprovals(T0), "the window sweep leg is non-fatal");
  });
});

// ── 5. BOOT revoke: no window survives a restart into live resolution ──────────────────────────────
describe("f09.2 boot — ALL persisted windows are revoked at boot (fail-closed)", () => {
  it("a future-dated persisted window is revoked: zero live windows + audit rows + kv cleared", () => {
    const store = new JanusStore(":memory:"); store.init();
    // Seed settings_kv with a window whose expires_at is comfortably in the future.
    const future = Date.now() + 60 * 60_000;
    store.setKV(AUTONOMY_WINDOWS_KV, JSON.stringify([
      { id: "aw_seed_0", pane_id: "p1", capabilities: ["write_to_pane"], granted_at: Date.now(), expires_at: future },
    ]));
    // Construct gating — the boot revoke runs inside createGating.
    const h = makeHarness({ store, gates: { write_to_pane: "Ask" } });
    // (a) zero LIVE windows — the seeded window never rehydrated as live.
    assert.strictEqual(h.gating.autonomyWindows.all().length, 0, "no window rehydrated as live");
    assert.strictEqual(h.gating.effectiveCapabilityGateFor("p1", "write_to_pane"), "Ask",
      "a restart-persisted window must NOT keep the pane hot");
    // (b) one revoke audit row per revoked window.
    const revoked = store.getEvents({ type: "permission_changed" })
      .filter((e) => (e.payload as any)?.action === "autonomy_window_revoked_boot");
    assert.strictEqual(revoked.length, 1, "one boot-revoke audit row");
    // (c) settings_kv cleared.
    assert.strictEqual(deserializeAutonomyWindows(store.getKV(AUTONOMY_WINDOWS_KV)).length, 0, "kv cleared at boot");
  });
});

// ── 6. VOICE contract: grant DEFERS (loosen), end APPLIES immediately (tighten) ────────────────────
describe("f09.2 action defs — identity", () => {
  // Also satisfies the action test-presence guard (tests/test_action_test_presence.ts) by referencing
  // both action NAMES as literals here.
  it("grant_autonomy_window / end_autonomy_window ride the set_capability_gate lock row, voice+rest", () => {
    assert.strictEqual(grantDef.name, "grant_autonomy_window");
    assert.strictEqual(endDef.name, "end_autonomy_window");
    assert.strictEqual(grantDef.capability, "set_capability_gate");
    assert.strictEqual(endDef.capability, "set_capability_gate");
    assert.ok(grantDef.surfaces.has("voice") && grantDef.surfaces.has("rest"));
    assert.ok(endDef.surfaces.has("voice") && endDef.surfaces.has("rest"));
  });
});

describe("f09.2 voice contract — grant defers, end applies immediately", () => {
  function fakeCtx(disposition: "run" | "deferred" | "forbidden") {
    const calls = { granted: [] as any[], ended: [] as any[], deferParams: null as any };
    const ctx: any = {
      gateOrDefer: (_cap: CapabilityGate, _pane: string | null, summary: string, run: () => string, params?: any) => {
        calls.deferParams = params;
        if (disposition === "run") return { disposition: "run" };
        if (disposition === "forbidden") return { disposition: "forbidden" };
        return { disposition: "deferred", actionId: "act_1", summary };
      },
      grantAutonomyWindow: (pane: string, mins: number, caps?: any) => {
        calls.granted.push({ pane, mins, caps });
        return { id: "w", pane_id: pane, capabilities: caps ?? ["write_to_pane"], granted_at: 0, expires_at: mins * 60_000 };
      },
      endAutonomyWindow: (pane: string) => {
        calls.ended.push(pane);
        return { id: "w", pane_id: pane, capabilities: ["write_to_pane"], granted_at: 0, expires_at: 1 };
      },
    };
    return { ctx, calls };
  }

  it("grant DEFERS through the Ask path — it does NOT apply the window silently", () => {
    const { ctx, calls } = fakeCtx("deferred");
    const r = grantDef.handler({ pane_id: "p1", minutes: 20 } as any, ctx) as any;
    assert.strictEqual(calls.granted.length, 0, "no window opened while awaiting confirm");
    assert.match(r.output, /confirm/i, "the operator is told it needs confirmation");
  });

  it("grant on Auto applies the window (run disposition)", () => {
    const { ctx, calls } = fakeCtx("run");
    grantDef.handler({ pane_id: "p1", minutes: 20 } as any, ctx);
    assert.strictEqual(calls.granted.length, 1, "the window opened");
  });

  it("grant on the REST surface applies immediately (deliberate UI loosen) WITHOUT gateOrDefer", () => {
    const { ctx, calls } = fakeCtx("deferred"); // gateOrDefer would defer — but REST must skip it
    ctx.surface = "rest";
    grantDef.handler({ pane_id: "p1", minutes: 20 } as any, ctx);
    assert.strictEqual(calls.granted.length, 1, "the window opened immediately on REST");
    assert.strictEqual(calls.deferParams, null, "REST never routes through gateOrDefer");
  });

  it("grant DISCLOSES the duration AND the sanitized capabilities in the deferral summary (never conceals scope)", () => {
    const { ctx } = fakeCtx("deferred");
    const r = grantDef.handler(
      { pane_id: "p1", minutes: 20, capabilities: ["set_capability_gate", "write_to_pane"] } as any, ctx) as any;
    assert.match(r.output, /20-minute/, "duration disclosed in the confirm summary");
    assert.match(r.output, /write_to_pane/, "the granted capability disclosed");
    assert.doesNotMatch(r.output, /set_capability_gate/, "the meta capability was filtered out, not disclosed as granted");
  });

  it("grant forwards ONLY the sanitized (productive) capabilities to the window mutator", () => {
    const { ctx, calls } = fakeCtx("run");
    grantDef.handler(
      { pane_id: "p1", minutes: 20, capabilities: ["set_capability_gate", "delete_pane", "write_to_pane"] } as any, ctx);
    assert.deepStrictEqual(calls.granted[0].caps, ["write_to_pane"], "meta/destructive stripped before the window opens");
  });

  it("grant clamps an over-cap duration server-side (120 min)", () => {
    const { ctx, calls } = fakeCtx("run");
    grantDef.handler({ pane_id: "p1", minutes: 9999 } as any, ctx);
    assert.strictEqual(calls.granted[0].mins, 120, "duration clamped to the hard cap");
  });

  it("end APPLIES immediately (tighten) — no gateOrDefer, window removed now", () => {
    const { ctx, calls } = fakeCtx("deferred"); // disposition irrelevant: end must not consult it
    const r = endDef.handler({ pane_id: "p1" } as any, ctx) as any;
    assert.strictEqual(calls.ended.length, 1, "the window was ended immediately");
    assert.strictEqual(calls.deferParams, null, "end never routes through gateOrDefer");
    assert.match(r.output, /ended/i);
  });
});
