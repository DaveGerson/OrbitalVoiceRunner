import { useEffect } from "react";
import type { ReactNode } from "react";
import type { CapabilityGate, CapabilityGateMap } from "../types";
import {
  POSTURE_STYLE,
  GATE_STYLE,
  CAPABILITY_LABELS,
  // n2r (wsm-e2e-pinned-n2r, §5.2): sanitize the rider's posture/write-gate before the closed-union
  // style lookup so a malformed approval_pending rider can't throw inside the approval modal.
  normalizePostureWord,
  normalizeGateValue,
  type PostureWord,
} from "../gateSurface";

type EffectiveMode = "Full Auto" | "Human-in-the-Loop" | "Read-Only";

/** Input bag for deriveApprovalDisplayState. */
export interface ApprovalDisplayInput {
  posture: PostureWord | undefined;
  effectiveGates: CapabilityGateMap | undefined;
  effectiveMode: EffectiveMode | undefined;
  capability: CapabilityGate | undefined;
}

/** All pre-computed display values for the approval dialog. Pure — no React, no JSX. */
export interface ApprovalDisplayState {
  showEffective: boolean;
  safePosture: ReturnType<typeof normalizePostureWord>;
  postureStyle: typeof POSTURE_STYLE[PostureWord] | undefined;
  writeCap: CapabilityGate;
  safeGate: ReturnType<typeof normalizeGateValue> | undefined;
  gateStyle: typeof GATE_STYLE[keyof typeof GATE_STYLE] | undefined;
  capLabel: string;
  showMode: boolean;
}

/**
 * Pure helper: compute all display-layer values from server-truth props.
 *
 * Extracted to reduce cyclomatic complexity of ApprovalDialog and to make the
 * branching logic (n2r §5.2 + rbh) independently unit-testable.
 *
 * EXPORTED for testing — not a React component, no hooks, no JSX.
 */
export function deriveApprovalDisplayState(input: ApprovalDisplayInput): ApprovalDisplayState {
  const { posture, effectiveGates, effectiveMode, capability } = input;

  // rbh: render the effective rider only when the server supplied posture truth (degrade-safe, D5).
  const showEffective = !!posture || !!effectiveGates;
  // n2r §5.2: normalize before the closed-union lookups (bad posture → GUARDED, bad gate → Ask).
  const safePosture = normalizePostureWord(posture);
  const postureStyle = safePosture ? POSTURE_STYLE[safePosture] ?? POSTURE_STYLE.GUARDED : undefined;
  const writeCap: CapabilityGate = capability ?? "write_to_pane";
  const writeGate = effectiveGates?.[writeCap];
  const safeGate = writeGate != null ? normalizeGateValue(writeGate) : undefined;
  const gateStyle = safeGate ? GATE_STYLE[safeGate] ?? GATE_STYLE.Ask : undefined;
  const capLabel = CAPABILITY_LABELS[writeCap] ?? writeCap;
  // The pane's effective autonomy MODE is the second axis of "into what am I approving this write?".
  // Read-Only is the load-bearing case: a write approved into a Read-Only pane lands in a LOCKED
  // posture, so we surface the mode alongside the posture word (consumes the previously dead prop).
  const showMode = !!effectiveMode;

  return { showEffective, safePosture, postureStyle, writeCap, safeGate, gateStyle, capLabel, showMode };
}

// ─── Inline render helpers (return ReactNode, called inline — NOT new React components) ──────────

/** Renders the "Approving into:" posture/gate/mode rider block. Called only when showEffective. */
function renderEffectiveRider(
  postureStyle: ApprovalDisplayState["postureStyle"],
  safePosture: ApprovalDisplayState["safePosture"],
  showMode: boolean,
  effectiveMode: EffectiveMode | undefined,
  gateStyle: ApprovalDisplayState["gateStyle"],
  capLabel: string,
): ReactNode {
  return (
    <div
      data-testid="approval-effective"
      className={`mb-4 rounded border p-2 font-mono ${postureStyle?.ring ?? "border-white/10"}`}
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="text-zinc-500 uppercase tracking-wider">Approving into:</span>
        {safePosture && postureStyle && (
          <span className={`inline-flex items-center gap-1.5 font-bold uppercase tracking-wider ${postureStyle.text}`}>
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${postureStyle.dot}`} />
            {safePosture}
          </span>
        )}
        {postureStyle && <span className="text-zinc-500 normal-case">· {postureStyle.label}</span>}
        {showMode && (
          <span data-testid="approval-mode" className="text-zinc-500 normal-case">· mode {effectiveMode}</span>
        )}
      </div>
      {gateStyle && (
        <div className="mt-1 flex items-center gap-2 text-xs">
          <span className="text-zinc-400">{capLabel}</span>
          <span className={`inline-flex items-center gap-1 ${gateStyle.text}`}>
            <span className={`inline-block w-1 h-1 rounded-full ${gateStyle.dot}`} />
            {gateStyle.word}
          </span>
        </div>
      )}
    </div>
  );
}

/** Renders the heard-trigger / proposed-rationale block. Called only when rationale is defined. */
function renderRationale(rationale: { trigger: string; summary: string }): ReactNode {
  return (
    <div className="mb-4 space-y-2 border-l-2 border-zinc-700 pl-3">
      <div className="text-xs font-mono">
        <span className="text-zinc-500 uppercase tracking-wider block font-bold">Heard trigger / context</span>
        <span className="text-zinc-300 italic">"{rationale.trigger}"</span>
      </div>
      <div className="text-xs font-mono">
        <span className="text-zinc-500 uppercase tracking-wider block font-bold">Proposed rationale / summary</span>
        <pre className="text-xs bg-black/30 p-1.5 rounded border border-white/5 text-zinc-400 whitespace-pre-wrap max-h-24 overflow-y-auto">
           {rationale.summary}
        </pre>
      </div>
    </div>
  );
}

/**
 * Approve/reject dialog for a staged PTY write (Human-in-the-Loop).
 *
 * rbh (wsm-e2e-pinned-rbh): below the command we render the TARGET pane's EFFECTIVE posture — the
 * posture word + the write gate (plain language) in force — so the operator can see "into what
 * posture am I approving this write?" with the SAME truth the chip shows. Posture is SERVER truth
 * threaded in via props (never re-derived); palette is the shared gateSurface map. Degrade-safe:
 * no posture → today's dialog.
 */
export function ApprovalDialog({
  messageId,
  terminalId,
  cmd,
  rationale,
  posture,
  effectiveGates,
  effectiveMode,
  capability,
  isTop = true,
  onApprove,
  onReject
}: {
  key?: string;
  messageId: string;
  terminalId: string;
  cmd: string;
  rationale?: {
    trigger: string;
    summary: string;
  };
  /** SERVER-resolved posture word for the target pane (undefined for older payloads / mocks). */
  posture?: PostureWord;
  /** SERVER-resolved effective gates for the target pane (the write gate is read from here). */
  effectiveGates?: CapabilityGateMap;
  /** SERVER-resolved effective mode the engine will enforce on this pane. */
  effectiveMode?: EffectiveMode;
  /** The write capability gating this approval (write_to_pane / deliver_handoff). */
  capability?: CapabilityGate;
  /**
   * Phase 1 1B.2: only the TOPMOST overlay may own the window-level Escape handler — with several
   * dialogs stacked, every instance registering its own listener meant one Escape bulk-rejected
   * everything. Optional + default true so existing call sites (classic App.tsx) compile unchanged.
   */
  isTop?: boolean;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  useEffect(() => {
    if (!isTop) return; // 1B.2: Escape belongs to the topmost dialog only
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onReject(messageId);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [messageId, onReject, isTop]);

  const {
    showEffective,
    safePosture,
    postureStyle,
    showMode,
    gateStyle,
    capLabel,
  } = deriveApprovalDisplayState({ posture, effectiveGates, effectiveMode, capability });

  return (
    <div data-testid="approval-dialog" className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-[620px] bg-[#111] border-2 border-amber-500/50 rounded-xl p-6 shadow-2xl shadow-black/80 animate-in slide-in-from-bottom-10 fade-in duration-300">
        <div className="flex items-start gap-5">
          <div className="flex-shrink-0 w-10 h-10 rounded-full bg-amber-500/20 border border-amber-500/50 flex items-center justify-center">
            <span className="text-amber-500 font-bold text-xl">!</span>
          </div>
          <div className="flex-1">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-xs font-mono font-bold uppercase tracking-widest text-[#d97706]">Proposed Command Execution</h3>
              <span className="text-xs font-mono opacity-40">Target: {terminalId}</span>
            </div>

            <p className="text-sm font-mono text-white/90 bg-black/40 p-2 rounded border border-white/5 mb-4 break-all">
              {cmd}
            </p>

            {showEffective && renderEffectiveRider(postureStyle, safePosture, showMode, effectiveMode, gateStyle, capLabel)}

            {rationale && renderRationale(rationale)}

            <div className="flex gap-3">
              <button
                data-testid="approval-approve"
                onClick={() => onApprove(messageId)}
                className="flex-1 py-2 bg-amber-600 hover:bg-amber-500 text-black text-xs font-bold uppercase tracking-widest transition-colors focus:outline-none focus:ring-2 focus:ring-amber-500"
              >
                Confirm & Fire
              </button>
              <button
                data-testid="approval-reject"
                onClick={() => onReject(messageId)}
                autoFocus
                className="px-6 py-2 border border-red-500/30 bg-red-950/10 hover:bg-red-900/20 text-red-400 text-xs font-bold uppercase tracking-widest transition-colors focus:outline-none focus:ring-2 focus:ring-red-500"
              >
                Reject [Esc]
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
