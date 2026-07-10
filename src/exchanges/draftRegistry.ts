// src/exchanges/draftRegistry.ts — the per-pane instruction-draft registry + anaphora
// recent-referent register (Phase 3, Step 3.2/3.3; spec
// docs/superpowers/specs/2026-07-09-instruction-routing.md §3.2, §5.2).
//
// Process-global, in-memory, best-effort — mirrors src/voice/recentTurns.ts's posture (a small,
// bounded singleton the voice layer pushes to / reads from once per turn, never a store). Two
// small pieces of state neither `EnvelopeDraft` (pure data, src/exchanges/instructionEnvelope.ts)
// nor `ExchangeService` (the durable lifecycle) own:
//
//   1. "which EnvelopeDraft is the open one for THIS pane right now" — spec §5.2: a pane's WIP
//      draft is backed by AT MOST ONE open exchange; a new envelope utterance for a pane with an
//      open draft REVISES it, never creates a sibling.
//   2. "prose-override" — spec §5.2: once the operator hand-edits the rendered prose directly
//      (typed draft_edit), the envelope enters prose-authoritative mode so a subsequent re-render
//      never clobbers their edit; a voice field revision clears the override.
//   3. the anaphora recent-referent register (spec §3.2): the last successfully bound instruction
//      target, TTL-bounded, following the recentTurns idiom (pushed once per resolved target,
//      never per frame). The target resolver only RECEIVES this as input — this module is where
//      it is maintained.

import { assessReadiness, type EnvelopeDraft, type ReadinessResult } from "./instructionEnvelope";

function keyFor(projectId: string, paneId: string): string {
  return `${projectId}::${paneId}`;
}

// ── one open draft per pane ─────────────────────────────────────────────────────────────────────

const openDrafts = new Map<string, EnvelopeDraft>();

export function getOpenDraft(projectId: string, paneId: string): EnvelopeDraft | undefined {
  return openDrafts.get(keyFor(projectId, paneId));
}

export function setOpenDraft(projectId: string, paneId: string, draft: EnvelopeDraft): void {
  openDrafts.set(keyFor(projectId, paneId), draft);
}

export function clearOpenDraft(projectId: string, paneId: string): void {
  openDrafts.delete(keyFor(projectId, paneId));
}

// ── outstanding-approval binding (spec §4/§5.3 — the draft-version CAS, Phase 3 step 3.5) ───────
//
// When send_instruction's dispatch parks as a PENDING APPROVAL (gate=Ask), the draft stays OPEN
// (the operator may still revise the in-flight instruction) and the approval record is BOUND here
// to the exact draft version it was staged from. The binding is the envelope layer's twin of the
// exchange spine's (approvalId, approval_draft_version) pair (src/exchanges/lifecycle.ts
// requestApproval/confirmApproval): any version bump (voice revise, typed edit, retarget) MUST
// invalidate the outstanding approval (invalidateOutstandingApproval below), and the resolve
// choke-point (src/gating/index.ts applyResolution) CAS-checks the binding before an approve can
// deliver — a stale approval can never deliver old text.

export interface DraftApprovalBinding {
  /** The pending-approval record's messageId (the pendingApprovals store key). */
  messageId: string;
  /** The exact draftVersion the approval was staged from. */
  draftVersion: number;
}

const approvalBindings = new Map<string, DraftApprovalBinding>();

export function bindApprovalToDraft(projectId: string, paneId: string, binding: DraftApprovalBinding): void {
  approvalBindings.set(keyFor(projectId, paneId), binding);
}

export function getApprovalBinding(projectId: string, paneId: string): DraftApprovalBinding | undefined {
  return approvalBindings.get(keyFor(projectId, paneId));
}

export function clearApprovalBinding(projectId: string, paneId: string): void {
  approvalBindings.delete(keyFor(projectId, paneId));
}

/** Reverse lookup for the resolve choke-point: which pane's draft is bound to this approval? */
export function findApprovalBindingByMessageId(
  messageId: string,
): { projectId: string; paneId: string; binding: DraftApprovalBinding } | undefined {
  for (const [key, binding] of approvalBindings) {
    if (binding.messageId === messageId) {
      const sep = key.indexOf("::");
      return { projectId: key.slice(0, sep), paneId: key.slice(sep + 2), binding };
    }
  }
  return undefined;
}

/**
 * Invalidate the outstanding pending approval bound to this pane's draft, if any — the envelope
 * twin of the exchange spine's revise-invalidates-approval rule (spec §4 "the old approval can
 * never fire against new text"; lifecycle.ts reviseDraft clears approvalId/approvalDraftVersion).
 * Called by EVERY draft-version-bumping path (voice revise/retarget, typed WS draft_edit, typed
 * REST PUT) and by the operator-direct Workbench send (which supersedes a staged approval).
 * `applyResolution` is the caller's injected resolve choke-point (src/gating applyResolution) —
 * resolving as "reject" claims + deletes the record through the one authoritative path, so the
 * stale approval broadcasts a normal cancellation and can never deliver. Best-effort: a throw
 * from the resolver must never break the draft edit itself.
 */
export function invalidateOutstandingApproval(
  projectId: string,
  paneId: string,
  applyResolution: (messageId: string, mode: "reject", opts?: { vocal?: boolean }) => unknown,
): void {
  const binding = approvalBindings.get(keyFor(projectId, paneId));
  if (!binding) return;
  approvalBindings.delete(keyFor(projectId, paneId));
  try {
    applyResolution(binding.messageId, "reject");
  } catch (e) {
    console.error("[instruction-envelope] failed to invalidate a stale pending approval:", e);
  }
}

// ── client-facing getter (Phase 3, Step 3.3 — instruction-routing spec §5, UI surfacing) ──────────
//
// A pure, read-only projection of an EnvelopeDraft onto a flat, JSON-serializable shape for the
// draft_updated broadcast frame and the GET /api/panes/:projectId/:paneId/draft response
// (server.ts). Mirrors src/types.ts's client-side ExchangeDraftView structurally (kept as two
// independent declarations, not a shared import, so the client bundle never pulls in this module's
// zod-backed instructionEnvelope dependency — the src/exchanges/** <-> src/orbital/** boundary the
// program's Python/TS-seam posture already draws elsewhere in this repo). No I/O, never throws.
export interface OpenDraftView {
  exchangeId: string;
  target: { projectId: string; paneId: string } | null;
  objective: string;
  relevantContext: string[];
  constraints: string[];
  requestedOutput: string | null;
  completionSignal: string | null;
  draftVersion: number;
  sentVersions: number[];
  /** The draft version currently parked as a PENDING operator approval, or null when none is
   *  outstanding (Phase 3 step 3.5 — lets the UI say "awaiting approval" instead of falsely
   *  claiming "delivered" for a version that has only been STAGED, never written to the pane). */
  pendingApprovalVersion: number | null;
  readiness: ReadinessResult;
}

/** The open draft for this pane, projected for a client, or null when there is none. Callers gate
 *  this on `instructionEnvelopeActive()` themselves (server.ts) so the field is omitted/`null`
 *  byte-for-byte when the flag is off — zero payload shape change for existing clients. */
export function viewOpenDraft(projectId: string, paneId: string): OpenDraftView | null {
  const draft = getOpenDraft(projectId, paneId);
  if (!draft) return null;
  return {
    exchangeId: draft.exchangeId,
    target: draft.target,
    objective: draft.envelope.objective,
    relevantContext: draft.envelope.relevant_context,
    constraints: draft.envelope.constraints,
    requestedOutput: draft.envelope.requested_output,
    completionSignal: draft.envelope.completion_signal,
    draftVersion: draft.draftVersion,
    sentVersions: [...draft.sentVersions],
    pendingApprovalVersion: getApprovalBinding(projectId, paneId)?.draftVersion ?? null,
    readiness: assessReadiness(draft),
  };
}

/** Find the (projectId, paneId, draft) triple currently holding this exchangeId as its open draft,
 *  if any — used to locate the draft a typed `draft_edit` frame should converge onto. */
export function findOpenDraftByExchangeId(
  exchangeId: string,
): { projectId: string; paneId: string; draft: EnvelopeDraft } | undefined {
  for (const [key, draft] of openDrafts) {
    if (draft.exchangeId === exchangeId) {
      const sep = key.indexOf("::");
      return { projectId: key.slice(0, sep), paneId: key.slice(sep + 2), draft };
    }
  }
  return undefined;
}

// ── prose-override (typed hand-edit wins until the next voice field revision) ──────────────────

const proseOverride = new Set<string>();

export function setProseOverride(projectId: string, paneId: string): void {
  proseOverride.add(keyFor(projectId, paneId));
}

export function clearProseOverride(projectId: string, paneId: string): void {
  proseOverride.delete(keyFor(projectId, paneId));
}

export function hasProseOverride(projectId: string, paneId: string): boolean {
  return proseOverride.has(keyFor(projectId, paneId));
}

// ── anaphora recent-referent register (spec §3.2) ───────────────────────────────────────────────

/** Bounded lifetime for the recent-referent register — an instruction target from ten minutes ago
 *  is not "that one" anymore. Mirrors the TTL-bounded language in spec §3.2 without inventing a
 *  new config surface. */
export const RECENT_REFERENT_TTL_MS = 10 * 60 * 1000;

interface RecentReferentEntry {
  paneId: string;
  projectId: string;
  at: number;
}

let recentReferent: RecentReferentEntry | null = null;

/** Record a successfully bound instruction target (call on every `target_resolved`, spec §3.2 —
 *  once per resolution, never per frame). */
export function recordRecentReferent(paneId: string, projectId: string, now: number = Date.now()): void {
  recentReferent = { paneId, projectId, at: now };
}

/** The live recent referent, or null if none was ever recorded or it has aged out of the TTL. */
export function getRecentReferent(now: number = Date.now()): { paneId: string; projectId: string } | null {
  if (!recentReferent) return null;
  if (now - recentReferent.at > RECENT_REFERENT_TTL_MS) return null;
  return { paneId: recentReferent.paneId, projectId: recentReferent.projectId };
}

/** Test-only reset — mirrors the reset seams other process-wide singletons in this codebase
 *  expose (e.g. src/exchanges/spine.ts's resetExchangeServiceForTests). Not used by production. */
export function resetDraftRegistryForTests(): void {
  openDrafts.clear();
  proseOverride.clear();
  approvalBindings.clear();
  recentReferent = null;
}
