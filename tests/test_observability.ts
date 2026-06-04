// tests/test_observability.ts
// Wave D (PLM2 + PLM5) — the two READ-ONLY observability tools: get_action_log + get_health.
//
// Pure handler tests over a minimal ActionContext stub (only the fields the two handlers touch),
// plus a real in-memory JanusStore so the action_log path is exercised end-to-end. No server boot,
// no Gemini key, no PTY.
//
// Runner: npx tsx --test --test-force-exit tests/test_observability.ts

import { describe, it } from "node:test";
import assert from "node:assert";

import { REGISTRY } from "../src/actions/registry";
import { getActionLog, getHealth } from "../src/actions/defs/observability";
import type { ActionContext, ActionResult } from "../src/actions/types";
import { JanusStore } from "../src/store/sqliteStore";

// ─────────────────────────────────────────────────────────────────────────────
// A minimal ActionContext stub. The two observability handlers touch only:
//   manager.terminals, session, store, pendingApprovals (only on non-null session), isFrozen.
// Everything else is cast away — these handlers never reach the other fields.
// ─────────────────────────────────────────────────────────────────────────────
function makeCtx(opts: {
  terminals?: Record<string, { status?: string }>;
  store?: JanusStore | null;
  frozen?: boolean;
  session?: unknown;
  pendingForSession?: number;
} = {}): ActionContext {
  const pendingCount = opts.pendingForSession ?? 0;
  return {
    manager: { terminals: opts.terminals ?? {} },
    session: opts.session ?? null,
    store: opts.store ?? null,
    isFrozen: () => opts.frozen ?? false,
    // forSession is only consulted when session is non-null; return a fixed-length array.
    pendingApprovals: { forSession: (_s: unknown) => new Array(pendingCount).fill({}) },
  } as unknown as ActionContext;
}

const run = (def: { handler: (a: any, c: ActionContext) => ActionResult | Promise<ActionResult> }, args: any, ctx: ActionContext) =>
  def.handler(args, ctx) as ActionResult;

// ─────────────────────────────────────────────────────────────────────────────
// (a) get_action_log with no durable store
// ─────────────────────────────────────────────────────────────────────────────
describe("get_action_log", () => {
  it("(a) returns { rows: [] } + a note when ctx.store is null", () => {
    const result = run(getActionLog, {}, makeCtx({ store: null }));
    assert.strictEqual(result.kind, "ok");
    const out = (result as { output: { rows: unknown[]; note?: string } }).output;
    assert.deepStrictEqual(out.rows, []);
    assert.strictEqual(out.note, "no durable store wired");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // (b) get_action_log with a real in-memory store
  // ───────────────────────────────────────────────────────────────────────────
  it("(b) returns recorded rows most-recent-first; name filter narrows", () => {
    const store = new JanusStore(":memory:");
    store.init();
    store.recordAction({ name: "create_pane", capability: "spawn_pane", result_kind: "ok", ms: 5 });
    store.recordAction({ name: "list_panes", capability: "read_pane", result_kind: "ok", ms: 1 });
    store.recordAction({ name: "create_pane", capability: "spawn_pane", result_kind: "error", ms: 9 });

    const ctx = makeCtx({ store });

    // No filter: all rows, most-recent-first (insertion order create_pane,list_panes,create_pane →
    // read order create_pane(error), list_panes, create_pane(ok)).
    const all = run(getActionLog, {}, ctx);
    assert.strictEqual(all.kind, "ok");
    const allRows = (all as { output: { rows: Array<{ name: string; result_kind: string }> } }).output.rows;
    assert.deepStrictEqual(allRows.map((r) => r.name), ["create_pane", "list_panes", "create_pane"]);
    assert.deepStrictEqual(allRows.map((r) => r.result_kind), ["error", "ok", "ok"]);

    // name filter narrows to just the two create_pane rows, still newest-first.
    const filtered = run(getActionLog, { name: "create_pane" }, ctx);
    const filteredRows = (filtered as { output: { rows: Array<{ name: string; result_kind: string }> } }).output.rows;
    assert.strictEqual(filteredRows.length, 2);
    assert.ok(filteredRows.every((r) => r.name === "create_pane"));
    assert.deepStrictEqual(filteredRows.map((r) => r.result_kind), ["error", "ok"]);

    store.close();
  });

  it("(b') limit coerces (REST query-string style) and caps the row count", () => {
    const store = new JanusStore(":memory:");
    store.init();
    for (let i = 0; i < 4; i++) store.recordAction({ name: `n${i}`, capability: "c", result_kind: "ok", ms: i });
    const ctx = makeCtx({ store });
    // z.coerce.number → a REST "2" query string coerces to the number 2. runAction parses args through
    // def.params before calling the handler, so reproduce that boundary here (the handler itself sees
    // the already-coerced value; coercion is the schema's job, not the handler's).
    const parsed = getActionLog.params.parse({ limit: "2" });
    assert.strictEqual(parsed.limit, 2, "z.coerce.number coerces the REST query string to a number");
    const limited = run(getActionLog, parsed, ctx);
    const rows = (limited as { output: { rows: unknown[] } }).output.rows;
    assert.strictEqual(rows.length, 2);
    store.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (c) get_health
// ─────────────────────────────────────────────────────────────────────────────
describe("get_health", () => {
  it("(c) reports pane counts, frozen state, and error_rate from the action log", () => {
    const store = new JanusStore(":memory:");
    store.init();
    store.recordAction({ name: "a", capability: "c", result_kind: "ok", ms: 1 });
    store.recordAction({ name: "b", capability: "c", result_kind: "error", ms: 1 });

    const ctx = makeCtx({
      terminals: {
        p1: { status: "Running" },
        p2: { status: "running" },
        p3: { status: "Exited" },
        p4: { status: "Idle" },
        p5: {}, // missing status → counted as idle
      },
      store,
      frozen: true,
    });

    const result = run(getHealth, {}, ctx);
    assert.strictEqual(result.kind, "ok");
    const out = (result as {
      output: {
        frozen: boolean;
        panes: { total: number; running: number; idle: number; exited: number };
        pending_approvals: number;
        recent: { total: number; errors: number; error_rate: number };
      };
    }).output;

    assert.strictEqual(out.frozen, true, "frozen reflects ctx.isFrozen()");
    assert.deepStrictEqual(out.panes, { total: 5, running: 2, idle: 2, exited: 1 });
    // session is null in this ctx → pending approvals reported as 0 (REST surface contract).
    assert.strictEqual(out.pending_approvals, 0);
    assert.strictEqual(out.recent.total, 2);
    assert.strictEqual(out.recent.errors, 1);
    assert.ok(out.recent.error_rate > 0, "one error row → error_rate > 0");
    assert.strictEqual(out.recent.error_rate, 0.5);

    store.close();
  });

  it("(c') error_rate is 0 with no store, and pending_approvals reflects the session store", () => {
    const ctx = makeCtx({ session: { sendToolResponse: () => {} }, pendingForSession: 3, store: null });
    const out = (run(getHealth, {}, ctx) as { output: { pending_approvals: number; recent: { error_rate: number } } }).output;
    assert.strictEqual(out.pending_approvals, 3, "non-null session → forSession length is reported");
    assert.strictEqual(out.recent.error_rate, 0, "no store → no recent rows → error_rate 0 (no divide-by-zero)");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (d) both defs are registered and born multi-surface (voice + rest) with a rest binding
// ─────────────────────────────────────────────────────────────────────────────
describe("registry wiring", () => {
  it("(d) get_action_log + get_health are present in REGISTRY, voice+rest, with a rest binding", () => {
    for (const name of ["get_action_log", "get_health"]) {
      const def = REGISTRY.find((d) => d.name === name);
      assert.ok(def, `${name} missing from REGISTRY`);
      assert.ok(def!.surfaces.has("voice"), `${name} must be a voice surface`);
      assert.ok(def!.surfaces.has("rest"), `${name} must be a rest surface`);
      assert.ok(def!.rest, `${name} must carry a rest binding`);
      assert.strictEqual(def!.rest!.method, "get", `${name} rest binding is a GET`);
      assert.ok(def!.readOnly, `${name} must be readOnly`);
      assert.strictEqual(def!.capability, "read_notes", `${name} matrix row is read_notes`);
    }
  });
});
