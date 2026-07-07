// ── Orbital App — pure derivation helpers ────────────────────────────────
// Extracted from OrbitalApp to keep the component under CC 10.
// No JSX, no React, no Vite-only imports — safe to import from node test runner.

import { modeToServiceId, type ServiceModeId } from "./theme";
import type { GlobalMode } from "./useOrbitalData";
import type { Station, StationProject } from "./station";

export type View = "line" | "pantry" | "boh";

/**
 * Resolve the initial view from a URL search string (empty string = no params).
 * Safe to call with "" when location is unavailable (SSR / node test runner).
 */
export function resolveStartView(search: string): View {
  const params = new URLSearchParams(search);
  const v = params.get("view") ?? "";
  return (["boh", "pantry"].includes(v) ? v : "line") as View;
}

/**
 * Resolve the initial selected-project slug from URL search params.
 * Returns "all" when no ?project= param is present.
 */
export function resolveStartProject(search: string): string {
  return new URLSearchParams(search).get("project") || "all";
}

/** Safe accessor for location.search — returns "" when location is unavailable (node/SSR). */
export function getLocationSearch(): string {
  return typeof location !== "undefined" ? location.search : "";
}

/** Resolve the ServiceModeId from the raw global mode, substituting "Inherit" → HiTL. */
export function resolveServiceId(globalMode: GlobalMode): ServiceModeId {
  return modeToServiceId(globalMode === "Inherit" ? "Human-in-the-Loop" : globalMode);
}

/** Resolve the concrete project id for the Pass jot-target.
 *  Priority: selected project (if not "all") → active station's project → first project → null.
 */
export function resolvePassProjectId(
  selectedProject: string,
  stations: Station[],
  activeTerminalId: string | null | undefined,
  projects: StationProject[],
): string | null {
  if (selectedProject !== "all") return selectedProject;
  return stations.find((s) => s.id === activeTerminalId)?.project
    || projects[0]?.id
    || null;
}

/** The nav ConversationalPill draws its OWN status dot span, so a shared LABELS entry that already
 *  carries a leading bullet (LABELS.listening = '● LIVE', byte-pinned to the KitchenRadio chip's e2e
 *  strings) would render a DOUBLED bullet ('● ● LIVE'). Strip a single leading bullet + optional
 *  whitespace for the pill ONLY — the shared LABELS map (and the chip that pins it) stays untouched. */
export function labelForPill(label: string): string {
  return label.replace(/^●\s*/, "");
}

/** Resolve a human-readable project name for the Pass, falling back to "a kitchen". */
export function resolvePassProjectName(
  passProjectId: string | null,
  projects: StationProject[],
): string {
  return projects.find((p) => p.id === passProjectId)?.name || "a kitchen";
}

/** Discriminated voice-call action — returned by matchVoiceCall and acted on by the component. */
export type VoiceCallAction =
  | { kind: "open"; stationId: string }
  | { kind: "setMode"; mode: GlobalMode }
  | { kind: "stopFreeze" }
  | { kind: "stopRelease" }
  | { kind: "coaching"; phrase: string };

/**
 * Pure match of a voice-call phrase against known commands.
 * Returns a VoiceCallAction — the component applies the side effects.
 * Keeps handleCall's dispatch logic testable without React or singletons.
 */
export function matchVoiceCall(phrase: string, stations: Station[]): VoiceCallAction {
  const p = phrase.toLowerCase().trim();
  if (p.startsWith("open ")) {
    const target = p.slice(5).trim();
    const st = stations.find((s) => s.name.toLowerCase() === target);
    if (st) return { kind: "open", stationId: st.id };
  }
  if (p === "let 'em cook") return { kind: "setMode", mode: "Full Auto" };
  if (p === "taste every plate") return { kind: "setMode", mode: "Human-in-the-Loop" };
  if (p === "hands off — read only") return { kind: "setMode", mode: "Read-Only" };
  if (p === "all hands — stop the line" || p === "kill the burners") return { kind: "stopFreeze" };
  if (p === "back to service") return { kind: "stopRelease" };
  return { kind: "coaching", phrase };
}
