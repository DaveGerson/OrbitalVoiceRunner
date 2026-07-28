// Graceful per-pane EXIT (terminate + archive) and the async scrollback writer.
//
// B3: OrchestratorManager.stopAndArchivePane() is the missing middle between the
// destructive hard-delete (DELETE /panes/:id, which erases the ledger record) and
// the reactive "Clear Exited". It kills the PTY, marks the pane Exited, and moves it
// into the RECOVERABLE archive — the ledger record survives (restorable), the live
// terminal object is dropped. Backend-agnostic: uses only interface methods
// (archiveExitedPanes + updatePane via syncLedger), so it holds against any LedgerLike.
//
// B2: appendScrollback no longer blocks the event loop with a per-chunk
// fs.appendFileSync (that synchronous disk write, fired once per PTY output burst on
// the SAME loop as the Gemini voice callback, aggravated the pane-open stall). It now
// queues writes on an ordered async promise-chain; flushScrollback() awaits the chain
// so callers (stop/restart) can guarantee durability.
//
// Each manager test gets an ISOLATED in-memory JanusStore ledger (dbt3: SQLite is the
// only ledger backend) so sibling suites can't pollute the archive counts.

// bead eoef: pin the settings file into a tmpdir for this whole file — constructing an
// OrchestratorManager (directly or via startServer) without this writes a cwd-relative
// .janus_settings.json into the repo root, which the run-unit cleanliness gate fails on.
import { pinSettingsPathToTmpdir } from "./helpers/settingsPath";
pinSettingsPathToTmpdir();

import { describe, it } from "node:test";
import assert from "node:assert";
import { OrchestratorManager, UniversalTerminal } from "../src/terminal";
import { JanusStore } from "../src/store/sqliteStore";
import type { PtyTransport } from "../src/ptyTransport";
import fs from "fs";

// Minimal PtyTransport stub: fires onExit synchronously on kill() (a pty that exits
// immediately when signalled), so stop() resolves without a real ConPTY spawn.
class StubTransport implements PtyTransport {
  pid: number | undefined = 5555;
  private exitCb: ((info: { exitCode: number; signal?: number }) => void) | null = null;
  onData(_cb: (data: string) => void): void { /* no output in the stub */ }
  onExit(cb: (info: { exitCode: number; signal?: number }) => void): void { this.exitCb = cb; }
  write(_data: string): void { /* no-op */ }
  resize(_cols: number, _rows: number): void { /* no-op */ }
  kill(_signal?: string): void { this.exitCb?.({ exitCode: 0 }); }
  async drainTeardown(): Promise<void> { /* stub has no native handle to drain */ }
}

function cleanupScrollback(id: string): void {
  try { fs.unlinkSync(`.janus_scrollback_${id}.log`); } catch { /* already gone */ }
}

function makeIsolatedManager(_tag: string): { manager: OrchestratorManager; store: JanusStore } {
  const store = new JanusStore(":memory:");
  store.init();
  const manager = new OrchestratorManager({ ledger: store });
  return { manager, store };
}

describe("OrchestratorManager.stopAndArchivePane (graceful exit + archive)", () => {
  it("kills the pane, moves it to the recoverable archive, and drops the live object WITHOUT hard-deleting the record", async () => {
    const { manager, store } = makeIsolatedManager("exit");
    const projectId = "default_project";
    const paneId = "p-exit";

    // Register a live pane without a real spawn: inject a stub transport, then sync to the ledger.
    const term = new UniversalTerminal(paneId, ".", "echo hi", "Custom", "Human-in-the-Loop", "", projectId);
    (term as any).transport = new StubTransport();
    term.status = "Idle"; // alive
    manager.terminals[paneId] = term;
    (manager as any).syncLedger();

    // Precondition: pane is present, alive, and nothing is archived yet (isolated ledger).
    let ws = manager.ledger.getProject(projectId);
    assert.ok(ws?.panes[paneId], "pane should be registered in the active project");
    assert.strictEqual(ws!.panes[paneId].alive, true, "pane starts alive");
    assert.strictEqual(manager.ledger.listArchived().length, 0, "nothing archived yet");

    // Act: graceful exit.
    const archived = await manager.stopAndArchivePane(projectId, paneId);

    // Assert: archived, live object dropped, pane out of the active list but recoverable.
    assert.strictEqual(archived, true, "reports that a pane was archived");
    assert.ok(!manager.terminals[paneId], "the live terminal object is dropped");
    ws = manager.ledger.getProject(projectId);
    assert.ok(!ws?.panes[paneId], "pane is removed from the ACTIVE pane list");
    const arch = manager.ledger.listArchived();
    assert.strictEqual(arch.length, 1, "pane is moved to the recoverable archive (not hard-deleted)");
    assert.strictEqual(arch[0].pane.pane_id, paneId, "the correct pane was archived");

    cleanupScrollback(paneId);
    store.close();
  });

  it("is a safe no-op-ish call when the pane has no live terminal (already exited)", async () => {
    const { manager, store } = makeIsolatedManager("ghost");
    const archived = await manager.stopAndArchivePane("default_project", "ghost-pane");
    assert.strictEqual(archived, false, "no pane archived when none exists");
    store.close();
  });

  // wsm-e2e-pinned-kdtu: the archive-intent mark MUST be set SYNCHRONOUSLY at entry — before the
  // awaited stop(). A one-tap 86 that joins a gated restart's in-flight stop() has its promise
  // reaction registered AFTER the restart's, so the restart continuation resumes FIRST; the
  // synchronous mark is the ONLY signal it can consult at that instant (terminals[id] is still
  // populated). tests/test_panes_rest_c55.ts pins the full interleaving against a mirror of this
  // method; THIS test pins the real method's load-bearing ordering so the mirror cannot drift.
  it("marks archivingPanes SYNCHRONOUSLY at entry (before the awaited stop) and clears it when done", async () => {
    const { manager, store } = makeIsolatedManager("mark");
    const paneId = "p-mark";
    const term = new UniversalTerminal(paneId, ".", "echo hi", "Custom", "Human-in-the-Loop", "", "default_project");
    let releaseStop!: () => void;
    const stopGate = new Promise<void>((r) => { releaseStop = r; });
    (term as any).stop = async () => { await stopGate; };
    term.status = "Idle";
    manager.terminals[paneId] = term;
    (manager as any).syncLedger();

    const archive = manager.stopAndArchivePane("default_project", paneId); // not awaited yet
    assert.strictEqual(
      manager.archivingPanes.has(paneId), true,
      "archive intent is visible synchronously, before stop() resolves"
    );

    releaseStop();
    await archive;
    assert.strictEqual(manager.archivingPanes.has(paneId), false, "mark is cleared after the archive completes");
    assert.ok(!manager.terminals[paneId], "the live terminal object is dropped");

    cleanupScrollback(paneId);
    store.close();
  });
});

describe("UniversalTerminal scrollback writer (async, ordered)", () => {
  it("persists appended chunks in order; flushScrollback() awaits the pending async writes", async () => {
    const paneId = "p-flush";
    cleanupScrollback(paneId);
    const term = new UniversalTerminal(paneId, ".", "echo hi", "Custom", "Human-in-the-Loop", "", "default_project");

    (term as any).appendScrollback("first-line\n");
    (term as any).appendScrollback("second-line\n");

    // The writes are async now — flushScrollback() must drain the ordered chain.
    await term.flushScrollback();

    const content = fs.readFileSync(`.janus_scrollback_${paneId}.log`, "utf-8");
    assert.ok(content.includes("first-line"), "first chunk persisted");
    assert.ok(content.includes("second-line"), "second chunk persisted");
    assert.ok(
      content.indexOf("first-line") < content.indexOf("second-line"),
      "chunks are written in append order (ordered chain, not racing)"
    );

    cleanupScrollback(paneId);
  });
});
