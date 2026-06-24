// src/classic/components/MiniMarkdown.tsx — the classic (?ui=classic) MiniMarkdown renderer +
// its inline-span parser, extracted VERBATIM out of src/App.tsx (bead dbt4 PR-A — App.tsx
// decomposition into a src/classic/ tree mirroring src/orbital/). Pure leaf: no hooks, no state,
// no Context. The per-line classifier `classifyMarkdownLine` still lives in appHelpers (tested);
// this module keeps that delegation. Rendered output is byte-identical to the former App body.

import * as React from "react";
import { classifyMarkdownLine } from "../../appHelpers";

export function parseInlines(text: string): React.ReactNode[] {
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  const matches = text.split(regex);
  return matches.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={i} className="font-bold text-white font-sans">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("*") && part.endsWith("*")) {
      return (
        <span key={i} className="italic text-cyan-200">
          {part.slice(1, -1)}
        </span>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={i} className="bg-black/80 px-1.5 py-0.5 rounded border border-white/10 font-mono text-xs text-cyan-400">
          {part.slice(1, -1)}
        </code>
      );
    }
    return part;
  }).filter(Boolean) as React.ReactNode[];
}

export function MiniMarkdown({ text }: { text: string }) {
  const lines = text.split("\n");
  // Burndown: the per-line startsWith ladder is the PURE classifier `classifyMarkdownLine` (tested).
  // The list arm's checkbox JSX (its only inline ternaries) is relocated into a nested closure so the
  // map callback's CC stays under the gate. Rendered output is byte-identical to the original ladder.
  const renderList = (info: ReturnType<typeof classifyMarkdownLine>, idx: number) => (
    <div key={idx} className="flex items-start gap-2.5 text-xs text-zinc-300 ml-4 py-0.5 font-sans leading-relaxed">
      {info.isChecklist ? (
        <span className={`w-3.5 h-3.5 border rounded flex-shrink-0 flex items-center justify-center text-xs tracking-tighter ${
          info.isChecked ? "bg-cyan-500/20 border-cyan-400 text-cyan-400 font-bold" : "border-white/20 text-transparent bg-black"
        }`}>✓</span>
      ) : (
        <span className="text-cyan-500 select-none">•</span>
      )}
      <span className={info.isChecked ? "line-through text-zinc-650" : ""}>{parseInlines(info.text)}</span>
    </div>
  );
  return (
    <div className="space-y-1.5 select-text font-sans">
      {lines.map((line, idx) => {
        const info = classifyMarkdownLine(line);
        switch (info.kind) {
          case "h4":
            return (
              <h4 key={idx} className="text-xs font-mono font-bold text-cyan-400 uppercase tracking-widest mt-4 mb-2 border-b border-white/5 pb-1">
                {info.text}
              </h4>
            );
          case "h3":
            return (
              <h3 key={idx} className="text-xs font-mono font-bold text-white uppercase tracking-wider mt-5 mb-2 border-b border-white/10 pb-1">
                {info.text}
              </h3>
            );
          case "h2":
            return (
              <h2 key={idx} className="text-sm font-sans font-black text-white hover:text-cyan-400 uppercase tracking-widest mt-6 mb-3 border-b-2 border-cyan-400/20 pb-1">
                {info.text}
              </h2>
            );
          case "hr":
            return <hr key={idx} className="border-white/5 my-4" />;
          case "list":
            return renderList(info, idx);
          case "blank":
            return <div key={idx} className="h-1.5" />;
          default:
            return (
              <p key={idx} className="text-xs text-zinc-400 leading-relaxed py-0.5 font-sans">
                {parseInlines(info.text)}
              </p>
            );
        }
      })}
    </div>
  );
}
