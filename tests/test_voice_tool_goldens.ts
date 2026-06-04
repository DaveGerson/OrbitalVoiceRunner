// ============================================================================
// REG1 NO-BEHAVIOR-CHANGE ORACLE (registry-spec §8.5 #21).
// ============================================================================
//
// This suite captures CHARACTERIZATION GOLDENS of the CURRENT (un-refactored)
// voice-tool dispatch. After the upcoming REG1 registry refactor swaps the giant
// `if (name === "...")` dispatch chain in server.ts for a tool registry, THIS
// SAME TEST MUST STILL PASS — that is the proof the migrated tools reproduce
// today's EXACT sendToolResponse payloads, byte-for-byte (modulo volatile fields).
//
// HOW IT WORKS
//   - Boots the real server headless via the mock-live harness (no Gemini key, no
//     mic), exactly like tests/test_voice_tools.ts / test_stop_all_two_stage.ts.
//   - Re-drives each representative tool against the CURRENT onmessage dispatch.
//   - Normalizes volatile fields (generated ids, timestamps, elapsed-ms, tokens)
//     to stable placeholders via a recursive normalizer.
//   - Asserts deep-equality of the normalized payload vs. the committed fixture
//     tests/fixtures/voice-tool-goldens.json.
//
//  ⚠️  IF A FUTURE CHANGE TO A TOOL RESPONSE IS INTENTIONAL, you must update the
//      fixture DELIBERATELY (delete the key or set JANUS_GOLDEN_REWRITE=1 to
//      regenerate, then review the diff). An ACCIDENTAL change is exactly what
//      this oracle exists to catch — do NOT blindly rewrite the fixture to make
//      a red test green.
//
// REPRESENTATIVE SET (registry-spec §8.5 #21) — the ORIGINAL 9:
//   list_panes, get_pane_summary,
//   propose_command.Auto  (gate Auto  -> auto_execute / runs),
//   propose_command.Ask   (gate Ask   -> pending_approval),
//   propose_command.Off   (gate Off   -> capability_forbidden / blocked),
//   deliver_handoff.pending (HiTL path -> status:pending_approval),
//   stop_all / confirm_stop_all / release_stop_all (the emergency-brake trio).
//
// WIDENED SET (added to strengthen the no-behavior-change proof — pure reads,
// deterministic metadata, and Auto/Ask/Off gate-disposition cases that need no real
// PTY / external binary / network):
//   Reads:   get_pane_delta, get_pane_command_history, list_pending_approvals (empty),
//            get_attention_digest (empty), get_pane_gates, list_capabilities,
//            get_project_notes, search_notes, list_handoffs, read_handoff,
//            switch_context (project briefing).
//   Mutators (deterministic output template + gate disposition):
//            create_project, rename_project, rename_pane, add_project_note,
//            add_pane_note, amend_note, delete_note, set_voice_mute, dismiss_attention,
//            set_global_permissions (Ask->deferred), set_pane_permissions (Ask->deferred),
//            set_capability_gate (tighten Auto->Ask + refuse-loosen).
//
// SKIPPED (cannot be made deterministic through this headless harness — see report):
//   create_pane (covered by tests/test_action_create_pane.ts; rides gateOrDefer);
//   execute_plan / apply_orchestration_recipe (spawn real panes via dispatchProposal);
//   propose_handoff / revise_handoff / stage_handoff / reject_handoff (success output
//     embeds a freshly generated handoff_<ts>_<rand> id as a bare SUBSTRING the shared
//     normalizer cannot stabilize — only their pending/error edges are pinned indirectly
//     via deliver_handoff.pending + read_handoff/list_handoffs error rows);
//   create_orchestrator_plan (output is fine but the plan id leaks into plans state and
//     the deterministic value-add is marginal); update_draft_prompt / switch_active_pane
//     (focus/draft side effects already exercised by sibling suites + setActivePane()).

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocket } from "ws";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(HERE, "fixtures", "voice-tool-goldens.json");
// Set JANUS_GOLDEN_REWRITE=1 to regenerate the fixture from current behavior
// (deliberate, reviewed updates only — see the warning at the top of this file).
const REWRITE = process.env.JANUS_GOLDEN_REWRITE === "1";

// ── Stub pane ────────────────────────────────────────────────────────────────
// Stand-in for a UniversalTerminal, covering the surface listPanes/getPaneSummary/
// stopAll/dispatchProposal touch. We never spawn a real ConPTY (Windows node-pty
// instability under the unit runner — same rationale as the sibling suites). Every
// field consumed by manager.syncLedger() is set to a STABLE value so list_panes is
// deterministic; the only volatile outputs (timestamps / elapsed_ms) are normalized.
class StubTerminal {
  status: "Running" | "Exited" | "Idle";
  lastCommand = "stub-last-command";
  writeInputCount = 0;
  stopCount = 0;
  // syncLedger() reads all of these:
  projectId = "gold_proj";
  cwd = "/stub/cwd";
  runtimeType: "interactive_cli" | "shell" = "interactive_cli";
  permissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only" = "Human-in-the-Loop";
  toolPreset = "Claude Code";
  sessionId = "stub-session";
  contextSize = 0;
  lastStatusChangeAt = 1_700_000_000_000; // fixed epoch; elapsed_ms is normalized anyway
  constructor(public terminalId: string, status: "Running" | "Exited" | "Idle" = "Running") {
    this.status = status;
  }
  writeInput(command: string) {
    this.lastCommand = command;
    this.writeInputCount++;
    if (this.status !== "Exited") this.status = "Running";
  }
  // getPaneSummary reads the LAST `limit` output lines.
  getRecentOutput(_lines = 10): string {
    return "stub output line A\nstub output line B";
  }
  // getPaneDelta pulls only-new lines via consumeDelta(); a fresh stub has a stable
  // single-shot delta. We return a fixed payload then mark the cursor consumed so a
  // second read would be empty — the golden captures only the FIRST read.
  private deltaConsumed = false;
  consumeDelta(): { lines: string; dropped: number } {
    if (this.deltaConsumed) return { lines: "", dropped: 0 };
    this.deltaConsumed = true;
    return { lines: "stub delta line 1\nstub delta line 2", dropped: 0 };
  }
  setPermissionsMode(mode: "Full Auto" | "Human-in-the-Loop" | "Read-Only") { this.permissionsMode = mode; }
  async stop() { this.stopCount++; this.status = "Exited"; }
}

// ── Recursive normalizer ──────────────────────────────────────────────────────
// Replaces volatile fields with stable placeholders so the golden is deterministic
// across runs. We normalize BY KEY (ids/timestamps/elapsed/tokens) and BY VALUE
// SHAPE (ISO timestamps, epoch-ms numbers in known fields). Structure + stable text
// (status, kind, spoken `output`, `prompt`) is preserved — that is the contract.
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
// Keys whose VALUE is a generated id / timestamp / elapsed measure.
const ID_KEYS = new Set(["messageId", "actionId", "handoff_id", "session_id", "sessionId", "id", "gate_approval_id"]);
const TS_KEYS = new Set(["timestamp", "captured_at", "created_at", "last_status_change_at", "staged_at", "lastStatusChangeAt"]);
const MS_KEYS = new Set(["elapsed_ms", "ageSeconds", "age_seconds", "staged_age_seconds"]);

function normalize(value: any): any {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(value).sort()) {
      const v = value[k];
      // Drop `undefined`-valued keys: JSON.stringify cannot represent them, so the persisted
      // fixture never carries them. Dropping on capture keeps deepStrictEqual symmetric across
      // the write→read round-trip (an explicit `key: undefined` would otherwise diverge from a
      // missing key). `null` is preserved (JSON-representable, a real contract value).
      if (v === undefined) continue;
      if (v === null) { out[k] = null; continue; }
      if (ID_KEYS.has(k) && typeof v === "string") { out[k] = "<ID>"; continue; }
      if (TS_KEYS.has(k)) { out[k] = "<TS>"; continue; }
      if (MS_KEYS.has(k)) { out[k] = "<MS>"; continue; }
      out[k] = normalize(v);
    }
    return out;
  }
  if (typeof value === "string") {
    // ISO timestamp embedded as a bare string value.
    if (ISO_RE.test(value)) return "<TS>";
    return value;
  }
  return value;
}

describe("REG1 voice-tool dispatch goldens (no-behavior-change oracle)", () => {
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
  // Snapshots of mutable global state this suite touches, restored in after() so the
  // suite leaves no global drift behind (mirrors the capabilityGates cleanup already there).
  let prevMicMuted: boolean | undefined;
  let prevActiveContext: string | undefined;
  let prevActiveProjectId: string | null | undefined;

  // Accumulated captures, keyed by stable label. Written to / compared against the fixture.
  const captured: Record<string, any> = {};
  let fixture: Record<string, any> = {};

  const api = (pathname: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${base}${pathname}`, {
      ...init,
      headers: { "x-api-token": apiToken, "content-type": "application/json", ...(init.headers || {}) },
    });

  function addPane(paneId: string, status: "Running" | "Exited" | "Idle" = "Running"): StubTerminal {
    const t = new StubTerminal(paneId, status);
    (running.manager.terminals as any)[paneId] = t;
    return t;
  }
  function clearPanes() {
    for (const id of Object.keys(running.manager.terminals)) {
      delete (running.manager.terminals as any)[id];
    }
  }
  // Make `paneId` the single active pane (the source of truth for propose_command /
  // deliver_handoff writes). The real UI sends a `set_active_pane` WS frame, but that is
  // async and races an immediately-following tool call; the voice `switch_active_pane`
  // tool sets `activePaneId` SYNCHRONOUSLY inside the same dispatch and answers when done,
  // so awaiting its response guarantees the active pane is set before the next call.
  async function setActivePane(paneId: string): Promise<void> {
    const call = session.emitToolCall("switch_active_pane", { pane_id: paneId });
    await waitFor(() => mock.responseFor(call));
  }
  function clearActivePane() {
    client.send(JSON.stringify({ type: "set_active_pane", paneId: null }));
  }
  async function releaseFreeze() {
    try { await api("/api/stop-all/release", { method: "POST" }); } catch {}
  }

  // Read the FULL functionResponse.response object for a callId across all sessions.
  // mock.responseFor() only returns `.response.output`, but the contract REG1 must preserve
  // includes the non-`output` payloads too: propose_command/deliver_handoff answer pending &
  // blocked with { status, messageId, pane_id, prompt } and NO `output` field. We capture the
  // whole `response` object so the golden pins those status/prompt fields, not just `output`.
  function rawResponseFor(callId: string): any | undefined {
    for (let s = mock.sessions.length - 1; s >= 0; s--) {
      const resps = mock.sessions[s].responses;
      for (let r = resps.length - 1; r >= 0; r--) {
        const fr = resps[r]?.functionResponses?.[0];
        if (fr?.id === callId) return { __captured: true, response: fr.response };
      }
    }
    return undefined;
  }

  // Drive a voice tool and capture the normalized FULL response payload under `label`.
  async function captureTool(label: string, name: string, args: Record<string, any> = {}): Promise<any> {
    const callId = session.emitToolCall(name, args);
    const wrapped = await waitFor(() => rawResponseFor(callId));
    captured[label] = normalize(wrapped.response);
    return wrapped.response;
  }

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-gold-"));
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

    // Snapshot mutable globals the suite mutates, for restoration in after().
    prevMicMuted = running.manager.settings.voiceAi?.isMicMuted;
    prevActiveContext = running.manager.settings.projects?.activeContext;
    prevActiveProjectId = running.manager.ledger.activeProjectId;

    fixture = fs.existsSync(FIXTURE_PATH)
      ? JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"))
      : {};
  });

  after(async () => {
    await releaseFreeze();
    clearActivePane();
    clearPanes();
    // Revert any gate mutations this suite made so it leaves no global state behind.
    if (running.manager.settings.advanced.capabilityGates) {
      delete (running.manager.settings.advanced.capabilityGates as any).write_to_pane;
      // set_capability_gate(global) tightened update_metadata Auto->Ask; drop the override.
      delete (running.manager.settings.advanced.capabilityGates as any).update_metadata;
    }
    // Restore mute + active-context drift from set_voice_mute / switch_context.
    if (running.manager.settings.voiceAi && prevMicMuted !== undefined) {
      running.manager.settings.voiceAi.isMicMuted = prevMicMuted;
    }
    if (running.manager.settings.projects && prevActiveContext !== undefined) {
      running.manager.settings.projects.activeContext = prevActiveContext;
    }
    if (prevActiveProjectId !== undefined) {
      running.manager.ledger.activeProjectId = prevActiveProjectId;
    }
    try { running.manager.saveSettings(); } catch {}
    if (client && client.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        client.once("close", () => resolve());
        try { client.terminate(); } catch { resolve(); }
      });
    }
    // If rewriting, persist the freshly-captured goldens (deliberate, reviewed only).
    // Sort top-level label keys for a stable diff WITHOUT an allowlist replacer (a bare
    // key array as the 2nd arg would strip every NESTED key not in the array).
    if (REWRITE) {
      const sorted: Record<string, any> = {};
      for (const k of Object.keys(captured).sort()) sorted[k] = captured[k];
      fs.writeFileSync(FIXTURE_PATH, JSON.stringify(sorted, null, 2) + "\n");
    }
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // Assert a captured label deep-equals the committed golden (unless rewriting).
  function assertGolden(label: string) {
    if (REWRITE) return; // rewrite mode: capture only, no assertion
    assert.ok(
      Object.prototype.hasOwnProperty.call(fixture, label),
      `fixture is missing golden "${label}" — run with JANUS_GOLDEN_REWRITE=1 to (re)generate it deliberately`,
    );
    assert.deepStrictEqual(
      captured[label],
      fixture[label],
      `voice-tool golden "${label}" diverged from the committed fixture. If this change is INTENTIONAL, update tests/fixtures/voice-tool-goldens.json deliberately (JANUS_GOLDEN_REWRITE=1) and review the diff.`,
    );
  }

  // ── Read tools ───────────────────────────────────────────────────────────────
  it("list_panes", async () => {
    clearPanes();
    addPane("gold-list");
    await captureTool("list_panes", "list_panes");
    assertGolden("list_panes");
  });

  it("get_pane_summary", async () => {
    clearPanes();
    addPane("gold-summary");
    await captureTool("get_pane_summary", "get_pane_summary", { pane_id: "gold-summary" });
    assertGolden("get_pane_summary");
  });

  it("get_pane_summary.missing (error path)", async () => {
    clearPanes();
    // No pane registered -> manager.getPaneSummary returns the stable error string.
    await captureTool("get_pane_summary.missing", "get_pane_summary", { pane_id: "no-such-pane" });
    assertGolden("get_pane_summary.missing");
  });

  it("get_pane_delta", async () => {
    clearPanes();
    addPane("gold-delta"); // StubTerminal.consumeDelta() yields a fixed first-read delta
    await captureTool("get_pane_delta", "get_pane_delta", { pane_id: "gold-delta" });
    assertGolden("get_pane_delta");
  });

  it("get_pane_command_history (empty for an un-run pane)", async () => {
    clearPanes();
    addPane("gold-hist");
    // Fresh tmpdir cwd => no .janus_history.json => loadHistory() returns [].
    await captureTool("get_pane_command_history", "get_pane_command_history", { pane_id: "gold-hist" });
    assertGolden("get_pane_command_history");
  });

  // EMPTY-state reads. These MUST run before any propose_command/deliver test leaves a
  // pending approval in the session, so the digest/queue are genuinely empty.
  it("list_pending_approvals (empty)", async () => {
    await captureTool("list_pending_approvals", "list_pending_approvals");
    assertGolden("list_pending_approvals");
  });

  it("get_attention_digest (empty)", async () => {
    // No attention items + no pending approvals yet -> the single stable "nothing" string.
    await captureTool("get_attention_digest", "get_attention_digest");
    assertGolden("get_attention_digest");
  });

  // ── Capability-matrix reads (UNGATED) ─────────────────────────────────────────
  it("list_capabilities", async () => {
    await captureTool("list_capabilities", "list_capabilities");
    assertGolden("list_capabilities");
  });

  it("get_pane_gates (global, no pane)", async () => {
    // pane_id omitted -> resolves the GLOBAL effective gate for every capability (defaults).
    await captureTool("get_pane_gates", "get_pane_gates");
    assertGolden("get_pane_gates");
  });

  // ── Notes reads + writes (each owns an ISOLATED project to keep counts deterministic) ──
  it("add_project_note", async () => {
    registerPaneInProject("gold_notes_proj", "gold-notes-pane");
    await captureTool("add_project_note", "add_project_note", {
      project_id: "gold_notes_proj", note: "golden project note alpha",
    });
    assertGolden("add_project_note");
  });

  it("add_project_note.missing (project not found)", async () => {
    await captureTool("add_project_note.missing", "add_project_note", {
      project_id: "no-such-project", note: "orphan note",
    });
    assertGolden("add_project_note.missing");
  });

  it("add_pane_note", async () => {
    registerPaneInProject("gold_panenote_proj", "gold-panenote-pane");
    await captureTool("add_pane_note", "add_pane_note", {
      project_id: "gold_panenote_proj", pane_id: "gold-panenote-pane", note: "golden pane note beta",
    });
    assertGolden("add_pane_note");
  });

  it("get_project_notes (exactly one note -> deterministic)", async () => {
    // Dedicated project with a SINGLE note so count + ordering are stable; the volatile
    // id/created_at are normalized to <ID>/<TS> by the shared normalizer.
    registerPaneInProject("gold_getnotes_proj", "gold-getnotes-pane");
    const add = session.emitToolCall("add_project_note", { project_id: "gold_getnotes_proj", note: "recall me later" });
    await waitFor(() => mock.responseFor(add));
    await captureTool("get_project_notes", "get_project_notes", { project_id: "gold_getnotes_proj" });
    assertGolden("get_project_notes");
  });

  it("search_notes (single FTS hit -> deterministic)", async () => {
    registerPaneInProject("gold_search_proj", "gold-search-pane");
    running.manager.ledger.activeProjectId = "gold_search_proj";
    const add = session.emitToolCall("add_project_note", { project_id: "gold_search_proj", note: "uniquetokenxyzzy appears once" });
    await waitFor(() => mock.responseFor(add));
    await captureTool("search_notes", "search_notes", { query: "uniquetokenxyzzy" });
    assertGolden("search_notes");
  });

  it("amend_note (Auto disposition, fixed echoed id)", async () => {
    // update_metadata gate defaults Auto -> applies now. The handler ECHOES the supplied
    // note_id verbatim (no existence check), so a LITERAL id keeps the output deterministic.
    await captureTool("amend_note", "amend_note", { note_id: "gold-fixed-note-id", text: "amended text" });
    assertGolden("amend_note");
  });

  it("delete_note (Auto disposition, fixed echoed id)", async () => {
    await captureTool("delete_note", "delete_note", { note_id: "gold-fixed-note-id" });
    assertGolden("delete_note");
  });

  // ── Project / pane metadata mutators (deterministic string outputs) ────────────
  it("create_project", async () => {
    // directory omitted -> resolves to server cwd (the tmpdir); output is a fixed string
    // that carries NO directory, so it is deterministic regardless of the tmpdir path.
    await captureTool("create_project", "create_project", {
      project_id: "gold_created_proj", summary: "a freshly created project",
    });
    assertGolden("create_project");
  });

  it("create_project.bad_dir (rejected)", async () => {
    await captureTool("create_project.bad_dir", "create_project", {
      project_id: "gold_baddir_proj", directory: "/definitely/not/a/real/dir/xyzzy",
    });
    assertGolden("create_project.bad_dir");
  });

  it("rename_project", async () => {
    registerPaneInProject("gold_rename_proj", "gold-rename-pane");
    await captureTool("rename_project", "rename_project", { project_id: "gold_rename_proj", name: "Renamed Project" });
    assertGolden("rename_project");
  });

  it("rename_pane", async () => {
    registerPaneInProject("gold_renamepane_proj", "gold-renamepane-pane");
    await captureTool("rename_pane", "rename_pane", {
      project_id: "gold_renamepane_proj", pane_id: "gold-renamepane-pane", name: "Renamed Pane",
    });
    assertGolden("rename_pane");
  });

  // ── switch_context: project briefing (directory pinned to a STABLE string) ─────
  it("switch_context (project briefing)", async () => {
    // Register the project with a FIXED directory string so the briefing's `directory`
    // field is stable (mkdtemp paths are random per run). switch_context only READS it.
    if (!running.manager.ledger.getProject("gold_ctx_proj")) {
      running.manager.ledger.addProject("gold_ctx_proj", "/stable/ctx/dir", "context briefing summary", ["alpha", "beta"]);
    }
    await captureTool("switch_context", "switch_context", { project_id: "gold_ctx_proj" });
    assertGolden("switch_context");
  });

  // ── Voice mute + attention dismissal (Auto) ────────────────────────────────────
  it("set_voice_mute", async () => {
    await captureTool("set_voice_mute", "set_voice_mute", { muted: true });
    assertGolden("set_voice_mute");
  });

  it("dismiss_attention (empty queue -> all)", async () => {
    // Run before any attention item is enqueued -> "Dismissed all 0 pending attention items."
    await captureTool("dismiss_attention", "dismiss_attention");
    assertGolden("dismiss_attention");
  });

  // ── Capability self-gate (set_capability_gate): tighten + refuse-loosen ─────────
  it("set_capability_gate (tighten global Auto->Ask)", async () => {
    // update_metadata defaults Auto; tightening to Ask by voice is allowed and immediate.
    await captureTool("set_capability_gate.tighten", "set_capability_gate", {
      capability: "update_metadata", gate: "Ask",
    });
    assertGolden("set_capability_gate.tighten");
  });

  it("set_capability_gate (refuse loosen Ask->Auto)", async () => {
    // write_to_pane GLOBAL default is Ask; asking to LOOSEN it to Auto (no active pane,
    // so no spotlight) is refused by voice with the stable safety message.
    clearActivePane();
    await captureTool("set_capability_gate.refuse", "set_capability_gate", {
      capability: "write_to_pane", gate: "Auto",
    });
    assertGolden("set_capability_gate.refuse");
  });

  it("set_capability_gate (invalid gate)", async () => {
    await captureTool("set_capability_gate.invalid", "set_capability_gate", {
      capability: "write_to_pane", gate: "Bogus",
    });
    assertGolden("set_capability_gate.invalid");
  });

  // ── Permission mutators (default gate Ask -> DEFERRED disposition) ──────────────
  it("set_global_permissions (Ask -> deferred)", async () => {
    await captureTool("set_global_permissions", "set_global_permissions", { permissions_mode: "Full Auto" });
    assertGolden("set_global_permissions");
  });

  it("set_pane_permissions (Ask -> deferred)", async () => {
    registerPaneInProject("gold_perm_proj", "gold-perm-pane");
    await captureTool("set_pane_permissions", "set_pane_permissions", {
      project_id: "gold_perm_proj", pane_id: "gold-perm-pane", permissions_mode: "Read-Only",
    });
    assertGolden("set_pane_permissions");
  });

  it("set_pane_permissions.invalid_mode", async () => {
    registerPaneInProject("gold_perm2_proj", "gold-perm2-pane");
    await captureTool("set_pane_permissions.invalid_mode", "set_pane_permissions", {
      project_id: "gold_perm2_proj", pane_id: "gold-perm2-pane", permissions_mode: "Nonsense",
    });
    assertGolden("set_pane_permissions.invalid_mode");
  });

  // ── Handoff reads (UNGATED; error rows are deterministic) ──────────────────────
  it("list_handoffs (empty for a fresh active project)", async () => {
    // Make a brand-new project active with NO handoffs -> stable empty array.
    if (!running.manager.ledger.getProject("gold_handoffs_proj")) {
      running.manager.ledger.addProject("gold_handoffs_proj", "/stable/ho/dir", "handoffs project");
    }
    running.manager.ledger.activeProjectId = "gold_handoffs_proj";
    await captureTool("list_handoffs", "list_handoffs");
    assertGolden("list_handoffs");
  });

  it("read_handoff.missing (not found)", async () => {
    await captureTool("read_handoff.missing", "read_handoff", { handoff_id: "no-such-handoff" });
    assertGolden("read_handoff.missing");
  });

  // ── propose_command: the three gate dispositions ──────────────────────────────
  // propose_command can only target the ACTIVE pane (single-active-pane guard).
  // write_to_pane is a SPOTLIGHT capability, so on the active pane it resolves Auto via
  // the spotlight UNLESS an explicit per-pane override is set (rule 1 beats spotlight).
  //   Auto: spotlight Auto + Full-Auto pane mode -> auto_execute (the write runs).
  //   Ask:  explicit per-pane write_to_pane=Ask  -> pending_approval (HiTL).
  //   Off:  explicit per-pane write_to_pane=Off  -> capability_forbidden (blocked).
  //
  // The per-pane override MUST be PERSISTED (the SQLite ledger hands out read-only
  // snapshots; a bare snapshot mutation is dropped). We persist it the real way: register
  // the pane in the active project, then TIGHTEN the gate via the set_capability_gate
  // VOICE tool (Auto->Ask / Auto->Off tightening is allowed by voice; it calls updatePane
  // which writes the capability_gates column). This is also why we DON'T set the gate
  // through the global matrix: the spotlight loosens the active pane back to Auto, so only
  // an explicit per-pane override actually lands.
  const GOLD_PROJ = "gold_proj"; // matches StubTerminal.projectId so syncLedger files panes here

  function registerLedgerPane(paneId: string) {
    running.manager.ledger.activeProjectId = GOLD_PROJ;
    if (!running.manager.ledger.getProject(GOLD_PROJ)) {
      running.manager.ledger.addProject(GOLD_PROJ, "/stub/cwd", "golden fixture project");
    }
    running.manager.ledger.updatePane(GOLD_PROJ, {
      pane_id: paneId, name: paneId, runtime_type: "interactive_cli",
      last_known_state: "Running active command", is_busy: true, alive: true,
      notes: [], permissions_mode: "Human-in-the-Loop", session_id: "stub-session",
      tool_preset: "Claude Code", context_size: 0,
    } as any, true);
  }
  // Register a ledger pane under an ARBITRARY project + make that project active. Used by the
  // note / rename / permission cases so each owns an isolated project (no note-count cross-talk).
  // Pane fields mirror registerLedgerPane so the row is stable; we DON'T narrate this pane (it is
  // never list_panes-captured), so volatile-looking fields here never reach a golden.
  function registerPaneInProject(projectId: string, paneId: string, dir = "/stub/cwd") {
    if (!running.manager.ledger.getProject(projectId)) {
      running.manager.ledger.addProject(projectId, dir, `${projectId} fixture project`);
    }
    running.manager.ledger.activeProjectId = projectId;
    running.manager.ledger.updatePane(projectId, {
      pane_id: paneId, name: paneId, runtime_type: "interactive_cli",
      last_known_state: "Running active command", is_busy: true, alive: true,
      notes: [], permissions_mode: "Human-in-the-Loop", session_id: "stub-session",
      tool_preset: "Claude Code", context_size: 0,
    } as any, true);
  }
  // Tighten a per-pane gate via the VOICE tool so it persists to the ledger.
  async function tightenPaneGate(paneId: string, gate: "Ask" | "Off") {
    const call = session.emitToolCall("set_capability_gate", { pane_id: paneId, capability: "write_to_pane", gate });
    await waitFor(() => mock.responseFor(call));
  }
  function dropLedgerPane(paneId: string) {
    // Best-effort cleanup: LedgerLike exposes no pane-removal method, so drop the
    // pane from the in-memory workspace snapshot directly. (For the SQLite backend
    // the snapshot is read-only and this won't persist — harmless, since list_panes
    // is captured FIRST, before any ledger pane is registered.)
    const proj = running.manager.ledger.getProject(GOLD_PROJ);
    if (proj && proj.panes[paneId]) {
      try { delete proj.panes[paneId]; } catch {}
    }
  }

  it("propose_command.Auto -> auto_execute (runs)", async () => {
    clearPanes();
    const t = addPane("gold-auto");
    t.permissionsMode = "Full Auto"; // effectiveMode Full Auto + spotlight Auto -> auto_execute
    await setActivePane("gold-auto");
    await captureTool("propose_command.Auto", "propose_command", {
      pane_id: "gold-auto",
      instruction: "echo hello",
    });
    assertGolden("propose_command.Auto");
    clearActivePane();
  });

  it("propose_command.Ask -> pending_approval", async () => {
    clearPanes();
    addPane("gold-ask");
    registerLedgerPane("gold-ask");
    await setActivePane("gold-ask");
    await tightenPaneGate("gold-ask", "Ask"); // explicit per-pane override beats the spotlight
    await captureTool("propose_command.Ask", "propose_command", {
      pane_id: "gold-ask",
      instruction: "echo needs-approval",
    });
    assertGolden("propose_command.Ask");
    clearActivePane();
    dropLedgerPane("gold-ask");
  });

  it("propose_command.Off -> capability_forbidden (blocked)", async () => {
    clearPanes();
    addPane("gold-off");
    registerLedgerPane("gold-off");
    await setActivePane("gold-off");
    await tightenPaneGate("gold-off", "Off"); // explicit per-pane override beats the spotlight
    await captureTool("propose_command.Off", "propose_command", {
      pane_id: "gold-off",
      instruction: "echo forbidden",
    });
    assertGolden("propose_command.Off");
    clearActivePane();
    dropLedgerPane("gold-off");
  });

  // ── deliver_handoff: the pending / HiTL path ──────────────────────────────────
  // Stage a real handoff in the store, make its target the active pane (HiTL mode),
  // then deliver. Spotlight gate=Auto + Human-in-the-Loop pane mode -> pending_approval
  // (the HiTL gate); the handler answers status:"pending_approval".
  it("deliver_handoff.pending (HiTL path)", async () => {
    clearPanes();
    const t = addPane("gold-handoff-target");
    t.permissionsMode = "Human-in-the-Loop";
    await setActivePane("gold-handoff-target");

    const store: any = (running.manager as any).ledger; // default SQLite backend exposes handoff API via server's `store`
    // Create + stage via the voice tools (the documented path), then deliver.
    const compose = session.emitToolCall("propose_handoff", {
      to_pane: "gold-handoff-target",
      draft_text: "Please continue the build and report status.",
      rationale: "phase handoff",
    });
    const composed: any = await waitFor(() => mock.responseFor(compose));
    const handoffId = composed?.handoff_id;
    assert.ok(handoffId, `propose_handoff returned a handoff_id (got: ${JSON.stringify(composed)})`);

    const stage = session.emitToolCall("stage_handoff", { handoff_id: handoffId });
    await waitFor(() => mock.responseFor(stage));

    await captureTool("deliver_handoff.pending", "deliver_handoff", { handoff_id: handoffId });
    assertGolden("deliver_handoff.pending");

    clearActivePane();
    // Reject the pending delivery so no state leaks.
    try {
      const rej = session.emitToolCall("reject_handoff", { handoff_id: handoffId });
      await waitFor(() => mock.responseFor(rej));
    } catch {}
    void store;
  });

  // ── Emergency-brake trio ──────────────────────────────────────────────────────
  it("stop_all (Stage 1 freeze)", async () => {
    clearPanes();
    addPane("gold-stop-a");
    addPane("gold-stop-b");
    await captureTool("stop_all", "stop_all");
    assertGolden("stop_all");
    await releaseFreeze();
  });

  it("confirm_stop_all (Stage 2 kill)", async () => {
    clearPanes();
    addPane("gold-confirm-a");
    const froze = session.emitToolCall("stop_all");
    await waitFor(() => mock.responseFor(froze));
    await captureTool("confirm_stop_all", "confirm_stop_all");
    assertGolden("confirm_stop_all");
    await releaseFreeze();
  });

  it("release_stop_all (clear freeze)", async () => {
    clearPanes();
    const froze = session.emitToolCall("stop_all");
    await waitFor(() => mock.responseFor(froze));
    await captureTool("release_stop_all", "release_stop_all");
    assertGolden("release_stop_all");
  });
});
