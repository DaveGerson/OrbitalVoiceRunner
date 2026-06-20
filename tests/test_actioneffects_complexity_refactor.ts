// tests/test_actioneffects_complexity_refactor.ts — CHARACTERIZATION tests for the cyclomatic-
// complexity burndown refactor of src/actionEffects.ts (the intent ⇄ run registry that rebuilds a
// deferred action's side effect from its persisted INTENT). These pin the CURRENT side-effect
// ORDERING, ledger calls, broadcasts, and the BYTE-EXACT confirm strings of the three over-limit
// functions so the behaviour-preserving refactor (extract per-capability builders / lookup table /
// decompose the create_pane-origin + update_metadata-op ladders) changes nothing observable.
//
// Written to be GREEN against the UNREFACTORED code FIRST (per D-6). The existing test_actionEffects.ts
// already pins each capability+origin+op exhaustively; this file adds focused EDGE pins for the exact
// branch lattice the two high-CC arrows decompose into — the create_pane origin switch (CC13) and the
// update_metadata op/scope ladder (CC21) — including the legacy-shaped fall-through arms and the
// nullish-vs-falsy default-param choices the rebuild deliberately mirrors.
//
// PURE: imports ../src/actionEffects ONLY (never ../server). A recording fake-deps bag captures the
// exact call order so we can assert ORDERING, not just final state.
//
// Runner: npx tsx --test --test-force-exit tests/test_actioneffects_complexity_refactor.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { buildActionRun } from "../src/actionEffects";

/** A recording deps bag: every ledger/broadcast call appends to `order` so side-effect SEQUENCE is
 *  observable. Mirrors the shape server.ts supplies at boot, trimmed to what buildActionRun touches. */
function recDeps() {
  const order: string[] = [];
  const calls: any = {
    order,
    added: [] as any[][],
    notes: [] as any[][],
    broadcasts: [] as any[],
    ledgerBroadcasts: 0,
    perms: null as any,
    projectsAdded: [] as any[][],
    amended: [] as any[][],
    deleted: [] as any[],
    projectNotesAdded: [] as any[][],
    projectsRenamed: [] as any[][],
    panesRenamed: [] as any[][],
  };
  const projects: Record<string, any> = {};
  const manager: any = {
    ledger: {
      getProject: (id: string) => projects[id],
      addProject(id: string, dir: string, summary: string) { projects[id] = { panes: {}, directory: dir, summary }; calls.projectsAdded.push([id, dir, summary]); order.push("addProject"); },
      addPaneNote(...a: any[]) { calls.notes.push(a); order.push("addPaneNote"); return true; },
      amendNote(id: string, text: string) { calls.amended.push([id, text]); order.push("amendNote"); },
      deleteNote(id: string) { calls.deleted.push(id); order.push("deleteNote"); },
      addNote(projectId: string, note: string) { calls.projectNotesAdded.push([projectId, note]); order.push("addNote"); return true; },
      renameProject(projectId: string, name: string) { calls.projectsRenamed.push([projectId, name]); order.push("renameProject"); },
      renamePane(projectId: string, paneId: string, name: string) { calls.panesRenamed.push([projectId, paneId, name]); order.push("renamePane"); },
    },
    addTerminal(...a: any[]) { calls.added.push(a); order.push("addTerminal"); return "OK"; },
    saveSettings() { order.push("saveSettings"); },
    settings: { advanced: {} as Record<string, any> },
    set globalPermissionsMode(v: any) { calls.perms = v; },
    get globalPermissionsMode() { return calls.perms; },
  };
  return {
    calls, projects, manager,
    deps: {
      manager,
      broadcast: (m: any) => { calls.broadcasts.push(m); order.push(`broadcast:${m.type}`); },
      broadcastLedgerUpdate: () => { calls.ledgerBroadcasts++; order.push("ledgerUpdate"); },
      sanitizeSettingsForClient: (s: any) => s,
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. buildActionRun outer dispatch (CC12) — capability routing + the no-op default.
// ═════════════════════════════════════════════════════════════════════════════
describe("actionEffects refactor — buildActionRun capability dispatch", () => {
  it("an unknown capability returns a safe no-op run naming the capability (never throws)", () => {
    const { deps } = recDeps();
    const out = buildActionRun({ capability: "totally_made_up", params: {} }, deps as any)();
    assert.match(out, /unknown capability "totally_made_up"/i);
  });
  it("buildActionRun NEVER runs the effect at build time — only the returned thunk does", () => {
    const { calls, deps } = recDeps();
    buildActionRun({ capability: "create_pane", params: { paneId: "x", command: "bash", projectId: "p1" } }, deps as any);
    assert.strictEqual(calls.order.length, 0, "constructing the run must not fire any side effect");
  });
  it("send_keys is deliberately NOT a case -> the no-op default (scope-out pin)", () => {
    const { deps } = recDeps();
    const out = buildActionRun({ capability: "send_keys", params: { paneId: "x", command: "ls" } }, deps as any)();
    assert.match(out, /unknown capability/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. create_pane arm (CC13) — the side-effect ORDER + the origin confirm-string switch.
// ═════════════════════════════════════════════════════════════════════════════
describe("actionEffects refactor — create_pane effect order + origin strings", () => {
  it("co-create order: addProject (missing) -> addTerminal -> ledgerUpdate -> terminals_updated", () => {
    const { calls, deps } = recDeps();
    buildActionRun({ capability: "create_pane", params: { paneId: "x", command: "bash", projectId: "pNew", cwd: "/tmp/p" } }, deps as any)();
    assert.deepStrictEqual(calls.order, ["addProject", "addTerminal", "ledgerUpdate", "broadcast:terminals_updated"]);
  });
  it("existing project: NO addProject; order is addTerminal -> ledgerUpdate -> terminals_updated", () => {
    const { calls, projects, deps } = recDeps();
    projects["p1"] = { panes: {} };
    buildActionRun({ capability: "create_pane", params: { paneId: "x", command: "bash", projectId: "p1" } }, deps as any)();
    assert.deepStrictEqual(calls.order, ["addTerminal", "ledgerUpdate", "broadcast:terminals_updated"]);
  });
  it("startupCommand inserts an addPaneNote BEFORE the ledgerUpdate (recipe variant)", () => {
    const { calls, projects, deps } = recDeps();
    projects["p1"] = { panes: {} };
    buildActionRun({ capability: "create_pane", params: { paneId: "x", command: "bash", projectId: "p1", startupCommand: "npm run dev" } }, deps as any)();
    assert.deepStrictEqual(calls.order, ["addTerminal", "addPaneNote", "ledgerUpdate", "broadcast:terminals_updated"]);
    assert.match(String(calls.notes[0][2]), /Suggested startup command: npm run dev/);
  });
  it("empty-string projectId is falsy -> NO co-create, and the confirm string carries an empty project", () => {
    const { calls, deps } = recDeps();
    const out = buildActionRun({ capability: "create_pane", params: { paneId: "x", command: "bash", projectId: "" } }, deps as any)();
    assert.strictEqual(calls.projectsAdded.length, 0, "falsy projectId never co-creates");
    assert.strictEqual(out, "Pane x created under project . Result: OK");
  });
  it("addTerminal receives the nullish-default toolPreset/permissions/session args (mirrors staging sites)", () => {
    const { calls, projects, deps } = recDeps();
    projects["p1"] = { panes: {} };
    buildActionRun({ capability: "create_pane", params: { paneId: "x", command: "bash", projectId: "p1" } }, deps as any)();
    const args = calls.added[0];
    // [paneId, cwd, command, toolPreset, permissionsMode, sessionId, projectId]
    assert.strictEqual(args[3], "Custom", "absent toolPreset -> 'Custom'");
    assert.strictEqual(args[4], "Human-in-the-Loop", "absent permissionsMode -> 'Human-in-the-Loop'");
    assert.strictEqual(args[5], "", "absent sessionId -> ''");
    assert.strictEqual(args[6], "p1");
  });
  it("origin switch: voice / rest / recipe / absent each yield their EXACT confirm string", () => {
    for (const [origin, expected] of [
      ["voice", "Pane x created under project p1. Result: OK"],
      ["rest", "OK"],
      ["recipe", "x"],
    ] as const) {
      const { deps } = recDeps();
      const out = buildActionRun({ capability: "create_pane", params: { origin, paneId: "x", command: "bash", projectId: "p1" } }, deps as any)();
      assert.strictEqual(out, expected, `origin=${origin}`);
    }
    // absent origin defaults to the voice string (legacy-row back-compat).
    const { deps } = recDeps();
    const out = buildActionRun({ capability: "create_pane", params: { paneId: "x", command: "bash", projectId: "p1" } }, deps as any)();
    assert.strictEqual(out, "Pane x created under project p1. Result: OK");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. update_metadata arm (CC21) — the op/scope ladder, each leaf's effect + EXACT string.
// ═════════════════════════════════════════════════════════════════════════════
describe("actionEffects refactor — update_metadata op/scope ladder", () => {
  it("op=amend -> amendNote(noteId, BOUND text) + ledgerUpdate + EXACT string", () => {
    const { calls, deps } = recDeps();
    const out = buildActionRun({ capability: "update_metadata", params: { op: "amend", noteId: "n1", text: "BOUND" } }, deps as any)();
    assert.deepStrictEqual(calls.order, ["amendNote", "ledgerUpdate"]);
    assert.deepStrictEqual(calls.amended, [["n1", "BOUND"]]);
    assert.strictEqual(out, "Note n1 updated.");
  });
  it("op=amend with absent text amends to the empty string (?? '' guard)", () => {
    const { calls, deps } = recDeps();
    buildActionRun({ capability: "update_metadata", params: { op: "amend", noteId: "n2" } }, deps as any)();
    assert.deepStrictEqual(calls.amended, [["n2", ""]]);
  });
  it("op=add scope=pane SUCCESS -> addPaneNote + ledgerUpdate + EXACT success string", () => {
    const { calls, deps } = recDeps();
    const out = buildActionRun({ capability: "update_metadata", params: { op: "add", scope: "pane", projectId: "p1", paneId: "x", note: "pn" } }, deps as any)();
    assert.deepStrictEqual(calls.order, ["addPaneNote", "ledgerUpdate"]);
    assert.strictEqual(out, "Note added to pane x");
  });
  it("op=add scope=pane FAILURE (addPaneNote false) -> NO ledgerUpdate + EXACT miss string", () => {
    const { calls, deps } = recDeps();
    deps.manager.ledger.addPaneNote = () => false; // simulate pane-not-found
    const out = buildActionRun({ capability: "update_metadata", params: { op: "add", scope: "pane", projectId: "p1", paneId: "x", note: "pn" } }, deps as any)();
    assert.strictEqual(calls.ledgerBroadcasts, 0, "no broadcast when addPaneNote returns false");
    assert.strictEqual(out, "Could not add note: pane x not found in project p1.");
  });
  it("op=add scope=project (default scope) SUCCESS -> addNote + ledgerUpdate + EXACT string", () => {
    const { calls, deps } = recDeps();
    const out = buildActionRun({ capability: "update_metadata", params: { op: "add", projectId: "p1", note: "hello" } }, deps as any)();
    assert.deepStrictEqual(calls.projectNotesAdded, [["p1", "hello"]]);
    assert.strictEqual(out, "Note added to project p1");
  });
  it("op=add scope=project FAILURE (addNote false) -> NO ledgerUpdate + EXACT miss string", () => {
    const { calls, deps } = recDeps();
    deps.manager.ledger.addNote = () => false;
    const out = buildActionRun({ capability: "update_metadata", params: { op: "add", projectId: "pX", note: "n" } }, deps as any)();
    assert.strictEqual(calls.ledgerBroadcasts, 0);
    assert.strictEqual(out, "Could not add note: project pX not found.");
  });
  it("op=rename scope=pane -> renamePane + ledgerUpdate + EXACT string", () => {
    const { calls, deps } = recDeps();
    const out = buildActionRun({ capability: "update_metadata", params: { op: "rename", scope: "pane", projectId: "p1", paneId: "x", name: "Pane X" } }, deps as any)();
    assert.deepStrictEqual(calls.panesRenamed, [["p1", "x", "Pane X"]]);
    assert.strictEqual(out, "Pane renamed to Pane X");
  });
  it("op=rename scope=project (default) -> renameProject + ledgerUpdate + EXACT string", () => {
    const { calls, deps } = recDeps();
    const out = buildActionRun({ capability: "update_metadata", params: { op: "rename", projectId: "p1", name: "New" } }, deps as any)();
    assert.deepStrictEqual(calls.projectsRenamed, [["p1", "New"]]);
    assert.strictEqual(out, "Project renamed to New");
  });
  it("op=delete (and any legacy delete-shaped row) -> deleteNote + ledgerUpdate + EXACT string", () => {
    const { calls, deps } = recDeps();
    const out = buildActionRun({ capability: "update_metadata", params: { op: "delete", noteId: "n7" } }, deps as any)();
    assert.deepStrictEqual(calls.order, ["deleteNote", "ledgerUpdate"]);
    assert.deepStrictEqual(calls.deleted, ["n7"]);
    assert.strictEqual(out, "Note n7 deleted.");
  });
  it("an UNRECOGNIZED op falls through to the delete arm (the documented legacy-shaped default)", () => {
    // The final arm is reached by op:"delete" OR any legacy/unknown op — it calls deleteNote.
    const { calls, deps } = recDeps();
    const out = buildActionRun({ capability: "update_metadata", params: { op: "totally_unknown" as any, noteId: "nz" } }, deps as any)();
    assert.deepStrictEqual(calls.deleted, ["nz"], "an unknown op takes the delete fall-through (current behavior)");
    assert.strictEqual(out, "Note nz deleted.");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. set_global_permissions — pinned here too (its arrow rides the outer CC12 dispatch).
// ═════════════════════════════════════════════════════════════════════════════
describe("actionEffects refactor — set_global_permissions effect order", () => {
  it("sets both mode fields, saves, broadcasts settings_updated, EXACT string", () => {
    const { calls, deps } = recDeps();
    const out = buildActionRun({ capability: "set_global_permissions", params: { permissionsMode: "Read-Only" } }, deps as any)();
    assert.strictEqual(calls.perms, "Read-Only");
    assert.strictEqual(deps.manager.settings.advanced.globalPermissionsMode, "Read-Only");
    assert.ok(calls.broadcasts.some((b: any) => b.type === "settings_updated" && b.globalPermissionsMode === "Read-Only"));
    assert.strictEqual(out, "Global permissions updated to Read-Only.");
  });
});
