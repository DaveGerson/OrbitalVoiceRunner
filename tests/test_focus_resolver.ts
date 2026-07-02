// tests/test_focus_resolver.ts — focus_pane conversational resolver (voice-UX wave 3, fz1-owned).
//
// Covers: candidate collection (ordinal/project/preset/state/recency/active derivation), the
// fail-closed literal TS floor (never fuzzy — exact/unique-prefix/ordinal only), all three
// voiceUx.focusBindPolicy variants (confirm/echo/tiered), the Off-veto guard, a nonexistent-pane
// bind target, and that runFocusPane carries NO shadow state across calls (D1 — a new focus
// request is always independent, so "interruption" is a non-issue by construction).
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  collectFocusCandidates,
  literalResolve,
  runFocusPane,
} from "../src/voice/focusResolver";
import type { FocusCandidate, FocusResolution } from "../src/voice/policyClient";
import { DEFAULT_VOICE_UX, type VoiceUxSettings } from "../src/types";
import type { ActionContext } from "../src/actions/types";

// ── fakes ────────────────────────────────────────────────────────────────────────────────────────

interface FakePaneMeta {
  pane_id: string;
  name: string;
  last_known_state?: string;
  is_busy?: boolean;
  tool_preset?: string;
  last_status_change_at?: string;
}

interface FakeTerm {
  toolPreset: string;
  status: string;
  lastStatusChangeAt: number;
  projectId: string;
}

interface CtxOpts {
  groups: Array<{ project_id: string; name: string; panes: FakePaneMeta[] }>;
  terminals?: Record<string, FakeTerm>;
  activePaneId?: string | null;
  gate?: (paneId: string | null) => string;
  voiceUx?: Partial<VoiceUxSettings>;
  policies?: { resolveFocus: (reference: string, candidates: FocusCandidate[]) => Promise<FocusResolution | null> };
}

interface CtxHandle {
  ctx: ActionContext;
  setActiveCalls: Array<string | null>;
  broadcasts: unknown[];
}

function makeCtx(opts: CtxOpts): CtxHandle {
  const terminals = opts.terminals ?? {};
  const setActiveCalls: Array<string | null> = [];
  const broadcasts: unknown[] = [];
  const workspaces: Record<string, { id: string; name: string; panes: Record<string, FakePaneMeta> }> = {};
  for (const g of opts.groups) {
    const panes: Record<string, FakePaneMeta> = {};
    for (const p of g.panes) panes[p.pane_id] = p;
    workspaces[g.project_id] = { id: g.project_id, name: g.name, panes };
  }

  const manager: any = {
    terminals,
    ledger: { workspaces },
    settings: { voiceUx: opts.voiceUx ? { ...DEFAULT_VOICE_UX, ...opts.voiceUx } : undefined },
    listPanes: () => opts.groups.map((g) => ({ project_id: g.project_id, panes: g.panes })),
  };

  const ctx = {
    manager,
    session: null,
    redact: (s: string) => s,
    broadcast: (m: unknown) => { broadcasts.push(m); },
    getActivePaneId: () => opts.activePaneId ?? null,
    setActivePane: (id: string | null) => { setActiveCalls.push(id); },
    effectiveCapabilityGateFor: (paneId: string | null) => (opts.gate ? opts.gate(paneId) : "Auto"),
    policies: opts.policies,
  } as unknown as ActionContext;

  return { ctx, setActiveCalls, broadcasts };
}

function pane(id: string, name: string, over: Partial<FakePaneMeta> = {}): FakePaneMeta {
  return { pane_id: id, name, last_known_state: "Idle", is_busy: false, ...over };
}

function term(over: Partial<FakeTerm> = {}): FakeTerm {
  return { toolPreset: "Claude Code", status: "Idle", lastStatusChangeAt: 1000, projectId: "proj1", ...over };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// collectFocusCandidates
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("collectFocusCandidates", () => {
  it("assigns 1-based ordinals in listPanes() display order across projects", () => {
    const { ctx } = makeCtx({
      groups: [
        { project_id: "p1", name: "Alpha", panes: [pane("a1", "build"), pane("a2", "tests")] },
        { project_id: "p2", name: "Bravo", panes: [pane("b1", "deploy")] },
      ],
    });
    const cands = collectFocusCandidates(ctx);
    assert.deepEqual(
      cands.map((c) => [c.paneId, c.ordinal]),
      [["a1", 1], ["a2", 2], ["b1", 3]],
    );
  });

  it("carries project id/name through to each candidate", () => {
    const { ctx } = makeCtx({
      groups: [{ project_id: "p1", name: "Alpha Project", panes: [pane("a1", "build")] }],
    });
    const [c] = collectFocusCandidates(ctx);
    assert.equal(c.projectId, "p1");
    assert.equal(c.projectName, "Alpha Project");
  });

  it("derives presetLabel/state/isBusy/lastActiveAt from the LIVE terminal when present", () => {
    const { ctx } = makeCtx({
      groups: [{ project_id: "p1", name: "Alpha", panes: [pane("a1", "build", { last_known_state: "Idle", is_busy: false })] }],
      terminals: { a1: term({ toolPreset: "Codex", status: "Running", lastStatusChangeAt: 42_000 }) },
    });
    const [c] = collectFocusCandidates(ctx);
    assert.equal(c.presetLabel, "Codex");
    assert.equal(c.state, "Running");
    assert.equal(c.isBusy, true, "Running term -> isBusy true, even though the stale PaneMeta says false");
    assert.equal(c.lastActiveAt, 42_000);
  });

  it("falls back to the persisted PaneMeta fields when no LIVE terminal exists", () => {
    const { ctx } = makeCtx({
      groups: [{
        project_id: "p1", name: "Alpha",
        panes: [pane("a1", "build", { last_known_state: "Exited", is_busy: false, tool_preset: "Antigravity", last_status_change_at: new Date(5000).toISOString() })],
      }],
      terminals: {},
    });
    const [c] = collectFocusCandidates(ctx);
    assert.equal(c.presetLabel, "Antigravity");
    assert.equal(c.state, "Exited");
    assert.equal(c.isBusy, false);
    assert.equal(c.lastActiveAt, 5000);
  });

  it("marks isActive true only for ctx.getActivePaneId()'s pane", () => {
    const { ctx } = makeCtx({
      groups: [{ project_id: "p1", name: "Alpha", panes: [pane("a1", "build"), pane("a2", "tests")] }],
      activePaneId: "a2",
    });
    const cands = collectFocusCandidates(ctx);
    assert.equal(cands.find((c) => c.paneId === "a1")!.isActive, false);
    assert.equal(cands.find((c) => c.paneId === "a2")!.isActive, true);
  });

  it("empty world -> empty candidate list", () => {
    const { ctx } = makeCtx({ groups: [] });
    assert.deepEqual(collectFocusCandidates(ctx), []);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// literalResolve — the fail-closed TS floor (D2: never fuzzy)
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("literalResolve (fail-closed TS floor)", () => {
  const candidates: FocusCandidate[] = [
    { paneId: "a1", paneName: "build", projectId: "p1", projectName: "Alpha", presetLabel: "Claude Code", ordinal: 1, state: "Idle", isBusy: false, lastActiveAt: 1000, isActive: false },
    { paneId: "a2", paneName: "tests", projectId: "p1", projectName: "Alpha", presetLabel: "Claude Code", ordinal: 2, state: "Running", isBusy: true, lastActiveAt: 2000, isActive: false },
    { paneId: "a3", paneName: "build-worker", projectId: "p1", projectName: "Alpha", presetLabel: "Codex", ordinal: 3, state: "Idle", isBusy: false, lastActiveAt: 3000, isActive: false },
  ];

  it("exact case-insensitive NAME match -> confidence 1, no alternatives", () => {
    assert.deepEqual(literalResolve("BUILD", candidates), { paneId: "a1", confidence: 1, alternatives: [] });
  });

  it("exact case-insensitive ID match -> confidence 1", () => {
    const r = literalResolve("A2", candidates);
    assert.equal(r.paneId, "a2");
    assert.equal(r.confidence, 1);
  });

  it("UNIQUE prefix match on pane name -> confidence 1", () => {
    const r = literalResolve("tes", candidates);
    assert.equal(r.paneId, "a2");
    assert.equal(r.confidence, 1);
  });

  it("AMBIGUOUS prefix (matches >1 pane) -> no match, confidence 0, alternatives listed", () => {
    // "build" itself is an exact match for a1 (handled above); a genuinely ambiguous PREFIX
    // (matching >1 candidate, none exact) is exercised via a shared prefix with no exact hit.
    const ambiguousCandidates: FocusCandidate[] = [
      { ...candidates[0], paneName: "build-a" },
      { ...candidates[2], paneName: "build-b" },
    ];
    const r = literalResolve("build", ambiguousCandidates);
    assert.equal(r.paneId, null);
    assert.equal(r.confidence, 0);
    assert.equal(r.alternatives.length, 2);
  });

  it("exact ordinal WORD ('two') resolves the pane at that display position -> confidence 1", () => {
    const r = literalResolve("two", candidates);
    assert.equal(r.paneId, "a2");
    assert.equal(r.confidence, 1);
  });

  it("exact ordinal DIGIT ('3') resolves the pane at that display position -> confidence 1", () => {
    const r = literalResolve("3", candidates);
    assert.equal(r.paneId, "a3");
  });

  it("'pane two' / 'pane number 2' phrasing resolves by ordinal", () => {
    assert.equal(literalResolve("pane two", candidates).paneId, "a2");
    assert.equal(literalResolve("pane number 2", candidates).paneId, "a2");
  });

  it("NEVER fuzzy: a mid-string substring that is not a PREFIX yields no match", () => {
    // "uild" is a substring of "build" but not a prefix -> the literal floor must NOT match it,
    // proving it never widens to substring/fuzzy scoring.
    const r = literalResolve("uild", candidates);
    assert.equal(r.paneId, null);
    assert.equal(r.confidence, 0);
  });

  it("NEVER fuzzy: a state/recency phrase like 'the stuck one' (python-only scoring) yields no match", () => {
    const r = literalResolve("the stuck one", candidates);
    assert.equal(r.paneId, null);
    assert.equal(r.confidence, 0);
  });

  it("no candidates -> no match, empty alternatives", () => {
    assert.deepEqual(literalResolve("build", []), { paneId: null, confidence: 0, alternatives: [] });
  });

  it("blank reference -> no match", () => {
    assert.deepEqual(literalResolve("   ", candidates), { paneId: null, confidence: 0, alternatives: [] });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// runFocusPane — daemon-down fallback, bind policies, Off-veto, nonexistent pane, no-shadow-state
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("runFocusPane — daemon-down literal fallback", () => {
  it("ctx.policies absent -> uses literalResolve; an exact unique match silently binds", async () => {
    const { ctx, setActiveCalls, broadcasts } = makeCtx({
      groups: [{ project_id: "p1", name: "Alpha", panes: [pane("a1", "build"), pane("a2", "tests")] }],
    });
    const result = await runFocusPane("build", ctx);
    assert.deepEqual(result, { kind: "ok", output: "Focused pane 'a1'." });
    assert.deepEqual(setActiveCalls, ["a1"]);
    assert.deepEqual(broadcasts, [{ type: "switch_active_pane", paneId: "a1" }]);
  });

  it("ctx.policies.resolveFocus resolves null (daemon miss) -> falls back to literalResolve, never fuzzy", async () => {
    const { ctx, setActiveCalls } = makeCtx({
      groups: [{ project_id: "p1", name: "Alpha", panes: [pane("a1", "build")] }],
      policies: { resolveFocus: async () => null },
    });
    const result = await runFocusPane("the stuck one", ctx); // would need python fuzzy scoring to resolve
    assert.equal(result.kind, "clarify");
    assert.deepEqual(setActiveCalls, [], "no bind occurred — the literal floor found nothing");
  });

  it("literal floor finds no match and there are no panes -> clarify with 'no panes open'", async () => {
    const { ctx, setActiveCalls } = makeCtx({ groups: [] });
    const result = await runFocusPane("the build pane", ctx);
    assert.equal(result.kind, "clarify");
    assert.match((result as { text: string }).text, /don't see any panes/i);
    assert.deepEqual(setActiveCalls, []);
  });

  it("literal floor finds no match with panes present -> clarify lists pane names", async () => {
    const { ctx } = makeCtx({
      groups: [{ project_id: "p1", name: "Alpha", panes: [pane("a1", "build"), pane("a2", "tests")] }],
    });
    const result = await runFocusPane("something entirely unrelated", ctx);
    assert.equal(result.kind, "clarify");
    assert.match((result as { text: string }).text, /build/);
    assert.match((result as { text: string }).text, /tests/);
  });
});

describe("runFocusPane — bind policies (confirm default / echo / tiered)", () => {
  const fuzzyResolution: FocusResolution = { paneId: "a1", confidence: 0.6, alternatives: [] };

  it("policy 'confirm' (default): fuzzy unique -> clarify 'Did you mean' WITHOUT binding", async () => {
    const { ctx, setActiveCalls } = makeCtx({
      groups: [{ project_id: "p1", name: "Alpha", panes: [pane("a1", "build")] }],
      policies: { resolveFocus: async () => fuzzyResolution },
    });
    const result = await runFocusPane("buld", ctx);
    assert.equal(result.kind, "clarify");
    assert.match((result as { text: string }).text, /Did you mean.*build/);
    assert.deepEqual(setActiveCalls, [], "confirm policy never binds a fuzzy match");
  });

  it("policy 'echo': fuzzy unique -> binds AND narrates the pane name", async () => {
    const { ctx, setActiveCalls } = makeCtx({
      groups: [{ project_id: "p1", name: "Alpha", panes: [pane("a1", "build")] }],
      policies: { resolveFocus: async () => fuzzyResolution },
      voiceUx: { focusBindPolicy: "echo" },
    });
    const result = await runFocusPane("buld", ctx);
    assert.deepEqual(result, { kind: "ok", output: "Focusing 'build'." });
    assert.deepEqual(setActiveCalls, ["a1"]);
  });

  it("policy 'tiered': confidence >= 0.8 binds with echo", async () => {
    const { ctx, setActiveCalls } = makeCtx({
      groups: [{ project_id: "p1", name: "Alpha", panes: [pane("a1", "build")] }],
      policies: { resolveFocus: async () => ({ paneId: "a1", confidence: 0.85, alternatives: [] }) },
      voiceUx: { focusBindPolicy: "tiered" },
    });
    const result = await runFocusPane("buld", ctx);
    assert.deepEqual(result, { kind: "ok", output: "Focusing 'build'." });
    assert.deepEqual(setActiveCalls, ["a1"]);
  });

  it("policy 'tiered': confidence < 0.8 behaves like 'confirm' (clarify, no bind)", async () => {
    const { ctx, setActiveCalls } = makeCtx({
      groups: [{ project_id: "p1", name: "Alpha", panes: [pane("a1", "build")] }],
      policies: { resolveFocus: async () => ({ paneId: "a1", confidence: 0.79, alternatives: [] }) },
      voiceUx: { focusBindPolicy: "tiered" },
    });
    const result = await runFocusPane("buld", ctx);
    assert.equal(result.kind, "clarify");
    assert.deepEqual(setActiveCalls, []);
  });

  it("exact/unique (confidence===1) always silently binds regardless of focusBindPolicy", async () => {
    const { ctx, setActiveCalls } = makeCtx({
      groups: [{ project_id: "p1", name: "Alpha", panes: [pane("a1", "build")] }],
      policies: { resolveFocus: async () => ({ paneId: "a1", confidence: 1, alternatives: [] }) },
      voiceUx: { focusBindPolicy: "confirm" },
    });
    const result = await runFocusPane("build", ctx);
    assert.deepEqual(result, { kind: "ok", output: "Focused pane 'a1'." });
    assert.deepEqual(setActiveCalls, ["a1"]);
  });

  it(">=2 close alternatives (within 0.15 of top) -> clarify listing top names, no bind", async () => {
    const { ctx, setActiveCalls } = makeCtx({
      groups: [{ project_id: "p1", name: "Alpha", panes: [pane("a1", "build"), pane("a2", "build-2"), pane("a3", "build-3")] }],
      policies: {
        resolveFocus: async () => ({
          paneId: "a1",
          confidence: 0.7,
          alternatives: [{ paneId: "a2", score: 0.65 }, { paneId: "a3", score: 0.6 }],
        }),
      },
    });
    const result = await runFocusPane("build", ctx);
    assert.equal(result.kind, "clarify");
    const text = (result as { text: string }).text;
    assert.match(text, /build/);
    assert.match(text, /build-2/);
    assert.deepEqual(setActiveCalls, []);
  });

  it("no match (paneId null) -> clarify, regardless of policy", async () => {
    const { ctx, setActiveCalls } = makeCtx({
      groups: [{ project_id: "p1", name: "Alpha", panes: [pane("a1", "build")] }],
      policies: { resolveFocus: async () => ({ paneId: null, confidence: 0, alternatives: [] }) },
      voiceUx: { focusBindPolicy: "echo" },
    });
    const result = await runFocusPane("gibberish", ctx);
    assert.equal(result.kind, "clarify");
    assert.deepEqual(setActiveCalls, []);
  });
});

describe("runFocusPane — Off-veto and nonexistent-pane guards (mirrors switch_active_pane)", () => {
  it("focus_pane gated Off -> blocked text, no bind, no broadcast", async () => {
    const { ctx, setActiveCalls, broadcasts } = makeCtx({
      groups: [{ project_id: "p1", name: "Alpha", panes: [pane("a1", "build")] }],
      gate: () => "Off",
    });
    const result = await runFocusPane("build", ctx);
    assert.equal(result.kind, "ok");
    assert.match((result as { output: string }).output, /gated Off/);
    assert.deepEqual(setActiveCalls, []);
    assert.deepEqual(broadcasts, []);
  });

  it("resolution names a pane id that no longer exists -> 'Cannot switch' text, no bind", async () => {
    const { ctx, setActiveCalls } = makeCtx({
      groups: [{ project_id: "p1", name: "Alpha", panes: [pane("a1", "build")] }],
      policies: { resolveFocus: async () => ({ paneId: "ghost", confidence: 1, alternatives: [] }) },
    });
    const result = await runFocusPane("ghost pane", ctx);
    assert.equal(result.kind, "ok");
    assert.match((result as { output: string }).output, /does not exist/);
    assert.deepEqual(setActiveCalls, []);
  });
});

describe("runFocusPane — no shadow state (D1): consecutive calls are fully independent", () => {
  it("a clarify from one call never affects the NEXT call's resolution (no pending window)", async () => {
    const { ctx, setActiveCalls } = makeCtx({
      groups: [{ project_id: "p1", name: "Alpha", panes: [pane("a1", "build"), pane("a2", "tests")] }],
      policies: {
        resolveFocus: async (reference: string) =>
          reference === "buld" ? { paneId: "a1", confidence: 0.6, alternatives: [] } : null,
      },
    });

    // First call: fuzzy -> clarify, no bind (confirm default).
    const first = await runFocusPane("buld", ctx);
    assert.equal(first.kind, "clarify");
    assert.deepEqual(setActiveCalls, []);

    // A bare "yes" is NOT itself a focus_pane re-call in this design (the model re-calls with the
    // confirmed name) — but even if runFocusPane were invoked again with an UNRELATED reference,
    // nothing from the first call leaks in: it resolves purely from its own input.
    const second = await runFocusPane("tests", ctx);
    assert.deepEqual(second, { kind: "ok", output: "Focused pane 'a2'." });
    assert.deepEqual(setActiveCalls, ["a2"], "the second call's bind is independent of the first's clarify");
  });

  it("runFocusPane never throws even if collecting candidates blows up", async () => {
    const brokenManager: any = {
      terminals: {},
      ledger: { workspaces: {} },
      settings: {},
      listPanes: () => { throw new Error("boom"); },
    };
    const ctx = {
      manager: brokenManager,
      getActivePaneId: () => null,
      setActivePane: () => {},
      broadcast: () => {},
      effectiveCapabilityGateFor: () => "Auto",
    } as unknown as ActionContext;
    const result = await runFocusPane("anything", ctx);
    assert.equal(result.kind, "clarify");
  });
});
