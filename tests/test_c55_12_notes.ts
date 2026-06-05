/**
 * tests/test_c55_12_notes.ts — c55.12 (wsm-e2e-pinned-c55.12): converge the 6 inline operator-UI
 * note/context routes into rest-only ActionDefs. Each is a faithful port of the inline handler:
 * UNGATED (ALWAYS_ALLOWED), readOnly:false, unredacted. Same doctrine as c55.11/Batch F: run the real
 * choke-point with a fake ctx, assert the ActionResult, then assert applyResultToHttp maps it to
 * {status, body}. Writes use the default {output} map (UI ignores the body, repaints off ledger_updated);
 * the GET feed rides rest.toHttp to emit {notes:[…]} top-level (the legacy shape).
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { REGISTRY } from "../src/actions/registry";
import { runAction } from "../src/actions/gemini";
import { applyResultToHttp, type RestResponse } from "../src/actions/rest";
import { INTENTIONAL_ASYMMETRY } from "../src/actions/coverage";
import type { ActionContext, ActionDef, ActionResult } from "../src/actions/types";

function makeFakeRes(): { res: RestResponse; sent: { status?: number; json?: unknown } } {
  const sent: { status?: number; json?: unknown } = {};
  const res: RestResponse = { status(c: number) { sent.status = c; return res; }, json(p: unknown) { sent.json = p; return undefined; } };
  return { res, sent };
}
function findDef(name: string): ActionDef {
  const def = REGISTRY.find((d) => d.name === name);
  assert.ok(def, `registry must contain a def named '${name}'`);
  return def!;
}
async function runToHttp(name: string, args: Record<string, unknown>, ctx: ActionContext) {
  const def = findDef(name);
  const result = await runAction(REGISTRY, name, args, ctx);
  const { res, sent } = makeFakeRes();
  applyResultToHttp(def, result, args, res);
  return { result, status: sent.status, json: sent.json };
}

// A fake ledger that records calls so we can assert the handler hit the right method with the right args.
function makeCtx(): { ctx: ActionContext; calls: string[]; notes: unknown[] } {
  const calls: string[] = [];
  const notes: unknown[] = [{ id: "n1", pane_id: null, type: "note", created_at: "t", text: "secret AKIAxxx" }];
  const ledger: any = {
    addNote: (p: string, n: string) => { calls.push(`addNote:${p}:${n}`); return { id: "n1" }; },
    getNotes: (q: { projectId: string }) => { calls.push(`getNotes:${q.projectId}`); return notes; },
    amendNote: (id: string, t: string) => { calls.push(`amendNote:${id}:${t}`); return { id }; },
    deleteNote: (id: string) => { calls.push(`deleteNote:${id}`); return true; },
    addPaneNote: (p: string, pane: string, n: string) => { calls.push(`addPaneNote:${p}:${pane}:${n}`); return { id: "n2" }; },
    addModelContext: (p: string, pane: string, t: string) => { calls.push(`addModelContext:${p}:${pane}:${t}`); return true; },
    addHumanContext: (p: string, pane: string, t: string) => { calls.push(`addHumanContext:${p}:${pane}:${t}`); return true; },
  };
  const ctx = {
    manager: { ledger }, session: null, surface: "rest",
    broadcastLedgerUpdate: () => { calls.push("broadcast"); },
    redact: (s: string) => `RED(${s})`, isFrozen: () => false, effectiveCapabilityGateFor: () => "Auto",
  } as unknown as ActionContext;
  return { ctx, calls, notes };
}

const SHAPE: Array<{ name: string; method: string; path: string }> = [
  { name: "create_project_note", method: "post", path: "/api/projects/:project_id/notes" },
  { name: "read_project_notes", method: "get", path: "/api/projects/:project_id/notes" },
  { name: "edit_note", method: "put", path: "/api/notes/:note_id" },
  { name: "remove_note", method: "delete", path: "/api/notes/:note_id" },
  { name: "create_pane_note", method: "post", path: "/api/projects/:project_id/panes/:pane_id/notes" },
  { name: "add_pane_context", method: "post", path: "/api/projects/:project_id/panes/:pane_id/context" },
];

describe("c55.12 — 6 rest-only note defs (shape + asymmetry)", () => {
  for (const { name, method, path: p } of SHAPE) {
    it(`${name} is rest-only ALWAYS_ALLOWED readOnly:false, binds ${method.toUpperCase()} ${p}, allow-listed`, () => {
      const def = findDef(name);
      assert.strictEqual(def.capability, "ALWAYS_ALLOWED", `${name} is ungated operator-UI`);
      assert.strictEqual(def.readOnly, false);
      assert.deepStrictEqual([...def.surfaces], ["rest"]);
      assert.deepStrictEqual(def.rest?.method, method);
      assert.deepStrictEqual(def.rest?.path, p);
      assert.deepStrictEqual(INTENTIONAL_ASYMMETRY[name], new Set(["rest"]), `${name} must be allow-listed rest-only`);
    });
  }
});

describe("c55.12 — fidelity: handlers hit the right ledger method + write defs broadcast", () => {
  it("create_project_note -> addNote + broadcast, 200", async () => {
    const { ctx, calls } = makeCtx();
    const { status } = await runToHttp("create_project_note", { project_id: "proj", note: "hi" }, ctx);
    assert.strictEqual(status, 200);
    assert.ok(calls.includes("addNote:proj:hi") && calls.includes("broadcast"));
  });
  it("read_project_notes -> getNotes, UNREDACTED {notes:[…]} TOP-LEVEL at 200", async () => {
    const { ctx, notes } = makeCtx();
    const { status, json } = await runToHttp("read_project_notes", { project_id: "proj" }, ctx);
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(json, { notes }, "raw {notes:[…]} top-level, byte-identical to the inline feed (NOT redacted, NOT {output})");
  });
  it("edit_note -> amendNote + broadcast, 200 (ungated)", async () => {
    const { ctx, calls } = makeCtx();
    const { status } = await runToHttp("edit_note", { note_id: "n1", text: "new" }, ctx);
    assert.strictEqual(status, 200);
    assert.ok(calls.includes("amendNote:n1:new") && calls.includes("broadcast"));
  });
  it("remove_note -> deleteNote + broadcast, 200 (ungated)", async () => {
    const { ctx, calls } = makeCtx();
    const { status } = await runToHttp("remove_note", { note_id: "n1" }, ctx);
    assert.strictEqual(status, 200);
    assert.ok(calls.includes("deleteNote:n1") && calls.includes("broadcast"));
  });
  it("create_pane_note -> addPaneNote + broadcast, 200", async () => {
    const { ctx, calls } = makeCtx();
    const { status } = await runToHttp("create_pane_note", { project_id: "proj", pane_id: "p1", note: "n" }, ctx);
    assert.strictEqual(status, 200);
    assert.ok(calls.includes("addPaneNote:proj:p1:n") && calls.includes("broadcast"));
  });
  it("add_pane_context layer=model -> addModelContext + broadcast, 200", async () => {
    const { ctx, calls } = makeCtx();
    const { status } = await runToHttp("add_pane_context", { project_id: "proj", pane_id: "p1", text: "ctx", layer: "model" }, ctx);
    assert.strictEqual(status, 200);
    assert.ok(calls.includes("addModelContext:proj:p1:ctx") && calls.includes("broadcast"));
  });
  it("add_pane_context (no layer) -> addHumanContext + broadcast, 200", async () => {
    const { ctx, calls } = makeCtx();
    const { status } = await runToHttp("add_pane_context", { project_id: "proj", pane_id: "p1", text: "ctx" }, ctx);
    assert.strictEqual(status, 200);
    assert.ok(calls.includes("addHumanContext:proj:p1:ctx") && calls.includes("broadcast"));
  });
});
