// tests/test_durable_action_version.ts
//
// PLM3 durable-closure VERSION GUARD (F3 core). A deferred action persists only its serializable
// INTENT and rebuilds its non-serializable run() closure on boot (buildActionRun). That rebuild
// silently assumes the action's identity+shape is unchanged across the restart. The version guard
// makes a mismatch DETECTABLE: actionSchemaHash() is a stable hash of { name, capability, sorted
// param keys }; an intent stamps the hash it was minted against; checkActionVersion() quarantines a
// rehydrated intent whose stamp no longer matches (re-confirm instead of blind replay).
//
// PURE unit test: imports ../src/actions/registry + ../src/actionEffects ONLY (never ../server —
// importing the server boots a real listener). No server boot, no PTY, no SQLite.

import { describe, it } from "node:test";
import assert from "node:assert";
import { actionSchemaHash, REGISTRY_SCHEMA_HASHES } from "../src/actions/registry";
import { checkActionVersion } from "../src/actionEffects";

describe("PLM3 F3 — actionSchemaHash is stable + identity-discriminating", () => {
  it("(a) is STABLE across repeated calls for a real action (amend_note)", () => {
    const h1 = actionSchemaHash("amend_note");
    const h2 = actionSchemaHash("amend_note");
    assert.ok(h1, "amend_note must hash to a non-null value");
    assert.strictEqual(h1, h2, "the same action hashes identically on every call (deterministic)");
    // Determinism is the property boot N+1 relies on to validate an intent stamped by boot N.
    assert.match(h1 as string, /^[0-9a-f]{8}$/, "hash is fixed 8-char lowercase hex");
  });

  it("(a) DIFFERS between two distinct actions (amend_note vs list_panes)", () => {
    const amend = actionSchemaHash("amend_note");
    const list = actionSchemaHash("list_panes");
    assert.ok(amend && list, "both must be real actions");
    assert.notStrictEqual(amend, list, "different identity/shape -> different hash");
  });

  it("returns null for a name not in the registry", () => {
    assert.strictEqual(actionSchemaHash("definitely_not_a_real_action"), null);
  });

  it("REGISTRY_SCHEMA_HASHES agrees with actionSchemaHash by construction", () => {
    assert.strictEqual(REGISTRY_SCHEMA_HASHES["amend_note"], actionSchemaHash("amend_note"));
    assert.strictEqual(REGISTRY_SCHEMA_HASHES["list_panes"], actionSchemaHash("list_panes"));
    assert.ok(Object.keys(REGISTRY_SCHEMA_HASHES).length >= 6, "bulk map covers the registry");
  });
});

describe("PLM3 F3 — checkActionVersion quarantine gate", () => {
  it("(b) ok=true for a correctly-stamped current intent", () => {
    const stamp = { actionName: "amend_note", schemaHash: actionSchemaHash("amend_note") as string };
    const res = checkActionVersion(stamp);
    assert.deepStrictEqual(res, { ok: true });
  });

  it("(c) ok=false reason=schema_changed for a known action with a mismatched hash", () => {
    const res = checkActionVersion({ actionName: "amend_note", schemaHash: "deadbeef" });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, "schema_changed");
  });

  it("(c') a known action with NO stamped hash is also schema_changed (partial/legacy stamp is unsafe)", () => {
    const res = checkActionVersion({ actionName: "amend_note" });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, "schema_changed");
  });

  it("(d) ok=false reason=unknown_action for a name not in the registry", () => {
    const res = checkActionVersion({ actionName: "ghost_action", schemaHash: "deadbeef" });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, "unknown_action");
  });

  it("(d') a legacy row with NO actionName is unknown_action (re-confirm, never blind replay)", () => {
    const res = checkActionVersion({});
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, "unknown_action");
  });
});
