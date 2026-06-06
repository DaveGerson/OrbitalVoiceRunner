# c55.9 — `execute_plan` REST Convergence: the Connection-Scoped Pane-Write Seam

**Status:** Design approved (2026-06-05). Ready for implementation planning.
**Bead:** `wsm-e2e-pinned-c55.9` (parent `wsm-e2e-pinned-c55`; blocks the terminal step `wsm-e2e-pinned-c55.16`).
**Seam shape:** A3-min (shared dispatch core), approved.

---

## 1. Goal

Converge the last inline pane-write route — `POST /api/plans/:id/execute` ("Run plan") — onto the registry `execute_plan` def, by giving the REST surface a **gated, connection-agnostic** pane-write path. This deletes the inline route, restores the c55 "one safety dial across surfaces" invariant, and **closes BUG-040** (the REST plan-execute writes step 1 un-gated today). It is the last architectural blocker feeding c55.16 (drop `opts.only`).

## 2. Context & the problem

Today the same action has **opposite safety behavior** on its two surfaces:

- **Inline REST** (`server.ts:945-970`, the "Run plan" button via `App.tsx handleExecutePlan`): does a **raw, ungated** `targetTerm.writeInput(currentStep.command)` — fires step 1 into the pane with no gate, any pane, any time.
- **Registry/voice** (`executePlan`, `src/actions/defs/orchestration.ts:113-165`): routes step 1 through `ctx.dispatchProposal({ capability: "execute_plan", … })`, which enforces `capabilityGates.execute_plan` (Auto → write, Ask → HiTL pending, Off → block).

`buildRestActionContext` (`server.ts:1144`) injects `dispatchProposal` as a **refusing stub** (`{ kind: "error", text: "pane-write is not available on the REST surface" }`), so converging the route today would make the Run-plan button always refuse. The route was therefore HELD (`src/actions/inlineExceptions.ts:46`).

**Why now:** `docs/review/IMPLEMENTATION_PLAN.md` logs **BUG-040** OPEN, with the explicit fix direction "route [the REST plan-execute] through the same `dispatchProposal` gate in a follow-up." c55.9 *is* that follow-up. The blocker that justified holding (no REST-native place to surface an Ask approval) was removed by **c55.15**, which converged the pending/approvals HiTL surface (`list_pending_actions` / `confirm_pending_action` / `cancel_pending_action`) and wired `pendingActions` + `pendingApprovals` into the REST `ActionContext`.

## 3. Decision

**Gated parity.** The REST/UI Run-plan path inherits the **capability gate** (`execute_plan` Auto/Ask/Off), reaching parity with voice and closing BUG-040. It does **not** inherit the voice-only active-pane HiTL guard (see §5, row 3): that guard constrains *unprompted Janus proposals*; an operator's Run-plan click is *operator-directed*, and the capability gate (Ask → approval dialog) is the correct HiTL checkpoint for that path.

## 4. The seam — what is and isn't connection-bound

`dispatchProposal` (`src/voice/index.ts:429-522`) is a pipe: **`[decide gate] → [apply effect]`**.

- The **`[decide]`** half — `effectiveModeFor(targetId)` + `effectiveCapabilityGateFor(targetId, capability)` + `decideProposal({ … })` — is **already shared, pure code** (src/gating). No duplication is introduced; both surfaces call the same decision.
- The **`[apply]`** half (`src/voice/index.ts:468-521`) branches on `decision.type`. Walking it, exactly **three** bindings differ between voice and REST:

| # | Binding | Voice today | REST needs |
|---|---|---|---|
| 1 | `sess` (stored in the approval side-map for the resolve-time `sendToolResponse`) | live Gemini session | `null` — already a legal type (`DispatchProposalArgs.sess: LiveSessionLike \| null`); PLM4 `detachSession` already keeps + resolves session-less "survivor" approvals, so the store and resolve path tolerate a null session |
| 2 | pending-notify sink (`pending_approval` arm, `src/voice/index.ts:511`) | `clientWs.send(approval_pending)` — the one originating socket | `broadcast(approval_pending)` — all connected operator UIs |
| 3 | active-pane guard (`src/voice/index.ts:454`, `isPaneActiveForWrite`) | **enforced** (Janus may only propose into the operator's open pane) | **skipped** (operator-directed click; not a Janus proposal) |

Everything else in the `[apply]` half — `auto_execute` (`addCommand` + `term.writeInput` + `broadcast`), `capability_forbidden`/`blocked_read_only` (`broadcast` + block), the `error_*`/`clarify_*` returns — is already connection-agnostic.

## 5. Architecture (A3-min: shared dispatch core)

Extract the `[apply effect]` switch into a single shared function both surfaces call:

```
applyDispatchDecision(
  decision,                       // the result of decideProposal (the shared [decide] half)
  deps,                           // connection-AGNOSTIC collaborators: manager, pendingApprovals,
                                  //   broadcast, addCommand, redactSecrets, getPaneSummary,
                                  //   posturePayloadForPane, announcementBus, effectiveMode, …
  conn,                           // the THREE connection-bound bindings:
) : DispatchOutcome

// conn = {
//   sess: LiveSessionLike | null,
//   notifyPending: (frame) => void,        // voice: clientWs.send ; rest: broadcast
//   enforceActivePaneGuard: boolean,       // voice: true ; rest: false
//   origin: "voice" | "rest",              // for the pending record / audit
// }
```

- **Voice** (`src/voice/index.ts`): `dispatchProposal` becomes a thin wrapper that resolves the gate as today and calls `applyDispatchDecision(decision, deps, { sess, notifyPending: (f) => clientWs.send(JSON.stringify(f)), enforceActivePaneGuard: true, origin: "voice" })`. **Behavior is byte-identical** to today; pinned by `tests/test_approvals_wse.ts`.
- **REST** (`server.ts buildRestActionContext`): replace the refusing stub with a `dispatchProposal` that resolves the same shared gate and calls `applyDispatchDecision(decision, deps, { sess: null, notifyPending: (f) => broadcast(f), enforceActivePaneGuard: false, origin: "rest" })`. `buildRestActionContext` already has `manager`, `broadcast`, `pendingApprovals`/`pendingActions` (c55.15), and `getActivePaneId`.

The active-pane guard (`src/voice/index.ts:454`) moves **inside** `applyDispatchDecision`, governed by `conn.enforceActivePaneGuard` (the shared core reads `coreState.activePaneId` + `isPaneActiveForWrite` via `deps`). One dispatch engine, two bindings — structurally preventing the surfaces from ever re-diverging.

## 6. REST decision table (`execute_plan` gate → behavior → HTTP)

| `execute_plan` gate / state | REST effect | HTTP via `rest.toHttp` |
|---|---|---|
| **Auto** | `addCommand` + `writeInput(step1)` now (= today's inline write) | **200** |
| **Ask** | stage `PendingApproval` (`pendingApprovals.add(record, null, …)`) + `broadcast(approval_pending)`; operator resolves via c55.15 `confirm_pending_action` → resolve path writes | **202** |
| **Off** | `broadcast(command_blocked)` + no write | **403** |
| pane offline (no live `term`) | plan paused, step failed, no write | **400** (preserves inline `400` "node offline") |
| plan not found | — | **404** (preserves inline `404`) |
| `clarify_*` (shell re-route) | no write | **409** |

The React client ignores the HTTP body and repaints off the `plans_updated` + `approval_pending` WS frames, so body shape is not load-bearing; statuses are preserved where the inline route distinguished them (`400`/`404`).

## 7. Data flow — the REST Ask path (end-to-end)

1. Operator clicks **Run plan** → `POST /api/plans/:id/execute` → `runAction(executePlan, restCtx)`.
2. `executePlan` handler sets the plan running and calls `ctx.dispatchProposal({ targetId: step1.terminalId, instruction: step1.command, capability: "execute_plan", sess: ctx.session /* null on REST */, pendingId: \`${callId}__${plan.id}__step0\`, … })`.
3. REST `dispatchProposal`: **skip** active-pane guard → resolve gate (`effectiveModeFor` + `effectiveCapabilityGateFor(_, "execute_plan")`) → `decideProposal(...)` → `applyDispatchDecision`.
4. Decision `pending_approval` → build `PendingApproval` record → `pendingApprovals.add(record, null, { workspaceId, ttlMs })` → `broadcast(approval_pending frame)` → return `{ kind: "pending" }`.
5. `executePlan` handler maps `pending` → `output` read-back string; returns `{ kind: "ok", output }` (voice wire shape preserved). `rest.toHttp` maps the outcome to **202**.
6. Operator UI shows the pending dialog (already wired by c55.15) → operator confirms via `confirm_pending_action` → the existing resolve path re-checks pane liveness and `writeInput`s step 1.

## 8. Components & files touched

- **New / refactor:** extract `applyDispatchDecision` (+ the `conn` shape). The plan fixes the module location (candidates: a new `src/dispatch/paneWrite.ts`, or alongside the shared gate helpers in `src/gating/`). It must import only connection-agnostic collaborators (no `clientWs`, no live `sess` capture).
- **`src/voice/index.ts`:** `dispatchProposal` (429-522) becomes a thin wrapper binding `clientWs.send` + `sess` + `guard:true` + `origin:"voice"`.
- **`server.ts` `buildRestActionContext` (~1144):** replace the refusing stub with the REST wrapper binding `broadcast` + `null` + `guard:false` + `origin:"rest"`.
- **`server.ts` (945-970):** delete the inline `POST /api/plans/:id/execute` route + the HELD note (938-944). Add `"execute_plan"` to the `mountRestRoutes` `only`-set.
- **`src/actions/defs/orchestration.ts` (executePlan):** add `rest.toHttp` for the §6 status map; expose the dispatch outcome kind to `toHttp` **without** changing the voice `output` string (see §9.2).
- **`src/actions/inlineExceptions.ts`:** delete the `POST /api/plans/:id/execute` held row (46). The no-twin guard requires the route deletion and the catalog-row deletion to land together.
- **Catalog:** `npm run catalog` regenerates (the def gains a `rest.toHttp` / `surfaces` projection change).

## 9. Error handling & edge cases (must be in the plan)

1. **`sess: null` resolution (load-bearing):** verify the `pendingApprovals` add + the c55.15 confirm/resolve path tolerate a null/`origin:"rest"` session (no `sendToolResponse` attempt on null). PLM4 `detachSession` survivors strongly imply yes — **pin it with an explicit test** (a REST-originated Ask, then confirm, asserts the write lands and no null-deref occurs).
2. **`toHttp` vs voice `output` string:** the handler returns `output` as the spoken/narration string on every branch (voice wire shape — do NOT change, per `orchestration.ts:108-111`). `rest.toHttp(result, args)` must derive the status from the dispatch outcome kind **without** mutating that string. Recommended: the handler carries the outcome kind on a structured field `toHttp` reads (mirror the c55.5 `toHttp` / c55.15 structured-output pattern); the exact mechanism is fixed in the plan against how c55.14/c55.15 wired `toHttp`.
3. **Active-pane-guard skip — explicit test:** assert REST `execute_plan` can target a **non-active** pane and write (Auto) / stage (Ask), while a voice proposal to a non-active pane still returns `clarify` (guard intact). This proves row 3 of §5 and prevents a regression to the inline behavior being lost.
4. **Auto path liveness guard:** preserve the inert-boot guard (`src/voice/index.ts:487`) — a ledger pane with no live `term` returns an error instead of crashing on `writeInput`; on REST this maps to **400** (parity with the inline "node offline" branch).
5. **Synthetic `pendingId`:** keep the `${callId}__${plan.id}__step0` synthetic id so a plan-step pending never collides with another pending entry.

## 10. Testing strategy

- **Voice regression (highest priority):** `tests/test_approvals_wse.ts` + the voice dispatch tests must stay green unchanged — proves the wrapper is byte-identical. This is the guardrail for touching the just-stabilized voice path.
- **New REST dispatch unit tests:** Auto → writes; Off → blocked + no write; Ask → stages pending (`pendingApprovals` grows) + broadcasts `approval_pending`, no `sendToolResponse`; offline → 400; not-found → 404; non-active pane → writes/stages (guard skipped).
- **`toHttp` contract test:** the §6 status map (extend the existing `toHttp`/rest-mount coverage from c55.5).
- **No-twin guard:** `tests/test_no_inline_twins.ts` stays green after the route + catalog-row deletion land together.
- **Full battery:** lint, unit (`--test-force-exit`), build, e2e, catalog drift.

## 11. Out of scope

- Steps 2..N of a plan (this converges step 1's write, exactly as inline does today; multi-step chaining is unchanged).
- The other declared inline exceptions (drafts, settings, raw-input) and the remaining c55.16 held collisions (`set_pane_gates`, `create_project` 2nd-mutation, `attention/clear` alias) — covered by the separate c55-closeout design package.
- Any change to the voice path's observable behavior.

## 12. Definition of done

- Inline `POST /api/plans/:id/execute` deleted; `execute_plan` served by the registry with the §6 `toHttp` map; its `inlineExceptions` row removed; no-twin guard green.
- REST Run-plan respects `capabilityGates.execute_plan` (Auto/Ask/Off) — BUG-040 closed.
- Voice behavior unchanged (regression suite green).
- Full battery green. c55.16's "execute_plan converged" precondition satisfied.
