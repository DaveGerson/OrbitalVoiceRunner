// tests/test_vt_emulator.ts — bead wsm-e2e-pinned-x6oo (RED phase).
//
// Pane output renders as gibberish in the MODEL lane (get_pane_delta / get_pane_summary /
// scrollback) because src/terminal.ts's onData strips escapes NAIVELY (stripAnsiSequences) with
// two defects: (1) it misses OSC (`ESC ] … BEL` / `ESC ] … ST`) and bare BEL, so window-title
// noise leaks into the buffer; (2) it has NO grid reconstruction, so a redraw-heavy TUI stream
// (spinners, cursor addressing, alt-screen) yields interleaved partial frames — the gobbledygook.
//
// The fix: patch stripAnsiSequences to also strip OSC + stray C0 controls, AND feed a per-pane
// headless VT emulator (@xterm/headless) so outputBuffer receives only the COMMITTED rendered grid.
//
// These tests are the RED contract. They drive input through the INJECTED FAKE TRANSPORT seam
// (transportFactory) — no real PTY — exactly like tests/test_failure_injection_pty_midcommand.ts,
// and await the deterministic drain barrier term.drainVtForTest() before asserting on the
// (async-parsed) emulator output. They MUST compile and fail on ASSERTIONS until the emulator and
// the OSC/BEL strip are implemented; they do NOT modify tests/test_pane_delta.ts.
//
// Runner: npx tsx --test --test-force-exit tests/test_vt_emulator.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "fs";
import { UniversalTerminal, stripAnsiSequences } from "../src/terminal";
import type { PtyTransport } from "../src/ptyTransport";

function deleteScrollback(id: string): void {
  const p = `.janus_scrollback_${id}.log`;
  try { fs.unlinkSync(p); } catch { /* already gone */ }
}

/** A controllable fake transport: records writes, lets the test push output chunks into the
 *  terminal's onData handler (emitData), and no-ops kill/resize. `pid` is defined so stop() runs
 *  its full teardown path (where the emulator is disposed). Mirrors the proven idiom in
 *  tests/test_failure_injection_pty_midcommand.ts. */
class FakeTransport implements PtyTransport {
  writes: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  pid: number | undefined = 7373;
  private dataCb: ((d: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;
  onData(cb: (d: string) => void) { this.dataCb = cb; }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void) { this.exitCb = cb; }
  write(d: string) { this.writes.push(d); }
  resize(cols: number, rows: number) { this.resizes.push({ cols, rows }); }
  kill() { /* no-op: stop() resolves via the killEscalation timeout (set to 25ms below) */ }
  /** Push an output chunk through the terminal's onData handler, as a real PTY would. */
  emitData(chunk: string) { this.dataCb?.(chunk); }
}

function makeStartedTerm(id: string): { term: UniversalTerminal; stub: FakeTransport } {
  deleteScrollback(id);
  const stub = new FakeTransport();
  const term = new UniversalTerminal(
    id, ".", "cmd", "Custom", "Human-in-the-Loop", "", "p",
    undefined,
    () => ({ transport: stub, usingNodePty: true }),
  );
  (term as any).killEscalationMs = 25; // fast, deterministic stop() (stub never emits a real exit)
  term.start();
  return { term, stub };
}

async function cleanup(term: UniversalTerminal, id: string): Promise<void> {
  try { await term.stop(); } catch { /* best-effort */ }
  deleteScrollback(id);
}

// ---------------------------------------------------------------------------
// (a) stripAnsiSequences — OSC (BEL/ST) + bare BEL, plus a CSI/SGR regression guard.
// ---------------------------------------------------------------------------
describe("x6oo(a): stripAnsiSequences strips OSC + bare control bytes", () => {
  it("strips a BEL-terminated OSC window-title sequence", () => {
    assert.strictEqual(stripAnsiSequences("\x1b]0;my-title\x07hello"), "hello");
  });

  it("strips an ST-terminated OSC sequence (ESC \\)", () => {
    assert.strictEqual(stripAnsiSequences("\x1b]0;t\x1b\\hello"), "hello");
  });

  it("strips a bare BEL byte", () => {
    assert.strictEqual(stripAnsiSequences("\x07"), "");
    assert.strictEqual(stripAnsiSequences("a\x07b"), "ab");
  });

  it("REGRESSION GUARD: still strips CSI/SGR color sequences (must stay green)", () => {
    assert.strictEqual(stripAnsiSequences("\x1b[31mred\x1b[0m"), "red");
    assert.strictEqual(stripAnsiSequences("\x1b[1;32mok\x1b[0m done"), "ok done");
  });
});

// ---------------------------------------------------------------------------
// (b) Spinner/redraw stream → only the final COMMITTED text survives (grid reconstruction).
// ---------------------------------------------------------------------------
describe("x6oo(b): a spinner/redraw stream commits only the final rendered line", () => {
  it("getRecentOutput() has 'Done!' and NONE of the overwritten 'Working' frames or CR bytes", async () => {
    const id = "x6oo-spinner";
    const { term, stub } = makeStartedTerm(id);
    try {
      // Four spinner frames rewriting the SAME row (CR + erase-line), then the final line.
      const spinner =
        "Working \x1b[?25l|" +          // hide cursor, frame 1
        "\r\x1b[KWorking /" +           // CR, erase-to-EOL, frame 2
        "\r\x1b[KWorking -" +           // frame 3
        "\r\x1b[KWorking \\" +          // frame 4
        "\r\x1b[K\x1b[32mDone!\x1b[0m\x1b[?25h\r\n"; // erase, green "Done!", show cursor, newline
      stub.emitData(spinner);
      await term.drainVtForTest();

      const out = term.getRecentOutput(50);
      assert.ok(out.includes("Done!"), `final committed text present — got ${JSON.stringify(out)}`);
      assert.ok(!out.includes("Working"), `no overwritten spinner frames leaked — got ${JSON.stringify(out)}`);
      assert.ok(!out.includes("\r"), `no interleaved CR frame garbage — got ${JSON.stringify(out)}`);
    } finally {
      await cleanup(term, id);
    }
  });
});

// ---------------------------------------------------------------------------
// (c) Claude-Code-style stream → NO raw escape bytes reach the model lane.
// ---------------------------------------------------------------------------
describe("x6oo(c): a Claude-Code-style stream leaves no escape bytes in the model lane", () => {
  it("getRecentOutput()/consumeDelta() contain no ESC/CSI/OSC/BEL bytes", async () => {
    const id = "x6oo-claude";
    const { term, stub } = makeStartedTerm(id);
    try {
      const stream =
        "\x1b]0;Claude Code\x07" +                 // OSC title (BEL-terminated)
        "\x1b[?1049h\x1b[2J\x1b[H" +               // enter alt-screen, clear, home
        "\x1b[1;34mAssistant:\x1b[0m thinking...\r\n" + // bold-blue SGR + redraw
        "\x1b[2K\rAssistant: intermediate\r\n" +   // erase-line + rewrite
        "\x1b[?1049l" +                            // leave alt-screen
        "Result committed.\r\n";                   // final normal-buffer line
      stub.emitData(stream);
      await term.drainVtForTest();

      const recent = term.getRecentOutput(100);
      const delta = term.consumeDelta().lines;
      for (const [label, s] of [["getRecentOutput", recent], ["consumeDelta", delta]] as const) {
        assert.ok(!s.includes("\x1b"), `${label}: no raw ESC — got ${JSON.stringify(s)}`);
        assert.ok(!s.includes("\x9b"), `${label}: no 8-bit CSI (0x9b) — got ${JSON.stringify(s)}`);
        assert.ok(!s.includes("\x07"), `${label}: no bare BEL — got ${JSON.stringify(s)}`);
        assert.ok(!s.includes("]0;"), `${label}: no OSC title remnant — got ${JSON.stringify(s)}`);
      }
      assert.ok(recent.includes("committed"), `final committed line rendered — got ${JSON.stringify(recent)}`);
    } finally {
      await cleanup(term, id);
    }
  });
});

// ---------------------------------------------------------------------------
// (d) INVARIANT GUARD: the DISPLAY lane (rawBackfill) keeps the raw escape bytes intact.
//     Green now AND after the fix — proves the fix does not touch the display lane.
// ---------------------------------------------------------------------------
describe("x6oo(d): the display lane (rawBackfill) keeps raw escape bytes", () => {
  it("getRawBackfill() still contains the raw ESC/OSC bytes after onData", async () => {
    const id = "x6oo-display";
    const { term, stub } = makeStartedTerm(id);
    try {
      const stream = "\x1b]0;title\x07\x1b[31mred\x1b[0m\r\n";
      stub.emitData(stream);
      await term.drainVtForTest();

      const raw = term.getRawBackfill();
      assert.ok(raw.includes("\x1b"), "raw ESC preserved for the xterm frontend");
      assert.ok(raw.includes("]0;title"), "raw OSC title preserved in the display lane");
      assert.ok(raw.includes("\x1b[31m"), "raw SGR color preserved in the display lane");
    } finally {
      await cleanup(term, id);
    }
  });
});

// ---------------------------------------------------------------------------
// (e) Emulator lifecycle: constructed on start(), resized on resize(), disposed on stop();
//     a second stop() is safe.
// ---------------------------------------------------------------------------
describe("x6oo(e): the VT emulator is resized on resize() and disposed on stop()", () => {
  it("constructs the emulator, propagates resize(), disposes it on stop(), and a 2nd stop() is safe", async () => {
    const id = "x6oo-lifecycle";
    const { term } = makeStartedTerm(id);
    try {
      const vt = (term as any).vt;
      assert.ok(vt, "a VT emulator is constructed on start()");

      term.resize(123, 44);
      assert.strictEqual((term as any).vt.cols, 123, "resize() propagates cols to the emulator");
      assert.strictEqual((term as any).vt.rows, 44, "resize() propagates rows to the emulator");

      await term.stop();
      assert.ok(!(term as any).vt, "stop() disposes and clears the emulator (no dangling handle)");

      await assert.doesNotReject(async () => { await term.stop(); }, "a second stop() is safe");
    } finally {
      deleteScrollback(id);
    }
  });
});
