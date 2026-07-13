// tests/test_delivery_hooks_flag_gating.ts
//
// AgentExchange spine — `mintExchangeForSend` flag gating (src/exchanges/deliveryHooks.ts).
//
// Regression (WP1 dedupe, adversarial review): the pre-consolidation voice lane
// (src/voice/index.ts's `draftEnvelopeJsonForDispatch`) gated open-draft serialization on
// `instructionEnvelopeActive()` — with JANUS_INSTRUCTION_ENVELOPE off, a dispatch NEVER stamped
// `instruction_envelope_json`, even if the pane somehow had an open draft. That guard is
// load-bearing because the compose_draft voice actions (src/actions/defs/voice_ux.ts) can register
// an open draft REGARDLESS of the envelope flag ("flag off => registry empty" does not hold). The
// first consolidated `mintExchangeForSend` read the registry unconditionally; this suite pins the
// restored gate.
//
// Process isolation: `node --test` runs each test FILE as its own process, and both flag constants
// (EXCHANGE_SPINE_MODE, INSTRUCTION_ENVELOPE_MODE) freeze at module load — so the env is set here,
// BEFORE any runtime import of the flag-reading modules (static imports below are type-only and
// erased; everything real is dynamically imported after the assignments — the documented pattern,
// see tests/test_instruction_routing_journeys.ts).

import { describe, it, after } from "node:test";
import assert from "node:assert";

process.env.JANUS_EXCHANGE_SPINE = "shadow";        // spine ON — exchanges are minted + mirrored
delete process.env.JANUS_INSTRUCTION_ENVELOPE;      // envelope OFF — the mode under test

const { mintExchangeForSend } = await import("../src/exchanges/deliveryHooks");
const { initExchangeSpineOnBoot, resetExchangeServiceForTests } = await import("../src/exchanges/spine");
const { setOpenDraft, getOpenDraft, resetDraftRegistryForTests } = await import("../src/exchanges/draftRegistry");
const { createDraft, buildEnvelope, instructionEnvelopeActive } = await import("../src/exchanges/instructionEnvelope");
const { JanusStore } = await import("../src/store/sqliteStore");

describe("mintExchangeForSend: envelope flag OFF never stamps instruction_envelope_json", () => {
  after(() => {
    resetExchangeServiceForTests();
    resetDraftRegistryForTests();
  });

  it("an open draft in the registry is IGNORED when JANUS_INSTRUCTION_ENVELOPE is off", () => {
    assert.strictEqual(instructionEnvelopeActive(), false, "precondition: envelope mode frozen off in this process");
    const store = new JanusStore(":memory:");
    store.init();
    initExchangeSpineOnBoot(store);

    // Simulate what the (envelope-flag-agnostic) compose_draft voice action can do: register an
    // open draft for the pane even though the envelope flag is off.
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
    assert.strictEqual(
      row.instruction_envelope_json, "{}",
      "envelope flag off => the column stays at its schema default; the open draft must NOT be serialized",
    );
    store.close();
  });
});
