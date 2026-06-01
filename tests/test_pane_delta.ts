import { describe, it } from "node:test";
import assert from "node:assert";
import { UniversalTerminal, OrchestratorManager } from "../src/terminal";

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
    const t: any = new UniversalTerminal("p1", "shell", "bash");
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
    const t: any = new UniversalTerminal("p2", "shell", "bash");
    t.maxBufferLines = 3;
    feed(t, "1\n2\n3\n4\n5\n"); // 5 lines pushed, buffer keeps last 3 (3,4,5)
    const d = t.consumeDelta();
    assert.strictEqual(d.dropped, 2, "lines 1-2 evicted before first read");
    assert.strictEqual(d.lines, "3\n4\n5");
  });
});

describe("manager.getPaneDelta", () => {
  it("returns a redacted, fenced delta and a no-output sentinel", () => {
    const m: any = new OrchestratorManager();
    const t: any = new UniversalTerminal("p3", "shell", "bash");
    m.terminals["p3"] = t;
    t.outputBuffer.push("hello", "AKIA1234567890ABCD99"); // 2nd line is an AWS-key shape
    t.totalLines += 2;

    const out = m.getPaneDelta("p3");
    assert.match(out, /hello/);
    assert.match(out, /\[REDACTED/i, "secret-shaped tokens are scrubbed");
    assert.match(out, /```/, "fenced block");

    assert.strictEqual(m.getPaneDelta("p3"), "[No new output since last read]");
    assert.match(m.getPaneDelta("missing"), /does not exist/);
  });
});
