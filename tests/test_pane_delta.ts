import { describe, it } from "node:test";
import assert from "node:assert";
import { UniversalTerminal } from "../src/terminal";

// Helper: push clean lines straight into the model-lane buffer the way onData does,
// without spinning up a real PTY. We exercise the public delta surface only.
function feed(term: any, text: string) {
  const cleanLines = text.split(/\r?\n/).filter((l: string) => l.trim() !== "");
  term.outputBuffer.push(...cleanLines);
  if (term.outputBuffer.length > term.maxBufferLines) {
    term.outputBuffer.splice(0, term.outputBuffer.length - term.maxBufferLines);
  }
  term.totalLines += cleanLines.length;
}

describe("UniversalTerminal.consumeDelta", () => {
  it("returns all lines on first read, then nothing until new output", () => {
    const t: any = new UniversalTerminal("p1", "/tmp", "shell");
    feed(t, "alpha\nbeta\n");
    let d = t.consumeDelta();
    assert.strictEqual(d.lines, "alpha\nbeta");
    assert.strictEqual(d.dropped, 0);

    d = t.consumeDelta();
    assert.strictEqual(d.lines, "", "no new output => empty delta");
    assert.strictEqual(d.dropped, 0);

    feed(t, "gamma\n");
    d = t.consumeDelta();
    assert.strictEqual(d.lines, "gamma");
  });

  it("reports dropped lines when the buffer cap evicts unread output", () => {
    const t: any = new UniversalTerminal("p2", "/tmp", "shell");
    t.maxBufferLines = 3;
    feed(t, "1\n2\n3\n4\n5\n"); // 5 lines pushed, buffer keeps last 3 (3,4,5)
    const d = t.consumeDelta();
    assert.strictEqual(d.dropped, 2, "lines 1-2 evicted before first read");
    assert.strictEqual(d.lines, "3\n4\n5");
  });
});
