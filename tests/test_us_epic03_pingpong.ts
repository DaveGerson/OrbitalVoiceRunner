// tests/test_us_epic03_pingpong.ts — EPIC 03: Parallel Task Ping-Pong (US-3.1 … US-3.4).
//
// This suite ASSERTS the production breadcrumb/history behavior that is already committed; it changes
// nothing. It pins the four ledger/server seams the epic rides on:
//
//   US-3.1  Drafts are pane-ISOLATED. A draft composed against pane A lands ONLY on A; switching the
//           active pane (server seam _testSetActivePane) and composing again lands ONLY on B. The voice
//           compose path (update_draft_prompt) targets activeDraftTarget() (coreState.activePaneId +
//           ledger.activeProjectId) and broadcasts a `draft_updated` WS frame scoped to that project/pane.
//           Negative: composing with NO active pane is a no-op (no orphan draft, no frame).
//   US-3.2  Drafts SURVIVE a restart on the SQLite backend (a fresh JanusStore over the same .db file
//           restores both panes' drafts with the right pane association + updatedAt). SQLite is the
//           ONLY ledger backend (dbt3 retired the legacy JSON Ledger escape hatch).
//   US-3.3  WRITES only reach the ACTIVE pane. The raw-input REST surface 409s every off-active-pane key
//           (incl. always-allowed nav + Ctrl+C); with no active pane the same 409 fires; a non-allowlisted
//           byte sequence is 400-rejected BEFORE the PTY; the voice write path (propose_command) enforces
//           the SAME single-active-pane guard (refused with a switch-the-pane clarify).
//   US-3.4  Panes are addressable by HUMAN names. rename_pane / PUT .../panes/:pane_id/rename updates the
//           ledger name, the new name shows in list_panes, it persists across restart, and the rename
//           broadcasts ledger_updated.
//
// US-3.5 is NOT in this file — it is scored by the vignette/simulator harness (see report). The
// US-3.4 "agent resolves 'the API pane' to the right id" leg is ALSO a vignette-harness concern and is
// likewise out of scope here (we pin the deterministic rename + list + persist + broadcast legs only).
//
// HERMETIC + PARALLEL-SAFE: every test runs against an isolated mkdtemp cwd. The pure-ledger tests
// chdir in/out per test (rmSync + chdir back in finally). The server-boot legs SHARE ONE in-process
// server lifecycle (one before/after) — `teardownServerSuite` closes the GLOBAL undici fetch pool, so
// booting/tearing-down a server PER nested suite would break `fetch` for the next one; one server, one
// teardown avoids that. Models the temp-cwd discipline of tests/test_secrets_at_rest.ts.
//
// Runner: npx tsx --test --test-force-exit tests/test_us_epic03_pingpong.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";

import { JanusStore } from "../src/store/sqliteStore";
import { OrchestratorManager, UniversalTerminal } from "../src/terminal";
import type { PtyTransport } from "../src/ptyTransport";
import type { StoredPane } from "../src/store/types";
import type { PaneMeta } from "../src/types";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

// ── byte-exact raw keys (multi-cli adapter spec §8/§10) ────────────────────────────────────────────
const ARROW_UP = "\x1b\x5b\x41"; // ESC[A — always-allowed nav
const CTRL_C = "\x03";           // §13.1 always-allowed emergency brake
const RM_RF = "rm -rf ~\r";      // the headline non-allowlisted exploit (NOT a vetted key)

// A full ledger PaneMeta (the generic LedgerLike shape, used against a pure JanusStore below).
function paneMeta(id: string, name = id): PaneMeta {
  return {
    pane_id: id, name, runtime_type: "shell", last_known_state: "Idle", is_busy: false,
    alive: true, notes: [], permissions_mode: "Human-in-the-Loop", session_id: "",
    tool_preset: "Claude Code", context_size: 0,
  };
}

// A StoredPane row (SQLite JanusStore path).
function storedPane(id: string, workspaceId: string, name = id): StoredPane {
  return {
    pane_id: id, workspace_id: workspaceId, name, runtime_type: "shell",
    tool_preset: "Claude Code", permissions_mode: "Human-in-the-Loop", session_id: "",
    last_known_state: "Idle", is_busy: false, alive: true, context_size: 0,
    last_status_change_at: null, last_command: null, scrollback_path: null,
    created_at: 0, updated_at: 0,
  };
}

// A spawned pane: a UniversalTerminal with an injected fake transport recording every write.
function spawnedPane(id: string): { term: UniversalTerminal; writes: string[] } {
  const writes: string[] = [];
  const transport: PtyTransport = {
    pid: 7777, onData() {}, onExit() {},
    write(data: string) { writes.push(data); }, resize() {}, kill() {},
  };
  const term = new UniversalTerminal(id, ".", "cmd");
  (term as any).transport = transport;
  return { term, writes };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// PURE-LEDGER LEGS (no server, no fetch) — each test owns its own temp cwd.
// ════════════════════════════════════════════════════════════════════════════════════════════════

// US-3.1 — Drafts are pane-isolated in the ledger. A→ALPHA, switch, B→BRAVO; neither leaks.
describe("US-3.1 drafts are pane-isolated in the ledger", () => {
  it("US-3.1: composing ALPHA on A then BRAVO on B keeps each draft scoped to its own pane", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "us31-iso-"));
    const prevCwd = process.cwd();
    process.chdir(dir);
    const store = new JanusStore(":memory:");
    store.init();
    try {
      store.addProject("P", dir);
      store.updatePane("P", paneMeta("A"));
      store.updatePane("P", paneMeta("B"));

      // Pane A is the active write target -> compose ALPHA against A.
      assert.equal(store.setDraft("P", "A", "ALPHA build the parser", "operator"), true);
      // Active flips to B (the _testSetActivePane move, modeled here as the target the composer writes).
      assert.equal(store.setDraft("P", "B", "BRAVO run the migration", "operator"), true);

      assert.equal(store.getDraft("P", "A")!.text, "ALPHA build the parser", "A holds ALPHA only");
      assert.equal(store.getDraft("P", "B")!.text, "BRAVO run the migration", "B holds BRAVO only");
      assert.ok(!store.getDraft("P", "A")!.text.includes("BRAVO"), "no BRAVO leaked into A");
      assert.ok(!store.getDraft("P", "B")!.text.includes("ALPHA"), "no ALPHA leaked into B");

      // The WIP register lists both, each scoped to its pane.
      const drafts = store.listDrafts("P").sort((a, b) => a.paneId.localeCompare(b.paneId));
      assert.deepStrictEqual(drafts.map((d) => d.paneId), ["A", "B"]);
      assert.equal(drafts.find((d) => d.paneId === "A")!.draft.text, "ALPHA build the parser");
      assert.equal(drafts.find((d) => d.paneId === "B")!.draft.text, "BRAVO run the migration");
    } finally {
      store.close();
      process.chdir(prevCwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// US-3.2 — Drafts survive a restart. SQLite is the durable backend (P0); legacy is characterized.
describe("US-3.2 drafts survive a server restart", () => {
  it("US-3.2: SQLite backend — both panes' drafts restore (pane association + updatedAt) after restart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "us32-sqlite-"));
    const dbPath = path.join(dir, "janus.db");
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      // Boot #1 on a SQLite-backed manager; register two panes and compose a draft on each.
      const store1 = new JanusStore(dbPath); store1.init();
      const m1 = new OrchestratorManager({ ledger: store1 });
      const proj = m1.ledger.activeProjectId!;
      store1.savePane(storedPane("A", proj));
      store1.savePane(storedPane("B", proj));
      assert.equal(m1.ledger.setDraft(proj, "A", "ALPHA survives", "operator"), true);
      assert.equal(m1.ledger.setDraft(proj, "B", "BRAVO survives", "janus"), true);
      const aAt = m1.ledger.getDraft(proj, "A")!.updatedAt;
      const bAt = m1.ledger.getDraft(proj, "B")!.updatedAt;
      assert.ok(aAt && bAt, "both drafts have an updatedAt before restart");
      store1.close();

      // Restart: a FRESH manager over the SAME .db file (simulates a process restart).
      const store2 = new JanusStore(dbPath); store2.init();
      const m2 = new OrchestratorManager({ ledger: store2 });
      const a = m2.ledger.getDraft(proj, "A");
      const b = m2.ledger.getDraft(proj, "B");
      assert.ok(a && b, "both drafts restored after restart");
      assert.equal(a!.text, "ALPHA survives", "A's draft restored to the right pane");
      assert.equal(b!.text, "BRAVO survives", "B's draft restored to the right pane");
      assert.equal(a!.updatedAt, aAt, "A's updatedAt round-trips unchanged");
      assert.equal(b!.updatedAt, bAt, "B's updatedAt round-trips unchanged");
      assert.equal(b!.updatedBy, "janus", "the updatedBy attribution survives too");
      store2.close();
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// US-3.4 — a rename persists across restart (a fresh JanusStore over the same db file
// restores the human name).
describe("US-3.4 a human name persists across restart (ledger)", () => {
  it("US-3.4: renamePane to 'API' survives a reload of the same ledger file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "us34-persist-"));
    const dbPath = path.join(dir, "janus.db");
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      const store1 = new JanusStore(dbPath); store1.init();
      store1.addProject("P", dir);
      store1.updatePane("P", paneMeta("pane_x", "pane_x"));
      store1.renamePane("P", "pane_x", "API");
      assert.equal(store1.getProject("P")!.panes["pane_x"].name, "API", "rename updated the ledger name");
      store1.close();

      const store2 = new JanusStore(dbPath); store2.init();
      assert.equal(
        store2.getProject("P")!.panes["pane_x"].name,
        "API",
        "the human name persists across a restart (still addressable as 'API')",
      );
      store2.close();
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// SERVER-BOOT LEGS — ONE in-process server + WS client shared across US-3.1 (voice), US-3.3, US-3.4.
// A single teardown (closes the global fetch pool once) keeps fetch alive for every sub-leg.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("EPIC 03 — server-boot legs (headless real server, mock Live)", () => {
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let session: MockLiveSession;
  let client: WebSocket;
  let projectId: string;
  let base: string;
  let tmpDir: string;
  let prevCwd: string;

  const draftFrames: any[] = [];
  const ledgerUpdates: any[] = [];

  const api = (pathname: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${pathname}`, {
      ...init,
      headers: { "x-api-token": apiToken, "content-type": "application/json", ...(init.headers || {}) },
    });

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "us3-srv-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    running = await startServer({ port: 0, enableVite: false });
    base = `http://127.0.0.1:${running.port}`;
    projectId = running.manager.ledger.activeProjectId!;

    // write_to_pane Auto so the gated Shift+Tab / a voice shell write would otherwise RUN — proving it
    // is the active-pane guard (not the capability gate) that refuses an off-active-pane key/command.
    running.manager.settings.advanced = running.manager.settings.advanced || ({} as any);
    (running.manager.settings.advanced as any).capabilityGates = { write_to_pane: "Auto" };

    client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, {
      headers: { Cookie: `auth_token=${apiToken}` },
    });
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => resolve());
      client.on("error", reject);
    });
    client.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg?.type === "draft_updated") draftFrames.push(msg);
        if (msg?.type === "ledger_updated") ledgerUpdates.push(msg);
      } catch { /* non-JSON frame */ }
    });

    session = await waitFor(() => mock.latest());
  });

  after(async () => {
    try { await api("/api/stop-all/release", { method: "POST" }); } catch {}
    if (client && client.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        client.once("close", () => resolve());
        try { client.terminate(); } catch { resolve(); }
      });
    }
    running._testSetActivePane?.(null);
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // ── US-3.1 (voice) — draft compose follows the active pane + scoped draft_updated frame ──────────
  describe("US-3.1 voice draft compose follows the active pane", () => {
    it("US-3.1: update_draft_prompt on A then on B writes ALPHA→A / BRAVO→B with no cross-leak", async () => {
      running.manager.ledger.updatePane(projectId, paneMeta("A"));
      running.manager.ledger.updatePane(projectId, paneMeta("B"));

      running._testSetActivePane?.("A");
      const c1 = session.emitToolCall("update_draft_prompt", { text: "ALPHA build the parser", mode: "replace" });
      await waitFor(() => mock.responseFor(c1));
      running._testSetActivePane?.("B");
      const c2 = session.emitToolCall("update_draft_prompt", { text: "BRAVO run the migration", mode: "replace" });
      await waitFor(() => mock.responseFor(c2));

      assert.equal(running.manager.ledger.getDraft(projectId, "A")!.text, "ALPHA build the parser");
      assert.equal(running.manager.ledger.getDraft(projectId, "B")!.text, "BRAVO run the migration");
      assert.ok(!running.manager.ledger.getDraft(projectId, "A")!.text.includes("BRAVO"));
      assert.ok(!running.manager.ledger.getDraft(projectId, "B")!.text.includes("ALPHA"));
    });

    it("US-3.1: each compose broadcasts a draft_updated frame scoped to the correct project+pane", async () => {
      await waitFor(() => draftFrames.some((f) => f.paneId === "A") && draftFrames.some((f) => f.paneId === "B"));
      const aFrame = draftFrames.find((f) => f.paneId === "A");
      const bFrame = draftFrames.find((f) => f.paneId === "B");
      assert.ok(aFrame && bFrame, "a draft_updated frame was scoped to each of A and B");
      assert.equal(aFrame.projectId, projectId, "A's frame carries the active project id");
      assert.equal(bFrame.projectId, projectId, "B's frame carries the active project id");
      assert.equal(aFrame.draft.text, "ALPHA build the parser", "A's frame carries A's draft text");
      assert.equal(bFrame.draft.text, "BRAVO run the migration", "B's frame carries B's draft text");
    });

    it("US-3.1 (negative): composing with NO active pane is a no-op — no orphan draft, no frame", async () => {
      const before = draftFrames.length;
      running._testSetActivePane?.(null);
      const c = session.emitToolCall("update_draft_prompt", { text: "ORPHAN should never land", mode: "replace" });
      const out = await waitFor(() => mock.responseFor(c));
      assert.match(String(out), /No pane is open/i, "voice is told there is no pane to compose against");
      assert.deepStrictEqual(
        running.manager.ledger.listDrafts(projectId).map((d) => d.draft.text).filter((t) => t.includes("ORPHAN")),
        [],
        "no orphan draft was created when no pane is active",
      );
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(draftFrames.length, before, "no draft_updated frame is broadcast for a no-active-pane compose");
    });
  });

  // ── US-3.3 — writes only reach the active pane (raw-input REST + voice propose_command) ──────────
  describe("US-3.3 writes only reach the active pane", () => {
    for (const [label, bytes] of [
      ["a nav key (Arrow Up)", ARROW_UP],
      ["the Ctrl+C emergency brake", CTRL_C],
    ] as Array<[string, string]>) {
      it(`US-3.3: ${label} to a NON-active pane is 409 (names the active pane) and writes NOTHING`, async () => {
        const { term: active } = spawnedPane("on");
        const { term: bg, writes: bgWrites } = spawnedPane("off");
        running.manager.terminals["on"] = active;
        running.manager.terminals["off"] = bg;
        running._testSetActivePane?.("on"); // operator has 'on' open; 'off' is a background pane

        const res = await api("/api/terminals/off/raw-input", {
          method: "POST",
          body: JSON.stringify({ bytes }),
        });
        assert.strictEqual(res.status, 409, `${label} to a background pane => 409`);
        const body = await res.json();
        assert.ok(typeof body.error === "string" && body.error.length > 0, "409 carries an explanatory error");
        assert.match(body.error, /on/, "the error names the active pane ('on')");
        assert.deepStrictEqual(bgWrites, [], `${label} reached the non-active transport NOWHERE`);

        running._testSetActivePane?.(null);
        delete running.manager.terminals["on"];
        delete running.manager.terminals["off"];
      });
    }

    it("US-3.3: with NO active pane, raw input is 409 ('no pane is open') and writes nothing", async () => {
      const { term, writes } = spawnedPane("nactive");
      running.manager.terminals["nactive"] = term;
      running._testSetActivePane?.(null); // no source of truth -> every key refused

      const res = await api("/api/terminals/nactive/raw-input", {
        method: "POST",
        body: JSON.stringify({ bytes: ARROW_UP }),
      });
      assert.strictEqual(res.status, 409, "no active pane => 409");
      const body = await res.json();
      assert.match(body.error, /no pane is active/i, "the 409 says no pane is active");
      assert.deepStrictEqual(writes, [], "nothing reaches the transport when no pane is active");
      delete running.manager.terminals["nactive"];
    });

    it("US-3.3: a non-allowlisted byte sequence ('rm -rf ~\\r') is 400-rejected BEFORE the PTY", async () => {
      const { term, writes } = spawnedPane("active2");
      running.manager.terminals["active2"] = term;
      running._testSetActivePane?.("active2"); // active + spawned: only the allowlist guard can stop it

      const res = await api("/api/terminals/active2/raw-input", {
        method: "POST",
        body: JSON.stringify({ bytes: RM_RF }),
      });
      assert.strictEqual(res.status, 400, "an arbitrary shell line is not a vetted raw key => 400");
      const body = await res.json();
      assert.strictEqual(body.error, "Unrecognized raw-key sequence", "exact rejection message");
      assert.deepStrictEqual(writes, [], "the shell line NEVER reached the PTY");

      running._testSetActivePane?.(null);
      delete running.manager.terminals["active2"];
    });

    it("US-3.3: voice propose_command to a NON-active pane is refused with a switch-the-pane clarify", async () => {
      // Seed two ledger panes; make 'on' the active write target. A voice propose_command to 'off' must
      // hit the single-active-pane guard in applyDispatchDecision (enforceActivePaneGuard=true on voice)
      // and come back as a clarify naming the active pane + telling Janus to switch — never a write.
      running.manager.ledger.updatePane(projectId, paneMeta("on"));
      running.manager.ledger.updatePane(projectId, paneMeta("off"));
      const { term: onTerm } = spawnedPane("on");
      const { term: offTerm, writes: offWrites } = spawnedPane("off");
      running.manager.terminals["on"] = onTerm;
      running.manager.terminals["off"] = offTerm;
      running._testSetActivePane?.("on");

      const callId = session.emitToolCall("propose_command", {
        pane_id: "off",
        instruction: "git status",
        kind: "shell",
      });
      const out = await waitFor(() => mock.responseFor(callId));
      // voiceResponse maps a clarify ActionResult to { status:"clarify", output:<inactivePaneClarify text> };
      // responseFor returns response.output (the clarify text).
      const text = String(out);
      assert.match(text, /can only act on the pane you have open/i, "Janus is told it can only write the open pane");
      assert.match(text, /'on'/, "the clarify names the active pane ('on')");
      assert.match(text, /switch to 'off'/, "the clarify tells Janus to switch to the target first");
      assert.deepStrictEqual(offWrites, [], "the voice write NEVER reached the non-active pane's transport");

      running._testSetActivePane?.(null);
      delete running.manager.terminals["on"];
      delete running.manager.terminals["off"];
    });
  });

  // ── US-3.4 — rename over the real server (REST + list_panes + ledger_updated broadcast) ──────────
  describe("US-3.4 rename over the real server", () => {
    it("US-3.4: PUT .../panes/:pane_id/rename updates the ledger, shows in list_panes, broadcasts ledger_updated", async () => {
      running.manager.ledger.updatePane(projectId, paneMeta("pane_y", "pane_y"));
      const before = ledgerUpdates.length;

      const res = await api(`/api/projects/${projectId}/panes/pane_y/rename`, {
        method: "PUT",
        body: JSON.stringify({ name: "API" }),
      });
      assert.strictEqual(res.status, 200, "rename succeeds (200)");

      assert.equal(
        running.manager.ledger.getProject(projectId)!.panes["pane_y"].name,
        "API",
        "the rename landed in the ledger",
      );

      const callId = session.emitToolCall("list_panes");
      const out = await waitFor(() => mock.responseFor(callId));
      const groups = out as Array<{ project_id: string; panes: PaneMeta[] }>;
      const renamed = groups.flatMap((g) => g.panes).find((p) => p.pane_id === "pane_y");
      assert.ok(renamed, "list_panes still lists the pane");
      assert.equal(renamed!.name, "API", "list_panes reflects the human name 'API'");

      await waitFor(() => ledgerUpdates.length > before);
      assert.ok(ledgerUpdates.length > before, "renaming broadcasts ledger_updated");
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// US-3.5 — NOT in this file. The "agent ping-pongs work across two live panes by name" journey is
// scored by the vignette/simulator harness, not this deterministic unit suite. (See report.)
// ════════════════════════════════════════════════════════════════════════════════════════════════
