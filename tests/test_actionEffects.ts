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
      addPaneNote(...a: any[]) { calls.notes.push(a); },
      amendNote(id: string, text: string) { calls.amended.push([id, text]); },
      deleteNote(id: string) { calls.deleted.push(id); },
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
  it("remove_watch_rule intent -> splices the rule + save(true) + watch_rules_updated + EXACT string", () => {
    const { calls, deps } = fakeDeps();
    calls.watchRules.push({ id: "rule_a" }, { id: "rule_b" }, { id: "rule_c" });
    const out = buildActionRun({ capability: "remove_watch_rule", params: { origin: "rest", ruleId: "rule_b" } }, deps as any)();
    assert.deepStrictEqual(calls.watchRules.map((r: any) => r.id), ["rule_a", "rule_c"], "the matching rule is spliced");
    assert.deepStrictEqual(calls.savedForce, [true], "force-persist (save(true)) fired exactly once");
    const frame = calls.broadcasts.find((b: any) => b.type === "watch_rules_updated");
    assert.ok(frame, "watch_rules_updated broadcast fired");
    assert.strictEqual(frame.watchRules, calls.watchRules, "broadcast carries the live array (post-splice)");
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
