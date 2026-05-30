# Orbital Harness — Janus — Multi-Lens Code Review Synthesis (2026-05-30)

Integrator: Opus. Synthesizes the simplicity, maintainability, and quality/correctness
lenses across the 5 functional chunks defined in `CHUNKS.md`. (Gemini 3.5/3.1 model
names are operator-confirmed and intentionally NOT flagged.)

---

## 1. Executive summary

The codebase has a sharply **bimodal quality distribution**. Its extracted *pure-decision*
modules — `pendingApprovals.ts`, `approvalIntent.ts`, `statusMachine.ts`, `statusProbe.ts`,
`announcementKinds.ts`, `announcementBus.ts`, `notificationStack.ts`, `eventBus.ts`,
`ledger.ts` — are genuinely excellent: single-responsibility, injected seams, documented with
the bug/invariant each rule fixes, and backed by thorough fixture/replay tests. All three
lenses independently rate these as reference-grade. The problem is that everything that did NOT
get extracted lives in two god-files — `server.ts` (2294 LOC) and `src/App.tsx` (3942 LOC) —
where good cores are wrapped in long, deeply-nested, untyped, untested glue. The single most
serious finding is that the security-critical permissions gate, beautifully built in its primary
`propose_command` path, is bypassed by **four independent write paths** (handoff tool, REST
handoff, REST plan-execute, watch-rule actions), so the system's "every agent command is gated"
guarantee is **false as shipped**. Secondary headline risks: the `geminiApiKey` is broadcast in
plaintext to all WS clients (the GET-mask is defeated), pane EXIT produces no alert at all
(a hole at the center of the monitoring story), and several lifecycle paths (restart race,
project-delete) are incorrect. The recurring structural causes are: god-files, an `any`-typed
wire protocol with no shared discriminated union, re-spelled vocabularies (permission modes /
presets / transitions), and untested write/classify paths despite otherwise strong test infra.
The team clearly knows the right pattern — the comments cite it repeatedly — the refactor is
simply half-done.

---

## 2. Per-component scorecard

| # | Chunk | Simpl | Maint | Qual | **Blended /10** | Verdict |
|---|-------|:-----:|:-----:|:----:|:---------------:|---------|
| 1 | Voice Pipeline & Gemini Live | 6 | 6 | 6 | **6** | Core loop works; voice-mute is a dead client no-op and earcon AudioContext leaks. |
| 2 | Terminal / Pane Lifecycle & Live I/O | 7 | 5 | 6.5 | **6** | Solid transport seam undermined by an un-awaited restart race and 4× duplicated preset maps. |
| 3 | Permissions & Approvals | 9 | 9 | 5.5 | **5** | Reference-grade pure core wrapped around a gate with real bypasses — security verdict dominates. |
| 4 | Status / Monitoring / Alerts | 6 | 7 | 6 | **5.5** | Excellent probe/machine layer, but pane EXIT never alerts and watch-rule writes are un-gated. |
| 5 | Ledger / Plans / Settings | 5 | 5 | 5 | **5** | Durable ledger, but 2 REST gate-bypasses, an API-key leak, and self-resurrecting project delete. |

**Blending rule (not a blind average):** correctness/security is weighted heavily wherever a
permission bypass, credential leak, or silent data loss exists — a beautifully-built gate with
bypasses around it is a security defect, not an "average." So Chunk 3's 9/9 craftsmanship does
**not** rescue it: its blended score is pulled to **5** because the quality lens found 1 CRITICAL +
2 HIGH gate/robustness defects on the very surface the chunk exists to protect. Chunk 5 (2 CRITICAL
+ 2 HIGH) holds at 5. Chunk 4 lands at 5.5 (a HIGH monitoring hole + a HIGH un-gated write against
a strong pure layer). Chunks 1 and 2 round to 6 (functional cores, HIGH-but-contained defects).
Where lenses agreed (clean cores, god-file debt) the simplicity/maintainability scores were taken
at face value; where they disagreed (Chunk 3: 9/9 vs 5.5) the disagreement is resolved explicitly
in favor of the security lens.

---

## 3. Codebase-wide CRITICAL / HIGH issues (deduplicated, prioritized)

Quality lens reported **3 CRITICAL + 8 HIGH**. After merging duplicates the other lenses also
raised (the handoff bypass and the god-file/`any`-protocol themes), the prioritized list is:

### CRITICAL (operator-safety guarantee is false as shipped)

> The four permission/approval bypass paths are grouped as **#1** because they share one root
> cause and one fix: not every `writeInput` is routed through `dispatchProposal`/`effectiveModeFor`.

1. **Permission-gate BYPASS cluster — the "every command is gated" guarantee is breakable four ways.**
   - **C1a — `handoff_context_between_panes` bypasses HiTL.** `server.ts:1823-1853` (write at `:1849`).
     Checks only Read-Only (`:1836`); for HiTL/Full-Auto panes it writes model-controlled multi-line
     `context_notes` to a target agent pane's stdin with no approval. The code's own comment
     (`:1829-1832`, TODO WS-G) flags it. Raised by quality (CRITICAL) and corroborated by
     maintainability Ch2/Ch3 and quality Ch5.
   - **C1b — `POST /api/handoff` bypasses ALL gating.** `server.ts:1058-1075` (write at `:1075`).
     REST handoff writes to target stdin with **no** permission check whatsoever.
   - **C1c — `POST /api/plans/:id/execute` bypasses the gate.** `server.ts:990-1004` (write at `:1001`).
     REST plan-start writes step 1 directly; the equivalent `execute_plan` **tool** is correctly gated
     (`server.ts:1769` → `dispatchProposal`), so the *same operation* is safe by voice but unsafe by REST.
   - **Fix for all:** route every one of these writes through `dispatchProposal` / `effectiveModeFor`
     so Read-Only and HiTL are honored on every write path, not just `propose_command`.

### HIGH

2. **Watch-rule actions write un-gated.** `server.ts:336-362` (write at `:345`). `actionCommand` is
   injected into the target pane ignoring its effective mode; a Read-Only pane is not actually
   write-protected against operator-armed automation. (This is the 4th bypass — same fix as #1.)
3. **`geminiApiKey` leaked over `settings_updated` broadcast.** `server.ts:1117-1122` (+`:1697`,`:1710`).
   `GET /api/settings` masks the key (`:1102-1106`), but `broadcast({settings: manager.settings})` ships
   it verbatim in plaintext to every WS client and into client React state. Fix: sanitize a copy
   (same masking as GET) before broadcasting.
4. **Pane EXIT produces no notification.** `server.ts:515-521` + missing `onExit` wiring. The
   `status==="Exited" => "exited"` branch is effectively dead because it only runs from a data event,
   and an exited process emits no further data. No earcon, attention item, transition, or desktop
   notification — a crashed pane is silently dead. Core monitoring hole. Fix: wire
   `UniversalTerminal.onExit` → `exited` announcement + attention push.
5. **Restart race: `term.stop()` not awaited before `term.start()`.** `server.ts:686-694`. `stop()` is
   async (SIGTERM→SIGKILL after 1s); the dying PTY's `onExit` later flips the just-restarted pane to
   Exited and tears down its probe timer; two PTYs briefly share the scrollback file. Fix:
   `await term.stop()` (make handler async) or detach the old transport's callbacks in `stop()`.
6. **No try/catch around the entire toolCall handler loop.** `server.ts:1486-1887`. Any throw in any
   tool handler escapes the Gemini SDK `onmessage` callback, leaves `call.id` unanswered, and stalls
   the conversation. Wrap each branch so a failure returns an error tool-response.
7. **Auto-execute crashes on a ledger-only pane.** `server.ts:1339-1343`. `term!` is non-null-asserted
   while `paneExists` is true for ledger-only panes (no live PTY); a Full-Auto `propose_command` to a
   restored-but-unspawned id throws `TypeError`, and with #6 absent the model hangs. Fix: require a
   LIVE terminal for `auto_execute`/`pending_approval`.
8. **`set_voice_mute` is a client-side no-op.** `src/App.tsx:933-937` + `server.ts:1706`. The
   `settings_updated` handler never calls `setIsMicMuted`, and the mic gate (`App.tsx:890`) reads only
   local `isMicMutedRef`. The model is told "Microphone now muted" while capture keeps streaming — a
   false confirmation. Root cause is split-brain mute state (maintainability Ch1). Fix: propagate
   `msg.settings?.voiceAi?.isMicMuted` to `setIsMicMuted`.
9. **Project delete orphans live PTYs and self-resurrects.** `server.ts:836-857`. Deletes
   `ledger.workspaces[id]` but not the live terminals whose `projectId===id`; the still-running PTYs
   keep emitting, and the next `syncLedger()` (`terminal.ts:750-757`) auto-recreates the "deleted"
   project. Fix: stop and remove all of the project's terminals before deleting the workspace.

### Cross-cutting MED (call out, fix opportunistically)
- Global-mode TOCTOU: a pending HiTL command approved *after* the pane became Read-Only still executes
  (`server.ts:1202-1208`); re-check `effectiveModeFor` at approve time.
- Status probes do blocking `execSync`/`readFileSync` on the event loop every 500ms per pane
  (`statusProbe.ts:326-388`) — stalls the WS/audio bridge under load.
- Error classifier false-positives on substrings (`server.ts:536-542`) — `"Error:"` in normal output
  fires spurious alerts; scope to recent tail / make line-anchored / exit-code aware.
- New-pane early stdout dropped before `fetchTerminals` lands (`App.tsx:301-310`).
- Ledger sync/async flush can interleave on the same temp file (`ledger.ts:90-107`).
- Recipes/`create_pane` can seed Full-Auto panes with no operator confirmation
  (`server.ts:1674-1687`, `:1034-1051`, `:1798-1818`).

---

## 4. Topical recommendations per chunk (all three lenses fused)

### Chunk 1 — Voice Pipeline & Gemini Live  (blended 6)
1. **Fix `set_voice_mute` and collapse split-brain mute** — drive `setIsMicMuted` from the
   `settings_updated` handler (`App.tsx:933`) so voice mute actually gates capture (HIGH correctness).
2. **Dispatch-table the inline tool chain** — convert the ~21-25-branch `if/else if` in the `/live`
   `onmessage` closure (`server.ts:1491-~1995`) into a `Record<string, handler>` registry; this is the
   single biggest simplicity+maintainability+testability win and makes the audio-forward path
   (`server.ts:1477-1483`) visible again. Also fix the broken indentation there.
3. **Type the WS protocol** — replace `JSON.parse → any` + string-literal `if/else` (`App.tsx:904-998`)
   with an exhaustive switch over a shared discriminated union.
4. **Fix the earcon AudioContext leak** — reuse one long-lived `AudioContext` and data-drive `playEarcon`
   with a `playTone` primitive + per-earcon note table (`App.tsx:79-178`); stop the silent `catch {}`.
5. **Factor SDK glue** — one `collectText(parts)` helper for the 3 part-extraction loops
   (`server.ts:1391-1411`, drops the `as any` casts); extract/version the inline `systemInstruction`
   (`server.ts:1895`); harden `playAudioChunk` against odd-length frames (`audio.ts`).

### Chunk 2 — Terminal / Pane Lifecycle & Live I/O  (blended 6)
1. **`await term.stop()` before `start()`** in the restart route (`server.ts:686-694`) — or detach the
   old transport callbacks — so the dying PTY can't zombify the restarted pane (HIGH correctness).
2. **Delete dead `universal_terminal.py` + its test** — a complete orphaned second PTY implementation
   with a divergent ANSI stripper, kept alive only by its own green test (simplicity+maintainability).
3. **One `presetToCommand(preset)` + `applySkipFlag(cmd,mode)` helper** to replace the 4× duplicated,
   already-diverging preset→command maps (`terminal.ts:690-693`, `server.ts:699-702`,
   `parsePresetsSafe`, `CreateTerminalDialog.tsx:31-39`; `claude` vs `claude-code` drift).
4. **Validate `create_pane` and surface duplicate-id as an error** (`server.ts:1674-1687`,
   `terminal.ts:716-718` — currently returns a string treated as `success:true`); retain buffered
   chunks for unknown pane ids in `queueStdoutChunk` (`App.tsx:301-310`) so first output isn't lost.
5. **Decompose the `UniversalTerminal` god-class** — extract scrollback persistence and session-ID
   scraping to collaborators; define a shared `PaneDTO` and convert `addTerminal`'s 7 positional params
   to an options object; make `appendScrollback` async/batched (`terminal.ts:451-454`).

### Chunk 3 — Command Proposal, Permissions & Approvals  (blended 5)
1. **Route `handoff_context_between_panes` through `dispatchProposal`** (`server.ts:1823-1853`) so the
   gate has no bypass — #1 fix, security-critical (CRITICAL).
2. **Require a LIVE terminal for write dispatch** (`server.ts:1339-1343`) and **wrap the whole toolCall
   loop in try/catch** (`server.ts:1486-1887`) so a throw answers `call.id` instead of hanging the
   model (HIGH).
3. **Re-check `effectiveModeFor` at approve time** (`server.ts:1202-1208`) so a pending command voids if
   the pane became Read-Only after the proposal (MED TOCTOU).
4. **Introduce a shared `PermissionsMode` type/const** and import everywhere the four mode strings
   appear (≥15 sites in `types.ts` alone, plus `terminal.ts`/`pendingApprovals.ts`/UI); type the live
   `session` with a minimal `LiveSession` interface to kill the `sess: any` boundary.
5. **Extract mock-mode out of `handleApprove`** (`App.tsx:693-711`, the literal `tailwindcss`/`pandas`
   fabricated output) behind a mock adapter; share one `resolvePending(id, approved)` helper for
   approve/reject and only remove pending state after the POST resolves (stop `catch {}`).

### Chunk 4 — Status Detection, Monitoring, Attention & Alerts  (blended 5.5)
1. **Wire transport `onExit` → `exited` attention item + announcement** (`server.ts:515-521`) so a dead
   pane actually alerts — the central monitoring hole (HIGH).
2. **Route watch-rule `actionCommand` writes through `effectiveModeFor`** (`server.ts:336-362`) so
   Read-Only is honored by automation (HIGH — 4th bypass).
3. **Extract a pure `classifyTransition(chunk,status,runtimeType)` module** with the build-failed/error
   trigger phrases as named constants in `statusConstants.ts` (out of `server.ts:515-558`), and
   fixture-test it like the probe parsers; this also fixes the substring false-positives (MED).
4. **Add `manager.addAttention()`/`dismissAttention()`** encapsulating push + `pruneAttention` +
   broadcast to replace the 4× copy-pasted triple (`server.ts:389,414,482,573`) and make the BUG-035
   prune impossible to forget; add an `unreadAttention` memo for the ~8 inline `!dismissed` filters.
5. **Make probes async / share one process snapshot per tick** (`statusProbe.ts:326-388`) so they don't
   block the event loop; give pending-approval its own `AnnouncementKind` instead of reusing `exited`
   (`server.ts:1352`).

### Chunk 5 — Ledger, Projects/Knowledge, Plans & Settings  (blended 5)
1. **Gate `POST /api/plans/:id/execute` and `POST /api/handoff`** through `dispatchProposal`/
   `effectiveModeFor` (`server.ts:990-1004`, `:1058-1075`) — the two REST bypasses (CRITICAL).
2. **Sanitize the settings broadcast** — mask `geminiApiKey` before any `settings_updated`
   (`server.ts:1117-1122`, `:1697`, `:1710`) (HIGH credential leak).
3. **Fix project delete** — stop and remove all live terminals for the project before deleting the
   workspace (`server.ts:836-857`) so PTYs don't orphan and `syncLedger` can't resurrect it (HIGH).
4. **Extract a pure `advancePlan()` module** out of `handlePlansTrigger` (`server.ts:364-510`) — the
   riskiest untested write path — and unit-test advance/pause/complete; collapse SettingsDialog's
   four-way settings restatement (`SettingsDialog.tsx:100-256`, ~24 useState hooks + hydration +
   `getCompiledSettings` + dep array) into one `useState<SystemSettings>` + `update` helper.
5. **Define named `PermissionsMode`/`ToolPreset`/`Transition` aliases in `types.ts`** (kills ~15 inline
   unions); move recipes to a typed `recipes.ts`; add `genId(prefix)` and `saveNow()/saveDebounced()`
   to replace the `ledger["save"](bool)` bracket-access and the 8+ random-id idiom sites; make sync vs
   async ledger flush mutually exclusive (`ledger.ts:90-107`).

---

## 5. Cross-cutting themes

- **Two god-files concentrate all untested, untyped residue.** `server.ts` (2294) and `App.tsx`
  (3942) hold the side-effects and the not-yet-extracted decisions; the clean modules are pure
  decisions. The `/live` `onmessage` closure (~700-1000 LOC, ~25 inline tools), `handlePlansTrigger`,
  `detectAndTriggerTransitions`, and the App.tsx `ws.onmessage` ladder are giant closures mixing
  decision + side-effect that each *should* be a pure module like their neighbors.
- **No shared, typed wire protocol — `any` at every boundary.** `broadcast(msg: any)`
  (`server.ts:307`), `JSON.parse → any` on both WS handlers, `session: any` for the Gemini Live handle,
  `listPanes(): any[]`. ~20 stringly-typed message types are duplicated as literals on both sides with
  no shared discriminated union — the single highest-leverage typing fix and a recurring drift source.
- **Re-spelled vocabularies.** `"Full Auto" | "Human-in-the-Loop" | "Read-Only"` appears as inline
  literal unions ~15× in `types.ts` alone (plus terminal.ts / pendingApprovals.ts / UI); the
  transition union and `AnnouncementKind` are near-duplicate event vocabularies. No
  `PermissionsMode`/`ToolPreset`/`Transition` aliases, so every addition is a multi-site edit with no
  compiler enforcement.
- **The permission gate is a single airtight choke-point with four write paths routed around it.**
  The pure `decideProposal`/`dispatchProposal` core is reference-grade, but handoff (tool + REST),
  REST plan-execute, and watch-rule actions all call `writeInput` directly. One fix pattern (route
  every write through `dispatchProposal`) closes all four.
- **The riskiest logic is the least tested.** Excellent fixture/replay coverage for the pure modules,
  but NO test asserts gating on the four bypass paths, pane-exit notification, the restart race, the
  `set_voice_mute` client effect, the settings-broadcast masking, the build/error classifier, or the
  multi-step plan-advancement gate — exactly the write/classify paths that can hurt.
- **Dead code, duplicated mappings, demo logic in production.** Orphaned `universal_terminal.py` with a
  divergent ANSI stripper and its own green test; preset→command mapping duplicated 4 ways (with
  `claude` vs `claude-code` drift); mock-mode fabricated output inlined in real handlers
  (`App.tsx:693-711`); recipes hardcoded inline (`server.ts:877-897`); and the `genId` /
  attention-push-triple / `ledger["save"]` idioms copy-pasted across many sites.

---

## 6. Suggested fix sequence (do-this-first ordering)

**Phase 1 — Security bypasses (fix together; one pattern).** Route every direct `writeInput` through
`dispatchProposal`/`effectiveModeFor`: handoff tool (`server.ts:1849`), REST handoff (`:1075`), REST
plan-execute (`:1001`), watch-rule actions (`:345`). Add a regression test per path asserting
Read-Only/HiTL is honored.

**Phase 2 — Data leak & robustness.** Sanitize the `settings_updated` broadcast to mask `geminiApiKey`
(`server.ts:1117-1122`); wrap the toolCall loop in try/catch (`:1486-1887`); require a live terminal for
write dispatch (`:1339-1343`).

**Phase 3 — Lifecycle correctness / races.** `await term.stop()` in restart (`server.ts:686-694`); wire
pane `onExit` → attention/announcement (`:515-521`); fix project-delete to stop terminals + prevent
resurrection (`:836-857`); fix `set_voice_mute` client propagation (`App.tsx:933-937`); re-check
effective mode at approve time (`:1202-1208`).

**Phase 4 — Maintainability refactors.** Define the shared typed WS message union + minimal
`LiveSession` interface; extract the tool-dispatch registry, `classifyTransition`, and `advancePlan`
pure modules; add `PermissionsMode`/`ToolPreset`/`Transition` aliases; add `manager.addAttention()`,
`genId(prefix)`, `presetToCommand()`, `saveNow()/saveDebounced()`; make probes async; delete
`universal_terminal.py`. Add the missing unit tests for the now-extracted classify/advance paths.

**Phase 5 — Simplicity polish.** Collapse SettingsDialog's four-way settings restatement; data-drive
`playEarcon`; dedupe `cleanupSocketOnly`/reconnect/part-extraction helpers; `unreadAttention` memo;
isolate mock-mode behind an adapter; move recipes to a data module.
