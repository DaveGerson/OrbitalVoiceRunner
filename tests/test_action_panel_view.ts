// tests/test_action_panel_view.ts
//
// hwu.7: the pure name→view picker behind the read-only ActionPanel. Deterministic mapping — known
// tool names route to their view family, an unknown tool falls to the generic card (never blank/
// crash), a gating-refusal string renders as a refusal (never as cached data), a kind:"pending"
// renders "awaiting approval" (never a completed result), and a truncated payload carries the flag.
//
// Runner: npx tsx --test --test-force-exit tests/test_action_panel_view.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { pickActionView, noteRowsFrom, stringifyOutput } from "../src/orbital/ActionPanel.js";
import type { ActionActivityFrame } from "../src/types.js";

function frame(name: string, payload: ActionActivityFrame["payload"]): ActionActivityFrame {
  return { type: "action_activity", name, callId: "call-1", ts: 1, payload };
}

test("get_status_summary (ok, prose string) → sitrep view carrying the prose body", () => {
  const v = pickActionView(frame("get_status_summary", { kind: "ok", output: "2 items awaiting your approval." }));
  assert.equal(v.view, "sitrep");
  assert.equal(v.title, "Status Summary");
  if (v.view === "sitrep") assert.equal(v.body, "2 items awaiting your approval.");
});

test("search_notes (ok, {results}) → notes view with one row per snippet", () => {
  const v = pickActionView(frame("search_notes", { kind: "ok", output: { query: "auth", count: 2, results: [{ id: "n1", snippet: "auth uses JWT" }, { id: "n2", snippet: "retry on 401" }] } }));
  assert.equal(v.view, "notes");
  if (v.view === "notes") assert.deepEqual(v.rows, ["auth uses JWT", "retry on 401"]);
});

test("get_project_notes (ok, {notes}) → notes view rows from note text", () => {
  const v = pickActionView(frame("get_project_notes", { kind: "ok", output: { project_id: "p", count: 1, notes: [{ id: "n1", text: "decided to ship" }] } }));
  assert.equal(v.view, "notes");
  if (v.view === "notes") assert.deepEqual(v.rows, ["decided to ship"]);
});

test("notes tool that returned a gating-refusal STRING renders a refusal, not a note list", () => {
  const refusal = "Error: the 'read_notes' capability is gated Off; reading note content is forbidden by policy.";
  const v = pickActionView(frame("get_project_notes", { kind: "ok", output: refusal }));
  assert.equal(v.view, "refusal");
  if (v.view === "refusal") assert.equal(v.body, refusal);
});

test("unknown tool name → generic summary card (never blank/crash)", () => {
  const v = pickActionView(frame("some_new_tool_47", { kind: "ok", output: { a: 1, b: [2, 3] } }));
  assert.equal(v.view, "generic");
  assert.equal(v.title, "some_new_tool_47");
  if (v.view === "generic") assert.match(v.body, /"a": 1/);
});

test("kind:pending → awaiting-approval card (deferred write is NOT a completed result)", () => {
  const v = pickActionView(frame("propose_command", { kind: "pending", summary: "run the migration on pane-2" }));
  assert.equal(v.view, "awaiting");
  if (v.view === "awaiting") assert.equal(v.body, "run the migration on pane-2");
});

test("kind:blocked → refusal card with the reason", () => {
  const v = pickActionView(frame("delete_note", { kind: "blocked", reason: "gate is Off" }));
  assert.equal(v.view, "refusal");
  if (v.view === "refusal") assert.equal(v.body, "gate is Off");
});

test("kind:error → error card with the message", () => {
  const v = pickActionView(frame("get_status_summary", { kind: "error", message: "boom" }));
  assert.equal(v.view, "error");
  if (v.view === "error") assert.equal(v.body, "boom");
});

test("truncated ok payload propagates the truncated flag into the view", () => {
  const v = pickActionView(frame("get_status_summary", { kind: "ok", output: "[truncated: 9000 bytes exceeded 8192]", truncated: true }));
  assert.equal(v.view, "sitrep");
  if (v.view === "sitrep") assert.equal(v.truncated, true);
});

test("truncated notes payload (string marker) does NOT masquerade as a refusal", () => {
  // A capped notes read replaces `output` with a string marker + sets truncated. It must not be
  // mislabeled a gating refusal — it falls through to a generic card carrying the truncation flag.
  const v = pickActionView(frame("search_notes", { kind: "ok", output: "[truncated: 9000 bytes exceeded 8192]", truncated: true }));
  assert.equal(v.view, "generic");
  if (v.view === "generic") assert.equal(v.truncated, true);
});

test("empty note list → notes view with zero rows (renders, never crashes)", () => {
  const v = pickActionView(frame("search_notes", { kind: "ok", output: { query: "zzz", count: 0, results: [] } }));
  assert.equal(v.view, "notes");
  if (v.view === "notes") assert.deepEqual(v.rows, []);
});

// ── helper units ────────────────────────────────────────────────────────────

test("noteRowsFrom returns null for non-list output (string / non-object)", () => {
  assert.equal(noteRowsFrom("just a string"), null);
  assert.equal(noteRowsFrom(42), null);
  assert.equal(noteRowsFrom({ foo: "bar" }), null);
});

test("stringifyOutput passes prose through and pretty-prints objects", () => {
  assert.equal(stringifyOutput("hello"), "hello");
  assert.equal(stringifyOutput(null), "");
  assert.match(stringifyOutput({ x: 1 }), /"x": 1/);
});
