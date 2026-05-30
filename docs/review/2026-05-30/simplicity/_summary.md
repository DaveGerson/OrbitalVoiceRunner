# Simplicity & Clarity Review — Summary (2026-05-30)

Lens: SIMPLICITY & CLARITY only. Per-chunk detail lives in `chunk-1.md` … `chunk-5.md`.

## Scores

| # | Chunk | Score /10 |
|---|-------|-----------|
| 1 | Voice Pipeline & Gemini Live Conversation | 6 |
| 2 | Terminal / Pane Lifecycle & Live I/O | 7 |
| 3 | Command Proposal, Permissions & Approvals | 9 |
| 4 | Status Detection, Monitoring, Attention & Proactive Alerts | 6 |
| 5 | Ledger, Projects/Knowledge, Orchestration Plans & Settings | 5 |

**Overall: ~6.6/10.** The pure, extracted "decision core" modules (`pendingApprovals`, `approvalIntent`, `decideStatus`, `announcementKinds`, `notificationStack`, `eventBus`, `ptyTransport`) are consistently excellent — small, single-responsibility, unit-tested, data-driven. Nearly all the simplicity debt is concentrated in the two mega-files, `server.ts` and `src/App.tsx`, where good cores are wrapped in long, repetitive, deeply-nested glue.

## The 5 biggest simplicity wins across the codebase

1. **Convert the Gemini Live inline tool-dispatch `if/else if` chain into a dispatch table** (`server.ts:1491-~1995`, ~25 tools). This is the largest single win: it shrinks the ~600-line `onmessage` closure by an order of magnitude, makes the audio-forwarding path visible again, and erases ~25 copies of the identical `sendToolResponse({functionResponses:[{name,id:call.id,response:{output}}]})` line (Chunks 1, 3, 5).
2. **Collapse SettingsDialog's four-way restatement of the settings shape** into one `useState<SystemSettings>` object + `update` helper (`SettingsDialog.tsx:100-256`): removes ~24 field useState hooks, the hand-copy hydration effect, `getCompiledSettings`, and the 20-entry dep array (Chunk 5).
3. **Delete the dead `universal_terminal.py`** (+ its test): a complete second PTY-spawn implementation kept alive only by its own test, never referenced by the TS runtime, presenting a redundant mental model (Chunk 2).
4. **Extract a `pushAttention()` helper and decompose `handlePlansTrigger`** (`server.ts:364-513` + the 4 duplicated AttentionItem-push blocks): removes ~30 lines of copy-pasted "build item + random id + prune + broadcast" and flattens 6-7 levels of plan-advancement nesting (Chunk 4).
5. **Replace `playEarcon`'s 100-line oscillator if/else with a `playTone` primitive + per-earcon note table** (`App.tsx:79-178`), and apply the same data-table treatment to the duplicated cleanup/reconnect/preset-command idioms scattered through App.tsx and terminal.ts (Chunks 1, 2).

Cross-cutting micro-win seen everywhere: the `"<prefix>_" + Math.random().toString(36).substring(2,11)` id idiom (8+ sites) and `attentionQueue.filter(i => !i.dismissed)` (6+ sites) both want a single shared helper.
