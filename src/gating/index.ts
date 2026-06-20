/**
 * src/gating/index.ts — the SHARED GATING / SAFETY CORE (DBT5 / dec-4).
 *
 * This is the behaviour-preserving carve of the capability-gate resolver, the deferred-action +
 * pending-approval stores (with their durable boot hydration), the effective-posture surface, the
 * single resolve choke-point (applyResolution), the TWO-STAGE EMERGENCY STOP-ALL brake, and the TTL
 * sweep out of `startServer()`. It is the safety substrate the REST surface AND the voice/WS path
 * BOTH consume — so it MUST stay ONE cohesive module. Splitting applyResolution /
 * broadcastTerminalsUpdated across a REST/voice boundary would re-introduce exactly the coupling this
 * decomposition removes (they are genuinely shared), so they live together here.
 *
 * Coupling flows ONLY through the injected `deps` bag. This module imports the pure helpers it already
 * used (pendingApprovals / pendingActions / actionEffects / actionPendingPayload / gateSurface /
 * handoffFlow / types) and the concrete types of its deps — NEVER server.ts.
 *
 * INVARIANTS preserved verbatim:
 *  - The pending stores are CONSTRUCTED inside createGating and EXPOSED so the REST ctxFactory + the
 *    voice ActionContext inject the SAME instances (one set of pending state, not two).
 *  - The boot hydration loop (buildActionRun + checkActionVersion quarantine) is kept EXACTLY, or
 *    survivors mis-rehydrate after a restart.
 *  - `broadcastTerminalsUpdated` reads coreState.frozen / coreState.activePaneId by reference, so a WS
 *    `set_active_pane` write is immediately visible to the posture surface across the boundary.
 *  - `pushApprovalNarration` is an INJECTED slot (voice owns the live session), so gating NEVER imports
 *    voice. For now server.ts passes its existing inline pushApprovalNarration in; dec-5 moves the
 *    definition into voice and injects it from there.
 *  - The frozen short-circuit (applyFrozenShortCircuit) stays the ONE choke-point in
 *    effectiveCapabilityGateFor; the matrix is never mutated, so Release re-exposes it exactly.
 */

import { OrchestratorManager, redactSecrets } from "../terminal";
import {
  PendingApprovalStore,
  resolveDecision,
  resolveCapabilityGateWithContext,
  loadShellAllowlist,
  decideSweepAction,
  renderResumptionLine,
  applyFrozenShortCircuit,
  APPROVAL_GRACE_MS,
  type EffectiveMode,
  type ResolveMode,
  type ResolveReason,
} from "../pendingApprovals";
import { PendingActionStore } from "../pendingActions";
import { applyPaneMode, type PaneModeResult } from "../applyPaneMode";
import { buildActionRun, checkActionVersion } from "../actionEffects";
import { resolveActionPendingPosture, type GlobalMode } from "../actionPendingPayload";
import { applyHandoffFlipOnResolve, type HandoffResolveReason } from "../handoffFlow";
import {
  deriveEffectiveGates,
  derivePostureWord,
  ALL_CAPABILITIES,
  type EffectiveMode as GateSurfaceMode,
} from "../gateSurface";
import { MAX_DEFERRALS } from "../approvalIntent";
import type { GateValue, CapabilityGate, PaneMeta } from "../types";
import { findPaneOwningProject } from "../paneOwnership";
import type { JanusStore } from "../store/sqliteStore";
import type { AnnouncementBus } from "../announcementBus";
import type { CoreState } from "../core/coreState";

/**
 * The gating core's injected dependency bag — everything the moved closures used from `startServer()`
 * scope, threaded explicitly so the SAME shared cells are mutated across the boundary.
 *
 *  - manager:                   the OrchestratorManager (terminals, ledger, settings, globalPermissionsMode).
 *  - store:                     the durable JanusStore (or null on the legacy / failed-init path).
 *  - broadcast / broadcastLedgerUpdate: the WS notification sinks.
 *  - broadcastDraft:            INJECTED — re-emits the per-pane WIP draft (draft_updated). The approved
 *                               resolve path clears a matching WIP draft so a later draft Send cannot
 *                               re-emit the same text (dup-send fix); this keeps the draft_updated WS
 *                               payload shape in ONE place (server.ts broadcastDraft).
 *  - coreState:                 the shared mutable state (frozen / activePaneId / activeLiveSession / lastStopAllFailed).
 *  - announcementBus:           the proactive-feedback sink (earcons + on-screen stack).
 *  - pushApprovalNarration:     INJECTED — narrates a system event into the live session (voice owns it; dec-5 moves the def into voice).
 *                               3V.3: the real seam returns `false` when the push threw (swallowed) so the
 *                               sweep can gate the last-call stamp on a HEARD narration. `void` (legacy
 *                               stubs) counts as success — only a strict `false` is a failed push.
 *  - sanitizeSettingsForClient: passed through to buildActionRun's deps for the rehydrated set_*_permissions effects.
 *  - addCommand:                the HistoryManager singleton's addCommand (server.ts HistoryManager is not importable);
 *                               the approved-write path records the command in command history exactly as before.
 */
export interface GatingDeps {
  manager: OrchestratorManager;
  store: JanusStore | null;
  broadcast: (msg: any) => void;
  broadcastLedgerUpdate: () => void;
  broadcastDraft: (projectId: string, paneId: string) => void;
  coreState: CoreState;
  announcementBus: AnnouncementBus;
  pushApprovalNarration: (session: any, text: string) => boolean | void;
  sanitizeSettingsForClient: (settings: any) => any;
  addCommand: (terminalId: string, command: string) => void;
}

/** The cohesive seam createGating returns. The pending stores + the constants are exposed so the
 *  server-owned consumers (REST ctxFactory, voice ActionContext, dispatchProposal, the close handler)
 *  reference the SAME instances. */
export interface Gating {
  effectiveModeFor: (targetId: string) => EffectiveMode;
  effectiveCapabilityGateFor: (paneId: string | null | undefined, capability: CapabilityGate) => GateValue;
  gateCapability: (capability: CapabilityGate, paneId: string | null) => { forbidden: boolean; gate: GateValue };
  gateOrDefer: (
    capability: CapabilityGate,
    paneId: string | null,
    summary: string,
    run: () => string,
    params?: Record<string, unknown>,
    requestedMode?: string
  ) => { disposition: "run" } | { disposition: "forbidden" } | { disposition: "deferred"; actionId: string; summary: string };
  effectiveGatesForPane: (paneId: string) => Record<CapabilityGate, GateValue>;
  posturePayloadForPane: (paneId: string) => { id: string; effective_gates: Record<CapabilityGate, GateValue>; posture: ReturnType<typeof derivePostureWord> };
  allPanePostures: () => { id: string; effective_gates: Record<CapabilityGate, GateValue>; posture: ReturnType<typeof derivePostureWord> }[];
  broadcastTerminalsUpdated: () => void;
  runningPaneIds: () => string[];
  stopAll: (kill: boolean) => Promise<string[]>;
  killAllPanes: () => Promise<{ killed: string[]; failed: string[] }>;
  releaseStopAll: () => void;
  applyResolution: (messageId: string, mode: ResolveMode, opts?: { vocal?: boolean }) => ReturnType<typeof resolveDecision>;
  /** 4D.3: the voice DEFER verb — re-arm the pending approval's TTL window ("ask me later")
   *  WITHOUT claiming/deleting it. Capped at MAX_DEFERRALS re-arms (no infinite parking). */
  applyDeferral: (messageId: string, now?: number) => { reason: "deferred" | "defer_limit" | "not_found"; deferrals?: number };
  /** 4D.1: stamp the moment the live voice session detached — opens the "while you were away"
   *  window that reannounceSurvivors digests (and consumes) on the next reconnect. */
  noteSessionDetached: (now?: number) => void;
  /** The LIVE mode-switch choke point (multi-cli spec §6, bead 1y8). set_pane_permissions + restart_pane delegate here. */
  applyPaneMode: (
    paneId: string,
    targetMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only",
    source: "voice" | "ui" | "restart_pane"
  ) => Promise<PaneModeResult>;
  reannounceSurvivors: (session: any) => void;
  pendingApprovals: PendingApprovalStore;
  pendingActions: PendingActionStore;
  sweepExpiredApprovals: (now?: number) => void;
  startSweepTimer: () => ReturnType<typeof setInterval>;
  /** The read-only first-token allowlist for kind:"shell" — consumed by the (server-owned) dispatchProposal decideProposal call. */
  shellAllowlist: ReturnType<typeof loadShellAllowlist>;
  /** TTL for an unresolved approval — consumed by the (server-owned) dispatchProposal pendingApprovals.add. */
  APPROVAL_TTL_MS: number;
  /** Sweep cadence — exposed for symmetry; the timer is armed via startSweepTimer. */
  APPROVAL_SWEEP_MS: number;
}

/**
 * findPaneOwningProject — resolve the ledger project that OWNS a pane, NOT the active project.
 *
 * The lookup itself lives in src/paneOwnership.ts (zero runtime deps) so action defs and the
 * restart replay can share it without closing the gating → actionEffects → registry → defs
 * import cycle; re-exported here for the established consumers (server.ts, tests).
 */
export { findPaneOwningProject } from "../paneOwnership";

/**
 * createGating(deps) — build the shared gating/safety core plus its private, per-server pending state.
 * The pending stores are constructed here (and exposed) so EVERY surface (REST + voice) injects the
 * SAME instances. The boot hydration loop runs INSIDE here, AFTER the stores are built and BEFORE the
 * first WS connection / sweep tick — exactly the order it ran inline in startServer().
 */
export function createGating(deps: GatingDeps): Gating {
  const {
    manager,
    store,
    broadcast,
    broadcastLedgerUpdate,
    broadcastDraft,
    coreState,
    announcementBus,
    pushApprovalNarration,
    sanitizeSettingsForClient,
    addCommand,
  } = deps;

  // WS-E: the spoken/targeted/safe pending-approval store. The serializable record +
  // session side-map + ordered index + claim flag live in PendingApprovalStore so WS-F can
  // add durability/atomicity without a rewrite (see src/pendingApprovals.ts §8).
  // WS-M (bead wsm-e2e-pinned-nzt): inject the durable JanusStore so pending approvals SURVIVE a
  // process restart, while the N-1 atomic-claim gate is backed by the durable SQL claim. When the
  // store is null (JANUS_LEDGER_BACKEND=legacy or store init failed) the class is pure in-memory,
  // byte-for-byte as before — no behavioral change on the legacy path.
  const pendingApprovals = new PendingApprovalStore(store);
  // G1: deferred execution for gated NON-PTY mutators (create_pane / set_*_permissions /
  // update_metadata). On the Ask tier these stage a side-effect here and run exactly once on operator
  // confirm — separate from the pane-write PendingApprovalStore so the two never entangle.
  // (src/pendingActions.)
  // kzt (wsm-e2e-pinned-kzt): inject the durable JanusStore so a deferred action SURVIVES a process
  // restart. The run() closure is non-serializable, so add() persists the action's INTENT
  // (capability + params); the boot loop below rebuilds run() via buildActionRun. store===null
  // (JANUS_LEDGER_BACKEND=legacy / store init failed) => pure in-memory, byte-for-byte as before.
  const pendingActions = new PendingActionStore(store);
  let pendingActionSeq = 0;

  // kzt: rebuild deferred-action survivors from durable intent. Extracted to hydrateDeferredActions()
  // (behavior-preserving) but invoked HERE, in the exact original order: AFTER manager + pendingActions
  // are built and BEFORE the first WS connection / sweep tick. See the helper for the full rationale.
  hydrateDeferredActions();
  // R1/R2: read-only first-token allowlist for kind:"shell" (operator-overridable via env).
  const shellAllowlist = loadShellAllowlist();
  // WS-E.3 (BUG-019): TTL for an unresolved approval before it auto-rejects.
  const APPROVAL_TTL_MS = 5 * 60 * 1000;
  const APPROVAL_SWEEP_MS = 30 * 1000;

  // Best-effort durable audit (extracted from the many inline `if (store) { try { store.recordActivity(
  // { project_id: active||default, ... }) } catch {} }` sites). Behavior-preserving: a null store is a
  // silent no-op, the project_id defaults to the active project exactly as before, and the recordActivity
  // throw is swallowed — the audit must NEVER break a gate decision. `project_id` is overridable for the
  // few callers (boot quarantine/rehydrate) that pin "default_project" explicitly.
  function recordActivitySafe(entry: {
    type: string;
    pane_id: string | null;
    summary: string;
    payload?: Record<string, unknown>;
    project_id?: string;
  }): void {
    if (!store) return;
    // NB: `||` (not `??`) to match the original inline sites byte-for-byte — an EMPTY activeProjectId
    // falls back to "default_project" exactly as before.
    const projectId = entry.project_id ?? (manager.ledger.activeProjectId || "default_project");
    try {
      store.recordActivity({
        type: entry.type as any,
        project_id: projectId,
        pane_id: entry.pane_id,
        summary: entry.summary,
        ...(entry.payload !== undefined ? { payload: entry.payload } : {}),
      } as any);
    } catch { /* audit is best-effort */ }
  }

  // kzt: rebuild deferred-action survivors from durable intent. The run() closure is non-serializable,
  // so we persisted the INTENT (capability+params) and rebuild it here, bound to the LIVE manager/
  // broadcast (a deserialized closure could never re-bind them — they are fresh in this startServer()
  // closure). Re-staging via add() carries the existing durable row (INSERT OR REPLACE is a no-op
  // rewrite) and makes the survivor confirmable/cancellable exactly as before the restart. Hydration
  // only REBUILDS + re-stages run; it never INVOKES it (effects run on explicit confirm only). Body
  // extracted VERBATIM from the original inline boot loop (behavior-preserving); the quarantine /
  // rehydrate audits pin project_id "default_project" exactly as before.
  function hydrateDeferredActions(): void {
    for (const row of pendingActions.hydrateIntents()) {
      let params: Record<string, unknown> = {};
      try { params = JSON.parse(row.params); } catch { /* corrupt -> empty params; run() degrades gracefully */ }
      const versionCheck = checkActionVersion({
        actionName: (params as { actionName?: string }).actionName,
        schemaHash: (params as { schemaHash?: string }).schemaHash,
      });
      if (!versionCheck.ok) {
        // PLM3: the staged def drifted (renamed/moved/reshaped) or is unstamped/legacy -> do NOT blindly
        // rebuild+replay it against a possibly-mismatched effect. Quarantine: skip re-staging; record it
        // so the operator can re-issue. (A future boot-prune sweep removes quarantined rows.)
        recordActivitySafe({
          type: "permission_changed", project_id: "default_project", pane_id: null,
          summary: `QUARANTINED deferred ${row.capability} (${versionCheck.reason}): ${row.summary}`,
          payload: { capability: row.capability, action: "quarantined", reason: versionCheck.reason, action_id: row.id },
        });
        continue;
      }
      const run = buildActionRun(
        { capability: row.capability, params },
        { manager, broadcast, broadcastLedgerUpdate, sanitizeSettingsForClient },
      );
      pendingActions.add({
        id: row.id, capability: row.capability, summary: row.summary, params,
        timestamp: row.timestamp, run, ttlMs: Math.max(0, row.expires_at - row.timestamp),
      });
      recordActivitySafe({
        type: "permission_changed", project_id: "default_project", pane_id: null,
        summary: `REHYDRATED deferred ${row.capability}: ${row.summary}`,
        payload: { capability: row.capability, action: "rehydrated", action_id: row.id },
      });
    }
  }

  // ── 4D.1: the "while you were away" window ──────────────────────────────────────────────────
  // The resumption digest used to cover ONLY surviving approvals + pending actions; everything
  // that HAPPENED while no live session existed (panes finishing/erroring/exiting, stop-all
  // engaging/releasing) was never mentioned. We stamp the last live-session detach moment here
  // (in-memory, mirrored to the store KV so the window survives a process restart) and, on
  // reconnect, replay the durable activity rows inside [detach, reconnect] into ONE compact
  // spoken summary (see composeAwayDigest / reannounceSurvivors). store === null (legacy) ⇒ the
  // digest is silently skipped — never a throw.
  const AWAY_DETACH_KV = "gating.lastDetachAt";
  let lastDetachAt: number | null = null;
  if (store) {
    try {
      const raw = store.getKV(AWAY_DETACH_KV);
      const n = raw ? Number(raw) : NaN;
      if (Number.isFinite(n) && n > 0) lastDetachAt = n;
    } catch { /* KV is best-effort — no window, no digest */ }
  }

  function noteSessionDetached(now: number = Date.now()): void {
    // EARLIEST detach wins: a paired onerror/onclose (or the client-WS close following a live-
    // session drop) must not shrink an already-open window — reconnect consumes it anyway.
    if (lastDetachAt !== null) return;
    lastDetachAt = now;
    if (store) {
      try { store.setKV(AWAY_DETACH_KV, String(now)); } catch { /* best-effort */ }
    }
  }

  // 4D.1 production writer: the announcement bus already sees every genuine pane lifecycle edge
  // (completion / error / build-failed / exited), session or no session — record those edges as
  // durable `status_transition` events so the away digest can replay them. Registered defensively
  // (test fakes inject `{ enqueue, stop }` stubs without onEnqueue). Summaries are NOT persisted
  // here — only the kind — so nothing un-redacted can leak into the events table from this path.
  const AWAY_RECORDED_KINDS = new Set(["completion", "error", "build-failed", "exited"]);
  if (store && typeof (announcementBus as any).onEnqueue === "function") {
    announcementBus.onEnqueue((item) => {
      if (!AWAY_RECORDED_KINDS.has(item.kind)) return;
      try {
        store.recordActivity({
          type: "status_transition",
          project_id: manager.ledger.activeProjectId || "default_project",
          pane_id: item.terminalId,
          summary: `pane ${item.terminalId} ${item.kind}`,
          payload: { transition: item.kind },
        });
      } catch { /* audit is best-effort */ }
    });
  }

  // The away-digest's accumulator: panes bucketed by most-severe edge + the stop-all counters. Shared
  // by bucketAwayEvents (fills it) and renderAwayClauses (reads it).
  type AwayBuckets = {
    errors: Set<string>;
    exits: Set<string>;
    finished: Set<string>;
    autos: Set<string>;
    engaged: number;
    released: number;
    killed: number;
  };

  // 4D.1: fetch the durable activity rows the digest replays (getEvents has no ts filter, so we fetch
  // per type and filter by ts in the bucketing pass). A failed read must NEVER break the reconnect
  // path — it returns null exactly as the original inline try/catch did. Extracted verbatim.
  function fetchAwayRows(): ReturnType<JanusStore["getEvents"]> | null {
    if (!store) return null;
    try {
      return [
        ...store.getEvents({ type: "status_transition" }),
        ...store.getEvents({ type: "permission_changed" }),
        ...store.getEvents({ type: "command_dispatched" }),
      ];
    } catch {
      return null;
    }
  }

  // 4D.1: a "status_transition" row -> errors|exits|finished by its transition text (verbatim).
  function classifyStatusTransition(b: AwayBuckets, e: ReturnType<JanusStore["getEvents"]>[number]): void {
    const t = String((e.payload as { transition?: unknown } | null)?.transition ?? e.summary ?? "");
    const pane = e.pane_id ?? "a pane";
    if (/error|build-failed/i.test(t)) b.errors.add(pane);
    else if (/exit/i.test(t)) b.exits.add(pane);
    else if (/completion|finished|idle/i.test(t)) b.finished.add(pane);
  }

  // 4D.1: a "permission_changed" row -> stop-all engaged|released|killed counters (verbatim).
  function classifyPermissionChanged(b: AwayBuckets, e: ReturnType<JanusStore["getEvents"]>[number]): void {
    const action = (e.payload as { action?: unknown } | null)?.action;
    if (action === "stop_all_freeze") b.engaged++;
    else if (action === "stop_all_release") b.released++;
    else if (action === "stop_all_kill") b.killed += ((e.payload as { panes?: unknown[] })?.panes?.length ?? 0);
  }

  // 4D.1: classify ONE durable activity row into the away buckets (mutates `b`). Thin type-dispatch;
  // the per-type mapping lives in the helpers above + the command_dispatched auto-bucket below.
  //   - "status_transition"  payload.transition: error|build-failed → errors; exit → exits;
  //                          completion|finished|idle → finished.
  //   - "permission_changed" payload.action: stop_all_freeze → engaged; stop_all_release → released;
  //                          stop_all_kill → killed += panes.length.
  //   - "command_dispatched" → auto-dispatches.
  function classifyAwayRow(b: AwayBuckets, e: ReturnType<JanusStore["getEvents"]>[number]): void {
    if (e.type === "status_transition") classifyStatusTransition(b, e);
    else if (e.type === "permission_changed") classifyPermissionChanged(b, e);
    else if (e.type === "command_dispatched") b.autos.add(e.pane_id ?? "a pane");
  }

  // 4D.1: bucket the in-window (since, now] rows, then dedupe per pane to its MOST SEVERE bucket.
  function bucketAwayEvents(rows: ReturnType<JanusStore["getEvents"]>, since: number, now: number): AwayBuckets {
    const b: AwayBuckets = {
      errors: new Set<string>(), exits: new Set<string>(), finished: new Set<string>(),
      autos: new Set<string>(), engaged: 0, released: 0, killed: 0,
    };
    for (const e of rows) {
      if (e.ts <= since || e.ts > now) continue;
      classifyAwayRow(b, e);
    }
    // Dedupe per pane across buckets: a pane counts once, in its MOST SEVERE bucket.
    for (const p of b.errors) { b.exits.delete(p); b.finished.delete(p); }
    for (const p of b.exits) b.finished.delete(p);
    return b;
  }

  // 4D.1: the stop-all sentence (engaged/released/killed). Extracted verbatim.
  function renderStopAllClause(engaged: number, released: number, killed: number): string {
    let stop: string;
    if (engaged && released) stop = "stop-all was engaged and released";
    else if (engaged) stop = "stop-all was engaged and is still holding";
    else stop = "stop-all was released";
    if (killed) stop += ` (${killed} pane${killed === 1 ? "" : "s"} killed)`;
    return stop;
  }

  // 4D.1: assemble the ordered clause list (most-severe-first) from the buckets. Verbatim ordering.
  function renderAwayClauses(b: AwayBuckets): string[] {
    const paneClause = (panes: Set<string>, singular: string, plural: string): string =>
      panes.size === 1 ? `pane ${[...panes][0]} ${singular}` : `${panes.size} panes ${plural}`;
    const clauses: string[] = [];
    if (b.errors.size) clauses.push(paneClause(b.errors, "reported an error", "reported errors"));
    if (b.exits.size) clauses.push(paneClause(b.exits, "exited", "exited"));
    if (b.engaged || b.released || b.killed) clauses.push(renderStopAllClause(b.engaged, b.released, b.killed));
    if (b.finished.size) clauses.push(paneClause(b.finished, "finished", "finished"));
    if (b.autos.size) clauses.push(`${b.autos.size} auto-dispatch${b.autos.size === 1 ? "" : "es"} ran`);
    return clauses;
  }

  /**
   * 4D.1: compose the spoken "while you were away" line from the durable activity rows inside
   * (since, now]. Most-severe-first (errors → exits → stop-all → finished → auto-dispatches); each
   * pane counts ONCE, in its most severe bucket; clause count capped (≈3 sentences). Returns null
   * when nothing notable happened. The fetch/bucket/render phases are extracted (behavior-preserving);
   * see those helpers for the per-event-type mapping.
   */
  function composeAwayDigest(since: number, now: number): string | null {
    const rows = fetchAwayRows();
    if (rows === null) return null; // legacy (no store) OR a failed read — never breaks reconnect.
    const buckets = bucketAwayEvents(rows, since, now);
    const clauses = renderAwayClauses(buckets);
    if (clauses.length === 0) return null;
    // Spoken-compactness cap (≈3 sentences): at most 4 clauses, most-severe-first; the rest fold
    // into a trailing count rather than disappearing.
    const MAX_CLAUSES = 4;
    const shown = clauses.slice(0, MAX_CLAUSES);
    const more = clauses.length - shown.length;
    return `While you were away: ${shown.join("; ")}${more > 0 ? `; and ${more} more thing${more === 1 ? "" : "s"}` : ""}.`;
  }

  // R3: a fresh client-content push delivers the spoken read-back / resolution result. The
  // original call.id is consumed once by the non-blocking pending_approval response, so the
  // outcome cannot be a 2nd sendToolResponse — it is an ephemeral interactive turn.
  // M3: single-source effective-mode resolution. `globalPermissionsMode === "Inherit"` defers to
  // the pane's own mode (HiTL default when the pane is unknown); otherwise the global override
  // wins. Used by EVERY write path (dispatchProposal + handoff_context) so "gate a new write" =
  // resolve the mode here, never re-derive it inline.
  function effectiveModeFor(targetId: string): EffectiveMode {
    if (manager.globalPermissionsMode === "Inherit") {
      const term = manager.terminals[targetId];
      return (term ? term.permissionsMode : "Human-in-the-Loop") as EffectiveMode;
    }
    return manager.globalPermissionsMode as EffectiveMode;
  }

  // Capability-gate resolution (design §3) with the SPOTLIGHT (director posture 2026-06-01:
  // "trust follows focus"). Precedence: explicit per-pane override > spotlight (active pane +
  // productive capability => Auto) > global default > Auto. The gate is AND-composed with
  // effectiveMode inside decideProposal (a gate only TIGHTENS the mode). Resolution itself is the
  // pure, unit-tested resolveCapabilityGateWithContext — keep this in lockstep with that function.
  // The pane override is read from the pane's OWNING project (findPaneOwningProject), NOT the
  // active project — an operator's override must govern without a context switch
  // (tests/test_gate_owning_project.ts). Only the SPOTLIGHT keys on coreState.activePaneId.
  function effectiveCapabilityGateFor(paneId: string | null | undefined, capability: CapabilityGate): GateValue {
    const globalGates = manager.settings.advanced?.capabilityGates;
    let paneGate: GateValue | undefined;
    if (paneId) {
      paneGate = findPaneOwningProject(manager, paneId)?.pane.capabilityGates?.[capability];
    }
    const isActivePane = !!paneId && coreState.activePaneId === paneId;
    const resolved = resolveCapabilityGateWithContext(paneGate, globalGates?.[capability], capability, isActivePane);
    // STOP-ALL Stage-1: the ONE place the `frozen` short-circuit is applied. While frozen every
    // capability resolves Off; the matrix above is untouched, so Release re-exposes it exactly.
    return applyFrozenShortCircuit(coreState.frozen, resolved);
  }

  // Lightweight capability guard for mutating handlers that do NOT write to a pane PTY
  // (create_pane, set_pane_permissions, set_global_permissions, add_watch_rule, apply_recipe).
  // These have no in-flight writeInput to defer, so the gate semantics are:
  //   Off  -> forbidden (the safety-critical veto): returns a blocked result, no side effect.
  //   Ask  -> proceed but flag `requiresConfirm` so the handler narrates "confirm?" to the
  //           operator (v1: the side effect is applied and audited; full deferred-execution is
  //           WS-F — see openQuestions). Off is the hard guarantee here.
  //   Auto -> proceed silently.
  // Returns null when allowed (caller proceeds), or a {forbidden} object the caller renders.
  function gateCapability(capability: CapabilityGate, paneId: string | null): { forbidden: boolean; gate: GateValue } {
    const gate = effectiveCapabilityGateFor(paneId, capability);
    if (store) {
      const activeProjectId = manager.ledger.activeProjectId || "default_project";
      try {
        store.recordActivity({ type: "permission_changed", project_id: activeProjectId, pane_id: paneId ?? null, summary: `capability ${capability} gate=${gate}`, payload: { capability, gate, action: "exercise" } });
      } catch { /* audit is best-effort */ }
    }
    return { forbidden: gate === "Off", gate };
  }

  // rbh: build the `action_pending` WS payload for a DEFERRED (Ask) non-PTY mutator. Extracted
  // verbatim from gateOrDefer's Ask branch (behavior-preserving) so the function stays under the
  // complexity gate. It enriches the confirm-dialog payload with the EFFECTIVE posture the engine
  // WILL apply, not the nominal summary. paneId may be null for global actions (D2) — then we surface
  // the resolved global mode + the global effective gate, no per-pane chip. The RESOLUTION is the pure
  // resolveActionPendingPosture (src/actionPendingPayload) — the same override→spotlight→global
  // precedence the chip uses (D1, server is the only authority), frozen-overlaid so the dialog matches
  // the chip while STOP-ALL is engaged. LOCKSTEP with effectiveCapabilityGateFor: the pane gates come
  // from the pane's OWNING project (findPaneOwningProject), not the active project, so the dialog's
  // posture matches the gate the engine will actually enforce for a non-active-project pane.
  function buildActionPendingBroadcast(
    actionId: string,
    capability: CapabilityGate,
    paneId: string | null,
    summary: string,
    requestedMode?: string,
  ): Record<string, unknown> {
    const targetTerm = paneId ? manager.terminals[paneId] : undefined;
    const posture = resolveActionPendingPosture({
      paneId,
      capability,
      globalMode: manager.globalPermissionsMode as GlobalMode,
      paneMode: targetTerm ? (targetTerm.permissionsMode as EffectiveMode) : undefined,
      paneGates: paneId ? findPaneOwningProject(manager, paneId)?.pane.capabilityGates : undefined,
      globalGates: manager.settings.advanced?.capabilityGates,
      isActivePane: !!paneId && coreState.activePaneId === paneId,
      frozen: coreState.frozen,
    });
    return {
      type: "action_pending", actionId, capability, summary,
      pane_id: paneId,
      effective_gate: posture.effective_gate,
      effective_mode: posture.effective_mode,
      ...(posture.posture ? { posture: posture.posture } : {}),
      ...(posture.effective_gates ? { effective_gates: posture.effective_gates } : {}),
      ...(requestedMode ? { requested_mode: requestedMode } : {}),
      global_override: manager.globalPermissionsMode !== "Inherit",
    };
  }

  // G1: gate a NON-PTY mutator with full Auto/Ask/Off semantics. Unlike gateCapability (which only
  // enforced the Off veto and let Ask proceed), this DEFERS the side effect on Ask by staging
  // `run` in pendingActions; the operator confirms via POST /api/actions/:id/confirm and the effect
  // runs exactly once. Returns the disposition so the handler can answer the model appropriately.
  //   { disposition: "run" }      -> Auto: caller invokes the effect now.
  //   { disposition: "forbidden"} -> Off:  caller refuses.
  //   { disposition: "deferred", actionId, summary } -> Ask: effect staged; caller tells the model
  //                                it is awaiting operator confirmation (no side effect yet).
  function gateOrDefer(
    capability: CapabilityGate,
    paneId: string | null,
    summary: string,
    run: () => string,
    // kzt (wsm-e2e-pinned-kzt): the serializable INTENT params the `run` closure captured. When
    // present (and a durable store is wired), pendingActions.add() persists them so the deferred
    // action survives a restart; the boot loop rebuilds `run` from them via buildActionRun. Keep
    // these keys in LOCKSTEP with the per-capability param shapes in src/actionEffects.ts.
    params?: Record<string, unknown>,
    // rbh (wsm-e2e-pinned-rbh): the mode the operator asked for, passed STRUCTURALLY by the two
    // permission handlers (never parsed from the summary — R5). Forwarded to the confirm dialog as
    // `requested_mode` so it can render a divergence "heads up" when the engine resolves tighter.
    // Non-permission capabilities (create_pane) pass nothing → no mode rider.
    requestedMode?: string
  ): { disposition: "run" } | { disposition: "forbidden" } | { disposition: "deferred"; actionId: string; summary: string } {
    const gate = effectiveCapabilityGateFor(paneId, capability);
    if (gate === "Off") {
      recordActivitySafe({
        type: "permission_changed", pane_id: paneId,
        summary: `FORBIDDEN ${capability}: ${summary}`,
        payload: { capability, gate, action: "forbidden" },
      });
      return { disposition: "forbidden" };
    }
    if (gate === "Ask") {
      const actionId = `act_${Date.now()}_${pendingActionSeq++}`;
      pendingActions.add({ id: actionId, capability, summary, params, timestamp: Date.now(), run });
      recordActivitySafe({
        type: "permission_changed", pane_id: paneId,
        summary: `DEFERRED ${capability} (await confirm): ${summary}`,
        payload: { capability, gate, action: "deferred", action_id: actionId },
      });
      broadcast(buildActionPendingBroadcast(actionId, capability, paneId, summary, requestedMode));
      return { disposition: "deferred", actionId, summary };
    }
    // Auto
    return { disposition: "run" };
  }

  // ── EFFECTIVE-POSTURE SERVER TRUTH (bead 8sq, spec §3 item 1 / §5) ─────────────────────────────
  // The chips + popover render from SERVER truth — never client policy re-derivation. We resolve
  // the 16 effective gate values + the derived posture word per pane here (reusing the pure
  // gateSurface) and expose them in /api/terminals AND the terminals_updated broadcast. The frozen
  // short-circuit is reflected because effectiveCapabilityGateFor (which deriveEffectiveGates mirrors)
  // already returns Off while frozen — but deriveEffectiveGates is pure (no `frozen` arg), so we
  // overlay the same applyFrozenShortCircuit here to keep the surface in lockstep with the resolver.
  function effectiveGatesForPane(paneId: string): Record<CapabilityGate, GateValue> {
    const globalGates = manager.settings.advanced?.capabilityGates;
    // LOCKSTEP with effectiveCapabilityGateFor: the OWNING project's overrides, not the active one's.
    const paneGates = findPaneOwningProject(manager, paneId)?.pane.capabilityGates;
    const isActivePane = coreState.activePaneId === paneId;
    const base = deriveEffectiveGates(paneGates, globalGates, isActivePane);
    if (!coreState.frozen) return base;
    // Frozen overlay — mirror the resolver's single-choke-point short-circuit on the surface.
    const out = {} as Record<CapabilityGate, GateValue>;
    for (const cap of ALL_CAPABILITIES) out[cap] = applyFrozenShortCircuit(true, base[cap]);
    return out;
  }
  function posturePayloadForPane(paneId: string): { id: string; effective_gates: Record<CapabilityGate, GateValue>; posture: ReturnType<typeof derivePostureWord> } {
    const effective = effectiveGatesForPane(paneId);
    const mode = effectiveModeFor(paneId) as GateSurfaceMode;
    return { id: paneId, effective_gates: effective, posture: derivePostureWord(effective, mode) };
  }
  function allPanePostures() {
    return Object.keys(manager.terminals).map((id) => posturePayloadForPane(id));
  }
  // Single helper so every pane-state mutation broadcasts the SAME shape: a terminals_updated frame
  // carrying the per-pane posture payload (chips repaint from this without a /api/terminals refetch).
  function broadcastTerminalsUpdated() {
    broadcast({ type: "terminals_updated", postures: allPanePostures() });
  }

  // ── TWO-STAGE EMERGENCY STOP-ALL (bead 8sq, spec §2.C / §3) ───────────────────────────────────
  //
  // DELIBERATELY UNGATED — these are the ONE set of paths that do NOT route through
  // gateOrDefer/effectiveCapabilityGateFor, and that is correct, not a regression. Capability
  // gates only ever TIGHTEN; the stop-all brake is the inverse (de-escalation / withdrawing
  // autonomy). A gate set to Off must never be able to FORBID an emergency halt — that would
  // defeat the gate's own safety purpose. So an always-allowed brake is consistent with the gate
  // model, not a bypass of it. (Mirrors the directional precedent in set_capability_gate: voice may
  // always TIGHTEN/de-escalate, never LOOSEN.) Single source of truth shared by REST, WS, voice.
  function runningPaneIds(): string[] {
    return Object.entries(manager.terminals)
      .filter(([, term]) => term.status !== "Exited") // union: 'Running'|'Exited'|'Idle'
      .map(([id]) => id);
  }

  /**
   * STOP-ALL stage routine.
   *   Stage 1 (kill=false): set+persist `frozen` (gate resolver now short-circuits every capability
   *     to Off), then CANCEL EVERYTHING IN-FLIGHT — reject all pending approvals (expire), expire all
   *     deferred actions, halt running plans (paused) + enabled watch-rules (disabled). PANES AND
   *     THEIR PTYs KEEP RUNNING (spec §2.C) — the freeze is reversible; only Release clears it.
   *   Stage 2 (kill=true): terminate each running pane PTY via the existing term.stop() primitive.
   *     The deliberate, irreversible step; valid only after a Stage-1 freeze.
   * Returns the still-running pane ids (Stage 1) or the killed pane ids (Stage 2).
   * QW4 (bead qw4): Stage 2 is now ASYNC and AWAITS the kills (Promise.allSettled), so the returned
   * killed[] names panes that ACTUALLY stopped — not merely the panes we asked to kill. Panes whose
   * stop() rejects are excluded from killed[] and surfaced separately (see killAllPanes / broadcast).
   */
  // Stage-1 sub-step: halt the passive co-pilot state (running plans -> paused, enabled watch-rules
  // -> disabled) and broadcast the change. Extracted verbatim from stopAllStage1Freeze; no pane writes.
  function haltPlansAndWatchRules(): void {
    let ledgerChanged = false;
    for (const plan of manager.ledger.plans) {
      if (plan.status === "running") { plan.status = "paused"; ledgerChanged = true; }
    }
    for (const rule of manager.ledger.watchRules) {
      if (rule.enabled) { rule.enabled = false; ledgerChanged = true; }
    }
    if (ledgerChanged) {
      manager.ledger["save"]?.(true);
      broadcast({ type: "plans_updated", plans: manager.ledger.plans });
      broadcast({ type: "watch_rules_updated", watchRules: manager.ledger.watchRules });
    }
  }

  // STOP-ALL Stage 1 (kill=false): freeze + cancel everything in-flight. PANES KEEP RUNNING. Extracted
  // verbatim from stopAll's `!kill` branch (behavior-preserving) so stopAll stays a thin dispatcher.
  function stopAllStage1Freeze(): string[] {
    coreState.setFrozen(true);
    // Cancel in-flight: reject every pending approval (expire path = no write, claim+delete).
    for (const p of [...pendingApprovals.all()]) applyResolution(p.messageId, "expire");
    // Expire every deferred non-PTY action (no side effect runs).
    for (const a of [...pendingActions.all()]) pendingActions.expire(a.id);
    haltPlansAndWatchRules();
    const stillRunning = runningPaneIds();
    recordActivitySafe({
      type: "permission_changed", pane_id: null,
      summary: `STOP_ALL Stage 1: froze Janus + cancelled in-flight (${stillRunning.length} pane(s) still running)`,
      payload: { action: "stop_all_freeze", running: stillRunning },
    });
    broadcast({ type: "frozen", frozen: true, running: stillRunning });
    broadcastTerminalsUpdated();
    // 1C.3 (Phase 1 Track C): STOP-ALL must be AUDIBLE on the voice channel. Reuse the SAME injected
    // narration seam the sweep last-call uses (pushApprovalNarration + coreState.activeLiveSession) so
    // Janus is told the whole line is gated Off. No live session => nothing to narrate (UI stands).
    if (coreState.activeLiveSession) {
      pushApprovalNarration(coreState.activeLiveSession, "Stop-all engaged — the whole line is frozen until you release.");
    }
    return stillRunning;
  }

  // STOP-ALL Stage 2 (kill=true): terminate the PTYs. QW4 — AWAIT every stop() (Promise.allSettled,
  // mirroring close()'s awaited per-term stop) so we report panes that ACTUALLY stopped. Extracted
  // verbatim from stopAll's kill branch (behavior-preserving).
  async function stopAllStage2Kill(): Promise<string[]> {
    // 1C.3: narrate the irreversible step BEFORE the awaited kills (present-progressive truth).
    if (coreState.activeLiveSession) {
      pushApprovalNarration(coreState.activeLiveSession, "Stage two — running panes are being killed.");
    }
    const { killed, failed } = await killAllPanes();
    recordActivitySafe({
      type: "permission_changed", pane_id: null,
      summary: `STOP_ALL Stage 2: killed ${killed.length} pane PTY(s)${failed.length ? `; ${failed.length} kill(s) FAILED` : ""}`,
      payload: { action: "stop_all_kill", panes: killed, failed },
    });
    coreState.lastStopAllFailed = failed; // QW4: surfaced to the REST confirm route (read right after the await).
    broadcast({ type: "stop_all", killed, failed });
    broadcastTerminalsUpdated();
    return killed;
  }

  async function stopAll(kill: boolean): Promise<string[]> {
    return kill ? stopAllStage2Kill() : stopAllStage1Freeze();
  }

  /**
   * QW4 (bead qw4): the awaited Stage-2 kill primitive. Asks every non-Exited pane to stop(), AWAITS
   * all of them (Promise.allSettled — one failing kill must not abort the rest), and partitions the
   * outcome: `killed` = panes whose stop() FULFILLED; `failed` = panes whose stop() REJECTED. The
   * fire-and-forget loop this replaces reported the asked-to-kill set, which lied when a kill failed.
   */
  async function killAllPanes(): Promise<{ killed: string[]; failed: string[] }> {
    const targets = Object.entries(manager.terminals).filter(([, term]) => term.status !== "Exited");
    const results = await Promise.allSettled(targets.map(([, term]) => Promise.resolve(term.stop())));
    const killed: string[] = [];
    const failed: string[] = [];
    results.forEach((r, i) => {
      const id = targets[i][0];
      if (r.status === "fulfilled") killed.push(id);
      else { failed.push(id); console.error(`[STOP-ALL] kill ${id} failed:`, r.reason); }
    });
    return { killed, failed };
  }

  /** Clear the freeze (Release). The matrix was never mutated, so this is a clean clear. */
  function releaseStopAll(): void {
    coreState.setFrozen(false);
    if (store) {
      try {
        store.recordActivity({
          type: "permission_changed",
          project_id: manager.ledger.activeProjectId || "default_project",
          pane_id: null,
          summary: "STOP_ALL released: freeze cleared, matrix restored",
          payload: { action: "stop_all_release" },
        });
      } catch { /* store optional */ }
    }
    broadcast({ type: "frozen", frozen: false });
    broadcastTerminalsUpdated();
    // 1C.3: the release is as voice-relevant as the freeze — same injected seam.
    if (coreState.activeLiveSession) {
      pushApprovalNarration(coreState.activeLiveSession, "Stop-all released — the kitchen is back.");
    }
  }

  // WS-F reconnect digest (spec §6.2/§7): "welcome back — here's what you left in progress."
  // After a fresh live session is established, re-attach every orphaned approval (a survivor whose
  // handle was nulled by detachSession on the prior disconnect, OR a restart-hydrated row) to THIS
  // session — opening a fresh TTL window — then speak ONE batched digest across approvals + pending
  // actions and broadcast so the UI chips repopulate the FULL list. Survivors stay UN-APPROVED
  // (re-require approval): the digest only re-surfaces them for a conscious yes; nothing auto-fires.
  function reannounceSurvivors(session: any) {
    const now = Date.now();
    // (1) Re-attach every orphan approval to the freshly-connected session (fresh TTL window,
    // lastCallAt cleared). pendingActions have no session binding — they survive in-process untouched.
    for (const orphan of pendingApprovals.orphans()) {
      pendingApprovals.reattachSession(orphan, session, now + APPROVAL_TTL_MS);
    }
    // (2) Collect the survivors: re-attached approvals (now bound to this session) + ALL pending
    // actions (not session-bound, spec §6.2 includes them all). Build ONE digest line per item.
    const approvals = pendingApprovals.forSession(session);
    const actions = pendingActions.all();
    type Survivor = { line: string; ts: number };
    const survivors: Survivor[] = [
      ...approvals.map((a) => ({ line: renderResumptionLine(a, now), ts: a.timestamp })),
      ...actions.map((a) => ({ line: `${a.capability}: ${redactSecrets(a.summary)}`, ts: a.timestamp })),
    ];
    // (spec §7) zero survivors -> the SURVIVOR digest stays silent (the 4D.1 away digest below has
    // its own emptiness rule and may still speak — the operator deserves the news either way).
    if (survivors.length > 0) {
      // (3) Most-recent first; speak up to 3, summarize the rest (spec §7). UI shows the full list.
      survivors.sort((x, y) => y.ts - x.ts);
      const total = survivors.length;
      const shown = survivors.slice(0, 3).map((s) => s.line);
      let digest: string;
      if (total === 1) {
        digest = `Welcome back — one action still waiting: ${shown[0]}. Approve, or has this moved on?`;
      } else if (total <= 3) {
        digest = `Welcome back — ${total} actions waiting from before: ${shown.join("; ")}. Which first?`;
      } else {
        digest = `Welcome back — ${total} actions waiting from before: ${shown.join("; ")}; …and ${total - 3} more, all in your queue.`;
      }
      pushApprovalNarration(session, digest);
      // (4) Repopulate the UI chips for the FULL list (the spoken cap is 3; the UI is not capped).
      broadcastTerminalsUpdated();
    }

    // (5) 4D.1: AFTER the survivors digest, the since-last-session delta — "while you were away".
    // The window is CONSUMED here (in-memory + KV) whether or not anything notable happened, so a
    // flapping reconnect never replays the same news. store === null ⇒ composeAwayDigest is null
    // and this is a silent no-op (legacy parity).
    const since = lastDetachAt;
    lastDetachAt = null;
    if (store) {
      try { store.setKV(AWAY_DETACH_KV, ""); } catch { /* best-effort */ }
    }
    if (since !== null) {
      const away = composeAwayDigest(since, now);
      if (away) pushApprovalNarration(session, away);
    }
  }

  // M4: the approval-related WS-event `type:` literals, named in one place. NOTE: the frontend
  // (ApprovalDialog.tsx) keys on these EXACT strings — do NOT rename the values without changing
  // the client. The `command_auto_executed` payload has two boolean variants the UI relies on:
  //   - `approved: true`  -> operator-APPROVED a HiTL command (REST or voice) — not auto-run.
  //   - `vocal: true`     -> the approval/dispatch arrived via VOICE (vs the REST dialog).
  //   - (neither flag)    -> a genuine Full-Auto auto-execution (no operator in the loop).
  const WS_EVT = {
    APPROVAL_PENDING: "approval_pending",
    AUTO_EXECUTED: "command_auto_executed",
    BLOCKED: "command_blocked",
    // Issue E: a messageId-keyed "this pending command is resolved — clear its modal" event,
    // broadcast on EVERY non-lost_race resolve so a VOICE approval (or a cross-client REST approve,
    // or a TTL-expire sweep) dismisses the ApprovalDialog in real time instead of lingering until
    // the ~20s safety-net poll. Mirrors the action_resolved event the pendingActions flow uses.
    APPROVAL_RESOLVED: "approval_resolved",
  } as const;

  // Step 9: the resolve reasons whose handoff row must be flipped to its terminal state in the SAME
  // choke-point. Replaces the inline `reason === "approved" || ... || "dead_pane"` chain byte-for-byte
  // (lost_race / not_found are deliberately absent — they never flip a handoff). `reason` is a typed
  // ResolveReason union (never external/prototype input), so Set membership is the exact equivalent.
  const handoffFlipReasons: ReadonlySet<ResolveReason> = new Set<ResolveReason>([
    "approved", "rejected", "expired", "dead_pane",
  ]);

  // WS-E single choke-point (simplicity H1 / maintainability H1/H2/L9): the ONE place every
  // resolve path (REST approve, voice approve/reject, TTL sweep) renders the outcome of the pure
  // `resolveDecision`. The MANDATORY atomic `claim()` lives INSIDE `resolveDecision`, so no path
  // here can write without winning the claim (the sweep now goes through the SAME gate too).
  // Returns the ResolveAction so a caller can branch on the reason for its own response shape.
  // R3 (P0-1): `call.id` was already answered ONCE by the non-blocking `pending_approval`
  // response at proposal time; resolution NEVER sends a 2nd `sendToolResponse` — the model-facing
  // outcome is the `pushApprovalNarration` push only.
  // Handoff gate leg (design §5.3 / step 9): when a resolved pending approval corresponds to a
  // staged handoff (the handoff delivery uses pendingId == handoff_id; gate_approval_id also
  // tracks it), flip the persisted handoff row to its terminal/transition state in the SAME
  // resolver choke-point — one added store call, no forked path. Approve => delivered (the write
  // already landed via the approved branch); reject => rejected; expire/dead-pane => expired.
  function flipHandoffOnResolve(messageId: string, reason: ResolveReason, opts?: { vocal?: boolean }) {
    // Delegate to the EXPORTED, unit-tested resolve-leg flip (src/handoffFlow) so the lookup +
    // reason->state mapping + provenance live in ONE source of truth and are exercised end-to-end
    // against a real JanusStore without a live session. `reason` is narrowed there to the handoff
    // resolve reasons; lost_race/not_found never reach here (gated at the applyResolution call site).
    applyHandoffFlipOnResolve(store, messageId, reason as HandoffResolveReason, { vocal: opts?.vocal });
  }

  // ── applyResolution per-reason renderers ─────────────────────────────────────────────────────
  // Each switch-case body of the resolve choke-point, extracted VERBATIM (behavior-preserving) so
  // applyResolution stays a thin dispatcher under the complexity gate. They share the pre-computed
  // record / redacted instruction / verb / session, passed in. NONE of them claim or delete — the
  // mandatory atomic claim already happened inside resolveDecision before any of these run.
  type ResolvedRecord = NonNullable<ReturnType<typeof resolveDecision>["record"]>;

  // DUP-SEND FIX (approved leg): the instruction just landed on the PTY, so a WIP draft holding that
  // SAME text is now stale — a later draft Send would re-emit it. Clear it, mirroring server.ts's
  // draft/send clear. Guard on a non-empty draft that MATCHES (or contains) the dispatched
  // instruction so an UNRELATED in-progress draft for this pane is never silently destroyed.
  function clearMatchingDraftOnApprove(record: ResolvedRecord): void {
    const term = manager.terminals[record.terminalId];
    const projectId = term?.projectId;
    if (!projectId) return;
    const current = manager.ledger.getDraft(projectId, record.terminalId);
    const draftText = current?.text ?? "";
    if (
      draftText.trim().length > 0 &&
      (draftText.trim() === record.instruction.trim() || draftText.includes(record.instruction))
    ) {
      manager.ledger.setDraft(projectId, record.terminalId, "", "operator");
      broadcastDraft(projectId, record.terminalId);
    }
  }

  function renderApproved(record: ResolvedRecord, safeInstr: string, verb: string, session: any, opts?: { vocal?: boolean }): void {
    // Claim already won inside resolveDecision — this is the single write path.
    addCommand(record.terminalId, record.instruction);
    manager.terminals[record.terminalId]!.writeInput(record.instruction);
    clearMatchingDraftOnApprove(record);
    if (session) pushApprovalNarration(session, `Approving: ${verb} ${record.terminalId} — "${safeInstr}". Dispatching now.`);
    // P1-2: operator-APPROVED, not an auto-execution — flag it so the UI does not mislabel.
    broadcast({ type: WS_EVT.AUTO_EXECUTED, terminalId: record.terminalId, cmd: safeInstr, approved: true, ...(opts?.vocal ? { vocal: true } : {}) });
  }

  function renderDeadPane(record: ResolvedRecord, safeInstr: string, session: any): void {
    if (session) pushApprovalNarration(session, `That pane (${record.terminalId}) is gone — I could not dispatch the command.`);
    broadcast({ type: WS_EVT.BLOCKED, terminalId: record.terminalId, cmd: safeInstr, reason: "Target pane missing." });
  }

  function renderRejected(record: ResolvedRecord, safeInstr: string, session: any, opts?: { vocal?: boolean }): void {
    if (session) pushApprovalNarration(session, `Rejecting the command on pane ${record.terminalId}: "${safeInstr}".`);
    broadcast({ type: WS_EVT.BLOCKED, terminalId: record.terminalId, cmd: safeInstr, reason: opts?.vocal ? "Execution cancelled by operator via voice." : "Execution cancelled by operator." });
  }

  function renderExpired(record: ResolvedRecord, safeInstr: string, session: any): void {
    if (session) pushApprovalNarration(session, `The command on pane ${record.terminalId} expired after ${Math.round(APPROVAL_TTL_MS / 60000)} minutes; I cancelled it.`);
    // 1C.1: the REAL approval_expired kind — this used to borrow kind:"exited" for its severity,
    // which rendered "Pane 'x' exited." for a pane that merely lost an approval.
    announcementBus.enqueue({ kind: "approval_expired", terminalId: record.terminalId, summary: "Approval expired." });
    broadcast({ type: WS_EVT.BLOCKED, terminalId: record.terminalId, cmd: safeInstr, reason: "Approval expired (timeout)." });
  }

  function applyResolution(messageId: string, mode: ResolveMode, opts?: { vocal?: boolean }) {
    // BUG-041: read the session BEFORE resolveDecision — terminal outcomes claim+delete the record
    // and the store's delete() drops the session side-map entry with it, so a lookup after the
    // resolve always misses and every spoken read-back below would be silently skipped.
    const session = pendingApprovals.sessionFor(messageId);
    const action = resolveDecision(
      pendingApprovals,
      messageId,
      mode,
      (terminalId) => !!manager.terminals[terminalId]
    );
    const { reason, record } = action;
    if (!record) return action; // not_found: idempotent no-op
    const safeInstr = redactSecrets(record.instruction);
    const verb = record.kind === "agent_instruction" ? "direct pane" : "run on pane";

    // Dispatch the per-reason render (each helper is the verbatim former switch-case body). lost_race
    // renders NOTHING (exactly-once preserved — another resolver already won the claim and broadcast).
    switch (reason) {
      case "approved":  renderApproved(record, safeInstr, verb, session, opts); break;
      case "dead_pane": renderDeadPane(record, safeInstr, session); break;
      case "rejected":  renderRejected(record, safeInstr, session, opts); break;
      case "expired":   renderExpired(record, safeInstr, session); break;
      case "lost_race": break;
    }
    // Step 9: flip any associated handoff row in the SAME choke-point (after the write/narration).
    if (handoffFlipReasons.has(reason)) {
      flipHandoffOnResolve(messageId, reason, opts);
    }
    // Issue E: emit a messageId-keyed resolve event so EVERY client dismisses the ApprovalDialog in
    // real time — voice approvals, cross-client REST approvals, and TTL-expire/dead-pane sweeps
    // alike. lost_race is skipped: the resolver that WON the claim already broadcast for this
    // messageId, and its record fields are the authoritative ones. The client's optimistic click
    // filter still gives instant button feedback and harmlessly double-filters on this event.
    if (reason !== "lost_race") {
      broadcast({ type: WS_EVT.APPROVAL_RESOLVED, messageId, terminalId: record.terminalId, outcome: reason });
      broadcastTerminalsUpdated();
    }
    return action;
  }

  /**
   * 4D.3: the voice DEFER verb — "later" / "not now" / "skip that for now, ask me later".
   * Pre-fix those utterances hit REJECT_WEAK and applyResolution claim+DELETED the staged command,
   * unrecoverably. Defer instead RE-ARMS the TTL window and walks away:
   *   - rec.timestamp = now      → decideSweepAction measures the TTL off the in-memory timestamp,
   *                                 so the sweep treats the record as freshly staged (the durable
   *                                 expires_at stays stale, which only makes the durable expired()
   *                                 enumeration a no-op candidate each tick — decideSweepAction
   *                                 returns "none" until the re-armed window truly crosses; no new
   *                                 store method needed, and a restart falls back to the existing
   *                                 reattach-with-fresh-TTL on reconnect anyway);
   *   - lastCallAt / lastCallFailures cleared → the fresh window earns a fresh spoken last-call;
   *   - the record is NEVER claimed/deleted → a later approve/reject still resolves exactly once.
   * NO INFINITE PARKING: after MAX_DEFERRALS (3) re-arms the verb refuses further holds (the window
   * is left untouched, so the normal last-call → grace → expire flow closes the record out) and the
   * operator is told so. deferCount is an in-memory transient (parity with lastCallFailures): a
   * restart resets it, which only re-grants holds — never drops anything.
   */
  function applyDeferral(messageId: string, now: number = Date.now()): { reason: "deferred" | "defer_limit" | "not_found"; deferrals?: number } {
    const rec = pendingApprovals.get(messageId);
    if (!rec || rec.claimed) return { reason: "not_found" }; // gone or mid-resolve — nothing to hold.
    const session = pendingApprovals.sessionFor(messageId);
    const r = rec as typeof rec & { deferCount?: number };
    const count = r.deferCount ?? 0;
    if (count >= MAX_DEFERRALS) {
      if (session) {
        pushApprovalNarration(session, `I've already held "${redactSecrets(rec.instruction)}" ${MAX_DEFERRALS} times — it needs a yes or a no now, or it expires.`);
      }
      return { reason: "defer_limit", deferrals: count };
    }
    r.deferCount = count + 1;
    rec.timestamp = now;
    rec.lastCallAt = undefined;
    rec.lastCallFailures = undefined;
    recordActivitySafe({
      type: "approval_decided",
      pane_id: rec.terminalId,
      summary: `DEFERRED approval on ${rec.terminalId} (hold ${r.deferCount}/${MAX_DEFERRALS})`,
      payload: { action: "deferred", message_id: messageId, deferrals: r.deferCount },
    });
    if (session) {
      pushApprovalNarration(session, `Holding it — I'll ask again in ${Math.round(APPROVAL_TTL_MS / 60000)} minutes.`);
    }
    broadcastTerminalsUpdated(); // the chip's age just reset — repaint from server truth.
    return { reason: "deferred", deferrals: r.deferCount };
  }

  // WS-F (spec §4.1/§6.3): the sweep no longer SILENTLY auto-rejects on TTL. It drives off the pure
  // `decideSweepAction` so the timing/connectivity policy lives in ONE unit-tested place:
  //   - DISCONNECTED item -> "none": the clock is PAUSED (you cannot speak a last-call into a session
  //     that isn't there, and the spec forbids rejecting without first speaking one). The item waits,
  //     durably, until the operator returns — this is the "away at a meeting -> still there" guarantee.
  //   - CONNECTED + past TTL, no prior last-call -> "lastcall": stamp lastCallAt=now and SPEAK a
  //     context-rich last-call (renderResumptionLine + "approve now or I'll drop it"). Do NOT reject.
  //   - CONNECTED + last-call already spoken + grace elapsed -> "reject": NOW route through the
  //     UNCHANGED terminal path (applyResolution(id,"expire") -> resolveDecision claim+delete).
  // Connectivity is resolved HERE and passed in: per-record `sessionFor(id) !== undefined` for
  // approvals (the detach/re-attach seam), global `coreState.activeFrontendWs !== null` for the non-session-
  // bound pending actions. Only the TRIGGER + the connected-gate change; the reject itself stays
  // byte-for-byte (the mandatory claim gate / exactly-once / dead-pane invariants are untouched).
  // 1C.4 (Phase 1 Track C): this IS the interval callback startSweepTimer arms, and it hits
  // better-sqlite3 (pendingApprovals.expired -> store.getExpiredApprovals, plus the resolve path)
  // with synchronous throws — a transient SQLITE_BUSY on a tick was an uncaughtException that
  // killed the whole process. Guard the ENTIRE body here (not just the timer arm) so EVERY sweep
  // path — the interval tick AND any direct sweepExpiredApprovals() call — is non-fatal: log and
  // wait for the next tick (the durable rows are untouched, so nothing is lost).
  function sweepExpiredApprovals(now: number = Date.now()) {
    try {
      sweepExpiredApprovalsUnsafe(now);
    } catch (e) {
      console.error("[gating] sweep failed (non-fatal):", e);
    }
  }

  // 3V.3 (last-call ack before reject): how many CONSECUTIVE sweep ticks a last-call narration may
  // fail (while a session IS connected — both legs below only reach "lastcall" when connected) before
  // we stamp lastCallAt anyway. The pre-fix sweep stamped BEFORE narrating, and pushApprovalNarration
  // swallows send failures — so an item could auto-reject a grace after a last-call NOBODY heard.
  // Now the stamp follows a SUCCESSFUL push; while un-narrated the item stays pre-last-call and the
  // sweep retries next tick. The failure counter is IN-MEMORY ONLY (never persisted): a restart
  // resets it, which is safe because boot re-hydrates the survivors and the next (re)connect
  // re-announces them (reannounceSurvivors), re-opening a fresh last-call window anyway. The bound
  // exists so a persistently-broken TTS channel can never hold approvals open forever.
  const LAST_CALL_MAX_NARRATION_FAILURES = 3;

  // One APPROVALS-leg item: the none/lastcall/reject decision for a single expired approval. Extracted
  // VERBATIM from sweepExpiredApprovalsUnsafe (behavior-preserving) so each leg stays under the gate.
  // Connectivity is per-record (sessionFor !== undefined — the detach/re-attach seam).
  function sweepApprovalItem(pending: ReturnType<PendingApprovalStore["expired"]>[number], now: number): void {
    const isConnected = pendingApprovals.sessionFor(pending.messageId) !== undefined;
    const decision = decideSweepAction(pending, now, APPROVAL_TTL_MS, APPROVAL_GRACE_MS, isConnected);
    if (decision.action === "none") return; // not due, clock paused, or inside grace.
    if (decision.action === "lastcall") {
      // First crossing while connected: SPEAK the last-call (no reject), THEN stamp the transient —
      // only a push that actually went out starts the grace clock (3V.3).
      const session = pendingApprovals.sessionFor(pending.messageId);
      const spoken = session !== undefined
        && pushApprovalNarration(session, `${renderResumptionLine(pending, now)} — approve now or I'll drop it.`) !== false;
      if (spoken) {
        pending.lastCallAt = now;
        pending.lastCallFailures = undefined;
        broadcastTerminalsUpdated();
      } else {
        pending.lastCallFailures = (pending.lastCallFailures ?? 0) + 1;
        if (pending.lastCallFailures >= LAST_CALL_MAX_NARRATION_FAILURES) {
          // Bounded: the session is connected but narration keeps failing — stamp anyway so a
          // broken TTS never wedges the queue (the grace still applies from here).
          console.warn(`[gating] last-call narration failed ${pending.lastCallFailures}x for ${pending.messageId} — stamping the last-call anyway.`);
          pending.lastCallAt = now;
          broadcastTerminalsUpdated();
        }
      }
      return;
    }
    // decision.action === "reject": grace elapsed after the last-call -> the UNCHANGED terminal path.
    applyResolution(pending.messageId, "expire");
  }

  // One PENDING-ACTIONS-leg item: same last-call->grace shape as the approvals leg. Extracted VERBATIM.
  // Connectivity is the SAME ref used to narrate (`coreState.activeLiveSession`), resolved ONCE by the
  // caller and passed in (see the long-form rationale at the call site).
  function sweepActionItem(act: ReturnType<PendingActionStore["expired"]>[number], now: number, actionsConnected: boolean): void {
    const decision = decideSweepAction(act, now, APPROVAL_TTL_MS, APPROVAL_GRACE_MS, actionsConnected);
    if (decision.action === "none") return;
    if (decision.action === "lastcall") {
      // 3V.3: same speak-then-stamp ordering as the approvals leg. The retry counter lives on the
      // in-memory record via a structural widening (PendingAction's serialized shape is owned by
      // pendingActions.ts; the counter is a sweep-private transient, deliberately never persisted).
      const retry = act as { lastCallFailures?: number };
      const spoken = coreState.activeLiveSession !== null
        && pushApprovalNarration(coreState.activeLiveSession, `${act.capability}: ${redactSecrets(act.summary)} — approve now or I'll drop it.`) !== false;
      if (spoken) {
        act.lastCallAt = now;
        retry.lastCallFailures = undefined;
        broadcast({ type: "action_pending", actionId: act.id, capability: act.capability, summary: act.summary });
      } else {
        retry.lastCallFailures = (retry.lastCallFailures ?? 0) + 1;
        if (retry.lastCallFailures >= LAST_CALL_MAX_NARRATION_FAILURES) {
          console.warn(`[gating] last-call narration failed ${retry.lastCallFailures}x for action ${act.id} — stamping the last-call anyway.`);
          act.lastCallAt = now;
          broadcast({ type: "action_pending", actionId: act.id, capability: act.capability, summary: act.summary });
        }
      }
      return;
    }
    // decision.action === "reject": grace elapsed -> expire (claim + drop, no side effect).
    pendingActions.expire(act.id);
    broadcast({ type: "action_resolved", actionId: act.id, outcome: "expired" });
  }

  function sweepExpiredApprovalsUnsafe(now: number) {
    for (const pending of pendingApprovals.expired(APPROVAL_TTL_MS, now)) {
      sweepApprovalItem(pending, now);
    }
    // G1 + WS-F: pending actions get the SAME last-call->grace shape. Connectivity is gated on the
    // SAME ref used to narrate (`coreState.activeLiveSession`), NOT `coreState.activeFrontendWs`. The two diverge during
    // the Gemini `ai.live.connect()` handshake window: `coreState.activeFrontendWs` is set synchronously on WS
    // open, but `coreState.activeLiveSession` is only assigned AFTER the async connect resolves. If the gate
    // were `coreState.activeFrontendWs`, a sweep tick in that window could return "lastcall" (gate true), stamp
    // the one-shot `lastCallAt`, yet SKIP the narration (no live session) — and since "lastcall" never
    // re-fires once stamped, the action would later be rejected having NEVER spoken a last-call,
    // violating spec §4.1/§10 #4 ("a spoken last-call always precedes any reject"). Coupling the gate
    // to `coreState.activeLiveSession` mirrors the approval path (gate ref == narration ref). The transient
    // `lastCallAt` drives the two-phase transition; expiry stays the unchanged pendingActions.expire(id).
    const actionsConnected = coreState.activeLiveSession !== null;
    for (const act of pendingActions.expired(APPROVAL_TTL_MS, now)) {
      sweepActionItem(act, now, actionsConnected);
    }
  }

  /**
   * Arm the TTL sweep interval and return the timer so the server's close handler can clearInterval
   * it. Mirrors the inline `const approvalSweepTimer = setInterval(...)` + `.unref()` exactly — the
   * server calls this ONCE (where the inline setInterval used to run) and keeps the returned handle.
   */
  function startSweepTimer(): ReturnType<typeof setInterval> {
    const approvalSweepTimer = setInterval(sweepExpiredApprovals, APPROVAL_SWEEP_MS);
    if (typeof approvalSweepTimer.unref === "function") approvalSweepTimer.unref();
    return approvalSweepTimer;
  }

  // ── applyPaneMode: the LIVE mode-switch choke point (multi-cli adapter spec §6, bead 1y8) ──────
  // Binds the standalone applyPaneMode core to this server's real terminal + gate + pending stores +
  // broadcast + ledger persist. set_pane_permissions and the restart_pane voice tool delegate here
  // (via ctx.applyPaneMode) so a Full-Auto promotion reaches the RUNNING process and drains pending.
  async function applyPaneModeBound(
    paneId: string,
    targetMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only",
    source: "voice" | "ui" | "restart_pane",
  ): Promise<PaneModeResult> {
    const term = manager.terminals[paneId];
    if (!term) {
      return { ok: false, kind: "unsupported", reason: `Pane ${paneId} is not live; no running process to switch.` };
    }
    return applyPaneMode(paneId, targetMode, source, term, {
      gateOrDefer: (cap, pane, summary, run, params, requestedMode) =>
        gateOrDefer(cap as CapabilityGate, pane, summary, run, params, requestedMode),
      pendingApprovals,
      pendingActions,
      broadcast,
      // PERSIST-WINS (sibling of bead gpd): write operator intent to the ledger so a later syncLedger
      // won't revert it. Mirrors the legacy set_pane_permissions persist (ledger pane mode + save).
      // The persist targets the pane's OWNING project (findPaneOwningProject) — the active-project
      // lookup this replaces silently no-opped for a live pane in a non-active project.
      persistMode: (pid, mode) => {
        const owner = findPaneOwningProject(manager, pid);
        if (owner) {
          owner.pane.permissions_mode = mode;
          manager.ledger.updatePane(owner.projectId, owner.pane, true);
        }
        broadcastLedgerUpdate();
      },
    });
  }

  return {
    applyPaneMode: applyPaneModeBound,
    effectiveModeFor,
    effectiveCapabilityGateFor,
    gateCapability,
    gateOrDefer,
    effectiveGatesForPane,
    posturePayloadForPane,
    allPanePostures,
    broadcastTerminalsUpdated,
    runningPaneIds,
    stopAll,
    killAllPanes,
    releaseStopAll,
    applyResolution,
    applyDeferral,
    noteSessionDetached,
    reannounceSurvivors,
    pendingApprovals,
    pendingActions,
    sweepExpiredApprovals,
    startSweepTimer,
    shellAllowlist,
    APPROVAL_TTL_MS,
    APPROVAL_SWEEP_MS,
  };
}
