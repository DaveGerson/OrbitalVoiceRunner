// tests/test_focus_journey.ts — focus_pane END-TO-END through the REAL server pipeline (voice-UX
// wave 3, fz1-owned). Real Gemini onmessage dispatch (registry runAction), the real
// single-active-pane WRITE guard (src/dispatch/paneWrite.ts), REAL PTY panes (create_pane), and
// (if the "policies" python daemon spawns) the real policy client — the assertions below are
// designed to hold identically whether or not that daemon is up, because:
//   - an EXACT reference always resolves confidence===1 in both the TS literal floor AND the
//     python scorer (an exact whole-string match), so "exact bind" behavior is daemon-agnostic.
//   - a genuinely AMBIGUOUS reference (a shared prefix across two same-scored candidates) always
//     produces a `clarify` (never a bind) in both paths — the TS floor via its own "ambiguous
//     prefix" branch, the python path via the "multiple close alternatives" bucket — so the
//     round-trip assertions ("did not bind", "clarify text mentions both names") hold either way.
//
// Journeys:
//   1. focus_pane(exact reference) silently binds through the SAME switch_active_pane path
//      (Off-veto -> existence -> setActivePane -> broadcast) and a subsequent bare
//      propose_command targeting that pane is NO LONGER refused by the single-active-pane guard,
//      while a propose_command aimed at the pane that just LOST focus IS refused.
//   2. An ambiguous reference clarifies WITHOUT binding; the model's next turn re-calls focus_pane
//      with the disambiguated exact name, and THAT binds — the two-turn conversational round trip
//      (D1: no TS-side pending window — every call is independent).
//   3. focus_pane gated Off blocks the bind with a spoken policy explanation and does not move
//      the active pane.
//
// Runner: npx tsx --test --test-force-exit tests/test_focus_journey.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { WebSocket } from "ws";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import { teardownServerSuite } from "./helpers/teardown";
import type { RunningServer } from "../server";

const PROJECT = "focus_journey_proj";

describe("focus_pane journeys (real server, real PTY panes, real active-pane guard; no API key, no mic)", () => {
  let startServer: (opts?: any) => Promise<RunningServer>;
  let apiToken: string;
  let installMockLive: () => MockLiveHandle;
  let waitFor: <T>(p: () => T | undefined | false, t?: number, i?: number) => Promise<T>;

  let mock: MockLiveHandle;
  let running: RunningServer;
  let client: WebSocket;
  let wsFrames: any[];
  let tmpDir: string;
  let prevCwd: string;

  const live = (): MockLiveSession => running._testActiveLiveSession!() as MockLiveSession;

  /** Create a REAL shell pane by voice (create_pane, gated Auto for this suite) — also makes the
   *  new pane the active WRITE target (create_pane's own activate-on-create effect). */
  async function createShellPane(paneId: string): Promise<void> {
    const call = live().emitToolCall("create_pane", {
      project_id: PROJECT,
      pane_id: paneId,
      tool_preset: "Custom",
    });
    const out = String(await waitFor(() => mock.responseFor(call)));
    assert.ok(out.includes(`Pane ${paneId} created`), `create_pane ran inline under Auto: ${out}`);
    assert.ok((running.manager.terminals as any)[paneId], `live terminal ${paneId} registered`);
  }

  /** Call focus_pane by voice and return { text, callId, raw }. Accepts either an `ok` or
   *  `clarify` tool response (focus_pane never errors on a bad reference — it always narrates
   *  something). */
  async function focusPane(reference: string): Promise<{ text: string; callId: string; raw: any }> {
    const callId = live().emitToolCall("focus_pane", { reference });
    const raw = await waitFor(() => mock.rawResponseFor(callId));
    const text = typeof raw === "string" ? raw : (raw?.output ?? raw?.text ?? JSON.stringify(raw));
    return { text: String(text), callId, raw };
  }

  /** propose_command by voice; returns the raw structured tool response. */
  async function proposeCommand(paneId: string): Promise<any> {
    const callId = live().emitToolCall("propose_command", {
      pane_id: paneId,
      instruction: "echo hi",
      kind: "shell",
    });
    return waitFor(() => mock.rawResponseFor(callId));
  }

  function switchFrames(): any[] {
    return wsFrames.filter((f) => f?.type === "switch_active_pane");
  }

  before(async () => {
    process.env.NODE_ENV = "test";
    process.env.JANUS_NO_AUTOSTART = "1";

    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "janus-focus-journey-"));
    process.chdir(tmpDir);

    ({ installMockLive, waitFor } = await import("./helpers/mockLive"));
    const serverMod = await import("../server");
    startServer = serverMod.startServer;
    apiToken = serverMod.API_AUTH_TOKEN;

    mock = installMockLive();
    running = await startServer({ port: 0, enableVite: false });

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
    await waitFor(() => mock.latest() && running._testActiveLiveSession?.());

    // create_pane defaults to Ask — loosen to Auto for this suite so panes spawn inline (mirrors
    // tests/test_voice_journeys.ts's convention).
    if (!running.manager.settings.advanced.capabilityGates) {
      running.manager.settings.advanced.capabilityGates = {} as any;
    }
    (running.manager.settings.advanced.capabilityGates as any).create_pane = "Auto";

    await createShellPane("build-one");
    await createShellPane("build-two"); // becomes the active pane (most recent create)
  });

  after(async () => {
    if (running?.manager?.settings?.advanced?.capabilityGates) {
      delete (running.manager.settings.advanced.capabilityGates as any).create_pane;
      delete (running.manager.settings.advanced.capabilityGates as any).focus_pane;
    }
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

  // ── Journey 1: exact bind, then a bare propose_command targets the newly active pane ──────────
  it("focus_pane(exact id) silently binds; propose_command now targets that pane, not the one that lost focus", async () => {
    wsFrames.length = 0;

    const { text } = await focusPane("build-one");
    assert.match(text, /Focused pane 'build-one'/);

    const frame = await waitFor(() => switchFrames().find((f) => f.paneId === "build-one"));
    assert.ok(frame, "a switch_active_pane broadcast fires for the newly focused pane");

    // A bare propose_command aimed at the NEWLY active pane (build-one) is no longer refused.
    const okResp = await proposeCommand("build-one");
    const okText = JSON.stringify(okResp);
    assert.doesNotMatch(okText, /I can only act on the pane you have open/, "build-one is the active pane, so it is a legal propose target");

    // A propose_command aimed at build-two (which just LOST focus) IS refused by the guard.
    const refusedResp = await proposeCommand("build-two");
    assert.equal(refusedResp?.status, "clarify", "off-focus pane is refused by the single-active-pane guard");
    assert.match(String(refusedResp?.output ?? ""), /I can only act on the pane you have open \('build-one'\)/);
  });

  // ── Journey 2: ambiguous reference clarifies without binding; a re-call with the exact name binds ──
  it("an ambiguous reference clarifies without binding; the model's re-call with the exact name then binds (two-turn round trip, D1: no shadow state)", async () => {
    wsFrames.length = 0;

    // "build" is a shared prefix of BOTH build-one and build-two — genuinely ambiguous.
    const ambiguous = await focusPane("build");
    // The tool response for a clarify carries {status:'clarify', ...} per the gemini projection
    // (src/actions/gemini.ts voiceResponse) — assert via the raw shape, not the coalesced text.
    const isClarify = typeof ambiguous.raw === "object" && ambiguous.raw?.status === "clarify";
    assert.ok(isClarify, `expected a clarify response for an ambiguous reference, got: ${JSON.stringify(ambiguous.raw)}`);
    assert.match(String(ambiguous.raw.output ?? ""), /build-one/);
    assert.match(String(ambiguous.raw.output ?? ""), /build-two/);
    assert.deepEqual(switchFrames(), [], "the ambiguous turn must NOT bind (no switch_active_pane broadcast)");

    // Second turn: the model (having heard both names) re-calls focus_pane with the disambiguated
    // exact name. NOTHING from the first call is consulted — this is a fresh, independent call.
    const disambiguated = await focusPane("build-two");
    assert.match(disambiguated.text, /Focused pane 'build-two'/);
    const frame = await waitFor(() => switchFrames().find((f) => f.paneId === "build-two"));
    assert.ok(frame, "the disambiguated re-call binds build-two");
  });

  // ── Journey 3: Off-veto blocks the bind (mirrors switch_active_pane's Off guard) ────────────────
  it("focus_pane gated Off refuses the bind with a spoken policy explanation; active pane is unchanged", async () => {
    wsFrames.length = 0;
    if (!running.manager.settings.advanced.capabilityGates) {
      running.manager.settings.advanced.capabilityGates = {} as any;
    }
    (running.manager.settings.advanced.capabilityGates as any).focus_pane = "Off";

    const { text } = await focusPane("build-one");
    assert.match(text, /gated Off/);
    assert.deepEqual(switchFrames(), [], "an Off-gated focus_pane call never broadcasts switch_active_pane");

    delete (running.manager.settings.advanced.capabilityGates as any).focus_pane;
  });
});
