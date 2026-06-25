// tests/test_telemetry_voice_transcript.ts — CHARACTERIZATION tests for the pure helpers hoisted
// during the chunk-3 "telemetry-voice-transcript" extraction of src/App.tsx (bead dbt4). Four
// sibling surfaces (TerminalHealthHeatmap, SynergyMatrixPanel, TranscriptPanel, SystemStatusBar)
// moved to src/classic/components/; the small inline `?:`/`||`/regex derivations they carried are
// now PURE helpers in src/appHelpers so they can be unit-pinned without jsdom.
//
// These pins assert the EXACT branch lattice and BYTE-EXACT output strings of every newly-hoisted
// helper, so the behavior-preserving extraction changes nothing observable. The voice-label pin in
// particular guards the FORBIDDEN behavior change: the Synergy panel's "AGENT STATUS" strings are
// DISTINCT from the header's geminiVoiceLabel and must NOT collapse to it.
//
// Imports the REAL helpers (../src/appHelpers) — never ../App.
//
// Runner: npx tsx --test --test-force-exit tests/test_telemetry_voice_transcript.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  voiceAgentStatusLabel,
  geminiVoiceLabel,
  specBufferBadge,
  heatmapSnippetLines,
  transcriptSourceLabel,
} from "../src/appHelpers";

// ═════════════════════════════════════════════════════════════════════════════
// voiceAgentStatusLabel — the Synergy panel "AGENT STATUS" line. DISTINCT strings
// from the header's geminiVoiceLabel; live > reconnect > mute > offline.
// ═════════════════════════════════════════════════════════════════════════════
describe("appHelpers — voiceAgentStatusLabel (synergy AGENT STATUS)", () => {
  it("renders the four byte-exact synergy strings (live > reconnect > mute > offline)", () => {
    // offline ignores the reconnect/mute flags
    assert.strictEqual(voiceAgentStatusLabel(false, false, false), "Offline (Mic Standby)");
    assert.strictEqual(voiceAgentStatusLabel(false, true, true), "Offline (Mic Standby)");
    // live: reconnect wins over mute
    assert.strictEqual(voiceAgentStatusLabel(true, true, false), "AI Reconnecting...");
    assert.strictEqual(voiceAgentStatusLabel(true, true, true), "AI Reconnecting...");
    // live, not reconnecting, muted
    assert.strictEqual(voiceAgentStatusLabel(true, false, true), "Muted (Zephyr Listening)");
    // live, not reconnecting, unmuted
    assert.strictEqual(voiceAgentStatusLabel(true, false, false), "Zephyr Voice Agent Live");
  });

  it("does NOT match the header geminiVoiceLabel for any input (distinct surfaces)", () => {
    for (const live of [true, false]) {
      for (const recon of [true, false]) {
        for (const mute of [true, false]) {
          assert.notStrictEqual(
            voiceAgentStatusLabel(live, recon, mute),
            geminiVoiceLabel(live, recon, mute),
            `synergy label collapsed to header label for (${live},${recon},${mute})`,
          );
        }
      }
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// specBufferBadge — the Spec Buffer char-count badge.
// ═════════════════════════════════════════════════════════════════════════════
describe("appHelpers — specBufferBadge", () => {
  it('"<n> Chars" when non-empty, "Empty" when empty', () => {
    assert.strictEqual(specBufferBadge(""), "Empty");
    assert.strictEqual(specBufferBadge("a"), "1 Chars");
    assert.strictEqual(specBufferBadge("hello"), "5 Chars");
    // multi-byte length is .length (UTF-16 code units), verbatim
    assert.strictEqual(specBufferBadge("héllo"), "5 Chars");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// heatmapSnippetLines — last 4 trimmed stdout lines, or [] when no output.
// ═════════════════════════════════════════════════════════════════════════════
describe("appHelpers — heatmapSnippetLines", () => {
  it("returns [] for undefined or empty output", () => {
    assert.deepStrictEqual(heatmapSnippetLines(undefined), []);
    // "" is falsy → [] (matches the original `output ? … : []`)
    assert.deepStrictEqual(heatmapSnippetLines(""), []);
  });

  it("trims then takes the LAST four lines", () => {
    assert.deepStrictEqual(heatmapSnippetLines("a\nb\nc"), ["a", "b", "c"]);
    assert.deepStrictEqual(heatmapSnippetLines("1\n2\n3\n4\n5\n6"), ["3", "4", "5", "6"]);
  });

  it("trims leading/trailing whitespace of the whole string before splitting", () => {
    // leading + trailing blank lines are trimmed off the whole blob first
    assert.deepStrictEqual(heatmapSnippetLines("\n\nx\ny\n\n"), ["x", "y"]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// transcriptSourceLabel — title || host(uri), scheme + path stripped.
// ═════════════════════════════════════════════════════════════════════════════
describe("appHelpers — transcriptSourceLabel", () => {
  it("prefers a non-empty title verbatim", () => {
    assert.strictEqual(
      transcriptSourceLabel({ uri: "https://example.com/x", title: "Example" }),
      "Example",
    );
  });

  it("falls back to the bare host when title is empty (scheme + path stripped)", () => {
    assert.strictEqual(
      transcriptSourceLabel({ uri: "https://example.com/foo/bar", title: "" }),
      "example.com",
    );
    assert.strictEqual(
      transcriptSourceLabel({ uri: "http://news.site.org/2026/a", title: "" }),
      "news.site.org",
    );
    // no path → just strips the scheme
    assert.strictEqual(
      transcriptSourceLabel({ uri: "https://bare.host", title: "" }),
      "bare.host",
    );
  });
});
