// Compact WebAudio earcons for the Orbital Kitchen's hands-free feedback (a trimmed port of the
// classic App.tsx playEarcon). Eyes-off operation means a state change that makes no sound is a bug
// (UX_BRIEF §4: "Eyes-off ⇒ quiet state changes are forbidden"). Each call spins a transient
// AudioContext, plays a short tone pair, and is fully try/caught so a blocked/absent audio context
// (autoplay policy, headless) degrades silently — never throws into the caller.
export type EarconType = "completion" | "alert" | "success" | "execute" | "chime";

/** Runtime guard for untyped WS frames (proactive_earcon carries a free-form string). */
export function isEarconType(v: unknown): v is EarconType {
  return v === "completion" || v === "alert" || v === "success" || v === "execute" || v === "chime";
}

export function playEarcon(type: EarconType): void {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    // Autoplay policy can hand back a suspended context — resume fire-and-forget so the
    // tones actually sound once the page has a user gesture on record.
    if (ctx.state === "suspended") ctx.resume().catch(() => { /* still blocked — degrade silently */ });
    const now = ctx.currentTime;
    // [freq, startOffset, duration] pairs per earcon — distinct enough to tell apart eyes-off.
    const tones: [number, number, number][] =
      type === "success" ? [[587.33, 0, 0.16], [880, 0.11, 0.22]]            // D5→A5 rising — "Order up!"
      : type === "completion" ? [[523.25, 0, 0.14], [783.99, 0.12, 0.26]]    // C5→G5 rising pair — work finished
      : type === "alert" ? [[440, 0, 0.16], [330, 0.13, 0.22]]              // A4→E4 falling — needs you / brake
      : type === "execute" ? [[660, 0, 0.12]]                                // short blip — it fired
      : [[523.25, 0, 0.18]];                                                  // chime — gentle single C5
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
