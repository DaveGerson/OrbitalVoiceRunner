// tests/test_exchange_flag.ts
//
// AgentExchange spine — the collapsed two-flag design (refactor/collapse-exchange-flags).
// Pins the behavior of src/exchanges/flag.ts (JANUS_EXCHANGE_SPINE: off|record|authoritative,
// with back-compat aliases for the pre-collapse off|shadow|primary spellings) and
// src/exchanges/flagReader.ts's `legacyFlagRetirementWarning` helper (used by
// src/exchanges/instructionEnvelope.ts / src/exchanges/resultEnvelope.ts to warn — never error —
// when an operator still has one of the two now-retired env vars, JANUS_INSTRUCTION_ENVELOPE /
// JANUS_AGENT_RESULT_ENVELOPE, set).
//
// Does NOT duplicate: tests/test_agent_result_envelope.ts (resultEnvelope.ts's own flag-derived
// behavior, JANUS_AGENT_COMPLETION_PROMPT), tests/test_instruction_envelope.ts (pure envelope
// logic, unaffected by this collapse).

import { describe, it } from "node:test";
import assert from "node:assert";

import { readExchangeSpineMode, exchangeSpineWrites, EXCHANGE_SPINE_MODE, type ExchangeSpineMode } from "../src/exchanges/flag";
import { legacyFlagRetirementWarning } from "../src/exchanges/flagReader";

describe("flag.ts: JANUS_EXCHANGE_SPINE — off | record | authoritative (default off)", () => {
  it("defaults to off when unset/empty/unrecognized", () => {
    assert.equal(readExchangeSpineMode({}), "off");
    assert.equal(readExchangeSpineMode({ JANUS_EXCHANGE_SPINE: "" }), "off");
    assert.equal(readExchangeSpineMode({ JANUS_EXCHANGE_SPINE: "bogus" }), "off");
  });

  it("accepts the canonical record/authoritative spellings, case-insensitively", () => {
    assert.equal(readExchangeSpineMode({ JANUS_EXCHANGE_SPINE: "record" }), "record");
    assert.equal(readExchangeSpineMode({ JANUS_EXCHANGE_SPINE: "RECORD" }), "record");
    assert.equal(readExchangeSpineMode({ JANUS_EXCHANGE_SPINE: "authoritative" }), "authoritative");
    assert.equal(readExchangeSpineMode({ JANUS_EXCHANGE_SPINE: "Authoritative" }), "authoritative");
  });

  it("BACK-COMPAT: the pre-collapse 'shadow'/'primary' spellings still work, aliased to record/authoritative", () => {
    assert.equal(readExchangeSpineMode({ JANUS_EXCHANGE_SPINE: "shadow" }), "record", "shadow -> record");
    assert.equal(readExchangeSpineMode({ JANUS_EXCHANGE_SPINE: "SHADOW" }), "record", "case-insensitive alias");
    assert.equal(readExchangeSpineMode({ JANUS_EXCHANGE_SPINE: "primary" }), "authoritative", "primary -> authoritative");
    assert.equal(readExchangeSpineMode({ JANUS_EXCHANGE_SPINE: "PRIMARY" }), "authoritative", "case-insensitive alias");
  });

  // Adversarial-review finding (2026-07): the alias table was a plain object literal, so its string
  // lookup walked Object.prototype — `JANUS_EXCHANGE_SPINE=constructor` / `__proto__` returned a
  // truthy INHERITED member that passed the `if (aliased)` guard and became the "mode". Since every
  // production gate is `mode !== "off"`, those values silently ACTIVATED the whole subsystem (spine
  // writes, envelope recording, boot rehydration, untrusted-output scanning) — fail-OPEN, where the
  // pre-collapse reader validated with includes() and correctly defaulted closed. Fixed by making
  // the table a Map (no prototype chain for string keys). This test pins the fail-CLOSED contract.
  it("FAIL-CLOSED: Object.prototype keys are not aliases — they default to off, never activate", () => {
    for (const attack of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
      const mode = readExchangeSpineMode({ JANUS_EXCHANGE_SPINE: attack });
      assert.equal(mode, "off", `${attack} must default to off, got ${String(mode)}`);
      assert.equal(
        exchangeSpineWrites(mode),
        false,
        `${attack} must NOT activate the spine (fail-closed)`,
      );
    }
  });

  it("the module-cached EXCHANGE_SPINE_MODE is one of the three valid modes (read once at load)", () => {
    const valid: readonly ExchangeSpineMode[] = ["off", "record", "authoritative"];
    assert.ok(valid.includes(EXCHANGE_SPINE_MODE));
  });

  it("exchangeSpineWrites: true for record and authoritative, false for off", () => {
    assert.equal(exchangeSpineWrites("off"), false);
    assert.equal(exchangeSpineWrites("record"), true);
    assert.equal(exchangeSpineWrites("authoritative"), true);
  });
});

describe("flagReader.ts: legacyFlagRetirementWarning — retired-var heads-up, never a crash", () => {
  it("returns null when the legacy var is unset or empty", () => {
    assert.equal(legacyFlagRetirementWarning("JANUS_INSTRUCTION_ENVELOPE", "subsumed.", {}), null);
    assert.equal(legacyFlagRetirementWarning("JANUS_INSTRUCTION_ENVELOPE", "subsumed.", { JANUS_INSTRUCTION_ENVELOPE: "" }), null);
  });

  it("returns a one-line, non-empty warning string when the legacy var is set to ANY value", () => {
    const msg = legacyFlagRetirementWarning("JANUS_INSTRUCTION_ENVELOPE", "subsumed into JANUS_EXCHANGE_SPINE.", {
      JANUS_INSTRUCTION_ENVELOPE: "primary",
    });
    assert.ok(msg && msg.length > 0);
    assert.ok(msg!.includes("JANUS_INSTRUCTION_ENVELOPE"));
    assert.ok(msg!.includes("IGNORED"));
    assert.equal(msg!.includes("\n"), false, "must be a single line");
  });

  it("also fires for a garbage/unrecognized legacy value (presence alone is what matters, not validity)", () => {
    const msg = legacyFlagRetirementWarning("JANUS_AGENT_RESULT_ENVELOPE", "subsumed.", {
      JANUS_AGENT_RESULT_ENVELOPE: "totally-bogus",
    });
    assert.ok(msg);
  });
});
