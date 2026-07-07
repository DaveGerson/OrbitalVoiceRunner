// tests/test_audio_playback_subscriber.ts
//
// bead 8fz.2 — the playback-state subscribe/notify seam (src/utils/audio.ts).
//
// The conversational pill's "speaking" signal must come from ACTUAL audio playback (the SAME
// activeSources bookkeeping playAudioChunk/resetAudioPlayback already maintain), never inferred
// from the freshest transcript sender. This pins that the subscriber fires EXACTLY ONCE on the
// 0->1 "started speaking" transition and EXACTLY ONCE on the 1->0 "done speaking" transition,
// no matter how many chunks are interleaved in between — never once per chunk (that would spam a
// downstream aria-live/screen-reader announcement).
//
// Deliberately does NOT construct a real/mock AudioContext: trackPlaybackStart/trackPlaybackEnd
// are exported standalone specifically so this test can drive them with plain mock source
// objects, keeping the seam thin.
//
// Runner: npx tsx --test --test-force-exit tests/test_audio_playback_subscriber.ts

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  subscribeAudioPlayback,
  trackPlaybackStart,
  trackPlaybackEnd,
  isAudioPlaybackActive,
  resetAudioPlayback,
} from "../src/utils/audio";

// A plain stand-in for AudioBufferSourceNode — only reference identity matters to the tracker
// (indexOf comparisons), so a bare object cast is enough. No AudioContext, no createBuffer.
function fakeSource(): AudioBufferSourceNode {
  return {} as unknown as AudioBufferSourceNode;
}

describe("audio playback subscribe/notify seam", () => {
  beforeEach(() => {
    // Drain any sources a prior test left active so each test starts from a clean idle state.
    resetAudioPlayback();
  });

  it("starts idle", () => {
    assert.equal(isAudioPlaybackActive(), false);
  });

  it("fires exactly once on start and once on drain across interleaved chunk starts/ends", () => {
    const events: boolean[] = [];
    const unsubscribe = subscribeAudioPlayback((playing) => events.push(playing));

    const s1 = fakeSource();
    const s2 = fakeSource();
    const s3 = fakeSource();

    trackPlaybackStart(s1); // 0 -> 1: notify(true)
    trackPlaybackStart(s2); // 1 -> 2: no notify
    trackPlaybackStart(s3); // 2 -> 3: no notify

    trackPlaybackEnd(s2); // 3 -> 2: no notify
    trackPlaybackEnd(s1); // 2 -> 1: no notify
    trackPlaybackEnd(s3); // 1 -> 0: notify(false)

    assert.deepEqual(events, [true, false], "exactly one start + one drain notification, no per-chunk spam");
    assert.equal(isAudioPlaybackActive(), false);

    unsubscribe();
  });

  it("a source removed twice (already gone) does not re-notify", () => {
    const events: boolean[] = [];
    const unsubscribe = subscribeAudioPlayback((playing) => events.push(playing));

    const s1 = fakeSource();
    trackPlaybackStart(s1);
    trackPlaybackEnd(s1); // drains to 0: notify(false)
    trackPlaybackEnd(s1); // already removed: must be a no-op, not a duplicate false

    assert.deepEqual(events, [true, false]);
    unsubscribe();
  });

  it("resetAudioPlayback notifies false exactly once when sources were active, and is silent when already idle", () => {
    const events: boolean[] = [];
    const unsubscribe = subscribeAudioPlayback((playing) => events.push(playing));

    trackPlaybackStart(fakeSource());
    resetAudioPlayback(); // bulk-clears activeSources -> one drain notify

    assert.deepEqual(events, [true, false]);

    resetAudioPlayback(); // already idle -> no further notify
    assert.deepEqual(events, [true, false]);

    unsubscribe();
  });

  it("unsubscribe stops further notifications", () => {
    const events: boolean[] = [];
    const unsubscribe = subscribeAudioPlayback((playing) => events.push(playing));
    unsubscribe();

    trackPlaybackStart(fakeSource());
    resetAudioPlayback();

    assert.deepEqual(events, []);
  });
});
