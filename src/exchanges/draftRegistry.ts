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

import type { EnvelopeDraft } from "./instructionEnvelope";

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
  recentReferent = null;
}
