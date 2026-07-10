// tests/test_instruction_routing_journeys.ts
//
// Phase 3, Step 3.4 — the VOICE/TYPED CONVERGENCE + mock-live JOURNEY BATTERY for instruction
// routing (spec docs/superpowers/specs/2026-07-09-instruction-routing.md). This suite does NOT
// duplicate the exhaustive unit coverage that already exists:
//   - tests/test_instruction_envelope.ts — the readiness predicate, buildEnvelope normalization,
//     renderEnvelope determinism, draft-version bump, send idempotency (all PURE, no I/O).
//   - tests/test_target_resolver.ts — the FULL §3.2 decision table (exact/multiple/anaphora/
//     cross-project/fuzzy/floor-never-widens/exact-beats-ranker), pure, no I/O.
// Instead, this suite drives the REAL seams end-to-end: the six voice-verb ActionDefs
// (src/actions/defs/voice_ux.ts draft/revise/retarget/confirm/cancel/send_instruction), the
// per-pane draft registry (src/exchanges/draftRegistry.ts), the REAL capability-gate dispatch
// choke-point (src/dispatch/paneWrite.ts via ctx.dispatchProposal), and — for the reconnect
// journey — the REST GET draft route + WS draft_updated broadcast. It boots the REAL server
// headless (tests/helpers/mockLive.ts, the SAME idiom as tests/test_focus_journey.ts and
// tests/test_voice_tool_goldens.ts) with STUB terminals (no real PTY, deterministic — the SAME
// StubTerminal idiom test_voice_tool_goldens.ts uses) standing in for live panes.
//
// JANUS_INSTRUCTION_ENVELOPE is set to "primary" BEFORE the first import of anything touching
// src/exchanges/flag-style env modules in this process (mirrors tests/test_exchange_recovery.ts's
// documented pattern for JANUS_EXCHANGE_SPINE) — `node --test` runs each test FILE as its own
// process, so this frozen module-level value cannot leak into any other test file.
//
// ── Journey -> test mapping (see the final assistant report for the full table) ──────────────
//   1  exact target, silent bind, byte-exact delivery         -> describe "journey 1"
//   2  two ambiguous targets -> exactly one clarification     -> describe "journey 2"
//   3  missing referent -> clarify, no draft mutation         -> describe "journey 3"
//   4  cross-project retarget + gate re-eval (+ BUG)          -> describe "journey 4"
//   5  long dictation distilled then revised, no fabrication  -> describe "journey 5"
//   6  typed edit then voice edit, prose-override lifecycle   -> describe "journey 6"
//   7  old approval after draft edit (BUG: no CAS at all)     -> describe "journey 7"
//   8  explicit send idempotent per version (+ BUG edge case) -> describe "journey 8"
//   9  cancel clears draft + exchange                         -> describe "journey 9"
//   10 reconnect with draft recovery (REST GET path)          -> describe "journey 10"
//   11 adapter rendering: formatting-only + maxChars gap      -> describe "journey 11" (pure)
//
// ── BUGS FOUND (see the full writeup in the final report) ─────────────────────────────────────
//   BUG-A (journey 4): performRetarget (src/actions/defs/voice_ux.ts) moves the active PANE via
//     ctx.setActivePane but never advances manager.ledger.activeProjectId. activeDraftTarget()
//     (server.ts:1420-1423) derives its projectId SOLELY from manager.ledger.activeProjectId, so
//     after a confirmed CROSS-PROJECT retarget, activeDraftTarget() reports the OLD project with
//     the NEW pane id — a key that was never written to the draft registry. revise_instruction /
//     send_instruction / cancel_instruction on the retargeted draft all then report "no open
//     instruction draft", even though a real, ready draft exists under the correct key.
//   BUG-B (journey 7): sendInstruction's own draftVersion/sentVersions bookkeeping
//     (src/exchanges/instructionEnvelope.ts) is COMPLETELY DISCONNECTED from the durable approval
//     record staged by ctx.dispatchProposal (src/dispatch/paneWrite.ts applyPendingApproval /
//     src/gating/index.ts renderApproved). renderApproved delivers `record.instruction` VERBATIM
//     with no reference to any draft version — there is no CAS at all. Compounding this,
//     sendInstruction clears the open draft on a `pending` outcome (not just `executed`), so the
//     operator cannot even voice-revise the in-flight instruction before it is approved.
//   BUG-C (journey 8): recordSend() marks a draftVersion as "sent" BEFORE dispatchProposal's
//     outcome is known. A `blocked`/`clarify`/`error` outcome (e.g. a gate flipped to Off) still
//     locks that version into `sentVersions`, so retrying the SAME never-delivered instruction
//     after fixing the blocker is wrongly refused as "already sent — revise it before sending
//     again" — the operator must gratuitously mutate the draft just to retry.
//   BUG-D (journey 11): every RenderProfile carries `maxChars`, but renderEnvelope() never reads
//     it (no truncation) and send_instruction/assessReadiness never refuse an over-limit draft.
//     Spec §6.2's "over-limit REFUSES at send... never silent truncation" is unimplemented in
//     BOTH directions — there is neither a refusal nor a truncation; maxChars is a dead field.
//
// Runner: npx tsx --test --test-force-exit tests/test_instruction_routing_journeys.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";
import type { RenderPreset } from "../src/exchanges/instructionEnvelope";

// JANUS_INSTRUCTION_ENVELOPE must be set BEFORE the FIRST import (anywhere in this process) of
// anything that touches src/exchanges/instructionEnvelope.ts — its INSTRUCTION_ENVELOPE_MODE
// constant is frozen at module load (mirrors tests/test_exchange_recovery.ts's documented
// JANUS_EXCHANGE_SPINE pattern). Because ES module `import` statements are hoisted above ALL
// other top-level code (regardless of source order), the only static imports above are
// type-only (erased at compile time, no runtime module load) — everything that touches the
// REAL module (including the "pure" journey-11 helpers below, which run in the SAME process as
// the server-backed journeys and must see the same cached mode) is loaded dynamically, via
// top-level await, AFTER this assignment.
process.env.JANUS_INSTRUCTION_ENVELOPE = "primary";

const {
  buildEnvelope,
  createDraft,
  renderEnvelope,
  RENDER_PROFILES,
  COMPLETION_REQUEST_LINE,
} = await import("../src/exchanges/instructionEnvelope");
const {
  getOpenDraft,
  setOpenDraft,
  hasProseOverride,
  resetDraftRegistryForTests,
} = await import("../src/exchanges/draftRegistry");

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Journey 11 — adapter rendering (PURE; no server). Formatting-only equivalence across the four
// default profiles, and the maxChars dead-field gap (BUG-D).
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("journey 11: adapter rendering — formatting-only across presets; maxChars gap (pure)", () => {
  const envelope = buildEnvelope({
    objective: "fix the retry bug in the webhook handler",
    relevantContext: ["the last deploy regressed this"],
    constraints: ["keep the public API unchanged"],
    requestedOutput: "a one-line summary of the fix",
    completionSignal: "the retry test suite is green",
  });

  /** Undo ONLY the documented formatting knobs (spec §6.2: heading style / completion-envelope
   *  request / eol) so the remaining content can be compared byte-for-byte across presets. */
  function normalizeFormatting(rendered: string): string {
    let body = rendered.replace(/\r\n/g, "\n");
    // Strip the ONE permitted non-operator addition (spec §6.2) if present.
    const withoutCompletion = body.endsWith(`\n\n${COMPLETION_REQUEST_LINE}`)
      ? body.slice(0, -(`\n\n${COMPLETION_REQUEST_LINE}`.length))
      : body;
    // markdown heading -> plain heading.
    return withoutCompletion.replace(/^## Context$/m, "Context:").replace(/^## Constraints$/m, "Constraints:");
  }

  it("same envelope, four presets -> semantic content is byte-identical after normalizing ONLY the documented formatting knobs", () => {
    const presets: RenderPreset[] = ["Claude Code", "Codex", "Antigravity", "Custom"];
    const normalized = presets.map((p) => normalizeFormatting(renderEnvelope(envelope, RENDER_PROFILES[p])));
    for (let i = 1; i < normalized.length; i++) {
      assert.strictEqual(
        normalized[i],
        normalized[0],
        `preset '${presets[i]}' diverges from '${presets[0]}' after stripping heading-style/completion-envelope/eol — a profile changed CONTENT, not just formatting`,
      );
    }
    // The differences that DID exist are exactly the documented knobs: markdown vs plain heading
    // labels, and whether the completion-envelope line is appended.
    const claude = renderEnvelope(envelope, RENDER_PROFILES["Claude Code"]);
    const custom = renderEnvelope(envelope, RENDER_PROFILES.Custom);
    assert.match(claude, /^## Context$/m, "Claude Code uses markdown headings");
    assert.doesNotMatch(custom, /^## Context$/m, "Custom uses plain headings");
    assert.ok(claude.includes(COMPLETION_REQUEST_LINE), "Claude Code requests the completion envelope");
    assert.ok(!custom.includes(COMPLETION_REQUEST_LINE), "Custom (bare shell) does not");
  });

  it("RENDER_PROFILES' key-set is formatting-only (preset/headingStyle/requestCompletionEnvelope/escapeStyle/eol/submitSequence/maxChars) — no target/gate/exchange-state key ever appears", () => {
    const allowed = new Set([
      "preset", "headingStyle", "requestCompletionEnvelope", "escapeStyle", "eol", "submitSequence", "maxChars",
    ]);
    for (const preset of Object.keys(RENDER_PROFILES) as RenderPreset[]) {
      for (const key of Object.keys(RENDER_PROFILES[preset])) {
        assert.ok(allowed.has(key), `RenderProfile['${preset}'] carries a non-formatting key '${key}'`);
      }
    }
  });

  it("(documents current behavior) renderEnvelope does NOT enforce maxChars — an over-limit body passes through UNTRUNCATED", () => {
    const bigObjective = "x".repeat(20_000);
    const out = renderEnvelope(buildEnvelope({ objective: bigObjective }), RENDER_PROFILES.Custom);
    assert.ok(
      out.length > RENDER_PROFILES.Custom.maxChars,
      "current (gap) behavior: content is never truncated or refused, despite maxChars being defined",
    );
    assert.ok(out.startsWith(bigObjective), "no truncation occurred — the full body passed through");
  });

  it("(BUG-D, spec §6.2) an over-limit draft SHOULD refuse at send ('never silent truncation') — no such guard exists anywhere in the codebase", { todo: "BUG-D: maxChars is a dead field; assessReadiness/renderEnvelope/sendInstruction have no size-ceiling guard at all" }, () => {
    // assessReadiness(draft) (src/exchanges/instructionEnvelope.ts) branches ONLY on target/objective
    // (spec §2.2) — it has no maxChars-aware branch, so an envelope whose rendered form vastly
    // exceeds every profile's maxChars is reported READY, and send_instruction would deliver it.
    const bigObjective = "y".repeat(50_000);
    const draft = createDraft({
      target: { projectId: "p", paneId: "pane" },
      envelope: buildEnvelope({ objective: bigObjective }),
    });
    const rendered = renderEnvelope(draft.envelope, RENDER_PROFILES.Custom);
    assert.ok(
      rendered.length <= RENDER_PROFILES.Custom.maxChars,
      "EXPECTED (spec §6.2): an over-limit render should never reach the pane-write seam unrefused",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Journeys 1-10 — the REAL server, mock-live voice dispatch, stub terminals.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** Stand-in for a UniversalTerminal — verbatim idiom from tests/test_voice_tool_goldens.ts
 *  (every field manager.syncLedger() reads is present; no real PTY spawns). */
class StubTerminal {
  status: "Running" | "Exited" | "Idle" = "Running";
  lastCommand = "";
  writeInputCount = 0;
  stopCount = 0;
  projectId = "ir_proj";
  cwd = "/stub/cwd";
  runtimeType: "interactive_cli" | "shell" = "interactive_cli";
  permissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only" = "Human-in-the-Loop";
  toolPreset = "Custom";
  sessionId = "stub-session";
  contextSize = 0;
  lastStatusChangeAt = 1_700_000_000_000;
  constructor(public terminalId: string) {}
  writeInput(command: string) {
    this.lastCommand = command;
    this.writeInputCount++;
    this.status = "Running";
  }
  getRecentOutput(_lines = 10): string {
    return "stub output line A\nstub output line B";
  }
  private deltaConsumed = false;
  consumeDelta(): { lines: string; dropped: number } {
    if (this.deltaConsumed) return { lines: "", dropped: 0 };
    this.deltaConsumed = true;
    return { lines: "stub delta line 1\nstub delta line 2", dropped: 0 };
  }
  setPermissionsMode(mode: "Full Auto" | "Human-in-the-Loop" | "Read-Only") { this.permissionsMode = mode; }
  async stop() { this.stopCount++; this.status = "Exited"; }
}

describe("instruction-routing journeys (real server, mock-live voice dispatch, stub terminals)", () => {
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let client: WebSocket;
  let wsFrames: any[];
  let base: string;
  let tmpDir: string;
  let prevCwd: string;

  const live = (): MockLiveSession => mock.latest()!;

  function api(pathname: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${base}${pathname}`, {
      ...init,
      headers: { "x-api-token": apiToken, "content-type": "application/json", ...(init.headers || {}) },
    });
  }

  async function callTool(name: string, args: Record<string, any> = {}): Promise<{ callId: string; output: string; status?: string; raw: any }> {
    const callId = live().emitToolCall(name, args);
    const raw = await waitFor(() => mock.rawResponseFor(callId));
    return { callId, output: String(raw?.output ?? ""), status: raw?.status, raw };
  }

  async function setActivePane(paneId: string): Promise<void> {
    const call = live().emitToolCall("switch_active_pane", { pane_id: paneId });
    await waitFor(() => mock.responseFor(call));
  }

  function clearPanes() {
    for (const id of Object.keys(running.manager.terminals)) {
      delete (running.manager.terminals as any)[id];
    }
  }

  /** Register a pane both in the ledger (persists across tests, name-scoped so cross-journey
   *  candidate accumulation never collides with a DIFFERENT journey's exact-name/prefix
   *  references) AND as a live StubTerminal. Does NOT touch manager.ledger.activeProjectId —
   *  callers set that explicitly so cross-project journeys stay precise. */
  function registerPane(
    projectId: string,
    paneId: string,
    name: string,
    preset: string,
    permissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only" = "Human-in-the-Loop",
  ): StubTerminal {
    if (!running.manager.ledger.getProject(projectId)) {
      running.manager.ledger.addProject(projectId, "/stub/cwd", `${projectId} fixture project`);
    }
    running.manager.ledger.updatePane(projectId, {
      pane_id: paneId, name, runtime_type: "interactive_cli",
      last_known_state: "Idle", is_busy: false, alive: true,
      notes: [], permissions_mode: permissionsMode, session_id: `${paneId}-session`,
      tool_preset: preset, context_size: 0,
    } as any, true);
    const t = new StubTerminal(paneId);
    t.permissionsMode = permissionsMode;
    t.toolPreset = preset;
    t.projectId = projectId;
    (running.manager.terminals as any)[paneId] = t;
    return t;
  }

  function ledgerDraftText(projectId: string, paneId: string): string {
    return running.manager.ledger.getDraft(projectId, paneId)?.text ?? "";
  }

  function draftUpdatedFrames(): any[] {
    return wsFrames.filter((f) => f?.type === "draft_updated");
  }

  function switchFrames(): any[] {
    return wsFrames.filter((f) => f?.type === "switch_active_pane");
  }

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";
    // JANUS_INSTRUCTION_ENVELOPE was already set (module top-level, before any dynamic import of
    // ../server) — see the file-header note.

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-ir-journeys-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    running = await startServer({ port: 0, enableVite: false });
    base = `http://127.0.0.1:${running.port}`;

    wsFrames = [];
    client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, {
      headers: { Cookie: `auth_token=${apiToken}` },
    });
    client.on("message", (data) => {
      try { wsFrames.push(JSON.parse(data.toString())); } catch { /* non-JSON */ }
    });
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => resolve());
      client.on("error", reject);
    });
    await waitFor(() => mock.latest());
  });

  after(async () => {
    if (running?.manager) {
      const terms = Object.values(running.manager.terminals) as any[];
      await Promise.all(terms.map((t) => Promise.resolve(t.stop()).catch(() => { /* already gone */ })));
      for (const id of Object.keys(running.manager.terminals)) {
        delete (running.manager.terminals as any)[id];
      }
    }
    if (client && client.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        client.once("close", () => resolve());
        try { client.terminate(); } catch { resolve(); }
      });
    }
    await teardownServerSuite(running);
    process.chdir(prevCwd);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  describe("journey 1: exact target binds silently; draft created; send delivers byte-exact rendered text", () => {
    it("focus_pane(exact name) binds silently, draft_instruction composes on it, send_instruction writes the EXACT renderEnvelope() output to the pane", async () => {
      resetDraftRegistryForTests();
      clearPanes();
      const PJ = "ir_proj_j1";
      registerPane(PJ, "codex-run-1", "codex-run-1", "Codex", "Full Auto");
      running.manager.ledger.activeProjectId = PJ;
      wsFrames.length = 0;

      const focus = await callTool("focus_pane", { reference: "codex-run-1" });
      assert.match(focus.output, /Focused pane 'codex-run-1'/);
      assert.strictEqual(focus.status, undefined, "exact reference binds silently — no clarify");
      await waitFor(() => switchFrames().find((f) => f.paneId === "codex-run-1"));

      const draft = await callTool("draft_instruction", { objective: "run the tests" });
      assert.match(draft.output, /Drafted for pane 'codex-run-1'/);
      assert.strictEqual(draft.status, undefined);

      const clarifies = [focus, draft].filter((r) => r.status === "clarify");
      assert.strictEqual(clarifies.length, 0, "no redundant confirmation anywhere in this flow");

      const send = await callTool("send_instruction", {});
      assert.match(send.output, /Command executed automatically on pane codex-run-1/);

      const term = running.manager.terminals["codex-run-1"] as unknown as StubTerminal;
      assert.strictEqual(term.writeInputCount, 1);
      const expected = renderEnvelope(buildEnvelope({ objective: "run the tests" }), RENDER_PROFILES.Codex);
      assert.strictEqual(term.lastCommand, expected, "byte-exact rendered instruction at the pane-write seam");
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  describe("journey 2: two panes matching 'test agent' -> exactly one clarification; answer resolves; draft follows", () => {
    it("retarget_instruction(name-prefix collision) -> confirm(multiple) naming both; confirm_instruction(chosen id) resolves with no further clarification", async () => {
      resetDraftRegistryForTests();
      clearPanes();
      const PJ = "ir_proj_j2";
      registerPane(PJ, "scratch-2", "scratch-2", "Custom", "Full Auto");
      registerPane(PJ, "test-agent-a", "test agent alpha", "Custom", "Full Auto");
      registerPane(PJ, "test-agent-b", "test agent beta", "Custom", "Full Auto");
      running.manager.ledger.activeProjectId = PJ;
      await setActivePane("scratch-2");

      const draft = await callTool("draft_instruction", { objective: "investigate the failure" });
      assert.match(draft.output, /Drafted for pane 'scratch-2'/);

      const retarget = await callTool("retarget_instruction", { reference: "test agent" });
      assert.strictEqual(retarget.status, "clarify", "two panes share the 'test agent' prefix -> confirm, never a guess");
      assert.match(retarget.output, /test agent alpha/);
      assert.match(retarget.output, /test agent beta/);
      // The clarify must NOT have mutated the draft (still targeting scratch-2, still v1).
      assert.deepStrictEqual(getOpenDraft(PJ, "scratch-2")?.target, { projectId: PJ, paneId: "scratch-2" });
      assert.strictEqual(getOpenDraft(PJ, "scratch-2")?.draftVersion, 1);

      const confirm = await callTool("confirm_instruction", { pane_id: "test-agent-a" });
      assert.strictEqual(confirm.status, undefined, "answering the clarification resolves without a second clarify");
      assert.match(confirm.output, /Retargeted the instruction draft to pane 'test-agent-a'/);

      const clarifyCount = [draft, retarget, confirm].filter((r) => r.status === "clarify").length;
      assert.strictEqual(clarifyCount, 1, "exactly one clarification for the whole ambiguity");

      assert.strictEqual(ledgerDraftText(PJ, "scratch-2"), "", "the old pane's draft is cleared on retarget");
      assert.ok(ledgerDraftText(PJ, "test-agent-a").includes("investigate the failure"));
      assert.strictEqual(getOpenDraft(PJ, "test-agent-b"), undefined, "the OTHER candidate never got a draft");
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  describe("journey 3: 'tell it to fix that' with no recent referent -> clarify, no draft mutation", () => {
    it("anaphora with no live recent referent clarifies and leaves the existing draft byte-for-byte untouched", async () => {
      resetDraftRegistryForTests();
      clearPanes();
      const PJ = "ir_proj_j3";
      registerPane(PJ, "solo-3", "solo-3", "Custom", "Full Auto");
      running.manager.ledger.activeProjectId = PJ;
      await setActivePane("solo-3");

      // Hand-construct the open draft with the SAME production primitives draft_instruction uses
      // (createDraft/buildEnvelope, src/exchanges/instructionEnvelope.ts + setOpenDraft,
      // src/exchanges/draftRegistry.ts) WITHOUT the recordRecentReferent side effect
      // draft_instruction.handler always performs — isolating the exact decision-table cell this
      // journey targets: a draft exists, but the anaphora register is empty (e.g. the TTL expired,
      // or the draft was recovered on reconnect — spec §3.2's "no recent referent -> clarify").
      const envelope = buildEnvelope({ objective: "investigate the outage" });
      const draft0 = createDraft({ target: { projectId: PJ, paneId: "solo-3" }, envelope });
      setOpenDraft(PJ, "solo-3", draft0);

      const retarget = await callTool("retarget_instruction", { reference: "it" });
      assert.strictEqual(retarget.status, "clarify", "no recent referent -> clarify, never a guess at the active pane");

      const after = getOpenDraft(PJ, "solo-3");
      assert.ok(after, "the draft still exists");
      assert.strictEqual(after!.draftVersion, 1, "a clarify never mutates the draft");
      assert.deepStrictEqual(after!.target, { projectId: PJ, paneId: "solo-3" });
      assert.strictEqual(after!.envelope.objective, "investigate the outage");
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  describe("journey 4: cross-project retarget requires confirm; the NEW pane's gate applies after confirm (+ BUG-A)", () => {
    it("an exact cross-project name reference NEVER binds silently — confirm(cross_project) required, no mutation until answered", async () => {
      resetDraftRegistryForTests();
      clearPanes();
      const PA = "ir_proj_j4a";
      const PB = "ir_proj_j4b";
      registerPane(PA, "a-pane", "a-pane", "Custom", "Human-in-the-Loop"); // default write_to_pane=Ask
      registerPane(PB, "b-pane", "b-pane", "Custom", "Full Auto");
      running.manager.ledger.activeProjectId = PA;
      await setActivePane("a-pane");

      const draft = await callTool("draft_instruction", { objective: "roll back the last migration" });
      assert.match(draft.output, /Drafted for pane 'a-pane'/);

      const retarget = await callTool("retarget_instruction", { reference: "b-pane" });
      assert.strictEqual(retarget.status, "clarify", "cross-project, even an EXACT name match, always confirms (spec §3.2/§4)");
      assert.match(retarget.output, /different project/);
      assert.strictEqual(getOpenDraft(PA, "a-pane")?.draftVersion, 1, "the confirm-required decision did not mutate the draft");

      const confirm = await callTool("confirm_instruction", { pane_id: "b-pane" });
      assert.strictEqual(confirm.status, undefined);
      assert.match(confirm.output, /Retargeted the instruction draft to pane 'b-pane'/);
      assert.deepStrictEqual(getOpenDraft(PB, "b-pane")?.target, { projectId: PB, paneId: "b-pane" });
      assert.strictEqual(getOpenDraft(PB, "b-pane")?.draftVersion, 2, "retarget bumps the version");
      assert.strictEqual(ledgerDraftText(PA, "a-pane"), "", "the source project's ledger draft is cleared");
    });

    it("BUG-A: activeDraftTarget()'s stale project id orphans send_instruction/revise_instruction after a confirmed cross-project retarget", async () => {
      resetDraftRegistryForTests();
      clearPanes();
      const PA = "ir_proj_j4c";
      const PB = "ir_proj_j4d";
      registerPane(PA, "c-pane", "c-pane", "Custom", "Human-in-the-Loop");
      registerPane(PB, "d-pane", "d-pane", "Custom", "Full Auto"); // the destination's gate is wide open
      running.manager.ledger.activeProjectId = PA;
      await setActivePane("c-pane");

      await callTool("draft_instruction", { objective: "restart the ingest worker" });
      await callTool("retarget_instruction", { reference: "d-pane" });
      const confirm = await callTool("confirm_instruction", { pane_id: "d-pane" });
      assert.match(confirm.output, /Retargeted the instruction draft to pane 'd-pane'/);

      // performRetarget (src/actions/defs/voice_ux.ts) calls ctx.setActivePane("d-pane") — the
      // ACTIVE PANE genuinely moved to project B's pane...
      await waitFor(() => switchFrames().find((f) => f.paneId === "d-pane"));
      // ...but manager.ledger.activeProjectId (the ONLY input activeDraftTarget() reads for its
      // projectId, server.ts:1420-1423) was NEVER advanced — root cause, pinned directly:
      assert.strictEqual(
        running.manager.ledger.activeProjectId,
        PA,
        "BUG-A root cause: the cross-project retarget moved the active PANE but not the active PROJECT",
      );

      // Consequence: send_instruction computes activeDraftTarget() = {projectId: PA (stale),
      // paneId: 'd-pane'} — a key that was never written (the real entry lives under
      // PB::d-pane, exactly as journey 4's first test proved). The confirmed, ready draft is
      // unreachable via voice.
      const send = await callTool("send_instruction", {});
      assert.match(
        send.output,
        /no open instruction draft for pane 'd-pane'/,
        "BUG-A: send_instruction cannot find the draft it just confirmed retargeting, because activeDraftTarget()'s projectId is stale",
      );
      // The draft is NOT gone — it is exactly where confirm_instruction put it, under the CORRECT key.
      assert.ok(getOpenDraft(PB, "d-pane"), "the draft genuinely still exists under the correct (new-project, new-pane) key");
    });

    it("(BUG-A, spec §5.3) a confirmed cross-project retarget SHOULD let send_instruction deliver to the new pane, applying ITS gate", { todo: "BUG-A: activeDraftTarget() never advances manager.ledger.activeProjectId on retarget (see the preceding test for the root cause)" }, async () => {
      resetDraftRegistryForTests();
      clearPanes();
      const PA = "ir_proj_j4e";
      const PB = "ir_proj_j4f";
      registerPane(PA, "e-pane", "e-pane", "Custom", "Human-in-the-Loop"); // Ask-gated
      registerPane(PB, "f-pane", "f-pane", "Custom", "Full Auto"); // the NEW pane's gate is wide open
      running.manager.ledger.activeProjectId = PA;
      await setActivePane("e-pane");

      await callTool("draft_instruction", { objective: "clear the dead-letter queue" });
      await callTool("retarget_instruction", { reference: "f-pane" });
      await callTool("confirm_instruction", { pane_id: "f-pane" });

      const send = await callTool("send_instruction", {});
      // EXPECTED (spec §5.3: "safety posture is re-read for the NEW pane"): f-pane's Full-Auto
      // gate applies, so this should auto_execute — not "no open instruction draft".
      assert.match(send.output, /Command executed automatically on pane f-pane/);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  describe("journey 5: long dictation distilled then revised — voice adds a constraint, no fabrication", () => {
    it("multi-sentence dictation -> envelope build -> voice revision appends a constraint -> same draft, version++, rendered text is byte-exact against the ONLY operator-provided strings", async () => {
      resetDraftRegistryForTests();
      clearPanes();
      const PJ = "ir_proj_j5";
      registerPane(PJ, "checkout-pane", "checkout-pane", "Custom", "Full Auto");
      running.manager.ledger.activeProjectId = PJ;
      await setActivePane("checkout-pane");

      const objective = "Investigate and fix the flaky checkout test that started failing after yesterday's deploy";
      const context = ["the failure started after yesterday's deploy", "only happens in CI, not locally"];
      const draft = await callTool("draft_instruction", { objective, relevant_context: context });
      assert.strictEqual(draft.status, undefined);
      assert.strictEqual(getOpenDraft(PJ, "checkout-pane")?.draftVersion, 1);

      // "add that it must preserve the API response shape" — the caller supplies the FULL
      // constraint list (revise_instruction's constraints field REPLACES, it does not append —
      // appending is the caller's responsibility, exactly like a typed textarea edit).
      const revise = await callTool("revise_instruction", { constraints: ["it must preserve the API response shape"] });
      assert.strictEqual(revise.status, undefined);

      const finalDraft = getOpenDraft(PJ, "checkout-pane")!;
      assert.strictEqual(finalDraft.draftVersion, 2, "the SAME draft, version bumped");
      assert.strictEqual(finalDraft.envelope.objective, objective, "objective untouched by the constraint-only revision");
      assert.deepStrictEqual(finalDraft.envelope.relevant_context, context, "context untouched");
      assert.deepStrictEqual(finalDraft.envelope.constraints, ["it must preserve the API response shape"]);

      const send = await callTool("send_instruction", {});
      assert.match(send.output, /Command executed automatically on pane checkout-pane/);

      const term = running.manager.terminals["checkout-pane"] as unknown as StubTerminal;
      const expected = renderEnvelope(
        buildEnvelope({ objective, relevantContext: context, constraints: ["it must preserve the API response shape"] }),
        RENDER_PROFILES.Custom,
      );
      assert.strictEqual(term.lastCommand, expected, "byte-exact — every line traces to an operator-provided string plus fixed labels");
      // Anti-fabrication spot-check: the delivered text contains NOTHING beyond what was said.
      for (const line of term.lastCommand.split("\n").filter((l: string) => l.trim().length > 0)) {
        const isOperatorLine = line === objective || context.some((c) => line.includes(c)) || line.includes("it must preserve the API response shape");
        const isFixedLabel = line === "Context:" || line === "Constraints:" || line.startsWith("- ");
        assert.ok(isOperatorLine || isFixedLabel, `unexpected non-operator, non-label line in the delivered text: "${line}"`);
      }
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  describe("journey 6: typed edit sets prose-override; the next voice revision clears it and re-renders", () => {
    it("PUT draft (typed) bumps the version + sets prose-override, verbatim text mirrored; revise_instruction (voice) clears the override, bumps again, and re-renders over the typed text", async () => {
      resetDraftRegistryForTests();
      clearPanes();
      const PJ = "ir_proj_j6";
      registerPane(PJ, "backoff-pane", "backoff-pane", "Custom", "Human-in-the-Loop");
      running.manager.ledger.activeProjectId = PJ;
      await setActivePane("backoff-pane");

      const draft = await callTool("draft_instruction", { objective: "tighten the retry backoff" });
      assert.strictEqual(draft.status, undefined);
      assert.strictEqual(getOpenDraft(PJ, "backoff-pane")?.draftVersion, 1);
      assert.strictEqual(hasProseOverride(PJ, "backoff-pane"), false);

      const typedText = "tighten the retry backoff, and cap it at 3 attempts";
      const putRes = await api(`/api/panes/${PJ}/backoff-pane/draft`, { method: "PUT", body: JSON.stringify({ text: typedText }) });
      assert.strictEqual(putRes.status, 200);
      await waitFor(() => ledgerDraftText(PJ, "backoff-pane") === typedText);

      assert.strictEqual(getOpenDraft(PJ, "backoff-pane")?.draftVersion, 2, "the typed edit converges onto the SAME draft, version bumped");
      assert.strictEqual(hasProseOverride(PJ, "backoff-pane"), true, "the hand-edited prose is now authoritative");
      assert.strictEqual(ledgerDraftText(PJ, "backoff-pane"), typedText, "the ledger draft is the operator's verbatim typed text — not re-rendered");

      const revise = await callTool("revise_instruction", { objective: "tighten the retry backoff and cap retries" });
      assert.strictEqual(revise.status, undefined);

      assert.strictEqual(getOpenDraft(PJ, "backoff-pane")?.draftVersion, 3, "the voice revision bumps the SAME version chain again");
      assert.strictEqual(hasProseOverride(PJ, "backoff-pane"), false, "a voice field revision always clears a stale typed override");
      const rerendered = ledgerDraftText(PJ, "backoff-pane");
      assert.notStrictEqual(rerendered, typedText, "the typed text was overwritten by the fresh render");
      const expected = renderEnvelope(buildEnvelope({ objective: "tighten the retry backoff and cap retries" }), RENDER_PROFILES.Custom);
      assert.strictEqual(rerendered, expected, "re-rendered from the envelope now that the override is cleared");
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  describe("journey 7: an approval bound to a stale draft (BUG-B: no CAS at all)", () => {
    it("send_instruction stages a pending approval, then CLEARS the open draft (even though nothing was delivered yet) — the operator cannot voice-revise the in-flight instruction", async () => {
      resetDraftRegistryForTests();
      clearPanes();
      const PJ = "ir_proj_j7";
      registerPane(PJ, "worker-pane", "worker-pane", "Custom", "Human-in-the-Loop"); // default write_to_pane=Ask
      running.manager.ledger.activeProjectId = PJ;
      await setActivePane("worker-pane");

      await callTool("draft_instruction", { objective: "restart the worker pool" });
      const send1 = await callTool("send_instruction", {});
      assert.match(send1.output, /Pending approval:.*worker-pane/);

      assert.strictEqual(getOpenDraft(PJ, "worker-pane"), undefined, "BUG-B: the open draft is gone even though the instruction only PENDED, never delivered");
      assert.strictEqual(ledgerDraftText(PJ, "worker-pane"), "");

      const revise2 = await callTool("revise_instruction", { objective: "restart the worker pool AND clear the queue" });
      assert.match(revise2.output, /no open instruction draft/, "the operator literally cannot amend the in-flight instruction via voice");
    });

    it("BUG-B: approving the stale pending approval delivers the ORIGINAL text unconditionally — no draft-version CAS exists at the approval layer", async () => {
      resetDraftRegistryForTests();
      clearPanes();
      const PJ = "ir_proj_j7b";
      registerPane(PJ, "cache-pane", "cache-pane", "Custom", "Human-in-the-Loop");
      running.manager.ledger.activeProjectId = PJ;
      await setActivePane("cache-pane");

      await callTool("draft_instruction", { objective: "flush the stale cache entries" });
      const send1 = await callTool("send_instruction", {});
      assert.match(send1.output, /Pending approval:.*cache-pane/);

      // src/gating/index.ts renderApproved writes `record.instruction` VERBATIM — it never checks
      // any draft version, because DispatchProposalArgs (src/actions/types.ts) carries no
      // exchangeId/draftVersion field on this path at all (the AgentExchange spine's exchangeId
      // hook, src/dispatch/paneWrite.ts:97-107, is threaded by an ENTIRELY SEPARATE flag/system
      // — JANUS_EXCHANGE_SPINE — that the instruction-envelope voice verbs never populate).
      const approve = await api("/api/commands/approve", {
        method: "POST",
        body: JSON.stringify({ messageId: send1.callId, approved: true }),
      });
      assert.strictEqual(approve.status, 200);

      const term = running.manager.terminals["cache-pane"] as unknown as StubTerminal;
      await waitFor(() => term.writeInputCount > 0);
      assert.strictEqual(term.writeInputCount, 1);
      assert.match(term.lastCommand, /flush the stale cache entries/, "the stale, un-revisable text was delivered unconditionally");
    });

    it("(BUG-B, spec §4/§5.3) revising a draft with an outstanding approval SHOULD bump draft_version and invalidate the pending approval so it can never deliver", { todo: "BUG-B: no CAS binds the pending-approval record to any EnvelopeDraft version; sendInstruction also clears the draft on `pending`, so there is no live draft left to revise" }, async () => {
      resetDraftRegistryForTests();
      clearPanes();
      const PJ = "ir_proj_j7c";
      registerPane(PJ, "gc-pane", "gc-pane", "Custom", "Human-in-the-Loop");
      running.manager.ledger.activeProjectId = PJ;
      await setActivePane("gc-pane");

      await callTool("draft_instruction", { objective: "trigger a manual GC pass" });
      const send1 = await callTool("send_instruction", {});
      assert.match(send1.output, /Pending approval/);

      // EXPECTED (spec): the draft should still be revisable (not cleared) while the approval is
      // outstanding, and revising it should invalidate the v1 approval.
      const revise = await callTool("revise_instruction", { objective: "trigger a manual GC pass and log heap stats" });
      assert.strictEqual(revise.status, undefined, "EXPECTED: revising while an approval is outstanding should succeed");

      // EXPECTED: the STALE v1 approval can no longer deliver.
      const approve = await api("/api/commands/approve", {
        method: "POST",
        body: JSON.stringify({ messageId: send1.callId, approved: true }),
      });
      const body = await approve.json().catch(() => ({}));
      assert.notStrictEqual(body?.success, true, "EXPECTED: the CAS-invalidated stale approval should fail to deliver");
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  describe("journey 8: explicit send is idempotent per version (+ BUG-C edge case)", () => {
    it("two consecutive send_instruction calls -> exactly ONE delivery (the second finds no open draft — the first already cleared it)", async () => {
      resetDraftRegistryForTests();
      clearPanes();
      const PJ = "ir_proj_j8a";
      registerPane(PJ, "idem-pane", "idem-pane", "Custom", "Full Auto");
      running.manager.ledger.activeProjectId = PJ;
      await setActivePane("idem-pane");

      await callTool("draft_instruction", { objective: "rotate the log files" });
      const send1 = await callTool("send_instruction", {});
      assert.match(send1.output, /Command executed automatically on pane idem-pane/);

      const send2 = await callTool("send_instruction", {});
      assert.match(send2.output, /no open instruction draft/);

      const term = running.manager.terminals["idem-pane"] as unknown as StubTerminal;
      assert.strictEqual(term.writeInputCount, 1, "exactly one delivery for the double send");
    });

    it("BUG-C: a BLOCKED (never-delivered) send still locks the version — a legitimate retry after fixing the blocker is wrongly refused as 'already sent'", async () => {
      resetDraftRegistryForTests();
      clearPanes();
      const PJ = "ir_proj_j8b";
      registerPane(PJ, "gated-pane", "gated-pane", "Custom", "Full Auto");
      running.manager.ledger.activeProjectId = PJ;
      await setActivePane("gated-pane");

      // write_to_pane is spotlight-eligible (src/pendingApprovals.ts SPOTLIGHT_CAPABILITIES): a
      // GLOBAL gate change is silently overridden back to Auto for the ACTIVE pane ("trust
      // follows focus"). Only an explicit PER-PANE override wins over the spotlight — persisted
      // the real way, via the set_capability_gate voice tool (mirrors
      // tests/test_voice_tool_goldens.ts's tightenPaneGate helper).
      const tighten = await callTool("set_capability_gate", { pane_id: "gated-pane", capability: "write_to_pane", gate: "Off" });
      assert.strictEqual(tighten.status, undefined);

      await callTool("draft_instruction", { objective: "purge the temp directory" });
      const send1 = await callTool("send_instruction", {});
      assert.match(send1.output, /gated Off/, "the write is blocked — nothing was delivered");

      // The draft was NOT cleared (only `executed`/`pending` clear it) — it is still open,
      // still v1, but recordSend already (wrongly) marked v1 as sent.
      const stillOpen = getOpenDraft(PJ, "gated-pane");
      assert.ok(stillOpen, "the draft survives a blocked send");
      assert.deepStrictEqual([...stillOpen!.sentVersions], [1], "BUG-C root cause: v1 is marked 'sent' even though the write was blocked, not delivered");

      // Operator fixes the blocker (clears the per-pane override — capability_gates is ALWAYS
      // rewritten from the update payload, NULL when absent, src/store/sqliteStore.ts:844) and
      // retries the SAME, never-delivered instruction.
      registerPane(PJ, "gated-pane", "gated-pane", "Custom", "Full Auto");
      await setActivePane("gated-pane");
      const send2 = await callTool("send_instruction", {});
      assert.match(
        send2.output,
        /already sent — revise it before sending again/,
        "BUG-C: the legitimate retry is wrongly refused as a duplicate, even though nothing was ever delivered",
      );
      const term = running.manager.terminals["gated-pane"] as unknown as StubTerminal;
      assert.strictEqual(term.writeInputCount, 0, "confirms nothing was EVER actually delivered, despite the 'already sent' refusal");
    });

    it("(BUG-C, spec §5.3) a retry of a never-delivered version SHOULD be allowed to deliver, not refused as a duplicate", { todo: "BUG-C: recordSend() marks sentVersions before dispatchProposal's outcome is known" }, async () => {
      resetDraftRegistryForTests();
      clearPanes();
      const PJ = "ir_proj_j8c";
      registerPane(PJ, "gated-pane-2", "gated-pane-2", "Custom", "Full Auto");
      running.manager.ledger.activeProjectId = PJ;
      await setActivePane("gated-pane-2");

      await callTool("set_capability_gate", { pane_id: "gated-pane-2", capability: "write_to_pane", gate: "Off" });
      await callTool("draft_instruction", { objective: "compact the index" });
      await callTool("send_instruction", {}); // blocked

      registerPane(PJ, "gated-pane-2", "gated-pane-2", "Custom", "Full Auto");
      await setActivePane("gated-pane-2");
      const retry = await callTool("send_instruction", {});
      assert.match(retry.output, /Command executed automatically on pane gated-pane-2/);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  describe("journey 9: cancel clears the draft, the exchange projection, and the Workbench view", () => {
    it("cancel_instruction clears the registry draft, the ledger draft, and broadcasts exchange:null", async () => {
      resetDraftRegistryForTests();
      clearPanes();
      const PJ = "ir_proj_j9";
      registerPane(PJ, "cancel-pane", "cancel-pane", "Custom", "Full Auto");
      running.manager.ledger.activeProjectId = PJ;
      await setActivePane("cancel-pane");

      await callTool("draft_instruction", { objective: "reindex the search cluster" });
      assert.ok(getOpenDraft(PJ, "cancel-pane"));
      wsFrames.length = 0;

      const cancel = await callTool("cancel_instruction", {});
      assert.match(cancel.output, /Cancelled the instruction draft for pane 'cancel-pane'/);

      assert.strictEqual(getOpenDraft(PJ, "cancel-pane"), undefined, "the exchange draft is cleared");
      assert.strictEqual(ledgerDraftText(PJ, "cancel-pane"), "", "the mirrored ledger/Workbench draft is cleared");

      const frame = await waitFor(() => draftUpdatedFrames().find((f) => f.paneId === "cancel-pane"));
      assert.strictEqual(frame.exchange, null, "the Workbench view (exchange projection) shows nothing after cancel");
      assert.strictEqual(frame.draft?.text, "");
    });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  describe("journey 10: WS reconnect — the open draft still recovers via the REST GET path, version preserved", () => {
    it("GET /api/panes/:projectId/:paneId/draft returns the SAME open exchange (same version, same objective) after the client reconnects", async () => {
      resetDraftRegistryForTests();
      clearPanes();
      const PJ = "ir_proj_j10";
      registerPane(PJ, "reconnect-pane", "reconnect-pane", "Custom", "Human-in-the-Loop");
      running.manager.ledger.activeProjectId = PJ;
      await setActivePane("reconnect-pane");

      await callTool("draft_instruction", { objective: "audit the rate limiter" });
      const before = getOpenDraft(PJ, "reconnect-pane")!;
      assert.strictEqual(before.draftVersion, 1);

      // Simulate a WS reconnect: close the current client, open a fresh one. The draft lives
      // server-side (src/exchanges/draftRegistry.ts, a process-global registry) — NOT on the
      // connection — so recovery is purely the REST GET path the Workbench calls on (re)load.
      await new Promise<void>((resolve) => {
        client.once("close", () => resolve());
        try { client.terminate(); } catch { resolve(); }
      });
      const client2 = new WebSocket(`ws://127.0.0.1:${running.port}/live`, {
        headers: { Cookie: `auth_token=${apiToken}` },
      });
      await new Promise<void>((resolve, reject) => {
        client2.on("open", () => resolve());
        client2.on("error", reject);
      });
      await waitFor(() => mock.sessions.length >= 2 ? mock.latest() : undefined);
      client = client2; // subsequent journeys (none follow) would use the new client

      const res = await api(`/api/panes/${PJ}/reconnect-pane/draft`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.ok(body.exchange, "the exchange projection recovers after reconnect");
      assert.strictEqual(body.exchange.draftVersion, 1, "version preserved across reconnect");
      assert.strictEqual(body.exchange.exchangeId, before.exchangeId);
      assert.match(body.exchange.objective, /audit the rate limiter/);
      assert.deepStrictEqual(body.exchange.target, { projectId: PJ, paneId: "reconnect-pane" });
      assert.strictEqual(body.draft.text, renderEnvelope(buildEnvelope({ objective: "audit the rate limiter" }), RENDER_PROFILES.Custom));
    });
  });
});
