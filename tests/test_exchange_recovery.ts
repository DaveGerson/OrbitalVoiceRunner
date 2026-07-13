// tests/test_exchange_recovery.ts
//
// AgentExchange spine — STORE-BACKED boot recovery (Phase 1, Step 1.4; spec
// docs/superpowers/specs/2026-07-09-agent-exchange-spine.md §4 "Restart behavior: durable state,
// recovery, quarantine").
//
// `tests/test_exchange_lifecycle.ts` already pins the PURE classification rule
// (`recoveryDisposition`) and `ExchangeMachine.recoverOnBoot`'s in-memory contract. This suite pins
// the missing bridge — `src/exchanges/recovery.ts`'s `recoverExchangesOnBoot`, which walks the
// DURABLE `agent_exchanges` rows a real process restart actually starts with (a fresh boot's
// ExchangeMachine is empty; the truth lives in SQLite) and applies the SAME disposition through the
// store's own guarded CAS — so a lost race is a no-op, never a second write, never invented history.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { JanusStore } from "../src/store/sqliteStore";
import { recoverExchangesOnBoot, interruptionDispositionFor } from "../src/exchanges/recovery";
import type { ExchangeState } from "../src/exchanges/lifecycle";
import { ExchangeService } from "../src/exchanges/service";
import {
  rehydrateDraftRegistryOnBoot,
  serializeDraftEnvelope,
  parsePersistedDraftEnvelope,
  getOpenDraft,
  setOpenDraft,
  getApprovalBinding,
  resetDraftRegistryForTests,
} from "../src/exchanges/draftRegistry";
import { createDraft, buildEnvelope } from "../src/exchanges/instructionEnvelope";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

function freshStore(): JanusStore {
  const s = new JanusStore(":memory:");
  s.init();
  return s;
}

function insertPendingApprovalRow(s: JanusStore, id: string, paneId: string): void {
  s.insertPendingApproval({
    id, session_id: "sess-1", workspace_id: "w1", pane_id: paneId,
    command: "do it", kind: "agent_instruction", rationale: null,
    claimed: false, timestamp: Date.now(), expires_at: Date.now() + 100000,
    exchange_id: null,
  });
}

describe("AgentExchange spine: boot recovery — restart BEFORE approval", () => {
  it("draft / awaiting_clarification are pure durable text — kept untouched, no event appended", () => {
    const s = freshStore();
    const draft = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "draft" });
    const clarifying = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "awaiting_clarification" });

    const report = recoverExchangesOnBoot(s);

    assert.ok(report.kept.includes(draft.exchange_id));
    assert.ok(report.kept.includes(clarifying.exchange_id));
    assert.strictEqual(s.getExchange(draft.exchange_id)!.state, "draft");
    assert.strictEqual(s.getExchange(clarifying.exchange_id)!.state, "awaiting_clarification");
    assert.deepStrictEqual(s.listExchangeEvents(draft.exchange_id), [], "a kept row gets no recovery event");
    s.close();
  });

  it("awaiting_approval: KEPT when the durable pending_approvals row survives the crash", () => {
    const s = freshStore();
    insertPendingApprovalRow(s, "appr-1", "pane-1");
    const row = s.insertExchange({
      project_id: "p1", pane_id: "pane-1", state: "awaiting_approval",
      approval_id: "appr-1", approval_draft_version: 1,
    });

    const report = recoverExchangesOnBoot(s);

    assert.ok(report.kept.includes(row.exchange_id));
    assert.ok(!report.reverted.includes(row.exchange_id));
    const after = s.getExchange(row.exchange_id)!;
    assert.strictEqual(after.state, "awaiting_approval");
    assert.strictEqual(after.approval_id, "appr-1", "the binding survives — never assumed lost");
    s.close();
  });

  it("awaiting_approval: REVERTED to draft (never resent, never assumed confirmed) when the approval row is gone", () => {
    const s = freshStore();
    // No matching pending_approvals row inserted — simulates claimed+deleted or TTL-swept mid-crash.
    const row = s.insertExchange({
      project_id: "p1", pane_id: "pane-1", state: "awaiting_approval",
      approval_id: "appr-GONE", approval_draft_version: 3,
    });

    const report = recoverExchangesOnBoot(s);

    assert.ok(report.reverted.includes(row.exchange_id));
    assert.ok(!report.kept.includes(row.exchange_id));
    const after = s.getExchange(row.exchange_id)!;
    assert.strictEqual(after.state, "draft", "reverted, not left dangling in awaiting_approval");
    assert.strictEqual(after.approval_id, null, "the stale binding is cleared");
    assert.strictEqual(after.approval_draft_version, null);
    assert.strictEqual(after.delivery_attempt, 0, "recovery never delivers");

    const events = s.listExchangeEvents(row.exchange_id);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event_type, "exchange_recovered");
    assert.strictEqual(JSON.parse(events[0].payload_redacted_json).disposition, "reverted_missing_approval");
    s.close();
  });
});

describe("AgentExchange spine: boot recovery — restart AFTER delivery-attempt, before confirmation", () => {
  it("staged with a recorded delivery attempt quarantines to interrupted — the uncertain-delivery signature", () => {
    const s = freshStore();
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "staged", delivery_attempt: 1 });

    const report = recoverExchangesOnBoot(s);

    assert.ok(report.interrupted.includes(row.exchange_id));
    const after = s.getExchange(row.exchange_id)!;
    assert.strictEqual(after.state, "interrupted");
    assert.strictEqual(after.delivery_attempt, 1, "the attempt count is preserved as forensic evidence, not erased");

    const events = s.listExchangeEvents(row.exchange_id);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event_type, "exchange_recovered");
    const payload = JSON.parse(events[0].payload_redacted_json);
    assert.strictEqual(payload.disposition, "interrupted");
    assert.strictEqual(payload.from_state, "staged");
    s.close();
  });

  it("NO DUPLICATE DELIVERY after recovery: a quarantined exchange can never CAS staged->delivered again", () => {
    const s = freshStore();
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "staged", delivery_attempt: 1 });
    recoverExchangesOnBoot(s);
    assert.strictEqual(s.getExchange(row.exchange_id)!.state, "interrupted");

    // Any code path that still believes the exchange is 'staged' and tries to complete delivery
    // loses the CAS — the interrupted state is a hard wall, never silently resent.
    const resend = s.updateExchange(row.exchange_id, { state: "delivered", delivered_at: Date.now() }, { state: "staged" });
    assert.strictEqual(resend.changed, false, "an interrupted exchange must never be resent as delivered");
    assert.strictEqual(s.getExchange(row.exchange_id)!.state, "interrupted", "state is unchanged by the rejected resend");
    s.close();
  });
});

describe("AgentExchange spine: boot recovery — restart AFTER delivered / observed in-flight", () => {
  for (const state of ["delivered", "running", "needs_input", "terminal_idle"] as ExchangeState[]) {
    it(`${state}: quarantines to interrupted (the observed PTY no longer exists after an inert boot)`, () => {
      const s = freshStore();
      const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state, delivery_attempt: 1, delivered_at: 1000 });

      const report = recoverExchangesOnBoot(s);

      assert.ok(report.interrupted.includes(row.exchange_id));
      assert.strictEqual(s.getExchange(row.exchange_id)!.state, "interrupted");
      s.close();
    });
  }

  // Regression (WP2 two-query rewrite, adversarial review): a row quarantined THIS boot pass
  // (e.g. running -> interrupted) must be counted EXACTLY ONCE — in `interrupted`, never also in
  // `kept`. The passthrough-id snapshot is taken BEFORE the actionable CAS pass precisely so a
  // just-quarantined row can't be re-seen in its new passthrough state. (The old per-state loop
  // queried "interrupted" AFTER the in-flight states and so double-counted these rows into `kept`,
  // inflating the boot digest — the rewrite fixed that; this pins the fix.)
  it("a row quarantined this pass appears ONLY in `interrupted` — never double-counted into `kept`", () => {
    const s = freshStore();
    const quarantined = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "running", delivery_attempt: 1, delivered_at: 1000 });
    const preExisting = s.insertExchange({ project_id: "p1", pane_id: "pane-2", state: "interrupted" });

    const report = recoverExchangesOnBoot(s);

    assert.ok(report.interrupted.includes(quarantined.exchange_id));
    assert.ok(!report.kept.includes(quarantined.exchange_id), "quarantined row must not also be counted as kept");
    assert.ok(report.kept.includes(preExisting.exchange_id), "a PRE-EXISTING interrupted row is still kept");
    assert.ok(!report.interrupted.includes(preExisting.exchange_id));
    s.close();
  });

  it("already-settled exchanges (agent_complete/agent_failed/cancelled/interrupted) are kept, untouched, no event", () => {
    const s = freshStore();
    const ids = (["agent_complete", "agent_failed", "cancelled", "interrupted"] as ExchangeState[]).map(
      (state) => s.insertExchange({ project_id: "p1", pane_id: "pane-1", state }).exchange_id
    );

    const report = recoverExchangesOnBoot(s);

    for (const id of ids) {
      assert.ok(report.kept.includes(id), `${id} should be kept`);
      assert.deepStrictEqual(s.listExchangeEvents(id), [], `${id} gets no recovery event — already settled`);
    }
    s.close();
  });
});

describe("AgentExchange spine: boot recovery — ambiguous member quarantine (dispatch-group correlation)", () => {
  it("a dispatch-group member's exchange (envelope carries dispatch_group_id) quarantines exactly like any other in-flight exchange", () => {
    // Step 1.4 does NOT persist DispatchJoinTracker groups (they stay in-memory, session-scoped —
    // see src/dispatch/joinTracker.ts's own module doc). Each member IS an agent_exchanges row, so
    // "ambiguous member correlation cannot be re-established after a restart" reduces to exactly
    // this: the member's own exchange row quarantines via the SAME general rule, no special-casing.
    const s = freshStore();
    const row = s.insertExchange({
      project_id: "p1", pane_id: "pane-1", state: "running",
      instruction_envelope_json: JSON.stringify({ dispatch_group_id: "dg-1" }),
    });

    const report = recoverExchangesOnBoot(s);

    assert.ok(report.interrupted.includes(row.exchange_id));
    const after = s.getExchange(row.exchange_id)!;
    assert.strictEqual(after.state, "interrupted");
    assert.strictEqual(
      JSON.parse(after.instruction_envelope_json).dispatch_group_id, "dg-1",
      "the reporting label survives quarantine for the operator-facing digest"
    );
    s.close();
  });

  it("a group with ONE ambiguous (in-flight) member and one already-settled member: only the ambiguous one is touched", () => {
    const s = freshStore();
    const ambiguous = s.insertExchange({
      project_id: "p1", pane_id: "pane-1", state: "delivered",
      instruction_envelope_json: JSON.stringify({ dispatch_group_id: "dg-2" }),
    });
    const settled = s.insertExchange({
      project_id: "p1", pane_id: "pane-2", state: "agent_complete",
      instruction_envelope_json: JSON.stringify({ dispatch_group_id: "dg-2" }),
    });

    const report = recoverExchangesOnBoot(s);

    assert.ok(report.interrupted.includes(ambiguous.exchange_id));
    assert.ok(report.kept.includes(settled.exchange_id));
    assert.strictEqual(s.getExchange(settled.exchange_id)!.state, "agent_complete", "settled member is immutable");
    s.close();
  });
});

describe("AgentExchange spine: boot recovery — idempotent, never-throws", () => {
  it("running recovery twice is a harmless no-op the second time (already-interrupted rows are kept, not re-quarantined)", () => {
    const s = freshStore();
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "delivered" });

    const first = recoverExchangesOnBoot(s);
    assert.ok(first.interrupted.includes(row.exchange_id));

    const second = recoverExchangesOnBoot(s);
    assert.ok(!second.interrupted.includes(row.exchange_id), "already interrupted -> classified as kept, not re-interrupted");
    assert.ok(second.kept.includes(row.exchange_id));
    assert.strictEqual(s.getExchange(row.exchange_id)!.state, "interrupted");
    s.close();
  });

  it("an empty store recovers cleanly (no rows, no throw, empty report)", () => {
    const s = freshStore();
    const report = recoverExchangesOnBoot(s);
    assert.deepStrictEqual(report, { kept: [], interrupted: [], reverted: [] });
    s.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Step 1.5b — boot recovery wired into the REAL server boot sequence (additive: proves the
// server.ts call site itself, not just the pure recoverExchangesOnBoot/spine.ts unit seams above).
// Mirrors the tests/test_boot_quarantine.ts / tests/test_boot_recovery_summary.ts idiom: seed a
// durable store BEFORE boot, point a fresh server process at it via env, import+boot the REAL
// server, then read the SAME on-disk file back through a second reader connection.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("AgentExchange spine: boot recovery wired into the REAL server boot sequence", () => {
  let tmpDir: string;
  let dbPath: string;
  let running: RunningServer;
  let reader: JanusStore | null = null;
  const midFlightId = "exch-boot-wiring-midflight";
  const settledId = "exch-boot-wiring-settled";

  const prevEnv: Record<string, string | undefined> = {};
  function setEnv(k: string, v: string | undefined) {
    prevEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "janus-boot-exchange-recovery-"));
    dbPath = join(tmpDir, "boot.db");

    // Seed the durable store BEFORE boot — models "the server was killed mid-flight".
    const seed = new JanusStore(dbPath);
    seed.init();
    seed.insertExchange({
      exchange_id: midFlightId, project_id: "p1", pane_id: "pane-1",
      state: "running", delivery_attempt: 1, delivered_at: 1000,
    });
    seed.insertExchange({
      exchange_id: settledId, project_id: "p1", pane_id: "pane-1", state: "agent_complete",
    });
    seed.close();

    // JANUS_EXCHANGE_SPINE must be set BEFORE the first import of anything touching
    // src/exchanges/flag.ts in THIS process — this file's earlier describe blocks only import
    // JanusStore/recoverExchangesOnBoot/lifecycle types, none of which touch the flag module, so
    // this is genuinely the first read. `node --test` runs each test FILE as its own process, so
    // this frozen value cannot leak into any other test file either.
    setEnv("JANUS_EXCHANGE_SPINE", "primary");
    setEnv("JANUS_DB", dbPath);
    setEnv("JANUS_NO_AUTOSTART", "1");
    setEnv("NODE_ENV", "test");

    const serverMod = await import("../server");
    // listen:false — the boot-recovery call site runs at module scope, before startServer() is
    // even invoked, let alone before any optional listen(); no bound port needed for this proof.
    running = await serverMod.startServer({ port: 0, enableVite: false, listen: false });

    reader = new JanusStore(dbPath);
    reader.init();
  });

  after(async () => {
    try { reader?.close(); } catch { /* best-effort; distinct connection from the server singleton */ }
    await teardownServerSuite(running);
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("the mid-flight exchange is quarantined to interrupted, with an exchange_recovered event, by the real boot sequence", () => {
    const row = reader!.getExchange(midFlightId)!;
    assert.strictEqual(row.state, "interrupted");
    const events = reader!.listExchangeEvents(midFlightId);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].event_type, "exchange_recovered");
    assert.strictEqual(JSON.parse(events[0].payload_redacted_json).from_state, "running");
  });

  it("the already-settled exchange is left untouched by the real boot sequence", () => {
    const row = reader!.getExchange(settledId)!;
    assert.strictEqual(row.state, "agent_complete");
    assert.deepStrictEqual(reader!.listExchangeEvents(settledId), []);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 4, Step 4.3 — the interruption class → disposition table (recovery.ts
// `interruptionDispositionFor`). Only `process_boot` triggers real machinery (proven by every
// describe block above); the other three classes are documented, TESTED no-ops — pinned here so a
// future "let's also quarantine on reconnect, just to be safe" patch fails a test instead of
// silently regressing operator experience (spuriously interrupting perfectly-delivered exchanges).
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("AgentExchange spine: interruption class -> disposition table (Phase 4, Step 4.3)", () => {
  it("process_boot is the ONLY class that quarantines uncertain in-flight exchanges", () => {
    assert.strictEqual(interruptionDispositionFor("process_boot"), "quarantine_uncertain_inflight");
  });
  it("browser_ws_reconnect is a no-op: the server process (and every PTY) survives a client tab reconnect", () => {
    assert.strictEqual(interruptionDispositionFor("browser_ws_reconnect"), "no_op_delivery_unaffected");
  });
  it("gemini_session_reconnect is a no-op: a Live-socket drop is a narration-channel event, not a delivery one", () => {
    assert.strictEqual(interruptionDispositionFor("gemini_session_reconnect"), "no_op_delivery_unaffected");
  });
  it("python_daemon_reconnect is a no-op: the memory/policy daemon never holds a PTY or an exchange row", () => {
    assert.strictEqual(interruptionDispositionFor("python_daemon_reconnect"), "no_op_delivery_unaffected");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 4, Step 4.3 — instruction_envelope_json now actually gets persisted at createExchange
// (previously always defaulted to '{}' — no code path populated it). This is the durable source
// `rehydrateDraftRegistryOnBoot` (below) reads back after a restart.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("AgentExchange spine: createExchange persists instructionEnvelopeJson (Phase 4, Step 4.3)", () => {
  it("createExchange with instructionEnvelopeJson stamps (redacted) instruction_envelope_json on the row", () => {
    const s = freshStore();
    const svc = new ExchangeService({ store: s });
    const json = JSON.stringify({ kind: "envelope_draft", envelope: { objective: "ship it" }, target: { projectId: "p1", paneId: "pane-1" }, draftVersion: 1 });
    const snap = svc.createExchange({
      projectId: "p1", paneId: "pane-1", operatorUtterance: "ship it", distilledInstruction: "ship it",
      instructionEnvelopeJson: json,
    });
    const row = s.getExchange(snap.exchangeId)!;
    assert.strictEqual(JSON.parse(row.instruction_envelope_json).envelope.objective, "ship it");
    s.close();
  });

  it("createExchange WITHOUT instructionEnvelopeJson leaves the schema default '{}' — unchanged from before this field existed", () => {
    const s = freshStore();
    const svc = new ExchangeService({ store: s });
    const snap = svc.createExchange({ projectId: "p1", paneId: "pane-1", operatorUtterance: "x", distilledInstruction: "x" });
    const row = s.getExchange(snap.exchangeId)!;
    assert.strictEqual(row.instruction_envelope_json, "{}");
    s.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Phase 4, Step 4.3 — draft-registry rehydration on boot (src/exchanges/draftRegistry.ts
// `rehydrateDraftRegistryOnBoot`). The registry (openDrafts/approvalBindings) is process-global
// in-memory — a restart wipes it. This rebuilds it from the durable `agent_exchanges` rows that
// carry a persisted envelope (the ONLY durable source for a draft that has been sent at least
// once — see the module's own "accepted limitation" doc for why a never-sent draft cannot
// rehydrate its structure).
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("Draft registry: rehydration from durable exchange rows on boot (Phase 4, Step 4.3)", () => {
  // Every test in this block shares the SAME process-global registry — reset before each so an
  // earlier test's (projectId, paneId) entry can never leak into a later one (the registry has no
  // per-test isolation of its own; that is exactly what production boot rehydration relies on
  // running once into an EMPTY registry).
  beforeEach(() => resetDraftRegistryForTests());
  after(() => resetDraftRegistryForTests());

  it("serializeDraftEnvelope + parsePersistedDraftEnvelope round-trip", () => {
    const draft = createDraft({ target: { projectId: "p1", paneId: "pane-1" }, envelope: buildEnvelope({ objective: "fix the bug" }) });
    const json = serializeDraftEnvelope(draft)!;
    const parsed = parsePersistedDraftEnvelope(json)!;
    assert.strictEqual(parsed.kind, "envelope_draft");
    assert.strictEqual(parsed.envelope.objective, "fix the bug");
    assert.deepStrictEqual(parsed.target, { projectId: "p1", paneId: "pane-1" });
    assert.strictEqual(parsed.draftVersion, 1);
  });

  it("serializeDraftEnvelope returns null for a draft with no bound target (defensive — readiness already requires one before a real send)", () => {
    const draft = createDraft({ envelope: buildEnvelope({ objective: "fix it" }) });
    assert.strictEqual(serializeDraftEnvelope(draft), null);
  });

  it("parsePersistedDraftEnvelope never confuses a dispatch-group label or the schema default with an envelope draft", () => {
    assert.strictEqual(parsePersistedDraftEnvelope("{}"), null);
    assert.strictEqual(parsePersistedDraftEnvelope(JSON.stringify({ dispatch_group_id: "dg-1" })), null);
    assert.strictEqual(parsePersistedDraftEnvelope("not json{"), null);
  });

  it("a 'draft' row (reverted from a failed delivery) with a persisted envelope rehydrates into the registry, sentVersions empty (a re-send must not be refused as a false duplicate)", () => {
    const s = freshStore();
    const json = JSON.stringify({ kind: "envelope_draft", envelope: { objective: "retry me" }, target: { projectId: "p1", paneId: "pane-1" }, draftVersion: 2 });
    const row = s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "draft", draft_version: 2, instruction_envelope_json: json });

    const report = rehydrateDraftRegistryOnBoot(s);

    assert.ok(report.rehydratedDrafts.includes(row.exchange_id));
    assert.deepStrictEqual(report.rehydratedApprovalBindings, []);
    const draft = getOpenDraft("p1", "pane-1")!;
    assert.strictEqual(draft.exchangeId, row.exchange_id);
    assert.strictEqual(draft.envelope.objective, "retry me");
    assert.strictEqual(draft.draftVersion, 2);
    assert.deepStrictEqual(draft.sentVersions, [], "a failed/reverted draft must allow a re-send of the SAME version");
    s.close();
  });

  it("an 'awaiting_approval' row whose pending_approvals row SURVIVED rehydrates the draft AND rebinds the approval, sentVersions=[draftVersion]", () => {
    const s = freshStore();
    s.insertPendingApproval({
      id: "appr-1", session_id: "sess-1", workspace_id: "w1", pane_id: "pane-1",
      command: "do it", kind: "agent_instruction", rationale: null,
      claimed: false, timestamp: Date.now(), expires_at: Date.now() + 100000, exchange_id: null,
    });
    const json = JSON.stringify({ kind: "envelope_draft", envelope: { objective: "ship it" }, target: { projectId: "p1", paneId: "pane-1" }, draftVersion: 1 });
    const row = s.insertExchange({
      project_id: "p1", pane_id: "pane-1", state: "awaiting_approval",
      approval_id: "appr-1", approval_draft_version: 1, instruction_envelope_json: json,
    });

    const report = rehydrateDraftRegistryOnBoot(s);

    assert.ok(report.rehydratedDrafts.includes(row.exchange_id));
    assert.ok(report.rehydratedApprovalBindings.includes(row.exchange_id));
    const draft = getOpenDraft("p1", "pane-1")!;
    assert.deepStrictEqual(draft.sentVersions, [1], "the sent version must stay refused for a duplicate re-send while approval is outstanding");
    const binding = getApprovalBinding("p1", "pane-1")!;
    assert.strictEqual(binding.messageId, "appr-1");
    assert.strictEqual(binding.draftVersion, 1);
    s.close();
  });

  it("an 'awaiting_approval' row whose pending_approvals row is GONE rehydrates the draft but NEVER binds a dead approval (never deliver stale)", () => {
    const s = freshStore();
    const json = JSON.stringify({ kind: "envelope_draft", envelope: { objective: "ship it" }, target: { projectId: "p1", paneId: "pane-1" }, draftVersion: 1 });
    const row = s.insertExchange({
      project_id: "p1", pane_id: "pane-1", state: "awaiting_approval",
      approval_id: "appr-GONE", approval_draft_version: 1, instruction_envelope_json: json,
    });

    const report = rehydrateDraftRegistryOnBoot(s);

    assert.ok(report.rehydratedDrafts.includes(row.exchange_id));
    assert.ok(!report.rehydratedApprovalBindings.includes(row.exchange_id));
    assert.strictEqual(getApprovalBinding("p1", "pane-1"), undefined, "no binding to a vanished approval — never deliver stale");
    assert.ok(getOpenDraft("p1", "pane-1"), "the draft itself still rehydrates — the operator can revise/resend it");
    s.close();
  });

  it("a row with no persisted envelope (accepted limitation — never sent, or a plain non-envelope dispatch) is silently skipped, not fabricated", () => {
    const s = freshStore();
    s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "draft" }); // schema default '{}'
    const report = rehydrateDraftRegistryOnBoot(s);
    assert.deepStrictEqual(report.rehydratedDrafts, []);
    assert.strictEqual(getOpenDraft("p1", "pane-1"), undefined);
    s.close();
  });

  it("never clobbers an ALREADY-LIVE registry entry for the same pane (only ever seeds a cold registry)", () => {
    const s = freshStore();
    const live = createDraft({ target: { projectId: "p1", paneId: "pane-1" }, envelope: buildEnvelope({ objective: "the LIVE one" }) });
    setOpenDraft("p1", "pane-1", live);
    const json = JSON.stringify({ kind: "envelope_draft", envelope: { objective: "the durable one" }, target: { projectId: "p1", paneId: "pane-1" }, draftVersion: 1 });
    s.insertExchange({ project_id: "p1", pane_id: "pane-1", state: "draft", instruction_envelope_json: json });

    const report = rehydrateDraftRegistryOnBoot(s);

    assert.deepStrictEqual(report.rehydratedDrafts, [], "the live entry wins — nothing rehydrated over it");
    assert.strictEqual(getOpenDraft("p1", "pane-1")!.envelope.objective, "the LIVE one");
    s.close();
  });

  it("an empty store rehydrates cleanly (no rows, no throw, empty report)", () => {
    const s = freshStore();
    const report = rehydrateDraftRegistryOnBoot(s);
    assert.deepStrictEqual(report, { rehydratedDrafts: [], rehydratedApprovalBindings: [] });
    s.close();
  });
});
