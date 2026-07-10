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

// ── z5c design (spec 2026-07-07-z5c-session-pool-design.md D5), Slice 2/3: the per-PROJECT key ──
// The design doc's actual keying scheme (SessionPool.gateFor, src/voice/sessionPool.ts) passes
// PROJECT ids through this exact registry, not opaque test-fixture strings. This closes the loop
// the slice-1 groundwork above left open ("slices 2/3 pass real session ids") — proving the SAME
// registry contract holds when the key is literally a project id, including the cross-project
// contamination bug this whole wave exists to close: pre-pool, EVERY project shared ONE gate
// (key null), so a brief that was "unchanged" for project A's conversation could wrongly skip an
// injection that was genuinely NEW for project B's conversation.
describe("InjectGateRegistry keyed by project id (z5c D5 — SessionPool.gateFor's real usage)", () => {
  it("switching the foreground project never lets one project's hash skip another's genuinely-changed brief", () => {
    const reg = new InjectGateRegistry(() => 3000);
    const projA = reg.forSession("proj_a");
    const projB = reg.forSession("proj_b");
    // Project A's brief with hash H1 was injected.
    projA.noteInjected("H1", 1000);
    // The operator switches to project B — its FIRST brief also happens to hash to H1 (same
    // situational shape, e.g. both projects have one idle pane). Pre-pool (one shared gate) this
    // would have wrongly read as "unchanged" and skipped. Per-project keying must still inject it.
    assert.deepStrictEqual(projB.evaluate("H1", "pane-switch", 1001), { inject: true, skip: null });
  });

  it("A -> B -> A: project A's own debounce/hash state survives the round trip untouched by B's activity", () => {
    const reg = new InjectGateRegistry(() => 3000);
    const projA = reg.forSession("proj_a");
    projA.noteInjected("H-a1", 1000);
    // Background B activity: many injections, none of which are project A.
    const projB = reg.forSession("proj_b");
    projB.noteInjected("H-b1", 1500);
    projB.noteInjected("H-b2", 2000);
    // Back to A: A's hash state is EXACTLY as A left it — unchanged-brief still skips A's own repeat.
    assert.deepStrictEqual(reg.forSession("proj_a").evaluate("H-a1", "pane-switch", 5000), { inject: false, skip: "unchanged-brief" });
    // ...but a genuinely new hash for A still injects, unaffected by how much B debounce-floor time elapsed.
    assert.deepStrictEqual(reg.forSession("proj_a").evaluate("H-a2", "pane-switch", 5001), { inject: true, skip: null });
  });

  it("gateFor(null) (no active project) still maps to the single stable default key — unchanged edge case", () => {
    const reg = new InjectGateRegistry(() => 3000);
    assert.strictEqual(reg.forSession(null), reg.forSession(null));
    assert.notStrictEqual(reg.forSession(null), reg.forSession("proj_a"));
  });
});
