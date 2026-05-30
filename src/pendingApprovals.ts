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
}

/**
 * The single, pure gate decision. Both `kind`s pass through the SAME effective-mode gate;
 * `kind` does NOT bypass permissions. The allowlist check is IN ADDITION to the mode gate.
 */
export function decideProposal(input: DecideProposalInput): ProposalDecision {
  const { kind, instruction, effectiveMode, runtimeType, paneExists, allowlist } = input;

  if (!paneExists) return { type: "error_no_pane" };

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

  if (effectiveMode === "Read-Only") return { type: "blocked_read_only" };
  if (effectiveMode === "Full Auto") return { type: "auto_execute" };
  return { type: "pending_approval" };
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
