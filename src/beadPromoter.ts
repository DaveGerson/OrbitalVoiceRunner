/**
 * src/beadPromoter.ts — the CONSTRAINED note→bead promoter (hwu.4).
 *
 * The live Gemini tool-call path (src/actions/defs/promote.ts) NEVER files a bead and NEVER shells a
 * process — it only stages a durable PROPOSAL. This module is the separate, server-side step that,
 * ON OPERATOR APPROVAL, composes the bead from the persisted note and shells `bd create`. It is the
 * one and only place a `bd`-write can originate, and it does so through an INJECTABLE exec seam so
 * every test drives it with a mock (no live `bd`, no child process in unit tests).
 *
 * Two responsibilities, cleanly split:
 *   1. composeBead() — PURE, deterministic mapping note → { title, issueType, priority, description }.
 *      This is the "decision-shaped" bit the seam note flags for a future Python-layer upgrade; v1 is
 *      a deterministic TS mapper (no LLM, no I/O).
 *   2. applyApprovedBead() — the I/O shell: run the composed bead through the exec seam. Called ONLY
 *      from a pending-action confirm (operator approval), never from the live tool call.
 *
 * SECURITY: the note text handed to composeBead() is ALREADY redactSecrets-applied by the caller
 * (promote.ts redacts the raw draft before persistence + composition), so neither the bead title nor
 * its description can carry a spoken credential. The default exec additionally redacts any error text
 * before it is surfaced/logged.
 */

import { execFileSync } from "node:child_process";
import { redactSecrets } from "./terminal";
import type { NoteType, BeadStatus } from "./store/types";

/** The bd issue types this deterministic mapper emits (a safe subset of the bd taxonomy). */
export type BeadIssueType = "task" | "feature" | "bug" | "chore";

/** The narrow, serializable contract composeBead produces (spec: note → {title, type, priority, description}). */
export interface ComposedBead {
  title: string;
  issueType: BeadIssueType;
  /** bd priority integer: 0 (highest) … 3 (lowest). Lower = more urgent. */
  priority: number;
  description: string;
}

/** Result of shelling `bd create` (or its mock). `id` is best-effort parsed from stdout. */
export interface BeadExecResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/**
 * The INJECTABLE exec seam. Synchronous by contract so a pending-action `run(): string` closure can
 * call it inline. Tests replace it via setBeadExec(); production uses defaultBeadExec (real `bd`).
 */
export type BeadExec = (composed: ComposedBead) => BeadExecResult;

// ── Deterministic note-type → bead-shape mapping (pure lookup tables, no branching) ────────────────
const TYPE_TO_ISSUE: Record<NoteType, BeadIssueType> = {
  todo: "task",
  warning: "bug",
  decision: "chore",
  handoff: "task",
  note: "task",
};
const TYPE_TO_PRIORITY: Record<NoteType, number> = {
  warning: 1, // flagged risk → high
  decision: 2,
  todo: 2,
  handoff: 2,
  note: 3, // plain capture → lowest
};

const TITLE_MAX = 72;

/** First non-empty line of `text`, whitespace-collapsed and capped to TITLE_MAX with an ellipsis. */
function deriveTitle(text: string): string {
  const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const oneLine = firstLine.replace(/\s+/g, " ").trim();
  if (!oneLine) return "Draft note";
  return oneLine.length > TITLE_MAX ? `${oneLine.slice(0, TITLE_MAX - 1).trimEnd()}…` : oneLine;
}

/**
 * PURE, deterministic note → bead composer (v1). The description carries the FULL note text
 * UNTRUNCATED (only the title is shortened — bd titles are one-liners), plus a provenance footer so a
 * reader knows the bead came from a promoted dictation note. Same input ⇒ same output, always.
 */
export function composeBead(note: { text: string; type: NoteType }): ComposedBead {
  const text = note.text ?? "";
  return {
    title: deriveTitle(text),
    issueType: TYPE_TO_ISSUE[note.type] ?? "task",
    priority: TYPE_TO_PRIORITY[note.type] ?? 3,
    description: `${text}\n\n---\nPromoted from a dictation ${note.type} note.`,
  };
}

/** Best-effort parse of a created bead id from `bd create` stdout (last non-empty whitespace token). */
function parseBeadId(stdout: string): string | undefined {
  const m = stdout.match(/([a-z][a-z0-9]*(?:-[a-z0-9]+)+|[a-z]+-?\d+)/i);
  return m ? m[1] : undefined;
}

/**
 * The DEFAULT production exec seam: shell `bd create` with the composed fields. Synchronous
 * (execFileSync) so the confirm closure stays `() => string`. NEVER invoked by the live Gemini path —
 * only from a pending-action confirm (operator approval). Errors are redacted before they escape.
 */
export const defaultBeadExec: BeadExec = (composed) => {
  try {
    const out = execFileSync(
      "bd",
      ["create", composed.title, "-t", composed.issueType, "-p", String(composed.priority), "-d", composed.description],
      { encoding: "utf8", timeout: 15_000 },
    );
    return { ok: true, id: parseBeadId(out) };
  } catch (e) {
    return { ok: false, error: redactSecrets(e instanceof Error ? e.message : String(e)) };
  }
};

// ── Injectable seam plumbing (mirrors setLiveConnector / setSessionAiFactory) ──────────────────────
let currentExec: BeadExec = defaultBeadExec;

/** Override the exec seam (tests). Pass null to restore the production default. */
export function setBeadExec(fn: BeadExec | null): void {
  currentExec = fn ?? defaultBeadExec;
}

/** The exec seam a confirm closure should use — the current override, else the production default. */
export function resolveBeadExec(): BeadExec {
  return currentExec;
}

/**
 * Apply an operator-APPROVED bead: run the composed bead through the exec seam exactly once. This is
 * the ONLY function that reaches `bd create`, and it is unreachable from the live tool call (it runs
 * only inside a pending-action confirm). `exec` defaults to the current seam so callers can inject a
 * mock without threading it through every layer.
 */
export function applyApprovedBead(composed: ComposedBead, exec: BeadExec = currentExec): BeadExecResult {
  return exec(composed);
}

/**
 * Structural view of the note store the promoter needs — just the marker writer. Kept narrow (not the
 * whole ledger) so the promoter never couples to the full LedgerLike surface. The live JanusStore
 * satisfies it via setNoteBeadStatus.
 */
export interface NoteMarkerStore {
  setNoteBeadStatus(id: string, status: BeadStatus | null): void;
}

/** Mark a note's promotion state, tolerating a store/test-double that lacks the method (no-op). */
export function markNoteStatus(store: unknown, noteId: string, status: BeadStatus): void {
  const s = store as Partial<NoteMarkerStore> | null | undefined;
  if (s && typeof s.setNoteBeadStatus === "function") s.setNoteBeadStatus(noteId, status);
}

/**
 * Operator DENY of a bead proposal: mark the source note 'denied' so the discard is durable and any
 * future promotion must be an EXPLICIT new proposal (never automatic). Runs no exec, files nothing.
 * The integrator wires this into the pending-action cancel path for a bead proposal (see promote.ts).
 */
export function denyBeadProposal(store: unknown, noteId: string): void {
  markNoteStatus(store, noteId, "denied");
}
