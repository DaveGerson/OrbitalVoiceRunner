/**
 * tests/test_c55_16_attention_clear.ts — c55.16 terminal disposition of the
 * POST /api/attention/clear path-alias (the "dismiss ALL" alias of dismiss_attention).
 *
 * BINDING DECISION (opts-only-drop design §2 P-3, the recommended default; roadmap §1 item 4):
 *   /api/attention/clear is NOT a path collision — its registry counterpart dismiss_attention is
 *   mounted on the DISTINCT per-item path POST /api/attention/:id/dismiss (orient.ts:225). So the
 *   `clear` alias never trips the shadow guard and is OFF the opts.only critical path ("separate
 *   track"). It is a permanent, logic-free PATH ALIAS: the inline shim (server.ts) already routes
 *   EXECUTION through runAction('dismiss_attention', {}) — there is NO logic twin to drift, only the
 *   path. The minimal terminal disposition is therefore to KEEP the thin shim and re-categorize the
 *   catalog row from `held` -> `exception` (no multi-path rest binding is added in c55.16). This is
 *   the disposition that lets the eventual no-held-rows gate go green without inventing new surface.
 *
 * Three assertion layers (per the c55 verification doctrine):
 *   (1) CATALOG GUARD (drives the change) — INLINE_EXCEPTIONS lists { post, /api/attention/clear }
 *       with category 'exception' (NOT 'held'). RED before the downgrade, green after.
 *   (2) SHIM CONTRACT GUARD (server.ts as text) — the inline POST /api/attention/clear route SURVIVES
 *       and routes execution through runAction('dismiss_attention', ...) (the path-alias binding is
 *       preserved; no logic twin is introduced).
 *   (3) DEF BEHAVIOR — the mass-dismiss path the shim triggers (id omitted): count undismissed,
 *       forEach dismiss, prune, broadcast attention_updated, ok -> 200.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { REGISTRY } from "../src/actions/registry";
import { runAction } from "../src/actions/gemini";
import { resultToHttp, type RestResponse } from "../src/actions/rest";
import type { ActionContext, ActionResult } from "../src/actions/types";
import { INLINE_EXCEPTIONS } from "../src/actions/inlineExceptions";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(path.join(here, "..", "server.ts"), "utf8");

// ── fake response (records status + json) ───────────────────────────────────────────────────────
function makeFakeRes(): { res: RestResponse; sent: { status?: number; json?: unknown } } {
  const sent: { status?: number; json?: unknown } = {};
  const res: RestResponse = {
    status(code: number) {
      sent.status = code;
      return res;
    },
    json(payload: unknown) {
      sent.json = payload;
      return undefined;
    },
  };
  return { res, sent };
}

// ── fake ActionContext (records broadcasts + prune calls) ─────────────────────────────────────────
interface CtxProbe {
  broadcasts: unknown[];
  pruneCalls: number;
}

function makeCtx(attentionQueue: Array<{ id: string; dismissed: boolean }>): {
  ctx: ActionContext;
  probe: CtxProbe;
} {
  const probe: CtxProbe = { broadcasts: [], pruneCalls: 0 };
  const ctx = {
    redact: (s: string) => s,
    broadcast: (msg: unknown) => {
      probe.broadcasts.push(msg);
    },
    pruneAttention: (): void => {
      probe.pruneCalls += 1;
    },
    manager: { attentionQueue },
  } as unknown as ActionContext;
  return { ctx, probe };
}

async function runToHttp(
  rawArgs: Record<string, unknown>,
  ctx: ActionContext
): Promise<{ result: ActionResult; status?: number; json?: unknown }> {
  const result = await runAction(REGISTRY, "dismiss_attention", rawArgs, ctx);
  const { res, sent } = makeFakeRes();
  resultToHttp(result, res);
  return { result, status: sent.status, json: sent.json };
}

// ── (1) catalog guard — the held row is DOWNGRADED to exception (this drives the change) ──────────
describe("c55.16 attention/clear — inlineExceptions catalog guard", () => {
  it("INLINE_EXCEPTIONS lists { post, /api/attention/clear } as category 'exception' (not 'held')", () => {
    const row = INLINE_EXCEPTIONS.find((e) => e.method === "post" && e.path === "/api/attention/clear");
    assert.ok(row, "the /api/attention/clear catalog row must remain (the inline shim survives)");
    assert.strictEqual(
      row!.category,
      "exception",
      "the path-alias row must be downgraded held->exception (it is a permanent logic-free alias; " +
        "no registry def claims this path, so it never collides — this unblocks the no-held-rows gate)"
    );
  });

  it("has NO `held` rows in the catalog at all after the c55.16 dispositions", () => {
    const held = INLINE_EXCEPTIONS.filter((e) => e.category === "held")
      .map((e) => `${e.method} ${e.path}`)
      .sort();
    assert.deepStrictEqual(
      held,
      [],
      `Unresolved held row(s) remain — each must be converged (route+row deleted) or downgraded to ` +
        `'exception':\n  ${held.join("\n  ")}`
    );
  });
});

// ── (2) shim contract guard — the path-alias binding is preserved (server.ts as text) ─────────────
describe("c55.16 attention/clear — inline shim contract (path alias preserved)", () => {
  it("POST /api/attention/clear inline shim SURVIVES and routes through runAction('dismiss_attention')", () => {
    const m = /app\.post\(\s*["']\/api\/attention\/clear["'][\s\S]{0,400}?\}\s*\)\s*;/.exec(serverSrc);
    assert.ok(m, "the POST /api/attention/clear inline shim must still exist (it is a permanent path alias)");
    assert.ok(
      /runAction\(\s*REGISTRY\s*,\s*["']dismiss_attention["']\s*,\s*\{\s*\}/.test(m![0]),
      "the shim must route execution through runAction('dismiss_attention', {}) — the mass-dismiss path"
    );
  });
});

// ── (3) def behavior — the mass-dismiss path the shim triggers (id omitted) ──────────────────────
describe("c55.16 attention/clear — dismiss-all behavior via runAction('dismiss_attention', {})", () => {
  it("id omitted: dismisses ALL undismissed, prunes, broadcasts attention_updated, ok -> 200", async () => {
    const queue = [
      { id: "a", dismissed: false },
      { id: "b", dismissed: false },
      { id: "c", dismissed: true }, // already dismissed -> not counted, but still marked
    ];
    const { ctx, probe } = makeCtx(queue);
    const { result, status } = await runToHttp({}, ctx);

    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(status, 200);
    // count is the # UNDISMISSED before the mass dismiss (2 here).
    assert.match((result as { output: string }).output, /Dismissed all 2 pending attention items\./);
    assert.ok(queue.every((i) => i.dismissed), "every item must be marked dismissed");
    assert.strictEqual(probe.pruneCalls, 1, "the def must prune the queue once");
    assert.ok(
      probe.broadcasts.some((m) => (m as { type?: string }).type === "attention_updated"),
      "dismiss-all must broadcast attention_updated (the WS frame the client repaints from)"
    );
  });

  it("singular narration: exactly one undismissed item -> 'item' (no plural)", async () => {
    const queue = [{ id: "only", dismissed: false }];
    const { ctx } = makeCtx(queue);
    const { result } = await runToHttp({}, ctx);
    assert.match((result as { output: string }).output, /Dismissed all 1 pending attention item\./);
  });
});
