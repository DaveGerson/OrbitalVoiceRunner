// Characterization tests for the cyclomatic-complexity burndown of src/ledger.ts.
// These pin the CURRENT observable behavior of Ledger.getNotes (and the legacy synthetic-id
// shape it produces) so the verbatim, behavior-preserving extraction cannot drift. Every branch
// of getNotes is exercised: project-id filter on/off, missing workspace skip, pane-id filter
// on/off, the project-level (pane_id=null) note row, per-pane rows, type filter, and the
// newest-first ordering (created_at == positional index).
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "fs";
import { Ledger } from "../src/ledger";
import { PaneMeta } from "../src/types";

const TEST_STORAGE = ".janus_ledger_cx_refactor_test.json";

const mkPane = (id: string, notes: string[] = []): PaneMeta => ({
  pane_id: id, name: id, runtime_type: "shell", last_known_state: "Idle",
  is_busy: false, alive: true, notes, permissions_mode: "Human-in-the-Loop",
  session_id: "", tool_preset: "Claude Code", context_size: 0,
});

describe("Ledger.getNotes characterization (complexity refactor)", () => {
  let ledger: Ledger;

  beforeEach(() => {
    if (fs.existsSync(TEST_STORAGE)) fs.unlinkSync(TEST_STORAGE);
    ledger = new Ledger(TEST_STORAGE);
  });
  afterEach(() => {
    if (fs.existsSync(TEST_STORAGE)) fs.unlinkSync(TEST_STORAGE);
  });

  it("returns [] when there are no workspaces", () => {
    assert.deepStrictEqual(ledger.getNotes(), []);
    assert.deepStrictEqual(ledger.getNotes({}), []);
    assert.deepStrictEqual(ledger.getNotes({ projectId: "ghost" }), []);
  });

  it("projects flat project-level notes into synthetic legacy rows (newest-first)", () => {
    ledger.addProject("proj_a", "/a");
    ledger.addNote("proj_a", "first");
    ledger.addNote("proj_a", "second");

    const rows = ledger.getNotes({ projectId: "proj_a" });
    assert.strictEqual(rows.length, 2);
    // newest-first: created_at == index, so index 1 sorts before index 0.
    assert.strictEqual(rows[0].text, "second");
    assert.strictEqual(rows[0].id, "legacy:proj_a::1");
    assert.strictEqual(rows[0].created_at, 1);
    assert.strictEqual(rows[0].updated_at, 1);
    assert.strictEqual(rows[0].project_id, "proj_a");
    assert.strictEqual(rows[0].pane_id, null);
    assert.strictEqual(rows[0].type, "note");
    assert.strictEqual(rows[0].author, "user");
    assert.strictEqual(rows[1].text, "first");
    assert.strictEqual(rows[1].id, "legacy:proj_a::0");
  });

  it("includes per-pane notes with pane_id-bearing synthetic ids", () => {
    ledger.addProject("proj_a", "/a");
    ledger.updatePane("proj_a", mkPane("pane_x", ["pnote0", "pnote1"]));

    const rows = ledger.getNotes({ projectId: "proj_a" });
    const paneRows = rows.filter((r) => r.pane_id === "pane_x");
    assert.strictEqual(paneRows.length, 2);
    const ids = paneRows.map((r) => r.id).sort();
    assert.deepStrictEqual(ids, ["legacy:proj_a:pane_x:0", "legacy:proj_a:pane_x:1"]);
  });

  it("with no projectId filter, sweeps all workspaces", () => {
    ledger.addProject("proj_a", "/a");
    ledger.addProject("proj_b", "/b");
    ledger.addNote("proj_a", "a-note");
    ledger.addNote("proj_b", "b-note");

    const all = ledger.getNotes();
    const texts = all.map((r) => r.text).sort();
    assert.deepStrictEqual(texts, ["a-note", "b-note"]);
    const projIds = new Set(all.map((r) => r.project_id));
    assert.deepStrictEqual([...projIds].sort(), ["proj_a", "proj_b"]);
  });

  it("paneId filter excludes project-level notes and non-matching panes", () => {
    ledger.addProject("proj_a", "/a");
    ledger.addNote("proj_a", "project-level"); // must be EXCLUDED when paneId set
    ledger.updatePane("proj_a", mkPane("pane_x", ["x0"]));
    ledger.updatePane("proj_a", mkPane("pane_y", ["y0", "y1"]));

    const rows = ledger.getNotes({ projectId: "proj_a", paneId: "pane_x" });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].text, "x0");
    assert.strictEqual(rows[0].pane_id, "pane_x");
    // No project-level (pane_id=null) row, no pane_y rows.
    assert.strictEqual(rows.every((r) => r.pane_id === "pane_x"), true);
  });

  it("paneId filter works without projectId (sweeps all workspaces for the pane)", () => {
    ledger.addProject("proj_a", "/a");
    ledger.addProject("proj_b", "/b");
    ledger.addNote("proj_a", "proj-a-level");
    ledger.updatePane("proj_a", mkPane("shared", ["from-a"]));
    ledger.updatePane("proj_b", mkPane("shared", ["from-b0", "from-b1"]));

    const rows = ledger.getNotes({ paneId: "shared" });
    // Both workspaces contribute their "shared" pane; no project-level rows.
    assert.strictEqual(rows.every((r) => r.pane_id === "shared"), true);
    const texts = rows.map((r) => r.text).sort();
    assert.deepStrictEqual(texts, ["from-a", "from-b0", "from-b1"]);
  });

  it("type filter keeps only matching rows (all legacy rows are type 'note')", () => {
    ledger.addProject("proj_a", "/a");
    ledger.addNote("proj_a", "n");
    assert.strictEqual(ledger.getNotes({ projectId: "proj_a", type: "note" }).length, 1);
    assert.strictEqual(ledger.getNotes({ projectId: "proj_a", type: "event" }).length, 0);
  });

  it("orders the full mixed result newest-first by created_at", () => {
    ledger.addProject("proj_a", "/a");
    ledger.addNote("proj_a", "p0");
    ledger.addNote("proj_a", "p1");
    ledger.updatePane("proj_a", mkPane("pane_x", ["x0", "x1", "x2"]));

    const rows = ledger.getNotes({ projectId: "proj_a" });
    // Verify non-increasing created_at ordering (the documented "newest-first" contract).
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i - 1].created_at >= rows[i].created_at,
        `row ${i - 1} created_at ${rows[i - 1].created_at} should be >= row ${i} ${rows[i].created_at}`);
    }
  });

  it("tolerates a pane with undefined notes (?? [] path)", () => {
    ledger.addProject("proj_a", "/a");
    const pane = mkPane("pane_x");
    // Force the notes-absent branch.
    delete (pane as { notes?: string[] }).notes;
    ledger.updatePane("proj_a", pane);
    const rows = ledger.getNotes({ projectId: "proj_a", paneId: "pane_x" });
    assert.deepStrictEqual(rows, []);
  });

  it("search() (which consumes getNotes) still surfaces matching notes", () => {
    ledger.addProject("proj_a", "/a");
    ledger.addNote("proj_a", "Use Python 3.11");
    ledger.addNote("proj_a", "Test driven development");
    const hits = ledger.search("python");
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].snippet, "Use Python 3.11");
    assert.strictEqual(hits[0].source, "note");
    assert.strictEqual(hits[0].id, "legacy:proj_a::0");
  });
});
