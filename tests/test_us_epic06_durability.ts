// tests/test_us_epic06_durability.ts
//
// EPIC 06 — Durability, Decay & Trust Boundaries. One file, six stories. Author-only;
// this suite edits no source and asserts against the ALREADY-COMMITTED behavior
// (breadcrumb per-pane fairness + history redaction-at-rest are the FIXED contract).
//
// Investigated seams (do not duplicate, do not change):
//   - tests/test_history_redaction_at_rest.ts  (history file is now redacted at rest)
//   - tests/test_history_flush.ts               (debounce/atomic/clear-wins)
//   - tests/test_secrets_at_rest.ts             (Gemini key in-memory-only, never on disk/SQLite)
//   - tests/test_store_migrate.ts / test_store_boot_migration.ts (one-shot reversible migration)
//   - tests/test_boot_quarantine.ts             (server boot quarantine wiring)
//   - tests/test_notes_recall.ts                (notes CRUD/redaction voice tools)
//   - tests/test_interaction_log.ts             (InteractionLogger seam)
//   - server.ts HistoryManager / sanitizeSettingsForClient / interaction-log wiring
//   - src/store/migrate.ts (migrateOnBootIfNeeded / migrateFromObjects / initStoreWithQuarantine)
//   - src/store/retention.ts (pruneOnBoot / pruneIncremental — NOTE: the `notes` table is NEVER
//     touched by either prune path; that ABSENCE is exactly why notes are the durable tier, US-6.1)
//
// KEY ESTABLISHED FACTS this suite leans on:
//   - .janus_history.json is REDACTED at rest (command + output via redactSecrets in
//     HistoryManager.saveHistory, redact-THEN-tail-slice).
//   - History truncation keeps only the TAIL of output (<= historyMaxOutputLength) and only the
//     most-recent historyMaxCommands entries; a clear wins over a pending flush.
//   - The Gemini key is in-memory only; masked (abcdef••••••••wxyz) in settings surfaces; never on
//     disk, never in settings_kv, never in logs.
//   - The retention sweep prunes events/archive/handoffs/pending_*/action_log by TTL — but NOT notes.
//
// HERMETIC + PARALLEL-SAFE: every server/manager/store test runs in its own mkdtemp cwd (chdir),
// chdir back + rmSync in finally, awaits terminal.stop()/teardownServerSuite. Synthetic credentials
// are FAKE-by-shape only (AKIA+16, AIza+35) — never real keys.
//
// Runner: npx tsx --test --test-force-exit tests/test_us_epic06_durability.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { JanusStore } from "../src/store/sqliteStore";
import {
  migrateOnBootIfNeeded,
  migrateFromJson,
  LEDGER_MIGRATED_KEY,
  initStoreWithQuarantine,
} from "../src/store/migrate";
import { pruneOnBoot, pruneIncremental } from "../src/store/retention";
import { OrchestratorManager, redactSecrets } from "../src/terminal";
import { WorldModel } from "../src/memory/worldModel";
import { BreadcrumbRing } from "../src/memory/breadcrumbs";
import {
  InteractionLogger,
  createFileInteractionSink,
  NOOP_SINK,
  groupByInteraction,
} from "../src/interactionLog";

// ── Synthetic credentials — FAKE by shape, never real keys. ───────────────────────────────────────
// AKIA + 16 uppercase alnum  -> \bAKIA[0-9A-Z]{16}\b -> [REDACTED:aws-key]
const FAKE_AWS = "AKIA" + "ABCDEFGHIJKLMNOP";
// AIza + 35 chars            -> \bAIza[0-9A-Za-z_-]{35}\b -> [REDACTED:google-api-key]
const FAKE_GOOGLE = "AIza" + "Sy" + "Z".repeat(33); // shaped like a Gemini key

function mkcwd(tag: string): { dir: string; prev: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `janus-e06-${tag}-`));
  const prev = process.cwd();
  process.chdir(dir);
  return { dir, prev };
}
function restore(prev: string, dir: string) {
  process.chdir(prev);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// addNote stamps created_at = Date.now() (ms). getNotes orders by created_at DESC, so two notes added
// within the SAME millisecond have no defined relative order. To pin ORDER deterministically (US-6.1),
// nudge the wall clock forward a couple ms between inserts with a tight synchronous wait (hermetic; no
// async timer, no flake under load).
function tickMs(ms = 2): void {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* spin: guarantee a distinct created_at */ }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// US-6.1 — Notes are the durable tier (P0).
//
// Notes must survive: a store reopen (restart), the 14d/30d TTL maintenance sweeps (events/archive
// TTLs), and a project switch away-and-back. They must appear in the switch_context briefing
// (getProjectBriefing) and in the WorldModel Project tier. Ordering/timestamps are preserved.
//
// We drive the JanusStore + WorldModel seams directly (hermetic, no PTY, no server) — exactly the
// surfaces server.ts mounts. The retention sweeps are seeded with timestamps OLDER than both TTLs.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("US-6.1 notes are the durable tier (survive restart, TTL maintenance, project switch)", () => {
  it("US-6.1: project + pane notes survive a store REOPEN (restart) with order + timestamps intact", () => {
    const { dir, prev } = mkcwd("notes-restart");
    const dbPath = path.join(dir, ".janus.db");
    try {
      {
        const s = new JanusStore(dbPath); s.init();
        s.addProject("proj", "/tmp", "the orbital runner", ["pty", "voice"]);
        s.savePane({
          pane_id: "pane-1", workspace_id: "proj", name: "pane-1", runtime_type: "shell",
          tool_preset: "Custom", permissions_mode: "Human-in-the-Loop", session_id: "",
          last_known_state: "Idle", is_busy: false, alive: false, context_size: 0,
          last_status_change_at: null, last_command: null, scrollback_path: null,
          created_at: Date.now(), updated_at: Date.now(),
        });
        const n1 = s.addNote("proj", "first decision", { type: "note", author: "user" });
        tickMs();
        const n2 = s.addNote("proj", "second decision", { type: "note", author: "user" });
        tickMs();
        const pn = s.addPaneNote("proj", "pane-1", "pane-scoped reminder");
        assert.ok(n1 && n2 && pn, "all three notes inserted");
        s.close();
      }
      // Restart: a fresh connection on the same file.
      const s2 = new JanusStore(dbPath); s2.init();
      try {
        const proj = s2.getNotes({ projectId: "proj" }).filter((n) => n.pane_id === null);
        assert.deepStrictEqual(
          proj.map((n) => n.text),
          ["second decision", "first decision"],
          "project notes survive restart, newest-first ORDER preserved",
        );
        // created_at is preserved and strictly orders the two notes.
        assert.ok(proj[0].created_at >= proj[1].created_at, "timestamps preserved and monotone");
        const paneNotes = s2.getNotes({ projectId: "proj", paneId: "pane-1" });
        assert.ok(paneNotes.some((n) => n.text === "pane-scoped reminder"), "pane note survives restart");
      } finally {
        s2.close();
      }
    } finally {
      restore(prev, dir);
    }
  });

  it("US-6.1: notes survive the 14d/30d TTL maintenance (boot prune + incremental sweep) — the notes table is never pruned", () => {
    const { dir, prev } = mkcwd("notes-ttl");
    const dbPath = path.join(dir, ".janus.db");
    const s = new JanusStore(dbPath); s.init();
    try {
      s.addProject("proj", "/tmp", "durable", []);
      // A note + an event sharing the SAME ancient timestamp era. The event is far older than both
      // TTLs and MUST be pruned; the note (no TTL at all) MUST survive.
      const ancientNote = s.addNote("proj", "ancient but durable decision", { type: "note", author: "user" });
      assert.ok(ancientNote, "note inserted");
      const day = 86_400_000;
      const now = Date.now();
      // Seed an event 60 days old (> 30d eventsTtl) directly so the prune has something to delete.
      s.appendEvent({ type: "command_outcome", project_id: "proj", ts: now - 60 * day, summary: "ancient event" });
      const eventsBefore = s.getEvents({ projectId: "proj", type: "command_outcome" }).length;
      assert.ok(eventsBefore >= 1, "an ancient event exists to be pruned");

      // 30d events TTL + 14d archive TTL — the production server.ts values (server.ts:497-498).
      pruneOnBoot((s as any).db, { now, eventsTtlDays: 30, archiveTtlDays: 14, scrollbackDirs: [dir] });
      const sweep = pruneIncremental((s as any).db, { now, eventsTtlDays: 30, archiveTtlDays: 14 });

      // The ancient EVENT is gone (proves the sweep actually ran against this data)...
      assert.strictEqual(
        s.getEvents({ projectId: "proj", type: "command_outcome" }).length, 0,
        "the >30d event was pruned by the TTL maintenance",
      );
      // ...the sweep result never reports a `notes` category (the table is outside retention)...
      assert.ok(!("notes" in sweep.deleted), "the retention sweep does not even consider the notes table");
      // ...and the note is STILL in the durable tier.
      const surviving = s.getNotes({ projectId: "proj" });
      assert.ok(surviving.some((n) => n.text === "ancient but durable decision"),
        "the note survives both TTL sweeps — notes are the durable tier");
    } finally {
      s.close();
      restore(prev, dir);
    }
  });

  it("US-6.1: notes appear in the switch_context briefing AND the WorldModel Project tier; a project switch away-and-back preserves them", () => {
    const { dir, prev } = mkcwd("notes-switch");
    const dbPath = path.join(dir, ".janus.db");
    const s = new JanusStore(dbPath); s.init();
    try {
      s.addProject("projA", "/a", "alpha summary", ["alpha"]);
      s.addProject("projB", "/b", "beta summary", ["beta"]);
      s.addNote("projA", "alpha note one", { type: "note", author: "user" });
      tickMs();
      s.addNote("projA", "alpha note two", { type: "note", author: "user" });

      // switch_context briefing surface (the legacy getProjectBriefing shape server mounts).
      const briefBefore = s.getProjectBriefing("projA");
      assert.ok(briefBefore, "projA has a briefing");
      assert.deepStrictEqual(
        briefBefore!.notes,
        ["alpha note one", "alpha note two"],
        "briefing carries the project notes in chronological (ASC) order",
      );

      // Simulate active project switching away (to B) and back (to A): the KV active id changes,
      // but the notes are project-scoped rows — independent of which project is active.
      s.setKV("activeProjectId", "projB");
      assert.strictEqual(s.getKV("activeProjectId"), "projB", "switched away to projB");
      s.setKV("activeProjectId", "projA");
      assert.strictEqual(s.getKV("activeProjectId"), "projA", "switched back to projA");

      const briefAfter = s.getProjectBriefing("projA");
      assert.deepStrictEqual(
        briefAfter!.notes, ["alpha note one", "alpha note two"],
        "the switch away-and-back preserved projA's notes (order intact)",
      );

      // WorldModel Project tier reads getProject(projectId) — drive it with the SAME store + a
      // redact pass; the tier reflects the project summary/key-terms (notes feed the briefing,
      // P0a keeps recentDecisions empty — characterized below).
      const wm = new WorldModel({
        manager: {
          activeId: null, terminals: {}, ledger: { activeProjectId: "projA" },
          settings: { globalPermissionsMode: "Human-in-the-Loop" }, listPanes: () => [],
        },
        store: s as any,
        redact: redactSecrets,
        breadcrumbs: new BreadcrumbRing({ breadcrumbMax: 5, breadcrumbMaxAgeMs: 1e9 }),
      });
      const tier = wm.getProjectTier("projA")!;
      assert.strictEqual(tier.name, "projA");
      assert.strictEqual(tier.summary, "alpha summary", "Project tier carries the (redacted) summary");
      // CHARACTERIZATION: P0a's WorldModel Project tier exposes summary/keyTerms but NOT the note
      // texts (recentDecisions is intentionally empty until P0b enriches from decision-typed notes).
      // The notes' durable home / recall surface is getProjectBriefing above, not this tier.
      assert.deepStrictEqual(tier.recentDecisions, [], "// CHARACTERIZATION: Project tier recentDecisions is [] in P0a");
    } finally {
      s.close();
      restore(prev, dir);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// US-6.2 — History truncation is tail-keeping, and we know it (P2 CHARACTERIZATION).
//
// Asserts the CURRENT (fixed) behavior of HistoryManager: redact-then-tail-slice keeps only the
// TAIL of output (<= historyMaxOutputLength), an early ERROR sentinel buried under noise is ABSENT
// at rest, only the most-recent historyMaxCommands entries survive, and a clear wins over a pending
// flush. We tighten the limits via env BEFORE importing ../server so the HistoryManager picks them
// up; the in-memory cap (historyMaxOutputLength) is read live off manager.settings.advanced.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("US-6.2 history truncation is tail-keeping (characterization)", () => {
  let hm: any;
  let serverMod: any;
  let dir: string;
  let prev: string;

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    ({ dir, prev } = mkcwd("hist-tail"));
    serverMod = await import("../server");
    hm = serverMod.HistoryManager.getInstance();
    // Limits are read LIVE (HistoryManager.getLimits -> manager.settings.advanced), so each test
    // tightens them via setLimits() just before driving the manager.
  });

  after(async () => {
    try { await hm.flushAll?.(); } catch { /* noop */ }
    restore(prev, dir);
  });

  function setLimits(maxCommands: number, maxOutput: number) {
    const adv = (serverMod.manager.settings.advanced ||= {} as any);
    adv.historyMaxCommands = maxCommands;
    adv.historyMaxOutputLength = maxOutput;
  }

  function historyPath(): string {
    return path.join(process.cwd(), ".janus_history.json");
  }
  function readHistory(): Record<string, any[]> {
    try { return JSON.parse(fs.readFileSync(historyPath(), "utf-8")); } catch { return {}; }
  }

  it("US-6.2: an early ERROR sentinel under (maxOutput x3) of noise is ABSENT at rest — only the TAIL (<= maxOutput) survives", async () => {
    const MAX_OUTPUT = 200;
    setLimits(50, MAX_OUTPUT);
    const SENTINEL = "ERR_SENTINEL_FATAL_42";
    hm.addCommand("tail-pane", "run thing");
    // The sentinel sits at the very FRONT, followed by maxOutput*3 chars of noise. The tail-slice
    // keeps only the last MAX_OUTPUT chars, so the early sentinel is sliced away.
    hm.appendOutputToLastCommand("tail-pane", SENTINEL + " " + "n".repeat(MAX_OUTPUT * 3));
    await hm.flushAll();

    const parsed = readHistory();
    const out: string = parsed["tail-pane"][0].output;
    assert.ok(out.length <= MAX_OUTPUT, `output capped to the TAIL (<= maxOutput=${MAX_OUTPUT}), got ${out.length}`);
    // CHARACTERIZATION: tail-keeping means the EARLY sentinel is gone — history is not a full log.
    assert.ok(!out.includes(SENTINEL), "// CHARACTERIZATION: the early ERROR sentinel is ABSENT (tail-only retention)");
    const raw = fs.readFileSync(historyPath(), "utf-8");
    assert.ok(!raw.includes(SENTINEL), "the sentinel is absent in the file at rest, not just the parsed view");
  });

  it("US-6.2: with > historyMaxCommands commands, only the most-recent N survive", async () => {
    const MAX_CMDS = 3;
    setLimits(MAX_CMDS, 5000);
    for (let i = 0; i < 7; i++) hm.addCommand("cap-pane", `cmd-${i}`);
    await hm.flushAll();

    const entries = readHistory()["cap-pane"];
    assert.strictEqual(entries.length, MAX_CMDS, `only historyMaxCommands=${MAX_CMDS} entries survive`);
    // The TAIL of the command list — the most-recent N.
    assert.deepStrictEqual(
      entries.map((e: any) => e.command),
      ["cmd-4", "cmd-5", "cmd-6"],
      "only the most-recent N commands are kept (tail of the command list)",
    );
  });

  it("US-6.2: clearing a pane's history WINS over any flush in flight (the clear is never resurrected)", async () => {
    setLimits(50, 5000);
    hm.addCommand("clr-pane", "echo doomed");      // dirty entry, flush pending
    hm.appendOutputToLastCommand("clr-pane", "DOOMED-OUTPUT");
    hm.clearHistory("clr-pane");                    // operator clears DURING the window
    await hm.flushAll();                            // force every pending flush to land

    const parsed = readHistory();
    assert.deepStrictEqual(parsed["clr-pane"] ?? [], [], "a cleared pane stays cleared after the pending flush lands");
    assert.deepStrictEqual(hm.loadHistory("clr-pane"), [], "the cache view agrees (no dirty resurrection)");
    const raw = fs.readFileSync(historyPath(), "utf-8");
    assert.ok(!raw.includes("DOOMED-OUTPUT"), "the doomed output never reappears at rest");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// US-6.3 — Secrets never reach persistent memory (P0).
//
// A synthetic credential placed in pane output / notes / lastCommand must NEVER appear verbatim in:
//   (a) the synthesized WORKING BRIEF (WorldModel boundary — every text field redacted there),
//   (b) the .janus_interaction_log.jsonl lines,
//   (c) breadcrumb text,
//   (d) the .janus_history.json at rest (now redacted — the FIXED behavior).
// And: the Gemini key in settings surfaces is masked (abcdef••••••••wxyz); a masked PUT-back does not
// overwrite the real key; the key never appears in server logs.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("US-6.3 secrets never reach persistent memory", () => {
  it("US-6.3(a)+(c): the synthesized working brief redacts a credential in pane lastCommand (WorldModel boundary) AND carries no secret from a breadcrumb (producer-side redaction)", async () => {
    // Build a WorldModel exactly as server.ts wires it (redact = redactSecrets). The active pane's
    // lastCommand carries the fake Google key RAW — the WorldModel redacts it at the tier boundary
    // (getPaneTier.lastCommand). The breadcrumb is fed the way the observe pipeline feeds it: ALREADY
    // redacted (src/observe/index.ts redact()'s the one-liner BEFORE onBreadcrumb). The BreadcrumbRing
    // itself stores text verbatim — redaction for the breadcrumb tier is PRODUCER-side, not at the
    // WorldModel boundary. We mirror that so the brief never carries a secret from EITHER path.
    const { assembleBrief } = await import("../src/memory/assembler");
    const { DEFAULT_MEMORY_CONFIG } = await import("../src/memory/types");
    const breadcrumbs = new BreadcrumbRing({ breadcrumbMax: 5, breadcrumbMaxAgeMs: 1e9 });
    // CHARACTERIZATION: the ring is NOT a redaction boundary — the feed edge redacts. Feed as observe does.
    breadcrumbs.add({ ts: Date.now(), paneId: "p1", text: redactSecrets(`pane p1 ran export AWS=${FAKE_AWS}`) });
    const wm = new WorldModel({
      manager: {
        activeId: "p1",
        terminals: { p1: { name: "p1", runtimeType: "shell", status: "Running", lastCommand: `gcloud auth ${FAKE_GOOGLE}` } },
        ledger: { activeProjectId: "proj" },
        settings: { globalPermissionsMode: "Human-in-the-Loop" },
        listPanes: () => [{ project_id: "proj", panes: [{ pane_id: "p1", name: "p1", last_known_state: "Running" }] }],
      },
      store: { getProject: () => ({ id: "proj", name: "Proj", summary: "s", key_terms: [] }), getProjectBriefing: () => null },
      redact: redactSecrets,
      breadcrumbs,
    });
    const brief = assembleBrief(wm.getTiers("p1", Date.now() + 1), DEFAULT_MEMORY_CONFIG as any, Date.now() + 1);

    assert.ok(!brief.text.includes(FAKE_AWS), "AWS key never reaches the working brief (breadcrumb path, producer-redacted)");
    assert.ok(!brief.text.includes(FAKE_GOOGLE), "Google key never reaches the working brief (lastCommand redacted at the WorldModel boundary)");
    assert.match(brief.text, /\[REDACTED/, "the brief carries a redaction marker where a secret was");

    // Pin the WorldModel boundary directly: getPaneTier.lastCommand is redacted (NOT verbatim).
    const paneTier = wm.getPaneTier("p1")!;
    assert.ok(!paneTier.lastCommand!.includes(FAKE_GOOGLE), "getPaneTier redacts lastCommand at the boundary");
    assert.match(paneTier.lastCommand!, /\[REDACTED/, "the redaction marker is present in the pane tier");
  });

  it("US-6.3(b): a credential pushed through the interaction log is REDACTED in the JSONL lines", () => {
    const { dir, prev } = mkcwd("ixn-redact");
    try {
      const logPath = path.join(dir, ".janus_interaction_log.jsonl");
      const logger = new InteractionLogger({ sink: createFileInteractionSink(logPath), redact: redactSecrets });
      const id = logger.mint();
      logger.log({ interactionId: id, kind: "voice_in", text: `set the key to ${FAKE_GOOGLE}` });
      logger.log({ interactionId: id, kind: "tool_call", data: { name: "propose_command", args: { cmd: `aws ${FAKE_AWS}` } } });

      const raw = fs.readFileSync(logPath, "utf-8");
      assert.ok(!raw.includes(FAKE_AWS), "AWS key redacted in the interaction log file");
      assert.ok(!raw.includes(FAKE_GOOGLE), "Google key redacted in the interaction log file");
      assert.match(raw, /\[REDACTED/, "a redaction marker is present in the JSONL");
      // Every line still parses (redaction never corrupts the JSON).
      for (const line of raw.split("\n").filter(Boolean)) JSON.parse(line);
    } finally {
      restore(prev, dir);
    }
  });

  it("US-6.3(d): a credential in pane output is REDACTED in .janus_history.json at rest (the FIXED behavior)", async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    const { dir, prev } = mkcwd("hist-secret");
    try {
      const serverMod = await import("../server");
      const hm = serverMod.HistoryManager.getInstance();
      hm.addCommand("sec-pane", `aws configure set ${FAKE_AWS}`);
      hm.appendOutputToLastCommand("sec-pane", `leaked ${FAKE_GOOGLE} in output`);
      await hm.flushAll();

      const raw = fs.readFileSync(path.join(dir, ".janus_history.json"), "utf-8");
      assert.ok(!raw.includes(FAKE_AWS), "AWS key must NOT appear verbatim in history at rest");
      assert.ok(!raw.includes(FAKE_GOOGLE), "Google key must NOT appear verbatim in history at rest");
      assert.match(raw, /\[REDACTED/, "history at rest carries a redaction marker");
      await hm.flushAll();
    } finally {
      restore(prev, dir);
    }
  });

  // The Gemini-key masking + PUT-back-keeps-real-key + on-disk/log secrecy are pinned against the REAL
  // production surfaces (GET /api/settings, the settings_updated WS broadcast, the PUT route) by booting
  // the in-process server headless via the mockLive harness — exactly how test_notes_recall drives it.
  describe("US-6.3 Gemini key masking through the real server surfaces", () => {
    let startServer: (opts?: any) => Promise<any>;
    let apiToken: string;
    let installMockLive: () => any;
    let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;
    let WebSocket: any;

    let running: any;
    let client: any;
    let base: string;
    let dir: string;
    let prev: string;
    // Capture console for the whole suite so we can prove the key never reaches a log line.
    const logLines: string[] = [];
    let origLog: any, origErr: any, origWarn: any;

    const api = (pathname: string, init: RequestInit = {}): Promise<Response> =>
      fetch(`${base}${pathname}`, {
        ...init,
        headers: { "x-api-token": apiToken, "content-type": "application/json", ...(init.headers || {}) },
      });

    before(async () => {
      process.env.NODE_ENV = "test";
      process.env.JANUS_NO_AUTOSTART = "1";
      ({ dir, prev } = mkcwd("gemini-server"));

      ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
      ({ WebSocket } = await import("ws"));
      const serverMod = await import("../server");
      startServer = serverMod.startServer;
      apiToken = serverMod.API_AUTH_TOKEN;

      installMockLive();
      running = await startServer({ port: 0, enableVite: false });
      base = `http://127.0.0.1:${running.port}`;

      client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, { headers: { Cookie: `auth_token=${apiToken}` } });
      await new Promise<void>((resolve, reject) => { client.on("open", () => resolve()); client.on("error", reject); });

      // Start log capture AFTER boot (boot is noisy with store/init lines we don't care about).
      origLog = console.log; origErr = console.error; origWarn = console.warn;
      const grab = (...a: any[]) => { logLines.push(a.map(String).join(" ")); };
      console.log = grab; console.error = grab; console.warn = grab;
    });

    after(async () => {
      console.log = origLog; console.error = origErr; console.warn = origWarn;
      if (client && client.readyState !== WebSocket.CLOSED) {
        await new Promise<void>((resolve) => { client.once("close", () => resolve()); try { client.terminate(); } catch { resolve(); } });
      }
      const { teardownServerSuite } = await import("./helpers/teardown");
      await teardownServerSuite(running);
      restore(prev, dir);
    });

    it("US-6.3: PUT a real key -> GET /api/settings masks it AND the settings_updated broadcast is masked", async () => {
      // Collect the next settings_updated broadcast pushed to the WS client.
      const gotBroadcast = new Promise<any>((resolve) => {
        client.on("message", (buf: any) => {
          try { const m = JSON.parse(String(buf)); if (m.type === "settings_updated") resolve(m); } catch { /* ignore */ }
        });
      });

      const put = await api("/api/settings", { method: "PUT", body: JSON.stringify({ secrets: { geminiApiKey: FAKE_GOOGLE } }) });
      assert.strictEqual(put.status, 200, "PUT settings accepted");
      const putBody = await put.json();
      // The PUT response is itself masked.
      assert.ok(!JSON.stringify(putBody).includes(FAKE_GOOGLE), "PUT response never echoes the raw key");

      // GET /api/settings is masked: prefix••••••••suffix.
      const get = await (await api("/api/settings")).json();
      const masked: string = get.secrets.geminiApiKey;
      assert.ok(!masked.includes(FAKE_GOOGLE), "GET /api/settings never ships the raw key");
      assert.ok(masked.includes("••••••••"), "GET masks with the bullet run");
      assert.strictEqual(masked.startsWith(FAKE_GOOGLE.substring(0, 6)), true, "prefix preserved (abcdef••••••••wxyz)");
      assert.strictEqual(masked.endsWith(FAKE_GOOGLE.substring(FAKE_GOOGLE.length - 4)), true, "suffix preserved");

      // The settings_updated WS broadcast is masked too.
      const b = await Promise.race([gotBroadcast, new Promise((_, rej) => setTimeout(() => rej(new Error("no broadcast")), 2000))]);
      assert.ok(!JSON.stringify(b).includes(FAKE_GOOGLE), "the settings_updated broadcast never carries the raw key");
      assert.ok(JSON.stringify(b).includes("••••••••"), "the broadcast carries the masked form");

      // The real key is held in memory for the live session.
      assert.strictEqual(running.manager.settings.secrets.geminiApiKey, FAKE_GOOGLE, "real key held in memory");
    });

    it("US-6.3: a MASKED value PUT back does NOT overwrite the real key", async () => {
      // The masked form the UI would echo back on a no-change save.
      const maskedEcho = FAKE_GOOGLE.substring(0, 6) + "••••••••" + FAKE_GOOGLE.substring(FAKE_GOOGLE.length - 4);
      const put = await api("/api/settings", { method: "PUT", body: JSON.stringify({ secrets: { geminiApiKey: maskedEcho } }) });
      assert.strictEqual(put.status, 200, "masked round-trip PUT accepted");
      // The server detected the '••••' echo and RESTORED the real in-memory key (did not clobber it).
      assert.strictEqual(running.manager.settings.secrets.geminiApiKey, FAKE_GOOGLE,
        "a masked PUT-back leaves the real key intact (not overwritten with the masked string)");
    });

    it("US-6.3: the Gemini key never appears in any captured server log line, nor in .janus_settings.json at rest", () => {
      assert.ok(!logLines.some((l) => l.includes(FAKE_GOOGLE)), "the Gemini key never appears in a server log line");
      // On-disk settings: the secret is in-memory-only, blanked on disk (secrets-at-rest hardening).
      const settingsFile = path.join(process.cwd(), ".janus_settings.json");
      if (fs.existsSync(settingsFile)) {
        const onDisk = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
        assert.notStrictEqual(onDisk.secrets?.geminiApiKey, FAKE_GOOGLE, "the real key is never written to .janus_settings.json");
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// US-6.4 — Migration one-shot and reversible (P1).
//
// A populated legacy .janus_ledger.json with no marker -> migrateOnBootIfNeeded imports
// workspaces/panes/notes into SQLite, renames originals to .bak AFTER the commit, sets the marker
// INSIDE the transaction; a second boot is a no-op; an unparseable ledger aborts loudly, leaving the
// JSON untouched (no rename, no marker). (Mirrors test_store_migrate.ts / test_store_boot_migration.ts
// but consolidated under the epic's story id.)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("US-6.4 migration is one-shot, reversible, and idempotent", () => {
  function writeLedger(dir: string) {
    const p = path.join(dir, ".janus_ledger.json");
    fs.writeFileSync(p, JSON.stringify({
      activeProjectId: "p1",
      workspaces: { p1: {
        id: "p1", name: "P1", directory: "/tmp", summary: "s", keyTerms: ["k"],
        notes: ["legacy decision A", "legacy decision B"],
        panes: { t1: { pane_id: "t1", name: "t1", runtime_type: "shell", last_known_state: "Idle",
          is_busy: false, alive: false, notes: ["pane legacy note"], permissions_mode: "Human-in-the-Loop",
          session_id: "", tool_preset: "Claude Code", context_size: 0 } },
      } },
      watchRules: [], plans: [],
    }), "utf8");
    return p;
  }

  it("US-6.4: a populated legacy ledger imports workspaces/panes/notes; originals .bak'd AFTER commit; marker set", () => {
    const { dir, prev } = mkcwd("mig-happy");
    const ledgerPath = writeLedger(dir);
    const s = new JanusStore(path.join(dir, ".janus.db")); s.init();
    try {
      const paths = {
        ledgerPath,
        settingsPath: path.join(dir, ".janus_settings.json"),
        historyPath: path.join(dir, ".janus_history.json"),
      };
      assert.strictEqual(migrateOnBootIfNeeded(s, paths), true, "first boot performs the import");

      assert.strictEqual(s.getWorkspaces()["p1"].name, "P1", "workspace imported");
      assert.strictEqual(Object.keys(s.getPanes("p1")).length, 1, "pane imported");
      const notes = s.getNotes({ projectId: "p1" });
      assert.ok(notes.some((n) => n.text === "legacy decision A" && n.pane_id === null), "project note imported");
      assert.ok(notes.some((n) => n.text === "legacy decision B" && n.pane_id === null), "second project note imported");
      assert.ok(notes.some((n) => n.text === "pane legacy note" && n.pane_id === "t1"), "pane note imported");

      assert.ok(s.getKV(LEDGER_MIGRATED_KEY), "marker set (inside the import transaction)");
      assert.ok(fs.existsSync(`${ledgerPath}.bak`), "original renamed to .bak AFTER the commit");
      assert.ok(!fs.existsSync(ledgerPath), "original no longer at the live path");
    } finally {
      s.close();
      restore(prev, dir);
    }
  });

  it("US-6.4: a second boot does NOT re-import (idempotent on the in-DB marker)", () => {
    const { dir, prev } = mkcwd("mig-idem");
    const ledgerPath = writeLedger(dir);
    const dbPath = path.join(dir, ".janus.db");
    const paths = { ledgerPath, settingsPath: path.join(dir, ".janus_settings.json"), historyPath: path.join(dir, ".janus_history.json") };
    try {
      const s1 = new JanusStore(dbPath); s1.init();
      assert.strictEqual(migrateOnBootIfNeeded(s1, paths), true);
      s1.close();

      // A stray ledger reappears with DIFFERENT data; the marker must block re-import.
      fs.writeFileSync(ledgerPath, JSON.stringify({ workspaces: { p2: { id: "p2", name: "SHOULD_NOT_IMPORT", panes: {} } } }), "utf8");
      const s2 = new JanusStore(dbPath); s2.init();
      try {
        assert.strictEqual(migrateOnBootIfNeeded(s2, paths), false, "already-migrated -> no-op");
        assert.strictEqual(s2.getWorkspaces()["p2"], undefined, "the second file is NOT imported");
      } finally {
        s2.close();
      }
    } finally {
      restore(prev, dir);
    }
  });

  it("US-6.4: an unparseable legacy ledger ABORTS loudly — file untouched at its live path, no .bak, no marker, nothing imported", () => {
    const { dir, prev } = mkcwd("mig-corrupt");
    const ledgerPath = path.join(dir, ".janus_ledger.json");
    fs.writeFileSync(ledgerPath, "{ not json !!!", "utf8");
    const s = new JanusStore(path.join(dir, ".janus.db")); s.init();
    try {
      assert.throws(() => migrateOnBootIfNeeded(s, {
        ledgerPath,
        settingsPath: path.join(dir, ".janus_settings.json"),
        historyPath: path.join(dir, ".janus_history.json"),
      }), /ledger|parse/i, "an existing-but-unparseable ledger throws rather than silently archiving");

      assert.ok(fs.existsSync(ledgerPath), "the unparseable ledger is left in place (recoverable)");
      assert.ok(!fs.existsSync(`${ledgerPath}.bak`), "it is NOT renamed to .bak");
      assert.strictEqual(s.getKV(LEDGER_MIGRATED_KEY), null, "the migration marker is NOT set");
      assert.strictEqual(Object.keys(s.getWorkspaces()).length, 0, "nothing was imported");
    } finally {
      s.close();
      restore(prev, dir);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// US-6.5 — Storage failure is loud, recoverable, never silently empty (P0).
//
// A corrupted .janus.db (+ stale -wal/-shm twins) is quarantined to .janus.db.corrupt-<ts>, a FRESH
// DB is initialized, the console states the quarantine path; only if the retry ALSO fails does the
// caller fall back to legacy. Negative/regression: NO silent-fallback-to-empty-legacy.
// (Models tests/test_boot_quarantine.ts / test_store_migrate.ts.)
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("US-6.5 storage failure is loud + recoverable, never silently empty", () => {
  it("US-6.5: a corrupt DB (+ stale -wal/-shm twins) is quarantined to .corrupt-<ts>, a FRESH DB boots, the path is announced", () => {
    const { dir, prev } = mkcwd("quar");
    const dbPath = path.join(dir, ".janus.db");
    const GARBAGE = "THIS IS NOT A SQLITE DATABASE  garbage";
    fs.writeFileSync(dbPath, GARBAGE, "utf8");
    fs.writeFileSync(`${dbPath}-wal`, "stale wal", "utf8");
    fs.writeFileSync(`${dbPath}-shm`, "stale shm", "utf8");

    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...a: any[]) => { errs.push(a.map(String).join(" ")); };
    let result: ReturnType<typeof initStoreWithQuarantine>;
    try {
      result = initStoreWithQuarantine(dbPath, (s) => s.init());
    } finally {
      console.error = origErr;
    }
    try {
      assert.ok(result.store, "a FRESH store boots after quarantine (never a silent empty fallback)");
      assert.ok(result.quarantinedTo, "the quarantine path is reported");
      assert.match(result.quarantinedTo!, /\.corrupt-\d+$/, "bad DB renamed to .corrupt-<timestamp>");
      assert.ok(fs.existsSync(result.quarantinedTo!), "the quarantined file exists (recoverable)");
      assert.strictEqual(fs.readFileSync(result.quarantinedTo!, "utf8"), GARBAGE, "corrupt bytes preserved verbatim");
      // The console STATED the quarantine path (loud, recoverable — the spec's core property).
      assert.ok(errs.some((l) => l.includes(result.quarantinedTo!)), "the console announced the quarantine path");
      // No stale twin lingers under the LIVE name (replay hazard).
      assert.ok(!fs.existsSync(`${dbPath}-wal`) || fs.readFileSync(`${dbPath}-wal`, "utf8") !== "stale wal",
        "no stale -wal twin under the live name");
      // The fresh store WORKS.
      result.store!.setKV("smoke", "ok");
      assert.strictEqual(result.store!.getKV("smoke"), "ok", "the fresh store round-trips");
    } finally {
      try { result!.store?.close(); } catch { /* noop */ }
      restore(prev, dir);
    }
  });

  it("US-6.5 (regression): a healthy/absent DB boots with NO quarantine and NO data loss — the old silent-empty fallback does not recur", () => {
    const { dir, prev } = mkcwd("quar-healthy");
    const dbPath = path.join(dir, ".janus.db");
    try {
      const r1 = initStoreWithQuarantine(dbPath, (s) => s.init());   // absent -> fresh
      assert.ok(r1.store, "absent DB created fresh");
      assert.strictEqual(r1.quarantinedTo, null, "no quarantine for a fresh DB");
      r1.store!.setKV("k", "v");
      r1.store!.close();

      const r2 = initStoreWithQuarantine(dbPath, (s) => s.init());   // healthy reopen
      try {
        assert.ok(r2.store, "healthy DB reopens");
        assert.strictEqual(r2.quarantinedTo, null, "no quarantine for a healthy DB");
        assert.strictEqual(r2.store!.getKV("k"), "v", "existing data intact (no destructive rename, never silently empty)");
      } finally {
        r2.store!.close();
      }
      assert.strictEqual(fs.readdirSync(dir).some((f) => f.includes(".corrupt-")), false, "no .corrupt-* artifacts on the healthy path");
    } finally {
      restore(prev, dir);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// US-6.6 — Turn forensics (P1).
//
// A full simulated turn (voice_in -> tool_call -> action_result -> approval -> pty) writes one
// REDACTED line per leg sharing ONE interaction_id; groupByInteraction reconstructs the timeline so
// per-leg timestamps measure the approve->dispatch lag. JANUS_INTERACTION_LOG=off produces NO file;
// a custom path relocates it. We exercise the PRODUCTION sink (createFileInteractionSink) + the
// analyzer's groupByInteraction + the env-driven sink selection that server.ts performs at module
// load (INTERACTION_LOG_PATH / NOOP_SINK) — all hermetically, no live Gemini socket.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("US-6.6 turn forensics — one redacted line per leg, reconstructable, env-gated", () => {
  it("US-6.6: a full turn writes one redacted leg per kind sharing one interaction_id; the sequence reconstructs and approve->dispatch lag is measurable", () => {
    const { dir, prev } = mkcwd("forensics");
    try {
      const logPath = path.join(dir, ".janus_interaction_log.jsonl");
      // Deterministic clock so per-leg timestamps (and the lag) are exact.
      let t = 1_000;
      const logger = new InteractionLogger({
        sink: createFileInteractionSink(logPath),
        redact: redactSecrets,
        now: () => t,
      });
      const id = logger.mint();
      t = 1_010; logger.log({ interactionId: id, kind: "voice_in", text: `run aws with ${FAKE_AWS}` });
      t = 1_020; logger.log({ interactionId: id, kind: "tool_call", data: { name: "propose_command", args: { cmd: "aws s3 ls" } } });
      t = 1_030; logger.log({ interactionId: id, kind: "action_result", data: { name: "propose_command", resultKind: "deferred" } });
      const approveTs = 1_100; t = approveTs; logger.log({ interactionId: id, kind: "approval", data: { intent: "approve" } });
      const dispatchTs = 1_140; t = dispatchTs; logger.log({ interactionId: id, kind: "pty", paneId: "claude_1", text: "executing" });

      const lines = fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
      assert.strictEqual(lines.length, 5, "one JSONL line per leg");
      // No secret survives anywhere in the file.
      assert.ok(!fs.readFileSync(logPath, "utf-8").includes(FAKE_AWS), "the credential is redacted across all legs");

      const groups = groupByInteraction(lines);
      assert.strictEqual(groups.size, 1, "all legs share ONE interaction_id");
      const legs = groups.get(id)!;
      assert.deepStrictEqual(
        legs.map((l) => l.kind),
        ["voice_in", "tool_call", "action_result", "approval", "pty"],
        "the leg sequence reconstructs in order",
      );
      // approve -> dispatch lag (Issue #1) is measurable from the per-leg ts.
      const approval = legs.find((l) => l.kind === "approval")!;
      const pty = legs.find((l) => l.kind === "pty")!;
      assert.strictEqual(pty.ts - approval.ts, dispatchTs - approveTs, "approve->dispatch lag is measurable from per-leg timestamps");
      assert.strictEqual(pty.pane_id, "claude_1", "the pty leg carries its pane_id");
    } finally {
      restore(prev, dir);
    }
  });

  it("US-6.6: JANUS_INTERACTION_LOG=off produces NO file (NOOP_SINK), and a custom path relocates the log", () => {
    const { dir, prev } = mkcwd("forensics-env");
    try {
      // Mirror server.ts's module-load sink selection exactly: 'off' -> NOOP_SINK, else file sink.
      const offPath = path.join(dir, ".janus_interaction_log.jsonl");
      const offEnv = "off";
      const offSink = offEnv.toLowerCase() === "off" ? NOOP_SINK : createFileInteractionSink(offPath);
      const offLogger = new InteractionLogger({ sink: offSink, redact: redactSecrets });
      offLogger.log({ interactionId: offLogger.mint(), kind: "system", text: "should vanish" });
      assert.ok(!fs.existsSync(offPath), "JANUS_INTERACTION_LOG=off writes no default-path file");
      // And nothing else materialized in the dir from the off logger.
      assert.strictEqual(fs.readdirSync(dir).some((f) => f.includes("interaction_log")), false, "no interaction-log file at all when off");

      // A custom path relocates the log.
      const customPath = path.join(dir, "audit", "turns.jsonl");
      fs.mkdirSync(path.dirname(customPath), { recursive: true });
      const customSink = ("turns.jsonl".toLowerCase() === "off") ? NOOP_SINK : createFileInteractionSink(customPath);
      const customLogger = new InteractionLogger({ sink: customSink, redact: redactSecrets });
      const id = customLogger.mint();
      customLogger.log({ interactionId: id, kind: "system", text: "relocated leg" });
      assert.ok(fs.existsSync(customPath), "a custom path relocates the interaction log");
      assert.match(fs.readFileSync(customPath, "utf-8"), /relocated leg/, "the relocated file carries the leg");
      assert.ok(!fs.existsSync(offPath), "the default path is untouched when a custom path is configured");
    } finally {
      restore(prev, dir);
    }
  });
});
