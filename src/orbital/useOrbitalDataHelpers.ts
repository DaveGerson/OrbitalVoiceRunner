// ── ORBITAL · pure helpers for the live data spine ───────────────────────
// Behavior-preserving extractions out of useOrbitalData.ts, pulled into a sibling MODULE so the
// node test runner can import the REAL helpers without dragging in React/Vite-only deps. Every
// function here is PURE (no React, no fetch, no setState) — it computes a value or a decision the
// hook then applies. Cyclomatic-complexity burndown only; no logic was changed.
import { extractSlots } from "../templates";
import type { PendingCommand, PendingActionView } from "../types";
import type { TemplateView, PaneHistoryEntry } from "./useOrbitalData";
import type { HandoffState, StoredHandoff } from "../store/types";

// ── handleObserveFrame helpers ───────────────────────────────────────────

/** templates_updated: project the RAW ledger rows the server broadcasts into TemplateView rows,
 *  re-deriving `slots` through the same pure engine the server projects with (extractSlots).
 *  Returns null when the frame carries no array (the caller then degrades to a refetch). */
export function projectTemplatesFrame(msg: { templates?: unknown }): TemplateView[] | null {
  if (!Array.isArray(msg.templates)) return null;
  return (msg.templates as { id?: unknown; name?: unknown; description?: unknown; body?: unknown; created_at?: unknown; updated_at?: unknown }[])
    .filter((t) => t && typeof t.id === "string" && typeof t.body === "string")
    .map((t) => ({
      id: t.id as string, name: String(t.name ?? ""), description: String(t.description ?? ""),
      body: t.body as string, slots: extractSlots(t.body as string),
      created_at: Number(t.created_at ?? 0), updated_at: Number(t.updated_at ?? 0),
    }));
}

/** history_updated: the per-pane history mirror value. The frame carries the full array; a frame
 *  without one yields entries:null (which tells the burner to refetch). */
export function historyEntriesFromFrame(msg: { history?: unknown }): PaneHistoryEntry[] | null {
  return Array.isArray(msg.history) ? (msg.history as PaneHistoryEntry[]) : null;
}

/** draft_updated: the WIP draft text for a pane (always a string; missing/non-string → ""). */
export function draftTextFromFrame(msg: { draft?: { text?: unknown } }): string {
  return typeof msg.draft?.text === "string" ? msg.draft.text : "";
}

/** handoffs_updated (j4e1): the full handoffs board the server broadcasts on every lifecycle mutation.
 *  Adopt it directly when present, else null so the caller degrades to a refetch (GET /api/handoffs) —
 *  the SAME adopt-or-refetch contract as plans_updated / templates_updated / history_updated. An empty
 *  array is a real value (the workspace genuinely has no handoffs), NOT a refetch signal. */
export function handoffsFromFrame(msg: { handoffs?: unknown }): StoredHandoff[] | null {
  return Array.isArray(msg.handoffs) ? (msg.handoffs as StoredHandoff[]) : null;
}

// Tiny field coercers for the handoff normalizer — each keeps the per-field branch OUT of the row
// builder so `normalizeHandoffRows` stays well under the complexity gate. All pure.
const hStr = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const hStrOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);
const hNum = (v: unknown, fallback = 0): number => (typeof v === "number" ? v : fallback);
const hNumOrNull = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** True iff a row carries a usable id (`id` or the REST projection's `handoff_id`) AND a to_pane. */
function hasUsableHandoffId(r: Record<string, unknown>): boolean {
  const id = r.id ?? r.handoff_id;
  return typeof id === "string" && !!id && typeof r.to_pane === "string" && !!r.to_pane;
}

/** Build ONE StoredHandoff from a raw row (each field through a tiny coercer — see hasUsableHandoffId
 *  for the precondition). Extracted from normalizeHandoffRows to keep that mapper under the gate. */
function buildHandoffRow(r: Record<string, unknown>): StoredHandoff {
  return {
    id: String(r.id ?? r.handoff_id),
    workspace_id: hStr(r.workspace_id),
    from_pane: hStrOrNull(r.from_pane),
    to_pane: String(r.to_pane),
    kind: hStr(r.kind, "agent_instruction") as StoredHandoff["kind"],
    composed_prompt: hStr(r.composed_prompt),
    source_context: hStr(r.source_context),
    source_context_refs: hStr(r.source_context_refs),
    state: hStr(r.state, "composing") as HandoffState,
    gate_approval_id: hStrOrNull(r.gate_approval_id),
    approved_by: hStrOrNull(r.approved_by),
    approved_via: hStrOrNull(r.approved_via),
    revision_count: hNum(r.revision_count),
    created_at: hNum(r.created_at),
    staged_at: hNumOrNull(r.staged_at),
    delivered_at: hNumOrNull(r.delivered_at),
    consumed_at: hNumOrNull(r.consumed_at),
    terminal_at: hNumOrNull(r.terminal_at),
    expires_at: hNumOrNull(r.expires_at),
  };
}

/** Extract the FULL composed_prompt from a read_handoff (GET /api/handoffs/:id) response. The default
 *  resultToHttp wraps the row under `{ output: {...} }`; a future bare-row shape is tolerated too.
 *  Returns null for any non-string / missing prompt (the caller then keeps its existing seed). Pure. */
export function handoffPromptFromReadResponse(d: unknown): string | null {
  const outer = d as { output?: unknown } | null;
  const row = (outer && typeof outer.output === "object" && outer.output ? outer.output : d) as { composed_prompt?: unknown } | null;
  const prompt = row && typeof row === "object" ? row.composed_prompt : null;
  return typeof prompt === "string" ? prompt : null;
}

/** Normalize the rows GET /api/handoffs returns into the StoredHandoff-ish shape the drawer reads.
 *  The list_handoffs REST projection (src/actions/defs/handoff.ts) keys the id as `handoff_id` and
 *  redacts/slices `composed_prompt`; the cv2 handoffs_updated frame is expected to carry FULL rows
 *  (`id`). Coalesce `id ?? handoff_id`, default the rest, and DROP any row without a usable id +
 *  to_pane (a malformed payload must never crash the board). Pure: list→list, no fetch/React. */
export function normalizeHandoffRows(rows: unknown): StoredHandoff[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && hasUsableHandoffId(r as Record<string, unknown>))
    .map(buildHandoffRow);
}

/** Group handoffs by their target station (`to_pane`) for the Line drawer — each station card reads
 *  off `byPane[stationId]`. Pure: object→object, insertion order preserved per bucket. */
export function groupHandoffsByPane(handoffs: StoredHandoff[]): Record<string, StoredHandoff[]> {
  const byPane: Record<string, StoredHandoff[]> = {};
  for (const h of handoffs) {
    if (!h || typeof h.to_pane !== "string" || !h.to_pane) continue;
    (byPane[h.to_pane] ??= []).push(h);
  }
  return byPane;
}

/** The drawer's status chip label per lifecycle state (pure map; unknown states degrade to the raw
 *  string so the chip never crashes on a state the UI hasn't enumerated). */
const HANDOFF_STATUS_LABELS: Record<HandoffState, string> = {
  composing: "Drafting", revising: "Revising", staged: "Staged", delivered: "Delivered",
  consumed: "Consumed", rejected: "Rejected", expired: "Expired", blocked_read_only: "Blocked",
};
export function handoffStatusLabel(state: HandoffState): string {
  return HANDOFF_STATUS_LABELS[state] ?? state;
}

/** settings_updated: should we adopt the wire's isMicMuted? Only when it's a boolean AND differs
 *  from our current (the !== guard keeps our own optimistic toggle echo from bouncing it). */
export function shouldAdoptMute(wireMuted: unknown, current: boolean): wireMuted is boolean {
  return typeof wireMuted === "boolean" && wireMuted !== current;
}

/** approval_pending: build the chip from the broadcast payload (same shape the classic app builds). */
export function buildPendingCommand(msg: Record<string, unknown>): PendingCommand {
  return {
    messageId: msg.messageId, cmd: msg.cmd, terminalId: msg.terminalId, rationale: msg.rationale,
    effective_gates: msg.effective_gates, posture: msg.posture, effective_mode: msg.effective_mode, capability: msg.capability,
  } as unknown as PendingCommand;
}

/** action_pending: build the chip carrying the SERVER-resolved effective posture. */
export function buildPendingAction(msg: Record<string, unknown>): PendingActionView {
  return {
    actionId: msg.actionId, capability: msg.capability, summary: msg.summary,
    effective_gate: msg.effective_gate, effective_mode: msg.effective_mode, posture: msg.posture,
    effective_gates: msg.effective_gates, pane_id: msg.pane_id, requested_mode: msg.requested_mode, global_override: msg.global_override,
  } as unknown as PendingActionView;
}

/** command_blocked: the toast text — names the pane, the command, and the server's reason (if any). */
export function blockedToastText(terminalId: unknown, cmd: string, reason: unknown): string {
  return `Held back on ${terminalId}: ${cmd}${typeof reason === "string" && reason ? ` — ${reason}` : ""}`;
}

// ── transcript helpers ───────────────────────────────────────────────────

/** grounding frame: attach grounded sources/queries to the most recent Janus turn (no-op if none
 *  yet). PURE list→list transform of the transcript, so a setState updater can call it directly. */
export function attachGrounding<T extends { sender: string; grounding?: unknown }>(
  prev: T[], rawSources: unknown, rawQueries: unknown,
): T[] {
  const sources = Array.isArray(rawSources) ? rawSources : [];
  const queries = Array.isArray(rawQueries) ? rawQueries : [];
  if (sources.length === 0 && queries.length === 0) return prev;
  let lastJanus = -1;
  for (let i = prev.length - 1; i >= 0; i--) { if (prev[i].sender === "Janus") { lastJanus = i; break; } }
  if (lastJanus === -1) return prev;
  const next = prev.slice();
  next[lastJanus] = { ...next[lastJanus], grounding: { queries, sources } };
  return next;
}

// ── gated-mutation REST helpers ──────────────────────────────────────────
// The mutation callbacks (executePlan/saveLayout/applyLayout/applyTemplate/createTemplate/…) share
// the same REST mapping (src/actions/rest.ts resultToHttp): 200 ok {output} / 202 pending / 403
// blocked {error} / 409 {clarify}. These pure helpers read a parsed body / status into a DECISION
// the callback then narrates — no fetch, no toast here.

/** First non-empty string among d.output / d.error / d.clarify — the "surface whichever the server
 *  sent" pattern shared by executePlan, applyTemplate and applyLayout's error arms. */
export function firstServerMessage(d: Record<string, unknown>): string | undefined {
  return [d.output, d.error, d.clarify].find((v) => typeof v === "string" && v) as string | undefined;
}

/** A toast spec: text + kind + optional explicit earcon override. `undefined` earcon means "use the
 *  showToast default for the kind"; the callbacks pass this straight into showToast. */
export interface ToastSpec { msg: string; kind: "fire" | "warn"; earcon?: "execute" | "success" | null }

/** saveSettings: should we adopt the server's echoed settings object? Only a non-empty object — so a
 *  thin ack can't wipe optimistic state. */
export function hasSettingsEcho(d: unknown): d is { settings: Record<string, unknown> } {
  return !!d && typeof (d as { settings?: unknown }).settings === "object"
    && (d as { settings: object }).settings !== null
    && Object.keys((d as { settings: Record<string, unknown> }).settings).length > 0;
}

/** setGlobalMode: the optimistic toast text for a mode flip (byte-exact with the original ternary). */
export function globalModeToast(mode: string): string {
  return mode === "Full Auto" ? "Lettin' 'em cook 🔥"
    : mode === "Read-Only" ? "Hands off — watchin' the line"
    : "Tastin' every plate 🛎";
}

/** createPane: resolve the spawn command for a tool preset — a configured preset's command wins,
 *  else the built-in default for that preset name, else bash. */
export function resolvePaneCommand(
  toolPreset: string, presets: { name: string; command?: string }[] | undefined,
): string {
  return presets?.find((p) => p.name === toolPreset)?.command
    || ({ "Claude Code": "claude", Codex: "codex", Antigravity: "antigravity", Custom: "bash" }[toolPreset] ?? "bash");
}

/** createPane: the pane id slug (lowercased, non-alnum→dash, trimmed, capped 24) + a 4-char suffix
 *  is built by the caller; this is the pure slug half so it's unit-pinnable. */
export function paneSlug(name: string | undefined): string {
  return (name || "pane").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "pane";
}

/** applyTemplate 409: the clarify text — the server's `clarify` string, else the generic ask. */
export function templateClarifyText(d: Record<string, unknown>): string {
  return typeof d.clarify === "string" && d.clarify ? d.clarify : "That template needs more values, Chef";
}

/** applyTemplate 200: a genuine "applied to pane" narration earns the filled-draft ack; any other
 *  200 body is an ok-narration refusal surfaced honestly (raw output, else the generic failure). */
export function templateApplyToast(d: Record<string, unknown>, paneId: string): { msg: string; kind: "fire" | "warn" } {
  const out = typeof d.output === "string" ? d.output : "";
  if (out.includes("applied to pane")) return { msg: `Draft's filled on ${paneId} — review it at the station 📝`, kind: "fire" };
  return { msg: out || "Couldn't fill that draft, Chef — try again.", kind: "warn" };
}

/** applyLayout 403: the server's `error` reason, else the generic gated-off copy. */
export function layoutGatedText(d: Record<string, unknown>): string {
  return typeof d.error === "string" && d.error ? d.error : "That layout's gated off, Chef";
}

/** saveLayout: a 200 narration containing "saved" earns the on-the-books ack; otherwise the raw
 *  output (or the generic failure copy) surfaces as a warn. Byte-exact with the original ladder. */
export function layoutSaveToast(d: Record<string, unknown>, name: string): { msg: string; kind: "fire" | "warn" } {
  const out = typeof d.output === "string" ? d.output : "";
  if (out.includes("saved")) return { msg: `Layout '${name}' is on the books 🗺`, kind: "fire" };
  return { msg: out || "Couldn't save that layout, Chef — try again.", kind: "warn" };
}

/** applyLayout: the success narration is gated on the server's output CONTAINING "applied" — that
 *  word also picks the earcon. A missing/empty output falls back to "Layout applied 🔥"; "not found"
 *  / "no active project" come back as 200 ok-narrations that read honestly as a warn. */
export function layoutApplyToast(d: Record<string, unknown>): ToastSpec {
  const out = (typeof d.output === "string" && d.output ? d.output : "") || "Layout applied 🔥";
  const applied = out.includes("applied");
  return { msg: out, kind: applied ? "fire" : "warn", earcon: applied ? "execute" : undefined };
}
