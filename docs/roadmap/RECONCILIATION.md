# Roadmap ↔ Capability-Gate Vision — Reconciliation

> **BLUF.** The velocity roadmap (`NEXT-LEVEL-ROADMAP.md`) "removed" the governance control-plane as
> out-of-scope. Since then the **capability-gate matrix** (`docs/design/janus-capability-gate-handoffs.md`,
> v1 built) became the central product thesis — and it *is* the tiered-approval layer the roadmap cut.
> The matrix is not a resurrected backlog item; it's now the **safety substrate the whole velocity
> roadmap sits on**, and building it already delivered partial/complete credit on roadmap items 5, 7, and 9.
> **Director decisions are LOCKED (2026-06-01, §6); the priority stack in §4 is now authoritative.**

Anchored to the trunk as of the matrix v1 build on `claude/prompt-composer-refactor`. The roadmap's own
line anchors (`main @16c62da`, 2026-05-28) predate this and are stale — current main is **`7efcaee`
(2026-06-06)**; re-anchor before acting (see §5).

---

## 1. What changed: the matrix is the spine, not a line item

The roadmap framed governance and velocity as a trade-off and chose velocity. The capability-gate model
dissolves that trade-off: **"Janus can do everything; safety is a per-capability `Auto | Ask | Off` matrix
(global default + per-pane override), most-restrictive-wins."** That single dial is the policy plane,
the tiered-approval engine, and the audit source — all at once — and every velocity feature that mutates
a pane now routes through it via the `effectiveModeFor → dispatchProposal → decideProposal` choke-point.

So the roadmap shouldn't carry "governance" as a deferred *section*. Governance is now **horizontal**:
each velocity capability declares a gate and inherits the matrix's safety for free. Per the director
(§6.2), the matrix is a **mixed surface** — the human controls the gated (`Ask`/`Off`) capabilities
*directly* (visible controls), while `Auto` capabilities run *indirectly* in the background.

## 2. Re-scoring the "Removed" governance items against the built matrix

| Removed item (Devon ref) | Status now that the matrix exists | Disposition (locked) |
|---|---|---|
| **Policy rule engine**, per-cmd/path allow/ask/deny (A1) | **Superseded.** The matrix (per-capability, global + per-pane) *is* the policy plane. Per-*path* granularity unneeded for a single-director tool. | **OUT** |
| **Command risk-classification + tiered approval + risk badge** (A2/B1) | **Reframed & BUILT.** Tiering is now per-**capability**, not per-command-risk. The matrix is the tiered-approval engine. | **CLOSED as built** — per-capability is sufficient (§6.5); no risk badges. |
| **Append-only signed audit log + replay** (A3/B3) | Atomic *unsigned* audit events already exist (`events.handoff_id`, one `recordActivity` txn per state-flip; live row + audit spine can't diverge). | **OUT** — a personal tool needs no multi-party tamper-evidence; the built unsigned trail suffices (§6.1). |
| **Global kill-switch + blast-radius indicator** (A4/B4) | Global gate → `Off` is already a soft kill-all; a single "stop-all" affordance + blast-radius count is a thin UI layer over the matrix. | **IN — P0b** (part of the matrix surface; direct control). |
| **Multi-operator RBAC + secrets brokering** (A5/A6) | RBAC is meaningless for a single director. Secrets: redaction already built (source context redacted; `composed_prompt` not FTS-indexed). | **OUT** (§6.1); redaction covers the secret-surface. |
| **Rate-limit/anomaly, diff-preview, per-pane policy chips** (A7/B2/B5) | Per-pane gate **chip** is trivial (matrix already carries per-pane overrides — just surface them). Rate-limit/anomaly/diff-preview have no single-director rationale. | per-pane chip **IN — P0b**; rest **OUT**. |

**Net (locked):** of 6 cut groups — 1 closed-as-built (tiered approval), 2 surfaced into the **P0b matrix
surface** (kill-switch, per-pane chip), and 3 fully **out of scope** under the single-director thesis
(per-path policy engine, signed/replay audit, RBAC/rate-limit/diff-preview).

## 3. The velocity items now ride the matrix (and some are already partly built)

| Roadmap item | Capability gate it rides | Status change from the matrix build |
|---|---|---|
| 1 Push observation | reads (ungated; redaction is the control) | **Unchanged feature** — the data plane; a P0b keystone (§4). |
| 2 Attention queue + digest | `dismiss_attention` | Unchanged feature; gate already defined. |
| 3 Multi-pane tiles | — (read-only UI) | Unchanged. |
| 4 Watch rules + plans | `add_watch_rule`, `execute_plan` | Gates defined; rule/DAG engine still net-new. |
| 5 Voice create / control | `create_pane`, `set_pane_permissions`, `set_global_permissions` | **Partially BUILT.** The gated handlers exist (enforce `Off`-veto + audit; `Ask` proceeds-and-audits pending WS-F deferred-execution staging). Remaining: the voice *tools* + full Ask staging. |
| 6 Cross-project fleet view | — (read-only UI) | Unchanged. |
| 7 Recipes / templates / **handoff** | `apply_recipe`, **`deliver_handoff`** | **Handoff DONE (v1):** first-class SQLite artifact + state machine + redaction, far past the roadmap's `handoff()` sketch. Templates/recipes remain (`apply_recipe` gate defined). |
| 8 Voice ergonomics | — | Unchanged. |
| 9 Hands-free confirmation | **the `Ask` tier itself** | **Reframed.** The mechanism *is* the matrix's `Ask` gate; item 9 collapses to the **voice read-back + distinct-confirm-phrase UX** layered on Ask-tier resolutions. No separate confirmation machinery needed. |
| 10 Velocity polish | various | Unchanged. |

## 4. Re-integrated priority stack (LOCKED)

| Tier | What | Rationale (decision) |
|---|---|---|
| **L0 — DONE** | Capability-gate matrix + first-class handoffs (v1, backend-verified). | Already built. |
| **P0a — HARDEN (first)** | WS-F deferred-execution staging · full `PendingApproval` persistence · full `deliver_handoff → flipHandoffOnResolve` server path · smoke content-assertion (PONG, not just `bytesAfter>0`). | **§6.3** — pay down v1 debt before stacking, *for* velocity. |
| **P0b — Two keystones (both full)** | ① **Push-observation w/ deltas** (the data plane). ② **Matrix surface**: per-pane gate chips + capability-matrix settings UI + global stop-all + item-5 voice tools on the already-gated handlers. | **§6.2 + §6.4** — direct control of the gated capabilities; both are full must-builds. |
| **P1 — Velocity** | Attention queue (2) · multi-pane tiles (3) · watch rules (4) · cross-project fleet view (6) · templates/recipes (7; handoff done) · voice ergonomics (8). | Ride the hardened, surfaced matrix. |
| **P2 — Polish** | Hands-free confirm as Ask-tier voice UX (9) · velocity polish (10). | — |
| **OUT (not deferred — out)** | Per-path policy engine · multi-operator RBAC · secrets brokering beyond redaction · signed/replay audit · per-command risk badges · rate-limit/anomaly · diff/impact preview. | **§6.1 + §6.5** — single-director tool needs none. |

**Sequencing:** `P0a → P0b → P1 → P2`. P0a (hardening) gates the rest. Within P0b the two keystones run in
parallel; push-observation and the WS-F hardening are largely code-disjoint, so push-observation may begin
alongside P0a if there's capacity — but the matrix surface waits on hardened gates.

## 5. Re-anchoring debt

The roadmap's evidence anchors reference `main @16c62da` (2026-05-28). The trunk has since absorbed the
terminal-fidelity coalesce, the e2e harness module, the capability-gate + handoff build, the SQLite
ledger cutover (WS-M), and the round-3/4 voice-UX work — current main is **`7efcaee` (2026-06-06)**.
Before acting on any single item, re-anchor its `server.ts` / `App.tsx` / `terminal.ts` line refs
against current main (server.ts is now ~3,200 lines and App.tsx has grown substantially since the
`16c62da` baseline, so EVERY per-line citation below still needs individual re-verification — the
SHA/date headers are refreshed, the inline `server.ts:NNN` / `App.tsx:NNN` anchors are NOT), and
re-check each "❌ open / ⚠️ partial" status — several (5, 7, 9) moved toward done via the matrix.

## 6. Decisions (LOCKED — 2026-06-01)

1. **Horizon & audience → personal, single-director tool (permanent).** Therefore RBAC, signed/replay
   audit, per-path policy engine, secrets brokering, rate-limit/anomaly, and diff-preview are **out of
   scope** — not deferred.
2. **Safety dial → mixed surface.** The director controls the gated (`Ask`/`Off`) capabilities **directly**
   (visible per-pane chips + matrix settings UI + global stop-all); `Auto` capabilities run **indirectly**
   in the background. This makes the matrix surface a P0b keystone.
3. **Matrix completeness → harden first.** Build the WS-F/persistence/handler-path hardening *before*
   stacking velocity features, explicitly *for* development velocity (don't compound v1 debt). → **P0a**.
4. **Keystones → both full builds.** Push-observation **and** the matrix surface are both must-builds, not
   either/or. → **P0b**.
5. **Risk model → per-capability is enough.** No per-command/path risk dimension; the per-command
   risk-classification item is closed-as-built.
