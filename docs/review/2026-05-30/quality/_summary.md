# Quality & Correctness Review — Summary (2026-05-30)

Lens: **does the code actually do the job, correctly and robustly?** (Opus quality/correctness reviewer.)

## Scores

| Chunk | Area | Score /10 |
| ----- | ---- | --------- |
| 1 | Voice Pipeline & Gemini Live Conversation | 6 |
| 2 | Terminal / Pane Lifecycle & Live I/O | 6.5 |
| 3 | Command Proposal, Permissions & Approvals (security-critical) | 5.5 |
| 4 | Status Detection, Monitoring, Attention & Proactive Alerts | 6 |
| 5 | Ledger, Projects/Knowledge, Orchestration Plans & Settings | 5 |
| | **Overall** | **~5.8** |

## Headline

The *designed* core — the pure `decideProposal` gate, the atomic claim, exactly-once dispatch, redaction, the status state-machine and de-spam bus — is genuinely well-engineered and tested. The failures cluster at the **edges that the tests don't cover**: there are FOUR separate write paths that bypass the permissions gate the system advertises, the API key leaks over the settings broadcast, and several lifecycle paths (restart, project-delete, pane-exit) are incorrect.

## CRITICAL issues (permission/HiTL bypass — operator safety guarantee is false as shipped)

1. **`handoff_context_between_panes` bypasses HiTL** — `server.ts:1823-1853`. Tool checks only Read-Only; writes model-controlled multi-line content to a target agent pane's stdin with no approval. (Chunk 3)
2. **`POST /api/handoff` bypasses ALL gating** — `server.ts:1058-1075`. REST handoff writes to target stdin with no permission check whatsoever. (Chunk 5)
3. **`POST /api/plans/:id/execute` bypasses the gate** — `server.ts:990-1004`. REST plan-start writes step 1 directly; the equivalent `execute_plan` tool is correctly gated, so voice is safe but REST is not. (Chunk 5)

## HIGH issues

4. **`set_voice_mute` is a client-side no-op** — `src/App.tsx:933-937` + `server.ts:1706`. The settings_updated handler never syncs `isMicMuted`, so "mute by voice" keeps streaming the mic; model is told it muted (false confirmation). (Chunk 1)
5. **Restart race: `term.stop()` not awaited before `term.start()`** — `server.ts:686-694`. The dying PTY's `onExit` flips the just-restarted pane to Exited and tears down its probe timer. (Chunk 2)
6. **Auto-execute crashes on a ledger-only pane** — `server.ts:1339-1343`. `term!` non-null-asserted while `paneExists` is true for ledger-only panes; throws, and with no try/catch in the toolCall loop the model hangs unanswered. (Chunk 3)
7. **No try/catch around the entire toolCall handler loop** — `server.ts:1486-1887`. Any tool throw escapes the SDK callback, leaves `call.id` unanswered, stalls the conversation. (Chunk 3)
8. **Pane EXIT produces no notification** — `server.ts:515-521` + missing `onExit` wiring. A crashed/exited pane is silently dead — no earcon, attention item, or transition. Core monitoring hole. (Chunk 4)
9. **Watch-rule actions write un-gated** — `server.ts:336-362`. `actionCommand` is written to the target pane ignoring Read-Only. (Chunk 4)
10. **API key leaked over `settings_updated` broadcast** — `server.ts:1117-1122` (+1697,1710). GET masks `geminiApiKey`; the WS broadcast ships it in plaintext to all clients. (Chunk 5)
11. **Project delete orphans live PTYs and self-resurrects** — `server.ts:836-857`. Deletes the workspace but not its live terminals; `syncLedger` re-creates the "deleted" project. (Chunk 5)

## Notable correctness gaps the tests would miss
- The suite exercises the gated `dispatchProposal`/approval path thoroughly (`test_approvals_wse`, `test_status_gating`) but has NO test asserting Read-Only/HiTL on `POST /api/plans/:id/execute`, `POST /api/handoff`, the handoff tool, or watch rules — exactly the four bypass paths above.
- No test for pane-exit notification, the restart race, the `set_voice_mute` client effect, or the settings-broadcast key masking.

## Cross-cutting MED issues
- Status probes (`execSync`/sync `readFileSync`) block the event loop every 500ms per pane (Chunk 4).
- Global-mode TOCTOU: a pending HiTL command approved after the pane became Read-Only still executes (Chunk 3).
- Client `ws.onmessage` and `playAudioChunk` lack guards against malformed/odd-length frames (Chunk 1).
- Ledger sync/async flush can interleave on the same temp file (Chunk 5).
- New-pane early stdout is dropped before `fetchTerminals` lands (Chunk 2).

## Bottom line
The permissions model is correctly implemented in its primary path but is NOT comprehensive: four independent write paths skip it. Fixing the four bypasses (route every `writeInput` through `dispatchProposal`), wrapping the tool loop in try/catch, sanitizing the settings broadcast, and wiring pane-exit are the highest-leverage correctness fixes.
