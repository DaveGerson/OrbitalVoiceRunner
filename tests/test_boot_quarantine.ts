// tests/test_boot_quarantine.ts
//
// p85 — INTEGRATION test for the PLM3 boot-loop QUARANTINE branch (reviewDurable follow-up).
//
// The pure guard (checkActionVersion, src/actionEffects.ts) is unit-pinned in
// tests/test_actionEffects.ts. The DURABLE round-trip (stage -> reopen -> rebuild -> confirm) is
// pinned in tests/test_pendingActions_durable.ts. But the server.ts boot rehydrate loop that actually
// CALLS the guard per survivor — and on a guard MISS records a "QUARANTINED ... (reason)"
// permission_changed activity and `continue`s (never rebuilding the closure) — was only exercised
// INDIRECTLY. This suite pins THAT WIRING end to end by booting the real server against a pre-seeded
// durable store and asserting the two branches the loop takes.
//
// WHAT WE PROVE (server.ts boot rehydrate loop ~1670-1709):
//   (a) a correctly-stamped create_pane intent ({ actionName:"create_pane",
//       schemaHash: actionSchemaHash("create_pane"), ... }) -> guard ok -> REHYDRATED branch
//       (buildActionRun + pendingActions.add re-stages it; a "REHYDRATED deferred create_pane"
//        permission_changed activity is recorded).
//   (b) a legacy UNSTAMPED create_pane row (no actionName/schemaHash) -> guard miss
//       (reason "unknown_action") -> QUARANTINE branch: NOT re-staged; a
//       "QUARANTINED deferred create_pane (unknown_action)" permission_changed activity is recorded,
//       and the loop `continue`s.
//
// HOW WE OBSERVE THE BRANCH TAKEN
// -------------------------------
// server.ts does NOT expose a `_testPendingActions` seam (it exposes only `_testPendingApprovals` /
// `_testActiveLiveSession` / `_testClients`), and BOTH rows remain physically present in the
// pending_actions table after boot (re-staging is an INSERT-OR-REPLACE no-op rewrite, and a
// quarantined row is left for a "future boot-prune sweep" — neither row is deleted). So a raw
// getPendingActions() count cannot discriminate re-staged from quarantined. The AUTHORITATIVE,
// branch-specific observable is the ACTIVITY EVENT the loop emits in each arm:
//   - rehydrated arm  -> events row: type=permission_changed, payload.action="rehydrated"
//   - quarantine arm  -> events row: type=permission_changed, payload.action="quarantined",
//                                    payload.reason="unknown_action"
// These are recorded via store.recordActivity inside the loop and are exactly the wiring under test,
// so asserting them is a faithful proof that (a) took the rehydrate arm and (b) took the quarantine
// arm. We read them back through a SECOND JanusStore reader reopened on the same db file after boot
// (WAL: the boot transactions are committed synchronously, so a fresh reader connection sees them) —
// the same "reopen the same file" pattern tests/test_pendingActions_durable.ts uses. We additionally
// assert that the quarantined row id NEVER appears in any rehydrated event (it was not re-staged).
//
// We boot with listen:false (no port bind, no WS client needed — the rehydrate loop runs before the
// optional server.listen()), and tear down via teardownServerSuite + our own reader-store close to
// stay clean under --test-force-exit (no libuv double-close).

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { JanusStore } from "../src/store/sqliteStore";
import { actionSchemaHash } from "../src/actions/registry";
import type { StoredEvent } from "../src/store/eventTypes";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

const TTL = 5 * 60 * 1000;
const STAMPED_ID = "act-stamped-create-pane";
const LEGACY_ID = "act-legacy-unstamped";

describe("p85 — boot rehydrate loop QUARANTINEs a drifted/legacy intent and re-stages a valid one", () => {
  let tmpDir: string;
  let dbPath: string;
  let running: RunningServer;
  let reader: JanusStore | null = null;

  // Env we mutate to point the server's module-level store at our seeded file; restored in after().
  const prevEnv: Record<string, string | undefined> = {};
  function setEnv(k: string, v: string | undefined) {
    prevEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "janus-boot-quarantine-"));
    dbPath = join(tmpDir, "boot.db");
    const now = Date.now();

    // ── SEED the durable store BEFORE boot, with TWO pending_actions rows. ──────────────────────
    // We write rows directly via insertPendingAction (the same path PendingActionStore.add() uses)
    // so we control the params JSON byte-for-byte — including, for (b), the ABSENCE of the version
    // stamp (a legacy pre-PLM3 row).
    const seed = new JanusStore(dbPath);
    seed.init();

    // (a) correctly-stamped create_pane intent: actionName + the CURRENT schemaHash for "create_pane".
    // The guard re-derives actionSchemaHash("create_pane") and matches -> ok -> rehydrate arm.
    seed.insertPendingAction({
      id: STAMPED_ID,
      capability: "create_pane",
      summary: "Create pane build-stamped",
      params: JSON.stringify({
        actionName: "create_pane",
        schemaHash: actionSchemaHash("create_pane"),
        origin: "voice",
        paneId: "build-stamped",
        cwd: tmpDir,
        command: "bash",
        projectId: "p-stamped",
      }),
      claimed: false,
      timestamp: now,
      expires_at: now + TTL,
    });

    // (b) legacy UNSTAMPED create_pane row: NO actionName / NO schemaHash. The guard sees no stamped
    // name -> actionSchemaHash(undefined) path -> current=null -> reason "unknown_action" -> QUARANTINE.
    seed.insertPendingAction({
      id: LEGACY_ID,
      capability: "create_pane",
      summary: "Create pane build-legacy",
      params: JSON.stringify({
        origin: "voice",
        paneId: "build-legacy",
        cwd: tmpDir,
        command: "bash",
        projectId: "p-legacy",
      }),
      claimed: false,
      timestamp: now + 1, // distinct ts so ORDER BY timestamp ASC is deterministic (a before b)
      expires_at: now + TTL,
    });
    seed.close();

    // ── Boot the REAL server against the seeded file. ───────────────────────────────────────────
    // JANUS_DB -> our seeded db (the module-level `store` opens this at import).
    // JANUS_LEDGER_BACKEND unset -> SQLite ledger is the DEFAULT (the loop's `if (store)` audit fires).
    // JANUS_NO_AUTOSTART=1 -> the module tail must NOT auto-start a second server on import.
    setEnv("JANUS_DB", dbPath);
    setEnv("JANUS_LEDGER_BACKEND", undefined);
    setEnv("JANUS_NO_AUTOSTART", "1");
    setEnv("NODE_ENV", "test");

    const serverMod = await import("../server");
    // listen:false — the rehydrate loop runs inside startServer() before any optional listen(); we
    // never need a bound port or a WS client for this proof.
    running = await serverMod.startServer({ port: 0, enableVite: false, listen: false });

    // Reopen a SECOND reader connection on the same file to read back the committed boot events.
    reader = new JanusStore(dbPath);
    reader.init();
  });

  after(async () => {
    try { reader?.close(); } catch { /* best-effort; distinct connection from the server singleton */ }
    await teardownServerSuite(running);
    // Restore env.
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function permissionEvents(): StoredEvent[] {
    return reader!.getEvents({ type: "permission_changed" });
  }

  it("(b) the legacy UNSTAMPED row is QUARANTINED with reason 'unknown_action' (the guard miss arm)", () => {
    const quarantined = permissionEvents().filter(
      (e) => e.payload?.action === "quarantined" && e.payload?.action_id === LEGACY_ID,
    );
    assert.strictEqual(
      quarantined.length, 1,
      "exactly one QUARANTINED permission_changed event for the legacy row",
    );
    const ev = quarantined[0];
    assert.strictEqual(ev.payload.reason, "unknown_action", "guard miss reason is unknown_action (no stamp)");
    assert.strictEqual(ev.payload.capability, "create_pane", "the quarantined intent's capability is carried");
    assert.match(
      ev.summary,
      /^QUARANTINED deferred create_pane \(unknown_action\):/,
      `quarantine summary follows the loop's literal format: ${ev.summary}`,
    );
  });

  it("(a) the correctly-stamped row is RE-STAGED (REHYDRATED arm), not quarantined", () => {
    const evts = permissionEvents();

    const rehydrated = evts.filter(
      (e) => e.payload?.action === "rehydrated" && e.payload?.action_id === STAMPED_ID,
    );
    assert.strictEqual(
      rehydrated.length, 1,
      "exactly one REHYDRATED permission_changed event for the stamped row",
    );
    assert.strictEqual(rehydrated[0].payload.capability, "create_pane");
    assert.match(
      rehydrated[0].summary,
      /^REHYDRATED deferred create_pane:/,
      `rehydrate summary follows the loop's literal format: ${rehydrated[0].summary}`,
    );

    // The stamped row must NOT have been quarantined (it took the OTHER arm).
    const stampedQuarantined = evts.filter(
      (e) => e.payload?.action === "quarantined" && e.payload?.action_id === STAMPED_ID,
    );
    assert.strictEqual(stampedQuarantined.length, 0, "the valid stamped row was NOT quarantined");
  });

  it("the QUARANTINE arm `continue`s — the legacy row is NEVER rehydrated/re-staged", () => {
    const legacyRehydrated = permissionEvents().filter(
      (e) => e.payload?.action === "rehydrated" && e.payload?.action_id === LEGACY_ID,
    );
    assert.strictEqual(
      legacyRehydrated.length, 0,
      "the quarantined legacy row never emitted a REHYDRATED event (loop continued past re-staging)",
    );
  });

  it("the two arms are mutually exclusive across exactly the two seeded rows", () => {
    const evts = permissionEvents();
    const rehydratedIds = new Set(
      evts.filter((e) => e.payload?.action === "rehydrated").map((e) => e.payload?.action_id),
    );
    const quarantinedIds = new Set(
      evts.filter((e) => e.payload?.action === "quarantined").map((e) => e.payload?.action_id),
    );
    assert.ok(rehydratedIds.has(STAMPED_ID), "stamped row in the rehydrated set");
    assert.ok(quarantinedIds.has(LEGACY_ID), "legacy row in the quarantined set");
    // No overlap: a row took exactly one arm.
    assert.ok(!rehydratedIds.has(LEGACY_ID), "legacy row not in the rehydrated set");
    assert.ok(!quarantinedIds.has(STAMPED_ID), "stamped row not in the quarantined set");
  });
});
