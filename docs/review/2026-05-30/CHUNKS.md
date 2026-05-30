# Review Manifest — Functional Chunk Map (2026-05-30)

This review is organized by **discrete end-to-end functionality**, not code layer.
Each chunk spans frontend (React/App.tsx + components), backend (server.ts + src/*.ts),
and the Python PTY layer where relevant. The two large files — `server.ts` (2294 LOC)
and `src/App.tsx` (3942 LOC) — intentionally appear in multiple chunks; review only the
slices relevant to that chunk's functionality.

Gemini model note (operator-confirmed, do NOT flag): Gemini model names in this repo are
on the **3.5 and 3.1** branches. These are real, tested, existing models. Do not raise
findings about "unknown/invalid/hallucinated Gemini model names" — that is expected.

---

## Chunk 1 — Voice Pipeline & Gemini Live Conversation
End-to-end: mic capture → PCM16 encode → WS `/live` → Gemini Live session → audio out →
earcons / spoken narration; voice mute.
- `src/utils/audio.ts` — audio encode/playback
- `src/App.tsx` — mic capture, `/live` WS client, `playEarcon`, earcon synthesis, audio out
- `server.ts` — Gemini Live session setup, `systemInstruction`, audio frame forwarding, `set_voice_mute` (~L1266–2294)
- `src/announcementBus.ts`, `src/announcementKinds.ts`, `src/eventBus.ts` — narration/announcement plumbing

## Chunk 2 — Terminal / Pane Lifecycle & Live I/O
End-to-end: create pane → REST `/terminals` → `manager.addTerminal` → PTY spawn → `stdout_chunk`
stream → render; stdin writes; tool presets (Claude Code / Codex / Antigravity).
- `universal_terminal.py` — PTY spawn/read/write
- `src/terminal.ts` — TerminalManager, pane model, spawning
- `src/ptyTransport.ts` — transport between server and PTY
- `src/components/CreateTerminalDialog.tsx`, `src/components/TerminalView.tsx`
- `src/App.tsx` — `fetchTerminals`, `queueStdoutChunk`, stdout handling, active-terminal history
- `server.ts` — terminal REST routes, `create_pane`, `handoff_context_between_panes`, broadcast (~L640–710)

## Chunk 3 — Command Proposal, Permissions & Approvals
End-to-end: model `propose_command` → single gated dispatch (effective permissions mode:
Full-Auto / Read-Only / Human-in-the-Loop) → pending approval → ApprovalDialog → operator
approve/reject → stdin write → outcome returned to model.
- `src/approvalIntent.ts`, `src/pendingApprovals.ts`
- `src/components/ApprovalDialog.tsx`
- `server.ts` — gated dispatch path (~L1299–1675), `propose_command`, `set_global_permissions`, `set_pane_permissions`
- `src/App.tsx` — `handleApprove`, `handleReject`, `fetchPendingCommands`
- `src/components/SettingsDialog.tsx` — permissions UI

## Chunk 4 — Status Detection, Monitoring, Attention & Proactive Alerts
End-to-end: pane stdout → status classification (busy/idle/waiting) → notification stack →
attention digest / watch rules → desktop notifications / earcons / spoken digest.
- `src/statusMachine.ts`, `src/statusProbe.ts`, `src/statusConstants.ts`
- `src/notificationStack.ts`, `src/components/NotificationStack.tsx`
- `src/App.tsx` — attention queue, watch rules, `recentlyIdled`, `triggerDesktopNotification`, spoken digest
- `server.ts` — `add_watch_rule`, `get_attention_digest`, `dismiss_attention`, status fields
- `tests/fixtures/status/*` — status parser fixtures

## Chunk 5 — Ledger, Projects/Knowledge, Orchestration Plans & Settings
End-to-end: ledger persistence (`.janus_ledger.json`), projects/workspaces, notes, rename,
`switch_context` briefing, orchestration plans/recipes/handoff, settings persistence.
- `src/ledger.ts`, `src/types.ts`
- `src/components/ProjectDialog.tsx`, `src/components/SettingsDialog.tsx`, `src/utils/api.ts`
- `src/App.tsx` — ledger/settings/plans/recipes fetchers & handlers
- `server.ts` — `create_project`, `add_project_note`, `add_pane_note`, `rename_*`, `switch_context`, `create_orchestrator_plan`, `apply_orchestration_recipe`, `execute_plan`, settings REST
- `SETTINGS_SPEC.md`, `JOURNEYS_DESIGN.md` — design intent

---

## Existing test suite (use as evidence of behavior / coverage)
`tests/` — test_redaction, test_status_gating, test_status_machine, test_status_parsers,
test_announcement_bus, test_journeys, test_terminal_manager, test_approvals,
test_universal_terminal.py, test_ledger, test_approvals_wse, test_server.
