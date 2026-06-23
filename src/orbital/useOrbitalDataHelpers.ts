// ── ORBITAL · pure helpers for the live data spine ───────────────────────
// Behavior-preserving extractions out of useOrbitalData.ts, pulled into a sibling MODULE so the
// node test runner can import the REAL helpers without dragging in React/Vite-only deps. Every
// function here is PURE (no React, no fetch, no setState) — it computes a value or a decision the
// hook then applies. Cyclomatic-complexity burndown only; no logic was changed.
import { extractSlots } from "../templates";
import type { EarconType } from "../utils/earcon";
import type { PendingCommand, PendingActionView, AttentionItem } from "../types";
import type { TemplateView, PaneHistoryEntry } from "./useOrbitalData";
import type { HandoffState, StoredHandoff } from "../store/types";

// ── handleObserveFrame helpers ───────────────────────────────────────────

// Frame-type → hands-free earcon (UX_BRIEF §4: eyes-off, a state change with no sound is a bug).
// Only the two attention-worthy lifecycle frames chime: an open approval (a pane needs you) rings
// the falling "alert"; a finished pane plays the rising "completion" pair. Everything else is null.
//
// IMPORTANT — frame shapes the server ACTUALLY emits (verified against src/observe/index.ts):
//   • `approval_pending` is a real top-level frame type → maps straight here.
//   • a finished pane does NOT broadcast a `pane_exited` frame (there is none). The exit edge
//     rides `pane_transition` with `transition:"exited"` (observe/index.ts ~580). So the completion
//     tone is keyed on that transition value in `earconForObserveFrame`, NOT on a frame type here.
const FRAME_EARCON: Record<string, EarconType> = {
  approval_pending: "alert",
};

/** The earcon a given observe-lane frame TYPE should play, or null for no tone. Type-keyed only —
 *  payload-dependent frames (pane_transition) are resolved by `earconForObserveFrame` below. */
export function earconForFrame(type: string): EarconType | null {
  return Object.hasOwn(FRAME_EARCON, type) ? FRAME_EARCON[type] : null;
}

/** A raw observe-lane frame as far as the earcon decision cares: a `type` discriminant plus an
 *  optional `transition` rider (carried only by `pane_transition`). The index signature keeps real
 *  wider frames (terminalId/cmd/status/…) assignable without excess-property friction. */
export interface ObserveFrame { type?: unknown; transition?: unknown; [k: string]: unknown }

/** velocity-mech: the hands-free earcon a RAW observe frame should play, or null for no tone. This is
 *  the production decision the hook routes every observe frame through — it understands both the
 *  type-keyed frames (approval_pending → "alert") AND the payload-keyed `pane_transition` frame the
 *  server really emits on a pane exit (transition:"exited" → "completion"). Pure, so it pins the
 *  REAL contract without mounting the hook. Mirrors the server's emitted shape exactly:
 *    { type:"pane_transition", terminalId, transition:"idle"|"prompt"|"error"|"build-failed"|"exited" }
 */
export function earconForObserveFrame(msg: ObserveFrame): EarconType | null {
  if (msg?.type === "pane_transition") {
    return msg.transition === "exited" ? "completion" : null;
  }
  return typeof msg?.type === "string" ? earconForFrame(msg.type) : null;
}

/** velocity-mech: TRUE for the exact `pane_transition` frame that means "a pane finished" — the only
 *  observe frame that carries the in-place status:"Exited" patch (mirrors the pane_status arm). */
export function isPaneExitedFrame(msg: ObserveFrame): boolean {
  return msg?.type === "pane_transition" && msg.transition === "exited";
}

/** velocity-mech: the actual "decide + fire" gate the hook's observe handler routes its earcons
 *  through — resolve the frame's earcon and ring it (skipping null). Pure over an injected sink, so a
 *  spy-`earcon` test pins the REAL firing behaviour (right tone on approval_pending /
 *  pane_transition(exited); silence on every neighbour) without mounting the React hook. The `earcon`
 *  sink the hook passes is already voice-cues-gated, so this never bypasses that. */
export function playObserveEarcon(
  msg: ObserveFrame,
  earcon: (type: EarconType) => void,
): void {
  const e = earconForObserveFrame(msg);
  if (e) earcon(e);
}

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

/** attention_updated: the full attention queue the server broadcasts on every queue mutation
 *  (push from observe, dismiss from orient). The frame carries the whole array — adopt it directly;
 *  a frame WITHOUT one yields null, the "degrade to a refetch" signal (mirrors the plans_updated
 *  adopt-or-refetch idiom). An EMPTY array is real state (a cleared queue), never a refetch. */
export function attentionQueueFromFrame(msg: { queue?: unknown }): AttentionItem[] | null {
  return Array.isArray(msg.queue) ? (msg.queue as AttentionItem[]) : null;
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

/** dismissAttention: classify the REST response into the outcome the hook applies. A dismiss is
 *  veto-class, so a gated-Off run does NOT 403 — it returns kind:ok → HTTP 200 with a body whose
 *  `output` starts with "Error:" (the "gated Off … forbidden by policy" narration). So a 200 is NOT
 *  proof the alert cleared: only a 200 WITHOUT an "Error:"-wrapped output is a real success.
 *    - status 403 → blocked (restore + warn)
 *    - !ok        → failed  (restore + warn)
 *    - 200 with output starting "Error:" → blocked (restore + warn)  ← the gate-off honesty case
 *    - otherwise  → cleared (success toast) */
export function dismissAttentionOutcome(status: number, ok: boolean, body: Record<string, unknown>): "cleared" | "blocked" | "failed" {
  if (status === 403) return "blocked";
  if (!ok) return "failed";
  if (typeof body.output === "string" && body.output.startsWith("Error:")) return "blocked";
  return "cleared";
}

/**
 * bead e7h: the held gated request an attention item resolves, or null when it is triage-only.
 * Returns the item's `messageId` (the PendingApproval key the POST /api/commands/approve resolver
 * takes) ONLY for an approval/confirmation item that actually carries one — the SAME id-presence gate
 * `attentionActKind` uses. Anything else (a suggestion, a dead/exited station, an idle completion, or
 * an approval/confirmation with no held request) returns null, so the inbox never tries to resolve a
 * gate that does not exist. A non-string/empty messageId is treated as absent (defensive).
 */
export function attentionResolveTarget(item: { type?: string; messageId?: unknown }): string | null {
  if (item.type !== "approval" && item.type !== "confirmation") return null;
  return typeof item.messageId === "string" && item.messageId.length > 0 ? item.messageId : null;
}
