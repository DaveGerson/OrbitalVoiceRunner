/**
 * tests/test_promote_draft.ts — hwu.4 promote_draft ActionDef. Exercises the def DIRECTLY (hand-built
 * ctx + a REAL in-memory PendingActionStore) — no registry. Pins:
 *   - target:"note" persists the FULL draft untruncated + typed, via gateOrDefer("update_metadata").
 *   - target:"bead" persists the note, marks it bead-proposed, stages a pending approval, and does NOT
 *     touch the exec seam; confirm files the bead exactly once with the composed fields; cancel/deny
 *     files nothing.
 *   - the module imports NO fs / child_process (the live path can never write a file or shell bd).
 *   - a replayed callId does not duplicate the proposal; the def is readOnly:false (inherits the shared
 *     runAction replay guard tests/test_session_reconnect.ts pins for add_project_note).
 *   - the Gemini-facing def shape (the "golden").
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

import { promoteDraft } from "../src/actions/defs/promote";
import { setBeadExec, type ComposedBead, type BeadExec } from "../src/beadPromoter";
import { PendingActionStore } from "../src/pendingActions";
import type { ActionContext, GateDisposition } from "../src/actions/types";

interface AddNoteCall { projectId: string; text: string; opts: { type?: string } }
interface MarkCall { id: string; status: string | null }

function makeCtx(opts: {
  draftText?: string | null;
  noPane?: boolean;
  classify?: (text: string) => Promise<string | null>;
  disposition?: GateDisposition;
  addNoteOk?: boolean;
  callId?: string;
} = {}) {
  const addNoteCalls: AddNoteCall[] = [];
  const markCalls: MarkCall[] = [];
  const gateCalls: Array<{ capability: string; paneId: string | null; params?: Record<string, unknown> }> = [];
  const broadcasts: any[] = [];
  const counters = { ledgerBroadcasts: 0, noteSeq: 0 };
  const pendingActions = new PendingActionStore();
  const ledger: any = {
    activeProjectId: "p",
    getDraft: () => (opts.draftText === undefined ? { text: "the draft body" } : (opts.draftText === null ? null : { text: opts.draftText })),
    addNote: (projectId: string, text: string, o: any = {}) => {
      addNoteCalls.push({ projectId, text, opts: o });
      return opts.addNoteOk === false ? null : { id: `n${++counters.noteSeq}` };
    },
    setNoteBeadStatus: (id: string, status: string | null) => markCalls.push({ id, status }),
  };
  const ctx = {
    manager: { ledger },
    session: null,
    surface: "voice",
    callId: opts.callId,
    versionStamp: { actionName: "promote_draft", schemaHash: "hash" },
    broadcast: (m: unknown) => broadcasts.push(m),
    broadcastLedgerUpdate: () => { counters.ledgerBroadcasts += 1; },
    activeDraftTarget: () => (opts.noPane ? null : { projectId: "p", paneId: "pane1" }),
    pendingActions,
    gateOrDefer: (capability: string, paneId: string | null, _summary: string, _run: () => string, params?: Record<string, unknown>): GateDisposition => {
      gateCalls.push({ capability, paneId, params });
      return opts.disposition ?? { disposition: "run" };
    },
    policies: { classifyNote: opts.classify ?? (async () => "note") },
  } as unknown as ActionContext;
  return { ctx, addNoteCalls, markCalls, gateCalls, broadcasts, counters, pendingActions };
}

afterEach(() => setBeadExec(null));

describe("promote_draft — def shape (golden)", () => {
  it("is a gated voice def on update_metadata with a note|bead target enum and no file/cargo member", () => {
    assert.equal(promoteDraft.name, "promote_draft");
    assert.equal(promoteDraft.capability, "update_metadata");
    assert.equal(promoteDraft.readOnly, false);
    assert.deepStrictEqual([...promoteDraft.surfaces], ["voice"]);
    // The target enum is closed to exactly note|bead (rescope removed file/cargo).
    const shape = (promoteDraft.params as any).shape.target;
    assert.deepStrictEqual(shape.options, ["note", "bead"]);
    // An invalid target is rejected at the params boundary.
    assert.equal(promoteDraft.params.safeParse({ target: "file" }).success, false);
    assert.equal(promoteDraft.params.safeParse({ target: "cargo" }).success, false);
    assert.equal(promoteDraft.params.safeParse({ target: "bead" }).success, true);
    assert.ok(promoteDraft.description.length > 0);
  });
});

describe("promote_draft — static seam isolation", () => {
  it("the ActionDef module imports NO fs and NO child_process (grep-provable)", () => {
    const src = readFileSync(path.join(process.cwd(), "src/actions/defs/promote.ts"), "utf8");
    assert.ok(!/child_process/.test(src), "promote.ts must not reference child_process");
    assert.ok(!/from\s+["']node:fs["']|from\s+["']fs["']|require\(\s*["']fs["']\s*\)/.test(src), "promote.ts must not import fs");
  });
});

describe("promote_draft(target:note) — full untruncated typed capture", () => {
  it("persists the FULL draft (untruncated) with the classified type via gateOrDefer('update_metadata')", async () => {
    const big = "line one\n" + "y".repeat(400);
    const { ctx, addNoteCalls, gateCalls, counters } = makeCtx({ draftText: big, classify: async () => "decision" });
    const res = await promoteDraft.handler({ target: "note" }, ctx);
    assert.equal(res.kind, "ok");
    assert.match((res as { output: string }).output, /decision note/);
    assert.equal(addNoteCalls.length, 1);
    assert.equal(addNoteCalls[0].text, big, "the full draft is persisted with NO truncation");
    assert.equal(addNoteCalls[0].opts.type, "decision");
    assert.equal(gateCalls[0].capability, "update_metadata");
    assert.equal(gateCalls[0].params?.op, "add");
    assert.equal(counters.ledgerBroadcasts, 1);
  });

  it("REDACTS a spoken secret before persistence", async () => {
    const { ctx, addNoteCalls } = makeCtx({ draftText: "key AKIAABCDEFGHIJKLMNOP here", classify: async () => "note" });
    await promoteDraft.handler({ target: "note" }, ctx);
    assert.ok(addNoteCalls[0].text.includes("[REDACTED:aws-key]"));
    assert.ok(!addNoteCalls[0].text.includes("AKIAABCDEFGHIJKLMNOP"));
  });

  it("forbidden (gate Off) → refusal, no write", async () => {
    const { ctx, addNoteCalls } = makeCtx({ disposition: { disposition: "forbidden" } });
    const res = await promoteDraft.handler({ target: "note" }, ctx);
    assert.match((res as { output: string }).output, /gated Off/);
    assert.equal(addNoteCalls.length, 0);
  });

  it("deferred (gate Ask) → queued narration, no immediate write", async () => {
    const { ctx, addNoteCalls } = makeCtx({ disposition: { disposition: "deferred", actionId: "a1", summary: "Promote draft to a note note" } });
    const res = await promoteDraft.handler({ target: "note" }, ctx);
    assert.match((res as { output: string }).output, /needs operator confirmation/);
    assert.equal(addNoteCalls.length, 0);
  });
});

describe("promote_draft — empty / no-pane is graceful", () => {
  it("no active pane → spoken refusal, no write, no proposal", async () => {
    const { ctx, addNoteCalls, pendingActions } = makeCtx({ noPane: true });
    const res = await promoteDraft.handler({ target: "bead" }, ctx);
    assert.match((res as { output: string }).output, /No pane is open/);
    assert.equal(addNoteCalls.length, 0);
    assert.equal(pendingActions.all().length, 0);
  });

  it("empty draft → spoken refusal, no write", async () => {
    const { ctx, addNoteCalls } = makeCtx({ draftText: "   " });
    const res = await promoteDraft.handler({ target: "note" }, ctx);
    assert.match((res as { output: string }).output, /nothing in the draft/i);
    assert.equal(addNoteCalls.length, 0);
  });
});

describe("promote_draft(target:bead) — proposal only; the live path never files a bead", () => {
  it("persists the note, marks it bead-proposed, stages a pending approval, and does NOT invoke the exec seam", async () => {
    let execCalls = 0;
    setBeadExec(() => { execCalls += 1; return { ok: true, id: "bd-1" }; });
    const { ctx, addNoteCalls, markCalls, pendingActions, broadcasts } = makeCtx({ draftText: "cap the retry backoff", classify: async () => "todo", callId: "call-1" });
    const res = await promoteDraft.handler({ target: "bead" }, ctx);

    assert.equal(res.kind, "pending", "the operator must approve — the tool returns a pending proposal");
    assert.equal(addNoteCalls.length, 1, "the full note is persisted");
    assert.deepStrictEqual(markCalls, [{ id: "n1", status: "proposed" }], "the note is marked bead-proposed");
    assert.equal(pendingActions.all().length, 1, "exactly one pending approval is staged");
    assert.equal(execCalls, 0, "the exec seam is NEVER reached on the live tool-call path");
    assert.ok(broadcasts.some((b) => b.type === "action_pending"), "an action_pending frame surfaces the approval");
  });

  it("on operator APPROVAL, the promoter files the bead EXACTLY ONCE with the composed fields + marks the note created", async () => {
    const seen: ComposedBead[] = [];
    const mock: BeadExec = (c) => { seen.push(c); return { ok: true, id: "bd-42" }; };
    setBeadExec(mock);
    const { ctx, markCalls, pendingActions } = makeCtx({ draftText: "TODO rotate the key", classify: async () => "todo", callId: "call-2" });
    const staged = await promoteDraft.handler({ target: "bead" }, ctx);
    const id = (staged as { messageId: string }).messageId;

    const resolved = pendingActions.confirm(id);
    assert.equal(resolved.reason, "confirmed");
    assert.equal(seen.length, 1, "bd create runs exactly once, only on confirm");
    assert.equal(seen[0].issueType, "task", "todo → task (composed field)");
    assert.ok(seen[0].description.includes("TODO rotate the key"), "the composed description carries the note body");
    assert.deepStrictEqual(markCalls[markCalls.length - 1], { id: "n1", status: "created" }, "the note is marked created after filing");
    assert.match(String(resolved.output), /Filed the bead/);
  });

  it("on operator DENY (cancel), nothing is filed — the exec seam is never reached; the note is auto-marked denied", async () => {
    let execCalls = 0;
    setBeadExec(() => { execCalls += 1; return { ok: true }; });
    const { ctx, pendingActions, markCalls } = makeCtx({ draftText: "maybe do this", classify: async () => "note", callId: "call-3" });
    const staged = await promoteDraft.handler({ target: "bead" }, ctx);
    const id = (staged as { messageId: string }).messageId;

    // The staged proposal carries the noteId so the deny path can mark the source note.
    const record = pendingActions.get(id);
    assert.equal((record?.params as any)?.noteId, "n1", "the proposal exposes its source noteId for the deny hook");

    // hwu.4 deny wiring (Wave 6): cancel() alone fires the onDiscard hook → the note is marked denied.
    // No manual denyBeadProposal call — the wiring is real now.
    const resolved = pendingActions.cancel(id);
    assert.equal(resolved.reason, "cancelled");
    assert.equal(execCalls, 0, "deny files nothing");
    assert.equal(pendingActions.all().length, 0, "the proposal is discarded");
    assert.deepStrictEqual(markCalls[markCalls.length - 1], { id: "n1", status: "denied" }, "cancel marks the source note denied");
  });

  it("a TTL EXPIRY of an un-answered proposal also marks the source note denied", async () => {
    setBeadExec(() => ({ ok: true }));
    const { ctx, pendingActions, markCalls } = makeCtx({ draftText: "expire me", classify: async () => "note", callId: "call-exp" });
    const staged = await promoteDraft.handler({ target: "bead" }, ctx);
    const id = (staged as { messageId: string }).messageId;
    const resolved = pendingActions.expire(id);
    assert.equal(resolved.reason, "expired");
    assert.deepStrictEqual(markCalls[markCalls.length - 1], { id: "n1", status: "denied" }, "expiry marks the source note denied");
  });
});

// ── BLOCKER FIX (Wave 6): the bead-target NOTE write rides the update_metadata gate ────────────────
describe("promote_draft(target:bead) — the note write is GATED (no bypass)", () => {
  it("Off veto → refusal, NO note written, NO bead proposal staged, exec never reached", async () => {
    let execCalls = 0;
    setBeadExec(() => { execCalls += 1; return { ok: true }; });
    const { ctx, addNoteCalls, markCalls, gateCalls, pendingActions } = makeCtx({
      draftText: "sensitive capture", classify: async () => "todo", callId: "call-off",
      disposition: { disposition: "forbidden" },
    });
    const res = await promoteDraft.handler({ target: "bead" }, ctx);
    assert.equal(res.kind, "ok");
    assert.match((res as { output: string }).output, /gated Off/);
    assert.equal(addNoteCalls.length, 0, "Off must persist NO note");
    assert.equal(markCalls.length, 0, "Off marks nothing bead-proposed");
    assert.equal(pendingActions.all().length, 0, "Off stages NO bead proposal");
    assert.equal(execCalls, 0, "Off never reaches the bead exec seam");
    assert.equal(gateCalls[0].capability, "update_metadata", "the write routes through the update_metadata gate");
    assert.equal(gateCalls[0].params?.op, "add");
  });

  it("Ask defer → queued narration, NO immediate note, NO bead proposal staged yet", async () => {
    let execCalls = 0;
    setBeadExec(() => { execCalls += 1; return { ok: true }; });
    const { ctx, addNoteCalls, markCalls, pendingActions } = makeCtx({
      draftText: "later capture", classify: async () => "todo", callId: "call-ask",
      disposition: { disposition: "deferred", actionId: "a1", summary: "Promote draft to a todo note" },
    });
    const res = await promoteDraft.handler({ target: "bead" }, ctx);
    assert.equal(res.kind, "ok");
    assert.match((res as { output: string }).output, /needs operator confirmation/);
    assert.equal(addNoteCalls.length, 0, "Ask writes no note immediately (it's queued in the gate)");
    assert.equal(markCalls.length, 0, "Ask marks nothing proposed");
    assert.equal(pendingActions.all().length, 0, "no bead proposal is staged until the note is confirmed");
    assert.equal(execCalls, 0, "Ask never reaches the bead exec seam");
  });
});

describe("promote_draft(target:bead) — idempotent on a replayed callId", () => {
  it("a replayed callId reuses the same proposal id and does NOT stage a second proposal", async () => {
    setBeadExec(() => ({ ok: true }));
    const { ctx, pendingActions } = makeCtx({ draftText: "same body", classify: async () => "note", callId: "dupe" });
    const first = await promoteDraft.handler({ target: "bead" }, ctx);
    const second = await promoteDraft.handler({ target: "bead" }, ctx);
    assert.equal((first as { messageId: string }).messageId, "bead_dupe");
    assert.equal((second as { messageId: string }).messageId, "bead_dupe", "same callId → same proposal id");
    assert.equal(pendingActions.all().length, 1, "the proposal is not duplicated on replay");
  });
});
