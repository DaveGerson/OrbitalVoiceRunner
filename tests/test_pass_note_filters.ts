// tests/test_pass_note_filters.ts
//
// hwu.5: pins the pure note-filter-chip helpers extracted from Pass.tsx (The Pass ticket filters —
// type/author/date):
//   - matchesTypeFilter(note, filter)
//   - matchesAuthorFilter(note, filter)
//   - matchesDateFilter(note, filter, now)
//   - filterNotes(notes, filters, now)  — composes all three
//
// Same Vite/React-stub loader-hook idiom as tests/test_pass_complexity_refactor.ts, so Pass.tsx
// (a Vite-only React module) can be loaded directly under plain tsx --test.
//
// Runner: npx tsx --test --test-force-exit tests/test_pass_note_filters.ts

import { register } from "node:module";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const hookSource = /* js */`
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('?raw')) {
    return { url: 'data:text/javascript,export default ""', shortCircuit: true };
  }
  if (specifier === 'react') {
    return { url: 'data:text/javascript,export default {};export function useState(){}export function useRef(){}export function useEffect(){}export const Fragment=Symbol("Fragment")', shortCircuit: true };
  }
  if (specifier === 'react/jsx-runtime') {
    return { url: 'data:text/javascript,export function jsx(){}export function jsxs(){}export const Fragment=Symbol("Fragment");export default {}', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url.startsWith('data:text/javascript,')) {
    const head = 'data:text/javascript,';
    const q = url.indexOf('?', head.length);
    const payload = q === -1 ? url.slice(head.length) : url.slice(head.length, q);
    return { format: 'module', source: decodeURIComponent(payload), shortCircuit: true };
  }
  if (url.endsWith('.svg') || url.includes('.svg?')) {
    return { format: 'module', source: 'export default ""', shortCircuit: true };
  }
  return nextLoad(url, context);
}
`;

register(
  `data:text/javascript,${encodeURIComponent(hookSource)}`,
  { parentURL: import.meta.url },
);

const {
  matchesTypeFilter,
  matchesAuthorFilter,
  matchesDateFilter,
  filterNotes,
} = await import("../src/orbital/views/Pass.js");

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

type NoteType = "decision" | "todo" | "warning" | "note" | "handoff";
type NoteAuthor = "janus" | "user";

function note(overrides: Partial<{ type: NoteType; author: NoteAuthor; created_at: number }> = {}) {
  return { type: "note" as NoteType, author: "user" as NoteAuthor, created_at: NOW, ...overrides };
}

// ─── matchesTypeFilter ─────────────────────────────────────────────────────────
describe("matchesTypeFilter", () => {
  it("'all' matches any type", () => {
    assert.equal(matchesTypeFilter(note({ type: "decision" }), "all"), true);
    assert.equal(matchesTypeFilter(note({ type: "warning" }), "all"), true);
  });
  it("matches an exact type", () => {
    assert.equal(matchesTypeFilter(note({ type: "decision" }), "decision"), true);
  });
  it("rejects a mismatched type", () => {
    assert.equal(matchesTypeFilter(note({ type: "todo" }), "decision"), false);
  });
  it("distinguishes decision from handoff (both collapse to the same ticket 'kind' but are separate chips)", () => {
    assert.equal(matchesTypeFilter(note({ type: "handoff" }), "decision"), false);
    assert.equal(matchesTypeFilter(note({ type: "decision" }), "handoff"), false);
  });
});

// ─── matchesAuthorFilter ───────────────────────────────────────────────────────
describe("matchesAuthorFilter", () => {
  it("'all' matches any author", () => {
    assert.equal(matchesAuthorFilter(note({ author: "janus" }), "all"), true);
    assert.equal(matchesAuthorFilter(note({ author: "user" }), "all"), true);
  });
  it("'janus' matches the model author", () => {
    assert.equal(matchesAuthorFilter(note({ author: "janus" }), "janus"), true);
    assert.equal(matchesAuthorFilter(note({ author: "user" }), "janus"), false);
  });
  it("'you' maps to the persisted 'user' author", () => {
    assert.equal(matchesAuthorFilter(note({ author: "user" }), "you"), true);
    assert.equal(matchesAuthorFilter(note({ author: "janus" }), "you"), false);
  });
});

// ─── matchesDateFilter ─────────────────────────────────────────────────────────
describe("matchesDateFilter", () => {
  it("'all' matches any age", () => {
    assert.equal(matchesDateFilter(note({ created_at: NOW - 30 * DAY_MS }), "all", NOW), true);
  });
  it("'today' matches a note from an hour ago", () => {
    assert.equal(matchesDateFilter(note({ created_at: NOW - 60 * 60 * 1000 }), "today", NOW), true);
  });
  it("'today' rejects a note from 2 days ago", () => {
    assert.equal(matchesDateFilter(note({ created_at: NOW - 2 * DAY_MS }), "today", NOW), false);
  });
  it("'week' matches a note from 3 days ago", () => {
    assert.equal(matchesDateFilter(note({ created_at: NOW - 3 * DAY_MS }), "week", NOW), true);
  });
  it("'week' includes 'today'-fresh notes too", () => {
    assert.equal(matchesDateFilter(note({ created_at: NOW - 60 * 60 * 1000 }), "week", NOW), true);
  });
  it("'week' rejects a note from 10 days ago", () => {
    assert.equal(matchesDateFilter(note({ created_at: NOW - 10 * DAY_MS }), "week", NOW), false);
  });
  it("defaults `now` to Date.now() when omitted (a fresh note always matches 'today')", () => {
    assert.equal(matchesDateFilter(note({ created_at: Date.now() }), "today"), true);
  });
});

// ─── filterNotes (composition) ─────────────────────────────────────────────────
describe("filterNotes", () => {
  const notes = [
    note({ type: "decision", author: "janus", created_at: NOW }),
    note({ type: "todo", author: "user", created_at: NOW - 2 * DAY_MS }),
    note({ type: "decision", author: "user", created_at: NOW - 10 * DAY_MS }),
    note({ type: "warning", author: "janus", created_at: NOW - 30 * DAY_MS }),
  ];

  it("all/all/all returns every note unchanged", () => {
    const out = filterNotes(notes, { type: "all", author: "all", date: "all" }, NOW);
    assert.equal(out.length, 4);
  });

  it("narrows by type alone", () => {
    const out = filterNotes(notes, { type: "decision", author: "all", date: "all" }, NOW);
    assert.equal(out.length, 2);
    assert.ok(out.every((n: { type: NoteType }) => n.type === "decision"));
  });

  it("narrows by author alone", () => {
    const out = filterNotes(notes, { type: "all", author: "you", date: "all" }, NOW);
    assert.equal(out.length, 2);
    assert.ok(out.every((n: { author: NoteAuthor }) => n.author === "user"));
  });

  it("narrows by date alone", () => {
    const out = filterNotes(notes, { type: "all", author: "all", date: "week" }, NOW);
    assert.equal(out.length, 2); // NOW and NOW-2d survive; NOW-10d and NOW-30d don't
  });

  it("composes all three filters (AND semantics)", () => {
    const out = filterNotes(notes, { type: "decision", author: "janus", date: "week" }, NOW);
    assert.equal(out.length, 1);
    assert.equal(out[0].type, "decision");
    assert.equal(out[0].author, "janus");
  });

  it("an over-narrow combination returns an empty array (not an error)", () => {
    const out = filterNotes(notes, { type: "todo", author: "janus", date: "today" }, NOW);
    assert.deepEqual(out, []);
  });

  it("empty input returns empty output regardless of filters", () => {
    const out = filterNotes([], { type: "decision", author: "you", date: "today" }, NOW);
    assert.deepEqual(out, []);
  });
});
