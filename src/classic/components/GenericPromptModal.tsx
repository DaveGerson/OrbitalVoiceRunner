// src/classic/components/GenericPromptModal.tsx — the classic (?ui=classic) single-input prompt
// modal, extracted VERBATIM out of src/App.tsx (App.tsx decomposition into src/classic/, chunk-1
// "warmup leaves"). Was `const GenericPromptModal = () => {...}` defined inside AppRaw; now a
// promoted leaf taking { promptDialog, setPromptDialog } as props. Owns one internal `val` useState
// and renders a fixed overlay modal (title, single input, Cancel/Save). DOM is byte-identical.
//
// IMPORTANT (rules-of-hooks): the `val` useState is called UNCONDITIONALLY, BEFORE the
// `if (!promptDialog) return null` early return — keep that ordering verbatim so the hook order is
// stable whether or not the dialog is open.

import * as React from "react";
import { useState } from "react";

export type PromptDialogState = {
  title: string;
  placeholder: string;
  onSubmit: (val: string) => void;
} | null;

export function GenericPromptModal({
  promptDialog,
  setPromptDialog,
}: {
  promptDialog: PromptDialogState;
  setPromptDialog: (next: PromptDialogState) => void;
}) {
  // Hook must be called unconditionally (rules-of-hooks): declare state BEFORE the
  // early return so the hook order is stable whether or not promptDialog is open.
  const [val, setVal] = useState("");
  if (!promptDialog) return null;
  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur flex items-center justify-center p-4">
      <div className="bg-[#111] border border-white/10 p-6 rounded shadow-2xl w-full max-w-sm flex flex-col gap-4">
        <h2 className="text-white text-sm font-bold font-mono tracking-wide">{promptDialog.title}</h2>
        <input
          autoFocus
          type="text"
          placeholder={promptDialog.placeholder}
          value={val}
          onChange={e => setVal(e.target.value)}
          className="w-full bg-black border border-white/20 p-2 text-white font-mono text-xs focus:outline-none focus:border-cyan-500"
          onKeyDown={e => e.key === 'Enter' && promptDialog.onSubmit(val)}
        />
        <div className="flex justify-end gap-3 mt-2">
          <button onClick={() => setPromptDialog(null)} className="text-xs font-mono uppercase tracking-wider text-white/50 hover:text-white transition">Cancel</button>
          <button onClick={() => promptDialog.onSubmit(val)} className="text-xs font-mono uppercase tracking-wider text-cyan-400 font-bold hover:text-cyan-300 transition">Save</button>
        </div>
      </div>
    </div>
  );
}
