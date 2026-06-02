// tests/test_resumption_digest.ts
//
// WS-F `odb` — Resumption Digest, TASK 1 (store-layer primitives).
//
// TDD RED-first for the three new store-layer primitives the resumption digest is built on
// (spec docs/superpowers/specs/2026-06-01-wsm-odb-resumption-digest-design.md §5, §6.1):
//
//   1. PendingApprovalStore.detachSession(session) — disconnect = DETACH, not purge. NULL the
//      live handle (sessions[id] === undefined) + clear lastAnnounced, but KEEP record + order
//      + durable row. The survivor then looks exactly like a restart-hydrated orphan, so a fresh
//      live handle can re-attach to it later (forSession(undefined) enumerates orphans).
//   2. renderResumptionLine(record, now) — pure render of the human-facing digest line from
//      EXISTING provenance: `capability → terminalId: "<redacted instruction>"` + `you said:
//      <rationale.trigger>` + `<age> ago`. Redacts secrets; degrades gracefully w/o rationale.
//   3. PendingApproval.lastCallAt?: number — transient in-memory marker (not persisted).
//
// Pure / well-bounded: no PTY, no server, no Gemini. Durable assertions use a temp-file JanusStore
// (the SQLite ledger is the DEFAULT backend as of WS-M) so detach can be shown to KEEP the row.

import { test, describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { JanusStore } from "../src/store/sqliteStore";
import {
  PendingApprovalStore,
  renderResumptionLine,
  decideSweepAction,
  APPROVAL_GRACE_MS,
  type PendingApproval,
} from "../src/pendingApprovals";

const TTL = 5 * 60 * 1000;
const tmpDirs: string[] = [];

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "janus-resumption-"));
  tmpDirs.push(dir);
  return join(dir, "approvals.db");
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function mkRecord(
  id: string,
  terminalId: string,
  instruction: string,
  extra: Partial<PendingApproval> = {},
): PendingApproval {
  return {
    messageId: id,
    instruction,
    kind: "agent_instruction",
    terminalId,
    callId: id,
    timestamp: Date.now(),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// detachSession — the disconnect seam (spec §6.1). In-memory (legacy) path.
// ---------------------------------------------------------------------------
describe("PendingApprovalStore.detachSession (in-memory)", () => {
  it("keeps the record + order, NULLs the live handle, clears lastAnnounced", () => {
    const store = new PendingApprovalStore();
    const s1 = { id: "s1" }, s2 = { id: "s2" };
    store.add(mkRecord("a", "p1", "one"), s1);
    store.add(mkRecord("b", "p2", "two"), s2);
    store.add(mkRecord("c", "p3", "three"), s1);

    store.detachSession(s1);

    // Records + order entries SURVIVE (not deleted like purgeSession).
    assert.strictEqual(store.has("a"), true);
    assert.strictEqual(store.has("c"), true);
    assert.deepStrictEqual(store.all().map((r) => r.messageId), ["a", "b", "c"]);

    // The live handle is NULLed for the detached session's records...
    assert.strictEqual(store.sessionFor("a"), undefined);
    assert.strictEqual(store.sessionFor("c"), undefined);
    // ...but the OTHER session's record is untouched.
    assert.strictEqual(store.sessionFor("b"), s2);

    // lastAnnounced for the dead handle is cleared.
    assert.strictEqual(store.lastAnnouncedFor(s1), null);
    assert.strictEqual(store.lastAnnouncedFor(s2), "b");
  });

  it("turns survivors into fresh-handle orphans: forSession(undefined) enumerates them", () => {
    const store = new PendingApprovalStore();
    const s1 = { id: "s1" };
    store.add(mkRecord("a", "p1", "one"), s1);
    store.add(mkRecord("c", "p3", "three"), s1);

    store.detachSession(s1);

    // forSession(undefined) is the orphan enumeration the reconnect path re-attaches over.
    assert.deepStrictEqual(store.forSession(undefined).map((r) => r.messageId), ["a", "c"]);
    // The old (dead) handle now scopes to nothing.
    assert.deepStrictEqual(store.forSession(s1).map((r) => r.messageId), []);
  });

  it("does NOT mutate purgeSession semantics — detach is a sibling, not a rename", () => {
    const store = new PendingApprovalStore();
    const s1 = {};
    store.add(mkRecord("a", "p1", "x"), s1);
    // purgeSession still HARD-deletes (retained per spec §6.1).
    const purged = store.purgeSession(s1);
    assert.deepStrictEqual(purged, ["a"]);
    assert.strictEqual(store.has("a"), false);
  });
});

// ---------------------------------------------------------------------------
// detachSession — durable path: the SQLite row must SURVIVE detach.
// ---------------------------------------------------------------------------
describe("PendingApprovalStore.detachSession (durable)", () => {
  it("KEEPS the durable row so a fresh store reopen still surfaces the survivor", () => {
    const path = tmpDbPath();
    const handle = { id: "live-ws-1" };

    const store1 = new JanusStore(path); store1.init();
    const s1 = new PendingApprovalStore(store1);
    s1.add(mkRecord("a1", "pane_a", "run the tests"), handle, { workspaceId: "p1", ttlMs: TTL });

    // Disconnect: detach (NOT purge). The durable row MUST remain.
    s1.detachSession(handle);
    assert.strictEqual(s1.has("a1"), true, "in-memory record survives detach");
    assert.strictEqual(s1.sessionFor("a1"), undefined, "live handle is nulled by detach");
    store1.close();

    // Process "restart": a brand-new store over the same file still sees the survivor.
    const store2 = new JanusStore(path); store2.init();
    const s2 = new PendingApprovalStore(store2);
    assert.strictEqual(s2.has("a1"), true, "durable row survived detach + reopen");
    store2.close();
  });
});

// ---------------------------------------------------------------------------
// orphans + reattachSession — the reconnect seam (spec §6.2). In-memory (legacy) path.
// ---------------------------------------------------------------------------
describe("PendingApprovalStore.reattachSession (in-memory)", () => {
  it("orphans() enumerates exactly the detached (handle-less) survivors", () => {
    const store = new PendingApprovalStore();
    const s1 = { id: "s1" }, s2 = { id: "s2" };
    store.add(mkRecord("a", "p1", "one"), s1);
    store.add(mkRecord("b", "p2", "two"), s2);
    // Nothing detached yet -> no orphans.
    assert.deepStrictEqual(store.orphans().map((r) => r.messageId), []);
    store.detachSession(s1);
    // Only s1's record is now an orphan; s2's stays bound.
    assert.deepStrictEqual(store.orphans().map((r) => r.messageId), ["a"]);
  });

  it("re-binds an orphan to the new live handle and clears lastCallAt", () => {
    const store = new PendingApprovalStore();
    const s1 = { id: "s1" };
    store.add(mkRecord("a", "p1", "one"), s1);
    // Simulate a stamped last-call before the disconnect.
    store.get("a")!.lastCallAt = 999;
    store.detachSession(s1);
    assert.strictEqual(store.sessionFor("a"), undefined, "detached -> orphan");

    const s2 = { id: "s2" }; // the fresh reconnect handle
    const NOW = 5_000_000;
    store.reattachSession(store.get("a")!, s2, NOW + TTL);

    assert.strictEqual(store.sessionFor("a"), s2, "re-bound to the new live handle");
    assert.strictEqual(store.get("a")!.lastCallAt, undefined, "lastCallAt cleared on re-attach (fresh window)");
    // After re-attach the item is no longer an orphan; forSession(new handle) sees it.
    assert.deepStrictEqual(store.orphans().map((r) => r.messageId), []);
    assert.deepStrictEqual(store.forSession(s2).map((r) => r.messageId), ["a"]);
  });

  it("is a NO-OP on a record whose handle is already bound (never re-stomp a live record)", () => {
    const store = new PendingApprovalStore();
    const s1 = { id: "s1" };
    store.add(mkRecord("a", "p1", "one"), s1);
    const s2 = { id: "s2" };
    // 'a' is NOT an orphan (still bound to s1) -> reattach must not rebind it to s2.
    store.reattachSession(store.get("a")!, s2, Date.now() + TTL);
    assert.strictEqual(store.sessionFor("a"), s1, "live record left bound to its original handle");
  });
});

// ---------------------------------------------------------------------------
// reattachSession — durable path: rewrites session_id + expires_at, carries claimed through.
// ---------------------------------------------------------------------------
describe("PendingApprovalStore.reattachSession (durable)", () => {
  it("rewrites the durable row's expires_at on re-attach (fresh window) and keeps it addressable", () => {
    const path = tmpDbPath();
    const handle = { id: "live-ws-1" };
    const store1 = new JanusStore(path); store1.init();
    const s1 = new PendingApprovalStore(store1);
    s1.add(mkRecord("a1", "pane_a", "run the tests", { timestamp: 1_000 }), handle, { workspaceId: "p1", ttlMs: TTL });

    // Original durable expires_at = timestamp + TTL.
    const before = store1.getExpiredApprovals(Number.MAX_SAFE_INTEGER).find((r) => r.id === "a1")!;
    assert.strictEqual(before.expires_at, 1_000 + TTL, "original expires_at = timestamp + ttl");

    s1.detachSession(handle);
    const s2handle = { id: "live-ws-2" };
    const FRESH = 9_000_000 + TTL;
    s1.reattachSession(s1.get("a1")!, s2handle, FRESH);

    // The durable row's expires_at is rewritten to the fresh window; the row is still addressable.
    const after = store1.getExpiredApprovals(Number.MAX_SAFE_INTEGER).find((r) => r.id === "a1")!;
    assert.strictEqual(after.expires_at, FRESH, "expires_at rewritten to the fresh window");
    assert.strictEqual(after.id, "a1", "same durable row id (delete/claim still address it)");
    assert.strictEqual(after.workspace_id, "p1", "workspace_id preserved on rewrite");

    // delete still hits the rewritten row (no stale duplicate left under the old session_id).
    s1.delete("a1");
    assert.strictEqual(store1.getExpiredApprovals(Number.MAX_SAFE_INTEGER).find((r) => r.id === "a1"), undefined, "row deleted by id after re-attach");
    store1.close();
  });

  it("carries an existing claimed=true through the re-attach rewrite (N-1 exactly-once guard)", () => {
    const path = tmpDbPath();
    const handle = { id: "live-ws-1" };
    const store1 = new JanusStore(path); store1.init();
    const s1 = new PendingApprovalStore(store1);
    s1.add(mkRecord("a1", "pane_a", "run the tests"), handle, { workspaceId: "p1", ttlMs: TTL });
    // Claim it (durable claimed=1 + in-memory mirror), then detach WITHOUT deleting.
    assert.strictEqual(s1.claim("a1"), true, "first claim wins");
    s1.detachSession(handle);

    const s2handle = { id: "live-ws-2" };
    s1.reattachSession(s1.get("a1")!, s2handle, Date.now() + TTL);

    // A claimed-but-undeleted survivor must NOT become re-claimable after re-attach (no double write).
    assert.strictEqual(s1.claim("a1"), false, "claimed survivor stays claimed across re-attach");
    store1.close();
  });

  it("legacy path (store === null): re-attach re-binds + clears lastCallAt, no durable rewrite, no crash", () => {
    const store = new PendingApprovalStore(); // no JanusStore -> legacy in-memory
    const s1 = { id: "s1" };
    store.add(mkRecord("a", "p1", "one"), s1);
    store.get("a")!.lastCallAt = 42;
    store.detachSession(s1);
    const s2 = { id: "s2" };
    store.reattachSession(store.get("a")!, s2, Date.now() + TTL);
    assert.strictEqual(store.sessionFor("a"), s2, "legacy re-attach still re-binds the handle");
    assert.strictEqual(store.get("a")!.lastCallAt, undefined, "legacy re-attach clears lastCallAt");
  });
});

// ---------------------------------------------------------------------------
// renderResumptionLine — pure render of the digest line (spec §5, §7).
// ---------------------------------------------------------------------------
describe("renderResumptionLine", () => {
  const NOW = 1_000_000_000_000;

  it("composes capability -> terminalId: \"<instruction>\" + you said + age", () => {
    const rec = mkRecord("a", "pane_build", "run the full test suite", {
      capability: "write_to_pane",
      rationale: { trigger: "kick off the tests", summary: "build pane idle" },
      timestamp: NOW - 5 * 60 * 1000, // 5 minutes ago
    });
    const line = renderResumptionLine(rec, NOW);
    assert.ok(line.includes("write_to_pane"), "names the capability");
    assert.ok(line.includes("pane_build"), "names the target pane");
    assert.ok(line.includes("run the full test suite"), "carries the (short) instruction");
    assert.ok(line.includes("kick off the tests"), "echoes the dictation: you said: <trigger>");
    assert.ok(/you said:/i.test(line), "labels the dictation provenance");
    assert.ok(/5 minutes? ago/.test(line), "humanizes the age from timestamp");
  });

  it("REDACTS secrets in the rendered instruction (never leaks credentials)", () => {
    const rec = mkRecord("s", "p1", "deploy with AKIAABCDEFGHIJKLMNOP now", {
      rationale: { trigger: "ship it", summary: "x" },
      timestamp: NOW,
    });
    const line = renderResumptionLine(rec, NOW);
    assert.ok(!line.includes("AKIAABCDEFGHIJKLMNOP"), "raw AWS key must not appear");
    assert.ok(line.includes("[REDACTED"), "redaction marker present");
  });

  it("REDACTS a secret that STRADDLES the 80-char truncation boundary (redact-before-shorten, spec §5)", () => {
    // Regression pin for the redaction-order bug: shortInstruction() truncates to 80 chars, so a
    // credential whose FIRST char sits before 80 but whose 20-char body crosses the cut would, if
    // truncation ran first, be sliced mid-token and dodge the anchored `AKIA[0-9A-Z]{16}\b` regex —
    // leaking a raw key fragment into the spoken digest. Redacting FIRST makes truncation only ever
    // cut the short [REDACTED:…] marker, never key bytes.
    const AKIA = "AKIAABCDEFGHIJKLMNOP"; // 20 chars: AKIA + 16
    // Position the key to straddle the 79/80 cut. It MUST be \b-word-bounded (a space before it),
    // otherwise the leading char glues to "AKIA" and the regex never matches regardless of order —
    // a bad test, not a real leak. Key starts at index 66 (..86), crossing the truncation point.
    const prefix = "deploy now with the aws credential ".padEnd(65, "x") + " ";
    const instruction = `${prefix}${AKIA} then run`;
    assert.strictEqual(instruction.indexOf(AKIA), 66, "key starts at 66 -> body (66..86) straddles the 80-char cut");

    const rec = mkRecord("straddle", "p1", instruction, {
      rationale: { trigger: "ship it", summary: "x" },
      timestamp: NOW,
    });
    const line = renderResumptionLine(rec, NOW);

    // No fragment of the raw key may survive — not the full key, and not the leading bytes the
    // old truncate-first path would have left dangling before the cut (e.g. "AKIAABCDEF").
    assert.ok(!line.includes(AKIA), "full raw AWS key must not appear");
    assert.ok(!/AKIA[0-9A-Z]/.test(line), "no raw AKIA key fragment (even a partial) may survive");
    assert.ok(line.includes("[REDACTED"), "redaction marker present");
  });

  it("degrades gracefully when rationale is MISSING (no 'you said:' clause, no crash)", () => {
    const rec = mkRecord("a", "pane_x", "do the thing", {
      capability: "write_to_pane",
      timestamp: NOW - 60 * 1000, // 1 minute ago
    });
    const line = renderResumptionLine(rec, NOW);
    assert.ok(line.includes("pane_x"), "still names the pane");
    assert.ok(line.includes("do the thing"), "still carries the instruction");
    assert.ok(!/you said:/i.test(line), "no dangling 'you said:' clause without a trigger");
    assert.ok(/1 minute ago/.test(line), "still humanizes the age");
  });

  it("defaults the capability to write_to_pane when the record omits it", () => {
    const rec = mkRecord("a", "pane_y", "type something", { timestamp: NOW });
    const line = renderResumptionLine(rec, NOW);
    assert.ok(line.includes("write_to_pane"), "absent capability falls back to write_to_pane");
  });

  it("formats sub-minute ages as 'just now' (no negative / zero-minute weirdness)", () => {
    const rec = mkRecord("a", "p1", "x", { timestamp: NOW - 10 * 1000 }); // 10s ago
    const line = renderResumptionLine(rec, NOW);
    assert.ok(/just now/.test(line), "sub-minute age reads 'just now'");
  });

  it("formats hour-scale ages in hours", () => {
    const rec = mkRecord("a", "p1", "x", { timestamp: NOW - 2 * 60 * 60 * 1000 }); // 2h ago
    const line = renderResumptionLine(rec, NOW);
    assert.ok(/2 hours? ago/.test(line), "hour-scale age reads in hours");
  });
});

// ---------------------------------------------------------------------------
// lastCallAt — transient marker on the record (spec §5). Pure shape assertion.
// ---------------------------------------------------------------------------
test("PendingApproval accepts a transient lastCallAt marker (in-memory only)", () => {
  const store = new PendingApprovalStore();
  const rec = mkRecord("a", "p1", "x");
  store.add(rec, {});
  const live = store.get("a")!;
  assert.strictEqual(live.lastCallAt, undefined, "lastCallAt starts unset");
  live.lastCallAt = 12345;
  assert.strictEqual(store.get("a")!.lastCallAt, 12345, "lastCallAt is settable on the live record");
});

// ---------------------------------------------------------------------------
// decideSweepAction — the PURE sweep-trigger decision (spec §4.1 / §6.3).
//
// Full transition table for the FORCED clock rule:
//   isConnected=false                                  -> "none"     (CLOCK PAUSED)
//   connected, past-TTL, no lastCallAt, !claimed       -> "lastcall" (speak it, don't reject)
//   connected, lastCallAt set, past-grace, !claimed    -> "reject"   (silence after last-call)
//   connected, lastCallAt set, inside-grace            -> "none"     (still waiting)
//   connected, claimed                                 -> "none"     (mid-resolve; never stomp)
//   connected, within-TTL                              -> "none"     (not yet due)
// No double-reject: a record only rejects once it has BOTH lastCallAt AND grace elapsed; the
// reject leg of the sweep claims+deletes via resolveDecision, so this fn never fires "reject" twice
// for a live record (the record is gone). We pin the claimed short-circuit as the in-fn guard.
// ---------------------------------------------------------------------------
describe("decideSweepAction", () => {
  const NOW = 2_000_000_000_000;
  const GRACE = APPROVAL_GRACE_MS; // 60_000

  // Helper: the minimal shape decideSweepAction reads off a record.
  function rec(extra: { timestamp?: number; claimed?: boolean; lastCallAt?: number } = {}) {
    return { timestamp: NOW - TTL - 1, ...extra }; // default: 1ms past TTL
  }

  // --- (1) Clock paused while disconnected -----------------------------------
  it("PAUSES the clock while disconnected: past-TTL but isConnected=false -> none", () => {
    assert.deepStrictEqual(decideSweepAction(rec(), NOW, TTL, GRACE, false), { action: "none" });
  });

  it("PAUSES even with a stale lastCallAt while disconnected (no reject without a session)", () => {
    // A record that was last-called, then the session dropped: must NOT reject while away.
    const r = rec({ lastCallAt: NOW - GRACE - 5000 });
    assert.deepStrictEqual(decideSweepAction(r, NOW, TTL, GRACE, false), { action: "none" });
  });

  it("PAUSES a long-abandoned item (hours past TTL) while disconnected -> still none", () => {
    const r = rec({ timestamp: NOW - 6 * 60 * 60 * 1000 }); // 6h old
    assert.deepStrictEqual(decideSweepAction(r, NOW, TTL, GRACE, false), { action: "none" });
  });

  // --- (3) First crossing -> last-call (connected) ---------------------------
  it("connected + just past TTL + no lastCallAt -> lastcall (no reject)", () => {
    assert.deepStrictEqual(decideSweepAction(rec(), NOW, TTL, GRACE, true), { action: "lastcall" });
  });

  it("connected + within TTL -> none (not yet due)", () => {
    const r = rec({ timestamp: NOW - TTL + 1000 }); // 1s short of TTL
    assert.deepStrictEqual(decideSweepAction(r, NOW, TTL, GRACE, true), { action: "none" });
  });

  it("connected + exactly AT TTL boundary -> none (strict greater-than, not >=)", () => {
    const r = rec({ timestamp: NOW - TTL }); // now - timestamp === ttlMs, not > ttlMs
    assert.deepStrictEqual(decideSweepAction(r, NOW, TTL, GRACE, true), { action: "none" });
  });

  // --- (4) last-call -> grace -> reject (connected) --------------------------
  it("connected + lastCallAt set + grace elapsed -> reject", () => {
    const r = rec({ lastCallAt: NOW - GRACE - 1 }); // grace + 1ms past the last-call
    assert.deepStrictEqual(decideSweepAction(r, NOW, TTL, GRACE, true), { action: "reject" });
  });

  it("connected + lastCallAt set + still INSIDE grace -> none (don't reject yet)", () => {
    const r = rec({ lastCallAt: NOW - GRACE + 1000 }); // 1s short of grace
    assert.deepStrictEqual(decideSweepAction(r, NOW, TTL, GRACE, true), { action: "none" });
  });

  it("connected + lastCallAt set + exactly AT grace boundary -> none (strict greater-than)", () => {
    const r = rec({ lastCallAt: NOW - GRACE }); // now - lastCallAt === graceMs, not > graceMs
    assert.deepStrictEqual(decideSweepAction(r, NOW, TTL, GRACE, true), { action: "none" });
  });

  it("does NOT re-issue a last-call once lastCallAt is set (lastcall is a one-shot)", () => {
    // Past TTL AND lastCallAt set but inside grace: stays "none", never re-fires "lastcall".
    const r = rec({ timestamp: NOW - 10 * TTL, lastCallAt: NOW - 1000 });
    assert.deepStrictEqual(decideSweepAction(r, NOW, TTL, GRACE, true), { action: "none" });
  });

  // --- (2) claimed short-circuit (never double-reject / never stomp a winner) ---
  it("claimed + past-TTL + no lastCallAt -> none (never last-call a claimed record)", () => {
    const r = rec({ claimed: true });
    assert.deepStrictEqual(decideSweepAction(r, NOW, TTL, GRACE, true), { action: "none" });
  });

  it("claimed + lastCallAt set + grace elapsed -> none (never re-reject a claimed winner)", () => {
    // The N-1 guard: a record an in-flight approve already claimed must NOT be rejected by the sweep.
    const r = rec({ claimed: true, lastCallAt: NOW - GRACE - 5000 });
    assert.deepStrictEqual(decideSweepAction(r, NOW, TTL, GRACE, true), { action: "none" });
  });

  it("claimed short-circuit beats disconnect ordering too (claimed+disconnected -> none)", () => {
    const r = rec({ claimed: true });
    assert.deepStrictEqual(decideSweepAction(r, NOW, TTL, GRACE, false), { action: "none" });
  });

  // --- full two-phase progression on one record (lastcall THEN reject) -------
  it("progresses lastcall -> (set lastCallAt) -> reject over two ticks", () => {
    const r: { timestamp: number; claimed?: boolean; lastCallAt?: number } = { timestamp: NOW - TTL - 1 };
    // Tick 1: first crossing.
    const t1 = decideSweepAction(r, NOW, TTL, GRACE, true);
    assert.deepStrictEqual(t1, { action: "lastcall" }, "tick 1 last-calls");
    // The server would stamp lastCallAt = now on a "lastcall"; simulate that.
    r.lastCallAt = NOW;
    // Tick 2 inside grace: holds.
    assert.deepStrictEqual(decideSweepAction(r, NOW + GRACE - 1, TTL, GRACE, true), { action: "none" }, "holds in grace");
    // Tick 3 past grace: rejects exactly once.
    assert.deepStrictEqual(decideSweepAction(r, NOW + GRACE + 1, TTL, GRACE, true), { action: "reject" }, "rejects after grace");
  });

  it("APPROVAL_GRACE_MS defaults to 60_000 (60 s)", () => {
    assert.strictEqual(APPROVAL_GRACE_MS, 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// Action sweep gate==narration coupling (spec §4.1 / §10 #4) — regression pin for the
// "STAMPED but never SPOKEN, then rejected" hole.
//
// The server's pending-ACTIONS sweep narrates the last-call into `activeLiveSession`, but the
// connectivity GATE used to read a DIFFERENT ref (`activeFrontendWs`). Those refs diverge during
// the Gemini `ai.live.connect()` handshake window: `activeFrontendWs` is set synchronously on WS
// open, while `activeLiveSession` is only assigned AFTER the async connect resolves. A sweep tick
// in that window returned "lastcall" (gate true via frontendWs), stamped the ONE-SHOT `lastCallAt`,
// but SKIPPED narration (no live session) — and since "lastcall" never re-fires once stamped, the
// action would later be rejected having NEVER spoken a last-call, violating spec §4.1/§10 #4.
//
// We can't reach the server closure from here, so we model its exact two-phase action loop over the
// pure `decideSweepAction` and assert the INVARIANT the fix restores: deriving `actionsConnected`
// from the SAME ref that gates narration makes "stamp lastCallAt" and "speak last-call" inseparable —
// so a reject can never follow a silent (un-spoken) last-call.
// ---------------------------------------------------------------------------
describe("action sweep: gate ref must equal narration ref (no stamp-without-speak)", () => {
  const NOW = 3_000_000_000_000;
  const GRACE = APPROVAL_GRACE_MS;

  type Act = { id: string; timestamp: number; claimed?: boolean; lastCallAt?: number };

  /**
   * Faithful reimplementation of the server's pending-ACTIONS sweep leg (server.ts ~1638-1650),
   * parameterized by the live-session ref. `actionsConnected` and the narration channel are BOTH
   * derived from `liveSession` — exactly the fix's gate==narration coupling. Returns the spoken
   * last-calls so a silent stamp is observable.
   */
  function sweepActions(acts: Act[], now: number, liveSession: unknown | null): { spoken: string[]; rejected: string[] } {
    const spoken: string[] = [];
    const rejected: string[] = [];
    const actionsConnected = liveSession !== null; // FIX: gated on the narration ref, not frontendWs.
    for (const act of acts) {
      if (act.claimed) continue;
      if (now - act.timestamp <= TTL) continue; // .expired() filter
      const decision = decideSweepAction(act, now, TTL, GRACE, actionsConnected);
      if (decision.action === "none") continue;
      if (decision.action === "lastcall") {
        act.lastCallAt = now;
        // The narration target is the SAME ref the gate read — so if we got here, it is non-null.
        if (liveSession) spoken.push(act.id);
        continue;
      }
      // reject
      rejected.push(act.id);
    }
    return { spoken, rejected };
  }

  it("handshake window (live session not yet connected): does NOT stamp a silent last-call", () => {
    // frontendWs is open but ai.live.connect() has NOT resolved -> liveSession === null.
    const act: Act = { id: "act1", timestamp: NOW - TTL - 1 }; // just past TTL
    const r = sweepActions([act], NOW, null);
    assert.deepStrictEqual(r.spoken, [], "nothing spoken while the live session is absent");
    assert.strictEqual(act.lastCallAt, undefined, "lastCallAt NOT stamped during the handshake window");
    assert.deepStrictEqual(r.rejected, [], "and certainly no reject");
  });

  it("never reaches reject without first SPEAKING a last-call across the handshake-then-connect arc", () => {
    const act: Act = { id: "act1", timestamp: NOW - TTL - 1 };

    // Tick 1: still inside the handshake window (liveSession null). With the fix, the clock is paused.
    sweepActions([act], NOW, null);
    assert.strictEqual(act.lastCallAt, undefined, "no silent stamp in the handshake window");

    // The live session finally connects. Tick 2 now last-calls AND speaks (same ref).
    const liveSession = { id: "live" };
    const t2 = sweepActions([act], NOW + 1000, liveSession);
    assert.deepStrictEqual(t2.spoken, ["act1"], "the FIRST crossing while connected actually speaks");
    assert.strictEqual(act.lastCallAt, NOW + 1000, "lastCallAt stamped only once narration was possible");
    assert.deepStrictEqual(t2.rejected, [], "no reject on the speaking tick");

    // Tick 3 after grace: NOW reject is allowed — but only because a real last-call was spoken first.
    const t3 = sweepActions([act], NOW + 1000 + GRACE + 1, liveSession);
    assert.deepStrictEqual(t3.rejected, ["act1"], "reject follows the SPOKEN last-call + grace");
  });

  it("counter-example: gating on a ref that is null while narration is impossible can NEVER stamp", () => {
    // Direct invariant: when liveSession is null, actionsConnected is false, so decideSweepAction
    // returns 'none' and lastCallAt is never set — making a later silent reject impossible.
    const act: Act = { id: "act1", timestamp: NOW - 10 * TTL }; // long past TTL
    const decision = decideSweepAction(act, NOW, TTL, GRACE, /*actionsConnected*/ false);
    assert.deepStrictEqual(decision, { action: "none" }, "disconnected (no live session) -> clock paused");
  });
});
