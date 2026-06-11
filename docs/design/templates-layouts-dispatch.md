# Spec: Prompt Templates, Pane Layouts, Multi-Pane Dispatch + Join

**Status:** approved direction (2026-06-11) · implementation in progress on
`claude/core-journeys-expansion-b4xx2s`
**Supersedes:** the "recipe authoring / plan builder" items in
`docs/roadmap/2026-06-10-journey-expansion.md` (J1-E2/E3, J7-E2) — see §1.

---

## 1. The model (why this shape)

Maintainer decision: **the agents in the panes do the orchestration work; the
orchestrator briefs, connects, and watches.** A `Plan` made of literal shell
commands micro-manages what a pane agent does better with one good
instruction. The investment therefore goes to:

1. **Prompt templates** — named, parameterized instruction bodies (the
   "structured response inputs"). The quality of each agent's work is mostly
   determined by the quality of the instruction it receives; templates make
   good instructions reusable and voice-fillable.
2. **Layouts** — what `TemplateRecipe` already was, renamed to what it is:
   pane *furniture* (preset/command/cwd/mode per pane), snapshot-able from a
   live project and re-appliable. No logic, nothing auto-runs.
3. **Dispatch + join** — the thin coordination kernel no pane agent can do
   itself: send one (templated) instruction to N panes, each write
   individually gated, and announce ONE completion when the whole group
   settles.

Existing `Plan`/`execute_plan` machinery stays as-is (deterministic-sequence
niche); no new UI investment in it.

## 2. Data model (DONE)

`src/types.ts`:

```ts
PromptTemplate { id, name, description?, body, created_at, updated_at }
LayoutPane     { id, name, command, cwd, preset, permissionsMode }
PaneLayout     { id, name, description?, sourceProjectId?, panes, created_at }
```

- Slots use `{{slot_name}}` (`[A-Za-z0-9_-]+`) and are **always derived from
  the body** (`extractSlots`, `src/templates.ts`) — never stored, never stale.
- Persistence: `ledger.promptTemplates` / `ledger.layouts` are self-persisting
  document arrays on **both** backends (JanusStore kv+Proxy getters +
  `persistPromptTemplates()`/`persistLayouts()`; legacy `Ledger` JSON fields),
  exactly the `watchRules`/`plans` pattern. `LedgerLike` widened accordingly.
- Dispatch groups are **in-memory** (`src/dispatch/joinTracker.ts`,
  bounded ring of 50) — session-scoped coordination; durable history is the
  action_log's job.

## 3. Action surface (DONE — `src/actions/defs/`)

| Action | Capability (reused — **no new matrix rows**) | Gate | Surfaces | REST |
|---|---|---|---|---|
| `list_prompt_templates` | `read_notes`, readOnly | Auto | voice+rest | GET /api/templates (toHttp raw array) |
| `create_prompt_template` | `update_metadata` via gateOrDefer | Auto | voice+rest | POST /api/templates |
| `update_prompt_template` | `update_metadata` | Auto | voice+rest | PUT /api/templates/:template_id |
| `delete_prompt_template` | `update_metadata` | Auto | voice+rest | DELETE /api/templates/:template_id |
| `apply_prompt_template` | `compose_draft` (ungated — draft write, like `update_draft_prompt`) | — | voice+rest | POST /api/templates/:template_id/apply |
| `save_project_layout` | `update_metadata` | Auto | voice+rest | POST /api/layouts |
| `list_layouts` | `read_notes`, readOnly | Auto | voice+rest | GET /api/layouts |
| `apply_layout` | `apply_recipe` layout veto + per-pane `create_pane` gateOrDefer (mirrors `apply_orchestration_recipe`, reuses `planRecipeApply`) | Ask | voice+rest | POST /api/layouts/:layout_id/apply |
| `delete_layout` | `update_metadata` | Auto | voice+rest | DELETE /api/layouts/:layout_id |
| `dispatch_to_panes` | `write_to_pane` — per-target `ctx.dispatchProposal` | see §4 | voice+rest | POST /api/dispatch |
| `get_dispatch_status` | `read_pane`, readOnly | Auto | voice+rest | GET /api/dispatch |

Key behaviors:
- `apply_prompt_template` instantiates into the target pane's **WIP draft**
  (`setDraft`/`appendDraft` + `draft_updated`), defaulting to the operator's
  open pane; missing slots → `clarify` (never guess). The existing draft
  review + gated send path stays the single write choke-point.
- Unknown ids resolve to ok-narration **before** the gate (watch_rules
  Decision-2 precedent).
- New WS frames: `templates_updated`, `layouts_updated`, `dispatch_updated`.
- Deferred Ask intents for the new metadata writes are **not**
  durable-replayable across restart (accepted scope-out, same as `send_keys`);
  in-process confirm replays via the staged closure.

## 4. The forceStage fan-out invariant (DONE — load-bearing safety piece)

`dispatch_to_panes` sets `forceStage: true` on every per-target
`ctx.dispatchProposal` call. In the shared engine
(`src/dispatch/paneWrite.ts applyDispatchDecision`):

1. an `auto_execute` decision is **downgraded to `pending_approval`** before
   the effect switch — a fan-out can never silently land N writes; and
2. the single-active-pane guard's clarify is skipped **only under forceStage**
   — sound precisely because of (1): the guard exists so the operator sees a
   write before it lands, and a staged approval is exactly that. Strictly more
   cautious than the default path, never less.

Threaded through both wrappers: voice (`src/voice/index.ts dispatchProposal`)
and REST (`server.ts restDispatchProposal`); optional
`forceStage?: boolean` added to `DispatchProposalArgs` (src/actions/types.ts)
and `DispatchDeps` (paneWrite.ts).

## 5. Join semantics (tracker DONE; observe hook REMAINING)

`src/dispatch/joinTracker.ts` (pure bookkeeping, exported singleton
`dispatchJoinTracker`):

- member lifecycle: `staged` →(pane Running edge)→ `running` →(idle)→ `done`
  / (error|build-failed|exited)→ `error`; dispatch-time refusals settle as
  `blocked`/`error`. `prompt` is not a settle edge.
- a group **completes** when no member is `staged`/`running`;
  `noteTransition()` returns groups *newly* completed so the caller announces
  exactly once.

**Remaining (work item A):** `src/observe/index.ts` must feed the tracker:
- `onRunning` → `dispatchJoinTracker.noteRunning(terminalId)`;
- `detectAndTriggerTransitions` (after the watch-rules/plans triggers) and the
  genuine `onIdle` edge → `noteTransition(terminalId, transition)`; for each
  newly-completed group: push an attention item (type `"idle"`-style info,
  message `Dispatch '<name>' complete: <done>/<n> done[, <e> failed]`),
  `pruneAttention()`, `broadcast attention_updated` + `dispatch_updated`, and
  `announcementBus.enqueue({ kind: "completion", terminalId, summary: … })` —
  reusing the existing sinks only, no new I/O. NOTE: `onIdle` fires the
  genuine Running→Idle completion edge but `detectAndTriggerTransitions` also
  classifies `idle` — call the tracker from ONE place per edge kind
  (transition handler for idle/error/build-failed/exited; `onRunning` for the
  running edge) to avoid double-settling.

## 6. UI slice (REMAINING — work item C)

`src/orbital/views/Pass.tsx` (+ wiring through `OrbitalApp.tsx` /
`useOrbitalData.ts` if props are needed): a **"Templates"** section beside the
existing jots/plans —
- list templates (GET /api/templates) with name, description, slot chips;
- create/edit inline (name, description, body textarea) → POST/PUT;
- delete → DELETE;
- **Apply**: pick a station (the active one pre-selected), fill slot values in
  a small form (slots from the template's `slots` field), POST
  `/api/templates/:id/apply` with `pane_id` + `values` → the instantiated text
  lands in that pane's existing draft surface for review/send;
- a **"Layouts"** card: list (GET /api/layouts) with pane chips,
  "Save current project as layout" (POST /api/layouts), Apply
  (POST /api/layouts/:id/apply — note 202/blocked handling mirrors recipes),
  Delete. Repaint off `templates_updated` / `layouts_updated` frames or
  refetch-on-action, matching how the Pass handles notes/plans today.
- Follow the Pass's existing visual/idiom patterns exactly; "if you can click
  it, you can say it" labels where the pattern exists.

## 7. Tests (REMAINING — work item B; unit lane, `tsx --test`)

- `tests/test_prompt_templates.ts`: engine (extractSlots order/dedup,
  instantiate fill/missing/unfilled-verbatim, valuesArrayToRecord later-wins);
  def handlers via stub ctx (create→list roundtrip on a fake ledger object,
  apply→setDraft called with instantiated text, missing-slots → clarify,
  unknown id → ok narration, gate Off → blocked, gate Ask → pending);
  REST toHttp raw-array projection.
- `tests/test_layouts.ts`: save snapshots only the target project's live
  terminals; apply skips existing ids, blocks on Off, defers on Ask, spawns on
  Auto with stored command/cwd (stub manager.addTerminal probe).
- `tests/test_dispatch_join.ts`: tracker lifecycle (staged→running→done,
  error settle, prompt ignored, completion fires once, settledAtDispatch,
  MAX ring); dispatch_to_panes handler with a stub dispatchProposal asserting
  `forceStage:true` and per-pane pendingIds; template path clarifies on
  missing slots; forceStage engine behavior (auto_execute downgraded,
  off-focus allowed under forceStage, guard still clarifies when
  forceStage=false) via applyDispatchDecision with stub deps/conn — follow the
  existing paneWrite/approvals test fixtures.
- Existing-suite invariants that must stay green: capability no-orphans /
  defaultGate goldens (§8.1b) — the new defs reuse existing capabilities, so
  no table change is expected; coverage/catalog tests pick up the new defs.

## 8. Validation + docs (REMAINING — work item D, sequential after A–C)

- `npm run catalog` (regenerates docs/CAPABILITIES.md — the drift guard
  otherwise fails CI), `npm run typecheck`, `npm test`.
- Revise `docs/roadmap/2026-06-10-journey-expansion.md`: replace J1-E2/E3 +
  J7-E2 with the template-centric model (templates first-class, layouts split
  from recipes, dispatch+join kernel; plans demoted to visibility-only), and
  re-rank the shortlist.
- Live smoke (no Gemini key needed — REST only): boot `npm run dev`-equivalent
  server, create a template, apply to a live Custom pane's draft, save+apply a
  layout, POST /api/dispatch to two panes, approve via
  POST /api/commands/approve, watch /api/dispatch settle.

## 9. Explicitly out of scope

Durable dispatch groups, watch-rules firing templated handoffs, template
versioning, per-slot descriptions/types, plan-builder UI, and anything on the
RECONCILIATION §6 rejected list.
