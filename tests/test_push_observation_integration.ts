import { describe, it } from "node:test";
import assert from "node:assert";
import { PaneSignalBus } from "../src/paneSignalBus";
import { classifyPaneOutput, formatPaneSignal } from "../src/paneSignals";

// A stand-in for the Gemini live session: records what would be spoken.
class FakeSession {
  spoken: string[] = [];
  sendClientContent(arg: any) {
    this.spoken.push(arg.turns[0].parts[0].text);
  }
}

describe("push-observation end-to-end (classify -> bus -> session)", () => {
  it("an error chunk reaches the subscribed session as compact narration", () => {
    const bus = new PaneSignalBus(0);
    const fake = new FakeSession();
    bus.subscribe((sig) =>
      fake.sendClientContent({
        turns: [{ role: "user", parts: [{ text: formatPaneSignal(sig) }] }],
        turnComplete: true,
      }),
    );

    // Simulate manager.onOutput for pane "build-1".
    const chunk = "webpack compiled\nError: Module not found: ./missing\n";
    const cls = classifyPaneOutput(chunk);
    assert.ok(cls, "classifier should fire");
    bus.publish({ paneId: "build-1", kind: cls!.kind, detail: cls!.detail });

    assert.strictEqual(fake.spoken.length, 1);
    assert.match(fake.spoken[0], /build-1/);
    assert.match(fake.spoken[0], /error/i);
    assert.match(fake.spoken[0], /Module not found/);
  });

  it("Phase 1 ears: a 'running' signal reaches the session as a compact started/cooking nudge", () => {
    // Proves the NEW kind survives the bus -> FakeSession.sendClientContent path of fact [C]
    // (the model's only live channel). The text must narrate a BEGINNING and name the pane,
    // not fall through to the 'exited' verb.
    const bus = new PaneSignalBus(0);
    const fake = new FakeSession();
    bus.subscribe((sig) =>
      fake.sendClientContent({
        turns: [{ role: "user", parts: [{ text: formatPaneSignal(sig) }] }],
        turnComplete: true,
      }),
    );

    bus.publish({ paneId: "agent-2", kind: "running", detail: "npm test" });

    assert.strictEqual(fake.spoken.length, 1);
    assert.match(fake.spoken[0], /agent-2/);
    assert.match(fake.spoken[0], /start|cook|working|began|begin|running/i);
    assert.doesNotMatch(fake.spoken[0], /\bexited\b/i, "a start must not narrate as 'exited'");
  });

  it("benign output produces no push", () => {
    const bus = new PaneSignalBus(0);
    const fake = new FakeSession();
    bus.subscribe((sig) => fake.sendClientContent({ turns: [{ role: "user", parts: [{ text: formatPaneSignal(sig) }] }] }));
    const cls = classifyPaneOutput("building 2 of 5\n");
    if (cls) bus.publish({ paneId: "build-1", kind: cls.kind, detail: cls.detail });
    assert.strictEqual(fake.spoken.length, 0);
  });
});
