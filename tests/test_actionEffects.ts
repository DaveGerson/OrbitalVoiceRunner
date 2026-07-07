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
import fs from "fs";
import os from "os";
import path from "path";
import { buildActionRun } from "../src/actionEffects";
import { JanusStore } from "../src/store/sqliteStore";

function fakeDeps() {
  const calls: any = {
    added: [], notes: [], broadcasts: [], ledgerBroadcasts: 0, perms: null,
    projectsAdded: [], saved: 0, amended: [], deleted: [],
    // PHASE 1 (deferrable-toggle honesty): durable-replay of the newly-gated update_metadata add/rename
    // ops + create_project + archive_pane. Records the ledger calls each rebuilt effect makes.
    projectNotesAdded: [] as Array<[string, string]>, paneNotesAddedG: [] as Array<[string, string, string]>,
    projectsRenamed: [] as Array<[string, string]>, panesRenamed: [] as Array<[string, string, string]>,
    archivedPanes: [] as Array<[string, string]>,
    // c55.16 tech_debt_buildactionrun: durable-replay of the c55.10 gated rest-only caps.
    // save(force) calls (the def force-persists via ledger.save(true)), live PTY writes, and the
    // live mutable ledger arrays the replay cases splice.
    savedForce: [] as boolean[], writes: [] as Array<[string, string]>,
    watchRules: [] as Array<{ id: string }>, plans: [] as Array<{ id: string }>,
  };
  const projects: Record<string, any> = {};
  const manager: any = {
    ledger: {
      getProject: (id: string) => projects[id],
      addProject(id: string, dir: string, summary: string) { projects[id] = { panes: {}, directory: dir, summary }; calls.projectsAdded.push([id, dir, summary]); },
      addPaneNote(...a: any[]) { calls.notes.push(a); return true; },
      amendNote(id: string, text: string) { calls.amended.push([id, text]); },
      deleteNote(id: string) { calls.deleted.push(id); },
      // PHASE 1: add/rename ledger ops for the durable update_metadata replay; archivePane for archive_pane.
      addNote(projectId: string, note: string) { calls.projectNotesAdded.push([projectId, note]); return true; },
      renameProject(projectId: string, name: string) { calls.projectsRenamed.push([projectId, name]); },
      renamePane(projectId: string, paneId: string, name: string) { calls.panesRenamed.push([projectId, paneId, name]); },
      archivePaneOwned(projectId: string, paneId: string) { calls.archivedPanes.push([projectId, paneId]); return true; },
      // wsm-e2e-pinned major-finding fix: the REAL durable delete_pane/delete_project effect (mirrors
      // JanusStore.deletePane/deleteProject — a hard row delete, truthy-on-success). Mutates the SAME
      // `projects` object the delete_pane/delete_project tests below assign onto `ledger.workspaces`,
      // so `workspaces`/`getProject` observe the deletion exactly like a fresh SQL read would.
      deletePane(projectId: string, paneId: string) {
        const ws = projects[projectId];
        if (!ws || !ws.panes[paneId]) return false;
        delete ws.panes[paneId];
        calls.saved++;
        return true;
      },
      deleteProject(id: string) {
        if (!projects[id]) return false;
        delete projects[id];
        calls.saved++;
        return true;
      },
      // save() tracks the legacy no-arg path; save(true) (force-persist) records the flag so the
      // watch-rule / plan replay cases can be pinned byte-for-byte against the def's `save(true)`.
      save(force?: boolean) { calls.saved++; calls.savedForce.push(force === true); },
      // Live mutable arrays the remove_watch_rule / delete_orchestrator_plan replay cases splice
      // (the SAME references the def handlers mutate in production via manager.ledger.watchRules/plans).
      watchRules: calls.watchRules,
      plans: calls.plans,
    },
    // terminals[id].writeInput is the live PTY write the send_keys effect would re-fire on replay;
    // present so the scope-out pin can prove the rebuilt send_keys intent does NOT touch it.
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

  // Wave 6 fix: a deferred export_project stages capability "update_metadata" with op:"export". WITHOUT
  // an export arm the op fell through to the DELETE arm -> ledger.deleteNote(undefined) -> a bind
  // TypeError that consumed the operator's confirm as a 500. These pin the real re-run + the no-delete.
  it("update_metadata[op=export] -> re-runs the deterministic export, writes ORBITAL_EXPORT.md, EXACT string; NEVER deletes a note", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbital-export-replay-"));
    try {
      const deleted: string[] = [];
      const project = {
        id: "p1", name: "Kitchen", directory: tmpDir, summary: "s", keyTerms: [],
        panes: { pa: { pane_id: "pa", name: "Pane A", alive: true, last_known_state: "Idle", tool_preset: "Claude Code", permissions_mode: "Human-in-the-Loop" } },
      };
      const manager: any = {
        ledger: {
          getProject: (id: string) => (id === "p1" ? project : null),
          getNotes: () => [{ id: "n1", type: "note", pane_id: null, text: "hi", created_at: 0 }],
          deleteNote: (id: string) => deleted.push(id),
          plans: [],
        },
      };
      const deps = { manager, broadcast: () => {}, broadcastLedgerUpdate: () => {}, sanitizeSettingsForClient: (s: any) => s };
      const out = buildActionRun({ capability: "update_metadata", params: { op: "export", projectId: "p1" } }, deps as any)();
      assert.strictEqual(out, "Export written — 1 notes, 1 stations.");
      assert.ok(fs.existsSync(path.join(tmpDir, "ORBITAL_EXPORT.md")), "the export artifact is written on replay");
      assert.deepStrictEqual(deleted, [], "op:export must NEVER fall through to deleteNote (the bind-TypeError bug)");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("update_metadata[op=export] with a missing project -> graceful not-found narration, no write, no delete", () => {
    const deleted: string[] = [];
    const manager: any = { ledger: { getProject: () => null, deleteNote: (id: string) => deleted.push(id), getNotes: () => [], plans: [] } };
    const deps = { manager, broadcast: () => {}, broadcastLedgerUpdate: () => {}, sanitizeSettingsForClient: (s: any) => s };
    const out = buildActionRun({ capability: "update_metadata", params: { op: "export", projectId: "ghost" } }, deps as any)();
    assert.strictEqual(out, "Could not export: project ghost not found.");
    assert.deepStrictEqual(deleted, [], "a missing project must not delete anything either");
  });

  // ---------------------------------------------------------------------------
  // c55.16 tech_debt_buildactionrun: the c55.10 gated rest-only caps. Each STAGES a pending action
  // on Ask (gateOrDefer), so a confirm-AFTER-restart must rebuild the SAME side effect from the
  // persisted intent. These pin the rebuild reproduces the def's effect closure (watch_rules.ts /
  // panes_rest.ts) BYTE-IDENTICALLY: the ledger array splice, the FORCE-persist (save(true)), the
  // *_updated broadcast, and the exact confirm string (the Risk-1 drift guard).
  //
  // The intent params are the WIDENED bag the def now persists: remove_watch_rule carries `ruleId`,
  // delete_orchestrator_plan carries `planId` — the payload the rebuilt effect needs (the original
  // bag held only { origin, versionStamp } and could not be replayed).
  // ---------------------------------------------------------------------------
  it("remove_watch_rule intent -> splices the rule + save(true) + EXACT string (wsm-e2e-pinned-33c.4: no watch_rules_updated broadcast — no client consumes it)", () => {
    const { calls, deps } = fakeDeps();
    calls.watchRules.push({ id: "rule_a" }, { id: "rule_b" }, { id: "rule_c" });
    const out = buildActionRun({ capability: "remove_watch_rule", params: { origin: "rest", ruleId: "rule_b" } }, deps as any)();
    assert.deepStrictEqual(calls.watchRules.map((r: any) => r.id), ["rule_a", "rule_c"], "the matching rule is spliced");
    assert.deepStrictEqual(calls.savedForce, [true], "force-persist (save(true)) fired exactly once");
    const frame = calls.broadcasts.find((b: any) => b.type === "watch_rules_updated");
    assert.ok(!frame, "watch_rules_updated broadcast is PRUNED (wsm-e2e-pinned-33c.4 — no client consumes it)");
    // EXACT — matches removeEffect (watch_rules.ts:194).
    assert.strictEqual(out, "Watch rule rule_b removed.");
  });

  it("remove_watch_rule intent for an already-gone rule -> no splice / no persist / no broadcast, still confirms", () => {
    const { calls, deps } = fakeDeps();
    calls.watchRules.push({ id: "rule_a" });
    const out = buildActionRun({ capability: "remove_watch_rule", params: { origin: "rest", ruleId: "rule_gone" } }, deps as any)();
    // Mirrors removeEffect's idempotent re-find guard: a rule deleted between stage and confirm is a
    // no-op mutation (no double-splice, no spurious repaint) but still narrates success.
    assert.deepStrictEqual(calls.watchRules.map((r: any) => r.id), ["rule_a"], "nothing spliced for a missing rule");
    assert.deepStrictEqual(calls.savedForce, [], "no persist when nothing changed");
    assert.strictEqual(calls.broadcasts.length, 0, "no broadcast when nothing changed");
    assert.strictEqual(out, "Watch rule rule_gone removed.");
  });

  it("delete_orchestrator_plan intent -> splices the plan + save(true) + plans_updated + EXACT string", () => {
    const { calls, deps } = fakeDeps();
    calls.plans.push({ id: "plan_a" }, { id: "plan_b" });
    const out = buildActionRun({ capability: "delete_orchestrator_plan", params: { origin: "rest", planId: "plan_a" } }, deps as any)();
    assert.deepStrictEqual(calls.plans.map((p: any) => p.id), ["plan_b"], "the matching plan is spliced");
    assert.deepStrictEqual(calls.savedForce, [true], "force-persist (save(true)) fired exactly once");
    const frame = calls.broadcasts.find((b: any) => b.type === "plans_updated");
    assert.ok(frame, "plans_updated broadcast fired");
    assert.strictEqual(frame.plans, calls.plans, "broadcast carries the live array (post-splice)");
    // EXACT — matches deleteEffect (watch_rules.ts:255).
    assert.strictEqual(out, "Plan plan_a deleted.");
  });

  it("delete_orchestrator_plan intent for an already-gone plan -> no splice / no persist / no broadcast, still confirms", () => {
    const { calls, deps } = fakeDeps();
    calls.plans.push({ id: "plan_a" });
    const out = buildActionRun({ capability: "delete_orchestrator_plan", params: { origin: "rest", planId: "plan_gone" } }, deps as any)();
    assert.deepStrictEqual(calls.plans.map((p: any) => p.id), ["plan_a"], "nothing spliced for a missing plan");
    assert.deepStrictEqual(calls.savedForce, [], "no persist when nothing changed");
    assert.strictEqual(calls.broadcasts.length, 0, "no broadcast when nothing changed");
    assert.strictEqual(out, "Plan plan_gone deleted.");
  });

  // ---------------------------------------------------------------------------
  // PHASE 1 (deferrable-toggle honesty): durable replay of the newly-gated deferrable toggles —
  // the additive update_metadata ops (add_project_note / add_pane_note / rename_project / rename_pane),
  // create_project, and archive_pane. Each STAGES a pending action on Ask (gateOrDefer), so a
  // confirm-AFTER-restart must rebuild the SAME side effect from the persisted intent. These pin the
  // rebuild reproduces the def's effect closure BYTE-IDENTICALLY (ledger call + broadcast + EXACT
  // confirm string), in lockstep with the def handlers.
  // ---------------------------------------------------------------------------
  it("update_metadata[op=add, scope=project] -> addNote + ledger broadcast + EXACT string", () => {
    const { calls, deps } = fakeDeps();
    const out = buildActionRun({ capability: "update_metadata", params: { op: "add", scope: "project", projectId: "p1", note: "hello" } }, deps as any)();
    assert.deepStrictEqual(calls.projectNotesAdded, [["p1", "hello"]], "addNote called with the bound text");
    assert.strictEqual(calls.ledgerBroadcasts, 1, "ledger update broadcast fired on success");
    assert.strictEqual(out, "Note added to project p1");
  });

  it("update_metadata[op=add, scope=pane] -> addPaneNote + ledger broadcast + EXACT string", () => {
    const { calls, deps } = fakeDeps();
    const out = buildActionRun({ capability: "update_metadata", params: { op: "add", scope: "pane", projectId: "p1", paneId: "x", note: "pn" } }, deps as any)();
    assert.deepStrictEqual(calls.notes, [["p1", "x", "pn"]], "addPaneNote called with project/pane/text");
    assert.strictEqual(calls.ledgerBroadcasts, 1, "ledger update broadcast fired on success");
    assert.strictEqual(out, "Note added to pane x");
  });

  it("update_metadata[op=rename, scope=project] -> renameProject + ledger broadcast + EXACT string", () => {
    const { calls, deps } = fakeDeps();
    const out = buildActionRun({ capability: "update_metadata", params: { op: "rename", scope: "project", projectId: "p1", name: "New Name" } }, deps as any)();
    assert.deepStrictEqual(calls.projectsRenamed, [["p1", "New Name"]], "renameProject called");
    assert.strictEqual(calls.ledgerBroadcasts, 1, "ledger update broadcast fired");
    assert.strictEqual(out, "Project renamed to New Name");
  });

  it("update_metadata[op=rename, scope=pane] -> renamePane + ledger broadcast + EXACT string", () => {
    const { calls, deps } = fakeDeps();
    const out = buildActionRun({ capability: "update_metadata", params: { op: "rename", scope: "pane", projectId: "p1", paneId: "x", name: "Pane X" } }, deps as any)();
    assert.deepStrictEqual(calls.panesRenamed, [["p1", "x", "Pane X"]], "renamePane called");
    assert.strictEqual(calls.ledgerBroadcasts, 1, "ledger update broadcast fired");
    assert.strictEqual(out, "Pane renamed to Pane X");
  });

  it("create_project intent -> addProject [+ rename] + ONE ledger broadcast + EXACT string", () => {
    const { calls, deps } = fakeDeps();
    const out = buildActionRun({ capability: "create_project", params: { projectId: "p9", directory: "/tmp/p9", summary: "s", keyTerms: ["k"], name: "Niner" } }, deps as any)();
    assert.deepStrictEqual(calls.projectsAdded, [["p9", "/tmp/p9", "s"]], "addProject called with resolved directory + summary");
    assert.deepStrictEqual(calls.projectsRenamed, [["p9", "Niner"]], "post-create rename runs when a name is staged");
    assert.strictEqual(calls.ledgerBroadcasts, 1, "exactly one ledger_updated broadcast after both mutations");
    assert.strictEqual(out, "Project context p9 created successfully.");
  });

  it("create_project intent with no name -> addProject only, no rename", () => {
    const { calls, deps } = fakeDeps();
    buildActionRun({ capability: "create_project", params: { projectId: "p10", directory: "/tmp/p10" } }, deps as any)();
    assert.deepStrictEqual(calls.projectsAdded, [["p10", "/tmp/p10", ""]], "addProject with empty summary default");
    assert.strictEqual(calls.projectsRenamed.length, 0, "no rename without a staged name");
  });

  it("archive_pane intent -> ledger.archivePane + ledger/terminals broadcasts + EXACT string", () => {
    const { calls, deps } = fakeDeps();
    const out = buildActionRun({ capability: "archive_pane", params: { paneId: "x", projectId: "p1" } }, deps as any)();
    assert.deepStrictEqual(calls.archivedPanes, [["p1", "x"]], "archivePane called with the owning project + pane");
    assert.strictEqual(calls.ledgerBroadcasts, 1, "ledger update broadcast fired on success");
    assert.ok(calls.broadcasts.some((b: any) => b.type === "terminals_updated"), "terminals_updated broadcast fired");
    assert.strictEqual(out, "Pane x archived (recoverable).");
  });

  it("clear_history intent -> falls back to a file clear (no bridge) + EXACT string", () => {
    // No history bridge is registered in this PURE unit context, so the rebuild uses the file
    // fallback. Run it in an isolated cwd so the .janus_history.json write does not collide.
    const prev = process.cwd();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-clr-"));
    process.chdir(dir);
    try {
      const fp = path.join(dir, ".janus_history.json");
      fs.writeFileSync(fp, JSON.stringify({ x: [{ command: "a", timestamp: "t", output: "" }], y: [{ command: "b", timestamp: "t", output: "" }] }), "utf-8");
      const { deps } = fakeDeps();
      const out = buildActionRun({ capability: "clear_history", params: { op: "clear", paneId: "x" } }, deps as any)();
      const parsed = JSON.parse(fs.readFileSync(fp, "utf-8"));
      assert.deepStrictEqual(parsed["x"], [], "the target pane's history is cleared on replay");
      assert.ok(Array.isArray(parsed["y"]) && parsed["y"].length === 1, "sibling pane history untouched");
      assert.strictEqual(out, "History cleared for terminal x.");
    } finally {
      process.chdir(prev);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  // ---------------------------------------------------------------------------
  // wsm-e2e-pinned-j2e: durable replay for the gated deletes + the respawn ("restart_pane") gate.
  // Before this, a deferred (Ask) delete_pane / delete_project / restart_pane confirmed AFTER a
  // process restart degraded to the safe "unknown capability" no-op narration — fail-safe, but the
  // operator was told an effect happened that never ran. These pin the REAL effect now runs.
  // ---------------------------------------------------------------------------

  it("restart_pane intent (live terminal) -> ordered stop()-then-start() + broadcasts + EXACT string", async () => {
    const { calls, manager, deps } = fakeDeps();
    let started = false;
    const term = {
      stop: () => Promise.resolve(),
      start: () => { started = true; },
    };
    manager.terminals["x"] = term;
    const out = buildActionRun({ capability: "restart_pane", params: { paneId: "x" } }, deps as any)();
    // Synchronous return, mirroring the live handler's fire-and-return contract.
    assert.strictEqual(out, "Terminal x restarted.");
    assert.strictEqual(started, false, "start() has not run yet — stop() has not resolved");
    // Flush the microtask queue so the awaited stop() continuation runs.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(started, true, "start() runs once stop() resolves");
    assert.strictEqual(calls.ledgerBroadcasts, 1);
    assert.ok(calls.broadcasts.some((b: any) => b.type === "terminals_updated"));
  });

  it("restart_pane intent (live terminal) -> archivingPanes guard suppresses start() (kdtu mirror)", async () => {
    const { calls, manager, deps } = fakeDeps();
    let started = false;
    const term = { stop: () => Promise.resolve(), start: () => { started = true; } };
    manager.terminals["x"] = term;
    manager.archivingPanes = new Set(["x"]);
    const out = buildActionRun({ capability: "restart_pane", params: { paneId: "x" } }, deps as any)();
    assert.strictEqual(out, "Terminal x restarted.");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(started, false, "an in-flight archive intent must suppress the ghost respawn");
    assert.strictEqual(calls.ledgerBroadcasts, 0);
  });

  it("restart_pane intent (ledger-only pane) -> respawnFromLedger spawns via addTerminal + EXACT string", () => {
    const { calls, projects, manager, deps } = fakeDeps();
    projects["p1"] = { id: "p1", directory: "/proj/p1", panes: { x: { tool_preset: "Custom", permissions_mode: "Human-in-the-Loop", session_id: "sess-1" } } };
    manager.ledger.workspaces = projects;
    const out = buildActionRun({ capability: "restart_pane", params: { paneId: "x" } }, deps as any)();
    assert.strictEqual(calls.added.length, 1, "addTerminal called once via the shared respawnFromLedger closure");
    const [paneId, cwd, , , permMode, sessionId, projectId] = calls.added[0];
    assert.strictEqual(paneId, "x");
    assert.strictEqual(cwd, "/proj/p1");
    assert.strictEqual(permMode, "Human-in-the-Loop");
    assert.strictEqual(sessionId, "sess-1");
    assert.strictEqual(projectId, "p1");
    assert.strictEqual(calls.ledgerBroadcasts, 1);
    assert.ok(calls.broadcasts.some((b: any) => b.type === "terminals_updated"));
    assert.strictEqual(out, "Terminal x restored and started.");
  });

  it("restart_pane intent -> neither a live terminal nor a ledger pane -> idempotent not-found narration", () => {
    const { calls, deps } = fakeDeps();
    const out = buildActionRun({ capability: "restart_pane", params: { paneId: "ghost" } }, deps as any)();
    assert.strictEqual(out, "Terminal ghost not found.");
    assert.strictEqual(calls.ledgerBroadcasts, 0);
  });

  it("delete_pane intent -> stop() + drop live slot + splice ledger row + save + broadcasts + EXACT string", () => {
    const { calls, projects, manager, deps } = fakeDeps();
    let stopped = false;
    manager.terminals["x"] = { stop: () => { stopped = true; } };
    projects["p1"] = { id: "p1", directory: "/proj/p1", panes: { x: { permissions_mode: "Full Auto" } } };
    manager.ledger.workspaces = projects;
    const out = buildActionRun({ capability: "delete_pane", params: { paneId: "x" } }, deps as any)();
    assert.strictEqual(stopped, true, "the live terminal is stopped");
    assert.strictEqual(manager.terminals["x"], undefined, "the live slot is dropped");
    assert.strictEqual(projects["p1"].panes.x, undefined, "the ledger row is spliced");
    assert.ok(calls.saved >= 1, "ledger.save() ran");
    assert.strictEqual(calls.ledgerBroadcasts, 1);
    assert.ok(calls.broadcasts.some((b: any) => b.type === "terminals_updated"));
    assert.strictEqual(out, "Pane x deleted.");
  });

  it("delete_pane intent -> already gone (both slot + ledger row absent) -> idempotent not-found narration", () => {
    const { calls, deps } = fakeDeps();
    const out = buildActionRun({ capability: "delete_pane", params: { paneId: "ghost" } }, deps as any)();
    assert.strictEqual(out, "Pane ghost not found.");
    assert.strictEqual(calls.ledgerBroadcasts, 0);
  });

  it("delete_project intent -> deletes the workspace + re-points activeContext to a fresh default + EXACT string", () => {
    const { calls, projects, manager, deps } = fakeDeps();
    projects["p1"] = { id: "p1", directory: "/proj/p1", panes: {} };
    manager.ledger.workspaces = projects;
    manager.ledger.activeProjectId = "p1";
    manager.ledger.switchContext = (id: string) => { calls.switched = id; };
    manager.settings.projects = { activeContext: "p1", localWorkspacePath: "" };
    const out = buildActionRun({ capability: "delete_project", params: { projectId: "p1" } }, deps as any)();
    assert.strictEqual(projects["p1"], undefined, "the workspace row is deleted");
    assert.ok(calls.projectsAdded.some((a: any) => a[0] === "default_project"), "a fallback default project is created");
    assert.strictEqual(calls.switched, "default_project", "context re-pointed to the fresh default");
    assert.strictEqual(manager.settings.projects.activeContext, "default_project");
    assert.strictEqual(calls.ledgerBroadcasts, 1);
    assert.strictEqual(out, "Project p1 deleted.");
  });

  it("delete_project intent -> already gone -> idempotent not-found narration, no broadcast", () => {
    const { calls, manager, deps } = fakeDeps();
    manager.ledger.workspaces = {};
    const out = buildActionRun({ capability: "delete_project", params: { projectId: "ghost" } }, deps as any)();
    assert.strictEqual(out, "Project ghost not found.");
    assert.strictEqual(calls.ledgerBroadcasts, 0);
  });

  // ---------------------------------------------------------------------------
  // wsm-e2e-pinned major-finding fix (Wave 5a review): the delete_pane/delete_project replay
  // builders above are proven ONLY against the plain-object `fakeDeps()` ledger, which mirrors a
  // snapshot-mutation idiom (`delete ws.panes[id]` / `delete workspaces[id]`) — that idiom is a
  // SILENT NO-OP against JanusStore, the only production backend: `workspaces`/`getProject` rebuild
  // fresh snapshots from SQL on every call and `save()` is a documented no-op, so the deleted row
  // resurrects on the next read. These cases run buildActionRun against a REAL JanusStore(':memory:')
  // so the persistence half of the effect (not just the in-memory mirror logic) is actually exercised.
  // ---------------------------------------------------------------------------
  describe("wsm-e2e-pinned major-finding fix — delete_pane/delete_project persist against a REAL JanusStore", () => {
    function realDeps() {
      const store = new JanusStore(":memory:");
      store.init();
      const calls = { broadcasts: [] as any[], ledgerBroadcasts: 0 };
      const manager: any = {
        ledger: store,
        terminals: {} as Record<string, any>,
        settings: { projects: { activeContext: "", localWorkspacePath: "" } },
        saveSettings() { /* no-op */ },
      };
      return {
        store, manager, calls,
        deps: {
          manager,
          broadcast: (m: any) => calls.broadcasts.push(m),
          broadcastLedgerUpdate: () => { calls.ledgerBroadcasts++; },
          sanitizeSettingsForClient: (s: any) => s,
        },
      };
    }

    it("delete_pane intent -> the pane row is REALLY gone from JanusStore (survives a fresh read, not just the snapshot)", () => {
      const { store, manager, deps } = realDeps();
      store.addProject("p1", "/proj/p1");
      store.updatePane("p1", { pane_id: "x", name: "x", alive: true } as any);
      manager.terminals["x"] = { stop: () => { /* no-op */ } };
      assert.ok(store.getProject("p1")!.panes["x"], "precondition: pane exists before replay");

      const out = buildActionRun({ capability: "delete_pane", params: { paneId: "x" } }, deps as any)();
      assert.strictEqual(out, "Pane x deleted.");

      // The bug this pins: a snapshot-only delete (`delete ws.panes[id]`) mutates a throwaway object
      // returned by getProject() and never touches SQL — a FRESH read (a new getProject() call, exactly
      // like a subsequent request/boot would do) would still see the row. Assert against a fresh read.
      assert.strictEqual(store.getProject("p1")!.panes["x"], undefined, "pane row is gone on a FRESH read from SQL");
      assert.strictEqual(store.getPanes("p1")["x"], undefined, "pane row is gone from the panes table directly");
    });

    it("delete_project intent -> the project row is REALLY gone from JanusStore (survives a fresh read, not just the snapshot)", () => {
      const { store, deps } = realDeps();
      store.addProject("p1", "/proj/p1");
      store.addProject("p2", "/proj/p2");
      store.activeProjectId = "p2"; // not the deleted project -> no reassignment branch
      assert.ok(store.getProject("p1"), "precondition: project exists before replay");

      const out = buildActionRun({ capability: "delete_project", params: { projectId: "p1" } }, deps as any)();
      assert.strictEqual(out, "Project p1 deleted.");

      // The bug this pins: `delete workspaces[id]` mutates a throwaway snapshot object from the
      // `workspaces` getter and never touches SQL — a FRESH read would still see the row.
      assert.strictEqual(store.getProject("p1"), null, "project row is gone on a FRESH read from SQL");
      assert.ok(!("p1" in store.workspaces), "project is gone from a fresh workspaces snapshot too");
      assert.ok(store.getProject("p2"), "sibling project untouched");
    });
  });

  // ---------------------------------------------------------------------------
  // send_keys is DELIBERATELY NOT replayable across a restart (panes_rest.ts:222-225 accepted
  // scope-out). Its effect re-fires term.writeInput straight to the LIVE PTY — a confirm-after-
  // restart would re-send a keystroke to a possibly-different pane process, which is a product
  // question, not a mechanical port. This pin DURABLY records that decision: a rebuilt send_keys
  // intent must fall through to the safe no-op string and NEVER touch the live PTY. If a future
  // change adds a send_keys case, this test goes RED and forces the product decision to be ratified.
  // ---------------------------------------------------------------------------
  it("send_keys intent -> NOT replayable (safe no-op string, never touches the live PTY)", () => {
    const { calls, manager, deps } = fakeDeps();
    manager.terminals["x"] = { writeInput: (cmd: string) => { calls.writes.push(["x", cmd]); } };
    const out = buildActionRun({ capability: "send_keys", params: { origin: "rest", paneId: "x", command: "ls -la" } }, deps as any)();
    assert.strictEqual(calls.writes.length, 0, "send_keys replay must NOT write to the live PTY");
    assert.strictEqual(calls.ledgerBroadcasts, 0, "no ledger broadcast on the no-op path");
    assert.match(out, /unknown capability/i);
  });

  it("unknown capability -> safe no-op run (never throws on hydrate)", () => {
    const { deps } = fakeDeps();
    const out = buildActionRun({ capability: "bogus", params: {} }, deps as any)();
    assert.match(out, /unknown capability/i);
  });
});
