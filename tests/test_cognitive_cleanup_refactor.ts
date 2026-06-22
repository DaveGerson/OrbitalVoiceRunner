// tests/test_cognitive_cleanup_refactor.ts
//
// Cognitive-complexity burndown PIN — advisory-warning tier (sonarjs/cognitive-complexity >15).
// Pins the CURRENT behavior of three functions before verbatim, behavior-preserving extraction:
//
//   1. executePlan.toHttp (orchestration.ts:148) — outcome→status mapping (pure, every branch)
//   2. runLiveSignal (applyPaneMode.ts:123) — live-signal loop via fake PaneLike (every branch:
//      converge on marker, converge on parsed mode, timeout, multi-step)
//   3. formatPaneSignal (paneSignals.ts:44) — every kind branch in the verb chain (pure)
//
// These tests run GREEN against the EXISTING code and must remain GREEN after the refactor.
// The existing test suites (test_pane_signals.ts, test_orchestration_complexity_refactor.ts,
// test_apply_pane_mode.ts) are the primary coverage; these are additive tripwires targeting the
// specific extractable pieces.

import { describe, it } from "node:test";
import assert from "node:assert";

// ══════════════════════════════════════════════════════════════════════════════
// 1. executePlan.toHttp — outcome→status map (orchestration.ts)
//
// The toHttp function reads `result.meta.outcome` (an ExecutePlanOutcome) and maps it to an HTTP
// status code. There are 6 named outcomes + a defensive default. This test drives the real toHttp
// via the executePlan.rest.toHttp property (without booting a server) to pin every branch.
// ══════════════════════════════════════════════════════════════════════════════
import { executePlan } from "../src/actions/defs/orchestration";
import type { ActionResult } from "../src/actions/types";

describe("executePlan.toHttp — outcome→status mapping (every branch)", () => {
  const toHttp = executePlan.rest!.toHttp!;

  function okResult(outcome: string | undefined): ActionResult {
    return { kind: "ok", output: "msg", meta: outcome !== undefined ? { outcome } : {} } as unknown as ActionResult;
  }

  it("outcome 'executed' -> 200", () => {
    assert.strictEqual(toHttp(okResult("executed"), {}).status, 200);
  });

  it("outcome 'pending' -> 202", () => {
    assert.strictEqual(toHttp(okResult("pending"), {}).status, 202);
  });

  it("outcome 'blocked' -> 403", () => {
    assert.strictEqual(toHttp(okResult("blocked"), {}).status, 403);
  });

  it("outcome 'pane_offline' -> 400", () => {
    assert.strictEqual(toHttp(okResult("pane_offline"), {}).status, 400);
  });

  it("outcome 'plan_not_found' -> 404", () => {
    assert.strictEqual(toHttp(okResult("plan_not_found"), {}).status, 404);
  });

  it("outcome 'clarify' -> 409", () => {
    assert.strictEqual(toHttp(okResult("clarify"), {}).status, 409);
  });

  it("outcome undefined (no meta) -> 200 (defensive default)", () => {
    assert.strictEqual(toHttp(okResult(undefined), {}).status, 200);
  });

  it("result.kind !== 'ok' -> outcome undefined -> 200; body is { error: ... }", () => {
    const r: ActionResult = { kind: "blocked", reason: "off" };
    const { status, body } = toHttp(r, {});
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, { error: "execute_plan failed" });
  });

  it("kind 'ok' body echoes output string", () => {
    const { body } = toHttp(okResult("executed"), {});
    assert.deepStrictEqual(body, { output: "msg" });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. runLiveSignal (applyPaneMode.ts)
//
// runLiveSignal is NOT exported; we pin it via the public applyPaneMode entry point using the
// same fake-pane harness as test_apply_pane_mode.ts, targeting just the branches that belong to
// the live-signal sub-path: converge on parseCurrentMode, converge on expectMarker, timeout with
// no convergence, and a multi-step sequence. The existing test_apply_pane_mode.ts already covers
// the full applyPaneMode call graph; these tests are additive and laser-focused on runLiveSignal
// behavior. Since runLiveSignal is the non-exported inner helper, we exercise it by forcing the
// adapter to return a live-signal plan.
// ══════════════════════════════════════════════════════════════════════════════
import { applyPaneMode, type PaneLike, type PaneModeDeps } from "../src/applyPaneMode";
import { PendingApprovalStore } from "../src/pendingApprovals";
import { PendingActionStore } from "../src/pendingActions";
import type { Mode } from "../src/agents";
import type { AgentAdapter } from "../src/agents";

/** A fake adapter that always returns a live-signal plan with the given steps. */
function makeLiveSignalAdapter(
  steps: { bytes: string; expectMarker?: RegExp }[],
  /** What parseCurrentMode returns after a write — controls "parsed mode convergence". */
  parsedModeAfterWrite: Mode | null,
): AgentAdapter {
  return {
    planModeChange: (_from: Mode, _to: Mode) => ({
      kind: "live-signal" as const,
      steps,
    }),
    parseCurrentMode: () => parsedModeAfterWrite,
    buildResumeCommand: () => ({ argv: ["claude"] }),
    pinnedSessionId: () => null,
    idleSignals: () => [],
    errorSignals: () => [],
    promptSignals: () => [],
    name: "fake-live-signal",
  } as unknown as AgentAdapter;
}

function makeFakePane(
  adapter: AgentAdapter,
  frameAfterWrite: string,
): PaneLike & { writes: string[] } {
  const writes: string[] = [];
  let landed = false;
  return {
    adapter,
    permissionsMode: "Human-in-the-Loop" as Mode,
    sessionId: "",
    shellCmd: "claude",
    writes,
    writeRaw(bytes: string) { writes.push(bytes); landed = true; },
    getRecentOutput() { return landed ? frameAfterWrite : ""; },
    async stop() {},
    start() {},
  };
}

function makeDeps(term: PaneLike): PaneModeDeps {
  return {
    gateOrDefer: (_cap, _pane, _summary, run) => { run(); return { disposition: "run" as const }; },
    pendingApprovals: new PendingApprovalStore(),
    pendingActions: new PendingActionStore(),
    broadcast: () => {},
    persistMode: () => {},
    readAfterWriteTimeoutMs: 200,
    readAfterWritePollMs: 5,
  };
}

describe("runLiveSignal via applyPaneMode — live-signal path branches", () => {
  it("converges via parseCurrentMode — ok:true, kind:live-signal", async () => {
    const adapter = makeLiveSignalAdapter(
      [{ bytes: "\x1b[Z" }],
      "Full Auto", // parseCurrentMode returns the target mode after write
    );
    const term = makeFakePane(adapter, "irrelevant");
    const deps = makeDeps(term);
    const result = await applyPaneMode("p1", "Full Auto", "voice", term, deps);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.kind, "live-signal");
    assert.strictEqual(term.writes.length, 1);
  });

  it("converges via expectMarker — ok:true, kind:live-signal", async () => {
    const marker = /FULL_AUTO_MODE/;
    const adapter = makeLiveSignalAdapter(
      [{ bytes: "\x1b[Z", expectMarker: marker }],
      null, // parseCurrentMode returns null, but expectMarker wins
    );
    const term = makeFakePane(adapter, "...FULL_AUTO_MODE...");
    const deps = makeDeps(term);
    const result = await applyPaneMode("p2", "Full Auto", "voice", term, deps);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.kind, "live-signal");
  });

  it("timeout — ok:false, kind:live-signal, reason mentions pane id", async () => {
    // parseCurrentMode never returns the target; expectMarker never matches
    const adapter = makeLiveSignalAdapter(
      [{ bytes: "\x1b[Z", expectMarker: /NEVER_MATCHES_XYZZY/ }],
      null,
    );
    const term = makeFakePane(adapter, "no match here");
    const deps = {
      ...makeDeps(term),
      readAfterWriteTimeoutMs: 10, // very tight — will timeout quickly
    };
    const result = await applyPaneMode("p3", "Full Auto", "voice", term, deps);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, "live-signal");
    assert.match(result.reason ?? "", /p3/);
    assert.match(result.reason ?? "", /timed out|timeout/i);
  });

  it("multi-step: both steps written in order on convergence", async () => {
    const writes: string[] = [];
    // Adapter with two steps; frame changes after each write.
    const step1Marker = /STEP1_DONE/;
    const step2Marker = /STEP2_DONE/;
    const adapter = makeLiveSignalAdapter(
      [
        { bytes: "BYTE1", expectMarker: step1Marker },
        { bytes: "BYTE2", expectMarker: step2Marker },
      ],
      null,
    );
    let writeCount = 0;
    const term: PaneLike & { writes: string[] } = {
      adapter,
      permissionsMode: "Human-in-the-Loop" as Mode,
      sessionId: "",
      shellCmd: "claude",
      writes,
      writeRaw(bytes: string) { writes.push(bytes); writeCount++; },
      getRecentOutput() {
        if (writeCount >= 2) return "STEP1_DONE STEP2_DONE";
        if (writeCount >= 1) return "STEP1_DONE";
        return "";
      },
      async stop() {},
      start() {},
    };
    const deps = makeDeps(term);
    const result = await applyPaneMode("p4", "Full Auto", "voice", term, deps);
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(writes, ["BYTE1", "BYTE2"]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. formatPaneSignal — every kind in the verb chain (paneSignals.ts)
//
// The ternary chain covers 8 named kinds + default. The existing test_pane_signals.ts covers a
// subset; these tests exhaustively pin every branch so any change to the verb table is caught.
// ══════════════════════════════════════════════════════════════════════════════
import { formatPaneSignal } from "../src/paneSignals";
import type { PaneSignalKind } from "../src/paneSignals";

describe("formatPaneSignal — every kind branch (exhaustive verb table pin)", () => {
  const PANE = "test-pane";

  function fmt(kind: PaneSignalKind, detail?: string): string {
    return formatPaneSignal({ paneId: PANE, kind, detail });
  }

  it("kind 'created' — verb contains 'up and ready'", () => {
    assert.match(fmt("created"), /up and ready/);
  });

  it("kind 'closed' — verb contains 'exited and archived'", () => {
    assert.match(fmt("closed"), /exited and archived/);
  });

  it("kind 'idle' — verb contains 'went idle'", () => {
    assert.match(fmt("idle"), /went idle/);
  });

  it("kind 'error' — verb contains 'reported an error'", () => {
    assert.match(fmt("error"), /reported an error/);
  });

  it("kind 'prompt' — verb contains 'waiting at a prompt'", () => {
    assert.match(fmt("prompt"), /waiting at a prompt/);
  });

  it("kind 'running' — verb contains 'started working' or 'cooking'", () => {
    assert.match(fmt("running"), /started working|cooking/i);
  });

  it("kind 'quiescing' — verb contains 'wrapping up' or 'cooking'", () => {
    assert.match(fmt("quiescing"), /wrapping up|cooking/i);
  });

  it("kind 'exited' (explicit) — verb is 'exited'", () => {
    assert.match(fmt("exited"), /\bexited\b/i);
  });

  it("detail appended with ': ' separator when present", () => {
    const text = fmt("error", "boom");
    assert.match(text, /: boom/);
    assert.match(text, /test-pane/);
  });

  it("no detail → no trailing ': '", () => {
    const text = fmt("idle");
    assert.doesNotMatch(text, /: $/);
  });

  it("pane id always present in output", () => {
    const kinds: PaneSignalKind[] = ["idle", "error", "prompt", "exited", "created", "running", "quiescing", "closed"];
    for (const kind of kinds) {
      assert.match(fmt(kind), new RegExp(PANE), `kind '${kind}' should include pane id`);
    }
  });
});
