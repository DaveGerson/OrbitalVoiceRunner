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
