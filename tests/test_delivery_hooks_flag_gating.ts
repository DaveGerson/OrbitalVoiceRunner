// tests/test_delivery_hooks_flag_gating.ts
//
// AgentExchange spine — `mintExchangeForSend` flag gating (src/exchanges/deliveryHooks.ts).
//
// Regression (WP1 dedupe, adversarial review): the pre-consolidation voice lane
// (src/voice/index.ts's `draftEnvelopeJsonForDispatch`) gated open-draft serialization on
// `instructionEnvelopeActive()` — with the (then-independent) envelope flag off, a dispatch NEVER
// stamped `instruction_envelope_json`, even if the pane somehow had an open draft. That guard was
// load-bearing because the compose_draft voice actions (src/actions/defs/voice_ux.ts) can register
// an open draft REGARDLESS of the envelope flag ("flag off => registry empty" does not hold).
//
// FLAG COLLAPSE (2026-07, refactor/collapse-exchange-flags): JANUS_INSTRUCTION_ENVELOPE is retired
// — instruction-envelope mode is now 1:1 DERIVED from JANUS_EXCHANGE_SPINE (flag.ts's FLAG
// LATTICE), so "spine on, envelope off" is no longer a reachable combination; the original
// regression's precondition is now structurally impossible; `deliveryHooks.ts`'s own doc comment
// documents the resulting simplification (the now-always-true `instructionEnvelopeActive()` guard
// was removed as dead weight, not kept). This suite is updated INTENTIONALLY to pin the new
// invariant that actually matters post-collapse: an open draft is serialized whenever the spine is
// on (record OR authoritative — scanning/envelope activity does not distinguish the two rungs), and
// nothing is minted at all — so nothing CAN be serialized — when the spine is off.
//
// Process isolation: `node --test` runs each test FILE as its own process, and `EXCHANGE_SPINE_MODE`
// freezes at module load — so the env is set here, BEFORE any runtime import of the flag-reading
// modules (static imports below are type-only and erased; everything real is dynamically imported
// after the assignment — the documented pattern, see tests/test_instruction_routing_journeys.ts).

import { describe, it, after } from "node:test";
import assert from "node:assert";

process.env.JANUS_EXCHANGE_SPINE = "record"; // spine ON (record rung) — exchanges are minted + mirrored

const { mintExchangeForSend } = await import("../src/exchanges/deliveryHooks");
const { initExchangeSpineOnBoot, resetExchangeServiceForTests } = await import("../src/exchanges/spine");
const { setOpenDraft, getOpenDraft, resetDraftRegistryForTests } = await import("../src/exchanges/draftRegistry");
const { createDraft, buildEnvelope, instructionEnvelopeActive } = await import("../src/exchanges/instructionEnvelope");
const { JanusStore } = await import("../src/store/sqliteStore");

describe("mintExchangeForSend: post-collapse — spine on implies envelope on, by construction", () => {
  after(() => {
    resetExchangeServiceForTests();
    resetDraftRegistryForTests();
  });

  it("precondition: with JANUS_EXCHANGE_SPINE=record, instructionEnvelopeActive() is ALSO true (derived 1:1 from the spine mode)", () => {
    assert.strictEqual(instructionEnvelopeActive(), true, "post-collapse: envelope mode mirrors the spine mode, frozen together in this process");
  });

  it("an open draft in the registry IS serialized into instruction_envelope_json when the spine is on", () => {
    const store = new JanusStore(":memory:");
    store.init();
    initExchangeSpineOnBoot(store);

    // Mirrors what the (spine-agnostic) compose_draft voice action does: register an open draft
    // for the pane. Under the pre-collapse design this could happen with the envelope flag OFF
    // while the spine was ON — that combination no longer exists, so this draft is now guaranteed
    // to serialize whenever the spine (hence the derived envelope mode) is on.
    setOpenDraft("p1", "pane-1", createDraft({
      target: { projectId: "p1", paneId: "pane-1" },
      envelope: buildEnvelope({ objective: "fix the bug" }),
    }));
    assert.ok(getOpenDraft("p1", "pane-1"), "precondition: the registry really holds an open draft");

    const exchangeId = mintExchangeForSend({
      projectId: "p1", paneId: "pane-1",
      operatorUtterance: "trigger", distilledInstruction: "fix the bug",
    });

    assert.ok(exchangeId, "spine is on — an exchange IS minted");
    const row = store.getExchange(exchangeId!)!;
    assert.notStrictEqual(
      row.instruction_envelope_json, "{}",
      "spine on => derived envelope mode on => the open draft IS serialized, not left at the schema default",
    );
    const parsed = JSON.parse(row.instruction_envelope_json!);
    assert.strictEqual(parsed.kind, "envelope_draft");
    assert.strictEqual(parsed.envelope.objective, "fix the bug");
    store.close();
  });

  it("a pane with NO open draft still mints an exchange, with instruction_envelope_json left at its schema default", () => {
    const store = new JanusStore(":memory:");
    store.init();
    initExchangeSpineOnBoot(store);

    assert.strictEqual(getOpenDraft("p1", "pane-2"), undefined, "precondition: no open draft for this pane");
    const exchangeId = mintExchangeForSend({
      projectId: "p1", paneId: "pane-2",
      operatorUtterance: "trigger", distilledInstruction: "run the tests",
    });
    assert.ok(exchangeId);
    const row = store.getExchange(exchangeId!)!;
    assert.strictEqual(row.instruction_envelope_json, "{}", "no open draft => nothing to serialize => schema default");
    store.close();
  });
});
