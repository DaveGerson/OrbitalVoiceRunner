// src/memory/injectGate.ts — Wave 4 D2: the inject gate, the pre-cortex choke point.
//
// Runs in src/voice/index.ts's injectMemoryBrief BEFORE any cortex round-trip: a synchronous,
// pure hash-compare + debounce-timer check against the INPUT tier snapshot (MemoryService's
// existing `_snapshotHash` machinery, exposed via `snapshotHashFor`). A skip costs ZERO Python
// round-trips. `evaluate` never mutates state — state advances ONLY via `noteInjected`, which the
// caller invokes AFTER a brief actually reaches Gemini (sendClientContent succeeds). A brief that
// is minted but then dropped by a downstream guard (stale pane / empty text) never counts as
// injected, so the gate's next evaluation still sees the true prior state.
//
// Spec: docs/superpowers/specs/2026-07-02-cortex-cutover-design.md D2.
import type { CortexWireTrigger } from "./types";

export type InjectGateSkip = "unchanged-brief" | "debounce";

export interface InjectGateDecision {
  inject: boolean;
  skip: InjectGateSkip | null;
}

export class InjectGate {
  private lastInjectedHash: string | null = null;
  // Epoch-ms of the last confirmed injection. Defaults to a true "no prior injection" sentinel
  // (z5c s1 review graft, from the codex executor branch): with the old `0` default the
  // never-debounce-before-first-injection guarantee held only because production `now` is
  // epoch-scale — a per-session gate evaluated under a relative/fake clock (small `now`) would
  // spuriously debounce its very first non-session-start call. NEGATIVE_INFINITY makes the
  // guarantee unconditional (`now - (-Infinity)` is +Infinity at any clock scale), which matters
  // once slices 2/3 unit-test per-session gates under fake timers.
  private lastInjectedAt = Number.NEGATIVE_INFINITY;

  constructor(private debounceMs: () => number) {}

  /** PURE: no state write. `session-start` bypasses both checks (a fresh Gemini session has empty
   *  context by definition). Otherwise: an unchanged snapshot hash (vs the last INJECTED hash)
   *  skips as "unchanged-brief" — checked BEFORE the debounce floor, so a genuinely unchanged
   *  world never waits out the clock. A changed snapshot inside the debounce floor since the last
   *  injection skips as "debounce". `debounceMs()` is read fresh on every call (not cached at
   *  construction) so a runtime settings change takes effect immediately. */
  evaluate(snapshotHash: string, wire: CortexWireTrigger, now: number): InjectGateDecision {
    if (wire === "session-start") return { inject: true, skip: null };
    if (snapshotHash === this.lastInjectedHash) return { inject: false, skip: "unchanged-brief" };
    if (now - this.lastInjectedAt < this.debounceMs()) return { inject: false, skip: "debounce" };
    return { inject: true, skip: null };
  }

  /** Advance state — call ONLY after the brief actually reached Gemini. A skip, or a downstream
   *  drop (stale pane / empty brief / send failure), must NEVER call this. */
  noteInjected(hash: string, now: number): void {
    this.lastInjectedHash = hash;
    this.lastInjectedAt = now;
  }
}

/** z5c slice 1 groundwork (spec 2026-07-07 D5): per-session gate state. One InjectGate per
 *  session key, created on demand; `null` (today's single implicit session) maps to a stable
 *  default key so current behavior is byte-identical. The debounceMs getter is shared by every
 *  gate so a runtime settings PUT reaches all sessions at once. Naming follows the existing
 *  `pendingApprovals.forSession(...)` idiom. */
export class InjectGateRegistry {
  private gates = new Map<string, InjectGate>();

  constructor(private debounceMs: () => number) {}

  forSession(sessionId: string | null): InjectGate {
    const key = sessionId ?? "__single_session__";
    let gate = this.gates.get(key);
    if (!gate) {
      gate = new InjectGate(this.debounceMs);
      this.gates.set(key, gate);
    }
    return gate;
  }
}
