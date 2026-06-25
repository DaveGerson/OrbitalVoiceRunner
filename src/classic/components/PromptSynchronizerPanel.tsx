// src/classic/components/PromptSynchronizerPanel.tsx — the right-rail "Sync Spec" / Prompt Draft
// composer workbench, extracted VERBATIM out of src/App.tsx's AppRaw() (bead dbt4 — App.tsx
// decomposition, chunk-2 "composer-cluster"). Mirrors the src/classic/components/ seam.
//
// The four conditional sub-sections (WIP strip, draft viewport, context block, header toolbar) are
// kept as INTERNAL nested render closures, byte-identical to the former App body — this both
// maximizes fidelity and keeps each ?:/&& inside its own function scope (CC gate). JSX
// order/keys/props/data-testids are unchanged.
//
// Composer state/handlers arrive as a single `composer` prop (the useComposer return object), so the
// caller threads the hook's exact identities through unchanged. setActiveTerminalId is harness-wired
// (the WIP-strip pane-switch buttons) and is passed as the SAME callback reference straight through.

import * as React from "react";
import { CheckSquare } from "lucide-react";
import { MiniMarkdown } from "./MiniMarkdown";
import type { Composer } from "../hooks/useComposer";
import type { PaneMeta } from "../../types";

export function PromptSynchronizerPanel({
  composer,
  activePaneMeta,
  activeTerminalId,
  setActiveTerminalId,
}: {
  composer: Composer;
  activePaneMeta: PaneMeta | null;
  activeTerminalId: string | null;
  setActiveTerminalId: (id: string) => void;
}) {
  const {
    promptBuffer,
    promptBufferEditMode,
    wipDrafts,
    contextInput,
    handlePromptBufferChange,
    handleSendDraft,
    handleAddHumanContext,
    setContextInput,
    setIsBufferFocused,
    setPromptBufferEditMode,
  } = composer;

  const activePaneName = activePaneMeta?.name || activeTerminalId || "no pane open";
  const modelCtx = activePaneMeta?.modelContext || [];
  const humanCtx = activePaneMeta?.humanContext || [];
  // The other panes (not the active one) that have WIP drafts — the scalable register.
  const otherWip = wipDrafts.filter((d) => d.paneId !== activeTerminalId);

  // Burndown: the three conditional sub-sections (WIP strip, draft viewport, context block) are
  // relocated VERBATIM into in-body render closures so their inline ?:/&& move into nested function
  // scopes — dropping this closure's own CC below the gate. JSX order/keys/props are unchanged; the
  // closures are called inline at their original positions.
  const renderWipStrip = () => otherWip.length > 0 && (
    <div className="px-3 py-1.5 bg-black/40 border-b border-white/5 flex items-center gap-1.5 overflow-x-auto select-none">
      <span className="text-xs font-mono uppercase text-zinc-500 shrink-0">WIP elsewhere:</span>
      {otherWip.map((d) => (
        <button
          key={d.paneId}
          onClick={() => setActiveTerminalId(d.paneId)}
          title={d.draft.text.slice(0, 200)}
          className="shrink-0 px-1.5 py-0.5 text-xs font-mono rounded bg-amber-500/10 text-amber-300 border border-amber-500/20 hover:bg-amber-500/20"
        >
          {d.paneId} · {d.draft.text.split("\n").filter(Boolean).length}L
        </button>
      ))}
    </div>
  );

  const renderViewport = () => (
    <div className="flex-1 p-4 overflow-y-auto font-mono text-xs text-zinc-300 min-h-[200px]">
      {promptBufferEditMode === "edit" ? (
        <textarea
          data-testid="composer-input"
          value={promptBuffer}
          onChange={(e) => handlePromptBufferChange(e.target.value)}
          onFocus={() => setIsBufferFocused(true)}
          onBlur={() => setIsBufferFocused(false)}
          disabled={!activeTerminalId}
          className="w-full h-full min-h-[180px] bg-black text-xs text-zinc-200 p-3 rounded border border-white/10 focus:outline-none focus:border-cyan-500 font-mono resize-none leading-relaxed overflow-y-auto selection:bg-cyan-500/30 disabled:opacity-50"
          placeholder={activeTerminalId ? "Compose the prompt to send to this pane. Your dictation and Janus's suggestions land here; refine, then Send." : "Open a pane to start composing a prompt for it."}
        />
      ) : (
        <div className="prose prose-invert max-w-none text-zinc-300">
          {promptBuffer ? (
            <MiniMarkdown text={promptBuffer} />
          ) : (
            <p className="text-xs text-zinc-600 font-mono italic">{activeTerminalId ? "Empty draft. Switch to Edit, speak into the microphone, or ask Janus to draft a prompt for this pane." : "No pane open. Open a pane to compose a prompt for it."}</p>
          )}
        </div>
      )}
    </div>
  );

  const renderContextBlock = () => activeTerminalId && (
    <div data-testid="pane-context-body" className="px-3 py-2 bg-[#080808] border-t border-white/5 select-none max-h-[160px] overflow-y-auto">
      <div className="text-xs font-mono uppercase text-zinc-500 mb-1">Context · {activePaneName}</div>
      {(modelCtx.length > 0 || humanCtx.length > 0) ? (
        <div className="space-y-0.5 mb-1.5">
          {modelCtx.slice(-4).map((c, i) => (
            <div key={`m${i}`} className="text-xs font-mono text-sky-300/80 leading-snug">· {c.text}</div>
          ))}
          {humanCtx.slice(-4).map((c, i) => (
            <div key={`h${i}`} className="text-xs font-mono text-emerald-300/90 leading-snug">✎ {c.text}</div>
          ))}
        </div>
      ) : (
        <div className="text-xs font-mono text-zinc-600 italic mb-1.5">No context yet. Add steering notes Janus will read.</div>
      )}
      <div className="flex gap-1">
        <input
          value={contextInput}
          onChange={(e) => setContextInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { handleAddHumanContext(contextInput); setContextInput(""); } }}
          placeholder="Add context for this pane…"
          className="flex-1 bg-black text-xs text-zinc-200 px-2 py-1 rounded border border-white/10 focus:outline-none focus:border-emerald-500 font-mono"
        />
        <button
          onClick={() => { handleAddHumanContext(contextInput); setContextInput(""); }}
          className="px-2 py-1 text-xs font-mono uppercase bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 rounded"
        >
          Add
        </button>
      </div>
    </div>
  );

  const renderHeaderToolbar = () => (
    <div className="p-3 bg-white/[0.02] border-b border-white/5 flex items-center justify-between shrink-0 select-none">
      <div className="flex items-center gap-2 min-w-0">
        <CheckSquare className="w-4 h-4 text-cyan-400 shrink-0" />
        <h3 className="text-xs font-mono font-bold tracking-wider text-white uppercase truncate">Prompt Draft</h3>
        <span
          data-testid="composer-target-pane"
          className="text-xs font-mono px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-300 border border-cyan-500/20 truncate"
          title="The pane this draft will be sent to"
        >
          → {activePaneName}
        </span>
      </div>
      <div className="flex items-center gap-1.5 bg-black/60 p-1 rounded border border-white/10 font-bold select-none">
        <button
          onClick={() => setPromptBufferEditMode("preview")}
          className={`px-2 py-0.5 text-xs font-mono rounded transition-colors uppercase ${promptBufferEditMode === "preview" ? "bg-cyan-500/10 text-cyan-400 font-bold" : "text-zinc-500 hover:text-zinc-300"}`}
        >
          Preview
        </button>
        <button
          data-testid="composer-edit-toggle"
          onClick={() => setPromptBufferEditMode("edit")}
          className={`px-2 py-0.5 text-xs font-mono rounded transition-colors uppercase ${promptBufferEditMode === "edit" ? "bg-cyan-500/10 text-cyan-400 font-bold" : "text-zinc-500 hover:text-zinc-300"}`}
        >
          Edit
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex-1 flex flex-col bg-[#060606] border border-white/5 rounded-lg overflow-hidden h-full">
      {/* Header toolbar */}
      {renderHeaderToolbar()}

      {/* Helper Explanation strip */}
      <div className="px-3 py-1.5 bg-cyan-950/10 border-b border-white/[0.03] select-none text-xs text-zinc-400 font-mono leading-relaxed">
        <span className="text-cyan-400 font-extrabold uppercase">Workbench:</span> compose the prompt for the open pane with Janus, then <span className="text-cyan-300 font-bold">Send</span> it. <span className="text-emerald-400/80">Saved per-pane — switching panes never loses your draft.</span>
      </div>

      {/* WIP register (the scalable part of "B"): other panes with drafts in progress. */}
      {renderWipStrip()}

      {/* Content Viewport — the draft */}
      {renderViewport()}

      {/* Context (C): the layered orientation that shapes this draft. */}
      {renderContextBlock()}

      {/* Action toolbar: Send is primary. */}
      <div className="p-3 bg-[#0d0d0d] border-t border-white/5 flex flex-wrap gap-2 items-center justify-between shrink-0 select-none">
        <div className="flex gap-2">
          <button
            onClick={() => handlePromptBufferChange(promptBuffer + "\n- [ ] ")}
            disabled={!activeTerminalId}
            className="px-2 py-1 text-xs font-mono uppercase bg-white/5 border border-white/10 text-zinc-300 hover:text-white rounded disabled:opacity-40"
          >
            + Task
          </button>
          <button
            onClick={() => handlePromptBufferChange("")}
            disabled={!activeTerminalId}
            className="px-2 py-1 text-xs font-mono uppercase bg-red-500/5 hover:bg-red-500/10 border border-red-500/10 hover:border-red-500/20 text-red-400 rounded disabled:opacity-40"
          >
            Clear
          </button>
        </div>

        <button
          data-testid="composer-send"
          onClick={handleSendDraft}
          disabled={!activeTerminalId || !promptBuffer.trim()}
          className="px-4 py-1.5 text-xs font-mono uppercase bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/40 rounded font-bold flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
          title="Send this prompt to the open pane (operator approval)"
        >
          Send → {activePaneName}
        </button>
      </div>
    </div>
  );
}
