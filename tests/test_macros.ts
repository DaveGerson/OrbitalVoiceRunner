// tests/test_macros.ts — VOICE MACROS (8fz.6) unit locks.
//
// Runner: npx tsx --test --test-force-exit tests/test_macros.ts
//
// Covers (per the spec's unit-test list):
//   - TS fallback matcher parity on the exact-match subset; phrase validation rejects approval verbs /
//     confirm vocabulary / wake words; the daemon-timeout path falls to the TS fallback and never
//     throws into the voice loop.
//   - fireMacro expansion → exactly N dispatchProposal calls, ALL forceStage:true with UNIQUE
//     pendingIds; a missing-pane step lands as refused with the group still created; narration matches
//     the staged/refused tallies.
//   - routing-order: an utterance that parses as an approval intent NEVER reaches macro matching
//     (macroMatchAllowed is false), and such a phrase is uncreatable in the first place.

import { describe, it } from "node:test";
import assert from "node:assert";

import {
  validateMacroPhrase,
  matchMacroLocal,
  matchMacroUtterance,
  macroMatchAllowed,
  fireMacro,
  newMacroId,
  type Macro,
} from "../src/macros";
import { parseApprovalIntent } from "../src/approvalIntent";
import { REGISTRY } from "../src/actions/registry";
import type { ActionContext, DispatchOutcome, DispatchProposalArgs } from "../src/actions/types";
import type { MacroMatch, MacroPhraseEntry } from "../src/voice/policyClient";
import { dispatchJoinTracker } from "../src/dispatch/joinTracker";

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────

function macro(over: Partial<Macro> & { phrase: string; name: string }): Macro {
  const now = Date.now();
  return { id: over.id ?? newMacroId(now), steps: over.steps ?? [], created_at: now, updated_at: now, ...over };
}

const DEPLOY = macro({ id: "mac_deploy", phrase: "deploy everything", name: "Deploy", steps: [{ paneName: "build", instruction: "npm run build" }] });
const ROUNDS = macro({ id: "mac_rounds", phrase: "morning rounds", name: "Rounds", steps: [] });

// ── (0) registry surface: the CRUD defs exist, REST/UI-only (no voice-surface define/delete verb) ──

describe("macros registry surface — REST/UI-only CRUD (operator decision 2026-07-06)", () => {
  const byName = (n: string) => REGISTRY.find((d) => d.name === n);
  it("list_macros / define_macro / delete_macro are registered and rest-only (never voice)", () => {
    for (const name of ["list_macros", "define_macro", "delete_macro"]) {
      const def = byName(name);
      assert.ok(def, `${name} must be in the registry`);
      assert.ok(def!.surfaces.has("rest"), `${name} is a REST surface`);
      assert.ok(!def!.surfaces.has("voice"), `${name} must NOT be a voice verb (voice can FIRE, never AUTHOR)`);
    }
  });
  it("define_macro / delete_macro ride the update_metadata write capability; list_macros is a read", () => {
    assert.strictEqual(byName("define_macro")!.capability, "update_metadata");
    assert.strictEqual(byName("delete_macro")!.capability, "update_metadata");
    assert.strictEqual(byName("list_macros")!.capability, "read_notes");
    assert.strictEqual(byName("list_macros")!.readOnly, true);
  });
});

// ── (1) phrase validation (creation-time, fail-closed) ──────────────────────────────────────────────

describe("validateMacroPhrase — reserved-vocabulary rejection", () => {
  it("accepts an ordinary, distinct phrase", () => {
    assert.strictEqual(validateMacroPhrase("morning rounds").ok, true);
    assert.strictEqual(validateMacroPhrase("kick off the nightly build").ok, true);
  });

  it("rejects an empty / whitespace phrase", () => {
    assert.strictEqual(validateMacroPhrase("").ok, false);
    assert.strictEqual(validateMacroPhrase("   ").ok, false);
  });

  it("rejects phrases that parse as an approve / reject / defer intent", () => {
    for (const p of ["yes", "approve", "no", "reject it", "later", "not now"]) {
      assert.strictEqual(validateMacroPhrase(p).ok, false, `'${p}' must be rejected (it parses as an approval-domain intent)`);
    }
  });

  it("rejects wake words, the emergency brake, spoken-confirm vocabulary, and affirmation phrases", () => {
    for (const p of ["janus", "hey janus", "stop", "stop everything", "halt", "kill them", "release", "cancel", "never mind", "confirm delete", "confirm clear", "go ahead", "send it", "make it so"]) {
      assert.strictEqual(validateMacroPhrase(p).ok, false, `'${p}' must be rejected (reserved voice command)`);
    }
  });

  it("normalization-stable: case + punctuation variants of a reserved word are still rejected", () => {
    assert.strictEqual(validateMacroPhrase("STOP!").ok, false);
    assert.strictEqual(validateMacroPhrase("  Janus  ").ok, false);
  });
});

// ── (2) TS fallback matcher (exact-match subset) ────────────────────────────────────────────────────

describe("matchMacroLocal — the synchronous fail-closed TS floor", () => {
  const macros = [DEPLOY, ROUNDS];
  it("normalized EXACT hit", () => {
    assert.strictEqual(matchMacroLocal("deploy everything", macros)?.id, "mac_deploy");
  });
  it("case + punctuation collapse to the same exact match (normalizeUtterance parity)", () => {
    assert.strictEqual(matchMacroLocal("Deploy, everything!", macros)?.id, "mac_deploy");
  });
  it("a fuzzy near-miss is NOT matched by the exact floor (a dead daemon never widens matching)", () => {
    assert.strictEqual(matchMacroLocal("deploy everythng", macros), null);
  });
  it("empty utterance / empty store → null", () => {
    assert.strictEqual(matchMacroLocal("", macros), null);
    assert.strictEqual(matchMacroLocal("deploy everything", []), null);
  });
});

// ── (3) match orchestration (Python primary + fail-closed TS fallback) ──────────────────────────────

function policyStub(fn: (u: string, e: MacroPhraseEntry[]) => Promise<MacroMatch | null>) {
  return { matchMacro: fn };
}

describe("matchMacroUtterance — Python primary, TS floor on any miss, never throws", () => {
  const macros = [DEPLOY, ROUNDS];

  it("no policies client → TS exact floor", async () => {
    const m = await matchMacroUtterance("deploy everything", macros, undefined);
    assert.strictEqual(m?.id, "mac_deploy");
  });

  it("daemon MISS (facade resolves null, e.g. timeout) → falls to the TS floor, does not throw", async () => {
    const m = await matchMacroUtterance("deploy everything", macros, policyStub(async () => null));
    assert.strictEqual(m?.id, "mac_deploy", "a null (timeout/down) degrades to the TS exact match");
  });

  it("daemon RAN with a fuzzy hit → uses the Python result (broader than the exact floor)", async () => {
    // The TS floor would MISS 'deploy everythng'; Python's fuzzy layer resolves it.
    const m = await matchMacroUtterance("deploy everythng", macros, policyStub(async () => ({ id: "mac_deploy" })));
    assert.strictEqual(m?.id, "mac_deploy");
  });

  it("daemon RAN with a definitive no-match ({id:null}) → no match, TS floor NOT consulted", async () => {
    // Even though 'morning rounds' is a TS-exact hit, a RAN daemon's authoritative no-match wins.
    const m = await matchMacroUtterance("morning rounds", macros, policyStub(async () => ({ id: null })));
    assert.strictEqual(m, null);
  });

  it("empty store short-circuits to null", async () => {
    const m = await matchMacroUtterance("deploy everything", [], policyStub(async () => ({ id: "x" })));
    assert.strictEqual(m, null);
  });
});

// ── (4) routing order: an approval intent NEVER reaches macro matching ──────────────────────────────

describe("macroMatchAllowed — the intent gate + creation-time shadow guard", () => {
  it("firing is allowed ONLY for a non-approval utterance", () => {
    assert.strictEqual(macroMatchAllowed("none"), true);
    for (const intent of ["approve", "reject", "defer", "clarify"]) {
      assert.strictEqual(macroMatchAllowed(intent), false, `intent '${intent}' must never reach macro matching`);
    }
  });

  it("an approval-parsing phrase is BOTH gated out of matching AND uncreatable (belt + suspenders)", () => {
    for (const phrase of ["approve", "yes", "reject it"]) {
      const parsed = parseApprovalIntent(phrase);
      assert.notStrictEqual(parsed.intent, "none", `'${phrase}' parses as an approval intent`);
      assert.strictEqual(macroMatchAllowed(parsed.intent), false, `so it can never reach macro matching`);
      assert.strictEqual(validateMacroPhrase(phrase).ok, false, `and it is uncreatable as a macro phrase`);
    }
  });

  it("an affirmation the approval parser IGNORES ('go ahead') is still uncreatable (creation-time defense)", () => {
    // The parser treats these as ambient ("none"), so routing would let them through — the creation
    // validator is the defense that makes them un-storable, so they never reach matching at all.
    assert.strictEqual(parseApprovalIntent("go ahead").intent, "none");
    assert.strictEqual(validateMacroPhrase("go ahead").ok, false);
  });
});

// ── (5) fireMacro expansion — the forceStage safety kernel ──────────────────────────────────────────

interface FireProbe { calls: DispatchProposalArgs[]; broadcasts: Array<Record<string, unknown>> }

function makeFireCtx(opts?: { panes?: string[]; outcomes?: Record<string, DispatchOutcome>; policies?: unknown }): { ctx: ActionContext; probe: FireProbe } {
  const panes = opts?.panes ?? ["build", "test"];
  const probe: FireProbe = { calls: [], broadcasts: [] };
  const ctx = {
    manager: {
      listPanes: () => [{
        project_id: "proj1",
        panes: panes.map((p) => ({ pane_id: p, name: p, is_busy: false, last_known_state: "Idle", tool_preset: "Claude Code" })),
      }],
      ledger: { workspaces: { proj1: { name: "Proj" } } },
      terminals: {},
    },
    session: null,
    callId: "macrocall",
    userUtterance: "",
    getActivePaneId: () => null,
    broadcast: (m: unknown): void => { probe.broadcasts.push(m as Record<string, unknown>); },
    dispatchProposal: (a: DispatchProposalArgs): DispatchOutcome => {
      probe.calls.push(a);
      return opts?.outcomes?.[a.targetId] ?? { kind: "pending", text: `staged ${a.targetId}` };
    },
    policies: opts?.policies,
  } as unknown as ActionContext;
  return { ctx, probe };
}

/** The join tracker is a module singleton — diff the list to find OUR group. */
async function fireAndFindGroup(ctx: ActionContext, m: Macro) {
  const before = dispatchJoinTracker.list().length;
  const result = await fireMacro(ctx, m);
  const after = dispatchJoinTracker.list();
  return { result, group: after.length > before ? after[after.length - 1] : undefined };
}

describe("fireMacro — N staged approvals joined by ONE dispatch group, every write forceStaged", () => {
  it("exactly N dispatchProposal calls, ALL forceStage:true with distinct pendingIds + correct per-step instruction", async () => {
    const { ctx, probe } = makeFireCtx();
    const m = macro({
      id: "mac_x", phrase: "run the lot", name: "Run the lot",
      steps: [
        { paneName: "build", instruction: "npm run build" },
        { paneName: "test", instruction: "npm test" },
      ],
    });
    const { result, group } = await fireAndFindGroup(ctx, m);

    assert.strictEqual(probe.calls.length, 2, "one dispatchProposal per step");
    for (const call of probe.calls) {
      assert.strictEqual(call.forceStage, true, "THE invariant: every macro write is forceStage:true");
      assert.strictEqual(call.capability, "write_to_pane");
    }
    // Per-step instruction + target routed correctly (NOT one shared instruction).
    assert.strictEqual(probe.calls[0].targetId, "build");
    assert.strictEqual(probe.calls[0].instruction, "npm run build");
    assert.strictEqual(probe.calls[1].targetId, "test");
    assert.strictEqual(probe.calls[1].instruction, "npm test");
    // Distinct synthetic pendingIds (no functionCall-id collapse).
    const ids = probe.calls.map((c) => c.pendingId);
    assert.strictEqual(new Set(ids).size, 2, "distinct pendingIds per step");
    assert.ok(ids.every((id) => id!.startsWith("macrocall__")), "pendingId base is the macro callId");

    assert.ok(group, "ONE dispatch group was created");
    assert.strictEqual(group!.name, "Run the lot", "the group is named after the macro");
    assert.strictEqual(group!.members.length, 2);
    assert.deepStrictEqual(result.staged, ["build", "test"]);
    assert.strictEqual(result.refused.length, 0);
    assert.ok(result.output.includes("staged 2 approval(s)"), `narration counts staged (got: ${result.output})`);
    assert.ok(probe.broadcasts.some((b) => b.type === "dispatch_updated"), "dispatch_updated broadcast");
  });

  it("two steps on the SAME pane get UNIQUE pendingIds (no reuse collapsing N stagings)", async () => {
    const { ctx, probe } = makeFireCtx({ panes: ["build"] });
    const m = macro({
      id: "mac_dup", phrase: "double tap", name: "Double",
      steps: [
        { paneName: "build", instruction: "first" },
        { paneName: "build", instruction: "second" },
      ],
    });
    await fireAndFindGroup(ctx, m);
    assert.strictEqual(probe.calls.length, 2);
    assert.strictEqual(new Set(probe.calls.map((c) => c.pendingId)).size, 2, "repeated pane still yields distinct pendingIds");
  });

  it("a missing-pane step lands as REFUSED; the group is still created; narration matches the tallies", async () => {
    const { ctx, probe } = makeFireCtx({ panes: ["build"] });
    const m = macro({
      id: "mac_miss", phrase: "half real", name: "Half real",
      steps: [
        { paneName: "build", instruction: "npm run build" },
        { paneName: "ghost", instruction: "never runs" }, // no such pane -> refused, never guessed
      ],
    });
    const { result, group } = await fireAndFindGroup(ctx, m);
    assert.strictEqual(probe.calls.length, 1, "the unresolved pane is NEVER dispatched (no guess)");
    assert.strictEqual(probe.calls[0].targetId, "build");
    assert.deepStrictEqual(result.staged, ["build"]);
    assert.ok(result.refused.some((r) => r.includes("ghost") && r.includes("no such pane")), `the missing pane is a refused entry (got: ${JSON.stringify(result.refused)})`);
    assert.ok(group, "the group is created even with a refused step");
    assert.ok(result.output.includes("staged 1 approval(s)") && result.output.includes("Not staged"), `narration reflects staged + refused (got: ${result.output})`);
  });

  it("never auto-executes even when the engine returns executed (forceStage should preclude it, but it is still recorded honestly)", async () => {
    const { ctx } = makeFireCtx({ outcomes: { build: { kind: "executed", text: "ran" } }, panes: ["build"] });
    const m = macro({ id: "mac_e", phrase: "edge", name: "Edge", steps: [{ paneName: "build", instruction: "go" }] });
    const { result } = await fireAndFindGroup(ctx, m);
    // recordDispatchOutcome maps executed -> staged/running (never silently dropped).
    assert.deepStrictEqual(result.staged, ["build"]);
  });

  // ── empty-group guard (Wave 5 minor fix) ──────────────────────────────────
  // When EVERY step fails pane resolution (targets.length === 0), staging would create a members:[]
  // join group that can never complete (noteTransition only settles via members) and would broadcast
  // a phantom dispatch_updated to the board. Guard: skip stageDispatchGroup entirely and narrate the
  // refusals only.
  it("EVERY step fails resolution → NO join group, NO dispatch_updated broadcast, refusals narrated", async () => {
    const { ctx, probe } = makeFireCtx({ panes: ["build"] }); // neither "ghost" nor "phantom" exists
    const m = macro({
      id: "mac_allmiss", phrase: "all ghosts", name: "All Ghosts",
      steps: [
        { paneName: "ghost", instruction: "never runs" },
        { paneName: "phantom", instruction: "also never runs" },
      ],
    });
    const before = dispatchJoinTracker.list().length;
    const result = await fireMacro(ctx, m);
    const after = dispatchJoinTracker.list().length;

    assert.strictEqual(probe.calls.length, 0, "no step is dispatched when none resolve");
    assert.strictEqual(after, before, "NO join group is created for a zero-target macro (empty group can never complete)");
    assert.ok(!probe.broadcasts.some((b) => b.type === "dispatch_updated"), "no phantom dispatch_updated broadcast");
    assert.deepStrictEqual(result.staged, []);
    assert.ok(
      result.refused.some((r) => r.includes("ghost")) && result.refused.some((r) => r.includes("phantom")),
      `both unresolved panes are refused (got: ${JSON.stringify(result.refused)})`,
    );
    assert.ok(
      result.output.includes("ghost") && result.output.includes("phantom") && result.output.includes("No writes were staged"),
      `spoken refusal names the unresolved panes and states nothing was staged (got: ${result.output})`,
    );
  });
});
