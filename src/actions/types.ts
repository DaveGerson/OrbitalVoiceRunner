/**
 * src/actions/types.ts — the ActionDef registry contract (REG1 Phase A scaffolding).
 *
 * One canonical ActionDef per operation: name, params (zod), capability gate, redaction policy,
 * surfaces, and ONE handler. Every surface (Gemini voice, REST, WS) is DERIVED from these defs
 * (see gemini.ts / rest.ts / capabilities.ts / coverage.ts). This file is the spec §5.0 contract,
 * transcribed verbatim except where the GROUNDING (real server.ts) requires a precise signature.
 *
 * IMPORTANT (grounding): gateOrDefer / effectiveCapabilityGateFor / dispatchProposal are NESTED
 * CLOSURES inside server.ts over heavy server state — they cannot be imported or lifted. They are
 * INJECTED through ActionContext. The GateOrDefer type below MATCHES the real server.ts signature
 * (server.ts:1753) exactly, including the optional `params` (durable-restart intent) and
 * `requestedMode` (the permission-handler divergence rider).
 */

import type { z } from "zod";
import type { OrchestratorManager } from "../terminal";
import type { CapabilityGate, GateValue } from "../types";
import type {
  ApprovalKind,
  PendingApprovalStore,
  ResolveAction,
  ResolveMode,
} from "../pendingApprovals";
import type { PendingActionStore } from "../pendingActions";
import type { JanusStore } from "../store/sqliteStore";
import type { PaneModeResult } from "../applyPaneMode";
import type { ShadowStats } from "../approvalShadow";

/** Which surfaces expose this action. Goal is convergence; the flag makes drift explicit. */
export type Surface = "voice" | "rest" | "ws";

/** A capability = one row of the matrix. The set is DERIVED from the registry, not hand-listed. */
export type Capability = string; // closed at runtime by the registry; see deriveCapabilities()

/**
 * Enforcement class of a capability — what kind of CONTROL the matrix/UI can honestly offer for it.
 * Phase 0 metadata foundation: classification ONLY, no behavior change. Later phases (1/2) drive the
 * correct control type (3-way / 2-way / read-only badge) and gate plumbing off this.
 *
 * - "deferrable":    side-effecting action that returns a narration string and can WAIT; supports full
 *                    Auto/Ask/Off via gateOrDefer/dispatchProposal → UI shows a 3-way toggle.
 * - "veto":          synchronous/return-style op where "Ask" cannot defer-and-return; only Off is
 *                    meaningful (Allow/Off) → UI shows a 2-way toggle.
 * - "informational": gating is self-defeating/nonsensical; shown as a read-only badge, never gated.
 */
export type CapabilityEnforcement = "deferrable" | "veto" | "informational";

/** One capability-matrix row. The metadata (label/category/default) lives in CAPABILITY_DEFS. */
export interface CapabilityDef {
  id: Capability;                 // e.g. "write_to_pane", "read_pane", "archive_pane"
  label: string;                  // plain language, no jargon (matrix + voice read-backs)
  category: string;               // grouping for the matrix editor
  defaultGate: "Auto" | "Ask" | "Off"; // behavior-preserving default (Decision 6)
  enforcement: CapabilityEnforcement;   // control-type class (Phase 0 metadata; drives UI in Phase 1/2)
  spotlightEligible?: boolean;    // may loosen to Auto on the active pane (today: write_to_pane, deliver_handoff)
}

/** Discriminated result so one handler can express every existing response shape (§9 wire map). */
export type ActionResult =
  // `meta` (c55.9) is an OPTIONAL out-of-band channel for a `rest.toHttp` hook to read facts the voice
  // wire shape must NOT carry. The voice projection (resultToToolResponse -> voiceResponse) reads ONLY
  // `output`, so `meta` is invisible to voice; a def that must vary its HTTP status WITHOUT mutating the
  // spoken `output` string (e.g. execute_plan, whose handler narrates the SAME read-back on every dispatch
  // outcome) stamps the outcome here and reads it back in toHttp. Absent on every other def (no behavior change).
  | { kind: "ok"; output: unknown; meta?: Record<string, unknown> }  // normal read/write success
  | { kind: "pending"; messageId: string; summary: string; extra?: Record<string, unknown> } // HiTL / deferred
  | { kind: "clarify"; text: string }                                // re-route / disambiguate (e.g. non-allowlisted shell)
  | { kind: "blocked"; reason: string }                              // gate Off / forbidden
  | { kind: "error"; message: string };                              // handler failure (still answered once)

/**
 * One row of the per-action audit trail emitted by runAction (the audit() seam). The store stamps
 * `ts` later — it is intentionally NOT part of this shape. `args` carries the PARSED args (the
 * store/redaction wiring is done later in server.ts — runAction never logs raw, un-redacted args).
 * `surface` is the dispatch surface ("voice" / "REST" / "WS"), derived from ctx.trigger.
 */
export interface ActionAuditRow {
  name: string;          // the dispatched action name
  capability: string;    // def.capability (the matrix row, or ALWAYS_ALLOWED)
  resultKind: string;    // ActionResult.kind: ok | pending | clarify | blocked | error
  ms: number;            // wall-clock handler elapsed (performance.now() delta)
  args?: unknown;        // parsed args (NOT raw); redaction wired later in the store
  surface?: string;      // dispatch surface, from ctx.trigger
}

/**
 * The exact disposition union the real server.ts gateOrDefer returns (server.ts:1768). runAction
 * branches on `.disposition`: "run" -> invoke handler, "forbidden" -> blocked, "deferred" -> pending.
 */
export type GateDisposition =
  | { disposition: "run" }
  | { disposition: "forbidden" }
  | { disposition: "deferred"; actionId: string; summary: string };

/**
 * The injected gate choke-point. Signature MATCHES server.ts:1753 verbatim — do NOT change the
 * parameter order/optionality: it is the same function object the voice path calls today, handed in
 * via ActionContext. (capability is typed `string` here, not the CapabilityGate union, because the
 * registry owns a SUPERSET of capabilities — the 16 existing + the promoted reads/focus/etc. The
 * real server widens its CapabilityGate union as those promotions land in Phase B/C.)
 */
export type GateOrDefer = (
  capability: string,
  paneId: string | null,
  summary: string,
  run: () => string,
  params?: Record<string, unknown>,
  requestedMode?: string
) => GateDisposition;

/**
 * A minimal structural shape for the Gemini Live session object on the voice path. We only ever
 * call sendToolResponse on it (resultToToolResponse, §9). `null` on the REST/WS path.
 */
export interface LiveSessionLike {
  sendToolResponse: (payload: {
    functionResponses: Array<{ name: string; id?: string; response: Record<string, unknown> }>;
  }) => void;
}

/**
 * The result shape returned by the pane-WRITE choke-point dispatchProposal (server.ts:482, a closure-
 * local `type` that cannot be imported — copied STRUCTURALLY verbatim, R3). The propose_command /
 * deliver_handoff / execute_plan handlers branch on `.kind` and narrate `.text`. Only the `pending`
 * arm has a side effect beyond return (it stages an approval entry + sends an approval_pending frame).
 */
export type DispatchOutcome =
  | { kind: "executed"; text: string }
  | { kind: "blocked"; text: string }
  | { kind: "error"; text: string }
  | { kind: "clarify"; text: string }
  | { kind: "pending"; text: string };

/**
 * The argument object the dispatchProposal choke-point takes (server.ts:2250). MATCHES the real
 * closure's `opts` exactly (R1). `sess` is the live Gemini session (passthrough, stored in the
 * approval side-map); pass `ctx.session` on the voice path. `pendingId` defaults to `callId`;
 * `capability` defaults to "write_to_pane".
 */
export interface DispatchProposalArgs {
  sess: LiveSessionLike | null;
  callId: string;
  pendingId?: string;
  targetId: string;
  instruction: string;
  explicitKind?: ApprovalKind;
  trigger: string;
  capability?: CapabilityGate;
  /**
   * Fan-out staging (dispatch_to_panes). When true the write may target a NON-active pane on the
   * voice path, BUT can never auto-execute: an auto_execute decision is downgraded to
   * pending_approval before the effect switch. Strictly more cautious than the default path — the
   * operator still sees/approves every write before it lands, which is the active-pane guard's
   * whole purpose. Absent/false everywhere except the multi-target dispatch handler.
   */
  forceStage?: boolean;
}

/**
 * The injected pane-WRITE choke-point. Signature MATCHES the real server.ts dispatchProposal closure
 * (server.ts:2250). It is a NESTED closure over ~12 server-lifetime + per-connection bindings
 * (activePaneId live-read, clientWs originator sink, manager, pendingApprovals, broadcast, …) — it
 * CANNOT be imported or lifted; it is handed in via ActionContext, exactly the same function object
 * the propose_command / deliver_handoff / execute_plan paths call today. It is THE single pane-write
 * enforcement function; handlers merely call it (one impl, injected).
 */
export type DispatchProposal = (args: DispatchProposalArgs) => DispatchOutcome;

/**
 * The injected lighter gate (server.ts:1734). Enforces ONLY the Off veto (and audits) — Ask is
 * allowed to PROCEED (no pendingActions staging, no durable replay). Used by the layout-level
 * apply_recipe envelope. Distinct from gateOrDefer, which durably defers on Ask. Returns the
 * effective gate so the caller can decide; `forbidden` is true exactly when the gate is Off.
 */
export type GateCapability = (
  capability: string,
  paneId: string | null
) => { forbidden: boolean; gate: GateValue };

/**
 * One entry in the orchestration-recipe catalog (server.ts:1326 — a closure-local `const recipes`
 * array). Defined STRUCTURALLY inline (R3 precedent) — NOT imported from server.ts. apply_orchestration_recipe
 * reads this catalog to materialize a layout (each pane opens a bare shell; startupCommand is a SUGGESTION
 * the operator runs explicitly, never auto-run). `preset` is always the literal "Custom"; permissionsMode
 * is one of the three EffectiveMode strings.
 */
export interface OrchestrationRecipe {
  id: string;
  name: string;
  description: string;
  panes: Array<{
    id: string;
    name: string;
    startupCommand: string;
    preset: "Custom";
    permissionsMode: "Human-in-the-Loop" | "Full Auto" | "Read-Only";
  }>;
}

/**
 * The per-session pending-approval surface the handoff/approval read+resolve handlers need
 * (list_pending_approvals, get_attention_digest, reject_handoff). This is exactly the live
 * PendingApprovalStore INSTANCE (server.ts:1645) injected by reference — type-only imported, so
 * no value/cycle risk. Handlers use forSession / setLastAnnounced / has (and the rest of the store
 * surface is available if a faithful port needs it).
 */
export type PendingApprovalsSurface = PendingApprovalStore;

/**
 * The injected handoff-delivery resolution closure: applyResolution (server.ts:2054). The single
 * resolve choke-point — runs resolveDecision (atomic claim + delete), narrates, broadcasts, and
 * flips any linked handoff row. reject_handoff calls it as `applyResolution(h.gate_approval_id,
 * "reject")` to cancel a pending delivery. Returns the ResolveAction so the caller can branch on
 * `.reason` (its `.record` is a PendingApproval — handlers get that shape transitively).
 */
export type ApplyResolution = (
  messageId: string,
  mode: ResolveMode,
  opts?: { vocal?: boolean }
) => ResolveAction;

/**
 * Everything a handler needs, INJECTED (never reached out to). The heavy server closures
 * (gateOrDefer, dispatchProposal, gateCapability, broadcast, …) are passed in so handlers stay thin
 * and testable. THIS IS THE FROZEN CONTRACT for the 7-agent authoring fan-out.
 *
 * GATE MODEL (Decision: handler-owned / model B). runAction does NOT apply a central gate. Each
 * handler faithfully ports its current server.ts branch — calling ctx.gateOrDefer (durable Ask-defer
 * mutators), ctx.dispatchProposal (pane-write HiTL: propose_command / deliver_handoff / execute_plan),
 * or ctx.gateCapability (Off-veto-only: apply_recipe envelope) EXACTLY where and how it does today —
 * AND NOT gating the tools that are intentionally ungated today (drafts, notes, focus, mute, handoff
 * staging). The three gate functions remain THE single enforcement FUNCTIONS (one impl each, injected);
 * handlers merely call them, same as the legacy dispatch. `capability` stays declared on every
 * ActionDef for the matrix projection + docs, even on ungated tools (it is the matrix row, not a
 * promise that runAction enforces it — the HANDLER is the authority on if/how it gates).
 */
export interface ActionContext {
  manager: OrchestratorManager;
  session: LiveSessionLike | null;     // present on the voice path; null for REST/WS
  callId?: string;                     // Gemini call.id on the voice path
  trigger?: string;                    // operator utterance / "REST" / "WS"
  /** Clean dispatch-surface token ("voice" | "rest" | "ws") persisted to the action_log. The context
   *  builders set it explicitly (the ONE source of truth); runAction falls back to a session-presence
   *  heuristic when absent. NEVER the raw operator utterance (that would leak un-redacted text into an
   *  un-redacted column) — that is why `trigger` (the utterance) is NOT reused as the surface. */
  surface?: string;
  /** The per-connection spoken utterance (server.ts:2233). propose_command uses it as the dispatch
   *  trigger (`currentSessionUserUtterance || "Spoken execute command"`). Empty string off the voice path. */
  userUtterance?: string;
  broadcast: (msg: unknown) => void;
  /** Re-broadcast the ledger snapshot (server.ts:831 broadcastLedgerUpdate) — note/project mutators
   *  fan this out after a write so the UI refreshes. Injected so handlers don't reach into closures. */
  broadcastLedgerUpdate: () => void;
  gateOrDefer: GateOrDefer;            // durable Ask-defer choke-point (server.ts:1753), injected
  dispatchProposal: DispatchProposal; // pane-WRITE HiTL choke-point (server.ts:2250), injected
  gateCapability: GateCapability;     // Off-veto-only gate (server.ts:1734), injected
  redact: (s: string) => string;      // redactSecrets, injected
  /** Optional per-action audit sink. runAction best-effort calls this once per dispatch (inside a
   *  try/catch that NEVER throws) with an ActionAuditRow. The store wiring (audit -> JanusStore,
   *  which stamps `ts` + applies redaction) is done later in server.ts; here it is only defined +
   *  called. Absent on the test/REST/WS paths that do not opt in. */
  audit?: (row: ActionAuditRow) => void;

  /** PLM3 version stamp for THIS dispatch: { actionName, schemaHash } the deferring handlers spread
   *  into the params they hand to ctx.gateOrDefer, so a boot can quarantine a drifted intent. Set by
   *  the server's context builder (it knows the dispatched action name); undefined off that path. */
  versionStamp?: { actionName?: string; schemaHash?: string };

  // ── Active-pane source of truth (server.ts:458, a closure-local `let activePaneId`) ──────────
  /** Read the live active pane id (the single source of truth for where Janus may write).
   *  add_pane_note defaults its pane_id to this when the caller omits one (server.ts:458). */
  getActivePaneId: () => string | null;

  // ── Memory Synthesis P0a freshness trigger (optional/additive) ────────────────────────────────
  /** Request a FRESH situational brief synthesis + inject it into the live session for the
   *  now-active pane (anti-rot, spec freshness trigger). switch_context calls it after its live
   *  ledger sync (the "catch me up" path). Wired by the server's voice context builder; absent on
   *  REST/test paths, where the call site is a safe no-op. NON-BLOCKING + never throws. */
  injectMemoryBrief?: () => void;
  /** P0b observability: which synthesis path is currently live ("python" when the warm daemon is
   *  available + the breaker is closed, else "fallback"). Wired by the server on the REST surface;
   *  absent on voice/test paths, where get_health reports the safe default "fallback". */
  memorySynthesizerState?: () => "python" | "fallback";
  /** Inc 2 task 2.2 observability: snapshot of the approval SHADOW diff counters (compared/match/
   *  mismatch/missing), or null when no recorder is installed (daemon off / memoryPythonEnabled false).
   *  Wired by the server on the REST surface; absent on voice/test paths, where get_health omits/zeros
   *  the shadow field. Read-only — additive, never gates a decision. */
  approvalShadowStats?: () => ShadowStats | null;
  /** Inc 2 task 2.3 observability: snapshot of the cumulative daemon DEGRADATION counters
   *  (transitions / msInFallback / currentlyFallback), or null when no tracker is wired. This is the
   *  POST-first-up, warm-up-immune retire-gate metric — distinct from memorySynthesizerState (the
   *  instantaneous read). Wired by the server; absent on voice/test paths, where get_health reports
   *  memory.daemon as null. Read-only — additive, never gates a decision. */
  daemonStateStats?: () => { transitions: number; msInFallback: number; currentlyFallback: boolean } | null;
  /** Write the active pane (switch_active_pane records the new focus, server.ts:2626). `null` clears
   *  focus when no pane is open. Pure focus move — never a CLI write. */
  setActivePane: (paneId: string | null) => void;

  // ── Workbench drafts (server.ts:508/512 — ungated; composing a draft is not a CLI write) ─────
  /** The active draft target: { projectId, paneId } resolved off the live active pane, or null when
   *  no pane is open (server.ts:508). update_draft_prompt targets this. */
  activeDraftTarget: () => { projectId: string; paneId: string } | null;
  /** Re-broadcast a pane's draft as a `{type:'draft_updated',...}` frame after a write
   *  (server.ts:512). update_draft_prompt fans this out so the UI repaints. */
  broadcastDraft: (projectId: string, paneId: string) => void;

  // ── Pane-posture broadcast (server.ts:1844) ──────────────────────────────────────────────────
  /** Broadcast `{type:'terminals_updated', postures: allPanePostures()}` so the chips repaint
   *  without a /api/terminals refetch (server.ts:1844). create_pane + set_pane_permissions emit it. */
  broadcastTerminalsUpdated: () => void;

  // ── Live mode-switch choke point (multi-cli adapter spec §6, bead 1y8) ─────────────────────────
  /**
   * The injected applyPaneMode choke point — the ONE path that makes a pane permission change reach
   * the LIVE process (Claude live-signal / Codex+agy restart-resume), draining pending on a Full-Auto
   * promotion (§11). The server binds it to the real terminal + gateOrDefer + pending stores +
   * broadcast + ledger persist. OPTIONAL so test/REST contexts that don't wire it fall back to the
   * legacy setPermissionsMode (next-spawn-only) path. `set_pane_permissions` and the new `restart_pane`
   * tool delegate here when present. `source` is the caller surface (audit only).
   */
  applyPaneMode?: (
    paneId: string,
    targetMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only",
    source: "voice" | "ui" | "restart_pane",
  ) => Promise<PaneModeResult>;

  // ── Gate inspection (server.ts:1711 — the resolver behind gateCapability/gateOrDefer) ─────────
  /** Resolve the EFFECTIVE per-capability gate for a (pane, capability), spotlight + frozen applied
   *  (server.ts:1711). Read-only inspection used by get_pane_gates / apply_orchestration_recipe /
   *  set_capability_gate (the loosen check). */
  effectiveCapabilityGateFor: (
    paneId: string | null | undefined,
    capability: CapabilityGate
  ) => GateValue;

  // ── Attention queue maintenance (server.ts:533) ──────────────────────────────────────────────
  /** Bound + TTL-evict the attention queue in place (server.ts:533). dismiss_attention /
   *  get_attention_digest call it before reading so the queue stays bounded. */
  pruneAttention: () => void;

  // ── Pending-approval store (server.ts:1645 — the live PendingApprovalStore instance) ──────────
  /** The per-session pending-approval store, injected by reference (server.ts:1645). Handlers use
   *  forSession / setLastAnnounced / has — list_pending_approvals, get_attention_digest, reject_handoff —
   *  and `all()` (the REST view, pendingApprovals.ts:623) for the c55.15 `list_pending_commands` def. */
  pendingApprovals: PendingApprovalsSurface;
  /** The non-PTY deferred-action store (gated-Ask staging), injected (server.ts pendingActions, line
   *  602). Used by the c55.15 approvals/pending REST defs: list (`all()`) / confirm / cancel — plus the
   *  `has(id)` 404 guard. GLOBAL (not session-scoped, unlike pendingApprovals). */
  pendingActions: PendingActionStore;
  /** The single resolve choke-point (server.ts:2054): claim+delete, narrate, broadcast, flip handoff.
   *  reject_handoff calls it to cancel a pending delivery; returns the ResolveAction to branch on. */
  applyResolution: ApplyResolution;

  // ── Durable ledger (server.ts module `store`) ────────────────────────────────────────────────
  /** The SQLite ledger backing handoffs + the audit trail. `null` under JANUS_LEDGER_BACKEND=legacy
   *  (or store-init failure); the 8 handoff/gate tools degrade gracefully when null. */
  store: JanusStore | null;

  // ── Settings masking (server.ts:84) ─────────────────────────────────────────────────────────
  /** Deep-copy settings with the Gemini key masked, safe for the settings_updated broadcast
   *  (server.ts:84). set_global_permissions / set_capability_gate / set_voice_mute use it. */
  sanitizeSettingsForClient: <T extends { secrets?: { geminiApiKey?: string } }>(settings: T) => T;

  // ── Orchestration-recipe catalog (server.ts:1326 — closure-local `const recipes`) ────────────
  /** The recipe catalog apply_orchestration_recipe materializes a layout from (server.ts:1326).
   *  ReadonlyArray — handlers only read it. */
  recipes: ReadonlyArray<OrchestrationRecipe>;

  // ── Emergency brake (server.ts:1879/1955 — the always-allowed STOP-ALL trio) ──────────────────
  /** STOP-ALL: freeze + cancel-in-flight (kill=false → returns the still-running pane names) or the
   *  irreversible kill (kill=true → returns the killed pane names). Broadcasts the frozen / stop_all
   *  frames itself (server.ts:1879). The brake is ALWAYS allowed — never gated. */
  stopAll: (kill: boolean) => Promise<string[]>;
  /** Clear the freeze; safety gates restore exactly as they were (server.ts:1955). Does not restart panes. */
  releaseStopAll: () => void;
  /** Read the live STOP-ALL `frozen` flag — confirm_stop_all / release_stop_all guard on it. */
  isFrozen: () => boolean;
  /** The pane ids that are still RUNNING (a live PTY) — the STOP-ALL boot-restore snapshot uses it to
   *  list what survived a freeze (server.ts runningPaneIds). get_stop_all_status reads it on Off-frozen. */
  runningPaneIds: () => string[];

  // ── Effective per-pane posture (server.ts gating posturePayloadForPane) ───────────────────────
  /** Resolve a pane's SERVER-truth posture: its id, the 16 effective gate values, and the derived
   *  posture word (frozen-aware). list_panes builds its flat per-pane REST array from this so the chip
   *  renders from server truth (no client policy re-derivation). The `posture` field is structurally
   *  typed here to avoid coupling the action contract to the gating module's internal posture-word type. */
  posturePayloadForPane: (paneId: string) => {
    id: string;
    effective_gates: Record<CapabilityGate, GateValue>;
    posture: unknown;
  };

  // deliver_handoff note: NO injected closure for the outcome→row mapping. `deliverOutcomeToHandoff`
  // is a PURE, EXPORTED function in src/handoffFlow (server.ts imports it as a value at server.ts:37,
  // and the deliver_handoff branch calls it at server.ts:3315). It captures NO server state, so it is
  // NOT a ctx closure — the deliver_handoff handler imports it directly
  // (`import { deliverOutcomeToHandoff } from "../handoffFlow"`) and reproduces the branch using
  // ctx.store (getHandoff / updateHandoffState / setGateApprovalId), ctx.dispatchProposal (the gated
  // pane write, capability "deliver_handoff"), and ctx.broadcast (`{type:'handoffs_updated'}`). All of
  // those are already on ActionContext; no new field is needed.
}

/**
 * The canonical, single-source-of-truth definition of one action. `S` is the zod schema; `z.infer<S>`
 * is the validated arg type the handler receives. ALWAYS_ALLOWED is the sentinel for the emergency
 * brake — runAction bypasses the gate for it (and ONLY it).
 */
export interface ActionDef<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;                        // canonical snake_case (the Gemini + dispatch + REST key)
  description: string;                 // operator-facing; fed verbatim to Gemini
  params: S;                           // ONE schema -> Gemini params + REST/WS validation
  capability: Capability | "ALWAYS_ALLOWED"; // MANDATORY — every action is a matrix entry (Decision 5)
  readOnly: boolean;                   // true => result text is redacted before leaving the process
  surfaces: ReadonlySet<Surface>;      // where it is exposed (drift made explicit & testable)
  rest?: {
    method: "get" | "post" | "put" | "delete";
    path: string;
    /**
     * OPTIONAL per-action response translator (c55 Batch E — the `rest.toHttp` primitive). When set,
     * mountRestRoutes routes this def's ActionResult through `toHttp(result, args)` instead of the
     * default `resultToHttp` map, letting a page-load READ emit a bespoke structured body (a rich
     * array/object) the flat `{output:string}` cannot carry. Reserved for the ~4 structured reads;
     * status-via-kinds is preferred wherever the handler can return blocked/pending directly. The
     * VOICE path never consults this — it always projects `result.output` via resultToToolResponse,
     * so a def using `toHttp` for a pure-UI shape should be `surfaces: new Set(['rest'])`.
     */
    toHttp?: (result: ActionResult, args: Record<string, unknown>) => { status: number; body: unknown };
  }; // optional explicit route binding (+ optional response translator)
  handler: (args: z.infer<S>, ctx: ActionContext) => Promise<ActionResult> | ActionResult;
  /** Optional arg coercion for back-compat (e.g. propose_command: command -> instruction). */
  coerceArgs?: (raw: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Optional per-action deadline override (ms). runAction races the handler against this ceiling for
   * NON-ALWAYS_ALLOWED actions; falls back to DEFAULT_ACTION_TIMEOUT_MS when unset. A fast handler
   * still returns immediately — this is a ceiling, not a delay. ALWAYS_ALLOWED actions are exempt.
   */
  timeoutMs?: number;
}

/** The ALWAYS_ALLOWED sentinel, exported so generators/tests reference one string. */
export const ALWAYS_ALLOWED = "ALWAYS_ALLOWED" as const;
