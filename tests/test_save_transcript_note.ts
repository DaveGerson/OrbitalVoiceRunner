/**
 * tests/test_save_transcript_note.ts — hwu.3 spine foundation. Exercises the save_transcript_note voice
 * ActionDef and the classify-on-write extension of the operator-UI create_project_note def DIRECTLY
 * (import the def, hand-built fake ctx) — no registry. Pins: last-turn capture, redact-before-persist,
 * fail-open classification ("note" on any daemon miss), gating parity with add_project_note, and the
 * graceful empty-buffer path.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";

import { saveTranscriptNote, createProjectNote } from "../src/actions/defs/notes";
import { recentTurns } from "../src/voice/recentTurns";
import type { ActionContext } from "../src/actions/types";
import type { GateDisposition } from "../src/actions/types";
import type { ClassifiableNoteType } from "../src/voice/policyClient";

interface AddNoteCall { projectId: string; text: string; opts: { type?: string; author?: string; paneId?: string } }

function makeCtx(opts: {
  classify?: ((text: string) => Promise<ClassifiableNoteType | null>) | null; // null => no policies wired
  disposition?: GateDisposition;
  activeProjectId?: string;
  addNoteOk?: boolean;
} = {}): {
  ctx: ActionContext;
  addNoteCalls: AddNoteCall[];
  gateCalls: Array<{ capability: string; paneId: string | null; summary: string; params?: Record<string, unknown> }>;
  counters: { broadcasts: number };
} {
  const addNoteCalls: AddNoteCall[] = [];
  const gateCalls: Array<{ capability: string; paneId: string | null; summary: string; params?: Record<string, unknown> }> = [];
  const counters = { broadcasts: 0 };
  const ledger: any = {
    activeProjectId: opts.activeProjectId ?? "proj",
    addNote: (projectId: string, text: string, o: any = {}) => {
      addNoteCalls.push({ projectId, text, opts: o });
      return opts.addNoteOk === false ? null : { id: "n1" };
    },
  };
  const ctx = {
    manager: { ledger },
    session: null,
    surface: "voice",
    versionStamp: { actionName: "save_transcript_note", schemaHash: "hash" },
    broadcastLedgerUpdate: () => { counters.broadcasts += 1; },
    gateOrDefer: (capability: string, paneId: string | null, summary: string, _run: () => string, params?: Record<string, unknown>): GateDisposition => {
      gateCalls.push({ capability, paneId, summary, params });
      return opts.disposition ?? { disposition: "run" };
    },
    policies: opts.classify === null ? undefined : { classifyNote: opts.classify ?? (async () => "note") },
  } as unknown as ActionContext;
  return { ctx, addNoteCalls, gateCalls, counters };
}

describe("save_transcript_note — shape", () => {
  it("is a gated voice def on update_metadata", () => {
    assert.strictEqual(saveTranscriptNote.name, "save_transcript_note");
    assert.strictEqual(saveTranscriptNote.capability, "update_metadata");
    assert.strictEqual(saveTranscriptNote.readOnly, false);
    assert.deepStrictEqual([...saveTranscriptNote.surfaces], ["voice"]);
  });
});

describe("save_transcript_note — capture, redaction, classification", () => {
  beforeEach(() => recentTurns.clear());

  it("captures the last turn, REDACTS a planted secret, persists the classified type + author", async () => {
    recentTurns.push("user", "TODO rotate the key AKIAABCDEFGHIJKLMNOP before launch");
    const { ctx, addNoteCalls, counters } = makeCtx({ classify: async () => "todo" });
    const res = await saveTranscriptNote.handler({}, ctx);
    assert.strictEqual(res.kind, "ok");
    assert.strictEqual((res as { output: unknown }).output, "Saved that as a todo note.");
    assert.strictEqual(addNoteCalls.length, 1);
    const call = addNoteCalls[0];
    assert.strictEqual(call.projectId, "proj");
    assert.strictEqual(call.opts.type, "todo");
    assert.strictEqual(call.opts.author, "user");
    assert.ok(call.text.includes("[REDACTED:aws-key]"), "secret must be redacted before persistence");
    assert.ok(!call.text.includes("AKIAABCDEFGHIJKLMNOP"), "raw secret must NOT reach the ledger");
    assert.strictEqual(counters.broadcasts, 1);
  });

  it("fails OPEN to type 'note' when the policy client returns null (daemon miss)", async () => {
    recentTurns.push("janus", "The build is failing on CI");
    const { ctx, addNoteCalls } = makeCtx({ classify: async () => null });
    await saveTranscriptNote.handler({}, ctx);
    assert.strictEqual(addNoteCalls[0].opts.type, "note");
  });

  it("fails OPEN to type 'note' when no policies daemon is wired at all", async () => {
    recentTurns.push("janus", "some model thought");
    const { ctx, addNoteCalls } = makeCtx({ classify: null });
    await saveTranscriptNote.handler({}, ctx);
    assert.strictEqual(addNoteCalls[0].opts.type, "note");
  });

  it("fails OPEN to type 'note' when classifyNote throws (never blocks capture)", async () => {
    recentTurns.push("user", "anything");
    const { ctx, addNoteCalls } = makeCtx({ classify: async () => { throw new Error("daemon exploded"); } });
    const res = await saveTranscriptNote.handler({}, ctx);
    assert.strictEqual(res.kind, "ok");
    assert.strictEqual(addNoteCalls[0].opts.type, "note");
  });

  it("author arg filters which turn is captured (operator => the user turn)", async () => {
    recentTurns.push("user", "operator said this");
    recentTurns.push("janus", "janus said this later");
    const { ctx, addNoteCalls } = makeCtx({ classify: async () => "note" });
    await saveTranscriptNote.handler({ author: "operator" }, ctx);
    assert.strictEqual(addNoteCalls[0].text, "operator said this");
    assert.strictEqual(addNoteCalls[0].opts.author, "user");
  });
});

describe("save_transcript_note — gating parity with add_project_note", () => {
  beforeEach(() => recentTurns.clear());

  it("routes through gateOrDefer('update_metadata', null, …) with an op:'add' scope:'project' intent", async () => {
    recentTurns.push("user", "decide to ship");
    const { ctx, gateCalls } = makeCtx({ classify: async () => "decision" });
    await saveTranscriptNote.handler({}, ctx);
    assert.strictEqual(gateCalls.length, 1);
    assert.strictEqual(gateCalls[0].capability, "update_metadata");
    assert.strictEqual(gateCalls[0].paneId, null);
    assert.strictEqual(gateCalls[0].params?.op, "add");
    assert.strictEqual(gateCalls[0].params?.scope, "project");
    // The durable intent must carry the REDACTED text, never raw.
    assert.strictEqual(gateCalls[0].params?.note, "decide to ship");
  });

  it("forbidden (gate Off) => refusal narration, NO write", async () => {
    recentTurns.push("user", "hello");
    const { ctx, addNoteCalls } = makeCtx({ classify: async () => "note", disposition: { disposition: "forbidden" } });
    const res = await saveTranscriptNote.handler({}, ctx);
    assert.match((res as { output: string }).output, /gated Off/);
    assert.strictEqual(addNoteCalls.length, 0);
  });

  it("deferred (gate Ask) => queued narration, NO immediate write", async () => {
    recentTurns.push("user", "hello");
    const { ctx, addNoteCalls } = makeCtx({ classify: async () => "note", disposition: { disposition: "deferred", actionId: "a1", summary: "Save transcript as a note note" } });
    const res = await saveTranscriptNote.handler({}, ctx);
    assert.match((res as { output: string }).output, /needs operator confirmation/);
    assert.strictEqual(addNoteCalls.length, 0);
  });
});

describe("save_transcript_note — empty buffer is graceful", () => {
  beforeEach(() => recentTurns.clear());

  it("returns a spoken 'nothing to save' and never writes an empty note or crashes", async () => {
    const { ctx, addNoteCalls, gateCalls } = makeCtx({ classify: async () => "note" });
    const res = await saveTranscriptNote.handler({}, ctx);
    assert.strictEqual(res.kind, "ok");
    assert.match((res as { output: string }).output, /nothing to save yet/i);
    assert.strictEqual(addNoteCalls.length, 0);
    assert.strictEqual(gateCalls.length, 0);
  });
});

describe("create_project_note — now classifies server-side", () => {
  it("classifies the (redacted) note text and persists with the resolved type", async () => {
    const { ctx, addNoteCalls, counters } = makeCtx({ classify: async () => "warning" });
    const res = await createProjectNote.handler({ project_id: "proj", note: "the migration is risky" }, ctx);
    assert.strictEqual(res.kind, "ok");
    assert.strictEqual(addNoteCalls[0].opts.type, "warning");
    assert.strictEqual(addNoteCalls[0].projectId, "proj");
    assert.strictEqual(counters.broadcasts, 1);
  });

  it("redacts before persistence and falls open to 'note' with no daemon", async () => {
    const { ctx, addNoteCalls } = makeCtx({ classify: null });
    await createProjectNote.handler({ project_id: "proj", note: "key AKIAABCDEFGHIJKLMNOP here" }, ctx);
    assert.strictEqual(addNoteCalls[0].opts.type, "note");
    assert.ok(addNoteCalls[0].text.includes("[REDACTED:aws-key]"));
  });
});
