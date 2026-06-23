# Attention ⇄ Approval routing — design (e7h / 8xn)

**Status:** design approved in brainstorm 2026-06-23 (operator). Implementation gated on PR #89 merge
(the `e7h` frontend contract it builds on lands in #89).
**Beads:** `wsm-e2e-pinned-e7h` (frontend contract, in #89) · `wsm-e2e-pinned-8xn` (this design).

## Problem

A gated action needs operator approval. Today the **only** surface is the blocking **ApprovalDialog
modal** — great when you're looking at that station, useless when you've stepped to another view or
you're hands-free. The attention inbox ("what needs me") shows softer suggestions you can Open/Dismiss
but cannot *approve*. The `e7h` frontend already wired real in-inbox Approve/Deny gated on a
`messageId`, but nothing routes a held approval there, so it's inert.

## Decisions (locked)

1. **Conditional routing**, not double-surfacing. A held approval lives on **exactly one** surface at a
   time, chosen by context.
2. **Focus is the router.** Voice is NOT a router — it's a cross-cutting *input* that resolves the
   approval on whichever surface holds it.
3. **Promote on return + persistent badge.** An inbox-routed approval waits quietly with a visible
   count; the moment you focus its station it promotes to the modal. No timers. The badge is the
   safeguard against a silently-blocked pane.

## The routing rule

On an `approval_pending` frame (carries `messageId` + `terminalId`):

```
isHere = (frame.terminalId === activeStationId) AND document.visibilityState === "visible"
isHere ? -> pendingCommands (MODAL, existing path)
        : -> attentionQueue as an approval item stamped with messageId (INBOX, e7h path)
```

- **Promotion:** when `activeStationId` changes to a pane that has an inbox-pending approval (or the tab
  regains focus on it), move that item out of `attentionQueue` into `pendingCommands` (it pops the
  modal). One-directional: modal→inbox does not happen on blur (avoid yanking a dialog you're mid-read
  on); only inbox→modal on focus.
- **Badge:** the attention surface shows a count of pending approval items (distinct styling from
  triage items). This is the always-on "something needs you" signal that makes the no-timer model safe.

## Resolution parity (the load-bearing invariant)

A held approval is a single `PendingApproval` (keyed by `messageId`). Modal and inbox are **views** of
it. Resolving via `approveCommand(messageId)` / `rejectCommand(messageId)` removes the underlying
`PendingApproval`; the server broadcast then clears it from **both** queues. So "resolve anywhere clears
everywhere" falls out for free — no extra dedup logic, as long as both surfaces resolve by `messageId`.

**Voice parity is the one real gap.** `src/voiceApprovalRouting.ts` resolves *staged actions*
(`pendingActions` / action-dialog) by voice — approve/reject/defer + multi-item disambiguation — but
**not** held pane-write commands (`pendingCommands` / approval-dialog). For "voice clears the modal AND
the inbox" to hold for held approvals, the voice resolver must also target held pane-write commands by
`messageId`, reusing the same approve/reject/defer + disambiguation logic. This is the primary
**server-side** piece of `8xn`.

## Scope of `8xn`

| Layer | Change |
|---|---|
| **Client (primary)** | Route `approval_pending` to modal vs inbox by focus; promote-on-return; approval-count badge on the attention surface. Reuses `e7h`'s `messageId` plumbing + `approveCommand`/`rejectCommand`. |
| **Server (parity)** | Extend the voice approval resolver to also resolve held pane-write commands by `messageId` (mirror `resolvePendingActionByVoice`), so voice works on the routed approval wherever it sits. |
| **Server (none/minimal)** | The existing `approval_pending` frame already carries `messageId` + `terminalId`; verify, no new producer needed. |

## Edge cases / safety

- **Never silently fake-approve:** the inbox item only shows Approve/Deny when it carries a real
  `messageId` (already the `e7h` id-gate). No messageId → triage-only Open/Dismiss.
- **Concurrent resolution:** modal/inbox/voice/REST can race; the `confirm()/cancel()` "lost_race"
  path already no-ops the loser. Keep that — do not add optimistic state that can resurrect a resolved
  approval.
- **Focus ambiguity / no active station:** default to **inbox** (the safe, non-interrupting side) +
  badge. The modal only ever appears when we're certain you're at that station.
- **Tab fully backgrounded:** always inbox (visibilityState !== "visible").

## Testing

- Unit: the routing predicate (`isHere`), promotion transition, badge count derivation.
- Unit/server: voice resolver resolves a held pane-write command by `messageId` (+ disambiguation when
  multiple held).
- e2e (mock): approval for the active station → modal; approval for a background station → inbox row
  with working Approve; navigate to that station → promotes to modal; resolve in inbox → clears; badge
  reflects count. (Build on `orbital_attention.spec.ts` + `orbital_approvals.spec.ts`.)
- Reuse the `20n` render-await fixture so the new stacked-routing assertions aren't flaky.

## Out of scope (future)

- Time-based escalation / spoken digest of waiting approvals (deliberately rejected for the no-timer
  model; revisit only if silent-block proves a real problem).
- Per-capability routing overrides (e.g. "high-risk always modal") — possible later via the gate matrix.
