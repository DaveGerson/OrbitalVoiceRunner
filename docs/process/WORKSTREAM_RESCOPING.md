# Active Workstream Re-Scoping — a single-dev ritual

> **BLUF.** Janus is a single-director cockpit, not an enterprise platform. The old WS-A..WS-M
> burndown (`docs/review/IMPLEMENTATION_PLAN.md`) is a *static* M0-M3 plan that predates this pivot
> and drifts the moment the UI moves. This is the lightweight, manual ritual that keeps the live plan
> (beads) and the locked priority stack (`RECONCILIATION.md`) honest against what actually shipped.
> It is a 15-minute conversation between you and the agent — **not** automation, **not** process overhead.

## Sources of truth (don't blur them)

| Doc | Role | Mutability |
|---|---|---|
| `docs/roadmap/RECONCILIATION.md` §4 | **Priority + scope authority.** The locked P0a→P0b→P1→P2 stack and the OUT list. | Locked (2026-06-01). Changing a priority *tier* or the OUT list is a deliberate, dated edit here — not a beads tweak. |
| **beads** (`bd`, Dolt-backed) | **Live task tracker.** Every open unit of work, tagged to a §4 tier. | Churns freely — this ritual prunes/merges/splits it. |
| `docs/NEXT_STEPS.md` | **Live next-session + bug/risk list.** The human-readable "you are here." | Updated each session; re-anchored to a commit. |
| `docs/review/IMPLEMENTATION_PLAN.md` | **Historical / archival.** The enterprise WS-A..WS-M burndown. Read for *root-cause detail*, never as the live plan. | Frozen. Don't resurrect items verbatim — re-derive against today's UI. |

## WHEN to re-scope (manual + active, never calendar-bound)

Run the ritual when reality moves out from under the plan — triggered by *events*, not a clock:

1. **A UI/feature ships** — a pane, chip, settings surface, or voice tool lands in the actual app.
2. **A keystone lands** — e.g. push-observation (P0b ①) or the matrix surface (P0b ②) completes.
3. **Scope shifts** — a locked decision changes, an OUT item gets reconsidered, or a workstream
   turns out bigger/smaller/irrelevant once you saw it in the product.

If none of these fired, **don't run it.** No standing meetings, no weekly cadence.

## The STEPS (~15 min, you + the agent)

1. **See what actually shipped.** Walk the *current UI/product*, not the doc. What can the director
   now see and do? (e.g. "the per-pane gate chip is live; the global stop-all isn't yet.")
2. **Re-frame each open workstream against today's product.** For every open WS / bead bucket, pick one:
   - **Narrow** — keep, but cut it to what the single-dev UI needs (drop the enterprise tail).
   - **Re-frame** — same intent, new shape against the matrix/UI reality (most §3 velocity items).
   - **Retire** — it's done, subsumed by the matrix, or now OUT. → write a **tombstone** (below).
   - **Keep** — still correct as-is.
3. **Reconcile beads against the §4 stack.** Every open bead must map to exactly one live tier
   (P0a/P0b/P1/P2). Anything that maps to the **OUT** list gets a tombstone and is closed —
   not left open "just in case."
4. **Prune / merge / split.** Collapse duplicate or stale beads; merge fragments of one real unit;
   split anything too big to land in a sitting. Keep the open set small enough to hold in your head.
5. **Tombstone retirements (never delete history).** Close the bead as `wontfix`/`done` with a one-line
   reason + the trigger that retired it (e.g. *"subsumed by matrix surface; per-command risk badge is
   OUT per RECONCILIATION §6.5"*). The closed bead **is** the tombstone — searchable, not deleted.
6. **Re-anchor the human docs.** Update `NEXT_STEPS.md` (next-session + last-anchored commit) and, only
   if a *tier or OUT decision* changed, make a dated edit to `RECONCILIATION.md`.

## How it stays single-dev-friendly (anti-bureaucracy guardrails)

- **One operator, one agent, one conversation.** No RBAC, no approvals-of-approvals, no sign-off
   chain. You decide; the agent drafts the bead edits and tombstones; you confirm.
- **The product is the spec, not the doc.** When the UI and a plan disagree, the UI wins — re-scope
   the plan, don't re-litigate the code.
- **Subtractive by default.** The ritual's main job is *cutting* scope (narrow/retire), keeping the
   open set honest. Adding work is the exception, not the reflex.
- **No new ceremony.** It rides existing tools (`bd`, two markdown docs). If it ever feels like
   process for its own sake, you're doing too much of it — wait for a real trigger.
- **History is cheap; ambiguity is expensive.** Always tombstone, never delete — a closed bead with a
   reason costs nothing and saves you re-deciding the same OUT call next quarter.

## Done means

Every open bead maps to a live §4 tier, nothing open maps to OUT, retirements are tombstoned with a
reason, and `NEXT_STEPS.md` reflects the current UI. The plan and the product agree again.
