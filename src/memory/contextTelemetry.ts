// src/memory/contextTelemetry.ts
// Cortex context-injection telemetry (P0 first PR — spec 2026-07-02-cortex-context-telemetry.md
// §6, §18.1, §18.3). Pure types + cheap deterministic helpers ONLY. No cost logic here (that
// lives in the report layer, spec §6.4 / §11) and no store I/O (that's src/store/sqliteStore.ts).
//
// This module observes; it never steers. Nothing here may change injectMemoryBrief's actual
// behavior — it only describes the shape of what gets recorded about it.

import { createHash } from "node:crypto";

/** Why injectMemoryBrief was called. Superset of the call sites that exist TODAY (delta 18.2
 *  drops emission for the ones with no current call site) PLUS the doc's future values, which
 *  are kept in the union so the report script never chokes on an unknown-but-valid trigger. */
export type ContextInjectionTrigger =
  | "session_start"
  | "pane_switch"
  | "project_switch"
  | "reconnect"
  | "catch_me_up"
  | "pane_signal"
  | "approval_event"
  | "handoff"
  | "manual_refresh"
  | "test";

/** Outcome of one injection attempt. `skipped_empty_brief` is a delta-18.3 addition: the doc's
 *  original taxonomy conflated "no active pane" with "brief rendered empty for the active pane",
 *  which are different failure signals worth separating. `skipped_dedupe_candidate` stays in the
 *  union for forward compatibility but is NEVER emitted by this PR (dedupe is metric-only). */
export type ContextInjectionDisposition =
  | "injected"
  | "skipped_no_session"
  | "skipped_no_active_pane"
  | "skipped_stale_brief"
  | "skipped_empty_brief"
  | "skipped_dedupe_candidate"
  | "failed";

/** One attempted context injection (spec §6.1). Column-for-column with schema v10's
 *  `context_injections` table — see src/store/schema.ts and src/store/sqliteStore.ts. Never carries
 *  raw brief text or unredacted error detail; only hashes, counts, source, and IDs. */
export interface ContextInjectionEvent {
  id: string;
  ts: number;
  session_id: string | null;
  interaction_id: string | null;
  inject_id: string | null;
  trigger: ContextInjectionTrigger;
  active_project_id: string | null;
  active_pane_id: string | null;
  brief_active_pane_id: string | null;
  source: "fallback" | "python" | "cortex-primary" | "none";
  disposition: ContextInjectionDisposition;
  skipped_reason: string | null;
  source_snapshot_hash: string | null;
  brief_hash: string | null;
  brief_chars: number;
  estimated_tokens: number;
  elapsed_ms: number | null;
  error: string | null;
}

// A module-scope monotonic counter mints `ctxevt-<ts>-<seq>` event ids — mirrors the B-3
// `mintInjectId` idiom (src/voice/index.ts) so both id families are cheap, collision-free, and
// sortable without touching a UUID library.
let eventSeq = 0;

/** Mint a fresh, monotonic context-injection EVENT id (distinct from `inject_id`, the B-3
 *  per-injection correlation key minted separately in src/voice/index.ts). */
export function mintContextInjectionEventId(): string {
  return `ctxevt-${Date.now()}-${++eventSeq}`;
}

/** Cheap, deterministic 16-hex-char SHA-256 fingerprint of arbitrary text (brief text, or a
 *  stable-stringified snapshot). Mirrors MemoryService's `_snapshotHash` helper
 *  (src/memory/index.ts) so hashing stays consistent across the codebase. */
export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Cheap, deterministic 16-hex-char SHA-256 fingerprint of a JSON-serializable snapshot value.
 *  Callers are responsible for passing an already-stable-ordered value if key order matters;
 *  this PR does not add a canonical stable stringifier (spec §6.2 permits deferring that). */
export function hashSnapshot(snapshot: unknown): string {
  return hashText(JSON.stringify(snapshot));
}

/** Trend/cost-comparison token estimate (spec §6.3). Not exact billing — do not overfit. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}
