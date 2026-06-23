import React, { useState, useEffect } from "react";
import { Workspace } from "../types";
import { X, Folder, AlignLeft, Tags, Hash, Terminal, Sparkles } from "lucide-react";

interface ProjectDialogProps {
  onClose: () => void;
  onSave: (data: {
    id: string;
    name: string;
    directory: string;
    summary: string;
    keyTerms: string[];
  }) => Promise<void>;
  project?: Workspace | null; // Pass if editing
}

export function ProjectDialog({ onClose, onSave, project }: ProjectDialogProps) {
  const isEditing = !!project;
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState("");
  const [summary, setSummary] = useState("");
  const [keyTermsInput, setKeyTermsInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (project) {
      setId(project.id);
      setName(project.name || project.id);
      setDirectory(project.directory);
      setSummary(project.summary || "");
      setKeyTermsInput(project.keyTerms ? project.keyTerms.join(", ") : "");
    } else {
      setId("");
      setName("");
      setDirectory(".");
      setSummary("");
      setKeyTermsInput("");
    }
    setError(null);
  }, [project]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const prunedId = id.trim().toLowerCase().replace(/\s+/g, "_");
    if (!prunedId) {
      setError("Project Context ID is required.");
      return;
    }

    if (!isEditing && !/^[a-z0-9_-]+$/.test(prunedId)) {
      setError("Project ID must contain only alphanumeric characters, underscores, and hyphens.");
      return;
    }

    const prunedDirectory = directory.trim() || ".";
    const prunedSummary = summary.trim() || "Dynamic context space.";
    const keyTerms = keyTermsInput
      .split(",")
      .map((term) => term.trim())
      .filter((term) => term.length > 0);

    setIsSaving(true);
    try {
      await onSave({
        id: prunedId,
        name: name.trim() || prunedId,
        directory: prunedDirectory,
        summary: prunedSummary,
        keyTerms,
      });
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to save project context.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="bg-[#0b0b0b] border border-white/10 rounded-xl w-full max-w-lg shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
        
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 bg-white/[0.02] border-b border-white/10 shrink-0 select-none">
          <div className="flex items-center gap-2.5">
            <Terminal className="w-5 h-5 text-cyan-400 shrink-0" />
            <div>
              <h2 className="text-xs font-mono text-white uppercase tracking-widest leading-none">
                {isEditing ? "Modify Project Context" : "Create New Project Context"}
              </h2>
              <p className="text-xs text-zinc-500 font-mono mt-1">
                Configure workspace profiles, working directories, and core terms
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-white/5 rounded text-zinc-400 hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4 text-xs font-mono">
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 text-red-400 text-xs rounded leading-relaxed">
              {error}
            </div>
          )}

          {/* Project ID */}
          <div className="space-y-1">
            <label className="text-zinc-400 flex items-center gap-1.5 font-bold uppercase tracking-wider text-xs">
              <Hash className="w-3.5 h-3.5 text-cyan-500" />
              Project Context ID (slugified)
            </label>
            <input
              type="text"
              disabled={isEditing}
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="e.g. multi-agent-space"
              className="w-full bg-black border border-white/10 disabled:border-white/5 disabled:opacity-50 rounded px-3 py-2 text-white placeholder-zinc-700 font-mono focus:outline-none focus:border-cyan-500"
              required
            />
            {!isEditing && (
              <span className="text-xs text-zinc-650 leading-none">
                Unique identifier used in URLs, terminal configs, and backend systems.
              </span>
            )}
          </div>

          {/* Display Name */}
          <div className="space-y-1">
            <label className="text-zinc-400 flex items-center gap-1.5 font-bold uppercase tracking-wider text-xs">
              <Sparkles className="w-3.5 h-3.5 text-cyan-500" />
              Human-Readable Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Multi-Agent Space"
              className="w-full bg-black border border-white/10 rounded px-3 py-2 text-white placeholder-zinc-700 font-mono focus:outline-none focus:border-cyan-500"
            />
          </div>

          {/* Working Directory */}
          <div className="space-y-1">
            <label className="text-zinc-400 flex items-center gap-1.5 font-bold uppercase tracking-wider text-xs">
              <Folder className="w-3.5 h-3.5 text-cyan-500" />
              CLI Working Directory Path (CWD)
            </label>
            <input
              type="text"
              value={directory}
              onChange={(e) => setDirectory(e.target.value)}
              placeholder="e.g. /workspace/multi-agent"
              className="w-full bg-black border border-white/10 rounded px-3 py-2 text-white placeholder-zinc-700 font-mono focus:outline-none focus:border-cyan-500"
              required
            />
            <span className="text-xs text-zinc-650 leading-none">
              Default path from which terminal panels and command environments will open.
            </span>
          </div>

          {/* Codebase Summary details */}
          <div className="space-y-1">
            <label className="text-zinc-400 flex items-center gap-1.5 font-bold uppercase tracking-wider text-xs">
              <AlignLeft className="w-3.5 h-3.5 text-cyan-500" />
              High-Level Details / Summary Description
            </label>
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Describe the primary architecture, components, or goals of this codebase context..."
              rows={3}
              className="w-full bg-black border border-white/10 rounded px-3 py-2 text-white placeholder-zinc-700 font-mono focus:outline-none focus:border-cyan-500 resize-none"
            />
          </div>

          {/* Core Codebase Terms */}
          <div className="space-y-1">
            <label className="text-zinc-400 flex items-center gap-1.5 font-bold uppercase tracking-wider text-xs">
              <Tags className="w-3.5 h-3.5 text-cyan-500" />
              Key Terms (comma separated tags)
            </label>
            <input
              type="text"
              value={keyTermsInput}
              onChange={(e) => setKeyTermsInput(e.target.value)}
              placeholder="e.g. React, Express, WebSocket, GeminiAPI"
              className="w-full bg-black border border-white/10 rounded px-3 py-2 text-white placeholder-zinc-700 font-mono focus:outline-none focus:border-cyan-500"
            />
            <span className="text-xs text-zinc-650 leading-none">
              Enter key terms or technologies that characterize this project context.
            </span>
          </div>

          {/* Footer Controls */}
          <div className="flex justify-end gap-3 pt-4 border-t border-white/5 bg-white/[0.01] -mx-6 -mb-6 px-6 py-4">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-white/5 hover:bg-white/5 rounded text-zinc-400 hover:text-white transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white font-bold rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {isSaving ? "Saving..." : isEditing ? "Save Changes" : "Create Context"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
