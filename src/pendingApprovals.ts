/**
 * WS-E — Spoken, targeted, safe approvals: the serializable pending-approval state shape +
 * store + the pure gate-decision and resolution logic.
 *
 * This module is shaped to CO-EVOLVE with WS-F (durable + race-safe state) WITHOUT a
 * rewrite, per the design §8:
 *   - `PendingApproval` is a plain, serializable record (no live `session` handle on it);
 *   - the live `session` handle lives in a SEPARATE side-map keyed by messageId;
 *   - an ordered index array drives ordinal targeting + `lastAnnouncedApprovalId`;
 *   - a `claimed` flag is the seam WS-F upgrades into an atomic claim (it already prevents
 *     the REST+voice double-dispatch on the single-threaded event loop today).
 * Durability itself is NOT implemented here.
 *
 * The gate-decision (`decideProposal`) and resolution helpers are PURE so the HiTL branch,
 * the kind/allowlist discriminator, back-compat inference, TTL auto-reject, and dead-pane
 * error can all be unit-tested against fake terminals/sessions (no PTY, no Gemini).
 */

import { redactSecrets } from "./terminal";
import type { JanusStore } from "./store/sqliteStore";
import type { StoredPendingApproval } from "./store/types";

/**
 * Durable backend contract PendingApprovalStore depends on. JanusStore implements it; a null
 * backend (legacy / store-init-failed) means pure in-memory behavior, byte-for-byte as before.
 * Typed structurally (not as the whole JanusStore) so the dependency surface stays minimal.
 */
// wsm-e2e-pinned-4s2 (5): `getPendingApprovals(sessionId)` is NOT part of this contract —
// PendingApprovalStore never calls it (hydration/expiry both go through getExpiredApprovals, which
// with now=MAX_SAFE_INTEGER doubles as "all unclaimed rows"). JanusStore still implements + exports
// the concrete method (tests exercise it directly against a JanusStore instance), so this is purely
// trimming the INTERFACE surface to what this module actually depends on.
export interface ApprovalDurableStore {
  insertPendingApproval(a: StoredPendingApproval): void;
  claimApproval(id: string): boolean;
  deletePendingApproval(id: string): void;
  getExpiredApprovals(now?: number): StoredPendingApproval[];
}

/** Optional metadata the server supplies on add() so the durable row can be fully formed. */
export interface AddApprovalMeta {
  /** Active project id at proposal time -> StoredPendingApproval.workspace_id. */
  workspaceId?: string;
  /** TTL window -> expires_at = record.timestamp + ttlMs (defaults to APPROVAL_DEFAULT_TTL_MS). */
  ttlMs?: number;
}

/** Fallback TTL when add() is called without an explicit ttlMs (mirrors server's APPROVAL_TTL_MS). */
export const APPROVAL_DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * The grace window between a spoken LAST-CALL and the auto-reject that follows continued silence
 * (spec §4.1 / §6.3). Default 60 s. Colocated with the TTL default so the sweep's two-phase
 * "last-call → grace → reject" timing lives next to `decideSweepAction`, the pure fn it parameterizes;
 * the server (TASK 3) imports it rather than re-declaring a literal.
 */
export const APPROVAL_GRACE_MS = 60 * 1000;

export type ApprovalKind = "agent_instruction" | "shell";
export type RuntimeType = "shell" | "interactive_cli";
export type EffectiveMode = "Full Auto" | "Human-in-the-Loop" | "Read-Only";
/** Per-capability gate value (design §3). Off > Ask > Auto (most-restrictive wins). */
export type GateValue = "Auto" | "Ask" | "Off";

/** The serializable record (WS-F primary key = `messageId`). NO live session handle here. */
export interface PendingApproval {
  /** Durable primary key; == the Live functionCall `callId` today. */
  messageId: string;
  /** The DISTILLED instruction (agent) or command (shell). `cmd` alias kept on serialize. */
  instruction: string;
  kind: ApprovalKind;
  terminalId: string;
  /** The Live functionCall id — consumed exactly once (push, not a 2nd tool response). */
  callId: string;
  /** trigger = raw dictation; summary = redacted pane snapshot. */
  rationale?: { trigger: string; summary: string };
  /** Creation epoch ms — drives the TTL sweep. */
  timestamp: number;
  /** WS-F atomic-claim seam: set before writeInput so REST+voice can't double-dispatch. */
  claimed?: boolean;
  /**
   * WS-F resumption transient (spec §5): the moment a spoken LAST-CALL was issued for this item
   * while its session is connected. Drives last-call→grace→reject in the sweep. IN-MEMORY ONLY —
   * never persisted (no durable column); cleared on re-attach. If it resets on restart the item
   * simply earns a fresh last-call, which is harmless.
   */
  lastCallAt?: number;
  /**
   * 3V.3 sweep transient: consecutive sweep ticks whose last-call NARRATION failed while the session
   * was connected (the sweep stamps lastCallAt only on a successful push, retrying next tick, and
   * stamps anyway once this counter hits the bound so a broken TTS never wedges the queue). IN-MEMORY
   * ONLY — never persisted; it resets on restart, which is safe because boot re-hydrates survivors
   * and the next (re)connect re-announces them, opening a fresh last-call window anyway. Cleared with
   * lastCallAt on re-attach.
   */
  lastCallFailures?: number;
  /** The capability this approval rides (design §3). Defaults to "write_to_pane". */
  capability?: string;
  /**
   * AgentExchange spine correlation (docs/superpowers/specs/2026-07-09-agent-exchange-spine.md
   * §5, flag JANUS_EXCHANGE_SPINE). Set ONLY when this approval was requested by the exchange
   * service on behalf of a tracked exchange (record/authoritative mode) — legacy/uncorrelated
   * approvals leave this undefined forever (never adopted heuristically). The bound
   * `draft_version` itself is NOT duplicated here: it lives on the exchange row
   * (`approval_draft_version`), addressed by `exchangeId`, so there is a single source of truth
   * for the CAS binding (spec §3).
   */
  exchangeId?: string;
}

/**
 * A small, read-only / observe-only first-token allowlist for `kind:"shell"`. Anything not
 * here is NOT executed and NOT dead-ended — it routes to a non-blocking clarify (the model
 * should hand heavy lifting to an agent pane via `kind:"agent_instruction"`).
 * Operator-overridable via `JANUS_SHELL_ALLOWLIST` (comma-separated env).
 *
 * bd wsm-e2e-pinned-wyv (BUCKET-3: looks-like-debt-but-correct): `ping` is DELIBERATELY ABSENT
 * here. It is not read-only/observe-only — under Full Auto it would auto-execute arbitrary-host
 * pings (unbounded runtime + network egress), so it must NEVER be a production default. The
 * voice-journey suite (tests/test_voice_journeys.ts) needs a stdin-ignoring long-blocker probe
 * and scopes `ping` in TEST-ONLY via `JANUS_SHELL_ALLOWLIST` (set in before(), deleted in
 * after()) — that env override REPLACES this default for the test process only. Do NOT add
 * `ping` to this list to "match the test"; the asymmetry is the whole point.
 */
export const DEFAULT_SHELL_ALLOWLIST = [
  "git", "ls", "cat", "pwd", "whoami", "ps", "head", "tail", "grep", "find", "df",
  "echo", "which", "env", "date", "uname", "hostname", "wc", "stat", "du", "tree",
];

export function loadShellAllowlist(envValue?: string): Set<string> {
  const raw = (envValue ?? process.env.JANUS_SHELL_ALLOWLIST ?? "").trim();
  if (!raw) return new Set(DEFAULT_SHELL_ALLOWLIST);
  return new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

/** First whitespace-delimited token of a shell command, lowercased (the allowlist key). */
export function firstShellToken(command: string): string {
  const m = command.trim().match(/^(\S+)/);
  return m ? m[1].toLowerCase() : "";
}

export function isShellAllowed(command: string, allowlist: Set<string>): boolean {
  const tok = firstShellToken(command);
  return tok.length > 0 && allowlist.has(tok);
}

/**
 * R2 back-compat: infer `kind` from the target pane's `runtimeType` when the model omits it.
 * `interactive_cli` (Claude Code / Codex / Antigravity) => agent_instruction; `shell` => shell.
 * Defaults to agent_instruction (the first-class path) when the pane is unknown.
 */
export function inferKind(explicitKind: ApprovalKind | undefined, runtimeType?: RuntimeType): ApprovalKind {
  if (explicitKind) return explicitKind;
  if (runtimeType === "shell") return "shell";
  return "agent_instruction";
}

export type ProposalDecision =
  | { type: "auto_execute" }                       // Full Auto: write now
  | { type: "blocked_read_only" }                  // Read-Only: never write
  | { type: "pending_approval" }                   // HiTL: two-phase spoken proposal
  | { type: "clarify_shell"; reason: string }      // non-allowlisted shell -> re-route
  | { type: "capability_forbidden"; capability: string } // gate Off: capability forbidden
  | { type: "error_no_pane" }                       // target pane missing
  | { type: "error_kind_mismatch"; reason: string };// agent_instruction on a shell pane, etc.

export interface DecideProposalInput {
  kind: ApprovalKind;
  instruction: string;
  /** The resolved effective permission mode for the target pane. */
  effectiveMode: EffectiveMode;
  /** undefined => pane not found. */
  runtimeType?: RuntimeType;
  paneExists: boolean;
  allowlist: Set<string>;
  /** The capability being exercised (design §3). Defaults to "write_to_pane" for back-compat. */
  capability?: string;
  /**
   * The resolved per-capability gate (design §3 AND-veto). When omitted, defaults to "Auto"
   * (back-compat: absent matrix = today's effectiveMode-only behavior). Composed decision is
   * the MOST RESTRICTIVE of (effectiveMode, gate): Off ⇒ forbidden, Ask ⇒ pending, Auto ⇒
   * defer to effectiveMode.
   */
  gate?: GateValue;
}

/**
 * STOP-ALL Stage-1 freeze short-circuit (spec §2.C / §3). While the global `frozen` flag is set,
 * EVERY capability resolves Off (capability_forbidden) at the SINGLE gate-resolution choke-point —
 * Janus literally cannot act anywhere until Release. This is a PURE pass-through on the already-
 * resolved gate value: it NEVER mutates the underlying matrix (Release is therefore a clean clear,
 * no snapshot/restore). Kept here next to resolveCapabilityGate* so the server's choke-point
 * (effectiveCapabilityGateFor) applies it in ONE place and never scatters the `frozen` check.
 *
 * Always-allowed actions (the stop_all emergency brake itself) DELIBERATELY do not route through
 * gate resolution, so this short-circuit can never forbid the halt/release that clears it.
 */
export function applyFrozenShortCircuit(frozen: boolean, resolved: GateValue): GateValue {
  return frozen ? "Off" : resolved;
}

/**
 * Pure capability-gate RESOLUTION (design §3): which gate value applies for a (pane,
 * capability). The per-pane override always WINS when present (in both directions — a pane
 * set to "Auto" overrides a global "Off", because the override is a deliberate exception to
 * the default); else the global default; else "Auto" (absent matrix == legacy mode-only).
 * Extracted pure so the precedence is unit-testable without the server's `manager` state.
 */
export function resolveCapabilityGate(
  paneGate: GateValue | undefined,
  globalGate: GateValue | undefined
): GateValue {
  return paneGate ?? globalGate ?? "Auto";
}

/**
 * Capabilities the SPOTLIGHT may loosen on the ACTIVE pane (director posture 2026-06-01:
 * "trust follows focus" — Janus acts freely where the director is looking). Only PRODUCTIVE
 * writes are spotlight-eligible. Destructive (close/restart), meta (set_*_gate/permissions),
 * and spawn (create_pane/apply_recipe/execute_plan) capabilities are NEVER auto-loosened by
 * focus — they always fall through to the explicit/global gate.
 */
export const SPOTLIGHT_CAPABILITIES: ReadonlySet<string> = new Set<string>([
  "write_to_pane",
  "deliver_handoff",
]);

/**
 * Context-aware gate resolution (the "spotlight"). Precedence:
 *   1. Explicit per-pane override always wins (deliberate exception, both directions).
 *   2. SPOTLIGHT: if this is the active pane AND the capability is productive/spotlight-eligible,
 *      loosen to "Auto" (act freely where the director is focused) — but only when there is no
 *      explicit per-pane override (rule 1).
 *   3. Else the global default.
 *   4. Else "Auto".
 * Pure + unit-testable; the server passes in whether paneId is the active pane.
 */
export function resolveCapabilityGateWithContext(
  paneGate: GateValue | undefined,
  globalGate: GateValue | undefined,
  capability: string,
  isActivePane: boolean
): GateValue {
  if (paneGate !== undefined) return paneGate; // explicit per-pane override wins
  if (isActivePane && SPOTLIGHT_CAPABILITIES.has(capability)) return "Auto"; // spotlight
  return globalGate ?? "Auto";
}

/**
 * f09.2 (timed autonomy windows): overlay a LIVE autonomy window onto an already-resolved gate.
 * A window is the FIRST thing that ever LOOSENS the matrix at runtime, so the direction is strictly
 * bounded here:
 *   - It loosens ONLY "Ask" → "Auto" (act freely on productive work for the window's lifetime).
 *   - It NEVER loosens an explicit "Off" (the veto) — Off stays Off. This is the safety guarantee.
 *   - It NEVER tightens "Auto".
 *   - `windowLive === false` (no window, or an expired one) is a pure pass-through.
 * Applied in effectiveCapabilityGateFor AFTER the override→spotlight→global resolution but BEFORE the
 * frozen short-circuit (applyFrozenShortCircuit) — so a STOP-ALL freeze ALWAYS wins over a window.
 * Pure + unit-testable; the caller decides liveness (a lazy `now < expires_at` check inside the gate).
 */
export function applyAutonomyWindow(resolved: GateValue, windowLive: boolean): GateValue {
  if (!windowLive) return resolved;
  return resolved === "Ask" ? "Auto" : resolved;
}

/**
 * Staged-handoff staleness (director posture 2026-06-01: "friction is worse" — a staged draft
 * NEVER auto-expires/deletes; it is merely FLAGGED stale so the operator can notice and act).
 * Default threshold 15 min. Pure; the caller derives this at read time from staged_at.
 */
export const STAGED_STALE_MS = 15 * 60 * 1000;
export function isStagedStale(stagedAt: number | null | undefined, now: number, thresholdMs: number = STAGED_STALE_MS): boolean {
  if (!stagedAt) return false;
  return now - stagedAt > thresholdMs;
}

/** Restriction rank of a gate: higher = more restrictive. Auto(0) < Ask(1) < Off(2). */
export function gateRank(g: GateValue): number {
  return g === "Off" ? 2 : g === "Ask" ? 1 : 0;
}

/**
 * Is changing `from` -> `to` a LOOSENING (less restrictive)? Loosening is the dangerous
 * direction for the meta-gate (design §6, director posture 2026-06-01): a confused/misheard
 * Janus loosening its own restraints by voice. Tightening (or equal) is always safe.
 */
export function isLoosening(from: GateValue, to: GateValue): boolean {
  return gateRank(to) < gateRank(from);
}

/**
 * Pre-gate input validation (design §2.1, P2): the soft-error / re-route checks that fire in
 * EVERY mode BEFORE the per-capability gate × effectiveMode composition. Order is load-bearing
 * and preserved verbatim from decideProposal: missing pane → empty instruction → kind/runtimeType
 * mismatch → non-allowlisted shell. Returns the early decision, or `null` to defer to the gate.
 * Extracted pure so decideProposal stays within the cyclomatic-complexity gate (≤10) WITHOUT
 * changing any branch, condition, or message byte.
 */
function validateProposalInput(input: DecideProposalInput): ProposalDecision | null {
  const { kind, instruction, runtimeType, paneExists, allowlist } = input;

  if (!paneExists) return { type: "error_no_pane" };

  // An empty/whitespace-only instruction is never a write (P2): in Full Auto it would otherwise
  // type a bare newline into the pane. Treat it as a soft clarify so the model re-states what it
  // actually wants to run, in EVERY mode (before the auto_execute branch can fire).
  if (instruction.trim() === "") {
    return { type: "clarify_shell", reason: "I didn't catch a command to run — what should I send to that pane?" };
  }

  // Kind/runtimeType validation (design §2.1): an agent instruction only makes sense on an
  // interactive_cli pane; a shell command on a shell pane. A mismatch is a soft error so the
  // model re-routes rather than typing prose into a bare shell.
  if (kind === "agent_instruction" && runtimeType === "shell") {
    return {
      type: "error_kind_mismatch",
      reason: "That pane is a raw shell, not an agent CLI. Use kind:\"shell\" for a shell command, or target an agent pane.",
    };
  }

  // Non-allowlisted shell -> clarify/re-route BEFORE the mode gate (it is never executed in
  // any mode; even Full Auto re-routes heavy shell to an agent).
  if (kind === "shell" && !isShellAllowed(instruction, allowlist)) {
    return {
      type: "clarify_shell",
      reason: `"${firstShellToken(instruction)}" is heavy-lifting shell — I should hand this to the agent in that pane instead of running it myself. Want me to direct the agent?`,
    };
  }

  return null; // valid input — defer to the gate × mode composition.
}

/**
 * The single, pure gate decision. Both `kind`s pass through the SAME effective-mode gate;
 * `kind` does NOT bypass permissions. The allowlist check is IN ADDITION to the mode gate.
 */
export function decideProposal(input: DecideProposalInput): ProposalDecision {
  const { effectiveMode } = input;
  const capability = input.capability ?? "write_to_pane";
  const gate: GateValue = input.gate ?? "Auto";

  // Pre-gate input validation (missing pane / empty instruction / kind mismatch / shell allowlist),
  // in the SAME order, BEFORE any gate × mode composition. Returns early when it fires.
  const invalid = validateProposalInput(input);
  if (invalid) return invalid;

  // AND-veto (design §3): the per-capability gate is evaluated AFTER the kind/allowlist checks
  // and AND-composed with effectiveMode. A capability can only TIGHTEN, never loosen, the mode.
  //   Off  ⇒ capability forbidden outright (most restrictive).
  //   Ask  ⇒ force pending_approval (unless Read-Only, which is even more restrictive — handled
  //          by the effectiveMode branch below since Read-Only > Ask).
  //   Auto ⇒ defer to the existing effectiveMode branch (mode is the sole gate).
  if (gate === "Off") return { type: "capability_forbidden", capability };

  // Read-Only is the most restrictive mode and wins over any gate (you cannot Ask your way past
  // a Read-Only pane). Evaluate it first so Ask cannot loosen Read-Only into a pending write.
  if (effectiveMode === "Read-Only") return { type: "blocked_read_only" };

  // Ask gate forces human-in-the-loop even when the mode would auto-execute (gate tightens mode).
  if (gate === "Ask") return { type: "pending_approval" };

  if (effectiveMode === "Full Auto") return { type: "auto_execute" };
  return { type: "pending_approval" };
}

/**
 * WS-E single-choke-point resolution (simplicity H1 / maintainability H1/H2/L9): the ONE place
 * every resolve path (REST approve, voice approve/reject, TTL sweep) decides what to do. The
 * atomic `claim()` is the MANDATORY gate INSIDE here, so NO path can write without winning the
 * claim — including the TTL sweep, which previously bypassed by filtering `!p.claimed`.
 *
 * It is PURE over the store + a `paneExists` predicate (no PTY, no Gemini), and returns a small
 * serializable ACTION the thin caller renders (writeInput + narration + broadcast). The record
 * is ALWAYS deleted on a terminal outcome (write/reject/dead-pane/expire) — never on a lost race.
 *
 * Reasons:
 *   - "not_found"      : no such record (idempotent no-op for a double resolve).
 *   - "lost_race"      : another resolver already claimed it (no write, no narration).
 *   - "dead_pane"      : approve but the target pane is gone -> error, no write.
 *   - "approved"       : claimed + write the instruction.
 *   - "rejected"       : operator/explicit reject -> no write.
 *   - "expired"        : TTL sweep -> no write.
 */
export type ResolveReason = "not_found" | "lost_race" | "dead_pane" | "approved" | "rejected" | "expired";

export interface ResolveAction {
  reason: ResolveReason;
  /** The record (for narration/broadcast). Absent only for "not_found". */
  record?: PendingApproval;
  /** True only for "approved": the caller MUST writeInput(record.instruction). */
  doWrite: boolean;
}

export type ResolveMode = "approve" | "reject" | "expire";

/**
 * Resolve a pending approval through the single mandatory claim gate.
 * `paneExists` is the caller's live check for the target terminal (dead-pane => error on approve).
 * On any TERMINAL outcome the record is deleted from the store here; the thin caller only renders.
 */
export function resolveDecision(
  store: PendingApprovalStore,
  messageId: string,
  mode: ResolveMode,
  paneExists: (terminalId: string) => boolean
): ResolveAction {
  const record = store.get(messageId);
  if (!record) return { reason: "not_found", doWrite: false };

  // Reject / expire never write — but they STILL claim, so a concurrent approve cannot then win
  // the claim and write after we have torn the entry down (closes the sweep/approve asymmetry).
  if (mode === "reject" || mode === "expire") {
    // If someone already claimed (a winning approve mid-flight), don't stomp it.
    if (record.claimed) return { reason: "lost_race", record, doWrite: false };
    // store.claim()'s boolean return is intentionally unchecked here: we just proved this record
    // is unclaimed, so the ONLY way this claim() can now lose is a genuinely concurrent approve
    // that claimed it in between (a cross-process race on the durable store — impossible in-process,
    // since JS never interleaves between these two synchronous statements). Either outcome is safe
    // to fall through on: if we won, this is the normal reject/expire path; if we lost, the winning
    // approve already captured its own copy of `record` and will write + delete independently — our
    // delete() here is then a harmless no-op (or races it harmlessly) rather than a correctness bug.
    store.claim(messageId);
    store.delete(messageId);
    return { reason: mode === "reject" ? "rejected" : "expired", record, doWrite: false };
  }

  // mode === "approve": dead-pane is an error (BUG-020) — delete, no write, no claimed write.
  if (!paneExists(record.terminalId)) {
    store.delete(messageId);
    return { reason: "dead_pane", record, doWrite: false };
  }
  // The MANDATORY atomic gate: only the claim winner writes (BUG-013/N-1 REST+voice race).
  if (!store.claim(messageId)) return { reason: "lost_race", record, doWrite: false };
  store.delete(messageId);
  return { reason: "approved", record, doWrite: true };
}

/**
 * The TRIGGER a sweep tick should fire for one staged record (spec §4.1 / §6.3). PURE — mirrors
 * the codebase's pure-decision pattern (`decideProposal`, `resolveDecision`): all the timing/connectivity
 * policy lives here so the server sweep (TASK 3) only RENDERS the chosen action (narrate / claim+delete /
 * nothing). The actual reject still routes through the unchanged `applyResolution(id,"expire")` →
 * `resolveDecision` claim+delete terminal path; this fn decides ONLY whether to last-call, reject, or wait.
 *
 *   - "none"     : leave the record staged (not yet due, or clock paused, or already claimed).
 *   - "lastcall" : connected + past TTL + no prior last-call → speak the last-call, set lastCallAt, DON'T reject.
 *   - "reject"   : connected + last-call already spoken + grace elapsed → route to applyResolution(id,"expire").
 */
export type SweepAction = { action: "none" } | { action: "lastcall" } | { action: "reject" };

/**
 * Decide the sweep trigger for `record` at `now` (spec §4.1 — the FORCED clock rule):
 *
 *   1. `isConnected === false` ⇒ "none". CLOCK PAUSED. You cannot re-announce a last-call into a
 *      session that isn't there, and the spec forbids rejecting without first speaking a last-call —
 *      so a disconnected item NEVER expires. It waits, durably, until the operator returns. (This is
 *      the whole "away at a meeting → still there on return" guarantee.)
 *   2. `claimed` truthy ⇒ "none". A claimed record is mid-resolve / already won by an approve; the
 *      sweep must never stomp it (mirrors resolveDecision's claimed short-circuit). Checked before the
 *      time gates so a claimed-but-undeleted survivor can never be last-called or re-rejected.
 *   3. Connected + idle past TTL (`now - timestamp > ttlMs`) with NO `lastCallAt` ⇒ "lastcall".
 *      First crossing: speak the context-rich last-call + grace; do NOT reject yet.
 *   4. Connected + `lastCallAt` set + grace elapsed (`now - lastCallAt > graceMs`) ⇒ "reject".
 *      Continued silence after the last-call: NOW route to the unchanged reject path.
 *   5. Else ⇒ "none" (not yet at TTL, or inside the grace window post-last-call).
 *
 * `now - timestamp > ttlMs` is exactly `now > expires_at` (expires_at = timestamp + ttlMs); the pure fn
 * works off the in-memory record's `timestamp` so it needs no durable column. Connectivity (per-record
 * session for approvals; global `activeFrontendWs` for actions) is resolved by the SERVER and passed in.
 */
export function decideSweepAction(
  record: { timestamp: number; claimed?: boolean; lastCallAt?: number },
  now: number,
  ttlMs: number,
  graceMs: number,
  isConnected: boolean,
): SweepAction {
  // (1) Clock paused while disconnected — never reject without a session to hear the last-call.
  if (!isConnected) return { action: "none" };
  // (2) A claimed record is mid-resolve / already won; the sweep must not touch it.
  if (record.claimed) return { action: "none" };
  // (4) Last-call already spoken and the grace window has elapsed → reject. (Checked before the
  // first-crossing gate so a record with lastCallAt set isn't re-issued a last-call.)
  if (record.lastCallAt !== undefined) {
    if (now - record.lastCallAt > graceMs) return { action: "reject" };
    return { action: "none" }; // still inside the grace window.
  }
  // (3) First crossing of the TTL while connected and idle → speak the last-call.
  if (now - record.timestamp > ttlMs) return { action: "lastcall" };
  // (5) Not yet due.
  return { action: "none" };
}

/** Serialize a record for the UI / persistence (keeps a `cmd` alias for back-compat). */
export function serializePending(p: PendingApproval): Record<string, any> {
  return {
    messageId: p.messageId,
    instruction: redactSecrets(p.instruction),
    cmd: redactSecrets(p.instruction), // back-compat: ApprovalDialog reads `cmd`
    kind: p.kind,
    terminalId: p.terminalId,
    rationale: p.rationale,
    timestamp: p.timestamp,
    ageSeconds: Math.max(0, Math.floor((Date.now() - p.timestamp) / 1000)),
  };
}

/**
 * Humanize an age (ms) into the spoken digest's coarse "<age> ago" form. Sub-minute reads
 * "just now" (no zero-minute / negative weirdness); then minutes, then hours, then days.
 * Coarse on purpose — the digest is spoken, not a precise audit clock.
 */
function humanizeAge(ageMs: number): string {
  if (ageMs < 60 * 1000) return "just now";
  const mins = Math.floor(ageMs / (60 * 1000));
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** Trim a long instruction to a spoken-digest length so a single line stays scannable. */
function shortInstruction(instruction: string, max = 80): string {
  const oneLine = instruction.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1).trimEnd()}…` : oneLine;
}

/**
 * PURE render of one resumption-digest line from EXISTING provenance (spec §5/§7) — no schema
 * change, all from fields already on the record:
 *   `<capability> → <terminalId>: "<redacted short instruction>" (you said: <trigger>) — <age> ago`
 * The instruction is ALWAYS routed through redactSecrets (never leak a credential into the spoken
 * digest); the durable command stays RAW (add() persists the unredacted instruction so an approved
 * write replays verbatim) — we redact only at render time. Missing `rationale` degrades gracefully:
 * the "you said:" clause is simply omitted (no dangling label). `capability` defaults to
 * "write_to_pane" to mirror the gate's back-compat default.
 */
export function renderResumptionLine(record: PendingApproval, now: number): string {
  const capability = record.capability ?? "write_to_pane";
  // Redact FIRST, then shorten. If we truncated first, a secret straddling the 80-char cut would be
  // sliced mid-token and no longer match the anchored, fixed-length redaction regexes (e.g. AKIA needs
  // the full 20 chars), leaking a partial credential into the spoken digest (spec §5). Redacting first
  // replaces the full secret with a short [REDACTED:…] marker, so a later truncation can only ever cut
  // the marker — never expose raw key bytes.
  const instruction = shortInstruction(redactSecrets(record.instruction));
  const said = record.rationale?.trigger?.trim();
  const saidClause = said ? ` (you said: ${said})` : "";
  const age = humanizeAge(Math.max(0, now - record.timestamp));
  return `${capability} → ${record.terminalId}: "${instruction}"${saidClause} — ${age}`;
}

/**
 * The store: the serializable Record + the non-serializable session side-map + an ordered
 * index for ordinal targeting + `lastAnnouncedApprovalId`. One place to route every
 * session-equality check (the design's "don't scatter session-equality checks").
 */
export class PendingApprovalStore {
  private records: Record<string, PendingApproval> = {};
  /** NON-serializable live handles, separated for WS-F (persist record, re-attach session). */
  private sessions: Record<string, any> = {};
  /** Insertion/announced order of messageIds (serializable; drives ordinal targeting). */
  private order: string[] = [];
  /** Per-session most-recently-announced id (keyed by the live session handle). */
  private lastAnnounced = new Map<any, string>();

  // ── WS-M durability wiring ──────────────────────────────────────────────────
  // The optional JanusStore is the DURABILITY layer (survives a process reopen). The
  // in-memory maps above remain the live, O(1), same-shape working set within a running
  // process; the store is the source of truth ONLY across a reopen. Every mutating method
  // dual-writes (store + in-memory mirror) so the live call sites never change shape and the
  // N-1 claim gate is enforced by the durable atomic SQL when a store is present.
  //
  // When `store === null` (a hand-built test harness — dbt3 removed the only production cause,
  // a store-init failure, which is now a fatal boot error) every method takes the EXACT original
  // in-memory path — byte-for-byte preserved.
  private readonly store: ApprovalDurableStore | null;
  /**
   * The live WS `session` handle is NOT serializable and churns per turn; durable rows need a
   * stable string session_id. We mint one lazily per handle and keep a bidirectional map. The
   * WeakMap (handle->sid) is GC-safe; the reverse Map (sid->handle) holds a strong ref that is
   * cleared on purgeSession so dead handles don't leak.
   */
  private handleToSid = new WeakMap<object, string>();
  private sidToHandle = new Map<string, any>();
  /** Per-messageId durable session_id, so delete/claim/purge can address durable rows. */
  private sidForId: Record<string, string> = {};
  /**
   * Per-messageId durable `workspace_id`, captured at add()/hydrate so reattachSession can rewrite
   * the durable row faithfully (the in-memory PendingApproval has no workspace column). Not read by
   * any resolve path; purely to keep the rewritten row byte-faithful to the original.
   */
  private workspaceForId: Record<string, string> = {};
  private sidSeq = 0;

  constructor(store: JanusStore | ApprovalDurableStore | null = null) {
    this.store = (store as ApprovalDurableStore) ?? null;
    if (this.store) this.hydrateFromStore();
  }

  /**
   * On construct with a durable store, repopulate the in-memory working set from any unclaimed
   * survivors so the synchronous call sites (has/all/get) see them immediately after a cold
   * reopen — BEFORE any live session reconnects. Survivors have no live handle yet (re-attach is
   * WS-F), so they go in with `session === undefined`; forSession(liveHandle) naturally returns
   * [] for a fresh handle, which is correct. Ordered by durable timestamp (== insertion order).
   */
  private hydrateFromStore(): void {
    if (!this.store) return;
    const rows = this.store.getExpiredApprovals(Number.MAX_SAFE_INTEGER); // claimed=0, all rows, ASC by expiry
    for (const row of rows) {
      const rec = hydrateApproval(row);
      if (this.records[rec.messageId]) continue;
      this.records[rec.messageId] = rec;
      this.sessions[rec.messageId] = undefined; // no live handle until WS-F re-attach
      this.order.push(rec.messageId);
      this.sidForId[rec.messageId] = row.session_id;
      this.workspaceForId[rec.messageId] = row.workspace_id;
      this.sidToHandle.set(row.session_id, undefined);
    }
  }

  /** Translate a live handle to a stable durable session_id, minting on first use. */
  private sidFor(session: any): string {
    if (session && typeof session === "object") {
      const existing = this.handleToSid.get(session);
      if (existing) return existing;
      const sid = `sess_${++this.sidSeq}_${Date.now()}`;
      this.handleToSid.set(session, sid);
      this.sidToHandle.set(sid, session);
      return sid;
    }
    // Non-object handles (e.g. {} or undefined in tests) can't key a WeakMap; fall back to a
    // synthetic sid keyed off identity via the reverse map only. These are not durable-critical
    // (tests with `{}` handles), so a fresh sid per add is acceptable.
    const sid = `sess_${++this.sidSeq}_${Date.now()}`;
    this.sidToHandle.set(sid, session);
    return sid;
  }

  add(record: PendingApproval, session: any, meta: AddApprovalMeta = {}): void {
    // In-memory mirror (identical to legacy) — always maintained so live call sites stay O(1).
    this.records[record.messageId] = record;
    this.sessions[record.messageId] = session;
    this.order.push(record.messageId);
    this.lastAnnounced.set(session, record.messageId);

    if (!this.store) return; // legacy path: nothing else to do.

    const sid = this.sidFor(session);
    this.sidForId[record.messageId] = sid;
    const workspaceId = meta.workspaceId ?? "default_project";
    this.workspaceForId[record.messageId] = workspaceId;
    const ttlMs = meta.ttlMs ?? APPROVAL_DEFAULT_TTL_MS;
    this.store.insertPendingApproval({
      id: record.messageId,
      session_id: sid,
      workspace_id: workspaceId,
      pane_id: record.terminalId,
      command: record.instruction, // RAW (not redacted) — the approved write replays verbatim.
      kind: record.kind,
      rationale: record.rationale ? JSON.stringify(record.rationale) : null,
      claimed: record.claimed ?? false,
      timestamp: record.timestamp,
      expires_at: record.timestamp + ttlMs,
      exchange_id: record.exchangeId ?? null,
    });
  }

  get(messageId: string): PendingApproval | undefined {
    return this.records[messageId];
  }

  /**
   * AgentExchange spine correlation (spec §5, flag JANUS_EXCHANGE_SPINE): bind an `exchangeId`
   * onto an ALREADY-ADDED pending-approval record. The caller only learns the pendingId once
   * `gateOrDefer`/`applyDispatchDecision` returns it, so this is a post-add correlation step, not
   * part of `add()` itself. In-memory ONLY — the durable row's `exchange_id` column is populated
   * at add()-time when the caller already knows the exchange (an add() carrying `record.exchangeId`
   * set); rewriting the durable row here would require reconstructing (and risk perturbing) its
   * anchored `expires_at`, so a late bind is a best-effort, in-process-only correlation. No-op if
   * the record no longer exists (already resolved/expired) — never throws.
   */
  bindExchange(messageId: string, exchangeId: string): void {
    const rec = this.records[messageId];
    if (rec) rec.exchangeId = exchangeId;
  }

  sessionFor(messageId: string): any {
    return this.sessions[messageId];
  }

  /**
   * BUG-017: the add()-time workspace scope for a pending, or undefined for an unknown id. Reads the
   * existing `workspaceForId` map — no new state.
   *
   * ENFORCEMENT DEPENDENCY: `workspaceForId` is populated ONLY when a durable JanusStore is present
   * (add() populates it iff `this.store` is set; hydrateFromStore repopulates it for cold survivors).
   * A scopeless in-memory store returns undefined here, which correctly DISABLES cross-workspace
   * enforcement in the REST approve/list handlers (a pending whose workspace is unknown is foreign to
   * nobody). So the REST scoping built on this accessor is live only on a real durable server boot.
   */
  workspaceFor(messageId: string): string | undefined {
    return this.workspaceForId[messageId];
  }

  has(messageId: string): boolean {
    return messageId in this.records;
  }

  delete(messageId: string): void {
    if (this.store) this.store.deletePendingApproval(messageId);
    const sid = this.sidForId[messageId];
    delete this.records[messageId];
    delete this.sessions[messageId];
    delete this.sidForId[messageId];
    delete this.workspaceForId[messageId];
    this.order = this.order.filter((id) => id !== messageId);
    // wsm-e2e-pinned-4s2 (5): a hydrated/detached orphan's sid was registered in sidToHandle
    // (hydrateFromStore / sidFor) but has no live handle to be reclaimed via purgeSession's
    // handleToSid walk. Once the LAST record referencing this sid is gone, drop it here too —
    // otherwise every fully-resolved hydrated survivor leaks one sidToHandle entry forever.
    if (sid && !Object.values(this.sidForId).includes(sid)) {
      this.sidToHandle.delete(sid);
    }
  }

  /**
   * Entries for a session, in ANNOUNCED order (oldest first).
   *
   * wsm-e2e-pinned-4s2 (5): `undefined` is a DELIBERATE alias for orphans() (see reattachSession's
   * doc — `sessions[id] === undefined` is exactly what a hydrated/detached survivor looks like), so
   * forSession(undefined) intentionally returns the orphan set and must NOT be short-circuited here.
   * `null` is a DIFFERENT, non-orphan sentinel — server.ts's REST ActionContext stamps `session:
   * null` for the no-live-session surface — and `sessions[id]` is never literally `null`, so the
   * filter below already returns [] for it. The explicit guard just makes that "REST calls never
   * see the orphan bucket" invariant load-bearing/obvious rather than an accident of `===` typing.
   */
  forSession(session: any): PendingApproval[] {
    if (session === null) return [];
    return this.order
      .filter((id) => this.sessions[id] === session)
      .map((id) => this.records[id]);
  }

  /** All entries (REST view), in order. */
  all(): PendingApproval[] {
    return this.order.map((id) => this.records[id]);
  }

  setLastAnnounced(session: any, messageId: string): void {
    this.lastAnnounced.set(session, messageId);
  }

  lastAnnouncedFor(session: any): string | null {
    return this.lastAnnounced.get(session) ?? null;
  }

  /**
   * The MANDATORY N-1 atomic claim. With a durable store the winner is selected by the atomic SQL
   * `claimApproval` (UPDATE ... WHERE claimed=0 => exactly one caller sees changes===1) so the
   * single-writer gate survives a reopen (a claimed-but-undeleted survivor stays claimed=1 and
   * cannot be re-claimed). Without a store it is the original in-memory flip. The in-memory
   * `rec.claimed` mirror is kept in sync so a same-process second resolve short-circuits and
   * `expired()`'s `!claimed` filter still holds.
   */
  claim(messageId: string): boolean {
    if (this.store) {
      const won = this.store.claimApproval(messageId);
      if (won) {
        const rec = this.records[messageId];
        if (rec) rec.claimed = true; // mirror for in-process short-circuits / expired() filter
      }
      return won;
    }
    const rec = this.records[messageId];
    if (!rec || rec.claimed) return false;
    rec.claimed = true;
    return true;
  }

  /**
   * Per-pane DRAIN (multi-cli adapter spec §11): on a pane's promotion to Full Auto its staged
   * approvals become moot (the live agent now self-approves), so every approval bound to that pane
   * is removed and the drained records are returned for the caller to broadcast `approval_resolved`
   * on. This is a hard removal (NOT a claim/resolve through resolveDecision): a promotion is not an
   * approve/reject, it makes the held write irrelevant — the agent will run unattended. Targets by
   * `terminalId`, the same field forSession/all() carry, so a different pane's pending is untouched.
   * Returns the records in `order` (oldest first) for deterministic broadcast.
   */
  drainForPane(paneId: string): PendingApproval[] {
    const drained = this.order
      .filter((id) => this.records[id]?.terminalId === paneId)
      .map((id) => this.records[id]);
    for (const rec of drained) this.delete(rec.messageId); // delete() removes the durable row too
    return drained;
  }

  /** Purge every entry for a closed session. (WS-F TODO: persist + re-announce, not purge.) */
  purgeSession(session: any): string[] {
    const purged = this.order.filter((id) => this.sessions[id] === session);
    for (const id of purged) this.delete(id); // delete() handles durable row removal too
    this.lastAnnounced.delete(session);
    // Drop the handle<->sid mapping for this closed handle so dead handles don't leak.
    if (session && typeof session === "object") {
      const sid = this.handleToSid.get(session);
      if (sid) { this.sidToHandle.delete(sid); this.handleToSid.delete(session); }
    }
    return purged;
  }

  /**
   * WS-F disconnect seam (spec §6.1): DETACH a closed session WITHOUT discarding its staged work.
   * For every record bound to `session`, NULL the live handle in the side-map (`sessions[id] =
   * undefined`) and clear `lastAnnounced` for the dead handle — but KEEP the record, its `order`
   * entry, AND the durable row. The result is byte-for-byte the shape the restart-hydrate path
   * already produces (`session === undefined`): an ORPHAN that `forSession(undefined)` enumerates
   * and a fresh live handle can re-attach to on reconnect.
   *
   * This is a SIBLING of purgeSession, not a rename: purgeSession still hard-deletes (retained for
   * callers that need true purge); only the disconnect handler switches to detachSession. We do NOT
   * touch the durable row (the whole point — the survivor must outlive the disconnect, and durably
   * outlive a process restart). The handle<->sid mapping IS dropped (the live handle is dead and
   * GC-eligible); the per-id durable sid stays on `sidForId` so the row remains addressable, and
   * the reverse map is rebound to `undefined` so a later re-attach can mint a fresh handle->sid.
   *
   * Legacy path (`store === null`): identical in-memory behavior, nothing durable to keep.
   */
  detachSession(session: any): string[] {
    const detached = this.order.filter((id) => this.sessions[id] === session);
    for (const id of detached) {
      this.sessions[id] = undefined; // NULL the live handle; record + order + durable row stay.
      if (this.sidForId[id]) this.sidToHandle.set(this.sidForId[id], undefined);
    }
    this.lastAnnounced.delete(session);
    // Drop the dead live handle<->sid binding so the closed handle can't leak (mirror purgeSession),
    // but DO NOT delete sidForId entries — the durable rows stay addressable for re-attach/sweep.
    if (session && typeof session === "object") {
      const sid = this.handleToSid.get(session);
      if (sid) { this.handleToSid.delete(session); }
    }
    return detached;
  }

  /**
   * The orphan survivors — records with no live session handle (`sessions[id] === undefined`), in
   * `order`. These are exactly what detachSession produces on disconnect and what hydrateFromStore
   * produces after a cold reopen. The reconnect path (`reannounceSurvivors`) enumerates these to
   * re-bind them to the freshly-connected session. (forSession(undefined) returns the same set; this
   * is the named, intention-revealing accessor for the resumption-digest call site.)
   */
  orphans(): PendingApproval[] {
    return this.order
      .filter((id) => this.sessions[id] === undefined)
      .map((id) => this.records[id]);
  }

  /**
   * WS-F reconnect seam (spec §6.2): RE-ATTACH one orphan record (an item with no live handle —
   * `sessions[id] === undefined`, produced by detachSession or restart-hydrate) to the freshly-
   * connected live `session`, opening a FRESH TTL window. This is the mirror of detachSession:
   * detach NULLs the handle and pauses the clock; reattach binds a new handle and restarts it.
   *
   * Steps:
   *   1. Bind the live handle: `sessions[id] = session`.
   *   2. Mint/rebind a stable durable sid for the new handle (existing `sidFor`) and record it on
   *      `sidForId[id]` so delete/claim/the durable rewrite address the SAME row under the NEW sid.
   *   3. Clear the transient `lastCallAt` (a fresh window earns a fresh last-call if it goes idle).
   *   4. With a durable store, REWRITE the row (INSERT OR REPLACE, keyed by the unchanged `id`) under
   *      the new session_id with `expires_at = nowExpiresAt` — so the re-attached item is NOT seen as
   *      expired until the fresh TTL elapses while connected, and delete/claim still hit the right row.
   *
   * CRITICAL (spec §9 HIGH COLLISION): the rewrite MUST carry the existing `claimed` value through.
   * An orphan is normally unclaimed (claimed survivors were deleted on resolve), but if a claimed-but-
   * undeleted survivor is ever re-attached, resetting claimed→0 would make it re-claimable (double
   * write). We read `rec.claimed` (the in-memory mirror kept in lockstep by claim()) into the row.
   *
   * Legacy path (`store === null`): steps 1–3 only — there is no durable row to rewrite. The
   * in-process re-attach + fresh in-memory window still function (the sweep's TTL is measured off the
   * in-memory `timestamp`, which is unchanged here; the durable expires_at narrowing is a no-op).
   *
   * No-op if `orphan` is not actually an orphan (its handle is already bound) — guards against a
   * double re-attach binding a live record to a second session.
   */
  reattachSession(orphan: PendingApproval, session: any, nowExpiresAt: number): void {
    const id = orphan.messageId;
    const rec = this.records[id];
    if (!rec) return;                                  // gone (resolved between detach and reconnect)
    if (this.sessions[id] !== undefined) return;       // not an orphan — already bound; never re-stomp

    // (1) Bind the new live handle.
    this.sessions[id] = session;
    // (3) Clear the last-call transients — re-attach opens a fresh window (3V.3: the narration
    // failure counter resets with it; the new session is a fresh channel).
    rec.lastCallAt = undefined;
    rec.lastCallFailures = undefined;

    if (!this.store) return;                           // legacy: nothing durable to rewrite.

    // (2) Mint/rebind the durable sid for the new live handle and address the row under it.
    const newSid = this.sidFor(session);
    this.sidForId[id] = newSid;
    // (4) Rewrite the durable row (INSERT OR REPLACE on the unchanged id) under the new session_id
    // with the fresh expires_at — carrying the EXISTING claimed through (never re-open a claimed row).
    this.store.insertPendingApproval({
      id,
      session_id: newSid,
      workspace_id: this.workspaceForId[id] ?? "default_project",
      pane_id: rec.terminalId,
      command: rec.instruction, // RAW — the approved write still replays verbatim (never redacted).
      kind: rec.kind,
      rationale: rec.rationale ? JSON.stringify(rec.rationale) : null,
      claimed: rec.claimed ?? false, // carry claimed through (spec §9 N-1 exactly-once guard).
      timestamp: rec.timestamp,
      expires_at: nowExpiresAt,
      exchange_id: rec.exchangeId ?? null, // carry the exchange correlation through re-attach too.
    });
  }

  /**
   * Entries older than `ttlMs` (for the TTL auto-reject sweep). With a durable store the sweep
   * reads DURABLE expiry (getExpiredApprovals, which filters claimed=0 AND expires_at<now) so a
   * survivor that crossed its TTL while the process was down is swept on the first post-reopen
   * tick. Rows are hydrated and the in-memory mirror is reconciled so the returned records are the
   * same objects the resolver will claim+delete. Without a store it is the original in-memory
   * filter (`now - timestamp > ttlMs && !claimed`).
   *
   * wsm-e2e-pinned-4s2 (4): note the durable branch below never reads `ttlMs` — it trusts the
   * `expires_at` column, which was ANCHORED once at add()/reattachSession() time (`expires_at =
   * timestamp + ttlMs` at that moment). The legacy (no-store) branch above has no persisted
   * expires_at, so it re-derives the same comparison live from the CURRENT ttlMs argument every
   * call. The two are equivalent as long as callers pass the same ttlMs they anchored with — a
   * caller that started passing a DIFFERENT ttlMs mid-flight would only affect the legacy branch
   * (durable rows are locked to their add-time TTL). This is intentional, not a bug: it's what
   * makes a durable row's expiry survive a reopen without re-reading server config.
   */
  expired(ttlMs: number, now: number = Date.now()): PendingApproval[] {
    if (!this.store) {
      return this.all().filter((p) => now - p.timestamp > ttlMs && !p.claimed);
    }
    const out: PendingApproval[] = [];
    for (const row of this.store.getExpiredApprovals(now)) {
      let rec = this.records[row.id];
      if (!rec) {
        // A survivor not yet in the in-memory mirror (e.g. hydrated lazily): fold it in so the
        // resolver can claim/delete it through the normal in-process path.
        rec = hydrateApproval(row);
        this.records[rec.messageId] = rec;
        this.sessions[rec.messageId] = this.sidToHandle.get(row.session_id);
        this.sidForId[rec.messageId] = row.session_id;
        if (!this.order.includes(rec.messageId)) this.order.push(rec.messageId);
      }
      out.push(rec);
    }
    return out;
  }
}

/** Hydrate a durable row back into the in-memory PendingApproval shape (inverse of add()'s map). */
function hydrateApproval(row: StoredPendingApproval): PendingApproval {
  let rationale: { trigger: string; summary: string } | undefined;
  if (row.rationale) {
    try {
      const parsed = JSON.parse(row.rationale);
      if (parsed && typeof parsed === "object") rationale = parsed;
    } catch { /* corrupt rationale -> undefined (non-load-bearing for resolve) */ }
  }
  return {
    messageId: row.id,
    instruction: row.command,
    kind: row.kind,
    terminalId: row.pane_id,
    // callId is a live functionCall id consumed once at proposal time; on reopen there is no live
    // call to answer (re-attach is WS-F) and resolveDecision never reads it — so it is dropped.
    callId: row.id,
    rationale,
    timestamp: row.timestamp,
    claimed: row.claimed,
    // capability has no column (option A): survivors default it; not read by any resolve path.
    capability: "write_to_pane",
    exchangeId: row.exchange_id ?? undefined,
  };
}
