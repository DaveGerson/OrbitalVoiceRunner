// src/voice/policyClient.ts — the typed facade over the "policies" Python daemon (voice-UX wave 3,
// scaffold-owned). Sibling of src/memory/approvalClient.ts / synthFacadeOverCore: it owns ONLY the
// wire mapping for the two new ops (focus.resolve, sitrep.rank) and validates raw responses with the
// zod schemas below. It rides an EXISTING PythonModuleClient core (server.ts builds a SECOND core,
// moduleName:"policies") — this file never spawns a daemon itself.
//
// FALLBACK CONTRACT (binding, D2): resolveFocus/rankSitrep resolve `null` on ANY miss — daemon down,
// breaker open, timeout, `ok:false`, or a schema reject. They NEVER reject. Callers MUST treat null as
// "use the TS fallback" and MUST NOT widen matching/ordering beyond the deterministic TS floor. A dead
// daemon dulls the experience (loses the fuzzy/ranked layer), never breaks it (never fails open).
import { z } from "zod";
import type { ModuleResponse, PythonModuleClient } from "../memory/pythonClient";
import { WIRE_VERSION } from "../memory/types";
import type { NoteType } from "../store/types";

/** The four NoteType values classify_note may emit (a SUBSET of NoteType — NEVER "handoff"). The
 *  zod enum below pins the wire to exactly this set so a drifted daemon can never inject an
 *  out-of-taxonomy type; the client falls open to "note" on any miss. */
export const CLASSIFIABLE_NOTE_TYPES = ["decision", "todo", "warning", "note"] as const;
export type ClassifiableNoteType = (typeof CLASSIFIABLE_NOTE_TYPES)[number];

/** Per-call race bound (D2). Overridable via `opts.timeoutMs` (tests only — production always uses
 *  the default). Kept small: a slow/absent daemon must never be perceptible as voice latency. */
export const POLICY_OP_TIMEOUT_MS = 300;

/** One candidate pane the operator might mean by a spoken reference ("the build pane", "pane two"). */
export interface FocusCandidate {
  paneId: string;
  paneName: string;
  projectId: string;
  projectName: string;
  presetLabel: string | null;
  ordinal: number;      // 1-based display order
  state: string;         // status word
  isBusy: boolean;
  lastActiveAt: number;  // epoch ms, term.lastStatusChangeAt
  isActive: boolean;
}

/** The resolved (or unresolved) focus target for a spoken reference. */
export interface FocusResolution {
  paneId: string | null;
  confidence: number; // 0..1
  alternatives: Array<{ paneId: string; score: number }>; // top 2-3, desc
}

/** The renderer-agnostic gather of everything a SITREP might narrate (D3). NO prose — a pure payload. */
export interface SitrepPayload {
  now: number;
  panes: Array<{
    paneId: string;
    projectId: string;
    name: string;
    state: string;
    isBusy: boolean;
    elapsedMs: number;
    lastCommand: string | null; // ALREADY redacted by the composer
  }>;
  approvals: Array<{
    id: string;
    kind: string;
    paneId: string | null;
    summary: string; // ALREADY redacted
  }>;
  attention: Array<{
    paneId: string;
    type: string;
    message: string;
    ageMs: number;
  }>;
  plans: Array<{
    id: string;
    name: string;
    status: string;
    currentStepIndex: number;
    totalSteps: number;
  }>;
}

/** The prioritized section ordering a SITREP renders. Needs-action first; "busy" also carries
 *  executing-plan progress items (resolved decision — see the wave-3 spec's risk #6). */
export interface SitrepRanking {
  sections: Array<{ key: "approvals" | "busy" | "attention" | "idle"; itemIds: string[] }>;
}

/** One stored macro phrase the daemon matches a routed utterance against (id + trigger phrase). */
export interface MacroPhraseEntry {
  id: string;
  phrase: string;
}

// ── z5c design (spec 2026-07-07-z5c-session-pool-design.md D3): pool.plan ──────────────────────
// Python DECIDES per-project session-pool membership (hot/warm/handle); TS keeps all socket I/O.
// Same wire shape + versioning + 300ms race + null-on-ANY-miss fallback contract as every other op
// in this file — see PythonPolicyClient's class doc above. The TS-side FAIL-CLOSED FLOOR (D6) lives
// in src/voice/sessionPool.ts (SessionPool.floorPlan), NOT here — this facade only ever returns the
// daemon's real answer or null; it never invents a floor plan itself (single-responsibility, mirrors
// resolveFocus/rankSitrep leaving their TS fallback to the caller).

/** One (project_id -> pool entry) snapshot row fed to pool.plan (spec D3's `entries[projectId]`). */
export interface PoolPlanEntrySnapshot {
  state: "hot-foreground" | "hot-warm" | "handle" | "cold";
  handleAgeMs: number | null;
  handleTtlMs: number | null;
  lastEventAtMs: number | null;
  lastSwitchAtMs: number | null;
}

/** The TS-composed health snapshot pool.plan reasons over (spec D3's request `snapshot` field). */
export interface PoolPlanSnapshot {
  projects: string[];
  foregroundProjectId: string | null;
  hotSlotBudget: number;
  entries: Record<string, PoolPlanEntrySnapshot>;
}

export type PoolPlanActionType = "promote" | "demote" | "resume" | "fresh" | "evict";

export interface PoolPlanAction {
  type: PoolPlanActionType;
  projectId: string;
  reason: string;
}

/** The daemon's deterministic slot assignment for THIS snapshot (spec D3's response `plan`). */
export interface PoolPlan {
  foregroundProjectId: string | null;
  hotSlots: string[];
  actions: PoolPlanAction[];
}

/** The macro.match result: the matched macro id, or null when the daemon RAN but found no match. */
export interface MacroMatch {
  id: string | null;
}

export interface PythonPolicyClient {
  /** Resolve a spoken reference against the live candidate set. Resolves null on ANY miss — see the
   *  FALLBACK CONTRACT above. NEVER rejects. */
  resolveFocus(reference: string, candidates: FocusCandidate[]): Promise<FocusResolution | null>;
  /** Rank a SITREP payload into prioritized sections. Resolves null on ANY miss. NEVER rejects. */
  rankSitrep(payload: SitrepPayload): Promise<SitrepRanking | null>;
  /** Match a routed utterance against stored macro phrases (normalized exact + bounded fuzzy).
   *  Resolves null on ANY miss (down/timeout/schema/ok:false) — the caller falls to the TS exact
   *  floor. A RAN daemon resolves { id } (id null = definitive no-match). NEVER rejects, NEVER fails
   *  open (a daemon error is a null, not a match). Same fallback contract as resolveFocus.
   *  OPTIONAL on the interface (like ctx.policies itself) so pre-macro test doubles stay valid; the
   *  production facade (createPythonPolicyClient) always implements it, and a caller treats an absent
   *  method exactly like a daemon miss (the TS exact floor). */
  matchMacro?(utterance: string, entries: MacroPhraseEntry[]): Promise<MacroMatch | null>;
  /** Classify a note's text into a NoteType (decision|todo|warning|note). Resolves null on ANY miss
   *  (down/timeout/schema/ok:false) — the caller MUST fall open to "note" so classification NEVER
   *  blocks or delays note capture. NEVER rejects, NEVER emits "handoff" or an out-of-taxonomy value
   *  (the wire enum is pinned to the four-value subset). Same fallback contract as resolveFocus.
   *  OPTIONAL on the interface (like matchMacro) so pre-hwu.3 test doubles stay valid. */
  classifyNote?(text: string): Promise<ClassifiableNoteType | null>;
  /** z5c design D3: ask the daemon which projects should be hot/warm/handle right now. Resolves
   *  null on ANY miss (down/timeout/schema/ok:false) — the caller (SessionPool.planPool) MUST
   *  fall back to the D6 fail-closed floor (foreground-only, no hot-warm slots) on null, exactly
   *  like every other op's fallback contract on this facade. NEVER rejects. OPTIONAL on the
   *  interface (like matchMacro/classifyNote) so pre-z5c test doubles stay valid. */
  planPool?(snapshot: PoolPlanSnapshot): Promise<PoolPlan | null>;
  /** True only when the shared daemon has pinged and the breaker is closed. */
  available(): boolean;
  /** Tear down the shared core (idempotent — call once for all facades over that core). */
  dispose(): void;
}

// ── wire response schemas (op-local; validated against the raw ModuleResponse object) ─────────────

const FocusResolutionSchema = z.object({
  paneId: z.string().nullable(),
  confidence: z.number(),
  alternatives: z.array(z.object({ paneId: z.string(), score: z.number() })),
});

const FocusResolveResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    id: z.string(),
    v: z.literal(WIRE_VERSION),
    ok: z.literal(true),
    resolution: FocusResolutionSchema,
  }),
  z.object({
    id: z.string(),
    v: z.literal(WIRE_VERSION),
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

const SitrepRankingSchema = z.object({
  sections: z.array(
    z.object({
      key: z.enum(["approvals", "busy", "attention", "idle"]),
      itemIds: z.array(z.string()),
    }),
  ),
});

const SitrepRankResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    id: z.string(),
    v: z.literal(WIRE_VERSION),
    ok: z.literal(true),
    ranking: SitrepRankingSchema,
  }),
  z.object({
    id: z.string(),
    v: z.literal(WIRE_VERSION),
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

const MacroMatchSchema = z.object({
  id: z.string().nullable(),
  score: z.number(),
});

const MacroMatchResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    id: z.string(),
    v: z.literal(WIRE_VERSION),
    ok: z.literal(true),
    match: MacroMatchSchema,
  }),
  z.object({
    id: z.string(),
    v: z.literal(WIRE_VERSION),
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

const NoteClassifyResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    id: z.string(),
    v: z.literal(WIRE_VERSION),
    ok: z.literal(true),
    type: z.enum(CLASSIFIABLE_NOTE_TYPES),
  }),
  z.object({
    id: z.string(),
    v: z.literal(WIRE_VERSION),
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

const PoolPlanActionSchema = z.object({
  type: z.enum(["promote", "demote", "resume", "fresh", "evict"]),
  projectId: z.string(),
  reason: z.string(),
});

const PoolPlanSchema = z.object({
  foregroundProjectId: z.string().nullable(),
  hotSlots: z.array(z.string()),
  actions: z.array(PoolPlanActionSchema),
});

const PoolPlanResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    id: z.string(),
    v: z.literal(WIRE_VERSION),
    ok: z.literal(true),
    plan: PoolPlanSchema,
    trace: z.unknown().optional(),
  }),
  z.object({
    id: z.string(),
    v: z.literal(WIRE_VERSION),
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

/** Race one core.request against `timeoutMs`; resolves null on timeout (the timer never rejects, so
 *  a slow daemon just loses the race — no unhandled rejection, no throw). */
async function raceRequest(
  core: PythonModuleClient,
  op: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<ModuleResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  if (timer && typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }
  try {
    return await Promise.race([core.request(op, payload), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Build the policy facade over an EXISTING shared core (does NOT dispose it unless the returned
 *  `dispose()` is called — mirrors synthFacadeOverCore's ownership contract). */
export function createPythonPolicyClient(
  core: PythonModuleClient,
  opts?: { timeoutMs?: number },
): PythonPolicyClient {
  const timeoutMs = opts?.timeoutMs ?? POLICY_OP_TIMEOUT_MS;
  return {
    available() { return core.available(); },
    async resolveFocus(reference, candidates) {
      const obj = await raceRequest(core, "focus.resolve", { reference, candidates }, timeoutMs);
      if (!obj) return null;
      const parsed = FocusResolveResponseSchema.safeParse(obj);
      if (!parsed.success || !parsed.data.ok) return null;
      const r = parsed.data.resolution;
      // Rebuilt field-by-field (rather than trusting the zod-inferred shape verbatim) so this facade's
      // public FocusResolution contract is independent of any zod version's exact inference quirks.
      return {
        paneId: r.paneId,
        confidence: r.confidence,
        alternatives: r.alternatives.map((a) => ({ paneId: a.paneId, score: a.score })),
      };
    },
    async rankSitrep(payload) {
      const obj = await raceRequest(core, "sitrep.rank", { payload }, timeoutMs);
      if (!obj) return null;
      const parsed = SitrepRankResponseSchema.safeParse(obj);
      if (!parsed.success || !parsed.data.ok) return null;
      const rk = parsed.data.ranking;
      return {
        sections: rk.sections.map((s) => ({ key: s.key, itemIds: [...s.itemIds] })),
      };
    },
    async matchMacro(utterance, entries) {
      const obj = await raceRequest(core, "macro.match", { utterance, entries }, timeoutMs);
      if (!obj) return null;
      const parsed = MacroMatchResponseSchema.safeParse(obj);
      if (!parsed.success || !parsed.data.ok) return null;
      // Rebuilt field-by-field (independent of any zod-inference quirk), mirroring resolveFocus.
      return { id: parsed.data.match.id };
    },
    async classifyNote(text) {
      const obj = await raceRequest(core, "note.classify", { text }, timeoutMs);
      if (!obj) return null;
      const parsed = NoteClassifyResponseSchema.safeParse(obj);
      if (!parsed.success || !parsed.data.ok) return null;
      // The enum-validated `type` is one of the four allowed values; return it verbatim.
      return parsed.data.type;
    },
    async planPool(snapshot) {
      const obj = await raceRequest(core, "pool.plan", { snapshot }, timeoutMs);
      if (!obj) return null;
      const parsed = PoolPlanResponseSchema.safeParse(obj);
      if (!parsed.success || !parsed.data.ok) return null;
      const p = parsed.data.plan;
      // Rebuilt field-by-field (independent of any zod-inference quirk), mirroring resolveFocus.
      return {
        foregroundProjectId: p.foregroundProjectId,
        hotSlots: [...p.hotSlots],
        actions: p.actions.map((a) => ({ type: a.type, projectId: a.projectId, reason: a.reason })),
      };
    },
    dispose() { core.dispose(); },
  };
}
