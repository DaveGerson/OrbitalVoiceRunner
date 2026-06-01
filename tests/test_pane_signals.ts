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
});

describe("formatPaneSignal", () => {
  it("produces compact operator-facing text with the pane id", () => {
    const text = formatPaneSignal({ paneId: "build-1", kind: "error", detail: "boom" });
    assert.match(text, /build-1/);
    assert.match(text, /error/i);
    assert.match(text, /boom/);
  });
});
