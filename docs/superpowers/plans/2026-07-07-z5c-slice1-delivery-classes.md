# z5c Slice 1: Bus Delivery Classes + Per-Session Gate Groundwork — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Command-outcome context injections get their own `PaneSignalBus` delivery class that bypasses the spoken-turn L1 cross-kind cooldown (fixing the fast-command under-injection, bead `wsm-e2e-pinned-1d6w`), plus an `InjectGateRegistry` so gate state can be keyed per session in later slices.

**Architecture:** The bus gains two independent delivery lanes (`spoken` keeps every current behavior including the L1 cross-kind cooldown; `inject` runs the same per-(pane,kind)+detail debounce but no cross-kind suppression — the D2 InjectGate is that leg's anti-spam authority). The voice layer splits its single subscription into a spoken subscription and an inject subscription. The D2 gate moves behind a per-session registry with a null-key default so today's behavior is byte-identical.

**Tech Stack:** TypeScript (Node), `node:test` via `npx tsx --test --test-force-exit`, eslint complexity gates (CC ≤ 10 / cognitive ≤ 15, hard errors, zero suppressions).

**Spec:** `docs/superpowers/specs/2026-07-07-z5c-session-pool-design.md` (sections D1, D5-groundwork, D8, D9-slice-1). Read it before starting.

**Non-goals (do NOT build):** handle tier, hot slots, `pool.plan`, any Python change, any new settings key, any telemetry schema change. Slice 1 is TS-only.

---

## Execution protocol (dual-executor comparison — read first)

This plan is executed **twice, independently**, for implementation comparison:

- **Executor A (Gemini/agy)** works in worktree `../OrbitalVoiceRunner-wt/z5c-s1-gemini`, branch `feat/z5c-s1-gemini`.
- **Executor B (Codex)** works in worktree `../OrbitalVoiceRunner-wt/z5c-s1-codex`, branch `feat/z5c-s1-codex`.
- The orchestrator (Fable) creates both worktrees, seeds each with the spec + this plan (committed as each branch's first commit), launches both executors, then **adversarially reviews and diffs the two implementations**. The winner (possibly with grafts from the runner-up) goes through the full done-pipeline (adversarial review → e2e → lint/unit/complexity/build → PR). The losing branch is closed unmerged.

**Executor rules:**
1. Work ONLY inside your own worktree. Never touch the shared main checkout or the other executor's worktree.
2. Do NOT run any `bd` (beads) mutation — the orchestrator owns issue state.
3. Commit after every task (messages given per task). Do NOT push and do NOT open a PR — the orchestrator handles integration after comparison.
4. Follow this plan's code exactly where given; where you see a genuinely better micro-decision, take it AND leave a `// DELTA(plan):` comment explaining the deviation — deviations are a scored part of the comparison.
5. Every existing test must stay green. `npm run lint`, `npm test`, `npm run complexity`, `npm run build` must all pass before your final commit.
6. Preserve existing comment blocks (4D.2, L1, ykr, Wave 4 D1/D2) — relocate and amend them where the plan says; never delete their history silently.

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `src/paneSignalBus.ts` | Modify | Two delivery lanes with per-lane debounce state; cross-kind cooldown becomes spoken-lane-only. |
| `src/memory/injectGate.ts` | Modify (append) | Add `InjectGateRegistry` (per-session-key gate instances, null → stable default key). |
| `src/memory/index.ts` | Modify | `MemoryService` holds a registry; `gate` becomes a delegating getter (back-compat). |
| `src/voice/index.ts` | Modify | Split the one bus subscription into spoken + inject subscriptions; widen the structural bus type. |
| `tests/test_pane_signal_bus.ts` | Modify (append) | New `describe` block: delivery-class semantics. |
| `tests/test_inject_gate_registry.ts` | Create | Registry unit tests. |
| `tests/test_cortex_cutover_journeys.ts` | Modify | Journey 4: organic outcome row becomes a hard requirement; delete the replay fallback + the 5.2s cooldown sleep. |

---

### Task 1: Bus delivery lanes

**Files:**
- Modify: `src/paneSignalBus.ts` (whole file, ~86 lines)
- Test: `tests/test_pane_signal_bus.ts` (append a `describe` block)

- [ ] **Step 1: Write the failing tests** — append to `tests/test_pane_signal_bus.ts` (imports at top of file already exist; add nothing to them):

```ts
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
```

- [ ] **Step 2: Run to verify the new tests fail** (existing ones must still pass):

Run: `npx tsx --test --test-force-exit tests/test_pane_signal_bus.ts`
Expected: the 6 new tests FAIL (TypeScript: `subscribe` takes 1 argument / behavior mismatches); all pre-existing tests PASS.

- [ ] **Step 3: Implement the lanes** — replace the body of `src/paneSignalBus.ts` (keep the file header import; preserve the 4D.2 / L1 comment content as shown):

```ts
import type { PaneSignal, PaneSignalKind } from "./paneSignals";

type Observer = (signal: PaneSignal) => void;

/** z5c slice 1 (spec 2026-07-07 D1, closes bead wsm-e2e-pinned-1d6w): the concern a subscriber
 *  consumes deliveries for. `spoken` = voice announcements — keeps the L1 cross-kind cooldown
 *  (speech pacing). `inject` = context-injection triggers — NOT cross-kind suppressed; the
 *  per-session InjectGate (hash + debounce, spec 2026-07-02 D2) is that leg's anti-spam
 *  authority, so suppressing it here only reproduced the fast-command under-injection. */
export type DeliveryClass = "spoken" | "inject";

/** Priority order for cross-kind cooldown bypass — higher number = higher priority.
 *  error/exited always pass through; lower-priority status signals are suppressed
 *  during the cross-kind cooldown to prevent the re-announcement loop (bug L1). */
const KIND_PRIORITY: Record<PaneSignalKind, number> = {
  closed:    0,
  prompt:    1,
  created:   2,
  quiescing: 3,
  running:   4,
  idle:      5,
  exited:    6,
  error:     7,
};

/** Per-class delivery state. Each class runs its OWN (pane,kind)+detail debounce window so a
 *  delivery to one class never consumes the other's window — the 4D.2 zero-observer rule,
 *  generalized per class. Cross-kind cooldown state stays bus-level but only the spoken lane
 *  reads or stamps it (crossKind flag). */
interface DeliveryLane {
  observers: Set<Observer>;
  /** 4D.2: last delivery timestamp per (pane,kind) — this lane only. */
  lastPushAt: Map<string, number>;
  /** 4D.2: the detail last DELIVERED per (pane,kind) — a different detail inside the window is
   *  genuinely new information and passes through; only identical repeats collapse. */
  lastDetail: Map<string, string | undefined>;
  /** L1 applies to the spoken lane only. */
  crossKind: boolean;
}

/** Bridges global pane-event callbacks to N per-connection live sessions.
 *  Per-(pane,kind) debounce keeps a chatty pane from spamming the model — per delivery class.
 *  Cross-kind cooldown (L1 fix) prevents status-flap loops (running→idle→running…) from each
 *  generating a forced spoken turn; it deliberately does NOT govern the inject class. */
export class PaneSignalBus {
  private lanes: Record<DeliveryClass, DeliveryLane> = {
    spoken: { observers: new Set(), lastPushAt: new Map(), lastDetail: new Map(), crossKind: true },
    inject: { observers: new Set(), lastPushAt: new Map(), lastDetail: new Map(), crossKind: false },
  };
  /** L1: last-delivered timestamp per paneId (ANY kind) for cross-kind cooldown — spoken lane only. */
  private lastPaneSignalAt = new Map<string, number>();

  constructor(
    private debounceMs = 3000,
    private crossKindCooldownMs = 5000,
    private now: () => number = () => Date.now(),
  ) {}

  /** Returns an unsubscribe function. Default class is `spoken` — every pre-slice-1 subscriber
   *  keeps its exact semantics without touching its call site. */
  subscribe(observer: Observer, cls: DeliveryClass = "spoken"): () => void {
    const lane = this.lanes[cls];
    lane.observers.add(observer);
    return () => { lane.observers.delete(observer); };
  }

  /** L1: true when a low-priority signal should be suppressed by the cross-kind cooldown. */
  private isCrossKindSuppressed(paneId: string, kind: PaneSignalKind, t: number): boolean {
    const lastAnyKind = this.lastPaneSignalAt.get(paneId) ?? Number.NEGATIVE_INFINITY;
    return t - lastAnyKind < this.crossKindCooldownMs && (KIND_PRIORITY[kind] ?? 0) < KIND_PRIORITY.exited;
  }

  /** One lane's independent delivery decision + state stamping. 4D.2 rules hold per lane:
   *  a zero-observer lane never consumes its window; same-kind-different-detail passes through;
   *  identical repeats collapse. Only a crossKind (spoken) lane checks/stamps the L1 state. */
  private deliverToLane(lane: DeliveryLane, signal: PaneSignal, t: number): boolean {
    if (lane.observers.size === 0) return false; // nobody heard it -> the window is NOT consumed.
    const key = `${signal.paneId}:${signal.kind}`;
    const last = lane.lastPushAt.get(key) ?? Number.NEGATIVE_INFINITY;
    if (t - last < this.debounceMs && signal.detail === lane.lastDetail.get(key)) {
      return false; // identical repeat inside the window -> collapse (anti-spam intent preserved).
    }
    if (lane.crossKind && this.isCrossKindSuppressed(signal.paneId, signal.kind, t)) {
      return false;
    }
    lane.lastPushAt.set(key, t);
    lane.lastDetail.set(key, signal.detail);
    if (lane.crossKind) this.lastPaneSignalAt.set(signal.paneId, t);
    for (const observer of lane.observers) {
      try { observer(signal); }
      catch (e) { console.error("PaneSignalBus observer failed:", e); }
    }
    return true;
  }

  /** Fan out per delivery class — each lane decides independently (see 4D.2 comments above for
   *  why dropped/unheard deliveries must not stamp state). Returns true if ANY lane delivered. */
  publish(signal: PaneSignal): boolean {
    const t = this.now();
    const spoken = this.deliverToLane(this.lanes.spoken, signal, t);
    const inject = this.deliverToLane(this.lanes.inject, signal, t);
    return spoken || inject;
  }

  get observerCount(): number {
    return this.lanes.spoken.observers.size + this.lanes.inject.observers.size;
  }
}
```

- [ ] **Step 4: Run the bus tests — all pass, old and new**

Run: `npx tsx --test --test-force-exit tests/test_pane_signal_bus.ts`
Expected: PASS (all pre-existing L1/4D.2/ykr tests unchanged and green — that is the byte-compat regression guard).

- [ ] **Step 5: Commit**

```bash
git add src/paneSignalBus.ts tests/test_pane_signal_bus.ts
git commit -m "feat(bus): per-class delivery lanes - inject class bypasses L1 cross-kind cooldown (z5c s1, bead 1d6w)"
```

---

### Task 2: InjectGateRegistry (per-session gate groundwork)

**Files:**
- Modify: `src/memory/injectGate.ts` (append)
- Modify: `src/memory/index.ts:68-89` (gate field → registry + getter)
- Create: `tests/test_inject_gate_registry.ts`

- [ ] **Step 1: Write the failing tests** — create `tests/test_inject_gate_registry.ts`:

```ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { InjectGateRegistry } from "../src/memory/injectGate";

// z5c slice 1 groundwork (spec 2026-07-07 D5): gate state keyed per session. Today there is ONE
// session (key null); slices 2/3 thread real per-project session identities through forSession.
describe("InjectGateRegistry (z5c slice 1 groundwork)", () => {
  it("returns the same gate instance for the same session key", () => {
    const reg = new InjectGateRegistry(() => 3000);
    assert.strictEqual(reg.forSession("s1"), reg.forSession("s1"));
  });

  it("null maps to one stable default gate (today's single-session behavior)", () => {
    const reg = new InjectGateRegistry(() => 3000);
    assert.strictEqual(reg.forSession(null), reg.forSession(null));
    assert.notStrictEqual(reg.forSession(null), reg.forSession("s1"));
  });

  it("distinct sessions hold independent gate state", () => {
    const reg = new InjectGateRegistry(() => 3000);
    const a = reg.forSession("a");
    const b = reg.forSession("b");
    assert.notStrictEqual(a, b);
    // Session A injected hash H; session B's gate must not deduplicate against A's state.
    a.noteInjected("H", 1000);
    assert.deepStrictEqual(a.evaluate("H", "pane-switch", 1001), { inject: false, skip: "unchanged-brief" });
    assert.deepStrictEqual(b.evaluate("H", "pane-switch", 1001), { inject: true, skip: null });
  });

  it("gates share one live debounceMs getter (settings PUT reaches every session)", () => {
    let floor = 3000;
    const reg = new InjectGateRegistry(() => floor);
    const g = reg.forSession("s1");
    g.noteInjected("H1", 1000);
    assert.deepStrictEqual(g.evaluate("H2", "pane-switch", 2000), { inject: false, skip: "debounce" });
    floor = 500; // runtime settings change
    assert.deepStrictEqual(g.evaluate("H2", "pane-switch", 2000), { inject: true, skip: null });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test --test-force-exit tests/test_inject_gate_registry.ts`
Expected: FAIL — `InjectGateRegistry` is not exported.

- [ ] **Step 3: Implement the registry** — append to `src/memory/injectGate.ts`:

```ts
/** z5c slice 1 groundwork (spec 2026-07-07 D5): per-session gate state. One InjectGate per
 *  session key, created on demand; `null` (today's single implicit session) maps to a stable
 *  default key so current behavior is byte-identical. The debounceMs getter is shared by every
 *  gate so a runtime settings PUT reaches all sessions at once. Naming follows the existing
 *  `pendingApprovals.forSession(...)` idiom. */
export class InjectGateRegistry {
  private gates = new Map<string, InjectGate>();

  constructor(private debounceMs: () => number) {}

  forSession(sessionId: string | null): InjectGate {
    const key = sessionId ?? "__single_session__";
    let gate = this.gates.get(key);
    if (!gate) {
      gate = new InjectGate(this.debounceMs);
      this.gates.set(key, gate);
    }
    return gate;
  }
}
```

- [ ] **Step 4: Rewire `MemoryService`** — in `src/memory/index.ts`, replace the gate field (lines 68-71) and its construction (line 88):

Replace:
```ts
  // Wave 4 D2: the pre-cortex inject gate. Public — src/voice/index.ts's injectMemoryBrief choke
  // point calls `.evaluate` BEFORE any cortex round-trip and `.noteInjected` only after a brief
  // actually reaches Gemini.
  readonly gate: InjectGate;
```
with:
```ts
  // Wave 4 D2 + z5c slice 1 (spec 2026-07-07 D5): the pre-cortex inject gates, keyed per session.
  // src/voice/index.ts's injectMemoryBrief choke point calls `.evaluate` BEFORE any cortex
  // round-trip and `.noteInjected` only after a brief actually reaches Gemini. Today there is one
  // session, reached via the `gate` getter (key null); slices 2/3 pass real session ids.
  readonly gates: InjectGateRegistry;
```

Replace (in the constructor body):
```ts
    this.gate = new InjectGate(debounceMs);
```
with:
```ts
    this.gates = new InjectGateRegistry(debounceMs);
```

Add below the constructor (before `_hashOf`):
```ts
  /** Today's single-session gate (registry key null). Existing call sites and tests keep working
   *  unchanged; per-session callers use `gates.forSession(id)` directly. */
  get gate(): InjectGate {
    return this.gates.forSession(null);
  }
```

Update the import at the top of `src/memory/index.ts` from `import { InjectGate } from "./injectGate";`-style to include the registry (match the file's actual import line, e.g.):
```ts
import { InjectGate, InjectGateRegistry } from "./injectGate";
```
(If `InjectGate` becomes type-only after this change, keep it imported as a type for the getter's return annotation.)

- [ ] **Step 5: Run registry tests + every existing gate/cortex suite**

Run: `npx tsx --test --test-force-exit tests/test_inject_gate_registry.ts`
Expected: PASS.

Run: `npm test`
Expected: PASS — in particular every Wave 4 test that touches `memory.service.gate` still passes through the delegating getter, proving byte-compat.

- [ ] **Step 6: Commit**

```bash
git add src/memory/injectGate.ts src/memory/index.ts tests/test_inject_gate_registry.ts
git commit -m "feat(memory): InjectGateRegistry - per-session gate state groundwork (z5c s1)"
```

---

### Task 3: Split the voice subscription (spoken vs inject)

**Files:**
- Modify: `src/voice/index.ts:331` (structural bus type)
- Modify: `src/voice/index.ts:1851-1879` (the subscription block inside `hoistAndSubscribe`)

- [ ] **Step 1: Widen the structural type** — at `src/voice/index.ts:331`, replace:

```ts
  paneSignalBus: { subscribe: (fn: (sig: any) => void) => () => void };
```
with:
```ts
  paneSignalBus: { subscribe: (fn: (sig: any) => void, cls?: "spoken" | "inject") => () => void };
```

- [ ] **Step 2: Split the subscription** — replace the block at `src/voice/index.ts:1851-1879` (from `state.unsubscribePaneSignals = paneSignalBus.subscribe(...)` through the closing `});`) with:

```ts
        const unsubscribeSpoken = paneSignalBus.subscribe((sig: PaneSignal) => {
          // B1 (phase-2 gate): the async-spawn "ready" ("created") AND the operator-initiated exit+
          // archive completion ("closed", wsm-e2e-pinned-5h0) are turn-gated — both are follow-ups that
          // must never talk over the operator. All other kinds (idle/error/prompt/exited) keep today's
          // immediate-push behavior verbatim.
          if (sig.kind === "created" || sig.kind === "closed") {
            const d = shouldSpeakReadyAck(ackState());
            if (d === "suppress") return;                       // barge-in -> drop the "ready".
            if (d === "defer") {                                // mid-utterance -> queue + re-arm.
              // bead ykr: clone before stamping — the bus shares ONE signal object across all observers,
              // so we must NOT mutate the shared payload. The queue owns its tagged copy.
              state.deferredReady.push(stampDeferred(sig, Date.now()));
              armReadyDrain();
              return;
            }
          }
          pushSignal(sig);
        });
        // Wave 4 (D1, cortex cutover design) + z5c slice 1 (spec 2026-07-07 D1, closes bead
        // wsm-e2e-pinned-1d6w): the observe layer's EXISTING onIdle 'idle' pane signal IS the
        // command-completion edge. It now arrives on the bus's `inject` delivery class, which is
        // NOT subject to the spoken-turn L1 cross-kind cooldown — a fast command completing
        // within 5s of its own 'running' edge still injects. Anti-spam for this leg is the SAME
        // InjectGate every other trigger goes through (hash + debounce floor) — a burst of idle
        // edges across panes still collapses to at most one cortex round-trip per floor.
        // Fire-and-forget (injectMemoryBrief owns its own try/catch and never rejects). It threads
        // the pane the signal was ABOUT (sig.paneId) as `affectedPaneId`, independent of whatever
        // pane is currently focused, so a command-outcome cortex profile can lead with it.
        const unsubscribeInject = paneSignalBus.subscribe((sig: PaneSignal) => {
          if (sig.kind !== "idle") return;
          void injectMemoryBrief(state.session, coreState.activePaneId, "command_outcome", sig.paneId);
        }, "inject");
        state.unsubscribePaneSignals = () => { unsubscribeSpoken(); unsubscribeInject(); };
```

(Note: `pushSignal(sig);` stays the LAST statement of the spoken observer; the old `if (sig.kind === "idle")` inject block is REMOVED from it — the inject subscription owns that leg now.)

- [ ] **Step 3: Lint + unit + the journey suite**

Run: `npm run lint`
Expected: clean (tsc --noEmit).

Run: `npm test`
Expected: PASS. `tests/test_cortex_cutover_journeys.ts` still passes as-written: its replay fallback is conditional (`if (!organicOutcomeRow())`) and simply never fires now.

- [ ] **Step 4: Commit**

```bash
git add src/voice/index.ts
git commit -m "feat(voice): command-outcome inject leg rides the inject delivery class (z5c s1, bead 1d6w)"
```

---

### Task 4: Journey 4 — organic outcome row becomes a hard requirement

**Files:**
- Modify: `tests/test_cortex_cutover_journeys.ts:497-524` (delete the replay fallback)
- Modify: `tests/test_cortex_cutover_journeys.ts:559-565` (delete the 5.2s cooldown sleep)

- [ ] **Step 1: Make the organic row required** — replace lines 497-524 (the machine-speed comment + `organicOutcomeRow` helper + the `if (!organicOutcomeRow()) { ... replay loop ... }` block + the `const outcomeRow = await waitFor(organicOutcomeRow, 10000);` line) with:

```ts
    // z5c slice 1 (spec 2026-07-07 D1, closed bead wsm-e2e-pinned-1d6w): the inject leg rides
    // its own bus delivery class and is NOT subject to the L1 cross-kind cooldown, so the organic
    // idle edge above ALWAYS reaches injectMemoryBrief — even on a fast runner where the whole
    // spawn->running->quiescing->idle cluster lands inside one 5s window (the exact machine-speed
    // dependence that used to require a replay-through-the-bus fallback here). The organic row is
    // now a hard requirement: if this waitFor times out, the delivery-class regression is real.
    const outcomeRow = await waitFor(() => rowsSince(running, bootTs).find(
      (r) => r.trigger === "command_outcome" && r.active_pane_id === "outcome-a" && r.disposition === "injected"), 15000);
```

(The two assertions that follow — `assert.ok(outcomeRow, ...)` and the `disposition`/`active_pane_id` strictEquals — stay exactly as they are.)

- [ ] **Step 2: Delete the cooldown sleep** — replace lines 559-565 (the "PaneSignalBus runs its OWN cross-kind cooldown" comment + `await new Promise((r) => setTimeout(r, 5200));`) with:

```ts
    // z5c slice 1: the inject lane has NO cross-kind cooldown, and the repeat probe below uses a
    // DIFFERENT detail string, which passes the lane's identical-repeat collapse (4D.2 semantics,
    // per lane) — so no cooldown wait is needed before the second publish. Gate-order note: the
    // InjectGate checks hash-equality BEFORE the debounce floor, so the unchanged world yields
    // "unchanged-brief" (not "debounce") regardless of how quickly this follows the first inject.
```

- [ ] **Step 3: Run the journey file**

Run: `npx tsx --test --test-force-exit tests/test_cortex_cutover_journeys.ts`
Expected: PASS, and Journey 4 runs ~5s faster than before (sleep removed).

- [ ] **Step 4: Commit**

```bash
git add tests/test_cortex_cutover_journeys.ts
git commit -m "test(journeys): Journey 4 asserts the organic fast-command outcome injects - replay fallback + cooldown sleep removed (z5c s1)"
```

---

### Task 5: Full battery

- [ ] **Step 1: Run every gate**

```bash
npm run lint
npm test
npm run complexity
npm run build
```
Expected: all green, zero suppressions. If `npm run complexity` flags `publish`/`deliverToLane`, extract further helpers rather than suppressing (the ratchet only shrinks).

- [ ] **Step 2: Final commit (only if anything changed in step 1 fixes)**

```bash
git add -u
git commit -m "chore(z5c-s1): battery fixes"
```

- [ ] **Step 3: STOP.** Do not push, do not open a PR, do not run `bd`. Report: files changed, test counts, any `// DELTA(plan):` deviations you took and why. The orchestrator takes it from here.

---

## Plan self-review (done at authoring time)

- **Spec coverage:** D1 (delivery classes) → Tasks 1+3; D5 groundwork (per-session gate state) → Task 2; D8 slice-1 test rows (cooldown matrix, per-lane isolation, Journey-4 regression) → Tasks 1, 2, 4. Handle tier / pool.plan are explicitly out (D9 slices 2-3).
- **Placeholder scan:** every code step carries full code; no TBDs.
- **Type consistency:** `DeliveryClass = "spoken" | "inject"` (Task 1) matches the structural type in Task 3 and the `subscribe(observer, cls)` signature; `InjectGateRegistry.forSession` (Task 2) matches the `gates.forSession(null)` getter; `evaluate`/`noteInjected` signatures match `src/memory/injectGate.ts` as it exists today.
