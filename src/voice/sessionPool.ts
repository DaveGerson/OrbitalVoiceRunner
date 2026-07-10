// src/voice/sessionPool.ts — z5c design (spec 2026-07-07-z5c-session-pool-design.md), Slice 2/3.
//
// SessionPool is the DECISION layer for the per-project session pool: entry state machine
// (D2), switching-flow decisions (D4), per-project resumption-handle KV persistence + legacy
// migration (D5), the hot-slot config surface (D7), and the pool.plan client integration with a
// TS fail-closed floor (D6). It deliberately does NOT own any Gemini Live socket — "Python
// decides pool membership; TypeScript keeps all socket I/O and the proven reconnect mechanics"
// (decision record 5) stays true of THIS module too: SessionPool tells its caller (src/voice/
// index.ts) what SHOULD happen (instant/resume/fresh, which projects should be hot/warm/handle),
// and the caller is responsible for actually driving connectLiveSession/mic-binding — the
// riskiest part of the wave (D2's own words) and the part this slice intentionally leaves the
// EXISTING single-socket mechanics to execute, generalized only as far as this decision seam.
//
// Scope (D5): a SessionPool instance lives for exactly one browser WS connection (constructed
// fresh in attachVoiceSession's `wss.on("connection", ...)` handler, alongside VoiceSessionState)
// — its in-memory entry map dies with that connection, same as today's hot Gemini socket. The
// per-project resumption HANDLES it reads/writes go through the durable `store` (KV), so they
// survive both a reconnect and a process restart — only the transient hot/warm/handle judgment
// resets per connection, exactly like the pre-pool single `state.session`/`lastSessionResumptionToken`
// did.

import type { InjectGate, InjectGateRegistry } from "../memory/injectGate";
import type { ContextVersionRegistry } from "../memory/contextVersions";
import {
  DEFAULT_RESUME_HANDLE_TTL_MS,
  LEGACY_RESUME_HANDLE_KV_KEY,
  readFreshHandle,
  resumptionHandleKvKeyFor,
  wrapHandleForPersist,
} from "../voiceResumption";
import type { PoolPlan, PoolPlanSnapshot, PythonPolicyClient } from "./policyClient";

/** D2: the four states a pooled project entry can be in. `hot-foreground` holds the mic/audio
 *  (exactly one entry, ever); `hot-warm` is a live socket with no audio; `handle` has no socket,
 *  only a persisted resumption handle; `cold` is a project the pool has never touched. */
export type PoolEntryState = "hot-foreground" | "hot-warm" | "handle" | "cold";

export interface PoolEntry {
  readonly projectId: string;
  state: PoolEntryState;
  /** Epoch-ms of the last time THIS project became the foreground (LRU key, mirrors pool.plan's
   *  `lastSwitchAtMs` snapshot field). 0 = never. */
  lastSwitchAtMs: number;
  /** Epoch-ms of the last inject-class event routed at (or dropped for) this project. 0 = never. */
  lastEventAtMs: number;
}

/** D4: the pure switching-flow decision for a project switch. NEVER touches a socket — computing
 *  this has zero side effects; the caller decides whether/how to execute it. */
export interface SwitchPlan {
  flow: "instant" | "resume" | "fresh";
  fromState: PoolEntryState;
  /** The context_version this project's session last ACKNOWLEDGED (ContextVersionRegistry) — the
   *  catch-up brief's "since" anchor (D4: "the cortex fires a catch-up brief" on a handle/fresh
   *  target). null when the pair has never acknowledged a delivery (a genuinely fresh pair). */
  sinceContextVersion: string | null;
}

/** Structural KV surface this module needs from the store — `JanusStore` satisfies this
 *  directly; a hand-built test double may pass a lighter fake with the same shape (mirrors
 *  ContextVersionSource's convention in contextVersions.ts). */
export interface PoolKVSource {
  getKV(key: string): string | null | undefined;
  setKV(key: string, value: string): void;
  deleteKV(key: string): void;
}

export interface PersistedHandle {
  token: unknown;
  persistedAt: number;
}

/** D7: the hot-slot budget config surface — `voiceUx.sessionPoolHotSlots`, default 1, clamped to
 *  [0, 3] (a quota guard against Gemini Live's concurrent-session limits). Any non-finite/absent
 *  input fails safe to the default, mirroring resolveResumeHandleTtlMs's shape. */
export const DEFAULT_HOT_SLOT_BUDGET = 1;
export const MIN_HOT_SLOT_BUDGET = 0;
export const MAX_HOT_SLOT_BUDGET = 3;

export function resolveHotSlotBudget(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_HOT_SLOT_BUDGET;
  const n = Math.trunc(raw);
  if (n < MIN_HOT_SLOT_BUDGET) return MIN_HOT_SLOT_BUDGET;
  if (n > MAX_HOT_SLOT_BUDGET) return MAX_HOT_SLOT_BUDGET;
  return n;
}

/** D6: today's single-session behavior, expressed as a plan — foreground only, no hot-warm
 *  slots, no actions. This is what EVERY `pool.plan` miss (daemon dead, timeout, off-schema,
 *  thrown error) degrades to; it is also what a brand-new pool with no daemon configured at all
 *  produces, so "no policies daemon" and "policies daemon just failed" behave identically. */
export function floorPlan(foregroundProjectId: string | null): PoolPlan {
  return {
    foregroundProjectId,
    hotSlots: foregroundProjectId ? [foregroundProjectId] : [],
    actions: [],
  };
}

export interface SessionPoolDeps {
  /** Durable store for per-project handle persistence. null degrades to in-memory-only (mirrors
   *  ContextVersionRegistry/persistResumptionToken's existing `store: JanusStore | null` idiom —
   *  a hand-built test harness with no store attached still works, just nothing survives restart). */
  store: PoolKVSource | null;
  /** Server-scoped, shared across every connection/project (see class doc): per-project gate
   *  state should survive a browser refresh (the daemon didn't restart, the project's "last
   *  injected hash" is still true), unlike the transient hot/warm/handle bookkeeping this pool
   *  itself owns. Callers pass `memory.service.gates` (already exists, InjectGateRegistry). */
  gates: InjectGateRegistry;
  contextVersions: ContextVersionRegistry;
  /** This connection's voice_session_id — the `session` leg of the (project, session) pair
   *  ContextVersionRegistry keys catch-up deltas on. */
  sessionId: string | null;
  hotSlotBudget: number;
  handleTtlMs?: number;
  now?: () => number;
}

export class SessionPool {
  private readonly entries = new Map<string, PoolEntry>();
  private foregroundProjectId: string | null = null;
  private legacyMigrationDone = false;

  constructor(private readonly deps: SessionPoolDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private entryFor(projectId: string): PoolEntry {
    let e = this.entries.get(projectId);
    if (!e) {
      e = { projectId, state: "cold", lastSwitchAtMs: 0, lastEventAtMs: 0 };
      this.entries.set(projectId, e);
    }
    return e;
  }

  /** D5: per-project InjectGate — real gate/debounce isolation so a stale hash from project A can
   *  never skip a genuinely-changed brief for project B (the pre-pool bug this closes: EVERY
   *  project shared ONE gate, keyed null). `null` maps to the same stable default key
   *  InjectGateRegistry already uses for "no active project" — byte-identical to pre-pool
   *  behavior in that edge case. */
  gateFor(projectId: string | null): InjectGate {
    return this.deps.gates.forSession(projectId);
  }

  /** D5: one-way migration of the legacy single-slot resumption handle into a target project's
   *  own per-project KV slot. Idempotent (runs at most once per SessionPool instance) and a
   *  total no-op if there's nothing to migrate or the target already has its own handle (never
   *  clobbers a project that already has real per-project state). Fail-soft: a store fault is
   *  logged, never thrown — mirrors persistResumptionToken's existing swallow contract. */
  migrateLegacyHandle(targetProjectId: string | null): void {
    if (this.legacyMigrationDone || !this.deps.store || !targetProjectId) {
      this.legacyMigrationDone = true;
      return;
    }
    this.legacyMigrationDone = true;
    try {
      const raw = this.deps.store.getKV(LEGACY_RESUME_HANDLE_KV_KEY);
      if (!raw) return;
      const targetKey = resumptionHandleKvKeyFor(targetProjectId);
      if (this.deps.store.getKV(targetKey)) return; // target already has its own — never clobber.
      this.deps.store.setKV(targetKey, raw);
      this.deps.store.deleteKV(LEGACY_RESUME_HANDLE_KV_KEY);
    } catch (e) {
      console.error("[session-pool] legacy handle migration failed:", e);
    }
  }

  /** Persist `projectId`'s own resumption handle (age-stamped, same wire shape as the pre-pool
   *  single-slot writer). `token == null` deletes the slot (mirrors persistResumptionToken). */
  persistHandle(projectId: string, token: unknown, now: number = this.now()): void {
    if (!this.deps.store) return;
    try {
      const key = resumptionHandleKvKeyFor(projectId);
      if (token == null) this.deps.store.deleteKV(key);
      else this.deps.store.setKV(key, wrapHandleForPersist(token, now));
    } catch (e) {
      console.error("[session-pool] persistHandle failed:", e);
    }
  }

  /** Read `projectId`'s own resumption handle back, only if fresh (readFreshHandle's existing
   *  age-guard fail-closed contract — an unknown/expired/garbage handle resolves null, never
   *  throws). Returns null with no store attached. */
  readHandle(projectId: string, now: number = this.now()): PersistedHandle | null {
    if (!this.deps.store) return null;
    try {
      const raw = this.deps.store.getKV(resumptionHandleKvKeyFor(projectId));
      return readFreshHandle(raw, now, this.deps.handleTtlMs ?? DEFAULT_RESUME_HANDLE_TTL_MS);
    } catch {
      return null;
    }
  }

  /** D4: the pure switching-flow decision. A hot entry (foreground already, or a hot-warm slot
   *  from a future slice) switches instantly — zero connects, the brain is already current. A
   *  handle/cold entry needs a real connect; whether that connect resumes or starts fresh depends
   *  entirely on whether a FRESH persisted handle exists for it (poisoned/expired handles read as
   *  cold here — readHandle already fails closed on staleness/garbage, matching D4's "handle
   *  poisoned (1008) => existing self-heal clears it, fresh session + catch-up"). */
  planSwitch(targetProjectId: string, now: number = this.now()): SwitchPlan {
    const entry = this.entryFor(targetProjectId);
    const sinceContextVersion = this.deps.contextVersions.currentAcknowledgedVersion(
      targetProjectId,
      this.deps.sessionId,
    );
    if (entry.state === "hot-foreground" || entry.state === "hot-warm") {
      return { flow: "instant", fromState: entry.state, sinceContextVersion };
    }
    const handle = this.readHandle(targetProjectId, now);
    return { flow: handle ? "resume" : "fresh", fromState: entry.state, sinceContextVersion };
  }

  /** Record that `projectId` is now (or remains) the foreground project — LRU bookkeeping (D3's
   *  `lastSwitchAtMs`) plus the state-machine transition. The PRIOR foreground (if different)
   *  demotes to `handle`: in today's single-physical-socket world there is no hot-warm slot yet
   *  to fall back to, so its live conversation freezes exactly as it does today when the operator
   *  switches away (D2's "Background hot entries keep receiving inject-class briefs" is Slice 3
   *  scope — see the module-level deferral note in src/voice/index.ts's wiring). Safe to call
   *  redundantly for the SAME project (session_start/reconnect re-affirming the current
   *  foreground) — a no-op demotion since prev === projectId. */
  noteSwitch(projectId: string, now: number = this.now()): void {
    const prevForeground = this.foregroundProjectId;
    if (prevForeground && prevForeground !== projectId) {
      const prev = this.entryFor(prevForeground);
      if (prev.state === "hot-foreground") prev.state = "handle";
    }
    const entry = this.entryFor(projectId);
    entry.state = "hot-foreground";
    entry.lastSwitchAtMs = now;
    entry.lastEventAtMs = now;
    this.foregroundProjectId = projectId;
  }

  /** Stamp a project's last-event time without changing its state (background inject-class
   *  traffic that was NOT live-delivered still updates freshness bookkeeping for pool.plan). */
  noteEvent(projectId: string, now: number = this.now()): void {
    this.entryFor(projectId).lastEventAtMs = now;
  }

  stateFor(projectId: string): PoolEntryState {
    return this.entries.get(projectId)?.state ?? "cold";
  }

  /** True only for the CURRENT foreground project — the one project with a live physical socket
   *  in today's single-socket world (Slice 3's hot-warm sockets are the deferred piece; once they
   *  land this should also return true for a hot-warm entry, which is exactly why the check is
   *  centralized here rather than inlined at each call site). */
  isForegroundProject(projectId: string | null): boolean {
    return projectId !== null && projectId === this.foregroundProjectId;
  }

  /** D1/D4/D6: whether a background project's inject-class signal has a live session to reach
   *  right now. Only hot entries do; a handle/cold entry has no socket to feed and — per D6 non-
   *  goal 6 ("no event queue for the handle tier") — the signal is simply dropped, not queued.
   *  Its eventual promotion's catch-up brief (sourced from durable stores via planSwitch's
   *  `sinceContextVersion`) covers what it missed; nothing is silently lost. */
  isLiveDeliverable(projectId: string): boolean {
    const s = this.stateFor(projectId);
    return s === "hot-foreground" || s === "hot-warm";
  }

  /** Compose the health snapshot pool.plan reasons over (D3's request shape). */
  snapshotFor(projects: string[], now: number = this.now()): PoolPlanSnapshot {
    const entries: PoolPlanSnapshot["entries"] = {};
    for (const projectId of projects) {
      const e = this.entryFor(projectId);
      const handle = this.readHandle(projectId, now);
      entries[projectId] = {
        state: e.state,
        handleAgeMs: handle ? now - handle.persistedAt : null,
        handleTtlMs: handle ? (this.deps.handleTtlMs ?? DEFAULT_RESUME_HANDLE_TTL_MS) : null,
        lastEventAtMs: e.lastEventAtMs || null,
        lastSwitchAtMs: e.lastSwitchAtMs || null,
      };
    }
    return {
      projects,
      foregroundProjectId: this.foregroundProjectId,
      hotSlotBudget: this.deps.hotSlotBudget,
      entries,
    };
  }

  /** D3/D6: race the Python `pool.plan` op (via the SAME optional `policies` facade every other
   *  voice-UX policy op uses); on ANY miss (no client, daemon down, timeout, schema mismatch,
   *  ok:false) resolve the D6 fail-closed floor instead. NEVER rejects, NEVER throws — matches
   *  the PythonPolicyClient FALLBACK CONTRACT verbatim so this call site needs no try/catch of
   *  its own. */
  async planPool(policies: PythonPolicyClient | undefined, projects: string[]): Promise<PoolPlan> {
    if (!policies?.planPool) return floorPlan(this.foregroundProjectId);
    const snapshot = this.snapshotFor(projects);
    const plan = await policies.planPool(snapshot);
    return plan ?? floorPlan(this.foregroundProjectId);
  }
}
