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
  /** The capability this approval rides (design §3). Defaults to "write_to_pane". */
  capability?: string;
}

/**
 * A small, read-only / observe-only first-token allowlist for `kind:"shell"`. Anything not
 * here is NOT executed and NOT dead-ended — it routes to a non-blocking clarify (the model
 * should hand heavy lifting to an agent pane via `kind:"agent_instruction"`).
 * Operator-overridable via `JANUS_SHELL_ALLOWLIST` (comma-separated env).
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
 * The single, pure gate decision. Both `kind`s pass through the SAME effective-mode gate;
 * `kind` does NOT bypass permissions. The allowlist check is IN ADDITION to the mode gate.
 */
export function decideProposal(input: DecideProposalInput): ProposalDecision {
  const { kind, instruction, effectiveMode, runtimeType, paneExists, allowlist } = input;
  const capability = input.capability ?? "write_to_pane";
  const gate: GateValue = input.gate ?? "Auto";

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

  add(record: PendingApproval, session: any): void {
    this.records[record.messageId] = record;
    this.sessions[record.messageId] = session;
    this.order.push(record.messageId);
    this.lastAnnounced.set(session, record.messageId);
  }

  get(messageId: string): PendingApproval | undefined {
    return this.records[messageId];
  }

  sessionFor(messageId: string): any {
    return this.sessions[messageId];
  }

  has(messageId: string): boolean {
    return messageId in this.records;
  }

  delete(messageId: string): void {
    delete this.records[messageId];
    delete this.sessions[messageId];
    this.order = this.order.filter((id) => id !== messageId);
  }

  /** Entries for a session, in ANNOUNCED order (oldest first). */
  forSession(session: any): PendingApproval[] {
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

  /** WS-F seam: atomic claim. Returns true if THIS caller won the claim. */
  claim(messageId: string): boolean {
    const rec = this.records[messageId];
    if (!rec || rec.claimed) return false;
    rec.claimed = true;
    return true;
  }

  /** Purge every entry for a closed session. (WS-F TODO: persist + re-announce, not purge.) */
  purgeSession(session: any): string[] {
    const purged = this.order.filter((id) => this.sessions[id] === session);
    for (const id of purged) this.delete(id);
    this.lastAnnounced.delete(session);
    return purged;
  }

  /** Entries older than `ttlMs` (for the TTL auto-reject sweep). */
  expired(ttlMs: number, now: number = Date.now()): PendingApproval[] {
    return this.all().filter((p) => now - p.timestamp > ttlMs && !p.claimed);
  }
}
