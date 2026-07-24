// src/appHelpers.ts — PURE, DOM-free helpers extracted from src/App.tsx during the cyclomatic-
// complexity burndown (branch claude/cyclomatic-monsters-k3x4nz). App.tsx imports CSS/Vite-only
// modules that break the node test runner, so the deterministic derivations (status resolution,
// status→className maps, the context-size reducers, the exited-pane filters) and the typed
// ws.onmessage dispatch table live HERE so they can be unit-pinned without jsdom.
//
// Every function in this module is a VERBATIM relocation of logic that previously lived inline in
// App.tsx — same branches, same byte-exact className strings, same default fall-throughs. The
// refactor only RELOCATES computation; it changes nothing observable.

import type { Terminal, PaneMeta, Workspace, PendingCommand } from "./types";
import type { ProjectNote } from "./classic/hooks/useLedgerData";
import type { EarconType } from "./announcementKinds";
import { requestNotifyPermission } from "./utils/notify";

// ─────────────────────────────────────────────────────────────────────────────
// Status resolution + pane filtering (the `term?.status || (pane.alive ? …)` idiom, repeated
// verbatim at App.tsx in the sidebar filter, the dashboard filter, the exited-count, and the
// Clear-Exited guard). The fallback ladder is identical at every site.
// ─────────────────────────────────────────────────────────────────────────────

/** The pane's effective status: the live terminal's status if present, else derived from the
 *  ledger pane's alive/is_busy flags. Mirrors the inline expression at every filter/derive site. */
export function resolvePaneStatus(
  term: Terminal | undefined,
  pane: Pick<PaneMeta, "alive" | "is_busy">,
): string {
  return term?.status || (pane.alive ? (pane.is_busy ? "Running" : "Idle") : "Exited");
}

/** The sidebar/dashboard pane filter: "All" keeps everything, otherwise keep panes whose resolved
 *  status === the filter. Verbatim from the two `.filter(pane => …)` callbacks. */
export function paneMatchesFilter(
  pane: PaneMeta,
  terminals: Terminal[],
  termFilter: string,
): boolean {
  if (termFilter === "All") return true;
  const term = terminals.find((t) => t.id === pane.pane_id);
  return resolvePaneStatus(term, pane) === termFilter;
}

/** Count of Exited panes in a project's pane map (Clear-Exited guard + button-visibility guard). */
export function countExitedPanes(
  panes: Record<string, PaneMeta> | undefined,
  terminals: Terminal[],
): number {
  if (!panes) return 0;
  return Object.values(panes).filter((pane) => {
    const term = terminals.find((t) => t.id === pane.pane_id);
    return resolvePaneStatus(term, pane) === "Exited";
  }).length;
}

/** Aggregate context-size across a project's panes (live terminal size wins, else the pane's). */
export function sumContextSize(
  panes: Record<string, PaneMeta> | undefined,
  terminals: Terminal[],
): number {
  if (!panes) return 0;
  return Object.values(panes).reduce((sum, pane) => {
    const term = terminals.find((t) => t.id === pane.pane_id);
    return sum + resolveCardContextSize(term, pane);
  }, 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Status → className derivations. Each returns the EXACT class string(s) the inline JSX produced
// for a given (isAlertActive, status, quiescing) tuple, so the visual output is byte-identical.
// ─────────────────────────────────────────────────────────────────────────────

/** Heatmap tile palette (App.tsx renderTerminalHealthHeatmap tile loop). Returns the four class
 *  fragments; the cyan active-glow override is applied AFTER by the caller (verbatim order). */
export function heatmapTileClasses(isAlertActive: boolean, term: Terminal): {
  bgClass: string; borderClass: string; textClass: string; animateDot: string; dotColor: string;
} {
  if (isAlertActive) {
    return {
      bgClass: "bg-amber-500/15",
      borderClass: "border-amber-500/70 shadow-[0_0_8px_rgba(245,158,11,0.2)]",
      textClass: "text-amber-300 font-extrabold",
      animateDot: "animate-ping",
      dotColor: "bg-amber-500",
    };
  }
  if (term.status === "Running" && term.quiescing) {
    return {
      bgClass: "bg-amber-500/5",
      borderClass: "border-amber-500/20",
      textClass: "text-amber-400/70",
      animateDot: "",
      dotColor: "bg-amber-400/70",
    };
  }
  if (term.status === "Running") {
    return {
      bgClass: "bg-emerald-500/10",
      borderClass: "border-emerald-500/30",
      textClass: "text-emerald-400 font-semibold",
      animateDot: "animate-pulse",
      dotColor: "bg-emerald-500",
    };
  }
  if (term.status === "Idle") {
    return {
      bgClass: "bg-yellow-500/5",
      borderClass: "border-yellow-500/20",
      textClass: "text-yellow-500/80",
      animateDot: "",
      dotColor: "bg-yellow-500",
    };
  }
  return {
    bgClass: "bg-red-500/5",
    borderClass: "border-red-500/20",
    textClass: "text-red-400/80",
    animateDot: "",
    dotColor: "bg-red-500",
  };
}

/** Heatmap tooltip status label + badge class (App.tsx tooltip IIFE). */
export function heatmapTooltipStatus(isAlertActive: boolean, term: Terminal): {
  statusLabel: string; statusBadgeClass: string;
} {
  if (isAlertActive) {
    return { statusLabel: "AWAITING APPROVAL", statusBadgeClass: "bg-amber-500 text-black font-extrabold shadow-[0_0_8px_#f59e0b]" };
  }
  if (term.status === "Running" && term.quiescing) {
    return { statusLabel: "COOKING…", statusBadgeClass: "bg-amber-500/10 text-amber-400/80 border border-amber-500/10" };
  }
  if (term.status === "Running") {
    return { statusLabel: "ACTIVE EXECUTING", statusBadgeClass: "bg-emerald-500/10 text-emerald-400 border border-emerald-500/10" };
  }
  if (term.status === "Exited") {
    return { statusLabel: "TERMINATED", statusBadgeClass: "bg-red-500/10 text-red-400 border border-red-500/10" };
  }
  return { statusLabel: "Idle & Listening", statusBadgeClass: "bg-yellow-500/10 text-yellow-400 border border-yellow-500/10" };
}

/** The small derived strings/classes the heatmap tooltip renders for a term (dot color, preset/mode
 *  defaults, context-size text, command text, byte count). Each mirrors the inline `?:`/`||` it
 *  replaces, verbatim. Pure so the tooltip IIFE's own CC stays under the gate. */
export function heatmapTooltipFields(isAlertActive: boolean, term: Terminal): {
  dotColorClass: string; presetText: string; modeText: string; contextSizeText: string; commandText: string; outputBytes: number;
} {
  return {
    dotColorClass: isAlertActive ? "bg-amber-500" : term.status === "Running" ? "bg-emerald-500" : "bg-yellow-500",
    presetText: term.tool_preset || "Custom Shell Engine",
    modeText: term.permissions_mode || "Human-in-the-Loop",
    contextSizeText: (term.context_size as number) < 1000 ? `${term.context_size} chars` : `${((term.context_size as number) / 1000).toFixed(1)}k chars`,
    commandText: term.command || "idle waiting",
    outputBytes: term.output?.length || 0,
  };
}

/** Mobile swiper inner status-dot class (the `<span>` inside each swiper button). Four arms:
 *  alert → amber ping2; running+quiescing → muted amber; running → green; else → yellow.
 *  Note the custom `animate-ping2` (not `animate-ping`) — verbatim from the inline ternary chain.
 *  `animate-ping2` is distinct from `animate-ping` on purpose (slower, less aggressive pulse). */
export function mobileSwiperDotClass(isAlertActive: boolean, term: Pick<Terminal, "status" | "quiescing">): string {
  if (isAlertActive) return "bg-amber-500 animate-ping2";
  if (term.status === "Running" && term.quiescing) return "bg-amber-400/70";
  if (term.status === "Running") return "bg-green-500";
  return "bg-yellow-500";
}

/** Mobile swiper button color (App.tsx mobile swiper `.map`). isActive precedence sits between the
 *  alert and the running/idle arms — verbatim from the original if/else-if ladder. */
export function mobileSwiperColorClass(isAlertActive: boolean, isActive: boolean, term: Terminal): string {
  if (isAlertActive) return "border-amber-500 text-amber-400 bg-amber-500/15 animate-pulse font-bold";
  if (isActive) return "border-cyan-500 text-cyan-400 bg-cyan-500/10 font-bold";
  if (term.status === "Running" && term.quiescing) return "border-amber-500/40 text-amber-400/80 bg-amber-500/5";
  if (term.status === "Running") return "border-green-500/50 text-green-400 bg-green-500/5";
  if (term.status === "Idle") return "border-yellow-500/50 text-yellow-500 bg-yellow-500/5";
  return "border-zinc-850 text-zinc-500 bg-black/40";
}

/** Sidebar pane status-dot color (App.tsx sidebar panes `.map`). When there is no live terminal it
 *  falls back to the ledger pane's alive/is_busy flags. `recentlyIdledClass` is the heartbeat suffix
 *  for the idle arm (passed in so this stays DOM/state-free). Verbatim from the nested ladders. */
export function sidebarPaneStatusColor(
  isAlertActive: boolean,
  term: Terminal | undefined,
  pane: Pick<PaneMeta, "alive" | "is_busy">,
  recentlyIdledClass: string,
): string {
  if (isAlertActive) return "bg-amber-500 shadow-[0_0_12px_rgba(245,158,11,0.9)] animate-pulse";
  if (term) {
    if (term.status === "Running") return "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)] animate-pulse";
    if (term.status === "Idle") return `bg-yellow-500 shadow-[0_0_8px_rgba(234,179,8,0.6)] ${recentlyIdledClass}`;
    if (term.status === "Exited") return "bg-red-500";
    return "bg-zinc-600";
  }
  if (pane.alive && pane.is_busy) return "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)] animate-pulse";
  if (pane.alive && !pane.is_busy) return `bg-yellow-500 shadow-[0_0_8px_rgba(234,179,8,0.6)] ${recentlyIdledClass}`;
  return "bg-red-500";
}

/** Sidebar pane row container class (alert > active > default). Verbatim from the inline chain. */
export function sidebarRowContainerClass(isAlertActive: boolean, isActive: boolean): string {
  return isAlertActive ? "bg-amber-500/10 border border-amber-500/30" : isActive ? "bg-white/5 border border-white/10" : "border border-transparent hover:bg-white/5";
}

/** Sidebar pane row name class (alert > active > default). Verbatim from the inline chain. */
export function sidebarRowNameClass(isAlertActive: boolean, isActive: boolean): string {
  return isAlertActive ? "text-amber-400 font-bold" : isActive ? "font-bold text-cyan-400" : "opacity-80";
}

/** Detailed dashboard card: primary border/text class + hover class + preset label, from the pane's
 *  tool_preset. Verbatim from the inline `if (pane.tool_preset === …)` ladder. */
export function detailedCardPresetClasses(toolPreset: string | undefined): {
  primaryColorClass: string; bgHover: string; presetLabel: string;
} {
  const presetLabel = toolPreset || "Custom";
  if (toolPreset === "Claude Code") {
    return { primaryColorClass: "border-purple-500/20 text-purple-400 bg-purple-500/[0.02]", bgHover: "hover:border-purple-500/50", presetLabel };
  }
  if (toolPreset === "Codex") {
    return { primaryColorClass: "border-orange-500/20 text-orange-400 bg-orange-500/[0.02]", bgHover: "hover:border-orange-500/50", presetLabel };
  }
  if (toolPreset === "Antigravity") {
    return { primaryColorClass: "border-cyan-500/20 text-cyan-400 bg-cyan-500/[0.02]", bgHover: "hover:border-cyan-500/50", presetLabel };
  }
  return { primaryColorClass: "border-zinc-800 text-zinc-400", bgHover: "hover:border-zinc-700", presetLabel };
}

/** Preset badge class fragment (the `pane.tool_preset === … ? … : …` chains inside the compact +
 *  detailed cards). `zincFallback` differs between the two sites, so it is passed in. */
export function presetBadgeClass(toolPreset: string | undefined, zincFallback: string): string {
  if (toolPreset === "Claude Code") return "bg-purple-500/10 text-purple-400";
  if (toolPreset === "Codex") return "bg-orange-500/10 text-orange-400";
  if (toolPreset === "Antigravity") return "bg-cyan-500/10 text-cyan-400";
  return zincFallback;
}

/** Dashboard status-dot class — videowall card (idle has NO heartbeat suffix). Verbatim chain. */
export function videowallDotClass(isAlertActive: boolean, status: string): string {
  if (isAlertActive) return "bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.9)] animate-ping";
  if (status === "Running") return "bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.6)] animate-pulse";
  if (status === "Idle") return "bg-yellow-500 shadow-[0_0_4px_rgba(234,179,8,0.2)]";
  return "bg-red-500";
}

/** Dashboard status-dot class — compact card (idle carries the heartbeat suffix). Verbatim chain. */
export function compactDotClass(isAlertActive: boolean, status: string, recentlyIdledClass: string): string {
  if (isAlertActive) return "bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.9)] animate-ping";
  if (status === "Running") return "bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.6)] animate-pulse";
  if (status === "Idle") return `bg-yellow-500 shadow-[0_0_6px_rgba(234,179,8,0.2)] ${recentlyIdledClass}`;
  return "bg-red-500";
}

/** Dashboard status-dot class — detailed card (idle carries the heartbeat suffix). Verbatim chain. */
export function detailedDotClass(isAlertActive: boolean, status: string, recentlyIdledClass: string): string {
  if (isAlertActive) return "bg-amber-500 shadow-[0_0_12px_rgba(245,158,11,0.9)] animate-ping";
  if (status === "Running") return "bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)] animate-pulse";
  if (status === "Idle") return `bg-yellow-500 shadow-[0_0_8px_rgba(234,179,8,0.2)] ${recentlyIdledClass}`;
  return "bg-red-500";
}

/** Compact card cwd display: ".../tail-25" when >25 chars, else the cwd, else "/workspace".
 *  Verbatim from the inline `term?.cwd ? (len>25 ? '...'+slice(-25) : cwd) : '/workspace'`. */
export function compactCwdDisplay(cwd: string | undefined): string {
  return cwd ? (cwd.length > 25 ? "..." + cwd.slice(-25) : cwd) : "/workspace";
}

/** Compact card process-state label + class (running > alert > idle). Verbatim from the two inline
 *  chains (the class uses status>alert>default; the label uses the same precedence). */
export function compactProcessState(status: string, isAlertActive: boolean): { label: string; className: string } {
  return {
    label: status === "Running" ? "Running" : isAlertActive ? "Awaiting" : "Idle",
    className: status === "Running" ? "text-green-400" : isAlertActive ? "text-amber-400" : "text-zinc-500",
  };
}

/** Header "Gemini Voice" status text-color class. Verbatim from the nested live/reconnect/mute chain. */
export function geminiVoiceColorClass(isLive: boolean, isReconnecting: boolean, isMicMuted: boolean): string {
  return isLive ? (isReconnecting ? "text-amber-500 animate-pulse" : (isMicMuted ? "text-amber-400" : "text-green-400")) : "text-zinc-600";
}

/** Header "Gemini Voice" status label. Verbatim from the nested live/reconnect/mute chain. */
export function geminiVoiceLabel(isLive: boolean, isReconnecting: boolean, isMicMuted: boolean): string {
  return isLive ? (isReconnecting ? "RECONNECTING..." : (isMicMuted ? "MUTED" : "LISTENING...")) : "OFFLINE";
}

/** Synergy-panel "AGENT STATUS" voice label — DISTINCT, longer strings from the header's
 *  geminiVoiceLabel (which renders "RECONNECTING…"/"MUTED"/"LISTENING…"/"OFFLINE"). The Synergy
 *  Matrix hero instead renders these full sentences, so they get their OWN byte-exact helper rather
 *  than reusing geminiVoiceLabel. Verbatim from the inline live/reconnect/mute chain at App.tsx. */
export function voiceAgentStatusLabel(isLive: boolean, isReconnecting: boolean, isMicMuted: boolean): string {
  return isLive
    ? (isReconnecting ? "AI Reconnecting..." : isMicMuted ? "Muted (Zephyr Listening)" : "Zephyr Voice Agent Live")
    : "Offline (Mic Standby)";
}

/** Synergy-panel Spec Buffer char-count badge: "<n> Chars" when non-empty, else "Empty".
 *  Verbatim from the inline `promptBuffer.length > 0 ? … : "Empty"` ternary. */
export function specBufferBadge(promptBuffer: string): string {
  return promptBuffer.length > 0 ? `${promptBuffer.length} Chars` : "Empty";
}

/** Heatmap tooltip "Live Stdout Capture" snippet: the last (up to) 4 trimmed lines of a term's
 *  output, or [] when there is no output. Verbatim from the inline
 *  `term.output ? term.output.trim().split("\n").slice(-4) : []`. */
export function heatmapSnippetLines(output: string | undefined): string[] {
  return output ? output.trim().split("\n").slice(-4) : [];
}

/** Transcript grounding source label: the source title if present, else the bare host of its URI
 *  (scheme + path stripped). Verbatim from the inline
 *  `s.title || s.uri.replace(/^https?:\/\//, "").replace(/\/.*$/, "")`. */
export function transcriptSourceLabel(source: { uri: string; title: string }): string {
  return source.title || source.uri.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

/** Total-context-size text class (>80k red, >40k amber, else cyan). Verbatim from the header chain. */
export function totalContextTextClass(totalContextSize: number): string {
  return totalContextSize > 80000 ? "text-red-400 animate-pulse font-extrabold" : totalContextSize > 40000 ? "text-amber-400 font-bold" : "text-cyan-400";
}

/** Total-context overload-bar fill class (>80k red+glow, >40k amber, else cyan). Verbatim. */
export function totalContextBarClass(totalContextSize: number): string {
  return totalContextSize > 80000 ? "bg-red-500 shadow-[0_0_8px_#ef4444]" : totalContextSize > 40000 ? "bg-amber-500" : "bg-cyan-500";
}

/** Context-meter color for a detailed card (App.tsx: `contextSize > 15000 ? … : …`). */
export function contextMeterColor(contextSize: number): string {
  return contextSize > 15000 ? "bg-red-500" : contextSize > 8000 ? "bg-amber-500" : "bg-cyan-500";
}

// ─────────────────────────────────────────────────────────────────────────────
// MiniMarkdown line classification. The MiniMarkdown line `.map` was one long startsWith ladder.
// This relocates the PURE classification (which kind + the stripped text + the checklist flags)
// into a single tested function; the renderer then switches on `kind`. Branch lattice is verbatim.
// ─────────────────────────────────────────────────────────────────────────────

export type MarkdownLineKind = "h4" | "h3" | "h2" | "hr" | "list" | "blank" | "text";

export interface MarkdownLineInfo {
  kind: MarkdownLineKind;
  /** For headers/lists: the text with the marker stripped. Empty for hr/blank. */
  text: string;
  /** List-only: whether the bullet is a `[ ]`/`[x]`/`[X]` checklist item. */
  isChecklist: boolean;
  /** List-only: whether a checklist item is checked (`[x]`/`[X]`). */
  isChecked: boolean;
}

/** Is `trimmed` any bullet/checklist list item? (the original 5-way `||` startsWith guard). */
function isMarkdownListLine(trimmed: string): boolean {
  return trimmed.startsWith("- [ ] ") || trimmed.startsWith("- [x] ") || trimmed.startsWith("- [X] ") || trimmed.startsWith("- ") || trimmed.startsWith("* ");
}

/** Build the list MarkdownLineInfo (checklist flags + the marker-stripped text). Verbatim. */
function classifyMarkdownList(trimmed: string): MarkdownLineInfo {
  const isChecklist = trimmed.startsWith("- [ ] ") || trimmed.startsWith("- [x] ") || trimmed.startsWith("- [X] ");
  const isChecked = trimmed.startsWith("- [x] ") || trimmed.startsWith("- [X] ");
  let listText = trimmed;
  if (isChecklist) {
    listText = trimmed.slice(6);
  } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
    listText = trimmed.slice(2);
  }
  return { kind: "list", text: listText, isChecklist, isChecked };
}

/** Classify ONE markdown line exactly as the MiniMarkdown ladder did. `text` mirrors the original
 *  `.slice(...)` for each arm; the normal-text arm returns the ORIGINAL (untrimmed) line, since the
 *  renderer feeds `parseInlines(line)` — not the trimmed form — for paragraphs. */
export function classifyMarkdownLine(line: string): MarkdownLineInfo {
  const trimmed = line.trim();
  if (trimmed.startsWith("### ")) return { kind: "h4", text: trimmed.slice(4), isChecklist: false, isChecked: false };
  if (trimmed.startsWith("## ")) return { kind: "h3", text: trimmed.slice(3), isChecklist: false, isChecked: false };
  if (trimmed.startsWith("# ")) return { kind: "h2", text: trimmed.slice(2), isChecklist: false, isChecked: false };
  if (trimmed === "---") return { kind: "hr", text: "", isChecklist: false, isChecked: false };
  if (isMarkdownListLine(trimmed)) return classifyMarkdownList(trimmed);
  if (!trimmed) return { kind: "blank", text: "", isChecklist: false, isChecked: false };
  // Normal text: the renderer uses the ORIGINAL line (parseInlines(line)), not the trimmed form.
  return { kind: "text", text: line, isChecklist: false, isChecked: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// ws.onmessage dispatch table. The giant `ws.onmessage` arrow in App.tsx was one long if/else-if
// ladder over `msg.type`. This relocates each per-type branch into a named handler keyed in a
// prototype-safe lookup table (mirroring eventBus.effectForEvent). `ctx` bundles the exact setters,
// refs, and helper closures the original branches captured — so each handler's body is the verbatim
// branch body. The arrow now does a single own-property lookup + dispatch (+ the eventBus fallback
// for the `else` arm), preserving setState/side-effect ORDERING within every branch.
// ─────────────────────────────────────────────────────────────────────────────

/** The capabilities a ws-message handler may reach for — every setter/ref/helper the original
 *  ladder closed over. Supplied by App.tsx at wire-up; this module never touches React directly. */
export interface WsHandlerCtx {
  playEarcon: (type: any) => void;
  triggerDesktopNotification: (title: string, body: string) => void;
  setPendingCommands: (updater: any) => void;
  setPendingActions: (updater: any) => void;
  setActiveTerminalId: (id: any) => void;
  setIsBufferFocused: (updater: any) => void;
  setPromptBuffer: (val: any) => void;
  fetchWipDrafts: (projectId?: any) => void;
  setTerminals: (updater: any) => void;
  setFrozen: (val: any) => void;
  setFrozenRunning: (updater: any) => void;
  setLedger: (val: any) => void;
  setGlobalPermissionsMode: (val: any) => void;
  setSettings: (val: any) => void;
  setIsMicMuted: (val: any) => void;
  setAutoApprovedNotification: (val: any) => void;
  setBlockedNotification: (val: any) => void;
  setTranscript: (updater: any) => void;
  setWsErrorNotification: (val: any) => void;
  setProactiveNotifications: (updater: any) => void;
  setPlans: (val: any) => void;
  /** D2: the attention/"what needs me" queue setter, fed by the eventBus `setAttentionQueue`
   *  effect (attention_updated frames). OPTIONAL — the classic App.tsx has no attention state, so a
   *  caller that omits it simply no-ops the setter (the bus earcon still fires). */
  setAttentionQueue?: (val: any) => void;
  queueStdoutChunk: (terminalId: string, chunk: string) => void;
  fetchTerminals: () => void;
  fetchPlans: () => void;
  fetchActiveTerminalHistory: (terminalId?: any) => void;
  resetAudioPlayback: () => void;
  playAudioChunk: (msg: any) => void;
  upsertNotification: (prev: any, entry: any) => any;
  effectForEvent: (msg: any) => { setter: string; earcon: any } | null;
  activeTerminalIdRef: { current: string | null };
}

type WsHandler = (msg: any, ctx: WsHandlerCtx) => void;

function handleApprovalPending(msg: any, ctx: WsHandlerCtx): void {
  // BUG-037(b): ask for desktop-notification permission on the first approval_pending. The guarded
  // helper self-no-ops unless Notification.permission === "default", so this fires the browser prompt
  // exactly once (the permission leaves "default" after the first decision). triggerDesktopNotification
  // stays gated on `granted` — this only wires the REQUEST, not the firing.
  requestNotifyPermission();
  ctx.playEarcon("alert");
  ctx.triggerDesktopNotification("🚨 Approval Pending", `Node ${msg.terminalId} is waiting for execute confirm: ${msg.cmd}`);
  ctx.setPendingCommands((prev: any[]) => {
    if (prev.some((pc) => pc.messageId === msg.messageId)) return prev;
    return [...prev, {
      messageId: msg.messageId,
      cmd: msg.cmd,
      terminalId: msg.terminalId,
      rationale: msg.rationale,
      effective_gates: msg.effective_gates,
      posture: msg.posture,
      effective_mode: msg.effective_mode,
      capability: msg.capability,
    }];
  });
}

function handleActionPending(msg: any, ctx: WsHandlerCtx): void {
  ctx.playEarcon("alert");
  ctx.triggerDesktopNotification("⚙ Action Pending", `Confirm: ${msg.summary}`);
  ctx.setPendingActions((prev: any[]) => {
    if (prev.some((a) => a.actionId === msg.actionId)) return prev;
    return [...prev, {
      actionId: msg.actionId,
      capability: msg.capability,
      summary: msg.summary,
      effective_gate: msg.effective_gate,
      effective_mode: msg.effective_mode,
      posture: msg.posture,
      effective_gates: msg.effective_gates,
      pane_id: msg.pane_id,
      requested_mode: msg.requested_mode,
      global_override: msg.global_override,
    }];
  });
}

function handleDraftUpdated(msg: any, ctx: WsHandlerCtx): void {
  if (msg.paneId === ctx.activeTerminalIdRef.current) {
    ctx.setIsBufferFocused((focused: boolean) => {
      if (!focused) {
        ctx.setPromptBuffer(msg.draft?.text ?? "");
      }
      return focused;
    });
  }
  ctx.fetchWipDrafts(msg.projectId);
}

function handleFrozen(msg: any, ctx: WsHandlerCtx): void {
  ctx.setFrozen(!!msg.frozen);
  ctx.setFrozenRunning(Array.isArray(msg.running) ? msg.running : []);
  if (msg.frozen) ctx.playEarcon("alert");
  ctx.fetchTerminals();
}

function handleStopAll(msg: any, ctx: WsHandlerCtx): void {
  if (Array.isArray(msg.killed)) ctx.setFrozenRunning((prev: string[]) => prev.filter((id) => !msg.killed.includes(id)));
  ctx.fetchTerminals();
}

function handleSettingsUpdated(msg: any, ctx: WsHandlerCtx): void {
  if (msg.globalPermissionsMode !== undefined) {
    ctx.setGlobalPermissionsMode(msg.globalPermissionsMode);
  }
  if (msg.settings) {
    ctx.setSettings(msg.settings);
    if (typeof msg.settings.voiceAi?.isMicMuted === "boolean") {
      ctx.setIsMicMuted(msg.settings.voiceAi.isMicMuted);
    }
  }
}

function handleCommandAutoExecuted(msg: any, ctx: WsHandlerCtx): void {
  ctx.playEarcon("execute");
  ctx.triggerDesktopNotification("▶ Command Auto-Approved", `Node ${msg.terminalId} executed: ${msg.cmd}`);
  ctx.setAutoApprovedNotification({ terminalId: msg.terminalId, cmd: msg.cmd });
  setTimeout(() => ctx.setAutoApprovedNotification(null), 4000);
  ctx.fetchTerminals();
}

function handleCommandBlocked(msg: any, ctx: WsHandlerCtx): void {
  ctx.playEarcon("alert");
  ctx.triggerDesktopNotification("⛔ Command Blocked (Read-Only)", `Node ${msg.terminalId} locked: ${msg.cmd}`);
  ctx.setBlockedNotification({ terminalId: msg.terminalId, cmd: msg.cmd, reason: msg.reason });
  setTimeout(() => ctx.setBlockedNotification(null), 4000);
}

function handleGrounding(msg: any, ctx: WsHandlerCtx): void {
  ctx.setTranscript((prev: any[]) => {
    const sources = Array.isArray(msg.sources) ? msg.sources : [];
    const queries = Array.isArray(msg.queries) ? msg.queries : [];
    if (sources.length === 0 && queries.length === 0) return prev;
    let lastJanus = -1;
    for (let i = prev.length - 1; i >= 0; i--) { if (prev[i].sender === "Janus") { lastJanus = i; break; } }
    if (lastJanus === -1) return prev;
    const next = prev.slice();
    next[lastJanus] = { ...next[lastJanus], grounding: { queries, sources } };
    return next;
  });
}

function handleError(msg: any, ctx: WsHandlerCtx): void {
  ctx.playEarcon("alert");
  ctx.setWsErrorNotification({ message: msg.message || "An unexpected error occurred during raw liveness communication." });
  setTimeout(() => ctx.setWsErrorNotification(null), 8000);
  ctx.resetAudioPlayback();
}

function handleHistoryUpdated(msg: any, ctx: WsHandlerCtx): void {
  if (msg.terminalId && msg.terminalId === ctx.activeTerminalIdRef.current) {
    ctx.fetchActiveTerminalHistory(msg.terminalId);
  }
}

function handleEventBusFallback(msg: any, ctx: WsHandlerCtx): void {
  const effect = ctx.effectForEvent(msg);
  if (!effect) return;
  switch (effect.setter) {
    case "setPlans": ctx.setPlans(msg.plans); break;
    // D2 (known gap): the eventBus emits setAttentionQueue for attention_updated, but this switch
    // had no arm for it — the queue silently never updated. Adopt msg.queue (optional setter, so
    // an attention-less surface like classic App.tsx no-ops; the earcon below still fires).
    case "setAttentionQueue": ctx.setAttentionQueue?.(msg.queue); break;
    case "fetchTerminals": ctx.fetchTerminals(); break;
    case "fetchPlans": ctx.fetchPlans(); break;
    case "noop": break;
  }
  if (effect.earcon) ctx.playEarcon(effect.earcon);
}

/** type -> handler. Own-property lookup only (prototype-safe), mirroring eventBus.STATIC_EFFECTS.
 *  Exported (bead wsm-e2e-pinned-ys8d) so tests/test_frame_contracts.ts can check its key set
 *  against the WS frame catalog — this module is already node-test-safe (no React/Vite imports). */
export const WS_HANDLERS: Record<string, WsHandler> = {
  audio: (msg, ctx) => { if (msg.audio) ctx.playAudioChunk(msg); },
  interrupted: (_msg, ctx) => ctx.resetAudioPlayback(),
  approval_pending: handleApprovalPending,
  action_pending: handleActionPending,
  action_resolved: (msg, ctx) => ctx.setPendingActions((prev: any[]) => prev.filter((a) => a.actionId !== msg.actionId)),
  approval_resolved: (msg, ctx) => ctx.setPendingCommands((prev: any[]) => prev.filter((item) => item.messageId !== msg.messageId)),
  switch_active_pane: (msg, ctx) => { if (msg.paneId) ctx.setActiveTerminalId(msg.paneId); },
  draft_updated: handleDraftUpdated,
  pane_status: (msg, ctx) => ctx.setTerminals((prev: any[]) => prev.map((t) => t.id === msg.terminalId ? { ...t, status: msg.status, quiescing: false } : t)),
  pane_quiescing: (msg, ctx) => ctx.setTerminals((prev: any[]) => prev.map((t) => t.id === msg.terminalId ? { ...t, quiescing: true } : t)),
  terminals_updated: (_msg, ctx) => ctx.fetchTerminals(),
  frozen: handleFrozen,
  stop_all: handleStopAll,
  ledger_updated: (msg, ctx) => ctx.setLedger(msg.ledger),
  settings_updated: handleSettingsUpdated,
  command_auto_executed: handleCommandAutoExecuted,
  command_blocked: handleCommandBlocked,
  stdout_chunk: (msg, ctx) => ctx.queueStdoutChunk(msg.terminalId, msg.chunk),
  transcript_text: (msg, ctx) => ctx.setTranscript((prev: any[]) => [...prev, { sender: msg.sender, text: msg.text, timestamp: new Date() }].slice(-50)),
  grounding: handleGrounding,
  error: handleError,
  proactive_earcon: (msg, ctx) => { if (msg.earcon) ctx.playEarcon(msg.earcon); },
  history_updated: handleHistoryUpdated,
  proactive_notification: (msg, ctx) => ctx.setProactiveNotifications((prev: any) => ctx.upsertNotification(prev, {
    id: msg.id, kind: msg.kind, terminalId: msg.terminalId, severity: msg.severity, message: msg.message, timestamp: msg.timestamp,
  })),
};

/** Dispatch a parsed ws message to its handler, or the eventBus fallback for an unmapped type.
 *  Own-property guard so a payload type of "__proto__"/"constructor" can never resolve an inherited
 *  member (mirrors eventBus.effectForEvent). Preserves the original if/else-if ladder's behavior. */
export function dispatchWsMessage(msg: any, ctx: WsHandlerCtx): void {
  const type = msg?.type;
  if (typeof type === "string" && Object.prototype.hasOwnProperty.call(WS_HANDLERS, type)) {
    WS_HANDLERS[type](msg, ctx);
  } else {
    handleEventBusFallback(msg, ctx);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Raw-key POST outcome (multi-cli adapter nit #3). The /raw-input route returns 202 (deferred —
// gate Ask), 403 (blocked — gate Off), or 409 (refused — pane not active / no live process). Each
// surfaces an earcon + a transient toast. VERBATIM relocation of App.writeControlKey's status
// ladder so the decision is unit-pinnable; 2xx and any other status -> null (silent success).
// ─────────────────────────────────────────────────────────────────────────────

export type RawKeyToastTone = "blocked" | "deferred" | "refused";
export interface RawKeyOutcome {
  earcon: EarconType;
  toast: { tone: RawKeyToastTone; title: string; detail: string };
}

/** Map a raw-input response status to its operator feedback. `reason` is the server-supplied 409
 *  detail (already resolved from res.json by the caller; "" when absent). Null -> no feedback. */
export function classifyRawKeyOutcome(status: number, paneId: string, reason: string): RawKeyOutcome | null {
  if (status === 202) {
    return {
      earcon: "execute", // queued, awaiting operator confirm
      toast: { tone: "deferred", title: "Key Deferred — Awaiting Confirm", detail: `Pane ${paneId}: the key is queued behind a permission check. Confirm it in the pending tray.` },
    };
  }
  if (status === 403) {
    return {
      earcon: "alert", // gated Off (NO "error" earcon token exists)
      toast: { tone: "blocked", title: "Key Blocked by Policy", detail: `Pane ${paneId}: this key is gated Off and was not sent.` },
    };
  }
  if (status === 409) {
    return {
      earcon: "alert",
      toast: { tone: "refused", title: "Key Not Delivered", detail: reason || `Pane ${paneId} is not the active pane (or has no live process). Open it first.` },
    };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Context-size / token-count formatters (dbt4 round 2). App.tsx rendered the SAME
// `n < 1000 ? \`${n} <suffix>\` : \`${(n / 1000).toFixed(1)}k <suffix>\`` ternary at six sites with
// FOUR distinct suffix spellings, plus the `Math.ceil(n / 4)` token estimate at three. The suffix
// spellings differ on purpose (capital "Chars"/"k Chars" in detail cards, capital "Chars" but
// LOWERCASE "k chars" in the header/system bar, "B"/"k c" in the compact density readout, and a bare
// count for token displays) — so each gets its OWN byte-exact helper rather than a unified one. Every
// branch/suffix below is a VERBATIM relocation of the inline JSX expression; the rendered text is
// identical. Pure so they can be unit-pinned without jsdom.
// ─────────────────────────────────────────────────────────────────────────────

/** "<n> Chars" under 1000, else "<n/1000 to 1dp>k Chars" (detailed card + pane-detail row). */
export function formatCharCount(n: number): string {
  return n < 1000 ? `${n} Chars` : `${(n / 1000).toFixed(1)}k Chars`;
}

/** "<n> Chars" under 1000, else "<n/1000 to 1dp>k chars" — note the LOWERCASE "k chars" on the big
 *  arm (header context readout + system-bar cumulative line). Differs from formatCharCount only there. */
export function formatCharCountLower(n: number): string {
  return n < 1000 ? `${n} Chars` : `${(n / 1000).toFixed(1)}k chars`;
}

/** "<n> B" under 1000, else "<n/1000 to 1dp>k c" (compact + videowall card density readout). */
export function formatCompactBytes(n: number): string {
  return n < 1000 ? `${n} B` : `${(n / 1000).toFixed(1)}k c`;
}

/** Bare "<n>" under 1000, else "<n/1000 to 1dp>k" — no unit suffix (token-count displays). */
export function formatTokenCount(n: number): string {
  return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
}

/** Token estimate: ceil(chars / 4), the 4-chars-per-token approximation used across the cards. */
export function estimateTokens(n: number): number {
  return Math.ceil(n / 4);
}

// ─────────────────────────────────────────────────────────────────────────────
// Context-size resolution + meter-fill percent (dbt4 round 3). App.tsx's grid-card `.map` derived
// the per-card context size with the SAME `term?.context_size !== undefined ? term.context_size :
// (pane.context_size || 0)` fallback that `sumContextSize` already reduces over — relocate it so
// the single-card site and the aggregate share ONE byte-exact derivation. The two meter-fill bars
// render `Math.min((n / DENOM) * 100, 100)` with DISTINCT denominators (20000 for a per-pane card,
// 100000 for the header cumulative bar), so each gets its OWN helper rather than a parameterized one
// — keeping every call site a literal, byte-exact relocation of its inline `Math.min(...)`.
// ─────────────────────────────────────────────────────────────────────────────

/** The card's effective context size: the live terminal's `context_size` if defined, else the
 *  ledger pane's (`|| 0`). VERBATIM from the inline `term?.context_size !== undefined ? … : …` at
 *  the grid-card map; identical to the per-pane term used inside `sumContextSize`'s reducer. */
export function resolveCardContextSize(
  term: Pick<Terminal, "context_size"> | undefined,
  pane: Pick<PaneMeta, "context_size">,
): number {
  return term?.context_size !== undefined ? term.context_size : (pane.context_size || 0);
}

/** Per-pane context-meter fill %: `Math.min((contextSize / 20000) * 100, 100)`, clamped to 100.
 *  VERBATIM from the grid detailed/videowall card meter (`contextPercent`). */
export function contextMeterPercent(contextSize: number): number {
  return Math.min((contextSize / 20000) * 100, 100);
}

/** Header cumulative overload-bar fill %: `Math.min((totalContextSize / 100000) * 100, 100)`,
 *  clamped to 100. VERBATIM from the system-bar inline `Math.min(...)` (note the 100000 denom —
 *  five-pane budget — distinct from the 20000 per-pane meter). */
export function totalContextBarPercent(totalContextSize: number): number {
  return Math.min((totalContextSize / 100000) * 100, 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// Header brand-strip pure derivations — extracted VERBATIM from the AppHeader brand strip
// (App.tsx chunk-5 "modal-queues + AppHeader"). Two clean derivations that previously lived
// inline as JSX template expressions: the live-status dot class and the "N RUNNING" count with
// its `||` ledger-pane fallback. Relocated so each branch is independently unit-pinnable.
// ─────────────────────────────────────────────────────────────────────────────

/** The brand live-status dot's className: cyan (pulsing) when live & connected, amber (pulsing)
 *  when live but reconnecting, zinc when offline. VERBATIM from the inline
 *  `isLive ? (isReconnecting ? amber : cyan) : zinc` template at the header brand strip. */
export function headerStatusDotClass(isLive: boolean, isReconnecting: boolean): string {
  return isLive
    ? (isReconnecting ? 'bg-amber-500 animate-pulse' : 'bg-cyan-400 animate-pulse')
    : 'bg-zinc-600';
}

/** The "N RUNNING" worker count: the live terminals in `Running` status, OR (when that is 0) the
 *  alive ledger panes of the active project. VERBATIM from the inline
 *  `terminals.filter(t => t.status === "Running").length || Object.values(activeProject?.panes ||
 *  {}).filter(p => p.alive).length` at the header telemetry strip. The `||` fallback is load-bearing:
 *  with zero live Running terminals it falls through to the ledger's alive-pane count. */
export function headerRunningCount(terminals: Terminal[], activeProject: Workspace | undefined): number {
  return terminals.filter(t => t.status === "Running").length || Object.values(activeProject?.panes || {}).filter(p => p.alive).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Terminal-view + dashboard-chrome pure derivations — extracted VERBATIM from the chunk-6 sections
// of src/App.tsx (ArtifactsRegistryPanel's pane register + PaneHistorySidebar's history list).
// ─────────────────────────────────────────────────────────────────────────────

/** Is a ledger pane backed by a LIVE terminal process? VERBATIM from the inline
 *  `terminals.some(t => t.id === pane.pane_id)` at the ArtifactsRegistryPanel "Active RAM vs Idle
 *  Registry" derivation (`isLiveProcess`). True ⇒ "Active RAM" (+ no Recover button); false ⇒ "Idle
 *  Registry" (+ the Recover & Wake button). */
export function isPaneLive(terminals: Pick<Terminal, "id">[], paneId: string): boolean {
  return terminals.some((t) => t.id === paneId);
}

/** Whether a history entry is the currently-selected one. VERBATIM from the inline
 *  `selectedHistoryEntry?.command === entry.command && selectedHistoryEntry?.timestamp ===
 *  entry.timestamp` at the PaneHistorySidebar list (computed once per row, used three times: row
 *  className, the toggle-to-null click, and the "Hide/Read stdout" label). The optional chains are
 *  load-bearing — a null selection compares `undefined === entry.command` → false on both sides. */
export function historyEntryIsSelected(
  selected: { command: string; timestamp: string } | null,
  entry: { command: string; timestamp: string },
): boolean {
  return selected?.command === entry.command && selected?.timestamp === entry.timestamp;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pane-grid card derivations — extracted VERBATIM from the per-iteration map body of the dashboard
// grid IIFE (App.tsx chunk-7 "pane-grid", now <PaneGridSection/>). Each was a genuinely-INLINE
// expression inside the `.map`/render*Card closures (not yet a named helper), relocated here so the
// component renders a single call and the BYTE-EXACT value is independently unit-pinnable. The four
// status/preset/context derivations (resolvePaneStatus / resolveCardContextSize /
// detailedCardPresetClasses / contextMeterPercent / contextMeterColor / the *DotClass family) were
// ALREADY helpers and are NOT re-hoisted. Nothing observable differs.
// ─────────────────────────────────────────────────────────────────────────────

/** Whether ANY pending command targets a pane (the card's `isAlertActive`). VERBATIM from the inline
 *  `pendingCommands.some(cmd => cmd.terminalId === pane.pane_id)` at the top of the grid `.map`. The
 *  detailed warning's `pendingCommands.find(...)?.cmd` is a DISTINCT lookup (returns the cmd text, not
 *  a boolean) and stays inline. */
export function paneHasPendingCommand(pendingCommands: Pick<PendingCommand, "terminalId">[], paneId: string): boolean {
  return pendingCommands.some((cmd) => cmd.terminalId === paneId);
}

/** Whether a pane "just went idle" (drives the compact/detailed dot's `heartbeat-animation` suffix).
 *  VERBATIM from the inline `recentlyIdled[pane.pane_id]` truthiness check — the caller keeps the
 *  `? "heartbeat-animation" : ""` ternary, this only normalizes the lookup to a boolean. */
export function isRecentlyIdled(recentlyIdled: Record<string, boolean>, paneId: string): boolean {
  return !!recentlyIdled[paneId];
}

/** The videowall card's "security-camera" tail: the last `n` lines of a terminal's output joined back
 *  with newlines. VERBATIM from the inline `term.output.split("\n").slice(-7).join("\n")` (n = 7). The
 *  caller keeps the outer `term?.output ? … : <idle span>` guard — this only runs when output exists. */
export function tailOutputLines(output: string, n: number): string {
  return output.split("\n").slice(-n).join("\n");
}

/** The detailed card's Node Chronicle source selector. VERBATIM precedence from the inline IIFE
 *  (bead bjm): id-bearing project notes for this pane win; else the ledger's bare-string notes; else
 *  empty. Returns WHICH source to render (the JSX for each arm stays in the component) so the branch
 *  lattice is unit-pinnable without jsdom. `"notes"` ⇒ id-bearing (delete/amend controls), `"legacy"`
 *  ⇒ bare strings, `"empty"` ⇒ the "No notes created." placeholder. */
export type ChronicleSource =
  | { kind: "notes"; notes: ProjectNote[] }
  | { kind: "legacy"; notes: string[] }
  | { kind: "empty" };

export function chooseChronicleSource(
  activeProjectNotes: ProjectNote[],
  paneNotes: string[] | undefined,
  paneId: string,
): ChronicleSource {
  const paneChronicle = activeProjectNotes.filter((n) => n.pane_id === paneId);
  if (paneChronicle.length > 0) return { kind: "notes", notes: paneChronicle };
  if (paneNotes && paneNotes.length > 0) return { kind: "legacy", notes: paneNotes };
  return { kind: "empty" };
}
