// src/classic/hooks/useComposer.ts — the prompt-buffer / WIP-draft composer layer, extracted VERBATIM
// out of src/App.tsx's AppRaw() (bead dbt4 — App.tsx decomposition, mirroring the gold-standard
// src/hooks/useLiveSession.ts / src/classic/hooks/useTerminalHistory.ts seam: params-interface in,
// returns-interface out, the ONE pure decision split into the node:test-pinned
// src/classic/helpers/composerLogic.ts sibling).
//
// Owns:
//   * promptBuffer / isBufferFocused / promptBufferEditMode — the Markdown prompt-buffer UI state.
//   * wipDrafts — the cross-pane WIP draft register (so work composed for one pane survives a switch).
//   * contextInput — the operator-typed human-context input.
//   * fetchActiveDraft(projId?, paneId?) — GET the active pane's persisted WIP draft into the buffer.
//   * fetchWipDrafts(projId?) — GET the project-wide WIP draft register.
//   * handlePromptBufferChange(val) — set the buffer, then push the edit over the live WS (draft_edit)
//     or fall back to a REST PUT — the WS-vs-REST gate is composerLogic.shouldSendDraftOverWs.
//   * handleSendDraft() — operator-direct send of the active pane's draft (POST), then clear + earcon.
//   * handleAddHumanContext(text) — POST an operator-typed human-context entry, then refresh the ledger.
//
// *** HARNESS COUPLING (load-bearing) ***: setWipDrafts IS wired into the e2e harness
// (E2EHarnessDeps.setWipDrafts at src/e2e/harness.ts:167, driven by the injectWipDraft hook used by
// the draft-pending-badge specs). This hook RETURNS setWipDrafts and App threads that exact identity
// back into the useE2EHarness deps object — mirroring how useStdoutStream preserved queueStdoutChunk.
//
// Seam: handlePromptBufferChange/handleSendDraft/handleAddHumanContext perform REST/WS I/O, so the
// caller (App) supplies activeProjectId/activeTerminalId (values), the live-session wsRef (so the
// draft_edit frame goes out the SAME socket useLiveSession owns), playEarcon, and fetchLedger.
//
// Behavior is byte-identical to the former App body: same default-arg fetchers, same WS-then-REST
// fallback, same .trim() send gate + "execute" earcon, same human-context POST + fetchLedger refresh.
// No observable change — the e2e classic net (draft badge / composer specs) is the integration witness.

import type * as React from "react";
import { useState, type Dispatch, type SetStateAction } from "react";
import { apiFetch } from "../../utils/api";
import { shouldSendDraftOverWs } from "../helpers/composerLogic";
import type { ExchangeDraftView } from "../../types";

/** One WIP-draft register row, as returned by GET /api/projects/:id/drafts. */
export type WipDraft = { paneId: string; draft: { text: string; updatedAt: string; updatedBy?: string } };

export interface ComposerParams {
  /** The active project — defaults the fetchers' projId and scopes the draft REST/WS routes. */
  activeProjectId: string;
  /** The active pane — defaults the active-draft fetcher's paneId and gates the send/context writes. */
  activeTerminalId: string | null;
  /**
   * The live-session WebSocket ref (owned by useLiveSession). handlePromptBufferChange reads
   * wsRef.current at call-time to push draft_edit frames over the SAME socket, falling back to REST.
   */
  wsRef: React.MutableRefObject<WebSocket | null>;
  /** Plays the "execute" earcon on a successful draft send (App-owned, from useEarcons). */
  playEarcon: (token: string) => void;
  /** Refreshes the ledger after a human-context POST (App-owned). */
  fetchLedger: () => void;
}

export interface Composer {
  promptBuffer: string;
  setPromptBuffer: Dispatch<SetStateAction<string>>;
  isBufferFocused: boolean;
  setIsBufferFocused: Dispatch<SetStateAction<boolean>>;
  promptBufferEditMode: "edit" | "preview";
  setPromptBufferEditMode: Dispatch<SetStateAction<"edit" | "preview">>;
  wipDrafts: WipDraft[];
  /** Returned for the e2e harness (injectWipDraft) — App threads this exact identity into useE2EHarness. */
  setWipDrafts: Dispatch<SetStateAction<WipDraft[]>>;
  contextInput: string;
  setContextInput: Dispatch<SetStateAction<string>>;
  /** Phase 3, Step 3.3 (additive, PRESERVES all WIP-draft behavior above unchanged): the open
   *  instruction-envelope exchange draft for the active pane, mirrored from the SAME GET response
   *  fetchActiveDraft already reads (its additive `exchange` field — server.ts, gated on
   *  instruction-envelope mode, derived from JANUS_EXCHANGE_SPINE post-2026-07-collapse). null
   *  when the mode is off, the pane has no open draft, or no
   *  pane is open. Refreshed only on fetchActiveDraft — this hook does not itself own a live WS
   *  subscription (see useComposer.ts's header comment); a caller wanting live pushes threads its
   *  own draft_updated handling the same way it already threads promptBuffer today. */
  exchangeDraft: ExchangeDraftView | null;
  fetchActiveDraft: (projId?: string, paneId?: string | null) => Promise<void>;
  fetchWipDrafts: (projId?: string) => Promise<void>;
  handlePromptBufferChange: (val: string) => void;
  handleSendDraft: () => Promise<void>;
  handleAddHumanContext: (text: string) => Promise<void>;
}

export function useComposer(params: ComposerParams): Composer {
  const { activeProjectId, activeTerminalId, wsRef, playEarcon, fetchLedger } = params;

  // --- Real-time Synchronous Markdown Prompt Buffer & Voice Agent Workspace States ---
  const [promptBuffer, setPromptBuffer] = useState("");
  const [isBufferFocused, setIsBufferFocused] = useState(false);
  const [promptBufferEditMode, setPromptBufferEditMode] = useState<"edit" | "preview">("preview");
  // Step 6 (the Workbench): the cross-pane WIP draft register, so work composed for one pane is
  // visible (and never lost) when the operator switches to another.
  const [wipDrafts, setWipDrafts] = useState<WipDraft[]>([]);
  const [contextInput, setContextInput] = useState("");
  // Phase 3, Step 3.3 (additive): see the Composer.exchangeDraft doc comment above.
  const [exchangeDraft, setExchangeDraft] = useState<ExchangeDraftView | null>(null);

  // Step 6 (the Workbench): the buffer is the ACTIVE pane's persistent WIP draft.
  const fetchActiveDraft = async (projId = activeProjectId, paneId = activeTerminalId) => {
    if (!paneId) { setPromptBuffer(""); setExchangeDraft(null); return; }
    try {
      const res = await apiFetch(`/api/panes/${projId}/${paneId}/draft`);
      if (res.ok) {
        const data = await res.json();
        setPromptBuffer(data.draft?.text ?? "");
        // Additive field (server.ts) — absent/undefined on any server that predates this step, and
        // always null while JANUS_EXCHANGE_SPINE is "off" (default). Either way: no behavior
        // change to promptBuffer above.
        setExchangeDraft((data.exchange as ExchangeDraftView | undefined) ?? null);
      }
    } catch (e) {
      console.warn("REST draft fetch failed");
    }
  };

  // The cross-pane WIP register (the scalable part of "B").
  const fetchWipDrafts = async (projId = activeProjectId) => {
    try {
      const res = await apiFetch(`/api/projects/${projId}/drafts`);
      if (res.ok) {
        const data = await res.json();
        setWipDrafts(data.drafts || []);
      }
    } catch (e) {}
  };

  const handlePromptBufferChange = (val: string) => {
    setPromptBuffer(val);
    if (!activeTerminalId) return;
    // Edit the active pane's draft (not a CLI write — ungated).
    if (shouldSendDraftOverWs(wsRef.current, WebSocket.OPEN)) {
      wsRef.current!.send(JSON.stringify({
        type: "draft_edit",
        projectId: activeProjectId,
        paneId: activeTerminalId,
        text: val
      }));
    } else {
      apiFetch(`/api/panes/${activeProjectId}/${activeTerminalId}/draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: val })
      }).catch(() => {});
    }
  };

  // Send the draft to the active pane. Operator-direct write (the operator is above the gate):
  // clicking Send IS the approval, so it writes immediately and clears the draft.
  const handleSendDraft = async () => {
    if (!activeTerminalId || !promptBuffer.trim()) return;
    try {
      const res = await apiFetch(`/api/panes/${activeProjectId}/${activeTerminalId}/draft/send`, { method: "POST" });
      if (res.ok) {
        setPromptBuffer("");
        playEarcon("execute");
      }
    } catch (e) {}
  };

  // Add an operator-typed context entry (the human layer) for the active pane.
  const handleAddHumanContext = async (text: string) => {
    if (!activeTerminalId || !text.trim()) return;
    try {
      await apiFetch(`/api/projects/${activeProjectId}/panes/${activeTerminalId}/context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, layer: "human" })
      });
      fetchLedger();
    } catch (e) {}
  };

  return {
    promptBuffer,
    setPromptBuffer,
    isBufferFocused,
    setIsBufferFocused,
    promptBufferEditMode,
    setPromptBufferEditMode,
    wipDrafts,
    setWipDrafts,
    contextInput,
    setContextInput,
    exchangeDraft,
    fetchActiveDraft,
    fetchWipDrafts,
    handlePromptBufferChange,
    handleSendDraft,
    handleAddHumanContext,
  };
}
