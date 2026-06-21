// tests/test_migrate_complexity_refactor.ts
//
// Behavior-pinning tests for the CC-35 transaction arrow function inside
// `migrateFromObjects` (src/store/migrate.ts). These pin the CURRENT, verbatim
// behavior of every import branch BEFORE the complexity refactor so the
// VERBATIM, BEHAVIOR-PRESERVING extraction can be proven equivalent.
//
// Uses a real in-memory better-sqlite3 JanusStore (same as test_store_migrate.ts);
// the DB is never mocked.

import { test } from "node:test";
import assert from "node:assert";
import { JanusStore } from "../src/store/sqliteStore";
import {
  migrateFromObjects,
  LEDGER_MIGRATED_KEY,
} from "../src/store/migrate";

// ── Empty / undefined inputs: the no-op-import path still appends the marker event ──
test("pin: empty input imports nothing but still appends the 'migrated from JSON' marker event", () => {
  const s = new JanusStore(":memory:"); s.init();
  migrateFromObjects(s, {});
  assert.strictEqual(Object.keys(s.getWorkspaces()).length, 0, "no workspaces");
  assert.strictEqual(s.getKV("activeProjectId"), null, "no activeProjectId KV");
  assert.strictEqual(s.getKV("watchRules"), null, "no watchRules KV");
  assert.strictEqual(s.getKV("plans"), null, "no plans KV");
  // the unconditional 'migrated from JSON' marker event is appended (pane_id null, no pane filter)
  const all = s.getEvents({ type: "command_outcome" });
  assert.strictEqual(all.length, 1, "exactly the marker event");
  s.close();
});

// ── Full ledger fan-out: workspaces, workspace notes, panes, pane notes, defaults ──
test("pin: full ledger imports workspaces, notes, panes, pane-notes with EXACT default coalescing", () => {
  const s = new JanusStore(":memory:"); s.init();
  const ledger = {
    activeProjectId: "p1",
    watchRules: [{ id: "w1" }, { id: "w2" }],
    plans: [{ id: "pl1" }],
    workspaces: {
      // ws with full fields + notes + a fully-specified pane with a note
      ws1: {
        id: "ws1", name: "WS1", directory: "/dir1", summary: "sum1", keyTerms: ["a", "b"],
        notes: ["wsnote1", "wsnote2"],
        panes: {
          t1: {
            pane_id: "t1", name: "pane1", runtime_type: "shell", tool_preset: "Claude Code",
            permissions_mode: "Auto", session_id: "sess1", last_known_state: "Busy",
            is_busy: true, alive: true, context_size: 42,
            last_status_change_at: 123, last_command: "ls", scrollback_path: "/sb",
            notes: ["panenote1"],
          },
        },
      },
      // ws with MISSING optional fields — exercises every ?? default branch
      ws2: {
        id: "ws2",
        // name, directory, summary, keyTerms, notes, panes all absent
        panes: {
          tDefault: { pane_id: "tDefault" }, // every pane field absent -> defaults
        },
      },
    },
  };
  migrateFromObjects(s, { ledger });

  // workspace 1 fully specified
  const wss = s.getWorkspaces();
  assert.equal(wss["ws1"].name, "WS1");
  assert.equal(wss["ws1"].directory, "/dir1");
  assert.equal(wss["ws1"].summary, "sum1");
  assert.deepEqual(wss["ws1"].key_terms, ["a", "b"]);

  // workspace 2 defaults
  assert.equal(wss["ws2"].name, "", "missing name -> ''");
  assert.equal(wss["ws2"].directory, "", "missing directory -> ''");
  assert.equal(wss["ws2"].summary, "", "missing summary -> ''");
  assert.deepEqual(wss["ws2"].key_terms, [], "missing keyTerms -> []");

  // workspace notes
  const ws1notes = s.getNotes({ projectId: "ws1" });
  assert.ok(ws1notes.some(n => n.text === "wsnote1" && n.pane_id === null));
  assert.ok(ws1notes.some(n => n.text === "wsnote2" && n.pane_id === null));
  assert.ok(ws1notes.some(n => n.text === "panenote1" && n.pane_id === "t1"), "pane note attached to pane");

  // pane 1 fully specified
  const p1 = s.getPanes("ws1")["t1"];
  assert.equal(p1.name, "pane1");
  assert.equal(p1.runtime_type, "shell");
  assert.equal(p1.tool_preset, "Claude Code");
  assert.equal(p1.permissions_mode, "Auto");
  assert.equal(p1.session_id, "sess1");
  assert.equal(p1.last_known_state, "Busy");
  assert.equal(!!p1.is_busy, true);
  assert.equal(!!p1.alive, true);
  assert.equal(p1.context_size, 42);
  assert.equal(p1.last_status_change_at, 123);
  assert.equal(p1.last_command, "ls");
  assert.equal(p1.scrollback_path, "/sb");

  // pane 2 defaults
  const pD = s.getPanes("ws2")["tDefault"];
  assert.equal(pD.name, "", "missing name -> ''");
  assert.equal(pD.runtime_type, "", "missing runtime_type -> ''");
  assert.equal(pD.tool_preset, "Custom", "missing tool_preset -> 'Custom'");
  assert.equal(pD.permissions_mode, "Human-in-the-Loop", "missing permissions_mode default");
  assert.equal(pD.session_id, "", "missing session_id -> ''");
  assert.equal(pD.last_known_state, "Idle", "missing last_known_state -> 'Idle'");
  assert.equal(!!pD.is_busy, false);
  assert.equal(!!pD.alive, false);
  assert.equal(pD.context_size, 0, "missing context_size -> 0");
  assert.equal(pD.last_status_change_at, null, "missing last_status_change_at -> null");
  assert.equal(pD.last_command, null, "missing last_command -> null");
  assert.equal(pD.scrollback_path, null, "missing scrollback_path -> null");

  // ledger KV branches
  assert.equal(s.getKV("activeProjectId"), "p1");
  assert.equal(JSON.parse(s.getKV("watchRules")!).length, 2);
  assert.equal(JSON.parse(s.getKV("plans")!).length, 1);

  s.close();
});

// ── ledger KV branches are independently gated (falsy -> not written) ──
test("pin: activeProjectId/watchRules/plans KV are only written when truthy", () => {
  const s = new JanusStore(":memory:"); s.init();
  // activeProjectId present but watchRules/plans absent
  migrateFromObjects(s, { ledger: { activeProjectId: "only-active", workspaces: {} } });
  assert.equal(s.getKV("activeProjectId"), "only-active");
  assert.strictEqual(s.getKV("watchRules"), null, "absent watchRules not written");
  assert.strictEqual(s.getKV("plans"), null, "absent plans not written");
  s.close();
});

// ── settings flattening + secrets exclusion ──
test("pin: settings are flattened (dot keys, JSON for non-strings) and secrets.* excluded", () => {
  const s = new JanusStore(":memory:"); s.init();
  const settings = {
    secrets: { geminiApiKey: "SECRET", nested: { deep: "x" } },
    advanced: { idleTimeoutMs: 1500, globalPermissionsMode: "Inherit" },
    topLevelString: "hello",
    arrayVal: [1, 2, 3],
    boolVal: true,
  };
  migrateFromObjects(s, { settings });

  // flattening: dotted keys
  assert.equal(s.getSettings("advanced.idleTimeoutMs"), "1500", "number serialized as string");
  assert.equal(s.getSettings("advanced.globalPermissionsMode"), "Inherit", "string left as-is");
  assert.equal(s.getSettings("topLevelString"), "hello", "top-level string as-is");
  // arrays are NOT recursed (treated as a value -> JSON.stringify)
  assert.equal(s.getSettings("arrayVal"), JSON.stringify([1, 2, 3]), "array serialized via JSON");
  assert.equal(s.getSettings("boolVal"), JSON.stringify(true), "bool serialized via JSON");

  // secrets.* excluded entirely
  assert.strictEqual(s.getSettings("secrets.geminiApiKey"), null, "secrets.* never imported");
  assert.strictEqual(s.getSettings("secrets.nested.deep"), null, "nested secrets.* never imported");
  s.close();
});

// the literal top-level "secrets" key (if it flattened to a leaf) is also excluded
test("pin: a leaf key exactly named 'secrets' is excluded", () => {
  const s = new JanusStore(":memory:"); s.init();
  // 'secrets' as a primitive leaf (k === "secrets" branch)
  migrateFromObjects(s, { settings: { secrets: "raw-leaf-secret", keep: "yes" } });
  assert.strictEqual(s.getSettings("secrets"), null, "leaf 'secrets' excluded");
  assert.equal(s.getSettings("keep"), "yes");
  s.close();
});

// ── history fan-out: one event per entry, with field coalescing ──
test("pin: history imports one command_outcome event per entry, coalescing missing fields", () => {
  const s = new JanusStore(":memory:"); s.init();
  const history = {
    paneA: [
      { command: "cmd1", timestamp: 10, finalResponse: "resp1", output: "out1" },
      { command: "cmd2" }, // timestamp/finalResponse/output absent -> defaults (ts=now, summary="")
    ],
    paneB: [
      { command: "cmd3", timestamp: 20, finalResponse: "resp3", output: "out3" },
    ],
  };
  migrateFromObjects(s, { history });

  const a = s.getEvents({ paneId: "paneA", type: "command_outcome" });
  assert.strictEqual(a.length, 2, "two events for paneA");
  const b = s.getEvents({ paneId: "paneB", type: "command_outcome" });
  assert.strictEqual(b.length, 1, "one event for paneB");

  // entry with explicit fields
  const e1 = a.find(e => e.ts === 10);
  assert.ok(e1, "explicit-timestamp event present");
  assert.equal(e1!.summary, "resp1", "finalResponse -> summary");

  // entry with defaults: finalResponse absent -> summary ""
  const e2 = a.find(e => e.summary === "" && e.ts !== 10);
  assert.ok(e2, "defaulted event present with empty summary");

  s.close();
});

// ── markMigratedAt marker is written INSIDE the txn, only when provided ──
test("pin: markMigratedAt writes the marker inside the txn; absent opts leaves no marker", () => {
  const s1 = new JanusStore(":memory:"); s1.init();
  migrateFromObjects(s1, { ledger: { workspaces: {} } }); // no opts
  assert.strictEqual(s1.getKV(LEDGER_MIGRATED_KEY), null, "no marker without opts");
  s1.close();

  const s2 = new JanusStore(":memory:"); s2.init();
  migrateFromObjects(s2, { ledger: { workspaces: {} } }, { markMigratedAt: "2026-06-21T00:00:00.000Z" });
  assert.strictEqual(s2.getKV(LEDGER_MIGRATED_KEY), "2026-06-21T00:00:00.000Z", "marker written with opts");
  s2.close();
});

// ── atomicity: a mid-import throw rolls back EVERYTHING including the marker ──
test("pin: a NOT NULL violation mid-import rolls back all rows + the marker (single transaction)", () => {
  const s = new JanusStore(":memory:"); s.init();
  const input = {
    ledger: {
      workspaces: {
        good: { id: "good", name: "G", directory: "/g", summary: "", keyTerms: [], notes: ["n"], panes: {} },
        bad: {
          id: "bad", name: "B", directory: "/b", summary: "", keyTerms: [], notes: [],
          panes: { p: { pane_id: null, name: "x" } }, // NOT NULL violation
        },
      },
    },
  };
  assert.throws(() => migrateFromObjects(s, input, { markMigratedAt: "X" }), /NOT NULL|constraint/i);
  assert.strictEqual(Object.keys(s.getWorkspaces()).length, 0, "all workspaces rolled back");
  assert.strictEqual(s.getEvents({}).length, 0, "all events rolled back");
  assert.strictEqual(s.getKV(LEDGER_MIGRATED_KEY), null, "marker rolled back too");
  s.close();
});

// ── idempotency at the object level: running the SAME import twice ──
// migrateFromObjects has no internal gate (that lives in migrateOnBootIfNeeded);
// pin its CURRENT behavior on a second run: workspaces/panes upsert (no dup),
// notes/events append (so they accumulate), KVs/settings overwrite.
test("pin: running migrateFromObjects twice — upserts dedupe workspaces/panes; notes+events accumulate", () => {
  const s = new JanusStore(":memory:"); s.init();
  const input = {
    ledger: {
      activeProjectId: "p1",
      workspaces: {
        w: {
          id: "w", name: "W", directory: "/w", summary: "s", keyTerms: ["k"],
          notes: ["wn"],
          panes: { t: { pane_id: "t", name: "T", notes: ["pn"] } },
        },
      },
    },
    settings: { advanced: { x: 1 } },
    history: { t: [{ command: "c", timestamp: 1, finalResponse: "r", output: "o" }] },
  };
  migrateFromObjects(s, input);
  migrateFromObjects(s, input);

  // workspaces/panes are keyed by id -> still exactly one each (upsert semantics)
  assert.strictEqual(Object.keys(s.getWorkspaces()).length, 1, "workspace deduped by id");
  assert.strictEqual(Object.keys(s.getPanes("w")).length, 1, "pane deduped by id");

  // notes append -> doubled
  const notes = s.getNotes({ projectId: "w" });
  assert.strictEqual(notes.filter(n => n.text === "wn").length, 2, "workspace note appended twice");
  assert.strictEqual(notes.filter(n => n.text === "pn").length, 2, "pane note appended twice");

  // events append -> history events + marker events doubled
  const paneEvents = s.getEvents({ paneId: "t", type: "command_outcome" });
  assert.strictEqual(paneEvents.length, 2, "history event appended twice");
  const allEvents = s.getEvents({ type: "command_outcome" });
  // 2 history (paneId t) + 2 marker (no pane) = 4
  assert.strictEqual(allEvents.length, 4, "history + marker events accumulate across runs");

  // KV overwrite (idempotent value)
  assert.equal(s.getKV("activeProjectId"), "p1");
  // settings overwrite (idempotent value)
  assert.equal(s.getSettings("advanced.x"), "1");

  s.close();
});
