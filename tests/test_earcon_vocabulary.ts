// tests/test_earcon_vocabulary.ts
//
// bead 8fz.4: completing the earcon vocabulary.
//   1. isEarconType — "reconnect" is a REAL EarconType (a server proactive_earcon carrying it must
//      not be silently dropped by the runtime guard), arbitrary strings are still rejected.
//   2. createYourTurnChimeDetector — the "your-turn" chime transition detector, pure/framework-free,
//      driven with node:test's `mock.timers` so the 200ms debounce guard is exercised deterministically.
//
// Runner: npx tsx --test --test-force-exit tests/test_earcon_vocabulary.ts

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { isEarconType, createYourTurnChimeDetector } from "../src/utils/earcon";
import { voiceChannelRestoredToast } from "../src/orbital/useOrbitalData";

describe("isEarconType", () => {
  it("accepts every real earcon, including the new 'reconnect'", () => {
    for (const t of ["completion", "alert", "success", "execute", "chime", "reconnect"]) {
      assert.equal(isEarconType(t), true, `${t} must be accepted`);
    }
  });

  it("rejects arbitrary strings and non-strings", () => {
    for (const v of ["bogus", "", "RECONNECT", "reconnected", null, undefined, 42, {}]) {
      assert.equal(isEarconType(v), false, `${JSON.stringify(v)} must be rejected`);
    }
  });
});

describe("voiceChannelRestoredToast — voice_channel_restored plays the DEDICATED reconnect tone", () => {
  it("carries the reconnect earcon override, not the generic success tone", () => {
    const t = voiceChannelRestoredToast();
    assert.equal(t.msg, "Back on the air.");
    assert.equal(t.kind, "fire");
    assert.equal(t.earcon, "reconnect", "must NOT double-tone as 'success' — reconnect is dedicated");
    assert.ok(isEarconType(t.earcon), "the override must be a real EarconType the player accepts");
  });
});

describe("createYourTurnChimeDetector — the your-turn transition detector", () => {
  it("speaking→listening (settled past the guard) chimes exactly once", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let chimes = 0;
      const d = createYourTurnChimeDetector(() => { chimes += 1; });
      d.onKindChange("speaking");
      d.onKindChange("listening");
      mock.timers.tick(200);
      assert.equal(chimes, 1);
    } finally { mock.timers.reset(); }
  });

  it("speaking→speaking→listening chimes exactly once (a repeated same-kind sample is a no-op)", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let chimes = 0;
      const d = createYourTurnChimeDetector(() => { chimes += 1; });
      d.onKindChange("speaking");
      d.onKindChange("speaking"); // no-op, not a real transition
      d.onKindChange("listening");
      mock.timers.tick(200);
      assert.equal(chimes, 1);
    } finally { mock.timers.reset(); }
  });

  it("listening→listening never chimes (no speaking edge to settle from)", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let chimes = 0;
      const d = createYourTurnChimeDetector(() => { chimes += 1; });
      d.onKindChange("listening");
      d.onKindChange("listening"); // no-op
      mock.timers.tick(500);
      assert.equal(chimes, 0);
    } finally { mock.timers.reset(); }
  });

  it("speaking→(interrupted)→listening does NOT chime — the operator already has the turn", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let chimes = 0;
      const d = createYourTurnChimeDetector(() => { chimes += 1; });
      d.onKindChange("speaking");
      d.markInterrupted(); // a Gemini "interrupted" barge-in frame landed
      d.onKindChange("listening");
      mock.timers.tick(200);
      assert.equal(chimes, 0);
    } finally { mock.timers.reset(); }
  });

  it("a rapid speaking/listening flap within the guard window still settles to exactly one chime", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let chimes = 0;
      const d = createYourTurnChimeDetector(() => { chimes += 1; });
      d.onKindChange("speaking");
      d.onKindChange("listening"); // starts a countdown
      mock.timers.tick(50);        // well inside the 200ms guard
      d.onKindChange("speaking");  // flap back — the countdown is CANCELLED, no chime for this leave
      mock.timers.tick(500);       // even if we wait, the cancelled countdown never fires
      assert.equal(chimes, 0);
      d.onKindChange("listening"); // settles for real this time
      mock.timers.tick(200);
      assert.equal(chimes, 1, "exactly one chime once it truly settles, not one per flap");
    } finally { mock.timers.reset(); }
  });

  it("settling into anything OTHER than listening (e.g. waiting) after leaving speaking stays silent", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let chimes = 0;
      const d = createYourTurnChimeDetector(() => { chimes += 1; });
      d.onKindChange("speaking");
      d.onKindChange("waiting"); // an approval landed the instant Janus stopped talking
      mock.timers.tick(200);
      assert.equal(chimes, 0, "waiting is not the operator's turn yet — must not chime");
    } finally { mock.timers.reset(); }
  });

  it("cancel() clears any in-flight countdown (unmount safety)", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let chimes = 0;
      const d = createYourTurnChimeDetector(() => { chimes += 1; });
      d.onKindChange("speaking");
      d.onKindChange("listening");
      d.cancel();
      mock.timers.tick(500);
      assert.equal(chimes, 0, "a cancelled detector must never fire late");
    } finally { mock.timers.reset(); }
  });

  it("an interrupted flag consumed by one settle does not leak into the NEXT unrelated settle", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let chimes = 0;
      const d = createYourTurnChimeDetector(() => { chimes += 1; });
      d.onKindChange("speaking");
      d.markInterrupted();
      d.onKindChange("listening");
      mock.timers.tick(200);
      assert.equal(chimes, 0); // first settle silenced by the barge-in

      d.onKindChange("speaking");
      d.onKindChange("listening"); // a fresh, un-interrupted settle
      mock.timers.tick(200);
      assert.equal(chimes, 1, "the interrupted flag must not silence a later, unrelated settle");
    } finally { mock.timers.reset(); }
  });

  // ── interrupt-latch leak on a CANCELLED countdown (Wave 5 minor fix) ────────
  // The barge-in latch must be consumed by the settle ATTEMPT, not only by a fired timer. If the
  // post-barge-in settle's countdown is cancelled by Janus resuming speech inside the guard, the
  // latch must NOT survive to silence the model's genuine next settle (its reply to the barge-in).
  it("a barge-in whose settle countdown is CANCELLED does not leak into the next genuine settle", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let chimes = 0;
      const d = createYourTurnChimeDetector(() => { chimes += 1; });
      d.markInterrupted();          // a Gemini "interrupted" barge-in frame landed
      d.onKindChange("speaking");
      d.onKindChange("listening");  // first (silenced) settle starts a countdown
      mock.timers.tick(100);        // inside the 200ms guard — not fired yet
      d.onKindChange("speaking");   // Janus resumes: the countdown is CANCELLED before it fires
      d.onKindChange("listening");  // the model's genuine reply now settles for real
      mock.timers.tick(300);
      assert.equal(chimes, 1, "the cancelled barge-in latch must not silence the genuine next settle");
    } finally { mock.timers.reset(); }
  });

  // ── barge-in arriving DURING the guard countdown (Wave 5 minor fix, round 2) ─
  // The round-1 fix consumed the latch at the settle ATTEMPT. That left the complementary race: a
  // markInterrupted() landing INSIDE the guard window (a barge-in after activeSources drained mid-
  // utterance) is captured too late for `wasInterrupted`, so the timer fires a SPURIOUS your-turn
  // chime AND leaks the live latch forward — silencing the model's genuine next settle. The robust
  // fix re-checks the LIVE latch at fire time and consumes it there too. Reviewer repro (1) & (2).
  it("a barge-in arriving DURING the settle countdown suppresses the spurious chime (repro 1)", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let chimes = 0;
      const d = createYourTurnChimeDetector(() => { chimes += 1; });
      d.onKindChange("speaking");
      d.onKindChange("listening"); // the settle starts a countdown
      d.markInterrupted();         // barge-in lands INSIDE the 200ms guard window
      mock.timers.tick(300);
      assert.equal(chimes, 0, "a barge-in mid-countdown must suppress the spurious your-turn chime");
    } finally { mock.timers.reset(); }
  });

  it("a mid-countdown barge-in does NOT leak the latch into the next genuine settle (repro 2)", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      let chimes = 0;
      const d = createYourTurnChimeDetector(() => { chimes += 1; });
      d.onKindChange("speaking");
      d.onKindChange("listening");
      d.markInterrupted();         // barge-in inside the guard window (silences THIS settle only)
      mock.timers.tick(300);
      const afterBargeIn = chimes; // 0 with the fix; 1 (spurious) under the leaked-latch bug
      d.onKindChange("speaking");
      d.onKindChange("listening"); // the model's genuine reply now settles for real
      mock.timers.tick(300);
      assert.equal(chimes - afterBargeIn, 1, "the next genuine settle must still chime — the mid-countdown latch must not leak");
    } finally { mock.timers.reset(); }
  });
});
