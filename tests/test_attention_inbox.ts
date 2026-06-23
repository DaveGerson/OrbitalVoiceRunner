// tests/test_attention_inbox.ts — D2 "Attention inbox" (what-needs-me) unit coverage.
//
// Three pure seams the Attention-tab feature leans on, pinned without React/DOM/fetch:
//
//   1. attentionQueueFromFrame  (src/orbital/useOrbitalDataHelpers.ts) — the attention_updated
//      WS-frame reducer: adopt the frame's `queue` array, else null (the refetch signal). Mirrors
//      historyEntriesFromFrame / the plans_updated adopt-or-refetch idiom.
//   2. handleEventBusFallback setAttentionQueue case (src/appHelpers.ts) — the KNOWN GAP: the
//      eventBus emits a `setAttentionQueue` setter for attention_updated, but the fallback switch
//      had no arm for it, so it silently no-oped. This pins the now-wired case (+ guards the
//      optional ctx member so a caller that omits it still no-ops, never throws).
//   3. attentionTabLabel / attentionTabActUnit (src/orbital/views/Pass.tsx) — the tab toggle label
//      ("Attention" / "Attention • N") and the per-item act-kind resolution (approve/deny/jump/
//      restart) that drives which buttons a queue row shows.
//   4. dismissAttentionOutcome (src/orbital/useOrbitalDataHelpers.ts) — the dismiss-response
//      classifier. A dismiss is veto-class, so gated-Off does NOT 403: it returns kind:ok → HTTP 200
//      with an "Error:"-wrapped output, which a bare 200-check would mistake for success. Plus the
//      optimistic-remove + restore wiring the hook runs around it (403 / non-ok / 200-error → restore).
//
// PURE: items (1) import the real helper module; (2) imports appHelpers (no React); (3) loads
// Pass.tsx through the same Node ESM loader-hook shim the Pass complexity test uses (Vite-only
// icons.svg?raw + react stubs) so the pure label/act helpers can be imported without Vite.
//
// Runner: npx tsx --test --test-force-exit tests/test_attention_inbox.ts

import { register } from "node:module";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  attentionQueueFromFrame, dismissAttentionOutcome, attentionResolveTarget,
  isApprovalHere, pendingApprovalBadgeCount, buildAttentionApprovalItem, approvalToPromote,
} from "../src/orbital/useOrbitalDataHelpers";
import { dispatchWsMessage, type WsHandlerCtx } from "../src/appHelpers";
import type { AttentionItem } from "../src/types";

// ── 1. attentionQueueFromFrame — adopt-or-refetch reducer ─────────────────────
describe("attentionQueueFromFrame", () => {
  it("returns the queue array when present", () => {
    const q = [{ id: "a", type: "exited", dismissed: false }];
    assert.equal(attentionQueueFromFrame({ queue: q } as never), q as never);
  });
  it("returns null when the frame carries no array (caller refetches)", () => {
    assert.equal(attentionQueueFromFrame({}), null);
    assert.equal(attentionQueueFromFrame({ queue: "nope" as unknown }), null);
    assert.equal(attentionQueueFromFrame({ queue: null as unknown }), null);
  });
  it("adopts an empty array verbatim (a cleared queue is real state, not a refetch)", () => {
    const empty: unknown[] = [];
    assert.equal(attentionQueueFromFrame({ queue: empty } as never), empty as never);
  });
});

// ── 2. appHelpers fallback: setAttentionQueue case (the known gap) ────────────
// A minimal recording ctx — only the members the attention path touches. setAttentionQueue is the
// new (optional) member; effectForEvent is steered to the attention_updated effect the eventBus
// emits, mirroring how App.tsx wires effectForEvent into dispatchWsMessage.
function attnCtx(withSetter: boolean) {
  const order: string[] = [];
  const calls: { queue?: unknown; effect?: unknown } = {};
  const ctx = {
    playEarcon: (t: any) => order.push(`earcon:${t}`),
    triggerDesktopNotification: () => {},
    setPendingCommands: () => {}, setPendingActions: () => {}, setActiveTerminalId: () => {},
    setIsBufferFocused: () => {}, setPromptBuffer: () => {}, fetchWipDrafts: () => {},
    setTerminals: () => {}, setFrozen: () => {}, setFrozenRunning: () => {}, setLedger: () => {},
    setGlobalPermissionsMode: () => {}, setSettings: () => {}, setIsMicMuted: () => {},
    setAutoApprovedNotification: () => {}, setBlockedNotification: () => {}, setTranscript: () => {},
    setWsErrorNotification: () => {}, setProactiveNotifications: () => {}, setPlans: () => {},
    queueStdoutChunk: () => {}, fetchTerminals: () => order.push("fetchTerminals"),
    fetchPlans: () => {}, fetchActiveTerminalHistory: () => {}, resetAudioPlayback: () => {},
    playAudioChunk: () => {}, upsertNotification: (p: any) => p,
    effectForEvent: () => ({ setter: "setAttentionQueue", earcon: "alert" }),
    activeTerminalIdRef: { current: null },
    ...(withSetter ? { setAttentionQueue: (v: unknown) => { order.push("setAttentionQueue"); calls.queue = v; } } : {}),
  } as unknown as WsHandlerCtx;
  return { ctx, order, calls };
}

describe("appHelpers — attention_updated routes to setAttentionQueue", () => {
  it("a wired ctx adopts the frame's queue and plays the bus earcon (ORDER)", () => {
    const a = attnCtx(true);
    const queue = [{ id: "x", type: "error", dismissed: false }];
    dispatchWsMessage({ type: "attention_updated", queue }, a.ctx);
    assert.deepEqual(a.order, ["setAttentionQueue", "earcon:alert"]);
    assert.deepEqual(a.calls.queue, queue);
  });
  it("a ctx WITHOUT setAttentionQueue no-ops the setter (still plays the earcon) — never throws", () => {
    const a = attnCtx(false);
    assert.doesNotThrow(() => dispatchWsMessage({ type: "attention_updated", queue: [] }, a.ctx));
    assert.deepEqual(a.order, ["earcon:alert"]); // setter skipped, earcon still fires
  });
});

// ── 3. Pass.tsx tab label + act-kind helpers (loaded through the Vite shim) ───
const hookSource = /* js */`
export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('?raw')) {
    return { url: 'data:text/javascript,export default ""', shortCircuit: true };
  }
  if (specifier === 'react') {
    return { url: 'data:text/javascript,export default {};export function useState(){}export function useRef(){}export function useEffect(){}export const Fragment=Symbol("Fragment")', shortCircuit: true };
  }
  if (specifier === 'react/jsx-runtime') {
    return { url: 'data:text/javascript,export function jsx(){}export function jsxs(){}export const Fragment=Symbol("Fragment");export default {}', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (url.startsWith('data:text/javascript,')) {
    const head = 'data:text/javascript,';
    const q = url.indexOf('?', head.length);
    const payload = q === -1 ? url.slice(head.length) : url.slice(head.length, q);
    return { format: 'module', source: decodeURIComponent(payload), shortCircuit: true };
  }
  if (url.endsWith('.svg') || url.includes('.svg?')) {
    return { format: 'module', source: 'export default ""', shortCircuit: true };
  }
  return nextLoad(url, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(hookSource)}`, { parentURL: import.meta.url });

const { attentionTabLabel, attentionActKind, attnChip } = await import("../src/orbital/views/Pass.js");

describe("attentionTabLabel", () => {
  it("bare 'Attention' when the queue is empty (no bullet, no count)", () => {
    assert.equal(attentionTabLabel(0), "Attention");
  });
  it("'Attention • N' once there's anything needing the operator", () => {
    assert.equal(attentionTabLabel(1), "Attention • 1");
    assert.equal(attentionTabLabel(7), "Attention • 7");
  });
  it("a negative/garbage count never renders a bullet (defensive — treated as empty)", () => {
    assert.equal(attentionTabLabel(-1), "Attention");
  });
});

describe("attentionActKind", () => {
  // bead e7h: approval/confirmation is only truly ACTIONABLE (real Approve/Deny) when it carries a
  // messageId — the id of the held gated request to resolve. Without one it must NOT offer a fake
  // approve; it degrades to "open" (go to the station + the always-present Dismiss).
  it("approval / confirmation WITH a messageId → a held gate decision → approve+deny", () => {
    assert.equal(attentionActKind({ type: "approval", messageId: "m1" } as never), "approve");
    assert.equal(attentionActKind({ type: "confirmation", messageId: "m2" } as never), "approve");
  });
  it("approval / confirmation WITHOUT a messageId → triage-only → open (never a fake approve)", () => {
    assert.equal(attentionActKind({ type: "approval" } as never), "open");
    assert.equal(attentionActKind({ type: "confirmation" } as never), "open");
    assert.equal(attentionActKind({ type: "approval", messageId: "" } as never), "open"); // empty id is not a held request
  });
  it("a finished/idle completion item → jump to the station (nothing to act on)", () => {
    assert.equal(attentionActKind({ type: "idle" } as never), "jump");
    assert.equal(attentionActKind({ type: "idle", messageId: "m" } as never), "jump"); // a stray id on a non-approval type never makes it approvable
  });
  it("error / exited / build-failed are dead/failed stations → restart", () => {
    assert.equal(attentionActKind({ type: "error" } as never), "restart");
    assert.equal(attentionActKind({ type: "exited" } as never), "restart");
    assert.equal(attentionActKind({ type: "build-failed" } as never), "restart");
  });
  it("an unknown type degrades to a plain jump (never a dead row)", () => {
    assert.equal(attentionActKind({ type: "mystery" as never } as never), "jump");
    assert.equal(attentionActKind({} as never), "jump");
  });
});

// ── bead e7h: attentionResolveTarget — the held-request id-gate the resolver call leans on ───────
describe("attentionResolveTarget", () => {
  it("returns the messageId for an approval/confirmation item that carries one", () => {
    assert.equal(attentionResolveTarget({ type: "approval", messageId: "msg_7" }), "msg_7");
    assert.equal(attentionResolveTarget({ type: "confirmation", messageId: "msg_8" }), "msg_8");
  });
  it("returns null for an approval/confirmation with no (or empty) messageId — nothing to resolve", () => {
    assert.equal(attentionResolveTarget({ type: "approval" }), null);
    assert.equal(attentionResolveTarget({ type: "confirmation", messageId: "" }), null);
    assert.equal(attentionResolveTarget({ type: "approval", messageId: 42 as never }), null); // non-string is not a key
  });
  it("returns null for any non-approval type, even if a stray messageId is present", () => {
    assert.equal(attentionResolveTarget({ type: "error", messageId: "m" }), null);
    assert.equal(attentionResolveTarget({ type: "exited", messageId: "m" }), null);
    assert.equal(attentionResolveTarget({ type: "idle", messageId: "m" }), null);
    assert.equal(attentionResolveTarget({}), null);
  });
});

// ── bead 8xn: focus-routing helpers (modal vs inbox) ─────────────────────────
// The held-approval router. isApprovalHere decides which surface a frame lands on; the rest carry
// the inbox leg (badge count, item builder, promotion target) so the hook stays under the gate.

describe("isApprovalHere — the focus router predicate", () => {
  it("active station AND visible tab → true (the modal pops)", () => {
    assert.equal(isApprovalHere({ terminalId: "t1" }, "t1", true), true);
  });
  it("a DIFFERENT pane is at the station → false (route to inbox)", () => {
    assert.equal(isApprovalHere({ terminalId: "t1" }, "t2", true), false);
  });
  it("the right pane but the tab is HIDDEN → false (fail-closed to inbox)", () => {
    assert.equal(isApprovalHere({ terminalId: "t1" }, "t1", false), false);
  });
  it("no active station (null) → false even when visible (never silently to the modal)", () => {
    assert.equal(isApprovalHere({ terminalId: "t1" }, null, true), false);
  });
  it("a frame with no/empty terminalId → false (cannot route to a station we can't name)", () => {
    assert.equal(isApprovalHere({}, "t1", true), false);
    assert.equal(isApprovalHere({ terminalId: "" }, "", true), false); // empty matches nothing, never the modal
  });
});

describe("pendingApprovalBadgeCount — the held-approval count", () => {
  const mk = (over: Partial<AttentionItem>): AttentionItem => ({
    id: "x", type: "approval", terminalId: "t1", projectId: "p1", message: "m", timestamp: "0", dismissed: false, ...over,
  });
  it("counts undismissed approval/confirmation items that carry a messageId", () => {
    const q = [mk({ id: "a", messageId: "m1" }), mk({ id: "b", type: "confirmation", messageId: "m2" })];
    assert.equal(pendingApprovalBadgeCount(q), 2);
  });
  it("excludes triage items (no messageId), dismissed items, and non-approval types", () => {
    const q = [
      mk({ id: "a", messageId: "m1" }),                         // counts
      mk({ id: "b", messageId: "m2", dismissed: true }),        // dismissed → out
      mk({ id: "c" }),                                          // approval, no messageId → triage, out
      mk({ id: "d", type: "exited", messageId: "stray" }),     // non-approval type → out (defense in depth)
      mk({ id: "e", type: "idle" }),                            // completion → out
    ];
    assert.equal(pendingApprovalBadgeCount(q), 1);
  });
  it("an empty queue → 0", () => {
    assert.equal(pendingApprovalBadgeCount([]), 0);
  });
});

describe("buildAttentionApprovalItem — the inbox leg of the router", () => {
  it("maps an approval_pending frame into the AttentionItem shape (deterministic id, stamped messageId)", () => {
    const item = buildAttentionApprovalItem({ messageId: "msg_9", terminalId: "claude_1", cmd: "rm -rf build" });
    assert.equal(item.type, "approval");
    assert.equal(item.messageId, "msg_9");
    assert.equal(item.terminalId, "claude_1");
    assert.equal(item.dismissed, false);
    assert.equal(item.id, "approval:msg_9"); // deterministic → a duplicate broadcast de-dups against itself
    assert.ok(item.message.includes("claude_1") && item.message.includes("rm -rf build"));
  });
  it("bead 8xn: preserves the RAW cmd in rawCmd (the unwrapped instruction the promote→modal path needs)", () => {
    const item = buildAttentionApprovalItem({ messageId: "msg_9", terminalId: "claude_1", cmd: "drop table users" });
    assert.equal(item.rawCmd, "drop table users"); // NOT the wrapped "claude_1 needs your ok: …" label
    assert.notEqual(item.rawCmd, item.message); // the label and the command are distinct fields
  });
  it("the item is genuinely actionable — attentionResolveTarget returns its messageId", () => {
    const item = buildAttentionApprovalItem({ messageId: "msg_9", terminalId: "t1", cmd: "ls" });
    assert.equal(attentionResolveTarget(item), "msg_9"); // a real Approve/Deny, not a fake one
  });
});

describe("approvalToPromote — one-directional inbox → modal target", () => {
  const mk = (over: Partial<AttentionItem>): AttentionItem => ({
    id: "x", type: "approval", terminalId: "t1", projectId: "p1", message: "m", timestamp: "0", dismissed: false, ...over,
  });
  it("returns the inbox approval whose station is now active", () => {
    const q = [mk({ id: "a", messageId: "m1", terminalId: "t1" }), mk({ id: "b", messageId: "m2", terminalId: "t2" })];
    assert.equal(approvalToPromote(q, "t2")?.id, "b");
  });
  it("returns null when no inbox approval matches the active station", () => {
    const q = [mk({ id: "a", messageId: "m1", terminalId: "t1" })];
    assert.equal(approvalToPromote(q, "t3"), null);
  });
  it("ignores triage items (no messageId) and dismissed items even on the active station", () => {
    const q = [mk({ id: "a", terminalId: "t1" }), mk({ id: "b", messageId: "m2", terminalId: "t1", dismissed: true })];
    assert.equal(approvalToPromote(q, "t1"), null); // nothing genuinely held to promote
  });
  it("a null active station never promotes (focus ambiguity stays in the inbox)", () => {
    const q = [mk({ id: "a", messageId: "m1", terminalId: "t1" })];
    assert.equal(approvalToPromote(q, null), null);
  });
});

// ── bead 8xn (round-1 review): approval_resolved clears the INBOX, not just the modal ───────────
// The load-bearing "resolve anywhere clears everywhere" invariant (design §"Resolution parity"). A
// held approval routed to the inbox is a CLIENT-synthesized row — it is NOT in manager.attentionQueue,
// and applyResolution broadcasts only approval_resolved (never attention_updated). So the
// approval_resolved handler must itself drop the inbox row keyed by messageId. We reconstruct the
// EXACT closures from useOrbitalData (the frame handler + the promotion effect) and pin that:
//   (a) a resolve via a NON-inbox path (voice/REST/modal/TTL) clears the inbox row + drops the badge;
//   (b) once cleared, promotion does NOT resurrect it as a fresh modal (issue #2).
function mkApproval(over: Partial<AttentionItem>): AttentionItem {
  return { id: "x", type: "approval", terminalId: "t1", projectId: "p1", message: "m", timestamp: "0", dismissed: false, ...over };
}
function makeRouterState(initial: AttentionItem[]) {
  let attentionQueue = [...initial];
  let pendingCommands: { messageId?: string; cmd?: string; terminalId?: string }[] = [];
  const setAttentionQueue = (fn: (prev: AttentionItem[]) => AttentionItem[]) => { attentionQueue = fn(attentionQueue); };
  const setPendingCommands = (fn: (prev: typeof pendingCommands) => typeof pendingCommands) => { pendingCommands = fn(pendingCommands); };
  // The EXACT approval_resolved closure from useOrbitalData (clears BOTH surfaces by messageId).
  const onApprovalResolved = (messageId: string) => {
    setPendingCommands((prev) => prev.filter((c) => c.messageId !== messageId));
    setAttentionQueue((prev) => prev.filter((a) => !a.messageId || a.messageId !== messageId));
  };
  // The EXACT promotion closure (inbox → modal) — rebuilds from rawCmd, dedups against pendingCommands.
  const promoteForActive = (activeId: string | null) => {
    const it = approvalToPromote(attentionQueue, activeId);
    if (!it) return;
    setAttentionQueue((prev) => prev.filter((a) => a.id !== it.id));
    setPendingCommands((prev) => prev.some((c) => c.messageId === it.messageId)
      ? prev
      : [...prev, { messageId: it.messageId, cmd: it.rawCmd ?? "", terminalId: it.terminalId }]);
  };
  return {
    getQueue: () => attentionQueue, getPending: () => pendingCommands,
    onApprovalResolved, promoteForActive,
  };
}

describe("bead 8xn: approval_resolved clears the inbox (resolve-anywhere-clears-everywhere)", () => {
  it("a resolve for a routed messageId drops the inbox row (voice/REST/modal/TTL path)", () => {
    const state = makeRouterState([
      mkApproval({ id: "approval:m1", messageId: "m1", terminalId: "t2" }),
      mkApproval({ id: "approval:m2", messageId: "m2", terminalId: "t3" }),
    ]);
    state.onApprovalResolved("m1"); // resolved on a NON-inbox surface
    assert.deepEqual(state.getQueue().map((a) => a.messageId), ["m2"]); // m1's row is gone
    assert.equal(pendingApprovalBadgeCount(state.getQueue()), 1);       // badge reflects the drop
  });
  it("clearing the inbox row also drops the held-approval badge to zero when it was the only one", () => {
    const state = makeRouterState([mkApproval({ id: "approval:m1", messageId: "m1", terminalId: "t2" })]);
    assert.equal(pendingApprovalBadgeCount(state.getQueue()), 1); // badge present while held
    state.onApprovalResolved("m1");
    assert.equal(pendingApprovalBadgeCount(state.getQueue()), 0); // badge gone
  });
  it("a resolve never disturbs a triage row that carries no messageId", () => {
    const triage = mkApproval({ id: "tri", messageId: undefined, terminalId: "t2", type: "exited" });
    const state = makeRouterState([mkApproval({ id: "approval:m1", messageId: "m1", terminalId: "t2" }), triage]);
    state.onApprovalResolved("m1");
    assert.deepEqual(state.getQueue().map((a) => a.id), ["tri"]); // the triage row survives
  });
  it("issue #2: promotion does NOT resurrect an already-resolved approval as a fresh modal", () => {
    const state = makeRouterState([mkApproval({ id: "approval:m1", messageId: "m1", terminalId: "t2", rawCmd: "drop table users" })]);
    state.onApprovalResolved("m1");                 // server resolved it (e.g. via voice)
    state.promoteForActive("t2");                   // operator now walks to that station
    assert.equal(state.getQueue().length, 0);       // nothing left in the inbox
    assert.equal(state.getPending().length, 0);     // and NO zombie modal was popped
  });
  it("a still-held approval promotes to the modal with the RAW cmd (issue #5 — not the wrapped label)", () => {
    const item = buildAttentionApprovalItem({ messageId: "m9", terminalId: "t2", cmd: "drop table users" });
    const state = makeRouterState([item]);
    state.promoteForActive("t2");
    assert.equal(state.getQueue().length, 0);                       // left the inbox
    assert.deepEqual(state.getPending().map((c) => c.cmd), ["drop table users"]); // RAW cmd, no "needs your ok" prefix
    assert.equal(state.getPending()[0].messageId, "m9");
  });
});

describe("attnChip", () => {
  it("maps each known item type to its own emoji/label/color", () => {
    assert.equal(attnChip("error").label, "error");
    assert.equal(attnChip("build-failed").label, "build");
    assert.equal(attnChip("exited").label, "exited");
    assert.equal(attnChip("approval").label, "approval");
    assert.equal(attnChip("idle").label, "done");
  });
  it("an unknown type falls back to a generic pin chip carrying the raw type", () => {
    assert.deepEqual(attnChip("mystery"), { emoji: "📌", label: "mystery", bg: "#8a6a4f" });
    assert.deepEqual(attnChip(""), { emoji: "📌", label: "alert", bg: "#8a6a4f" });
  });
});

// ── 4. dismissAttentionOutcome — the dismiss response classifier ──────────────
// A dismiss is veto-class: gated-Off does NOT 403, it returns kind:ok → HTTP 200 with a body whose
// `output` starts with "Error:". So a bare 200 is NOT proof the alert cleared. This pins all four arms.
describe("dismissAttentionOutcome", () => {
  it("403 (some gate refuses) → blocked", () => {
    assert.equal(dismissAttentionOutcome(403, false, {}), "blocked");
  });
  it("any non-ok status (e.g. 500) → failed", () => {
    assert.equal(dismissAttentionOutcome(500, false, { error: "boom" }), "failed");
    assert.equal(dismissAttentionOutcome(404, false, {}), "failed");
  });
  it("200 with an 'Error:'-wrapped output (gate-off honesty case) → blocked, NOT a false success", () => {
    assert.equal(dismissAttentionOutcome(200, true,
      { output: "Error: the 'dismiss_attention' capability is gated Off; dismissing alerts is forbidden by policy." }),
      "blocked");
  });
  it("a clean 200 (real dismissal narration) → cleared", () => {
    assert.equal(dismissAttentionOutcome(200, true, { output: "Cleared alert a1." }), "cleared");
    assert.equal(dismissAttentionOutcome(200, true, {}), "cleared"); // no output is still a real 200
  });
});

// ── 5. dismissAttention optimistic-remove + restore wiring ────────────────────
// Reconstructs the exact closure dismissAttention runs (src/orbital/useOrbitalData.ts): capture the
// removed item, optimistically drop it, then restore() (idempotently) on a blocked/failed outcome. We
// drive a fake setState through every outcome the classifier returns and assert the queue end-state.
function makeQueueState(initial: AttentionItem[]) {
  let queue = [...initial];
  const setAttentionQueue = (fn: (prev: AttentionItem[]) => AttentionItem[]) => { queue = fn(queue); };
  return { get: () => queue, setAttentionQueue };
}
function item(id: string): AttentionItem {
  return { id, type: "exited", terminalId: "t1", projectId: "p1", message: "m", timestamp: "0", dismissed: false };
}
// Mirrors the hook's optimistic-remove + outcome-driven restore (only the queue-mutation seam — fetch
// stubbed to a (status, ok, body) triple the real handler would derive from the REST response).
function runDismiss(state: ReturnType<typeof makeQueueState>, id: string, status: number, ok: boolean, body: Record<string, unknown>) {
  let removed: AttentionItem | undefined;
  state.setAttentionQueue((prev) => { removed = prev.find((a) => a.id === id) ?? removed; return prev.filter((a) => a.id !== id); });
  const restore = () => { const r = removed; if (r) state.setAttentionQueue((prev) => (prev.some((a) => a.id === r.id) ? prev : [...prev, r])); };
  const outcome = dismissAttentionOutcome(status, ok, body);
  if (outcome === "blocked" || outcome === "failed") restore();
  return outcome;
}

describe("dismissAttention optimistic remove + restore", () => {
  it("optimistically removes the item before the response lands", () => {
    const state = makeQueueState([item("a"), item("b")]);
    let removed: AttentionItem | undefined;
    state.setAttentionQueue((prev) => { removed = prev.find((a) => a.id === "a"); return prev.filter((a) => a.id !== "a"); });
    assert.deepEqual(state.get().map((a) => a.id), ["b"]); // gone immediately
    assert.equal(removed?.id, "a");
  });
  it("restores the item on a 403 (blocked)", () => {
    const state = makeQueueState([item("a"), item("b")]);
    assert.equal(runDismiss(state, "a", 403, false, {}), "blocked");
    assert.deepEqual(state.get().map((x) => x.id).sort(), ["a", "b"]); // restored
  });
  it("restores the item on a non-ok status (failed)", () => {
    const state = makeQueueState([item("a"), item("b")]);
    assert.equal(runDismiss(state, "a", 500, false, { error: "boom" }), "failed");
    assert.deepEqual(state.get().map((x) => x.id).sort(), ["a", "b"]); // restored
  });
  it("restores the item on a gate-off 200-wrapped 'Error:' body (NOT a false success)", () => {
    const state = makeQueueState([item("a"), item("b")]);
    const out = runDismiss(state, "a", 200, true,
      { output: "Error: the 'dismiss_attention' capability is gated Off; dismissing alerts is forbidden by policy." });
    assert.equal(out, "blocked");
    assert.deepEqual(state.get().map((x) => x.id).sort(), ["a", "b"]); // restored, not silently dropped
  });
  it("keeps the item removed on a clean 200 (a real dismissal)", () => {
    const state = makeQueueState([item("a"), item("b")]);
    assert.equal(runDismiss(state, "a", 200, true, { output: "Cleared alert a." }), "cleared");
    assert.deepEqual(state.get().map((x) => x.id), ["b"]); // stays gone
  });
  it("restore is idempotent — never double-adds if the item is somehow already back", () => {
    const state = makeQueueState([item("a")]);
    // simulate the item already restored (e.g. a racing attention_updated frame) before restore() runs
    let removed: AttentionItem | undefined;
    state.setAttentionQueue((prev) => { removed = prev.find((a) => a.id === "a"); return prev.filter((a) => a.id !== "a"); });
    state.setAttentionQueue((prev) => [...prev, item("a")]); // racing re-add
    const restore = () => { const r = removed; if (r) state.setAttentionQueue((prev) => (prev.some((a) => a.id === r.id) ? prev : [...prev, r])); };
    restore();
    assert.equal(state.get().filter((x) => x.id === "a").length, 1); // exactly one, no dup
  });
});

// ── 6. bead e7h: approveAttention / denyAttention — in-inbox resolve via messageId ─────────────
// Reconstructs the exact id-gated closures the hook runs (src/orbital/useOrbitalData.ts):
//   approveAttention(item): resolve = attentionResolveTarget(item)
//     - no messageId  → selectActivePane(item.terminalId); STOP (no resolver, no queue mutation)
//     - has messageId → optimistically drop the item, then approveCommand(messageId)
//   denyAttention(item):    same gate, else dismissAttention(item.id) / rejectCommand(messageId)
// This pins that the SAME POST /api/commands/approve resolver (approveCommand/rejectCommand) is hit
// with the held-request id, and that a triage-only item never touches the resolver.
function attnItem(id: string, type: AttentionItem["type"], messageId?: string): AttentionItem {
  return { id, type, terminalId: "t9", projectId: "p1", message: "needs you", timestamp: "0", dismissed: false, ...(messageId ? { messageId } : {}) };
}
function makeResolverSpies() {
  const calls: string[] = [];
  let queue: AttentionItem[] = [];
  const spies = {
    calls,
    setQueue: (q: AttentionItem[]) => { queue = q; },
    getQueue: () => queue,
    setAttentionQueue: (fn: (prev: AttentionItem[]) => AttentionItem[]) => { queue = fn(queue); },
    selectActivePane: (paneId: string | null) => calls.push(`select:${paneId}`),
    approveCommand: (mid: string) => calls.push(`approve:${mid}`),
    rejectCommand: (mid: string) => calls.push(`reject:${mid}`),
    dismissAttention: (id: string) => calls.push(`dismiss:${id}`),
  };
  // The EXACT closures from useOrbitalData (id gate + optimistic clear).
  const approveAttention = (it: AttentionItem) => {
    const mid = attentionResolveTarget(it);
    if (!mid) { spies.selectActivePane(it.terminalId); return; }
    spies.setAttentionQueue((prev) => prev.filter((a) => a.id !== it.id));
    spies.approveCommand(mid);
  };
  const denyAttention = (it: AttentionItem) => {
    const mid = attentionResolveTarget(it);
    if (!mid) { spies.dismissAttention(it.id); return; }
    spies.setAttentionQueue((prev) => prev.filter((a) => a.id !== it.id));
    spies.rejectCommand(mid);
  };
  return { spies, approveAttention, denyAttention };
}

describe("approveAttention / denyAttention (in-inbox resolve)", () => {
  it("approve on an item WITH a messageId hits approveCommand(messageId) and clears the row", () => {
    const { spies, approveAttention } = makeResolverSpies();
    const it = attnItem("a1", "approval", "msg_77");
    spies.setQueue([it, attnItem("a2", "exited")]);
    approveAttention(it);
    assert.deepEqual(spies.calls, ["approve:msg_77"]); // SAME resolver voice uses, keyed by the held id
    assert.deepEqual(spies.getQueue().map((x) => x.id), ["a2"]); // optimistically cleared
  });
  it("deny on an item WITH a messageId hits rejectCommand(messageId) and clears the row", () => {
    const { spies, denyAttention } = makeResolverSpies();
    const it = attnItem("a1", "confirmation", "msg_88");
    spies.setQueue([it]);
    denyAttention(it);
    assert.deepEqual(spies.calls, ["reject:msg_88"]);
    assert.deepEqual(spies.getQueue().map((x) => x.id), []); // cleared
  });
  it("approve on a triage-only item (NO messageId) jumps to the station — never calls the resolver", () => {
    const { spies, approveAttention } = makeResolverSpies();
    const it = attnItem("a1", "approval"); // no held request
    spies.setQueue([it]);
    approveAttention(it);
    assert.deepEqual(spies.calls, ["select:t9"]); // jump, NOT approve
    assert.deepEqual(spies.getQueue().map((x) => x.id), ["a1"]); // queue untouched (dismiss button still clears it)
  });
  it("deny on a triage-only item (NO messageId) locally dismisses — never calls the resolver", () => {
    const { spies, denyAttention } = makeResolverSpies();
    const it = attnItem("a1", "confirmation"); // no held request
    spies.setQueue([it]);
    denyAttention(it);
    assert.deepEqual(spies.calls, ["dismiss:a1"]); // local dismiss, NOT reject
  });
  it("an error/idle item never resolves a gate even with a stray messageId (defense in depth)", () => {
    const { spies, approveAttention, denyAttention } = makeResolverSpies();
    const err = attnItem("e1", "error", "should_be_ignored");
    spies.setQueue([err]);
    approveAttention(err);
    denyAttention(err);
    assert.deepEqual(spies.calls, ["select:t9", "dismiss:e1"]); // jump + dismiss, resolver untouched
  });
});
