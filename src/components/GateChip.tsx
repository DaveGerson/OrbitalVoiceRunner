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
        className={`inline-flex items-center gap-1.5 rounded border px-1.5 ${compact ? "py-0" : "py-0.5"} font-mono uppercase tracking-wider ${compact ? "text-[8px]" : "text-[9px]"} font-bold transition-colors cursor-pointer ${style.ring} ${style.text}`}
        data-testid="gate-chip-trigger"
      >
        <span className={`inline-block rounded-full ${compact ? "w-1 h-1" : "w-1.5 h-1.5"} ${style.dot}`} />
        <span>{safePosture}</span>
        {focused && (
          <span data-testid="gate-chip-focus-star" title="Focused — trust follows your focus here" className="text-cyan-300 leading-none">★</span>
        )}
      </button>

      {open && (
        <div
          data-testid="gate-chip-popover"
          className="absolute z-50 top-full right-0 mt-1 w-72 max-h-80 overflow-y-auto rounded-lg border border-white/10 bg-[#0b0b0b] shadow-2xl p-3 font-mono text-[10px] text-zinc-300 animate-in fade-in zoom-in-95 duration-150"
          onClick={(e) => e.stopPropagation()}
        >
          <div className={`flex items-center gap-2 pb-2 mb-2 border-b border-white/10 ${style.text}`}>
            <span className={`inline-block w-2 h-2 rounded-full ${style.dot}`} />
            <span className="uppercase tracking-widest font-bold">{safePosture}</span>
            {focused && <span className="text-cyan-300" title="Spotlight loosened a write here">★ focused</span>}
            <span className="ml-auto text-zinc-500 normal-case font-sans text-[9px]">{style.label}</span>
          </div>

          {/* n2r (D8): calm degraded tell — a malformed posture frame is a transient infra hiccup, not
              an operator emergency. Muted, no color alarm; surfaces that we fell back to the safe default. */}
          {degraded && (
            <div
              data-testid="gate-chip-degraded"
              className="mb-2 px-2 py-1 rounded border border-white/5 bg-white/[0.02] text-[9px] text-zinc-500 normal-case font-sans leading-snug"
            >
              Posture unavailable — showing safe default.
            </div>
          )}

          {Object.entries(CAPABILITY_CATEGORIES).map(([category, caps]) => (
            <div key={category} className="mb-2 last:mb-0">
              <div className="text-[8px] uppercase tracking-widest text-zinc-600 font-bold mb-1">{category}</div>
              <div className="space-y-0.5">
                {caps.map((cap) => {
                  // `gates` is already normalized → always a valid GateValue. The `?? GATE_STYLE.Ask`
                  // hard fallback makes this row provably non-throwing regardless of upstream changes.
                  const value = gates[cap];
                  // PHASE 2 (veto-toggle honesty): show the HONEST status per enforcement class so the
                  // popover never implies a control the gate doesn't really have.
                  //   informational → a read-only "Always on" badge (never gated).
                  //   veto          → Allow/Blocked only; a veto "Ask" is collapsed to "Allowed" (it
                  //                   can't defer, so Ask is effectively Allow — never shown as "Ask").
                  //   deferrable    → the raw Auto/Ask/Off word (unchanged 3-way semantics).
                  const control = controlForEnforcement(cap);
                  if (control === "badge") {
                    return (
                      <div key={cap} data-testid={`gate-row-${cap}`} data-control="badge" className="flex items-center justify-between gap-2">
                        <span className="text-zinc-400 truncate" title={CAPABILITY_LABELS[cap]}>{CAPABILITY_LABELS[cap]}</span>
                        <span className="flex items-center gap-1 shrink-0 text-zinc-500" title="Not a safety gate — always on.">
                          <span className="uppercase normal-case font-sans text-[9px]">Always on</span>
                        </span>
                      </div>
                    );
                  }
                  // veto displays Auto/Ask as "Allowed", Off as "Blocked"; deferrable shows the raw word.
                  const displayValue: GateValue = control === "two-way" && value !== "Off" ? "Auto" : value;
                  const g = GATE_STYLE[displayValue] ?? GATE_STYLE.Ask;
                  const word = control === "two-way" ? g.word : displayValue;
                  const viaFocus = isActivePane && SPOTLIGHT_CAPS.has(cap) && value === "Auto";
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
                })}
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
