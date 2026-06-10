// tests/test_action_test_presence.ts — META-GUARD: every registry action must be referenced by at
// least one test (unit, golden, or e2e), so a NEW action cannot land with zero test coverage.
//
// PURE structural test over REGISTRY + the on-disk test corpus — no server boot, no Gemini key, no
// PTY (mirrors tests/test_catalog.ts / test_check_deps.ts style: synchronous fs reads only). The
// corpus is the TEXT of tests/*.ts (excluding this file) plus e2e/*.spec.ts; a word-boundary match
// on the snake_case tool name counts as a reference (so "create_pane" does NOT satisfy
// "create_pane_x", and quoted usages like "list_panes" naturally count).
//
// Allow-list hygiene mirrors INTENTIONAL_ASYMMETRY (test_action_coverage.ts): KNOWN_UNTESTED may
// only SHRINK — an entry that has since gained coverage fails the build until it is removed.
//
// Runner: npx tsx --test --test-force-exit tests/test_action_test_presence.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { REGISTRY } from "../src/actions/registry";

// ─────────────────────────────────────────────────────────────────────────────
// KNOWN_UNTESTED — the allow-list of actions with NO test reference yet. Each entry needs a
// one-line reason; this list may only SHRINK (the hygiene assert below rejects stale entries).
// As of 2026-06-10 the whole registry (79 actions) is referenced by at least one test, so the
// allow-list is EMPTY — keep it that way: a new action should land WITH its test, not an entry here.
// ─────────────────────────────────────────────────────────────────────────────
const KNOWN_UNTESTED: Readonly<Record<string, string>> = Object.freeze({
  // (empty — add `action_name: "reason"` ONLY as a last resort, with a follow-up bead filed)
});

// ─────────────────────────────────────────────────────────────────────────────
// Corpus assembly — synchronous, two flat directories only, CRLF-normalized, deterministic.
// ─────────────────────────────────────────────────────────────────────────────
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "test_action_test_presence.ts";

function readCorpus(): string {
  const chunks: string[] = [];
  const scan = (dir: string, keep: (f: string) => boolean): void => {
    for (const f of fs.readdirSync(path.join(ROOT, dir)).sort()) {
      if (!keep(f)) continue;
      const full = path.join(ROOT, dir, f);
      if (!fs.statSync(full).isFile()) continue;
      chunks.push(fs.readFileSync(full, "utf8").replace(/\r\n/g, "\n"));
    }
  };
  scan("tests", (f) => f.endsWith(".ts") && f !== SELF);
  scan("e2e", (f) => f.endsWith(".spec.ts"));
  return chunks.join("\n");
}

/** Word-boundary reference test: `create_pane` must NOT be satisfied by `create_pane_x`
 *  (underscore is a word character, so \b only fires at a true token edge). */
function isReferenced(corpus: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(corpus);
}

// ─────────────────────────────────────────────────────────────────────────────
// The guard.
// ─────────────────────────────────────────────────────────────────────────────
describe("action test-presence guard (every action referenced by some test)", () => {
  const corpus = readCorpus();
  const names = REGISTRY.map((d) => d.name);

  it("sanity: the registry is non-empty and the corpus was read", () => {
    assert.ok(names.length > 0, "REGISTRY is empty — import broken?");
    assert.ok(corpus.length > 0, "test corpus is empty — tests/ + e2e/ unreadable?");
  });

  it("every action is referenced by at least one test file, or allow-listed with a reason", () => {
    const uncovered = names.filter((n) => !isReferenced(corpus, n) && !(n in KNOWN_UNTESTED));
    assert.deepStrictEqual(
      uncovered,
      [],
      `action(s) with NO test coverage: ${uncovered.join(", ")} — each new action must ship with a ` +
        `test that references it by name (a unit test in tests/, a golden, or an e2e spec in e2e/). ` +
        `If coverage genuinely cannot land yet, add the action to KNOWN_UNTESTED in ` +
        `tests/${SELF} with a one-line reason and file a follow-up bead.`,
    );
  });

  it("allow-list hygiene: KNOWN_UNTESTED contains no entry that has since gained coverage", () => {
    const stale = Object.keys(KNOWN_UNTESTED).filter((n) => isReferenced(corpus, n));
    assert.deepStrictEqual(
      stale,
      [],
      `stale KNOWN_UNTESTED entr(y/ies): ${stale.join(", ")} — these actions are now referenced by ` +
        `a test; remove them from the allow-list (it may only shrink).`,
    );
  });

  it("allow-list hygiene: every KNOWN_UNTESTED key is a real registry action", () => {
    const registered = new Set(names);
    const orphans = Object.keys(KNOWN_UNTESTED).filter((n) => !registered.has(n));
    assert.deepStrictEqual(
      orphans,
      [],
      `KNOWN_UNTESTED entr(y/ies) not in the registry: ${orphans.join(", ")} — remove dead entries.`,
    );
  });
});
