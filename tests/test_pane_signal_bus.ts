import { describe, it } from "node:test";
import assert from "node:assert";
import { PaneSignalBus } from "../src/paneSignalBus";
import { stampDeferred } from "../src/voice/index";
import type { PaneSignal } from "../src/paneSignals";

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
});
