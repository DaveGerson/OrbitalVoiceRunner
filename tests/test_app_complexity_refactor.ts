// tests/test_app_complexity_refactor.ts — CHARACTERIZATION tests for the cyclomatic-complexity
// burndown of src/App.tsx (branch claude/cyclomatic-monsters-k3x4nz). The pure derivations and the
// ws.onmessage dispatch table were relocated out of the App.tsx component body into
// src/appHelpers.ts so they can be unit-pinned without jsdom (App.tsx pulls in CSS/Vite-only
// modules that break the node runner). These pins assert the EXACT branch lattice, the BYTE-EXACT
// className strings, and the setState/side-effect ORDERING of every relocated helper, so the
// behavior-preserving refactor changes nothing observable.
//
// Imports the REAL helpers (../src/appHelpers) — never ../App or ../server.
//
// Runner: npx tsx --test --test-force-exit tests/test_app_complexity_refactor.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  resolvePaneStatus,
  paneMatchesFilter,
  countExitedPanes,
  sumContextSize,
  heatmapTileClasses,
  heatmapTooltipStatus,
  heatmapTooltipFields,
  mobileSwiperColorClass,
  sidebarPaneStatusColor,
  sidebarRowContainerClass,
  sidebarRowNameClass,
  detailedCardPresetClasses,
  presetBadgeClass,
  videowallDotClass,
  compactDotClass,
  detailedDotClass,
  compactCwdDisplay,
  compactProcessState,
  geminiVoiceColorClass,
  geminiVoiceLabel,
  totalContextTextClass,
  totalContextBarClass,
  contextMeterColor,
  classifyMarkdownLine,
  dispatchWsMessage,
  type WsHandlerCtx,
} from "../src/appHelpers";
import type { Terminal, PaneMeta } from "../src/types";

// Minimal fixture builders — only the fields the helpers read.
function term(p: Partial<Terminal>): Terminal {
  return { id: "t", cwd: "", command: "", output: "", status: "Idle", ...p } as Terminal;
}
function pane(p: Partial<PaneMeta>): PaneMeta {
  return {
    pane_id: "t", name: "n", runtime_type: "shell", last_known_state: "Idle",
    is_busy: false, alive: true, notes: [], permissions_mode: "Human-in-the-Loop",
    session_id: "", tool_preset: "Custom", context_size: 0, ...p,
  } as PaneMeta;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. resolvePaneStatus — the live-terminal-wins ladder + ledger fallback.
// ═════════════════════════════════════════════════════════════════════════════
describe("appHelpers — resolvePaneStatus", () => {
  it("live terminal status always wins when present", () => {
    assert.strictEqual(resolvePaneStatus(term({ status: "Running" }), pane({ alive: false })), "Running");
    assert.strictEqual(resolvePaneStatus(term({ status: "Exited" }), pane({ alive: true, is_busy: true })), "Exited");
  });
  it("no terminal + alive + busy -> Running", () => {
    assert.strictEqual(resolvePaneStatus(undefined, pane({ alive: true, is_busy: true })), "Running");
  });
  it("no terminal + alive + not busy -> Idle", () => {
    assert.strictEqual(resolvePaneStatus(undefined, pane({ alive: true, is_busy: false })), "Idle");
  });
  it("no terminal + not alive -> Exited", () => {
    assert.strictEqual(resolvePaneStatus(undefined, pane({ alive: false, is_busy: false })), "Exited");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. paneMatchesFilter / countExitedPanes / sumContextSize.
// ═════════════════════════════════════════════════════════════════════════════
describe("appHelpers — pane filtering + aggregation", () => {
  it("filter 'All' keeps every pane regardless of status", () => {
    assert.strictEqual(paneMatchesFilter(pane({ alive: false }), [], "All"), true);
  });
  it("filter matches the RESOLVED status (live terminal lookup by pane_id)", () => {
    const p = pane({ pane_id: "x", alive: true, is_busy: false });
    assert.strictEqual(paneMatchesFilter(p, [term({ id: "x", status: "Running" })], "Running"), true);
    assert.strictEqual(paneMatchesFilter(p, [term({ id: "x", status: "Running" })], "Idle"), false);
    // No live terminal -> falls back to ledger flags (alive+!busy -> Idle).
    assert.strictEqual(paneMatchesFilter(p, [], "Idle"), true);
  });
  it("countExitedPanes counts resolved-Exited panes; undefined map -> 0", () => {
    assert.strictEqual(countExitedPanes(undefined, []), 0);
    const panes = { a: pane({ pane_id: "a", alive: false }), b: pane({ pane_id: "b", alive: true, is_busy: true }) };
    assert.strictEqual(countExitedPanes(panes, []), 1);
    // A live terminal overrides the ledger flag.
    assert.strictEqual(countExitedPanes(panes, [term({ id: "b", status: "Exited" })]), 2);
  });
  it("sumContextSize prefers the live terminal size, else the pane size; undefined map -> 0", () => {
    assert.strictEqual(sumContextSize(undefined, []), 0);
    const panes = { a: pane({ pane_id: "a", context_size: 100 }), b: pane({ pane_id: "b", context_size: 50 }) };
    assert.strictEqual(sumContextSize(panes, []), 150);
    // term.context_size === 0 (defined) wins over pane's 100.
    assert.strictEqual(sumContextSize(panes, [term({ id: "a", context_size: 0 })]), 50);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Status -> className derivations (byte-exact).
// ═════════════════════════════════════════════════════════════════════════════
describe("appHelpers — heatmapTileClasses", () => {
  it("alert dominates", () => {
    const c = heatmapTileClasses(true, term({ status: "Idle" }));
    assert.strictEqual(c.dotColor, "bg-amber-500");
    assert.strictEqual(c.animateDot, "animate-ping");
    assert.strictEqual(c.borderClass, "border-amber-500/70 shadow-[0_0_8px_rgba(245,158,11,0.2)]");
  });
  it("running + quiescing -> muted amber (no animate)", () => {
    const c = heatmapTileClasses(false, term({ status: "Running", quiescing: true }));
    assert.strictEqual(c.bgClass, "bg-amber-500/5");
    assert.strictEqual(c.animateDot, "");
    assert.strictEqual(c.dotColor, "bg-amber-400/70");
  });
  it("running -> emerald pulse", () => {
    const c = heatmapTileClasses(false, term({ status: "Running" }));
    assert.strictEqual(c.dotColor, "bg-emerald-500");
    assert.strictEqual(c.animateDot, "animate-pulse");
  });
  it("idle -> yellow; exited (default) -> red", () => {
    assert.strictEqual(heatmapTileClasses(false, term({ status: "Idle" })).dotColor, "bg-yellow-500");
    assert.strictEqual(heatmapTileClasses(false, term({ status: "Exited" })).dotColor, "bg-red-500");
  });
});

describe("appHelpers — heatmapTooltipStatus", () => {
  it("alert / quiescing / running / exited / idle labels", () => {
    assert.strictEqual(heatmapTooltipStatus(true, term({})).statusLabel, "AWAITING APPROVAL");
    assert.strictEqual(heatmapTooltipStatus(false, term({ status: "Running", quiescing: true })).statusLabel, "COOKING…");
    assert.strictEqual(heatmapTooltipStatus(false, term({ status: "Running" })).statusLabel, "ACTIVE EXECUTING");
    assert.strictEqual(heatmapTooltipStatus(false, term({ status: "Exited" })).statusLabel, "TERMINATED");
    assert.strictEqual(heatmapTooltipStatus(false, term({ status: "Idle" })).statusLabel, "Idle & Listening");
  });
});

describe("appHelpers — mobileSwiperColorClass precedence", () => {
  it("alert > active > quiescing > running > idle > default", () => {
    assert.match(mobileSwiperColorClass(true, true, term({ status: "Running" })), /amber-500 .*animate-pulse/);
    assert.match(mobileSwiperColorClass(false, true, term({ status: "Idle" })), /cyan-500/);
    assert.strictEqual(mobileSwiperColorClass(false, false, term({ status: "Running", quiescing: true })), "border-amber-500/40 text-amber-400/80 bg-amber-500/5");
    assert.strictEqual(mobileSwiperColorClass(false, false, term({ status: "Running" })), "border-green-500/50 text-green-400 bg-green-500/5");
    assert.strictEqual(mobileSwiperColorClass(false, false, term({ status: "Idle" })), "border-yellow-500/50 text-yellow-500 bg-yellow-500/5");
    assert.strictEqual(mobileSwiperColorClass(false, false, term({ status: "Exited" })), "border-zinc-850 text-zinc-500 bg-black/40");
  });
});

describe("appHelpers — sidebarPaneStatusColor", () => {
  it("alert dominates everything", () => {
    assert.match(sidebarPaneStatusColor(true, term({ status: "Running" }), pane({}), ""), /amber-500 .*animate-pulse/);
  });
  it("with a live terminal: running/idle/exited arms; idle carries the heartbeat suffix", () => {
    assert.match(sidebarPaneStatusColor(false, term({ status: "Running" }), pane({}), ""), /green-500/);
    assert.strictEqual(
      sidebarPaneStatusColor(false, term({ status: "Idle" }), pane({}), "heartbeat-animation"),
      "bg-yellow-500 shadow-[0_0_8px_rgba(234,179,8,0.6)] heartbeat-animation",
    );
    assert.strictEqual(sidebarPaneStatusColor(false, term({ status: "Exited" }), pane({}), ""), "bg-red-500");
  });
  it("no live terminal: falls back to alive/is_busy flags", () => {
    assert.match(sidebarPaneStatusColor(false, undefined, pane({ alive: true, is_busy: true }), ""), /green-500/);
    assert.match(sidebarPaneStatusColor(false, undefined, pane({ alive: true, is_busy: false }), "hb"), /yellow-500 .*hb$/);
    assert.strictEqual(sidebarPaneStatusColor(false, undefined, pane({ alive: false, is_busy: false }), ""), "bg-red-500");
  });
});

describe("appHelpers — preset class derivations", () => {
  it("detailedCardPresetClasses by preset", () => {
    assert.match(detailedCardPresetClasses("Claude Code").primaryColorClass, /purple-500/);
    assert.match(detailedCardPresetClasses("Codex").bgHover, /orange-500/);
    assert.match(detailedCardPresetClasses("Antigravity").primaryColorClass, /cyan-500/);
    const fallback = detailedCardPresetClasses(undefined);
    assert.strictEqual(fallback.primaryColorClass, "border-zinc-800 text-zinc-400");
    assert.strictEqual(fallback.presetLabel, "Custom");
    assert.strictEqual(detailedCardPresetClasses("Codex").presetLabel, "Codex");
  });
  it("presetBadgeClass honors the passed-in zinc fallback (differs per site)", () => {
    assert.strictEqual(presetBadgeClass("Claude Code", "X"), "bg-purple-500/10 text-purple-400");
    assert.strictEqual(presetBadgeClass("Codex", "X"), "bg-orange-500/10 text-orange-400");
    assert.strictEqual(presetBadgeClass("Antigravity", "X"), "bg-cyan-500/10 text-cyan-400");
    assert.strictEqual(presetBadgeClass(undefined, "bg-zinc-805 text-zinc-500"), "bg-zinc-805 text-zinc-500");
    assert.strictEqual(presetBadgeClass("Custom", "bg-zinc-800 text-zinc-400"), "bg-zinc-800 text-zinc-400");
  });
  it("contextMeterColor thresholds (>15000 red, >8000 amber, else cyan)", () => {
    assert.strictEqual(contextMeterColor(20000), "bg-red-500");
    assert.strictEqual(contextMeterColor(15001), "bg-red-500");
    assert.strictEqual(contextMeterColor(15000), "bg-amber-500");
    assert.strictEqual(contextMeterColor(8001), "bg-amber-500");
    assert.strictEqual(contextMeterColor(8000), "bg-cyan-500");
    assert.strictEqual(contextMeterColor(0), "bg-cyan-500");
  });
});

describe("appHelpers — heatmapTooltipFields", () => {
  it("dot color (alert > running > else), defaults, context text, command text, byte count", () => {
    const f = heatmapTooltipFields(true, term({ status: "Idle", context_size: 500, output: "abc" }));
    assert.strictEqual(f.dotColorClass, "bg-amber-500");
    const g = heatmapTooltipFields(false, term({ status: "Running", tool_preset: undefined, permissions_mode: undefined, command: "", output: undefined as any, context_size: 1500 }));
    assert.strictEqual(g.dotColorClass, "bg-emerald-500");
    assert.strictEqual(g.presetText, "Custom Shell Engine");
    assert.strictEqual(g.modeText, "Human-in-the-Loop");
    assert.strictEqual(g.commandText, "idle waiting");
    assert.strictEqual(g.contextSizeText, "1.5k chars");
    assert.strictEqual(g.outputBytes, 0);
    assert.strictEqual(heatmapTooltipFields(false, term({ status: "Idle" })).dotColorClass, "bg-yellow-500");
    assert.strictEqual(heatmapTooltipFields(false, term({ context_size: 999 })).contextSizeText, "999 chars");
  });
});

describe("appHelpers — sidebar row class chains", () => {
  it("container + name (alert > active > default)", () => {
    assert.match(sidebarRowContainerClass(true, false), /amber-500/);
    assert.match(sidebarRowContainerClass(false, true), /white\/5/);
    assert.strictEqual(sidebarRowContainerClass(false, false), "border border-transparent hover:bg-white/5");
    assert.strictEqual(sidebarRowNameClass(true, true), "text-amber-400 font-bold");
    assert.strictEqual(sidebarRowNameClass(false, true), "font-bold text-cyan-400");
    assert.strictEqual(sidebarRowNameClass(false, false), "opacity-80");
  });
});

describe("appHelpers — dashboard status dots", () => {
  it("videowall has NO idle heartbeat; compact/detailed carry it; shadows differ per card", () => {
    assert.strictEqual(videowallDotClass(false, "Idle"), "bg-yellow-500 shadow-[0_0_4px_rgba(234,179,8,0.2)]");
    assert.strictEqual(compactDotClass(false, "Idle", "hb"), "bg-yellow-500 shadow-[0_0_6px_rgba(234,179,8,0.2)] hb");
    assert.strictEqual(detailedDotClass(false, "Idle", "hb"), "bg-yellow-500 shadow-[0_0_8px_rgba(234,179,8,0.2)] hb");
    assert.match(videowallDotClass(true, "Idle"), /amber-500 .*animate-ping/);
    assert.match(detailedDotClass(true, "Running", ""), /shadow-\[0_0_12px/);
    assert.strictEqual(compactDotClass(false, "Exited", ""), "bg-red-500");
  });
});

describe("appHelpers — compact card helpers", () => {
  it("cwd display: long truncates to ...tail-25, short kept, undefined -> /workspace", () => {
    assert.strictEqual(compactCwdDisplay(undefined), "/workspace");
    assert.strictEqual(compactCwdDisplay("/short"), "/short");
    const long = "/a/very/long/path/that/exceeds/twenty-five-characters";
    assert.strictEqual(compactCwdDisplay(long), "..." + long.slice(-25));
  });
  it("process state label + class (running > alert > idle)", () => {
    assert.deepStrictEqual(compactProcessState("Running", false), { label: "Running", className: "text-green-400" });
    assert.deepStrictEqual(compactProcessState("Idle", true), { label: "Awaiting", className: "text-amber-400" });
    assert.deepStrictEqual(compactProcessState("Idle", false), { label: "Idle", className: "text-zinc-500" });
  });
});

describe("appHelpers — header derivations", () => {
  it("gemini voice color/label (live > reconnect > mute > offline)", () => {
    assert.strictEqual(geminiVoiceColorClass(false, false, false), "text-zinc-600");
    assert.strictEqual(geminiVoiceLabel(false, false, false), "OFFLINE");
    assert.strictEqual(geminiVoiceColorClass(true, true, false), "text-amber-500 animate-pulse");
    assert.strictEqual(geminiVoiceLabel(true, true, false), "RECONNECTING...");
    assert.strictEqual(geminiVoiceColorClass(true, false, true), "text-amber-400");
    assert.strictEqual(geminiVoiceLabel(true, false, true), "MUTED");
    assert.strictEqual(geminiVoiceColorClass(true, false, false), "text-green-400");
    assert.strictEqual(geminiVoiceLabel(true, false, false), "LISTENING...");
  });
  it("total-context text + bar classes (>80k red, >40k amber, else cyan)", () => {
    assert.match(totalContextTextClass(90000), /red-400/);
    assert.strictEqual(totalContextTextClass(50000), "text-amber-400 font-bold");
    assert.strictEqual(totalContextTextClass(10000), "text-cyan-400");
    assert.strictEqual(totalContextBarClass(90000), "bg-red-500 shadow-[0_0_8px_#ef4444]");
    assert.strictEqual(totalContextBarClass(50000), "bg-amber-500");
    assert.strictEqual(totalContextBarClass(0), "bg-cyan-500");
  });
});

describe("appHelpers — classifyMarkdownLine", () => {
  it("headers strip their marker (longest first)", () => {
    assert.deepStrictEqual(classifyMarkdownLine("### Hi"), { kind: "h4", text: "Hi", isChecklist: false, isChecked: false });
    assert.deepStrictEqual(classifyMarkdownLine("## Hi"), { kind: "h3", text: "Hi", isChecklist: false, isChecked: false });
    assert.deepStrictEqual(classifyMarkdownLine("# Hi"), { kind: "h2", text: "Hi", isChecklist: false, isChecked: false });
  });
  it("hr / blank", () => {
    assert.strictEqual(classifyMarkdownLine("---").kind, "hr");
    assert.strictEqual(classifyMarkdownLine("   ").kind, "blank");
  });
  it("checklist (unchecked/checked) and plain bullets strip the marker", () => {
    assert.deepStrictEqual(classifyMarkdownLine("- [ ] task"), { kind: "list", text: "task", isChecklist: true, isChecked: false });
    assert.deepStrictEqual(classifyMarkdownLine("- [x] done"), { kind: "list", text: "done", isChecklist: true, isChecked: true });
    assert.deepStrictEqual(classifyMarkdownLine("- [X] DONE"), { kind: "list", text: "DONE", isChecklist: true, isChecked: true });
    assert.deepStrictEqual(classifyMarkdownLine("- bullet"), { kind: "list", text: "bullet", isChecklist: false, isChecked: false });
    assert.deepStrictEqual(classifyMarkdownLine("* star"), { kind: "list", text: "star", isChecklist: false, isChecked: false });
  });
  it("normal text returns the ORIGINAL (untrimmed) line — the renderer feeds parseInlines(line)", () => {
    assert.deepStrictEqual(classifyMarkdownLine("  hello world  "), { kind: "text", text: "  hello world  ", isChecklist: false, isChecked: false });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. dispatchWsMessage — the ws.onmessage table. A recording ctx captures call order.
// ═════════════════════════════════════════════════════════════════════════════
function recCtx() {
  const order: string[] = [];
  const calls: any = { order, transcript: [] as any[], terminalsUpdater: null as any, errors: [] as any[] };
  const ctx: WsHandlerCtx = {
    playEarcon: (t) => order.push(`earcon:${t}`),
    triggerDesktopNotification: (title) => order.push(`desktop:${title}`),
    setPendingCommands: (u) => { order.push("setPendingCommands"); calls.pendingCommandsUpdater = u; },
    setPendingActions: (u) => { order.push("setPendingActions"); calls.pendingActionsUpdater = u; },
    setActiveTerminalId: (id) => { order.push("setActiveTerminalId"); calls.activeId = id; },
    setIsBufferFocused: (u) => { order.push("setIsBufferFocused"); calls.bufferFocusedUpdater = u; },
    setPromptBuffer: (v) => { order.push("setPromptBuffer"); calls.promptBuffer = v; },
    fetchWipDrafts: (p) => { order.push("fetchWipDrafts"); calls.wipProject = p; },
    setTerminals: (u) => { order.push("setTerminals"); calls.terminalsUpdater = u; },
    setFrozen: (v) => { order.push("setFrozen"); calls.frozen = v; },
    setFrozenRunning: (u) => { order.push("setFrozenRunning"); calls.frozenRunningUpdater = u; },
    setLedger: (v) => { order.push("setLedger"); calls.ledger = v; },
    setGlobalPermissionsMode: (v) => { order.push("setGlobalPermissionsMode"); calls.gpm = v; },
    setSettings: (v) => { order.push("setSettings"); calls.settings = v; },
    setIsMicMuted: (v) => { order.push("setIsMicMuted"); calls.micMuted = v; },
    setAutoApprovedNotification: (v) => { order.push("setAutoApprovedNotification"); calls.autoApproved = v; },
    setBlockedNotification: (v) => { order.push("setBlockedNotification"); calls.blocked = v; },
    setTranscript: (u) => { order.push("setTranscript"); calls.transcriptUpdater = u; },
    setWsErrorNotification: (v) => { order.push("setWsErrorNotification"); calls.errors.push(v); },
    setProactiveNotifications: (u) => { order.push("setProactiveNotifications"); calls.proactiveUpdater = u; },
    setPlans: (v) => { order.push("setPlans"); calls.plans = v; },
    queueStdoutChunk: (id, chunk) => { order.push("queueStdoutChunk"); calls.chunk = [id, chunk]; },
    fetchTerminals: () => order.push("fetchTerminals"),
    fetchPlans: () => order.push("fetchPlans"),
    fetchActiveTerminalHistory: (id) => { order.push("fetchActiveTerminalHistory"); calls.histId = id; },
    resetAudioPlayback: () => order.push("resetAudioPlayback"),
    playAudioChunk: (m) => { order.push("playAudioChunk"); calls.audio = m.audio; },
    upsertNotification: (prev, entry) => { calls.upsertEntry = entry; return [...(prev || []), entry]; },
    effectForEvent: (m) => calls.effect !== undefined ? calls.effect : (calls.effect = m.__effect ?? null),
    activeTerminalIdRef: { current: "active-pane" },
  };
  return { ctx, calls, order };
}

describe("appHelpers — dispatchWsMessage routing + ordering", () => {
  it("audio with payload calls playAudioChunk; audio without payload no-ops (no fallback fire)", () => {
    const a = recCtx();
    dispatchWsMessage({ type: "audio", audio: "QQ==" }, a.ctx);
    assert.deepStrictEqual(a.order, ["playAudioChunk"]);
    assert.strictEqual(a.calls.audio, "QQ==");
    const b = recCtx();
    dispatchWsMessage({ type: "audio" }, b.ctx);
    assert.deepStrictEqual(b.order, []);
  });
  it("interrupted -> resetAudioPlayback", () => {
    const a = recCtx();
    dispatchWsMessage({ type: "interrupted" }, a.ctx);
    assert.deepStrictEqual(a.order, ["resetAudioPlayback"]);
  });
  it("approval_pending: earcon, desktop, then setPendingCommands (ORDER); updater dedupes by messageId", () => {
    const a = recCtx();
    dispatchWsMessage({ type: "approval_pending", terminalId: "T1", cmd: "ls", messageId: "m1" }, a.ctx);
    assert.deepStrictEqual(a.order, ["earcon:alert", "desktop:🚨 Approval Pending", "setPendingCommands"]);
    const out = a.calls.pendingCommandsUpdater([]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].messageId, "m1");
    // dedupe: existing messageId returns prev unchanged.
    const same = a.calls.pendingCommandsUpdater([{ messageId: "m1" }]);
    assert.strictEqual(same.length, 1);
  });
  it("action_pending: earcon, desktop, setPendingActions; updater dedupes by actionId", () => {
    const a = recCtx();
    dispatchWsMessage({ type: "action_pending", actionId: "a1", summary: "do it" }, a.ctx);
    assert.deepStrictEqual(a.order, ["earcon:alert", "desktop:⚙ Action Pending", "setPendingActions"]);
    assert.strictEqual(a.calls.pendingActionsUpdater([]).length, 1);
    assert.strictEqual(a.calls.pendingActionsUpdater([{ actionId: "a1" }]).length, 1);
  });
  it("action_resolved / approval_resolved filter their respective lists", () => {
    const a = recCtx();
    dispatchWsMessage({ type: "action_resolved", actionId: "a1" }, a.ctx);
    assert.deepStrictEqual(a.calls.pendingActionsUpdater([{ actionId: "a1" }, { actionId: "a2" }]), [{ actionId: "a2" }]);
    const b = recCtx();
    dispatchWsMessage({ type: "approval_resolved", messageId: "m1" }, b.ctx);
    assert.deepStrictEqual(b.calls.pendingCommandsUpdater([{ messageId: "m1" }, { messageId: "m2" }]), [{ messageId: "m2" }]);
  });
  it("switch_active_pane sets active only when paneId present", () => {
    const a = recCtx();
    dispatchWsMessage({ type: "switch_active_pane", paneId: "p9" }, a.ctx);
    assert.strictEqual(a.calls.activeId, "p9");
    const b = recCtx();
    dispatchWsMessage({ type: "switch_active_pane" }, b.ctx);
    assert.deepStrictEqual(b.order, []);
  });
  it("draft_updated: active pane + unfocused -> setPromptBuffer; always fetchWipDrafts", () => {
    const a = recCtx();
    dispatchWsMessage({ type: "draft_updated", paneId: "active-pane", projectId: "P", draft: { text: "hi" } }, a.ctx);
    assert.deepStrictEqual(a.order, ["setIsBufferFocused", "fetchWipDrafts"]);
    // unfocused updater writes the buffer and returns focus unchanged.
    const ret = a.calls.bufferFocusedUpdater(false);
    assert.strictEqual(ret, false);
    assert.strictEqual(a.calls.promptBuffer, "hi");
    // focused updater does NOT write the buffer.
    const b = recCtx();
    dispatchWsMessage({ type: "draft_updated", paneId: "active-pane", projectId: "P", draft: { text: "z" } }, b.ctx);
    b.calls.bufferFocusedUpdater(true);
    assert.ok(!b.order.includes("setPromptBuffer"));
    // non-active pane: no buffer mirror, only fetchWipDrafts.
    const c = recCtx();
    dispatchWsMessage({ type: "draft_updated", paneId: "other", projectId: "P" }, c.ctx);
    assert.deepStrictEqual(c.order, ["fetchWipDrafts"]);
  });
  it("pane_status / pane_quiescing patch terminals in place", () => {
    const a = recCtx();
    dispatchWsMessage({ type: "pane_status", terminalId: "x", status: "Running" }, a.ctx);
    const patched = a.calls.terminalsUpdater([{ id: "x", status: "Idle", quiescing: true }, { id: "y", status: "Idle" }]);
    assert.deepStrictEqual(patched[0], { id: "x", status: "Running", quiescing: false });
    assert.deepStrictEqual(patched[1], { id: "y", status: "Idle" });
    const b = recCtx();
    dispatchWsMessage({ type: "pane_quiescing", terminalId: "x" }, b.ctx);
    assert.strictEqual(b.calls.terminalsUpdater([{ id: "x", status: "Running" }])[0].quiescing, true);
  });
  it("terminals_updated -> fetchTerminals", () => {
    const a = recCtx();
    dispatchWsMessage({ type: "terminals_updated" }, a.ctx);
    assert.deepStrictEqual(a.order, ["fetchTerminals"]);
  });
  it("frozen: setFrozen, setFrozenRunning, earcon only when frozen, then fetchTerminals (ORDER)", () => {
    const a = recCtx();
    dispatchWsMessage({ type: "frozen", frozen: true, running: ["r1"] }, a.ctx);
    assert.deepStrictEqual(a.order, ["setFrozen", "setFrozenRunning", "earcon:alert", "fetchTerminals"]);
    assert.strictEqual(a.calls.frozen, true);
    // frozen passes a VALUE (array), not a functional updater.
    assert.deepStrictEqual(a.calls.frozenRunningUpdater, ["r1"]);
    // not frozen: no earcon; absent running -> [].
    const b = recCtx();
    dispatchWsMessage({ type: "frozen", frozen: false }, b.ctx);
    assert.deepStrictEqual(b.order, ["setFrozen", "setFrozenRunning", "fetchTerminals"]);
    assert.deepStrictEqual(b.calls.frozenRunningUpdater, []);
  });
  it("stop_all filters killed from frozenRunning then fetchTerminals", () => {
    const a = recCtx();
    dispatchWsMessage({ type: "stop_all", killed: ["k1"] }, a.ctx);
    assert.deepStrictEqual(a.order, ["setFrozenRunning", "fetchTerminals"]);
    assert.deepStrictEqual(a.calls.frozenRunningUpdater(["k1", "k2"]), ["k2"]);
    // no killed array: only fetchTerminals.
    const b = recCtx();
    dispatchWsMessage({ type: "stop_all" }, b.ctx);
    assert.deepStrictEqual(b.order, ["fetchTerminals"]);
  });
  it("ledger_updated -> setLedger(msg.ledger)", () => {
    const a = recCtx();
    dispatchWsMessage({ type: "ledger_updated", ledger: { z: 1 } }, a.ctx);
    assert.deepStrictEqual(a.calls.ledger, { z: 1 });
  });
  it("settings_updated: gpm only when defined; settings + mute only when present", () => {
    const a = recCtx();
    dispatchWsMessage({ type: "settings_updated", settings: { voiceAi: { isMicMuted: true } } }, a.ctx);
    assert.deepStrictEqual(a.order, ["setSettings", "setIsMicMuted"]);
    assert.strictEqual(a.calls.micMuted, true);
    // gpm present, no settings.
    const b = recCtx();
    dispatchWsMessage({ type: "settings_updated", globalPermissionsMode: "Read-Only" }, b.ctx);
    assert.deepStrictEqual(b.order, ["setGlobalPermissionsMode"]);
    // settings present but no boolean mute -> no setIsMicMuted.
    const c = recCtx();
    dispatchWsMessage({ type: "settings_updated", settings: { voiceAi: {} } }, c.ctx);
    assert.deepStrictEqual(c.order, ["setSettings"]);
  });
  it("command_auto_executed: earcon, desktop, setAuto, fetchTerminals (ORDER)", () => {
    const a = recCtx();
    dispatchWsMessage({ type: "command_auto_executed", terminalId: "T", cmd: "go" }, a.ctx);
    assert.deepStrictEqual(a.order, ["earcon:execute", "desktop:▶ Command Auto-Approved", "setAutoApprovedNotification", "fetchTerminals"]);
    assert.deepStrictEqual(a.calls.autoApproved, { terminalId: "T", cmd: "go" });
  });
  it("command_blocked: earcon, desktop, setBlocked (ORDER)", () => {
    const a = recCtx();
    dispatchWsMessage({ type: "command_blocked", terminalId: "T", cmd: "rm", reason: "ro" }, a.ctx);
    assert.deepStrictEqual(a.order, ["earcon:alert", "desktop:⛔ Command Blocked (Read-Only)", "setBlockedNotification"]);
    assert.deepStrictEqual(a.calls.blocked, { terminalId: "T", cmd: "rm", reason: "ro" });
  });
  it("stdout_chunk -> queueStdoutChunk(terminalId, chunk)", () => {
    const a = recCtx();
    dispatchWsMessage({ type: "stdout_chunk", terminalId: "T", chunk: "out" }, a.ctx);
    assert.deepStrictEqual(a.calls.chunk, ["T", "out"]);
  });
  it("transcript_text appends + caps at 50", () => {
    const a = recCtx();
    dispatchWsMessage({ type: "transcript_text", sender: "User", text: "hi" }, a.ctx);
    const prev = Array.from({ length: 50 }, (_, i) => ({ sender: "User", text: String(i), timestamp: new Date() }));
    const out = a.calls.transcriptUpdater(prev);
    assert.strictEqual(out.length, 50);
    assert.strictEqual(out[out.length - 1].text, "hi");
  });
  it("grounding: attaches to the most recent Janus turn; no-op when nothing to show / no Janus", () => {
    const a = recCtx();
    dispatchWsMessage({ type: "grounding", sources: [{ uri: "u", title: "T" }], queries: [] }, a.ctx);
    const prev = [{ sender: "User", text: "q" }, { sender: "Janus", text: "a" }];
    const out = a.calls.transcriptUpdater(prev);
    assert.deepStrictEqual(out[1].grounding, { queries: [], sources: [{ uri: "u", title: "T" }] });
    assert.strictEqual(out[0].grounding, undefined);
    // no Janus turn -> prev unchanged (same updater, non-empty payload, but no Janus to attach to).
    assert.deepStrictEqual(a.calls.transcriptUpdater([{ sender: "User", text: "x" }]), [{ sender: "User", text: "x" }]);
    // empty sources+queries -> prev returned reference-equal (separate dispatch).
    const b = recCtx();
    dispatchWsMessage({ type: "grounding", sources: [], queries: [] }, b.ctx);
    assert.strictEqual(b.calls.transcriptUpdater(prev), prev);
  });
  it("error: earcon, setWsError, resetAudioPlayback (ORDER); default message when absent", () => {
    const a = recCtx();
    dispatchWsMessage({ type: "error", message: "boom" }, a.ctx);
    assert.deepStrictEqual(a.order, ["earcon:alert", "setWsErrorNotification", "resetAudioPlayback"]);
    assert.deepStrictEqual(a.calls.errors[0], { message: "boom" });
    const b = recCtx();
    dispatchWsMessage({ type: "error" }, b.ctx);
    assert.match(b.calls.errors[0].message, /unexpected error occurred/);
  });
  it("proactive_earcon plays only when an earcon is present", () => {
    const a = recCtx();
    dispatchWsMessage({ type: "proactive_earcon", earcon: "chime" }, a.ctx);
    assert.deepStrictEqual(a.order, ["earcon:chime"]);
    const b = recCtx();
    dispatchWsMessage({ type: "proactive_earcon" }, b.ctx);
    assert.deepStrictEqual(b.order, []);
  });
  it("history_updated refreshes only when it concerns the active pane", () => {
    const a = recCtx();
    dispatchWsMessage({ type: "history_updated", terminalId: "active-pane" }, a.ctx);
    assert.deepStrictEqual(a.order, ["fetchActiveTerminalHistory"]);
    assert.strictEqual(a.calls.histId, "active-pane");
    const b = recCtx();
    dispatchWsMessage({ type: "history_updated", terminalId: "other" }, b.ctx);
    assert.deepStrictEqual(b.order, []);
  });
  it("proactive_notification upserts the coalesced entry", () => {
    const a = recCtx();
    dispatchWsMessage({ type: "proactive_notification", id: "n1", kind: "k", terminalId: "T", severity: "info", message: "m", timestamp: 1 }, a.ctx);
    assert.deepStrictEqual(a.order, ["setProactiveNotifications"]);
    const out = a.calls.proactiveUpdater([]);
    assert.deepStrictEqual(out, [{ id: "n1", kind: "k", terminalId: "T", severity: "info", message: "m", timestamp: 1 }]);
  });
  it("unmapped type falls through to the eventBus effect (setter + earcon)", () => {
    const a = recCtx();
    a.calls.effect = { setter: "setPlans", earcon: "execute" };
    dispatchWsMessage({ type: "plans_updated", plans: [{ id: "p" }] }, a.ctx);
    assert.deepStrictEqual(a.order, ["setPlans", "earcon:execute"]);
    assert.deepStrictEqual(a.calls.plans, [{ id: "p" }]);
  });
  it("unmapped type with fetchTerminals/fetchPlans setters routes correctly", () => {
    const a = recCtx();
    a.calls.effect = { setter: "fetchTerminals", earcon: null };
    dispatchWsMessage({ type: "pane_transition" }, a.ctx);
    assert.deepStrictEqual(a.order, ["fetchTerminals"]);
    const b = recCtx();
    b.calls.effect = { setter: "fetchPlans", earcon: "success" };
    dispatchWsMessage({ type: "plan_completed" }, b.ctx);
    assert.deepStrictEqual(b.order, ["fetchPlans", "earcon:success"]);
  });
  it("unmapped type with no effect -> nothing happens", () => {
    const a = recCtx();
    a.calls.effect = null;
    dispatchWsMessage({ type: "totally_unknown" }, a.ctx);
    assert.deepStrictEqual(a.order, []);
  });
  it("prototype-safe: a '__proto__' type never resolves an inherited handler (-> fallback)", () => {
    const a = recCtx();
    a.calls.effect = null;
    dispatchWsMessage({ type: "__proto__" }, a.ctx);
    assert.deepStrictEqual(a.order, []);
    const b = recCtx();
    b.calls.effect = null;
    dispatchWsMessage({ type: "constructor" }, b.ctx);
    assert.deepStrictEqual(b.order, []);
  });
});
