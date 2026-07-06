// src/memory/decisionRing.ts — Wave 4 D4: the TS-side decision-memory ring buffer feeding the
// cortex's hysteresis rule. Oldest-first, capped at HISTORY_K (8), NOT persisted across restarts
// (D8 non-goal — a fresh process starts with an empty ring, which is fine: hysteresis suppression
// is a short-lived UX smoothing, not a durable invariant). MemoryService owns one instance and
// pushes exactly one entry per SUCCESSFUL `cortex.decide` call — the SHADOW `.then` hit and the
// PRIMARY `onHit` alike (D4: "on EVERY ok decide") — then passes `snapshot()` as `CortexCtx.history`
// on every subsequent decide request. Python's pure core reads it; it never retains state itself.
//
// Spec: docs/superpowers/specs/2026-07-02-cortex-cutover-design.md D4.
import { HISTORY_K, type CortexHistoryEntry } from "./types";

export class DecisionRing {
  private entries: CortexHistoryEntry[] = [];

  /** Append one decide outcome, evicting the oldest once past HISTORY_K. */
  push(e: CortexHistoryEntry): void {
    this.entries.push(e);
    if (this.entries.length > HISTORY_K) this.entries.shift();
  }

  /** A defensive copy (oldest-first) — callers (the wire ctx) must not mutate the ring itself. */
  snapshot(): CortexHistoryEntry[] {
    return [...this.entries];
  }
}
