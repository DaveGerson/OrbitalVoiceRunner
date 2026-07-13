// tests/test_exchange_notifications.ts
//
// AgentExchange spine — Phase 4, Step 4.2: exchange-aware attention/catch-up/SITREP/narration.
//
// Covers the pure building blocks src/voice/sitrep.ts and src/announcementBus.ts landed for this
// step: the 6-tier priority board (composeExchangeBoard/rankExchangeBoard/renderExchangeBoard), the
// per-state terse narration line (terseExchangeOutcomeLine — shared by the board AND the live
// voice-session narration seam in src/voice/index.ts), the durable-attention sync
// (syncExchangeAttentionItems), and the exactly-once narration gate (ExchangeNarrationGate).
//
// Runner: npx tsx --test --test-force-exit tests/test_exchange_notifications.ts

import { describe, it } from "node:test";
import assert from "node:assert";

import { JanusStore } from "../src/store/sqliteStore";
import {
  composeExchangeBoard,
  rankExchangeBoard,
  renderExchangeBoard,
  terseExchangeOutcomeLine,
  syncExchangeAttentionItems,
  COMPLETION_WINDOW_MS,
  type ExchangeBoardItem,
} from "../src/voice/sitrep";
import { ExchangeNarrationGate, getExchangeNarrationGate, resetExchangeNarrationGateForTests } from "../src/announcementBus";
import type { ActionContext } from "../src/actions/types";
import type { AgentExchange } from "../src/exchanges/types";

function freshStore(): JanusStore {
  const s = new JanusStore(":memory:");
  s.init();
  return s;
}

/** Insert an exchange row directly in an arbitrary terminal-ish state (the storage layer performs
 *  no legality checking — see tests/test_exchange_store.ts's identical precedent). */
function seedExchange(store: JanusStore, patch: Partial<AgentExchange> & Pick<AgentExchange, "project_id" | "pane_id">): AgentExchange {
  return store.insertExchange(patch);
}

function makeCtx(opts: {
  store?: JanusStore | null;
  workspaces?: Record<string, any>;
  attentionQueue?: any[];
  approvals?: any[];
  actions?: any[];
  redact?: (s: string) => string;
} = {}): ActionContext {
  return {
    manager: {
      terminals: {},
      ledger: {
        workspaces: opts.workspaces ?? {},
        activeProjectId: "proj-1",
      },
      attentionQueue: opts.attentionQueue ?? [],
      settings: {},
    },
    session: null,
    redact: opts.redact ?? ((s: string) => s),
    pruneAttention: () => {},
    pendingApprovals: { forSession: () => opts.approvals ?? [] },
    pendingActions: { all: () => opts.actions ?? [] },
    store: opts.store ?? null,
  } as unknown as ActionContext;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1. terseExchangeOutcomeLine — per-state terse wording.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("terseExchangeOutcomeLine", () => {
  const identity = (s: string) => s;

  it("needs_input with a question text -> names it, quoted", () => {
    const line = terseExchangeOutcomeLine("build", "needs_input", "continue? y/n", null, identity);
    assert.strictEqual(line, `Pane 'build' needs your input: "continue? y/n"`);
  });

  it("needs_input with no question text -> a bare 'needs your input'", () => {
    const line = terseExchangeOutcomeLine("build", "needs_input", null, null, identity);
    assert.strictEqual(line, "Pane 'build' needs your input.");
  });

  it("agent_failed with detail -> names it", () => {
    const line = terseExchangeOutcomeLine("api", "agent_failed", "npm ERR! missing script", null, identity);
    assert.strictEqual(line, "Pane 'api' failed: npm ERR! missing script");
  });

  it("interrupted -> a fixed sentence (no detail column to draw from)", () => {
    const line = terseExchangeOutcomeLine("api", "interrupted", "some stale question", null, identity);
    assert.strictEqual(line, "Pane 'api' was interrupted.");
  });

  it("agent_complete WITH a meaningful summary -> names it", () => {
    const line = terseExchangeOutcomeLine("build", "agent_complete", null, "142 tests passing", identity);
    assert.strictEqual(line, "Pane 'build' finished: 142 tests passing");
  });

  it("agent_complete with NO summary -> null (nothing meaningful to narrate)", () => {
    const line = terseExchangeOutcomeLine("build", "agent_complete", null, null, identity);
    assert.strictEqual(line, null);
    const lineEmpty = terseExchangeOutcomeLine("build", "agent_complete", null, "", identity);
    assert.strictEqual(lineEmpty, null);
  });

  it("running/delivered -> a terse 'still working' line", () => {
    assert.strictEqual(terseExchangeOutcomeLine("api", "running", null, null, identity), "Pane 'api' is still working.");
    assert.strictEqual(terseExchangeOutcomeLine("api", "delivered", null, null, identity), "Pane 'api' is still working.");
  });

  it("a non-terse state (e.g. draft/staged) -> null", () => {
    assert.strictEqual(terseExchangeOutcomeLine("api", "draft", null, null, identity), null);
    assert.strictEqual(terseExchangeOutcomeLine("api", "staged", null, null, identity), null);
  });

  it("redacts + caps the question/detail/summary text through the injected redact fn", () => {
    const redact = (s: string) => s.replace("SECRET", "***");
    const line = terseExchangeOutcomeLine("build", "needs_input", "token=SECRET, proceed?", null, redact);
    assert.strictEqual(line, `Pane 'build' needs your input: "token=***, proceed?"`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2. composeExchangeBoard / rankExchangeBoard — 6-tier priority ordering with a mixed board.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("composeExchangeBoard + rankExchangeBoard — priority ordering", () => {
  it("empty world (no store) -> an empty board, so callers fall back to the legacy pipeline", () => {
    const ctx = makeCtx({ store: null });
    const board = composeExchangeBoard(ctx, 1000);
    assert.deepStrictEqual(board, []);
  });

  it("a store with no exchange rows at all -> still empty (approvals alone never trigger the board)", () => {
    const store = freshStore();
    const ctx = makeCtx({ store, approvals: [{ messageId: "m1", instruction: "run it", terminalId: "p1", timestamp: 500 }] });
    const board = composeExchangeBoard(ctx, 1000);
    assert.deepStrictEqual(board, []);
    store.close();
  });

  it("mixed board: needs_input, failed, complete, running, held approval, staged approval, and a recent decision — sorted tier 1..6", () => {
    const store = freshStore();
    const now = 1_000_000;
    // Tier 1a: needs_input.
    seedExchange(store, { project_id: "proj-1", pane_id: "p-ask", state: "needs_input", terminal_state: "continue? y/n", updated_at: now - 1000 });
    // Tier 2: failed.
    seedExchange(store, { project_id: "proj-1", pane_id: "p-fail", state: "agent_failed", terminal_state: "build broke", updated_at: now - 2000 });
    // Tier 3: meaningful complete.
    seedExchange(store, { project_id: "proj-1", pane_id: "p-done", state: "agent_complete", result_summary: "all green", updated_at: now - 3000 });
    // Tier 3 exclusion: complete with NO summary — never narrated.
    seedExchange(store, { project_id: "proj-1", pane_id: "p-done-quiet", state: "agent_complete", result_summary: null, updated_at: now - 3500 });
    // Tier 4: running.
    seedExchange(store, { project_id: "proj-1", pane_id: "p-run", state: "running", updated_at: now - 4000 });
    // Tier 6: a recent decision.
    const decided = seedExchange(store, { project_id: "proj-1", pane_id: "p-decided", state: "staged", updated_at: now - 5000 });
    store.appendExchangeEvent({ exchange_id: decided.exchange_id, event_type: "approval_confirmed", pane_id: "p-decided", project_id: "proj-1", ts: now - 60_000 });

    const ctx = makeCtx({
      store,
      // Older than the needs_input exchange (now - 1000) so tier 1's within-tier newest-first sort
      // still puts the needs_input question ahead of this held approval (asserted below).
      approvals: [{ messageId: "m1", instruction: "rm -rf tmp", terminalId: "p-write", timestamp: now - 10_000 }],
      actions: [{ id: "a1", capability: "delete_pane", summary: "delete pane p9" }],
    });
    const board = rankExchangeBoard(composeExchangeBoard(ctx, now));

    assert.deepStrictEqual(board.map((i) => i.tier), [1, 1, 2, 3, 4, 5, 6]);
    assert.deepStrictEqual(board.map((i) => i.kind), [
      "needs_input", "approval", "failed", "complete", "running", "approval", "decision",
    ]);
    // The quiet completion never appears at all.
    assert.ok(!board.some((i) => i.paneId === "p-done-quiet"));
    // Tier 1 contains BOTH the needs_input exchange and the held pane-write approval.
    const tier1 = board.filter((i) => i.tier === 1);
    assert.strictEqual(tier1.length, 2);
    store.close();
  });

  // Phase 5.5 (4.5 review B11): tier-3 completions are WINDOWED — an old completion falls off the
  // spoken board instead of re-surfacing on every SITREP until the 30-day store TTL prunes it.
  it("a completion older than COMPLETION_WINDOW_MS is excluded from the board; a recent one stays", () => {
    const store = freshStore();
    const now = 1_000_000_000;
    seedExchange(store, { project_id: "proj-1", pane_id: "p-stale", state: "agent_complete", result_summary: "old result", updated_at: now - COMPLETION_WINDOW_MS - 1 });
    seedExchange(store, { project_id: "proj-1", pane_id: "p-recent", state: "agent_complete", result_summary: "fresh result", updated_at: now - 1000 });
    const ctx = makeCtx({ store });
    const board = composeExchangeBoard(ctx, now);
    assert.deepStrictEqual(board.map((i) => i.paneId), ["p-recent"], "only the recent completion surfaces");
    store.close();
  });

  it("an ONLY-stale-completions world composes an empty board (callers fall back to the legacy pipeline)", () => {
    const store = freshStore();
    const now = 1_000_000_000;
    seedExchange(store, { project_id: "proj-1", pane_id: "p-stale", state: "agent_complete", result_summary: "old result", updated_at: now - COMPLETION_WINDOW_MS - 1 });
    const ctx = makeCtx({ store });
    assert.deepStrictEqual(composeExchangeBoard(ctx, now), []);
    store.close();
  });

  it("within a tier, items sort newest-updated first", () => {
    const store = freshStore();
    const now = 1_000_000;
    seedExchange(store, { project_id: "proj-1", pane_id: "p-old", state: "needs_input", terminal_state: "q1", updated_at: now - 10_000 });
    seedExchange(store, { project_id: "proj-1", pane_id: "p-new", state: "needs_input", terminal_state: "q2", updated_at: now - 100 });
    const ctx = makeCtx({ store });
    const board = rankExchangeBoard(composeExchangeBoard(ctx, now));
    assert.deepStrictEqual(board.map((i) => i.paneId), ["p-new", "p-old"]);
    store.close();
  });

  it("renderExchangeBoard joins each item's terse text with a single space", () => {
    const items: ExchangeBoardItem[] = [
      { tier: 1, kind: "needs_input", exchangeId: "e1", paneId: "p1", projectId: "proj-1", text: "Pane 'p1' needs your input.", updatedAt: 0 },
      { tier: 2, kind: "failed", exchangeId: "e2", paneId: "p2", projectId: "proj-1", text: "Pane 'p2' failed.", updatedAt: 0 },
    ];
    assert.strictEqual(renderExchangeBoard(items), "Pane 'p1' needs your input. Pane 'p2' failed.");
  });

  it("resolves the pane display name off the ledger, redacted, when a workspace name is recorded", () => {
    const store = freshStore();
    const now = 1_000;
    seedExchange(store, { project_id: "proj-1", pane_id: "p1", state: "needs_input", terminal_state: "go?", updated_at: now });
    const redact = (s: string) => s.replace("SECRET", "***");
    const ctx = makeCtx({
      store,
      workspaces: { "proj-1": { panes: { p1: { name: "build-SECRET-pane" } } } },
      redact,
    });
    const board = composeExchangeBoard(ctx, now);
    assert.strictEqual(board[0].text, `Pane 'build-***-pane' needs your input: "go?"`);
    store.close();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3. syncExchangeAttentionItems — durable attention items carrying exchange_id in details.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("syncExchangeAttentionItems", () => {
  it("pushes one attention item per needs_input/failed/complete board entry, carrying exchange_id", () => {
    const queue: any[] = [];
    const ctx = makeCtx({ attentionQueue: queue });
    const board: ExchangeBoardItem[] = [
      { tier: 1, kind: "needs_input", exchangeId: "ex1", paneId: "p1", projectId: "proj-1", text: "Pane 'p1' needs your input.", updatedAt: 0 },
      { tier: 2, kind: "failed", exchangeId: "ex2", paneId: "p2", projectId: "proj-1", text: "Pane 'p2' failed.", updatedAt: 0 },
      { tier: 3, kind: "complete", exchangeId: "ex3", paneId: "p3", projectId: "proj-1", text: "Pane 'p3' finished: ok", updatedAt: 0 },
      { tier: 4, kind: "running", exchangeId: "ex4", paneId: "p4", projectId: "proj-1", text: "Pane 'p4' is still working.", updatedAt: 0 },
      { tier: 5, kind: "approval", exchangeId: null, paneId: null, projectId: null, text: "A staged action...", updatedAt: 0 },
    ];
    syncExchangeAttentionItems(ctx, board, 5000);
    assert.strictEqual(queue.length, 3, "needs_input/failed/complete get attention items; running/approval do not");
    assert.deepStrictEqual(queue.map((q) => q.type), ["needs_input", "error", "idle"]);
    assert.deepStrictEqual(queue.map((q) => q.details.exchange_id), ["ex1", "ex2", "ex3"]);
    assert.ok(queue.every((q) => q.dismissed === false));
  });

  it("is idempotent: a repeated sync for the SAME exchange+kind never duplicates a non-dismissed item", () => {
    const queue: any[] = [];
    const ctx = makeCtx({ attentionQueue: queue });
    const item: ExchangeBoardItem = { tier: 1, kind: "needs_input", exchangeId: "ex1", paneId: "p1", projectId: "proj-1", text: "t", updatedAt: 0 };
    syncExchangeAttentionItems(ctx, [item], 1000);
    syncExchangeAttentionItems(ctx, [item], 2000);
    syncExchangeAttentionItems(ctx, [item], 3000);
    assert.strictEqual(queue.length, 1);
  });

  it("a DISMISSED prior item does not block a fresh push for the same exchange+kind", () => {
    const queue: any[] = [{
      id: "att_1", type: "needs_input", terminalId: "p1", projectId: "proj-1",
      message: "old", timestamp: new Date(0).toISOString(), dismissed: true,
      details: { exchange_id: "ex1", kind: "needs_input" },
    }];
    const ctx = makeCtx({ attentionQueue: queue });
    const item: ExchangeBoardItem = { tier: 1, kind: "needs_input", exchangeId: "ex1", paneId: "p1", projectId: "proj-1", text: "t2", updatedAt: 0 };
    syncExchangeAttentionItems(ctx, [item], 5000);
    assert.strictEqual(queue.length, 2);
    assert.strictEqual(queue[1].dismissed, false);
  });

  // Phase 5.5 (4.5 review B11): COMPLETION items are minted exactly once per (exchange, updated_at)
  // anchor — a dismissed/TTL-pruned "finished" item is never re-minted for the same settled result,
  // while a genuinely NEW completion (fresh updated_at) still mints fresh.
  it("a COMPLETION whose item was dismissed or pruned is NOT re-minted for the same updated_at anchor", () => {
    resetExchangeNarrationGateForTests();
    const queue: any[] = [];
    const ctx = makeCtx({ attentionQueue: queue });
    const item: ExchangeBoardItem = { tier: 3, kind: "complete", exchangeId: "ex-done", paneId: "p1", projectId: "proj-1", text: "Pane 'p1' finished: ok", updatedAt: 42_000 };
    syncExchangeAttentionItems(ctx, [item], 50_000);
    assert.strictEqual(queue.length, 1, "first sync mints");
    queue.length = 0; // TTL prune / dismissal-sweep removed it entirely
    syncExchangeAttentionItems(ctx, [item], 60_000);
    assert.strictEqual(queue.length, 0, "same settled completion never re-mints");
    // A NEW completion on the same exchange (fresh transition => fresh updated_at) mints again.
    syncExchangeAttentionItems(ctx, [{ ...item, updatedAt: 99_000 }], 70_000);
    assert.strictEqual(queue.length, 1, "a fresh anchor is a fresh mint");
    resetExchangeNarrationGateForTests();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4. ExchangeNarrationGate — exactly-once narration across repeated edges + reconnect.
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("ExchangeNarrationGate — exactly-once (exchange_id, event_type, narration-id)", () => {
  it("the FIRST call for a triple narrates; every REPEAT of the exact same triple does not", () => {
    const gate = new ExchangeNarrationGate();
    assert.strictEqual(gate.shouldNarrate("ex1", "needs_input", 1000), true);
    assert.strictEqual(gate.shouldNarrate("ex1", "needs_input", 1000), false, "same anchor -> no re-narrate");
    assert.strictEqual(gate.shouldNarrate("ex1", "needs_input", 1000), false, "still no re-narrate on a 3rd repeat");
  });

  it("a repeated terminal edge that does NOT change exchange state (same anchor) never re-announces", () => {
    // Mirrors the real contract: persistTransition only advances `updated_at` on a genuine CAS-won
    // transition, so a repeated pane edge with an unchanged exchange row carries the SAME anchor.
    const gate = new ExchangeNarrationGate();
    const anchor = 42_000; // stand-in for the exchange's unchanged updated_at
    assert.strictEqual(gate.shouldNarrate("ex1", "agent_failed", anchor), true);
    // Three more identical edges (e.g. the pane keeps re-printing the same error line).
    assert.strictEqual(gate.shouldNarrate("ex1", "agent_failed", anchor), false);
    assert.strictEqual(gate.shouldNarrate("ex1", "agent_failed", anchor), false);
    assert.strictEqual(gate.shouldNarrate("ex1", "agent_failed", anchor), false);
  });

  it("a GENUINE new transition (a fresh anchor) narrates again even for the same exchange+state label", () => {
    const gate = new ExchangeNarrationGate();
    assert.strictEqual(gate.shouldNarrate("ex1", "needs_input", 1000), true);
    // e.g. needs_input -> running -> needs_input again (a second, later question) carries a NEW
    // updated_at, which is a legitimately fresh thing to say.
    assert.strictEqual(gate.shouldNarrate("ex1", "needs_input", 2000), true);
  });

  it("different exchanges (or different event types on the same exchange) never collide", () => {
    const gate = new ExchangeNarrationGate();
    assert.strictEqual(gate.shouldNarrate("ex1", "needs_input", 1000), true);
    assert.strictEqual(gate.shouldNarrate("ex2", "needs_input", 1000), true, "different exchange -> independent");
    assert.strictEqual(gate.shouldNarrate("ex1", "agent_failed", 1000), true, "different event type -> independent");
  });

  it("a client RECONNECT within the same process does not reset the gate (no re-announce)", () => {
    // A WS reconnect never restarts the node process — the gate is a process-lifetime singleton
    // (getExchangeNarrationGate), so its memory naturally survives a reconnect. Simulated here by
    // simply calling shouldNarrate again without any reset in between.
    const gate = new ExchangeNarrationGate();
    assert.strictEqual(gate.shouldNarrate("ex1", "needs_input", 1000), true);
    // "reconnect" — no gate.reset() call, exactly like a real WS drop/resume.
    assert.strictEqual(gate.shouldNarrate("ex1", "needs_input", 1000), false);
  });

  it("reset() clears all memory (mirrors what a real process restart implies)", () => {
    const gate = new ExchangeNarrationGate();
    assert.strictEqual(gate.shouldNarrate("ex1", "needs_input", 1000), true);
    gate.reset();
    assert.strictEqual(gate.shouldNarrate("ex1", "needs_input", 1000), true, "post-reset, the same triple narrates again");
  });

  it("the process-lifetime singleton accessor returns the SAME instance across calls", () => {
    resetExchangeNarrationGateForTests();
    const a = getExchangeNarrationGate();
    const b = getExchangeNarrationGate();
    assert.strictEqual(a, b);
    assert.strictEqual(a.shouldNarrate("ex1", "needs_input", 1), true);
    assert.strictEqual(b.shouldNarrate("ex1", "needs_input", 1), false, "shared state through the singleton");
    resetExchangeNarrationGateForTests();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5. Terse spoken shape (voice terseness contract).
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("voice terseness — one clause per item, no evidence/instruction dump", () => {
  it("a board item's text is a single short clause, never multi-sentence detail", () => {
    const store = freshStore();
    seedExchange(store, {
      project_id: "proj-1", pane_id: "p1", state: "agent_failed",
      terminal_state: "npm ERR! missing script: build", updated_at: 1000,
    });
    const ctx = makeCtx({ store });
    const board = composeExchangeBoard(ctx, 1000);
    assert.strictEqual(board.length, 1);
    // One clause: "Pane '<x>' failed: <detail>" — no embedded newlines, no evidence array dump.
    assert.ok(!board[0].text.includes("\n"));
    assert.ok(board[0].text.startsWith("Pane 'p1' failed:"));
    store.close();
  });

  it("long terminal_state / result_summary text is capped, never spoken verbatim past the cap", () => {
    const store = freshStore();
    const longQuestion = "y".repeat(500);
    seedExchange(store, { project_id: "proj-1", pane_id: "p1", state: "needs_input", terminal_state: longQuestion, updated_at: 1000 });
    const ctx = makeCtx({ store });
    const board = composeExchangeBoard(ctx, 1000);
    assert.ok(board[0].text.length < longQuestion.length, "the spoken line is capped well under the raw text length");
    store.close();
  });
});
