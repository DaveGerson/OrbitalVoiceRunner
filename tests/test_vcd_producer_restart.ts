// tests/test_vcd_producer_restart.ts — fikj.11 RED, producer 2: the restart ACK-before-readiness
// claim records at ack time and RETRACTS on the async failure/cancel arms (which today only
// console.error — the operator is never told; co-design §D rank-5).
// Runner: npx tsx --test --test-force-exit tests/test_vcd_producer_restart.ts
import { test } from "node:test";
import assert from "node:assert";
import { respawnPane } from "../src/actions/defs/panes_rest";
import { buildActionRun } from "../src/actionEffects";

type AnyRec = Record<string, any>;
const tick = () => new Promise<void>(r => setImmediate(() => setImmediate(() => r())));

function captureLedger() {
  const records: AnyRec[] = [];
  const invalidations: AnyRec[] = [];
  return {
    records, invalidations,
    record: (c: AnyRec) => { records.push(c); },
    invalidate: (ref: string, groundTruth: string, opts?: AnyRec) => {
      invalidations.push({ ref, groundTruth, opts });
      return { corrected: true };
    },
    latestSpokenClaim: (_p: string) => undefined,
  };
}

function makeCtx(opts: { stopFails?: boolean; archiveDuringStop?: boolean; ledger?: boolean } = {}) {
  const ledger = captureLedger();
  const term: AnyRec = {
    projectId: "p1",
    started: false,
    stop: async () => {
      if (opts.stopFails) throw new Error("stop failed");
      if (opts.archiveDuringStop) ctx.manager.archivingPanes.add("t1");
    },
    start: () => { term.started = true; },
  };
  const ctx: AnyRec = {
    manager: {
      terminals: { t1: term },
      archivingPanes: new Set<string>(),
      ledger: { getProject: () => ({ id: "p1", panes: { t1: { id: "t1" } } }), getActiveProject: () => undefined },
      settings: { advanced: {} },
    },
    ...(opts.ledger === false ? {} : { correctionLedger: ledger }),
    gateOrDefer: (_cap: string, _pane: string, _summary: string, _run: () => string) => ({ disposition: "run" }),
    broadcastLedgerUpdate: () => {},
    broadcastTerminalsUpdated: () => {},
    broadcast: () => {},
  };
  return { ctx, ledger, term };
}

test("a live-terminal restart records ONE spoken restart claim; a clean restart never self-corrects", async () => {
  const { ctx, ledger, term } = makeCtx();
  const result: AnyRec = respawnPane.handler({ pane_id: "t1" } as any, ctx as any);
  assert.strictEqual(result.kind, "ok");
  assert.strictEqual(result.output, "Terminal t1 restarted.");
  assert.strictEqual(ledger.records.length, 1, "fikj.11 feature absent: the restart ack must record a claim");
  assert.strictEqual(ledger.records[0].kind, "restart");
  assert.strictEqual(ledger.records[0].paneId, "t1");
  assert.strictEqual(ledger.records[0].spoken, true, "the confirm string always reaches the invoking surface");
  assert.strictEqual(ledger.records[0].assertedText, "Terminal t1 restarted.");
  await tick();
  assert.strictEqual(term.started, true);
  assert.strictEqual(ledger.invalidations.length, 0, "negative fixture: a successful restart is never corrected");
});

test("a failed stop() RETRACTS the ack claim (exception severity, same claimId)", async () => {
  const { ctx, ledger } = makeCtx({ stopFails: true });
  respawnPane.handler({ pane_id: "t1" } as any, ctx as any);
  await tick();
  assert.strictEqual(ledger.invalidations.length, 1,
    "fikj.11 feature absent: the async failure arm must invalidate the restart claim");
  assert.strictEqual(ledger.invalidations[0].ref, ledger.records[0].claimId, "retracts by the SAME claim identity");
  assert.ok(ledger.invalidations[0].groundTruth.includes("failed"), "the ground truth names the failure");
  assert.deepStrictEqual(ledger.invalidations[0].opts, { severity: "exception" });
});

test("the kdtu 86-during-restart cancel RETRACTS the ack claim (restart never happened)", async () => {
  const { ctx, ledger, term } = makeCtx({ archiveDuringStop: true });
  respawnPane.handler({ pane_id: "t1" } as any, ctx as any);
  await tick();
  assert.strictEqual(term.started, false, "the guard held — no ghost PTY");
  assert.strictEqual(ledger.invalidations.length, 1);
  assert.ok(ledger.invalidations[0].groundTruth.includes("cancelled"), "the ground truth says cancelled, not failed");
});

test("no ledger on ctx (legacy) -> unchanged behavior, no throw", async () => {
  const { ctx } = makeCtx({ ledger: false, stopFails: true });
  const result: AnyRec = respawnPane.handler({ pane_id: "t1" } as any, ctx as any);
  assert.strictEqual(result.output, "Terminal t1 restarted.");
  await tick(); // the .catch console.errors — must not throw
});

test("the buildActionRun replay twin mirrors record + failure invalidate", async () => {
  const { ctx, ledger } = makeCtx({ stopFails: true });
  const deps: AnyRec = {
    manager: ctx.manager,
    broadcast: () => {},
    broadcastLedgerUpdate: () => {},
    sanitizeSettingsForClient: (s: AnyRec) => s,
    correctionLedger: ledger,
  };
  const out = buildActionRun({ capability: "restart_pane", params: { paneId: "t1" } } as any, deps as any)();
  assert.strictEqual(out, "Terminal t1 restarted.");
  assert.strictEqual(ledger.records.length, 1, "the replay records the claim too");
  await tick();
  assert.strictEqual(ledger.invalidations.length, 1, "the replay's failure arm retracts too");
});

test("the buildActionRun replay twin mirrors the CANCEL arm (86-during-restart -> cancelled retraction, no ghost PTY)", async () => {
  const { ctx, ledger, term } = makeCtx({ archiveDuringStop: true });
  const deps: AnyRec = {
    manager: ctx.manager,
    broadcast: () => {},
    broadcastLedgerUpdate: () => {},
    sanitizeSettingsForClient: (s: AnyRec) => s,
    correctionLedger: ledger,
  };
  const out = buildActionRun({ capability: "restart_pane", params: { paneId: "t1" } } as any, deps as any)();
  assert.strictEqual(out, "Terminal t1 restarted.");
  await tick();
  assert.strictEqual(term.started, false, "the replayed guard held — no ghost PTY");
  assert.strictEqual(ledger.invalidations.length, 1, "the replay's cancel arm retracts too");
  assert.strictEqual(ledger.invalidations[0].ref, ledger.records[0].claimId, "retracts by the SAME claim identity");
  assert.ok(ledger.invalidations[0].groundTruth.includes("cancelled"), "the ground truth says cancelled, not failed");
});
