import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryService, briefIsForActivePane } from "../src/memory";
import { DEFAULT_MEMORY_CONFIG, type MemoryTiers } from "../src/memory/types";
import type { PythonSynthClient, SynthesizeResult } from "../src/memory/pythonClient";

const FRAME = { role: "Janus", gatePosture: "Auto", prefs: [] };
const TIERS: MemoryTiers = {
  project: { projectId: "x", name: "Janus", summary: "Voice orchestrator.", keyTerms: [], recentDecisions: [] },
  pane: { paneId: "p1", name: "build", runtimeType: "claude", status: "Running", lastCommand: "go", recent: [] },
  board: [], frame: FRAME, breadcrumbs: [],
};
// A minimal WorldModel stand-in: getTiers ignores args and returns TIERS.
const wm: any = { getTiers: () => TIERS };

function clientReturning(r: SynthesizeResult | Promise<SynthesizeResult>, avail = true): PythonSynthClient {
  return {
    available: () => avail,
    synthesizerState: () => (avail ? "python" : "fallback"),
    request: () => Promise.resolve(r),
    dispose: () => {},
  };
}

test("no client → fallback", async () => {
  const svc = new MemoryService(wm, DEFAULT_MEMORY_CONFIG);
  const b = await svc.synthesizeAsync("p1", 0);
  assert.equal(b.source, "fallback");
  assert.ok(b.text.includes("PROJECT Janus"));
});

test("unavailable client → fallback (request never called)", async () => {
  let called = false;
  const client: PythonSynthClient = {
    available: () => false, synthesizerState: () => "fallback",
    request: () => { called = true; return Promise.resolve({ ok: false }); }, dispose: () => {},
  };
  const svc = new MemoryService(wm, DEFAULT_MEMORY_CONFIG, client, 50);
  const b = await svc.synthesizeAsync("p1", 0);
  assert.equal(b.source, "fallback");
  assert.equal(called, false);
});

test("client ok → source python", async () => {
  const client = clientReturning({ ok: true, brief: { text: "PY BRIEF", perTierChars: { project: 8 }, activePaneId: "p1" } });
  const svc = new MemoryService(wm, DEFAULT_MEMORY_CONFIG, client, 50);
  const b = await svc.synthesizeAsync("p1", 0);
  assert.equal(b.source, "python");
  assert.equal(b.text, "PY BRIEF");
});

test("client ok:false → fallback", async () => {
  const svc = new MemoryService(wm, DEFAULT_MEMORY_CONFIG, clientReturning({ ok: false }), 50);
  const b = await svc.synthesizeAsync("p1", 0);
  assert.equal(b.source, "fallback");
});

test("client slower than the timeout → fallback", async () => {
  const slow = clientReturning(new Promise<SynthesizeResult>((res) => setTimeout(() => res({ ok: true, brief: { text: "LATE", perTierChars: {}, activePaneId: "p1" } }), 200)));
  const svc = new MemoryService(wm, DEFAULT_MEMORY_CONFIG, slow, 20);
  const b = await svc.synthesizeAsync("p1", 0);
  assert.equal(b.source, "fallback"); // 20ms race beat the 200ms client
});

test("briefIsForActivePane: latest-wins predicate", () => {
  assert.equal(briefIsForActivePane("p1", "p1"), true);
  assert.equal(briefIsForActivePane("p1", "p2"), false);
  assert.equal(briefIsForActivePane(null, null), true);
  assert.equal(briefIsForActivePane("p1", null), false);
  assert.equal(briefIsForActivePane(null, "p1"), false);
});
