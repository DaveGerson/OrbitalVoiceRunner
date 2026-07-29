// CARD 4D.1 (Phase 4 Track D) — the "While you were away" digest.
//
// AUDIT FINDING: the resumption digest (gating.reannounceSurvivors) covered ONLY surviving
// approvals + pending actions. Panes that finished/errored/exited, freezes engaged/released —
// anything that happened while NO live session existed — was never mentioned: the operator
// returned to silence about everything that happened.
//
// FIX under test (src/gating/index.ts):
//   - gating.noteSessionDetached() stamps the last live-session detach time (in-memory, mirrored
//     to the store KV "gating.lastDetachAt" so the away window survives a process restart).
//   - on reconnect, reannounceSurvivors(session) — AFTER the survivors digest — reads the durable
//     activity window via the EXISTING store.getEvents (no ts filter exists, so events are
//     filtered by ts in JS) and narrates ONE compact, most-severe-first summary:
//       "While you were away: pane b reported an error; pane c exited; stop-all was engaged and
//        released; pane a finished."
//     Dedupe per pane (a pane counts once, in its most severe bucket); empty window => SILENT;
//     store === null (legacy) => SILENT, never a throw. The window is CONSUMED on reconnect.
//   - production writer: createGating subscribes to announcementBus.onEnqueue and records the
//     completion/error/build-failed/exited edges as durable "status_transition" events
//     (payload.transition = kind) — these are the rows the digest replays.
//
// Runner: npx tsx --test --test-force-exit tests/test_away_digest.ts

import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { createGating, type GatingDeps } from "../src/gating";
import { AnnouncementBus } from "../src/announcementBus";
import { JanusStore } from "../src/store/sqliteStore";

const stores: JanusStore[] = [];
const buses: AnnouncementBus[] = [];
afterEach(() => {
  while (buses.length) { try { buses.pop()!.stop(); } catch { /* best-effort */ } }
  while (stores.length) { try { stores.pop()!.close(); } catch { /* best-effort */ } }
});

function mkStore(): JanusStore {
  const s = new JanusStore(":memory:"); s.init(); stores.push(s);
  return s;
}

function mkBus(): AnnouncementBus {
  const bus = new AnnouncementBus({ broadcast: () => {} });
  buses.push(bus);
  return bus;
}

function makeDeps(store: JanusStore | null, narrations: string[], bus?: AnnouncementBus): GatingDeps {
  const manager: any = {
    globalPermissionsMode: "Inherit",
    terminals: {},
    settings: { advanced: { capabilityGates: {} } },
    ledger: {
      activeProjectId: "default_project",
      getActiveProject: () => undefined,
      plans: [],
      watchRules: [],
      save: () => {},
    },
  };
  const coreState: any = {
    activeFrontendWs: null,
    activeLiveSession: null,
    clients: new Set(),
    activePaneId: null,
    frozen: false,
    lastStopAllFailed: [],
    setFrozen: () => {},
  };
  return {
    manager,
    store,
    broadcast: () => {},
    broadcastLedgerUpdate: () => {},
    broadcastDraft: () => {},
    coreState,
    announcementBus: (bus ?? { enqueue: () => true, stop: () => {} }) as any,
    pushApprovalNarration: (_s: any, text: string) => { narrations.push(text); return true; },
    sanitizeSettingsForClient: (s: any) => s,
    addCommand: () => {},
  };
}

/** Seed a pane-lifecycle event the digest consumes (the shape the production writer records). */
function seedTransition(store: JanusStore, paneId: string, transition: string, ts: number) {
  store.appendEvent({
    type: "status_transition",
    project_id: "default_project",
    pane_id: paneId,
    summary: `pane ${paneId} ${transition}`,
    payload: { transition },
    ts,
  });
}

describe("4D.1 — 'While you were away' digest on reconnect", () => {
  it("summarizes finished/error/exited panes + freeze engage/release recorded between detach and reconnect", () => {
    const store = mkStore();
    const narrations: string[] = [];
    const gating = createGating(makeDeps(store, narrations));

    const now = Date.now();
    const detachAt = now - 60_000;
    gating.noteSessionDetached(detachAt);

    seedTransition(store, "pane_a", "completion", detachAt + 1_000);
    seedTransition(store, "pane_b", "error", detachAt + 2_000);
    seedTransition(store, "pane_c", "exited", detachAt + 3_000);
    store.appendEvent({
      type: "permission_changed", project_id: "default_project", pane_id: null,
      summary: "STOP_ALL Stage 1", payload: { action: "stop_all_freeze" }, ts: detachAt + 4_000,
    });
    store.appendEvent({
      type: "permission_changed", project_id: "default_project", pane_id: null,
      summary: "STOP_ALL released", payload: { action: "stop_all_release" }, ts: detachAt + 5_000,
    });

    gating.reannounceSurvivors({ sendClientContent: () => {} });

    const away = narrations.find((t) => /while you were away/i.test(t));
    assert.ok(away, `expected an away digest, got: ${JSON.stringify(narrations)}`);
    assert.match(away!, /pane_b/, "names the errored pane");
    assert.match(away!, /error/i, "mentions the error");
    assert.match(away!, /exited/i, "mentions the exit");
    assert.match(away!, /stop-all was engaged and released/i, "mentions the freeze + release");
    assert.match(away!, /finished/i, "mentions the completion");
    // Most-severe-first: the error clause precedes the finished clause.
    assert.ok(away!.search(/error/i) < away!.search(/finished/i), "errors lead the digest");
  });

  it("the away digest comes AFTER the survivors digest", () => {
    const store = mkStore();
    const narrations: string[] = [];
    const gating = createGating(makeDeps(store, narrations));
    const s1 = { id: "old" };
    gating.pendingApprovals.add(
      { messageId: "a1", instruction: "run tests", kind: "agent_instruction", terminalId: "p1", callId: "a1", timestamp: Date.now() - 30_000 } as any,
      s1,
    );
    gating.pendingApprovals.detachSession(s1);
    const detachAt = Date.now() - 30_000;
    gating.noteSessionDetached(detachAt);
    seedTransition(store, "pane_x", "error", detachAt + 1_000);

    gating.reannounceSurvivors({ id: "fresh", sendClientContent: () => {} });

    const welcomeIdx = narrations.findIndex((t) => /welcome back/i.test(t));
    const awayIdx = narrations.findIndex((t) => /while you were away/i.test(t));
    assert.ok(welcomeIdx >= 0, "survivors digest spoken");
    assert.ok(awayIdx >= 0, "away digest spoken");
    assert.ok(awayIdx > welcomeIdx, "away digest follows the survivors digest");
  });

  it("dedupes per pane: one pane erroring twice and finishing counts ONCE, in the error bucket", () => {
    const store = mkStore();
    const narrations: string[] = [];
    const gating = createGating(makeDeps(store, narrations));
    const detachAt = Date.now() - 60_000;
    gating.noteSessionDetached(detachAt);
    seedTransition(store, "pane_a", "error", detachAt + 1_000);
    seedTransition(store, "pane_a", "error", detachAt + 2_000);
    seedTransition(store, "pane_a", "completion", detachAt + 3_000);

    gating.reannounceSurvivors({ sendClientContent: () => {} });

    const away = narrations.find((t) => /while you were away/i.test(t));
    assert.ok(away, "digest spoken");
    assert.match(away!, /pane_a/);
    assert.match(away!, /error/i, "pane lands in its most severe bucket");
    assert.doesNotMatch(away!, /finished/i, "the same pane is not double-counted as finished");
  });

  it("empty window -> NO away digest (and zero survivors stays fully silent)", () => {
    const store = mkStore();
    const narrations: string[] = [];
    const gating = createGating(makeDeps(store, narrations));
    gating.noteSessionDetached(Date.now() - 60_000);
    // Events OUTSIDE the window (before detach) must not count.
    seedTransition(store, "pane_old", "error", Date.now() - 120_000);

    gating.reannounceSurvivors({ sendClientContent: () => {} });
    assert.deepStrictEqual(narrations, [], "nothing notable happened in the window -> silent");
  });

  it("legacy store === null: no throw, no away digest", () => {
    const narrations: string[] = [];
    const gating = createGating(makeDeps(null, narrations));
    gating.noteSessionDetached(Date.now() - 60_000);
    assert.doesNotThrow(() => gating.reannounceSurvivors({ sendClientContent: () => {} }));
    assert.deepStrictEqual(narrations, []);
  });

  it("the window is CONSUMED: a second reconnect without a new detach repeats nothing", () => {
    const store = mkStore();
    const narrations: string[] = [];
    const gating = createGating(makeDeps(store, narrations));
    const detachAt = Date.now() - 60_000;
    gating.noteSessionDetached(detachAt);
    seedTransition(store, "pane_a", "error", detachAt + 1_000);

    gating.reannounceSurvivors({ sendClientContent: () => {} });
    assert.strictEqual(narrations.filter((t) => /while you were away/i.test(t)).length, 1);

    gating.reannounceSurvivors({ sendClientContent: () => {} });
    assert.strictEqual(
      narrations.filter((t) => /while you were away/i.test(t)).length, 1,
      "no repeat digest on the next reconnect",
    );
  });

  it("the detach stamp PERSISTS via the store KV (a restart still digests the away window)", () => {
    const store = mkStore();
    const detachAt = Date.now() - 60_000;
    {
      const gating1 = createGating(makeDeps(store, []));
      gating1.noteSessionDetached(detachAt);
    }
    seedTransition(store, "pane_a", "exited", detachAt + 1_000);

    // "Restart": a fresh gating core over the SAME store hydrates the detach stamp from KV.
    const narrations: string[] = [];
    const gating2 = createGating(makeDeps(store, narrations));
    gating2.reannounceSurvivors({ sendClientContent: () => {} });

    const away = narrations.find((t) => /while you were away/i.test(t));
    assert.ok(away, "away digest survives a process restart");
    assert.match(away!, /exited/i);
  });

  it("production writer: announcementBus.enqueue records a durable status_transition row", () => {
    const store = mkStore();
    const bus = mkBus();
    createGating(makeDeps(store, [], bus));

    bus.enqueue({ kind: "error", terminalId: "pane_w", summary: "boom" });
    bus.enqueue({ kind: "completion", terminalId: "pane_w2", summary: "done" });
    bus.enqueue({ kind: "approval_pending", terminalId: "pane_w3", summary: "not a lifecycle edge" });

    const rows = store.getEvents({ type: "status_transition" });
    const transitions = rows.map((r) => `${r.pane_id}:${r.payload?.transition}`);
    assert.ok(transitions.includes("pane_w:error"), "error edge recorded");
    assert.ok(transitions.includes("pane_w2:completion"), "completion edge recorded");
    assert.ok(!transitions.some((t) => t.startsWith("pane_w3:")), "approval kinds are NOT lifecycle rows");
  });

  it("end-to-end: an edge announced while away surfaces in the reconnect digest", () => {
    const store = mkStore();
    const bus = mkBus();
    const narrations: string[] = [];
    const gating = createGating(makeDeps(store, narrations, bus));

    // turn-arbiter program, Wave 3 (yg1w): the gap must clear RECONNECT_QUIET_MS (30s) so this
    // reconnect is a GENUINE absence, not a silent blip — this test is about digest CONTENT, which
    // tests/test_reconnect_quiet_threshold.ts covers separately.
    gating.noteSessionDetached(Date.now() - 31_000);
    bus.enqueue({ kind: "exited", terminalId: "pane_dead", summary: "code 1" });

    gating.reannounceSurvivors({ sendClientContent: () => {} });
    const away = narrations.find((t) => /while you were away/i.test(t));
    assert.ok(away, "the announced edge reached the digest");
    assert.match(away!, /pane_dead/);
    assert.match(away!, /exited/i);
  });

  // WS1 regression (adversarial-review fix): before the outcome-keyed kind split, a failed run's
  // idle edge arrived here as plain "completion" and WAS recorded. The new "completion_failed"
  // kind must not fall out of the away record (silent drop — forbidden), and it must replay in the
  // ERRORS bucket, never as a plain "finished" (the finished-bucket /completion/ regex would
  // otherwise swallow it).
  it("WS1: a completion_failed edge is recorded while away and replays as an error, not a plain finish", () => {
    const store = mkStore();
    const bus = mkBus();
    const narrations: string[] = [];
    const gating = createGating(makeDeps(store, narrations, bus));

    // turn-arbiter program, Wave 3 (yg1w): keep the gap >= RECONNECT_QUIET_MS so this reconnect is
    // a genuine absence (see the note on the sibling test above).
    gating.noteSessionDetached(Date.now() - 31_000);
    bus.enqueue({ kind: "completion_failed", terminalId: "pane_ff", summary: "3 failing" });

    const rows = store.getEvents({ type: "status_transition" });
    assert.ok(
      rows.some((r) => r.pane_id === "pane_ff" && r.payload?.transition === "completion_failed"),
      "the completion_failed lifecycle edge must be durably recorded (told-more beats silently-missed)",
    );

    gating.reannounceSurvivors({ sendClientContent: () => {} });
    const away = narrations.find((t) => /while you were away/i.test(t));
    assert.ok(away, "a failed run while away must surface in the reconnect digest");
    assert.match(away!, /pane_ff/, "names the failed pane");
    assert.match(away!, /error/i, "replayed in the errors bucket");
    assert.ok(!/pane_ff finished/i.test(away!), "must NOT be replayed as a plain 'finished'");
  });
});
