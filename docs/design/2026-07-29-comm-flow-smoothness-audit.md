<!--
Provenance: read-only structural audit, 2026-07-29, commissioned by the director after operator
reports of "weird jump-overs" — the voice conversation abruptly switching topic when notifications
and system effects land mid-flow. Scope: every mechanism that can PUSH content into the live Gemini
conversation, classified against the open voice-coherence beads (epic wsm-e2e-pinned-fikj, spec
docs/superpowers/specs/2026-07-28-voice-coherence-codesign.md) and the two tactical fixes in flight
(fikj.8 answer-first + BACKGROUND framing, fikj.7 outcome-keyed earcon). File:line citations are
against main @ e595db2. Companion through-line (LOCKED): "told-more beats silently-missed" — no
recommendation below may introduce a silent-drop path.
-->

# Communication-Flow Smoothness Audit — What Structurally Causes Topic Jump-Overs

**Author:** Architect (read-only audit) · **Status:** FINAL · **Date:** 2026-07-29
**Question:** beyond fikj.8 (answer-first) and the open vc beads, is anything *structural* causing
abrupt topic switches, and is a larger communication-smoothness program warranted?

---

## BLUF

The jump-over feeling has **four independent producer families writing into one Gemini
conversation, each with its own (or no) turn policy** — and the open beads fix the two loudest
producers while leaving the third **completely un-gated** and adding two more producers with two
more private queues. Concretely:

1. The two causes the in-flight work covers are real and correctly targeted: **turn-completing
   memory briefs** (vc-A / fikj.6) and **unframed passive injections that hijack the next answer**
   (fikj.8). Land them; they are the highest-frequency offenders.
2. **NEW GAP (high):** the `pushApprovalNarration` family — sweep last-calls, autonomy-window
   warnings/expiry, TTL-expiry notices — sends **forced spoken turns (`turnComplete:true`,
   "SYSTEM EVENT (say this to the operator, then stop)") from timers, with zero turn-gating**.
   A last-call landing mid-question is a *guaranteed* topic hijack by construction. No open bead
   touches this.
3. **NEW GAP (medium):** the reconnect path replays a "Welcome back" digest + away digest + a
   turn-completing brief on **every** Gemini socket re-establishment — including transient blips
   the operator never noticed — a three-shot burst mid-flow.
4. **Verdict: a small program is warranted** — not a rewrite, but a **single turn-arbiter owning
   all model-bound sends with priority classes**, grown out of the machinery the beads are already
   building (ack-gate trichotomy, `armReadyDrain` queue, vc-D's `drainPending` coalescer). Without
   it, cross-producer ordering stays a wall-clock accident and every future producer re-invents a
   private gate.

---

## 1. The send-surface inventory (every path into the model's conversation)

There are exactly **four** `sendClientContent` call sites in `src/voice/index.ts` (grep-verified;
`src/announcementBus.ts:6` confirms the client notification stack never reaches the model). Each
is one producer family:

| # | Producer family | Site | `turnComplete` | Turn-gated? | Trigger class |
|---|---|---|---|---|---|
| A | `pushApprovalNarration` (+ `pushAck`) | `src/voice/index.ts:412`, `:489` | **true** (forced spoken turn) | **NO** (only the `create_pane` ack at `:2100-2110` checks `shouldSpeakOpeningAck`) | operator-initiated *and* **timer-driven** (see §2.1) |
| B | Memory-brief injection (`injectMemoryBrief`) | `src/voice/index.ts:1219-1222` | **true** today | InjectGate/latest-wins gate *content*, never *timing* | session_start, pane/project switch, catch-up, **every `idle` edge** (`:2449-2470`) |
| C | Pane-signal push (`pushSignal`) | `src/voice/index.ts:2389-2392` | false (passive) | `created`/`closed` only, via `shouldSpeakReadyAck` + `armReadyDrain` (`:2421-2438`, `:2401-2419`); `idle`/`error`/`prompt`/`exited` push immediately | PTY output classifier + state machine |
| D | Tool responses (`sendToolResponse`) | `runToolCall`, `src/voice/index.ts:2112+` | n/a | n/a — the model answers the operator's own request | operator-initiated (natural) |

Family D is conversationally natural. Families A, B, C are where every jump-over lives.

---

## 2. Structural jump-over mechanisms, each classified

Classification key: **(a)** covered by an open vc bead · **(b)** resolved by fikj.8 ·
**(c)** NEW GAP.

### 2.1 Timer-driven forced spoken turns — the un-gated narration family — **(c) NEW GAP, HIGH**

`pushApprovalNarration` (`src/voice/index.ts:410-421`) wraps its text in
`SYSTEM EVENT (say this to the operator, then stop)` and sends `turnComplete:true` — the model
**must** stop what it is conversationally doing and voice the line. That is exactly right for its
operator-initiated callers (approve/reject echoes at `src/gating/index.ts:1112-1130`, deferral
acks `:1259/:1274`, stop-all `:861/:872/:927`, spokenConfirm `src/voice/index.ts:977`, macro
read-back `:1848`, hands-free approval routing `:1798/:1811` — the operator just spoke, so the
turn is theirs to fill). It is structurally wrong for the **timer-driven** callers:

| Caller | Site | Trigger |
|---|---|---|
| Approval sweep last-call ("approve now or I'll drop it") | `src/gating/index.ts:1330` | TTL interval sweep |
| Pending-action sweep last-call | `src/gating/index.ts:1363` | TTL interval sweep |
| Autonomy-window T-minus warning | `src/gating/index.ts:768` | sweep tick, ~2 min out |
| Autonomy-window expiry ("back to asking first") | `src/gating/index.ts:782` | sweep tick |
| Approval TTL-expiry notice ("I cancelled it") | `src/gating/index.ts:1130` | sweep → `applyResolution("expire")` |

None consult `ackState()` / `voiceAckGate` — the trichotomy exists one seam away
(`src/voiceAckGate.ts`) and is simply not wired here, because gating receives
`pushApprovalNarration` as an injected slot (`src/gating/index.ts:110`) with no turn-state access.
A last-call landing between the operator's question and the model's answer is the purest form of
the reported "weird jump-over": mid-flow, unrelated, and *mandatory* ("say this, then stop").

These lines are deadline-driven truth (the told-more principle forbids demoting them to passive
context), so the fix shape is vc-D's, not vc-A's: a **defer-briefly-never-drop** class
(`shouldSpeakCorrection` semantics) plus coalescing — hold ≤ one `OPERATOR_HOLD_MS` drain cycle at
a time until turn-clear, never suppress. **No open bead covers this.** (vc-D touches
`renderApproved` ordering only; vc-C gates completions only.)

### 2.2 Turn-completing memory briefs — **(a) covered: fikj.6 (vc-A), reinforced by fikj.8**

`injectMemoryBrief`'s send (`src/voice/index.ts:1219-1222`) is `turnComplete:true` on every
trigger — session_start, pane switch, catch-up, and, via the `inject`-class bus subscription
(`:2449-2470`), **every idle edge of every foreground-project pane**. A background command
finishing mid-conversation therefore *completes a turn*, inviting the model to speak about the
brief's content over whatever was being discussed. This is the second prime suspect and it is
precisely vc-A's target (`briefTurnComplete` boolean; mid-utterance/barge-in → `false`, brief
still lands as context). fikj.8's Leg-B BACKGROUND preamble on the same send hardens the
passive case. Correctly scoped; nothing to add — **but note the vc-A/vc-C same-release coupling
is load-bearing** (a `false` brief the model never voices is a silent-miss unless vc-C's
deterministic completion narration exists to carry the news).

### 2.3 Unframed passive injections steering the next answer — **(b) resolved by fikj.8 (in flight)**

`pushSignal` (`src/voice/index.ts:2384-2396`) sends passive context (`turnComplete:false`), which
cannot interrupt — but it *steers the next turn*. The fallback text already self-frames
(`formatPaneSignal`, `src/paneSignals.ts:110-114`: "context only — do not speak unless the
operator asks"), while the **enriched narrate branch carries no framing at all**
(`buildExchangeAwareSignalText`, `src/voice/index.ts:232-254` → bare
"Pane 'X' needs your input: …"). The model, mid-answer, sees an authoritative unframed user-role
line and pivots to it — the answer-first violation the director experiences. fikj.8 (Leg A prompt
rule + Leg B BACKGROUND preamble on exactly this composition site) is the right fix; its
acceptance criterion 3 ("framing applies to `turnComplete:false` sends only") closes the asymmetry.

### 2.4 The reconnect burst — **(c) NEW GAP, MEDIUM**

Every re-established Gemini session runs, back-to-back: `reannounceSurvivors` — a forced
"Welcome back — N actions still waiting…" turn (`src/gating/index.ts:937-971`), then the away
digest (`:973-985`), then a turn-completing `reconnect` brief
(`src/voice/index.ts:2320-2329`). After genuine absence this is excellent. But the PLM4
auto-reconnect scheduler (`src/voice/index.ts:2518-2541`) re-enters the same closure after a
**transient socket blip the operator never perceived** — mid-conversation, the operator hears
"Welcome back" plus a re-read of approvals they were just discussing, and the model may greet
afresh off the brief. Structural cause: the pipeline has no notion of *away duration* — a 4-second
blip and a 4-hour absence replay identically. Cheap fix shape: threshold the spoken digest on
`now - lastDetachAt` (below ~30s: re-attach silently, chips repopulate, no narration; the
`reconnect` brief rides vc-A's turn-aware boolean once fikj.6 lands). No open bead covers this.

### 2.5 Producer proliferation with no arbiter — **(c) NEW GAP (architectural), HIGH**

The cross-cutting finding, and the reason patches alone will not fully smooth the flow: turn
policy is **distributed and heterogeneous**. Today: family A has no gate; family B gates content
but not timing; family C has a trichotomy for two of its six kinds and a private queue
(`state.deferredReady` + `armReadyDrain`). The co-design adds vc-C (ready trichotomy + suppression
of the duplicate passive signal) and vc-D (never-suppress gate + its own `drainPending` queue +
coalescing). That will make **three private hold-queues** (`deferredReady`, vc-D's pending
corrections, and §2.1's needed last-call deferral) with **no cross-queue ordering**: on a single
turn-clear instant, a deferred ready-ack, a coalesced correction, a completion narration, and a
sweep last-call can all fire in wall-clock arrival order — four consecutive topic switches where
one prioritized, coalesced turn should exist. Every future producer (plan events, watch rules,
multi-project promotion) re-decides this from scratch.

### 2.6 Minor / adjacent observations (low)

- **"speak" that doesn't speak:** the ready-ack trichotomy's `speak` arm resolves to
  `pushSignal` — a *passive* `turnComplete:false` send whose own text says "do not speak unless
  the operator asks" (`src/voice/index.ts:2411`, `src/paneSignals.ts:113`). The gate arbitrates
  the timing of a context injection, not actual speech; a cleared "ready" may never be voiced
  (mild told-more tension), and when vc-C reuses the same trichotomy for a *real* narration,
  `speak` will mean two different strengths on the same seam. Worth one clarifying sentence in
  vc-C's implementation notes; no new bead.
- **Earcon overlay:** client earcons (`src/utils/earcon.ts:39-64`) play over model TTS with no
  ducking. Acoustic overlap, not a topic switch — and the parallel non-verbal channel is exactly
  what makes fikj.2's muted-as-aside legible. By design; no action.
- **Silence-gate discontinuity:** a mute that reads as a dead mic is a *different* unnaturalness
  (absence, not interruption) and is fully covered by fikj.1/fikj.2/fikj.5.
- **switch_context orphaned-focus confusion** is a coherence (not interruption) defect; covered by
  fikj.9.

---

## 3. Coverage matrix

| Mechanism | Severity | Coverage |
|---|---|---|
| Timer-driven forced narrations (sweep last-call, autonomy warn/expire, TTL notice) | high | **NEW GAP** |
| Turn-completing memory briefs (incl. every idle edge) | high | fikj.6 (vc-A) + fikj.8 Leg B |
| Unframed passive injections steering the next answer | high | fikj.8 (in flight) |
| No cross-producer arbiter; private queues multiply (3 after vc-C/vc-D) | high (architectural) | **NEW GAP** — beads converge on the seam but nothing owns it |
| Reconnect "Welcome back" burst on transient blips | medium | **NEW GAP** |
| Ready-ack "speak" is passive; semantic drift vs vc-C | low | partially fikj.3; note in impl |
| Earcon-over-TTS overlap | low | by design (non-verbal aside channel) |
| Silence-gate dead-mic ambiguity | (different defect) | fikj.1/.2/.5 |
| switch_context pane honesty | (different defect) | fikj.9 |

---

## 4. Architectural verdict

**The open beads + fikj.8 make the flow markedly smoother but not smooth.** They eliminate the two
highest-frequency offenders and, importantly, they build the right primitives (one ack-gate seam,
one narration sink, a coalescing drain). They do not touch the gating-layer timer narrations —
which are *forced* turns and therefore the worst per-incident offenders — nor the reconnect burst,
and they deepen the private-queue problem they sit next to.

**A larger program is warranted, and it should be small and shaped as consolidation, not
invention** — call it the **turn-arbiter** (conversation scheduler):

- **One module owns every model-bound send.** Producers stop calling `sendClientContent` /
  `pushApprovalNarration` directly and submit `{text, class, paneId?, coalesceKey?}` to the
  arbiter. Pure decision core in TS (in-process, synchronous against `ackState()` — the LOCKED
  seam rule for turn timing already forbids a Python round-trip here).
- **Priority classes, descending:** (0) corrections/emergency — defer-never-drop (vc-D's gate,
  verbatim); (1) operator-response — immediate, exempt from gating (family D + the
  operator-initiated half of family A); (2) deadline narrations — §2.1's last-calls/expiries,
  defer-briefly-never-drop, coalesced; (3) deterministic completions — vc-C's policy table;
  (4) acks — today's speak/defer/suppress trichotomy; (5) passive context — vc-A's turn-aware
  boolean + fikj.8's BACKGROUND framing.
- **One drain, one coalescer:** fold `armReadyDrain`'s queue and vc-D's `drainPending` into a
  single turn-clear flush that emits **at most one spoken turn per drain**, severity-ordered
  (vc-D's coalescing rule generalized: "Two things: pane 2's restart failed, and your approval on
  pane 4 expires in a minute").
- **Sequencing:** land fikj.8 and vc-B1 now (independent); land vc-C + vc-A + vc-D as sliced —
  their pure modules are arbiter components, not throwaway. Then the arbiter is an **M-size
  refactor** that re-homes the three queues and re-routes §2.1's five gating call sites (the
  injected-slot indirection at `src/gating/index.ts:110` makes that a one-signature change), plus
  the §2.4 away-duration threshold. Do not build the arbiter first — it would stall the P0 truth
  fixes behind plumbing.

The through-line holds throughout: every mechanism above defers or coalesces; nothing is silently
dropped.
