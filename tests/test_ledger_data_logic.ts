// tests/test_ledger_data_logic.ts — characterization tests for the ledger-data response normalizers
// (bead wsm-e2e-pinned-4ib). These PIN the current inline-fetcher behavior BEFORE the useLedgerData
// extraction, so the suite goes red the instant the move alters how a fetched body is normalized.
// node:test (pure logic; the I/O fetchers themselves are covered by the REST-preservation smoke in
// src/ledgerData.rest.test.tsx and pixel parity in the Playwright mock lane).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeProjectNotes,
  normalizeFrozenStatus,
  normalizeArchive,
  globalModeFromSettings,
} from "../src/classic/helpers/ledgerDataLogic";

test("normalizeProjectNotes: passes a real array through untouched", () => {
  const notes = [{ id: "n1", text: "hi" }];
  assert.equal(normalizeProjectNotes({ notes }), notes);
});

test("normalizeProjectNotes: non-array / missing -> []", () => {
  assert.deepEqual(normalizeProjectNotes({ notes: "nope" as unknown as undefined }), []);
  assert.deepEqual(normalizeProjectNotes({}), []);
  assert.deepEqual(normalizeProjectNotes({ notes: null as unknown as undefined }), []);
});

test("normalizeFrozenStatus: coerces frozen to a hard boolean", () => {
  assert.deepEqual(normalizeFrozenStatus({ frozen: true, running: [] }), { frozen: true, running: [] });
  assert.deepEqual(normalizeFrozenStatus({ frozen: 1 as unknown as boolean, running: [] }), { frozen: true, running: [] });
  assert.deepEqual(normalizeFrozenStatus({ frozen: undefined, running: [] }), { frozen: false, running: [] });
  assert.deepEqual(normalizeFrozenStatus({}), { frozen: false, running: [] });
});

test("normalizeFrozenStatus: running falls back to [] for any non-array body", () => {
  const running = ["p1", "p2"];
  assert.equal(normalizeFrozenStatus({ frozen: true, running }).running, running);
  assert.deepEqual(normalizeFrozenStatus({ frozen: true, running: "p1" as unknown as string[] }).running, []);
  assert.deepEqual(normalizeFrozenStatus({ frozen: true }).running, []);
});

test("normalizeArchive: unwraps data.archived, else []", () => {
  const archived = [{ id: "a1" }];
  assert.equal(normalizeArchive({ archived }), archived);
  assert.deepEqual(normalizeArchive({}), []);
  assert.deepEqual(normalizeArchive({ archived: undefined }), []);
});

test("globalModeFromSettings: applies the mode when advanced present, skips otherwise", () => {
  assert.deepEqual(globalModeFromSettings({ advanced: { globalPermissionsMode: "Full Auto" } }), { apply: true, mode: "Full Auto" });
  // advanced present but no mode -> apply=true with mode undefined (inline calls setter with undefined).
  assert.deepEqual(globalModeFromSettings({ advanced: {} }), { apply: true, mode: undefined });
  // No `advanced` block -> apply=false == "leave the current mode unchanged" (the inline `if` guard).
  assert.deepEqual(globalModeFromSettings({}), { apply: false, mode: undefined });
});
