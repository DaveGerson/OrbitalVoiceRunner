// Fixture for tests/test_run_unit.ts — a single known-failing test whose REAL TAP output the
// parser test captures and parses. The failing test name "parser_target_fails" is the exact
// string parseTapFailures() must extract from the runner's real "not ok N - <name>" line.
// NOT in the default glob (lives under tests/fixtures/).
import { test } from "node:test";
import assert from "node:assert";

test("parser_target_passes", () => { assert.ok(true); });
test("parser_target_fails", () => { assert.fail("intentional"); });
