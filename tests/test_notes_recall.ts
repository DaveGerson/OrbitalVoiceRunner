// Notes-recall voice-tool suite (bead bjm / WS-I).
//
// Surfaces the already-shipped SQLite notes CRUD+FTS5 as Gemini Live tools and pins the
// four gut-check MUST-FIX invariants (bd remember key `bjm-required-changes`):
//   (1) REDACTION quarantine — every snippet a voice handler hands the model is redactSecrets'd
//       (model-egress guard); the id-bearing GET feed is DOM-render-only and may stay raw.
//   (2) search_notes — store.search() returns note AND event rows; the handler FILTERS to
//       note-only AND redacts every returned snippet (secret-bearing note + matching event =>
//       event excluded, snippet [REDACTED]).
//   (3) delete_note/amend_note — route through gateOrDefer('update_metadata'); the store mutation
//       runs only inside the gated `run` closure; the amend text is bound at enqueue time
//       (Off = no change, Ask = applies the correct bound text on confirm, Auto = applies now).
//   (4) add_pane_note — pane_id defaults to the server-tracked activePaneId; when there is no
//       active pane it writes NOTHING and reports "no pane open".
//
// Boots the REAL server headless via the ce7 harness (no API key, no mic): JANUS_NO_AUTOSTART=1,
// installMockLive() swaps the injectable liveConnector, startServer({port:0}). Owns its own boot
// scaffolding (ce7's test_live_harness keeps fixtures local; we don't depend on them).

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

describe("bjm notes-recall voice tools (headless, no API key, no mic)", () => {
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

  const PROJECT = "p_notes";

  const api = (pathname: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${pathname}`, {
      ...init,
      headers: { "x-api-token": apiToken, "content-type": "application/json", ...(init.headers || {}) },
    });

  // Direct store access for arrange/assert (LedgerLike doesn't surface savePane; cast through).
  const store = () => running.manager.ledger as any;

  // Seed a pane ROW (panes table) so addPaneNote's existence check passes. INSERT-based, so guard
  // against a duplicate seed across tests.
  function seedPane(paneId: string) {
    try {
      store().savePane({
        pane_id: paneId, workspace_id: PROJECT, name: paneId, runtime_type: "claude",
        tool_preset: "Claude Code", permissions_mode: "Human-in-the-Loop", session_id: "",
        last_known_state: "Running", is_busy: false, alive: true, context_size: 0,
        last_status_change_at: null, last_command: null, scrollback_path: null,
        created_at: Date.now(), updated_at: Date.now(),
      });
    } catch { /* already seeded */ }
  }

  // Set the global capability gate the gated note handlers read; pass null to clear.
  function setUpdateMetadataGate(value: "Auto" | "Ask" | "Off" | null) {
    const adv = (running.manager.settings.advanced ||= {} as any);
    adv.capabilityGates = adv.capabilityGates || {};
    if (value === null) delete (adv.capabilityGates as any).update_metadata;
    else (adv.capabilityGates as any).update_metadata = value;
  }

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-notes-"));
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

    // Arrange: a project that is the ACTIVE focus (so the handlers' active-project default resolves
    // to it) plus one pane row for the add_pane_note active-pane default test.
    await api("/api/projects", { method: "POST", body: JSON.stringify({ id: PROJECT, directory: ".", summary: "", keyTerms: [] }) });
    await api(`/api/projects/${PROJECT}/switch`, { method: "POST" });
    seedPane("pn-1");
  });

  after(async () => {
    setUpdateMetadataGate(null);
    if (client && client.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        client.once("close", () => resolve());
        try { client.terminate(); } catch { resolve(); }
      });
    }
    // Deterministic teardown: close server + global fetch pool, then drain libuv so
    // --test-force-exit can't abort on a half-closed async handle (src\win\async.c:76).
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // ── get_project_notes ─────────────────────────────────────────────────────────────────────
  describe("get_project_notes (read, redacted, no switch_context required)", () => {
    it("returns the project's notes without a prior switch_context call", async () => {
      await api(`/api/projects/${PROJECT}/notes`, { method: "POST", body: JSON.stringify({ note: "we DECIDED to ship the matrix" }) });

      // No switch_context emitted before this — recall must work standalone.
      const callId = session.emitToolCall("get_project_notes");
      const out: any = await waitFor(() => mock.responseFor(callId));

      assert.ok(out && Array.isArray(out.notes), `output carries a notes array: ${JSON.stringify(out)}`);
      assert.ok(out.notes.some((n: any) => /DECIDED to ship the matrix/.test(n.text)), "the decision note is present");
      assert.ok(out.notes.every((n: any) => typeof n.id === "string"), "every returned note carries its id");
    });

    it("MUST-FIX #1: redacts secrets in every returned note (model-egress guard)", async () => {
      await api(`/api/projects/${PROJECT}/notes`, { method: "POST", body: JSON.stringify({ note: "creds are password=supersecret123 do not lose" }) });

      const callId = session.emitToolCall("get_project_notes");
      const out: any = await waitFor(() => mock.responseFor(callId));
      const blob = JSON.stringify(out.notes);
      assert.ok(!blob.includes("supersecret123"), "raw secret never reaches the model");
      assert.ok(blob.includes("[REDACTED"), "the secret was replaced with a redaction marker");
    });
  });

  // ── search_notes ──────────────────────────────────────────────────────────────────────────
  describe("search_notes (FTS, note-only, redacted)", () => {
    it("MUST-FIX #2: a matching EVENT is excluded and the note snippet is redacted", async () => {
      // Adding a note ALSO records a NOTE_ADDED event whose summary mirrors the text, so an FTS
      // query on a distinctive token matches BOTH a note row and an event row.
      await api(`/api/projects/${PROJECT}/notes`, { method: "POST", body: JSON.stringify({ note: "FROBNICATE pipeline uses password=supersecret123" }) });

      // Prove the raw store surface really does return an event for this query...
      const raw = store().search("FROBNICATE", { limit: 25 }) as Array<{ source: string }>;
      assert.ok(raw.some((r) => r.source === "event"), "raw store.search returns at least one event row");
      const noteCount = raw.filter((r) => r.source === "note").length;
      assert.ok(noteCount >= 1, "raw store.search returns at least one note row");

      // ...then assert the voice handler dropped the events and redacted the note snippet.
      const callId = session.emitToolCall("search_notes", { query: "FROBNICATE" });
      const out: any = await waitFor(() => mock.responseFor(callId));
      assert.ok(out && Array.isArray(out.results), `output carries a results array: ${JSON.stringify(out)}`);
      assert.strictEqual(out.results.length, noteCount, "only note-source rows are returned (events excluded)");
      const blob = JSON.stringify(out.results);
      assert.ok(!blob.includes("supersecret123"), "snippet secret is redacted");
      assert.ok(blob.includes("[REDACTED"), "redaction marker present in snippet");
    });
  });

  // ── add_pane_note active-pane default (MUST-FIX #4) ─────────────────────────────────────────
  describe("add_pane_note active-pane default", () => {
    // Runs FIRST while activePaneId is still null (boot default; nothing has switched yet).
    it("MUST-FIX #4: with no active pane it writes nothing and says 'no pane'", async () => {
      const before = store().getNotes({ projectId: PROJECT, paneId: "pn-1" }).length;
      const callId = session.emitToolCall("add_pane_note", { note: "should not land anywhere" });
      const out: any = await waitFor(() => mock.responseFor(callId));
      assert.ok(/no pane|open a pane|no active pane/i.test(String(out)), `reports no pane open: ${out}`);
      const after = store().getNotes({ projectId: PROJECT, paneId: "pn-1" }).length;
      assert.strictEqual(after, before, "nothing was written when there is no active pane");
    });

    it("MUST-FIX #4: with an active pane and no pane_id arg, the note lands on the active pane", async () => {
      // switch_active_pane sets the server-tracked activePaneId and acks observably.
      const sw = session.emitToolCall("switch_active_pane", { pane_id: "pn-1" });
      await waitFor(() => mock.responseFor(sw));

      const callId = session.emitToolCall("add_pane_note", { note: "lands on the active pane" });
      const out: any = await waitFor(() => mock.responseFor(callId));
      assert.ok(/pn-1/.test(String(out)), `read-back names the active pane: ${out}`);
      const paneNotes = store().getNotes({ projectId: PROJECT, paneId: "pn-1" });
      assert.ok(paneNotes.some((n: any) => n.text === "lands on the active pane"), "note persisted on the active pane");
    });
  });

  // ── amend_note / delete_note gating (MUST-FIX #3) ───────────────────────────────────────────
  describe("amend_note + delete_note route through gateOrDefer('update_metadata')", () => {
    // Add a note and return its id via the id-bearing read surface.
    async function addNoteReturningId(text: string): Promise<string> {
      await api(`/api/projects/${PROJECT}/notes`, { method: "POST", body: JSON.stringify({ note: text }) });
      const notes = store().getNotes({ projectId: PROJECT }) as Array<{ id: string; text: string }>;
      const hit = notes.find((n) => n.text === text);
      assert.ok(hit, `seeded note '${text}' is retrievable`);
      return hit!.id;
    }

    it("MUST-FIX #3: amend_note is FORBIDDEN and changes nothing when update_metadata=Off", async () => {
      const id = await addNoteReturningId("amend-off original");
      setUpdateMetadataGate("Off");
      const callId = session.emitToolCall("amend_note", { note_id: id, text: "amend-off CHANGED" });
      const out: any = await waitFor(() => mock.responseFor(callId));
      assert.ok(/forbidden|gated off|policy/i.test(String(out)), `Off => forbidden read-back: ${out}`);
      const after = store().getNotes({ projectId: PROJECT }).find((n: any) => n.id === id);
      assert.strictEqual(after.text, "amend-off original", "Off applied no change");
      setUpdateMetadataGate(null);
    });

    it("MUST-FIX #3: amend_note applies immediately and durably when update_metadata=Auto", async () => {
      const id = await addNoteReturningId("amend-auto original");
      setUpdateMetadataGate("Auto");
      const callId = session.emitToolCall("amend_note", { note_id: id, text: "amend-auto CHANGED" });
      await waitFor(() => mock.responseFor(callId));
      const after = store().getNotes({ projectId: PROJECT }).find((n: any) => n.id === id);
      assert.strictEqual(after.text, "amend-auto CHANGED", "Auto applied the amend");
      setUpdateMetadataGate(null);
    });

    it("MUST-FIX #3: amend_note DEFERS under Ask and confirm applies the text bound at enqueue", async () => {
      const id = await addNoteReturningId("amend-ask original");
      setUpdateMetadataGate("Ask");
      const callId = session.emitToolCall("amend_note", { note_id: id, text: "amend-ask CONFIRMED" });
      const out: any = await waitFor(() => mock.responseFor(callId));
      assert.ok(/confirm/i.test(String(out)), `Ask => awaiting-confirm read-back: ${out}`);

      // Not applied yet (deferred).
      let cur = store().getNotes({ projectId: PROJECT }).find((n: any) => n.id === id);
      assert.strictEqual(cur.text, "amend-ask original", "Ask does not mutate before confirmation");

      // Confirm the staged action; the bound text must apply.
      const pending = await (await api("/api/actions/pending")).json();
      const action = pending.find((a: any) => a.summary.includes(id));
      assert.ok(action, `a pending action references note ${id}`);
      const conf = await (await api(`/api/actions/${action.id}/confirm`, { method: "POST" })).json();
      assert.strictEqual(conf.success, true, "confirm succeeded");

      cur = store().getNotes({ projectId: PROJECT }).find((n: any) => n.id === id);
      assert.strictEqual(cur.text, "amend-ask CONFIRMED", "confirm applied the text bound at enqueue time");
      setUpdateMetadataGate(null);
    });

    it("MUST-FIX #3: delete_note removes the note under Auto and the deletion is durable", async () => {
      const id = await addNoteReturningId("delete-me");
      setUpdateMetadataGate("Auto");
      const callId = session.emitToolCall("delete_note", { note_id: id });
      await waitFor(() => mock.responseFor(callId));
      const stillThere = store().getNotes({ projectId: PROJECT }).some((n: any) => n.id === id);
      assert.strictEqual(stillThere, false, "the note is gone after delete_note");
      setUpdateMetadataGate(null);
    });
  });

  // ── DOM-render-only REST feed + operator-direct controls ────────────────────────────────────
  describe("REST notes feed + UI controls (operator-direct, DOM-only)", () => {
    it("GET /api/projects/:id/notes returns id-bearing notes for the UI", async () => {
      await api(`/api/projects/${PROJECT}/notes`, { method: "POST", body: JSON.stringify({ note: "rest-feed note" }) });
      const res = await api(`/api/projects/${PROJECT}/notes`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.ok(Array.isArray(body.notes), "feed returns a notes array");
      assert.ok(body.notes.every((n: any) => typeof n.id === "string"), "every note carries an id for delete/amend controls");
      assert.ok(body.notes.some((n: any) => n.text === "rest-feed note"), "the new note is in the feed");
    });

    it("PUT /api/notes/:id amends and DELETE /api/notes/:id removes (operator-direct, ungated)", async () => {
      await api(`/api/projects/${PROJECT}/notes`, { method: "POST", body: JSON.stringify({ note: "ui original" }) });
      const id = store().getNotes({ projectId: PROJECT }).find((n: any) => n.text === "ui original").id;

      const put = await api(`/api/notes/${id}`, { method: "PUT", body: JSON.stringify({ text: "ui amended" }) });
      assert.strictEqual(put.status, 200);
      assert.strictEqual(store().getNotes({ projectId: PROJECT }).find((n: any) => n.id === id).text, "ui amended");

      const del = await api(`/api/notes/${id}`, { method: "DELETE" });
      assert.strictEqual(del.status, 200);
      assert.strictEqual(store().getNotes({ projectId: PROJECT }).some((n: any) => n.id === id), false);
    });
  });
});
