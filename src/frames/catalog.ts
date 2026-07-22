// ── bead wsm-e2e-pinned-ys8d — server<->frontend WS frame contract catalog ──────────────────
//
// WHAT THIS IS: a typed inventory of every `{ type: "..." }` frame the server actually emits
// over the two live WebSocket lanes (the always-on observe/board broadcast set, and the
// per-connection voice socket), plus the choke-point wrappers (`sendFrame` / `assertValidFrameIfEnabled`)
// that let a test/CI run smoke-validate every emitted frame against its schema.
//
// THE CATALOG DESCRIBES WHAT **IS** — it was built by grepping every `broadcast(`/`ctx.broadcast(`/
// `deps.broadcast(`/`this.broadcast(`/`clientWs.send(JSON.stringify(` call site in server.ts and
// src/**/*.ts (see tests/test_frame_contracts.ts for the cited enumeration) and reading each site's
// actual literal. It does NOT rename fields, does NOT change any frame's shape, and does NOT fix any
// inconsistency found along the way (those are reported, not silently patched, in the review that
// shipped this file).
//
// SCHEMA STRICTNESS, DELIBERATE CHOICE: every field beyond the `type` discriminant is `.optional()`
// (many additionally loosely-typed as `z.unknown()`), and every object schema is `.passthrough()`.
// This is intentional, not laziness — `stdout_chunk` alone fires on a 30ms coalescing timer for
// every live PTY chunk, and `npm test`'s ~54 real-server-booting suites (the ones that
// `process.env.NODE_ENV = "test"` before `startServer()`) push a huge, organically-varying volume of
// REAL production frames through `broadcast()`. A schema strict enough to reject a legitimate field
// variant would false-red the whole suite; the catalog's job here is to catch a genuinely NEW/renamed
// `type` string (the actual drift class it exists to prevent), not to police every optional field's
// exact type. Per-type comments below describe the REAL shape (including cross-site variance) even
// where the zod schema itself stays loose.
//
// TWO LANES, TWO CHOKE POINTS (both validate identically, both are no-ops outside test mode):
//   - observe/board lane (ALL connected clients): server.ts's existing `broadcast()` function is
//     hardened in place to call `assertValidFrameIfEnabled` before its unchanged JSON.stringify/
//     client.send loop. Every one of the ~50 `broadcast(...)`/`ctx.broadcast(...)`/`deps.broadcast(...)`/
//     `this.broadcast(...)` call sites across server.ts, src/gating, src/actions/defs/*, src/dispatch,
//     src/announcementBus.ts, src/applyPaneMode.ts, src/actionEffects.ts, src/voice/*, etc. is a call
//     to the SAME shared `broadcast` identity (threaded through dependency-injection, never
//     reimplemented) — hardening its one body covers every caller with ZERO call-site edits.
//   - voice socket (ONE connection): src/voice/index.ts's direct `clientWs.send(JSON.stringify(...))`
//     sites bypass `broadcast()` entirely (they target one operator's socket, not the broadcast set).
//     Those ~13 sites are mechanically converted to `sendFrame(clientWs, {...})`, the single-socket
//     twin of `broadcast()` — same validate-then-send shape, same env-gated cost.
//
// RAW-SEND GUARD SCOPE (tests/test_frame_contracts.ts part 1d): the guard's job is to catch a frame
// construction that bypasses BOTH choke points — a stray `ws.send(JSON.stringify({type:...}))` outside
// this file. It does NOT flag `broadcast(...)`/`ctx.broadcast(...)`/`deps.broadcast(...)` call sites:
// those already funnel through the ONE hardened `broadcast()` body (see above), so they are not a
// bypass — converting ~50 already-correct call sites to a different function name would be pure
// churn for zero behavior change. This scope choice is documented at the guard test itself too.

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// § Observe / board lane — broadcast to every connected client (both the always-on observe
// socket and any live voice socket sit in the same `coreState.clients` broadcast set).
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** src/observe/index.ts (bufferAndScheduleFlush, ~30ms coalescing timer) — the PTY-output hot path.
 *  Always `{terminalId, chunk}`, both strings. Never touch this schema's cost profile. */
const StdoutChunkFrame = z.object({
  type: z.literal("stdout_chunk"),
  terminalId: z.string().optional(),
  chunk: z.string().optional(),
}).passthrough();

/** Bare `{type}` (most call sites), `{type, postures}` (gating.broadcastTerminalsUpdated — the
 *  per-pane effective-posture array), or `{type, paneId}` (actionEffects.ts / applyPaneMode.ts —
 *  a single-pane-scoped repaint hint). All three variants are real; none imply the others. */
const TerminalsUpdatedFrame = z.object({
  type: z.literal("terminals_updated"),
  postures: z.array(z.unknown()).optional(),
  paneId: z.string().optional(),
}).passthrough();

/** src/observe/index.ts onRunning — always `{terminalId, status:"Running"}` at its one call site. */
const PaneStatusFrame = z.object({
  type: z.literal("pane_status"),
  terminalId: z.string().optional(),
  status: z.string().optional(),
}).passthrough();

/** src/observe/index.ts onQuiescing — `{terminalId}` only, no status field. */
const PaneQuiescingFrame = z.object({
  type: z.literal("pane_quiescing"),
  terminalId: z.string().optional(),
}).passthrough();

/** src/observe/index.ts detectAndTriggerTransitions — `{terminalId, transition, message}`.
 *  `transition` is one of the Transition union (idle/prompt/error/build-failed/exited/running/…);
 *  `isPaneExitedFrame` (frontend) keys specifically on transition==="exited" for the completion tone. */
const PaneTransitionFrame = z.object({
  type: z.literal("pane_transition"),
  terminalId: z.string().optional(),
  transition: z.string().optional(),
  message: z.string().optional(),
}).passthrough();

/** server.ts broadcastDraft — `{projectId, paneId, draft:{text,updatedAt}, exchange}`. `exchange` is
 *  additive (Phase 3, Step 3.3): null when the instruction-envelope flag is off or there's no open
 *  exchange, otherwise an ExchangeDraftView-shaped object. Frontend degrades a malformed one to null. */
const DraftUpdatedFrame = z.object({
  type: z.literal("draft_updated"),
  projectId: z.string().optional(),
  paneId: z.string().optional(),
  draft: z.unknown().optional(),
  exchange: z.unknown().nullable().optional(),
}).passthrough();

/** src/observe/index.ts computeIdleSummary — `{terminalId, history}`, the full per-pane history
 *  array (historyManager-shaped entries). Consumer reads `msg.history` directly (historyEntriesFromFrame). */
const HistoryUpdatedFrame = z.object({
  type: z.literal("history_updated"),
  terminalId: z.string().optional(),
  history: z.array(z.unknown()).optional(),
}).passthrough();

/** server.ts broadcastLedgerUpdate — `{ledger: manager.ledger.workspaces}` (the full workspace array). */
const LedgerUpdatedFrame = z.object({
  type: z.literal("ledger_updated"),
  ledger: z.unknown().optional(),
}).passthrough();

/** Kitchen-only e2e/harness seam (useOrbitalData.ts comment, Phase 5 Step 5.1): the REAL server
 *  NEVER broadcasts this frame today (fleetExchangeSummaries is fetch-refreshed) — it exists solely
 *  so Playwright's generic injectWsFrame hook can seed deterministic fleet-card data under ?mock=1.
 *  Schema kept for dispatch-table-key coverage (handleObserveFrame handles it); see
 *  inconsistenciesFound in the review that shipped this catalog. */
const FleetExchangeSummaryUpdatedFrame = z.object({
  type: z.literal("fleet_exchange_summary_updated"),
  summaries: z.unknown().optional(),
}).passthrough();

/** src/observe/index.ts (plan step edges) + src/actions/defs/orchestration.ts, watch_rules.ts,
 *  src/actionEffects.ts, src/gating/index.ts — always `{plans: manager.ledger.plans}` (full board). */
const PlansUpdatedFrame = z.object({
  type: z.literal("plans_updated"),
  plans: z.array(z.unknown()).optional(),
}).passthrough();

/** Many observe/index.ts sites + src/actions/defs/orient.ts — always the FULL queue array,
 *  `{queue: manager.attentionQueue}`. An empty array is real state (cleared queue), not absent. */
const AttentionUpdatedFrame = z.object({
  type: z.literal("attention_updated"),
  queue: z.array(z.unknown()).optional(),
}).passthrough();

/** src/actions/defs/templates.ts (save/update/delete) — `{templates: manager.ledger.promptTemplates}`. */
const TemplatesUpdatedFrame = z.object({
  type: z.literal("templates_updated"),
  templates: z.array(z.unknown()).optional(),
}).passthrough();

/** src/actions/defs/layouts.ts (save/delete) — `{layouts: manager.ledger.layouts}`. */
const LayoutsUpdatedFrame = z.object({
  type: z.literal("layouts_updated"),
  layouts: z.array(z.unknown()).optional(),
}).passthrough();

/** src/actions/defs/handoff.ts (7 call sites: compose/revise/stage/deliver/reject/…) — EVERY site is
 *  the bare `{type: "handoffs_updated"}`, no payload. Frontend's handoffsFromFrame(msg) reads
 *  `msg.handoffs`, which is never actually sent — the "adopt directly" branch is (today) always dead
 *  and the frame always degrades to a GET /api/handoffs refetch. Documented at the frontend site as
 *  the expected today-shape ("the current payload-less frame yields null"), not a bug. */
const HandoffsUpdatedFrame = z.object({
  type: z.literal("handoffs_updated"),
  handoffs: z.array(z.unknown()).optional(),
}).passthrough();

/** The most field-variable frame in the catalog. Observed shapes:
 *   - server.ts PUT /api/settings, src/actions/defs/locks.ts set_global_permissions:
 *       {globalPermissionsMode, settings}
 *   - src/actions/defs/orient.ts:  {settings}  (no globalPermissionsMode)
 *   - src/actionEffects.ts / src/applyPaneMode.ts / src/dispatch (per-pane mode set):
 *       {paneId, permissionsMode}  (no settings/globalPermissionsMode at all)
 *  All four fields are therefore optional; no single call site sends all of them. */
const SettingsUpdatedFrame = z.object({
  type: z.literal("settings_updated"),
  globalPermissionsMode: z.string().optional(),
  settings: z.unknown().optional(),
  paneId: z.string().optional(),
  permissionsMode: z.string().optional(),
}).passthrough();

/** src/actions/defs/voice_ux.ts, panes_write.ts, src/voice/focusResolver.ts — always `{paneId}`. */
const SwitchActivePaneFrame = z.object({
  type: z.literal("switch_active_pane"),
  paneId: z.string().optional(),
}).passthrough();

/** src/gating/index.ts stopAll — `{frozen:true, running: stillRunning}` on freeze,
 *  `{frozen:false}` (no `running`) on release. */
const FrozenFrame = z.object({
  type: z.literal("frozen"),
  frozen: z.boolean().optional(),
  running: z.array(z.unknown()).optional(),
}).passthrough();

/** src/gating/index.ts stopAll(kill:true) — `{killed, failed}`, both process/pane-id arrays. */
const StopAllFrame = z.object({
  type: z.literal("stop_all"),
  killed: z.array(z.unknown()).optional(),
  failed: z.array(z.unknown()).optional(),
}).passthrough();

/** src/dispatch/paneWrite.ts (the ONE literal construction site) — routed through `conn.notifyPending`,
 *  which is `broadcast` on the REST path (all clients) or a direct `clientWs.send` on the voice path
 *  (one client) — so this type can arrive via EITHER choke point depending on request origin. */
const ApprovalPendingFrame = z.object({
  type: z.literal("approval_pending"),
  messageId: z.string().optional(),
  cmd: z.string().optional(),
  instruction: z.string().optional(),
  kind: z.string().optional(),
  terminalId: z.string().optional(),
  // `rationale` is `{trigger, summary}` (src/dispatch/paneWrite.ts:289) — an OBJECT, not a string.
  rationale: z.unknown().optional(),
  effective_gates: z.unknown().optional(),
  posture: z.unknown().optional(),
  effective_mode: z.string().optional(),
  capability: z.string().optional(),
}).passthrough();

/** src/gating/index.ts (WS_EVT.APPROVAL_RESOLVED — a messageId-keyed dismiss) — `{messageId,
 *  terminalId, outcome}`; src/applyPaneMode.ts drainPaneOnPromotion sends `outcome:"drained"` on a
 *  Full-Auto promotion drain. NOTE: the frontend key `WS_EVT.APPROVAL_RESOLVED` and
 *  `WS_EVT.AUTO_EXECUTED`/`WS_EVT.BLOCKED` below are symbolic constants in src/gating/index.ts that
 *  resolve to these exact literal strings — see that file's `const WS_EVT = {...}`. */
const ApprovalResolvedFrame = z.object({
  type: z.literal("approval_resolved"),
  messageId: z.string().optional(),
  terminalId: z.string().optional(),
  outcome: z.string().optional(),
}).passthrough();

/** Two real shapes:
 *   - src/actions/defs/promote.ts: {actionId, capability, summary, pane_id} (pane_id always null there)
 *   - src/gating/index.ts buildActionPendingBroadcast: {actionId, capability, summary, pane_id,
 *       effective_gate, effective_mode, posture?, effective_gates?, requested_mode?, global_override}
 *   - src/gating/index.ts last-call retry (line ~1361/1367): {actionId, capability, summary} only,
 *       no pane_id at all.
 *  `pane_id` is explicitly `string | null` at its richest call site — nullable, not just optional. */
const ActionPendingFrame = z.object({
  type: z.literal("action_pending"),
  actionId: z.string().optional(),
  capability: z.string().optional(),
  summary: z.string().optional(),
  pane_id: z.string().nullable().optional(),
  effective_gate: z.unknown().optional(),
  effective_mode: z.string().optional(),
  posture: z.unknown().optional(),
  effective_gates: z.unknown().optional(),
  requested_mode: z.string().optional(),
  global_override: z.boolean().optional(),
}).passthrough();

/** src/actions/defs/approvals_rest.ts (confirm/cancel), src/voiceApprovalRouting.ts,
 *  src/voice/spokenConfirm.ts, src/gating/index.ts sweep — `{actionId, outcome}`, outcome one of
 *  "confirmed"|"failed"|"cancelled"|"expired"; `error` present only on the "failed" outcome. */
const ActionResolvedFrame = z.object({
  type: z.literal("action_resolved"),
  actionId: z.string().optional(),
  outcome: z.string().optional(),
  error: z.string().optional(),
}).passthrough();

/** server.ts (raw-input auto-execute), src/dispatch/paneWrite.ts, src/gating/index.ts
 *  (WS_EVT.AUTO_EXECUTED) — `{terminalId, cmd}` always; `approved:true` + optional `vocal:true` only
 *  on the gating dispatch-render path (an operator-approved-then-executed command, not genuine
 *  Full-Auto). */
const CommandAutoExecutedFrame = z.object({
  type: z.literal("command_auto_executed"),
  terminalId: z.string().optional(),
  cmd: z.string().optional(),
  approved: z.boolean().optional(),
  vocal: z.boolean().optional(),
}).passthrough();

/** src/dispatch/paneWrite.ts, src/gating/index.ts (WS_EVT.BLOCKED) — always `{terminalId, cmd, reason}`. */
const CommandBlockedFrame = z.object({
  type: z.literal("command_blocked"),
  terminalId: z.string().optional(),
  cmd: z.string().optional(),
  reason: z.string().optional(),
}).passthrough();

/** src/announcementBus.ts toNotification (flush()) — `{id, kind, terminalId, severity, message, timestamp}`. */
const ProactiveNotificationFrame = z.object({
  type: z.literal("proactive_notification"),
  id: z.string().optional(),
  kind: z.string().optional(),
  terminalId: z.string().optional(),
  severity: z.string().optional(),
  message: z.string().optional(),
  timestamp: z.string().optional(),
}).passthrough();

/** src/announcementBus.ts deliver() — fires BEFORE the coalesced notification, sub-100ms feedback.
 *  `{earcon, kind, terminalId}`; `earcon` may be null (EARCON_FOR[kind] has no tone for that kind). */
const ProactiveEarconFrame = z.object({
  type: z.literal("proactive_earcon"),
  earcon: z.string().nullable().optional(),
  kind: z.string().optional(),
  terminalId: z.string().optional(),
}).passthrough();

/** src/voice/index.ts (unauthorized WS connect, connect-failure ×2) — voice-socket ONLY, always via
 *  clientWs.send (never broadcast to all clients). `{message}`. */
const ErrorFrame = z.object({
  type: z.literal("error"),
  message: z.string().optional(),
}).passthrough();

/** Inc 2 task 2.2 (Memory Synthesis daemon tracker) — server.ts `{state, reason}`. `state` is
 *  "python"|"fallback" at every real site; kept as a loose string here (the frontend's own consumer
 *  already narrows with a strict `===` check, so a schema-level enum buys nothing extra). */
const DaemonStateFrame = z.object({
  type: z.literal("daemon_state"),
  state: z.string().optional(),
  reason: z.string().optional(),
}).passthrough();

/** src/voice/index.ts buildActionActivityFrame / emitActionActivity — `{name, callId, ts, payload}`;
 *  payload is the redacted+capped ActionActivityPayload projection: {kind, output?, summary?,
 *  reason?, message?, truncated?} (src/types.ts). Emitted via the SAME shared `broadcast` (passed in
 *  as emitActionActivity's first param), not a direct clientWs.send — reaches every client. */
const ActionActivityFrameSchema = z.object({
  type: z.literal("action_activity"),
  name: z.string().optional(),
  callId: z.string().optional(),
  ts: z.number().optional(),
  payload: z.unknown().optional(),
}).passthrough();

/** src/actions/defs/dispatch_group.ts (stage), src/observe/index.ts (dispatch-join completion) —
 *  `{dispatches: dispatchJoinTracker.list()}`. UNCONSUMED — see UNCONSUMED_FRAME_TYPES below. */
const DispatchUpdatedFrame = z.object({
  type: z.literal("dispatch_updated"),
  dispatches: z.array(z.unknown()).optional(),
}).passthrough();

/** src/observe/index.ts handleWatchRulesTrigger — `{ruleId, suggestedCommand, targetTerminalId,
 *  message}`. Consumed ONLY via the classic UI's eventBus fallback (STATIC_EFFECTS) — Kitchen has no
 *  watch-rule surface (see the "watch_rules_updated is PRUNED" sibling comment at the emit site). */
const WatchRuleSuggestedFrame = z.object({
  type: z.literal("watch_rule_suggested"),
  ruleId: z.string().optional(),
  suggestedCommand: z.string().optional(),
  targetTerminalId: z.string().optional(),
  message: z.string().optional(),
}).passthrough();

/** src/observe/index.ts completePlan — `{planId, message}`. Classic-only (eventBus STATIC_EFFECTS). */
const PlanCompletedFrame = z.object({
  type: z.literal("plan_completed"),
  planId: z.string().optional(),
  message: z.string().optional(),
}).passthrough();

/** src/observe/index.ts failPlanStep — `{planId, message}`. Classic-only (eventBus STATIC_EFFECTS). */
const PlanPausedFrame = z.object({
  type: z.literal("plan_paused"),
  planId: z.string().optional(),
  message: z.string().optional(),
}).passthrough();

/** src/observe/index.ts handlePlanStepEdge — `{planId, stepId, message}`. Classic-only (eventBus). */
const PlanStepCompletedFrame = z.object({
  type: z.literal("plan_step_completed"),
  planId: z.string().optional(),
  stepId: z.string().optional(),
  message: z.string().optional(),
}).passthrough();

/** src/actions/defs/macros.ts (save/delete) — `{macros: manager.ledger.macros}`. UNCONSUMED. */
const MacrosUpdatedFrame = z.object({
  type: z.literal("macros_updated"),
  macros: z.array(z.unknown()).optional(),
}).passthrough();

/** src/actionEffects.ts (restart-resume permission note) — `{paneId, note}`. UNCONSUMED. */
const PaneNoteFrame = z.object({
  type: z.literal("pane_note"),
  paneId: z.string().optional(),
  note: z.string().optional(),
}).passthrough();

// ─────────────────────────────────────────────────────────────────────────────────────────────
// § Voice socket lane — ONE connection only, sent via direct `clientWs.send(JSON.stringify(...))`
// (the sendFrame choke point below), never through the multi-client `broadcast()`. Exceptions
// noted per-type: voice_channel_lost/restored DO go through the shared `broadcast()` (they announce
// the channel's health to every UI, not just the one voice tab).
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** src/voice/index.ts relayModelAudio — `{audio}`, base64 PCM. Per-audio-chunk hot path. */
const AudioFrame = z.object({
  type: z.literal("audio"),
  audio: z.string().optional(),
}).passthrough();

/** src/voice/index.ts relayInterruptAndTurnState (barge-in) — always `{interrupted: true}`. */
const InterruptedFrame = z.object({
  type: z.literal("interrupted"),
  interrupted: z.boolean().optional(),
}).passthrough();

/** src/voice/index.ts (operator utterance + model utterance flush) — `{sender: "User"|"Janus", text}`. */
const TranscriptTextFrame = z.object({
  type: z.literal("transcript_text"),
  sender: z.string().optional(),
  text: z.string().optional(),
}).passthrough();

/** src/voice/index.ts handleGrounding — `{queries, sources}` (Google-Search grounding metadata). */
const GroundingFrame = z.object({
  type: z.literal("grounding"),
  queries: z.array(z.unknown()).optional(),
  sources: z.array(z.unknown()).optional(),
}).passthrough();

/** src/voice/index.ts (session-lost/invalid-key/reconnect-exhausted) — routed through the SHARED
 *  `broadcast()` (all clients hear the channel drop), not a per-socket send. `{reason?, permanent?}`;
 *  `permanent:true` only on the final reconnect-exhausted frame. */
const VoiceChannelLostFrame = z.object({
  type: z.literal("voice_channel_lost"),
  reason: z.string().optional(),
  permanent: z.boolean().optional(),
}).passthrough();

/** src/voice/index.ts (post-reconnect) — routed through the SHARED `broadcast()`. Bare `{type}`,
 *  no payload at its one real call site. */
const VoiceChannelRestoredFrame = z.object({
  type: z.literal("voice_channel_restored"),
}).passthrough();

/** src/voice/index.ts handleStopAllFrame / release_stop_all — the per-request ACK for the voice
 *  socket's own stop-all control frame (distinct from the broadcast `stop_all`/`frozen` frames every
 *  client receives). Four shapes: `{error:"not_frozen"}`, `{stage:2, killed, failed}`,
 *  `{stage:1, frozen:true, running}`, `{stage:0, frozen:false}`. Consumed by Kitchen's handleVoiceFrame
 *  (refetches frozen state and terminals without playing earcon). */
const StopAllDoneFrame = z.object({
  type: z.literal("stop_all_done"),
  stage: z.number().optional(),
  error: z.string().optional(),
  killed: z.array(z.unknown()).optional(),
  failed: z.unknown().optional(),
  frozen: z.boolean().optional(),
  running: z.array(z.unknown()).optional(),
}).passthrough();

// ─────────────────────────────────────────────────────────────────────────────────────────────
// § The catalog registry
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** One entry per frame `type`. This Record IS the catalog: tests/test_frame_contracts.ts checks
 *  its key set against (a) every type found emitted in server.ts/src and (b) every frontend
 *  dispatch-table key. */
export const FRAME_SCHEMAS = {
  // observe/board lane
  stdout_chunk: StdoutChunkFrame,
  terminals_updated: TerminalsUpdatedFrame,
  pane_status: PaneStatusFrame,
  pane_quiescing: PaneQuiescingFrame,
  pane_transition: PaneTransitionFrame,
  draft_updated: DraftUpdatedFrame,
  history_updated: HistoryUpdatedFrame,
  ledger_updated: LedgerUpdatedFrame,
  fleet_exchange_summary_updated: FleetExchangeSummaryUpdatedFrame,
  plans_updated: PlansUpdatedFrame,
  attention_updated: AttentionUpdatedFrame,
  templates_updated: TemplatesUpdatedFrame,
  layouts_updated: LayoutsUpdatedFrame,
  handoffs_updated: HandoffsUpdatedFrame,
  settings_updated: SettingsUpdatedFrame,
  switch_active_pane: SwitchActivePaneFrame,
  frozen: FrozenFrame,
  stop_all: StopAllFrame,
  approval_pending: ApprovalPendingFrame,
  approval_resolved: ApprovalResolvedFrame,
  action_pending: ActionPendingFrame,
  action_resolved: ActionResolvedFrame,
  command_auto_executed: CommandAutoExecutedFrame,
  command_blocked: CommandBlockedFrame,
  proactive_notification: ProactiveNotificationFrame,
  proactive_earcon: ProactiveEarconFrame,
  error: ErrorFrame,
  daemon_state: DaemonStateFrame,
  action_activity: ActionActivityFrameSchema,
  dispatch_updated: DispatchUpdatedFrame,
  watch_rule_suggested: WatchRuleSuggestedFrame,
  plan_completed: PlanCompletedFrame,
  plan_paused: PlanPausedFrame,
  plan_step_completed: PlanStepCompletedFrame,
  macros_updated: MacrosUpdatedFrame,
  pane_note: PaneNoteFrame,
  // voice socket lane
  audio: AudioFrame,
  interrupted: InterruptedFrame,
  transcript_text: TranscriptTextFrame,
  grounding: GroundingFrame,
  voice_channel_lost: VoiceChannelLostFrame,
  voice_channel_restored: VoiceChannelRestoredFrame,
  stop_all_done: StopAllDoneFrame,
} as const;

export type FrameType = keyof typeof FRAME_SCHEMAS;

/** zod v4 discriminated union of every schema above — the actual runtime validator. */
export const FrameSchema = z.discriminatedUnion(
  "type",
  Object.values(FRAME_SCHEMAS) as unknown as [
    (typeof FRAME_SCHEMAS)[FrameType],
    ...(typeof FRAME_SCHEMAS)[FrameType][],
  ],
);

/** Catalog types with NO frontend consumer in any of the three dispatch surfaces (Kitchen's
 *  handleObserveFrame / handleVoiceFrame, or the classic UI's WS_HANDLERS + eventBus fallback) —
 *  each with a one-line reason. These are real gaps found during the audit (server emits, nothing
 *  reads it — the `Object.hasOwn` dispatch guard silently no-ops), reported here per the review
 *  instructions rather than silently "fixed" by adding a handler. */
export const UNCONSUMED_FRAME_TYPES: Record<string, string> = {
  dispatch_updated: "emitted by src/actions/defs/dispatch_group.ts + src/observe/index.ts's dispatch-join completion; no frontend surface (Kitchen or classic) has a dispatch-board UI that reads it.",
  macros_updated: "emitted by src/actions/defs/macros.ts on save/delete; neither Kitchen nor the classic UI has a macros surface that reads it.",
  pane_note: "emitted by src/actionEffects.ts's restart-resume permission-mode note; no frontend surface renders a pane note pushed over the WS frame (only the REST-created note surfaces render).",
};

/** Enabled ONLY for real-server-booting tests (the ~54 suites that set `process.env.NODE_ENV =
 *  "test"` before `startServer()`) or an explicit opt-in flag — NEVER in production, and NEVER for
 *  `npm run test:e2e`'s mock lane (that lane is client-only, ?mock=1, no Node backend, so this module
 *  is never even reached). Computed ONCE at module load so the hot broadcast()/sendFrame() paths pay
 *  a single cached boolean check, not a repeated env lookup. */
export const VALIDATE_FRAMES =
  process.env.NODE_ENV === "test" || process.env.JANUS_VALIDATE_FRAMES === "1";

/** Throws a descriptive Error when `frame` doesn't match any cataloged schema. Exported standalone
 *  (not just via the two choke points) so tests/test_frame_contracts.ts can assert against it
 *  directly without booting a server or socket. */
export function validateFrame(frame: unknown): void {
  const result = FrameSchema.safeParse(frame);
  if (!result.success) {
    const typeHint = (frame as { type?: unknown } | null)?.type;
    throw new Error(
      `[frames/catalog] frame failed schema validation (type=${JSON.stringify(typeHint)}): ${result.error.message}`,
    );
  }
}

/** The observe/board choke point's validation hook. server.ts's `broadcast()` calls this as its
 *  first line — a zero-cost passthrough (one boolean check) outside test mode, exactly as today. */
export function assertValidFrameIfEnabled(frame: unknown): void {
  if (VALIDATE_FRAMES) validateFrame(frame);
}

/** The single-socket choke point — the twin of `broadcast()` for the voice connection's direct
 *  `clientWs.send(...)` sites. Production behavior is BYTE-IDENTICAL to the `clientWs.send(
 *  JSON.stringify(frame))` it replaces: same JSON.stringify, same `.send` call, same synchronous
 *  throw-on-closed-socket semantics (callers that wrapped the old call in try/catch keep doing so
 *  around this one). Test-mode-only, additionally validates against the catalog first. */
export function sendFrame(ws: { send: (data: string) => void }, frame: unknown): void {
  if (VALIDATE_FRAMES) validateFrame(frame);
  ws.send(JSON.stringify(frame));
}
