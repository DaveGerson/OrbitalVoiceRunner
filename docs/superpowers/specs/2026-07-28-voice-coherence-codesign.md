<!--
Provenance: co-created 2026-07-28 by a multi-agent design workflow — Opus architect (v1 draft +
final synthesis) with Sonnet persona role-play by Maya (power user) and Sam (voice-first operator);
Devon (governance) excluded per director. Origin: coherence audit of the context-management ↔
deterministic-gates ↔ status-reporting seam (session follow-on to the 2026-07-28 codex-sol journey
review triage).

Implementation beads (epic wsm-e2e-pinned-fikj):
  fikj.1 vc-B1 P0  honest silence-gate prompt clause        — ships unconditionally
  fikj.2 vc-B3 P0  muted-as-aside earcon + mute telemetry   — gates fikj.5
  fikj.5 vc-B2 P1  flip silenceGate default → true          — HARD-DEPENDS fikj.2
  fikj.3 vc-C  P1  deterministic completion narration       — composes with x6oo idle-accuracy
  fikj.6 vc-A  P1  turn-gate brief injections               — HARD-DEPENDS fikj.3 (same release)
  fikj.4 vc-D  P0  correction ledger + spoken retraction    — consumes a2tp/qj6s/rank-5 via invalidate

Director decisions LOCKED 2026-07-28 (recorded on the epic): B3 hard-gates B2; corrections
spoken-locked (no knob); completionAnnounce default `dispatched`; mute-rate counter in scope for B3.
-->

# Voice-Coherence FINAL Design Doc â€” Turn-gating, Silence-Gate Truth, Deterministic Closure, Retraction

**Author:** Architect (principal) Â· **Status:** FINAL (post persona co-creation) Â· **Date:** 2026-07-28
**Scope:** four coherence fixes at the context-management â†” gates â†” status-reporting seam.
**Co-creators:** Maya (power user, six-pane fleet driver) Â· Sam (voice-first, eyes-off, RSI-motivated hands-free).

---

## BLUF

Ship all four, but the persona pass **moved three defaults and added two mechanisms that were absent from v1** â€” and every one of those additions traces to the same first principle both personas independently stated: **told-more beats silently-missed.** Concretely:

1. **B (silence gate)** now ships default-ON **coupled to a real-time non-verbal "muted-as-aside" earcon** â€” this is a hard gate, not a footnote. Without the earcon, Sam correctly reads a mute as a dead mic; with it, a mute becomes a legible signal both personas accept.
2. **C (completion)** default re-keys from screen-`focused` to **dispatch-intent (`hasExchange`)** â€” the persona conflict resolved decisively in Sam's favor because Maya's own worked example (walk to the kitchen while pane 2 runs) is a *background dispatched* pane, which `focused` silently drops. New tier name: `dispatched`.
3. **D (correction)** drops the 30s staleness clock entirely (supersession is the only skip rule) and **adds multi-correction coalescing** so a return-from-away doesn't machine-gun retractions.
4. **A** is unchanged in mechanism but its rollout is now **hard-coupled to C** â€” A alone converts "occasionally rude interruption" into "silently missing information," which violates the shared principle; C is what guarantees the deferred content still reaches the operator.

Everything still sits on the three existing seams (ack-gate trichotomy, narration sink, InjectGate/latest-wins) plus the new pure modules. Every turn-timing decision stays in-process TS per the LOCKED seam rule.

**Shared plumbing (final):**

| Unit | File | Shape | Î” from v1 |
|---|---|---|---|
| `briefTurnComplete(ackState)` | `src/voiceAckGate.ts` | pure `boolean` | unchanged |
| silence-gate default flip + honest prompt clause | settings + `src/voice/systemPrompt.ts` | data + ternary | unchanged |
| **`muted-aside` earcon emit** | `src/voice/speakGate.ts` â†’ `announcementBus` | side-effect on mute | **NEW (Sam)** |
| `completionNarration(...)` | `src/voice/completionPolicy.ts` (new, pure) | table â†’ `{speak,text?}` | **default re-keyed to `dispatched`** |
| `shouldSpeakCorrection(ackState)` | `src/voiceAckGate.ts` | `"speak"\|"defer"`, never suppress | unchanged |
| `correctionLedger` (+ **coalescing**) | `src/voice/correctionLedger.ts` (new, pure) | record/invalidate/**drain** | **coalescing added; staleness clock removed** |

---

## CHANGE A â€” Turn-gate the brief injections

### Final mechanism
`injectMemoryBrief` (`src/voice/index.ts:1109`) keeps its full InjectGate â†’ shadow â†’ `synthesizeAsync` â†’ latest-wins â†’ delivery-ledger pipeline **byte-for-byte**. The only edit is the final `sess.sendClientContent` (line 1216): `turnComplete` becomes a **turn-aware boolean**.

New pure helper in `voiceAckGate.ts`:
```
briefTurnComplete(s: AckTurnState): boolean   // === (shouldSpeakReadyAck(s) === "speak")
```
- **Turn clear** (`now - lastOperatorSpeechAt â‰¥ 1500ms`, not interrupted) â†’ `turnComplete:true`. Context lands; the model may proactively engage (the greet/orient on `session_start`/`pane_switch`).
- **Mid-utterance OR barge-in** â†’ `turnComplete:false`. The brief **still lands immediately** as passive context (identical to `pushSignal` at line 2367) â€” freshness, latest-wins, and debounce fully preserved â€” but it never completes a turn, so it can never invite a response over the director.

A brief is never spoken (`CONTEXT â€¦ do not read aloud`), so a boolean, not the trichotomy, is correct: both non-clear cases collapse to "commit the context, don't invite a turn." Barge-in does **not** drop the brief (unlike a phase-2 ready-ack) â€” dropping would starve the model.

### Final defaults & knobs
None. Mechanical correctness fix, not a preference. `holdMs` override rides `ackState` for tests only.

### What changed from v1 (persona input)
- **Sam:** "I will not accept A shipping *without* C." A converts a background idle from "occasionally-rude interruption" into "inert context the model may never voice" â€” which trades a rudeness bug for a *silently-missed* bug, the one thing Sam ranks worst. **Resolution:** A and C ship in the **same release, coupled in the rollout plan (not a footnote)**; C is the mechanism that guarantees deferred brief content eventually reaches the operator (via deterministic completion narration and catch-me-up). Codified in the bead slicing below as an explicit dependency, not "land together."
- **Maya:** worried "fold into the next natural turn" could mean *manufacturing* a "by the way, pane 5 finished" bolted onto an unrelated later moment. **Resolution:** a turn-gated brief that never hit a natural pause is **never proactively voiced by the brief path itself** â€” it stays context-only until (a) the operator asks (`catch_me_up`/`pane_switch`), or (b) Change C independently elects a deterministic completion narration for that pane. No synthetic interjection moment is ever invented. This is a documented invariant in the acceptance criteria, not just intent.

### Rejected persona feedback
- (none rejected â€” both accepted the mechanism; the only asks were coupling/invariant clarifications, both adopted.)

### Acceptance criteria
1. `command_outcome` injection with `lastOperatorSpeechAt` within 1500ms â†’ send carries `turnComplete:false`.
2. Clear turn â†’ `turnComplete:true`.
3. `interrupted` latch set â†’ `turnComplete:false` (barge-in does not drop the brief).
4. Gate-skip / stale-brief / empty-brief paths return before the send exactly as today.
5. **Invariant:** a turn-gated (`false`) brief produces **no** proactive spoken turn from the brief path; its content surfaces only via operator request or a Change-C completion election.

### Test approach (TDD, CCâ‰¤10)
Unit: table over `AckTurnState` asserting `briefTurnComplete` (pure, CC 2). Injection test: fake `sess` capturing `sendClientContent`; assert flag flips with `lastOperatorSpeechAt`/`interrupted`, and skip/stale/empty still short-circuit. Behavioral: assert no spoken turn emitted from a `false` brief.

### Size: **S**

---

## CHANGE B â€” Close the silence-gate truth gap

### Final mechanism (three moves, ship together)

**Move 1 â€” Honest prompt in BOTH states (unconditional).** `buildSystemInstruction` (`systemPrompt.ts:94`) injects a computed clause from the live `voiceAi.silenceGate`:
- gate **ON** â†’ "A runtime gate also enforces this silence, so contribute when you have something net-new and useful."
- gate **OFF** â†’ "Your own judgment is the only gate here â€” when in doubt, stay silent."

Threaded through `BuildSystemInstructionOpts` (same struct carrying `activeProjectId`/`workspaces`) via `{{silenceGateClause}}`. The prompt can never again assert a gate that isn't running.

**Move 2 â€” Flip default `silenceGate` to `true`.** The gate mutes **spoken audio only** (transcript still renders; tool calls and context untouched) and is **fail-open by construction**: mutes only on high-confidence thinking-aloud (leading musing marker, â‰¥3 tokens, confidence â‰¥0.7); addressed/imperative/emergency-brake/ambiguous all SPEAK.

**Move 3 â€” Real-time "muted-as-aside" earcon (NEW).** Every mute event emits a **cheap, distinct, non-verbal earcon** through `announcementBus` (reuse the completion-earcon channel), acoustically distinct from the completion chime. This converts an ambiguous silence into a legible "heard you, filed it as an aside" tick. The mute still writes its auditable `reason` to the interaction log as today.

### Final defaults & knobs
- `voiceAi.silenceGate` default **true**.
- `voiceAi.muteEarcon` default **true** (bound to Move 3; can be silenced independently for operators who find it noisy, but ON by default).
- **Mute-rate telemetry surfaced, not just logged (Maya):** wire the existing per-mute `reason` log to a glanceable counter the operator can query ("how much have you muted yourself today") â€” a `list_panes`-style status field, defined in the bead below.

### What changed from v1 (persona input)
- **Sam:** blocked the default flip *without* real-time mute feedback â€” "a misfire reads as a dead mic, indistinguishable from a crash." **Resolution:** Move 3 (mute earcon) is now a **hard ship-gate on Move 2**. Default flips to `true` **only** when the earcon lands in the same release; otherwise B degrades to Move-1-only (honest prompt, default stays `false`). This is the reconciliation, not a compromise â€” it satisfies Sam's told-more principle while delivering Maya's flip.
- **Maya:** wanted mute-rate telemetry "wired to something I can glance at, not logged into a void." **Resolution:** telemetry surfaced as an operator-queryable counter (added to defaults above).
- Both: **addressed/imperative always speaks** is held as an inviolable line â€” the dealbreaker for both. Encoded as a dedicated regression test, not just a default.

### Rejected persona feedback
- **B-OFF as the *final* resting state (Sam's conditional fallback):** rejected as the endpoint â€” B-OFF is only the *interim* state if Move 3 slips; the target is default-ON. One-line why: leaving the ~67%-failure interruption defect unfixed abandons the whole thesis, and Move 3 is small enough that slipping it is a scheduling failure, not a design one.

### Acceptance criteria
1. Rendered prompt: gate-enabled contains "runtime gate also enforces" clause; gate-disabled contains judgment-only clause **and not** the false claim.
2. Default settings â†’ `silenceGate === true` **iff** the mute earcon is wired; otherwise `false` (Move-1-only).
3. Every mute event emits the `muteEarcon` (when enabled) and writes an audit `reason`.
4. **Regression (dealbreaker):** an addressed/imperative/emergency-brake/ambiguous transcript is **never** muted â€” dedicated test, both personas' hard line.
5. Mute-rate counter is queryable via status.

### Test approach (TDD, CCâ‰¤10)
`systemPrompt` content-invariant test gains two clause cases. Settings-default test asserts the earcon-coupled default logic. `speakGate` suite gains the never-mute-addressed regression + an assert that a mute call fires the earcon side-effect (fake bus). Builder adds one ternary (CC +1).

### Size: **M** (earcon + telemetry surface push it past S)

---

## CHANGE C â€” Deterministic completion closure

### Final mechanism
Idle edge today = earcon + toast + passive `turnComplete:false` signal + `command_outcome` brief â€” none a **guaranteed spoken turn**. Add a deterministic completion **narration** through the narration sink, turn-gated by the **same ready-ack trichotomy** the `created`/`closed` signals use (`shouldSpeakReadyAck` + `armReadyDrain`, lines 2377-2414).

New pure module `src/voice/completionPolicy.ts`:
```
completionNarration(sig, hasExchange, isEngaged, policy): { speak: boolean; text?: string }
```

**Final decision table â€” re-keyed off dispatch-intent (`hasExchange`), not screen focus:**

| Condition | Outcome |
|---|---|
| `policy = off` | never speak (earcon-only) |
| exception kind (error/needs_input/agent_failed/interrupted), **any pane**, `policy â‰  off` | **speak** (named-pane; never miss eyes-off) |
| success on a pane with `hasExchange` (I dispatched/tracked it), `policy â‰¥ dispatched` | **speak** terse named close â€” **focused OR background** |
| success on a pane **without** `hasExchange` (ambient, non-dispatched activity) | speak only if `policy = all`; else suppress |
| idle edge with **no tracked exchange** | **never speak "done"** â€” passive signal only (false-done guard) |

At the spoken `paneSignalBus` subscription, when `.speak`, run the line through `shouldSpeakReadyAck(ackState())`: **speak** when clear, **defer** into `armReadyDrain` when mid-utterance, **suppress** on barge-in. When a deterministic completion is elected for an edge, **suppress the duplicate passive idle signal** for that same edge; the `command_outcome` brief still fires as context (now `turnComplete:false` per Change A).

**False-done guard (composes with heuristic idle, does not fix it):** `speak` is gated on `hasExchange`, corroborated via `activeExchangeForPane` (line 2343). A bare idle with no dispatched command never becomes a spoken "done." Idle accuracy remains `x6oo`/headless-VT's job; this change refuses to *amplify* an uncorroborated idle. Change D is the backstop for a spoken "done" later contradicted.

### Final defaults & knobs
`voiceAi.completionAnnounce`: **`off` | `exceptions` | `dispatched` | `all`.** **Default `dispatched`.**
- `dispatched` (default): speak on completion (success or exception) for **any pane I dispatched/tracked** (`hasExchange`), focused or background, + all exceptions fleet-wide by name.
- `exceptions`: only errors/needs-input speak.
- `all`: every foreground-project completion speaks by name (loudest).
- `off`: today's earcon-only.

### What changed from v1 (persona input)
- **Sam (dealbreaker):** v1's `focused` default "silently reintroduces the exact gap this change exists to close, for the highest-value case (walk-away dispatch)." Sam dispatches *specifically to walk away* â€” the pane is never on-screen when it matters. **Resolution:** default re-keyed from screen-`focused` to **`dispatched` (`hasExchange`-scoped)**; the tier is renamed accordingly. This is the single biggest v1â†’final change.
- **Maya vs. Sam â€” genuine conflict, reconciled not silently picked:** Maya asked for `focused` but *defined* it as **"the pane I was last actively engaged with, sticky until I explicitly switch â€” not whatever's on-screen while I've walked away."** Maya's own worked example (kitchen / pane 2 integration suite) is a background pane. So Maya's *intent* and Sam's *ask are the same signal* â€” "the pane I meant to be watching" â€” and both are captured by `hasExchange`/dispatch-intent, which is strictly broader and screen-independent. `dispatched` satisfies both; there is no residual conflict once "focused" is read as Maya meant it rather than as literal viewport. **The opinionated default is `dispatched`.** Maya's flood concern (six panes shouting) is handled because `dispatched` still requires an exchange per pane and successes on *non-dispatched* ambient panes stay silent â€” you only hear the panes you actually launched work on.
- **Both:** exception-kind speaks **fleet-wide, by name, every time** (unless `off`) â€” held as inviolable.

### Rejected persona feedback
- **Maya's literal "sticky-to-last-engaged focus" semantic as the keying signal:** rejected in favor of `hasExchange`. One-line why: "last-engaged pane" is a strict subset of "panes I dispatched work on," and using the broader dispatch signal closes Sam's walk-away gap *and* Maya's kitchen example with one rule â€” a sticky-focus pointer would still drop the second background pane Maya launched.

### Acceptance criteria
1. Background success + `hasExchange` + `policy=dispatched` â†’ exactly one deterministic spoken named turn, turn-gated (deferred if mid-sentence, **not** dropped). *(This is the case v1's `focused` wrongly dropped.)*
2. Focused success + `hasExchange` + `policy=dispatched` â†’ speak (same rule, focus-independent).
3. `policy=off` â†’ no spoken turn; earcon unchanged.
4. Success on a pane with **no** exchange â†’ silent unless `policy=all`.
5. Exception kind on **any** pane â†’ spoken by name regardless of focus (unless `off`).
6. Idle with no tracked exchange â†’ passive signal only, no spoken "done."
7. `announcementBus`/toast/brief unchanged; duplicate passive idle signal suppressed exactly when the deterministic line is elected.

### Test approach (TDD, CCâ‰¤10)
Unit: table over `hasExchange` Ã— kind Ã— policy against `completionNarration` (pure, policy map extracted, CCâ‰¤10). Behavioral: fake session + fake exchange service; assert exactly-once push, duplicate-signal suppression, defer-under-mid-utterance via stamped `ackState`, and the **background-dispatched-success speaks** case explicitly (the persona-driven fix).

### Size: **M**

---

## CHANGE D â€” Retraction / correction protocol

### Final mechanism
When a previously-**narrated** deterministic claim is invalidated, the voice thread deterministically **speaks a correction** through the narration sink â€” never leaves it as passive context.

New pure module `src/voice/correctionLedger.ts` (turn-adjacent â†’ TS per seam rule):
```
record({ claimId, paneId, kind: "dispatch"|"restart"|"completion"|"readiness", assertedText, assertedAt, session })
invalidate(claimId|paneId, groundTruth): CorrectionDecision   // â†’ correction line | none
drainPending(ackState): CorrectionDecision                    // NEW: coalesced flush on turn-clear
```
`invalidate` returns **none** if the claim was never spoken (suppressed ack), already superseded, or already corrected. Otherwise a terse line: `"Correction: pane 2's restart actually failed â€” it's not up."` Emission goes through the narration sink (`turnComplete:true`).

**Turn-gating â€” a correction is truth, not a nicety.** New pure helper in `voiceAckGate.ts`:
```
shouldSpeakCorrection(s): "speak" | "defer"   // NEVER suppress â€” defers on barge-in too
```
A ready-ack is nice-to-have and rightly dropped on barge-in; a correction retracts a false assertion the operator may be **acting on** â€” burying it recreates the exact defect.

**Multi-correction coalescing (NEW).** When â‰¥2 corrections are pending on turn-clear (the operator was away/mid-turn while several claims flipped), `drainPending` **collapses them into one spoken turn**, ordered severity-first (exceptions before successes), most-recent-within-severity next: *"Two corrections: pane 2's restart actually failed, and pane 4's dispatch never landed."* Never a machine-gun of separate narration events; never silently held.

**Storm control (final):** at most one correction per `claimId`; a correction supersedes its origin claim and is never itself re-corrected. **No time-based downgrade** â€” the only skip is supersession (the operator already learned ground truth via another deterministic channel, e.g. a Change-C completion narration reflecting the real outcome).

### Where `invalidate` is called (composes with the truth-plane beads â€” does not duplicate)
D is the **consumer** of ground-truth flips; it does no liveness/policy revalidation itself:
- **`a2tp` (commit-time revalidation):** on downgrade of a narrated approve (dead PTY / policy change), calls `invalidate` for that dispatch claim. Ships-now ordering fix in `renderApproved` (`gating:1112`): narrate optimistic **"Dispatching now"** only **after** a successful dispatch; on failure narrate `renderDeadPane` â€” turning many false claims into a correct *first* claim. D catches the residue that fails after a legitimately-successful-looking dispatch.
- **`qj6s` (adapter launch plans):** a spawn that ACKed then failed its launch plan invalidates the spawn/readiness claim.
- **Rank-5 restart-ACKs-before-readiness + future awaited-lifecycle:** a restart/readiness ACKed then failing â†’ `invalidate`. Until awaited-lifecycle lands, D wires `invalidate` at edges we already have: a resolution that flips post-narration, and idle/error/exited signals contradicting a recent Change-C completion claim (closing C's false-done residue).

D ships the **ledger + emission + `shouldSpeakCorrection` gate + coalescing + record/invalidate wiring** now (at `renderApproved`, the restart-ack site, and Change-C completion claims), delivering value immediately and leaving the `invalidate` seam ready for `a2tp`/`qj6s`/awaited-lifecycle.

### Final defaults & knobs
Corrections **always on**, independent of `completionAnnounce` â€” a safety/truth signal. Optional `voiceAi.corrections = spoken (default) | passive` exposed only if the director insists; **recommend spoken-locked**.

### What changed from v1 (persona input)
- **Sam (dealbreaker):** kill the "~30s downgrade to passive" clause â€” "a claim I'm still operating under doesn't get less wrong because it's been a minute." **Resolution:** staleness clock **removed entirely**. The only skip is supersession, which v1 already had ("never re-corrected" / "already superseded"). That is sufficient and architecture-gated rather than clock-gated.
- **Maya:** add coalescing for the return-from-away stack â€” "don't read me five separate interruptions in a row" but also "don't let storm control mean only one ever fires." **Resolution:** `drainPending` coalesces â‰¥2 pending corrections into one severity-ordered spoken turn on turn-clear.
- **Both:** never-suppress-on-barge-in and always-on-independent-of-verbosity confirmed and locked.

### Rejected persona feedback
- (none rejected â€” both dealbreakers and asks adopted; they were mutually compatible.)

### Acceptance criteria
1. Dispatch claim narrated â†’ invalidated (dead PTY / `a2tp` reject) â†’ exactly one deterministic correction naming pane + reality.
2. Restart ack â†’ readiness-failure â†’ correction.
3. Correction mid-utterance â†’ deferred; on barge-in â†’ **deferred, never suppressed**.
4. **â‰¥2 pending corrections on turn-clear â†’ one coalesced, severity-ordered spoken turn** (not N narrations, not silence).
5. No correction if origin claim never spoken or already superseded.
6. â‰¤1 correction per claim; a correction is never re-corrected; **no time-based downgrade path exists**.
7. Corrections fire regardless of `completionAnnounce`.

### Test approach (TDD, CCâ‰¤10)
Unit: `shouldSpeakCorrection` (speak/defer only). Ledger: recordâ†’invalidateâ†’decision; dedup; never-spokenâ†’none; supersessionâ†’none; **`drainPending` coalescing order** (severity then recency). Behavioral: fake session; narrate a dispatch claim, `invalidate`, assert exactly-one correction (`turnComplete:true`) with correct text; queue two under mid-utterance `ackState`, clear turn, assert single coalesced push.

### Size: **M** (coalescing + multi-site wiring)

---

## Cross-cutting notes

- **One seam family, four uses.** A (turn boolean), C (ready trichotomy + narration), D (never-suppress variant + narration + coalescing) sit on ack-gate + narration-sink; B sits on speak-gate + prompt-builder + `announcementBus` (mute earcon). Net new surface: two pure modules (`correctionLedger`, `completionPolicy`), three pure helpers, one settings-default-flip, one prompt clause, one earcon emit.
- **Turn-timing stays TS.** Every `now`/barge-in decision (A, C, D) is synchronous in-process â€” LOCKED seam rule holds; nothing crosses to Python.
- **The through-line both personas enforced:** *told-more beats silently-missed.* It moved B (earcon), C (dispatch-scope), D (no staleness clock, add coalescing), and A (hard C-coupling). Any future tuning must not reintroduce a silent-drop path.
- **A+C are a single shippable unit** â€” A without C trades rudeness for silent-miss. Sliced with an explicit dependency below.

---

## (1) Proposed bead slicing

| Title | Priority | Scope (one line) | Compose-with |
|---|---|---|---|
| **vc-A: Turn-gate brief injections** | P1 | `briefTurnComplete` helper + flip `injectMemoryBrief` send to turn-aware `turnComplete`; brief-never-proactively-voiced invariant. | **Hard-depends on vc-C** (ship same release). |
| **vc-B1: Honest silence-gate prompt clause** | P0 | Conditional `{{silenceGateClause}}` in `buildSystemInstruction`; remove the false "runtime gate" claim in both states. **Ships unconditionally, immediately.** | Standalone. |
| **vc-B3: Muted-as-aside earcon + mute telemetry surface** | P0 | Emit distinct non-verbal earcon on every mute via `announcementBus`; surface queryable mute-rate counter. | Gate for vc-B2. |
| **vc-B2: Flip `silenceGate` default â†’ true** | P1 | Default-ON **iff vc-B3 landed**; never-mute-addressed regression test. | **Hard-depends on vc-B3.** |
| **vc-C: Deterministic completion narration (`dispatched`-scoped)** | P1 | `completionPolicy` module; `dispatched` default (`hasExchange`-keyed, focus-independent); false-done guard; ready-ack turn-gating; suppress duplicate passive signal. | Composes-with `x6oo` (idle accuracy â€” do not duplicate); feeds vc-D. |
| **vc-D: Correction ledger + spoken retraction + coalescing** | P0 | `correctionLedger` + `shouldSpeakCorrection` (never-suppress) + `drainPending` coalescing; wire `invalidate` at `renderApproved`, restart-ack, and vc-C completion claims; no staleness clock. | **Consumes** `a2tp` (commit-revalidation), `qj6s` (launch plans), rank-5 restart-ACK-before-readiness, future awaited-lifecycle â€” via `invalidate`, does not re-implement. Closes vc-C false-done residue. |

**Ordering:** vc-B1 (free honesty win) and vc-B3 first â†’ vc-B2 unlocks. vc-A + vc-C land together (dependency). vc-D lands with or immediately after vc-C (shares the completion-claim recording site). Priorities mirror the personas' ranking: B and D are the trust-deciders (P0-heavy), A/C the enablers.

---

## (2) Decisions for the director (not defaulted)

1. **B rollout gate â€” accept B3-as-hard-blocker on B2?** The design makes the default-ON flip contingent on the mute earcon shipping in the same release. If the director wants default-ON *sooner* than the earcon can land, that is a conscious "accept Sam's dead-mic ambiguity risk for N days" call â€” it should not be defaulted silently. **Recommended: hold the coupling.**
2. **Corrections knob exposure â€” `voiceAi.corrections` spoken vs. passive: expose at all?** Recommend **spoken-locked, no knob** (truth-plane stakes; both personas want it inviolable). Exposing a `passive` mode reintroduces the exact "model may never voice it" defect as an operator foot-gun. Director call on whether any operator should be *able* to silence corrections.
3. **`completionAnnounce` default = `dispatched` (recommended) vs. `exceptions` (quietest-useful).** Both personas want `dispatched`; the only reason to consider `exceptions` is if fleet-scale success narration proves noisy in the field. Recommend shipping `dispatched` and letting telemetry (not a pre-emptive downgrade) drive any change.
4. **Mute-rate + completion-narration telemetry â€” is the queryable-counter surface in scope for v1, or a fast-follow?** Maya asked for it "especially in the first couple weeks after the flip," which argues for in-scope; if it slips, B2 still ships but loses its early-warning instrument.
