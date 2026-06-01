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
});
