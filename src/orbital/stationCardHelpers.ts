// ── ORBITAL · StationCard pure helpers ──────────────────────────────────────
// All logic extracted from StationCard to bring McCabe complexity to ≤10.
// Every function here is a pure, side-effect-free derivation — no JSX, no
// React, no DOM — so the node test runner can import this module without
// Vite shims.

import { INK } from "./theme";

// ─── colour palette ─────────────────────────────────────────────────────────

export interface CardColors {
  cardBg: string;
  fg: string;
  sub: string;
  sunken: string;
}

/** Derive the four background/foreground tokens for the current dark-mode setting. */
export function deriveCardColors(dark: boolean): CardColors {
  return {
    cardBg: dark ? "#2f1d12" : "#fff9ec",
    fg: dark ? "#ffe9c7" : INK,
    sub: dark ? "#c89f74" : "#8a6a4f",
    sunken: dark ? "#241409" : "#fff4de",
  };
}

// ─── tag ────────────────────────────────────────────────────────────────────

/** Derive the 4-letter project tag shown next to the accent pip. */
export function deriveCardTag(projectName: string): string {
  return projectName.replace(/[^a-z]/gi, "").slice(0, 4).toUpperCase() || "—";
}

// ─── box-shadow ─────────────────────────────────────────────────────────────

/** Build the CSS box-shadow string from hover/active/needs state. */
export function deriveCardBoxShadow(
  active: boolean,
  hover: boolean,
  needs: boolean,
): string {
  const prefix = active ? "0 0 0 3px var(--butter), " : "";
  const shadow = hover
    ? "6px 6px 0 0 " + INK
    : needs
    ? "3px 3px 0 0 #ff8a3d"
    : "3px 3px 0 0 " + INK;
  return prefix + shadow;
}

// ─── transform ──────────────────────────────────────────────────────────────

/** Build the CSS transform string from hover/tilt state. */
export function deriveCardTransform(hover: boolean, tilt: number): string {
  return `${hover ? "translate(-1px,-2px) " : ""}rotate(${hover ? 0 : tilt}deg)`;
}

// ─── accent spine ────────────────────────────────────────────────────────────

export interface SpineStyle {
  position: "absolute";
  top: number;
  left: number;
  bottom: number;
  width: number;
  backgroundColor: string;
  backgroundImage: string;
  backgroundSize: string;
  animation: string;
}

/** Derive inline style for the animated accent-spine strip. */
export function deriveSpineStyle(accentHex: string, isRun: boolean): SpineStyle {
  return {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    width: 5,
    backgroundColor: accentHex,
    backgroundImage: isRun
      ? "repeating-linear-gradient(135deg, rgba(255,255,255,.55) 0 5px, rgba(255,255,255,0) 5px 10px)"
      : "none",
    backgroundSize: "14px 14px",
    animation: isRun ? "orb-spine .6s linear infinite" : "none",
  };
}

// ─── scribble colour ────────────────────────────────────────────────────────

/** Derive the text colour for the scribble/last-command note. */
export function deriveScribbleColor(needs: boolean, dark: boolean): string {
  return needs ? "#e23a3a" : dark ? "#ffc94a" : "#a8151a";
}

// ─── scribble border colour ─────────────────────────────────────────────────

/** Derive the border colour for the scribble block. */
export function deriveScribbleBorderColor(dark: boolean): string {
  return dark ? "#5b3a23" : INK;
}

// ─── output line colour ─────────────────────────────────────────────────────

/** Map a single terminal output line to its display colour. */
export function deriveOutputLineColor(line: string): string {
  if (line.startsWith("$")) return "#ffc94a";
  if (line.startsWith("✓")) return "#9be3c0";
  if (line.startsWith("⚠")) return "#ff8a3d";
  return "#e9d9c0";
}

// ─── footer divider colour ───────────────────────────────────────────────────

/** Derive the dashed-border colour for the footer row. */
export function deriveFooterBorderColor(dark: boolean): string {
  return dark ? "#5b3a23" : "#c9a97a";
}

// ─── voice-cue border colour ─────────────────────────────────────────────────

/** Derive the dotted-border colour for the voice-cue row. */
export function deriveCueBorderColor(dark: boolean): string {
  return dark ? "#5b3a23" : "#d9bf94";
}
