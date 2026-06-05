import { test } from "node:test";
import assert from "node:assert/strict";
import { briefIsForActivePane } from "../src/memory";

// Simulate the injector's await→guard→inject sequence with a mutable "current active pane".
async function injectWithGuard(opts: {
  requestedId: string | null;
  synthesizeAsync: (id: string | null) => Promise<{ text: string; activePaneId: string | null; source: string }>;
  currentActiveIdAfterAwait: string | null;
  send: (text: string) => void;
}) {
  const brief = await opts.synthesizeAsync(opts.requestedId);
  if (!briefIsForActivePane(opts.requestedId, opts.currentActiveIdAfterAwait)) return; // drop stale
  if (brief.text.trim()) opts.send(brief.text);
}

test("a slow brief for a no-longer-active pane is dropped (latest-wins)", async () => {
  const sent: string[] = [];
  await injectWithGuard({
    requestedId: "p2",
    synthesizeAsync: async () => ({ text: "P2 BRIEF", activePaneId: "p2", source: "python" }),
    currentActiveIdAfterAwait: "p1", // user already switched back to p1
    send: (t) => sent.push(t),
  });
  assert.deepEqual(sent, []); // dropped
});

test("a brief for the still-active pane is injected exactly once", async () => {
  const sent: string[] = [];
  await injectWithGuard({
    requestedId: "p1",
    synthesizeAsync: async () => ({ text: "P1 BRIEF", activePaneId: "p1", source: "fallback" }),
    currentActiveIdAfterAwait: "p1",
    send: (t) => sent.push(t),
  });
  assert.deepEqual(sent, ["P1 BRIEF"]);
});

test("a brief for a still-active pane that has no tier (activePaneId null) is still injected", async () => {
  const sent: string[] = [];
  await injectWithGuard({
    requestedId: "p1",
    synthesizeAsync: async () => ({ text: "P1 BRIEF", activePaneId: null, source: "fallback" }), // tier missing → null
    currentActiveIdAfterAwait: "p1",
    send: (t) => sent.push(t),
  });
  assert.deepEqual(sent, ["P1 BRIEF"]); // NOT dropped — compared the requested id, not the null brief id
});
