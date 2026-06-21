// tests/test_terminalwindow_complexity_refactor.ts — CHARACTERIZATION tests for the
// cyclomatic-complexity burndown refactor of src/orbital/TerminalWindow.tsx.
//
// HistoryRow  : CC 14 → 8  (extracted formatHistoryTimestamp, buildHistoryOutputText)
// TerminalWindow: CC 30 → 9  (extracted 5 pure helpers + 5 inline render-helper fns)
//
// This file pins every branch of the SIX pure helpers exported from the module:
//   formatHistoryTimestamp   — timestamp parse/format with try/catch + isNaN guard
//   buildHistoryOutputText   — output trim, 4000-char truncation, empty fallback, finalResponse append
//   deriveStatusLineText     — 4-branch status text for the pane header bar
//   derive86Title            — Exited vs. live 86-button title
//   derive86ButtonStyle      — confirm86 toggles background + color
//   derive86ButtonLabel      — confirm86 toggles label text
//   resolveNoteTicketKey     — maps note type → TICKET_KINDS key
//
// Runner: npx tsx --test --test-force-exit tests/test_terminalwindow_complexity_refactor.ts

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatHistoryTimestamp,
  buildHistoryOutputText,
  deriveStatusLineText,
  derive86Title,
  derive86ButtonStyle,
  derive86ButtonLabel,
  resolveNoteTicketKey,
} from "../src/orbital/terminalWindowHelpers";

// ─────────────────────────────────────────────────────────────────────────────
// 1. formatHistoryTimestamp
// ─────────────────────────────────────────────────────────────────────────────
describe("formatHistoryTimestamp", () => {
  it("returns a locale time string for a valid ISO timestamp", () => {
    const ts = "2024-03-15T10:30:00.000Z";
    const result = formatHistoryTimestamp(ts);
    // Must differ from the raw input (was formatted) and be a non-empty string
    assert.ok(typeof result === "string" && result.length > 0);
    // The raw ISO string should no longer be returned verbatim (it gets formatted)
    assert.notEqual(result, ts);
  });

  it("returns the raw string for a non-date string (falls back to raw)", () => {
    const raw = "not-a-date";
    assert.equal(formatHistoryTimestamp(raw), raw);
  });

  it("returns the raw string for an empty string (falls back to raw)", () => {
    assert.equal(formatHistoryTimestamp(""), "");
  });

  it("returns the raw string for a numeric-only string that produces NaN", () => {
    // "NaN" passed to new Date → invalid date → falls back to raw
    const raw = "NaN";
    assert.equal(formatHistoryTimestamp(raw), raw);
  });

  it("correctly formats a Unix epoch timestamp string", () => {
    // new Date("1970-01-01T00:00:00.000Z") is a valid date → gets formatted
    const ts = "1970-01-01T00:00:00.000Z";
    const result = formatHistoryTimestamp(ts);
    assert.ok(typeof result === "string" && result.length > 0);
    assert.notEqual(result, ts);
  });

  it("returns a locale time string for an RFC 2822 timestamp", () => {
    // Most JS engines can parse "Thu, 01 Jan 2015 00:00:00 GMT"
    const ts = "Thu, 01 Jan 2015 00:00:00 GMT";
    const result = formatHistoryTimestamp(ts);
    assert.ok(typeof result === "string" && result.length > 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. buildHistoryOutputText
// ─────────────────────────────────────────────────────────────────────────────
describe("buildHistoryOutputText", () => {
  it("returns '(no recorded output)' when output is undefined", () => {
    assert.equal(buildHistoryOutputText(undefined, undefined), "(no recorded output)");
  });

  it("returns '(no recorded output)' when output is empty string", () => {
    assert.equal(buildHistoryOutputText("", undefined), "(no recorded output)");
  });

  it("returns '(no recorded output)' when output is whitespace only", () => {
    assert.equal(buildHistoryOutputText("   \n  ", undefined), "(no recorded output)");
  });

  it("returns the trimmed output when it is short (≤4000 chars)", () => {
    const output = "  hello world  ";
    assert.equal(buildHistoryOutputText(output, undefined), "hello world");
  });

  it("returns only the last 4000 chars when output exceeds 4000 chars", () => {
    const output = "x".repeat(5000);
    const result = buildHistoryOutputText(output, undefined);
    // The trim doesn't change "x".repeat(5000), so it should slice to last 4000
    assert.equal(result.length, 4000);
    assert.equal(result, "x".repeat(4000));
  });

  it("returns exactly 4000 chars (boundary — not truncated)", () => {
    const output = "y".repeat(4000);
    const result = buildHistoryOutputText(output, undefined);
    assert.equal(result, output);
    assert.equal(result.length, 4000);
  });

  it("appends finalResponse separated by newline+dash when present", () => {
    const result = buildHistoryOutputText("cmd output", "Task complete");
    assert.equal(result, "cmd output\n— Task complete");
  });

  it("does NOT append anything when finalResponse is undefined", () => {
    const result = buildHistoryOutputText("some output", undefined);
    assert.equal(result, "some output");
    assert.ok(!result.includes("—"));
  });

  it("does NOT append anything when finalResponse is empty string", () => {
    // empty string is falsy → no append
    const result = buildHistoryOutputText("some output", "");
    assert.equal(result, "some output");
  });

  it("'(no recorded output)' + finalResponse appended correctly", () => {
    const result = buildHistoryOutputText(undefined, "Done");
    assert.equal(result, "(no recorded output)\n— Done");
  });

  it("truncation + finalResponse: truncates THEN appends", () => {
    const output = "a".repeat(5000);
    const result = buildHistoryOutputText(output, "end");
    assert.ok(result.startsWith("a".repeat(4000)));
    assert.ok(result.endsWith("\n— end"));
    assert.equal(result, "a".repeat(4000) + "\n— end");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. deriveStatusLineText
// ─────────────────────────────────────────────────────────────────────────────
describe("deriveStatusLineText", () => {
  it("returns 'live on the burner' when live=true (regardless of status)", () => {
    assert.equal(deriveStatusLineText("Running", true), "live on the burner");
    assert.equal(deriveStatusLineText("Exited", true), "live on the burner");
  });

  it("returns 'process ended' when live=false and status='Exited'", () => {
    assert.equal(deriveStatusLineText("Exited", false), "process ended");
  });

  it("returns 'waiting on you, Chef' when live=false and status='Needs Input'", () => {
    assert.equal(deriveStatusLineText("Needs Input", false), "waiting on you, Chef");
  });

  it("returns 'idle — prompt ready' for any other status when live=false", () => {
    assert.equal(deriveStatusLineText("Idle", false), "idle — prompt ready");
    assert.equal(deriveStatusLineText("Running", false), "idle — prompt ready");
    assert.equal(deriveStatusLineText("Unknown", false), "idle — prompt ready");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. derive86Title
// ─────────────────────────────────────────────────────────────────────────────
describe("derive86Title", () => {
  it("returns the 'already exited' title when status is 'Exited'", () => {
    const title = derive86Title("Exited");
    assert.ok(title.includes("already exited"), `expected 'already exited' in: ${title}`);
    assert.ok(title.includes("recoverable"), `expected 'recoverable' in: ${title}`);
  });

  it("returns the 'stop the process' title for non-Exited statuses", () => {
    for (const status of ["Running", "Idle", "Needs Input"]) {
      const title = derive86Title(status);
      assert.ok(title.includes("stop the process"), `expected 'stop the process' in: ${title} (status=${status})`);
      assert.ok(title.includes("recoverable"), `expected 'recoverable' in: ${title}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. derive86ButtonStyle
// ─────────────────────────────────────────────────────────────────────────────
describe("derive86ButtonStyle", () => {
  it("returns confirming style (red bg, light text) when confirm86=true", () => {
    const s = derive86ButtonStyle(true);
    assert.equal(s.background, "#e23a3a");
    assert.equal(s.color, "#fff4de");
  });

  it("returns default style (light bg, dark red text) when confirm86=false", () => {
    const s = derive86ButtonStyle(false);
    assert.equal(s.background, "#fff4de");
    assert.equal(s.color, "#a8151a");
  });

  it("returns an object with exactly background and color keys", () => {
    const keys = Object.keys(derive86ButtonStyle(false));
    assert.deepEqual(keys.sort(), ["background", "color"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. derive86ButtonLabel
// ─────────────────────────────────────────────────────────────────────────────
describe("derive86ButtonLabel", () => {
  it("returns confirm message when confirm86=true", () => {
    assert.equal(derive86ButtonLabel(true), "Sure, Chef? Tap again");
  });

  it("returns default label when confirm86=false", () => {
    assert.equal(derive86ButtonLabel(false), "86 this station");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. resolveNoteTicketKey
// ─────────────────────────────────────────────────────────────────────────────
describe("resolveNoteTicketKey", () => {
  it("maps 'warning' → 'bug'", () => {
    assert.equal(resolveNoteTicketKey("warning"), "bug");
  });

  it("maps 'todo' → 'todo'", () => {
    assert.equal(resolveNoteTicketKey("todo"), "todo");
  });

  it("maps 'note' → 'note' (explicit note type)", () => {
    assert.equal(resolveNoteTicketKey("note"), "note");
  });

  it("maps any unknown/other type → 'note' (default fallback)", () => {
    assert.equal(resolveNoteTicketKey("bug"), "note");
    assert.equal(resolveNoteTicketKey("unknown"), "note");
    assert.equal(resolveNoteTicketKey(""), "note");
    assert.equal(resolveNoteTicketKey("random"), "note");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Cross-cutting: consistent interaction between helpers
// ─────────────────────────────────────────────────────────────────────────────
describe("cross-cutting invariants", () => {
  it("derive86ButtonStyle and derive86ButtonLabel are consistent — both flip on confirm86", () => {
    const s0 = derive86ButtonStyle(false);
    const l0 = derive86ButtonLabel(false);
    const s1 = derive86ButtonStyle(true);
    const l1 = derive86ButtonLabel(true);
    // confirming state is different from default state in all fields
    assert.notEqual(s0.background, s1.background);
    assert.notEqual(s0.color, s1.color);
    assert.notEqual(l0, l1);
  });

  it("deriveStatusLineText never returns empty string for any combination", () => {
    const statuses = ["Running", "Idle", "Needs Input", "Exited", "Unknown"];
    for (const status of statuses) {
      for (const live of [true, false]) {
        const text = deriveStatusLineText(status, live);
        assert.ok(text.length > 0, `expected non-empty text for status=${status} live=${live}`);
      }
    }
  });

  it("buildHistoryOutputText body never empty for any valid input", () => {
    // Even with undefined output, we always get '(no recorded output)'
    const result = buildHistoryOutputText(undefined, undefined);
    assert.ok(result.length > 0);
  });
});
