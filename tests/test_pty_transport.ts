import { describe, it } from "node:test";
import assert from "node:assert";
import { nodePtyAvailable } from "../src/ptyTransport";

/**
 * Guard for the node-pty loader (ptyTransport.loadNodePty) — the linchpin that
 * keeps live panes on a REAL PTY. Under tsx/ESM there is no lexical `require`, so
 * the loader resolves one via createRequire(import.meta.url); if that ever
 * regresses, every pane silently falls back to the non-TTY legacy transport and
 * Claude detects no terminal and exits after a few seconds. This fails loudly the
 * moment node-pty stops loading.
 *
 * It only asserts the module RESOLVES (a real `require` was found and the native
 * binding exposes `spawn`). It never spawns a ConPTY.
 */
describe("node-pty loader (ptyTransport)", () => {
  it("resolves the native node-pty module under the runtime (real PTY available)", () => {
    assert.strictEqual(
      nodePtyAvailable(),
      true,
      "native node-pty failed to load — panes would degrade to the non-TTY legacy transport"
    );
  });

  it("is memoized: repeated calls return the same resolution", () => {
    const first = nodePtyAvailable();
    const second = nodePtyAvailable();
    assert.strictEqual(first, second);
    assert.strictEqual(second, true);
  });
});
