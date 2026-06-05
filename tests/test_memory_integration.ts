import { test } from "node:test";
import assert from "node:assert/strict";
import { attachObserve } from "../src/observe";

// Minimal manager + deps double; we only assert onBreadcrumb fires on the Running edge.
test("onRunning pushes a redacted breadcrumb via onBreadcrumb dep", () => {
  const crumbs: any[] = [];
  const manager: any = { terminals: { p1: { lastCommand: "deploy KEY=sk-abc" } } };
  const deps: any = {
    broadcast() {}, announcementBus: { enqueue() {} }, paneSignalBus: { publish() {} },
    pruneAttention() {}, interactionLog: { log() {} }, getLastInteractionId: () => null,
    redact: (s: string) => s.replace(/sk-[a-z]+/g, "[R]"),
    historyManager: { loadHistory: () => [], saveHistory() {}, appendOutputToLastCommand() {} },
    ai: {} as any,
    onBreadcrumb: (b: any) => crumbs.push(b),
  };
  const h = attachObserve(manager, deps);
  h.onRunning("p1");
  assert.equal(crumbs.length, 1);
  assert.equal(crumbs[0].paneId, "p1");
  assert.match(crumbs[0].text, /\[R\]/);          // redacted
  assert.doesNotMatch(crumbs[0].text, /sk-abc/);
});
