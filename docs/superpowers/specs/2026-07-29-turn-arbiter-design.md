# Turn-Arbiter (Conversation Scheduler) — Program Design

**Date:** 2026-07-29 · **Status:** APPROVED (director, brainstorm session 2026-07-29)
**Program bead:** `wsm-e2e-pinned-fikj.10` · folds in `fikj.6` (vc-A), `fikj.3` (vc-C), `fikj.4` (vc-D), `yg1w` (reconnect burst)
**Foundation:** `docs/design/2026-07-29-comm-flow-smoothness-audit.md` (structural audit) and
`docs/superpowers/specs/2026-07-28-voice-coherence-codesign.md` (vc-A/C/D component specs, branch
`docs/voice-coherence-codesign`, PR #151). Stacked on PR #152 (`feat/voice-coherence-followups`).
**Interactive companion:** claude.ai artifact "Turn-Arbiter — Design & Flow Model" (43cd2dda).

---

## 1. Problem

Four independent producer families write into one Gemini voice conversation with heterogeneous (or
absent) turn policies. Operators experience "jump-overs": a timer-driven last-call hijacks the model
mid-answer; a reconnect blip replays "Welcome back" mid-flow; multiple deferred items fire in
wall-clock order as consecutive topic switches. The audit's verdict: patches cannot fully fix this —
one module must own every model-bound send.

## 2. Locked decisions (director, 2026-07-29)

| # | Decision | Substance |
|---|---|---|
| D1 | The deadline waits for you | While the operator holds the floor, a class-2 item defers AND its TTL pauses. Extension cap +60s, then interrupt at the next phrase boundary. A TTL that expires anyway swaps the queued last-call for the honest expiry notice. |
| D2 | Headline + counted tail | One drain speaks the top-severity item fully, counts the rest ("also, three panes finished — ask for the rundown"). Tail items stay in the visual stack + catch-up. |
| D3 | Force the turn, steer the words | Mechanical guarantees: delivery, priority order, coalescing, TTL honesty, and (for must-voice classes) THAT a spoken turn happens at turn-clear. Prompt-steered: ALL phrasing, verbosity, headline choice. No verbatim scripts. |
| D4 | A dial, with a floor | Per-class delivery mode `forced-turn \| steered-digest \| passive-context` in settings (capability-gate idiom). Floor: classes 0–2 refuse `passive`; NO class can be configured silent. **Provenance: this formally revises the 2026-07-28 locked "no corrections knob" decision — tunability was re-decided by the director on 2026-07-29 with the never-silent floor as the preserved invariant.** |
| D5 | All test layers with the build | Ratchet, property tests, journey replays, telemetry + watch bead ship in this program (no early guardrails). Accepted interim risk: producer inventory unfrozen until land. |
| D6 | Big-bang, waved inside | One program, one branch, four internal waves each passing the full gate; one stacked PR. |

Standing invariants inherited unchanged: **"told-more beats silently-missed"** (no silent-drop path
may exist in any configuration); **turn-timing decisions stay in-process TS** (LOCKED seam rule —
no Python round-trip anywhere near `ackState()`); **the emergency brake ([6] guardrails) bypasses
the arbiter entirely**; **panes boot inert**.

## 3. Architecture

### 3.1 The core: `src/voice/turnArbiter.ts`

Pure, synchronous decision module (no I/O, no timers of its own; the caller supplies `now`).
Fully unit-testable with fake time.

```ts
submit(item: {
  facts: string;            // structured, already-redacted narration facts (NOT a scripted sentence)
  cls: 0|1|2|3|4|5;         // priority class (below)
  paneId?: string;
  coalesceKey?: string;     // items sharing a key coalesce ("pane-completion", "last-call:<approvalId>")
  deadline?: { expiresAt: number; onExpirySwap: string };  // class-2 only
}): void

evaluate(ctx: { now: number; floorHeld: boolean; turnClear: boolean }): DrainDecision
// DrainDecision: { action: "hold" } | { action: "drain"; digest: Digest; mode: DeliveryMode }
//                | { action: "interrupt-at-phrase-boundary"; digest: Digest }   // D1 cap reached
```

- **Priority classes:** 0 corrections (vc-D) · 1 operator-response (exempt, never queued) ·
  2 deadline narrations (five gating timer call-sites) · 3 completions (vc-C) · 4 acks (existing
  trichotomy re-homed) · 5 passive context (vc-A briefs + pane signals).
- **Drain:** at most ONE spoken turn per turn-clear. Digest = severity-ordered facts, headline =
  highest class, tail = counted with a `coalesceKey`-grouped summary. Tail facts are ALSO pushed to
  the visual stack / catch-up (D2 — told-more floor).
- **TTL-pause (D1):** class-2 items carry `deadline`. While `floorHeld`, the arbiter reports a
  pause to the gating sweep (the sweep consults `arbiter.floorPausedMs(approvalId)` before
  expiring). Pause cap: `TTL_FLOOR_EXTENSION_CAP_MS = 60_000`; at cap, `evaluate` returns
  `interrupt-at-phrase-boundary` (phrase boundary = the 200 ms settle guard the your-turn chime
  detector already trusts, `src/utils/earcon.ts` / `src/utils/audio.ts:130-134`).
- **Rendering (D3):** the drain payload is a structured digest injection; the system prompt gains a
  short narration-guidance block in `[7. VOICE OUTPUT RULES]` (answer-first is already there from
  fikj.8): lead with the worst, headline + counted tail, offer the rundown. For classes in
  `forced-turn` mode the injection completes the turn (the model MUST speak; its words, our
  timing). `steered-digest` injects turn-completing digest only when something in it warrants
  speech per its class policy; `passive-context` injects with `turnComplete:false` + BACKGROUND
  framing (fikj.8 Leg B machinery, reused verbatim).

### 3.2 The delivery-mode matrix (D4)

Settings shape (house idiom, sibling of the capability gates): per class →
`forced-turn | steered-digest | passive-context`. Defaults: 0=forced, 2=forced, 3=steered,
4=steered, 5=passive. Validation floor enforced at the settings boundary AND in the arbiter
(defense in depth): classes 0–2 minimum `steered-digest`; no `off`/silent value exists in the
type. Class 1 has no dial (always immediate).

### 3.3 Producer integration (what gets re-routed)

| Producer | Today | After |
|---|---|---|
| 5 gating timer narrations (sweep last-calls ×2, autonomy warn/expire, TTL-expiry notice) | forced `turnComplete:true` via injected `pushApprovalNarration` slot (`src/gating/index.ts:110`) | class-2 `submit` with `deadline`; one-signature change at the slot |
| Operator-initiated echoes (approve/reject, stop-all, spokenConfirm, macro read-back) | forced turns | unchanged semantics via class 1 (immediate; not queued) |
| vc-D corrections | (not yet built) | built directly as class 0; correction ledger + retraction phrasing per co-design spec §D; `drainPending` machinery lives inside the arbiter from day one |
| vc-C completions | (not yet built) | built directly as class 3; outcome-keyed decision table (completionAnnounce default `dispatched`, hasExchange-keyed) per co-design spec §C; reuses PR #152's settled-outcome seam |
| Memory briefs (vc-A / fikj.6) | `turnComplete:true` every trigger | class 5; `briefTurnComplete` boolean per co-design spec §A — mid-utterance → passive; BACKGROUND framing already applied |
| Pane signals (`pushSignal` + `deferredReady`/`armReadyDrain`) | private queue, partial gating | class 4 (acks) / class 5 (context); private queue folded into the arbiter |
| Reconnect ceremony (yg1w) | full "Welcome back" burst on every re-establish | thresholded on `now - lastDetachAt` (< `RECONNECT_QUIET_MS = 30_000`: silent re-attach, chips repopulate, events land in next catch-up); above: ceremony via class 2/5 submissions |
| Tool responses (family D) | direct | EXEMPT (the turn is the operator's); pinned by the ratchet |

### 3.4 Failure semantics

Any arbiter throw → the calling producer falls back to a passive framed injection
(`turnComplete:false` + BACKGROUND) plus the visual stack, and logs `[turn-arbiter]` at error.
Truth is never lost; a broken scheduler degrades to pre-arbiter behavior, never to silence and
never to a forced-turn storm. The emergency-brake narration path does not route through the
arbiter at all.

## 4. Program shape — four waves (D6)

Each wave: TDD (RED verified) → use-case validation → implement → full battery green → commit on
`feat/turn-arbiter-program`. No wave starts until the previous is green.

- **W1 — Arbiter core.** `turnArbiter.ts` pure module + delivery-matrix settings/validation +
  send-site ratchet test (T1). No call-site re-routes yet (no behavior change).
  *Accept:* property tests green (never-drop, priority order, one-turn-per-drain, coalescing,
  TTL-pause cap); ratchet enumerates today's send sites exactly; matrix floor rejects
  under-floor configs; battery green.
- **W2 — Deadline truth.** vc-D corrections (class 0, ledger + retraction + coalescing) + the five
  gating call-sites re-routed as class 2 with TTL-pause + expiry swap.
  *Accept:* co-design §D acceptance criteria; a last-call arriving mid-floor defers with paused
  TTL and drains first at turn-clear; cap interrupt at phrase boundary; no gating narration
  bypasses the arbiter; battery green.
- **W3 — Completions, briefs, reconnect.** vc-C (class 3, outcome table + `dispatched` default) +
  vc-A (`briefTurnComplete`, class 5) + reconnect quiet threshold (yg1w).
  *Accept:* co-design §A/§C criteria; failed-outcome narration keys off the SAME settled-outcome
  seam as PR #152's earcon; sub-threshold reconnect produces zero spoken ceremony with no event
  loss; battery green.
- **W4 — Proof & watch.** Journey replays (T3), jump-over + drain-size telemetry (T4), `[7]`
  narration-guidance prompt block, +14d due-dated watch bead created at land.
  *Accept:* journey suite covers the three canonical collisions (mid-answer last-call; transient
  blip; multi-item turn-clear); telemetry rows written via `JanusStore`; battery green.

## 5. Testing layers (D5)

- **T1 Ratchet:** conformance test — allowlisted `sendClientContent` / forced-narration callers =
  arbiter + family D only. A new producer fails CI on arrival.
- **T2 Property tests:** pure core + fake time — never-drop, priority order, TTL-pause cap bounds,
  at-most-one-turn-per-drain, coalescing idempotence, floor-flap (rapid hold/release) stability.
- **T3 Journey replays:** scripted operator collisions asserting answer-first ordering and drain
  unity end-to-end.
- **T4 Telemetry + watch:** `jump_over` counter (forced turn landing mid-answer/mid-utterance),
  drain-size distribution; due-dated review bead +14d after land — the program is not "stable"
  until the watch closes (mute-rate precedent).

## 6. Non-goals / accepted risks

- vc-B family (fikj.1/2/5 silence-gate) stays separately sliced — not in this program.
- Producer inventory unfrozen until the program lands (D5, director-accepted).
- Stacked on PR #152; a rebase follows if #152 changes in review.
- No Python involvement anywhere (LOCKED seam rule); no earcon ducking (by design, audit §2.6).
