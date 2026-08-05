/**
 * settingsDialogHelpers — PURE, frontend-safe helpers extracted from SettingsDialog.tsx for the
 * cyclomatic-complexity burndown (no React, no lucide, no fs). They concentrate the many
 * nullish-coalescing default chains, the JSON-tab value derivation, the preset-rebuild literals,
 * the terminal⇄preset matching predicate, and the per-preset status/footprint formatting so the
 * component and its big effects each stay under the McCabe gate.
 *
 * These are BEHAVIOR-PRESERVING extractions: every default, coercion, and branch is byte-faithful
 * to the inline code it replaced. Importing only types means node:test can pin every branch without
 * booting the browser bundle (tests/test_settingsdialog_complexity_refactor.ts).
 */
import type { CliPreset, SystemSettings } from "../types";
import { normalizeDeliveryMatrix, type DeliveryMode } from "../voice/turnArbiter";
import { normalizeCompletionAnnounce, type CompletionAnnounce } from "../voice/completionPolicy";

// ─── Coercion primitives ─────────────────────────────────────────────────────
// Tiny, single-decision helpers that absorb the per-field `||` / `??` / `!== undefined` branches so
// the builders/derivers that call them stay flat (a function call adds 0 to the caller's McCabe CC).

/** `String(raw || "")` — empty-string fallback for required string fields. */
function asStr(raw: any): string {
  return String(raw || "");
}
/** `raw || fallback` for enum-ish string fields (preserves the original truthy-OR semantics). */
function orStr<T extends string>(raw: any, fallback: T): T {
  return (raw || fallback) as T;
}
/** `Boolean(raw ?? fallback)` for boolean fields (nullish default, then Boolean coercion). */
function asBool(raw: any, fallback: boolean): boolean {
  return Boolean(raw ?? fallback);
}
/** `raw !== undefined ? String(raw) : ""` for the optional stringified fields (portOffset/customEnvVars). */
function optStr(raw: any): string {
  return raw !== undefined ? String(raw) : "";
}
/** `raw ?? fallback` — plain nullish default (no coercion). */
function nn<T>(raw: T | null | undefined, fallback: T): T {
  return raw ?? fallback;
}

/**
 * For each key in `keys`, copy `src[key]` into `out[key]` IFF it is `!== undefined`. Folds the
 * repeated `if (src.k !== undefined) out.k = src.k` guards into one loop so the patch builders stay
 * flat. Returns `out` for chaining. Byte-faithful to the original per-key `!== undefined` guards.
 */
function copyDefined<T extends Record<string, any>>(out: Partial<T>, src: any, keys: (keyof T)[]): Partial<T> {
  for (const k of keys) {
    if (src[k as string] !== undefined) (out as any)[k] = src[k as string];
  }
  return out;
}

// ─── Preset rebuild literals (parsePresetsSafe) ──────────────────────────────

/** Build the preset object literal for the ARRAY form of `parsePresetsSafe` (pre-gate-preserve). */
export function buildPresetFromArrayItem(item: any): CliPreset {
  const o = item || {};
  return {
    id: asStr(o.id),
    name: asStr(o.name),
    command: asStr(o.command),
    enabled: asBool(o.enabled, true),
    permissionsMode: orStr(o.permissionsMode, "Human-in-the-Loop"),
    windowMode: orStr(o.windowMode, "Standard Split-Pane"),
    visualTheme: orStr(o.visualTheme, "Default Green Mono"),
    persistentRestore: asBool(o.persistentRestore, false),
    dangerouslySkipPermissions: asBool(o.dangerouslySkipPermissions, false),
    sessionResume: asBool(o.sessionResume, true),
    portOffset: optStr(o.portOffset),
    customEnvVars: optStr(o.customEnvVars),
  };
}

/** Map a preset record KEY to its human display name (object form of `parsePresetsSafe`). */
export function presetDisplayName(key: string): string {
  if (key === "claudeCode") return "Claude Code";
  if (key === "codex") return "Codex CLI";
  if (key === "antigravity") return "Antigravity Agent";
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Build the preset object literal for the OBJECT form of `parsePresetsSafe` (pre-gate-preserve). */
export function buildPresetFromObjectEntry(key: string, val: any): CliPreset {
  const o = val || {};
  return {
    id: key,
    name: orStr(o.name, presetDisplayName(key)),
    command: asStr(o.command),
    enabled: asBool(o.enabled, true),
    permissionsMode: orStr(o.permissionsMode, "Human-in-the-Loop"),
    windowMode: orStr(o.windowMode, "Standard Split-Pane"),
    visualTheme: orStr(o.visualTheme, "Default Green Mono"),
    persistentRestore: asBool(o.persistentRestore, false),
    dangerouslySkipPermissions: asBool(o.dangerouslySkipPermissions, false),
    sessionResume: asBool(o.sessionResume, true),
    portOffset: optStr(o.portOffset),
    customEnvVars: optStr(o.customEnvVars),
  };
}

// ─── Default-resolution for the initialSettings sync effect ───────────────────
// Each helper folds the `?? default` chains for one settings section into a single pure call so
// the effect's branch count drops below the gate. Values are byte-identical to the inline defaults.

export interface ServerFields {
  port: number;
  host: string;
  appUrl: string;
}
export function deriveServerFields(s: SystemSettings | null): ServerFields {
  const sv = s?.server;
  return {
    port: nn(sv?.port, 3000),
    host: nn(sv?.host, "0.0.0.0"),
    appUrl: nn(sv?.appUrl, ""),
  };
}

// ─── fikj.12: the D4 delivery dial (per-class narration delivery + completionAnnounce) ─────────

export type DialClass = "0" | "2" | "3" | "4" | "5";
export type DialMode = DeliveryMode;
export type CompletionAnnounceTier = CompletionAnnounce;

export const DIAL_CLASS_LABELS: Record<DialClass, { label: string; hint: string }> = {
  "0": { label: "Corrections", hint: "Retractions of narrated claims. Floor: never passive." },
  "2": { label: "Deadline narrations", hint: "Approval last-calls, autonomy warnings/expiry. Floor: never passive." },
  "3": { label: "Completions", hint: "Deterministic pane-finished narration." },
  "4": { label: "Acks", hint: "Pane created/closed acknowledgements." },
  "5": { label: "Background context", hint: "Memory briefs + passive pane signals." },
};

/** The floor, structurally: classes 0/2 never OFFER passive-context, so the dialog cannot even
 *  express an under-floor value (the server boundary clamp is the backstop for hand-edited files). */
export function dialModeOptions(cls: DialClass): DialMode[] {
  return cls === "0" || cls === "2"
    ? ["forced-turn", "steered-digest"]
    : ["forced-turn", "steered-digest", "passive-context"];
}

export interface DialFields {
  deliveryMatrix: Record<DialClass, DialMode>;
  completionAnnounce: CompletionAnnounceTier;
}

/** Normalized (clamped) dial fields for display — the dialog never shows an under-floor value. */
export function deriveDialFields(s: SystemSettings | null): DialFields {
  const { matrix } = normalizeDeliveryMatrix(s?.voiceAi?.deliveryMatrix);
  return {
    deliveryMatrix: { "0": matrix[0], "2": matrix[2], "3": matrix[3], "4": matrix[4], "5": matrix[5] },
    completionAnnounce: normalizeCompletionAnnounce(s?.voiceAi?.completionAnnounce),
  };
}

export interface VoiceFields {
  voice: string;
  voiceStyle: "Direct" | "Creative" | "Concise" | "Explanatory";
  volume: number;
  isMicMuted: boolean;
  model: string;
  systemPrompt: string;
  groundingEnabled: boolean;
  silenceGate: boolean;
  // fikj.12: the D4 dial rides the same voice-tab field group.
  deliveryMatrix: Record<DialClass, DialMode>;
  completionAnnounce: CompletionAnnounceTier;
}
export function deriveVoiceFields(s: SystemSettings | null): VoiceFields {
  const v = s?.voiceAi;
  return {
    voice: nn(v?.voice, "Zephyr"),
    voiceStyle: nn(v?.voiceStyle, "Creative"),
    volume: nn(v?.volume, 80),
    isMicMuted: nn(v?.isMicMuted, false),
    model: nn(v?.model, "gemini-3.1-flash-live-preview"),
    systemPrompt: nn(v?.systemPrompt, ""),
    groundingEnabled: nn(v?.groundingEnabled, false),
    silenceGate: nn(v?.silenceGate, false),
    ...deriveDialFields(s),
  };
}

export interface ProjectFields {
  activeContext: string;
  localWorkspacePath: string;
}
export function deriveProjectFields(s: SystemSettings | null): ProjectFields {
  const p = s?.projects;
  return {
    activeContext: nn(p?.activeContext, "default_project"),
    localWorkspacePath: nn(p?.localWorkspacePath, ""),
  };
}

export interface AdvancedFields {
  maxBufferLines: number;
  idleTimeoutMs: number;
  agentIdleTimeoutMs: number;
  defaultShellCommand: string;
  globalPermissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only" | "Inherit";
  historyMaxCommands: number;
  historyMaxOutputLength: number;
  memoryPythonEnabled: boolean;
  memorySynthTimeoutMs: number;
}
export function deriveAdvancedFields(s: SystemSettings | null): AdvancedFields {
  const a: any = s?.advanced || {};
  return {
    maxBufferLines: nn(a.maxBufferLines, 100),
    idleTimeoutMs: nn(a.idleTimeoutMs, 2000),
    agentIdleTimeoutMs: nn(a.agentIdleTimeoutMs, 3500),
    defaultShellCommand: nn(a.defaultShellCommand, "bash"),
    globalPermissionsMode: nn(a.globalPermissionsMode, "Inherit"),
    historyMaxCommands: nn(a.historyMaxCommands, 50),
    historyMaxOutputLength: nn(a.historyMaxOutputLength, 5000),
    memoryPythonEnabled: nn(a.memoryPythonEnabled, true),
    memorySynthTimeoutMs: nn(a.memorySynthTimeoutMs, 150),
  };
}

// ─── Memory synthesizer status (health probe) ────────────────────────────────

/** Coerce a raw `/api/health` synthesizer field to the pill state ("python" | "fallback" | "unknown"). */
export function coerceSynthStatus(synth: any): "python" | "fallback" | "unknown" {
  if (synth === "python" || synth === "fallback") return synth;
  return "unknown";
}

// ─── JSON-tab value derivation (handleJsonChange) ─────────────────────────────
// Each helper returns a normalized PARTIAL of the fields present in the parsed JSON section. The
// component applies them through its setters. Absent keys are simply omitted (never overwritten) —
// byte-faithful to the original `if (x !== undefined) setX(...)` guards.

export function jsonServerPatch(parsed: any): Partial<ServerFields> {
  const sv = parsed?.server;
  if (!sv) return {};
  return copyDefined<ServerFields>({}, sv, ["port", "host", "appUrl"]);
}

export function jsonVoicePatch(parsed: any): Partial<VoiceFields> {
  const v = parsed?.voiceAi;
  if (!v) return {};
  const out = copyDefined<VoiceFields>({}, v, ["voice", "voiceStyle", "volume", "isMicMuted", "model"]);
  // Coerced fields differ from a plain copy, so they stay explicit (byte-faithful to the original).
  if (v.systemPrompt !== undefined) out.systemPrompt = v.systemPrompt ?? "";
  if (v.groundingEnabled !== undefined) out.groundingEnabled = !!v.groundingEnabled;
  if (v.silenceGate !== undefined) out.silenceGate = !!v.silenceGate;
  if (v.deliveryMatrix !== undefined) {
    out.deliveryMatrix = deriveDialFields({ voiceAi: { deliveryMatrix: v.deliveryMatrix } } as SystemSettings).deliveryMatrix;
  }
  if (v.completionAnnounce !== undefined) out.completionAnnounce = normalizeCompletionAnnounce(v.completionAnnounce);
  return out;
}

export function jsonProjectsPatch(parsed: any): Partial<ProjectFields> {
  const p = parsed?.projects;
  if (!p) return {};
  return copyDefined<ProjectFields>({}, p, ["activeContext", "localWorkspacePath"]);
}

/**
 * Derive the advanced-section patch from parsed JSON. `capabilityGates` is excluded here (the
 * component normalizes & applies it separately) — this mirrors the original control flow. The
 * `memorySynthTimeoutMs` clamp (Number.isFinite && n > 0 else 150) is preserved exactly.
 */
export function jsonAdvancedPatch(
  parsed: any
): Partial<Omit<AdvancedFields, never>> {
  const a = parsed?.advanced;
  if (!a) return {};
  const out = copyDefined<AdvancedFields>({}, a, [
    "maxBufferLines",
    "idleTimeoutMs",
    "agentIdleTimeoutMs",
    "defaultShellCommand",
    "globalPermissionsMode",
    "historyMaxCommands",
    "historyMaxOutputLength",
  ]);
  // Coerced fields differ from a plain copy, so they stay explicit (byte-faithful to the original).
  if (a.memoryPythonEnabled !== undefined) out.memoryPythonEnabled = !!a.memoryPythonEnabled;
  if (a.memorySynthTimeoutMs !== undefined) {
    const n = Number(a.memorySynthTimeoutMs);
    out.memorySynthTimeoutMs = Number.isFinite(n) && n > 0 ? n : 150;
  }
  return out;
}

/** True iff the parsed advanced section carries a `capabilityGates` key (to be normalized by caller). */
export function jsonHasAdvancedGates(parsed: any): boolean {
  return parsed?.advanced?.capabilityGates !== undefined;
}

/** Merge JSON announcements over a previous template map (mirrors `{ ...prev, ...parsed.announcements }`). */
export function mergeAnnouncements<T extends Record<string, any>>(
  prev: T,
  parsedAnnouncements: any
): T {
  return { ...prev, ...parsedAnnouncements };
}

// ─── Preset ⇄ terminal matching + status (profiles list) ──────────────────────

/** The known default presets matched by an exact (presetId, tool_preset) pair. */
const PRESET_TOOL_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["claudecode", "claude code"],
  ["codex", "codex"],
  ["antigravity", "antigravity"],
];

/** True iff (presetIdLower, termPresetLower) is one of the exact default-preset aliases. */
function matchesPresetAlias(presetIdLower: string, termPresetLower: string): boolean {
  return PRESET_TOOL_ALIASES.some(([pid, tool]) => presetIdLower === pid && termPresetLower === tool);
}

/** PURE predicate: does terminal `t` belong to preset `p`? Byte-faithful to the inline filter. */
export function terminalMatchesPreset(t: any, p: CliPreset): boolean {
  const termPresetLower = (t.tool_preset || "").toLowerCase();
  const presetIdLower = p.id.toLowerCase();
  const presetNameLower = p.name.toLowerCase();
  const tIdLower = t.id.toLowerCase();

  if (matchesPresetAlias(presetIdLower, termPresetLower)) return true;
  if (termPresetLower === presetNameLower) return true;

  // Substring / command fallback checks
  if (tIdLower.includes(presetIdLower) || tIdLower.includes(presetNameLower)) return true;
  if (t.command.toLowerCase().includes(p.command.toLowerCase())) return true;
  return false;
}

export interface PresetStatusVisual {
  statusLabel: string;
  statusBadgeStyle: string;
  dotColor: string;
}

/**
 * Derive the status pill (label/badge/dot) for a preset row from the matched-terminal summary.
 * Branch order/values are byte-faithful to the original inline derivation.
 */
export function derivePresetStatus(args: {
  numActive: number;
  hasAlert: boolean;
  anyRunning: boolean;
}): PresetStatusVisual {
  let statusLabel = "No Live Processes";
  let statusBadgeStyle = "text-zinc-500 bg-zinc-950 border-zinc-800";
  let dotColor = "bg-zinc-600";

  if (args.numActive > 0) {
    if (args.hasAlert) {
      statusLabel = `▲ ALERT: AWAITING APPROVAL`;
      statusBadgeStyle = "text-amber-400 bg-amber-500/10 border-amber-500/30 font-bold animate-pulse";
      dotColor = "bg-amber-500 animate-ping";
    } else if (args.anyRunning) {
      statusLabel = `● RUNNING ACTIVE COMMAND`;
      statusBadgeStyle = "text-green-400 bg-green-500/10 border-green-500/30 font-bold";
      dotColor = "bg-green-500 animate-pulse";
    } else {
      statusLabel = `● IDLE OPERATING READY`;
      statusBadgeStyle = "text-yellow-400 bg-yellow-500/10 border-yellow-500/20 font-bold";
      dotColor = "bg-yellow-500";
    }
  }

  return { statusLabel, statusBadgeStyle, dotColor };
}

// ─── className builders (tab/sidebar active-state) ────────────────────────────
// Pure string builders that fold the `${active ? A : B}` className ternaries out of the JSX so the
// render functions stay under the gate. Each returns the EXACT class string the inline ternary did.

const TOP_TAB_BASE = "px-4 py-3 border-b-2 transition-colors cursor-pointer";
/** Top tab button className (Setup Panels / Raw JSON / Terminal Seed Snippet). */
export function topTabClass(active: boolean): string {
  return `${TOP_TAB_BASE} ${active ? "border-cyan-500 text-cyan-400 bg-white/[0.01]" : "border-transparent text-zinc-400 hover:text-zinc-200"}`;
}

const SUB_TAB_BASE = "px-3 py-2 text-left shrink-0 rounded transition-colors flex items-center gap-2 cursor-pointer";
/** Sidebar (cyan) sub-tab button className for the session/profiles/gates/advanced tabs. */
export function subTabClass(active: boolean): string {
  return `${SUB_TAB_BASE} ${active ? "bg-cyan-950/40 border border-cyan-500/20 text-cyan-400 font-bold" : "border border-transparent text-zinc-400 hover:bg-white/[0.02]"}`;
}

/** Sidebar (red) Secrets sub-tab button className. */
export function secretsTabClass(active: boolean): string {
  return `${SUB_TAB_BASE} ${active ? "bg-red-950/30 border border-red-500/20 text-rose-400 font-bold" : "border border-transparent text-zinc-400 hover:bg-white/[0.02]"}`;
}

/** Format the per-preset memory footprint badge text ("N ch (~M t)"). Byte-faithful to the inline IIFE. */
export function formatContextFootprint(totalContextSize: number): string {
  const chars = totalContextSize < 1000 ? `${totalContextSize} ch` : `${(totalContextSize / 1000).toFixed(1)}k ch`;
  const estimatedTokens = Math.ceil(totalContextSize / 4);
  const tokens = estimatedTokens < 1000 ? `${estimatedTokens} t` : `${(estimatedTokens / 1000).toFixed(1)}k t`;
  return `${chars} (~${tokens})`;
}
