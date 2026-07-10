// src/memory/worldModel.ts — the in-process raw-truth reader. Pure reads off live manager + store;
// every text field is redacted at this boundary (spec invariant). No server.ts import.
//
// Phase 2 Step 2.1 (docs/superpowers/specs/2026-07-09-agent-exchange-spine.md): enriches the
// tiers with communication facts that ALREADY EXIST in JanusStore — typed decision/warning/todo
// notes (Wave 6), command-outcome events, handoffs, and AgentExchange state/events. No new fact
// collection; this module only reads and composes what the store already durably records. Every
// new store accessor on WorldModelDeps.store is OPTIONAL (`?.`) so a caller that hands in a
// narrower store shape (a test fixture, or server.ts's `store ?? { getProject, getProjectBriefing }`
// null-store fallback) still typechecks and behaves as a graceful "nothing to enrich with" no-op —
// see tests/test_memory_worldmodel.ts's fakeDeps(), which deliberately never grows these methods.
import type { BreadcrumbRing } from "./breadcrumbs";
import type { MemoryTiers, ProjectTier, PaneTier, BoardEntry, JanusFrame, EventFocusTier } from "./types";

/** A minimal note shape (StoredNote, src/store/types.ts) — duplicated narrowly here so this
 *  module has zero import coupling to src/store/*, matching the existing WorldModelDeps style. */
interface NoteLike {
  id: string; text: string; created_at: number;
  bead_status?: "proposed" | "created" | "denied" | null;
}
/** A minimal event shape (StoredEvent, src/store/eventTypes.ts). */
interface EventLike { id: number; ts: number; summary: string; }
/** A minimal handoff shape (StoredHandoff, src/store/types.ts). */
interface HandoffLike { id: string; state: string; composed_prompt: string; created_at: number; staged_at: number | null; }
/** A minimal AgentExchange row shape (src/exchanges/types.ts). */
interface ExchangeLike {
  exchange_id: string; state: string; created_at: number;
  result_summary: string | null; terminal_state: string | null; distilled_instruction: string;
}
/** A minimal ExchangeEvent row shape (src/exchanges/types.ts). */
interface ExchangeEventLike { event_id: number; event_type: string; payload_redacted_json: string; ts: number; }

export interface WorldModelDeps {
  manager: {
    activeId: string | null;
    terminals: Record<string, { name?: string; runtimeType?: string; status?: string; lastCommand?: string | null }>;
    ledger: { activeProjectId?: string | null };
    settings: { globalPermissionsMode?: string };
    listPanes: () => Array<{ project_id: string; panes: Array<{ pane_id: string; name?: string; last_known_state?: string }> }>;
  };
  store: {
    getProject: (id: string) => any | null;
    getProjectBriefing: (id: string) => any | null;
    /** Phase 2 Step 2.1: typed notes (Wave 6 NoteType). Mirrors JanusStore.getNotes. */
    getNotes?: (filter: { projectId?: string; paneId?: string; type?: string }) => NoteLike[];
    /** Command-outcome events (and any other `events` row). Mirrors JanusStore.getEvents. */
    getEvents?: (filter: { projectId?: string; paneId?: string; type?: string; limit?: number }) => EventLike[];
    /** Handoffs targeting a pane. Mirrors JanusStore.listHandoffs. */
    listHandoffs?: (filter: { workspaceId?: string; toPane?: string; state?: string }) => HandoffLike[];
    /** Every AgentExchange ever created for a pane (oldest-first). Mirrors JanusStore.listExchangesByPane. */
    listExchangesByPane?: (paneId: string) => ExchangeLike[];
    /** One exchange's ordered event timeline. Mirrors JanusStore.listExchangeEvents. */
    listExchangeEvents?: (exchangeId: string) => ExchangeEventLike[];
  };
  redact: (s: string) => string;
  breadcrumbs: BreadcrumbRing;
}

/** One candidate entry for PaneTier.recent / EventFocusTier.eventText — `ts`/`tie` are ONLY used
 *  for deterministic ordering, never rendered, so sorting on them can never inject clock/id churn
 *  into the hashed/rendered text (hash-stability invariant). */
interface RecentCandidate { ts: number; tie: string; text: string; }

/** Bounds — reviewable defaults, not magic numbers (mirrors breadcrumbMax's role for breadcrumbs). */
const PROJECT_LIST_MAX = 8;
const PANE_RECENT_MAX = 8;
const EXCHANGES_PER_PANE_SCAN = 5;

/** exchange_events types that count as a pane "outcome" worth surfacing in PaneTier.recent /
 *  EventFocusTier (needs_input_detected is handled separately — it gets its own "Needs input:"
 *  label rather than the generic "Exchange <type>:" one). */
const RELEVANT_EXCHANGE_EVENTS = new Set([
  "agent_completion_reported", "agent_failure_reported", "delivery_succeeded", "exchange_cancelled",
]);

/** Terminal AgentExchange states (spec §1.1) — excluded from "current in-flight exchange". */
const TERMINAL_EXCHANGE_STATES = new Set(["agent_complete", "agent_failed", "cancelled"]);

/** Human-readable waiting reason per in-flight exchange state, or absent (null) when the state
 *  doesn't imply the operator/agent is waiting on anything in particular. */
const WAITING_REASONS: Record<string, string> = {
  needs_input: "needs input",
  awaiting_approval: "awaiting approval",
  awaiting_clarification: "awaiting clarification",
};

/** Newest-first sort with a deterministic secondary tiebreak (string compare, descending) so two
 *  calls against the SAME store state always produce the SAME order — required for the
 *  snapshot-hash stability invariant (no reliance on unstable sort / insertion order). */
function sortDeterministic<T>(items: T[], ts: (t: T) => number, tie: (t: T) => string): T[] {
  return [...items].sort((a, b) => {
    const d = ts(b) - ts(a);
    if (d !== 0) return d;
    const ta = tie(a), tb = tie(b);
    return ta < tb ? 1 : ta > tb ? -1 : 0;
  });
}

/** Best-effort extraction of a human-readable detail string from an exchange_events
 *  `payload_redacted_json` blob — `detail` (pane-signal payloads) then `reason` (cancellation).
 *  Malformed/absent JSON never throws; it just yields no detail. */
function extractPayloadDetail(json: string | undefined): string | null {
  if (!json) return null;
  try {
    const p = JSON.parse(json);
    if (p && typeof p.detail === "string") return p.detail;
    if (p && typeof p.reason === "string") return p.reason;
  } catch { /* malformed payload — treated as no detail, never thrown */ }
  return null;
}

export class WorldModel {
  constructor(private deps: WorldModelDeps) {}

  // ── typed notes (project-level: decisions / warnings / open todos) ───────────────────────────

  private notesOfType(projectId: string, type: string): NoteLike[] {
    const notes = this.deps.store.getNotes?.({ projectId, type }) ?? [];
    return sortDeterministic(notes, n => n.created_at, n => n.id);
  }

  private redactedTexts(notes: NoteLike[], max: number): string[] {
    return notes.slice(0, max).map(n => this.deps.redact(n.text));
  }

  /** Open todos: type=todo notes NOT already promoted to a bead (bead_status "created" means the
   *  work is now tracked as a bead, so it's no longer an "open" note-level todo). */
  private openTodoNotes(projectId: string): NoteLike[] {
    return this.notesOfType(projectId, "todo").filter(n => n.bead_status !== "created");
  }

  // ── AgentExchange state (board enrichment + event focus) ─────────────────────────────────────

  private currentExchangeForPane(paneId: string): ExchangeLike | null {
    const open = (this.deps.store.listExchangesByPane?.(paneId) ?? [])
      .filter(x => !TERMINAL_EXCHANGE_STATES.has(x.state));
    if (!open.length) return null;
    return sortDeterministic(open, x => x.created_at, x => x.exchange_id)[0];
  }

  private exchangeStateForPane(paneId: string): { state: string | null; waitingReason: string | null } {
    const cur = this.currentExchangeForPane(paneId);
    if (!cur) return { state: null, waitingReason: null };
    return { state: cur.state, waitingReason: WAITING_REASONS[cur.state] ?? null };
  }

  // ── pane "recent" candidates (command outcomes + exchange events + handoffs) ─────────────────

  private commandOutcomeCandidates(paneId: string): RecentCandidate[] {
    const events = this.deps.store.getEvents?.({ paneId, type: "command_outcome" }) ?? [];
    return events.map(e => ({ ts: e.ts, tie: `evt:${e.id}`, text: `Outcome: ${this.deps.redact(e.summary || "")}` }));
  }

  private handoffCandidates(paneId: string): RecentCandidate[] {
    const handoffs = this.deps.store.listHandoffs?.({ toPane: paneId }) ?? [];
    return handoffs.map(h => ({
      ts: h.staged_at ?? h.created_at,
      tie: `ho:${h.id}`,
      text: `Handoff ${h.state}: ${this.deps.redact((h.composed_prompt || "").slice(0, 160))}`,
    }));
  }

  /** One exchange_events row -> zero or one RecentCandidate, per the label rules above. */
  private candidateForExchangeEvent(ex: ExchangeLike, ev: ExchangeEventLike): RecentCandidate | null {
    if (ev.event_type === "needs_input_detected") {
      const detail = extractPayloadDetail(ev.payload_redacted_json) ?? "input requested";
      return { ts: ev.ts, tie: `xev:${ev.event_id}`, text: `Needs input: ${this.deps.redact(detail)}` };
    }
    if (!RELEVANT_EXCHANGE_EVENTS.has(ev.event_type)) return null;
    const detail = extractPayloadDetail(ev.payload_redacted_json)
      ?? (ev.event_type === "agent_completion_reported" ? ex.result_summary : null)
      ?? ex.terminal_state
      ?? ex.distilled_instruction
      ?? "";
    return { ts: ev.ts, tie: `xev:${ev.event_id}`, text: `Exchange ${ev.event_type}: ${this.deps.redact(detail)}` };
  }

  private exchangeEventCandidates(paneId: string): RecentCandidate[] {
    const exchanges = sortDeterministic(
      this.deps.store.listExchangesByPane?.(paneId) ?? [],
      x => x.created_at, x => x.exchange_id,
    ).slice(0, EXCHANGES_PER_PANE_SCAN);
    const out: RecentCandidate[] = [];
    for (const ex of exchanges) {
      const events = this.deps.store.listExchangeEvents?.(ex.exchange_id) ?? [];
      for (const ev of events) {
        const cand = this.candidateForExchangeEvent(ex, ev);
        if (cand) out.push(cand);
      }
    }
    return out;
  }

  private paneRecentCandidates(paneId: string): RecentCandidate[] {
    return [
      ...this.commandOutcomeCandidates(paneId),
      ...this.exchangeEventCandidates(paneId),
      ...this.handoffCandidates(paneId),
    ];
  }

  private getPaneRecent(paneId: string): string[] {
    return sortDeterministic(this.paneRecentCandidates(paneId), c => c.ts, c => c.tie)
      .slice(0, PANE_RECENT_MAX)
      .map(c => c.text);
  }

  // ── tiers ──────────────────────────────────────────────────────────────────────────────────

  getProjectTier(projectId: string): ProjectTier | null {
    const ws = this.deps.store.getProject(projectId);
    if (!ws) return null;
    return {
      projectId,
      name: ws.name ?? projectId,
      summary: this.deps.redact(ws.summary ?? ""),
      keyTerms: Array.isArray(ws.key_terms) ? ws.key_terms : [],
      recentDecisions: this.redactedTexts(this.notesOfType(projectId, "decision"), PROJECT_LIST_MAX),
      warnings: this.redactedTexts(this.notesOfType(projectId, "warning"), PROJECT_LIST_MAX),
      openTodos: this.redactedTexts(this.openTodoNotes(projectId), PROJECT_LIST_MAX),
    };
  }

  getPaneTier(paneId: string): PaneTier | null {
    const t = this.deps.manager.terminals[paneId];
    if (!t) return null;
    return {
      paneId,
      name: t.name ?? paneId,
      runtimeType: t.runtimeType ?? "",
      status: t.status ?? "Idle",
      lastCommand: t.lastCommand ? this.deps.redact(t.lastCommand) : null,
      recent: this.getPaneRecent(paneId),
    };
  }

  getBoardTier(): BoardEntry[] {
    const out: BoardEntry[] = [];
    for (const grp of this.deps.manager.listPanes()) {
      for (const p of grp.panes) {
        const { state, waitingReason } = this.exchangeStateForPane(p.pane_id);
        out.push({
          paneId: p.pane_id, name: p.name ?? p.pane_id, status: p.last_known_state ?? "Idle",
          exchangeState: state, waitingReason,
        });
      }
    }
    return out;
  }

  getJanusFrameTier(): JanusFrame {
    return {
      role: "Janus — voice orchestrator for live CLI panes",
      gatePosture: this.deps.manager.settings.globalPermissionsMode ?? "Human-in-the-Loop",
      prefs: [],
    };
  }

  /** Phase 2 Step 2.1: the background-pane "event focus" block. `null` when there is no affected
   *  pane, or it IS the active pane (the ordinary ACTIVE PANE tier already covers that case), or
   *  the pane is unknown to the live manager. */
  getEventFocusTier(affectedPaneId: string | null, activePaneId: string | null): EventFocusTier | null {
    if (!affectedPaneId || affectedPaneId === activePaneId) return null;
    const t = this.deps.manager.terminals[affectedPaneId];
    if (!t) return null;
    const candidates = sortDeterministic(this.paneRecentCandidates(affectedPaneId), c => c.ts, c => c.tie);
    const { state, waitingReason } = this.exchangeStateForPane(affectedPaneId);
    return {
      paneId: affectedPaneId,
      name: t.name ?? affectedPaneId,
      eventText: candidates[0]?.text ?? "",
      exchangeState: state,
      waitingReason,
    };
  }

  /** `affectedPaneId` (Wave 4 D1 wiring, Phase 2 Step 2.1): the pane a command-outcome/background
   *  trigger is ABOUT, independent of `activePaneId`. Optional + defaults to null so every
   *  pre-existing call site (the pure `synthesize()` fallback, `snapshotHashFor`) keeps its exact
   *  prior behavior — eventFocus only ever appears when a caller explicitly supplies it. */
  getTiers(activePaneId: string | null, now: number, affectedPaneId: string | null = null): MemoryTiers {
    const projectId = this.deps.manager.ledger.activeProjectId ?? "";
    return {
      project: projectId ? this.getProjectTier(projectId) : null,
      pane: activePaneId ? this.getPaneTier(activePaneId) : null,
      board: this.getBoardTier(),
      frame: this.getJanusFrameTier(),
      breadcrumbs: this.deps.breadcrumbs.recent(now),
      eventFocus: this.getEventFocusTier(affectedPaneId, activePaneId),
    };
  }
}
