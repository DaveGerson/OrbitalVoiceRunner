// Phase 4 Track E — Card 4E.1: HistoryManager must stop rewriting .janus_history.json
// per PTY chunk.
//
// FINDING (verified): appendOutputToLastCommand ran fs.readFileSync + JSON.parse of the
// whole multi-pane history file, mutated, then JSON.stringify + writeFileSync — on EVERY
// PTY data event. A chatty pane = continuous O(file-size) sync I/O on the loop serving
// voice/WS/HTTP, and the write was non-atomic.
//
// CONTRACT under test:
//  - mutations land IN MEMORY and flush DEBOUNCED (JANUS_HISTORY_FLUSH_MS after the last
//    mutation, capped by a JANUS_HISTORY_FLUSH_MAX_MS linger), ASYNC (fs.promises),
//    ATOMIC (tmp + rename) — so N rapid appends produce at most ~2 file writes;
//  - loadHistory served from the in-memory dirty cache — a read after a write but BEFORE
//    the flush returns the fresh data;
//  - flushAll() (the server close() path) forces pending mutations to disk;
//  - the on-disk format stays byte-compatible: one JSON object keyed by terminalId,
//    pretty-printed with 2-space indent (operators may have tooling);
//  - foreign pane keys written to the file by the inline action-def ports survive a flush.

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";

// Short, test-friendly flush windows. MUST be set before ../server is imported
// (HistoryManager reads them at construction).
const FLUSH_MS = 60;
const MAX_LINGER_MS = 240;

function historyPath(): string {
  return path.join(process.cwd(), ".janus_history.json");
}

function readHistoryFile(): Record<string, any[]> {
  try {
    return JSON.parse(fs.readFileSync(historyPath(), "utf-8"));
  } catch {
    return {};
  }
}

async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 3000, intervalMs = 10): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = probe();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe("4E.1 HistoryManager debounced/atomic flush", () => {
  let hm: any;
  let tmpDir: string;
  let prevCwd: string;

  // fs spies: count every write that targets the history file (sync legacy path AND the
  // async tmp+rename path), so the "at most 1-2 writes for N appends" assertion catches a
  // regression to per-chunk writes regardless of which API performs them.
  let historyWrites = 0;
  const realWriteFileSync = fs.writeFileSync;
  const realPromisesWriteFile = fs.promises.writeFile;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    process.env.JANUS_HISTORY_FLUSH_MS = String(FLUSH_MS);
    process.env.JANUS_HISTORY_FLUSH_MAX_MS = String(MAX_LINGER_MS);

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-histflush-"));
    process.chdir(tmpDir);

    const serverMod = await import("../server");
    hm = serverMod.HistoryManager.getInstance();

    (fs as any).writeFileSync = (file: any, ...rest: any[]) => {
      if (String(file).includes(".janus_history")) historyWrites++;
      return (realWriteFileSync as any)(file, ...rest);
    };
    (fs.promises as any).writeFile = (file: any, ...rest: any[]) => {
      if (String(file).includes(".janus_history")) historyWrites++;
      return (realPromisesWriteFile as any)(file, ...rest);
    };
  });

  after(async () => {
    (fs as any).writeFileSync = realWriteFileSync;
    (fs.promises as any).writeFile = realPromisesWriteFile;
    // Drain any pending flush so rmSync doesn't race a rename.
    try { await hm.flushAll?.(); } catch { /* legacy impl has no flushAll */ }
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("N rapid appends coalesce to at most 2 file writes; final content correct; no tmp residue", async () => {
    historyWrites = 0;
    hm.addCommand("t1", "echo hello");
    let expected = "";
    for (let i = 0; i < 25; i++) {
      const chunk = `chunk${i};`;
      expected += chunk;
      hm.appendOutputToLastCommand("t1", chunk);
    }

    // Wait until the debounced flush lands the final state on disk.
    await waitFor(() => {
      const parsed = readHistoryFile();
      return parsed.t1?.[0]?.output === expected;
    });
    // Give a trailing debounce window a chance to (wrongly) fire extra writes.
    await new Promise((r) => setTimeout(r, FLUSH_MS * 3));

    assert.ok(
      historyWrites <= 2,
      `26 rapid mutations must flush in at most 2 writes (debounce + max-linger), saw ${historyWrites}`,
    );

    const parsed = readHistoryFile();
    assert.strictEqual(parsed.t1.length, 1, "exactly one history entry for the one command");
    assert.strictEqual(parsed.t1[0].command, "echo hello");
    assert.strictEqual(parsed.t1[0].output, expected, "all appended chunks landed in order");
    assert.strictEqual(typeof parsed.t1[0].timestamp, "string");

    // Format identical to the legacy writer: pretty-printed, 2-space indent.
    const raw = fs.readFileSync(historyPath(), "utf-8");
    assert.match(raw, /^\{\n {2}"/, "file keeps the JSON.stringify(..., null, 2) layout");

    // Atomic write: no temp file left behind.
    const leftovers = fs.readdirSync(tmpDir).filter((f) => f.includes(".janus_history") && f !== ".janus_history.json");
    assert.deepStrictEqual(leftovers, [], "no atomic-write temp files left behind");
  });

  it("read-after-write-before-flush returns the fresh data (cache), while the file write is deferred", () => {
    hm.addCommand("t2", "run thing");
    hm.appendOutputToLastCommand("t2", "FRESH-OUTPUT");

    // The cache must serve the mutation immediately...
    const history = hm.loadHistory("t2");
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].output, "FRESH-OUTPUT", "loadHistory never returns stale pre-flush data");

    // ...while the on-disk file has NOT been rewritten synchronously (the whole point of 4E.1).
    const onDisk = readHistoryFile();
    assert.strictEqual(onDisk.t2, undefined, "the per-chunk synchronous file rewrite is gone (write is deferred)");
  });

  it("flushAll() — the server close() path — forces pending mutations to disk immediately", async () => {
    hm.addCommand("t3", "final command");
    hm.appendOutputToLastCommand("t3", "tail");

    await hm.flushAll();

    const parsed = readHistoryFile();
    assert.strictEqual(parsed.t3?.[0]?.command, "final command", "close-path flush persists pending history");
    assert.strictEqual(parsed.t3?.[0]?.output, "tail");
    // Earlier panes' flushed data must survive (one shared multi-pane file).
    assert.ok(parsed.t1, "previously flushed panes survive later flushes");
  });

  it("foreign pane keys written directly to the file (inline action-def ports) survive a flush", async () => {
    await hm.flushAll();
    // Simulate src/actions/defs/* writing the SAME file out-of-band.
    const all = readHistoryFile();
    all["foreign-pane"] = [{ command: "x", timestamp: "t", output: "o" }];
    fs.writeFileSync(historyPath(), JSON.stringify(all, null, 2), "utf-8");

    hm.appendOutputToLastCommand("t3", "+more");
    await hm.flushAll();

    const parsed = readHistoryFile();
    assert.deepStrictEqual(
      parsed["foreign-pane"],
      [{ command: "x", timestamp: "t", output: "o" }],
      "flush merges over the on-disk file instead of clobbering foreign keys",
    );
    assert.ok(String(parsed.t3[0].output).endsWith("+more"), "the dirty pane's mutation landed too");
  });
});
