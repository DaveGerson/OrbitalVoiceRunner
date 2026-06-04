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
// REPRESENTATIVE SET (registry-spec §8.5 #21):
//   list_panes, get_pane_summary,
//   propose_command.Auto  (gate Auto  -> auto_execute / runs),
//   propose_command.Ask   (gate Ask   -> pending_approval),
//   propose_command.Off   (gate Off   -> capability_forbidden / blocked),
//   deliver_handoff.pending (HiTL path -> status:pending_approval),
//   stop_all / confirm_stop_all / release_stop_all (the emergency-brake trio).

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
    }
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
