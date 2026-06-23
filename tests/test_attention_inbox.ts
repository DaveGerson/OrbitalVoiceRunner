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

import { attentionQueueFromFrame, dismissAttentionOutcome } from "../src/orbital/useOrbitalDataHelpers";
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
  it("approval / confirmation items are gate decisions → approve+deny", () => {
    assert.equal(attentionActKind({ type: "approval" } as never), "approve");
    assert.equal(attentionActKind({ type: "confirmation" } as never), "approve");
  });
  it("a finished/idle completion item → jump to the station (nothing to act on)", () => {
    assert.equal(attentionActKind({ type: "idle" } as never), "jump");
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
