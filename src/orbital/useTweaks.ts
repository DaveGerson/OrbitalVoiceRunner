// ── ORBITAL · useTweaks ─────────────────────────────────────────────────
// The design's tweaks-panel.jsx is a Claude-Design EDIT-MODE harness (it posts
// __edit_mode_set_keys to the design host to rewrite a JSON block on disk) — it
// is NOT product code. In the real app these tweaks are genuine view
// preferences: persisted to localStorage, overridable via URL params (so e2e /
// deep-links stay deterministic), same shape the prototype exposed.
import { useCallback, useState } from "react";
import type { AccentKey } from "./theme";

export interface Tweaks {
  density: "calm" | "dense";
  accent: AccentKey;
  layout: "grid" | "rail" | "list";
  dark: boolean;
  mascot: boolean;
  voiceCues: boolean;
  danceParty: boolean;
  /** 2K.6: desktop notifications for background-tab events (separate from Voice cues, which gates audio). */
  desktopNotes: boolean;
  /** 8fz.3: the caption pop-up (last Janus + last User transcript lines). Auto-shown while the
   *  radio is live; this toggle just governs whether it's allowed to show at all. */
  captions: boolean;
}

export const TWEAK_DEFAULTS: Tweaks = {
  density: "calm",
  accent: "cherry",
  layout: "grid",
  dark: false,
  mascot: true,
  voiceCues: true,
  danceParty: false,
  desktopNotes: true,
  captions: true,
};

const LS_KEY = "orbital-tweaks";

function loadStored(): Partial<Tweaks> {
  try {
    const raw = typeof localStorage !== "undefined" && localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as Partial<Tweaks>) : {};
  } catch {
    return {};
  }
}

/** Defaults ← localStorage ← URL params (URL wins, like the prototype). */
export function mergedDefaults(): Tweaks {
  const d: Tweaks = { ...TWEAK_DEFAULTS, ...loadStored() };
  const p = typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
  const dd = d as unknown as Record<string, string | boolean>;
  (["density", "accent", "layout"] as const).forEach((k) => {
    const v = p.get(k);
    if (v) dd[k] = v;
  });
  if (p.has("dark")) d.dark = p.get("dark") === "1";
  if (p.has("mascot")) d.mascot = p.get("mascot") === "1";
  if (p.has("cues")) d.voiceCues = p.get("cues") === "1";
  if (p.has("dance")) d.danceParty = p.get("dance") === "1";
  if (p.has("notes")) d.desktopNotes = p.get("notes") === "1";
  if (p.has("captions")) d.captions = p.get("captions") === "1";
  return d;
}

export function useTweaks(initial: Tweaks): [Tweaks, <K extends keyof Tweaks>(key: K, val: Tweaks[K]) => void] {
  const [values, setValues] = useState<Tweaks>(initial);
  const setTweak = useCallback(<K extends keyof Tweaks>(key: K, val: Tweaks[K]) => {
    setValues((prev) => {
      const next = { ...prev, [key]: val };
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(next));
      } catch {
        /* ignore quota / unavailable */
      }
      return next;
    });
  }, []);
  return [values, setTweak];
}
