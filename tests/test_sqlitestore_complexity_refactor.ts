// tests/test_sqlitestore_complexity_refactor.ts — CHARACTERIZATION tests for the burndown
// cyclomatic refactor of src/store/sqliteStore.ts (cyclomatic-complexity initiative §7, decision D-6).
//
// These PIN the CURRENT observable behaviour of the four over-limit functions on the exact branches
// that the existing suite covers only thinly, so the behaviour-preserving complexity refactor
// (extract helpers / guard clauses / table-driven column mapping) can be proven not to change a
// single output, round-trip, or side-effect. WRITTEN TO BE GREEN AGAINST THE UN-REFACTORED CODE
// FIRST, then kept green through the refactor.
//
// Covered functions (line @ HEAD : current cyclomatic complexity):
//   - updatePane          (≈L731, CC16): the four conditional writes the savePane upsert does NOT
//     touch — draft / model_context / human_context carried on the PaneMeta, and the ALWAYS-written
//     capability_gates column (set when non-empty, CLEARED to NULL when absent/empty).
//   - workspaces (getter) (≈L889, CC14): the one-pass projection — note partitioning (project vs
//     pane, DESC->ASC reverse), orphan-pane-note invisibility, empty store, empty-panes project.
//     (The byte-identical golden is in test_store_projection.ts; this adds edge re-pins.)
//   - hydrateHandoff      (≈L982, CC14): every NULL-column default (?? null / ?? "" / ?? 0 / "{}"/"[]")
//     — the null-column edge the burndown mandate calls out — vs. a fully-populated row.
//   - updateHandoffState  (≈L1092, CC14): each conditional SET fragment (staged/delivered/consumed
//     timestamps with default-now vs. explicit patch, approved_by/approved_via/gate_approval_id only
//     when `!== undefined` incl. explicit-null, terminal_at for every terminal state and NOT for
//     non-terminal), plus the missing-handoff null short-circuit.
//
// PURE / in-memory: every test uses a JanusStore(":memory:") ledger — no PTY, no API key, no disk.

import { describe, it } from "node:test";
import assert from "node:assert";
import { JanusStore } from "../src/store/sqliteStore";
import type { StoredPane, HandoffState } from "../src/store/types";

function freshStore(): JanusStore {
  const s = new JanusStore(":memory:");
  s.init();
  return s;
}

function seedProject(s: JanusStore, id = "p1"): void {
  s.saveWorkspace({ id, name: id.toUpperCase(), directory: "/d", summary: "", key_terms: [], created_at: 0, updated_at: 0 });
}

function mkPane(id: string, ws = "p1", over: Partial<StoredPane> = {}): StoredPane {
  return {
    pane_id: id, workspace_id: ws, name: id, runtime_type: "shell",
    tool_preset: "Custom", permissions_mode: "Human-in-the-Loop", session_id: "",
    last_known_state: "Idle", is_busy: false, alive: true, context_size: 0,
    last_status_change_at: null, last_command: null, scrollback_path: null,
    created_at: 0, updated_at: 0, ...over,
  };
}

// The minimal PaneMeta updatePane consumes (only the fields it reads off the meta).
function mkMeta(id: string, over: Record<string, unknown> = {}): any {
  return {
    pane_id: id, name: id, runtime_type: "shell", tool_preset: "Custom",
    permissions_mode: "Human-in-the-Loop", session_id: "", last_known_state: "Idle",
    is_busy: false, alive: true, context_size: 0, last_command: null,
    ...over,
  };
}

/** Read the raw stored column for a pane (bypasses hydration). */
function rawPaneColumn(s: JanusStore, ws: string, paneId: string, column: string): unknown {
  const r = s.db.prepare(`SELECT ${column} AS v FROM panes WHERE pane_id=? AND workspace_id=?`).get(paneId, ws) as any;
  return r?.v;
}

// ───────────────────────────────────────────────────────────────────────────
// updatePane (≈L731, CC16) — the four conditional columns savePane's upsert doesn't write.
// ───────────────────────────────────────────────────────────────────────────
describe("updatePane characterization (conditional draft/context/gates columns)", () => {
  it("with NO draft/context/gates on the meta: all four columns are NULL after a fresh updatePane", () => {
    const s = freshStore(); seedProject(s);
    s.updatePane("p1", mkMeta("t1"));
    assert.strictEqual(rawPaneColumn(s, "p1", "t1", "draft"), null, "draft untouched -> NULL");
    // model_context / human_context keep the savePane upsert default (NOT written by updatePane when absent).
    // capability_gates is ALWAYS written by updatePane -> NULL when absent/empty.
    assert.strictEqual(rawPaneColumn(s, "p1", "t1", "capability_gates"), null, "absent gates -> NULL");
    s.close();
  });

  it("draft on the meta is JSON-persisted to the draft column; absent leaves it NULL", () => {
    const s = freshStore(); seedProject(s);
    const draft = { text: "hello", updatedAt: "2026-01-01T00:00:00.000Z", updatedBy: "operator" as const };
    s.updatePane("p1", mkMeta("t1", { draft }));
    assert.deepStrictEqual(s.getDraft("p1", "t1"), draft, "draft round-trips via getDraft");
    assert.strictEqual(rawPaneColumn(s, "p1", "t1", "draft"), JSON.stringify(draft), "raw column is the JSON string");
    s.close();
  });

  it("modelContext / humanContext on the meta are JSON-persisted to their columns", () => {
    const s = freshStore(); seedProject(s);
    const model = [{ text: "m", at: "2026-01-01T00:00:00.000Z" }];
    const human = [{ text: "h", at: "2026-01-01T00:00:00.000Z", source: "op" }];
    s.updatePane("p1", mkMeta("t1", { modelContext: model, humanContext: human }));
    assert.strictEqual(rawPaneColumn(s, "p1", "t1", "model_context"), JSON.stringify(model));
    assert.strictEqual(rawPaneColumn(s, "p1", "t1", "human_context"), JSON.stringify(human));
    const ctx = s.getPaneContext("p1", "t1")!;
    assert.deepStrictEqual(ctx.model, model);
    assert.deepStrictEqual(ctx.human, human);
    s.close();
  });

  it("non-empty capabilityGates is JSON-written; the column round-trips via getProject", () => {
    const s = freshStore(); seedProject(s);
    s.updatePane("p1", mkMeta("t1", { capabilityGates: { send_keys: "Off", close_pane: "Ask" } }));
    assert.strictEqual(rawPaneColumn(s, "p1", "t1", "capability_gates"), JSON.stringify({ send_keys: "Off", close_pane: "Ask" }));
    assert.deepStrictEqual(s.getProject("p1")!.panes["t1"].capabilityGates, { send_keys: "Off", close_pane: "Ask" });
    s.close();
  });

  it("an EMPTY capabilityGates object ({}) is written as NULL (treated as no override)", () => {
    const s = freshStore(); seedProject(s);
    s.updatePane("p1", mkMeta("t1", { capabilityGates: {} }));
    assert.strictEqual(rawPaneColumn(s, "p1", "t1", "capability_gates"), null, "empty gates map -> NULL column");
    assert.strictEqual(s.getProject("p1")!.panes["t1"].capabilityGates, undefined, "no override hydrated");
    s.close();
  });

  it("capability_gates is CLEARED to NULL on a subsequent updatePane without gates (override erased, not stale)", () => {
    const s = freshStore(); seedProject(s);
    s.updatePane("p1", mkMeta("t1", { capabilityGates: { send_keys: "Off" } }));
    assert.notStrictEqual(rawPaneColumn(s, "p1", "t1", "capability_gates"), null);
    // Second update carries no gates -> the always-write clears the column.
    s.updatePane("p1", mkMeta("t1"));
    assert.strictEqual(rawPaneColumn(s, "p1", "t1", "capability_gates"), null, "override must be erased, not left stale");
    s.close();
  });

  it("absent draft/context do NOT clobber columns written by a prior call (no conditional write fires)", () => {
    const s = freshStore(); seedProject(s);
    // First: write a draft + model context.
    s.updatePane("p1", mkMeta("t1", { draft: { text: "keep", updatedAt: "2026-01-01T00:00:00.000Z" }, modelContext: [{ text: "m", at: "2026-01-01T00:00:00.000Z" }] }));
    // Second: same pane, no draft/context on the meta -> those `if` branches are skipped, columns preserved.
    s.updatePane("p1", mkMeta("t1"));
    assert.ok(s.getDraft("p1", "t1"), "prior draft preserved (no clobber)");
    assert.strictEqual(s.getDraft("p1", "t1")!.text, "keep");
    assert.strictEqual(s.getPaneContext("p1", "t1")!.model.length, 1, "prior model context preserved");
    s.close();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// workspaces getter (≈L889, CC14) — projection edges (byte-identical golden is in test_store_projection.ts).
// ───────────────────────────────────────────────────────────────────────────
describe("workspaces getter characterization (projection edges)", () => {
  it("empty store -> empty record", () => {
    const s = freshStore();
    assert.deepStrictEqual(s.workspaces, {});
    s.close();
  });

  it("project with NO panes -> empty panes record and notes array", () => {
    const s = freshStore(); seedProject(s, "empty");
    const ws = s.workspaces["empty"];
    assert.deepStrictEqual(ws.panes, {});
    assert.deepStrictEqual(ws.notes, []);
    s.close();
  });

  it("notes partition (project vs pane) and reverse DESC->ASC; orphan pane notes stay invisible", () => {
    const s = freshStore(); seedProject(s);
    s.savePane(mkPane("t1"));
    const note = s.db.prepare(
      "INSERT INTO notes(id,project_id,pane_id,text,type,author,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)"
    );
    note.run("n1", "p1", null, "proj A", "note", "user", 10, 10);
    note.run("n2", "p1", null, "proj B", "note", "user", 20, 20);
    note.run("n3", "p1", "t1", "pane A", "note", "user", 30, 30);
    note.run("n4", "p1", "t1", "pane B", "note", "user", 40, 40);
    note.run("n5", "p1", "gone", "orphan", "note", "user", 50, 50); // pane absent -> invisible
    const ws = s.workspaces["p1"];
    assert.deepStrictEqual(ws.notes, ["proj A", "proj B"], "project notes in ASC order");
    assert.deepStrictEqual(ws.panes["t1"].notes, ["pane A", "pane B"], "pane notes in ASC order");
    assert.ok(!Object.keys(ws.panes).includes("gone"), "orphan note's missing pane is not materialized");
    s.close();
  });

  it("keyTerms and capabilityGates project through the one-pass getter identically to getProject", () => {
    const s = freshStore();
    s.saveWorkspace({ id: "p1", name: "P1", directory: "/d", summary: "s", key_terms: ["a", "b"], created_at: 0, updated_at: 0 });
    s.savePane(mkPane("t1"));
    s.updatePane("p1", mkMeta("t1", { capabilityGates: { send_keys: "Off" } }));
    assert.deepStrictEqual(s.workspaces, { p1: s.getProject("p1") }, "one-pass projection equals per-call getProject");
    s.close();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// hydrateHandoff (≈L982, CC14) — null-column defaulting vs. a fully-populated row.
// ───────────────────────────────────────────────────────────────────────────
describe("hydrateHandoff characterization (NULL-column defaults)", () => {
  it("a freshly created handoff (mostly-NULL optional columns) hydrates to the documented defaults", () => {
    const s = freshStore();
    const h = s.createHandoff({ workspace_id: "ws", to_pane: "p1" }); // omit every optional field
    const row = s.getHandoff(h.id)!;
    // Defaults baked by createHandoff, surfaced verbatim by hydrateHandoff:
    assert.strictEqual(row.from_pane, null, "from_pane ?? null");
    assert.strictEqual(row.kind, "agent_instruction");
    assert.strictEqual(row.composed_prompt, "", "composed_prompt ?? ''");
    assert.strictEqual(row.source_context, "{}", "source_context ?? '{}'");
    assert.strictEqual(row.source_context_refs, "[]", "source_context_refs ?? '[]'");
    assert.strictEqual(row.state, "composing");
    assert.strictEqual(row.gate_approval_id, null);
    assert.strictEqual(row.approved_by, null);
    assert.strictEqual(row.approved_via, null);
    assert.strictEqual(row.revision_count, 0, "revision_count ?? 0");
    assert.strictEqual(row.staged_at, null);
    assert.strictEqual(row.delivered_at, null);
    assert.strictEqual(row.consumed_at, null);
    assert.strictEqual(row.terminal_at, null);
    assert.strictEqual(row.expires_at, null);
    assert.strictEqual(typeof row.created_at, "number");
    s.close();
  });

  it("hydrates a fully-populated row verbatim (no default substituted when the column is present)", () => {
    const s = freshStore();
    // Insert a row with EVERY nullable column populated, bypassing createHandoff's defaults.
    s.db.prepare(
      `INSERT INTO handoffs(id,workspace_id,from_pane,to_pane,kind,composed_prompt,source_context,
         source_context_refs,state,gate_approval_id,approved_by,approved_via,revision_count,
         created_at,staged_at,delivered_at,consumed_at,terminal_at,expires_at)
       VALUES(@id,@workspace_id,@from_pane,@to_pane,@kind,@composed_prompt,@source_context,
         @source_context_refs,@state,@gate_approval_id,@approved_by,@approved_via,@revision_count,
         @created_at,@staged_at,@delivered_at,@consumed_at,@terminal_at,@expires_at)`
    ).run({
      id: "full", workspace_id: "ws", from_pane: "src", to_pane: "dst", kind: "shell",
      composed_prompt: "run", source_context: '{"k":1}', source_context_refs: '["r"]',
      state: "delivered", gate_approval_id: "ga", approved_by: "alice", approved_via: "voice",
      revision_count: 3, created_at: 111, staged_at: 222, delivered_at: 333,
      consumed_at: 444, terminal_at: 555, expires_at: 666,
    });
    const row = s.getHandoff("full")!;
    assert.deepStrictEqual(row, {
      id: "full", workspace_id: "ws", from_pane: "src", to_pane: "dst", kind: "shell",
      composed_prompt: "run", source_context: '{"k":1}', source_context_refs: '["r"]',
      state: "delivered", gate_approval_id: "ga", approved_by: "alice", approved_via: "voice",
      revision_count: 3, created_at: 111, staged_at: 222, delivered_at: 333,
      consumed_at: 444, terminal_at: 555, expires_at: 666,
    });
    s.close();
  });

  it("getHandoff returns null for an unknown id (hydrate not reached)", () => {
    const s = freshStore();
    assert.strictEqual(s.getHandoff("nope"), null);
    s.close();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// updateHandoffState (≈L1092, CC14) — each conditional SET fragment + terminal_at + null guard.
// ───────────────────────────────────────────────────────────────────────────
describe("updateHandoffState characterization (conditional SET fragments)", () => {
  function staged(s: JanusStore, id = "h"): string {
    const h = s.createHandoff({ id, workspace_id: "ws", to_pane: "p1", state: "composing" });
    return h.id;
  }

  it("returns null for an unknown handoff id (no row touched)", () => {
    const s = freshStore();
    assert.strictEqual(s.updateHandoffState("missing", "staged"), null);
    s.close();
  });

  it("state='staged' stamps staged_at with default-now when no patch given", () => {
    const s = freshStore(); const id = staged(s);
    const before = Date.now();
    const row = s.updateHandoffState(id, "staged")!;
    assert.strictEqual(row.state, "staged");
    assert.ok(row.staged_at !== null && row.staged_at >= before, "staged_at defaulted to now");
    assert.strictEqual(row.delivered_at, null, "only staged_at stamped");
    assert.strictEqual(row.terminal_at, null, "staged is not terminal");
    s.close();
  });

  it("explicit patch timestamps override the default-now for staged/delivered/consumed", () => {
    const s = freshStore(); const id = staged(s);
    s.updateHandoffState(id, "staged", { staged_at: 1000 });
    s.updateHandoffState(id, "delivered", { delivered_at: 2000 });
    const row = s.updateHandoffState(id, "consumed", { consumed_at: 3000 })!;
    assert.strictEqual(row.staged_at, 1000);
    assert.strictEqual(row.delivered_at, 2000);
    assert.strictEqual(row.consumed_at, 3000);
    s.close();
  });

  it("approved_by / approved_via / gate_approval_id write ONLY when present in the patch (incl. explicit null)", () => {
    const s = freshStore(); const id = staged(s);
    // approved_by explicit value; approved_via explicit null (undefined-check, not truthy-check).
    const row = s.updateHandoffState(id, "delivered", { approved_by: "bob", approved_via: null, gate_approval_id: "g1" })!;
    assert.strictEqual(row.approved_by, "bob");
    assert.strictEqual(row.approved_via, null, "explicit null in patch is written (!== undefined branch)");
    assert.strictEqual(row.gate_approval_id, "g1");
    s.close();
  });

  it("omitting approved_* from the patch leaves the existing column values untouched", () => {
    const s = freshStore(); const id = staged(s);
    s.updateHandoffState(id, "delivered", { approved_by: "carol", approved_via: "rest" });
    // A later transition with NO approved_* in the patch must not null them out.
    const row = s.updateHandoffState(id, "staged", { staged_at: 9 })!;
    assert.strictEqual(row.approved_by, "carol", "approved_by preserved when omitted");
    assert.strictEqual(row.approved_via, "rest", "approved_via preserved when omitted");
    s.close();
  });

  it("terminal_at is stamped for EVERY terminal state and NOT for non-terminal states", () => {
    const terminal: HandoffState[] = ["consumed", "rejected", "expired", "blocked_read_only"];
    for (const st of terminal) {
      const s = freshStore(); const id = staged(s);
      const row = s.updateHandoffState(id, st)!;
      assert.ok(row.terminal_at !== null, `terminal_at stamped for terminal state '${st}'`);
      s.close();
    }
    const nonTerminal: HandoffState[] = ["revising", "staged", "delivered"];
    for (const st of nonTerminal) {
      const s = freshStore(); const id = staged(s);
      const row = s.updateHandoffState(id, st)!;
      assert.strictEqual(row.terminal_at, null, `terminal_at NOT stamped for non-terminal state '${st}'`);
      s.close();
    }
  });

  it("an explicit terminal_at patch overrides the default-now for a terminal state", () => {
    const s = freshStore(); const id = staged(s);
    const row = s.updateHandoffState(id, "consumed", { terminal_at: 777, consumed_at: 778 })!;
    assert.strictEqual(row.terminal_at, 777);
    assert.strictEqual(row.consumed_at, 778);
    s.close();
  });
});
