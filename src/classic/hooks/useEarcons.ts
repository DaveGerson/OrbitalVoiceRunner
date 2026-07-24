// src/classic/hooks/useEarcons.ts — the hands-free non-verbal feedback layer, extracted VERBATIM
// out of src/App.tsx's AppRaw() (bead dbt4 — App.tsx decomposition, mirroring the gold-standard
// src/hooks/useLiveSession.ts seam: params-interface in, returns-interface out, pure decisions
// split into a sibling *Logic.ts node:test-pinned helper).
//
// Owns:
//   * browserNotificationsEnabled — the operator toggle that gates desktop notifications.
//   * playEarcon — the Web-Audio oscillator earcon player (irreducibly browser-coupled; AudioContext
//     graph kept byte-for-byte from the App body).
//   * triggerDesktopNotification — the gated `new Notification(...)` wrapper; the pure gate decision
//     delegates to shouldNotify (classic/helpers/earconLogic.ts, pinned in tests/test_earcon_logic.ts).
//
// Behavior is byte-identical to the former App body: same oscillator types/frequencies/gain
// envelopes/timings per earcon, same try/catch swallow, same notification gate conjunction. No
// observable change — the e2e voice journeys (which assert earcon/notification side-effects) are the
// integration witness.

import { useState } from "react";
import type { EarconType } from "../../announcementKinds";
import { shouldNotify } from "../helpers/earconLogic";

export interface Earcons {
  playEarcon: (type: EarconType) => void;
  triggerDesktopNotification: (title: string, body: string) => void;
  browserNotificationsEnabled: boolean;
  setBrowserNotificationsEnabled: (v: boolean) => void;
}

export function useEarcons(): Earcons {
  // browserNotificationsEnabled gates triggerDesktopNotification(), which still fires for the
  // surviving approval / action-pending / auto-approve / blocked notifications. Auto-enabled at
  // boot when Notification.permission is already "granted". The manual toggle lived in the removed
  // Alerts tab; desktop notifications now follow the browser's existing permission grant.
  const [browserNotificationsEnabled, setBrowserNotificationsEnabled] = useState(false);

  // Web Audio Synth Chimes for Hands-Free Feedback
  const playEarcon = (type: EarconType) => {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === "completion") {
        // WS-D (BUG-024): a distinct, short rising two-note so a genuine completion is
        // audibly distinct from alert/success/execute/chime.
        const now = ctx.currentTime;
        osc.type = "triangle";
        osc.frequency.setValueAtTime(587.33, now); // D5
        gain.gain.setValueAtTime(0.05, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
        osc.start(now);
        osc.stop(now + 0.2);

        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.type = "triangle";
        osc2.frequency.setValueAtTime(880, now + 0.12); // A5
        gain2.gain.setValueAtTime(0.05, now + 0.12);
        gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.12 + 0.22);
        osc2.start(now + 0.12);
        osc2.stop(now + 0.12 + 0.24);
      } else if (type === "alert") {
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(440, ctx.currentTime);
        gain.gain.setValueAtTime(0.04, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.4);

        setTimeout(() => {
          const osc2 = ctx.createOscillator();
          const gain2 = ctx.createGain();
          osc2.connect(gain2);
          gain2.connect(ctx.destination);
          osc2.type = "sawtooth";
          osc2.frequency.setValueAtTime(554, ctx.currentTime);
          gain2.gain.setValueAtTime(0.04, ctx.currentTime);
          gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
          osc2.start(ctx.currentTime);
          osc2.stop(ctx.currentTime + 0.4);
        }, 150);
      } else if (type === "success") {
        const now = ctx.currentTime;
        osc.type = "sine";
        osc.frequency.setValueAtTime(523.25, now);
        gain.gain.setValueAtTime(0.06, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
        osc.start(now);
        osc.stop(now + 0.55);

        const notes = [659.25, 783.99, 1046.50];
        notes.forEach((freq, idx) => {
          const oscN = ctx.createOscillator();
          const gainN = ctx.createGain();
          oscN.connect(gainN);
          gainN.connect(ctx.destination);
          oscN.type = "sine";
          oscN.frequency.setValueAtTime(freq, now + (idx + 1) * 0.08);
          gainN.gain.setValueAtTime(0.06, now + (idx + 1) * 0.08);
          gainN.gain.exponentialRampToValueAtTime(0.001, now + (idx + 1) * 0.08 + 0.4);
          oscN.start(now + (idx + 1) * 0.08);
          oscN.stop(now + (idx + 1) * 0.08 + 0.5);
        });
      } else if (type === "execute") {
        osc.type = "square";
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        gain.gain.setValueAtTime(0.02, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.1);
      } else if (type === "chime") {
        const now = ctx.currentTime;
        osc.type = "sine";
        osc.frequency.setValueAtTime(329.63, now);
        gain.gain.setValueAtTime(0.05, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
        osc.start(now);
        osc.stop(now + 0.62);

        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.type = "sine";
        osc2.frequency.setValueAtTime(493.88, now + 0.1);
        gain2.gain.setValueAtTime(0.05, now + 0.1);
        gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.1 + 0.5);
        osc2.start(now + 0.1);
        osc2.stop(now + 0.1 + 0.62);
      } else if (type === "blocked") {
        // BUG-018: a DARKER, lower falling pair (E4→A3) than `alert` (440/554) so an eyes-off
        // operator hears a command was HELD BACK, not that a pane needs an OK. Mirrors the kitchen
        // tone (src/utils/earcon.ts TONE_TABLE.blocked) so the two UIs sound the same.
        const now = ctx.currentTime;
        osc.type = "triangle";
        osc.frequency.setValueAtTime(330, now); // E4
        gain.gain.setValueAtTime(0.05, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
        osc.start(now);
        osc.stop(now + 0.18);

        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.type = "triangle";
        osc2.frequency.setValueAtTime(220, now + 0.12); // A3
        gain2.gain.setValueAtTime(0.05, now + 0.12);
        gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.12 + 0.22);
        osc2.start(now + 0.12);
        osc2.stop(now + 0.12 + 0.24);
      } else if (type === "permission") {
        // BUG-018: a crisp two-note RISE (B4→D#5) — the operator learns it as "autonomy changed",
        // audibly distinct from alert (falling) and blocked (low falling). Mirrors the kitchen tone
        // (src/utils/earcon.ts TONE_TABLE.permission).
        const now = ctx.currentTime;
        osc.type = "triangle";
        osc.frequency.setValueAtTime(493.88, now); // B4
        gain.gain.setValueAtTime(0.05, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
        osc.start(now);
        osc.stop(now + 0.12);

        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.type = "triangle";
        osc2.frequency.setValueAtTime(622.25, now + 0.09); // D#5
        gain2.gain.setValueAtTime(0.05, now + 0.09);
        gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.09 + 0.16);
        osc2.start(now + 0.09);
        osc2.stop(now + 0.09 + 0.18);
      }
    } catch (e) {}
  };

  const triggerDesktopNotification = (title: string, body: string) => {
    if (shouldNotify(browserNotificationsEnabled, "Notification" in window, Notification.permission)) {
      try {
        new Notification(title, { body });
      } catch (e) {}
    }
  };

  return { playEarcon, triggerDesktopNotification, browserNotificationsEnabled, setBrowserNotificationsEnabled };
}
