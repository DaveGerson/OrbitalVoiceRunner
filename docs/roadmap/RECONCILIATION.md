# Roadmap ↔ Capability-Gate Vision — Reconciliation

> **BLUF.** The velocity roadmap (`NEXT-LEVEL-ROADMAP.md`) "removed" the governance control-plane as
> out-of-scope. Since then the **capability-gate matrix** (`docs/design/janus-capability-gate-handoffs.md`,
> v1 built) became the central product thesis — and it *is* the tiered-approval layer the roadmap cut.
> The matrix is not a resurrected backlog item; it's now the **safety substrate the whole velocity
> roadmap sits on**, and building it already delivered partial/complete credit on roadmap items 5, 7, and 9.
> This doc re-integrates the two. It does **not** rewrite the roadmap's priority order — that's the
> director's call (§6 lists the decisions).

Anchored to the trunk as of the matrix v1 build on `claude/prompt-composer-refactor`. The roadmap's own
line anchors (`main @16c62da`) predate this and are stale — see §5.

---

## 1. What changed: the matrix is the spine, not a line item

The roadmap framed governance and velocity as a trade-off and chose velocity. The capability-gate model
dissolves that trade-off: **"Janus can do everything; safety is a per-capability `Auto | Ask | Off` matrix
(global default + per-pane override), most-restrictive-wins."** That single dial is the policy plane,
the tiered-approval engine, and the audit source — all at once — and every velocity feature that mutates
a pane now routes through it via the `effectiveModeFor → dispatchProposal → decideProposal` choke-point.

So the roadmap shouldn't carry "governance" as a deferred *section*. Governance is now **horizontal**:
each velocity capability declares a gate and inherits the matrix's safety for free.

## 2. Re-scoring the "Removed" governance items against the built matrix

| Removed item (Devon ref) | Status now that the matrix exists | Recommendation |
|---|---|---|
| **Policy rule engine**, per-cmd/path allow/ask/deny (A1) | **Superseded for v1.** The matrix (per-capability, global + per-pane) *is* the policy plane. Per-*path* granularity still deferred. | Keep deferred — matrix covers the 80%. |
| **Command risk-classification + tiered approval + risk badge** (A2/B1) | **Reframed & BUILT.** Tiering is now per-**capability**, not per-command-risk. The matrix is the tiered-approval engine. | Close as built (different axis). Per-command risk badge → optional polish only. |
| **Append-only signed audit log + replay** (A3/B3) | **Partially BUILT.** Atomic audit events exist (`events.handoff_id`, one `recordActivity` txn per state-flip; live row + audit spine can't diverge). Signing + replay still absent. | **Re-elevate** "signed + replay" as a scoped follow-up — the spine is already there. |
| **Global kill-switch + blast-radius indicator** (A4/B4) | **Now cheap.** Global gate → `Off` is already a soft kill-all; a single "stop-all" affordance + blast-radius count is a thin UI layer over the matrix. | **Re-elevate** as a small item — the matrix made it a UI add, not a control plane. |
| **Multi-operator RBAC + secrets brokering** (A5/A6) | **RBAC out of scope** by thesis (single *director*). **Secrets:** redaction already built (source context redacted; `composed_prompt` not FTS-indexed); full brokering deferred. | RBAC stays out. Note redaction covers the secret-surface for v1. |
| **Rate-limit/anomaly, diff-preview, per-pane policy chips** (A7/B2/B5) | **Per-pane gate chip now trivial** (matrix already carries per-pane overrides — just surface them). Rate-limit/anomaly/diff-preview still deferred. | **Re-elevate** the per-pane gate chip as small UI; defer the rest. |

**Net:** of 6 cut groups, 1 is built (tiered approval), 2 are partially built (audit, secrets-via-redaction),
2 became cheap and worth re-elevating (kill-switch, per-pane chip), and 2 stay correctly deferred (per-path
policy engine, RBAC/rate-limit/diff-preview).

## 3. The velocity items now ride the matrix (and some are already partly built)

| Roadmap item | Capability gate it rides | Status change from the matrix build |
|---|---|---|
| 1 Push observation | reads (ungated; redaction is the control) | **Unchanged** — still the data plane to build first. |
| 2 Attention queue + digest | `dismiss_attention` | Unchanged feature; gate already defined. |
| 3 Multi-pane tiles | — (read-only UI) | Unchanged. |
| 4 Watch rules + plans | `add_watch_rule`, `execute_plan` | Gates defined; rule/DAG engine still net-new. |
| 5 Voice create / control | `create_pane`, `set_pane_permissions`, `set_global_permissions` | **Partially BUILT.** The gated handlers exist (enforce `Off`-veto + audit; `Ask` proceeds-and-audits pending WS-F deferred-execution staging). Remaining: the voice *tools* + full Ask staging. |
| 6 Cross-project fleet view | — (read-only UI) | Unchanged. |
| 7 Recipes / templates / **handoff** | `apply_recipe`, **`deliver_handoff`** | **Handoff DONE (v1):** first-class SQLite artifact + state machine + redaction, far past the roadmap's `handoff()` sketch. Templates/recipes remain (`apply_recipe` gate defined). |
| 8 Voice ergonomics | — | Unchanged. |
| 9 Hands-free confirmation | **the `Ask` tier itself** | **Reframed.** The mechanism *is* the matrix's `Ask` gate; item 9 collapses to the **voice read-back + distinct-confirm-phrase UX** layered on Ask-tier resolutions. No separate confirmation machinery needed. |
| 10 Velocity polish | various | Unchanged. |

## 4. Proposed re-integrated priority stack (recommendation — director confirms in §6)

- **Layer 0 — DONE:** capability-gate matrix + first-class handoffs (v1, backend-verified). Pending: live voice/UI test; WS-F (deferred-execution staging + full `PendingApproval` persistence).
- **P0 — velocity spine (unchanged core):** **(1) push observation** → **(2) attention queue / (3) tiles** → **(4) watch rules**. Item 1 is still the keystone everything else stands on.
- **P0.5 — NEW, matrix-enabled & cheap (closes the "safety dial" story the vision leads with):**
  - **Surface the matrix in the UI** — per-pane gate chips + a global-gate control (was Devon B5; trivial now).
  - **Global stop-all / kill-switch** affordance over `set_global_permissions → Off` (was Devon A4; thin UI).
  - **Signed audit + replay** on the existing audit spine (was Devon A3; spine already built).
- **P1 — hands-free & multi-project:** **(5)** finish voice tools on the already-gated handlers · **(6)** cross-project fleet view · **(7)** templates/recipes (handoff already done) · **(8)** voice ergonomics.
- **P2 — polish:** **(9)** hands-free confirm *as the Ask-tier voice UX* · **(10)** velocity polish.
- **Deferred (correctly out of scope):** per-path policy rule engine, multi-operator RBAC, secrets brokering beyond redaction, rate-limit/anomaly flags, diff/impact preview, per-command risk badges.

The one substantive change vs. the original ordering: a small **P0.5** band that surfaces and rounds out
the matrix (chips, stop-all, signed audit). It's cheap *because* the matrix exists, and it's what makes the
"settings-controlled safety dial" thesis legible to the director — so it earns its place ahead of P1.

## 5. Re-anchoring debt

The roadmap's evidence anchors reference `main @16c62da` (2026-05-28). The trunk has since absorbed the
terminal-fidelity coalesce, the e2e harness module, and the capability-gate + handoff build. Before acting
on any single item, re-anchor its `server.ts` / `App.tsx` / `terminal.ts` line refs against the current
trunk, and re-check each "❌ open / ⚠️ partial" status — several (5, 7, 9) moved toward done via the matrix.

## 6. Decisions for the director

1. **Tiered approval = matrix?** Confirm the per-capability matrix *closes* "command risk-classification /
   tiered approval" (different axis: per-capability, not per-command-risk). Or do you still want per-command
   risk badges as polish?
2. **Adopt the P0.5 band?** Re-elevate the three now-cheap governance items (per-pane gate chips, global
   stop-all, signed-audit + replay) ahead of P1 — they complete the safety-dial story the product leads with.
3. **RBAC stays out?** Confirm multi-operator RBAC remains out of scope under the single-director thesis
   (redaction already covers the v1 secret-surface).
4. **Keystone unchanged?** Confirm **item 1 (push observation)** is still the first build — nothing in the
   matrix work displaced it.
