// tests/test_fc_hardening.ts — FC hardening bundle (post-verification round).
//
// Pins the eight FC fixes surfaced by final verification of the bug-fix campaign. Each describe
// block maps 1:1 to a numbered fix in the FIX-QUEUE FC section:
//   1. Stale lastExitCode across respawn (BUG-031)  — reset in start()
//   2. search_pane_output path traversal (security) — pane-id charset guard at addTerminal
//   3. empty keyword (security-adjacent)            — SearchPaneOutputParams keyword.min(1)
//   4. get_pane_summary limit/offset over REST      — PaneSummaryParams z.coerce (still rejects OOR)
//   5. "0 failed" false positive (BUG-031)          — extractOutputSignals suppresses 0-count fails
//   6. getPaneErrors raw ANSI after hydration       — stripAnsiSequences before extraction
//   7. CR-into-wrong-transport race (BUG-042)       — deliverSubmit captures transport identity
//   8. empty-string env disables pacing (BUG-042)   — resolveSubmitDelayMs treats "" as unset
//
// Runner: npx tsx --test --test-force-exit tests/test_fc_hardening.ts

// bead eoef: pin the settings file into a tmpdir for this whole file — constructing an
// OrchestratorManager (directly or via startServer) without this writes a cwd-relative
// .janus_settings.json into the repo root, which the run-unit cleanliness gate fails on.
import { pinSettingsPathToTmpdir } from "./helpers/settingsPath";
pinSettingsPathToTmpdir();

import { describe, it, mock } from "node:test";
import assert from "node:assert";
import fs from "fs";
import {
  UniversalTerminal,
  OrchestratorManager,
  resolveSubmitDelayMs,
} from "../src/terminal";
import { extractOutputSignals } from "../src/paneSignals";
import { JanusStore } from "../src/store/sqliteStore";
import { REGISTRY } from "../src/actions/registry";
import type { PtyTransport } from "../src/ptyTransport";

const AWS_KEY = "AKIA1234567890ABCD99"; // AWS-key shape -> redactSecrets scrubs it

function makeManager(): any {
  const store = new JanusStore(":memory:");
  store.init();
  return new OrchestratorManager({ ledger: store });
}

function deleteScrollback(id: string): void {
  try { fs.unlinkSync(`.janus_scrollback_${id}.log`); } catch { /* already gone */ }
}

// Minimal fake transport (mirrors tests/test_terminal_input.ts): captures every write, no process.
function makeFakeTransport() {
  const writes: string[] = [];
  const transport: PtyTransport = {
    pid: 4242,
    onData() {},
    onExit() {},
    write(data: string) { writes.push(data); },
    resize() {},
    kill() {},
  };
  return { transport, writes };
}

// Driveable exit stub (mirrors tests/test_pane_output_signals.ts): fires onExit only when driven.
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

function makeStubTerm(id: string, stub: ExitCodeTransport): any {
  const term = new UniversalTerminal(
    id, ".", "cmd", "Custom", "Human-in-the-Loop", "", "p",
    undefined,
    () => ({ transport: stub, usingNodePty: true }),
  );
  (term as any).submitEnterDelayMs = 0;
  (term as any).killEscalationMs = 25;
  return term;
}

const tick = () => new Promise<void>((r) => setImmediate(r));

// ─────────────────────────────────────────────────────────────────────────────
// FC(1): lastExitCode reset on respawn
// ─────────────────────────────────────────────────────────────────────────────
describe("FC(1) BUG-031: lastExitCode does not survive a respawn", () => {
  it("is undefined after start() re-invocation even though the prior run exited with a code", async () => {
    const stub = new ExitCodeTransport();
    const term = makeStubTerm("fc1-respawn", stub);
    try {
      term.start();
      assert.strictEqual(term.status, "Running", "boots to Running");
      assert.strictEqual(term.lastExitCode, undefined, "no code before the process exits");

      stub.emitExit(42);
      await tick();
      assert.strictEqual(term.status, "Exited", "first run exited");
      assert.strictEqual(term.lastExitCode, 42, "captured the prior run's exit code");

      // Respawn on the SAME instance (POST /api/terminals/:id/restart does stop(); start()).
      term.start();
      assert.strictEqual(term.status, "Running", "respawn boots back to Running");
      assert.strictEqual(term.lastExitCode, undefined, "the stale prior-run code is cleared on respawn");
    } finally {
      await term.stop();
      deleteScrollback("fc1-respawn");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FC(2): pane-id traversal rejected at addTerminal
// ─────────────────────────────────────────────────────────────────────────────
describe("FC(2) security: a traversal pane id is rejected at the creation choke-point", () => {
  it("rejects a forward-slash traversal id and creates no pane", () => {
    const m = makeManager();
    const res = m.addTerminal("../../etc/passwd", ".", "shell");
    assert.match(res, /invalid pane id/i, "rejected with an invalid-id message");
    assert.strictEqual(m.terminals["../../etc/passwd"], undefined, "no pane created for a traversal id");
  });

  it("rejects a backslash traversal id (Windows lexical ..)", () => {
    const m = makeManager();
    const res = m.addTerminal("..\\..\\win.ini", ".", "shell");
    assert.match(res, /invalid pane id/i);
    assert.strictEqual(m.terminals["..\\..\\win.ini"], undefined);
  });

  it("rejects a drive/ADS colon id", () => {
    const m = makeManager();
    assert.match(m.addTerminal("C:evil", ".", "shell"), /invalid pane id/i);
  });

  it("neutralizes search_pane_output for a traversal id — it can never resolve a pane, so it cannot read a file outside the workspace", () => {
    const m = makeManager();
    // Because the pane can never be created, the scrollback filename is never built from the
    // traversal id — the read is structurally impossible; the manager returns the does-not-exist string.
    const out = m.searchScrollback("../../etc/passwd", "root");
    assert.match(out, /does not exist/i);
  });

  it("still accepts a well-formed id with letters/digits/_ . - (regression)", async () => {
    const m = makeManager();
    const res = m.addTerminal("good_pane-1.2", ".", "shell");
    assert.match(res, /Created terminal 'good_pane-1\.2'/, "a conforming id is accepted");
    const term = m.terminals["good_pane-1.2"];
    assert.ok(term, "the well-formed pane is created");
    // Neutralize the deferred real spawn scheduled by addTerminal (setImmediate) so no ConPTY leaks.
    if (term) (term as any).start = () => {};
    await m.flushPendingSpawns();
    deleteScrollback("good_pane-1.2");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FC(3): search_pane_output rejects an empty keyword
// ─────────────────────────────────────────────────────────────────────────────
describe("FC(3) security-adjacent: search_pane_output requires a non-empty keyword", () => {
  const def: any = REGISTRY.find((d) => d.name === "search_pane_output");

  it("rejects keyword \"\" at parse (an empty keyword matches every line)", () => {
    assert.ok(def, "search_pane_output def is registered");
    assert.throws(() => def.params.parse({ pane_id: "p", keyword: "" }));
  });

  it("accepts a one-char keyword", () => {
    const parsed = def.params.parse({ pane_id: "p", keyword: "x" });
    assert.strictEqual(parsed.keyword, "x");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FC(4): get_pane_summary limit/offset coerce over REST, still reject out-of-range
// ─────────────────────────────────────────────────────────────────────────────
describe("FC(4) API coherence: get_pane_summary coerces REST string args but keeps out-of-range a rejection", () => {
  const def: any = REGISTRY.find((d) => d.name === "get_pane_summary");

  it("coerces string \"50\"/\"5\" (REST query shape) to numbers", () => {
    assert.ok(def, "get_pane_summary def is registered");
    const p = def.params.parse({ pane_id: "p", limit: "50", offset: "5" });
    assert.strictEqual(p.limit, 50);
    assert.strictEqual(p.offset, 5);
  });

  it("still REJECTS \"501\"/\"0\"/\"-1\" (min/max are rejections, not clamps)", () => {
    assert.throws(() => def.params.parse({ pane_id: "p", limit: "501" }), "limit above max");
    assert.throws(() => def.params.parse({ pane_id: "p", limit: "0" }), "limit below min");
    assert.throws(() => def.params.parse({ pane_id: "p", offset: "-1" }), "offset below min");
  });

  it("omitted limit/offset stay undefined (bare pane_id is behavior-preserving)", () => {
    const p = def.params.parse({ pane_id: "p" });
    assert.strictEqual(p.limit, undefined);
    assert.strictEqual(p.offset, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FC(5): extractOutputSignals suppresses "0 failed" / "0 failing"
// ─────────────────────────────────────────────────────────────────────────────
describe("FC(5) BUG-031: a green '0 failed' summary is not an error", () => {
  it("does NOT push 'Tests: 0 failed, 25 passed' into errors[]", () => {
    const { errors } = extractOutputSignals("Tests: 0 failed, 25 passed");
    assert.ok(!errors.some((l) => /0 failed/.test(l)), "a passing run must not narrate as failed");
    assert.strictEqual(errors.length, 0, "no error line at all for a clean run");
  });

  it("suppresses '0 failing' too", () => {
    const { errors } = extractOutputSignals("Suite complete: 0 failing");
    assert.ok(!errors.some((l) => /0 failing/.test(l)));
  });

  it("STILL captures a real '3 failed' as an error", () => {
    const { errors } = extractOutputSignals("Tests: 3 failed, 22 passed");
    assert.ok(errors.some((l) => /3 failed/.test(l)), "a real failure is still an error");
  });

  it("does not touch the exit-code / warning lanes", () => {
    const { exitCode } = extractOutputSignals("0 failed\nprocess exited with code 0");
    assert.strictEqual(exitCode, 0, "exit-code extraction is unaffected");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FC(6): getPaneErrors strips ANSI before extraction
// ─────────────────────────────────────────────────────────────────────────────
describe("FC(6) BUG-031: getPaneErrors returns escape-free error lines even from a raw-ANSI ring", () => {
  it("strips escape bytes from returned error lines", () => {
    const m = makeManager();
    const t: any = new UniversalTerminal("fc6-ansi", ".", "shell");
    // Simulate a post-restart ring seeded by loadScrollback from the RAW scrollback file (ANSI intact).
    t.outputBuffer = ["[31merror: build failed at step 3[0m"];
    t.totalLines = 1;
    m.terminals["fc6-ansi"] = t;

    const res: any = m.getPaneErrors("fc6-ansi");
    assert.ok(res.errors.length >= 1, "the error line is captured");
    assert.ok(res.errors.every((l: string) => !/\[/.test(l)), "no escape bytes survive in returned error lines");
    assert.ok(res.errors.some((l: string) => /build failed at step 3/.test(l)), "content preserved after strip");
  });

  it("redacts a secret that an ANSI escape had split (strip THEN redact — no dodge)", () => {
    const m = makeManager();
    const t: any = new UniversalTerminal("fc6-secret", ".", "shell");
    // The AWS key is broken by an SGR reset mid-token; only after stripping does it become a
    // contiguous key that redactSecrets can scrub. Without the strip, the fragments would leak.
    t.outputBuffer = [`error: token AKIA1234[0m567890ABCD99 leaked`];
    t.totalLines = 1;
    m.terminals["fc6-secret"] = t;

    const joined = (m.getPaneErrors("fc6-secret").errors as string[]).join(" ");
    assert.match(joined, /\[REDACTED/i, "the reassembled secret is scrubbed");
    assert.ok(!joined.includes(AWS_KEY), "the full key must not leak");
    assert.ok(!joined.includes("AKIA1234"), "the head fragment is gone (subsumed into the redaction)");
    assert.ok(!joined.includes("567890ABCD99"), "the tail fragment is gone too");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FC(7): deferred submit CR must not land in a swapped-in transport
// ─────────────────────────────────────────────────────────────────────────────
describe("FC(7) BUG-042: a transport swap during the paced gap suppresses the deferred CR", () => {
  it("does NOT write the CR to the new transport (nor the retired one) after an identity change", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const term: any = new UniversalTerminal("fc7-swap", ".", "cmd");
      const t1 = makeFakeTransport();
      const t2 = makeFakeTransport();
      term.transport = t1.transport;
      term.spawnReady = true;
      term.submitEnterDelayMs = 20; // force the paced (deferred-CR) path

      term.writeInput("go");
      await Promise.resolve(); await Promise.resolve(); // let the serialized submit write the body
      assert.deepStrictEqual(t1.writes, ["go"], "body written to the original transport; CR deferred");

      // A restart swaps in a NEW transport DURING the gap.
      term.transport = t2.transport;
      mock.timers.tick(20); // the gap elapses -> the deferred CR would fire

      assert.deepStrictEqual(t2.writes, [], "the stray CR must NOT land in the newly swapped-in transport");
      assert.ok(!t1.writes.includes("\r"), "and the CR is not delivered to the retired transport either");
    } finally {
      mock.timers.reset();
    }
  });

  it("still delivers the CR when the transport is unchanged across the gap (no regression)", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const term: any = new UniversalTerminal("fc7-stable", ".", "cmd");
      const t1 = makeFakeTransport();
      term.transport = t1.transport;
      term.spawnReady = true;
      term.submitEnterDelayMs = 20;

      term.writeInput("go");
      await Promise.resolve(); await Promise.resolve();
      mock.timers.tick(20);
      assert.deepStrictEqual(t1.writes, ["go", "\r"], "CR still arrives when the transport is the same one");
    } finally {
      mock.timers.reset();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FC(8): empty-string env must not disable pacing
// ─────────────────────────────────────────────────────────────────────────────
describe("FC(8) BUG-042: resolveSubmitDelayMs treats empty/blank env as unset, keeps '0' as opt-out", () => {
  it("empty string \"\" resolves to the 60ms default (NOT 0)", () => {
    assert.strictEqual(resolveSubmitDelayMs(""), 60);
  });
  it("whitespace-only resolves to the 60ms default", () => {
    assert.strictEqual(resolveSubmitDelayMs("   "), 60);
  });
  it("undefined (unset env) resolves to the 60ms default", () => {
    assert.strictEqual(resolveSubmitDelayMs(undefined), 60);
  });
  it("explicit \"0\" is honored as the synchronous opt-out", () => {
    assert.strictEqual(resolveSubmitDelayMs("0"), 0);
  });
  it("a real numeric value wins", () => {
    assert.strictEqual(resolveSubmitDelayMs("80"), 80);
  });
  it("a non-finite / negative value falls back to the default", () => {
    assert.strictEqual(resolveSubmitDelayMs("abc"), 60);
    assert.strictEqual(resolveSubmitDelayMs("-5"), 60);
  });
});
