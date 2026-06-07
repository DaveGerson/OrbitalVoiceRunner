// ── ORBITAL · kitchen theme constants ───────────────────────────────────
// Ported from the design's kitchen/data.jsx. The DATA (stations/projects/
// tickets) is NOT here — that comes live from the backend. This file holds
// only the stable design vocabulary: palettes, the status dressing, runtime
// labels, service-mode mapping, and the decorative chef roster.

export const INK = "#2a1a10";

export type PermissionsMode = "Full Auto" | "Human-in-the-Loop" | "Read-Only";

// Accent palette — swapped live by the Tweaks panel.
export type AccentKey = "cherry" | "blueberry" | "mint" | "butter";
export const ACCENTS: Record<AccentKey, { name: string; hex: string; soft: string; deep: string; on: string }> = {
  cherry:    { name: "Cherry",    hex: "#e23a3a", soft: "#ffd3ce", deep: "#a8151a", on: "#fff4de" },
  blueberry: { name: "Blueberry", hex: "#4b3bb3", soft: "#d6cfff", deep: "#2e2480", on: "#fff4de" },
  mint:      { name: "Mint",      hex: "#4db892", soft: "#c3e8d2", deep: "#2f7a5e", on: "#2a1a10" },
  butter:    { name: "Butter",    hex: "#ffc94a", soft: "#fff0b8", deep: "#c98a16", on: "#2a1a10" },
};

// The literal pane status WORDS, dressed in kitchen states. "Needs Input" is a
// SYNTHESIZED status (a Running pane with an open approval), not a backend enum.
export type StationStatus = "Running" | "Idle" | "Needs Input" | "Exited";
export const STATUS: Record<StationStatus, { word: string; sub: string; color: string; dot: string; emoji: string }> = {
  Running:       { word: "Running",     sub: "on the burner",       color: "#ffc94a", dot: "#ff8a3d", emoji: "🔥" },
  Idle:          { word: "Idle",        sub: "resting on the rack",  color: "#d4a15a", dot: "#d4a15a", emoji: "😴" },
  "Needs Input": { word: "Needs Input", sub: "ding! needs you",      color: "#ff8a3d", dot: "#ff8a3d", emoji: "🛎" },
  Exited:        { word: "Exited",      sub: "off the line",         color: "#8a6a4f", dot: "#8a6a4f", emoji: "🧊" },
};

// The line cooks — PURE DECORATION. No backend `assignee`/`chef` field exists;
// a pane's chef is a deterministic, stable cosmetic avatar derived from its id.
export type ChefKey = "gordon" | "mary" | "julia" | "escoffi" | "paul" | "rata";
export const CHEFS: Record<ChefKey, { name: string; initials: string; color: string }> = {
  gordon:  { name: "Gordon",  initials: "GO", color: "#ff8a3d" },
  mary:    { name: "Mary",    initials: "MR", color: "#4db892" },
  julia:   { name: "Julia",   initials: "JU", color: "#6db9ff" },
  escoffi: { name: "Escoffi", initials: "ES", color: "#ffc94a" },
  paul:    { name: "Paul",    initials: "PA", color: "#d6336c" },
  rata:    { name: "Ratatou", initials: "RA", color: "#4b3bb3" },
};
const CHEF_KEYS = Object.keys(CHEFS) as ChefKey[];
/** Stable cosmetic chef for a pane id (decoration only — never a real assignee). */
export function chefForPane(id: string): ChefKey {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return CHEF_KEYS[h % CHEF_KEYS.length];
}

// Which coding CLI an agent runs (the "burner"). Keyed by Terminal.tool_preset.
export type ToolPreset = "Claude Code" | "Codex" | "Antigravity" | "Custom";
export const RUNTIMES: Record<ToolPreset, { label: string; burner: string }> = {
  "Claude Code": { label: "claude",      burner: "Sauté" },
  Codex:         { label: "codex",       burner: "Grill" },
  Antigravity:   { label: "antigravity", burner: "Pastry" },
  Custom:        { label: "custom",      burner: "Prep" },
};

// SERVICE MODE — the design's 3-way autonomy switch. Maps 1:1 onto the real
// backend lever `globalPermissionsMode`.
export type ServiceModeId = "auto" | "hitl" | "read";
export const SERVICE_MODES: { id: ServiceModeId; mode: PermissionsMode; label: string; kitchen: string; sub: string; icon: string; color: string }[] = [
  { id: "auto", mode: "Full Auto",         label: "Full Auto",         kitchen: "Let 'em cook",    sub: "the line fires freely", icon: "fire", color: "#e23a3a" },
  { id: "hitl", mode: "Human-in-the-Loop", label: "Human-in-the-Loop", kitchen: "Taste every plate", sub: "you call every fire",  icon: "bell", color: "#ff8a3d" },
  { id: "read", mode: "Read-Only",         label: "Read-Only",         kitchen: "Hands off",       sub: "watch the line only",   icon: "user", color: "#4b3bb3" },
];
export const modeToServiceId = (m: PermissionsMode | undefined): ServiceModeId =>
  (SERVICE_MODES.find((s) => s.mode === m) || SERVICE_MODES[1]).id;
export const serviceIdToMode = (id: ServiceModeId): PermissionsMode =>
  (SERVICE_MODES.find((s) => s.id === id) || SERVICE_MODES[1]).mode;

// THE PASS — ticket kinds (a presentation convention layered over notes).
export type TicketKind = "bug" | "todo" | "note" | "log";
export const TICKET_KINDS: Record<TicketKind, { label: string; color: string; emoji: string }> = {
  bug:  { label: "bug",   color: "#e23a3a", emoji: "🐛" },
  todo: { label: "to-do", color: "#4b3bb3", emoji: "📌" },
  note: { label: "note",  color: "#d4a15a", emoji: "✏️" },
  log:  { label: "log",   color: "#4db892", emoji: "🧾" },
};

// Per-card whimsy rotation (the hand-pinned tilt).
export const TILTS = [-1.4, 0.9, -0.7, 1.2, -1.1, 0.6];

// Deterministic per-project sign color/emoji (no backend column — cosmetic,
// persisted client-side keyed by project id; see useProjectSkins).
export const PROJECT_COLORS = ["#e23a3a", "#4db892", "#ff8a3d", "#ffc94a", "#4b3bb3", "#d6336c"];
export const PROJECT_EMOJIS = ["🍳", "🔐", "💳", "🖥", "📚", "⚙️", "🧪", "🚀"];

// User-picked project "signs" (emoji + accent) persist client-side (no backend
// column — G4). skinForProject prefers a stored override, else a stable hash.
const SKIN_LS = "orbital-project-skins";
let _skinCache: Record<string, { color: string; emoji: string }> | null = null;
function skinOverrides(): Record<string, { color: string; emoji: string }> {
  if (_skinCache) return _skinCache;
  try { _skinCache = JSON.parse((typeof localStorage !== "undefined" && localStorage.getItem(SKIN_LS)) || "{}"); }
  catch { _skinCache = {}; }
  return _skinCache!;
}
export function setProjectSkin(id: string, skin: { color: string; emoji: string }): void {
  const o = skinOverrides();
  o[id] = skin;
  try { localStorage.setItem(SKIN_LS, JSON.stringify(o)); } catch { /* quota */ }
}
export function skinForProject(id: string): { color: string; emoji: string } {
  const override = skinOverrides()[id];
  if (override) return override;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return { color: PROJECT_COLORS[h % PROJECT_COLORS.length], emoji: PROJECT_EMOJIS[h % PROJECT_EMOJIS.length] };
}
