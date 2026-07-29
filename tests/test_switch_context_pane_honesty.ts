// tests/test_switch_context_pane_honesty.ts — WS3 (director decision: Option C + breadcrumbs,
// honesty over auto-targeting).
//
// PROBLEM: after a voice `switch_context` to project B, the model's PROJECT context has moved,
// but `coreState.activePaneId` (read via ctx.getActivePaneId(), server.ts:458) has NOT — only
// switch_active_pane moves it (src/actions/defs/orient.ts, src/voice/focusResolver.ts). If the
// operator then says "run tests in that pane", "that pane" silently resolves to a pane that may
// belong to an entirely different project. Option B (auto-retarget the focus) was REJECTED —
// Option C requires the tool response to be HONEST about the stale focus instead.
//
// REQUIRED post-fix behavior this suite pins (switchContext handler, src/actions/defs/orient.ts:
// 139-178; ownership predicate = findPaneOwningProject, src/paneOwnership.ts, the SAME resolver
// resolveBriefPane already reuses at src/voice/index.ts:268-277 — REUSE, do not reimplement):
//
//   1. When ctx.getActivePaneId() names a pane whose OWNING project (findPaneOwningProject) is
//      NOT the project just switched to, the { kind:"ok", output } payload ADDITIONALLY carries:
//        a. `notice` — substance "no active pane selected — say which pane"
//        b. `panes`  — the new project's roster (already present in the briefing; must survive)
//        c. `previousProject` / `previousFocusPane` / `switchBreadcrumb` — which project we
//           switched FROM and that the prior focus pane belongs to it
//      AND the broadcast `{type:"context_switched", activeProjectId}` frame (orient.ts:161)
//      ADDITIVELY carries `activePaneOrphaned: true`.
//   2. When the focused pane DOES belong to the new project, OR there is no focused pane at all,
//      the output stays BYTE-IDENTICAL to today's pure briefing, and the frame carries no truthy
//      `activePaneOrphaned`. The handler must still CONSULT ctx.getActivePaneId() to reach that
//      conclusion (pinned via a call-count spy) — this is the "wiring of the seam" part of the
//      workstream, not just a no-op passthrough.
//   3. HARD constraints: ctx.setActivePane (the coreState.activePaneId mutator) is NEVER called
//      by switch_context — no auto-targeting, Option B stays rejected. The existing ordered side
//      effects (the ASYMMETRY HAZARD at orient.ts:118-123 — unconditional ledger/settings writes,
//      then broadcastLedgerUpdate, then context_switched, then the live sync, then the briefing
//      read) still ALL fire, in the same relative order, in the orphaned branch too — the honesty
//      additions are additive-AFTER, never a short-circuit.
//
// Ownership-predicate robustness: one scenario resolves the stale pane via a LEDGER-ONLY pane in
// a THIRD (backgrounded) project — absent from `manager.terminals` — to prove the handler walks
// the real findPaneOwningProject resolution chain rather than a shallow "check terminals only"
// stand-in that would silently miss ledger-only panes.
//
// Runner: npx tsx --test --test-force-exit tests/test_switch_context_pane_honesty.ts

import { describe, it } from "node:test";
import assert from "node:assert";

import { switchContext } from "../src/actions/defs/orient";
import type { ActionContext } from "../src/actions/types";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Fixture world: three projects.
//   proj_a — the project active BEFORE this switch_context call; owns pane_a1 (LIVE terminal).
//   proj_b — the project this switch_context call switches TO; owns pane_b1 (LIVE terminal).
//   proj_c — a backgrounded THIRD project; owns pane_c1, LEDGER-ONLY (no live terminal entry) —
//            exercises findPaneOwningProject's ledger fallback, not just its live-terminal tier.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const PANE_A1 = {
  pane_id: "pane_a1", name: "Pane A1", runtime_type: "claude-code",
  last_known_state: "Idle", is_busy: false, alive: true,
  permissions_mode: "Human-in-the-Loop", tool_preset: "Claude Code",
};
const PANE_B1 = {
  pane_id: "pane_b1", name: "Pane B1", runtime_type: "claude-code",
  last_known_state: "Running", is_busy: true, alive: true,
  permissions_mode: "Human-in-the-Loop", tool_preset: "Claude Code",
};
const PANE_C1 = {
  pane_id: "pane_c1", name: "Pane C1", runtime_type: "codex",
  last_known_state: "Idle", is_busy: false, alive: true,
  permissions_mode: "Human-in-the-Loop", tool_preset: "Codex",
};

const BRIEFING_B = {
  project_id: "proj_b", summary: "Project B summary", directory: "/tmp/b",
  panes: [PANE_B1], notes: ["note-b"], key_codebase_terms: ["term-b"],
};

/**
 * Builds a fresh manager/ctx pair per test. `initialActivePaneId` seeds ctx.getActivePaneId()'s
 * return value (the server's per-connection focused pane BEFORE the switch_context call runs).
 */
function buildFixture(initialActivePaneId: string | null) {
  const events: string[] = [];
  const frames: Array<Record<string, unknown>> = [];
  const setActivePaneCalls: Array<string | null> = [];
  let activePaneId = initialActivePaneId;
  let getActivePaneIdCalls = 0;

  const workspaces: Record<string, any> = {
    proj_a: {
      id: "proj_a", name: "Project A", directory: "/tmp/a", summary: "", notes: [],
      panes: { pane_a1: PANE_A1 },
    },
    proj_b: {
      id: "proj_b", name: "Project B", directory: "/tmp/b", summary: "Project B summary",
      notes: ["note-b"], keyTerms: ["term-b"], panes: { pane_b1: PANE_B1 },
    },
    proj_c: {
      id: "proj_c", name: "Project C", directory: "/tmp/c", summary: "", notes: [],
      panes: { pane_c1: PANE_C1 },
    },
  };

  // ledger.switchContext mutates the ACTIVE project, exactly like the real ledger — so any
  // ownership check the handler performs (before or after that call) sees consistent state:
  // proj_a is active on entry, proj_b is active once switchContext(projectId) has run.
  let activeLedgerProjectId = "proj_a";

  const manager = {
    refreshLedger: () => { events.push("sync"); },
    listPanes: () => { events.push("sync"); return []; },
    settings: { projects: { activeContext: "proj_a", localWorkspacePath: "/tmp/a" } },
    saveSettings: () => { events.push("saveSettings"); },
    // pane_c1 is deliberately ABSENT here (ledger-only, no live terminal) — see fixture-world
    // comment above.
    terminals: {
      pane_a1: { projectId: "proj_a" },
      pane_b1: { projectId: "proj_b" },
    },
    ledger: {
      switchContext: (id: string) => { events.push(`switchContext:${id}`); activeLedgerProjectId = id; },
      workspaces,
      getActiveProject: () => workspaces[activeLedgerProjectId] ?? null,
      getProject: (id: string) => workspaces[id] ?? null,
      getProjectIdForPane: (paneId: string) => {
        for (const [pid, ws] of Object.entries(workspaces)) {
          if ((ws as any).panes?.[paneId]) return pid;
        }
        return null;
      },
      getProjectBriefing: (id: string) => {
        events.push(`briefing:${id}`);
        if (id === "proj_b") return { ...BRIEFING_B, panes: [...BRIEFING_B.panes] };
        return null;
      },
    },
  } as unknown as ActionContext["manager"];

  const ctx = {
    manager,
    broadcastLedgerUpdate: () => { events.push("ledger_updated"); },
    broadcast: (msg: Record<string, unknown>) => { events.push(String(msg.type)); frames.push(msg); },
    effectiveCapabilityGateFor: () => "Auto",
    injectMemoryBrief: () => { events.push("injectMemoryBrief"); },
    // The seam this workstream must wire in: the handler reads the CURRENT focused pane to
    // decide honesty vs. pure-briefing. Absent from switch_context's handler today.
    getActivePaneId: () => { getActivePaneIdCalls++; return activePaneId; },
    // HARD constraint spy: switch_context must NEVER call this (no auto-targeting).
    setActivePane: (id: string | null) => { setActivePaneCalls.push(id); activePaneId = id; },
  } as unknown as ActionContext;

  return {
    ctx, events, frames, setActivePaneCalls,
    getActivePaneIdCallCount: () => getActivePaneIdCalls,
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// 1. Orphaned focus — the focused pane belongs to a DIFFERENT project than the one just
//    switched to. The handler must speak up (Option C), never auto-retarget (Option B rejected).
// ════════════════════════════════════════════════════════════════════════════════════════════
describe("switch_context pane honesty — orphaned focus (WS3)", () => {
  it("flags the stale focus pane when it belongs to the PREVIOUSLY-ACTIVE project (typical case)", () => {
    const { ctx, events, frames, setActivePaneCalls, getActivePaneIdCallCount } = buildFixture("pane_a1");

    const res = switchContext.handler({ project_id: "proj_b" }, ctx) as any;

    assert.strictEqual(res.kind, "ok", "switch_context still answers kind:ok");
    const output = res.output;
    assert.ok(output && typeof output === "object", "output must be an object payload");

    // The full original briefing must still be there — additive, never replacing.
    for (const key of Object.keys(BRIEFING_B)) {
      assert.deepStrictEqual(
        output[key], (BRIEFING_B as any)[key],
        `briefing field '${key}' must be preserved unchanged alongside the honesty additions`,
      );
    }

    // (a) explicit "no active pane selected — say which pane" statement.
    assert.strictEqual(typeof output.notice, "string", "output.notice must be a string (missing today)");
    assert.match(output.notice, /no active pane/i, "must state no active pane is selected");
    assert.match(output.notice, /say which pane/i, "must tell the operator to say which pane");

    // (b) the new project's pane roster is present (reused from the briefing already fetched,
    // NOT re-fetched) even in the orphaned branch.
    assert.deepStrictEqual(output.panes, BRIEFING_B.panes, "the new project's pane roster must be included");

    // (c) breadcrumb: which project we switched FROM + that the prior focus pane belongs to it.
    assert.strictEqual(output.activePaneOrphaned, true, "activePaneOrphaned must be true (missing today)");
    assert.deepStrictEqual(
      output.previousProject, { project_id: "proj_a", name: "Project A" },
      "previousProject must identify the project OWNING the stale pane",
    );
    assert.deepStrictEqual(
      output.previousFocusPane, { pane_id: "pane_a1", name: "Pane A1" },
      "previousFocusPane must identify the stale pane itself",
    );
    assert.strictEqual(typeof output.switchBreadcrumb, "string", "switchBreadcrumb must be a re-orientation sentence");
    assert.ok(
      output.switchBreadcrumb.includes("proj_a") || output.switchBreadcrumb.includes("Project A"),
      "breadcrumb must name the FROM project",
    );
    assert.ok(
      output.switchBreadcrumb.includes("pane_a1") || output.switchBreadcrumb.includes("Pane A1"),
      "breadcrumb must name the stale focus pane",
    );
    assert.match(output.switchBreadcrumb, /belong/i, "breadcrumb must state the prior pane belongs to the prior project");

    // Visual mirror: the context_switched frame carries the SAME honesty flag, additively.
    const frame = frames.find((f) => f.type === "context_switched");
    assert.ok(frame, "context_switched frame must still be broadcast");
    assert.strictEqual(frame!.activeProjectId, "proj_b", "frame still carries the new project id");
    assert.strictEqual(frame!.activePaneOrphaned, true, "the frame must additively carry activePaneOrphaned:true");

    // HARD constraint: no auto-targeting — ctx.setActivePane (coreState.activePaneId) untouched.
    assert.strictEqual(setActivePaneCalls.length, 0, "switch_context must NEVER call setActivePane (Option B rejected)");

    // The existing ordered side effects (the ASYMMETRY HAZARD) must still ALL fire.
    // VERIFIER PATCH: pinned as the EXACT event sequence, not just membership + one ordering
    // pair — the spec says the ordered side effects are preserved EXACTLY and the honesty
    // additions are event-silent (ownership resolution goes through findPaneOwningProject /
    // getProject / getActivePaneId, none of which touch these seams). This also pins that the
    // roster comes from the briefing ALREADY fetched — a second `briefing:proj_b` (a re-fetch)
    // or an extra `sync` (a listPanes()-based roster) fails the exact match.
    assert.deepStrictEqual(
      events,
      ["switchContext:proj_b", "saveSettings", "ledger_updated", "context_switched", "sync", "injectMemoryBrief", "briefing:proj_b"],
      "the pre-existing ordered side effects must fire EXACTLY as today — the honesty additions are additive-after and event-silent",
    );

    assert.ok(getActivePaneIdCallCount() >= 1, "the handler must consult ctx.getActivePaneId() to detect the stale focus");
  });

  it("resolves ownership via the LEDGER for a backgrounded THIRD project's pane (no live terminal) — proves the real findPaneOwningProject predicate is reused, not a live-terminal-only shortcut", () => {
    const { ctx, frames, setActivePaneCalls, getActivePaneIdCallCount } = buildFixture("pane_c1");

    const res = switchContext.handler({ project_id: "proj_b" }, ctx) as any;

    assert.strictEqual(res.kind, "ok");
    const output = res.output;

    assert.strictEqual(output.activePaneOrphaned, true, "a ledger-only stale pane must still be flagged orphaned");
    assert.deepStrictEqual(
      output.previousProject, { project_id: "proj_c", name: "Project C" },
      "previousProject must be the pane's TRUE owner (proj_c), not merely 'whatever was active before' (proj_a) — proves ownership is resolved via the pane, per the reused predicate",
    );
    assert.deepStrictEqual(output.previousFocusPane, { pane_id: "pane_c1", name: "Pane C1" });
    assert.match(output.notice, /no active pane/i);
    assert.match(output.notice, /say which pane/i);
    assert.ok(
      output.switchBreadcrumb.includes("proj_c") || output.switchBreadcrumb.includes("Project C"),
      "breadcrumb must name proj_c (the ledger-resolved owner), not proj_a",
    );

    const frame = frames.find((f) => f.type === "context_switched");
    assert.strictEqual(frame!.activePaneOrphaned, true);

    assert.strictEqual(setActivePaneCalls.length, 0, "no auto-targeting here either");
    assert.ok(getActivePaneIdCallCount() >= 1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 1b. REVIEWER ATTACK — UNRESOLVABLE owner. resolveBriefPane's pinned semantics (the predicate
//     this workstream must MATCH) fail toward isolation: "A pane whose owner cannot be resolved
//     is dropped too (fail toward isolation — we cannot confirm affinity)." A ghost focus (pane
//     closed + evicted from every workspace while coreState.activePaneId still names it) must
//     therefore be treated as ORPHANED — say so — never silently blessed as belonging.
// ════════════════════════════════════════════════════════════════════════════════════════════
describe("switch_context pane honesty — unresolvable owner fails toward orphaned (WS3)", () => {
  it("a focused pane in NO workspace (owner unresolvable) is flagged orphaned with a degraded breadcrumb", () => {
    const { ctx, frames, setActivePaneCalls } = buildFixture("pane_ghost");

    const res = switchContext.handler({ project_id: "proj_b" }, ctx) as any;

    assert.strictEqual(res.kind, "ok");
    const output = res.output;
    assert.strictEqual(
      output.activePaneOrphaned, true,
      "an unresolvable owner must be treated as orphaned (resolveBriefPane semantics: fail toward isolation), not silently blessed",
    );
    assert.match(output.notice, /no active pane/i);
    assert.match(output.notice, /say which pane/i);
    // Degraded honestly: the owner is UNKNOWN, so no previousProject claim may be invented.
    assert.strictEqual(output.previousProject, undefined, "must not fabricate an owning project for an unresolvable pane");
    assert.deepStrictEqual(
      output.previousFocusPane, { pane_id: "pane_ghost", name: "pane_ghost" },
      "the stale pane is still identified (by id — no pane record exists to name it from)",
    );
    assert.ok(output.switchBreadcrumb.includes("pane_ghost"), "breadcrumb must name the ghost pane");
    // The briefing itself must still be fully present (additive, never replacing).
    for (const key of Object.keys(BRIEFING_B)) {
      assert.deepStrictEqual(output[key], (BRIEFING_B as any)[key], `briefing field '${key}' preserved`);
    }

    const frame = frames.find((f) => f.type === "context_switched");
    assert.strictEqual(frame!.activePaneOrphaned, true, "the frame mirrors the orphaned verdict");
    assert.strictEqual(setActivePaneCalls.length, 0, "still no auto-targeting");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════
// 2. Byte-compatible cases — the payload must stay pure-briefing, but the handler must actually
//    CONSULT ctx.getActivePaneId() to reach that conclusion (the seam is wired, not skipped).
// ════════════════════════════════════════════════════════════════════════════════════════════
describe("switch_context pane honesty — byte-compatible cases (WS3)", () => {
  it("stays byte-identical to today's briefing when the focused pane belongs to the NEW project", () => {
    const { ctx, frames, setActivePaneCalls, getActivePaneIdCallCount } = buildFixture("pane_b1");

    const res = switchContext.handler({ project_id: "proj_b" }, ctx) as any;

    assert.strictEqual(res.kind, "ok");
    assert.deepStrictEqual(
      res.output, { ...BRIEFING_B, panes: [PANE_B1] },
      "output must be the PURE briefing — no additive fields when the focused pane is owned by the target project",
    );

    const frame = frames.find((f) => f.type === "context_switched");
    assert.ok(frame);
    assert.ok(!frame!.activePaneOrphaned, "activePaneOrphaned must not be truthy when the pane is not stale");

    assert.strictEqual(setActivePaneCalls.length, 0);
    assert.ok(
      getActivePaneIdCallCount() >= 1,
      "the handler must still consult ctx.getActivePaneId() to CONFIRM the pane is not stale (missing today — today's handler never reads it at all)",
    );
  });

  it("stays byte-identical to today's briefing when there is no focused pane at all", () => {
    const { ctx, frames, setActivePaneCalls, getActivePaneIdCallCount } = buildFixture(null);

    const res = switchContext.handler({ project_id: "proj_b" }, ctx) as any;

    assert.strictEqual(res.kind, "ok");
    assert.deepStrictEqual(
      res.output, { ...BRIEFING_B, panes: [PANE_B1] },
      "output must be the PURE briefing when there is no focused pane to be stale",
    );

    const frame = frames.find((f) => f.type === "context_switched");
    assert.ok(frame);
    assert.ok(!frame!.activePaneOrphaned);

    assert.strictEqual(setActivePaneCalls.length, 0);
    assert.ok(
      getActivePaneIdCallCount() >= 1,
      "the handler must call ctx.getActivePaneId() even with no focus, to know there is nothing stale (missing today)",
    );
  });

  // VERIFIER PATCH (regression guard — GREEN today, like the WS1 suite's additive pins): the
  // UNKNOWN-project fallback path. With a stale focused pane (pane_a1, owned by proj_a) and an
  // unknown target id, a naive orphanhood predicate ("focused pane's owner !== target project")
  // is TRUE — a lazy implementation would bolt notice/breadcrumb/orphan keys onto the
  // { error: "Project not found" } payload (there is no briefing/roster to be honest ABOUT, and
  // the ledger no-ops on the unknown id so the focus pane is not actually orphaned). Nothing else
  // pins this combination: tests/test_c55_batch_b.ts pins the error payload byte-exactly but its
  // REST ctx has no getActivePaneId, so it can never see the stale-pane branch. The ASYMMETRY
  // HAZARD (unconditional settings writes even for unknown ids) must also survive here.
  it("keeps the unknown-project { error } fallback byte-identical — honesty additions never attach to a failed switch", () => {
    const { ctx, events, frames, setActivePaneCalls } = buildFixture("pane_a1");

    const res = switchContext.handler({ project_id: "proj_nope" }, ctx) as any;

    assert.strictEqual(res.kind, "ok");
    assert.deepStrictEqual(
      res.output, { error: "Project not found" },
      "the unknown-id fallback payload must stay EXACTLY { error: 'Project not found' } — no notice/roster/breadcrumb/orphan keys",
    );

    const frame = frames.find((f) => f.type === "context_switched");
    assert.ok(frame, "the context_switched frame still fires unconditionally (today's behavior, preserved)");
    assert.ok(
      !frame!.activePaneOrphaned,
      "no truthy activePaneOrphaned on a FAILED switch — the ledger no-oped, so the focus pane was never actually orphaned",
    );

    assert.strictEqual(setActivePaneCalls.length, 0, "no auto-targeting on the error path either");

    // ASYMMETRY HAZARD preserved: the unconditional ledger/settings writes still happen even for
    // an unknown id (documented at orient.ts:118-123 — preserved exactly, do NOT 'fix').
    assert.ok(events.includes("switchContext:proj_nope"), "ledger.switchContext still runs for the unknown id");
    assert.ok(events.includes("saveSettings"), "saveSettings still runs for the unknown id");
    assert.strictEqual(
      (ctx.manager as any).settings.projects.activeContext, "proj_nope",
      "the unconditional settings.activeContext write still lands even for an unknown id",
    );
  });
});
