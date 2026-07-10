// tests/test_worldmodel_exchange_context.ts — Phase 2 Step 2.1 (AgentExchange spine context
// enrichment): WorldModel now populates ProjectTier.recentDecisions/warnings/openTodos from typed
// notes (Wave 6), PaneTier.recent from command outcomes/needs-input/handoffs/exchange events, board
// entries from agent_exchanges state, and the NEW EventFocusTier for a background-outcome trigger.
// Every new source is ALREADY durable in JanusStore — this suite exercises the real store (an
// in-memory SQLite instance), not a hand-rolled fake, so the WorldModel<->store contract is
// genuinely covered end-to-end (mirrors tests/test_context_telemetry_store.ts's style).
//
// Spec: docs/superpowers/specs/2026-07-09-agent-exchange-spine.md
import { test } from "node:test";
import assert from "node:assert/strict";
import { JanusStore } from "../src/store/sqliteStore";
import { EVENT_TYPES } from "../src/store/eventTypes";
import { WorldModel } from "../src/memory/worldModel";
import { BreadcrumbRing } from "../src/memory/breadcrumbs";
import { assembleBrief } from "../src/memory/assembler";
import { DEFAULT_MEMORY_CONFIG } from "../src/memory/types";
import { ExchangeService } from "../src/exchanges/service";

const SECRET = "sk-supersecret789";
const REDACTED_MARK = "[REDACTED]";

function redact(s: string): string {
  return s.replace(/sk-[A-Za-z0-9]+/g, REDACTED_MARK);
}

function seedStore(): JanusStore {
  const s = new JanusStore(":memory:");
  s.init();
  s.saveWorkspace({ id: "proj", name: "Janus", directory: "/repo", summary: "orchestrator", key_terms: ["pty"], created_at: 0, updated_at: 0 });
  return s;
}

/** Directly backdates a `notes` row's created_at — addNote always stamps Date.now(), so this is
 *  the only way to get deterministic, fully-controlled ordering across several planted notes. */
function backdateNote(store: JanusStore, id: string, ts: number): void {
  store.db.prepare("UPDATE notes SET created_at=? WHERE id=?").run(ts, id);
}

interface FakeManagerOpts {
  activeId?: string | null;
  activeProjectId?: string | null;
  terminals: Record<string, { name?: string; runtimeType?: string; status?: string; lastCommand?: string | null }>;
  panes: Array<{ pane_id: string; name?: string; last_known_state?: string }>;
}

function fakeManager(opts: FakeManagerOpts) {
  return {
    activeId: opts.activeId ?? null,
    terminals: opts.terminals,
    ledger: { activeProjectId: opts.activeProjectId ?? "proj" },
    settings: { globalPermissionsMode: "Human-in-the-Loop" },
    listPanes: () => [{ project_id: "proj", panes: opts.panes }],
  };
}

function wm(store: JanusStore, managerOpts: FakeManagerOpts): WorldModel {
  const breadcrumbs = new BreadcrumbRing({ breadcrumbMax: 12, breadcrumbMaxAgeMs: 1e9 });
  return new WorldModel({ manager: fakeManager(managerOpts) as any, store, redact, breadcrumbs });
}

const TERMINALS = {
  p1: { name: "p1-main", runtimeType: "claude", status: "Running", lastCommand: "npm test" },
  p2: { name: "p2-worker", runtimeType: "codex", status: "Idle", lastCommand: null },
};
const PANES = [
  { pane_id: "p1", name: "p1-main", last_known_state: "Running" },
  { pane_id: "p2", name: "p2-worker", last_known_state: "Idle" },
];

// ── ProjectTier.recentDecisions / warnings / openTodos ──────────────────────────────────────────

test("ProjectTier.recentDecisions: typed decision notes, redacted, bounded, newest-first", () => {
  const store = seedStore();
  const ids: string[] = [];
  for (let i = 0; i < 10; i++) {
    const text = i === 3 ? `chose stdio seam token=${SECRET}` : `decision number ${i}`;
    const note = store.addNote("proj", text, { type: "decision" })!;
    backdateNote(store, note.id, 1000 + i * 10);
    ids.push(note.id);
  }
  const model = wm(store, { terminals: TERMINALS, panes: PANES });
  const project = model.getProjectTier("proj")!;

  // bounded (PROJECT_LIST_MAX = 8) — only the 8 most-recent of the 10 planted decisions survive.
  assert.equal(project.recentDecisions.length, 8);
  // newest-first: decision 9 (ts 1090) is the most recent -> index 0.
  assert.equal(project.recentDecisions[0], "decision number 9");
  assert.equal(project.recentDecisions[7], "decision number 2");
  // redacted (the planted secret at i=3 fell out of the bounded window, so plant one more recent
  // secret note to prove redaction independent of the bounding).
  const secretNote = store.addNote("proj", `latest decision uses token=${SECRET}`, { type: "decision" })!;
  backdateNote(store, secretNote.id, 5000);
  const project2 = model.getProjectTier("proj")!;
  assert.equal(project2.recentDecisions[0], `latest decision uses token=${REDACTED_MARK}`);
  assert.ok(!project2.recentDecisions.some(d => d.includes("sk-")), "no raw secret leaks through recentDecisions");
});

test("ProjectTier.warnings / openTodos: typed notes, redacted, bounded; promoted todos excluded", () => {
  const store = seedStore();
  store.addNote("proj", `disk usage high token=${SECRET}`, { type: "warning" });
  store.addNote("proj", "cert expiring soon", { type: "warning" });
  const openTodo = store.addNote("proj", "fix flaky test", { type: "todo" })!;
  const promotedTodo = store.addNote("proj", "write the design doc", { type: "todo" })!;
  store.setNoteBeadStatus(promotedTodo.id, "created"); // promoted to a bead -> no longer "open"

  const model = wm(store, { terminals: TERMINALS, panes: PANES });
  const project = model.getProjectTier("proj")!;

  assert.equal(project.warnings?.length, 2);
  assert.ok(project.warnings!.some(w => w.includes(REDACTED_MARK)));
  assert.ok(!project.warnings!.some(w => w.includes("sk-")));

  assert.deepEqual(project.openTodos, ["fix flaky test"]);
  assert.ok(!project.openTodos!.some(t => t === "write the design doc"), "promoted todo excluded");
  assert.ok(openTodo.id.length > 0);
});

// ── PaneTier.recent: outcomes / needs-input questions / handoffs / exchange events ─────────────

test("PaneTier.recent: command outcomes, needs-input questions, handoffs, and exchange events — bounded, deterministic, redacted", () => {
  const store = seedStore();

  // 1) command outcome
  store.appendEvent({
    type: EVENT_TYPES.COMMAND_OUTCOME, pane_id: "p2", ts: 1000,
    summary: `build succeeded token=${SECRET}`,
  });

  // 2) an exchange that reaches needs_input (needs-input "question")
  store.insertExchange({
    exchange_id: "exch_a", project_id: "proj", pane_id: "p2", state: "needs_input", created_at: 500,
  });
  store.appendExchangeEvent({
    exchange_id: "exch_a", event_type: "needs_input_detected", pane_id: "p2", ts: 2000,
    payload_redacted_json: JSON.stringify({ detail: `confirm deploy? token=${SECRET}` }),
  });

  // 3) a SEPARATE, settled exchange whose completion report surfaces as an "exchange event"
  store.insertExchange({
    exchange_id: "exch_b", project_id: "proj", pane_id: "p2", state: "agent_complete", created_at: 100,
    result_summary: `tests passed token=${SECRET}`,
  });
  store.appendExchangeEvent({
    exchange_id: "exch_b", event_type: "agent_completion_reported", pane_id: "p2", ts: 3000,
  });

  // 4) a handoff targeting the pane
  store.createHandoff({
    workspace_id: "proj", to_pane: "p2", state: "delivered",
    composed_prompt: `please review PR token=${SECRET}`,
  });

  const model = wm(store, { terminals: TERMINALS, panes: PANES });
  const pane = model.getPaneTier("p2")!;

  assert.ok(pane.recent.some(r => r.startsWith("Outcome:")), "command outcome present");
  assert.ok(pane.recent.some(r => r.startsWith("Needs input:")), "needs-input question present");
  assert.ok(pane.recent.some(r => r.startsWith("Exchange agent_completion_reported:")), "exchange event present");
  assert.ok(pane.recent.some(r => r.startsWith("Handoff")), "handoff present");
  // every entry redacted — no raw secret anywhere in PaneTier.recent
  assert.ok(!pane.recent.some(r => r.includes("sk-")), "no raw secret leaks through PaneTier.recent");
  assert.ok(pane.recent.some(r => r.includes(REDACTED_MARK)));
  // bounded (PANE_RECENT_MAX = 8)
  assert.ok(pane.recent.length <= 8);
});

test("PaneTier.recent is bounded to 8 entries under a large candidate set", () => {
  const store = seedStore();
  for (let i = 0; i < 20; i++) {
    store.appendEvent({ type: EVENT_TYPES.COMMAND_OUTCOME, pane_id: "p2", ts: 1000 + i, summary: `outcome ${i}` });
  }
  const model = wm(store, { terminals: TERMINALS, panes: PANES });
  const pane = model.getPaneTier("p2")!;
  assert.equal(pane.recent.length, 8);
  // newest-first: outcome 19 (ts 1019) must lead.
  assert.equal(pane.recent[0], "Outcome: outcome 19");
});

// ── Board entries: exchange state + waiting reason ──────────────────────────────────────────────

test("Board entries: current in-flight exchange state + waiting reason per pane", () => {
  const store = seedStore();
  // p1: an older 'draft' exchange, then a newer 'running' one -> board should reflect 'running'
  // (the current in-flight exchange), not the stale draft.
  store.insertExchange({ exchange_id: "exch_old", project_id: "proj", pane_id: "p1", state: "draft", created_at: 100 });
  store.insertExchange({ exchange_id: "exch_new", project_id: "proj", pane_id: "p1", state: "running", created_at: 200 });
  // p2: needs_input -> a human-readable waiting reason.
  store.insertExchange({ exchange_id: "exch_p2", project_id: "proj", pane_id: "p2", state: "needs_input", created_at: 100 });

  const model = wm(store, { terminals: TERMINALS, panes: PANES });
  const board = model.getBoardTier();
  const p1 = board.find(b => b.paneId === "p1")!;
  const p2 = board.find(b => b.paneId === "p2")!;

  assert.equal(p1.exchangeState, "running");
  assert.equal(p1.waitingReason, null);
  assert.equal(p2.exchangeState, "needs_input");
  assert.equal(p2.waitingReason, "needs input");
});

test("Board entries: terminal exchanges never surface as the current in-flight one", () => {
  const store = seedStore();
  store.insertExchange({ exchange_id: "exch_done", project_id: "proj", pane_id: "p1", state: "agent_complete", created_at: 100 });
  const model = wm(store, { terminals: TERMINALS, panes: PANES });
  const board = model.getBoardTier();
  const p1 = board.find(b => b.paneId === "p1")!;
  assert.equal(p1.exchangeState, null);
  assert.equal(p1.waitingReason, null);
});

test("Board entries: awaiting_approval reports an 'awaiting approval' waiting reason (unresolved approval)", () => {
  const store = seedStore();
  store.insertExchange({ exchange_id: "exch_appr", project_id: "proj", pane_id: "p2", state: "awaiting_approval", created_at: 100 });
  const model = wm(store, { terminals: TERMINALS, panes: PANES });
  const p2 = model.getBoardTier().find(b => b.paneId === "p2")!;
  assert.equal(p2.exchangeState, "awaiting_approval");
  assert.equal(p2.waitingReason, "awaiting approval");
});

// ── EventFocusTier: the affected-pane / background-outcome block ────────────────────────────────

test("getTiers: eventFocus names the background pane + its event delta + exchange state when affectedPaneId != activePaneId", () => {
  const store = seedStore();
  store.insertExchange({ exchange_id: "exch_bg", project_id: "proj", pane_id: "p2", state: "needs_input", created_at: 100 });
  store.appendExchangeEvent({
    exchange_id: "exch_bg", event_type: "needs_input_detected", pane_id: "p2", ts: 500,
    payload_redacted_json: JSON.stringify({ detail: `approve this? token=${SECRET}` }),
  });

  const model = wm(store, { activeId: "p1", terminals: TERMINALS, panes: PANES });
  const tiers = model.getTiers("p1", 1000, "p2");

  assert.ok(tiers.eventFocus, "eventFocus block present for a background trigger");
  assert.equal(tiers.eventFocus!.paneId, "p2");
  assert.equal(tiers.eventFocus!.name, "p2-worker");
  assert.equal(tiers.eventFocus!.exchangeState, "needs_input");
  assert.equal(tiers.eventFocus!.waitingReason, "needs input");
  assert.ok(tiers.eventFocus!.eventText.startsWith("Needs input:"));
  assert.ok(!tiers.eventFocus!.eventText.includes("sk-"), "eventFocus text redacted");
  assert.ok(tiers.eventFocus!.eventText.includes(REDACTED_MARK));
});

test("getTiers: eventFocus is null when the affected pane IS the active pane", () => {
  const store = seedStore();
  const model = wm(store, { activeId: "p1", terminals: TERMINALS, panes: PANES });
  const tiers = model.getTiers("p1", 1000, "p1");
  assert.equal(tiers.eventFocus, null);
});

test("getTiers: eventFocus is null when no affectedPaneId is supplied (default behavior unchanged)", () => {
  const store = seedStore();
  const model = wm(store, { activeId: "p1", terminals: TERMINALS, panes: PANES });
  const tiers = model.getTiers("p1", 1000);
  assert.equal(tiers.eventFocus, null);
});

test("getTiers: eventFocus is null for an affected pane unknown to the live manager", () => {
  const store = seedStore();
  const model = wm(store, { activeId: "p1", terminals: TERMINALS, panes: PANES });
  const tiers = model.getTiers("p1", 1000, "p9-does-not-exist");
  assert.equal(tiers.eventFocus, null);
});

// ── Determinism: identical store state -> byte-identical snapshot ──────────────────────────────

test("getTiers + assembleBrief: same store state produces a byte-identical snapshot and rendered brief", () => {
  const store = seedStore();
  store.addNote("proj", "use sqlite for the ledger", { type: "decision" });
  store.addNote("proj", "disk usage high", { type: "warning" });
  store.appendEvent({ type: EVENT_TYPES.COMMAND_OUTCOME, pane_id: "p1", ts: 1000, summary: "build ok" });
  store.insertExchange({ exchange_id: "exch_x", project_id: "proj", pane_id: "p2", state: "needs_input", created_at: 100 });
  store.appendExchangeEvent({ exchange_id: "exch_x", event_type: "needs_input_detected", pane_id: "p2", ts: 200 });

  const model = wm(store, { activeId: "p1", terminals: TERMINALS, panes: PANES });
  const a = model.getTiers("p1", 5000, "p2");
  const b = model.getTiers("p1", 5000, "p2");
  assert.deepEqual(a, b, "two calls against the SAME store state must yield an identical snapshot");

  const briefA = assembleBrief(a, DEFAULT_MEMORY_CONFIG, 5000);
  const briefB = assembleBrief(b, DEFAULT_MEMORY_CONFIG, 5000);
  assert.equal(briefA.text, briefB.text, "rendered brief text must be byte-identical for unchanged content");
});

// ── Budget respected under a large enriched snapshot ────────────────────────────────────────────

test("assembleBrief: enriched tiers (decisions/warnings/todos/pane-recent/eventFocus) still respect the total budget", () => {
  const store = seedStore();
  for (let i = 0; i < 20; i++) {
    store.addNote("proj", "x".repeat(300), { type: "decision" });
    store.addNote("proj", "y".repeat(300), { type: "warning" });
    store.addNote("proj", "z".repeat(300), { type: "todo" });
    store.appendEvent({ type: EVENT_TYPES.COMMAND_OUTCOME, pane_id: "p1", ts: 1000 + i, summary: "o".repeat(300) });
  }
  store.insertExchange({ exchange_id: "exch_big", project_id: "proj", pane_id: "p2", state: "needs_input", created_at: 100 });
  store.appendExchangeEvent({
    exchange_id: "exch_big", event_type: "needs_input_detected", pane_id: "p2", ts: 200,
    payload_redacted_json: JSON.stringify({ detail: "q".repeat(2000) }),
  });

  const model = wm(store, { activeId: "p1", terminals: TERMINALS, panes: PANES });
  const tiers = model.getTiers("p1", 5000, "p2");
  const brief = assembleBrief(tiers, DEFAULT_MEMORY_CONFIG, 5000);

  // Same slack-tolerance style as tests/test_memory_assembler.ts's budget assertion.
  assert.ok(
    brief.text.length <= DEFAULT_MEMORY_CONFIG.totalBudgetChars * 1.3,
    `budget respected even under a heavily enriched snapshot (got ${brief.text.length} chars)`,
  );
});

// ── BUG (Phase 2 Step 2.4, cross-project journey 10 — planted-secret redaction at rest) ─────────
//
// Every test above proves WorldModel redacts secrets on READ (getProjectTier/getPaneTier/
// getEventFocusTier all call `this.deps.redact(...)` before rendering). That is NOT the same
// guarantee as "secrets never land in the DB" — tests/test_secrets_at_rest.ts and
// tests/test_history_redaction_at_rest.ts exist precisely because those are two different
// invariants for other tables. For the AgentExchange spine, they are NOT both held:
//
//   1. src/exchanges/service.ts `persistTransition` (the ONLY writer of exchange_events rows for
//      real transitions) does:
//        payload_redacted_json: JSON.stringify(opts?.payload ?? {})
//      with NO redaction call anywhere in between. `opts.payload` traces back to `onPaneSignal`'s
//      `sig.detail` (service.ts ~line 257: `sig.detail !== undefined ? { payload: { detail:
//      sig.detail } } : undefined`) — real, unredacted pane-output text for a "needs_input_detected"
//      signal. The column name promises redaction; the code never performs it.
//
//   2. `distilled_instruction` (agent_exchanges) is populated verbatim from the operator's
//      propose_command instruction: src/voice/index.ts:1134 `distilledInstruction: instruction` —
//      again with no `redactSecrets` pass before it reaches `ExchangeService.createExchange` ->
//      `store.insertExchange`.
//
// This test exercises the REAL production write path end-to-end (ExchangeService, not a
// hand-built fixture) and is RED against current code — filed here rather than fixed, per this
// task's test-only scope. See the session report for the full finding.
{
  const SECRET = "sk-ant-SECRET123";

  test("BUG: distilled_instruction and payload_redacted_json both retain the raw secret after a real create -> stage -> deliver -> needs_input cycle (ExchangeService writes secrets to agent_exchanges/exchange_events UNREDACTED at rest)", () => {
    const store = seedStore();
    const svc = new ExchangeService({ store, now: () => 1000 });

    const snap = svc.createExchange({
      projectId: "proj",
      paneId: "p2",
      operatorUtterance: `please rotate the key to ${SECRET}`,
      distilledInstruction: `export API_KEY=${SECRET}`,
    });
    assert.ok(svc.stageForDelivery(snap.exchangeId).ok, "stageForDelivery succeeded");
    assert.ok(svc.recordDelivery(snap.exchangeId).ok, "recordDelivery succeeded");
    svc.onPaneSignal({ paneId: "p2", kind: "prompt", detail: `confirm? current key is ${SECRET}` });

    const row = store.getExchange(snap.exchangeId)!;
    const events = store.listExchangeEvents(snap.exchangeId);
    const promptEvent = events.find(e => e.event_type === "needs_input_detected")!;
    assert.ok(promptEvent, "the needs_input_detected event was recorded");

    // Desired/expected behavior — CURRENTLY FALSE (the bug):
    assert.ok(
      !row.distilled_instruction.includes(SECRET),
      "BUG: agent_exchanges.distilled_instruction stores the raw secret verbatim at rest " +
      "(src/voice/index.ts:1134 passes the operator's raw instruction straight through, never redacted)",
    );
    assert.ok(
      !promptEvent.payload_redacted_json.includes(SECRET),
      "BUG: exchange_events.payload_redacted_json stores the raw secret verbatim at rest " +
      "(src/exchanges/service.ts persistTransition JSON.stringify(opts.payload) with no redaction pass)",
    );
  });
}

// ── tests/test_memory_worldmodel.ts stays green — this suite is additive, not a replacement ─────
test("sanity: a store with none of the new data sources still yields empty (never throwing) enriched fields", () => {
  const store = seedStore();
  const model = wm(store, { activeId: "p1", terminals: TERMINALS, panes: PANES });
  const project = model.getProjectTier("proj")!;
  assert.deepEqual(project.recentDecisions, []);
  assert.deepEqual(project.warnings, []);
  assert.deepEqual(project.openTodos, []);
  const pane = model.getPaneTier("p1")!;
  assert.deepEqual(pane.recent, []);
  const board = model.getBoardTier();
  assert.ok(board.every(b => b.exchangeState === null && b.waitingReason === null));
});
