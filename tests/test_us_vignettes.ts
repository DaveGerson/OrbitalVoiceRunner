// tests/test_us_vignettes.ts — SCORED user-story vignettes.
//
// Each test scripts a plausible operator/agent dialogue (a "vignette") through the REAL server
// dispatch via the mock Gemini Live harness, reconstructs the turn legs from the correlated
// interaction log (grouped by interaction_id), and asserts a SCORE within a REGRESSION THRESHOLD —
// NOT a hard model pass/fail. The thresholds are named constants with explanatory comments.
//
// What is and ISN'T being measured (important framing):
//   - The SERVER-SIDE routing is deterministic: a per-pane tool handler reads exactly the pane_id in
//     its args; there is no model-side name-resolution step on this path. So for a CORRECTLY-SCRIPTED
//     vignette the mis-attribution rate is structurally 0. These tests therefore pin the SERVER
//     PLUMBING (the interaction-log reconstruction + attribution accounting + grounding-ordering
//     invariant), which is exactly the regression surface a future routing/instrumentation change
//     could break. They do not — and cannot, with a mock model — measure whether a LIVE model would
//     choose the right pane; that is a live-eval concern, called out per-scenario below.
//
// Runner: npx tsx --test --test-force-exit tests/test_us_vignettes.ts
//
// Hermetic + parallel-safe: each scenario suite runs in its OWN mkdtemp cwd (chdir before importing
// ../server so the boot-time store restore + the interaction-log path resolve into the temp dir),
// chdir back + rmSync in afterEach, and AWAITs teardownServerSuite. Modelled on
// tests/test_secrets_at_rest.ts (temp cwd) + tests/test_voice_tools.ts (server-suite + mock Live).

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { teardownServerSuite } from "./helpers/teardown";
import {
  runVignette,
  scoreAttribution,
  scoreGroundingPrecedesClaim,
  type Vignette,
} from "./helpers/vignettes";
import type { MockLiveHandle, MockLiveSession } from "./helpers/mockLive";
import type { RunningServer } from "../server";

// ─────────────────────────────────────────────────────────────────────────────
// Regression thresholds (named, with rationale).
// ─────────────────────────────────────────────────────────────────────────────

// Server routing is DETERMINISTIC (handlers read the pane_id in their args verbatim), so a correctly
// scripted vignette must mis-attribute NOTHING. Any non-zero rate is a real plumbing regression.
const MAX_MISATTRIBUTION_RATE = 0;

// The grounding-call-precedes-claim invariant for a SCRIPTED grounded sequence: every scorable turn
// must lead with a grounding/read call. 1.0 == every scorable turn satisfied it.
const MIN_GROUNDED_RATE = 1;

// A backstabbed "older than breadcrumbMaxAgeMs" window. The default is 15min (src/memory/types.ts);
// we don't depend on the live clock here (the vignette grounds via explicit read tools, not the
// breadcrumb cache), but the constant documents the scenario premise.
const BREADCRUMB_MAX_AGE_MS = 15 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Shared server-suite scaffolding (temp cwd + mock Live + headless server).
// ─────────────────────────────────────────────────────────────────────────────

interface Suite {
  running: RunningServer;
  mock: MockLiveHandle;
  session: MockLiveSession;
  manager: any;
  tmpDir: string;
  prevCwd: string;
}

async function bootSuite(prefix: string): Promise<Suite> {
  process.env.NODE_ENV = "test";
  process.env.JANUS_NO_AUTOSTART = "1";

  // Isolate ALL .janus_* artifacts (ledger, history, interaction log) into a temp cwd BEFORE
  // importing ../server — server.ts resolves INTERACTION_LOG_PATH at module load relative to cwd.
  const prevCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.chdir(tmpDir);

  const { installMockLive, waitFor } = await import("./helpers/mockLive");
  const serverMod = await import("../server");

  const mock = installMockLive();
  const running = await serverMod.startServer({ port: 0, enableVite: false });

  // The server opens its live session lazily; trigger it by connecting nothing — startServer wires a
  // session on boot when JANUS has voice config. If no session exists yet, push a benign operator
  // utterance to force the live loop to instantiate, then await it.
  let session = mock.latest();
  if (!session) {
    // Some boots create the session only on first WS /live connect. Connect a lightweight client.
    const { WebSocket } = await import("ws");
    const client = new WebSocket(`ws://127.0.0.1:${running.port}/live`, {
      headers: { Cookie: `auth_token=${serverMod.API_AUTH_TOKEN}` },
    });
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => resolve());
      client.on("error", reject);
    });
    session = await waitFor(() => mock.latest());
    // Keep the socket open for the suite; closed in teardown via the server close.
    (running as any).__vignetteClient = client;
  }

  return { running, mock, session: session!, manager: running.manager, tmpDir, prevCwd };
}

async function teardownSuite(s: Suite): Promise<void> {
  const client = (s.running as any).__vignetteClient;
  if (client && client.readyState !== 3 /* CLOSED */) {
    await new Promise<void>((resolve) => {
      client.once("close", () => resolve());
      try { client.terminate(); } catch { resolve(); }
    });
  }
  await teardownServerSuite(s.running);
  process.chdir(s.prevCwd);
  try { fs.rmSync(s.tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/**
 * Register a ledger project + panes directly (no PTY) so per-pane reads/renames resolve a real id.
 *
 * The default backend is the SQLite-backed LedgerLike (the JanusStore IS the ledger — server.ts:534),
 * whose `workspaces` is a GETTER that rebuilds from the store, so a direct `workspaces[id].panes[..]=`
 * mutation is thrown away. Panes must be persisted via `savePane` (the store's pane upsert). We fall
 * back to the legacy in-memory Ledger shape (a plain `panes` map) when savePane is absent.
 */
function seedProject(
  manager: any,
  projectId: string,
  panes: Array<{ id: string; name?: string }>
): void {
  const ledger = manager.ledger;
  ledger.addProject(projectId, process.cwd(), `${projectId} summary`, []);
  if (typeof ledger.savePane === "function") {
    const now = Date.now();
    for (const p of panes) {
      ledger.savePane({
        pane_id: p.id,
        workspace_id: projectId,
        name: p.name ?? p.id,
        runtime_type: "shell",
        tool_preset: "Custom",
        permissions_mode: "Human-in-the-Loop",
        session_id: "",
        last_known_state: "Idle",
        is_busy: false,
        alive: false,
        context_size: 0,
        last_status_change_at: null,
        last_command: null,
        scrollback_path: null,
        created_at: now,
        updated_at: now,
      });
    }
  } else {
    const ws = ledger.workspaces[projectId];
    for (const p of panes) {
      ws.panes[p.id] = { id: p.id, name: p.name ?? p.id, notes: [], runtimeType: "shell" } as any;
    }
  }
  ledger.switchContext(projectId);
}

// ─────────────────────────────────────────────────────────────────────────────
// US-2.5 — no confabulation: a grounding call precedes any factual claim about a STALE pane.
// ─────────────────────────────────────────────────────────────────────────────
//
// Premise: project B's last activity is older than breadcrumbMaxAgeMs while project A is active. The
// operator asks about B's status. The agent must GROUND (list_panes / get_pane_summary /
// switch_context) BEFORE making any factual claim about B. We script that grounded sequence and
// assert the grounding-call-precedes-claim invariant holds for the SCRIPTED plumbing, and record the
// rate. (A LIVE model's reliability at choosing to ground is a separate live-eval; here we pin that
// the server-side trace faithfully records a grounded-first sequence so a regression that dropped or
// reordered the legs would be caught.)
describe("US-2.5 no-confabulation (grounding precedes claim about a stale pane)", () => {
  let s: Suite;
  before(async () => { s = await bootSuite("janus-us25-"); });
  after(async () => { await teardownSuite(s); });

  it("the scripted trace grounds (list_panes/get_pane_summary) BEFORE any claim about B", async () => {
    seedProject(s.manager, "proj_A", [{ id: "A1" }]);
    seedProject(s.manager, "proj_B", [{ id: "B1" }]);
    s.manager.ledger.switchContext("proj_A"); // A is active; B is the stale background project.

    const v: Vignette = {
      name: "US-2.5 stale-B status query",
      turns: [
        {
          utterance: `What's the status of project B? (its last activity is older than ${BREADCRUMB_MAX_AGE_MS}ms)`,
          targetPaneId: "B1",
          // Grounded sequence: orient first (list_panes), then read the SPECIFIC pane (get_pane_summary).
          // No factual-claim tool is emitted before a grounding read.
          toolCalls: [
            { name: "list_panes" },
            { name: "get_pane_summary", args: { pane_id: "B1" } },
          ],
          expectation: "a grounding read precedes any factual claim about B",
        },
      ],
    };

    const run = await runVignette(s.running, s.mock, v);
    const grounding = scoreGroundingPrecedesClaim(run);

    assert.ok(run.legs.length >= 2, `both scripted legs were reconstructed: ${run.legs.length}`);
    assert.strictEqual(
      grounding.rate >= MIN_GROUNDED_RATE,
      true,
      `grounded rate ${grounding.rate} >= ${MIN_GROUNDED_RATE} (perTurn=${JSON.stringify(grounding.perTurn)})`
    );
    // The B-pane read actually routed to B1 (so the claim it grounds is about B, not A).
    const bRead = run.legs.find((l) => l.name === "get_pane_summary");
    assert.strictEqual(bRead?.effectiveTarget, "B1", "the summary read targeted B1");
    // REPORT: with the current tooling the SCRIPTED grounding-first sequence is reliably recorded.
    // grounded rate == 1.0, scorableTurns == 1.
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-3.4 — name resolution (scored): "the API pane" resolves to the right pane id.
// ─────────────────────────────────────────────────────────────────────────────
//
// A pane is renamed "API". A turn addressing "the API pane" must resolve to that pane's id in
// get_pane_summary / propose_command calls. We model resolution as: the agent first renames the pane
// to "API" (rename_pane), looks it up, and the subsequent per-pane calls carry the resolved id. The
// score is RESOLUTION ACCURACY = fraction of "API pane" calls whose effective target is the correct
// id. (The mock model already knows the id we scripted; what we PIN is that the server records the
// resolved id on every leg so a regression that lost the pane_id would surface as a drop in accuracy.)
describe("US-3.4 name resolution (the 'API' pane resolves to its id)", () => {
  let s: Suite;
  before(async () => { s = await bootSuite("janus-us34-"); });
  after(async () => { await teardownSuite(s); });

  it("every 'API pane' call resolves to the correct pane id (resolution accuracy 100%)", async () => {
    const API_PANE_ID = "pane_api_7";
    seedProject(s.manager, "proj_api", [{ id: API_PANE_ID, name: "shell" }]);

    const v: Vignette = {
      name: "US-3.4 API pane resolution",
      turns: [
        {
          utterance: "Rename this pane to API, then show me what the API pane is doing.",
          targetPaneId: API_PANE_ID,
          toolCalls: [
            { name: "rename_pane", args: { project_id: "proj_api", pane_id: API_PANE_ID, name: "API" } },
            { name: "get_pane_summary", args: { pane_id: API_PANE_ID } },
            { name: "get_pane_command_history", args: { pane_id: API_PANE_ID } },
          ],
          expectation: "'the API pane' resolves to pane_api_7 on every per-pane leg",
        },
      ],
    };

    const run = await runVignette(s.running, s.mock, v);

    // Resolution accuracy over the per-pane legs (legs that name a pane_id target).
    const perPaneLegs = run.legs.filter((l) => l.effectiveTarget != null);
    const correct = perPaneLegs.filter((l) => l.effectiveTarget === API_PANE_ID).length;
    const accuracy = perPaneLegs.length === 0 ? 0 : correct / perPaneLegs.length;
    assert.ok(perPaneLegs.length >= 3, `all three pane-targeting legs reconstructed: ${perPaneLegs.length}`);
    assert.strictEqual(accuracy, 1, `resolution accuracy ${accuracy} == 1 (all 'API pane' calls hit ${API_PANE_ID})`);

    // The rename actually took in the ledger — the name "API" is now bound to the id.
    assert.strictEqual(
      s.manager.ledger.workspaces["proj_api"].panes[API_PANE_ID].name,
      "API",
      "the pane is now named 'API' in the ledger"
    );
    // REPORT: resolution accuracy 1.0 (3/3 legs). Threshold: == 1 (deterministic id routing).
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-3.5 — interleaved attribution: a dialogue alternating pane-A and pane-B every turn.
// ─────────────────────────────────────────────────────────────────────────────
//
// Reconstruct by interaction_id and assert each tool_call leg targets the pane named in ITS turn.
// Score = mis-attribution rate. Threshold 0 (deterministic server routing). This is the core
// "did the right turn's pane get the right action" pin — the interleaving is exactly the case where
// a turn-id/attribution regression would manifest as cross-talk between A and B.
describe("US-3.5 interleaved attribution (alternating A/B turns)", () => {
  let s: Suite;
  before(async () => { s = await bootSuite("janus-us35-"); });
  after(async () => { await teardownSuite(s); });

  it("each turn's tool_call leg targets the pane named for that turn (mis-attribution rate 0)", async () => {
    seedProject(s.manager, "proj_ab", [{ id: "paneA" }, { id: "paneB" }]);

    // Six turns alternating A,B,A,B,A,B — each turn reads + (history-reads) its OWN pane.
    const turns = [];
    for (let i = 0; i < 6; i++) {
      const target = i % 2 === 0 ? "paneA" : "paneB";
      turns.push({
        utterance: `Turn ${i + 1}: check pane ${target}.`,
        targetPaneId: target,
        toolCalls: [
          { name: "get_pane_summary", args: { pane_id: target } },
          { name: "get_pane_command_history", args: { pane_id: target } },
        ],
        expectation: `both legs target ${target}`,
      });
    }
    const v: Vignette = { name: "US-3.5 interleaved A/B", turns };

    const run = await runVignette(s.running, s.mock, v);
    const score = scoreAttribution(run);

    // Reconstruction sanity: 6 turns * 2 calls = 12 scorable legs, each under its OWN interaction_id.
    assert.strictEqual(score.total, 12, `12 pane-targeting legs scored (got ${score.total})`);
    const distinctIxn = new Set(run.legs.map((l) => l.interactionId));
    assert.strictEqual(distinctIxn.size, 6, `6 distinct interaction_ids (one per turn): ${distinctIxn.size}`);

    assert.strictEqual(
      score.rate <= MAX_MISATTRIBUTION_RATE,
      true,
      `mis-attribution rate ${score.rate} <= ${MAX_MISATTRIBUTION_RATE}; offenders=${JSON.stringify(
        score.offenders.map((o) => ({ turn: o.turnIndex, named: run.vignette.turns[o.turnIndex].targetPaneId, got: o.effectiveTarget }))
      )}`
    );
    // REPORT: mis-attribution rate 0/12 == 0. Threshold MAX_MISATTRIBUTION_RATE = 0 (deterministic routing).
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-4.2 — scored "what was I doing": answer is pulled from notes/history, not invented.
// ─────────────────────────────────────────────────────────────────────────────
//
// All pane activity is older than breadcrumbMaxAgeMs. The operator asks "what was I doing?". The
// answer must be sourced from notes/history content. We seed REAL history into .janus_history.json
// (read back by get_pane_command_history) and a ledger note, then script the recall turn and assert
// the trace PULLS from those grounding tools and that the returned content is the seeded (non-
// invented) content — verifiable in the reconstructed legs (resultKind ok + the actual output).
describe("US-4.2 'what was I doing' (answer grounded in notes/history, not invented)", () => {
  let s: Suite;
  before(async () => { s = await bootSuite("janus-us42-"); });
  after(async () => { await teardownSuite(s); });

  it("the recall turn pulls from get_pane_command_history (returns the SEEDED history, not invented)", async () => {
    const PANE = "work_pane";
    seedProject(s.manager, "proj_work", [{ id: PANE }]);
    s.manager.ledger.addPaneNote("proj_work", PANE, "Was mid-refactor of the auth middleware.");

    // Seed REAL history (older than breadcrumbMaxAgeMs) so get_pane_command_history returns it from
    // .janus_history.json (the file fallback the read uses when no live HistoryManager bridge exists).
    const SEEDED_CMD = "npm run test:auth";
    const SEEDED_FINAL = "auth suite: 12 passing, 1 failing (token refresh)";
    const staleTs = new Date(Date.now() - BREADCRUMB_MAX_AGE_MS - 60_000).toISOString();
    const historyFile = path.join(process.cwd(), ".janus_history.json");
    fs.writeFileSync(
      historyFile,
      JSON.stringify({
        [PANE]: [{ command: SEEDED_CMD, timestamp: staleTs, output: "", finalResponse: SEEDED_FINAL }],
      })
    );

    const v: Vignette = {
      name: "US-4.2 what was I doing",
      turns: [
        {
          utterance: "What was I doing? It's been a while.",
          targetPaneId: PANE,
          // Pull from grounding/recall tools — orient, then read the pane's recorded command history.
          toolCalls: [
            { name: "list_panes" },
            { name: "get_pane_command_history", args: { pane_id: PANE } },
          ],
          expectation: "the answer is sourced from recorded history, not invented",
        },
      ],
    };

    const run = await runVignette(s.running, s.mock, v);
    const grounding = scoreGroundingPrecedesClaim(run);

    // The recall turn led with grounding/recall tools (no invented-claim tool ran first).
    assert.ok(grounding.rate >= MIN_GROUNDED_RATE, `grounded rate ${grounding.rate} is below the threshold ${MIN_GROUNDED_RATE}`);

    // The history read returned the SEEDED content — verifiable in the leg's result + the tool output.
    const histLeg = run.legs.find((l) => l.name === "get_pane_command_history");
    assert.ok(histLeg, "a get_pane_command_history leg was reconstructed");
    assert.strictEqual(histLeg!.resultKind, "ok", "the history read succeeded");
    const histResult = run.results.find((r) => r.name === "get_pane_command_history");
    const serialized = JSON.stringify(histResult?.output ?? "");
    assert.ok(
      serialized.includes(SEEDED_CMD) && serialized.includes(SEEDED_FINAL),
      `the answer carries the SEEDED history (not invented): ${serialized}`
    );
    // REPORT: grounded rate 1.0; the recall pulled the seeded command + final response from history.
  });
});
