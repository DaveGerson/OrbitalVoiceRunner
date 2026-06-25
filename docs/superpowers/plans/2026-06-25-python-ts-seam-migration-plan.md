# Project Plan: Python ⇄ TS Seam Migration (shadow-first, 4 increments)

- **Date:** 2026-06-25
- **Status:** Ready to execute (Increment 1)
- **Spec:** `docs/superpowers/specs/2026-06-25-python-ts-seam-migration-design.md`
- **ADR:** `docs/design/2026-06-19-python-ts-seam.md` (2026-06-25 amendment)
- **Review:** `handover/python-ts-seam-redteam-review.html`

---

## BLUF

Four independently-shippable increments. **Increment 1 ships this week** with no hard dependency and
~zero user risk (Python runs in shadow; TS stays authoritative). Trust/observability/Windows-CI work
is sequenced to **Increment 2 (the flip)**, where it bites. Increment 3 (retire + harden) is
metrics-gated and deferred. Increment 4 (the brain) branches off the proven seam and is
brainstorm-gated.

```
  INC 1 ──────────▶ INC 2 ──────────▶ INC 3
  Prove the seam    Take the dep       Retire + harden
  (shadow)          (flip)             (metrics-gated, deferred)
  ship this week    after clean        ├─ retire twin (fallback≈0)
  no dependency     shadow window      ├─ breaker reducer [F5]   ┐
  ~zero risk        audible degrade    ├─ full contract test [F6]├ opportunistic
                    Windows live-CI    └─ latency partition [F-HOL]┘
       │
       └────────────────────────────────────────────▶ INC 4
                                                       The brain
                                                       greenfield Python agent logic
                                                       on the PROVEN seam
                                                       (branches off Inc 1, not Inc 3)
                                                       brainstorm-gated
```

The seam is *proven* the moment Increment 1 lands. Increment 4 needs only the proven seam — it does
**not** wait on the flip or the retire. That is the branch in the diagram.

---

## Increment 1 — "Prove the seam"

**Goal:** Ship the first Python port in shadow. Python computes `parseApprovalIntent` alongside the
authoritative TS; we log/count diffs. No hard dependency, ~zero user risk. Generalize the bridge to
one multiplexed daemon + typed facade. Take the free scope cuts.

**Entry gate:** ADR amendment + this plan accepted (done — 2026-06-25). Repo clean.

**Exit gate:** `npm run lint` (tsc) + `npm run complexity` + `npm test` + mock-`npm run test:e2e`
all green. **No new infra** (no Windows-CI job, no observability push, no contract test). Shadow diff
counter wired and emitting.

### Task list (implementation granularity)

| # | Task (crisp deliverable) | Absorbs | Notes |
|---|---|---|---|
| 1.1 | **Extract generic transport core.** Pull spawn/discovery/breaker/line-framing/pending-map/expiry out of `createPythonSynthClient` into `createPythonModuleClient` (generic core). | F4, F-API | Behavior-preserving refactor; existing synth tests must stay green unchanged. |
| 1.2 | **Re-express synth client as a typed facade.** `request(tiers, cfg, now)` becomes a thin wrapper over the core — **signature byte-identical** (no churn across ~6 test files + `index.ts:43`). | F-API | The adapter is the whole point: zero positional-call migration. |
| 1.3 | **Add `approval.parse` op to the Python router.** Extend `dispatch.py` `handle()` with the namespaced op; keep its per-request `try/except` blast-radius. | F4 | One daemon, one router — not a second process. |
| 1.4 | **Freeze the envelope + single-source `WIRE_VERSION`.** One checked version constant both sides; `approval.parse` gets its own request/response payload schema (`{transcript}` → `{intent, targetHint?}`). | F6 (light) | Full contract test deferred to Inc 3. |
| 1.5 | **Port `parseApprovalIntent` + tables to Python.** Negators, bare-yes/no, strong/weak verbs, the defer phrase table + precedence, ordinals, fragment extraction, the leading-negator directive. | F-TARGET | Pure port; canonize current TS behavior exactly (no "fixes"). |
| 1.6 | **Wire SHADOW.** At the approval call-site, run TS (authoritative — answer used) **and** Python (observer); record `match`/`mismatch` (counter + structured log line). Nothing the operator sees depends on Python. | F-TARGET, F9 | The shadow harness is the live confirmer for F9 Path B. |
| 1.7 | **Boundary golden-master sweep.** Drive TS `parseApprovalIntent` across a dense, *boundary-focused* grid; freeze outputs; a Python unit test asserts the port reproduces every vector. | F9 (Path A) | Hit `len<=2`/`len<=3` guards, negation window, defer ladder, apostrophe-drop, approve/reject collisions. Not sampled. |
| 1.8 | **DROP `recipeApply`.** Remove from migration scope permanently; it stays TS (the gate). Doc note in the plan; no code change. | F1 | Free scope cut. |
| 1.9 | **KEEP `voiceAckGate` in TS + add the in-process regression test.** Assert the ack decision is computed in-process (never crosses the seam). | F2 | Free scope cut; the one seam where tidy architecture would break the product. |

### Per-finding dispositions absorbed

F-TARGET (port, shadow) · F1 (drop) · F2 (keep + test) · F4 (one daemon) · F-API (typed facade) ·
F6 (envelope + single-source version; contract test deferred) · F9 (sweep + shadow-compare).

### Risk notes

- **Refactor risk (1.1/1.2).** The core extraction touches the breaker/discovery machine that F5
  flags as under-tested. Mitigation: behavior-preserving extraction only; the existing synth tests
  are the regression net; do **not** change breaker semantics here (that's deferred F5).
- **Parity-grid blind spots (1.7).** A weak grid canonizes a false "parity." Mitigation: grid is
  boundary-focused and reviewed, not sampled; shadow (1.6) is the live backstop.
- **Behavior-freeze trap.** The sweep canonizes any TS bug. Accepted deliberately — porting, not
  redesigning; corrections are a later, separate decision.

---

## Increment 2 — "Take the dependency"

**Goal:** Flip Python → primary; the TS twin becomes the fail-closed fallback (the floor). Ship the
trust work that the flip makes load-bearing: audible degradation + observability + Windows live-CI.

**Entry gate:** Increment 1 merged **and** shadow has run green over an agreed window (length/volume
set by the operator once real traffic exists). Fallback-rate observable.

**Exit gate (merge gate on the flip PR):** **"twin present + fail-closed verified + degradation
audible."** Plus the standing green battery (lint/complexity/unit/e2e) and the new live-spawn
Windows CI smoke passing.

### Task list

| # | Task | Absorbs | Notes |
|---|---|---|---|
| 2.1 | **Flip to primary.** Python answer is the one acted on; TS twin invoked as fallback on unavailable/timeout/breaker-open/version-mismatch. Twin **NOT deleted** — it is the floor; no separate shim. | F3 | Reviewer signs: floor returns conservative intent (clarify, no auto-resolve) on Python-unavailable; fail-**closed**, never fail-stale/open. |
| 2.2 | **Observability WS push.** Emit a daemon-state frame on every transition + breaker open/close (reuse `broadcast()`); visual degradation badge; fallback-rate counter (the metric Inc 3 retire gates on). | F8 | Don't over-debounce — a flapping daemon *is* the status. |
| 2.3 | **Audible degradation (the product law).** Earcon + Kitchen Radio narration on any flip to fallback ("Chef — voice brain on backup"). Visual badge is insufficient for eyes-off. | F8 | UX_BRIEF Principle 7 + #1 anti-pattern. Merge-blocking. |
| 2.4 | **Windows reliability.** Discovery failures advance `candIndex` **without** spending the breaker budget; live-spawn Windows CI smoke (boot real daemon, assert pong); interpreter pin on top. | F7 | Removes both Windows cold-start failure paths; stops silent CI regression. |

### Per-finding dispositions absorbed

F3 (floor = retained twin, verify-at-flip, no separate shim) · F8 (observability push + audible
degradation) · F7 (discovery ≠ breaker budget + live Windows CI smoke).

### Risk notes

- **Breaker accounting is safety-sensitive (2.4).** Changing what counts toward the breaker touches
  the floor's availability. Mitigation: discovery-failure exemption is surgical; covered by the new
  Windows live-CI smoke + (if landed) the deferred F5 reducer tests.
- **Debounce vs. honesty (2.2/2.3).** Too much debounce hides a flapping daemon (violates the law);
  too little spams the Radio. Tune to "every real transition is audible, transients don't chatter."
- **Flip is the first real user-risk moment.** This is why 2.1–2.4 are a single merge gate — none
  ships without the others.

---

## Increment 3 — "Retire + harden" (deferred, metrics-gated, directional)

**Goal:** Remove the TS twin once it's provably dead weight; then opportunistic hardening.

**Entry gate:** fallback-rate ≈ 0 over an agreed window (from the Inc 2 counter). Hardening items
additionally gated on a **2nd hot consumer or real metrics** demanding them.

**Exit gate:** twin removed with no availability/parity regression; any hardening item that lands
has its own green tests.

### Task list (directional)

| # | Task | Absorbs | Trigger |
|---|---|---|---|
| 3.1 | **Retire the TS twin.** Remove once fallback-rate ≈ 0 over the window. | F9 (close-out) | Metrics. |
| 3.2 | **Breaker reducer + 3 characterization tests.** `breakerStep(state,event,now)→{state,action}`; tests for probe-recovery, in-flight-crash settle, window-reset. | F5 | Opportunistic — a 2nd hot consumer or flapping metrics. |
| 3.3 | **Full schema contract test.** Boot the real daemon in CI; assert every op's response parses. | F6 | A 2nd op / payload-drift risk. |
| 3.4 | **Latency-class daemon partition.** Approvals on a fast lane; never queue behind heavy synth. | F-HOL | Real same-daemon contention appears. |

### Per-finding dispositions absorbed

F9 (final retire) · F5 (deferred) · F6 (contract test, deferred) · F-HOL (deferred).

### Risk notes

- Retiring too early (before the window is truly clean) re-introduces the F3 floor loss. The
  metrics gate is the guard — do not eyeball it.

---

## Increment 4 — "The brain" (directional, brainstorm-gated)

**Goal:** Greenfield agent / planning logic born in Python on the proven seam — the dev-productivity
payoff and the ADR's preferred "new logic born in Python."

**Entry gate:** the seam is proven (**Increment 1 merged** — does NOT wait on Inc 2/3) **and** a
dedicated brainstorm has scoped the first brain consumer.

**Exit gate:** TBD by that brainstorm.

### Risk notes

- Scope is unbounded until the brainstorm runs — that gate exists precisely to bound it. No
  implementation tasks listed here on purpose.

---

## Cross-cutting risks

| Risk | Increment | Mitigation |
|---|---|---|
| Dual-maintenance window (two-language tables) | 1→3 | Bounded by the metrics-gated retire; any semantics change lands both sides + re-runs the sweep. |
| Behavior freeze canonizes a TS bug | 1 | Deliberate; corrections are a separate post-parity decision. |
| Breaker stays timing-coupled through the flip | 1→2 | Shadow can't break the user; flip's audible degradation surfaces flapping; F5 reducer available if metrics demand. |
| "Agreed shadow window" unset | 1→2 | Set by operator once Inc 1 lands and real traffic exists — gated on data, not guessed. |

---

## Appendix A — Proposed beads (id-less; DO NOT create — for operator)

> One bead per crisp deliverable, grouped by increment. Titles + one-liners only; the operator
> creates these with `bd create`.

**Increment 1 — Prove the seam (ship this week)**

- `seam: extract generic createPythonModuleClient core` — pull transport/discovery/breaker out of the synth client, behavior-preserving. *(Inc 1)*
- `seam: re-express synth client as typed facade (byte-identical signature)` — zero churn across the ~6 positional-call test files. *(Inc 1)*
- `seam: add approval.parse op to dispatch.py router` — one multiplexed daemon, namespaced op. *(Inc 1)*
- `seam: freeze envelope + single-source WIRE_VERSION` — one checked version constant both sides; approval payload schema. *(Inc 1)*
- `seam: port parseApprovalIntent + tables to Python` — pure port; canonize current TS behavior exactly. *(Inc 1)*
- `seam: wire SHADOW compare for approval parsing` — TS authoritative, Python observes, log/count diffs. *(Inc 1)*
- `seam: boundary golden-master sweep for parseApprovalIntent` — dense boundary grid frozen as Python parity vectors. *(Inc 1)*
- `seam: DROP recipeApply from migration scope (stays TS — the gate)` — doc-only scope cut. *(Inc 1)*
- `seam: keep voiceAckGate in TS + add in-process regression test` — assert the ack decision never crosses the seam. *(Inc 1)*

**Increment 2 — Take the dependency (after clean shadow window)**

- `seam: flip parseApprovalIntent Python→primary, TS twin→fail-closed floor` — no separate shim; twin is the floor. *(Inc 2)*
- `seam: observability WS push + fallback-rate counter + degradation badge` — state frame on every transition + breaker open/close. *(Inc 2)*
- `seam: audible degradation — earcon + Kitchen Radio narration on flip to fallback` — UX Principle 7; merge-blocking. *(Inc 2)*
- `seam: Windows reliability — discovery≠breaker budget + live-spawn Windows CI smoke` — boot real daemon, assert pong; interpreter pin. *(Inc 2)*

**Increment 3 — Retire + harden (deferred, metrics-gated)**

- `seam: retire TS approval twin once fallback-rate ≈ 0` — metrics-gated removal. *(Inc 3)*
- `seam: extract breaker as pure reducer + 3 characterization tests` — opportunistic [F5]. *(Inc 3)*
- `seam: full schema contract test (boot real daemon in CI)` — opportunistic [F6]. *(Inc 3)*
- `seam: latency-class daemon partition (approvals on a fast lane)` — opportunistic [F-HOL]. *(Inc 3)*

**Increment 4 — The brain (brainstorm-gated)**

- `seam: brainstorm first greenfield Python brain consumer on the proven seam` — scope the agent/planning beachhead. *(Inc 4)*

---

## Appendix B — Sequencing diagram (one screen)

```
                         OPERATOR ACCEPTS (2026-06-25)
                                   │
                                   ▼
   ┌───────────────────────────────────────────────────────────────────────┐
   │ INCREMENT 1 · PROVE THE SEAM                          ship this week     │
   │   1.1 generic core ─▶ 1.2 typed facade ─▶ 1.3 approval.parse op          │
   │   1.4 envelope+version ─▶ 1.5 port parser ─▶ 1.6 SHADOW ─▶ 1.7 sweep     │
   │   1.8 drop recipeApply   1.9 keep voiceAckGate (+test)                   │
   │   GATE: tsc + complexity + unit + mock-e2e  (NO new infra)               │
   └───────────────────────────────────────────────────────────────────────┘
                 │ (seam PROVEN here)                       │
                 │                                          │
                 │  clean shadow window (operator-set)      │ branches off the
                 ▼                                          │ proven seam — does
   ┌─────────────────────────────────────────────────┐     │ NOT wait on Inc 2/3
   │ INCREMENT 2 · TAKE THE DEPENDENCY (the flip)     │     │
   │   2.1 flip→primary (twin = fail-closed floor)    │     │
   │   2.2 observability push   2.3 AUDIBLE degrade   │     │
   │   2.4 Windows live-CI + discovery≠breaker        │     │
   │   MERGE GATE: twin present + fail-closed +       │     │
   │               degradation audible                │     │
   └─────────────────────────────────────────────────┘     │
                 │ fallback-rate ≈ 0 (metrics)              │
                 ▼                                          │
   ┌─────────────────────────────────────────────────┐     │
   │ INCREMENT 3 · RETIRE + HARDEN (deferred)         │     │
   │   3.1 retire twin                                │     │
   │   3.2 breaker reducer [F5]  ┐                    │     │
   │   3.3 contract test  [F6]   ├ opportunistic only │     │
   │   3.4 latency partition[F-HOL]┘                  │     │
   └─────────────────────────────────────────────────┘     │
                                                            ▼
                                          ┌─────────────────────────────────┐
                                          │ INCREMENT 4 · THE BRAIN          │
                                          │   greenfield Python agent logic  │
                                          │   brainstorm-gated               │
                                          └─────────────────────────────────┘
```
