/**
 * GateChip — the per-pane EFFECTIVE-posture chip (bead 8sq, spec §2.A / §4).
 *
 * Renders ONE calm posture word (OPEN | GUARDED | LOCKED) + a colored dot, with a focus ★ when the
 * spotlight has loosened a productive capability on the ACTIVE pane. Click/hover opens a popover
 * listing all 16 capabilities in PLAIN language (CAPABILITY_LABELS — NO PRODUCT JARGON) with each
 * one's effective gate value and a one-word reason when the spotlight changed it.
 *
 * This component renders STRICTLY from SERVER-PROVIDED effective gates (the `effective_gates` +
 * `posture` fields the server attaches to each terminal). It does NOT re-derive policy — the only
 * client-side derivation is the cosmetic focus-★ hint, computed purely from whether a productive
 * capability resolved Auto on the active pane (spotlight tell). Single gate language reused
 * everywhere: Auto = green, Ask = amber, Off = red.
 */

import React, { useState, useRef, useEffect } from "react";
import type { CapabilityGate, CapabilityGateMap, GateValue } from "../types";
import {
  CAPABILITY_LABELS,
  CAPABILITY_CATEGORIES,
  ALL_CAPABILITIES,
  POSTURE_STYLE,
  GATE_STYLE,
  controlForEnforcement,
  normalizePostureWord,
  normalizeEffectiveGates,
  type PostureWord,
  type GateControlKind,
} from "../gateSurface";

/** Spotlight-eligible productive capabilities (mirror of gateSurface SPOTLIGHT_CAPABILITIES). */
const SPOTLIGHT_CAPS: ReadonlySet<CapabilityGate> = new Set<CapabilityGate>([
  "write_to_pane",
  "deliver_handoff",
]);

// POSTURE_STYLE + GATE_STYLE moved to gateSurface (rbh): the chip and the confirmation dialogs now
// share ONE palette source so they can never drift. See gateSurface.ts for the canonical maps.

interface GateChipProps {
  /** The 16 server-resolved effective gate values for this pane (server truth). */
  effectiveGates?: CapabilityGateMap;
  /** The server-derived posture word. */
  posture?: PostureWord;
  /** Whether this pane currently holds the spotlight (active write target) — drives the focus ★. */
  isActivePane?: boolean;
  /** Compact mode shrinks the chip for dense pane lists. */
  compact?: boolean;
}

/**
 * Whether the spotlight loosened a productive capability here. The focus ★ is a cosmetic tell —
 * shown only when this is the active pane AND a spotlight-eligible capability resolved Auto. (The
 * server already applied the spotlight; we just surface that it's in effect.)
 */
function spotlightActive(gates: CapabilityGateMap, isActivePane: boolean): boolean {
  if (!isActivePane) return false;
  for (const cap of SPOTLIGHT_CAPS) if (gates[cap] === "Auto") return true;
  return false;
}

// ─── Pure helpers (extracted to reduce GateChipInner CC) ─────────────────────

/**
 * Resolve the display GateValue for a capability row.
 * two-way (veto) collapses Auto/Ask → Auto; Off stays Off.
 * All other control kinds pass the value through unchanged.
 */
export function deriveDisplayValue(control: GateControlKind, value: GateValue): GateValue {
  return control === "two-way" && value !== "Off" ? "Auto" : value;
}

/**
 * Resolve the display word string for a capability row.
 * two-way uses the GATE_STYLE word (e.g. "Allowed" / "Blocked").
 * All other control kinds use the raw displayValue string.
 */
export function deriveDisplayWord(
  control: GateControlKind,
  gStyleWord: string,
  displayValue: GateValue,
): string {
  return control === "two-way" ? gStyleWord : displayValue;
}

/**
 * Whether the "· via focus" spotlight annotation should appear on a capability row.
 * True iff this is the active pane, the cap is spotlight-eligible, and the gate is Auto.
 */
export function isViaFocus(isActivePane: boolean, cap: CapabilityGate, value: GateValue): boolean {
  return isActivePane && SPOTLIGHT_CAPS.has(cap) && value === "Auto";
}

/**
 * className for the chip trigger button — compact flag selects vertical padding. Font size is the
 * `text-xs` floor in both modes (5n7 type-scale migration floored the former sub-12px sizes here).
 * Extracted to eliminate a ternary from GateChipInner's CC count.
 */
function chipTriggerClassName(style: typeof POSTURE_STYLE[keyof typeof POSTURE_STYLE], compact: boolean): string {
  const py = compact ? "py-0" : "py-0.5";
  return `inline-flex items-center gap-1.5 rounded border px-1.5 ${py} font-mono uppercase tracking-wider text-xs font-bold transition-colors cursor-pointer ${style.ring} ${style.text}`;
}

/**
 * className for the trigger dot span — compact flag selects the dot size.
 * Extracted to eliminate 1 ternary from GateChipInner's CC count.
 */
function chipDotClassName(style: typeof POSTURE_STYLE[keyof typeof POSTURE_STYLE], compact: boolean): string {
  const size = compact ? "w-1 h-1" : "w-1.5 h-1.5";
  return `inline-block rounded-full ${size} ${style.dot}`;
}

/**
 * Inline render helper: one capability row in the popover list.
 * Module-level so its branches are NOT counted in GateChipInner's CC.
 * Called inline as {renderCapRow(cap, gates, isActivePane)}.
 * PHASE 2 (veto-toggle honesty): badge caps get a fixed "Always on" badge; gated caps show the
 * HONEST veto (two-way) or deferrable (three-way) control.
 */
function renderCapRow(
  cap: CapabilityGate,
  gates: Record<CapabilityGate, GateValue>,
  isActivePane: boolean,
): React.ReactNode {
  // `gates` is already normalized → always a valid GateValue. The `?? GATE_STYLE.Ask`
  // hard fallback makes this row provably non-throwing regardless of upstream changes.
  const value = gates[cap];
  const control = controlForEnforcement(cap);
  if (control === "badge") {
    return (
      <div key={cap} data-testid={`gate-row-${cap}`} data-control="badge" className="flex items-center justify-between gap-2">
        <span className="text-zinc-400 truncate" title={CAPABILITY_LABELS[cap]}>{CAPABILITY_LABELS[cap]}</span>
        <span className="flex items-center gap-1 shrink-0 text-zinc-500" title="Not a safety gate — always on.">
          <span className="uppercase normal-case font-sans text-xs">Always on</span>
        </span>
      </div>
    );
  }
  // veto displays Auto/Ask as "Allowed", Off as "Blocked"; deferrable shows the raw word.
  const displayValue = deriveDisplayValue(control, value);
  const g = GATE_STYLE[displayValue] ?? GATE_STYLE.Ask;
  const word = deriveDisplayWord(control, g.word, displayValue);
  const viaFocus = isViaFocus(isActivePane, cap, value);
  return (
    <div key={cap} data-testid={`gate-row-${cap}`} data-control={control} className="flex items-center justify-between gap-2">
      <span className="text-zinc-400 truncate" title={CAPABILITY_LABELS[cap]}>{CAPABILITY_LABELS[cap]}</span>
      <span className={`flex items-center gap-1 shrink-0 ${g.text}`}>
        <span className={`inline-block w-1 h-1 rounded-full ${g.dot}`} />
        <span className="uppercase">{word}</span>
        {viaFocus && <span className="text-cyan-400 normal-case" title="Loosened because this is the focused pane">· via focus</span>}
      </span>
    </div>
  );
}

function GateChipInner({ effectiveGates, posture, isActivePane = false, compact = false }: GateChipProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close the popover on an outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // n2r: normalize at the boundary so a MALFORMED server payload can never index an undefined style
  // record and white-screen the cockpit (plan §2 Change 2). Genuinely absent posture ⇒ render nothing
  // (older payloads / mocks, D3); a present-but-bad word degrades to GUARDED (D1) with a calm tell.
  const safePosture = normalizePostureWord(posture);
  if (safePosture === null) return null;                              // genuinely absent → no chip (back-compat)
  const gates = normalizeEffectiveGates(effectiveGates);             // TOTAL, validated map (never throws below)
  const style = POSTURE_STYLE[safePosture] ?? POSTURE_STYLE.GUARDED; // belt-and-suspenders style fallback
  const focused = spotlightActive(gates, isActivePane);
  const degraded = posture != null && safePosture !== posture;       // server sent a malformed posture word

  return (
    <div ref={ref} className="relative inline-flex" data-testid="gate-chip" data-posture={safePosture}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        onMouseEnter={() => setOpen(true)}
        title={`${style.label} Click for the full breakdown.`}
        className={chipTriggerClassName(style, compact)}
        data-testid="gate-chip-trigger"
      >
        <span className={chipDotClassName(style, compact)} />
        <span>{safePosture}</span>
        {focused && (
          <span data-testid="gate-chip-focus-star" title="Focused — trust follows your focus here" className="text-cyan-300 leading-none">★</span>
        )}
      </button>

      {open && (
        <div
          data-testid="gate-chip-popover"
          className="absolute z-50 top-full right-0 mt-1 w-72 max-h-80 overflow-y-auto rounded-lg border border-white/10 bg-[#0b0b0b] shadow-2xl p-3 font-mono text-xs text-zinc-300 animate-in fade-in zoom-in-95 duration-150"
          onClick={(e) => e.stopPropagation()}
        >
          <div className={`flex items-center gap-2 pb-2 mb-2 border-b border-white/10 ${style.text}`}>
            <span className={`inline-block w-2 h-2 rounded-full ${style.dot}`} />
            <span className="uppercase tracking-widest font-bold">{safePosture}</span>
            {focused && <span className="text-cyan-300" title="Spotlight loosened a write here">★ focused</span>}
            <span className="ml-auto text-zinc-500 normal-case font-sans text-xs">{style.label}</span>
          </div>

          {/* n2r (D8): calm degraded tell — a malformed posture frame is a transient infra hiccup, not
              an operator emergency. Muted, no color alarm; surfaces that we fell back to the safe default. */}
          {degraded && (
            <div
              data-testid="gate-chip-degraded"
              className="mb-2 px-2 py-1 rounded border border-white/5 bg-white/[0.02] text-xs text-zinc-500 normal-case font-sans leading-snug"
            >
              Posture unavailable — showing safe default.
            </div>
          )}

          {Object.entries(CAPABILITY_CATEGORIES).map(([category, caps]) => (
            <div key={category} className="mb-2 last:mb-0">
              <div className="text-xs uppercase tracking-widest text-zinc-600 font-bold mb-1">{category}</div>
              <div className="space-y-0.5">
                {caps.map((cap) => renderCapRow(cap, gates, isActivePane))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * n2r (plan §2 Change 3, D4): a GateChip-LOCAL error boundary. The chip is a peripheral, server-fed,
 * non-load-bearing widget — an unforeseen render fault must NOT have app-wide blast radius via the one
 * global ErrorBoundary. The normalizers make the two KNOWN crash surfaces unreachable; this boundary is
 * defense-in-depth so even a FUTURE unguarded lookup degrades to *no chip*, never the dead-app fault
 * page. `componentDidCatch` logs so a genuinely new fault is still visible (not silently swallowed).
 * The global ErrorBoundary stays as the last resort for everything else.
 */
interface GateChipBoundaryProps { children: React.ReactNode }
interface GateChipBoundaryState { failed: boolean }

class GateChipBoundary extends React.Component<GateChipBoundaryProps, GateChipBoundaryState> {
  state: GateChipBoundaryState;
  props: GateChipBoundaryProps;

  constructor(props: GateChipBoundaryProps) {
    super(props);
    this.props = props;
    this.state = { failed: false };
  }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: unknown) { console.error("[GateChip] render fault (degraded to no chip)", e); }
  render() { return this.state.failed ? null : this.props.children; }
}

/** Public surface: the chip wrapped in its local boundary so a render fault loses the chip, not the app. */
export function GateChip(props: GateChipProps) {
  return (
    <GateChipBoundary>
      <GateChipInner {...props} />
    </GateChipBoundary>
  );
}

/** Re-export the canonical capability list so callers can iterate without re-importing gateSurface. */
export { ALL_CAPABILITIES };
