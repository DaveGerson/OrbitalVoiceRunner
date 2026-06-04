// tests/test_actionEffects.ts
//
// WS-F follow-up (scope B) / bead wsm-e2e-pinned-kzt — the intent ⇄ run registry that rebuilds a
// deferred action's non-serializable side effect from its persisted INTENT, bound to the live
// manager/broadcast deps the server supplies at boot.
//
// PURE: imports ../src/actionEffects ONLY (never ../server — importing the server boots a listener).
// These pin that buildActionRun() reproduces the literal staging-site closures (current main:
// server.ts:842 REST / 1454 + 2816 recipe / 2516 + 2530 update_metadata / 2654 voice create_pane /
// 2676 set_global / 3240 set_pane) against a fake deps bag, so a confirm-after-restart matches a
// confirm-in-process. The guard against closure/registry drift (Risk 1).
//
// RE-SCOPE (kzt-rescope.md §3.4): the ORIGINAL buildActionRun had NO `update_metadata` case, so a
// rebuilt amend/delete returned the no-op "unknown capability" string and applied NO text — the
// precise #27 notes-recall regression. The amend/delete cases below are the failing-first anchor.

import { describe, it } from "node:test";
import assert from "node:assert";
import { buildActionRun } from "../src/actionEffects";

function fakeDeps() {
  const calls: any = {
    added: [], notes: [], broadcasts: [], ledgerBroadcasts: 0, perms: null,
    projectsAdded: [], saved: 0, amended: [], deleted: [],
  };
  const projects: Record<string, any> = {};
  const manager: any = {
    ledger: {
      getProject: (id: string) => projects[id],
      addProject(id: string, dir: string, summary: string) { projects[id] = { panes: {}, directory: dir, summary }; calls.projectsAdded.push([id, dir, summary]); },
      addPaneNote(...a: any[]) { calls.notes.push(a); },
      amendNote(id: string, text: string) { calls.amended.push([id, text]); },
      deleteNote(id: string) { calls.deleted.push(id); },
      save() { calls.saved++; },
    },
    terminals: {} as Record<string, any>,
    addTerminal(...a: any[]) { calls.added.push(a); return "OK"; },
    saveSettings() { calls.saved++; },
    settings: { advanced: {} as Record<string, any> },
    set globalPermissionsMode(v: any) { calls.perms = v; },
    get globalPermissionsMode() { return calls.perms; },
  };
  return {
    calls, projects, manager,
    deps: {
      manager,
      broadcast: (m: any) => calls.broadcasts.push(m),
      broadcastLedgerUpdate: () => { calls.ledgerBroadcasts++; },
      sanitizeSettingsForClient: (s: any) => s,
    },
  };
}

describe("kzt — buildActionRun rebuilds deferred effects from intent", () => {
  it("create_pane intent -> addTerminal + ledger + terminals_updated broadcast", () => {
    const { calls, deps } = fakeDeps();
    const run = buildActionRun({ capability: "create_pane", params: { paneId: "x", command: "bash", projectId: "p1" } }, deps as any);
    const out = run();
    assert.strictEqual(calls.added.length, 1, "addTerminal called once");
    assert.strictEqual(calls.added[0][0], "x", "pane id is the first addTerminal arg");
    assert.ok(calls.broadcasts.some((b: any) => b.type === "terminals_updated"));
    assert.strictEqual(calls.ledgerBroadcasts, 1, "ledger update broadcast fired");
    assert.match(out, /pane x/i);
  });

  // ---------------------------------------------------------------------------
  // DRIFT GUARD (Risk 1): pin the EXACT confirm-output string per create_pane origin.
  // The three create_pane staging sites in server.ts return THREE different strings, but all
  // persist under capability "create_pane". The rebuild must reproduce each verbatim or a
  // confirm-after-restart diverges from a confirm-in-process. `origin` is the discriminator.
  //   voice  (server.ts:2652): `Pane ${id} created under project ${proj}. Result: ${result}`
  //   rest   (server.ts:840) : `String(result)`  (bare addTerminal result)
  //   recipe (server.ts:1451/2810): `${id}`       (just the pane id, no result)
  // ---------------------------------------------------------------------------
  it("create_pane[origin=voice] returns the EXACT voice confirm string", () => {
    const { deps } = fakeDeps();
    const out = buildActionRun({ capability: "create_pane", params: { origin: "voice", paneId: "build-1", command: "bash", projectId: "p1" } }, deps as any)();
    assert.strictEqual(out, "Pane build-1 created under project p1. Result: OK");
  });

  it("create_pane[origin=rest] returns the bare addTerminal result (String(result))", () => {
    const { deps } = fakeDeps();
    const out = buildActionRun({ capability: "create_pane", params: { origin: "rest", paneId: "build-1", command: "bash", projectId: "p1" } }, deps as any)();
    assert.strictEqual(out, "OK");
  });

  it("create_pane[origin=recipe] returns just the pane id", () => {
    const { deps } = fakeDeps();
    const out = buildActionRun({ capability: "create_pane", params: { origin: "recipe", paneId: "build-1", command: "bash", projectId: "p1", startupCommand: "npm run dev" } }, deps as any)();
    assert.strictEqual(out, "build-1");
  });

  it("create_pane with no origin defaults to the voice string (back-compat for legacy rows)", () => {
    const { deps } = fakeDeps();
    const out = buildActionRun({ capability: "create_pane", params: { paneId: "build-1", command: "bash", projectId: "p1" } }, deps as any)();
    assert.strictEqual(out, "Pane build-1 created under project p1. Result: OK");
  });

  it("create_pane intent co-creates the project when it does not exist yet", () => {
    const { calls, deps } = fakeDeps();
    buildActionRun({ capability: "create_pane", params: { paneId: "x", command: "bash", projectId: "p-new", cwd: "/tmp/p" } }, deps as any)();
    assert.deepStrictEqual(calls.projectsAdded.map((p: any[]) => p[0]), ["p-new"], "missing project co-created");
  });

  it("create_pane intent records a startupCommand as a pane note (recipe variant)", () => {
    const { calls, deps } = fakeDeps();
    buildActionRun({ capability: "create_pane", params: { paneId: "x", command: "bash", projectId: "p1", startupCommand: "npm run dev" } }, deps as any)();
    assert.strictEqual(calls.notes.length, 1, "startupCommand persisted as a pane note");
    assert.match(String(calls.notes[0][2]), /npm run dev/);
  });

  it("set_global_permissions intent -> sets mode + settings_updated broadcast + EXACT string", () => {
    const { calls, deps } = fakeDeps();
    const out = buildActionRun({ capability: "set_global_permissions", params: { permissionsMode: "Read-Only" } }, deps as any)();
    assert.strictEqual(calls.perms, "Read-Only");
    assert.ok(calls.broadcasts.some((b: any) => b.type === "settings_updated"));
    // Exact confirm string (server.ts:2674).
    assert.strictEqual(out, "Global permissions updated to Read-Only.");
  });

  it("set_pane_permissions intent -> sets pane mode + terminals_updated broadcast + EXACT string", () => {
    const { calls, projects, manager, deps } = fakeDeps();
    let paneMode: string | null = null;
    manager.terminals["x"] = { setPermissionsMode: (m: string) => { paneMode = m; } };
    projects["p1"] = { panes: { x: { permissions_mode: "Full Auto" } } };
    const out = buildActionRun({ capability: "set_pane_permissions", params: { paneId: "x", projectId: "p1", permissionsMode: "Read-Only" } }, deps as any)();
    assert.strictEqual(paneMode, "Read-Only", "live terminal permission mode set");
    assert.strictEqual(projects["p1"].panes.x.permissions_mode, "Read-Only", "ledger pane mode set");
    assert.ok(calls.broadcasts.some((b: any) => b.type === "terminals_updated"));
    // Exact confirm string — MUST keep the trailing "successfully." (server.ts:3238).
    assert.strictEqual(out, "Safety permission mode for pane x updated to Read-Only successfully.");
  });

  // ---------------------------------------------------------------------------
  // RE-SCOPE CORE (kzt-rescope.md §3.4 / Risk R2): update_metadata amend + delete.
  // #27 added amend_note + delete_note, both gated through gateOrDefer("update_metadata", …)
  // (server.ts:2516 / 2530). The ORIGINAL buildActionRun had no update_metadata case → a rebuilt
  // amend returned the no-op "unknown capability" string and applied NO text. These two cases are
  // the failing-first anchor: they fail with the no-op string until the §3.4 case lands.
  // The `op` discriminator (amend|delete) is REQUIRED — both share the capability string but call
  // different ledger methods and return different confirm strings.
  // ---------------------------------------------------------------------------
  it("update_metadata[op=amend] -> amendNote(noteId, BOUND text) + ledger broadcast + EXACT string", () => {
    const { calls, deps } = fakeDeps();
    const out = buildActionRun({ capability: "update_metadata", params: { op: "amend", noteId: "n1", text: "BOUND TEXT" } }, deps as any)();
    // The enqueue-bound text must be applied verbatim — NOT whatever the model says next (#27 MUST-FIX #3).
    assert.deepStrictEqual(calls.amended, [["n1", "BOUND TEXT"]], "amendNote called with the bound text");
    assert.strictEqual(calls.deleted.length, 0, "delete must not fire on amend");
    assert.strictEqual(calls.ledgerBroadcasts, 1, "ledger update broadcast fired");
    // Exact confirm string (server.ts:2514 literal).
    assert.strictEqual(out, "Note n1 updated.");
  });

  it("update_metadata[op=delete] -> deleteNote(noteId) + ledger broadcast + EXACT string", () => {
    const { calls, deps } = fakeDeps();
    const out = buildActionRun({ capability: "update_metadata", params: { op: "delete", noteId: "n7" } }, deps as any)();
    assert.deepStrictEqual(calls.deleted, ["n7"], "deleteNote called with the note id");
    assert.strictEqual(calls.amended.length, 0, "amend must not fire on delete");
    assert.strictEqual(calls.ledgerBroadcasts, 1, "ledger update broadcast fired");
    // Exact confirm string (server.ts:2528 literal).
    assert.strictEqual(out, "Note n7 deleted.");
  });

  it("update_metadata[op=amend] with empty/absent text amends to the empty string (no crash)", () => {
    const { calls, deps } = fakeDeps();
    const out = buildActionRun({ capability: "update_metadata", params: { op: "amend", noteId: "n2" } }, deps as any)();
    assert.deepStrictEqual(calls.amended, [["n2", ""]], "absent text amends to empty string");
    assert.strictEqual(out, "Note n2 updated.");
  });

  it("unknown capability -> safe no-op run (never throws on hydrate)", () => {
    const { deps } = fakeDeps();
    const out = buildActionRun({ capability: "bogus", params: {} }, deps as any)();
    assert.match(out, /unknown capability/i);
  });
});
