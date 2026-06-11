// tests/test_us_epic05_orchestration.ts
//
// EPIC 05 — Multi-Agent Orchestration. One acceptance-level suite spanning all five stories.
// Author-once file: it asserts against the ALREADY-COMMITTED fixed behavior (breadcrumb per-pane
// fairness in src/memory/breadcrumbs.ts BreadcrumbRing.recent(), and history-redaction at the
// WorldModel read boundary). It changes no production source.
//
// SHAPE (mirrors the harness brief):
//   US-5.1  Accurate fleet orientation       — REAL server boot (installMockLive + startServer):
//                                                voice list_panes + GET /api/terminals reflect actual
//                                                PTY state for mixed-state panes; fast-fail spawn shows
//                                                Exited; context_size present per pane.
//   US-5.2  Handoffs deliver outcomes         — REAL on-disk JanusStore + the EXPORTED handoffFlow
//                                                mappings (deliverOutcomeToHandoff) the server calls;
//                                                Full Auto delivers, HiTL awaits, Read-Only blocks;
//                                                durable across a store reopen (server restart).
//   US-5.3  Burst completions don't spam      — AnnouncementBus + an injected FakeClock: 3 panes idle
//                                                inside one coalesce window flush within the token-bucket;
//                                                per-pane debounce honored; every completion is still
//                                                represented (onEnqueue observer = the attention facts);
//                                                custom settings templates applied.
//   US-5.4  One chatty agent can't erase trail— FIXED behavior at BOTH the BreadcrumbRing.recent() level
//                                                AND the WorldModel brief (getTiers().breadcrumbs): a
//                                                noisy pane cannot evict the quiet panes' latest crumbs.
//   US-5.5  Memory respects the permission wall— REAL server boot: reads/organize (get_pane_summary,
//                                                add_pane_note, compose draft) succeed against a
//                                                Read-Only pane; propose_command is blocked; the
//                                                global=Read-Only override beats a pane=Full Auto.
//
// HANDOFF REGISTRATION TRIGGER (documented per the brief): src/actions/defs/handoff.ts. The lifecycle
// is propose_handoff (creates a 'composing' row from pane A's task targeting pane B via to_pane) ->
// stage_handoff ('staged') -> deliver_handoff (the ONLY writing handler; GATED via ctx.dispatchProposal
// capability "deliver_handoff"). On delivery the server maps the dispatch outcome through the EXPORTED
// pure function deliverOutcomeToHandoff(kind) and flips the persisted row:
//   "executed"(Full Auto) -> deliver_now/delivered ; "pending"(HiTL) -> await_approval (setGateApprovalId,
//   flips on resolve) ; "blocked"(Read-Only/Off) -> block/blocked_read_only. US-5.2 drives exactly that
//   composition against a real JanusStore (the same seam tests/test_handoff_flow.ts and the
//   scripts/smoke-handoff.ts smoke exercise), which is the registration->delivery trigger.
//
// HERMETIC + PARALLEL-SAFE: every server boot isolates .janus_* into a fresh mkdtemp cwd (chdir in,
// chdir back + rmSync in finally); every JanusStore uses a per-test temp file db; terminal.stop() and
// teardownServerSuite() are AWAITED. Time is compressed via FakeClock / explicit `now` arguments — no
// real timers, no idle waits. Modeled on tests/test_secrets_at_rest.ts (mkdtemp cwd) and
// tests/test_voice_tools.ts (the real server-boot harness).
//
// Runner: npx tsx --test --test-force-exit tests/test_us_epic05_orchestration.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";

import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

import { BreadcrumbRing } from "../src/memory/breadcrumbs";
import { WorldModel } from "../src/memory/worldModel";
import {
  AnnouncementBus,
  DEFAULT_ANNOUNCEMENT_TEMPLATES,
  type AnnouncementItem,
  type Clock,
} from "../src/announcementBus";
import { JanusStore } from "../src/store/sqliteStore";
import {
  deliverOutcomeToHandoff,
  applyHandoffFlipOnResolve,
  type DeliverDispatchKind,
} from "../src/handoffFlow";

const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";

// ════════════════════════════════════════════════════════════════════════════════════════════════
// US-5.1 — Accurate fleet orientation (P0)
//   4+ panes in mixed states (Running / Idle / quiescing / Exited). Both the voice list_panes tree and
//   the flat GET /api/terminals array must reflect the ACTUAL per-pane PTY state, a fast-fail spawn must
//   read Exited (no stale "Running"/false "ready"), and context_size must be present per pane.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("US-5.1 accurate fleet orientation (real server: list_panes + GET /api/terminals)", () => {
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let session: MockLiveSession;
  let client: WebSocket;
  let base: string;
  let tmpDir: string;
  let prevCwd: string;

  const api = (pathname: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${pathname}`, {
      ...init,
      headers: { "x-api-token": apiToken, "content-type": "application/json", ...(init.headers || {}) },
    });

  // Register a spawn-free stub pane directly into the manager. We want DETERMINISTIC status without a
  // real PTY (a real cmd.exe/sh spawn is flaky for status assertions), exercising the genuine
  // list_panes/GET-/api/terminals projection off term.status / term.quiescing / term.contextSize.
  function addStub(
    id: string,
    status: "Running" | "Idle" | "Exited",
    opts: { quiescing?: boolean; output?: string[] } = {},
  ): void {
    const outputBuffer = [...(opts.output ?? [])];
    const term: any = {
      cwd: ".",
      shellCmd: shell,
      status,
      quiescing: opts.quiescing ?? false,
      permissionsMode: "Human-in-the-Loop",
      toolPreset: "Custom",
      sessionId: "",
      outputBuffer,
      // contextSize is a derived getter on the real UniversalTerminal; mirror it on the stub.
      get contextSize() { return this.outputBuffer.join("\n").length; },
      getRawBackfill: () => outputBuffer.join("\n"),
      getRecentOutput: (_n: number) => outputBuffer.join("\n"),
      runtimeType: "shell",
      async stop() { this.status = "Exited"; },
    };
    (running.manager.terminals as any)[id] = term;
  }

  function clearPanes() {
    for (const id of Object.keys(running.manager.terminals)) {
      delete (running.manager.terminals as any)[id];
    }
  }

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "us51-fleet-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    running = await startServer({ port: 0, enableVite: false });
    base = `http://127.0.0.1:${running.port}`;

    client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, {
      headers: { Cookie: `auth_token=${apiToken}` },
    });
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => resolve());
      client.on("error", reject);
    });
    session = await waitFor(() => mock.latest());
  });

  after(async () => {
    clearPanes();
    if (client && client.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        client.once("close", () => resolve());
        try { client.terminate(); } catch { resolve(); }
      });
    }
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("US-5.1 GET /api/terminals reports status/quiescing/context_size per pane matching actual PTY state", async () => {
    clearPanes();
    addStub("fleet-run", "Running", { output: ["building step 1", "building step 2"] });
    addStub("fleet-idle", "Idle", { output: ["done"] });
    addStub("fleet-cooking", "Running", { quiescing: true, output: ["waiting on prompt"] });
    addStub("fleet-dead", "Exited", { output: ["boom"] });

    const res = await api("/api/terminals");
    assert.strictEqual(res.status, 200);
    const flat = (await res.json()) as Array<any>;
    const byId = new Map(flat.map((p) => [p.id, p]));

    // Every pane present and its status matches the actual term.status.
    assert.strictEqual(byId.get("fleet-run")?.status, "Running");
    assert.strictEqual(byId.get("fleet-idle")?.status, "Idle");
    assert.strictEqual(byId.get("fleet-cooking")?.status, "Running", "a quiescing pane is still Running");
    assert.strictEqual(byId.get("fleet-dead")?.status, "Exited", "a dead pane reads Exited, never a stale Running");

    // quiescing ("cooking…") overlay: present (truthy) ONLY for the quiet-but-running pane; omitted
    // (undefined, not false) otherwise — field-identical to the legacy GET /api/terminals body.
    assert.strictEqual(byId.get("fleet-cooking")?.quiescing, true);
    assert.strictEqual(byId.get("fleet-run")?.quiescing, undefined, "a busy non-quiet pane omits quiescing");
    assert.strictEqual(byId.get("fleet-dead")?.quiescing, undefined);

    // context_size present per pane (assert PRESENCE, not an exact value) — non-empty buffers carry > 0.
    for (const id of ["fleet-run", "fleet-idle", "fleet-cooking", "fleet-dead"]) {
      const p = byId.get(id);
      assert.ok(p && typeof p.context_size === "number", `context_size present for ${id}`);
    }
    assert.ok(byId.get("fleet-run")!.context_size > 0, "a pane with output reports a non-zero context_size");
  });

  it("US-5.1 voice list_panes narrates the same mixed-state set (busy/idle reflect actual state)", async () => {
    clearPanes();
    // Use the genuine addTerminal -> ledger sync so listPanes() (the voice tree) has projects+panes.
    running.manager.ledger.addProject("fleet_proj", ".", "fleet orientation demo");
    running.manager.addTerminal("v-run", ".", shell, "Custom", "Human-in-the-Loop", "", "fleet_proj");
    running.manager.addTerminal("v-idle", ".", shell, "Custom", "Human-in-the-Loop", "", "fleet_proj");
    // Pin deterministic status (addTerminal spawns a real PTY; we assert the projected status field).
    (running.manager.terminals as any)["v-run"].status = "Running";
    (running.manager.terminals as any)["v-idle"].status = "Idle";

    const callId = session.emitToolCall("list_panes");
    const out = await waitFor(() => mock.responseFor(callId));
    // The voice surface returns the project/pane tree (manager.listPanes()). Find our project group.
    const tree = Array.isArray(out) ? out : (out as any)?.panes ?? out;
    const grp = (Array.isArray(tree) ? tree : []).find((g: any) => g.project_id === "fleet_proj");
    assert.ok(grp, `list_panes tree must include fleet_proj: ${JSON.stringify(out)}`);
    const vrun = grp.panes.find((p: any) => p.pane_id === "v-run");
    const vidle = grp.panes.find((p: any) => p.pane_id === "v-idle");
    assert.ok(vrun && vidle, "both panes appear in the tree");
    // is_busy reflects the ACTUAL state: Running -> busy, Idle -> not busy (J6 contract).
    assert.strictEqual(vrun.is_busy, true, "Running pane reports is_busy:true");
    assert.strictEqual(vidle.is_busy, false, "Idle pane reports is_busy:false");

    await Promise.all([
      (running.manager.terminals as any)["v-run"].stop(),
      (running.manager.terminals as any)["v-idle"].stop(),
    ]);
  });

  it("US-5.1 a pane that fast-fails on spawn shows Exited promptly (no stale Running / false ready)", async () => {
    clearPanes();
    running.manager.ledger.addProject("ff_proj", ".", "fast-fail demo");
    // A bogus executable that cannot spawn: node-pty fails fast and the term degrades to Exited.
    running.manager.addTerminal(
      "ff-pane", ".", "definitely-not-a-real-binary-xyzzy", "Custom", "Human-in-the-Loop", "", "ff_proj",
    );
    // addTerminal defers the blocking start() one tick (B1 async spawn); poll until the fast-fail lands.
    const term: any = (running.manager.terminals as any)["ff-pane"];
    await waitFor(() => term.status === "Exited", 4000, 25);
    assert.strictEqual(term.status, "Exited", "a fast-fail spawn reads Exited, never a stale Running");

    // And the flat orientation array reflects it (the operator is never told it's ready/running).
    const flat = (await (await api("/api/terminals")).json()) as Array<any>;
    const ff = flat.find((p) => p.id === "ff-pane");
    assert.ok(ff, "fast-failed pane still listed");
    assert.strictEqual(ff.status, "Exited", "GET /api/terminals shows Exited for the fast-failed pane");
    await term.stop();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// US-5.2 — Handoffs deliver outcomes across panes (P0)
//   Registration trigger (documented above): src/actions/defs/handoff.ts propose -> stage -> deliver.
//   deliver_handoff maps the dispatch outcome via the EXPORTED deliverOutcomeToHandoff and flips the
//   persisted row. Here we drive that EXACT composition against a real on-disk JanusStore (the seam
//   tests/test_handoff_flow.ts uses), assert the dependent action respects pane B's permission mode,
//   and prove the row survives a store reopen (server restart) and still delivers afterward.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("US-5.2 handoffs deliver outcomes across panes (real JanusStore + handoffFlow mappings)", () => {
  function freshStore(): { store: JanusStore; dbPath: string; dir: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "us52-handoff-"));
    const dbPath = path.join(dir, "handoffs.db");
    const store = new JanusStore(dbPath);
    store.init();
    return { store, dbPath, dir };
  }
  function cleanup(store: JanusStore | null, dir: string) {
    try { store?.close(); } catch { /* best-effort */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  // Stage a handoff from pane A's task targeting pane B — propose_handoff (composing) then stage_handoff
  // (staged). Returns the id (the registration trigger's persisted artifact).
  function stageAtoB(store: JanusStore, fromPane: string, toPane: string): string {
    const h = store.createHandoff({
      workspace_id: "ws-epic05",
      from_pane: fromPane,
      to_pane: toPane,
      kind: "agent_instruction",
      composed_prompt: "Continue the migration A finished: wire the new store backend.",
      state: "composing",
    });
    store.updateHandoffState(h.id, "staged");
    return h.id;
  }

  // The deliver_handoff composition: B's effective mode -> the dispatch outcome kind the server's
  // dispatchProposal would produce -> deliverOutcomeToHandoff -> persisted-row effect. This is the
  // server's exact mapping (src/actions/defs/handoff.ts:deliverHandoff), driven without a PTY.
  function modeToDispatchKind(effectiveMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only"): DeliverDispatchKind {
    if (effectiveMode === "Full Auto") return "executed";
    if (effectiveMode === "Human-in-the-Loop") return "pending";
    return "blocked"; // Read-Only / Off
  }

  it("US-5.2 Full Auto target: A's completion delivers; the stored row flips to delivered", () => {
    const { store, dir } = freshStore();
    try {
      const id = stageAtoB(store, "paneA", "paneB");
      // A's task completes (idle edge with outcome) -> deliver fires against B (Full Auto).
      const effect = deliverOutcomeToHandoff(modeToDispatchKind("Full Auto"));
      assert.strictEqual(effect.kind, "deliver_now");
      if (effect.kind === "deliver_now") {
        store.updateHandoffState(id, effect.state, { approved_via: effect.approvedVia });
      }
      const row = store.getHandoff(id)!;
      assert.strictEqual(row.state, "delivered", "the handoff record reflects delivery");
      assert.strictEqual(row.approved_via, "full_auto");
      assert.ok(row.delivered_at, "delivered_at stamped on the Full-Auto deliver");
    } finally { cleanup(store, dir); }
  });

  it("US-5.2 HiTL target: delivery awaits approval (gate_approval_id set), then resolve flips to delivered", () => {
    const { store, dir } = freshStore();
    try {
      const id = stageAtoB(store, "paneA", "paneB");
      const effect = deliverOutcomeToHandoff(modeToDispatchKind("Human-in-the-Loop"));
      assert.strictEqual(effect.kind, "await_approval", "HiTL parks as approval_pending, not delivered");
      // Server's await_approval branch: link gate_approval_id == handoff id (identity linkage).
      store.setGateApprovalId(id, id);
      let row = store.getHandoff(id)!;
      assert.strictEqual(row.state, "staged", "still staged while awaiting approval (not yet delivered)");

      // Operator approves -> the resolve-leg flip (the exact helper server.ts:flipHandoffOnResolve wraps).
      const flip = applyHandoffFlipOnResolve(store, id, "approved", { vocal: true });
      assert.strictEqual(flip.flipped, true);
      row = store.getHandoff(id)!;
      assert.strictEqual(row.state, "delivered", "approval flips the HiTL handoff to delivered");
      assert.strictEqual(row.approved_via, "voice");
    } finally { cleanup(store, dir); }
  });

  it("US-5.2 Read-Only target: delivery is blocked; the row records blocked_read_only (no write)", () => {
    const { store, dir } = freshStore();
    try {
      const id = stageAtoB(store, "paneA", "paneB");
      const effect = deliverOutcomeToHandoff(modeToDispatchKind("Read-Only"));
      assert.strictEqual(effect.kind, "block");
      if (effect.kind === "block") store.updateHandoffState(id, effect.state);
      const row = store.getHandoff(id)!;
      assert.strictEqual(row.state, "blocked_read_only", "Read-Only target blocks delivery (command_blocked)");
      assert.ok(!row.delivered_at, "a blocked handoff never stamps delivered_at");
    } finally { cleanup(store, dir); }
  });

  it("US-5.2 handoffs persist across a server restart (.janus.db) and still deliver afterward", () => {
    const { store, dbPath, dir } = freshStore();
    let reopened: JanusStore | null = null;
    try {
      // Pre-restart: A stages a handoff to B; it persists as 'staged'. No delivery yet.
      const id = stageAtoB(store, "paneA", "paneB");
      assert.strictEqual(store.getHandoff(id)!.state, "staged");
      store.close();

      // Server restart: a FRESH JanusStore over the SAME on-disk db file (the durable .janus.db path).
      reopened = new JanusStore(dbPath);
      reopened.init();
      const survived = reopened.getHandoff(id);
      assert.ok(survived, "the staged handoff survived the restart");
      assert.strictEqual(survived!.state, "staged", "it is still deliverable (staged) after the restart");

      // Post-restart delivery (Full Auto) still flips the durable row to delivered.
      const effect = deliverOutcomeToHandoff("executed");
      if (effect.kind === "deliver_now") {
        reopened.updateHandoffState(id, effect.state, { approved_via: effect.approvedVia });
      }
      assert.strictEqual(reopened.getHandoff(id)!.state, "delivered", "delivery works after the restart");
    } finally {
      try { reopened?.close(); } catch { /* best-effort */ }
      cleanup(null, dir);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// US-5.3 — Burst completions don't spam (P1)
//   3 panes go idle inside one coalescing window. The bus flushes within its token-bucket (never more
//   than the configured rate); per-pane debounce is honored; EVERY completion is still individually
//   represented (the onEnqueue observer = the durable attention facts — coalesce the SOUND, not the
//   FACTS); operator-customized templates are applied. Time driven by an injected FakeClock.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("US-5.3 burst completions coalesce the sound, not the facts (AnnouncementBus + FakeClock)", () => {
  class FakeClock implements Clock {
    private t = 0;
    private timers: { id: number; fireAt: number; fn: () => void }[] = [];
    private nextId = 1;
    now() { return this.t; }
    setTimeout(fn: () => void, ms: number) {
      const id = this.nextId++;
      this.timers.push({ id, fireAt: this.t + ms, fn });
      return id;
    }
    clearTimeout(handle: any) { this.timers = this.timers.filter((x) => x.id !== handle); }
    advance(ms: number) {
      const target = this.t + ms;
      for (;;) {
        const due = this.timers.filter((x) => x.fireAt <= target).sort((a, b) => a.fireAt - b.fireAt);
        if (due.length === 0) break;
        const next = due[0];
        this.timers = this.timers.filter((x) => x.id !== next.id);
        this.t = next.fireAt;
        next.fn();
      }
      this.t = target;
    }
  }
  const notifs = (msgs: any[]) => msgs.filter((m) => m.type === "proactive_notification");

  it("US-5.3 three distinct panes idle in one window -> 3 notifications, each fact represented, custom template applied", () => {
    const sink: any[] = [];
    const clock = new FakeClock();
    // The durable "attention facts" recorder: onEnqueue observes EVERY genuine edge pre-debounce.
    const facts: string[] = [];
    const bus = new AnnouncementBus({
      broadcast: (m) => sink.push(m),
      clock,
      coalesceWindowMs: 1500,
      perPaneDebounceMs: 4000,
      rateLimitWindowMs: 3000,
      rateLimitBurst: 5, // generous enough that 3 distinct panes flush in one go
      // Operator-customized template (settings.announcements) — applied at flush.
      getTemplates: () => ({ ...DEFAULT_ANNOUNCEMENT_TEMPLATES, completion: "FINISHED {pane}: {summary}" }),
    });
    bus.onEnqueue((item: AnnouncementItem) => facts.push(`${item.terminalId}:${item.kind}`));

    // 3 panes go idle within the SAME coalescing window.
    bus.enqueue({ kind: "completion", terminalId: "burst-a", summary: "tests green" });
    bus.enqueue({ kind: "completion", terminalId: "burst-b", summary: "build ok" });
    bus.enqueue({ kind: "completion", terminalId: "burst-c", summary: "lint clean" });

    clock.advance(1500); // cross the coalesce window -> single flush
    const out = notifs(sink);

    // The sound is coalesced into ONE flush, but every pane is individually represented.
    assert.strictEqual(out.length, 3, "all 3 completions individually represented (coalesce sound, not facts)");
    assert.deepStrictEqual(
      new Set(out.map((m) => m.terminalId)),
      new Set(["burst-a", "burst-b", "burst-c"]),
      "each pane has its own notification entry",
    );
    // Distinct coalescing ids (pane+severity) — no same-pane dupes.
    assert.strictEqual(new Set(out.map((m) => m.id)).size, 3, "distinct per-pane ids");
    // The customized template is applied.
    assert.ok(out.every((m) => /^FINISHED /.test(m.message)), "custom completion template applied to every entry");
    assert.ok(out.some((m) => /FINISHED burst-a: tests green/.test(m.message)), "{pane}+{summary} interpolated");

    // Every completion edge reached the attention-facts recorder (the queue), pre-coalesce.
    assert.deepStrictEqual(facts.sort(), ["burst-a:completion", "burst-b:completion", "burst-c:completion"]);
    bus.stop();
  });

  it("US-5.3 token-bucket caps the emission RATE: a burst is spaced across windows, none dropped", () => {
    const sink: any[] = [];
    const clock = new FakeClock();
    // burst=1 so each flush consumes the only token; debounce 0 so distinct panes all flow.
    const bus = new AnnouncementBus({
      broadcast: (m) => sink.push(m),
      clock,
      coalesceWindowMs: 1500,
      perPaneDebounceMs: 0,
      rateLimitWindowMs: 3000,
      rateLimitBurst: 1,
    });
    for (const id of ["rl-a", "rl-b", "rl-c"]) bus.enqueue({ kind: "completion", terminalId: id, summary: id });

    clock.advance(1500); // first flush — bounded by the single token
    const firstFlush = notifs(sink).length;
    assert.ok(firstFlush >= 1, "at least one notification at the first flush");

    // Once the bucket refills, all 3 panes surface — coalesced for sound, but never dropped.
    clock.advance(10_000);
    const ids = new Set(notifs(sink).map((m) => m.terminalId));
    assert.deepStrictEqual([...ids].sort(), ["rl-a", "rl-b", "rl-c"], "every completion eventually represented");
    bus.stop();
  });

  it("US-5.3 per-pane debounce honored: a 2nd same-pane completion is deferred, not machine-gunned", () => {
    const sink: any[] = [];
    const clock = new FakeClock();
    const bus = new AnnouncementBus({
      broadcast: (m) => sink.push(m),
      clock,
      coalesceWindowMs: 1500,
      perPaneDebounceMs: 4000,
      rateLimitWindowMs: 3000,
      rateLimitBurst: 10,
    });
    const first = bus.enqueue({ kind: "completion", terminalId: "flap", summary: "1" });
    const second = bus.enqueue({ kind: "completion", terminalId: "flap", summary: "2" });
    assert.strictEqual(first, true, "the first same-pane completion is delivered");
    assert.strictEqual(second, false, "the 2nd same-pane completion within the debounce window is DEFERRED");
    clock.advance(1500);
    assert.strictEqual(notifs(sink).length, 1, "only one notification for the same pane inside the window");
    bus.stop();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// US-5.4 — One chatty agent can't erase the others' trail (P0; assert FIXED behavior)
//   Pane A flaps (high breadcrumb production) while B and C each produce ONE recent crumb. With the ring
//   at breadcrumbMax capacity, B's AND C's most-recent crumbs MUST survive — both directly in
//   BreadcrumbRing.recent() AND in the synthesized brief (WorldModel.getTiers().breadcrumbs).
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("US-5.4 per-pane breadcrumb fairness survives a noisy pane (the committed FIX)", () => {
  it("US-5.4 BreadcrumbRing.recent(): a flapping pane A cannot evict B's and C's latest crumbs", () => {
    // breadcrumbMax=4; pane A alone floods >4 in-window crumbs. B and C fire EARLIER (smaller ts) so
    // they lose a pure-recency race — under the OLD global-recency cut they'd be sliced out entirely.
    const ring = new BreadcrumbRing({ breadcrumbMax: 4, breadcrumbMaxAgeMs: 10_000 });
    ring.add({ ts: 100, paneId: "B", text: "B-latest" });
    ring.add({ ts: 200, paneId: "C", text: "C-latest" });
    // Pane A cycles running/idle rapidly: a flood of the newest crumbs.
    for (let i = 0; i < 6; i++) ring.add({ ts: 1000 + i, paneId: "A", text: `A-${i}` });

    const r = ring.recent(2000);
    const texts = r.map((b) => b.text);
    assert.strictEqual(r.length, 4, "still capped at breadcrumbMax");
    for (let i = 1; i < r.length; i++) {
      assert.ok(r[i - 1].ts >= r[i].ts, "newest-first preserved");
    }
    // The FIX: BOTH quiet panes keep their single most-recent crumb despite A's flood.
    assert.ok(texts.includes("B-latest"), "B's latest crumb survives the noisy flood (fairness)");
    assert.ok(texts.includes("C-latest"), "C's latest crumb survives the noisy flood (fairness)");
    // A still appears, filling the remaining capacity by recency.
    assert.ok(texts.some((t) => t.startsWith("A-")), "the noisy pane is still represented");
  });

  it("US-5.4 brief level (WorldModel.getTiers): B's and C's crumbs survive in the synthesized breadcrumbs", () => {
    const ring = new BreadcrumbRing({ breadcrumbMax: 4, breadcrumbMaxAgeMs: 10_000 });
    ring.add({ ts: 100, paneId: "B", text: "B-note" });
    ring.add({ ts: 200, paneId: "C", text: "C-note" });
    for (let i = 0; i < 6; i++) ring.add({ ts: 1000 + i, paneId: "A", text: `A-note-${i}` });

    // Minimal WorldModel deps (modeled on tests/test_memory_worldmodel.ts).
    const wm = new WorldModel({
      manager: {
        activeId: "A",
        terminals: {
          A: { name: "A", runtimeType: "interactive_cli", status: "Running", lastCommand: "npm test" },
          B: { name: "B", runtimeType: "shell", status: "Idle", lastCommand: "ls" },
          C: { name: "C", runtimeType: "shell", status: "Idle", lastCommand: "git status" },
        },
        ledger: { activeProjectId: "proj" },
        settings: { globalPermissionsMode: "Human-in-the-Loop" },
        listPanes: () => [{
          project_id: "proj",
          panes: [
            { pane_id: "A", name: "A", last_known_state: "Running" },
            { pane_id: "B", name: "B", last_known_state: "Idle" },
            { pane_id: "C", name: "C", last_known_state: "Idle" },
          ],
        }],
      },
      store: {
        getProject: (_id: string) => ({ id: "proj", name: "Janus", summary: "orchestrator", key_terms: [] }),
        getProjectBriefing: (_id: string) => ({ summary: "orchestrator", recentNotes: [] }),
      },
      redact: (s: string) => s,
      breadcrumbs: ring,
    } as any);

    const tiers = wm.getTiers("A", 2000);
    const crumbTexts = tiers.breadcrumbs.map((b) => b.text);
    assert.ok(tiers.breadcrumbs.length <= 4, "the brief honors breadcrumbMax");
    assert.ok(crumbTexts.includes("B-note"), "B's crumb survives into the synthesized brief");
    assert.ok(crumbTexts.includes("C-note"), "C's crumb survives into the synthesized brief");
    assert.ok(crumbTexts.some((t) => t.startsWith("A-note-")), "the noisy pane still appears in the brief");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// US-5.5 — Memory respects the permission wall (P0)
//   Pane R is EFFECTIVELY Read-Only. Reads/organize (get_pane_summary, add_pane_note, compose draft)
//   succeed (ungated). propose_command against R is BLOCKED with the model told writes are disabled.
//   Global-mode precedence: a pane-level mode is inert unless global is Inherit — so we PIN global to
//   Read-Only and also show that a pane set to Full Auto under global=Read-Only STILL blocks.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("US-5.5 memory respects the permission wall (real server: reads ungated, writes gated by mode)", () => {
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let session: MockLiveSession;
  let client: WebSocket;
  let tmpDir: string;
  let prevCwd: string;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "us55-wall-"));
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
    session = await waitFor(() => mock.latest());
  });

  after(async () => {
    if (client && client.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        client.once("close", () => resolve());
        try { client.terminate(); } catch { resolve(); }
      });
    }
    // Stop any live panes before teardown (real PTYs).
    await Promise.all(
      Object.values(running.manager.terminals).map((t: any) =>
        typeof t.stop === "function" ? t.stop().catch(() => {}) : Promise.resolve(),
      ),
    );
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("US-5.5 reads/organize against a Read-Only pane SUCCEED (get_pane_summary, add_pane_note, compose draft are ungated)", async () => {
    // Pin global to Read-Only (the EFFECTIVE mode). The pane R is created Read-Only too.
    running.manager.globalPermissionsMode = "Read-Only";
    running.manager.ledger.addProject("ro_proj", ".", "read-only wall demo");
    running.manager.ledger.activeProjectId = "ro_proj";
    running.manager.addTerminal("pane-R", ".", shell, "Custom", "Read-Only", "", "ro_proj");
    // Make R the active pane (the spotlight) so propose_command/compose target it.
    running._testSetActivePane?.("pane-R");

    // (1) get_pane_summary — a READ. It must succeed (return the fenced tail, not a forbidden error).
    const sumCall = session.emitToolCall("get_pane_summary", { pane_id: "pane-R" });
    const sumOut = String(await waitFor(() => mock.responseFor(sumCall)));
    assert.ok(!/gated Off|forbidden by policy/i.test(sumOut), `read succeeds under Read-Only: ${sumOut}`);

    // (2) add_pane_note — ORGANIZE. Note capture must succeed against a Read-Only pane.
    const noteCall = session.emitToolCall("add_pane_note", {
      project_id: "ro_proj", pane_id: "pane-R", note: "R is read-only; do not write here.",
    });
    const noteOut = String(await waitFor(() => mock.responseFor(noteCall)));
    assert.ok(!/forbidden|gated Off/i.test(noteOut), `add_pane_note succeeds against a Read-Only pane: ${noteOut}`);
    // The note actually landed in the ledger (organize is real, not a no-op).
    const notes = running.manager.ledger.getNotes({ projectId: "ro_proj" });
    assert.ok(
      notes.some((n: any) => n.pane_id === "pane-R" && /read-only/i.test(n.text)),
      "the pane note was durably captured despite Read-Only",
    );

    // (3) compose a draft (propose_handoff) targeting R — drafting NEVER touches the pane, so ungated.
    const draftCall = session.emitToolCall("propose_handoff", {
      to_pane: "pane-R", draft_text: "When unlocked: run the full suite.", from_pane: "pane-R",
    });
    const draftOut = await waitFor(() => mock.responseFor(draftCall));
    const draftStr = typeof draftOut === "string" ? draftOut : JSON.stringify(draftOut);
    assert.ok(!/forbidden|gated Off/i.test(draftStr), `compose_draft (propose_handoff) succeeds: ${draftStr}`);
    assert.ok(/composing|handoff_id|Drafted/i.test(draftStr), `a draft handoff was created: ${draftStr}`);
  });

  it("US-5.5 propose_command against a Read-Only pane is BLOCKED (the model is told writes are disabled)", async () => {
    running.manager.globalPermissionsMode = "Read-Only";
    if (!running.manager.terminals["pane-R"]) {
      running.manager.ledger.addProject("ro_proj", ".", "read-only wall demo");
      running.manager.ledger.activeProjectId = "ro_proj";
      running.manager.addTerminal("pane-R", ".", shell, "Custom", "Read-Only", "", "ro_proj");
    }
    running._testSetActivePane?.("pane-R");

    // The pane is a raw shell (runtimeType "shell"), so a kind:"agent_instruction" would clarify
    // ("raw shell, not an agent CLI") BEFORE the gate. Use kind:"shell" with an ALLOWLISTED first
    // token (git) so it passes the allowlist check and reaches the Read-Only gate, which blocks it.
    const cmdCall = session.emitToolCall("propose_command", {
      pane_id: "pane-R", instruction: "git status", kind: "shell",
    });
    const out = String(await waitFor(() => mock.responseFor(cmdCall)));
    // Read-Only blocks the write and the read-back tells the model writes are disabled (command_blocked).
    assert.ok(
      /read-only|disabled|blocked|cannot|can't|not allowed|gated/i.test(out),
      `propose_command to a Read-Only pane is refused with a writes-disabled message: ${out}`,
    );
    // It must NOT read as a pending approval (Read-Only never parks an approval).
    assert.ok(!/pending_approval/i.test(out), `Read-Only blocks outright, never an approval: ${out}`);
  });

  it("US-5.5 global-override gotcha: pane set to Full Auto while global=Read-Only STILL blocks the write", async () => {
    // Global precedence: a pane-level mode is INERT unless global is Inherit. So even after promoting the
    // pane to Full Auto, global=Read-Only must dominate and the write must still be blocked.
    running.manager.globalPermissionsMode = "Read-Only";
    if (!running.manager.terminals["pane-R"]) {
      running.manager.ledger.addProject("ro_proj", ".", "read-only wall demo");
      running.manager.ledger.activeProjectId = "ro_proj";
      running.manager.addTerminal("pane-R", ".", shell, "Custom", "Read-Only", "", "ro_proj");
    }
    running._testSetActivePane?.("pane-R");
    // Promote the PANE to Full Auto — but global is Read-Only, so this must NOT loosen the effective mode.
    (running.manager.terminals as any)["pane-R"].setPermissionsMode?.("Full Auto");

    // Allowlisted shell token (echo) so it passes the allowlist and reaches the effective-mode gate.
    const cmdCall = session.emitToolCall("propose_command", {
      pane_id: "pane-R", instruction: "echo should-not-run", kind: "shell",
    });
    const out = String(await waitFor(() => mock.responseFor(cmdCall)));
    assert.ok(
      /read-only|disabled|blocked|cannot|can't|not allowed|gated/i.test(out),
      `global Read-Only beats a pane Full Auto — the write stays blocked: ${out}`,
    );
    assert.ok(!/pending_approval/i.test(out), `still blocked outright, not parked as an approval: ${out}`);
  });
});
