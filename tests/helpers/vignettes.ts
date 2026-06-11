// tests/helpers/vignettes.ts — a REUSABLE vignette scoring harness.
//
// CONCEPT
// -------
// A "vignette" is a plausible operator/agent dialogue: an ORDERED list of turns, each naming a
// target pane (or project) and the tool calls the agent should make for that turn. With the mock
// Gemini Live harness (tests/helpers/mockLive.ts) WE script that tool-call sequence and drive it
// through the REAL server dispatch (the genuine onmessage -> runAction(REGISTRY,…) path). After the
// run we reconstruct each turn's legs from the correlated interaction log
// (`.janus_interaction_log.jsonl`, grouped by interaction_id — src/interactionLog.ts) and compute a
// SCORE (e.g. a mis-attribution rate) that a scored test asserts against a REGRESSION THRESHOLD —
// NOT a hard model pass/fail.
//
// WHY THE INTERACTION LOG IS THE GROUND TRUTH
// -------------------------------------------
// Every tool call the model emits writes a `tool_call` leg (data:{name,callId,args}) and, after the
// handler runs, an `action_result` leg (data:{name,callId,resultKind}), BOTH keyed by the turn's
// interaction_id (src/voice/index.ts ~L1021/L1055). A fresh interaction_id is minted at each
// operator-speech boundary (onOperatorSpeech() — minted iff lastSpeaker !== "operator"); a tool call
// flips lastSpeaker to "model" (setModelTurn()), so emitting one synthetic operator utterance per
// turn cleanly partitions the legs by turn. The sink is a SYNCHRONOUS appendFileSync, so once a
// call's tool response has been observed the leg is already durable on disk — no async flush race.
//
// TURN BOUNDARY: emit({ serverContent:{ inputTranscription:{ text } } }) feeds extractTranscripts'
// operator channel (src/liveTranscripts.ts), which is exactly what mints the per-turn interaction_id.
//
// EFFECTIVE TARGET PANE: for the routing/attribution score we read each tool_call leg's recorded
// args — `pane_id` for the per-pane tools, `project_id` for switch_context/rename_pane — because
// that is the pane the server actually routed the action to (deterministic server routing: the
// handler reads exactly the id in the args; there is no model-side name-resolution step that could
// drift). A leg whose effective target != the turn's named target is a mis-attribution.

import fs from "node:fs";
import path from "node:path";
import { groupByInteraction } from "../../src/interactionLog";
import type { MockLiveHandle, MockLiveSession } from "./mockLive";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** One scripted tool call within a turn (the args WE, playing the model, emit). */
export interface VignetteToolCall {
  name: string;
  args?: Record<string, any>;
}

/**
 * One turn of a vignette: a synthetic operator utterance, the pane/project the turn is ABOUT, and
 * the tool calls the agent should make for it. `expectation` is free-form documentation of what the
 * turn is meant to demonstrate (it is not asserted by the generic scorer — scenario tests assert it).
 */
export interface VignetteTurn {
  /** What the operator "said" this turn — feeds the operator-speech channel to mint the turn id. */
  utterance: string;
  /** The pane this turn names/addresses (the attribution ground truth for per-pane tools). */
  targetPaneId?: string;
  /** The project this turn names (the attribution ground truth for switch_context / project tools). */
  targetProjectId?: string;
  toolCalls: VignetteToolCall[];
  /** Human-readable description of the invariant this turn exercises. */
  expectation?: string;
}

export interface Vignette {
  name: string;
  turns: VignetteTurn[];
}

/** One reconstructed tool-call leg paired with the turn it belongs to. */
export interface ReconstructedLeg {
  /** 0-based index of the owning turn in the vignette. */
  turnIndex: number;
  interactionId: string;
  name: string;
  callId: string | undefined;
  /** The args the server recorded for this call (the routing ground truth). */
  args: Record<string, any>;
  /** The pane/project this call effectively targeted (from args), or null if it named no target. */
  effectiveTarget: string | null;
  /** The kind ("ok" | "error" | "pending" | "clarify" | …) from the paired action_result leg. */
  resultKind: string | undefined;
}

/** Everything a scored test needs from a run: the raw tool results + the reconstructed legs. */
export interface VignetteRun {
  vignette: Vignette;
  /** The tool result the server returned, in emission order, paired with the turn index. */
  results: Array<{ turnIndex: number; name: string; callId: string; output: any }>;
  /** Tool-call legs, in interaction-log order, mapped back to their turn. */
  legs: ReconstructedLeg[];
  /** The interaction_ids minted, in turn order (legs.length permitting). */
  interactionIdsByTurn: Array<string | undefined>;
}

/** The attribution score: fraction of tool-call legs that routed to the WRONG pane/project. */
export interface AttributionScore {
  total: number;
  misAttributed: number;
  /** misAttributed / total (0 when total is 0). 0 == perfect attribution. */
  rate: number;
  /** The offending legs, for a readable assertion message. */
  offenders: ReconstructedLeg[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Interaction-log helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The interaction-log path the server resolves at module load (server.ts:64) is relative to cwd:
 * `process.env.JANUS_INTERACTION_LOG ?? ".janus_interaction_log.jsonl"`. A vignette suite runs in an
 * isolated mkdtemp cwd set BEFORE importing ../server, so the file lands in that temp dir. This reads
 * it from process.cwd() by default (matching the server's own resolution).
 */
export function interactionLogPath(cwd: string = process.cwd()): string {
  const fromEnv = process.env.JANUS_INTERACTION_LOG;
  if (fromEnv && fromEnv.toLowerCase() !== "off") {
    return path.isAbsolute(fromEnv) ? fromEnv : path.join(cwd, fromEnv);
  }
  return path.join(cwd, ".janus_interaction_log.jsonl");
}

/** Read + parse the interaction-log JSONL into a Map<interaction_id, leg[]> (empty if absent). */
export function readInteractionGroups(cwd?: string): Map<string, any[]> {
  const file = interactionLogPath(cwd);
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return new Map();
  }
  return groupByInteraction(raw.split(/\r?\n/));
}

/**
 * The pane/project an action routed to, read from the recorded tool_call args. Per-pane tools record
 * `pane_id`; switch_context / project tools record `project_id`. Returns null when the call names no
 * target (e.g. list_panes, get_attention_digest — orientation calls with no specific pane).
 */
export function effectiveTargetOf(args: Record<string, any> | undefined): string | null {
  if (!args || typeof args !== "object") return null;
  if (typeof args.pane_id === "string" && args.pane_id.length > 0) return args.pane_id;
  if (typeof args.project_id === "string" && args.project_id.length > 0) return args.project_id;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────────

/** Poll until predicate is truthy or timeout — local copy so the helper has no cross-import. */
async function waitUntil<T>(predicate: () => T | undefined | false, timeoutMs = 2000, intervalMs = 10): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = predicate();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`vignette waitUntil timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * runVignette — drive a scripted dialogue through the REAL server dispatch and reconstruct the legs.
 *
 * For each turn: (1) emit a synthetic operator utterance to mint a fresh interaction_id, then
 * (2) emit each scripted tool call in order, awaiting the server's tool response (which guarantees
 * the action_result leg has been written) before the next call. After all turns, the interaction log
 * is read back, grouped by interaction_id, and the tool_call legs are mapped to their turn (legs are
 * matched to turns by the per-turn interaction_id, recovered in emission order).
 *
 * `_server` is accepted for symmetry / future use (the dispatch is driven entirely through the mock
 * Live session, which IS the server's real onmessage handler); the active session is taken from the
 * mock handle so the caller need not thread it.
 */
export async function runVignette(
  _server: unknown,
  mock: MockLiveHandle,
  vignette: Vignette
): Promise<VignetteRun> {
  const session: MockLiveSession = await waitUntil(() => mock.latest());

  const results: VignetteRun["results"] = [];
  // The interaction_id minted for each turn, in turn order. We recover it from the tool_call legs
  // after the run (the mint is server-internal), so we record the callIds emitted per turn and look
  // up which interaction_id their legs landed under.
  const callIdsByTurn: string[][] = [];

  for (let t = 0; t < vignette.turns.length; t++) {
    const turn = vignette.turns[t];
    callIdsByTurn[t] = [];
    // (1) Operator-speech boundary -> mints a fresh interaction_id (onOperatorSpeech()).
    session.emit({ serverContent: { inputTranscription: { text: turn.utterance } } });
    // (2) Scripted tool calls, in order, each awaited so its action_result leg is flushed first.
    for (const tc of turn.toolCalls) {
      const callId = session.emitToolCall(tc.name, tc.args ?? {});
      callIdsByTurn[t].push(callId);
      const output = await waitUntil(() => {
        const r = mock.responseFor(callId);
        return r === undefined ? false : { r };
      });
      results.push({ turnIndex: t, name: tc.name, callId, output: (output as { r: any }).r });
    }
  }

  // Reconstruct: read the interaction log, group by interaction_id, and map each tool_call leg back
  // to the turn whose emitted callIds contain it.
  const groups = readInteractionGroups();
  const callIdToTurn = new Map<string, number>();
  callIdsByTurn.forEach((ids, turnIdx) => ids.forEach((id) => callIdToTurn.set(id, turnIdx)));

  const legs: ReconstructedLeg[] = [];
  const interactionIdsByTurn: Array<string | undefined> = new Array(vignette.turns.length).fill(undefined);

  for (const [interactionId, recs] of groups) {
    for (const rec of recs) {
      if (rec?.kind !== "tool_call") continue;
      const data = (rec.data ?? {}) as { name?: string; callId?: string; args?: Record<string, any> };
      const callId = data.callId;
      const turnIndex = callId != null && callIdToTurn.has(callId) ? callIdToTurn.get(callId)! : -1;
      if (turnIndex < 0) continue; // a leg from another suite/turn we didn't script — skip
      interactionIdsByTurn[turnIndex] = interactionId;
      const args = (data.args ?? {}) as Record<string, any>;
      // Pair with the action_result leg for the same callId (resultKind).
      const resultLeg = recs.find(
        (r) => r?.kind === "action_result" && (r.data as any)?.callId === callId
      );
      legs.push({
        turnIndex,
        interactionId,
        name: data.name ?? rec.kind,
        callId,
        args,
        effectiveTarget: effectiveTargetOf(args),
        resultKind: (resultLeg?.data as any)?.resultKind,
      });
    }
  }

  // Keep legs in turn order, then in their emission order within a turn (callId emission order).
  const callIdEmissionOrder = new Map<string, number>();
  let seq = 0;
  callIdsByTurn.forEach((ids) => ids.forEach((id) => callIdEmissionOrder.set(id, seq++)));
  legs.sort((a, b) => (callIdEmissionOrder.get(a.callId ?? "") ?? 0) - (callIdEmissionOrder.get(b.callId ?? "") ?? 0));

  return { vignette, results, legs, interactionIdsByTurn };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scorers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * scoreAttribution — mis-attribution rate over the tool-call legs that NAME a target.
 *
 * A leg is "attributed" by comparing its effectiveTarget (the pane/project in the recorded args) to
 * its turn's named target (targetPaneId for per-pane tools, targetProjectId for project tools). Legs
 * that name no target (pure orientation calls like list_panes) are EXCLUDED from the denominator —
 * they make no pane claim to mis-attribute. With deterministic server routing the effective target
 * always equals the args we scripted, so a correctly-scripted vignette scores rate === 0; a non-zero
 * rate means a leg routed somewhere other than the turn intended (a real attribution regression).
 */
export function scoreAttribution(run: VignetteRun): AttributionScore {
  const offenders: ReconstructedLeg[] = [];
  let total = 0;
  for (const leg of run.legs) {
    const turn = run.vignette.turns[leg.turnIndex];
    if (!turn) continue;
    if (leg.effectiveTarget == null) continue; // no target named -> not scorable for attribution
    const named = turn.targetPaneId ?? turn.targetProjectId;
    if (named == null) continue; // turn names no target -> exclude
    total++;
    if (leg.effectiveTarget !== named) offenders.push(leg);
  }
  const misAttributed = offenders.length;
  return { total, misAttributed, rate: total === 0 ? 0 : misAttributed / total, offenders };
}

/**
 * scoreGroundingPrecedesClaim — for a single-turn "answer a question about X" vignette, verify that a
 * GROUNDING call (one of the read/orientation tools) appears in the turn's trace BEFORE any factual
 * claim about X. Because WE script the sequence, "the claim" is modeled as the FIRST non-grounding
 * tool call (or, if all calls are grounding reads, the turn is fully grounded). Returns the per-turn
 * grounded flags and an overall rate of turns that satisfied the invariant.
 *
 * `groundingTools` defaults to the orientation/read set the spec calls out (list_panes,
 * get_pane_summary, get_pane_command_history, switch_context, get_pane_delta).
 */
export function scoreGroundingPrecedesClaim(
  run: VignetteRun,
  groundingTools: Set<string> = new Set([
    "list_panes",
    "get_pane_summary",
    "get_pane_command_history",
    "get_pane_delta",
    "switch_context",
    "get_attention_digest",
  ])
): { perTurn: boolean[]; groundedTurns: number; scorableTurns: number; rate: number } {
  const perTurn: boolean[] = [];
  let scorable = 0;
  let grounded = 0;
  for (let t = 0; t < run.vignette.turns.length; t++) {
    const turnLegs = run.legs.filter((l) => l.turnIndex === t);
    if (turnLegs.length === 0) {
      perTurn.push(true); // no calls -> nothing to ground (vacuously satisfied)
      continue;
    }
    scorable++;
    // A turn is grounded iff a grounding call occurs at or before the first non-grounding call.
    const firstNonGrounding = turnLegs.findIndex((l) => !groundingTools.has(l.name));
    const firstGrounding = turnLegs.findIndex((l) => groundingTools.has(l.name));
    const ok =
      firstGrounding !== -1 && (firstNonGrounding === -1 || firstGrounding <= firstNonGrounding);
    perTurn.push(ok);
    if (ok) grounded++;
  }
  return { perTurn, groundedTurns: grounded, scorableTurns: scorable, rate: scorable === 0 ? 1 : grounded / scorable };
}
