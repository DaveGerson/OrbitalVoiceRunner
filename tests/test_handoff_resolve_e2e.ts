// tests/test_handoff_resolve_e2e.ts
//
// WS-M / bead wsm-e2e-pinned-alf — the RESOLVE leg of the handoff lifecycle (design §5.3, gap G3):
// when a pending approval gating a STAGED handoff RESOLVES (approve/reject/expire/dead_pane), the
// persisted handoff row must FLIP to the mapped terminal/transition state, EXACTLY ONCE, on the
// claim winner, and ONLY for the approval linked to that handoff via gate_approval_id.
//
// This pins the FULL composition end-to-end WITHOUT a live Gemini/WS session:
//   REAL JanusStore (temp FILE db, so the durable atomic-claim path bead nzt added is exercised)
//   + REAL PendingApprovalStore + REAL resolveDecision (the N-1 claim gate)
//   + the EXPORTED applyHandoffFlipOnResolve (the exact helper server.ts:flipHandoffOnResolve wraps).
//
// One source of truth: the reason->state mapping is resolveReasonToHandoffState (imported, never forked).

import { test, afterEach } from "node:test";
import assert from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { JanusStore } from "../src/store/sqliteStore";
import {
  PendingApprovalStore,
  resolveDecision,
  type PendingApproval,
  type ResolveMode,
  type ResolveReason,
} from "../src/pendingApprovals";
import { applyHandoffFlipOnResolve } from "../src/handoffFlow";

const TTL = 5 * 60 * 1000;
const WS = "ws-alf";
const tmpDirs: string[] = [];

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "janus-handoff-resolve-"));
  tmpDirs.push(dir);
  return join(dir, "handoffs.db");
}

afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function freshStore(): { store: JanusStore; approvals: PendingApprovalStore } {
  const store = new JanusStore(tmpDbPath());
  store.init();
  const approvals = new PendingApprovalStore(store);
  return { store, approvals };
}

function mkRecord(id: string, terminalId: string, instruction: string, ts = Date.now()): PendingApproval {
  return { messageId: id, instruction, kind: "agent_instruction", terminalId, callId: id, timestamp: ts };
}

/**
 * Stage a GATED handoff: create (composing) -> stage -> link gate_approval_id == handoff id, AND register
 * a matching PendingApproval whose messageId == handoff id (the identity linkage the deliver_handoff
 * await_approval branch creates: setGateApprovalId(handoff_id, handoff_id)). Returns the shared id.
 */
function stageGated(
  store: JanusStore,
  approvals: PendingApprovalStore,
  id: string,
  pane: string,
  ts = Date.now()
): string {
  const h = store.createHandoff({
    id,
    workspace_id: WS,
    to_pane: pane,
    kind: "agent_instruction",
    composed_prompt: "carry out the staged plan",
    state: "composing",
  });
  store.updateHandoffState(h.id, "staged");
  store.setGateApprovalId(h.id, h.id); // (id, approvalId) — id first; identity linkage
  approvals.add(mkRecord(id, pane, "carry out the staged plan", ts), { id: "live-ws" }, { workspaceId: WS, ttlMs: TTL });
  return id;
}

/**
 * The REAL resolve->flip composition, exactly as applyResolution does it in server.ts: run the claim
 * gate, then flip ONLY for a non-lost-race terminal reason, via the exported helper. Returns both so a
 * test can assert the gate reason AND whether the flip fired.
 */
function resolveAndFlip(
  store: JanusStore,
  approvals: PendingApprovalStore,
  id: string,
  mode: ResolveMode,
  paneExists: (t: string) => boolean,
  opts: { vocal?: boolean } = {}
): { reason: ResolveReason; flipped: boolean } {
  const action = resolveDecision(approvals, id, mode, paneExists);
  let flipped = false;
  if (action.reason === "approved" || action.reason === "rejected" || action.reason === "expired" || action.reason === "dead_pane") {
    flipped = applyHandoffFlipOnResolve(store, id, action.reason, opts).flipped;
  }
  return { reason: action.reason, flipped };
}

const alive = (_t: string) => true;
const dead = (_t: string) => false;

// ---------------------------------------------------------------------------
// APPROVE => delivered (delivered_at + approved_via), both rest and voice provenance.
// ---------------------------------------------------------------------------
test("e2e approve: gated staged handoff flips to delivered with delivered_at + approved_via=rest", () => {
  const { store, approvals } = freshStore();
  try {
    const id = stageGated(store, approvals, "h-appr", "pane_a");
    const r = resolveAndFlip(store, approvals, id, "approve", alive);
    assert.strictEqual(r.reason, "approved");
    assert.strictEqual(r.flipped, true);
    const row = store.getHandoff(id)!;
    assert.strictEqual(row.state, "delivered");
    assert.ok(row.delivered_at, "delivered_at must be stamped on approve");
    assert.strictEqual(row.approved_via, "rest");
  } finally { store.close(); }
});

test("e2e approve (voice): approved_via=voice when vocal", () => {
  const { store, approvals } = freshStore();
  try {
    const id = stageGated(store, approvals, "h-voice", "pane_a");
    const r = resolveAndFlip(store, approvals, id, "approve", alive, { vocal: true });
    assert.strictEqual(r.reason, "approved");
    const row = store.getHandoff(id)!;
    assert.strictEqual(row.state, "delivered");
    assert.strictEqual(row.approved_via, "voice");
  } finally { store.close(); }
});

// ---------------------------------------------------------------------------
// REJECT => rejected, no delivered_at (the reject_handoff -> applyResolution(...,'reject') routing).
// ---------------------------------------------------------------------------
test("e2e reject: gated staged handoff flips to rejected, no delivered_at", () => {
  const { store, approvals } = freshStore();
  try {
    const id = stageGated(store, approvals, "h-rej", "pane_a");
    const r = resolveAndFlip(store, approvals, id, "reject", alive);
    assert.strictEqual(r.reason, "rejected");
    assert.strictEqual(r.flipped, true);
    const row = store.getHandoff(id)!;
    assert.strictEqual(row.state, "rejected");
    assert.ok(!row.delivered_at, "rejected row must not carry delivered_at");
    assert.strictEqual(approvals.has(id), false, "the pending approval is consumed on reject");
  } finally { store.close(); }
});

// ---------------------------------------------------------------------------
// EXPIRE (TTL sweep) => expired with approved_via='ttl_expire'.
// ---------------------------------------------------------------------------
test("e2e expire: TTL sweep flips the gated handoff to expired (approved_via=ttl_expire)", () => {
  const { store, approvals } = freshStore();
  try {
    const id = stageGated(store, approvals, "h-exp", "pane_a");
    const r = resolveAndFlip(store, approvals, id, "expire", alive);
    assert.strictEqual(r.reason, "expired");
    assert.strictEqual(r.flipped, true);
    const row = store.getHandoff(id)!;
    assert.strictEqual(row.state, "expired");
    assert.strictEqual(row.approved_via, "ttl_expire");
    assert.ok(!row.delivered_at, "expired row must not carry delivered_at");
  } finally { store.close(); }
});

// ---------------------------------------------------------------------------
// DEAD_PANE => expired (assert STATE only; provenance is intentionally labelled ttl_expire).
// ---------------------------------------------------------------------------
test("e2e dead_pane: approve against a missing pane flips the handoff to expired (state only)", () => {
  const { store, approvals } = freshStore();
  try {
    const id = stageGated(store, approvals, "h-dead", "pane_gone");
    const r = resolveAndFlip(store, approvals, id, "approve", dead);
    assert.strictEqual(r.reason, "dead_pane");
    assert.strictEqual(r.flipped, true);
    assert.strictEqual(store.getHandoff(id)!.state, "expired");
  } finally { store.close(); }
});

// ---------------------------------------------------------------------------
// EXACTLY-ONCE / LOST RACE: two approves on the same id. First wins+flips (delivered); the second
// loses the claim (not_found after delete) and must NOT re-flip / overwrite the delivered row.
// Proven via the upstream claim gate, NOT a store terminal guard.
// ---------------------------------------------------------------------------
test("e2e exactly-once: a double-resolve flips once; the lost race does not overwrite", () => {
  const { store, approvals } = freshStore();
  try {
    const id = stageGated(store, approvals, "h-race", "pane_a");

    const first = resolveAndFlip(store, approvals, id, "approve", alive);
    assert.strictEqual(first.reason, "approved");
    assert.strictEqual(first.flipped, true);
    const deliveredAt = store.getHandoff(id)!.delivered_at;
    assert.ok(deliveredAt, "first resolve stamped delivered_at");

    // Second resolve — even a REJECT — must be a no-op: the record was claimed+deleted by the winner.
    const second = resolveAndFlip(store, approvals, id, "reject", alive);
    assert.strictEqual(second.flipped, false, "lost race / not_found must not flip a second time");
    assert.notStrictEqual(second.reason, "rejected");

    const row = store.getHandoff(id)!;
    assert.strictEqual(row.state, "delivered", "row stays in the winner's state, never overwritten to rejected");
    assert.strictEqual(row.delivered_at, deliveredAt, "delivered_at unchanged — written exactly once");
  } finally { store.close(); }
});

// ---------------------------------------------------------------------------
// NON-HANDOFF APPROVAL: a pending approval whose id matches NO handoff row. resolveDecision approves
// it normally, but the flip lookup (getHandoff + listHandoffs-by-gate_approval_id) finds nothing ->
// no row created or touched.
// ---------------------------------------------------------------------------
test("e2e non-handoff approval: resolves normally and touches no handoff row", () => {
  const { store, approvals } = freshStore();
  try {
    // Register a plain approval with NO backing handoff row.
    approvals.add(mkRecord("plain-cmd", "pane_a", "ls -la"), { id: "live-ws" }, { workspaceId: WS, ttlMs: TTL });
    const before = store.listHandoffs().length;

    const r = resolveAndFlip(store, approvals, "plain-cmd", "approve", alive);
    assert.strictEqual(r.reason, "approved", "the approval still resolves normally");
    assert.strictEqual(r.flipped, false, "no handoff row -> no flip");

    assert.strictEqual(store.listHandoffs().length, before, "no handoff row was created");
    assert.strictEqual(store.getHandoff("plain-cmd"), null, "no row exists for a non-handoff approval");
  } finally { store.close(); }
});

// ---------------------------------------------------------------------------
// FALLBACK LINKAGE: gate_approval_id differs from the handoff id (a future non-identity gate). The
// flip must still find the row via the listHandoffs-by-gate_approval_id fallback path.
// ---------------------------------------------------------------------------
test("e2e fallback linkage: flip finds the handoff when gate_approval_id != handoff id", () => {
  const { store, approvals } = freshStore();
  try {
    const h = store.createHandoff({ workspace_id: WS, to_pane: "pane_a", composed_prompt: "x", state: "composing" });
    store.updateHandoffState(h.id, "staged");
    const approvalId = "appr-distinct";
    store.setGateApprovalId(h.id, approvalId); // gate_approval_id != handoff id
    approvals.add(mkRecord(approvalId, "pane_a", "x"), { id: "live-ws" }, { workspaceId: WS, ttlMs: TTL });

    const r = resolveAndFlip(store, approvals, approvalId, "approve", alive);
    assert.strictEqual(r.reason, "approved");
    assert.strictEqual(r.flipped, true);
    assert.strictEqual(store.getHandoff(h.id)!.state, "delivered", "fallback gate_approval_id lookup flipped the row");
  } finally { store.close(); }
});
