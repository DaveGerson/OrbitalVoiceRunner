// tests/test_pane_output_signals.ts — BUG-031: semantic error/warning/exit-code extraction.
//
// REQUIRED post-fix behavior this suite pins:
//   (a) A pure exported extractOutputSignals(cleanText): { errors, warnings, exitCode? } in
//       src/paneSignals.ts — REUSING the existing ERROR_RE (:21), plus a WARN_RE and an exit-code
//       regex. Noise lines (progress bars, hex dumps, timestamps) are excluded. Extracted lines are
//       secret-redacted at the boundary (same convention as classifyPaneOutput). A `code 0` exit is
//       reported as exitCode===0 (NOT dropped as falsy).
//   (b) UniversalTerminal captures node-pty's exit code in `this.lastExitCode` from the
//       transport.onExit handler (today the exit-code arg is discarded).
//   (c) A new get_pane_errors voice ActionDef (read_pane, readOnly) returning structured
//       { errors, warnings, exit_code, last_command } — extracted lines + last_command redacted;
//       exit_code prefers the authoritative captured code, else the text-extracted code.
//
// RED today (all BEHAVIORAL / runtime — the file compiles and repo tsc stays green):
//   - extractOutputSignals is loaded via a DYNAMIC import so the missing export surfaces as a
//     runtime "not a function" in each test (not a repo-wide static-import link crash).
//   - term.lastExitCode is unset (undefined) after an exit today.
//   - REGISTRY has no "get_pane_errors" def; manager.getPaneErrors does not exist.
//
// Runner: npx tsx --test --test-force-exit tests/test_pane_output_signals.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "fs";
import { UniversalTerminal, OrchestratorManager } from "../src/terminal";
import { JanusStore } from "../src/store/sqliteStore";
import { REGISTRY } from "../src/actions/registry";
import type { PtyTransport } from "../src/ptyTransport";

const AWS_KEY = "AKIA1234567890ABCD99"; // AWS-key shape -> redactSecrets scrubs it

// Load the planned-missing pure fn lazily: a dynamic import keeps repo tsc green and turns the
// missing export into a clean per-test "extractOutputSignals is not a function" RED.
async function loadExtract(): Promise<(clean: string) => { errors: string[]; warnings: string[]; exitCode?: number }> {
  const mod: any = await import("../src/paneSignals");
  return mod.extractOutputSignals;
}

function feed(term: any, lines: string[]) {
  term.outputBuffer.push(...lines);
  term.totalLines += lines.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// (a) extractOutputSignals — pure classifier
// ─────────────────────────────────────────────────────────────────────────────
describe("BUG-031(a): extractOutputSignals extracts errors / warnings / exit code, excludes noise", () => {
  // Real signals the EXISTING ERROR_RE / a WARN_RE already recognize, mixed with pure noise lines.
  const SAMPLE = [
    "Compiling module foo",                       // benign
    "error: cannot find module 'x'",              // ERROR_RE: error
    "Traceback (most recent call last):",         // ERROR_RE: traceback
    "1 failed, 4 passed",                         // ERROR_RE: \d+ failed
    "Warning: 'foo' is deprecated",               // WARN_RE
    "npm WARN deprecated bar@1.0.0",              // WARN_RE
    "[####------] 40% building modules",          // NOISE: progress bar
    "de ad be ef 00 11 22 33 44 55 66 77",        // NOISE: hex dump
    "2026-07-24T10:00:00.123Z heartbeat",         // NOISE: timestamp
    "process exited with code 1",                 // exit code (NOT an error/warning line)
  ].join("\n");

  it("collects the error lines and nothing else into errors[]", async () => {
    const extract = await loadExtract();
    const { errors } = extract(SAMPLE);
    assert.ok(errors.some((l) => /cannot find module/.test(l)), "captures the error: line");
    assert.ok(errors.some((l) => /Traceback/.test(l)), "captures the traceback line");
    assert.ok(errors.some((l) => /1 failed/.test(l)), "captures the test-failure line");
    // noise + benign + warning + exit lines must NOT appear as errors
    assert.ok(!errors.some((l) => /40% building|de ad be ef|heartbeat|deprecated|exited with code/.test(l)),
      "no noise / warning / exit lines leak into errors");
  });

  it("collects only the warning lines into warnings[]", async () => {
    const extract = await loadExtract();
    const { warnings } = extract(SAMPLE);
    assert.ok(warnings.some((l) => /'foo' is deprecated/.test(l)), "captures the Warning: line");
    assert.ok(warnings.some((l) => /npm WARN deprecated bar/.test(l)), "captures the npm WARN line");
    assert.ok(!warnings.some((l) => /cannot find module|Traceback|1 failed|40% building|heartbeat/.test(l)),
      "no error / noise lines leak into warnings");
  });

  it("extracts the exit code (and does NOT drop a zero exit)", async () => {
    const extract = await loadExtract();
    assert.strictEqual(extract("process exited with code 1").exitCode, 1);
    assert.strictEqual(extract("Command exited with status 0").exitCode, 0, "code 0 must be reported, not dropped");
    assert.strictEqual(extract("all good, nothing terminated").exitCode, undefined, "no exit line -> undefined");
  });

  it("redacts secrets inside an extracted error line at the boundary", async () => {
    const extract = await loadExtract();
    const { errors } = extract(`error: auth failed with ${AWS_KEY}`);
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /\[REDACTED/i, "the secret is scrubbed");
    assert.ok(!errors[0].includes(AWS_KEY), "the raw secret must not leak");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (b) UniversalTerminal captures node-pty's exit code
// ─────────────────────────────────────────────────────────────────────────────

// Minimal stub transport (mirrors test_pane_death_signal.ts): never emits data, fires onExit only
// when driven, with a chosen exit code. Injected via the constructor's transportFactory seam.
class ExitCodeTransport implements PtyTransport {
  pid: number | undefined = 4242;
  private exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;
  onData(_cb: (d: string) => void) { /* silent */ }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void) { this.exitCb = cb; }
  write(_d: string) {}
  resize() {}
  kill() {}
  emitExit(code: number) { this.exitCb?.({ exitCode: code, signal: 0 }); }
}

function makeTerm(id: string, stub: ExitCodeTransport): UniversalTerminal {
  const term = new UniversalTerminal(
    id, ".", "cmd", "Custom", "Human-in-the-Loop", "", "p",
    undefined,
    () => ({ transport: stub, usingNodePty: true }),
  );
  (term as any).submitEnterDelayMs = 0;
  (term as any).killEscalationMs = 25;
  return term;
}
function deleteScrollback(id: string): void {
  try { fs.unlinkSync(`.janus_scrollback_${id}.log`); } catch { /* already gone */ }
}
const tick = () => new Promise<void>((r) => setImmediate(r));

describe("BUG-031(b): UniversalTerminal captures the pty exit code in lastExitCode", () => {
  it("records the node-pty exit code on a genuine exit", async () => {
    const stub = new ExitCodeTransport();
    const term: any = makeTerm("exitcode-1", stub);
    try {
      term.start();
      assert.strictEqual(term.status, "Running", "boots to Running");
      assert.strictEqual(term.lastExitCode, undefined, "no exit code before the process exits");

      stub.emitExit(42);
      await tick();

      assert.strictEqual(term.status, "Exited", "status flips to Exited");
      assert.strictEqual(term.lastExitCode, 42, "lastExitCode captured from transport.onExit");
    } finally {
      await term.stop();
      deleteScrollback("exitcode-1");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) get_pane_errors ActionDef + manager.getPaneErrors
// ─────────────────────────────────────────────────────────────────────────────
describe("BUG-031(c): get_pane_errors reports structured signals", () => {
  function setup() {
    const store = new JanusStore(":memory:");
    store.init();
    const m: any = new OrchestratorManager({ ledger: store });
    const t: any = new UniversalTerminal("errpane", ".", "shell");
    t.lastCommand = `npm test --auth ${AWS_KEY}`; // a secret inside the last command
    feed(t, [
      "Compiling",
      "error: build failed at step 3",
      "Warning: 'legacyApi' is deprecated",
      "[####----] 50% linking",
      "process exited with code 1",
    ]);
    m.terminals["errpane"] = t;
    return m;
  }

  it("get_pane_errors is a registered read_pane / readOnly voice tool", () => {
    const def: any = REGISTRY.find((d) => d.name === "get_pane_errors");
    assert.ok(def, "REGISTRY must contain a def named 'get_pane_errors'");
    assert.strictEqual(def.capability, "read_pane");
    assert.strictEqual(def.readOnly, true);
    assert.ok(def.surfaces.has("voice"), "must be a voice tool");
    const parsed: any = def.params.parse({ pane_id: "p1" });
    assert.strictEqual(parsed.pane_id, "p1");
  });

  it("manager.getPaneErrors returns {errors, warnings, exit_code, last_command}, redacted", () => {
    const m = setup();
    assert.strictEqual(typeof m.getPaneErrors, "function", "manager.getPaneErrors must exist");
    const res: any = m.getPaneErrors("errpane");

    assert.ok(Array.isArray(res.errors) && res.errors.some((l: string) => /build failed/i.test(l)), "error captured");
    assert.ok(Array.isArray(res.warnings) && res.warnings.some((l: string) => /deprecated/i.test(l)), "warning captured");
    assert.strictEqual(res.exit_code, 1, "exit code surfaced (text-extracted here; captured code preferred when present)");
    // last_command is echoed but secret-redacted
    assert.match(String(res.last_command), /\[REDACTED/i, "last_command is redacted");
    assert.ok(!String(res.last_command).includes(AWS_KEY), "the raw secret in last_command must not leak");
    // noise / benign lines are excluded from both signal arrays
    assert.ok(!res.errors.some((l: string) => /50% linking|Compiling/.test(l)));
    assert.ok(!res.warnings.some((l: string) => /50% linking|Compiling/.test(l)));
  });

  it("returns a does-not-exist marker for an unknown pane", () => {
    const m = setup();
    const res: any = m.getPaneErrors("ghost");
    assert.match(JSON.stringify(res), /does not exist/i);
  });

  it("get_pane_errors handler routes to manager.getPaneErrors", () => {
    const def: any = REGISTRY.find((d) => d.name === "get_pane_errors");
    assert.ok(def, "def must exist to exercise its handler");
    const ctx: any = { manager: setup(), isFrozen: () => false, effectiveCapabilityGateFor: () => "Auto" };
    const res: any = def.handler({ pane_id: "errpane" }, ctx);
    assert.strictEqual(res.output.exit_code, 1);
    assert.ok(res.output.errors.some((l: string) => /build failed/i.test(l)));
  });
});
