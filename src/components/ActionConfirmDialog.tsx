import { useEffect } from "react";

/**
 * Confirm dialog for a gated NON-PTY deferred action (capability gate `Ask` tier — G1).
 * Mirrors ApprovalDialog but for actions that mutate config/panes rather than writing to a PTY:
 * create_pane, set_pane_permissions, set_global_permissions. The action's side effect is held on
 * the server (PendingActionStore) and runs exactly once when the operator confirms here.
 */
export function ActionConfirmDialog({
  actionId,
  capability,
  summary,
  onConfirm,
  onCancel,
}: {
  key?: string;
  actionId: string;
  capability: string;
  summary: string;
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
