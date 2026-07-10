# Phase 5, Step 5.5 — Final Release Review: decisions of record + validation record

Reviewer: final release review with cross-phase fix authority, 2026-07-10. Scope: the whole
Voice Communication Cockpit program (Phases 1–5, commits `d859f36..f9dc83a`) plus this step's
own fixes. Companion docs: ops guide `docs/runbooks/communication-cockpit-operations.md` ·
security decisions `docs/review/2026-07-10-communication-security-review-5.4.md`.

---

## 1. Architecture & boundary verdict

**PASS.** The implementation is explainable as *"Orbital listens, understands, drafts, routes,
correlates, and reports; terminal agents engineer."* A full boundary sweep (src/exchanges/**,
src/voice/**, src/observe/, action defs, src/orbital/ fleet components, metrics/replay/benchmark)
found **no violation** of the seven normative non-goals (no mission DAGs, no decomposition/
fabrication, no engineering verification, no retry policy/scheduling, no autonomous follow-ups,
no gate authority outside the capability-gate choke-point, one-instruction-one-pane grain).
Spot anchors: `buildEnvelope`/`renderEnvelope` emit operator content plus exactly one fixed
protocol line, enforced by a module-load profile-key guard; `recoverExchangesOnBoot` never
resends; `retryExchange` is operator-initiated, gated `write_to_pane`, and mints a follow-up
draft for `interrupted` (never a resume); metrics/benchmarks measure communication quality only.

## 2. Cross-phase defects found & fixed in 5.5

| # | Seam | Defect | Fix |
|---|---|---|---|
| F1 | fleet ↔ actions | Fleet cards offered **Retry** for terminal `agent_failed` rows (the service refuses unconditionally — the "failed" chip collapses `agent_failed` and `interrupted`) and **Hold/cancel** for terminal rows; refusals then surfaced as success toasts. | `FleetRow.exchangeState` + pure `fleetRetryOffered`/`fleetCancelOffered` keyed to the lifecycle's legal-transition/eligibility rules (`src/orbital/fleetExchangeOrdering.ts`, `FleetExchangeView.tsx`); cancel toast now shows the server's real outcome text (`useOrbitalData.ts`). Pinned by new unit + component tests. |
| F2 | pool ↔ notifications | The documented suppression of a **backgrounded project's completion** was ineffective: the null-means-fallback plumbing leaked it into the foreground session as a plain "PANE STATUS UPDATE" context line. | Three-way `ExchangeSignalNarration` (`narrate`/`fallback`/`suppress`) in `src/voice/index.ts`; background completions and already-narrated anchors are now genuinely silent. Pinned end-to-end by journey 13 (`tests/test_return_channel_journeys.ts`): silent live, surfaced on catch_me_up. |
| F3 | routing ↔ observability | `replay.ts` rendered `clarification_requested` events with `text: null` — `pickText` didn't know the `cause` payload key the producer writes. | `cause` added to `pickText`'s key list. |
| F4 | docs ↔ code | `src/exchanges/metrics.ts` header still claimed `target_resolved`/`clarification_requested` have "no producer yet" (false since 5.4). | Header rewritten: both producers named; `wrongTargetDeliveries` documented as a live tripwire; the pre-exchange clarify boundary documented (see §3.1). |
| F5 | test harness | `tests/test_policy_client.ts` — the "known baseline exception" (6-test cancellation class in Linux containers) turned out to have a cheap real root cause: the production race timer is deliberately `unref()`d, so on a quiet event loop the hung-daemon test's only wake-up source doesn't hold the loop open; node:test drains and cancels the test **and everything queued behind it**. | A ref'd keep-alive timer scoped to that one test's await window (test-only; the null still arrives via the production unref'd race timer — the contract is not weakened). 11/11 across 5 consecutive standalone runs, previously 5 pass / 6 cancelled deterministically. **The known-baseline exception is retired.** |

Boundary-adjacent cosmetics left alone deliberately: `terminal_quiescing` is consumed by a replay
bucket but never produced (spec-consistent — it is advisory-only; the filter matches nothing);
`context_version_delivered` is an as-yet-unproduced union member (forward vocabulary).

## 3. Deferred items — dispositions (1–7)

### 3.1 `clarification_requested` at the target-resolver clarify seam — **decision of record: keep dispatch-seam-only; document**

The resolver's "which pane did you mean" turn fires **before any exchange exists**, and
`exchange_events.exchange_id` is `NOT NULL` by deliberate schema design (every audit row belongs
to a real exchange). The carried-cause alternative (stash the clarify on the pane's open draft,
emit at the eventual `createExchange`) was evaluated and rejected for this release: the carry key
is the *draft's* pane while the clarify is about the *new* reference, so a confirmed retarget
moves the draft and orphans/mis-attributes the carried cause; it also adds a cross-module thread
(voice_ux → draftRegistry → both exchange-mint sites) for an audit-only breadcrumb. Pre-exchange
clarifies remain visible in the interaction log. **Root fix** is mint-at-compose (create the
exchange when drafting starts), which makes the resolver clarify an ordinary in-lifecycle event —
tracked in `docs/NEXT_STEPS.md` item 2. `countClarificationCauses` therefore counts post-exchange
clarifies only (documented at the metric).

### 3.2 (4.5-B7) terminal_idle-parked exchanges vs. manual commands — **decision of record: accept + document**

Marker lifetime is spec-locked, and the correlation contract "manual writes on the pane do not
advance the exchange lifecycle" is pinned (`tests/test_exchange_correlation.ts`). Clearing or
re-pointing the marker on a manual write would violate that contract and break the fast-command
flow. Residual exposure: a manual command whose output's final line passes the legacy done-line
heuristic can settle a parked exchange with the manual command's summary. It is narrow by
construction — the 4.5 eligibility gates already require real agent output, an at-rest exchange,
non-echo, and no failure vocabulary. Accepted and documented (ops guide §5.3, NEXT_STEPS R6);
revisit when mint-at-compose lands.

### 3.3 (4.5-B8) `ExchangeService.recordManualCommand` zero call sites — **FIXED: wired**

Wired at the one manual-write seam, `send_keys` (`src/actions/defs/panes_rest.ts` sendEffect),
guarded by `exchangeSpineActive()` and try/caught so a spine fault can never block the operator's
keystroke. Pure bookkeeping: `exchangeId: null` by contract, never touches the active-exchange
binding. Pinned by `tests/test_send_keys_manual_command.ts` (new file, spine-shadow process).

### 3.4 (4.5-B11) unwindowed tier-3 completions — **FIXED (the suggested anchor-set shape)**

Two halves (`src/voice/sitrep.ts`):
- **SITREP board**: tier-3 `agent_complete` items are now windowed by `COMPLETION_WINDOW_MS`
  (30 min, mirroring tier 6's `DECISION_WINDOW_MS` rationale) — a completion stops re-surfacing
  on every SITREP for up to 30 days; replay/attention/catch-up keep the durable record.
- **Attention re-mint**: completion items mint exactly once per `(exchange_id, updated_at)`
  anchor for the process lifetime (`mintedCompletionAnchors`, the ExchangeNarrationGate's
  derived-anchor idea applied to the mint). Scoped to `complete` only — needs_input/failed are
  the operator's outstanding backlog and their dismiss-then-re-push behavior is pinned intended.
Pinned by new cases in `tests/test_exchange_notifications.ts`.

### 3.5 Envelope draft vs. exchange version counters — **decision of record: keep separate; consistency argument documented**

The envelope draft (`EnvelopeDraft.draftVersion`, minted `envd_*`) and the exchange row
(`agent_exchanges.draft_version`, minted `exch_*` at send time) deliberately keep independent
counters. **The consistency guarantee is the shared approval record, not counter equality**:
- the envelope layer CAS-binds `(messageId, envelope draftVersion)` and invalidates through the
  one resolve choke-point on every version bump (`invalidateOutstandingApproval`);
- the exchange layer CAS-binds `(approval_id, approval_draft_version)` on its own counter
  (`confirmApproval`).
Both bindings reference the SAME `pending_approvals` row, so a stale approval loses at least one
CAS on either side — old text can never deliver regardless of which counter a caller consults.
Unifying the counters requires minting the exchange at compose time (today it is minted at send),
which would also close the draft-registry restart gap (documented in
`src/exchanges/draftRegistry.ts`) and the result-envelope id-delivery gap (§4.2) — one root
cause, three payoffs, deliberately a follow-up, not a release-window change.

### 3.6 z5c slice-3 physical hot-warm sockets — **documented honestly**

Status note added at the top of `docs/superpowers/specs/2026-07-07-z5c-session-pool-design.md`:
decision layer shipped, physical multi-socket execution deferred; `sessionPoolHotSlots` > 1
shapes plans, not sockets; background inject-class events are dropped-not-queued (D6) with
freshness bookkeeping. Also in the ops guide §5.1 and NEXT_STEPS item 1.

### 3.7 `context_injections` TTL — **FIXED**

The 5.4-reported pre-existing gap is closed following the exact 5.4 idiom
(`src/store/retention.ts`): 30d default, boot prune + batched incremental sweep, own try/catch
guard (pre-v10 DBs skip). `pruneOnBoot`'s transaction arrow was refactored to precomputed
cutoffs to stay under the CC-10 gate. Pinned by new cases in `tests/test_store_retention.ts`.

## 4. Other release-honest known gaps (operator-facing list in ops guide §5)

1. **Result-envelope correlation is defensive-only today** (found by this review's seam sweep):
   the delivered instruction never carries its `exchange_id`, so a live agent cannot echo a
   matching envelope — envelope settlement fires only for planted/fixture reports; live
   settlement rides the conservative legacy heuristic + ambient signals. Safe by construction
   (forged/stale ids are ignored and logged). Fix path = mint-at-compose (§3.5).
2. **Redacted-retry refusal** — 5.4 decision, unchanged.
3. **Voice-lane delivery settlement is post-hoc** (documented SCOPE NOTE,
   `src/voice/index.ts` ~1270): the voice arm derives exchange transitions from the returned
   DispatchOutcome after the synchronous call rather than strictly around the write — the
   crash-window between write and settle is quarantine-covered, not intent-covered, on that arm.
4. **`speechToDraftLatency` ≈ 0 for live traffic** (resolution synchronous with minting —
   documented at the producer).
5. **Raw scrollback at rest** (pre-existing, out of scope; 5.4 §"Raw-at-rest").

## 5. Validation record (this container, 2026-07-10)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` (tsc --noEmit) | ✅ clean |
| Unit suite | `npm test` | ✅ **4794 pass / 0 fail (954 suites)** — final post-fix full run, includes the retired policy_client class (F5) and the new 5.5 suites (journey 13, send_keys manual-command, retention TTL, fleet offer rules, B11 window/mint-once) |
| test_policy_client (was the known-baseline exception) | 5× standalone runs | ✅ 11/11 × 5 (was 5 pass / 6 cancelled deterministic pre-fix) |
| Component tests | `npm run test:component` (vitest) | ✅ 6 files, 61 tests pass (includes the updated FleetExchangeView suite) |
| E2E (mock harness) | `npm run test:e2e` | ✅ **222 passed / 8 skipped / 0 failed**, exit 0 (Playwright self-cleaning lanes; the fleet-exceptions specs were updated to the lifecycle-consistent quick actions — the pre-fix run failed exactly the two specs that pinned the OLD guaranteed-refused Retry/Hold behavior, F1, plus a new no-actions-on-terminal spec was added) |
| Complexity gates | `npm run complexity` (eslint: CC≤10, cognitive≤15, rules-of-hooks; zero suppressions) | ✅ exit 0 (one 5.5-introduced violation in retention.ts was caught and refactored during this review) |
| Build | `npm run build` (vite + esbuild + copy-python) | ✅ dist/server.cjs 931 kB + client bundle |
| Python tests | `npm run test:py` | ✅ 78/78 OK |
| Capability catalog | `npm run catalog` + `tests/test_catalog.ts` | ✅ regenerated, **no drift** (116 actions) |
| Live pane smoke | `npm run smoke:claude` | ⛔ **ENVIRONMENT-GATED: NOT RUN** — no authed Claude CLI binary in this container. |
| Live E2E | `npm run test:e2e:live` | ⛔ **ENVIRONMENT-GATED: NOT RUN** — requires live CLI + key material absent here. |
| Live voice verification | `npm run verify:live-voice` | ⛔ **ENVIRONMENT-GATED: NOT RUN** — no live Gemini API key in this container. |

The three environment-gated checks were **not weakened, stubbed, or faked**; they remain the
manual pre-merge gate per the standing done-pipeline (NEXT_STEPS R2).

## 6. Overall release verdict

**GO, with the documented known gaps.** The boundary holds everywhere it was probed; the five
phases compose without contract breaks after the 5.5 fixes (F1–F5); every deferred item has
either a shipped small fix (B8, B11, context_injections TTL, policy_client) or a reasoned
decision of record (resolver clarify seam, B7, version counters, slice-3 sockets); all
runnable gates are green with zero suppressions; the live-gated checks are honestly recorded as
not run. The largest single follow-up (mint-at-compose) is scoped in NEXT_STEPS with its three
dependent gaps named.
