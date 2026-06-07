# Orbital Kitchen → OrbitalVoiceRunner — Implementation Blueprint

> Source: Claude Design handoff (`~/Downloads/Orbital-handoff/orbital`), 2026-06-06.
> Build epic: **wsm-e2e-pinned-g6t** (9 phase children). Deferred gaps epic: **wsm-e2e-pinned-9ql** (5 children).
> Executed wave-by-wave in worktree `orbital-kitchen`, TDD, **hold push**.

## Director decisions (2026-06-06)
1. **The Pass** = notes-backed (real project/pane notes CRUD). **BeadsExplorer** = honest disabled placeholder.
2. **Pantry git + decor rooms (Loading Dock, Boss's Office)** = skipped in v1, rendered as explicit disabled placeholders; full functionality specced under deferred epic `wsm-e2e-pinned-9ql`.
3. **Delivery** = autonomous wave-by-wave in worktree; hold push; review at end.
4. **Cosmetics** (nothing-fake rule): chefs/mascots = pure decoration (deterministic from `pane_id`, never a real assignee); StationCard scribble = real `Terminal.last_command`; Pips = real `context_size` fill (labeled "context", not fake "steps").

## Concept mapping (kitchen → real system)
| Kitchen | Real |
|---|---|
| Station / "the burner" | pane / PTY terminal |
| Project / menu | project / workspace |
| Service Mode (auto/hitl/read) | `globalPermissionsMode` (Full Auto / Human-in-the-Loop / Read-Only) |
| Back of House → The Rulebook | the Auto/Ask/Off capability-gate matrix (27 caps) |
| The Pass / tickets | project & pane **notes** |
| Kitchen Radio / Chef de Cuisine | Gemini Live voice (transcript/audio/mic/grounding) |
| All Hands / hold-to-kill | stop-all (freeze → confirm → release) |
| Tweaks panel | client view-prefs (localStorage) — NOT the design-time edit-mode harness |

## Status legend
- **WIRED** — backend exists + current React app already calls it → reuse the hook/effect.
- **NEW-WIRE** — route exists, current app doesn't call it → build the call.
- **GAP** — no backend → deferred (epic `wsm-e2e-pinned-9ql`) or notes-backed.
- **DECOR** — cosmetic, no backend.

## Key backend bindings (verified against live tree)
- Ledger/terminals: `GET /api/ledger`, `GET /api/terminals`; WS `ledger_updated`/`terminals_updated`/`pane_status`/`pane_quiescing`.
- Terminal type carries: `tool_preset`, `context_size`, `effective_gates`, `posture`, `last_command`, `elapsed_ms`, `last_known_state` (`src/types.ts:107-165`). **No `assignee`/`chef` field — chefs are decor.**
- Pane lifecycle: `POST /api/terminals` (`panes_write.ts:203`, gated→202), `POST /api/terminals/:id/restart` (`panes_rest.ts:160`), `POST /api/terminals/:id/raw-input` (`server.ts:767`), `POST /api/terminals/:id/input` (`panes_rest.ts:249`).
- Drafts: `GET/PUT /api/panes/:projectId/:paneId/draft` (`server.ts:1009/1015`), `POST .../draft/send` (`server.ts:1033`); WS `draft_updated` (focus-lock).
- Terminal stream: `publishChunk`/`subscribeChunks` (`src/terminalStream.ts:18/31`); WS `stdout_chunk`. **Reuse `TerminalView` verbatim.**
- Settings: `GET/PUT /api/settings` (`server.ts:1047/1051`); WS `settings_updated`. Holds `voiceAi.{model,voice,voiceStyle,volume,isMicMuted}`, `advanced.{globalPermissionsMode,capabilityGates,maxBufferLines,idleTimeoutMs,agentIdleTimeoutMs,defaultShellCommand,redactSecrets}`, `presets[]`, `projects.{activeContext,localWorkspacePath}`.
- Capability gates: global via settings; per-pane `PUT /api/projects/:projectId/panes/:paneId/capability-gates` (`server.ts:871`); list `GET /api/capabilities` (`reads.ts:290`). **Reuse `CapabilityMatrixTab` + `src/gateSurface.ts`.**
- Approvals: WS `approval_pending` → `POST /api/commands/approve {messageId,approve}` → `approval_resolved`. Non-PTY: WS `action_pending` → `POST /api/actions/:id/confirm|cancel` → `action_resolved`. **Reuse `ApprovalDialog` + `ActionConfirmDialog` (server-truth posture is a safety invariant — never re-derive).**
- Stop-all: `POST /api/stop-all{,/confirm,/release}`, `GET /api/stop-all/status`; WS `frozen`. **Reuse `EmergencyStop` stage machine.**
- Voice: WS `transcript_text {sender,text}`, `audio` (24kHz), `interrupted`, `grounding`, `voice_channel_lost`; outbound `{type:"audio",audio}` (16kHz). **Reuse audio pipeline.**
- Notes: `GET /api/projects/:id/notes`, `POST /api/projects/:id/notes {note}` (`notes.ts:269`), `DELETE /api/notes/:id` (`notes.ts:323`).
- Project summary (Pantry About): `PUT /api/projects/:project_id {summary}` (`lifecycle_rest.ts:27`).
- Voice context switch: `POST /api/projects/:project_id/switch` (`orient.ts:99`). New project: `POST /api/projects {project_id,directory}` (`orient.ts:172`).

## Phase plan (TDD: `npm run lint` + `npm test` + `npm run test:e2e`)
- **P0** Scaffolding: Tailwind/CSS tokens + fonts + keyframes; Orbital primitives (`Icon/Mascot/Chip/Button/ChefAvatar/Pips/StatusBadge/VoiceCue`); App shell + view router; `useTweaks`→localStorage. *(no backend)*
- **P1** Data-layer reuse: `useLedger/useTerminals/useWebSocket` lifted from `App.tsx`; keep `terminalStream`/`eventBus`/`utils/api` verbatim.
- **P2** The Line: `ProjectsSidebar` + `Board` (grid/rail/list) + `StationCard` live (status, runtime, elapsed, scribble=`last_command`, Pips=`context_size`, Needs-Input = pane has open approval).
- **P3** New Pane / New Project / ServiceMode / All Hands.
- **P4** The Burner (`TerminalWindow`): wrap existing `TerminalView` + draft sync + `ControlKeyBar`.
- **P5** Kitchen Radio + Approvals (reuse dialogs + audio/transcript).
- **P6** Back of House (settings rooms; Rulebook reuses `CapabilityMatrixTab`; Loading Dock/Boss disabled).
- **P7** The Pass + JotNote (notes-backed); BeadsExplorer disabled placeholder.
- **P8** The Pantry (panes + notes + About; git pane disabled placeholder).

## REUSE VERBATIM (do not rebuild — working, load-bearing plumbing)
`src/terminalStream.ts`, `src/components/TerminalView.tsx`, `src/components/ApprovalDialog.tsx`, `src/components/ActionConfirmDialog.tsx`, `src/components/CapabilityMatrixTab.tsx` + `src/gateSurface.ts`, `ControlKeyBar` + raw-key allowlist, `src/components/EmergencyStop.tsx` (stage machine), `src/eventBus.ts`, `src/utils/api.ts`, draft-sync effect (focus-lock), WS subscription + audio pipeline, `?mock=1` e2e harness + fixtures.
