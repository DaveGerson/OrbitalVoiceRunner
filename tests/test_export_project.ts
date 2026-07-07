/**
 * tests/test_export_project.ts — hwu.6: the deterministic project export (composer + voice + REST).
 *
 * TDD per project convention: this suite was written and run RED (before src/actions/defs/export.ts
 * existed) then GREEN against the implementation. Standalone registry — EXPORT_ACTIONS is passed
 * directly to runAction/mountRestRoutes (the canonical REGISTRY is integrator-owned; this task builds
 * + unit-tests its ActionDefs directly, per the file-ownership rules).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runAction } from "../src/actions/gemini";
import { applyResultToHttp, type RestResponse } from "../src/actions/rest";
import type { ActionContext, ActionDef, ActionResult, GateDisposition } from "../src/actions/types";
import type { StoredNote } from "../src/store/types";
import type { StoredEvent } from "../src/store/eventTypes";
import type { Workspace, Plan } from "../src/types";
import {
  EXPORT_ACTIONS,
  EXPORT_BASENAME,
  EXPORT_HISTORY_CAP,
  composeExportMarkdown,
  buildExportSnapshot,
  writeExportArtifactAtomic,
  redactForExport,
  type ExportProjectSnapshot,
} from "../src/actions/defs/export";

function findDef(name: string): ActionDef {
  const def = EXPORT_ACTIONS.find((d) => d.name === name);
  assert.ok(def, `EXPORT_ACTIONS must contain '${name}'`);
  return def!;
}

// ── Fake REST response double (same idiom as tests/test_c55_*.ts, PLUS set/send for hwu.6) ─────────
function makeFakeRes(): {
  res: RestResponse;
  sent: { status?: number; json?: unknown; headers?: Record<string, string>; sentBody?: string };
} {
  const sent: { status?: number; json?: unknown; headers?: Record<string, string>; sentBody?: string } = {};
  const res: RestResponse = {
    status(c: number) { sent.status = c; return res; },
    json(p: unknown) { sent.json = p; return undefined; },
    set(h: Record<string, string>) { sent.headers = { ...(sent.headers ?? {}), ...h }; return res; },
    send(b: string) { sent.sentBody = b; return undefined; },
  };
  return { res, sent };
}

function makePane(id: string, overrides: Partial<Workspace["panes"][string]> = {}): Workspace["panes"][string] {
  return {
    pane_id: id, name: `Pane ${id}`, runtime_type: "shell", last_known_state: "Idle",
    is_busy: false, alive: true, notes: [], permissions_mode: "Human-in-the-Loop",
    session_id: `sess-${id}`, tool_preset: "Claude Code", context_size: 0,
    ...overrides,
  };
}

interface FakeCtxOpts {
  tmpDir: string;
  notes?: StoredNote[];
  events?: StoredEvent[];
  plans?: Plan[];
  panes?: Record<string, Workspace["panes"][string]>;
  projectId?: string;
  gateDisposition?: GateDisposition;
  gateValue?: "Auto" | "Ask" | "Off";
  frozen?: boolean;
}

function makeCtx(opts: FakeCtxOpts): { ctx: ActionContext; calls: string[] } {
  const calls: string[] = [];
  const projectId = opts.projectId ?? "proj1";
  const project: Workspace = {
    id: projectId, name: "Test Kitchen", directory: opts.tmpDir,
    summary: "the summary", notes: [], panes: opts.panes ?? { p1: makePane("p1") }, keyTerms: ["alpha", "beta"],
  };
  const notes = opts.notes ?? [];
  const events = opts.events ?? [];
  const plans = opts.plans ?? [];
  const ledger: any = {
    activeProjectId: projectId,
    getProject: (id: string) => { calls.push(`getProject:${id}`); return id === projectId ? project : null; },
    getNotes: (f: { projectId?: string }) => { calls.push(`getNotes:${f.projectId}`); return notes.filter((n) => n.project_id === f.projectId); },
    plans,
  };
  const store: any = {
    getEvents: (f: { projectId?: string }) => { calls.push(`getEvents:${f.projectId}`); return events.filter((e) => e.project_id === f.projectId); },
  };
  const gateDisposition: GateDisposition = opts.gateDisposition ?? { disposition: "run" };
  const ctx = {
    manager: { ledger }, store, session: null, surface: "rest",
    broadcastLedgerUpdate: () => { calls.push("broadcast"); },
    redact: (s: string) => s, // identity — the composer already redacts explicitly (see readOnly:false note)
    isFrozen: () => !!opts.frozen,
    effectiveCapabilityGateFor: () => opts.gateValue ?? "Auto",
    gateOrDefer: (_cap: string, _paneId: string | null, _summary: string, _run: () => string) => {
      calls.push(`gateOrDefer:${_cap}`);
      return gateDisposition;
    },
  } as unknown as ActionContext;
  return { ctx, calls };
}

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbital-export-")); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

// ════════════════════════════════════════════════════════════════════════════════════════════════
// composeExportMarkdown — pure, deterministic golden
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("composeExportMarkdown — deterministic golden", () => {
  const FIXED_CLOCK = () => Date.parse("2026-07-06T12:00:00.000Z");

  function fullSnapshot(): ExportProjectSnapshot {
    return {
      project: { id: "proj1", name: "Test Kitchen", directory: "/kitchens/proj1", summary: "A test kitchen", keyTerms: ["alpha", "beta"] },
      notes: [
        { id: "n1", type: "decision", pane_id: null, text: "Use SQLite", created_at: Date.parse("2026-07-01T00:00:00.000Z") },
        { id: "n2", type: "todo", pane_id: "p1", text: "Write tests", created_at: Date.parse("2026-07-02T00:00:00.000Z") },
      ],
      panes: [
        { pane_id: "p1", name: "Pane One", alive: true, last_known_state: "Idle", tool_preset: "Claude Code", permissions_mode: "Human-in-the-Loop" },
      ],
      events: [
        { id: 1, ts: Date.parse("2026-07-03T00:00:00.000Z"), type: "note_added", pane_id: null, summary: "note added" },
      ],
      plans: [
        { id: "plan1", name: "Ship it", status: "idle", steps: [{ id: "s1", command: "npm test", status: "pending" }] },
      ],
    };
  }

  it("produces the exact golden Markdown body for a seeded snapshot", () => {
    const md = composeExportMarkdown(fullSnapshot(), FIXED_CLOCK);
    const expected = [
      "# Orbital Export — Test Kitchen (proj1)",
      "",
      "_Generated: 2026-07-06T12:00:00.000Z_",
      "",
      "## Project",
      "",
      "- **Directory:** /kitchens/proj1",
      "- **Summary:** A test kitchen",
      "- **Key Terms:** alpha, beta",
      "",
      "## Notes (2)",
      "",
      "### Decisions (1)",
      "",
      "- **[n1]** (project-level) — Use SQLite _(2026-07-01T00:00:00.000Z)_",
      "",
      "### Todos (1)",
      "",
      "- **[n2]** (pane p1) — Write tests _(2026-07-02T00:00:00.000Z)_",
      "",
      "### Warnings (0)",
      "",
      "(none)",
      "",
      "### Notes (0)",
      "",
      "(none)",
      "",
      "### Handoffs (0)",
      "",
      "(none)",
      "",
      "## Panes (1)",
      "",
      "- **p1** — Pane One — alive / Idle — preset:Claude Code mode:Human-in-the-Loop",
      "",
      "## Recent History (last 1 shown)",
      "",
      "- `2026-07-03T00:00:00.000Z` **note_added** (project-level) — note added",
      "",
      "## Plans (1)",
      "",
      "### Ship it (idle) — plan1",
      "  - step 1: npm test — pending",
      "",
    ].join("\n");
    assert.strictEqual(md, expected);
  });

  it("is byte-identical across two calls given the SAME snapshot + clock", () => {
    const a = composeExportMarkdown(fullSnapshot(), FIXED_CLOCK);
    const b = composeExportMarkdown(fullSnapshot(), FIXED_CLOCK);
    assert.strictEqual(a, b);
  });

  it("an empty project composes a valid skeleton document (no crash, no sections missing)", () => {
    const empty: ExportProjectSnapshot = {
      project: { id: "p0", name: "Empty", directory: "/empty", summary: "", keyTerms: [] },
      notes: [], panes: [], events: [], plans: [],
    };
    const md = composeExportMarkdown(empty, FIXED_CLOCK);
    assert.match(md, /## Notes \(0\)/);
    assert.match(md, /## Panes \(0\)/);
    assert.match(md, /## Recent History \(last 0 shown\)/);
    assert.match(md, /## Plans \(0\)/);
    assert.match(md, /\*\*Summary:\*\* \(none\)/);
    assert.match(md, /\*\*Key Terms:\*\* \(none\)/);
  });

  it("redacts a secret planted in a PANE NAME and the PROJECT NAME (agent-writable free text — hwu.6)", () => {
    const secretValue = "sk-live-fakePaneNameSecret1234567";
    const snap: ExportProjectSnapshot = {
      project: { id: "p1", name: `Kitchen token=${secretValue}`, directory: "/k", summary: "clean", keyTerms: [] },
      notes: [],
      panes: [{ pane_id: "p1", name: `pane api_key=${secretValue}`, alive: true, last_known_state: "Idle", tool_preset: "Claude Code", permissions_mode: "Human-in-the-Loop" }],
      events: [],
      plans: [],
    };
    const md = composeExportMarkdown(snap, FIXED_CLOCK);
    assert.ok(!md.includes(secretValue), "a secret in a pane name or the project name must never appear raw in the export");
    assert.match(md, /# Orbital Export — Kitchen/, "the (redacted) project name still titles the document");
    assert.match(md, /\*\*p1\*\* — pane/, "the (redacted) pane name still renders");
  });

  it("redacts a planted secret-shaped string AND the literal API_AUTH_TOKEN value out of note/event/plan text", () => {
    const secretValue = "sk-live-fakeSecretValue1234567890";
    const snap: ExportProjectSnapshot = {
      project: { id: "p1", name: "K", directory: "/k", summary: "clean", keyTerms: [] },
      notes: [{ id: "n1", type: "note", pane_id: null, text: `remember this: API_AUTH_TOKEN=${secretValue}`, created_at: 0 }],
      panes: [],
      events: [{ id: 1, ts: 0, type: "command_outcome", pane_id: null, summary: `leaked api_key=${secretValue}` }],
      plans: [{ id: "pl1", name: "plan", status: "idle", steps: [{ id: "s1", command: `curl -H "token=${secretValue}"`, status: "pending" }] }],
    };
    const md = composeExportMarkdown(snap, FIXED_CLOCK);
    assert.ok(!md.includes(secretValue), "the planted secret VALUE must never appear in the export");
  });
});

describe("redactForExport — defense-in-depth beyond the canonical redactSecrets", () => {
  it("scrubs an underscore-joined key like API_AUTH_TOKEN that the canonical \\b-anchored pass misses", () => {
    const out = redactForExport("API_AUTH_TOKEN=abcdef123456ghijkl");
    assert.ok(!out.includes("abcdef123456ghijkl"));
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// buildExportSnapshot — reads the ledger/store surface
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("buildExportSnapshot", () => {
  it("bounds history to EXPORT_HISTORY_CAP, keeping the MOST RECENT events (not the oldest)", () => {
    const events: StoredEvent[] = Array.from({ length: EXPORT_HISTORY_CAP + 20 }, (_, i) => ({
      id: i, ts: i, type: "note_added", project_id: "proj1", pane_id: null, session_id: null, summary: `event ${i}`, payload: {},
    }));
    const { ctx } = makeCtx({ tmpDir, events });
    const project = ctx.manager.ledger.getProject("proj1")!;
    const snap = buildExportSnapshot(ctx, project, "proj1");
    assert.strictEqual(snap.events.length, EXPORT_HISTORY_CAP);
    assert.strictEqual(snap.events[0].id, 20, "the oldest 20 events must be DROPPED — the window keeps the tail");
    assert.strictEqual(snap.events[snap.events.length - 1].id, EXPORT_HISTORY_CAP + 19);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// export_project (voice) — atomic write, gate, terse confirmation
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("export_project (voice)", () => {
  it("writes ORBITAL_EXPORT.md into the project's OWN directory and speaks the terse confirmation", async () => {
    const notes: StoredNote[] = [
      { id: "n1", project_id: "proj1", pane_id: null, text: "hello", type: "note", author: "user", created_at: 1, updated_at: 1 },
    ];
    const { ctx } = makeCtx({ tmpDir, notes, panes: { p1: makePane("p1"), p2: makePane("p2") } });
    const result = await runAction(EXPORT_ACTIONS, "export_project", {}, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual((result as { output: unknown }).output, "Export written — 1 notes, 2 stations.");
    const target = path.join(tmpDir, EXPORT_BASENAME);
    assert.ok(fs.existsSync(target), "the artifact must land at <project directory>/ORBITAL_EXPORT.md");
    const body = fs.readFileSync(target, "utf8");
    assert.match(body, /# Orbital Export — Test Kitchen \(proj1\)/);
    assert.match(body, /hello/);
    // Voice output NEVER carries the document body.
    assert.ok(!String((result as { output: unknown }).output).includes("Orbital Export"), "the voice confirmation must never be the document body");
  });

  it("no path/basename argument exists on the tool — the model cannot influence where it writes", () => {
    const def = findDef("export_project");
    const shape = (def.params as any).shape ?? {};
    assert.ok(!("path" in shape) && !("filename" in shape) && !("basename" in shape));
  });

  it("overwrites deterministically on a second call (same ledger state -> same body, tick-for-tick)", async () => {
    const realNow = Date.now;
    try {
      Date.now = () => Date.parse("2026-07-06T00:00:00.000Z");
      const { ctx: ctx1 } = makeCtx({ tmpDir });
      await runAction(EXPORT_ACTIONS, "export_project", {}, ctx1);
      const first = fs.readFileSync(path.join(tmpDir, EXPORT_BASENAME), "utf8");
      const { ctx: ctx2 } = makeCtx({ tmpDir });
      await runAction(EXPORT_ACTIONS, "export_project", {}, ctx2);
      const second = fs.readFileSync(path.join(tmpDir, EXPORT_BASENAME), "utf8");
      assert.strictEqual(first, second);
    } finally {
      Date.now = realNow;
    }
  });

  it("gate-refusal (Off) writes NOTHING and answers a graceful spoken refusal", async () => {
    const { ctx, calls } = makeCtx({ tmpDir, gateDisposition: { disposition: "forbidden" } });
    const result = await runAction(EXPORT_ACTIONS, "export_project", {}, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.match(String((result as { output: unknown }).output), /forbidden by policy/);
    assert.ok(!fs.existsSync(path.join(tmpDir, EXPORT_BASENAME)), "Off must never write the artifact");
    assert.ok(calls.includes("gateOrDefer:update_metadata"));
  });

  it("gate-defer (Ask) queues the confirmation and writes NOTHING yet", async () => {
    const { ctx } = makeCtx({ tmpDir, gateDisposition: { disposition: "deferred", actionId: "act_1", summary: "Export project proj1 to ORBITAL_EXPORT.md" } });
    const result = await runAction(EXPORT_ACTIONS, "export_project", {}, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.match(String((result as { output: unknown }).output), /needs operator confirmation/);
    assert.ok(!fs.existsSync(path.join(tmpDir, EXPORT_BASENAME)));
  });

  it("unknown project resolves to a graceful ok-narration miss, writes nothing", async () => {
    const { ctx } = makeCtx({ tmpDir });
    const result = await runAction(EXPORT_ACTIONS, "export_project", { project_id: "ghost" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.match(String((result as { output: unknown }).output), /not found/);
    assert.ok(!fs.existsSync(path.join(tmpDir, EXPORT_BASENAME)));
  });

  it("atomic: a throw during the write step never corrupts/replaces the FINAL target path", async () => {
    // Seed a PRIOR artifact so we can prove it survives untouched after a mid-write failure.
    fs.writeFileSync(path.join(tmpDir, EXPORT_BASENAME), "PRIOR CONTENT", "utf8");
    const realWrite = fs.writeFileSync;
    (fs as any).writeFileSync = (...args: unknown[]) => { throw new Error("simulated disk failure"); };
    try {
      const { ctx } = makeCtx({ tmpDir });
      const result = await runAction(EXPORT_ACTIONS, "export_project", {}, ctx);
      assert.strictEqual(result.kind, "ok");
      assert.match(String((result as { output: unknown }).output), /Export failed/);
    } finally {
      (fs as any).writeFileSync = realWrite;
    }
    const survived = fs.readFileSync(path.join(tmpDir, EXPORT_BASENAME), "utf8");
    assert.strictEqual(survived, "PRIOR CONTENT", "the target must be untouched — no partial file");
  });

  it("writeExportArtifactAtomic leaves no dangling temp file after a successful write", () => {
    writeExportArtifactAtomic(tmpDir, "# hello");
    const entries = fs.readdirSync(tmpDir);
    assert.deepStrictEqual(entries, [EXPORT_BASENAME]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// get_project_export (rest) — same composer, markdown download, 404, history cap, Off-gate
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("get_project_export (rest)", () => {
  async function runToHttp(args: Record<string, unknown>, ctx: ActionContext) {
    const def = findDef("get_project_export");
    const result = await runAction(EXPORT_ACTIONS, "get_project_export", args, ctx);
    const { res, sent } = makeFakeRes();
    applyResultToHttp(def, result, args, res);
    return { result, sent };
  }

  it("200s with the SAME composed markdown, text/markdown + Content-Disposition: attachment", async () => {
    const notes: StoredNote[] = [
      { id: "n1", project_id: "proj1", pane_id: null, text: "hi", type: "note", author: "user", created_at: 1, updated_at: 1 },
    ];
    const { ctx } = makeCtx({ tmpDir, notes });
    const { sent } = await runToHttp({ project_id: "proj1" }, ctx);
    assert.strictEqual(sent.status, 200);
    assert.strictEqual(sent.headers?.["Content-Type"], "text/markdown; charset=utf-8");
    assert.strictEqual(sent.headers?.["Content-Disposition"], `attachment; filename="${EXPORT_BASENAME}"`);
    assert.match(String(sent.sentBody), /# Orbital Export — Test Kitchen \(proj1\)/);
    assert.match(String(sent.sentBody), /hi/);
    // The REST leg never writes to disk.
    assert.ok(!fs.existsSync(path.join(tmpDir, EXPORT_BASENAME)));
  });

  it("404s for an unknown project", async () => {
    const { ctx } = makeCtx({ tmpDir });
    const { sent } = await runToHttp({ project_id: "ghost" }, ctx);
    assert.strictEqual(sent.status, 404);
    assert.match(String((sent.json as { error?: string })?.error), /not found/);
  });

  it("bounds the history section to EXPORT_HISTORY_CAP events", async () => {
    const events: StoredEvent[] = Array.from({ length: EXPORT_HISTORY_CAP + 5 }, (_, i) => ({
      id: i, ts: i, type: "note_added", project_id: "proj1", pane_id: null, session_id: null, summary: `event ${i}`, payload: {},
    }));
    const { ctx } = makeCtx({ tmpDir, events });
    const { sent } = await runToHttp({ project_id: "proj1" }, ctx);
    const body = String(sent.sentBody);
    assert.match(body, new RegExp(`Recent History \\(last ${EXPORT_HISTORY_CAP} shown\\)`));
    assert.ok(!body.includes("event 0"), "the oldest events must be dropped by the cap");
    assert.ok(body.includes(`event ${EXPORT_HISTORY_CAP + 4}`), "the newest event must survive the cap");
  });

  it("Off-gated read_notes -> 403, never touches the composer", async () => {
    const { ctx, calls } = makeCtx({ tmpDir, gateValue: "Off" });
    const { sent } = await runToHttp({ project_id: "proj1" }, ctx);
    assert.strictEqual(sent.status, 403);
    assert.ok(!calls.some((c) => c.startsWith("getProject")), "an Off veto must short-circuit before any read");
  });

  it("is rest-only (no voice twin) and read-gated under read_notes", () => {
    const def = findDef("get_project_export");
    assert.deepStrictEqual([...def.surfaces], ["rest"]);
    assert.strictEqual(def.capability, "read_notes");
    assert.strictEqual(def.rest?.method, "get");
    assert.strictEqual(def.rest?.path, "/api/projects/:project_id/export");
  });
});
