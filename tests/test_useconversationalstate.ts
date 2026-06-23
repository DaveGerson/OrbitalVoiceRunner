// tests/test_useconversationalstate.ts
//
// Velocity-design layer (operator decision D7): the conversational pill's STATE MACHINE.
// Written FIRST (TDD RED) to pin every transition of deriveConversationalState() — the pure
// reducer that the useConversationalState hook wraps. The pill's discrete state is derived
// ONLY from the voice-channel booleans the data layer already computes (live / connected /
// micBlocked / muted / reconnecting) plus tool-call activity surfaced through the transcript's
// grounding sources (the "activeSources" signal). No React, no rendering — the machine is pure.
//
// IMPORT STRATEGY: useConversationalState.ts imports React (useMemo) for the thin hook wrapper,
// but the pure deriveConversationalState/hasToolActivity exports pull in nothing transitive (no
// primitives.tsx / icons.svg?raw), so this loads directly like station.ts's test — no resolve hook.
//
// Runner: npx tsx --test --test-force-exit tests/test_useconversationalstate.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveConversationalState,
  hasToolActivity,
  type ConversationalSignals,
  type ConversationalState,
} from "../src/orbital/useConversationalState";
import type { TranscriptEntry } from "../src/orbital/useOrbitalData";

// ── builders ───────────────────────────────────────────────────────────────
function sig(over: Partial<ConversationalSignals> = {}): ConversationalSignals {
  return {
    live: true,
    connected: true,
    micBlocked: false,
    muted: false,
    reconnecting: false,
    toolActive: false,
    ...over,
  };
}

function entry(over: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    sender: "Janus",
    text: "heard, chef",
    timestamp: new Date(),
    ...over,
  } as TranscriptEntry;
}

// ── deriveConversationalState — the transition table ─────────────────────────

describe("deriveConversationalState", () => {
  it("not live → offline (off air), whatever else is set", () => {
    const s: ConversationalState = deriveConversationalState(sig({ live: false }));
    assert.equal(s.kind, "offline");
    // not-live dominates: connected/toolActive can't promote it
    assert.equal(deriveConversationalState(sig({ live: false, connected: true, toolActive: true })).kind, "offline");
  });

  it("live + mic blocked → blocked (named loudly, never 'listening')", () => {
    assert.equal(deriveConversationalState(sig({ micBlocked: true })).kind, "blocked");
    // blocked outranks muted and tool activity
    assert.equal(deriveConversationalState(sig({ micBlocked: true, muted: true, toolActive: true })).kind, "blocked");
  });

  it("live but socket not open → tuning (between the click and the open)", () => {
    assert.equal(deriveConversationalState(sig({ connected: false })).kind, "tuning");
    // reconnecting while not yet open is still tuning
    assert.equal(deriveConversationalState(sig({ connected: false, reconnecting: true })).kind, "tuning");
  });

  it("live + connected + muted → muted (mic held, session intact)", () => {
    assert.equal(deriveConversationalState(sig({ muted: true })).kind, "muted");
    // tool activity must NOT override an explicitly muted mic
    assert.equal(deriveConversationalState(sig({ muted: true, toolActive: true })).kind, "muted");
  });

  it("fully live + tool activity → thinking (a tool/grounding call is in flight)", () => {
    assert.equal(deriveConversationalState(sig({ toolActive: true })).kind, "thinking");
  });

  it("fully live, idle → listening (the steady-state ready ear)", () => {
    assert.equal(deriveConversationalState(sig()).kind, "listening");
  });

  it("precedence is total & ordered: offline > blocked > tuning > muted > thinking > listening", () => {
    // each higher-precedence flag wins even when every lower signal is also asserted
    assert.equal(deriveConversationalState(sig({ live: false, micBlocked: true, connected: false, muted: true, toolActive: true })).kind, "offline");
    assert.equal(deriveConversationalState(sig({ micBlocked: true, connected: false, muted: true, toolActive: true })).kind, "blocked");
    assert.equal(deriveConversationalState(sig({ connected: false, muted: true, toolActive: true })).kind, "tuning");
    assert.equal(deriveConversationalState(sig({ muted: true, toolActive: true })).kind, "muted");
    assert.equal(deriveConversationalState(sig({ toolActive: true })).kind, "thinking");
  });

  it("every state carries a stable, non-empty label", () => {
    const kinds: ConversationalState["kind"][] = ["offline", "blocked", "tuning", "muted", "thinking", "listening"];
    const seen = new Set<string>();
    for (const k of kinds) {
      // build a signals object that resolves to exactly k via precedence
      const map: Record<ConversationalState["kind"], ConversationalSignals> = {
        offline: sig({ live: false }),
        blocked: sig({ micBlocked: true }),
        tuning: sig({ connected: false }),
        muted: sig({ muted: true }),
        thinking: sig({ toolActive: true }),
        listening: sig(),
      };
      const st = deriveConversationalState(map[k]);
      assert.equal(st.kind, k);
      assert.equal(typeof st.label, "string");
      assert.ok(st.label.length > 0, `label for ${k} must be non-empty`);
      assert.ok(!seen.has(st.label), `label for ${k} must be distinct`);
      seen.add(st.label);
    }
  });
});

// ── hasToolActivity — the "activeSources / tool-call" signal off the transcript ──

describe("hasToolActivity", () => {
  it("empty transcript → false", () => {
    assert.equal(hasToolActivity([]), false);
  });

  it("plain turns with no grounding → false", () => {
    assert.equal(hasToolActivity([entry(), entry({ sender: "User", text: "hey chef" })]), false);
  });

  it("most-recent turn carries grounded sources → true (a tool call just ran)", () => {
    const t = [
      entry(),
      entry({ grounding: { queries: ["retry policy"], sources: [{ uri: "https://x", title: "X" }] } }),
    ];
    assert.equal(hasToolActivity(t), true);
  });

  it("only an OLDER turn was grounded → false (activity is about the freshest turn)", () => {
    const t = [
      entry({ grounding: { queries: ["q"], sources: [{ uri: "https://x", title: "X" }] } }),
      entry({ text: "and here's the plan" }),
    ];
    assert.equal(hasToolActivity(t), false);
  });

  it("grounding present but with zero sources → false (no tool actually resolved)", () => {
    const t = [entry({ grounding: { queries: ["q"], sources: [] } })];
    assert.equal(hasToolActivity(t), false);
  });

  it("a User turn cannot signal tool activity (only Janus runs tools)", () => {
    const t = [entry({ sender: "User", text: "do the thing", grounding: { queries: ["q"], sources: [{ uri: "https://x", title: "X" }] } })];
    assert.equal(hasToolActivity(t), false);
  });

  it("undefined transcript is treated as empty → false", () => {
    assert.equal(hasToolActivity(undefined as unknown as TranscriptEntry[]), false);
  });
});
