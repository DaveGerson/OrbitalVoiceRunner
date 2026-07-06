/**
 * tests/test_pane_input_client.ts — unit tests for buildPaneInputFrame (src/orbital/paneInputClient.ts).
 *
 * This pins the FRONTEND half of the pane_input wire contract: the exact field names the client emits
 * must be the ones the server's applyPaneInputFrame reads (`type` / `paneId` / `data`). Without this,
 * a typo like `pane_id` or `payload` at a call site would ship a frame the server silently ignores or
 * mis-routes, and only the (slower, live-only) e2e would ever catch it.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { buildPaneInputFrame, shouldSendPaneInput } from "../src/orbital/paneInputClient";

describe("buildPaneInputFrame — the pane_input wire contract", () => {
  it("produces exactly { type:'pane_input', paneId, data } with those field names", () => {
    const frame = buildPaneInputFrame("pane-7", "echo hi\r");
    assert.deepStrictEqual(frame, { type: "pane_input", paneId: "pane-7", data: "echo hi\r" });
  });

  it("emits the field names the server (applyPaneInputFrame) reads off the frame", () => {
    // Guards against client/server wire drift: these keys must match what the server validates.
    const frame = buildPaneInputFrame("p1", "x");
    assert.ok("type" in frame && "paneId" in frame && "data" in frame, "type/paneId/data all present");
    assert.strictEqual(frame.type, "pane_input");
  });

  it("round-trips through JSON.stringify/parse unchanged (what actually departs over the socket)", () => {
    const frame = buildPaneInputFrame("p1", "ls -la\r");
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(frame)),
      { type: "pane_input", paneId: "p1", data: "ls -la\r" },
    );
  });

  it("passes the keystroke bytes through verbatim (escape sequences / control chars intact)", () => {
    const arrowUp = "\x1b[A";
    const frame = buildPaneInputFrame("p1", arrowUp);
    assert.strictEqual(frame.data, arrowUp, "raw bytes are not transformed");
  });
});

describe("shouldSendPaneInput — the TerminalView onInput= send guard", () => {
  it("suppresses under plain mock mode (e2e wire NOT armed), even with an OPEN socket", () => {
    assert.strictEqual(shouldSendPaneInput(true, false, { readyState: 1 }), false);
  });

  it("allows mock mode when the e2e wire IS armed and the socket is OPEN", () => {
    assert.strictEqual(shouldSendPaneInput(true, true, { readyState: 1 }), true);
  });

  it("suppresses when the socket is not OPEN, even live and wire-armed", () => {
    assert.strictEqual(shouldSendPaneInput(false, true, { readyState: 3 }), false);
  });

  it("suppresses when there is no socket at all", () => {
    assert.strictEqual(shouldSendPaneInput(false, true, null), false);
    assert.strictEqual(shouldSendPaneInput(false, true, undefined), false);
  });

  it("allows the live/non-mock path with an OPEN socket (positive control)", () => {
    assert.strictEqual(shouldSendPaneInput(false, false, { readyState: 1 }), true);
  });
});
