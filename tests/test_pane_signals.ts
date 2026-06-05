import { describe, it } from "node:test";
import assert from "node:assert";
import { classifyPaneOutput, formatPaneSignal } from "../src/paneSignals";

describe("classifyPaneOutput", () => {
  it("flags error lines", () => {
    const c = classifyPaneOutput("compiling...\nError: cannot find module 'x'\n");
    assert.strictEqual(c?.kind, "error");
    assert.match(c!.detail, /cannot find module/);
  });

  it("flags test-failure summaries", () => {
    const c = classifyPaneOutput("Tests: 3 failed, 10 passed\n");
    assert.strictEqual(c?.kind, "error");
  });

  it("flags a trailing shell prompt", () => {
    const c = classifyPaneOutput("done\nuser@host:~/proj$ ");
    assert.strictEqual(c?.kind, "prompt");
  });

  it("returns null for benign output", () => {
    assert.strictEqual(classifyPaneOutput("building module 2 of 5\n"), null);
  });

  it("errors win over a trailing prompt", () => {
    const c = classifyPaneOutput("Error: not found\nuser@host:~/proj$ ");
    assert.strictEqual(c?.kind, "error");
  });

  it("does not false-positive on kebab/dotted/path error filenames (HMR noise)", () => {
    assert.strictEqual(classifyPaneOutput("error-handling.ts compiled in 14ms\n"), null);
    assert.strictEqual(classifyPaneOutput("[vite] hmr update /src/error.ts\n"), null);
  });

  it("redacts secrets in detail (invariant: detail is safe to inject into the model)", () => {
    const c = classifyPaneOutput("Error: auth failed token AKIA1234567890ABCD99\n");
    assert.strictEqual(c?.kind, "error");
    assert.doesNotMatch(c!.detail, /AKIA1234567890ABCD99/, "raw secret must not survive in detail");
    assert.match(c!.detail, /\[REDACTED/i);
    // and end-to-end through the formatter that builds the model-bound text
    const text = formatPaneSignal({ paneId: "p", kind: "error", detail: c!.detail });
    assert.doesNotMatch(text, /AKIA1234567890ABCD99/);
  });
});

describe("formatPaneSignal", () => {
  it("produces compact operator-facing text with the pane id", () => {
    const text = formatPaneSignal({ paneId: "build-1", kind: "error", detail: "boom" });
    assert.match(text, /build-1/);
    assert.match(text, /error/i);
    assert.match(text, /boom/);
  });

  // Phase 1 ("give Janus ears"): the new "running" kind must narrate a BEGINNING, not be
  // swallowed by the verb chain's "exited" fallthrough (the exhaustiveness trap — tsc cannot
  // catch it because the ternary chain has a default). The model only ever sees this text.
  it("running renders a started/cooking BEGINNING with the pane id (NOT the 'exited' fallback)", () => {
    const text = formatPaneSignal({ paneId: "pane-7", kind: "running" });
    assert.match(text, /pane-7/, "names the pane");
    assert.match(text, /start|cook|working|began|begin|running/i, "narrates a beginning, not an end");
    assert.doesNotMatch(text, /\bexited\b/i, "must NOT mis-narrate a start as the 'exited' fallback");
  });

  it("running detail is preserved and remains redaction-safe (invariant: safe to inject into the model)", () => {
    // The caller redacts detail at the boundary (observe/index.ts), so the formatter just
    // appends it; assert it survives AND that a pre-redacted detail renders verbatim.
    const text = formatPaneSignal({ paneId: "p", kind: "running", detail: "npm test" });
    assert.match(text, /npm test/);
    assert.match(text, /p\b/);
    // A detail that was already redacted upstream must pass through untouched (no secret leak
    // reintroduced by the formatter).
    const redactedText = formatPaneSignal({ paneId: "p", kind: "running", detail: "deploy [REDACTED]" });
    assert.match(redactedText, /\[REDACTED\]/);
    assert.doesNotMatch(redactedText, /\bexited\b/i);
  });
});

// Conservative Phase 2 ("make status honest, humbly"): the new "quiescing" kind is the
// model-facing 'pane appears to be wrapping up / cooking' nudge — observed strictly inside
// the pre-idle debounce window the state machine ALREADY creates. It must NOT read as 'done'
// (no premature completion), must NOT be swallowed by the verb chain's "exited" fallthrough
// (the exhaustiveness trap — tsc cannot catch the ternary default), and must NOT collide with
// the existing 'idle' wording (idle is the authoritative completion edge).
describe("quiescing signal (Conservative Phase 2)", () => {
  it("formatPaneSignal renders a humble cooking nudge for kind:quiescing", () => {
    const text = formatPaneSignal({ paneId: "p1", kind: "quiescing" });
    assert.match(text, /p1/, "names the pane");
    assert.match(
      text,
      /cooking|wrapping up|appears to be finishing|settling/i,
      "narrates a humble 'still cooking / wrapping up' state"
    );
    // Humble: it is NOT a completion. Must not claim done/finished, must not be the
    // 'exited' fallthrough, must not reuse the authoritative 'idle' wording.
    assert.doesNotMatch(text, /\bfinished\b|\bdone\b/i, "must NOT claim genuine completion");
    assert.doesNotMatch(text, /\bexited\b/i, "must NOT mis-narrate as the 'exited' fallback");
    assert.doesNotMatch(text, /went idle/i, "must NOT reuse the authoritative idle wording");
  });

  it("quiescing detail is preserved and remains redaction-safe", () => {
    const text = formatPaneSignal({ paneId: "p", kind: "quiescing", detail: "npm test" });
    assert.match(text, /npm test/);
    const redactedText = formatPaneSignal({ paneId: "p", kind: "quiescing", detail: "deploy [REDACTED]" });
    assert.match(redactedText, /\[REDACTED\]/);
    assert.doesNotMatch(redactedText, /\bexited\b/i);
  });
});
