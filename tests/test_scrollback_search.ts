// tests/test_scrollback_search.ts — BUG-030(b): search_pane_output over the scrollback FILE.
//
// REQUIRED post-fix behavior this suite pins:
//   1. A new `search_pane_output` voice ActionDef exists (capability read_pane, readOnly, voice
//      surface) with a { pane_id, keyword } schema.
//   2. OrchestratorManager.searchScrollback(paneId, keyword) case-insensitively searches the pane's
//      512KB scrollback FILE (.janus_scrollback_<id>.log) — reaching lines BEYOND the 100-line
//      in-memory ring — and returns REDACTED matching lines (bounded count) OR a clear no-match
//      message. A missing pane returns the standard "does not exist" string.
//   3. The scrollback file may contain ANSI + secrets: matches are ANSI-stripped and run through
//      redactSecrets before they leave the process.
//
// RED today (all BEHAVIORAL — no missing top-level imports; the file compiles + repo tsc stays green):
//   - REGISTRY has no def named "search_pane_output" (find() -> undefined).
//   - OrchestratorManager has no searchScrollback method (typeof -> "undefined", call -> TypeError).
//   The 512KB scrollback file is written at src/terminal.ts:876 / loaded at boot :856, but is not
//   exposed to ANY read tool today.
//
// Runner: npx tsx --test --test-force-exit tests/test_scrollback_search.ts

// bead eoef: pin the settings file into a tmpdir for this whole file — constructing an
// OrchestratorManager (directly or via startServer) without this writes a cwd-relative
// .janus_settings.json into the repo root, which the run-unit cleanliness gate fails on.
import { pinSettingsPathToTmpdir } from "./helpers/settingsPath";
pinSettingsPathToTmpdir();

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import { UniversalTerminal, OrchestratorManager } from "../src/terminal";
import { JanusStore } from "../src/store/sqliteStore";
import { REGISTRY } from "../src/actions/registry";

// The scrollback file path is relative to process.cwd() (src/terminal.ts uses a bare
// `.janus_scrollback_<id>.log`), NOT the terminal's cwd arg — mirror that here.
function scrollbackPath(id: string): string {
  return `.janus_scrollback_${id}.log`;
}
function deleteScrollback(id: string): void {
  try { fs.unlinkSync(scrollbackPath(id)); } catch { /* already gone */ }
}

const PANE = "scrollsearch-p1";
// The needle sits on the FIRST file line (well beyond a 100-line ring). It carries an AWS-key-shaped
// secret AND is wrapped in real ANSI SGR codes (the file stores RAW chunks incl. ANSI — see
// appendScrollback(decoded)), so one line pins three properties at once: "found beyond the ring",
// "secret redacted on egress", and "ANSI stripped on egress".
const NEEDLE_LINE = "\u001b[32mSTARTUP_MARKER\u001b[0m build boot token=AKIA1234567890ABCD99 ready";

before(() => {
  // 1 needle line + 200 filler lines -> the needle is far outside the last-100-line in-memory buffer.
  const filler = Array.from({ length: 200 }, (_, i) => `filler output line ${i + 1}`);
  fs.writeFileSync(scrollbackPath(PANE), [NEEDLE_LINE, ...filler].join("\n") + "\n", "utf-8");
});
after(() => deleteScrollback(PANE));

function makeManagerWithPane(): any {
  const store = new JanusStore(":memory:");
  store.init();
  const m: any = new OrchestratorManager({ ledger: store });
  const t: any = new UniversalTerminal(PANE, ".", "shell");
  // Simulate a live ring that holds only RECENT output — the needle is NOT in memory, only in the file.
  t.outputBuffer = ["filler output line 199", "filler output line 200"];
  t.totalLines = 201;
  m.terminals[PANE] = t;
  return m;
}

describe("BUG-030(b): search_pane_output ActionDef is registered", () => {
  it("exists as a read_pane / readOnly voice tool with a pane_id + keyword schema", () => {
    const def: any = REGISTRY.find((d) => d.name === "search_pane_output");
    assert.ok(def, "REGISTRY must contain a def named 'search_pane_output'");
    assert.strictEqual(def.capability, "read_pane", "search reads pane content -> read_pane");
    assert.strictEqual(def.readOnly, true, "read tool: result is redacted on egress");
    assert.ok(def.surfaces.has("voice"), "must be a voice tool");
    // schema must accept a keyword alongside pane_id
    const parsed: any = def.params.parse({ pane_id: "p1", keyword: "boom" });
    assert.strictEqual(parsed.pane_id, "p1");
    assert.strictEqual(parsed.keyword, "boom");
  });
});

describe("BUG-030(b): OrchestratorManager.searchScrollback", () => {
  it("finds a keyword that lives ONLY in the scrollback file (beyond the in-memory ring), case-insensitively", () => {
    const m = makeManagerWithPane();
    assert.strictEqual(typeof m.searchScrollback, "function", "manager.searchScrollback must exist");

    // The in-memory summary cannot see the needle (it is not in the ring)...
    const summary = String(m.getPaneSummary(PANE, 100, 0));
    assert.ok(!/STARTUP_MARKER/.test(summary), "sanity: the needle is NOT in the in-memory ring");

    // ...but the scrollback search finds it (lowercase keyword -> case-insensitive match).
    const out = String(m.searchScrollback(PANE, "startup_marker"));
    assert.match(out, /STARTUP_MARKER/, "search finds the needle line in the file");
  });

  it("redacts secrets in matched lines", () => {
    const m = makeManagerWithPane();
    const out = String(m.searchScrollback(PANE, "startup_marker"));
    assert.match(out, /\[REDACTED/i, "the AWS-key-shaped token is scrubbed");
    assert.ok(!/AKIA1234567890ABCD99/.test(out), "the raw secret must not leak");
  });

  it("strips ANSI escape sequences from matched lines", () => {
    // The scrollback file stores RAW chunks incl. ANSI (the needle is wrapped in SGR color codes).
    // A search that forgets stripAnsiSequences would still 'find' the line but leak the escape bytes.
    const m = makeManagerWithPane();
    const out = String(m.searchScrollback(PANE, "startup_marker"));
    // stripAnsiSequences removes the ESC + the "[32m" body as a unit, so the definitive check is
    // simply that no raw ESC (0x1b) byte survives on egress.
    assert.ok(!out.includes(String.fromCharCode(27)), "no bare ESC (0x1b) byte survives in the returned match");
    assert.match(out, /STARTUP_MARKER build boot/, "the human-readable text is intact after stripping");
  });

  it("returns a clear no-match message when nothing matches", () => {
    const m = makeManagerWithPane();
    const out = String(m.searchScrollback(PANE, "no-such-keyword-xyzzy"));
    assert.ok(!/STARTUP_MARKER/.test(out), "no false match");
    assert.match(out, /no .*match|no match|match/i, "a human-readable no-match message");
  });

  it("returns the standard does-not-exist string for an unknown pane", () => {
    const m = makeManagerWithPane();
    assert.match(String(m.searchScrollback("ghost-pane", "boot")), /does not exist/i);
  });
});

describe("BUG-030(b): search_pane_output handler routes to manager.searchScrollback", () => {
  it("returns the redacted matching lines via the def handler", () => {
    const def: any = REGISTRY.find((d) => d.name === "search_pane_output");
    assert.ok(def, "def must exist to exercise its handler");
    const ctx: any = { manager: makeManagerWithPane(), isFrozen: () => false, effectiveCapabilityGateFor: () => "Auto" };
    const res: any = def.handler({ pane_id: PANE, keyword: "startup_marker" }, ctx);
    assert.match(String(res.output), /STARTUP_MARKER/);
    assert.match(String(res.output), /\[REDACTED/i);
  });
});
