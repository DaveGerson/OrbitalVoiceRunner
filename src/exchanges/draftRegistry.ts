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

import {
  assessReadiness,
  instructionEnvelopeIsPrimary,
  reviseDraft,
  type EnvelopeDraft,
  type EnvelopeTarget,
  type InstructionEnvelope,
  type ReadinessResult,
} from "./instructionEnvelope";
import type { JanusStore } from "../store/sqliteStore";

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

/**
 * Shared instruction-envelope convergence bridge (spec docs/superpowers/specs/2026-07-09-
 * instruction-routing.md §5.2), JANUS_EXCHANGE_SPINE=authoritative only: a typed `draft_edit` (the
 * WS frame, src/voice/index.ts, and its REST twin — the PUT /api/panes/:projectId/:paneId/draft
 * route, server.ts) ALSO revises the pane's OPEN envelope draft, if one exists, and marks
 * prose-override so the operator's hand-edited text is never clobbered by a subsequent re-render —
 * a voice field revision (revise_instruction) clears the override. Both surfaces mutate the SAME
 * `EnvelopeDraft` registry above; last writer wins the prose; every write bumps the same
 * `draftVersion`. `applyResolution` is the caller's injected resolve choke-point
 * (src/gating/index.ts) — used to invalidate a pending approval staged from a now-stale draft
 * version. Best-effort and never throws back into the caller's message/route handler — a
 * convergence-bridge failure must never break plain draft editing. This one implementation replaces
 * the two byte-identical copies that used to live in src/voice/index.ts and server.ts.
 */
export function convergeTypedDraftEdit(
  projectId: string,
  paneId: string,
  text: string,
  applyResolution: (messageId: string, mode: "reject", opts?: { vocal?: boolean }) => unknown,
): void {
  if (!instructionEnvelopeIsPrimary()) return;
  try {
    const existing = getOpenDraft(projectId, paneId);
    if (!existing) return;
    // Step 3.5 (BUG-B): the typed edit bumps the draft version — any approval staged from the
    // prior version is invalidated through the resolve choke-point (it must never deliver stale
    // text; spec §4).
    invalidateOutstandingApproval(projectId, paneId, applyResolution);
    // Step 3.5: an emptied draft (the Workbench Cancel/Scrap = PUT/edit with "") CANCELS the open
    // exchange instead of leaving a ghost registry entry.
    if (text.trim().length === 0) {
      clearOpenDraft(projectId, paneId);
      clearProseOverride(projectId, paneId);
      return;
    }
    setOpenDraft(projectId, paneId, reviseDraft(existing, {}));
    setProseOverride(projectId, paneId);
  } catch (e) {
    console.error("[instruction-envelope] draft_edit convergence failed:", e);
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

// ── durable persistence + boot/reconnect rehydration (Phase 4, Step 4.3) ────────────────────────
//
// DESIGN DECISION (documented per the 4.3 brief): `openDrafts`/`approvalBindings` above are
// process-global IN-MEMORY maps — they do not survive a process restart. A BROWSER reconnect
// (the WS socket drops and the client reconnects to the SAME live server process) needs no
// rehydration at all: this Map is untouched by a client disconnect, so GET /api/panes/:p/:id/draft
// already reads live, current state the moment the client reconnects. Only a SERVER restart
// (this process's memory is gone) creates a real gap, and only for a draft that has been SENT AT
// LEAST ONCE: `stampExchangeForDispatch` (src/voice/index.ts) and the Workbench send seam
// (server.ts's `/draft/send` route) are the only two places that mint a durable `agent_exchanges`
// row for an envelope draft, and both stamp `instruction_envelope_json` with the shape below —
// so ANY draft that reached a send attempt (whether it is now `awaiting_approval`, pending
// operator confirmation, or reverted to `draft` by a failed/interrupted delivery) has a durable
// row this module can rebuild an `EnvelopeDraft` from.
//
// ACCEPTED LIMITATION: a draft that was composed (draft_instruction/revise_instruction) but NEVER
// sent has no `agent_exchanges` row at all under today's "mint at send time" architecture, so its
// STRUCTURED envelope (objective/context/constraints split) cannot be reconstructed after a
// restart — only the flattened rendered prose survives, durably, in the ledger's `panes.draft`
// column (already read by GET .../draft independent of this registry). Reconstructing structure
// from that flat prose would itself be a spec §1 anti-fabrication violation (inventing an
// objective/context split the operator never explicitly gave), so this module deliberately does
// NOT attempt it — the honest behavior is "the Workbench shows your last-composed text; voice
// structure resets" for that one case, not a silent fabrication. Moving exchange-minting earlier
// (to compose time) would close this gap but is a larger, riskier change to the existing Phase 3
// compose/revise flow and is out of this step's scope — tracked as a documented follow-up, not
// silently punted.

/** The discriminated JSON shape stamped into `agent_exchanges.instruction_envelope_json` for an
 *  exchange that correlates to an open Workbench/voice envelope draft. The `kind` discriminant
 *  keeps this parse from ever colliding with the OTHER thing that column carries — a dispatch
 *  fan-out's `{ dispatch_group_id }` label (src/dispatch/joinTracker.ts) — or the schema default
 *  `'{}'` for a plain, non-envelope dispatch. */
export interface PersistedDraftEnvelope {
  kind: "envelope_draft";
  envelope: InstructionEnvelope;
  target: EnvelopeTarget;
  draftVersion: number;
}

/** Serialize an open draft's structured envelope for durable persistence (the caller — voice's
 *  `stampExchangeForDispatch`, or server.ts's Workbench send seam — passes the JSON string on to
 *  `ExchangeService.createExchange`'s `instructionEnvelopeJson`). Returns `null` when the draft
 *  has no bound target yet (readiness already requires a target before a real send can happen,
 *  but this helper stays defensive for any future caller). */
export function serializeDraftEnvelope(draft: EnvelopeDraft): string | null {
  if (!draft.target) return null;
  const payload: PersistedDraftEnvelope = {
    kind: "envelope_draft",
    envelope: draft.envelope,
    target: draft.target,
    draftVersion: draft.draftVersion,
  };
  return JSON.stringify(payload);
}

/** Parse a durable `instruction_envelope_json` value back into the persisted-draft shape, or
 *  `null` for anything that isn't it (the default `'{}'`, a dispatch-group label, corrupt JSON).
 *  Never throws. */
export function parsePersistedDraftEnvelope(json: string): PersistedDraftEnvelope | null {
  try {
    const parsed = JSON.parse(json);
    if (parsed && parsed.kind === "envelope_draft" && parsed.envelope && parsed.target) {
      return parsed as PersistedDraftEnvelope;
    }
  } catch {
    /* not our shape / corrupt — fall through to null */
  }
  return null;
}

/** One pane's durable row rehydrated back into an in-memory `EnvelopeDraft`. `sentVersions`:
 *  `awaiting_approval` means this exact version WAS sent (parked pending operator confirmation —
 *  the send-idempotency guard, spec §5.3, must keep refusing a duplicate send of it); a `draft`
 *  row means the version's one delivery attempt is known to have FAILED (that's the only way a
 *  post-send exchange returns to `draft` — `delivery_failed`, spec note ᵉ — or it was reverted by
 *  boot recovery because its approval row vanished), so re-sending the SAME version must be
 *  allowed again, not refused as a false duplicate. */
function rehydratedDraftFrom(
  row: { exchange_id: string; state: string },
  persisted: PersistedDraftEnvelope,
): EnvelopeDraft {
  return {
    exchangeId: row.exchange_id,
    target: persisted.target,
    envelope: persisted.envelope,
    draftVersion: persisted.draftVersion,
    sentVersions: row.state === "awaiting_approval" ? [persisted.draftVersion] : [],
  };
}

/** Rehydrate the pane-approval binding for one `awaiting_approval` row — but ONLY when the
 *  durable `pending_approvals` row it names still survives (mirrors src/exchanges/recovery.ts's
 *  own `recoverAwaitingApproval` defensiveness exactly, independently re-checked here rather than
 *  assumed from call order: this function must be safe to call on its own). A binding is never
 *  rehydrated for a vanished approval — that would let a stale `approve` deliver text nobody can
 *  see was confirmed. */
function rehydrateApprovalBindingIfSurvived(
  store: JanusStore,
  projectId: string,
  paneId: string,
  approvalId: string | null,
  approvalDraftVersion: number | null,
): boolean {
  if (approvalId == null || approvalDraftVersion == null) return false;
  if (!store.hasPendingApproval(approvalId)) return false;
  bindApprovalToDraft(projectId, paneId, { messageId: approvalId, draftVersion: approvalDraftVersion });
  return true;
}

/** The rehydration report — mirrors `ExchangeRecoveryReport`'s shape (src/exchanges/recovery.ts)
 *  so a boot log line can report both in one consistent style. */
export interface DraftRegistryRehydrationReport {
  /** Pane keys (`${projectId}::${paneId}`) whose open draft was rebuilt from a durable row. */
  rehydratedDrafts: string[];
  /** Of those, the ones whose outstanding-approval binding ALSO survived and was rebound. */
  rehydratedApprovalBindings: string[];
}

/**
 * Boot rehydration (Phase 4, Step 4.3): walk the durable `draft`/`awaiting_approval` exchange rows
 * (the two dispositions boot recovery, src/exchanges/recovery.ts, ALWAYS keeps — see its own
 * table; `recoverExchangesOnBoot` should run BEFORE this, though this function independently
 * re-verifies the approval survival check so call order is not load-bearing) and rebuild this
 * process's `openDrafts`/`approvalBindings` registry from the ones that carry a persisted
 * envelope. Best-effort and pure bookkeeping: a row with no persisted envelope (the accepted
 * limitation above) or a project/pane that already has a (newer, same-process) open draft is
 * skipped, never overwritten — this only ever SEEDS a cold registry, it never clobbers live state.
 */
export function rehydrateDraftRegistryOnBoot(store: JanusStore): DraftRegistryRehydrationReport {
  const report: DraftRegistryRehydrationReport = { rehydratedDrafts: [], rehydratedApprovalBindings: [] };
  for (const state of ["draft", "awaiting_approval"] as const) {
    for (const row of store.listExchangesByState(state)) {
      if (getOpenDraft(row.project_id, row.pane_id)) continue; // never clobber a live registry entry
      const persisted = parsePersistedDraftEnvelope(row.instruction_envelope_json);
      if (!persisted) continue; // no structured envelope to rebuild (accepted limitation, see doc)
      setOpenDraft(row.project_id, row.pane_id, rehydratedDraftFrom(row, persisted));
      report.rehydratedDrafts.push(row.exchange_id);
      if (state === "awaiting_approval" &&
          rehydrateApprovalBindingIfSurvived(store, row.project_id, row.pane_id, row.approval_id, row.approval_draft_version)) {
        report.rehydratedApprovalBindings.push(row.exchange_id);
      }
    }
  }
  return report;
}
