// tests/test_live_trace_capture.ts — RED/GREEN spec for the raw Gemini Live capture tap (BEAD
// wsm-e2e-pinned-arkr, deliverable 1: src/voice/liveTraceCapture.ts).
//
// TWO LAYERS:
//   (A) direct unit tests of createLiveTraceWriter/wrapOnMessageWithCapture — fast, isolated, cover
//       the edge cases (flag off, falsy sessionId fallback, fail-soft on a mkdir error).
//   (B) a harness-level test (mirrors tests/test_voice_thought_buffer.ts's boot pattern) that drives
//       SYNTHETIC messages through the REAL server's onmessage dispatcher via tests/helpers/mockLive.ts,
//       proving the tap is actually wired at the live-connector boundary in src/voice/index.ts — not
//       just correct in isolation.
//
// Runner: npx tsx --test --test-force-exit tests/test_live_trace_capture.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import { createLiveTraceWriter, wrapOnMessageWithCapture } from "../src/voice/liveTraceCapture";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

// ── (A) direct unit tests ───────────────────────────────────────────────────────────────────────
describe("liveTraceCapture — createLiveTraceWriter / wrapOnMessageWithCapture (unit)", () => {
  let tmpDir: string;
  let prevCwd: string;

  before(() => {
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-trace-unit-"));
    process.chdir(tmpDir);
  });

  after(() => {
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("flag ON: appends every captured message, in order, as {ts, seq, message} lines to .janus_traces/<sessionId>.jsonl", () => {
    const writer = createLiveTraceWriter("sess-abc", { env: { JANUS_CAPTURE_LIVE_TRACES: "1" } });
    const messages = [
      { serverContent: { outputTranscription: { text: "Hello" } } },
      { serverContent: { outputTranscription: { text: " world." } } },
      { serverContent: { turnComplete: true } },
    ];
    for (const m of messages) writer.capture(m);

    const filePath = path.join(tmpDir, ".janus_traces", "sess-abc.jsonl");
    assert.ok(fs.existsSync(filePath), "trace file must exist when capture is enabled");
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
    assert.strictEqual(lines.length, messages.length, "exactly one line per captured message");
    const parsed = lines.map((l) => JSON.parse(l));
    parsed.forEach((row, i) => {
      assert.strictEqual(row.seq, i, `row ${i} carries the correct monotonic seq`);
      assert.strictEqual(typeof row.ts, "number", `row ${i} carries a numeric ts`);
      assert.deepStrictEqual(row.message, messages[i], `row ${i} holds the RAW envelope verbatim`);
    });
  });

  it("flag OFF (env var absent): capture() is a true no-op — no file, no directory", () => {
    // Isolated `dir` (not the shared default `.janus_traces`) so a PRIOR test's directory in this
    // same tmpDir can never make this assertion vacuously true or falsely fail.
    const dir = path.join(tmpDir, "flag-off-dir");
    const writer = createLiveTraceWriter("sess-off", { env: {}, dir });
    writer.capture({ serverContent: { outputTranscription: { text: "should not be written" } } });
    assert.strictEqual(fs.existsSync(dir), false, "no trace directory is created when disabled");
  });

  it("flag set to something other than '1' (e.g. 'true') is still treated as OFF", () => {
    const writer = createLiveTraceWriter("sess-truthy", { env: { JANUS_CAPTURE_LIVE_TRACES: "true" } });
    writer.capture({ foo: "bar" });
    assert.strictEqual(fs.existsSync(path.join(tmpDir, ".janus_traces", "sess-truthy.jsonl")), false);
  });

  it("a falsy sessionId falls back to a timestamp-based filename", () => {
    const writer = createLiveTraceWriter("", { env: { JANUS_CAPTURE_LIVE_TRACES: "1" }, dir: path.join(tmpDir, "fallback-dir") });
    writer.capture({ ping: true });
    const files = fs.readdirSync(path.join(tmpDir, "fallback-dir"));
    assert.strictEqual(files.length, 1, "exactly one trace file was created");
    assert.match(files[0], /^\d+\.jsonl$/, "falls back to a numeric (timestamp) filename");
  });

  it("fail-soft: a directory-create failure degrades to a no-op writer instead of throwing", () => {
    // Block the target path with a plain FILE so mkdirSync(..., {recursive:true}) cannot create it.
    const blockedPath = path.join(tmpDir, "blocked-by-a-file");
    fs.writeFileSync(blockedPath, "not a directory");
    assert.doesNotThrow(() => {
      const writer = createLiveTraceWriter("sess-x", { env: { JANUS_CAPTURE_LIVE_TRACES: "1" }, dir: blockedPath });
      writer.capture({ anything: "at all" });
    }, "a mkdir failure at mint time must never throw out of createLiveTraceWriter/capture");
  });

  it("fail-soft: a write error on an already-minted writer never throws (directory removed after mint)", () => {
    const dir = path.join(tmpDir, "vanishing-dir");
    const writer = createLiveTraceWriter("sess-vanish", { env: { JANUS_CAPTURE_LIVE_TRACES: "1" }, dir });
    fs.rmSync(dir, { recursive: true, force: true });
    // Recreate the parent as a FILE so the subsequent appendFileSync inside the directory cannot
    // possibly succeed (ENOTDIR/ENOENT), exercising the writer's own try/catch, not the mint-time one.
    fs.writeFileSync(dir, "now a file, not a directory");
    assert.doesNotThrow(() => writer.capture({ still: "must not throw" }));
  });

  it("wrapOnMessageWithCapture captures BEFORE invoking the wrapped handler, and forwards the return value", async () => {
    const order: string[] = [];
    const writer = { capture: (_m: unknown) => { order.push("capture"); } };
    const handler = async (message: { echo: string }) => { order.push("handler"); return message.echo; };
    const wrapped = wrapOnMessageWithCapture(handler, writer);
    const result = await wrapped({ echo: "ok" });
    assert.deepStrictEqual(order, ["capture", "handler"], "capture must run BEFORE normal processing");
    assert.strictEqual(result, "ok", "the wrapped handler's return value is forwarded unchanged");
  });
});

// ── (B) harness-level wiring: the tap fires at the REAL live-connector boundary in src/voice/index.ts ──
describe("liveTraceCapture — wired at the live-connector boundary (harness)", () => {
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let client: WebSocket;
  let tmpDir: string;
  let prevCwd: string;
  let prevEnv: string | undefined;

  const live = (): MockLiveSession => running._testActiveLiveSession!() as MockLiveSession;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    prevEnv = process.env.JANUS_CAPTURE_LIVE_TRACES;
    process.env.JANUS_CAPTURE_LIVE_TRACES = "1";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-trace-harness-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    running = await startServer({ port: 0, enableVite: false });

    client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, {
      headers: { Cookie: `auth_token=${apiToken}` },
    });
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => resolve());
      client.on("error", reject);
    });
    await waitFor(() => mock.latest() && running._testActiveLiveSession?.());
  });

  after(async () => {
    if (client && client.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        client.once("close", () => resolve());
        try { client.terminate(); } catch { resolve(); }
      });
    }
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    if (prevEnv === undefined) delete process.env.JANUS_CAPTURE_LIVE_TRACES;
    else process.env.JANUS_CAPTURE_LIVE_TRACES = prevEnv;
  });

  it("with the flag ON, driving synthetic messages through the real onmessage dispatcher writes exactly the raw envelopes, in order, to .janus_traces/", async () => {
    const messages = [
      { serverContent: { outputTranscription: { text: "First" } } },
      { serverContent: { outputTranscription: { text: " fragment." } } },
      { serverContent: { turnComplete: true } },
    ];
    for (const m of messages) live().emit(m);
    await new Promise((r) => setTimeout(r, 200));

    const traceDir = path.join(tmpDir, ".janus_traces");
    assert.ok(fs.existsSync(traceDir), ".janus_traces directory must exist when capture is enabled");
    const files = fs.readdirSync(traceDir);
    assert.strictEqual(files.length, 1, "exactly one trace file for this one connection");
    const lines = fs.readFileSync(path.join(traceDir, files[0]), "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
    assert.strictEqual(lines.length, messages.length, "exactly one captured line per emitted message");
    const parsed = lines.map((l) => JSON.parse(l));
    parsed.forEach((row, i) => {
      assert.strictEqual(row.seq, i);
      assert.deepStrictEqual(row.message, messages[i], `captured envelope ${i} is byte-identical to what was emitted`);
    });
  });
});

describe("liveTraceCapture — flag OFF leaves no trace at all (harness)", () => {
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let client: WebSocket;
  let tmpDir: string;
  let prevCwd: string;
  let prevEnv: string | undefined;

  const live = (): MockLiveSession => running._testActiveLiveSession!() as MockLiveSession;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    prevEnv = process.env.JANUS_CAPTURE_LIVE_TRACES;
    delete process.env.JANUS_CAPTURE_LIVE_TRACES;

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-trace-harness-off-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    running = await startServer({ port: 0, enableVite: false });

    client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, {
      headers: { Cookie: `auth_token=${apiToken}` },
    });
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => resolve());
      client.on("error", reject);
    });
    await waitFor(() => mock.latest() && running._testActiveLiveSession?.());
  });

  after(async () => {
    if (client && client.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        client.once("close", () => resolve());
        try { client.terminate(); } catch { resolve(); }
      });
    }
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    if (prevEnv === undefined) delete process.env.JANUS_CAPTURE_LIVE_TRACES;
    else process.env.JANUS_CAPTURE_LIVE_TRACES = prevEnv;
  });

  it("with the flag OFF (default), driving the same synthetic messages creates NO .janus_traces directory at all", async () => {
    const messages = [
      { serverContent: { outputTranscription: { text: "First" } } },
      { serverContent: { outputTranscription: { text: " fragment." } } },
      { serverContent: { turnComplete: true } },
    ];
    for (const m of messages) live().emit(m);
    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(fs.existsSync(path.join(tmpDir, ".janus_traces")), false, "capture disabled by default: no directory, no file");
  });
});
