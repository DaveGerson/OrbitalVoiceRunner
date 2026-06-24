// src/classic/components/ErrorBoundary.tsx — the classic (?ui=classic) global ErrorBoundary,
// extracted VERBATIM out of src/App.tsx (bead dbt4 PR-A — App.tsx decomposition into a
// src/classic/ tree mirroring src/orbital/). Pure leaf class component: catches an unhandled
// render fault, logs it, and renders the FAULT page with a reboot button. No app state/Context.
// Behavior is byte-identical to the former App body. (src/main.tsx keeps its OWN separate
// ErrorBoundary for the OrbitalApp default — unrelated to this one.)

import * as React from "react";

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState;
  props: ErrorBoundaryProps;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.props = props;
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("[CRITICAL FRONTEND FAULT]", error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#060606] text-white flex flex-col items-center justify-center p-6 font-mono select-none">
          <div className="w-full max-w-md bg-red-950/20 border border-red-500/30 rounded p-6 shadow-2xl relative animate-in zoom-in duration-250">
            <div className="absolute top-3 right-3 text-xs bg-red-500 text-black px-1.5 rounded font-bold">FAULT</div>
            <h1 className="text-sm font-bold uppercase tracking-wider text-red-400 mb-4 flex items-center gap-2">
              ⚠️ Critical Sandbox Error
            </h1>
            <p className="text-xs text-zinc-400 leading-relaxed mb-4">
              The Antigravity application engine encountered an unhandled execution exception. This sandbox remains active.
            </p>
            <div className="bg-black/60 p-3 rounded text-xs text-zinc-500 overflow-x-auto break-all border border-white/5 max-h-40 mb-6 font-mono leading-relaxed">
              {this.state.error?.stack || this.state.error?.message || "Unknown Runtime Exception"}
            </div>
            <button
              onClick={() => window.location.reload()}
              className="w-full text-center py-2 bg-red-500 text-black hover:bg-red-400 text-xs font-bold uppercase tracking-wider transition-colors cursor-pointer focus:outline-none"
            >
              Reboot Application View
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
