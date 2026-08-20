// tests/test_target_resolver.ts
//
// Target resolver — RED-FIRST decision-table suite (Phase 3, step 3.1; spec
// docs/superpowers/specs/2026-07-09-instruction-routing.md §3-§4).
//
// This suite imports `../src/voice/targetResolver`, which DOES NOT EXIST YET — the suite must
// fail (ERR_MODULE_NOT_FOUND) until step 3.3 implements it. It is the executable contract for
// the §3.2 decision table:
//   - exact pane id / name binds silently; unique role/preset reference binds (exact-token
//     floor tier 4); exact ordinal binds;
//   - two matching panes -> confirm with the named candidates (reason "multiple");
//   - no referent -> clarify; anaphora with no recent referent -> clarify; anaphora with a live
//     recent referent binds silently;
//   - cross-project reference -> confirm (reason "cross_project"), NEVER a silent bind, with or
//     without the operator naming the project;
//   - fuzzy (ranker-only, confidence < 1) -> confirm, NEVER a silent bind — focusBindPolicy
//     echo/tiered is deliberately NOT honored for instruction targets (spec §3.2);
//   - the TS floor NEVER widens: with the ranker absent/down (rank omitted or resolving null),
//     only exact name/id, unique prefix, exact ordinal, and exact role-token matches resolve —
//     a fuzzy/typo reference clarifies;
//   - exact beats the ranker: a floor-exact reference binds even if the ranker claims a
//     different pane at confidence 1 (Python is RANKING ONLY — it can never override or widen
//     an exact match);
//   - the resolver returns a plain-data DECISION and never changes focus itself: it never
//     mutates its input, and the decision carries no functions/side-effect handles (focus moves
//     only via bindFocus / switch_active_pane; draft binding via the exchange service).
//
// Contract expected from src/voice/targetResolver (async, pure over its inputs; the ranking seam
// is the EXISTING focus.resolve shape — FocusCandidate / FocusResolution from
// src/voice/policyClient, null on ANY miss):
//   export interface TargetResolverInput {
//     reference: string | null;             // null/"" = the utterance carried no referent
//     candidates: FocusCandidate[];         // collectFocusCandidates display-order shape
//     activeProjectId: string | null;       // the operator's current project
//     explicitProject: string | null;       // a project the operator NAMED, if any
//     recentReferent: { paneId: string; projectId: string } | null; // anaphora register
//     rank?: (reference: string, candidates: FocusCandidate[]) => Promise<FocusResolution | null>;
//   }
//   export type TargetDecision =
//     | { kind: "bind";    paneId: string; projectId: string }
//     | { kind: "confirm"; reason: "fuzzy" | "cross_project" | "multiple";
//         candidates: Array<{ paneId: string; projectId: string }>; prompt: string }
//     | { kind: "clarify"; prompt: string };
//   export async function resolveTarget(input: TargetResolverInput): Promise<TargetDecision>;

import { describe, it } from "node:test";
import assert from "node:assert";

import type { FocusCandidate, FocusResolution } from "../src/voice/policyClient";
import { resolveTarget, type TargetResolverInput } from "../src/voice/targetResolver";

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────

function cand(partial: Partial<FocusCandidate> & { paneId: string; ordinal: number }): FocusCandidate {
  return {
    paneName: partial.paneId,
    projectId: "proj-a",
    projectName: "Project A",
    presetLabel: "Claude Code",
    state: "Idle",
    isBusy: false,
    lastActiveAt: 0,
    isActive: false,
    ...partial,
  };
}

/** Two projects: proj-a holds build-runner (Claude Code), codex-1 (Codex), scratch (Custom);
 *  proj-b holds docs-pane (Claude Code). */
function fleet(): FocusCandidate[] {
  return [
    cand({ paneId: "build-runner", ordinal: 1, presetLabel: "Claude Code", isActive: true }),
    cand({ paneId: "codex-1", ordinal: 2, presetLabel: "Codex" }),
    cand({ paneId: "scratch", ordinal: 3, presetLabel: "Custom" }),
    cand({ paneId: "docs-pane", ordinal: 4, projectId: "proj-b", projectName: "Project B" }),
  ];
}

function input(overrides: Partial<TargetResolverInput>): TargetResolverInput {
  return {
    reference: null,
    candidates: fleet(),
    activeProjectId: "proj-a",
    explicitProject: null,
    recentReferent: null,
    ...overrides,
  };
}

/** A ranker that is "down" — resolves null on every call (the policyClient FALLBACK CONTRACT:
 *  null on ANY miss; callers must fall to the deterministic TS floor and never widen). */
async function deadRank(): Promise<FocusResolution | null> {
  return null;
}

// ── exact references bind silently ──────────────────────────────────────────────────────────────

describe("targetResolver: exact references bind silently (spec §3.2)", () => {
  it("exact pane id -> bind, no confirmation", async () => {
    const d = await resolveTarget(input({ reference: "codex-1" }));
    assert.deepStrictEqual(d, { kind: "bind", paneId: "codex-1", projectId: "proj-a" });
  });

  it("exact pane name (case-insensitive) -> bind", async () => {
    const d = await resolveTarget(input({ reference: "Build-Runner" }));
    assert.strictEqual(d.kind, "bind");
    if (d.kind === "bind") assert.strictEqual(d.paneId, "build-runner");
  });

  it("exact ordinal ('pane two') -> bind", async () => {
    const d = await resolveTarget(input({ reference: "pane two" }));
    assert.strictEqual(d.kind, "bind");
    if (d.kind === "bind") assert.strictEqual(d.paneId, "codex-1");
  });

  it("unique role/preset reference ('the codex pane') -> bind — exact-token floor tier 4", async () => {
    const d = await resolveTarget(input({ reference: "the codex pane", rank: deadRank }));
    assert.strictEqual(d.kind, "bind", "one pane runs Codex, so the role reference is exact-unique");
    if (d.kind === "bind") assert.strictEqual(d.paneId, "codex-1");
  });

  it("Gemini/agy role spellings ('gemini' / 'agy' / 'anti-gravity') -> bind the Antigravity pane", async () => {
    // Demo 2026-08-18: the operator said "make it a Gemini pane" and no spelling reached the
    // Antigravity preset. Gemini IS the agy CLI — all three spoken forms are exact role tokens.
    const withAgy = [
      cand({ paneId: "build-runner", ordinal: 1, presetLabel: "Claude Code" }),
      cand({ paneId: "agy-1", ordinal: 2, presetLabel: "Antigravity" }),
    ];
    for (const reference of ["the gemini pane", "the agy pane", "the anti-gravity pane"]) {
      const d = await resolveTarget(input({ reference, candidates: withAgy, rank: deadRank }));
      assert.strictEqual(d.kind, "bind", `${reference} resolves via the exact-token floor`);
      if (d.kind === "bind") assert.strictEqual(d.paneId, "agy-1", reference);
    }
  });
});

// ── ambiguity -> confirm with candidates ────────────────────────────────────────────────────────

describe("targetResolver: multiple candidates -> confirm with candidates (spec §3.2)", () => {
  it("role reference matching TWO panes -> confirm(reason 'multiple') naming both", async () => {
    const twoClaudes = [
      cand({ paneId: "claude-api", ordinal: 1, presetLabel: "Claude Code" }),
      cand({ paneId: "claude-ui", ordinal: 2, presetLabel: "Claude Code" }),
    ];
    const d = await resolveTarget(input({ reference: "the claude pane", candidates: twoClaudes, rank: deadRank }));
    assert.strictEqual(d.kind, "confirm");
    if (d.kind === "confirm") {
      assert.strictEqual(d.reason, "multiple");
      const ids = d.candidates.map((c) => c.paneId).sort();
      assert.deepStrictEqual(ids, ["claude-api", "claude-ui"]);
      assert.ok(d.prompt.length > 0);
    }
  });

  it("name-prefix collision (two panes share the spoken prefix) -> confirm with both, never a guess", async () => {
    const collide = [
      cand({ paneId: "build-runner", ordinal: 1 }),
      cand({ paneId: "build-watcher", ordinal: 2 }),
    ];
    const d = await resolveTarget(input({ reference: "build", candidates: collide, rank: deadRank }));
    assert.strictEqual(d.kind, "confirm");
    if (d.kind === "confirm") assert.strictEqual(d.reason, "multiple");
  });

  it("ranker alternatives within the 0.15 margin -> confirm(multiple), mirroring classifyResolution", async () => {
    const rank = async (): Promise<FocusResolution> => ({
      paneId: "build-runner",
      confidence: 0.7,
      alternatives: [{ paneId: "codex-1", score: 0.62 }],
    });
    const d = await resolveTarget(input({ reference: "the one working on the pipeline", rank }));
    assert.strictEqual(d.kind, "confirm");
    if (d.kind === "confirm") assert.strictEqual(d.reason, "multiple");
  });
});

// ── no referent / anaphora ──────────────────────────────────────────────────────────────────────

describe("targetResolver: no referent and anaphora (spec §3.2)", () => {
  it("no referent at all (reference null) -> clarify", async () => {
    const d = await resolveTarget(input({ reference: null }));
    assert.strictEqual(d.kind, "clarify");
    if (d.kind === "clarify") assert.ok(d.prompt.length > 0);
  });

  it("empty-string reference -> clarify (same as no referent)", async () => {
    const d = await resolveTarget(input({ reference: "   " }));
    assert.strictEqual(d.kind, "clarify");
  });

  it("anaphora ('that pane') with NO recent referent -> clarify, never a guess at the active pane", async () => {
    const d = await resolveTarget(input({ reference: "that pane", recentReferent: null, rank: deadRank }));
    assert.strictEqual(d.kind, "clarify");
  });

  it("anaphora ('that one') WITH a live recent referent -> bind silently to it", async () => {
    const d = await resolveTarget(
      input({ reference: "that one", recentReferent: { paneId: "codex-1", projectId: "proj-a" } })
    );
    assert.deepStrictEqual(d, { kind: "bind", paneId: "codex-1", projectId: "proj-a" });
  });

  it("(step 3.5) anaphora whose recent referent lives OUTSIDE the active project -> confirm(cross_project), never a silent cross-project bind", async () => {
    const d = await resolveTarget(
      input({ reference: "it", recentReferent: { paneId: "docs-pane", projectId: "proj-b" }, rank: deadRank })
    );
    assert.strictEqual(d.kind, "confirm", "continuing a thread does not waive the project boundary (spec §3.2 hard rule)");
    if (d.kind === "confirm") {
      assert.strictEqual(d.reason, "cross_project");
      assert.deepStrictEqual(d.candidates, [{ paneId: "docs-pane", projectId: "proj-b" }]);
    }
  });

  it("(step 3.5) anaphora whose recent referent pane is GONE from the candidate set -> clarify, never a ghost bind", async () => {
    const d = await resolveTarget(
      input({ reference: "that one", recentReferent: { paneId: "deleted-pane", projectId: "proj-a" }, rank: deadRank })
    );
    assert.strictEqual(d.kind, "clarify", "a TTL-live referent to a deleted/archived pane must not bind");
  });
});

// ── cross-project ───────────────────────────────────────────────────────────────────────────────

describe("targetResolver: cross-project references always confirm (spec §3.2, §4)", () => {
  it("exact name in a NON-active project, project not named -> confirm(cross_project), never bind", async () => {
    const d = await resolveTarget(input({ reference: "docs-pane", explicitProject: null }));
    assert.strictEqual(d.kind, "confirm");
    if (d.kind === "confirm") {
      assert.strictEqual(d.reason, "cross_project");
      assert.deepStrictEqual(d.candidates, [{ paneId: "docs-pane", projectId: "proj-b" }]);
    }
  });

  it("even with the project explicitly named, a cross-project retarget still confirms", async () => {
    const d = await resolveTarget(input({ reference: "docs-pane", explicitProject: "proj-b" }));
    assert.strictEqual(d.kind, "confirm");
    if (d.kind === "confirm") assert.strictEqual(d.reason, "cross_project");
  });
});

// ── the ranking seam: fuzzy confirms, floor never widens, exact beats the ranker ───────────────

describe("targetResolver: Python ranking seam — ranking only, floor never widens (spec §3.1)", () => {
  it("fuzzy ranker match (confidence < 1, no close alternatives) -> confirm(fuzzy), NEVER silent bind", async () => {
    const rank = async (): Promise<FocusResolution> => ({
      paneId: "build-runner",
      confidence: 0.85, // above focusBindPolicy 'tiered''s 0.8 bind line — must STILL confirm here
      alternatives: [],
    });
    const d = await resolveTarget(input({ reference: "the busy one", rank }));
    assert.strictEqual(d.kind, "confirm");
    if (d.kind === "confirm") {
      assert.strictEqual(d.reason, "fuzzy");
      assert.deepStrictEqual(d.candidates, [{ paneId: "build-runner", projectId: "proj-a" }]);
    }
  });

  it("ranker confidence 1 (unique) -> bind (the ranker's exact tier is honored)", async () => {
    const rank = async (): Promise<FocusResolution> => ({ paneId: "scratch", confidence: 1, alternatives: [] });
    const d = await resolveTarget(input({ reference: "the shell thing", rank }));
    assert.deepStrictEqual(d, { kind: "bind", paneId: "scratch", projectId: "proj-a" });
  });

  it("TS floor never widens: fuzzy/typo reference with the ranker DOWN -> clarify (exact/prefix/ordinal/role-token only)", async () => {
    for (const rank of [undefined, deadRank]) {
      const d = await resolveTarget(input({ reference: "the biuld one", rank }));
      assert.strictEqual(d.kind, "clarify", "a dead daemon must never widen matching beyond the literal floor");
    }
  });

  it("exact beats the ranker: a floor-exact reference binds even when the ranker claims another pane at confidence 1", async () => {
    const hijack = async (): Promise<FocusResolution> => ({ paneId: "scratch", confidence: 1, alternatives: [] });
    const d = await resolveTarget(input({ reference: "codex-1", rank: hijack }));
    assert.deepStrictEqual(d, { kind: "bind", paneId: "codex-1", projectId: "proj-a" },
      "ranking is additive recall for fuzzy references only — it can never override an exact match");
  });

  it("a rejecting ranker degrades to the floor, never throws out of the resolver", async () => {
    const rank = async (): Promise<FocusResolution | null> => { throw new Error("daemon exploded"); };
    const d = await resolveTarget(input({ reference: "codex-1", rank }));
    assert.deepStrictEqual(d, { kind: "bind", paneId: "codex-1", projectId: "proj-a" });
    const fuzzy = await resolveTarget(input({ reference: "the biuld one", rank }));
    assert.strictEqual(fuzzy.kind, "clarify");
  });

  it("(step 3.5) a ranker naming a pane OUTSIDE the candidate set -> clarify — a confused daemon can never bind or confirm a ghost target", async () => {
    const ghost = async (): Promise<FocusResolution> => ({ paneId: "not-a-real-pane", confidence: 1, alternatives: [] });
    const d = await resolveTarget(input({ reference: "the mystery pane", rank: ghost }));
    assert.strictEqual(d.kind, "clarify", "the ranker names candidates, it does not create them (D2: never widen)");
  });
});

// ── the resolver is a pure decision — it never changes focus itself ─────────────────────────────

describe("targetResolver: pure decision, no focus mutation (spec §3.2)", () => {
  it("never mutates its input (frozen input + candidates survive resolution)", async () => {
    const candidates = fleet().map((c) => Object.freeze({ ...c }));
    Object.freeze(candidates);
    const frozen = Object.freeze(input({ reference: "codex-1", candidates: candidates as FocusCandidate[] }));
    // A resolver that writes to its input would throw on the frozen objects.
    const d = await resolveTarget(frozen);
    assert.strictEqual(d.kind, "bind");
  });

  it("the decision is plain data — JSON-round-trippable, no functions or side-effect handles", async () => {
    for (const reference of ["codex-1", "the claude pane", "that pane", "docs-pane", null]) {
      const d = await resolveTarget(input({ reference }));
      assert.deepStrictEqual(JSON.parse(JSON.stringify(d)), d,
        "a TargetDecision must carry no functions — focus moves only through bindFocus/switch_active_pane");
    }
  });

  it("a bind decision names the target but performs no bind — repeated resolution is idempotent", async () => {
    const i = input({ reference: "codex-1" });
    const first = await resolveTarget(i);
    const second = await resolveTarget(i);
    assert.deepStrictEqual(first, second, "resolving is a read — same input, same decision, no state advanced");
  });
});
