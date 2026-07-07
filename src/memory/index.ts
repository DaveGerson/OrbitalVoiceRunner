import { createHash } from "node:crypto";
import { WorldModel, type WorldModelDeps } from "./worldModel";
import { BreadcrumbRing } from "./breadcrumbs";
import { assembleBrief } from "./assembler";
import {
  DEFAULT_MEMORY_CONFIG,
  type MemoryConfig,
  type SynthesizedBrief,
  type Breadcrumb,
  type CortexCtx,
  type MemoryTiers,
  type CortexWireTrigger,
} from "./types";
import type { PythonSynthClient } from "./pythonClient";
import type { PythonCortexClient, CortexResult } from "./cortexClient";
import { isCortexPrimary, resolveWithCortex, cortexPrimaryTimeoutMs } from "./cortexShadow";
import { InjectGate, InjectGateRegistry } from "./injectGate";
import { DecisionRing } from "./decisionRing";

/** Default quiet-window for cortex hysteresis (ms). Same hash within this window → suppress. */
export const DEFAULT_CORTEX_QUIET_WINDOW_MS = 500;

/** D6 default: the inject gate's debounce floor when no getter is threaded in (matches
 *  DEFAULT_VOICE_UX.contextInjectDebounceMs — periphery wires the live settings getter). */
export const DEFAULT_INJECT_DEBOUNCE_MS = 3000;

export { WorldModel } from "./worldModel";
export { BreadcrumbRing } from "./breadcrumbs";
export * from "./types";
export * from "./pythonClient";
export { createPythonApprovalClient, type PythonApprovalClient } from "./approvalClient";
export { createPythonCortexClient, type PythonCortexClient, type CortexResult } from "./cortexClient";
export { createDaemonStateTracker, type DaemonStateTracker, type DaemonStateStats } from "./daemonStateTracker";
export { InjectGate, type InjectGateDecision, type InjectGateSkip } from "./injectGate";
export { DecisionRing } from "./decisionRing";
export type { RenderPlan } from "./assembler";
export type { CortexResolution } from "./cortexShadow";

/** Latest-wins predicate (invariant I3): a brief is only injectable if its pane is still the focus. */
export function briefIsForActivePane(briefActivePaneId: string | null, currentActivePaneId: string | null): boolean {
  return briefActivePaneId === currentActivePaneId;
}

/** B-3 measurement spine: the row shape `observeCortexShadow` hands to the durable store (the
 *  cortex decision-trace + its correlation key). Column-for-column with `store.recordCortexDecision`. */
export interface CortexDecisionSinkRow {
  ts: number;
  injectId: string | null;
  sessionId: string | null;
  activePaneId: string | null;
  trigger: string;
  ruleFired: string;
  applied: boolean;
  traceJson: string;
}

/** The fire-and-forget durable sink for cortex decisions (typically `store.recordCortexDecision`,
 *  bound at the construction site). Must be fail-soft on its own — but the caller guards it anyway. */
export type CortexDecisionSink = (row: CortexDecisionSinkRow) => void;

export class MemoryService {
  // B-6 hysteresis: suppress duplicate cortex fires within the quiet window (default 500 ms).
  private _lastSnapshotHash: string | null = null;
  private _lastCortexFiredAt: number = 0;
  // Wave 4 D4: the last HISTORY_K decide outcomes, fed to Python as CortexCtx.history so its pure
  // core can apply the resurface-suppression rule without retaining any daemon-side state.
  private readonly ring = new DecisionRing();
  // Wave 4 D2 + z5c slice 1 (spec 2026-07-07 D5): the pre-cortex inject gates, keyed per session.
  // src/voice/index.ts's injectMemoryBrief choke point calls `.evaluate` BEFORE any cortex
  // round-trip and `.noteInjected` only after a brief actually reaches Gemini. Today there is one
  // session, reached via the `gate` getter (key null); slices 2/3 pass real session ids.
  readonly gates: InjectGateRegistry;

  constructor(
    private wm: WorldModel,
    private cfg: MemoryConfig = DEFAULT_MEMORY_CONFIG,
    private pythonClient?: PythonSynthClient,
    private timeoutMs: number = 150,
    private cortexClient?: PythonCortexClient,
    private quietWindowMs: number = DEFAULT_CORTEX_QUIET_WINDOW_MS,
    // B-3 measurement spine (optional/last so every existing call site + test still compiles):
    // the durable cortex-decision sink. Absent ⇒ the SHADOW tap observes but persists nothing.
    private decisionSink?: CortexDecisionSink,
    // Wave 4 D6: the live debounce-floor getter (periphery threads
    // `() => (settings.voiceUx ?? DEFAULT_VOICE_UX).contextInjectDebounceMs`). Read fresh on every
    // gate.evaluate() call, never cached, so a settings PUT takes effect immediately.
    debounceMs: () => number = () => DEFAULT_INJECT_DEBOUNCE_MS,
  ) {
    this.gates = new InjectGateRegistry(debounceMs);
  }

  /** Today's single-session gate (registry key null). Existing call sites and tests keep working
   *  unchanged; per-session callers use `gates.forSession(id)` directly. */
  get gate(): InjectGate {
    return this.gates.forSession(null);
  }


  /** Cheap 16-hex-char SHA-256 fingerprint of an arbitrary JSON-serializable value. Shared by the
   *  whole-snapshot hysteresis hash and the per-tier hashes (D4's ctx.tierHashes). */
  private _hashOf(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
  }

  private _snapshotHash(tiers: MemoryTiers): string {
    return this._hashOf(tiers);
  }

  /** Wave 4 D2: the gate's input hash for `paneId` at `now` — the SAME machinery as the internal
   *  hysteresis hash, exposed for src/voice/index.ts's choke point to feed `gate.evaluate`. A
   *  getTiers throw yields `""` (never throws itself) — an empty-string hash can never equal a
   *  real prior injected hash, so a hashing fault fails toward INJECTING, not toward silently
   *  suppressing forever. */
  snapshotHashFor(paneId: string | null, now: number): string {
    try {
      return this._snapshotHash(this.wm.getTiers(paneId, now));
    } catch {
      return "";
    }
  }

  /** B-6 PURE check: does the cortex-shadow fire for this snapshot+timestamp? No state write —
   *  see `_advanceCortexState` (split per Wave 4 4ey so callers can advance state unconditionally,
   *  independent of whether they end up firing). Suppresses when the hash is unchanged AND elapsed
   *  time is within the quiet window (both read from state as of BEFORE this call's own advance). */
  private _shouldFireCortex(tiers: MemoryTiers, now: number): boolean {
    const hash = this._snapshotHash(tiers);
    const elapsed = now - this._lastCortexFiredAt;
    return !(this._lastSnapshotHash === hash && elapsed < this.quietWindowMs);
  }

  /** Wave 4 4ey fix: advances the hysteresis snapshot/timestamp UNCONDITIONALLY. Both
   *  `observeCortexShadow` and `synthesizeAsync` call this BEFORE branching on `isCortexPrimary()`,
   *  so the state never goes stale while primary mode is active (the pre-4ey bug: observeCortexShadow
   *  early-returned on `isCortexPrimary()` before ever touching this state, and synthesizeAsync's
   *  primary path never touched it either — a long primary-mode run left the hysteresis snapshot
   *  frozen at whatever it was before the flip, so a later flip BACK to shadow mode could misfire
   *  against ancient state). A future runtime toggle can now never inherit stale state. */
  private _advanceCortexState(tiers: MemoryTiers, now: number): void {
    this._lastSnapshotHash = this._snapshotHash(tiers);
    this._lastCortexFiredAt = now;
  }

  /** Per-tier content hashes for ALL five canonical tiers (Wave 4 D4's `CortexCtx.tierHashes`).
   *  Python never hashes — it only compares these against tierHashes recorded on prior history
   *  entries to detect a "strong trigger" (content actually changed since the tier was dropped). */
  private _allTierHashes(tiers: MemoryTiers): Record<string, string> {
    return {
      project: this._hashOf(tiers.project),
      pane: this._hashOf(tiers.pane),
      board: this._hashOf(tiers.board),
      frame: this._hashOf(tiers.frame),
      breadcrumbs: this._hashOf(tiers.breadcrumbs),
    };
  }

  /** Build the wire `CortexCtx` for one decide call — shared by the shadow and primary paths so
   *  both carry the SAME history/tierHashes/affectedPaneId shape (Wave 4 D4/D5). */
  private _buildCtx(tiers: MemoryTiers, activePaneId: string | null, trigger: string, affectedPaneId: string | null): CortexCtx {
    return {
      activePaneId,
      sessionId: null,
      trigger,
      history: this.ring.snapshot(),
      tierHashes: this._allTierHashes(tiers),
      affectedPaneId,
    };
  }

  /** Wave 4 D4: push one ring entry on EVERY successful decide (shadow hit AND primary onHit
   *  alike). `tierHashes` on the entry covers ONLY the dropped tiers (the hysteresis rule only
   *  ever needs to detect a later content change on what was dropped). */
  private _pushHistory(res: Extract<CortexResult, { ok: true }>, ctx: CortexCtx, now: number): void {
    const droppedTiers = res.decision.drop;
    const tierHashes: Record<string, string> = {};
    for (const key of droppedTiers) {
      if (ctx.tierHashes && key in ctx.tierHashes) tierHashes[key] = ctx.tierHashes[key];
    }
    this.ring.push({ droppedTiers, tierHashes, trigger: ctx.trigger, ts: now });
  }

  /** Inc 4 slice 1 (SHADOW): fire-and-forget cortex curation OBSERVATION. Builds the same tiers,
   *  asks the cortex what it WOULD curate, and LOGS the decision-trace. It NEVER blocks injection,
   *  NEVER throws, and NEVER applies the decision when NOT primary. Absent/unavailable client ⇒ a
   *  synchronous no-op. B-6 hysteresis: back-to-back calls with the identical snapshot within
   *  quietWindowMs are suppressed. 4ey: the hysteresis snapshot advances UNCONDITIONALLY, even on
   *  the `isCortexPrimary()` early-return (see `_advanceCortexState`), so state never goes stale
   *  while primary mode is active. */
  observeCortexShadow(
    activePaneId: string | null,
    now: number,
    trigger: string = "brief-inject",
    injectId: string | null = null,
    affectedPaneId: string | null = null,
  ): void {
    const client = this.cortexClient;
    if (!client || !client.available()) return;
    try {
      const tiers = this.wm.getTiers(activePaneId, now);
      const shouldFire = this._shouldFireCortex(tiers, now);
      this._advanceCortexState(tiers, now); // 4ey: advance BEFORE the isCortexPrimary early-return.
      // csw: primary path decides+records via cortexCuratedBrief; suppress the shadow hit here to
      // avoid the double daemon call.
      if (isCortexPrimary()) return;
      if (!shouldFire) return;
      const ctx = this._buildCtx(tiers, activePaneId, trigger, affectedPaneId);
      // Fire-and-forget: do NOT await. The facade never rejects, but guard the rejection arm anyway so
      // an unexpected throw can never surface as an unhandled rejection in the live loop. B-3: on a clean
      // hit, persist the decision-trace (SHADOW counterfactual, applied:false) via the durable sink, and
      // push it onto the D4 ring so a later decide sees it in `ctx.history`.
      void client.decide(tiers, ctx, now).then(
        (res) => {
          if (res.ok) {
            this._recordDecision(res, ctx, now, injectId);
            this._pushHistory(res, ctx, now);
          }
        },
        () => { /* miss — silent; parity preserved */ },
      );
    } catch {
      // getTiers (or a synchronous throw from decide) must never affect injection — swallow.
    }
  }

  /** B-3 measurement spine: persist a (would-be) cortex decision to the durable sink, keyed by
   *  `injectId`. SHADOW ⇒ `applied:false` (counterfactual); PRIMARY hit ⇒ `applied:true`.
   *  Fail-soft: a sink throw is swallowed so it can never surface as an unhandled rejection in
   *  the fire-and-forget `.then` microtask. */
  private _recordDecision(res: Extract<CortexResult, { ok: true }>, ctx: CortexCtx, now: number, injectId: string | null, applied: boolean = false): void {
    if (!this.decisionSink) return;
    try {
      this.decisionSink({
        ts: now,
        injectId,
        sessionId: ctx.sessionId ?? null,
        activePaneId: ctx.activePaneId,
        trigger: ctx.trigger,
        ruleFired: res.trace.ruleFired,
        applied,
        traceJson: JSON.stringify(res.trace),
      });
    } catch (e) {
      console.error("[cortex-shadow] decisionSink failed:", e);
    }
  }

  /** Synchronous deterministic fallback — unchanged P0a path (REST/tests + the race else-branch).
   *  Also the "no-cortex control" baseline the FLOOR invariant tests compare against — it never
   *  touches the cortex client or the synth daemon at all. */
  synthesize(activePaneId: string | null, now: number): SynthesizedBrief {
    return assembleBrief(this.wm.getTiers(activePaneId, now), this.cfg, now);
  }

  /** B-1 FLIP (default OFF): when the cortex is PRIMARY and available, ask it which tiers survive
   *  and in what order/budget, render per that plan, and stamp `source: "cortex-primary"`. Returns
   *  null on ANY miss (flag off, unavailable, timeout, ok:false, throw) so the caller falls through
   *  to the full-tier floor UNCHANGED — the parity guarantee while the flag is off (the branch is
   *  never even entered). csw: on a clean hit, records the decision as applied:true AND pushes the
   *  D4 ring entry via the onHit callback (decide runs ONCE here; observeCortexShadow is suppressed
   *  when primary to avoid the double daemon call). */
  private async cortexCuratedBrief(tiers: MemoryTiers, now: number, injectId: string | null, ctx: CortexCtx): Promise<SynthesizedBrief | null> {
    const cortex = this.cortexClient;
    if (!isCortexPrimary() || !cortex || !cortex.available()) return null;
    const onHit = (res: Extract<CortexResult, { ok: true }>) => {
      this._recordDecision(res, ctx, now, injectId, true);
      this._pushHistory(res, ctx, now);
    };
    const resolved = await resolveWithCortex(tiers, ctx, now, cortex, cortexPrimaryTimeoutMs(), onHit);
    if (!resolved) return null;
    return { ...assembleBrief(resolved.tiers, this.cfg, now, resolved.plan), source: "cortex-primary" };
  }

  /** P0b: race the Python synth daemon (≤timeoutMs) against the in-process floor; TS owns `source`
   *  (I1/I4). Extracted out of synthesizeAsync (complexity gate: each default parameter there already
   *  costs a branch, so this wave's 2 new ones needed the daemon-race body pulled out to stay ≤10). */
  private async _raceSynthDaemon(tiers: MemoryTiers, now: number, fallback: () => SynthesizedBrief): Promise<SynthesizedBrief> {
    const client = this.pythonClient;
    if (!client || !client.available()) return fallback();
    // In-flight rule: the awaited race DEPENDS on this ceiling to settle if the daemon request
    // hangs, so it holds the loop while live and is cleared as soon as the race settles.
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((res) => { timeoutTimer = setTimeout(() => res(null), this.timeoutMs); });
    let raced: Awaited<ReturnType<PythonSynthClient["request"]>> | null;
    try {
      raced = await Promise.race([client.request(tiers, this.cfg, now), timeout]);
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
    }
    if (raced && raced.ok) {
      return {
        text: raced.brief.text,
        perTierChars: raced.brief.perTierChars as Record<string, number>,
        activePaneId: raced.brief.activePaneId,
        source: "python",
      };
    }
    return fallback();
  }

  /** csw: when primary and the cortex misses, tiers are already the full floor so the synth race is
   *  pure latency — skip it and return the in-process floor immediately (+0ms vs the previous +150ms).
   *  `trigger` (Wave 4 D5, default "catch-up") is the wire-vocabulary trigger the cortex profile
   *  table branches on; `affectedPaneId` (D1) is the pane a command-outcome trigger is ABOUT. 4ey:
   *  the hysteresis snapshot advances BEFORE the primary/shadow branch, in both modes. */
  async synthesizeAsync(
    activePaneId: string | null,
    now: number,
    injectId: string | null = null,
    trigger: CortexWireTrigger = "catch-up",
    affectedPaneId: string | null = null,
  ): Promise<SynthesizedBrief> {
    try {
      const tiers = this.wm.getTiers(activePaneId, now);
      this._advanceCortexState(tiers, now); // 4ey: advance BEFORE the primary/shadow branch.
      const fallback = (): SynthesizedBrief => assembleBrief(tiers, this.cfg, now);
      // B-1: cortex-primary curation (default OFF). On a clean hit this REPLACES the synth race below
      // (the cortex already curated the tiers); on any miss it returns null and we fall through.
      const ctx = this._buildCtx(tiers, activePaneId, trigger, affectedPaneId);
      const curated = await this.cortexCuratedBrief(tiers, now, injectId, ctx);
      if (curated) return curated;
      // csw: primary + cortex-miss ⇒ tiers are already the full floor; the synth race only re-derives
      // the byte-equal floor at +150ms. Skip it.
      if (isCortexPrimary()) return fallback();
      return await this._raceSynthDaemon(tiers, now, fallback);
    } catch {
      // Last-resort floor: even if getTiers/assembleBrief throws, never reject.
      return { text: "", perTierChars: {}, activePaneId, source: "fallback" };
    }
  }

  synthesizerState(): "python" | "fallback" {
    return this.pythonClient?.synthesizerState() ?? "fallback";
  }
}

export interface CreatedMemory {
  service: MemoryService;
  breadcrumbs: BreadcrumbRing;
  addBreadcrumb: (b: Breadcrumb) => void;
}

/** Build the wired memory service. `pythonClient`/`timeoutMs` are optional (P0b); absent ⇒ pure fallback.
 *  `debounceMs` (Wave 4 D6) is the live inject-gate debounce-floor getter; absent ⇒ the gate's own
 *  default (3000ms). */
export function createMemoryService(
  deps: Omit<WorldModelDeps, "breadcrumbs">,
  cfg: MemoryConfig = DEFAULT_MEMORY_CONFIG,
  pythonClient?: PythonSynthClient,
  timeoutMs: number = 150,
  cortexClient?: PythonCortexClient,
  decisionSink?: CortexDecisionSink,
  debounceMs?: () => number,
): CreatedMemory {
  const breadcrumbs = new BreadcrumbRing(cfg);
  const wm = new WorldModel({ ...deps, breadcrumbs });
  return {
    service: new MemoryService(wm, cfg, pythonClient, timeoutMs, cortexClient, DEFAULT_CORTEX_QUIET_WINDOW_MS, decisionSink, debounceMs),
    breadcrumbs,
    addBreadcrumb: (b) => breadcrumbs.add(b),
  };
}
