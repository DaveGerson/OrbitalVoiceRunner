// Fixture for tests/test_run_unit.ts — a fully clean suite (all tests pass).
// NOT part of the default tests/*.ts glob (lives under tests/fixtures/); invoked explicitly by
// the wrapper test via scripts/run-unit.mjs with this file as the args glob.
import { test } from "node:test";
import assert from "node:assert";

test("clean_fixture_a", () => { assert.equal(1, 1); });
test("clean_fixture_b", () => { assert.equal(2, 2); });
