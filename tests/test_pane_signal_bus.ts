import { describe, it } from "node:test";
import assert from "node:assert";
import { PaneSignalBus } from "../src/paneSignalBus";

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
    const bus = new PaneSignalBus(3000, () => now);
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
});
