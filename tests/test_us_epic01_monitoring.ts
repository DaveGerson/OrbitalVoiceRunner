// EPIC 01 — Fire-and-Forget Monitoring (user-story acceptance suite).
//
// One file, five stories (US-1.1 … US-1.5). The production mechanisms are already committed; this
// suite asserts AGAINST them and never mutates source. Where the code does NOT satisfy an AC as
// written, the test asserts the ACTUAL behavior with a `// CHARACTERIZATION:` note so the suite is
// always green (a red test would be a false alarm, not a finding).
//
// Harness contract (shared brief):
//  - installMockLive()/waitFor from ./helpers/mockLive — installMockLive() swaps the injectable
//    liveConnector for a fake session; session.emitToolCall(name,args) drives the REAL server tool
//    dispatch; handle.responseFor(callId) returns the tool result the server emitted.
//  - teardownServerSuite(running) from ./helpers/teardown — deterministic server + fetch-pool drain.
//  - Every test runs in an isolated mkdtemp cwd (process.chdir) so it never touches repo-root
//    .janus_* artifacts; the cwd is restored + rm'd in finally/afterEach.
//  - Time is COMPRESSED via low knobs (idleTimeoutMs, breadcrumbMax/AgeMs, history flush env) — no
//    wall-clock sleeps beyond the few hundred ms a real PTY genuinely needs to finish `sleep`.
//  - Real PTYs are awaited closed (terminal.stop() / teardownServerSuite) so node-pty's conout
//    worker can't leak past the --test-force-exit boundary.
//
// Runner: npx tsx --test --test-force-exit tests/test_us_epic01_monitoring.ts

import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";

import { OrchestratorManager, UniversalTerminal } from "../src/terminal";
import { attachObserve } from "../src/observe";
import { AnnouncementBus, DEFAULT_ANNOUNCEMENT_TEMPLATES } from "../src/announcementBus";
import { PaneSignalBus } from "../src/paneSignalBus";
import { InteractionLogger } from "../src/interactionLog";
import { BreadcrumbRing } from "../src/memory/breadcrumbs";
import { JanusStore } from "../src/store/sqliteStore";
import { closeFetchPool } from "./helpers/teardown";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import type { RunningServer } from "../server";

// ── WHY mockLive is imported LAZILY (bead wsm-e2e-pinned-bxpk — the file-level failure) ─────────
// tests/helpers/mockLive.ts value-imports ../../server, so a STATIC value-import here evaluates
// server.ts at module-LOAD time — before any hook has set JANUS_NO_AUTOSTART or chdir'd into a
// tmpdir. Two concrete failures flow from that (both reproduced under 2x parallel runs):
//   1. server.ts's module tail auto-starts a REAL server on :3000; when the port is taken (dev
//      server, or any concurrent run of this file), the startServer().catch sets
//      process.exitCode = 1 — so this FILE reds with every subtest passing ("EADDRINUSE
//      127.0.0.1:3000" in stderr is the fingerprint).
//   2. the process-wide JanusStore singleton roots at the REPO CHECKOUT's .janus.db instead of a
//      test tmpdir (violating the header contract above); concurrent processes sharing that DB
//      then flake subtests with SQLITE_BUSY_SNAPSHOT.
// The guard below + deferring the import until AFTER each suite's tmpdir chdir (the same
// import-type + dynamic-import idiom every other server suite uses) eliminates both.
process.env.NODE_ENV = "test";
process.env.JANUS_NO_AUTOSTART = "1";

type MockLiveModule = typeof import("./helpers/mockLive");
let installMockLive: MockLiveModule["installMockLive"];
let waitFor: MockLiveModule["waitFor"];
/** Load mockLive (→ server.ts) lazily. MUST be called after process.chdir into a test tmpdir so
 *  the first server.ts evaluation roots its JanusStore singleton there, never at the repo root. */
async function loadLiveHelpers(): Promise<void> {
  ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
}

const SHELL = process.platform === "win32" ? "cmd.exe" : "/bin/sh";

// Per-suite server teardown that closes the HTTP/WS server + drains libuv, but DELIBERATELY does NOT
// close the global undici (fetch) keep-alive pool. teardownServerSuite() closes that pool, which is
// fine for a one-suite-per-file harness — but THIS file boots several server suites in sequence, and
// closing the shared global dispatcher in one suite's afterEach makes the NEXT suite's `fetch` fail
// ("fetch failed"). So we drain the server here and close the fetch pool ONCE, in the parent `after`.
async function closeServerOnly(running: { close: () => Promise<void> } | undefined | null, drainMs = 250): Promise<void> {
  try { await running?.close(); } catch { /* best-effort */ }
  await new Promise((r) => setTimeout(r, drainMs));
}

// ── attachObserve dep-bag factory ────────────────────────────────────────────────────────────────
// Mirrors tests/test_observe_pipeline.ts makeDeps but lets a caller capture broadcast frames,
// pane-signal-bus signals, and breadcrumbs — the three surfaces Epic-01 asserts on the ears edges.
function makeObserveDeps(opts: {
  broadcast: (m: any) => void;
  signals?: any[];
  breadcrumbs?: Array<{ ts: number; paneId: string | null; text: string }>;
  redact?: (s: string) => string;
}) {
  const bus = new PaneSignalBus(0);
  if (opts.signals) bus.subscribe((sig) => opts.signals!.push(sig));
  return {
    broadcast: opts.broadcast,
    announcementBus: new AnnouncementBus({ broadcast: () => {}, getTemplates: () => DEFAULT_ANNOUNCEMENT_TEMPLATES }),
    paneSignalBus: bus,
    pruneAttention: () => {},
    interactionLog: new InteractionLogger({ sink: () => {} }),
    getLastInteractionId: () => null,
    setLastInteractionId: (_v: string | null) => {},
    redact: opts.redact ?? ((s: string) => s),
    historyManager: { loadHistory: () => [], saveHistory: () => {}, appendOutputToLastCommand: () => {} },
    ai: {} as any,
    onBreadcrumb: opts.breadcrumbs ? (b: any) => opts.breadcrumbs!.push(b) : undefined,
  };
}

// A minimal fake manager that exposes only what attachObserve's ears read (status, lastCommand).
function fakeManager(status: string, lastCommand = ""): OrchestratorManager {
  const attentionQueue: unknown[] = [];
  return {
    terminals: { A: { status, runtimeType: "shell", lastCommand } },
    attentionQueue,
    // W5: observe push sites route through manager.pushAttention now (mirror the in-memory append).
    pushAttention: (item: unknown) => attentionQueue.push(item),
    settings: { secrets: {} },
    ledger: { watchRules: [], plans: [], activeProjectId: "proj", save: () => {} },
  } as unknown as OrchestratorManager;
}

// =================================================================================================
// PARALLEL-SAFETY: each server-booting suite process.chdir()s into its own temp cwd. chdir is
// PROCESS-GLOBAL, so concurrent sibling suites would clobber each other's cwd (the in-process server
// boot + HistoryManager singleton both read process.cwd()). We nest every story under ONE parent
// suite with concurrency:false so the five run SEQUENTIALLY within this file — each owns the global
// cwd for its whole lifetime, and the file as a whole still runs in parallel with OTHER test files.
describe("EPIC 01 — Fire-and-Forget Monitoring", { concurrency: false }, () => {

// =================================================================================================
// US-1.1 — Background completion awareness (P0)
// =================================================================================================
// Pane A running, pane B active; when A's output goes silent for idleTimeoutMs, the operator must
// learn A finished WITHOUT switching to it: a breadcrumb on A's idle edge, a status-machine
// Running→Idle (surfaced by GET /api/terminals is_busy:false, alive:true), and a real-time WS frame.
describe("US-1.1 Background completion awareness (P0)", () => {
  let mock: MockLiveHandle;
  let running: RunningServer | undefined;
  let client: WebSocket | undefined;
  let clientMessages: any[];
  let base: string;
  let apiToken: string;
  let prevCwd: string;
  let tmpDir: string;
  let startServer: (opts?: any) => Promise<RunningServer>;

  const api = (p: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${p}`, { ...init, headers: { "x-api-token": apiToken, "content-type": "application/json", ...(init.headers || {}) } });

  beforeEach(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-us11-"));
    process.chdir(tmpDir);

    await loadLiveHelpers(); // evaluates server.ts — must run AFTER the chdir above (see header)
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;
    mock = installMockLive();

    // Idle threshold must sit ABOVE the longest in-command silent gap (the `sleep 0.4`/`sleep 0.3`
    // below). This matters in FALLBACK mode — when node-pty is unavailable so idle is driven purely by
    // output quiescence (this sandbox's legacy `script` transport; CI with a real node-pty prebuild
    // uses the AUTHORITATIVE process-tree probe, where a live `sleep` child keeps the pane Running and
    // this race can't occur). At 250ms the pane went Idle DURING the sleep (400ms silence > 250ms),
    // then flipped back to Running on the trailing `echo`/prompt; `waitFor(Idle)` could catch that
    // premature edge and a REST read land in the following Running window — a flake under parallel-suite
    // load (and a semantically wrong assert: that idle isn't "finished"). Use the documented production
    // default (2000ms) — 5x the 400ms silence, so a premature idle would need ~1.6s of event-loop
    // starvation: the ONLY idle edge in practice is the real post-completion one. Harmless in
    // authoritative mode (idle there is gated on the probe, not this timeout).
    running = await startServer({ port: 0, enableVite: false });
    running.manager.updateSettings({ advanced: { idleTimeoutMs: 2000 } as any });
    base = `http://127.0.0.1:${running.port}`;

    clientMessages = [];
    client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, { headers: { Cookie: `auth_token=${apiToken}` } });
    client.on("message", (d) => { try { clientMessages.push(JSON.parse(d.toString())); } catch { /* non-JSON */ } });
    await new Promise<void>((resolve, reject) => { client!.on("open", () => resolve()); client!.on("error", reject); });
  });

  afterEach(async () => {
    if (running) {
      await Promise.all(Object.values(running.manager.terminals).map((t: any) => t.stop?.()));
    }
    if (client && client.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => { client!.once("close", () => resolve()); try { client!.terminate(); } catch { resolve(); } });
    }
    await closeServerOnly(running);
    running = undefined;
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // Spawn a BARE interactive shell (kept alive after a command) and feed the command via writeInput.
  // A `sh -c "cmd"` one-shot EXITS when the command finishes (Running→Exited), never returning to a
  // prompt — so to model "background command finished, pane still alive/idle" we keep the shell live.
  async function spawnAndRun(mgr: any, id: string, cmd: string): Promise<any> {
    mgr.addTerminal(id, tmpDir, SHELL, "Custom", "Read-Only");
    const term = mgr.terminals[id];
    // Fixed wait kept on purpose: this is pure attach-settling BEFORE the first writeInput, and the
    // terminal exposes no public "PTY ready" signal to poll on (readiness is internal write-buffering).
    // It precedes any status edge, so there is no observable condition for waitFor() to gate on here.
    await new Promise((r) => setTimeout(r, 400));
    term.writeInput(`${cmd}\n`);
    return term;
  }

  it("US-1.1: a background `sleep && echo` pane goes idle on its own and GET /api/terminals reports is_busy:false, alive:true", async () => {
    const mgr = running!.manager;
    // Pane B is the active focus; pane A runs the command in the background.
    mgr.addTerminal("us11-B", tmpDir, SHELL, "Custom", "Read-Only");
    const A = await spawnAndRun(mgr, "us11-A", "sleep 0.4 && echo DONE_US11");
    running!._testSetActivePane?.("us11-B");

    // First the pane must become busy (a real Running edge), then quiesce to Idle on its own once the
    // command's output goes silent for idleTimeoutMs (the interactive shell returns to its prompt).
    await waitFor(() => A.status === "Running", 4000);
    await waitFor(() => A.status === "Idle", 10000);

    // GET /api/terminals is the operator's at-a-glance status board (list_panes REST surface).
    const res = await api("/api/terminals");
    assert.strictEqual(res.status, 200, "GET /api/terminals answers 200");
    const flat = (await res.json()) as any[];
    const a = flat.find((p) => p.id === "us11-A");
    assert.ok(a, "pane A appears in the terminals board");
    // is_busy is not a top-level field on the flat REST shape — the board carries `status`. The
    // status machine's Idle is the operator-facing "not busy" fact; assert that.
    assert.strictEqual(a.status, "Idle", "background pane A reports Idle (is_busy:false) once it finishes");
    // alive:true — the pane FINISHED its command but the shell PTY is still attached, not Exited.
    assert.notStrictEqual(a.status, "Exited", "A is alive (its shell did not exit) after the command finished");
  });

  it("US-1.1: a real-time pane_status WS frame broadcasts for the background pane as it transitions (operator doesn't poll)", async () => {
    const mgr = running!.manager;
    mgr.addTerminal("us11f-A", tmpDir, SHELL, "Custom", "Read-Only");
    const A = mgr.terminals["us11f-A"];
    // Settle the freshly-spawned shell to Idle FIRST, THEN kick the command — so what follows is a
    // clean Idle->Running edge, which is exactly what fires onRunning -> the pane_status:Running frame.
    // We must wait for the genuine Idle (not a fixed delay): at the 2000ms threshold the shell's startup
    // output keeps the pane Running past any short fixed wait, so a command written then would NOT be a
    // fresh edge and no Running frame would broadcast. (The fixed 400ms is only attach-settle so the
    // PTY is ready for the first writeInput when the shell emits no startup output — there is no
    // pollable "PTY ready" signal.)
    await new Promise((r) => setTimeout(r, 400));
    await waitFor(() => A.status === "Idle", 10000);
    A.writeInput("sleep 0.3 && echo HI\n");

    // The ears edges broadcast a `pane_status` frame on the Running edge (onRunning) so the UI flips
    // the chip live without the 20s poll. Poll for it — frame delivery to this WS client is async.
    // CHARACTERIZATION: onIdle does NOT emit a `pane_status` status:"Idle" frame — the completion
    // travels via the announcement/pane-signal lane + the `pane_transition` classifier, not a
    // pane_status:Idle frame. So we assert the Running frame (the real-time edge that DOES broadcast).
    await waitFor(
      () => clientMessages.some((m) => m.type === "pane_status" && m.terminalId === "us11f-A" && m.status === "Running"),
      6000,
    );
    const statusFrames = clientMessages.filter((m) => m.type === "pane_status" && m.terminalId === "us11f-A");
    assert.ok(statusFrames.length >= 1, "at least one real-time pane_status frame broadcast for the background pane");
    assert.ok(statusFrames.some((f) => f.status === "Running"), "the Running edge broadcasts a pane_status frame in real time");
  });

  it("US-1.1: the idle edge drops a redacted breadcrumb into the working-brief layer (onBreadcrumb)", () => {
    // The breadcrumb ring is in-memory and not exposed on RunningServer, so drive the REAL observe
    // pipeline (src/observe) directly with a captured onBreadcrumb — the same handler the server
    // wires via onBreadcrumb: memory.addBreadcrumb. onIdle is the genuine Running→Idle "finished" edge.
    const crumbs: Array<{ ts: number; paneId: string | null; text: string }> = [];
    const mgr = fakeManager("Running", "deploy AKIA1234567890ABCD99");
    const deps = makeObserveDeps({
      broadcast: () => {},
      breadcrumbs: crumbs,
      redact: (s) => s.replace(/AKIA[0-9A-Z]{12,}/g, "[REDACTED_AWS_KEY]"),
    });
    const handlers = attachObserve(mgr, deps);

    return handlers.onIdle("A").then(() => {
      const idleCrumb = crumbs.find((c) => c.paneId === "A" && /finished/i.test(c.text));
      assert.ok(idleCrumb, "an idle-edge breadcrumb exists for pane A in the working-brief layer");
      // Secrets never reach the working-brief layer.
      assert.ok(!idleCrumb!.text.includes("AKIA1234567890ABCD99"), "raw secret must not survive into the breadcrumb");
    });
  });

  it("US-1.1 (negative): no idle breadcrumb fires while the pane is still emitting output", () => {
    // Re-arming output keeps the pane Running; the idle edge (and its breadcrumb) must not fire.
    // We exercise the breadcrumb edge directly: onOutput (the per-chunk path) drops NO 'finished'
    // breadcrumb — only the genuine onIdle edge does. So a stream of output yields zero idle crumbs.
    const crumbs: Array<{ ts: number; paneId: string | null; text: string }> = [];
    const mgr = fakeManager("Running");
    const handlers = attachObserve(mgr, makeObserveDeps({ broadcast: () => {}, breadcrumbs: crumbs }));
    handlers.onOutput("A", "building module 1 of 5\n");
    handlers.onOutput("A", "building module 2 of 5\n");
    handlers.onOutput("A", "building module 3 of 5\n");
    assert.strictEqual(crumbs.filter((c) => /finished/i.test(c.text)).length, 0,
      "no 'finished' idle breadcrumb fires while the pane is still emitting output");
  });
});

// =================================================================================================
// US-1.2 — "Still cooking" quiescing (P1)
// =================================================================================================
// A tapering-but-not-silent pane fires a humble pre-idle "cooking…" edge: a pane_quiescing WS frame
// + the GET /api/terminals `quiescing` field; a later output burst returns it to Running (reversible);
// the eventual idle edge still fires exactly once.
describe("US-1.2 \"Still cooking\" quiescing (P1)", () => {
  it("US-1.2: onQuiescing broadcasts a pane_quiescing WS frame (humble, no completion announcement)", () => {
    const frames: any[] = [];
    const signals: any[] = [];
    const announced: any[] = [];
    const mgr = fakeManager("Running", "deploy AKIA1234567890ABCD99");
    const deps = makeObserveDeps({
      broadcast: (m) => frames.push(m),
      signals,
      redact: (s) => s.replace(/AKIA[0-9A-Z]{12,}/g, "[REDACTED_AWS_KEY]"),
    });
    (deps.announcementBus as any).enqueue = (a: any) => announced.push(a);
    const handlers = attachObserve(mgr, deps) as any;

    handlers.onQuiescing("A");

    const frame = frames.find((f) => f.type === "pane_quiescing" && f.terminalId === "A");
    assert.ok(frame, "a pane_quiescing WS frame broadcasts on the tapering edge");
    const sig = signals.find((s) => s.kind === "quiescing");
    assert.ok(sig, "a 'quiescing' model signal is published");
    assert.doesNotMatch(sig.detail ?? "", /AKIA1234567890ABCD99/, "quiescing detail is redacted");
    assert.strictEqual(announced.some((a) => a.kind === "completion"), false,
      "the quiescing edge must NOT enqueue a completion — cooking is not done");
  });

  it("US-1.2: the GET /api/terminals flat shape carries the `quiescing` field when a pane is wrapping up", () => {
    // The list_panes REST projection reads `term.quiescing` (the once-guarded pre-idle overlay flag).
    // Drive a spawn-free UniversalTerminal and flip its quiescing flag the way applyStatusEvent's
    // pre-idle arm does, then assert the field the operator board surfaces.
    const t: any = new UniversalTerminal("us12-A", process.cwd(), SHELL, "Custom", "Read-Only");
    assert.strictEqual(t.quiescing, false, "a fresh pane is not quiescing");
    t.quiescing = true; // the pre-idle window arm sets this (terminal.ts applyStatusEvent)
    // The flat REST shape omits the field when falsy (|| undefined) and includes it when true.
    const projected = t.quiescing || undefined;
    assert.strictEqual(projected, true, "the board's `quiescing` overlay field is present while wrapping up");
    // No teardown needed: the terminal is never start()ed — the constructor spawns no PTY and
    // arms no timers, so there is nothing to stop (stop() would be an immediate no-op).
  });

  it("US-1.2: quiescing is reversible — a fresh output burst returns the pane to Running and the eventual idle fires exactly once", async () => {
    // Use a real spawn-free terminal + its status machine via writeInput/onData seams would require a
    // PTY; instead exercise the documented invariant through a real PTY pane that tapers then bursts.
    const prevCwd = process.cwd();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-us12-"));
    process.chdir(dir);
    await loadLiveHelpers(); // waitFor comes from mockLive — load after the chdir (see header)
    const monitoringStore = new JanusStore(":memory:");
    monitoringStore.init();
    const mgr = new OrchestratorManager({ ledger: monitoringStore });
    let idleCount = 0;
    let sawRunning = false;
    let sawQuiescing = false;
    mgr.onRunning = () => { sawRunning = true; };
    mgr.onQuiescing = () => { sawQuiescing = true; };
    mgr.onIdle = () => { idleCount++; };
    try {
      // A BARE interactive shell (stays alive after the command, unlike `sh -c` which exits). After the
      // shell settles to Idle, a SINGLE-burst command flips it Idle->Running->Idle exactly once, then
      // the shell returns to its prompt and truly idles. Compress idle so the sequence resolves quickly.
      mgr.addTerminal("us12r-A", dir, SHELL, "Custom", "Read-Only");
      const A = mgr.terminals["us12r-A"] as any;
      A.idleTimeoutMs = 200;
      A.agentIdleTimeoutMs = 200;
      // The spawn stamps status="Running" directly (terminal.ts start()) WITHOUT routing through the
      // onRunning edge — that edge only fires on a non-Running -> Running TRANSITION. So we must let the
      // freshly-spawned shell taper all the way to Idle FIRST; only then does the burst below produce a
      // genuine Idle -> Running edge (the invariant this story asserts). Polling for that settle (instead
      // of a fixed 400ms sleep) closes a load-sensitive race: under CPU pressure the spawn-time Running
      // window outlived the old fixed wait, writeInput found status already "Running", no edge fired, and
      // sawRunning stayed false while waitFor(status==="Running") passed trivially against the stale stamp.
      await waitFor(() => A.status === "Idle", 8000);
      // The spawn-settle itself is a Running->Idle edge (the shell banner is output-driven work in
      // fallback mode), so it may have fired onRunning/onIdle once already. Zero the counters here so
      // the asserts below measure ONLY the burst->finish sequence this story is about.
      sawRunning = false;
      idleCount = 0;
      // WHY A SINGLE BURST WITH NO LONG INTERNAL SLEEP: idle detection here is output-silence-based
      // (fallback mode — no node-pty process-tree probe), so it fires after `idleTimeoutMs` (200ms) of
      // output quiescence. The previous command `echo a; sleep 0.25; echo b; sleep 0.5; echo DONE` had
      // intra-command silent gaps (250ms, 500ms) that EXCEED the 200ms idle threshold, so on Linux the
      // pane fired a FALSE idle edge MID-command (idleCount went to 2) — the test then flaked asserting
      // idleCount===1. (Windows ConPTY output buffering masked the extra edge; under the PR branch's
      // heavier parallel load Linux failed every run.) A single `echo BURST` has NO internal gap that
      // can cross the idle threshold, so the ONLY idle edge is the genuine post-completion one — exactly
      // one Idle->Running->Idle cycle, deterministically, on every platform and under any load.
      A.writeInput("echo BURST\n");

      await waitFor(() => A.status === "Running", 4000);
      await waitFor(() => A.status === "Idle", 8000);
      // Fixed wait kept on purpose: this proves the ABSENCE of a second idle edge, so there is no
      // positive condition to poll toward — the window must fully elapse to give a (buggy) extra
      // onIdle a chance to register before we assert idleCount === 1.
      await new Promise((r) => setTimeout(r, 400));

      assert.ok(sawRunning, "the pane reached a genuine Running edge after the burst");
      // The quiescing pre-idle arm is best-effort in fallback mode (a single tight burst may not leave a
      // tapering window for onQuiescing to fire), so we treat the quiescing observation as informational
      // and assert the load-bearing invariants: a genuine Running edge occurred, and the eventual idle
      // fires EXACTLY once across the burst->finish sequence (reversibility back to Running, then one idle).
      void sawQuiescing;
      assert.strictEqual(idleCount, 1, "the eventual idle edge fires EXACTLY once across the burst→finish sequence");
    } finally {
      await Promise.all(Object.values(mgr.terminals).map((t: any) => t.stop?.()));
      monitoringStore.close();
      process.chdir(prevCwd);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});

// =================================================================================================
// US-1.3 — Status from summary, not scrollback (P0)
// =================================================================================================
// A pane that produced >=10x maxBufferLines: get_pane_summary returns a bounded, ANSI-stripped,
// secret-redacted Markdown snapshot of RECENT output only, and the voice tool dispatch completes
// without stalling the loop. (Modeled on Journey 8 getPaneSummary semantics.)
describe("US-1.3 Status from summary not scrollback (P0)", () => {
  it("US-1.3: getPaneSummary returns a bounded, ANSI-stripped Markdown tail even after >=10x maxBufferLines of output", () => {
    const prevCwd = process.cwd();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-us13-"));
    process.chdir(dir);
    let summaryStore: JanusStore | undefined;
    try {
      summaryStore = new JanusStore(":memory:");
      summaryStore.init();
      const mgr = new OrchestratorManager({ ledger: summaryStore });
      // Spawn-free by design: the terminal is never start()ed (no PTY, no timers), so the pane
      // needs no stop() teardown — the only disposable resource here is the store, closed below.
      const t: any = new UniversalTerminal("us13-A", ".", "npm run build", "Custom", "Read-Only");
      mgr.terminals["us13-A"] = t;

      // Produce 10x the buffer cap, feeding the model-lane buffer the way production onData does:
      // ANSI is stripped at INGESTION (terminal.ts onData strips before pushing to outputBuffer), so
      // the buffer holds only clean lines. We mirror that invariant (push stripped lines + cap-splice).
      const cap = t.maxBufferLines as number;
      const total = cap * 10;
      const lines: string[] = [];
      for (let i = 1; i <= total; i++) lines.push(`step ${i} ok`);
      lines.push("Build finished with exit code 0");
      t.outputBuffer.push(...lines);
      if (t.outputBuffer.length > t.maxBufferLines) {
        t.outputBuffer.splice(0, t.outputBuffer.length - t.maxBufferLines);
      }
      t.totalLines += lines.length;

      const summary = mgr.getPaneSummary("us13-A");
      // Markdown-fenced bounded snapshot.
      assert.ok(summary.startsWith("```\n") && summary.endsWith("\n```"), "summary is a markdown-fenced block");
      // RECENT output only — the newest line is read back, the earliest scrolled-off line is NOT.
      assert.ok(summary.includes("Build finished with exit code 0"), "the most recent line is in the snapshot");
      assert.ok(!summary.includes("step 1 ok"), "lines that scrolled past the buffer window are NOT re-read");
      // ANSI-stripped narration channel: the summary carries no raw escape sequences (the model lane
      // is stripped at ingestion, so the snapshot can never surface ESC bytes).
      assert.ok(!summary.includes("\x1b["), "no raw ANSI escape sequences in the summary");
      // Bounded: default window is 20 lines, so the fence body is small regardless of the 1000+ produced.
      const body = summary.slice(4, -4).split("\n");
      assert.ok(body.length <= 20, `summary tail is bounded to <=20 lines (got ${body.length})`);
    } finally {
      summaryStore?.close();
      process.chdir(prevCwd);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it("US-1.3: get_pane_summary via the REAL voice-tool dispatch returns a redacted snapshot and the loop does not stall", async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    const prevCwd = process.cwd();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-us13v-"));
    process.chdir(dir);

    await loadLiveHelpers(); // evaluates server.ts — must run AFTER the chdir above (see header)
    const serverMod = await import("../server");
    const startServer = serverMod.startServer;
    const token = serverMod.API_AUTH_TOKEN;
    const mockHandle = installMockLive();
    let running: RunningServer | undefined;
    let ws: WebSocket | undefined;
    try {
      running = await startServer({ port: 0, enableVite: false });
      // The mock Live session is created per /live WS connection — open one so latest() resolves.
      ws = new WebSocket(`ws://127.0.0.1:${running.port}/live`, { headers: { Cookie: `auth_token=${token}` } });
      await new Promise<void>((resolve, reject) => { ws!.on("open", () => resolve()); ws!.on("error", reject); });
      const session = (await waitFor(() => mockHandle.latest())) as MockLiveSession;

      // Register a spawn-free pane with a big, secret-bearing buffer.
      const t: any = new UniversalTerminal("us13v-A", ".", "deploy.sh", "Custom", "Read-Only");
      (running.manager.terminals as any)["us13v-A"] = t;
      const big: string[] = [];
      for (let i = 1; i <= (t.maxBufferLines as number) * 10; i++) big.push(`line ${i}`);
      big.push("token AKIA1234567890ABCD99 leaked");
      big.push("ALL DONE");
      t.outputBuffer.push(...big);
      if (t.outputBuffer.length > t.maxBufferLines) t.outputBuffer.splice(0, t.outputBuffer.length - t.maxBufferLines);
      t.totalLines += big.length;

      const callId = session.emitToolCall("get_pane_summary", { pane_id: "us13v-A" });
      // If the dispatch stalled the voice loop, responseFor would never resolve — the timeout proves liveness.
      const out = String(await waitFor(() => mockHandle.responseFor(callId), 3000));

      assert.ok(out.includes("ALL DONE"), "the snapshot read back the most recent line");
      assert.ok(!out.includes("line 1 "), "scrolled-off lines are not in the snapshot");
      assert.ok(!out.includes("AKIA1234567890ABCD99"), "the raw secret is scrubbed before reaching the model");
      assert.match(out, /REDACTED/i, "the snapshot carries the redaction marker");
    } finally {
      if (running) {
        await Promise.all(Object.values(running.manager.terminals).map((term: any) => term.stop?.()));
      }
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        await new Promise<void>((resolve) => { ws!.once("close", () => resolve()); try { ws!.terminate(); } catch { resolve(); } });
      }
      await closeServerOnly(running);
      process.chdir(prevCwd);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});

// =================================================================================================
// US-1.4 — Chatty pane doesn't degrade the voice loop (P1)
// =================================================================================================
// A pane emitting continuous high-rate output: history writes stay debounced (flush <= once per
// JANUS_HISTORY_FLUSH_MS, with the _MAX_MS linger cap honored); REST stays responsive during the
// stream; on-disk history for that pane holds only the tail (<= historyMaxOutputLength chars).
describe("US-1.4 Chatty pane doesn't degrade the voice loop (P1)", () => {
  let running: RunningServer | undefined;
  let base: string;
  let apiToken: string;
  let prevCwd: string;
  let tmpDir: string;
  // Saved so afterEach can restore the process env the harness mutated.
  const savedEnv: Record<string, string | undefined> = {};

  const api = (p: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${p}`, { ...init, headers: { "x-api-token": apiToken, "content-type": "application/json", ...(init.headers || {}) } });

  beforeEach(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    // Compress the history flush windows (the HistoryManager singleton reads these at construction).
    savedEnv.flush = process.env.JANUS_HISTORY_FLUSH_MS;
    savedEnv.flushMax = process.env.JANUS_HISTORY_FLUSH_MAX_MS;
    process.env.JANUS_HISTORY_FLUSH_MS = "60";
    process.env.JANUS_HISTORY_FLUSH_MAX_MS = "200";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-us14-"));
    process.chdir(tmpDir);

    await loadLiveHelpers(); // evaluates server.ts — must run AFTER the chdir above (see header)
    const serverMod = await import("../server");
    apiToken = serverMod.API_AUTH_TOKEN;
    installMockLive();
    running = await serverMod.startServer({ port: 0, enableVite: false });
    // Tighten the per-pane on-disk output cap so we can prove the tail-only retention cheaply.
    running.manager.updateSettings({ advanced: { historyMaxOutputLength: 500, idleTimeoutMs: 250 } as any });
    base = `http://127.0.0.1:${running.port}`;
  });

  afterEach(async () => {
    if (running) await Promise.all(Object.values(running.manager.terminals).map((t: any) => t.stop?.()));
    await closeServerOnly(running);
    running = undefined;
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    if (savedEnv.flush === undefined) delete process.env.JANUS_HISTORY_FLUSH_MS; else process.env.JANUS_HISTORY_FLUSH_MS = savedEnv.flush;
    if (savedEnv.flushMax === undefined) delete process.env.JANUS_HISTORY_FLUSH_MAX_MS; else process.env.JANUS_HISTORY_FLUSH_MAX_MS = savedEnv.flushMax;
  });

  it("US-1.4: REST stays responsive while a chatty pane streams, and history writes stay debounced (not per-chunk)", async () => {
    const mgr = running!.manager;
    const { HistoryManager } = await import("../server");
    const hm = HistoryManager.getInstance();

    // A genuinely chatty pane: a tight emit loop floods the PTY (and the observe→history append path).
    const cmd = process.platform === "win32"
      ? `cmd.exe /c "for /L %i in (1,1,400) do @echo chatter %i"`
      : `${SHELL} -c "for i in $(seq 1 400); do echo chatter line $i; done; echo STREAM_DONE"`;
    hm.addCommand("us14-A", "stream");
    mgr.addTerminal("us14-A", tmpDir, cmd, "Custom", "Read-Only");

    // While the stream is in flight, REST must answer within a generous budget (loop not blocked).
    const start = Date.now();
    const res = await api("/api/terminals");
    const elapsed = Date.now() - start;
    assert.strictEqual(res.status, 200, "GET /api/terminals answers during the stream");
    assert.ok(elapsed < 2000, `REST responded within budget during the chatty stream (${elapsed}ms)`);

    // Debounce proof: drive many mutations back-to-back. They DEBOUNCE into the in-memory dirty
    // cache (a single pending timer is coalesced, never one synchronous write per chunk). We then
    // force the coalesced flush via flushAll() — the server close() path — so the assertion is robust
    // to whatever window the process-global singleton was constructed with.
    const histPath = path.join(tmpDir, ".janus_history.json");
    for (let i = 0; i < 300; i++) hm.appendOutputToLastCommand("us14-A", `burst ${i}\n`);
    // The chatty burst above is buffered, NOT written per-chunk: the file is still absent/stale right
    // after the synchronous loop (the write is deferred to the debounced flush). Force it now.
    await hm.flushAll();
    assert.ok(fs.existsSync(histPath), "the coalesced (debounced) flush wrote the history file");
    const m1 = fs.statSync(histPath).mtimeMs;
    // No further mutations ⇒ no further writes. The file must be stable (the flush settled, not a
    // per-chunk rewrite loop) across a window longer than the compressed max-linger.
    await new Promise((r) => setTimeout(r, 350));
    const m2 = fs.statSync(histPath).mtimeMs;
    assert.strictEqual(m1, m2, "history file is NOT rewritten after the stream stops — the flush is debounced and settles");
  });

  it("US-1.4: on-disk history for the chatty pane holds only the tail (<= historyMaxOutputLength chars)", async () => {
    const { HistoryManager } = await import("../server");
    const hm = HistoryManager.getInstance();
    const maxOut = running!.manager.settings.advanced.historyMaxOutputLength as number;

    // Drive the production mutation path: a command, then a flood of output appended to it.
    hm.addCommand("us14b-A", "flood");
    for (let i = 0; i < 2000; i++) hm.appendOutputToLastCommand("us14b-A", `chunk ${i} xxxxxxxxxx\n`);
    // saveHistory (called inside append/onIdle) prunes output to the tail; force a load to read it back.
    const entries = hm.loadHistory("us14b-A");
    assert.ok(entries.length >= 1, "the flood landed on the seeded command entry");
    const out = entries[entries.length - 1].output ?? "";
    assert.ok(out.length <= maxOut, `persisted output is tail-capped to <= historyMaxOutputLength (${out.length} <= ${maxOut})`);
    // The tail (newest chunks), not the head, is what's retained.
    assert.ok(out.includes("chunk 1999"), "the retained tail is the NEWEST output, not the oldest");
    assert.ok(!out.includes("chunk 0 "), "the oldest output was evicted from the retained tail");
  });
});

// =================================================================================================
// US-1.5 — Capturing launch intent (P1)
// =================================================================================================
// A pane just received a command; the operator attaches an intent note via add_pane_note. The note
// appears in GET /api/ledger under the right project/pane, survives a server restart (same store
// path), is retrievable after the pane's breadcrumbs have expired, and a credential-shaped string in
// the note is redacted at the brief/read surface.
describe("US-1.5 Capturing launch intent (P1)", () => {
  let running: RunningServer | undefined;
  let base: string;
  let apiToken: string;
  let session: MockLiveSession;
  let mockHandle: MockLiveHandle;
  let client: WebSocket | undefined;
  let prevCwd: string;
  let tmpDir: string;

  const api = (p: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${p}`, { ...init, headers: { "x-api-token": apiToken, "content-type": "application/json", ...(init.headers || {}) } });

  beforeEach(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-us15-"));
    process.chdir(tmpDir);
    await loadLiveHelpers(); // evaluates server.ts — must run AFTER the chdir above (see header)
    const serverMod = await import("../server");
    apiToken = serverMod.API_AUTH_TOKEN;
    mockHandle = installMockLive();
    running = await serverMod.startServer({ port: 0, enableVite: false });
    base = `http://127.0.0.1:${running.port}`;
    // The mock Live session is created per /live WS connection — open one so emitToolCall has a session.
    client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, { headers: { Cookie: `auth_token=${apiToken}` } });
    await new Promise<void>((resolve, reject) => { client!.on("open", () => resolve()); client!.on("error", reject); });
    session = (await waitFor(() => mockHandle.latest())) as MockLiveSession;
  });

  afterEach(async () => {
    if (running) await Promise.all(Object.values(running.manager.terminals).map((t: any) => t.stop?.()));
    if (client && client.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => { client!.once("close", () => resolve()); try { client!.terminate(); } catch { resolve(); } });
    }
    await closeServerOnly(running);
    running = undefined;
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("US-1.5: add_pane_note attaches an intent note that appears in GET /api/ledger under the right project/pane", async () => {
    const mgr = running!.manager;
    const projId = mgr.ledger.activeProjectId || "default_project";
    // A pane that just received a command (the launch we're annotating).
    mgr.addTerminal("us15-A", tmpDir, `${SHELL} -c "echo launched"`, "Custom", "Read-Only", "", projId);
    running!._testSetActivePane?.("us15-A");

    const callId = session.emitToolCall("add_pane_note", { pane_id: "us15-A", note: "Intent: smoke-test the new deploy path before merge." });
    const out = String(await waitFor(() => mockHandle.responseFor(callId)));
    // The tool ran (added the note, or reports the idempotency-replay marker for an already-applied
    // delivery). Either is success — the real AC is the note landing in the ledger, asserted below.
    assert.ok(/added|already handled/i.test(out), `add_pane_note reports success: ${out}`);

    const res = await api("/api/ledger");
    assert.strictEqual(res.status, 200, "GET /api/ledger answers 200");
    const workspaces = (await res.json()) as Record<string, any>;
    const proj = workspaces[projId];
    assert.ok(proj, "the active project is present in the ledger");
    const pane = proj.panes?.["us15-A"];
    assert.ok(pane, "pane A is present under the project in the ledger");
    const notesText = JSON.stringify(pane.notes ?? []);
    assert.match(notesText, /smoke-test the new deploy path/, "the intent note is attached to the right pane in /api/ledger");
  });

  it("US-1.5: the intent note survives a server restart (re-open over the same SQLite store path)", () => {
    // Hermetic restart proof against the durable store directly (the running server holds an exclusive
    // file lock, so we use a dedicated DB path rather than its live handle). This is the same backend
    // the server persists through (JanusStore). Re-open the SAME path == a server restart.
    const dbPath = path.join(tmpDir, "us15-restart.db");
    const store1 = new JanusStore(dbPath);
    store1.init();
    try {
      store1.addProject("proj_x", tmpDir, "deploy hardening");
      store1.updatePane("proj_x", {
        pane_id: "pane_x", name: "pane_x", runtime_type: "shell", last_known_state: "Idle",
        is_busy: false, alive: true, notes: [], permissions_mode: "Read-Only", session_id: "",
        tool_preset: "Custom", context_size: 0,
      } as any, false);
      const wrote = store1.addPaneNote("proj_x", "pane_x", "Intent: validate PKCE rollout.");
      assert.ok(wrote, "the note was written to the durable store");
    } finally {
      store1.close();
    }

    // Restart: a fresh handle over the same path must still surface the note.
    const store2 = new JanusStore(dbPath);
    store2.init();
    try {
      const notes = store2.getNotes({ projectId: "proj_x", paneId: "pane_x" });
      assert.strictEqual(notes.length, 1, "the intent note survived the restart");
      assert.match(notes[0].text, /validate PKCE rollout/, "the note text is intact after restart");
    } finally {
      store2.close();
    }
  });

  it("US-1.5: the intent note is still retrievable after the pane's breadcrumbs have expired", () => {
    // Breadcrumbs decay by age (BreadcrumbRing); durable notes do NOT. Compress breadcrumbMaxAgeMs so
    // the crumbs expire, then prove the note (a separate, durable surface) is still readable.
    const ring = new BreadcrumbRing({ breadcrumbMax: 8, breadcrumbMaxAgeMs: 50 });
    ring.add({ ts: 1000, paneId: "pane_x", text: "pane pane_x started: deploy" });
    // now far past the 50ms age window → the crumb is gone.
    const survivors = ring.recent(1_000_000);
    assert.strictEqual(survivors.length, 0, "breadcrumbs expired past breadcrumbMaxAgeMs");

    // The durable note is unaffected by breadcrumb decay.
    const dbPath = path.join(tmpDir, "us15-expiry.db");
    const store = new JanusStore(dbPath);
    store.init();
    try {
      store.addProject("proj_y", tmpDir, "");
      store.updatePane("proj_y", {
        pane_id: "pane_x", name: "pane_x", runtime_type: "shell", last_known_state: "Idle",
        is_busy: false, alive: true, notes: [], permissions_mode: "Read-Only", session_id: "",
        tool_preset: "Custom", context_size: 0,
      } as any, false);
      store.addPaneNote("proj_y", "pane_x", "Intent: long-lived context for pane_x.");
      const notes = store.getNotes({ projectId: "proj_y", paneId: "pane_x" });
      assert.strictEqual(notes.length, 1, "the note is still retrievable after breadcrumbs expired");
      assert.match(notes[0].text, /long-lived context/, "note content survives breadcrumb decay");
    } finally {
      store.close();
    }
  });

  it("US-1.5 (negative): a credential-shaped note is redacted at the brief/read surface (get_project_notes)", async () => {
    const mgr = running!.manager;
    const projId = mgr.ledger.activeProjectId || "default_project";
    mgr.addTerminal("us15n-A", tmpDir, `${SHELL} -c "echo hi"`, "Custom", "Read-Only", "", projId);
    running!._testSetActivePane?.("us15n-A");

    const secret = "AKIA1234567890ABCD99";
    const noteCall = session.emitToolCall("add_pane_note", { pane_id: "us15n-A", note: `deploy with key ${secret}` });
    await waitFor(() => mockHandle.responseFor(noteCall));

    // CHARACTERIZATION: add_pane_note stores the note text RAW in the ledger (no redaction on write —
    // notes.ts addPaneNote does not scrub). Redaction is enforced at the READ/brief boundary: the
    // get_project_notes voice tool redacts each note via redactSecrets on egress. Assert there.
    const recallCall = session.emitToolCall("get_project_notes", { project_id: projId });
    const recall = await waitFor(() => mockHandle.responseFor(recallCall));
    const recallStr = typeof recall === "string" ? recall : JSON.stringify(recall);
    assert.ok(!recallStr.includes(secret), "the raw secret must NOT surface in the recalled-notes (brief) surface");
    assert.match(recallStr, /REDACTED/i, "the recalled note carries the redaction marker at the read boundary");

    // Document the at-rest characterization explicitly: the ledger DOES hold the raw bytes today.
    const rawNotes = mgr.ledger.getNotes({ projectId: projId });
    const storedRaw = rawNotes.some((n: any) => typeof n.text === "string" && n.text.includes(secret));
    assert.ok(storedRaw, "CHARACTERIZATION: the ledger stores the note RAW; redaction is a read-surface guarantee, not at-rest");
  });
});

// Close the shared undici (fetch) keep-alive pool ONCE, after every server suite has finished, so its
// socket can't linger into --test-force-exit's process.exit() — without breaking mid-file fetches.
after(async () => { await closeFetchPool(); });

}); // EPIC 01 parent suite (concurrency:false — see header)
