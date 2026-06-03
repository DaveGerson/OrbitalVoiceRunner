// tests/test_pendingActions_durable.ts
//
// WS-F follow-up (scope B) / bead wsm-e2e-pinned-kzt — durable PendingActionStore backed by
// JanusStore (SQLite). Mirrors tests/test_pendingApprovals_durable.ts (nzt).
//
// The point of the task: an Ask-tier deferred ACTION must SURVIVE a process restart / store reopen.
// Unlike a PendingApproval (already serializable), a PendingAction carries a non-serializable run()
// CLOSURE — so we persist the INTENT (capability + JSON params) and the server rebuilds run() on boot
// via src/actionEffects.ts. These tests pin the STORE seam (persist intent + hydrate + durable claim);
// the registry rebuild is pinned in tests/test_actionEffects.ts.
//
// RE-SCOPE (kzt-rescope.md §6 / Risk R2): a dedicated update_metadata amend round-trip pins that the
// #27 amend text survives a reopen and the rebuilt confirm applies THAT text (not the no-op the
// original buildActionRun produced).
//
// TEMP FILE (not ":memory:") so a SECOND JanusStore reopens the SAME db and sees survivors.

import { test, afterEach } from "node:test";
import assert from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { JanusStore } from "../src/store/sqliteStore";
import { PendingActionStore } from "../src/pendingActions";
import { buildActionRun } from "../src/actionEffects";

const TTL = 5 * 60 * 1000;
const tmpDirs: string[] = [];

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "janus-actions-"));
  tmpDirs.push(dir);
  return join(dir, "actions.db");
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ---------------------------------------------------------------------------
// DURABILITY: a staged action's INTENT survives a store reopen (hydrateIntents).
// ---------------------------------------------------------------------------
test("durable: a staged action's INTENT survives a store reopen (hydrateIntents)", () => {
  const path = tmpDbPath();
  const store1 = new JanusStore(path); store1.init();
  const s1 = new PendingActionStore(store1);
  s1.add({
    id: "act1", capability: "create_pane", summary: "Create pane build-1",
    params: { paneId: "build-1", command: "bash", projectId: "p1" },
    timestamp: Date.now(), ttlMs: TTL, run: () => "ran",
  });
  store1.close();

  // "restart": fresh store + fresh PendingActionStore over the SAME file.
  const store2 = new JanusStore(path); store2.init();
  const s2 = new PendingActionStore(store2);
  const intents = s2.hydrateIntents();
  assert.deepStrictEqual(intents.map((i) => i.id), ["act1"], "survivor intent must reopen");
  assert.strictEqual(JSON.parse(intents[0].params).paneId, "build-1");
  store2.close();
});

// ---------------------------------------------------------------------------
// END-TO-END: stage -> reopen -> REBUILD -> confirm runs the rebuilt effect exactly once.
// Models the server boot loop using buildActionRun directly (server can't be imported).
// ---------------------------------------------------------------------------
test("durable e2e: stage -> reopen -> rebuild -> confirm runs the effect exactly once", () => {
  const path = tmpDbPath();
  const store1 = new JanusStore(path); store1.init();
  const s1 = new PendingActionStore(store1);
  s1.add({
    id: "act1", capability: "create_pane", summary: "Create pane build-1",
    // origin:"voice" rides through the durable round-trip so we can pin the EXACT rebuilt confirm
    // string below (the drift guard at the durable seam, not just in the pure registry test).
    params: { origin: "voice", paneId: "build-1", command: "bash", projectId: "p1" }, timestamp: Date.now(), ttlMs: TTL,
    run: () => { throw new Error("original run must NOT be used after restart"); },
  });
  store1.close();

  // Restart: rebuild survivors exactly as server.ts boot loop does.
  const store2 = new JanusStore(path); store2.init();
  const s2 = new PendingActionStore(store2);
  const calls: any[] = [];
  const deps = {
    manager: {
      ledger: { getProject: () => null, addProject() {}, addPaneNote() {} },
      addTerminal: (...a: any[]) => { calls.push(a); return "OK"; },
    },
    broadcast: () => {},
    broadcastLedgerUpdate: () => {},
    sanitizeSettingsForClient: (s: any) => s,
  };
  for (const row of s2.hydrateIntents()) {
    const params = JSON.parse(row.params);
    s2.add({
      id: row.id, capability: row.capability, summary: row.summary, params, timestamp: row.timestamp,
      run: buildActionRun({ capability: row.capability, params }, deps as any), ttlMs: TTL,
    });
  }
  // Confirm the rebuilt action: the REBUILT run fires (not the dead original), exactly once.
  const r = s2.confirm("act1");
  assert.strictEqual(r.reason, "confirmed");
  // The rebuilt confirm output survives the restart byte-identical to the in-process voice string.
  assert.strictEqual(r.output, "Pane build-1 created under project p1. Result: OK");
  assert.strictEqual(calls.length, 1, "rebuilt addTerminal ran exactly once");
  assert.strictEqual(s2.has("act1"), false);
  // A fresh reopen sees the durable row gone (confirm deleted it durably).
  store2.close();
  const store3 = new JanusStore(path); store3.init();
  assert.strictEqual(new PendingActionStore(store3).hydrateIntents().length, 0);
  store3.close();
});

// ---------------------------------------------------------------------------
// RE-SCOPE R2 GUARD: update_metadata amend survives a reopen and applies the ENQUEUE-BOUND text.
// This is the regression the original buildActionRun caused (no update_metadata case -> no-op).
// ---------------------------------------------------------------------------
test("durable e2e: update_metadata amend rebuilds + applies the bound text across a reopen", () => {
  const path = tmpDbPath();
  const store1 = new JanusStore(path); store1.init();
  const s1 = new PendingActionStore(store1);
  s1.add({
    id: "act-amend", capability: "update_metadata", summary: "Amend note n1",
    params: { op: "amend", noteId: "n1", text: "BOUND AT ENQUEUE" }, timestamp: Date.now(), ttlMs: TTL,
    run: () => { throw new Error("original run must NOT be used after restart"); },
  });
  store1.close();

  const store2 = new JanusStore(path); store2.init();
  const s2 = new PendingActionStore(store2);
  const amended: any[] = [];
  const deps = {
    manager: { ledger: { amendNote: (id: string, text: string) => amended.push([id, text]), deleteNote() {} } },
    broadcast: () => {},
    broadcastLedgerUpdate: () => {},
    sanitizeSettingsForClient: (s: any) => s,
  };
  for (const row of s2.hydrateIntents()) {
    const params = JSON.parse(row.params);
    s2.add({
      id: row.id, capability: row.capability, summary: row.summary, params, timestamp: row.timestamp,
      run: buildActionRun({ capability: row.capability, params }, deps as any), ttlMs: TTL,
    });
  }
  const r = s2.confirm("act-amend");
  assert.strictEqual(r.reason, "confirmed");
  // The amend applies the text bound at ENQUEUE, surviving the reopen — NOT the no-op string.
  assert.deepStrictEqual(amended, [["n1", "BOUND AT ENQUEUE"]], "rebuilt amend applies the bound text");
  assert.strictEqual(r.output, "Note n1 updated.");
  store2.close();
});

// ---------------------------------------------------------------------------
// CLAIM survives reopen: a claimed-but-undeleted row is NOT re-hydrated (no double-run).
// ---------------------------------------------------------------------------
test("durable: a claimed-but-undeleted action row stays claimed across reopen (no double-run)", () => {
  const path = tmpDbPath();
  const store1 = new JanusStore(path); store1.init();
  new PendingActionStore(store1).add({
    id: "act1", capability: "create_pane", summary: "x",
    params: { paneId: "x", command: "bash" }, timestamp: Date.now(), ttlMs: TTL, run: () => "ran",
  });
  assert.strictEqual(store1.claimAction("act1"), true);   // claimed, not deleted (crash sim)
  store1.close();

  const store2 = new JanusStore(path); store2.init();
  const s2 = new PendingActionStore(store2);
  assert.deepStrictEqual(s2.hydrateIntents().map((i) => i.id), [], "claimed survivor is NOT re-hydrated (getPendingActions filters claimed=0)");
  store2.close();
});

// ---------------------------------------------------------------------------
// CANCEL is durable: a cancelled action's row does not survive reopen (claim+delete fired).
// ---------------------------------------------------------------------------
test("durable: cancel flips the durable claim + deletes the row (no re-replay after reopen)", () => {
  const path = tmpDbPath();
  const store1 = new JanusStore(path); store1.init();
  const s1 = new PendingActionStore(store1);
  s1.add({
    id: "act1", capability: "create_pane", summary: "x",
    params: { paneId: "x", command: "bash" }, timestamp: Date.now(), ttlMs: TTL, run: () => "ran",
  });
  const r = s1.cancel("act1");
  assert.strictEqual(r.reason, "cancelled");
  store1.close();

  const store2 = new JanusStore(path); store2.init();
  const s2 = new PendingActionStore(store2);
  assert.deepStrictEqual(s2.hydrateIntents().map((i) => i.id), [], "cancelled action must not survive reopen");
  store2.close();
});

// ---------------------------------------------------------------------------
// LEGACY byte-for-byte: new PendingActionStore() / (null) is pure in-memory (no store needed).
// ---------------------------------------------------------------------------
test("legacy: store=null behaves exactly as the in-memory store (no durability, no throw)", () => {
  for (const s of [new PendingActionStore(null), new PendingActionStore()]) {
    let ran = 0;
    s.add({ id: "a", capability: "create_pane", summary: "x", timestamp: Date.now(), run: () => { ran++; return "ran"; } });
    assert.strictEqual(s.has("a"), true);
    assert.deepStrictEqual(s.hydrateIntents(), [], "no store -> no persisted intents");
    const r = s.confirm("a");
    assert.strictEqual(r.reason, "confirmed");
    assert.strictEqual(ran, 1);
    assert.strictEqual(s.has("a"), false);
  }
});
