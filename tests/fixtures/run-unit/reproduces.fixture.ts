// Fixture for tests/test_run_unit.ts — a DETERMINISTIC failure that reproduces on every run.
// The wrapper must RED on this (the failure is in the intersection of both legs). This stands in
// for a genuine assertion regression. NOT in the default glob (lives under tests/fixtures/).
import { test } from "node:test";
import assert from "node:assert";

test("reproduces_pass", () => { assert.equal(1, 1); });
test("reproduces_fail_always", () => { assert.equal(1, 2, "this always fails"); });
