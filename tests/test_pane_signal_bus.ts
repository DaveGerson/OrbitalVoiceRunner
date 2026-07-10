import { describe, it } from "node:test";
import assert from "node:assert";
import { PaneSignalBus } from "../src/paneSignalBus";
import { stampDeferred, backgroundProjectForSignal, resolveBriefPane } from "../src/voice/index";
import type { PaneSignal } from "../src/paneSignals";
import { SessionPool } from "../src/voice/sessionPool";
import { InjectGateRegistry } from "../src/memory/injectGate";
import { ContextVersionRegistry } from "../src/memory/contextVersions";

describe("PaneSignalBus", () => {
  it("fans out to every subscriber and respects unsubscribe", () => {
    const bus = new PaneSignalBus(0); // no debounce
    const a: any[] = [];
    const b: any[] = [];
    const off = bus.subscribe((s) => a.push(s));
    bus.subscribe((s) => b.push(s));

    bus.publish({ paneId: "p1", kind: "idle" });
    off();
    bus.publish({ paneId: "p1", kind: "error", detail: "x" });

    assert.strictEqual(a.length, 1, "unsubscribed observer stops receiving");
    assert.strictEqual(b.length, 2);
  });

  it("debounces repeat (pane,kind) within the window but lets other kinds through", () => {
    let now = 1000;
    const bus = new PaneSignalBus(3000, 0, () => now);
    const seen: string[] = [];
    bus.subscribe((s) => seen.push(`${s.paneId}:${s.kind}`));

    assert.strictEqual(bus.publish({ paneId: "p1", kind: "error" }), true);
    assert.strictEqual(bus.publish({ paneId: "p1", kind: "error" }), false, "coalesced");
    assert.strictEqual(bus.publish({ paneId: "p1", kind: "prompt" }), true, "different kind ok");
    now += 3001;
    assert.strictEqual(bus.publish({ paneId: "p1", kind: "error" }), true, "window elapsed");

    assert.deepStrictEqual(seen, ["p1:error", "p1:prompt", "p1:error"]);
  });

  it("an observer that throws does not break the fan-out", () => {
    const bus = new PaneSignalBus(0);
    const seen: string[] = [];
    bus.subscribe(() => { throw new Error("boom"); });
    bus.subscribe((s) => seen.push(s.paneId));
    bus.publish({ paneId: "p9", kind: "idle" });
    assert.deepStrictEqual(seen, ["p9"]);
  });

  // ── CARD 4D.2 (Phase 4 Track D) — debounce defers/passes, never drops real news ──────────────
  // AUDIT FINDINGS: (a) lastPushAt was stamped even when observers.size === 0 — a signal landing
  // just BEFORE the radio connected consumed the window and debounced away the first real signal
  // AFTER connect; (b) a second DIFFERENT error (new detail) within the 3s window was dropped.
  // FIX: stamp only when at least one observer hears the signal; within the window, a same-kind
  // signal with a DIFFERENT detail is genuinely new information and passes through (identical
  // repeats still collapse — the anti-spam intent).
  it("4D.2: a zero-observer publish does NOT consume the (pane,kind) window", () => {
    let now = 1000;
    const bus = new PaneSignalBus(3000, 0, () => now);
    // Nobody is listening yet — the signal is lost on the floor, but must not stamp the window.
    assert.strictEqual(bus.publish({ paneId: "p1", kind: "error", detail: "boom" }), false, "no observers -> not delivered");
    now += 10; // well inside the window
    const seen: string[] = [];
    bus.subscribe((s) => seen.push(`${s.paneId}:${s.kind}`));
    assert.strictEqual(bus.publish({ paneId: "p1", kind: "error", detail: "boom" }), true,
      "the first signal after the radio connects is DELIVERED, not debounced away");
    assert.deepStrictEqual(seen, ["p1:error"]);
  });

  it("4D.2: a same-kind signal with a DIFFERENT detail passes through inside the window", () => {
    let now = 1000;
    const bus = new PaneSignalBus(3000, 0, () => now);
    const seen: string[] = [];
    bus.subscribe((s) => seen.push(`${s.kind}:${s.detail ?? ""}`));

    assert.strictEqual(bus.publish({ paneId: "p1", kind: "error", detail: "TypeError" }), true);
    now += 100;
    assert.strictEqual(bus.publish({ paneId: "p1", kind: "error", detail: "TypeError" }), false, "identical repeat still collapses");
    now += 100;
    assert.strictEqual(bus.publish({ paneId: "p1", kind: "error", detail: "ENOENT" }), true,
      "a DIFFERENT error within the window is genuinely new information");
    now += 100;
    assert.strictEqual(bus.publish({ paneId: "p1", kind: "error", detail: "ENOENT" }), false, "the new detail now collapses its own repeats");

    assert.deepStrictEqual(seen, ["error:TypeError", "error:ENOENT"]);
  });

  it("4D.2: detail-less repeats keep collapsing exactly as before (no regression)", () => {
    let now = 1000;
    const bus = new PaneSignalBus(3000, 0, () => now);
    const seen: string[] = [];
    bus.subscribe((s) => seen.push(s.kind));
    assert.strictEqual(bus.publish({ paneId: "p1", kind: "idle" }), true);
    now += 100;
    assert.strictEqual(bus.publish({ paneId: "p1", kind: "idle" }), false, "undefined detail == undefined detail -> collapse");
    assert.deepStrictEqual(seen, ["idle"]);
  });

  // bead 53q sibling (ykr): publish() hands the SAME PaneSignal object reference to EVERY observer.
  // The voice defer path (voice/index.ts) used to stamp `__deferredAt` directly onto that shared object,
  // mutating the payload that every OTHER observer (and the bus's caller) holds. The fix clones before
  // stamping. This proves the bus fan-out reference IS shared (so the hazard is real) and that the
  // defer-stamp helper does NOT mutate the shared/original signal.
  it("the voice defer-stamp does NOT mutate the shared signal handed to other observers (bead ykr)", () => {
    const bus = new PaneSignalBus(0); // no debounce
    let consumerA: PaneSignal | undefined; // the "voice" consumer that defers + stamps
    let consumerB: PaneSignal | undefined; // an innocent bystander consumer

    bus.subscribe((s) => { consumerA = s; });
    bus.subscribe((s) => { consumerB = s; });

    const original: PaneSignal = { paneId: "p7", kind: "created", detail: "ready" };
    bus.publish(original);

    assert.ok(consumerA && consumerB, "both consumers received the signal");
    // Sanity: the bus fans the SAME reference out — this is exactly why an in-place stamp would leak.
    assert.strictEqual(consumerA, consumerB, "bus fan-out shares one object reference across observers");

    // Drive consumer A through the defer-stamp path (the real voice/index.ts helper).
    const stamped = stampDeferred(consumerA!, 123456);

    // The clone carries the stamp...
    assert.strictEqual((stamped as any).__deferredAt, 123456, "the cloned signal carries __deferredAt");
    assert.notStrictEqual(stamped, consumerA, "stampDeferred returns a NEW object, not the shared one");

    // ...but the OTHER consumer's object and the ORIGINAL are untouched.
    assert.strictEqual(
      "__deferredAt" in (consumerB as any),
      false,
      "the bystander consumer's signal was NOT mutated by the defer stamp",
    );
    assert.strictEqual(
      "__deferredAt" in (original as any),
      false,
      "the original published signal was NOT mutated by the defer stamp",
    );
  });

  // ── L1 fix: cross-kind cooldown prevents status-flap re-announcement loop ──────────────
  it("L1: cross-kind cooldown suppresses low-priority kinds within the window", () => {
    let now = 1000;
    const bus = new PaneSignalBus(3000, 5000, () => now);
    const seen: string[] = [];
    bus.subscribe((s) => seen.push(`${s.paneId}:${s.kind}`));

    assert.strictEqual(bus.publish({ paneId: "p1", kind: "running" }), true, "first signal passes");
    now += 1000; // inside cross-kind cooldown
    assert.strictEqual(bus.publish({ paneId: "p1", kind: "idle" }), false, "idle suppressed by cross-kind cooldown");
    now += 1000;
    assert.strictEqual(bus.publish({ paneId: "p1", kind: "quiescing" }), false, "quiescing suppressed too");

    assert.deepStrictEqual(seen, ["p1:running"]);
  });

  it("L1: error and exited always pass through cross-kind cooldown", () => {
    let now = 1000;
    const bus = new PaneSignalBus(3000, 5000, () => now);
    const seen: string[] = [];
    bus.subscribe((s) => seen.push(`${s.paneId}:${s.kind}`));

    assert.strictEqual(bus.publish({ paneId: "p1", kind: "running" }), true);
    now += 500;
    assert.strictEqual(bus.publish({ paneId: "p1", kind: "error", detail: "boom" }), true, "error passes through cooldown");
    now += 500;
    assert.strictEqual(bus.publish({ paneId: "p1", kind: "exited" }), true, "exited passes through cooldown");

    assert.deepStrictEqual(seen, ["p1:running", "p1:error", "p1:exited"]);
  });

  it("L1: cross-kind cooldown expires and low-priority kinds pass again", () => {
    let now = 1000;
    const bus = new PaneSignalBus(3000, 5000, () => now);
    const seen: string[] = [];
    bus.subscribe((s) => seen.push(`${s.paneId}:${s.kind}`));

    assert.strictEqual(bus.publish({ paneId: "p1", kind: "running" }), true);
    now += 5001; // cross-kind cooldown expired
    assert.strictEqual(bus.publish({ paneId: "p1", kind: "idle" }), true, "idle passes after cooldown expires");

    assert.deepStrictEqual(seen, ["p1:running", "p1:idle"]);
  });

  it("L1: cross-kind cooldown is per-pane (different panes are independent)", () => {
    let now = 1000;
    const bus = new PaneSignalBus(3000, 5000, () => now);
    const seen: string[] = [];
    bus.subscribe((s) => seen.push(`${s.paneId}:${s.kind}`));

    assert.strictEqual(bus.publish({ paneId: "p1", kind: "running" }), true);
    now += 500;
    assert.strictEqual(bus.publish({ paneId: "p2", kind: "idle" }), true, "different pane is independent");
    assert.strictEqual(bus.publish({ paneId: "p1", kind: "idle" }), false, "same pane still in cooldown");

    assert.deepStrictEqual(seen, ["p1:running", "p2:idle"]);
  });
});

// ── z5c slice 1 (spec 2026-07-07 D1, closes bead wsm-e2e-pinned-1d6w) — delivery classes ──────
// The inject leg (command-outcome context injection) must not inherit the SPOKEN-turn L1
// cross-kind cooldown: a fast command completing within 5s of its own "running" edge was never
// injected. Each class runs its OWN debounce window; only `spoken` keeps the cross-kind cooldown.
describe("PaneSignalBus delivery classes (z5c slice 1)", () => {
  it("inject class is NOT suppressed by the cross-kind cooldown; spoken pacing is unchanged", () => {
    let now = 1000;
    const bus = new PaneSignalBus(3000, 5000, () => now);
    const spoken: string[] = [];
    const inject: string[] = [];
    bus.subscribe((s) => spoken.push(s.kind), "spoken");
    bus.subscribe((s) => inject.push(s.kind), "inject");

    assert.strictEqual(bus.publish({ paneId: "p1", kind: "running" }), true);
    now += 2000; // inside the 5s cross-kind window — the fast-command case
    assert.strictEqual(bus.publish({ paneId: "p1", kind: "idle", detail: "done" }), true,
      "delivered to the inject lane even though spoken is cooldown-suppressed");
    assert.deepStrictEqual(spoken, ["running"], "spoken pacing unchanged: idle still suppressed");
    assert.deepStrictEqual(inject, ["running", "idle"], "the outcome edge reaches the inject leg");
  });

  it("inject class still collapses identical repeats (per-lane debounce)", () => {
    let now = 1000;
    const bus = new PaneSignalBus(3000, 5000, () => now);
    const inject: string[] = [];
    bus.subscribe((s) => inject.push(s.kind), "inject");

    assert.strictEqual(bus.publish({ paneId: "p1", kind: "idle", detail: "d" }), true);
    now += 100;
    assert.strictEqual(bus.publish({ paneId: "p1", kind: "idle", detail: "d" }), false,
      "identical repeat inside the window collapses on the inject lane too");
    now += 100;
    assert.strictEqual(bus.publish({ paneId: "p1", kind: "idle", detail: "e" }), true,
      "4D.2 pass-through for a genuinely new detail applies per lane");
    assert.deepStrictEqual(inject, ["idle", "idle"]);
  });

  it("a spoken-only delivery does not consume the inject lane's window (per-lane 4D.2)", () => {
    let now = 1000;
    const bus = new PaneSignalBus(3000, 5000, () => now);
    const spoken: string[] = [];
    bus.subscribe((s) => spoken.push(s.kind), "spoken");
    assert.strictEqual(bus.publish({ paneId: "p1", kind: "idle", detail: "x" }), true);
    now += 10;
    const inject: string[] = [];
    bus.subscribe((s) => inject.push(s.kind), "inject");
    // Identical signal 10ms later: spoken collapses in its OWN window; the inject lane never
    // heard the first one (zero inject observers then), so its window was NOT consumed.
    assert.strictEqual(bus.publish({ paneId: "p1", kind: "idle", detail: "x" }), true);
    assert.deepStrictEqual(spoken, ["idle"]);
    assert.deepStrictEqual(inject, ["idle"]);
  });

  it("an inject-only delivery neither paces nor debounces the spoken lane", () => {
    let now = 1000;
    const bus = new PaneSignalBus(3000, 5000, () => now);
    const inject: string[] = [];
    bus.subscribe((s) => inject.push(s.kind), "inject");
    assert.strictEqual(bus.publish({ paneId: "p1", kind: "running" }), true); // inject-only
    now += 100;
    const spoken: string[] = [];
    bus.subscribe((s) => spoken.push(s.kind), "spoken");
    // Spoken lane: fresh debounce window AND no cross-kind stamp from the inject-only delivery.
    assert.strictEqual(bus.publish({ paneId: "p1", kind: "idle" }), true);
    assert.deepStrictEqual(spoken, ["idle"], "inject deliveries never pace the spoken lane");
    assert.deepStrictEqual(inject, ["running", "idle"]);
  });

  it("publish returns false only when EVERY lane suppresses", () => {
    let now = 1000;
    const bus = new PaneSignalBus(3000, 5000, () => now);
    const spoken: string[] = [];
    const inject: string[] = [];
    bus.subscribe((s) => spoken.push(s.kind), "spoken");
    bus.subscribe((s) => inject.push(s.kind), "inject");
    assert.strictEqual(bus.publish({ paneId: "p1", kind: "idle", detail: "d" }), true);
    now += 100;
    assert.strictEqual(bus.publish({ paneId: "p1", kind: "idle", detail: "d" }), false,
      "identical repeat inside both lanes' windows delivers nowhere");
    assert.deepStrictEqual(spoken, ["idle"]);
    assert.deepStrictEqual(inject, ["idle"]);
  });

  it("unsubscribe removes the observer from its own lane only", () => {
    const bus = new PaneSignalBus(0, 0);
    const spoken: string[] = [];
    const inject: string[] = [];
    const offSpoken = bus.subscribe((s) => spoken.push(s.kind), "spoken");
    bus.subscribe((s) => inject.push(s.kind), "inject");
    offSpoken();
    bus.publish({ paneId: "p1", kind: "idle" });
    assert.deepStrictEqual(spoken, []);
    assert.deepStrictEqual(inject, ["idle"]);
  });
});

// ── z5c design (spec 2026-07-07-z5c-session-pool-design.md D1/D4/D6) — per-project inject routing ─
// The bus itself is project-agnostic (a PaneSignal carries only paneId/kind/detail — no project).
// Routing an inject-class delivery to "its own" project's session is a CONSUMER-side decision,
// made in src/voice/index.ts's inject subscriber using backgroundProjectForSignal (a project id
// resolved from the pane) + SessionPool bookkeeping. These tests exercise that exact combination:
// the bus fans out to ONE subscriber (mirroring the real single subscriber in voice/index.ts), and
// the subscriber's own routing logic decides whether to "deliver" (call the session's inject hook)
// or drop-and-bookkeep (a background project with no live socket, per D6's no-event-queue decision).
//
// backgroundProjectForSignal is deliberately conservative: it only classifies a project as
// "background" when the POOL has POSITIVE evidence (state "handle") that a real switch AWAY from
// it happened — never merely "some other id than whatever manager.ledger.activeProjectId is right
// now". A project a pane was created/worked in WITHOUT the operator ever running switch_context
// (the common case in most of this app's own test suites — create_pane never itself switches
// context) must keep injecting exactly as it did pre-pool.
describe("PaneSignalBus inject-class routing to the right project's session (z5c D1/D4/D6)", () => {
  function makePool(now: () => number = () => 1000): SessionPool {
    return new SessionPool({
      store: null,
      gates: new InjectGateRegistry(() => 3000),
      contextVersions: new ContextVersionRegistry(null),
      sessionId: "vsess-1",
      hotSlotBudget: 1,
      now,
    });
  }

  it("a signal about the FOREGROUND project's own pane is delivered", () => {
    const bus = new PaneSignalBus(0, 0);
    const pool = makePool();
    pool.noteSwitch("proj_a", 1000);
    const delivered: PaneSignal[] = [];
    const dropped: string[] = [];
    bus.subscribe((sig) => {
      const bg = backgroundProjectForSignal(pool, "proj_a"); // this signal's pane belongs to proj_a
      if (bg) { dropped.push(bg); return; }
      delivered.push(sig);
    }, "inject");

    bus.publish({ paneId: "pane_in_a", kind: "idle" });
    assert.deepStrictEqual(delivered.map((s) => s.paneId), ["pane_in_a"]);
    assert.deepStrictEqual(dropped, []);
  });

  it("a signal about a DIFFERENT project the pool has NEVER tracked a switch away from is still delivered (the common case)", () => {
    const bus = new PaneSignalBus(0, 0);
    const pool = makePool();
    pool.noteSwitch("proj_a", 1000); // proj_a is foreground; proj_z was simply never switched to
    const delivered: PaneSignal[] = [];
    bus.subscribe((sig) => {
      const bg = backgroundProjectForSignal(pool, "proj_z");
      if (bg) return;
      delivered.push(sig);
    }, "inject");

    bus.publish({ paneId: "pane_in_z", kind: "idle" });
    assert.deepStrictEqual(delivered.map((s) => s.paneId), ["pane_in_z"], "a never-switched project is NOT background — matches pre-pool behavior");
  });

  it("a signal about a project the pool EXPLICITLY switched away from is dropped (no live socket) and its bookkeeping still advances", () => {
    const bus = new PaneSignalBus(0, 0);
    const pool = makePool();
    pool.noteSwitch("proj_a", 1000); // proj_a is foreground
    pool.noteSwitch("proj_b", 2000); // now proj_b is foreground; proj_a is backgrounded (state "handle")
    const delivered: PaneSignal[] = [];
    bus.subscribe((sig) => {
      const bg = backgroundProjectForSignal(pool, "proj_a"); // this signal's pane belongs to the BACKGROUNDED proj_a
      if (bg) { pool.noteEvent(bg, 3000); return; }
      delivered.push(sig);
    }, "inject");

    bus.publish({ paneId: "pane_in_a", kind: "idle" });
    assert.deepStrictEqual(delivered, [], "background project signal never reaches the foreground's session");
    assert.strictEqual(pool.stateFor("proj_a"), "handle", "proj_a stays backgrounded — this signal did not promote it");
    // Its bookkeeping DID advance (visible via the next pool.plan snapshot's lastEventAtMs), even
    // though nothing was live-delivered — the promotion's own catch-up brief covers what it missed.
    const snap = pool.snapshotFor(["proj_a", "proj_b"], 3000);
    assert.strictEqual(snap.entries.proj_a.lastEventAtMs, 3000);
  });

  it("an UNRESOLVABLE owning project falls back to delivery — never silently drop an unclassifiable pane", () => {
    const bus = new PaneSignalBus(0, 0);
    const pool = makePool();
    pool.noteSwitch("proj_a", 1000);
    const delivered: PaneSignal[] = [];
    bus.subscribe((sig) => {
      const bg = backgroundProjectForSignal(pool, null); // pane's owning project could not be resolved
      if (bg) return;
      delivered.push(sig);
    }, "inject");

    bus.publish({ paneId: "orphan_pane", kind: "idle" });
    assert.deepStrictEqual(delivered.map((s) => s.paneId), ["orphan_pane"]);
  });

  it("a fresh pool with no switches at all never classifies anything as background", () => {
    const pool = makePool();
    assert.strictEqual(backgroundProjectForSignal(pool, "proj_a"), null);
  });
});

// ── Phase 2 Step 2.5 (fix of the Step 2.4 documented switch_context mixed-brief bug) ───────────
// resolveBriefPane: on a project_switch whose focused pane still belongs to the PRIOR project,
// the brief renders with NO active-pane tier (the pane tier arrives on the operator's next
// switch_active_pane). Every other trigger — and a pane that DOES belong to the new foreground
// project — is byte-identical to before. Unresolvable pane ownership fails toward isolation.
describe("resolveBriefPane — project_switch drops a cross-project stale pane from the brief", () => {
  function makeManager(paneProject: Record<string, string>): any {
    const terminals: Record<string, any> = {};
    const workspaces: Record<string, any> = {};
    for (const [paneId, projectId] of Object.entries(paneProject)) {
      terminals[paneId] = { projectId };
      workspaces[projectId] = workspaces[projectId] ?? { id: projectId, panes: {} };
      workspaces[projectId].panes[paneId] = { pane_id: paneId };
    }
    return {
      terminals,
      ledger: {
        workspaces,
        getProject: (id: string) => workspaces[id] ?? null,
      },
    };
  }

  it("project_switch + pane owned by the PRIOR project -> pane dropped (null)", () => {
    const manager = makeManager({ "pane-a": "proj_a" });
    assert.strictEqual(resolveBriefPane(manager, "project_switch", "pane-a", "proj_b"), null);
  });

  it("project_switch + pane owned by the NEW foreground project -> pane kept", () => {
    const manager = makeManager({ "pane-b": "proj_b" });
    assert.strictEqual(resolveBriefPane(manager, "project_switch", "pane-b", "proj_b"), "pane-b");
  });

  it("project_switch + UNRESOLVABLE pane ownership -> dropped (fail toward isolation)", () => {
    const manager = makeManager({});
    assert.strictEqual(resolveBriefPane(manager, "project_switch", "ghost-pane", "proj_b"), null);
  });

  it("project_switch with no focused pane at all -> stays null (the common fresh-connection case)", () => {
    const manager = makeManager({});
    assert.strictEqual(resolveBriefPane(manager, "project_switch", null, "proj_b"), null);
  });

  it("every NON-project_switch trigger keeps the pane verbatim — no ownership lookup, no behavior change", () => {
    const manager = makeManager({ "pane-a": "proj_a" });
    for (const trigger of ["session_start", "reconnect", "pane_switch", "command_outcome", "catch_up"] as const) {
      assert.strictEqual(resolveBriefPane(manager, trigger as any, "pane-a", "proj_b"), "pane-a", trigger);
    }
  });
});
