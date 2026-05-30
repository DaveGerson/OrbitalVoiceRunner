# Prompt-Composer Refactor — Target Architecture

> Branch: `claude/prompt-composer-refactor`
> Status: in progress
> Supersedes the "autonomous multi-pane orchestrator" framing of the original
> codebase.

## 1. The reframe

OrbitalVoiceRunner was built as an **autonomous multi-pane orchestrator**:
watch-rules that fire on their own, plans that march across panes A→B→C, and a
voice agent (Janus / Gemini Live) that decides and acts.

That is **not** the product we want. The product is a **conversational
prompt-composer**:

> A conversational interface to work on projects inside Claude Code — one that
> helps the operator structure their thinking, out loud, into well-formed input
> prompts that the operator then sends to the CLI agent in the pane they are
> working in.

Janus is a **co-pilot**, not an autopilot. It observes everything, but it acts
on nothing without the operator, and only ever on the pane the operator is
actively engaged with.

Almost every security finding from the 2026-05-30 review (the ungated
cross-pane `writeInput`, the model-armable watch rules, the manufacturable
status transitions, the handoff stdin injection) exists **only** because of the
orchestrator framing. Removing the framing removes the holes; it is less code
and less attack surface, not more.

## 2. Core principles

1. **Single active pane.** Exactly one pane is "active" (engageable) at a time.
   The system maintains situational awareness of all panes, but Janus may only
   write to the active one.
2. **No autopilot.** Nothing writes to a CLI pane in the background. There are
   no autonomous, unattended, cross-pane pipelines. If a write happens, the
   operator caused it in the moment.
3. **One write door.** Every write into a CLI pane's stdin goes through a single
   gated path (`dispatchProposal`). The gate is not a safety wrapper bolted onto
   automation — it **is** the product loop: conversation → proposed prompt →
   operator approves → write to active pane.
4. **Context is free.** Writing to a pane's *orientation context* (what the live
   model reads to understand the pane) is NOT a CLI write and is NOT gated.
   Context is layered (see §4).
5. **Operator is above the gate.** Direct operator actions (button clicks,
   typing) are fully un-gated, including on Read-Only panes. The gate constrains
   Janus, not the human.

## 3. Three tiers of "who may write to a CLI pane"

| Actor | May write to CLI stdin? | Gate |
|---|---|---|
| **Operator** (clicks, typing) | Any pane | None — fully un-gated |
| **Janus / Gemini Live** | The one **active** pane only | Current policy mode via `dispatchProposal` |
| **Background automation** | **Never** | n/a — removed |

Writes to *model/orientation context* (any actor): never gated (§4).

## 4. Layered per-terminal context (the substrate)

Today context is a single flat bucket: `PaneMeta.notes: string[]`. The composer
needs two distinct, ungated layers per pane, plus the durable session record:

- **`modelContext`** — orientation notes written by Janus and the async
  synthesizer. Machine-maintained; the operator may edit/clear it.
- **`humanContext`** — notes the operator types to steer/override. Authoritative
  when present.
- **session record** — `session_id`(s) + last known state, maintained routinely
  so a project/terminal can be closed and restarted gracefully.

The conversation refines context; context shapes the proposed prompt; the
operator approves the prompt; the prompt is the only thing that reaches the CLI.

`addPaneNote` (the existing primitive at `ledger.ts:138`) is the seam where this
layering is introduced.

## 5. Keep / Demote / Remove manifest

Code locations are from `server.ts` / `src/` at branch point.

### Keep — becomes the center
- `dispatchProposal` and the effective-mode gate — promote to the primary loop.
- Per-pane status/situational awareness (`statusMachine`, `statusProbe`).
- The voice/announcement bus as the conversational surface.

### Build — new
- Layered per-terminal context (`modelContext` + `humanContext`) — §4.
- Durable per-terminal session record for graceful restart.

### Demote — engine → passive structure
- **Plans** (`server.ts:377` `handlePlansTrigger`, `:445-472` auto-advance,
  `activePlanGate` at `:302`/`:2211`/`:2259`): stop being an execution engine.
  A plan becomes a *living outline of what we intend to ask Claude Code next* —
  read/written as context, never auto-executed. Delete the auto-advance write
  and the `activePlanGate` machinery.

### Remove — the holes
- **Watch-rule autonomous writes**: `targetTerm.writeInput(rule.actionCommand)`
  at `server.ts:358`. Gone (at most demoted to an attention nudge that never
  writes).
- **`add_watch_rule` Gemini tool** (`server.ts:1729`, decl `:2116`): model can no
  longer arm deferred writes.
- **Handoff stdin injection**: the `writeInput` of a comment block at
  `server.ts:1861` (and `:1088`). Handoff carries *context*, so it writes to the
  target pane's `modelContext`, never its stdin.
- Any remaining path that writes to a non-active pane.

## 6. Build sequence

1. **Anchor** — this document. ✅
2. **Context substrate** — layered `modelContext` / `humanContext` on `PaneMeta`,
   ledger accessors, back-compat load of existing flat `notes`. ✅
3. **Remove autonomous writes** — watch-rule write + `add_watch_rule`; convert
   handoff to a context write. ✅
4. **Demote plans** — strip auto-advance + `activePlanGate`; keep plan as outline.
   Advancement now pauses + surfaces the next step as a suggestion, never writes. ✅
5. **Single active pane** — make "active pane" first-class; constrain Janus
   writes to it. ⏳
6. **Prompt-composer loop** — make conversation → proposed prompt → approve →
   send the explicit primary flow in the UI and the voice layer. ⏳

Each step keeps `npm run lint` and `npm test` green before moving on.
