// tests/test_locks_complexity_refactor.ts — CHARACTERIZATION tests for the cyclomatic-complexity
// burndown refactor of src/actions/defs/locks.ts. These pin the CURRENT observable behavior of the
// two over-limit handlers so the behaviour-preserving refactor (extract helpers / guard clauses)
// changes NO gate-write semantics, validation, audit row, or operator string.
//
//   - setCapabilityGate.handler (CC19): invalid-gate clarify, the tighten-only loosen REFUSAL (+ its
//     audit row), per-pane set (owning-project resolve + not-found), global set, and the audit +
//     settings_updated broadcast on the apply path.
//   - setPaneGates.handler     (CC16): the {notFound} sentinel, the Auto|Ask|Off normalize filter
//     (invalid silently dropped), the empty/all-invalid CLEAR (undefined override), the updatePane
//     persist on BOTH paths, the guarded audit row, and the {capabilityGates} success body.
//
// Written GREEN against the UNREFACTORED code FIRST (D-6), then kept green. The gate WRITES are
// asserted by inspecting the mutated stub settings / pane objects.
//
// Runner: npx tsx --test --test-force-exit tests/test_locks_complexity_refactor.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { setCapabilityGate, setPaneGates } from "../src/actions/defs/locks";
import type { ActionContext, ActionResult } from "../src/actions/types";

interface PaneObj { id?: string; capabilityGates?: Record<string, string> }
interface ProjectObj { id: string; panes: Record<string, PaneObj> }

interface CtxOpts {
  effectiveGate?: string;           // what effectiveCapabilityGateFor returns (current gate)
  capabilityGates?: Record<string, string> | undefined; // global map (settings.advanced.capabilityGates)
  projects?: Record<string, ProjectObj>;
  activeProjectId?: string;
  store?: boolean;
  recorded?: unknown[];
  saved?: { count: number };
  updatedPanes?: Array<{ projectId: string; pane: PaneObj; durable?: boolean }>;
  broadcasts?: unknown[];
  ledgerBroadcasts?: { count: number };
  terminalsBroadcasts?: { count: number };
  liveTerminals?: Record<string, { projectId?: string }>;
}

function makeCtx(opts: CtxOpts): ActionContext {
  const recorded = opts.recorded ?? [];
  const saved = opts.saved ?? { count: 0 };
  const updatedPanes = opts.updatedPanes ?? [];
  const broadcasts = opts.broadcasts ?? [];
  const projects = opts.projects ?? {};
  const advanced: { capabilityGates?: Record<string, string> } = { capabilityGates: opts.capabilityGates };
  const settings = { advanced } as unknown as ActionContext["manager"]["settings"];

  const storeObj = opts.store === false ? null : {
    recordActivity: (r: unknown) => { recorded.push(r); },
  };

  return {
    manager: {
      settings,
      saveSettings: () => { saved.count += 1; },
      terminals: opts.liveTerminals ?? {},
      ledger: {
        activeProjectId: opts.activeProjectId ?? "proj1",
        getProject: (id: string) => projects[id],
        getActiveProject: () => projects[opts.activeProjectId ?? "proj1"],
        getProjectIdForPane: (paneId: string) => {
          for (const [pid, p] of Object.entries(projects)) if (p.panes[paneId]) return pid;
          return undefined;
        },
        updatePane: (projectId: string, pane: PaneObj, durable?: boolean) => { updatedPanes.push({ projectId, pane, durable }); },
        workspaces: Object.values(projects),
      },
    } as unknown as ActionContext["manager"],
    store: storeObj as unknown as ActionContext["store"],
    effectiveCapabilityGateFor: () => (opts.effectiveGate ?? "Auto") as never,
    sanitizeSettingsForClient: (s) => s,
    broadcast: (m) => { broadcasts.push(m); },
    broadcastLedgerUpdate: () => { if (opts.ledgerBroadcasts) opts.ledgerBroadcasts.count += 1; },
    broadcastTerminalsUpdated: () => { if (opts.terminalsBroadcasts) opts.terminalsBroadcasts.count += 1; },
  } as unknown as ActionContext;
}

async function run(
  def: { handler: (a: never, c: ActionContext) => Promise<ActionResult> | ActionResult },
  args: unknown,
  ctx: ActionContext,
): Promise<ActionResult> {
  return await def.handler(args as never, ctx);
}

// ═════════════════════════════════════════════════════════════════════════════
// set_capability_gate (CC19)
// ═════════════════════════════════════════════════════════════════════════════
describe("locks refactor — setCapabilityGate.handler", () => {
  it("invalid gate -> clarify string", async () => {
    const ctx = makeCtx({});
    const r = await run(setCapabilityGate, { capability: "write_to_pane", gate: "Bogus" }, ctx);
    assert.deepStrictEqual(r, { kind: "ok", output: 'Invalid gate "Bogus". Must be one of: Auto, Ask, Off.' });
  });

  it("LOOSEN by voice (Off -> Ask) -> refusal string + audit row", async () => {
    const recorded: unknown[] = [];
    // effective current = Off, requested = Ask -> loosening
    const ctx = makeCtx({ effectiveGate: "Off", recorded });
    const r = await run(setCapabilityGate, { capability: "write_to_pane", gate: "Ask" }, ctx) as { kind: "ok"; output: string };
    assert.match(r.output, /^For safety I can't LOOSEN a capability gate by voice/);
    assert.match(r.output, /from Off to Ask/);
    assert.strictEqual(recorded.length, 1);
    assert.match((recorded[0] as any).summary, /REFUSED voice loosen/);
    assert.strictEqual((recorded[0] as any).payload.refused, true);
  });

  it("global TIGHTEN (Auto -> Ask) -> writes global map, saves, broadcasts, audits", async () => {
    const capabilityGates: Record<string, string> = {};
    const recorded: unknown[] = [];
    const saved = { count: 0 };
    const broadcasts: unknown[] = [];
    const ctx = makeCtx({ effectiveGate: "Auto", capabilityGates, recorded, saved, broadcasts });
    const r = await run(setCapabilityGate, { capability: "write_to_pane", gate: "Ask" }, ctx) as { kind: "ok"; output: string };
    assert.strictEqual(r.output, "Set global gate 'write_to_pane' = Ask.");
    assert.strictEqual(capabilityGates["write_to_pane"], "Ask");
    assert.strictEqual(saved.count, 1);
    assert.strictEqual(recorded.length, 1);
    assert.ok(broadcasts.some((b: any) => b.type === "settings_updated"));
  });

  it("global set with undefined gates map -> initializes {} then writes", async () => {
    const ctx = makeCtx({ effectiveGate: "Auto", capabilityGates: undefined });
    const r = await run(setCapabilityGate, { capability: "read_pane", gate: "Off" }, ctx) as { kind: "ok"; output: string };
    assert.strictEqual(r.output, "Set global gate 'read_pane' = Off.");
    // the global map was created and written
    assert.strictEqual((ctx.manager.settings.advanced.capabilityGates as any)["read_pane"], "Off");
  });

  it("per-pane set, pane in a project -> updatePane(durable) + success string", async () => {
    const pane: PaneObj = { id: "p1", capabilityGates: { existing: "Auto" } };
    const projects = { proj1: { id: "proj1", panes: { p1: pane } } };
    const updatedPanes: Array<{ projectId: string; pane: PaneObj; durable?: boolean }> = [];
    const ctx = makeCtx({ effectiveGate: "Auto", projects, updatedPanes });
    const r = await run(setCapabilityGate, { pane_id: "p1", capability: "write_to_pane", gate: "Ask" }, ctx) as { kind: "ok"; output: string };
    assert.strictEqual(r.output, "Set per-pane gate 'write_to_pane' = Ask for pane p1.");
    assert.strictEqual(updatedPanes.length, 1);
    assert.strictEqual(updatedPanes[0].durable, true);
    // the new pane map preserves existing + adds the new entry
    assert.strictEqual(pane.capabilityGates!["existing"], "Auto");
    assert.strictEqual(pane.capabilityGates!["write_to_pane"], "Ask");
  });

  it("per-pane set, pane not found in any project -> not-found string, no write", async () => {
    const updatedPanes: Array<unknown> = [];
    const ctx = makeCtx({ effectiveGate: "Auto", projects: {}, updatedPanes: updatedPanes as never });
    const r = await run(setCapabilityGate, { pane_id: "ghost", capability: "write_to_pane", gate: "Ask" }, ctx);
    assert.deepStrictEqual(r, { kind: "ok", output: "Pane ghost not found in any project." });
    assert.strictEqual(updatedPanes.length, 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// set_pane_gates (CC16)
// ═════════════════════════════════════════════════════════════════════════════
describe("locks refactor — setPaneGates.handler", () => {
  it("pane not found -> {notFound:true} sentinel, no mutation", async () => {
    const updatedPanes: Array<unknown> = [];
    const ctx = makeCtx({ projects: {}, updatedPanes: updatedPanes as never });
    const r = await run(setPaneGates, { project_id: "proj1", pane_id: "ghost", capability_gates: { read_pane: "Off" } }, ctx);
    assert.deepStrictEqual(r, { kind: "ok", output: { notFound: true } });
    assert.strictEqual(updatedPanes.length, 0);
  });

  it("valid map -> only Auto|Ask|Off survive; invalid silently dropped; persists + audits", async () => {
    const pane: PaneObj = {};
    const projects = { proj1: { id: "proj1", panes: { p1: pane } } };
    const recorded: unknown[] = [];
    const updatedPanes: Array<{ projectId: string; pane: PaneObj; durable?: boolean }> = [];
    const ledgerBroadcasts = { count: 0 };
    const terminalsBroadcasts = { count: 0 };
    const ctx = makeCtx({ projects, recorded, updatedPanes, ledgerBroadcasts, terminalsBroadcasts });
    const r = await run(setPaneGates, {
      project_id: "proj1", pane_id: "p1",
      capability_gates: { read_pane: "Off", write_to_pane: "Ask", bad: "Bogus", another: "Auto" },
    }, ctx) as { kind: "ok"; output: any };
    // success body
    assert.deepStrictEqual(r.output.capabilityGates, { read_pane: "Off", write_to_pane: "Ask", another: "Auto" });
    // pane mutated with the clean map
    assert.deepStrictEqual(pane.capabilityGates, { read_pane: "Off", write_to_pane: "Ask", another: "Auto" });
    assert.strictEqual(updatedPanes.length, 1);
    assert.strictEqual(updatedPanes[0].durable, true);
    assert.strictEqual(recorded.length, 1);
    assert.strictEqual(ledgerBroadcasts.count, 1);
    assert.strictEqual(terminalsBroadcasts.count, 1);
  });

  it("empty / all-invalid map -> CLEARS override (undefined), still persists+broadcasts", async () => {
    const pane: PaneObj = { capabilityGates: { read_pane: "Off" } };
    const projects = { proj1: { id: "proj1", panes: { p1: pane } } };
    const updatedPanes: Array<{ projectId: string; pane: PaneObj }> = [];
    const ctx = makeCtx({ projects, updatedPanes });
    const r = await run(setPaneGates, { project_id: "proj1", pane_id: "p1", capability_gates: { junk: "nope" } }, ctx) as { kind: "ok"; output: any };
    assert.strictEqual(pane.capabilityGates, undefined);
    assert.deepStrictEqual(r.output, { capabilityGates: null });
    assert.strictEqual(updatedPanes.length, 1);
  });

  it("absent map -> CLEARS override (undefined)", async () => {
    const pane: PaneObj = { capabilityGates: { read_pane: "Off" } };
    const projects = { proj1: { id: "proj1", panes: { p1: pane } } };
    const ctx = makeCtx({ projects });
    const r = await run(setPaneGates, { project_id: "proj1", pane_id: "p1" }, ctx) as { kind: "ok"; output: any };
    assert.strictEqual(pane.capabilityGates, undefined);
    assert.deepStrictEqual(r.output, { capabilityGates: null });
  });

  it("store null -> no audit throw, still succeeds", async () => {
    const pane: PaneObj = {};
    const projects = { proj1: { id: "proj1", panes: { p1: pane } } };
    const ctx = makeCtx({ projects, store: false });
    const r = await run(setPaneGates, { project_id: "proj1", pane_id: "p1", capability_gates: { read_pane: "Auto" } }, ctx) as { kind: "ok"; output: any };
    assert.deepStrictEqual(r.output.capabilityGates, { read_pane: "Auto" });
  });
});
