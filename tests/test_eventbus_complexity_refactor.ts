/**
 * Behavior-pinning tests for the eventBus complexity-burndown refactor.
 *
 * `effectForEvent` (CC 11) is being brought to <= 10 via verbatim, behavior-preserving
 * extraction. These tests exhaustively pin the CURRENT observable behavior of every
 * branch + edge case so any semantic drift fails GREEN-before / GREEN-after.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  effectForEvent,
  earconForAttention,
  earconForTransition,
} from "../src/eventBus";

describe("effectForEvent — every switch arm pinned", () => {
  it("attention_updated -> setAttentionQueue, earcon derived from queue (alert)", () => {
    const eff = effectForEvent({
      type: "attention_updated",
      queue: [{ type: "error", dismissed: false }],
    });
    assert.deepStrictEqual(eff, { setter: "setAttentionQueue", earcon: "alert" });
  });

  it("attention_updated -> completion when unread but no alert types", () => {
    const eff = effectForEvent({
      type: "attention_updated",
      queue: [{ type: "approval", dismissed: false }],
    });
    assert.deepStrictEqual(eff, { setter: "setAttentionQueue", earcon: "completion" });
  });

  it("attention_updated -> null earcon when queue empty", () => {
    const eff = effectForEvent({ type: "attention_updated", queue: [] });
    assert.deepStrictEqual(eff, { setter: "setAttentionQueue", earcon: null });
  });

  it("attention_updated -> null earcon when queue missing/undefined", () => {
    const eff = effectForEvent({ type: "attention_updated" });
    assert.deepStrictEqual(eff, { setter: "setAttentionQueue", earcon: null });
  });

  it("plans_updated -> setPlans, null", () => {
    assert.deepStrictEqual(effectForEvent({ type: "plans_updated" }), {
      setter: "setPlans",
      earcon: null,
    });
  });

  // wsm-e2e-pinned-33c.4: watch_rules_updated is no longer server-emitted (and never had a real
  // client consumer post d858e5e), so it's dropped from eventBus's mapping table — an unmapped
  // type now falls through to null, same as any other unrecognized event.
  it("watch_rules_updated -> null (no longer mapped; the frame is pruned server-side)", () => {
    assert.strictEqual(effectForEvent({ type: "watch_rules_updated" }), null);
  });

  it("pane_transition -> fetchTerminals, earcon from transition (alert)", () => {
    assert.deepStrictEqual(
      effectForEvent({ type: "pane_transition", transition: "build-failed" }),
      { setter: "fetchTerminals", earcon: "alert" },
    );
  });

  it("pane_transition idle -> fetchTerminals, null (bus owns completion)", () => {
    assert.deepStrictEqual(
      effectForEvent({ type: "pane_transition", transition: "idle" }),
      { setter: "fetchTerminals", earcon: null },
    );
  });

  it("pane_transition with missing transition -> fetchTerminals, null", () => {
    assert.deepStrictEqual(effectForEvent({ type: "pane_transition" }), {
      setter: "fetchTerminals",
      earcon: null,
    });
  });

  it("plan_step_completed -> fetchPlans, execute", () => {
    assert.deepStrictEqual(effectForEvent({ type: "plan_step_completed" }), {
      setter: "fetchPlans",
      earcon: "execute",
    });
  });

  it("plan_completed -> fetchPlans, success", () => {
    assert.deepStrictEqual(effectForEvent({ type: "plan_completed" }), {
      setter: "fetchPlans",
      earcon: "success",
    });
  });

  it("plan_paused -> fetchPlans, alert", () => {
    assert.deepStrictEqual(effectForEvent({ type: "plan_paused" }), {
      setter: "fetchPlans",
      earcon: "alert",
    });
  });

  it("history_updated -> noop, null", () => {
    assert.deepStrictEqual(effectForEvent({ type: "history_updated" }), {
      setter: "noop",
      earcon: null,
    });
  });

  it("watch_rule_suggested -> noop, chime (suggestion only, never writes)", () => {
    assert.deepStrictEqual(effectForEvent({ type: "watch_rule_suggested" }), {
      setter: "noop",
      earcon: "chime",
    });
  });

  it("unknown type -> null", () => {
    assert.strictEqual(effectForEvent({ type: "audio" }), null);
    assert.strictEqual(effectForEvent({ type: "stdout_chunk" }), null);
    assert.strictEqual(effectForEvent({ type: "totally-made-up" }), null);
  });

  it("null / undefined / non-object msg -> null (optional-chaining on msg?.type)", () => {
    assert.strictEqual(effectForEvent(null), null);
    assert.strictEqual(effectForEvent(undefined), null);
    assert.strictEqual(effectForEvent({}), null);
    assert.strictEqual(effectForEvent(42), null);
    assert.strictEqual(effectForEvent("attention_updated"), null);
  });
});

describe("earconForAttention — edge cases pinned", () => {
  it("non-array -> null", () => {
    assert.strictEqual(earconForAttention(undefined), null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.strictEqual(earconForAttention(null as any), null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.strictEqual(earconForAttention("nope" as any), null);
  });

  it("empty array -> null", () => {
    assert.strictEqual(earconForAttention([]), null);
  });

  it("all dismissed -> null", () => {
    assert.strictEqual(
      earconForAttention([{ type: "error", dismissed: true }]),
      null,
    );
  });

  it("filters out falsy items, then sees no unread -> null", () => {
    assert.strictEqual(earconForAttention([null, undefined, false as any]), null);
  });

  it("unread alert types -> alert (error / build-failed / exited)", () => {
    assert.strictEqual(earconForAttention([{ type: "error", dismissed: false }]), "alert");
    assert.strictEqual(earconForAttention([{ type: "build-failed", dismissed: false }]), "alert");
    assert.strictEqual(earconForAttention([{ type: "exited", dismissed: false }]), "alert");
  });

  it("unread non-alert type -> completion", () => {
    assert.strictEqual(earconForAttention([{ type: "approval", dismissed: false }]), "completion");
  });

  it("mixed: any unread alert wins over completion", () => {
    assert.strictEqual(
      earconForAttention([
        { type: "approval", dismissed: false },
        { type: "exited", dismissed: false },
      ]),
      "alert",
    );
  });

  it("dismissed alert + unread non-alert -> completion (dismissed excluded)", () => {
    assert.strictEqual(
      earconForAttention([
        { type: "error", dismissed: true },
        { type: "approval", dismissed: false },
      ]),
      "completion",
    );
  });
});

describe("earconForTransition — edge cases pinned", () => {
  it("alert transitions -> alert", () => {
    assert.strictEqual(earconForTransition("error"), "alert");
    assert.strictEqual(earconForTransition("build-failed"), "alert");
    assert.strictEqual(earconForTransition("exited"), "alert");
  });

  it("idle / prompt / routine / undefined -> null", () => {
    assert.strictEqual(earconForTransition("idle"), null);
    assert.strictEqual(earconForTransition("prompt"), null);
    assert.strictEqual(earconForTransition("routine"), null);
    assert.strictEqual(earconForTransition(undefined), null);
  });
});
