import { useEffect } from "react";
import type { GateValue } from "../types";
import {
  POSTURE_STYLE,
  GATE_STYLE,
  CAPABILITY_LABELS,
  deriveActionDivergence,
  // n2r (wsm-e2e-pinned-n2r, §5.2): route the rider's posture/gate through the same crash-safe
  // normalizers the chip uses, so a malformed rider payload degrades the badge calmly instead of
  // throwing INSIDE the confirm modal (which would block the operator's confirm path — worse than
  // the chip case). n2r only sanitizes the presentation inputs; the divergence decision stays rbh's.
  normalizePostureWord,
  normalizeGateValue,
  type PostureWord,
} from "../gateSurface";

type EffectiveMode = "Full Auto" | "Human-in-the-Loop" | "Read-Only";

/**
 * Confirm dialog for a gated NON-PTY deferred action (capability gate `Ask` tier — G1).
 * Mirrors ApprovalDialog but for actions that mutate config/panes rather than writing to a PTY:
 * create_pane, set_pane_permissions, set_global_permissions. The action's side effect is held on
 * the server (PendingActionStore) and runs exactly once when the operator confirms here.
 *
 * rbh (wsm-e2e-pinned-rbh): below the nominal summary we render an EFFECTIVE-posture rider — the
 * posture word + the effective gate (plain language) the engine WILL apply — and, when the operator
 * asked for a mode the global mode or a tighter gate overrides, a divergence "heads up" rider. The
 * posture is SERVER truth threaded in via props (never re-derived here); the palette is the SAME
 * gateSurface map the chip uses, so dialog == chip == engine. Degrade-safe: no posture → today's dialog.
 */
export function ActionConfirmDialog({
  actionId,
  capability,
  summary,
  posture,
  effectiveGate,
  effectiveMode,
  requestedMode,
  globalOverride,
  paneId,
  onConfirm,
  onCancel,
}: {
  key?: string;
  actionId: string;
  capability: string;
  summary: string;
  /** SERVER-resolved posture word for the target pane (undefined for global actions / older payloads). */
  posture?: PostureWord;
  /** SERVER-resolved effective gate for `capability` after override → spotlight → global resolution. */
  effectiveGate?: GateValue;
  /** SERVER-resolved effective mode (global override or pane mode) the engine will enforce. */
  effectiveMode?: EffectiveMode;
  /** The mode the operator asked for (structural — never parsed from the summary). */
  requestedMode?: string;
  /** Whether the GLOBAL mode (≠ Inherit) genuinely overrides the request (vs a staged-not-applied delta). */
  globalOverride?: boolean;
  /** null for global actions (no pane scope — D2). */
  paneId?: string | null;
  onConfirm: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel(actionId);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [actionId, onCancel]);

  // rbh: render the effective rider only when the server supplied posture truth (degrade-safe, D5).
  const showEffective = !!posture || !!effectiveGate;
  // n2r §5.2: normalize before the closed-union style lookup so a malformed rider never indexes an
  // undefined record. normalizePostureWord(null) === null (render no badge); a bad word → GUARDED.
  const safePosture = normalizePostureWord(posture);
  const safeGate = effectiveGate != null ? normalizeGateValue(effectiveGate) : undefined;
  const postureStyle = safePosture ? POSTURE_STYLE[safePosture] ?? POSTURE_STYLE.GUARDED : undefined;
  const gateStyle = safeGate ? GATE_STYLE[safeGate] ?? GATE_STYLE.Ask : undefined;
  const capLabel = CAPABILITY_LABELS[capability as keyof typeof CAPABILITY_LABELS] ?? capability;
  // Scope label: a per-pane action names its pane ("Effective on p1:"); a global action (paneId
  // null/undefined — D2) has no pane scope, so we read "Effective globally:". This makes the
  // pane-vs-global distinction visible and consumes the (previously dead) paneId prop.
  const scopeLabel = paneId ? `Effective on ${paneId}:` : "Effective globally:";

  // Divergence: pure decision (gateSurface) — the operator asked for `requestedMode`, but will the
  // engine apply it? "global" leads with the root-cause global mode; "gate" reports a bare gate-Off.
  // `globalOverride` (server: globalMode !== Inherit) keeps the "global" branch from mislabeling a
  // staged-not-yet-applied mode change as a global override (concern-3 fix).
  const divergence = deriveActionDivergence(requestedMode, effectiveMode, effectiveGate, globalOverride);
  const showDivergence = divergence !== "none";
  let divergenceText = "";
  if (divergence === "global") {
    // global mode wins: the pane stays at the resolved posture until the global mode changes.
    const stays = safePosture ?? "LOCKED";
    divergenceText = `Global mode is ${effectiveMode} — this pane stays ${stays} until you change the global mode.`;
  } else if (divergence === "gate") {
    // gate veto with no mode override: the capability gate itself is Off.
    divergenceText = `The '${capLabel}' gate is Blocked — this stays Blocked even after you confirm.`;
  }

  return (
    <div data-testid="action-dialog" className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-[620px] bg-[#111] border-2 border-sky-500/50 rounded-xl p-6 shadow-2xl shadow-black/80 animate-in slide-in-from-bottom-10 fade-in duration-300">
        <div className="flex items-start gap-5">
          <div className="flex-shrink-0 w-10 h-10 rounded-full bg-sky-500/20 border border-sky-500/50 flex items-center justify-center">
            <span className="text-sky-400 font-bold text-lg">⚙</span>
          </div>
          <div className="flex-1">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-mono font-bold uppercase tracking-widest text-sky-400">Confirm Action</h3>
              <span data-testid="action-capability" className="text-[10px] font-mono opacity-40">{capability}</span>
            </div>

            <p data-testid="action-summary" className="text-sm font-mono text-white/90 bg-black/40 p-2 rounded border border-white/5 mb-4 break-all">
              {summary}
            </p>

            {showEffective && (
              <div
                data-testid="action-effective"
                className={`mb-3 rounded border p-2 font-mono ${postureStyle?.ring ?? "border-white/10"}`}
              >
                <div className="flex items-center gap-2 text-[11px]">
                  <span data-testid="action-scope" className="text-zinc-500 uppercase tracking-wider">{scopeLabel}</span>
                  {safePosture && postureStyle && (
                    <span className={`inline-flex items-center gap-1.5 font-bold uppercase tracking-wider ${postureStyle.text}`}>
                      <span className={`inline-block w-1.5 h-1.5 rounded-full ${postureStyle.dot}`} />
                      {safePosture}
                    </span>
                  )}
                  {postureStyle && <span className="text-zinc-500 normal-case">· {postureStyle.label}</span>}
                </div>
                {gateStyle && (
                  <div className="mt-1 flex items-center gap-2 text-[10px]">
                    <span className="text-zinc-400">{capLabel}</span>
                    <span className={`inline-flex items-center gap-1 ${gateStyle.text}`}>
                      <span className={`inline-block w-1 h-1 rounded-full ${gateStyle.dot}`} />
                      {gateStyle.word}
                    </span>
                  </div>
                )}
              </div>
            )}

            {showDivergence && (
              <p data-testid="action-divergence" className="mb-3 text-[11px] font-mono text-amber-300 bg-amber-950/20 border border-amber-500/30 rounded p-2">
                Heads up — {divergenceText}
              </p>
            )}

            <p className="text-[10px] font-mono text-zinc-500 mb-4">
              This action is gated <span className="text-sky-400">Ask</span> — Janus staged it but will not apply it until you confirm.
            </p>

            <div className="flex gap-3">
              <button
                data-testid="action-confirm"
                onClick={() => onConfirm(actionId)}
                className="flex-1 py-2 bg-sky-600 hover:bg-sky-500 text-black text-xs font-bold uppercase tracking-widest transition-colors focus:outline-none focus:ring-2 focus:ring-sky-500"
              >
                Confirm
              </button>
              <button
                data-testid="action-cancel"
                onClick={() => onCancel(actionId)}
                autoFocus
                className="px-6 py-2 border border-red-500/30 bg-red-950/10 hover:bg-red-900/20 text-red-400 text-xs font-bold uppercase tracking-widest transition-colors focus:outline-none focus:ring-2 focus:ring-red-500"
              >
                Cancel [Esc]
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
