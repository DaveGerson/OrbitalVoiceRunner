/**
 * CapabilityMatrixTab — the grouped-toggle capability-gate editor (bead 8sq, spec §2.B / §4).
 *
 * A new "Capability Matrix" sub-tab in SettingsDialog. Layout (locked design): sections by intent
 * (CAPABILITY_CATEGORIES), one row per PLAIN-labeled action (CAPABILITY_LABELS — NO PRODUCT JARGON),
 * each with a 3-way segmented switch [Auto | Ask | Off]. A scope selector at the top picks WHICH
 * matrix is being edited — all three scopes:
 *   - Global default → settings.advanced.capabilityGates (edited via SettingsDialog form state)
 *   - A preset       → CliPreset.capabilityGates           (edited via SettingsDialog form state)
 *   - A specific pane → PaneMeta.capabilityGates           (persisted via the per-pane REST path)
 *
 * The component is CONTROLLED: it never owns the gate state. For global/preset it reads/writes the
 * map the parent holds in form state (so save round-trips it via settingsGatesRoundTrip — closing the
 * drop-on-save data-loss bug). For the per-pane scope it calls `onSavePaneGates` which hits the REST
 * endpoint. All three scopes round-trip with ZERO loss.
 */

import React, { useState } from "react";
import type { CapabilityGate, GateValue, CapabilityGateMap, CliPreset } from "../types";
import { CAPABILITY_CATEGORIES, CAPABILITY_LABELS } from "../gateSurface";

const GATE_OPTIONS: GateValue[] = ["Auto", "Ask", "Off"];

/** Plain one-word effect per gate value + active swatch (the single gate-language palette). */
const GATE_PRESENTATION: Record<GateValue, { label: string; active: string }> = {
  Auto: { label: "Auto", active: "bg-emerald-500/20 text-emerald-300 border-emerald-500/50" },
  Ask: { label: "Ask", active: "bg-amber-500/20 text-amber-300 border-amber-500/50" },
  Off: { label: "Off", active: "bg-red-500/20 text-red-300 border-red-500/50" },
};

/** What each gate value means for the operator, in plain language (used in the scope hint). */
const GATE_HELP = "Auto = Janus does it on its own · Ask = Janus checks with you first · Off = Janus can't do it.";

export type MatrixScope =
  | { kind: "global" }
  | { kind: "preset"; presetId: string }
  | { kind: "pane"; paneId: string };

export interface PaneOption { id: string; name: string }

interface CapabilityMatrixTabProps {
  /** Current global default matrix (SettingsDialog form state). */
  globalGates: CapabilityGateMap | undefined;
  /** Persist a new global matrix into the parent's form state (round-trips on Save). */
  onChangeGlobalGates: (gates: CapabilityGateMap | undefined) => void;

  /** The CLI presets (each may carry its own capabilityGates seed). */
  presets: CliPreset[];
  /** Persist a preset's matrix into the parent's form state (round-trips on Save). */
  onChangePresetGates: (presetId: string, gates: CapabilityGateMap | undefined) => void;

  /** The live panes (for the per-pane scope selector). */
  panes: PaneOption[];
  /** Current per-pane override map for a given pane (read from the ledger/terminals). */
  paneGatesFor: (paneId: string) => CapabilityGateMap | undefined;
  /** Persist a per-pane override immediately via REST (the pane scope is not part of the form save). */
  onSavePaneGates: (paneId: string, gates: CapabilityGateMap | undefined) => Promise<void> | void;
}

/** Resolve the map currently being edited for a scope. */
function gatesForScope(
  scope: MatrixScope,
  globalGates: CapabilityGateMap | undefined,
  presets: CliPreset[],
  paneGatesFor: (paneId: string) => CapabilityGateMap | undefined,
): CapabilityGateMap {
  if (scope.kind === "global") return globalGates ?? {};
  if (scope.kind === "preset") return presets.find((p) => p.id === scope.presetId)?.capabilityGates ?? {};
  return paneGatesFor(scope.paneId) ?? {};
}

export function CapabilityMatrixTab(props: CapabilityMatrixTabProps) {
  const { globalGates, onChangeGlobalGates, presets, onChangePresetGates, panes, paneGatesFor, onSavePaneGates } = props;
  const [scope, setScope] = useState<MatrixScope>({ kind: "global" });
  const [savingPane, setSavingPane] = useState(false);

  const current = gatesForScope(scope, globalGates, presets, paneGatesFor);

  /** Effective value shown for a row. For global/preset scope, absent ⇒ Auto (back-compat default).
   *  For the per-pane scope, absent means "follow the global default" — we still SHOW Auto's slot as
   *  unselected so the operator sees there's no override; selecting any value writes an override. */
  const valueOf = (cap: CapabilityGate): GateValue | undefined => current[cap];

  const commit = async (next: CapabilityGateMap) => {
    // Normalize empties to undefined so we never persist a masking `{}`.
    const normalized = Object.keys(next).length ? next : undefined;
    if (scope.kind === "global") onChangeGlobalGates(normalized);
    else if (scope.kind === "preset") onChangePresetGates(scope.presetId, normalized);
    else {
      setSavingPane(true);
      try { await onSavePaneGates(scope.paneId, normalized); }
      finally { setSavingPane(false); }
    }
  };

  const setGate = (cap: CapabilityGate, value: GateValue) => {
    void commit({ ...current, [cap]: value });
  };

  const clearGate = (cap: CapabilityGate) => {
    const next = { ...current };
    delete next[cap];
    void commit(next);
  };

  const scopeLabel =
    scope.kind === "global" ? "Global default (applies to every pane unless overridden)"
    : scope.kind === "preset" ? "Preset seed (applied to new panes from this profile)"
    : "This pane only (overrides the global default)";

  return (
    <div className="space-y-4" data-testid="capability-matrix-tab">
      <div className="border-b border-white/5 pb-2">
        <h3 className="text-white uppercase text-[10px] tracking-widest font-bold">Safety gates (capability matrix)</h3>
        <p className="text-[10px] text-zinc-500 mt-0.5">Decide what Janus may do on its own, what it must ask about, and what it can't do at all.</p>
      </div>

      {/* Scope selector */}
      <div className="bg-white/[0.01] p-3 rounded-lg border border-white/5 space-y-2">
        <label className="block text-[9px] uppercase tracking-wider text-zinc-500 font-bold">Editing which gates?</label>
        <select
          data-testid="matrix-scope-select"
          className="w-full bg-black border border-white/10 rounded px-3 py-1.5 text-white cursor-pointer focus:outline-none focus:border-cyan-500"
          value={scope.kind === "global" ? "global" : scope.kind === "preset" ? `preset:${scope.presetId}` : `pane:${scope.paneId}`}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "global") setScope({ kind: "global" });
            else if (v.startsWith("preset:")) setScope({ kind: "preset", presetId: v.slice("preset:".length) });
            else if (v.startsWith("pane:")) setScope({ kind: "pane", paneId: v.slice("pane:".length) });
          }}
        >
          <option value="global">Global default — every pane</option>
          {presets.length > 0 && (
            <optgroup label="A specific startup profile (seed for new panes)">
              {presets.map((p) => <option key={p.id} value={`preset:${p.id}`}>Profile: {p.name}</option>)}
            </optgroup>
          )}
          {panes.length > 0 && (
            <optgroup label="A specific open pane (override)">
              {panes.map((p) => <option key={p.id} value={`pane:${p.id}`}>Pane: {p.name}</option>)}
            </optgroup>
          )}
        </select>
        <p className="text-[9px] text-zinc-600">{scopeLabel} {scope.kind === "pane" && savingPane && <span className="text-cyan-400">· saving…</span>}</p>
        <p className="text-[9px] text-zinc-600">{GATE_HELP}</p>
      </div>

      {/* Grouped toggles */}
      <div className="space-y-4 max-h-[340px] overflow-y-auto pr-1">
        {Object.entries(CAPABILITY_CATEGORIES).map(([category, caps]) => (
          <div key={category} className="space-y-1.5">
            <div className="text-[9px] uppercase tracking-widest text-zinc-500 font-bold">{category}</div>
            {caps.map((cap) => {
              const value = valueOf(cap);
              const isPaneScope = scope.kind === "pane";
              return (
                <div key={cap} data-testid={`matrix-row-${cap}`} className="flex items-center justify-between gap-3 bg-black/40 border border-white/5 rounded px-3 py-1.5">
                  <span className="text-zinc-300 text-[11px] flex-1 min-w-0 truncate" title={CAPABILITY_LABELS[cap]}>{CAPABILITY_LABELS[cap]}</span>
                  <div className="flex items-center gap-1 shrink-0">
                    <div className="inline-flex rounded border border-white/10 overflow-hidden" role="group" aria-label={CAPABILITY_LABELS[cap]}>
                      {GATE_OPTIONS.map((opt) => {
                        const selected = value === opt;
                        const p = GATE_PRESENTATION[opt];
                        return (
                          <button
                            key={opt}
                            type="button"
                            data-testid={`matrix-${cap}-${opt}`}
                            aria-pressed={selected}
                            onClick={() => setGate(cap, opt)}
                            className={`px-2 py-0.5 text-[9px] uppercase tracking-wider font-bold transition-colors cursor-pointer border-r border-white/10 last:border-r-0 ${selected ? p.active : "text-zinc-500 hover:text-zinc-200 hover:bg-white/5"}`}
                          >
                            {p.label}
                          </button>
                        );
                      })}
                    </div>
                    {/* Per-pane scope: a value absent means "follow global". Offer a clear-override affordance. */}
                    {isPaneScope && value !== undefined && (
                      <button
                        type="button"
                        data-testid={`matrix-${cap}-clear`}
                        onClick={() => clearGate(cap)}
                        title="Remove this pane's override (fall back to the global default)"
                        className="px-1.5 py-0.5 text-[8px] uppercase text-zinc-600 hover:text-zinc-300 cursor-pointer"
                      >
                        reset
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
