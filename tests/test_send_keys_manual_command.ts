// tests/test_send_keys_manual_command.ts
//
// Phase 5.5 (release review; closes the 4.5 finding "ExchangeService.recordManualCommand has zero
// call sites"): send_keys — the one gated write lane that deliberately carries NO exchange (spine
// spec §5: legacy/manual entries stay exchange_id-less forever) — now records each manual command
// into the correlator's per-pane command log, exchangeId: null by contract. The wiring must be
// PURE BOOKKEEPING: it never touches the pane's active-exchange binding and never advances any
// exchange lifecycle (the correlation contract pinned by tests/test_exchange_correlation.ts).
//
// Runner: npx tsx --test --test-force-exit tests/test_send_keys_manual_command.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";

// Must be set BEFORE the first import of anything touching src/exchanges/flag.ts in THIS process —
// the flag caches its mode at module load (tests/test_return_channel_journeys.ts's documented
// idiom). `node --test` runs each test FILE as its own process, so this cannot leak elsewhere.
process.env.JANUS_EXCHANGE_SPINE = "shadow";

const { REGISTRY } = await import("../src/actions/registry");
const { runAction } = await import("../src/actions/gemini");
const { getExchangeService, resetExchangeServiceForTests } = await import("../src/exchanges/spine");
type ActionContext = import("../src/actions/types").ActionContext;

/** Minimal ctx for send_keys (mirrors tests/test_panes_rest_c55.ts's harness, trimmed to what the
 *  send_keys handler reads): one fake live terminal, an Auto gate, no-op broadcasts. */
function makeCtx(terminalId: string): { ctx: ActionContext; inputs: string[] } {
  const inputs: string[] = [];
  const manager: any = {
    terminals: { [terminalId]: { writeInput: (s: string) => inputs.push(s) } },
    settings: {},
    ledger: { activeProjectId: null, getActiveProject: () => null, getProject: () => null },
  };
  const ctx = {
    manager,
    session: null,
    redact: (s: string) => s,
    isFrozen: () => false,
    broadcast: () => {},
    broadcastLedgerUpdate: () => {},
    broadcastTerminalsUpdated: () => {},
    gateOrDefer: (_cap: string, _paneId: string | null, _summary: string, _run: () => string) =>
      ({ disposition: "run" as const }),
  } as unknown as ActionContext;
  return { ctx, inputs };
}

/** Isolated cwd so the handler's .janus_history.json write never touches the repo's. */
async function withTempCwd<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sendkeys-manual-"));
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

describe("send_keys records a manual (exchange-less) command into the correlator's command log", () => {
  it("Auto-gated send_keys -> commandLog entry with exchangeId null; the PTY write still happens", async () => {
    await withTempCwd(async () => {
      resetExchangeServiceForTests();
      const { ctx, inputs } = makeCtx("pane-1");
      const result = await runAction(REGISTRY, "send_keys", { pane_id: "pane-1", command: "git status" }, ctx);
      assert.equal(result.kind, "ok");
      assert.deepEqual(inputs, ["git status"], "the manual keystroke reaches the live PTY unchanged");
      assert.deepEqual(
        getExchangeService().commandLog("pane-1"),
        [{ command: "git status", exchangeId: null }],
        "recorded as a manual command — never adopted by any exchange",
      );
      resetExchangeServiceForTests();
    });
  });

  it("a manual send_keys write never advances the pane's active exchange (correlation contract)", async () => {
    await withTempCwd(async () => {
      resetExchangeServiceForTests();
      const svc = getExchangeService();
      // A delivered (in-flight) exchange occupies the pane's active binding.
      const snap = svc.createExchange({
        projectId: "proj-1", paneId: "pane-1",
        operatorUtterance: "run the tests", distilledInstruction: "npm test",
      });
      svc.stageForDelivery(snap.exchangeId);
      svc.recordDelivery(snap.exchangeId);
      assert.equal(svc.activeExchangeForPane("pane-1"), snap.exchangeId);

      const { ctx } = makeCtx("pane-1");
      await runAction(REGISTRY, "send_keys", { pane_id: "pane-1", command: "npm test" }, ctx);

      assert.equal(svc.get(snap.exchangeId)!.state, "delivered", "the manual write is not an exchange event");
      assert.equal(svc.activeExchangeForPane("pane-1"), snap.exchangeId, "the active binding is untouched");
      assert.deepEqual(
        svc.commandLog("pane-1").map((e) => e.exchangeId),
        [snap.exchangeId, null],
        "byte-identical manual text stays uncorrelated even right after a real delivery",
      );
      resetExchangeServiceForTests();
    });
  });
});
