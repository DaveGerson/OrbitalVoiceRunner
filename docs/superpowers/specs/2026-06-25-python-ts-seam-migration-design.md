# Design Spec: Python ⇄ TS Seam Migration — shadow-first, 4-increment

- **Date:** 2026-06-25
- **Status:** Accepted (operator direction, post red-team + product review)
- **Owner:** operator
- **Supersedes:** the "delete-on-cutover" posture in the brainstorm under `handover/python-ts-seam-redteam-review.html` (decision #2/#5/#6 there)
- **Amends:** `docs/design/2026-06-19-python-ts-seam.md` (the ADR — see its 2026-06-25 amendment section)
- **Companion plan:** `docs/superpowers/plans/2026-06-25-python-ts-seam-migration-plan.md`
- **Review input:** `handover/python-ts-seam-redteam-review.html` (3 eng reviewers → 3 remedy analysts → 3 product personas; 12 findings)

---

## 1 · Executive summary (BLUF)

**We ship the first Python port in SHADOW — Python computes alongside the authoritative TS, we
log/count the diffs, and TS stays the source of truth. This decouples "ship the port" from "take a
hard dependency," and pulls the entire trust/observability/Windows-CI burden OUT of the critical
path to the first merge.** That burden returns at the *flip to primary*, exactly where it bites —
not as an upfront gate.

The migration philosophy survives the review intact: **Python owns decisions; TS owns the frontend
+ I/O shell; we generalize the one proven bridge.** Three things changed:

- **Posture:** `SHADOW → FLIP → RETIRE` replaces delete-on-cutover. The TS twin is the fail-closed
  floor; it is retired *last*, only after the Python side is proven, never deleted at cutover.
- **First target:** `parseApprovalIntent` (the voice-approval parser) — not `recipeApply` (the
  gate) or `voiceAckGate` (pure-but-hot). Both of those stay TS permanently.
- **Sequencing:** the trust work (audible degradation, fail-closed verification, Windows live-CI)
  is honored, but sequenced to **Increment 2 (the flip)**, not demanded before the first merge.

**Founder principle driving this:** build a product that makes developers faster and more capable;
move quickly; get increments out the door. The trust/safety work is honored, but **sequenced to
where it bites, not used as an upfront gate.**

---

## 2 · The reframe (the logjam-breaker)

The review left a pile of "fix before spec" blockers — observability push, audible degradation,
Windows live-CI, the fail-closed shim, the breaker reducer extraction, latency-class partitioning.
Read literally, every one of those is a precondition to the first merge, and the first merge never
happens.

**The reframe: decouple "ship the port" from "take the dependency."**

| | Old framing (cutover) | New framing (shadow-first) |
|---|---|---|
| First merge ships… | Python as the new authority | Python computing **in shadow**, TS still authoritative |
| User risk at first merge | Real — a degraded daemon breaks a live feature | **~Zero** — TS answer is always the one used |
| What gates the first merge | observability + Windows-CI + fail-closed shim + breaker + latency partition | `tsc` + complexity + unit + mock-e2e green. **No new infra.** |
| When does the trust work land | upfront, all at once | at the **flip** (Increment 2), where it actually bites |

In shadow, the Python side is a **silent observer**: it receives the same input, computes its
answer, and we record `match / mismatch` against the authoritative TS answer. Nothing the operator
sees or hears depends on Python being up. So the death of the daemon is invisible *and harmless* —
which is the only context where "invisible" is acceptable. The moment Python's answer can change
what the operator experiences (the flip), invisibility becomes the cardinal sin again, and the
audible-degradation + fail-closed work becomes a hard merge gate. That is Increment 2.

---

## 3 · Supersession — delete-on-cutover is retired

The brainstorm's locked decision #2 ("Cutover = delete TS; Python = single source of truth + hard
dependency") and #5/#6 (Phase-1 = `voiceAckGate` + `recipeApply`; parity = harvest-then-delete
same-PR) are **formally superseded as of 2026-06-25.**

**New posture: `SHADOW → FLIP → RETIRE`.**

- **SHADOW** — Python computes alongside authoritative TS; we log/count diffs. No dependency.
- **FLIP** — Python becomes primary; the TS twin becomes the fail-closed fallback (the *floor*).
  The twin is **NOT deleted** — it *is* the floor. There is no separate "5-line shim"; the retained
  twin already is a correct, exhaustively-tested fail-closed implementation.
- **RETIRE** — the TS twin is removed only after metrics prove the Python side (fallback-rate ≈ 0
  over an agreed window). Retirement is deferred and metrics-gated, never same-PR.

Why this beats both the original "delete-same-PR" and a naive "no-delete-forever":

- vs **delete-same-PR**: that destroys the parity oracle (F9) and the availability floor (F3) in
  one stroke. Catastrophic for the highest-trust function in the codebase.
- vs **keep-twin-forever**: two drifting brains rot (the F3 Path-B objection). Our retire step is
  real and metrics-gated — the twin's lifespan is bounded, just not by the cutover PR.

---

## 4 · Architecture

### 4.1 The bridge, generalized (one multiplexed logic daemon + typed facade)

Today the bridge (`src/memory/pythonClient.ts` ⇄ `python/synthesizer/dispatch.py`) is a warm
stdio-NDJSON daemon with exactly one consumer (the synthesizer). Generalizing it for a second
consumer must NOT spawn a second process per module.

- **One multiplexed logic daemon [F4].** The Python side already multiplexes on `op`
  (`dispatch.py:18-35` routes `ping` / `synthesize`). A new op (`approval.parse`) joins the same
  router in the same long-lived child. One cold-start, one breaker, one interpreter discovery — not
  N. `handle()`'s per-request `try/except` keeps blast-radius per-op. A dedicated process is
  reserved only for genuinely heavy/unsafe future work.
- **Generic core + typed facade [F-API].** Extract the transport machinery from
  `createPythonSynthClient` into a generic `createPythonModuleClient` core (spawn, discovery,
  breaker, line-framing, pending-map, request/expiry). Ship each consumer as a **thin typed facade**
  over it:
  - `request(tiers, cfg, now)` — the existing synthesizer signature, **byte-identical** (zero churn
    across the ~6 test files + `index.ts:43` that depend on it positionally).
  - `parseApproval(transcript)` — the new approval facade.

  The facade is where the op string and the Zod schema live; the core is generic and tested once.
  This is the review's Path A for F-API: an adapter preserves the exact signature for free; the
  generics-parameterized factory (Path B) buys purity at the cost of churn for no behavioral gain.

```
  ┌─────────────────────── TypeScript (frontend + I/O shell) ───────────────────────┐
  │                                                                                  │
  │   synth facade            approval facade           (future facades)             │
  │   request(tiers,cfg,now)  parseApproval(transcript)                              │
  │        │                       │                                                 │
  │        └───────────┬───────────┴─────────────────────────────┐                  │
  │                    ▼                                          ▼                  │
  │        createPythonModuleClient (generic core)   ── spawn/discovery/breaker/     │
  │                    │                                 line-framing/pending-map    │
  └────────────────────┼─────────────────────────────────────────────────────────────┘
                       │  one warm child · NDJSON · one object per line
  ┌────────────────────▼─────────────────────────── Python (the brain) ─────────────┐
  │   dispatch.handle(msg) ── op router ──▶ synthesize · approval.parse · ping        │
  └──────────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 The protocol (envelope / payload split + single-source version)

The wire is NDJSON, one JSON object per line, correlated by `id` (unchanged). We split the message
into a **frozen envelope** and a **per-op payload [F6]**:

- **Envelope (frozen, single-source `WIRE_VERSION`):** `{ id, v, op, ... }` on the request;
  `{ id, v, ok, ... }` on the response. `WIRE_VERSION` is the one constant that **must** match both
  sides — it is single-sourced now (a generated/checked constant, not two hand-typed `15`/`1`
  literals at `types.ts:60` and `dispatch.py:15`). A version mismatch ⇒ daemon treated as
  unavailable ⇒ fallback (existing behavior, preserved).
- **Payload (per-op, owned by the facade):** each op authors its own request/response payload
  schema. For `approval.parse`: request `{ transcript }`, response
  `{ intent, targetHint? }` matching `ParsedApproval`.

The full **schema contract test** (boot the real daemon, assert every op's response parses) is
deferred to Increment 3 — at Increment 1 the cheap boundary golden-master sweep (§6) already pins
`approval.parse` behavior, and a single consumer doesn't yet justify the live-interpreter CI cost.
This is the review's F6 recommendation: single-source the version *now*, defer the contract test.

### 4.3 What crosses, what doesn't (the ADR litmus)

`parseApprovalIntent` passes all four ADR litmus points (`docs/design/2026-06-19-python-ts-seam.md`
§ "Litmus test"):

1. **Pure** — `approvalIntent.ts:333`: `string in → POJO out`, no `this` / PTY / WS / DB handle, no
   closure capture.
2. **A decision/transformation**, not transport.
3. **Not on a hot path** — called once per voice approval (human-paced, cold).
4. **Latency-tolerant** — a stdio round-trip is invisible at human approval cadence.

The two rejected targets fail the litmus and stay TS **permanently** (§7).

---

## 5 · The SHADOW → FLIP → RETIRE lifecycle

```
   ┌──────────┐        ┌──────────┐        ┌──────────┐        ┌──────────┐
   │  SHADOW  │  ───▶  │   FLIP   │  ───▶  │  RETIRE  │   …▶   │ THE BRAIN│
   │  (Inc 1) │        │  (Inc 2) │        │  (Inc 3) │        │  (Inc 4) │
   └──────────┘        └──────────┘        └──────────┘        └──────────┘
   TS authoritative;   Python primary;     metrics-gated:      greenfield agent
   Python observes;    TS twin = fail-     remove the twin     logic born in
   log/count diffs.    closed floor;       once fallback≈0;    Python on the
   No dependency.      audible degrade.    then opportunistic  proven seam.
                                           hardening.
```

- **SHADOW (Increment 1).** Every approval utterance is parsed by **both** TS (authoritative — its
  answer is used) and Python (observer — its answer is logged + compared). A mismatch is recorded
  (counter + structured log line), never acted on. Exit when shadow runs green over an agreed window.
- **FLIP (Increment 2).** Python becomes the answer the system acts on; TS becomes the fail-closed
  fallback invoked on Python-unavailable / timeout / breaker-open / version-mismatch. The fallback
  is **fail-closed** (returns the conservative intent — `clarify` / no auto-resolve — never reuses a
  stale answer, never fail-opens to `approve`). The degradation is **spoken** (§8).
- **RETIRE (Increment 3).** When the observability counter shows fallback-rate ≈ 0 over a window,
  remove the TS twin. Then, and only if a second hot consumer or real metrics demand it, do the
  deferred hardening (breaker reducer, full contract test, latency partition).

---

## 6 · Parity strategy (golden-master sweep + production shadow-compare)

Per F9 — a wrong approval parse is a *silent wrong action* (say "approve the second one" and the
first fires; a wrong "reject" claim+deletes a staged command the operator wanted kept —
`approvalIntent.ts:110` literally warns of this). Parity is two complementary oracles, **and the
twin survives until BOTH are green**:

- **Boundary golden-master sweep (the gate, Increment 1) [F9 Path A].** Drive the TS
  `parseApprovalIntent` across a **dense, boundary-focused** input grid — *not sampled* — and freeze
  the outputs as the vector set Python must reproduce. The grid deliberately hits the
  length-guard boundaries the existing tests miss: `tokens.length <= 2` (`tryBareYesNo`,
  `tryBareSkip`), `tokens.length <= 3` (defer short-`later`), the negation window edges, the
  defer-precedence ladder, apostrophe-drop forms, and approve/reject collisions. The oracle *is* the
  TS implementation, so the sweep canonizes current behavior exactly (including any TS edge bug —
  the safest "preserve behavior" stance; behavior changes are a separate, later decision).
- **Production shadow-compare (the confirmer, Increment 1→2) [F9 Path B].** The shadow run itself is
  the live diff against the true input distribution — it catches inputs no generator imagined. The
  twin is retired (Increment 3) only after the sweep is green **and** the shadow window is clean.

This is the review's hybrid: A as the gate, B as the confirmer, never delete the twin in the same PR.

---

## 7 · What stays TS, and why (the rejected targets)

Both original Phase-1 targets are disqualified by the ADR litmus and stay TS **permanently**.

- **`recipeApply` = the gate [F1] → DROP, stays TS.** `planRecipeApply`
  (`recipeApply.ts:29-34`) takes live closures (`resolveLayout` / `resolvePane`) that call
  `ctx.effectiveCapabilityGateFor` inside a **synchronous** handler (`layouts.ts:256`). Closures
  can't cross "one JSON per line," and this *is* the capability gate the ADR explicitly defers
  (§ "Notable deferral"). The only seam-crossable remnant is a ~6-line disposition ternary, dwarfed
  by the round-trip — and it sits on the Journey-1 fan-out path that spawns panes on the operator's
  host. A synchronous fail-closed gate read is never traded for a stdio round-trip here.
- **`voiceAckGate` = pure-but-hot [F2] → KEEP in TS + add a regression test.**
  `shouldSpeakOpeningAck` / `shouldSpeakReadyAck` (`voiceAckGate.ts:39-50`) are pure and cold, but
  decide "speak over the operator NOW" against a **1500 ms barge-in window** (`OPERATOR_HOLD_MS`). A
  round-trip (up to the 2 s request expiry) makes the turn-state snapshot stale — failing ADR
  litmus (4). And the fail-closed direction inverts here: the safe default for a *gate* is "don't
  act," but the safe default for an *ack* is "don't go silent" — fail-closed-on-timeout would turn
  every ack into a suppress, violating the UX law. We add an **in-process regression test** that
  asserts this decision stays in TS (the one seam where "tidy architecture" would actively break the
  product).

**Litmus summary:**

| Unit | Pure? | Decision? | Cold (not hot)? | Latency-tolerant? | Verdict |
|---|:--:|:--:|:--:|:--:|---|
| `parseApprovalIntent` | ✅ | ✅ | ✅ | ✅ | **Port (shadow→flip), twin kept** |
| `recipeApply` | ❌ (closures) | gate | ✅ | ❌ (sync gate read) | **Stays TS (drop)** |
| `voiceAckGate` | ✅ | ✅ | ❌ (1.5 s window) | ❌ (stale snapshot) | **Stays TS (+ regression test)** |

---

## 8 · Safety / trust contract

Two non-negotiables, both activated at the **flip** (Increment 2), both merge-blocking on the flip PR.

- **Fail-closed floor = the retained TS twin.** When Python is unavailable / times out /
  breaker-open / version-mismatched, the system falls back to the TS twin, which returns the
  **conservative** intent (no silent auto-resolve; `clarify` over a guessed `approve`/`reject`). The
  floor must be auditably **fail-closed, never fail-stale** (no reusing the last answer) and never
  fail-open. A reviewer signs that the floor rejects-not-approves on Python-unavailable. There is no
  separate shim to drift — the twin *is* the floor.
- **Audible degradation (the product law).** Per `docs/orbital-kitchen/UX_BRIEF.md` Principle 7
  ("speak the consequence, confirm out loud") and §5's #1 anti-pattern ("silent autonomy — act with
  nothing said/shown"): a daemon flipping `python → fallback` **is itself a silent state change** —
  the cardinal sin in a hands-free, calmly-trust-the-swarm product. So every flip to fallback must
  **earcon + narrate into the Kitchen Radio** ("Chef — voice brain on backup, every plate gets a
  taste"), not merely log or badge. The visual degradation badge is necessary but **insufficient**
  for an eyes-off operator; the audible cue is the requirement. Observability is a WS push on every
  transition + breaker open/close, with a fallback-rate counter (the metric the retire decision
  gates on). Don't debounce so hard it hides a flapping daemon — a degrading machine *is* the status.

> **Note on shadow (Increment 1):** in shadow, Python's death is invisible *and harmless* (TS is
> authoritative; nothing the operator sees depends on Python). So the audible-degradation law does
> **not** gate Increment 1 — it gates the flip, the instant Python can change what the operator
> experiences. This is the whole point of the reframe.

---

## 9 · Per-increment design

### Increment 1 — "Prove the seam" (ship this week · no dependency · ~zero user risk)

Implementation-grade. Exit gate: `tsc` + complexity + unit + mock-e2e green. **No new infra.**

1. **Generalize the bridge [F4, F-API].** Extract the generic `createPythonModuleClient` core from
   `createPythonSynthClient`; re-express the synth client as a thin typed facade over it
   (signature byte-identical). Add the `approval.parse` op to `dispatch.py`'s router.
2. **Protocol split + single-source version [F6, light slice].** Freeze the envelope; give
   `approval.parse` its own payload schema; single-source `WIRE_VERSION` (one checked constant, both
   sides). Defer the full contract test.
3. **Port `parseApprovalIntent` to Python IN SHADOW [F-TARGET].** Port the parser + all its tables
   (negators, bare-yes/no, strong/weak verbs, defer phrase table, ordinals, fragment extraction) to
   Python. **TS stays authoritative**; Python computes alongside; log + count diffs.
4. **Boundary golden-master sweep [F9].** Freeze the dense boundary grid of TS outputs as Python's
   parity vectors; a Python unit test asserts the port reproduces every vector.
5. **Free scope cuts:** **DROP `recipeApply` [F1]** (stays TS, gate); **KEEP `voiceAckGate` in TS
   and add the in-process regression test [F2].**

### Increment 2 — "Take the dependency" (after shadow runs green for an agreed window)

1. **Flip Python → primary [F3].** TS twin becomes the fail-closed fallback (NOT deleted — the twin
   IS the floor; no separate shim).
2. **Observability + audible degradation [F8].** WS push of daemon state on every transition +
   breaker open/close; visual badge; **earcon + Kitchen Radio narration** of any flip to fallback;
   fallback-rate counter.
3. **Windows reliability [F7].** Discovery failures advance `candIndex` **without** counting against
   the breaker budget; a **live-spawn Windows CI smoke** that boots the real daemon and asserts a
   pong; interpreter pin layered on top.

**Merge gate on the flip PR:** "twin present + fail-closed verified + degradation audible."

### Increment 3 — "Retire + harden" (deferred · metrics-gated · directional)

- Retire the TS twin once fallback-rate ≈ 0 over a window.
- Then **opportunistically** (only if a 2nd hot consumer or real metrics demand): breaker reducer
  extraction + 3 characterization tests [F5]; full schema contract test [F6]; latency-class daemon
  partition (approvals on a fast lane, never behind heavy synth) [F-HOL].

### Increment 4 — "The brain" (the dev-productivity payoff · directional · brainstorm-gated)

Greenfield agent / planning logic born in Python on the now-proven seam — the ADR's preferred
"new logic born in Python." Branches off the proven seam; does not depend on Increment 3.

---

## 10 · Per-finding disposition

| ID | Finding | Disposition | Inc |
|---|---|---|---|
| `F-TARGET` | First real consumer | Port `parseApprovalIntent` shadow→promote; twin kept | 1→2 |
| `F1` | `recipeApply` is the gate | **Drop** — stays TS | 1 |
| `F2` | `voiceAckGate` is pure-but-hot | **Keep TS** + in-process regression test | 1 |
| `F4` | Daemon topology | **One multiplexed daemon** | 1 |
| `F-API` | Generic surface vs typed | **Typed facade** over generic core | 1 |
| `F6` | Protocol/schema drift | Envelope split + single-source version **now**; contract test **deferred** | 1 / 3 |
| `F9` | Parity oracle | Boundary sweep + shadow-compare; retire twin only when **both** green | 1→3 |
| `F3` | Delete removes the floor | **Floor = retained twin**; verify-at-flip gate; **no separate shim** | 2 |
| `F8` | Degradation invisible | Observability push + **audible** degradation | 2 |
| `F7` | Windows cold-start trips breaker | Discovery ≠ breaker budget + **live Windows CI smoke** | 2 |
| `F5` | Breaker under-tested | Breaker reducer + char tests — **DEFER** (opportunistic) | 3 |
| `F-HOL` | Head-of-line blocking | Latency-class partition — **DEFER** | 3 |

---

## 11 · Journey & roadmap ties

`parseApprovalIntent` is the **highest-trust-leverage function in the codebase** — it powers:

- **Journey 2 — Supervisor / Air-Traffic-Control** (`docs/journeys/2-supervisor/`).
- **Journey 3 — Review & Approve by voice** (`docs/journeys/3-review-approve/`).
- **ROADMAP P0.1 — the voice approval path** (`docs/roadmap/ROADMAP.md` § P0.1), the #1 headline
  feature; "approved == executed" is the load-bearing product property (ROADMAP shared baseline).

This is precisely why it is the right first consumer: it gets the *most* de-risking *because*
getting it wrong is a catastrophe. If Python ever disagrees with TS on an approval intent, the
conservative TS answer wins until shadow proves parity. It's the thing to put a fallback *under*,
not the thing to bet the cutover *on*.

---

## 12 · Caveats / deferred (honest list)

- **Behavior is frozen, not improved.** The golden-master sweep canonizes current TS behavior,
  bugs included. Any *correction* to approval-parsing semantics is a separate decision after parity
  is established — we are porting, not redesigning.
- **Dual-maintenance window (Inc 1→3).** Until the twin retires, the tables live in two languages.
  A change to approval semantics must land both sides + re-run the sweep. The window is bounded
  (retire is metrics-gated and real), but it is real.
- **Full schema contract test deferred to Inc 3.** With one consumer, the boundary sweep + envelope
  freeze suffice; we accept that a *new* op added before Inc 3 leans on review discipline, not a
  live-daemon CI assertion, for payload-shape drift.
- **Breaker reducer + characterization tests deferred to Inc 3 [F5].** The breaker stays as-is
  (timing-coupled, happy-path-tested) through the flip. Acceptable because shadow can't break the
  user and the flip's audible degradation surfaces flapping; revisited only if a 2nd hot consumer or
  real metrics demand it.
- **Latency-class partition deferred [F-HOL].** Until a second *hot* op shares the daemon, a single
  serial loop can't starve approvals (only the cold synth shares it, and only in shadow at Inc 1).
  The partition lands in Inc 3 if/when a real same-daemon contention appears.
- **"Agreed window" for shadow→flip is unset here.** The flip is explicitly gated on a clean shadow
  window whose length/volume the operator sets when Inc 1 lands and real traffic exists — a
  deliberate decision deferred to data, not guessed now.
- **Increment 4 is brainstorm-gated.** The greenfield brain is directional only; it gets its own
  brainstorm before any implementation.
