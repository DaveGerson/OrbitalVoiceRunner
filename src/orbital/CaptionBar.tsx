// ── ORBITAL · CaptionBar (bead 8fz.3) ────────────────────────────────────
// High-contrast caption pop-up: the tail of the radio transcript (last Janus line
// + last User line), distinct from KitchenRadio's scrollable bubble transcript
// (KitchenRadio.tsx:288, data-testid="radio-transcript"). Fed entirely by the
// transcript_text frames useOrbitalData already folds into `transcript`
// (useOrbitalData.ts:1104) — no new WS frame, no server change.
//
// Placement (operator decision 2026-07-06): a pop-up rising from the BOTTOM OF
// THE RIGHT SIDEBAR, mounted as a sibling below KitchenRadio inside OrbitalApp's
// action-right <aside> (OrbitalApp.tsx ~310). It occupies its own flex row rather
// than an absolutely-positioned overlay, so it structurally can never cover the
// mic control buttons the sidebar also hosts — they're separate boxes in the
// same flex column, not stacked layers.
import type { CSSProperties } from "react";
import { INK } from "./theme";
import type { TranscriptEntry } from "./useOrbitalData";

export interface CaptionTail {
  janus: string | null;
  user: string | null;
  /** True when the latest Janus line was minted by a toast (showToast) — that string is ALREADY
   *  announced by the toast's own role="status" aria-live region, so the caption region must NOT
   *  re-announce it (the double-announce guard). Genuine radio transcript_text lines are false. */
  janusFromToast: boolean;
}

/** Pure selector: walks the transcript TAIL and stops as soon as the latest
 *  Janus line and the latest User line are both found — never slices, reverses,
 *  or copies the array (the transcript is already capped at 50 by the caller,
 *  but this selector doesn't rely on that; it just never scans further than it
 *  has to). */
export function captionTail(transcript: TranscriptEntry[]): CaptionTail {
  let janus: string | null = null;
  let user: string | null = null;
  let janusFromToast = false;
  for (let i = transcript.length - 1; i >= 0 && (janus === null || user === null); i--) {
    const entry = transcript[i];
    if (entry.sender === "Janus" && janus === null) { janus = entry.text; janusFromToast = entry.fromToast === true; }
    else if (entry.sender === "User" && user === null) user = entry.text;
  }
  return { janus, user, janusFromToast };
}

const clampLine: CSSProperties = {
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
  textOverflow: "ellipsis",
  wordBreak: "break-word",
  fontSize: 16,
  lineHeight: 1.25,
  fontFamily: "DM Sans, sans-serif",
  fontWeight: 700,
};

export function CaptionBar({
  transcript, live, captionsOn, dark,
}: {
  transcript: TranscriptEntry[];
  /** Radio channel is live — captions are AUTO-ON while true (operator decision). */
  live: boolean;
  /** Persisted useTweaks toggle (mirrors voiceCues) — hides captions even while live. */
  captionsOn: boolean;
  dark: boolean;
}) {
  if (!live || !captionsOn) return null;
  const { janus, user, janusFromToast } = captionTail(transcript);
  // NOTE: no early-return on an empty tail. Once live + captionsOn, the caption-janus aria-live
  // region below is mounted PERSISTENTLY (rendered empty until the first Janus line lands) — a live
  // region that is created already-populated is NOT announced by some screen readers, so the first
  // utterance after going live would be silently dropped. The !live / !captionsOn guard above still
  // keeps the whole bar unmounted off-air / with captions toggled off.

  // High-contrast per the Kitchen design language: INK on cream (light mode) / cream on INK (dark).
  const bg = dark ? "#fff4de" : INK;
  const fg = dark ? INK : "#fff4de";

  return (
    <div
      data-testid="caption-bar"
      style={{
        flexShrink: 0,
        maxWidth: "100%",
        boxSizing: "border-box",
        overflow: "hidden",
        background: bg,
        color: fg,
        padding: "10px 14px",
        borderTop: "3px solid " + INK,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      {user !== null && (
        // The operator's own recognized utterance is visible but NOT announced — they said it,
        // announcing it back would be an echo-chamber for screen-reader users (the one real
        // sabotage hazard this bead calls out).
        <div data-testid="caption-user" style={{ ...clampLine, opacity: 0.72 }}>{user}</div>
      )}
      {/* The Janus line's aria-live region is ALWAYS mounted (empty string until the first line
          arrives) so the region pre-exists its first content and screen readers announce it.
          aria-live="polite" on the Janus line ONLY — coordinated with the 8fz.2 pill (which
          announces STATE via its own role="status"/aria-live) so content and state each announce
          exactly once, never doubled. A toast-minted line is set aria-live="off": the toast's own
          role="status" region already announces it, so re-announcing here would be a double-announce
          loop (the reconnect ack "Back on the air." was the concrete offender). */}
      <div data-testid="caption-janus" aria-live={janusFromToast ? "off" : "polite"} style={clampLine}>{janus ?? ""}</div>
    </div>
  );
}
