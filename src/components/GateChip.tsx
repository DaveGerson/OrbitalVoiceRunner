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
import type { CapabilityGate, GateValue, CapabilityGateMap } from "../types";
import {
  CAPABILITY_LABELS,
  CAPABILITY_CATEGORIES,
  ALL_CAPABILITIES,
  type PostureWord,
} from "../gateSurface";

/** Spotlight-eligible productive capabilities (mirror of gateSurface SPOTLIGHT_CAPABILITIES). */
const SPOTLIGHT_CAPS: ReadonlySet<CapabilityGate> = new Set<CapabilityGate>([
  "write_to_pane",
  "deliver_handoff",
]);

/** Posture word → swatch classes (the one gate-language palette). */
const POSTURE_STYLE: Record<PostureWord, { dot: string; text: string; ring: string; label: string }> = {
  OPEN: { dot: "bg-emerald-500", text: "text-emerald-400", ring: "border-emerald-500/30 bg-emerald-500/5", label: "Janus can act here freely." },
  GUARDED: { dot: "bg-amber-500", text: "text-amber-400", ring: "border-amber-500/30 bg-amber-500/5", label: "Some actions here need a checkpoint." },
  LOCKED: { dot: "bg-red-500", text: "text-red-400", ring: "border-red-500/30 bg-red-500/5", label: "Janus can't type into this pane." },
};

/** Gate value → dot color + plain word. Auto = green, Ask = amber, Off = red (spec §2.A). */
const GATE_STYLE: Record<GateValue, { dot: string; text: string; word: string }> = {
  Auto: { dot: "bg-emerald-500", text: "text-emerald-400", word: "Allowed" },
  Ask: { dot: "bg-amber-500", text: "text-amber-400", word: "Asks first" },
  Off: { dot: "bg-red-500", text: "text-red-400", word: "Blocked" },
};

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

export function GateChip({ effectiveGates, posture, isActivePane = false, compact = false }: GateChipProps) {
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

  // Degrade gracefully: no server posture ⇒ render nothing (older payloads / mocks).
  if (!posture || !effectiveGates) return null;

  const gates = effectiveGates;
  const style = POSTURE_STYLE[posture];
  const focused = spotlightActive(gates, isActivePane);

  return (
    <div ref={ref} className="relative inline-flex" data-testid="gate-chip" data-posture={posture}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        onMouseEnter={() => setOpen(true)}
        title={`${style.label} Click for the full breakdown.`}
        className={`inline-flex items-center gap-1.5 rounded border px-1.5 ${compact ? "py-0" : "py-0.5"} font-mono uppercase tracking-wider ${compact ? "text-[8px]" : "text-[9px]"} font-bold transition-colors cursor-pointer ${style.ring} ${style.text}`}
        data-testid="gate-chip-trigger"
      >
        <span className={`inline-block rounded-full ${compact ? "w-1 h-1" : "w-1.5 h-1.5"} ${style.dot}`} />
        <span>{posture}</span>
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
            <span className="uppercase tracking-widest font-bold">{posture}</span>
            {focused && <span className="text-cyan-300" title="Spotlight loosened a write here">★ focused</span>}
            <span className="ml-auto text-zinc-500 normal-case font-sans text-[9px]">{style.label}</span>
          </div>

          {Object.entries(CAPABILITY_CATEGORIES).map(([category, caps]) => (
            <div key={category} className="mb-2 last:mb-0">
              <div className="text-[8px] uppercase tracking-widest text-zinc-600 font-bold mb-1">{category}</div>
              <div className="space-y-0.5">
                {caps.map((cap) => {
                  const value = gates[cap] ?? "Auto";
                  const g = GATE_STYLE[value];
                  const viaFocus = isActivePane && SPOTLIGHT_CAPS.has(cap) && value === "Auto";
                  return (
                    <div key={cap} data-testid={`gate-row-${cap}`} className="flex items-center justify-between gap-2">
                      <span className="text-zinc-400 truncate" title={CAPABILITY_LABELS[cap]}>{CAPABILITY_LABELS[cap]}</span>
                      <span className={`flex items-center gap-1 shrink-0 ${g.text}`}>
                        <span className={`inline-block w-1 h-1 rounded-full ${g.dot}`} />
                        <span className="uppercase">{value}</span>
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

/** Re-export the canonical capability list so callers can iterate without re-importing gateSurface. */
export { ALL_CAPABILITIES };
