# Core-Journey Expansion Opportunities — 2026-06-10

> **Revision 2026-06-11 — orchestration reframed (maintainer decision).** The
> recipe/plan-authoring items below (J1-E2, J1-E3, J7-E2) are superseded by the
> **template-centric model**: the agents in the panes do the orchestration
> work; the orchestrator briefs (prompt templates), connects (multi-pane
> dispatch with per-write gating + a single join announcement), and watches.
> Layouts are split out of "recipes" as pure pane furniture. Plans stay as-is
> for the deterministic-sequence niche but get no further UI investment.
> Spec + implementation: `docs/design/templates-layouts-dispatch.md`
> (shipped on this branch: `create/list/update/delete/apply_prompt_template`,
> `save_project_layout` / `list_layouts` / `apply_layout` / `delete_layout`,
> `dispatch_to_panes` + `get_dispatch_status` with the forceStage staging
> invariant, plus the Pass UI for templates/layouts). The shortlist in §3 is
> re-ranked accordingly.

**Scope.** A journey-by-journey survey of how the eight core journeys
(`JOURNEYS_DESIGN.md`, `docs/journeys/*`) can be *expanded or better supported*
— in the UI, the voice surface, or the server — now that the Phase 0–4
stability stack has merged. This doc deliberately excludes testing and general
stability (tracked elsewhere) and stays inside the locked scope:

- **Honors the priority stack** (`RECONCILIATION.md §4`): nothing here jumps
  the P0b keystones; items are tagged with the tier they belong to.
- **Honors the rejected list** (`RECONCILIATION.md §6`): no per-path policy
  engine, RBAC, risk badges, rate-limiting, diff preview, signed audit, or
  secrets brokering beyond redaction is proposed.
- **No duplication** of already-planned work: where an opportunity is an
  existing workstream (WS-I/J/K) or Wave-5 item, it is endorsed and refined,
  not re-invented.

**Method.** Re-derived the current capability surface from the action registry
(`src/actions/defs/*`), gating core (`src/gating/`), store (`src/store/`),
voice path (`src/voice/`), and both UIs (`src/App.tsx`,
`src/orbital/*`), then diffed it against the per-journey gap registers
(2026-05-29) and the 2026-06-10 UX gap audit to isolate what is *still* open
and what new expansion surface the Phase 0–4 substrate makes cheap.

---

## 1. The headline pattern: the server outgrew the UI

Phases 0–4 left the backend with several **first-class, durable capabilities
that have no (or only vestigial) operator surface**:

| Backend capability (exists today) | Operator surface today | Gap class |
|---|---|---|
| Handoff state machine — compose/revise/stage/deliver/reject, `revision_count`, expiry (`src/actions/defs/handoff.ts`, `handoffs` table) | None. `Pass.tsx:19` merely styles a note of type `"handoff"` as a log entry | Whole journey leg invisible |
| Defer verb — TTL re-arm, `MAX_DEFERRALS=3` (`src/gating/index.ts:121`, `src/approvalIntent.ts`) | Voice only. `ApprovalDialog.tsx` has Approve/Reject; no "Later" | Modality parity |
| Approval TTL + last-call grace (`pending_approvals.expires_at`) | Not rendered anywhere — no countdown, no last-call state | Eyes-on operator flies blind on a deadline the server enforces |
| Attention queue + dismiss + digest (`/api/attention`, `get_attention_digest`) | Classic: earcon + toast. Kitchen: a bare "needs you" counter; zero attention surface in `src/orbital/` | Inbox missing |
| Plans — durable, step state machine, timeline (`kv["plans"]`, `orchestration.ts`) | `Pass.tsx` lists plans with execute/delete only; no create, no edit, no live step progress | Authoring + observability missing |
| Recipes (`list_orchestration_recipes`, `apply_orchestration_recipe`) | Hardcoded templates; no authoring path by voice or UI | Authoring missing |
| Typed notes — `type`, `author`, timestamps, FTS (`notes` table, `search_notes`) | Jots render text only; no filter by type/author/date; no export | Retrieval UX missing |
| Action log with `interaction_id` threading (`action_log`, `get_action_log`) | Service log shows entries; no turn-threaded view, no gate-provenance answers | Observability depth |

Most of the highest-leverage journey expansion is therefore **surfacing work,
not new machinery** — exactly the "matrix surface / velocity" direction the
roadmap already points at. The sections below go journey by journey.

---

## 2. Journey-by-journey opportunities

Tags: **[UI]** kitchen/classic frontend · **[Voice]** tool or verb ·
**[Server]** registry/store/gating. Effort: S (&lt;1 day) / M (1–3 days) /
L (&gt; 3 days). Tier: where it slots in the locked stack.

### J1 — Fan-out / delegate in parallel

*Stands today:* real concurrent PTYs, plans/recipes/watch-rules durable and
gated, handoffs exist server-side. But plan execution is strictly sequential,
and everything orchestration-shaped is voice-create-only.

| # | Opportunity | Tags | Effort | Tier |
|---|---|---|---|---|
| J1-E1 | ~~Parallel step groups in plans (WS-K)~~ **Superseded → SHIPPED as `dispatch_to_panes` + join** (rev. 2026-06-11): one (templated) instruction to N panes, every write staged for approval, one spoken/attention announcement when the group settles. The plan-DAG variant is dropped — agents sequence their own work. | [Server][Voice] | — | Done |
| J1-E2 | ~~Plan builder + live progress UI~~ **Demoted** (rev. 2026-06-11): plans keep execute/delete only; group visibility comes from `get_dispatch_status` + the `dispatch_updated` frame instead. | [UI] | — | Dropped |
| J1-E3 | ~~"Snapshot this project as a recipe"~~ **Superseded → SHIPPED as layouts** (rev. 2026-06-11): `save_project_layout` captures the live formation (command/cwd/preset/mode per pane); `apply_layout` re-materializes it under the same gates as a recipe apply. | [Server][Voice][UI] | — | Done |
| J1-E4 | **Duplicate station / pane templates.** A clone button on station cards (re-create with same preset/cwd/command/mode) and per-pane config save-as-template in `CreateTerminalDialog`. Cheap because `create_pane` already accepts the full config. | [UI] | S | P1 |
| J1-E5 | **Multi-target propose:** "tell every idle pane in this project to run the linter." A fan-out wrapper over `propose_command` that resolves a pane *set* (by status/project/preset), with each write still individually gated — N approvals stage if the gate says Ask. Pairs naturally with J2-E4 batch resolution. | [Voice][Server] | M | P1 |

### J2 — Supervisor / air-traffic control

*Stands today:* the approval loop is genuinely solid post-WS-E (two-phase
proposal, targeting, negation-aware parser, TTL sweep, durable queue). The
remaining expansion is almost entirely *operator-side visibility and
ergonomics*.

| # | Opportunity | Tags | Effort | Tier |
|---|---|---|---|---|
| J2-E1 | **Approvals + attention inbox.** One non-modal surface (Kitchen: a "Tickets" rail; Classic: panel) listing pending approvals, staged actions, and attention items with age, source pane, and TTL remaining. Today the Kitchen literally cannot show *what* needs you, only *how many*. Modal stacking stays for foreground decisions; the inbox is the ambient queue. | [UI] | M | P0b-adjacent (matrix surface) |
| J2-E2 | **Defer parity in the dialogs.** Add a "Later" button to `ApprovalDialog`/`ActionConfirmDialog` wired to the existing TTL re-arm (`applyDeferral`); show remaining deferrals (server caps at 3). Voice already has the verb; the mouse doesn't. | [UI] | S | Wave-5-adjacent |
| J2-E3 | **Render the deadline.** TTL countdown ring + a visible "last call" state on each pending card/dialog (`expires_at` is already in the payload). The server auto-rejects on expiry; the eyes-on operator should see that coming. | [UI] | S | Wave-5-adjacent |
| J2-E4 | **Batch resolution.** "Approve all", "reject everything for pane X" voice verbs + inbox multi-select. Server loops the existing claim/dispatch path per entry; one spoken confirmation summarising the set ("Approving 3 commands on two panes"). The negation-aware parser already exists to keep this safe. | [Voice][Server][UI] | M | P1 |
| J2-E5 | **Speakable hints on approval surfaces.** Extend the Kitchen's "if you can click it, you can say it" contract into the approval flow: each pending card shows its disambiguation phrase ("say: *approve the npm one*"), generated from the same fragment logic `selectApprovalTarget` matches on. Teaches the voice grammar exactly where it's needed. | [UI] | S | P1 (voice ergonomics, J8/WS-E synergy) |

### J3 — Review & approve across panes

*Stands today:* targeting, ordinals, and clarification are in. The open seam
is the **voice↔UI modality mismatch** when several approvals are pending.

| # | Opportunity | Tags | Effort | Tier |
|---|---|---|---|---|
| J3-E1 | **Highlight the voice target.** When &gt;1 approval is pending, visually mark which entry a bare "approve" will resolve (the same selection `selectApprovalTarget` would make). Eliminates the historical "voice resolves A, visible modal is B" trap at the UI layer. | [UI] | S | Wave-5-adjacent |
| J3-E2 | **Queue walking verbs.** "Next approval" / "skip this one" to step through the pending queue audibly, reusing defer for skip semantics. Completes the eyes-off review loop for multi-pane sessions. | [Voice] | S–M | P1 |
| J3-E3 | **Decision context in the dialog.** Show what the pane printed *since the proposal was staged* (one `get_pane_delta` call keyed to the proposal timestamp) under the rationale snapshot. Reviewers approve against current reality, not a stale snapshot. | [UI][Server] | M | P1 |

### J4 — Knowledge capture & continuity

*Stands today:* the data model quietly got good — typed notes with author +
timestamps + FTS, amend/delete by voice, durable drafts, away-digest on
reconnect, handoffs as first-class artifacts. Almost none of it is visible.

| # | Opportunity | Tags | Effort | Tier |
|---|---|---|---|---|
| J4-E1 | **Handoff surface.** A Pass tab (or Line drawer) listing handoffs by state (composing/staged/delivered) with the composed prompt, source/target panes, revision count; actions: view, edit (→`revise_handoff`), deliver, reject. The full lifecycle exists server-side with zero UI. This is the single largest "built but invisible" feature in the product. | [UI] | M | P1 (handoff v1 follow-through) |
| J4-E2 | **Typed-note UX.** Filter chips on jots (decision / TODO / handoff / context; janus vs. operator; date), powered by columns that already exist. Voice: map "what did we decide?" to `search_notes` with `type=decision`. | [UI][Voice] | S–M | M2 (WS-I surface) |
| J4-E3 | **Transcript → note.** "Save that as a note" voice verb (capture the last Janus/user turn) + a per-turn save icon in the transcript panel. The cheapest possible knowledge capture — the words already exist in state. | [Voice][UI] | S | P1 |
| J4-E4 | **Project export.** `GET /api/projects/:id/export` returning Markdown (summary, typed notes, pane inventory, recent history, plans) + a voice "export my notes" and a download button. Closes the capture→reuse loop outside the tool. | [Server][UI][Voice] | M | M2 |
| J4-E5 | **Cross-pane timeline in the briefing.** Fold a merged recent-commands timeline (the events/action-log spine already has it) into the `switch_context` briefing so "brief me" includes *what ran*, not just notes and pane states. | [Server] | S–M | M2 (WS-I/J seam) |

### J5 — Adjust autonomy mid-session

*Stands today:* WS-G landed the truth fixes (override caveat, `restart_pane`,
persisted modes); the matrix + chips + BoH editor exist. Expansion is about
making the *posture* legible and time-bounded.

| # | Opportunity | Tags | Effort | Tier |
|---|---|---|---|---|
| J5-E1 | **Gate provenance.** In the GateChip popover, annotate each effective gate with *which layer decided* (pane override / spotlight / global mode / default). The resolver already walks these layers; exposing the winning layer turns "why is this Ask?" from a support question into a tooltip. | [UI][Server] | S–M | P0b (matrix surface) |
| J5-E2 | **Timed autonomy.** "Full auto on the build pane for 20 minutes": a gate change with an expiry that auto-reverts and speaks a warning before flipping back. Per-capability, single-operator — squarely inside the matrix model, explicitly not a policy engine. Server: expiry column on the override + sweep (the TTL sweep pattern already exists for approvals). | [Server][Voice][UI] | M | P1 |
| J5-E3 | **Posture profiles.** Named bundles of global mode + capability gates ("Heads-down", "Demo", "Locked") switchable in one tap in BoH or one phrase. Stored in settings; no new gating semantics. | [UI][Server][Voice] | M | P1 |
| J5-E4 | **Per-project default posture.** New panes inherit their project's default gates/mode instead of global defaults. One field on `projects`, read at `create_pane`. | [Server][UI] | S | P1 |

### J6 — On-demand status check

*Stands today:* busy/idle is finally trustworthy (WS-C), proactive audio
exists (WS-D), away-digest covers reconnect. The remaining gap is *synthesis*:
the operator still has to stitch tools together.

| # | Opportunity | Tags | Effort | Tier |
|---|---|---|---|---|
| J6-E1 | **`get_status_summary` — one spoken SITREP.** Merge `list_panes` (busy + elapsed), pending approvals/actions, unread attention, and executing-plan progress into one tool with explicit sections. Today "what needs me?" takes 3–4 tool calls and model improvisation. | [Voice][Server] | S–M | P0b-adjacent |
| J6-E2 | **On-demand catch-up window.** "What happened in the last hour?" — reuse the away-digest composer (`composeAwayDigest`) with an arbitrary `[since, now]` window over the events table, instead of only firing on reconnect. | [Voice][Server] | S | P1 |
| J6-E3 | **Cross-project fleet view** (= roadmap item 6, endorsed). One board flattening all projects' stations with filters (busy / needs-you / erroring), so multi-project supervision doesn't require context switching. | [UI] | M–L | P1 (planned) |
| J6-E4 | **Live output tiles on the Kitchen board.** Classic's videowall mode has no Kitchen equivalent; station cards could optionally show a 3–5 line live tail (the `stdout_chunk` stream already reaches the client). | [UI] | M | P1 (planned: multi-pane tiles) |

### J7 — Dictate a specification

*Stands today:* drafts are per-pane, durable, mirrored over `draft_updated`,
and sendable with gating. The buffer-volatility crisis is gone; what's left
is workflow closure.

| # | Opportunity | Tags | Effort | Tier |
|---|---|---|---|---|
| J7-E1 | **Draft → artifact promotion.** Verbs/buttons to promote a draft into (a) a typed project note, (b) handoff cargo (`propose_handoff` pre-filled), or (c) a file in the project directory (e.g. `SPEC.md`) via a gated write. Dictation currently dead-ends at "send to pane". | [Server][Voice][UI] | M | M2 |
| J7-E2 | ~~Spec templates as data~~ **Superseded → SHIPPED as prompt templates** (rev. 2026-06-11): first-class `PromptTemplate` artifacts with `{{slot}}` parameters; create/edit/apply by voice or on The Pass; `apply_prompt_template` instantiates into the pane's WIP draft for review-then-send. | [Server][Voice][UI] | — | Done |
| J7-E3 | **Draft history.** Keep the last N revisions per pane draft (drafts are overwritten in place today); "undo my last edit" by voice. | [Server][UI] | S–M | P2 |
| J7-E4 | **Focused-pane default for notes.** `add_pane_note`/`compose_draft` default `pane_id` to `coreState.activePaneId` so "note this here" needs no pane naming. | [Server] | S | P1 |

### J8 — Narrate a terminal walk-through

*Stands today:* redaction landed (WS-B), `get_pane_delta` gives "what's new".
The scrollback file (512 KB per pane) is still write-only, and narration has
no UI counterpart.

| # | Opportunity | Tags | Effort | Tier |
|---|---|---|---|---|
| J8-E1 | **Scrollback search + error extraction** (= WS-J, endorsed): `search_pane_output` (keyword/range over the scrollback file, redacted) and `get_pane_errors` (errors/warnings/exit-code extraction) so "did anything fail half an hour ago?" is answerable. | [Server][Voice] | M | M2 (planned) |
| J8-E2 | **Narration-synced UI.** While Janus narrates a pane, highlight the narrated line range in the burner and flag narration-active on the station card — the eyes-on companion to an eyes-off feature. | [UI] | M | P2 |
| J8-E3 | **Note-saved earcon.** Distinct chime when a dictated note persists (the `playEarcon` infra is idle here). | [UI] | S | Wave-5-adjacent |

---

## 3. Ranked shortlist (impact ÷ effort, scope-safe)

> Rev. 2026-06-11: prompt templates, layouts, and dispatch+join (formerly
> ranked 5–6 in plan-shaped form, plus J7-E2) **shipped on this branch** —
> see `docs/design/templates-layouts-dispatch.md`. The remaining ranking:

1. **J2-E1 Approvals + attention inbox** — the supervisor journey's missing
   ambient surface; everything it shows already exists server-side (now
   including `dispatch_updated` group state).
2. **J2-E2 + J2-E3 Defer button & TTL countdown** — two small PRs that give
   the mouse the same verbs the voice has and make the enforced deadline
   visible. Doubly valuable now that `dispatch_to_panes` stages N approvals
   at once.
3. **J4-E1 Handoff surface** — the largest fully-built, fully-invisible
   feature; pure UI.
4. **J6-E1 `get_status_summary`** — one tool that turns the most common
   question into one round-trip (should fold in dispatch-group progress).
5. **J2-E4 Batch approve/reject** — the natural companion to staged fan-out:
   "approve all" resolves a dispatch group in one breath.
6. **J5-E1 Gate provenance** — makes the matrix self-explaining right as it
   becomes the product's spine.
7. **J8-E1 Scrollback search + error extraction (WS-J)** — depth for both
   narration and status journeys.
8. **J5-E2 Timed autonomy** — the most-requested shape of trust ("just for
   this task") expressed inside the existing matrix.
9. **J4-E3 Transcript → note** — near-free knowledge capture.
10. **J1-E4 Duplicate station** — the small sibling of layouts.

Items 1–4 and 6 are surfacing work that could ride alongside the P0b matrix
surface; 5, 7–10 slot into the existing P1/M2 lanes.

---

## 4. Explicitly *not* proposed

Per `RECONCILIATION.md §6` (single-director thesis), this survey deliberately
contains no per-command risk classification, no diff/impact preview, no
per-path policy engine, no RBAC/multi-operator features, no rate-limiting or
anomaly detection, no signed audit trail, and no secrets handling beyond the
existing redaction layer. Testing and stability work is excluded by request
and tracked in the phase/test branches.
