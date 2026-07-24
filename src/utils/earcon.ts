// Compact WebAudio earcons for the Orbital Kitchen's hands-free feedback (a trimmed port of the
// classic App.tsx playEarcon). Eyes-off operation means a state change that makes no sound is a bug
// (UX_BRIEF §4: "Eyes-off ⇒ quiet state changes are forbidden"). Each call spins a transient
// AudioContext, plays a short tone pair, and is fully try/caught so a blocked/absent audio context
// (autoplay policy, headless) degrades silently — never throws into the caller.
export type EarconType =
  | "completion" | "alert" | "success" | "execute" | "chime" | "reconnect"
  // BUG-018 differentiation tokens: an eyes-off operator must hear a DISTINCT tone for a held-back
  // command ("blocked") vs. a pane needing your OK ("alert") vs. an autonomy change ("permission").
  | "blocked" | "permission" | "note";

/** Runtime guard for untyped WS frames (proactive_earcon carries a free-form string). */
export function isEarconType(v: unknown): v is EarconType {
  return v === "completion" || v === "alert" || v === "success" || v === "execute" || v === "chime" || v === "reconnect"
    || v === "blocked" || v === "permission" || v === "note";
}

// [freq, startOffset, duration] triples per earcon — distinct enough to tell apart eyes-off. A
// Record lookup (not a ternary/switch chain) keeps playEarcon itself a flat, low-complexity
// dispatch — adding an earcon here is a one-line table entry, never another branch.
const TONE_TABLE: Record<EarconType, [number, number, number][]> = {
  success: [[587.33, 0, 0.16], [880, 0.11, 0.22]],             // D5→A5 rising — "Order up!"
  completion: [[523.25, 0, 0.14], [783.99, 0.12, 0.26]],       // C5→G5 rising pair — work finished
  alert: [[440, 0, 0.16], [330, 0.13, 0.22]],                  // A4→E4 falling — needs you / brake
  execute: [[660, 0, 0.12]],                                    // short blip — it fired
  // G4→C5→E5 3-note rising figure — sonically distinct from success's 2-note D5→A5; "the radio's back"
  reconnect: [[392, 0, 0.11], [523.25, 0.09, 0.11], [659.25, 0.18, 0.2]],
  chime: [[523.25, 0, 0.18]],                                   // gentle single C5
  // BUG-018: darker/lower than `alert` (A4→E4) so a refusal reads as "held back", not a summons.
  blocked: [[330, 0, 0.14], [220, 0.12, 0.22]],                 // E4→A3 low falling — command blocked
  // A crisp two-note "lock clicked" rise — the operator learns it as "autonomy changed".
  permission: [[494, 0, 0.10], [622, 0.09, 0.16]],              // B4→D#5 short rising — permission_changed
  note: [[659.25, 0, 0.12]],                                    // single E5 blip — note saved
};

export function playEarcon(type: EarconType): void {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    // Autoplay policy can hand back a suspended context — resume fire-and-forget so the
    // tones actually sound once the page has a user gesture on record.
    if (ctx.state === "suspended") ctx.resume().catch(() => { /* still blocked — degrade silently */ });
    const now = ctx.currentTime;
    const tones = TONE_TABLE[type];
    for (const [freq, off, dur] of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(freq, now + off);
      gain.gain.setValueAtTime(0.05, now + off);
      gain.gain.exponentialRampToValueAtTime(0.001, now + off + dur);
      osc.start(now + off);
      osc.stop(now + off + dur + 0.02);
    }
    // Close the transient context shortly after the last tone so they don't accumulate.
    setTimeout(() => { try { ctx.close(); } catch { /* already closed */ } }, 700);
  } catch { /* audio blocked/unavailable — degrade silently */ }
}

// ── bead 8fz.4: the "your-turn" chime detector ──────────────────────────────
// A debounced, trailing-edge detector over the discrete conversational-state "kind" string (the
// 8fz.2 ladder: offline/tuning/blocked/reconnecting/muted/speaking/waiting/executing/thinking/
// listening). It fires `fire()` exactly once per GENUINE speaking→listening settle:
//   - leaving "speaking" starts a `guardMs` countdown (default 200ms, the SAME inter-chunk buffer
//     guard src/utils/audio.ts's isAudioPlaying already uses at audio.ts:130-134, so a streamed
//     utterance's inter-chunk gaps never fire a premature chime);
//   - resuming "speaking" before the countdown elapses CANCELS it outright (the classic flap false
//     positive this bead exists to avoid) — a later settle starts its OWN fresh countdown;
//   - the countdown only fires if the kind is STILL "listening" when it elapses (settling into
//     "waiting"/"muted"/anything else stays silent — that is not the operator's turn yet);
//   - `markInterrupted()` (call on a Gemini "interrupted" barge-in frame) silences the very NEXT
//     settle into "listening" — the operator already took the turn back, so chiming would be noise.
// Deliberately decoupled from the ConversationalKind TYPE (plain `string` in, structurally
// compatible) so this module stays free of any React/orbital import — a pure, framework-free
// timer machine, easy to unit test with node:test's `mock.timers`.
export interface YourTurnChimeDetector {
  /** Feed the freshest discrete conversational kind. Call on every kind change (a no-op if the kind
   *  did not actually change since the last call). */
  onKindChange: (kind: string) => void;
  /** Mark a barge-in — silences the very next settle into "listening". */
  markInterrupted: () => void;
  /** Cancels any in-flight debounce timer (call on unmount). */
  cancel: () => void;
}

export function createYourTurnChimeDetector(fire: () => void, guardMs = 200): YourTurnChimeDetector {
  let prevKind: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let interrupted = false;

  const clearPending = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
  };

  return {
    onKindChange(kind: string): void {
      if (kind === prevKind) return; // not a real transition — never restart/cancel a countdown
      const leftSpeaking = prevKind === "speaking" && kind !== "speaking";
      const resumedSpeaking = kind === "speaking";
      prevKind = kind;
      if (resumedSpeaking) { clearPending(); return; } // flap back into speaking — abort the countdown
      if (!leftSpeaking) return; // any other transition (e.g. waiting→listening) never chimes
      clearPending(); // a second leftSpeaking edge (shouldn't happen, but stay safe) restarts fresh
      // Consume the barge-in latch at the settle ATTEMPT, not when the timer fires. If this
      // countdown is later CANCELLED by Janus resuming speech inside the guard, the latch must
      // still be spent — otherwise it would leak forward and wrongly silence the model's genuine
      // next settle (its reply to the barge-in). markInterrupted() always precedes the settle.
      const wasInterrupted = interrupted;
      interrupted = false;
      timer = setTimeout(() => {
        timer = null;
        // Re-check the LIVE latch too: a markInterrupted() that lands DURING this countdown (a
        // barge-in inside the guard window, after activeSources drained mid-utterance) is captured
        // too late for `wasInterrupted`. Consume it HERE so it both suppresses this spurious fire
        // AND never leaks forward to silence the model's genuine next settle.
        const liveInterrupted = interrupted;
        interrupted = false;
        if (prevKind === "listening" && !wasInterrupted && !liveInterrupted) fire();
      }, guardMs);
    },
    markInterrupted(): void { interrupted = true; },
    cancel: clearPending,
  };
}
