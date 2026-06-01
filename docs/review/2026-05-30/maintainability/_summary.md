# Maintainability & Clean-Code Review — Summary (2026-05-30)

Lens: **maintainability & clean code only**. Reviewer: Opus. Codebase: OrbitalVoiceRunner / "Orbital Harness — Janus".

## Scores

| Chunk | Name | Score /10 |
|------:|------|:---------:|
| 1 | Voice Pipeline & Gemini Live Conversation | 6 |
| 2 | Terminal / Pane Lifecycle & Live I/O | 5 |
| 3 | Command Proposal, Permissions & Approvals | 9 |
| 4 | Status Detection, Monitoring, Attention & Proactive Alerts | 7 |
| 5 | Ledger, Projects/Knowledge, Orchestration Plans & Settings | 5 |
| | **Average** | **6.4** |

## The pattern

This codebase has a **bimodal quality distribution**. The extracted pure modules — `pendingApprovals.ts`, `approvalIntent.ts`, `statusProbe.ts`, `statusMachine.ts`, `announcementKinds.ts`, `announcementBus.ts`, `notificationStack.ts`, `eventBus.ts`, `ledger.ts` — are genuinely excellent: single-responsibility, injected seams, exhaustively documented with the bug/invariant each rule fixes, and backed by thorough fixture/replay tests. Chunk 3 (approvals) is a reference example of how to do this well.

The problem is **everything that did NOT get extracted lives in two god-files**: `server.ts` (2294 LOC) and `src/App.tsx` (3942 LOC). The clean modules are pure *decisions*; the god-files hold all the *side-effects, wiring, and the logic that nobody got around to extracting yet* — and that residue is where the maintainability debt concentrates. The team clearly knows the right pattern (the comments cite it repeatedly); the work is half-done.

## 5 biggest codebase-wide maintainability risks

1. **Two god-files concentrate the untested, untyped logic.** The `/live` connection callback (server.ts:1266-2254, ~1000 LOC, ~25 inline tool handlers), `handlePlansTrigger` (server.ts:364-510), `detectAndTriggerTransitions` (server.ts:515-597), and the App.tsx `ws.onmessage` ladder (App.tsx:904-997) are all giant closures mixing decision + side-effect. Each contains logic that *should* be a pure module like its well-factored neighbors but isn't — so it is hard to test, hard to navigate, and hard to onboard onto.

2. **No shared, typed wire protocol; `any` at every boundary.** `broadcast(msg: any)` (server.ts:307), `JSON.parse → any` on both WS message handlers, `session: any` for the Gemini Live handle everywhere, and `listPanes(): any[]`. The server↔client contract is ~20 stringly-typed message types duplicated as literals on both sides with no shared discriminated union — the single highest-leverage typing fix, and a recurring drift source.

3. **Vocabulary duplication: permission modes, presets, and transitions are re-spelled everywhere.** `"Full Auto" | "Human-in-the-Loop" | "Read-Only"` appears as inline literal unions ~15 times in types.ts alone (plus terminal.ts, pendingApprovals.ts, UI); the transition union and `AnnouncementKind` are near-duplicate event vocabularies. No named `PermissionsMode`/`ToolPreset`/`Transition` aliases, so the compiler enforces nothing and every addition is a multi-site edit.

4. **Untested critical write/classify paths despite strong test infra.** The build-failed/error text classifier (server.ts:524-542) and the multi-step plan-advancement gate (server.ts:364-510) — both of which can write to panes or fire high-severity alerts — have no dedicated unit tests, even though the surrounding pure modules are exhaustively covered. The riskiest logic is the least tested.

5. **Dead code, duplicated mappings, and demo logic interleaved with production.** `universal_terminal.py` is a fully orphaned second PTY implementation (with its own green test and a divergent ANSI stripper); preset→command mapping is duplicated 4 ways with the Claude command literally differing (`claude` vs `claude-code`); mock-mode simulation with fabricated output strings lives inside real handlers (App.tsx:693-711); recipes are hardcoded inline in server.ts; and the `genId`/attention-push/`ledger["save"]` idioms are copy-pasted across many sites. Collectively these are onboarding traps and silent-drift hazards.

### Cross-cutting top recommendations (ordered by leverage)
1. Define one shared, typed WS message union + a minimal `LiveSession` interface (kills risks #2, much of #1's testability problem).
2. Extract the remaining "decisions" from the god-files into pure modules: `classifyTransition`, `advancePlan`, a tool-handler registry, an `earcons` table (kills #1, #4).
3. Introduce named type aliases for the mode/preset/transition vocabularies (kills #3).
4. Delete `universal_terminal.py`; add `presetToCommand`, `genId(prefix)`, `manager.addAttention()` helpers; pull mock-mode behind an adapter (kills #5).
