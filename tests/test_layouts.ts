/**
 * tests/test_layouts.ts — PANE LAYOUTS (journey-expansion work item B, spec §7).
 *
 * Layers (PTY-free / no server boot):
 *   (1) save_project_layout — snapshots ONLY the target project's LIVE terminals (two-project stub
 *       manager.terminals proves the filter), capturing shellCmd/cwd/toolPreset/permissionsMode and
 *       narrating the captured pane ids; an empty project answers ok WITHOUT consulting the gate.
 *   (2) apply_layout — rides the recipe gates: already-live pane ids are skipped; a layout-level
 *       Off (effectiveCapabilityGateFor(null,'apply_recipe')==='Off') blocks the WHOLE apply;
 *       per-pane Ask routes through gateOrDefer("create_pane") and narrates awaiting-confirmation;
 *       Auto spawns via the manager.addTerminal probe with the STORED command/cwd/preset/mode and
 *       the project-directory fallback when the stored cwd is empty.
 *   (3) delete_layout — unknown id -> ok narration BEFORE the gate.
 *
 * Runner: npx tsx --test --test-force-exit tests/test_layouts.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert";

import { REGISTRY } from "../src/actions/registry";
import { runAction } from "../src/actions/gemini";
import type { ActionContext, GateDisposition } from "../src/actions/types";
import type { PaneLayout, GateValue, CapabilityGate } from "../src/types";

// ── stub ctx ──────────────────────────────────────────────────────────────────────────────────────

interface CtxProbe {
  broadcasts: Array<Record<string, unknown>>;
  saveCalls: boolean[];
  ledgerUpdates: number;
  gateCalls: Array<{ capability: string; paneId: string | null; summary: string }>;
  gateCapabilityCalls: Array<{ capability: string; paneId: string | null }>;
  addTerminalCalls: unknown[][];
}

/** A live-terminal stub carrying exactly the fields save_project_layout snapshots. */
interface StubTerm {
  id: string;
  projectId: string;
  shellCmd?: string;
  cwd?: string;
  toolPreset?: string;
  permissionsMode?: string;
}

function makeCtx(opts?: {
  layouts?: PaneLayout[];
  terminals?: Record<string, StubTerm>;
  projects?: Record<string, { directory: string }>;
  activeProjectId?: string;
  /** What gateOrDefer answers (default run). */
  gate?: GateDisposition;
  /** effective gate per (paneId ?? "null") + capability; default Auto. */
  gates?: Record<string, GateValue>;
}): { ctx: ActionContext; probe: CtxProbe; layouts: PaneLayout[] } {
  const probe: CtxProbe = {
    broadcasts: [],
    saveCalls: [],
    ledgerUpdates: 0,
    gateCalls: [],
    gateCapabilityCalls: [],
    addTerminalCalls: [],
  };
  const layouts = opts?.layouts ?? [];
  const projects = opts?.projects ?? {};
  const gateFor = (paneId: string | null | undefined, capability: string): GateValue =>
    opts?.gates?.[`${paneId ?? "null"}:${capability}`] ?? "Auto";
  const ledger = {
    layouts,
    activeProjectId: opts?.activeProjectId ?? "projA",
    getProject: (id: string): { directory: string } | undefined => projects[id],
    save: (force: boolean): void => {
      probe.saveCalls.push(force);
    },
  };
  const ctx = {
    manager: {
      ledger,
      terminals: opts?.terminals ?? {},
      addTerminal: (...args: unknown[]): void => {
        probe.addTerminalCalls.push(args);
      },
    },
    session: null,
    redact: (s: string) => s,
    broadcast: (msg: unknown): void => {
      probe.broadcasts.push(msg as Record<string, unknown>);
    },
    broadcastLedgerUpdate: (): void => {
      probe.ledgerUpdates += 1;
    },
    gateOrDefer: (capability: string, paneId: string | null, summary: string, run: () => string): GateDisposition => {
      probe.gateCalls.push({ capability, paneId, summary });
      void run;
      return opts?.gate ?? { disposition: "run" as const };
    },
    gateCapability: (capability: string, paneId: string | null): { forbidden: boolean; gate: GateValue } => {
      probe.gateCapabilityCalls.push({ capability, paneId });
      const g = gateFor(paneId, capability);
      return { forbidden: g === "Off", gate: g };
    },
    effectiveCapabilityGateFor: (paneId: string | null | undefined, capability: CapabilityGate): GateValue =>
      gateFor(paneId, capability),
  } as unknown as ActionContext;
  return { ctx, probe, layouts };
}

function seedLayout(over?: Partial<PaneLayout>): PaneLayout {
  return {
    id: "layout_seed1",
    name: "duo",
    description: "two panes",
    sourceProjectId: "projA",
    panes: [
      { id: "p1", name: "p1", command: "claude --resume", cwd: "/work/p1", preset: "Claude Code", permissionsMode: "Full Auto" },
      { id: "p2", name: "p2", command: "codex", cwd: "", preset: "Custom", permissionsMode: "Human-in-the-Loop" },
    ],
    created_at: 1,
    ...over,
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (1) save_project_layout
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe("save_project_layout — snapshots ONLY the target project's live panes", () => {
  it("two projects live: captures projA's panes only, with shellCmd/cwd/toolPreset/permissionsMode", async () => {
    const { ctx, probe, layouts } = makeCtx({
      projects: { projA: { directory: "/work/a" }, projB: { directory: "/work/b" } },
      terminals: {
        a1: { id: "a1", projectId: "projA", shellCmd: "claude --resume", cwd: "/work/a/one", toolPreset: "Claude Code", permissionsMode: "Full Auto" },
        a2: { id: "a2", projectId: "projA", shellCmd: "codex", cwd: "/work/a/two", toolPreset: "Codex", permissionsMode: "Read-Only" },
        b1: { id: "b1", projectId: "projB", shellCmd: "bash", cwd: "/work/b", toolPreset: "Custom", permissionsMode: "Human-in-the-Loop" },
      },
    });
    const result = await runAction(REGISTRY, "save_project_layout", { name: "duo", project_id: "projA" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(layouts.length, 1, "the layout was pushed");
    const layout = layouts[0];
    assert.strictEqual(layout.sourceProjectId, "projA");
    assert.deepStrictEqual(
      layout.panes.map((p) => p.id).sort(),
      ["a1", "a2"],
      "ONLY projA's live panes are captured — b1 (projB) must not leak in"
    );
    const a1 = layout.panes.find((p) => p.id === "a1")!;
    assert.strictEqual(a1.command, "claude --resume", "shellCmd captured as command");
    assert.strictEqual(a1.cwd, "/work/a/one");
    assert.strictEqual(a1.preset, "Claude Code");
    assert.strictEqual(a1.permissionsMode, "Full Auto");
    const a2 = layout.panes.find((p) => p.id === "a2")!;
    assert.strictEqual(a2.preset, "Codex");
    assert.strictEqual(a2.permissionsMode, "Read-Only");
    // narration names the captured pane ids
    const out = String((result as { output: unknown }).output);
    assert.ok(out.includes("a1") && out.includes("a2"), `narration must name the captured pane ids (got: ${out})`);
    assert.ok(!out.includes("b1"), "narration must not name the other project's pane");
    assert.ok(probe.saveCalls.includes(true), "save_project_layout must persist via ledger.save(true)");
    assert.ok(probe.broadcasts.some((m) => m.type === "layouts_updated"), "must broadcast layouts_updated");
  });

  it("missing snapshot fields fall back (command '' / preset Custom / mode Human-in-the-Loop)", async () => {
    const { ctx, layouts } = makeCtx({
      projects: { projA: { directory: "/work/a" } },
      terminals: { bare: { id: "bare", projectId: "projA" } },
    });
    const result = await runAction(REGISTRY, "save_project_layout", { name: "bare", project_id: "projA" }, ctx);
    assert.strictEqual(result.kind, "ok");
    const pane = layouts[0].panes[0];
    assert.strictEqual(pane.command, "");
    assert.strictEqual(pane.cwd, "");
    assert.strictEqual(pane.preset, "Custom");
    assert.strictEqual(pane.permissionsMode, "Human-in-the-Loop");
  });

  it("empty project (no live panes) -> ok narration WITHOUT consulting the gate; nothing saved", async () => {
    const { ctx, probe, layouts } = makeCtx({
      projects: { projA: { directory: "/work/a" }, projB: { directory: "/work/b" } },
      // only projB has live panes — projA snapshots empty
      terminals: { b1: { id: "b1", projectId: "projB" } },
    });
    const result = await runAction(REGISTRY, "save_project_layout", { name: "empty", project_id: "projA" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.ok(String((result as { output: unknown }).output).includes("no live panes"));
    assert.strictEqual(probe.gateCalls.length, 0, "an empty snapshot is a no-op — never reaches the gate");
    assert.strictEqual(layouts.length, 0, "nothing was saved");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (2) apply_layout — recipe gates: skip-existing / layout Off veto / per-pane Ask / Auto spawn
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe("apply_layout — gate dispositions and the addTerminal spawn probe", () => {
  it("skip-existing: an already-live pane id is skipped (narrated), the other spawns", async () => {
    const { ctx, probe } = makeCtx({
      layouts: [seedLayout()],
      projects: { projA: { directory: "/work/a" } },
      terminals: { p1: { id: "p1", projectId: "projA" } }, // p1 is already live
    });
    const result = await runAction(REGISTRY, "apply_layout", { layout_id: "layout_seed1" }, ctx);
    assert.strictEqual(result.kind, "ok");
    const out = String((result as { output: unknown }).output);
    assert.ok(out.includes("Already running (skipped): p1"), `p1 must be narrated as skipped (got: ${out})`);
    assert.ok(out.includes("Spawned: p2"), `p2 must be narrated as spawned (got: ${out})`);
    assert.strictEqual(probe.addTerminalCalls.length, 1, "only the non-live pane spawns");
    assert.strictEqual(probe.addTerminalCalls[0][0], "p2");
  });

  it("layout-level Off (apply_recipe gated Off) -> kind blocked, NOTHING spawns", async () => {
    const { ctx, probe } = makeCtx({
      layouts: [seedLayout()],
      projects: { projA: { directory: "/work/a" } },
      gates: { "null:apply_recipe": "Off" },
    });
    const result = await runAction(REGISTRY, "apply_layout", { layout_id: "layout_seed1" }, ctx);
    assert.strictEqual(result.kind, "blocked");
    assert.strictEqual(probe.addTerminalCalls.length, 0, "the Off veto must refuse the WHOLE layout");
    assert.strictEqual(probe.gateCalls.length, 0, "no per-pane gateOrDefer after the layout veto");
  });

  it("per-pane Ask: gateOrDefer('create_pane') deferred -> narrated as awaiting confirmation, no spawn", async () => {
    const { ctx, probe } = makeCtx({
      layouts: [seedLayout()],
      projects: { projA: { directory: "/work/a" } },
      gates: { "p1:create_pane": "Ask", "p2:create_pane": "Ask" },
      gate: { disposition: "deferred", actionId: "act-1", summary: "Create pane p1 (layout duo)" },
    });
    const result = await runAction(REGISTRY, "apply_layout", { layout_id: "layout_seed1" }, ctx);
    assert.strictEqual(result.kind, "ok");
    const out = String((result as { output: unknown }).output);
    assert.ok(
      out.includes("Awaiting confirmation (gated Ask): p1, p2"),
      `deferred panes must be narrated as awaiting confirmation (got: ${out})`
    );
    assert.strictEqual(probe.addTerminalCalls.length, 0, "Ask defers — nothing spawns now");
    assert.deepStrictEqual(
      probe.gateCalls.map((c) => ({ capability: c.capability, paneId: c.paneId })),
      [
        { capability: "create_pane", paneId: "p1" },
        { capability: "create_pane", paneId: "p2" },
      ],
      "each deferred pane routes through gateOrDefer('create_pane', paneId)"
    );
  });

  it("Auto: addTerminal probe gets the STORED command/cwd/preset/mode; empty cwd falls back to the project directory", async () => {
    const { ctx, probe } = makeCtx({
      layouts: [seedLayout()],
      projects: { projA: { directory: "/work/projdir" } },
    });
    const result = await runAction(REGISTRY, "apply_layout", { layout_id: "layout_seed1" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(probe.addTerminalCalls.length, 2, "both panes spawn on Auto");
    // p1: stored cwd wins
    assert.deepStrictEqual(probe.addTerminalCalls[0], [
      "p1",
      "/work/p1",
      "claude --resume",
      "Claude Code",
      "Full Auto",
      "",
      "projA",
    ]);
    // p2: cwd is "" -> the project directory fallback
    assert.deepStrictEqual(probe.addTerminalCalls[1], [
      "p2",
      "/work/projdir",
      "codex",
      "Custom",
      "Human-in-the-Loop",
      "",
      "projA",
    ]);
    const out = String((result as { output: unknown }).output);
    assert.ok(out.includes("Spawned: p1, p2"), `narration lists the spawned panes (got: ${out})`);
  });

  it("unknown layout id -> ok narration; nothing gated, nothing spawned", async () => {
    const { ctx, probe } = makeCtx({ projects: { projA: { directory: "/work/a" } } });
    const result = await runAction(REGISTRY, "apply_layout", { layout_id: "layout_ghost" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.ok(String((result as { output: unknown }).output).includes("not found"));
    assert.strictEqual(probe.addTerminalCalls.length, 0);
    assert.strictEqual(probe.gateCapabilityCalls.length, 0, "no audit row for a no-op");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (3) delete_layout
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe("delete_layout — unknown id is an ok no-op before the gate", () => {
  it("unknown id -> ok narration WITHOUT consulting gateOrDefer", async () => {
    const { ctx, probe } = makeCtx({ layouts: [seedLayout()] });
    const result = await runAction(REGISTRY, "delete_layout", { layout_id: "layout_ghost" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.ok(String((result as { output: unknown }).output).includes("not found"));
    assert.strictEqual(probe.gateCalls.length, 0, "an unknown-id no-op must never reach the gate");
  });

  it("known id (gate run): removed + save(true) + layouts_updated broadcast", async () => {
    const { ctx, probe, layouts } = makeCtx({ layouts: [seedLayout()] });
    const result = await runAction(REGISTRY, "delete_layout", { layout_id: "layout_seed1" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(layouts.length, 0, "the layout was removed");
    assert.ok(probe.saveCalls.includes(true));
    assert.ok(probe.broadcasts.some((m) => m.type === "layouts_updated"));
  });
});
