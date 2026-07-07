// tests/test_captionbar_selector.ts
//
// bead 8fz.3: the caption pop-up's pure tail selector. Written FIRST (TDD RED) to pin the
// contract: given the transcript array useOrbitalData already maintains (capped at 50, tail-
// appended), captionTail() returns the MOST RECENT Janus line and the MOST RECENT User line —
// never the whole transcript, never a full-array copy/reverse.
//
// Runner: npx tsx --test --test-force-exit tests/test_captionbar_selector.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { captionTail } from "../src/orbital/CaptionBar";
import type { TranscriptEntry } from "../src/orbital/useOrbitalData";

function entry(sender: "User" | "Janus", text: string): TranscriptEntry {
  return { sender, text, timestamp: new Date() };
}

/** A toast-minted Janus entry — already announced by the toast's own role="status" region. */
function toastEntry(text: string): TranscriptEntry {
  return { sender: "Janus", text, timestamp: new Date(), fromToast: true };
}

describe("captionTail", () => {
  it("returns nulls for an empty transcript", () => {
    assert.deepEqual(captionTail([]), { janus: null, user: null, janusFromToast: false });
  });

  it("returns only the Janus line when there is no User turn yet", () => {
    const t = [entry("Janus", "order up, chef")];
    assert.deepEqual(captionTail(t), { janus: "order up, chef", user: null, janusFromToast: false });
  });

  it("returns only the User line when there is no Janus turn yet", () => {
    const t = [entry("User", "fire table six")];
    assert.deepEqual(captionTail(t), { janus: null, user: "fire table six", janusFromToast: false });
  });

  it("picks the LATEST of each sender in an interleaved transcript", () => {
    const t = [
      entry("User", "first user line"),
      entry("Janus", "first janus line"),
      entry("User", "second user line"),
      entry("Janus", "second janus line"),
      entry("User", "third user line"),
    ];
    assert.deepEqual(captionTail(t), { janus: "second janus line", user: "third user line", janusFromToast: false });
  });

  it("keeps picking the latest of each even once both are already found (stops scanning)", () => {
    const t = [
      entry("Janus", "oldest janus"),
      entry("User", "oldest user"),
      entry("Janus", "newest janus"),
      entry("User", "newest user"),
    ];
    assert.deepEqual(captionTail(t), { janus: "newest janus", user: "newest user", janusFromToast: false });
  });

  it("handles a full 50-entry cap, honoring only the tail", () => {
    const t: TranscriptEntry[] = [];
    for (let i = 0; i < 50; i++) {
      t.push(entry(i % 2 === 0 ? "Janus" : "User", `line-${i}`));
    }
    // last entry is index 49 (odd -> User "line-49"), second-to-last is index 48 (Janus "line-48")
    assert.deepEqual(captionTail(t), { janus: "line-48", user: "line-49", janusFromToast: false });
  });

  // ── double-announce guard (Wave 5 fix) ────────────────────────────────────
  // A toast-minted Janus entry is ALREADY announced by the toast's own role="status" aria-live
  // region (OrbitalApp renderToast). The caption region must therefore flag that latest Janus
  // line as fromToast so CaptionBar can suppress its own aria-live and NOT double-announce it.
  it("flags janusFromToast=true when the latest Janus line was minted by a toast", () => {
    const t = [entry("User", "fire table six"), toastEntry("Back on the air.")];
    assert.deepEqual(captionTail(t), { janus: "Back on the air.", user: "fire table six", janusFromToast: true });
  });

  it("flags janusFromToast=false when a genuine radio Janus line is newer than a toast line", () => {
    const t = [toastEntry("Back on the air."), entry("Janus", "order up, chef")];
    assert.deepEqual(captionTail(t), { janus: "order up, chef", user: null, janusFromToast: false });
  });

  it("flags janusFromToast=true when a toast line is newer than a genuine radio Janus line", () => {
    const t = [entry("Janus", "order up, chef"), toastEntry("Fired to Burner 2.")];
    assert.deepEqual(captionTail(t), { janus: "Fired to Burner 2.", user: null, janusFromToast: true });
  });
});
