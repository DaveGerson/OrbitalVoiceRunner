/**
 * src/actions/defs/handoff.ts — REG1 Phase B faithful port of the HANDOFF dispatch group
 * (server.ts:3072-3334). One ActionDef per voice tool, each a NEAR-VERBATIM port of its legacy
 * `name === "..."` branch. The model is HANDLER-OWNED gating (model B): there is NO central gate in
 * runAction. Seven of these tools are UNGATED today (drafts/notes/reads/state flips) so their handlers
 * do NOT gate; deliver_handoff is GATED, but its gate is OWNED by ctx.dispatchProposal (capability
 * "deliver_handoff") — so the def is ALWAYS_ALLOWED at the runAction level to avoid DOUBLE-gating, and
 * the handler performs the real gate via dispatchProposal exactly as the legacy branch does.
 *
 * WIRE FIDELITY: every legacy branch answers `session.sendToolResponse({ functionResponses:[{ name,
 * id: call.id, response: <obj> }] })`. We reproduce `<obj>` byte-for-byte:
 *   - the common shape is `{ output: resp }` → ActionResult kind:"ok" with output = resp (a string OR
 *     a structured object — both legacy and registry nest it under { output }).
 *   - deliver_handoff's HiTL branch is the ONE exception: its response object is
 *     `{ status:"pending_approval", messageId, pane_id, prompt }` (NOT under `output`) → ActionResult
 *     kind:"pending" with messageId + extra:{ pane_id, prompt }, which voiceResponse spreads back into
 *     `{ status:"pending_approval", messageId, pane_id, prompt }`.
 *
 * HISTORY SEAM: handoff_context_between_panes + propose_handoff (archived from_pane fallback) read
 * pane command history via the server-local HistoryManager singleton (server.ts:100), which is NOT
 * exported from any importable module (importing server.ts would boot a listener + create a cycle).
 * `loadPaneHistory` below replicates HistoryManager.loadHistory EXACTLY (same file `.janus_history.json`
 * in process.cwd(), same parse guard, same `historyMaxCommands ?? 50` slice sourced from manager
 * settings) so the ported handlers stay byte-identical without reaching into server state.
 */

import fs from "fs";
import path from "path";
import { z } from "zod";
import type { ActionDef, ActionContext, ActionResult } from "../types";
import { ALWAYS_ALLOWED } from "../types";
import type { ApprovalKind } from "../../pendingApprovals";
import type { CapabilityGate } from "../../types";
import { redactSecrets, classifySecrets } from "../../terminal";
import { isStagedStale } from "../../pendingApprovals";
import { deliverOutcomeToHandoff, type DeliverDispatchKind } from "../../handoffFlow";
import { findPaneOwningProject } from "../../paneOwnership";
import type { HandoffState } from "../../store/types";

/** Mirror of server.ts HistoryEntry (server.ts:93-98) — the per-command history row. */
interface HistoryEntry {
  command: string;
  timestamp: string;
  output: string;
  finalResponse?: string;
}

/**
 * Faithful re-derivation of HistoryManager.getInstance().loadHistory(paneId) (server.ts:122-140).
 * Reads `.janus_history.json` from process.cwd(), guards a corrupt/missing file, and slices to the
 * last `historyMaxCommands` (default 50, sourced from manager.settings to match getLimits()). Kept
 * here because HistoryManager is server.ts-local and not importable.
 */
function loadPaneHistory(manager: ActionContext["manager"], paneId: string): HistoryEntry[] {
  const filePath = path.join(process.cwd(), ".janus_history.json");
  const maxCmds = manager.settings?.advanced?.historyMaxCommands ?? 50;
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const list = parsed[paneId];
        if (Array.isArray(list)) {
          return list.slice(-maxCmds);
        }
      }
    }
  } catch (e) {
    // Return empty if file not found or corrupted (matches HistoryManager.loadHistory).
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// handoff_context_between_panes (server.ts:3072) — UNGATED.
// Writes orientation CONTEXT to the target pane's model-context layer (addModelContext) — NOT a CLI
// write, deliberately ungated (architecture §5 removed handoff stdin injection). Only handoff tool
// with a REST route (POST /api/handoff); REST adapter maps camelCase body -> these snake_case args.
// ─────────────────────────────────────────────────────────────────────────────

const HandoffContextParams = z.object({
  source_pane_id: z.string(),
  target_pane_id: z.string(),
  context_notes: z.string(),
});

export const handoffContextBetweenPanes: ActionDef<typeof HandoffContextParams> = {
  name: "handoff_context_between_panes",
  description:
    "Gather context from a source CLI pane and package summaries/learnings to prime a model agent in another target pane.",
  params: HandoffContextParams,
  capability: "compose_draft",
  readOnly: false,
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "post", path: "/api/handoff" },
  // c55 Batch D: the UI POSTs a camelCase body { sourcePaneId, targetPaneId, contextNotes }; the
  // voice schema keys are snake_case. Alias camel->snake (only when the snake key is absent, so a
  // voice call carrying snake_case is never clobbered) so the inline route's body shape keeps working.
  coerceArgs: (raw) => {
    const out = { ...raw };
    if (out.source_pane_id == null && out.sourcePaneId != null) out.source_pane_id = out.sourcePaneId;
    if (out.target_pane_id == null && out.targetPaneId != null) out.target_pane_id = out.targetPaneId;
    if (out.context_notes == null && out.contextNotes != null) out.context_notes = out.contextNotes;
    delete out.sourcePaneId;
    delete out.targetPaneId;
    delete out.contextNotes;
    return out;
  },
  handler: (args, ctx): ActionResult => {
    // PHASE 2 (veto-toggle honesty): compose_draft is a veto-class capability — block on an EXPLICIT
    // Off veto (default Auto → behavior-preserving). ACTION (not a read), so STOP-ALL blocks it (no
    // !isFrozen bypass — effectiveCapabilityGateFor resolves Off while frozen).
    if (ctx.effectiveCapabilityGateFor(null, "compose_draft") === "Off") {
      return { kind: "ok", output: "Error: the 'compose_draft' capability is gated Off; composing drafts is forbidden by policy." };
    }
    const { source_pane_id, target_pane_id, context_notes } = args;
    const sourceTerm = ctx.manager.terminals[source_pane_id];
    const targetTerm = ctx.manager.terminals[target_pane_id];

    let resp = "";
    if (!sourceTerm || !targetTerm) {
      resp = `Error: Both source and target terminal panes must be active. (Source: ${sourceTerm ? "OK" : "Not found"}, Target: ${targetTerm ? "OK" : "Not found"})`;
    } else {
      const sourceHistory = loadPaneHistory(ctx.manager, source_pane_id);
      const lastFiveOutlines = sourceHistory
        .map((h) => `${h.command} -> ${h.finalResponse || "executed"}`)
        .slice(-5)
        .join(" | ");

      const activeProjectId = ctx.manager.ledger.activeProjectId || "default_project";
      const handoffNote = `Handoff from [${source_pane_id}] with notes: ${context_notes}. Last events: ${lastFiveOutlines}`;

      ctx.manager.ledger.addModelContext(activeProjectId, target_pane_id, handoffNote, "handoff");

      ctx.broadcastLedgerUpdate();
      resp = `Handoff context from [${source_pane_id}] recorded into [${target_pane_id}]'s orientation context. No command was written to the pane.`;
    }
    return { kind: "ok", output: resp };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// propose_handoff (server.ts:3099) — UNGATED (drafting never touches a pane).
// Inserts a 'composing' row; snapshots + redacts source_context. Structured object under { output }.
// ─────────────────────────────────────────────────────────────────────────────

const ProposeHandoffParams = z.object({
  to_pane: z.string(),
  draft_text: z.string(),
  from_pane: z.string().optional(),
  rationale: z.string().optional(),
});

/**
 * Snapshot the SOURCE pane context (redacted) for propose_handoff: prefer the live pane summary, fall
 * back to recent command history, else "" (no from_pane). Extracted from the handler to keep the
 * handler under CC 10 — same redaction, same fallback ordering (behavior-preserving).
 */
function captureSourceSummary(ctx: ActionContext, from_pane: string | undefined): string {
  if (!from_pane) return "";
  if (ctx.manager.terminals[from_pane]) {
    return redactSecrets(ctx.manager.getPaneSummary(from_pane, 12));
  }
  const hist = loadPaneHistory(ctx.manager, from_pane);
  return redactSecrets(
    hist.map((h) => `${h.command} -> ${h.finalResponse || "executed"}`).slice(-8).join("\n")
  );
}

/** Build the (redacted) source-context snapshot JSON-serialized for a propose_handoff draft row. */
function buildSourceContext(
  ctx: ActionContext,
  from_pane: string | undefined,
  rationale: string | undefined,
): string {
  return JSON.stringify({
    from_pane: from_pane ?? null,
    rationale: rationale ? redactSecrets(String(rationale)) : null,
    summary: captureSourceSummary(ctx, from_pane) || "[no source context captured]",
    captured_at: new Date().toISOString(),
  });
}

export const proposeHandoff: ActionDef<typeof ProposeHandoffParams> = {
  name: "propose_handoff",
  description:
    "Draft a first-class handoff to a target pane (UNGATED — never touches the pane). Snapshots the source pane's context (redacted) and stores a 'composing' draft for the operator to revise by voice. Use this to begin co-authoring a prompt to delegate to a CLI agent pane.",
  params: ProposeHandoffParams,
  capability: "compose_draft",
  readOnly: false,
  // cv2 (D5): voice+rest. The REST twin is the "Compose" handoff-drawer button. Pure ledger op
  // (createHandoff snapshot) — safe on session:null (no pane write, no session use). Registry-canonical
  // path: POST /api/handoffs (the create verb on the /api/handoffs collection list_handoffs reads).
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "post", path: "/api/handoffs" },
  // The drawer POSTs a camelCase body { toPane, draftText, fromPane?, rationale? }; the voice schema
  // keys are snake_case. Alias camel->snake ONLY when the snake key is absent (a voice call carrying
  // snake_case is never clobbered) — same pattern as handoff_context_between_panes above.
  coerceArgs: (raw) => {
    const out = { ...raw };
    if (out.to_pane == null && out.toPane != null) out.to_pane = out.toPane;
    if (out.draft_text == null && out.draftText != null) out.draft_text = out.draftText;
    if (out.from_pane == null && out.fromPane != null) out.from_pane = out.fromPane;
    delete out.toPane;
    delete out.draftText;
    delete out.fromPane;
    return out;
  },
  handler: (args, ctx): ActionResult => {
    // PHASE 2 (veto-toggle honesty): compose_draft is veto-class — block on an EXPLICIT Off veto
    // (default Auto → behavior-preserving). ACTION, so STOP-ALL blocks it (no !isFrozen bypass).
    if (ctx.effectiveCapabilityGateFor(null, "compose_draft") === "Off") {
      return { kind: "ok", output: "Error: the 'compose_draft' capability is gated Off; composing drafts is forbidden by policy." };
    }
    const { to_pane, draft_text, from_pane, rationale } = args;
    const store = ctx.store;
    if (!store) {
      return { kind: "ok", output: "Error: the persistent store is unavailable; handoffs cannot be created right now." };
    }
    if (!to_pane) {
      return { kind: "ok", output: "Error: a target pane (to_pane) is required for a handoff." };
    }
    const activeProjectId = ctx.manager.ledger.activeProjectId || "default_project";
    const targetTerm = ctx.manager.terminals[to_pane];
    const kind: ApprovalKind = targetTerm?.runtimeType === "shell" ? "shell" : "agent_instruction";
    const h = store.createHandoff({
      workspace_id: activeProjectId,
      from_pane: from_pane ?? null,
      to_pane,
      kind,
      composed_prompt: draft_text ?? "",
      source_context: buildSourceContext(ctx, from_pane, rationale),
      state: "composing",
    });
    ctx.broadcast({ type: "handoffs_updated" });
    return {
      kind: "ok",
      output: {
        handoff_id: h.id,
        state: h.state,
        to_pane: h.to_pane,
        composed_prompt: redactSecrets(h.composed_prompt),
        message: `Drafted handoff ${h.id} to pane ${to_pane} (state: composing). Read the draft back to the operator; revise by voice, then stage and deliver.`,
      },
    };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// revise_handoff (server.ts:3149) — UNGATED co-authoring; revision_count++.
// ─────────────────────────────────────────────────────────────────────────────

const ReviseHandoffParams = z.object({
  handoff_id: z.string(),
  new_draft_text: z.string().optional(),
});

export const reviseHandoff: ActionDef<typeof ReviseHandoffParams> = {
  name: "revise_handoff",
  description:
    "Rewrite a handoff's composed prompt (UNGATED co-authoring; increments revision_count). Read the revised draft back to the operator.",
  params: ReviseHandoffParams,
  capability: "compose_draft",
  readOnly: false,
  // cv2 (D5): voice+rest. The REST twin is the "Revise" handoff-drawer button. Pure ledger op
  // (updateHandoffCargo) — safe on session:null. Registry-canonical path: POST /api/handoffs/:handoff_id/revise
  // — the POST /api/<resource>/:id/<verb> family the sibling state-transition twins use (stage/reject),
  // so revise reads as a verb on the single-handoff resource, NOT a REST PUT-replace of the row.
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "post", path: "/api/handoffs/:handoff_id/revise" },
  // The drawer PUTs a camelCase body { newDraftText }; the voice key is snake_case. Alias camel->snake
  // only when the snake key is absent (a voice call carrying snake_case is never clobbered).
  coerceArgs: (raw) => {
    const out = { ...raw };
    if (out.new_draft_text == null && out.newDraftText != null) out.new_draft_text = out.newDraftText;
    delete out.newDraftText;
    return out;
  },
  handler: (args, ctx): ActionResult => {
    // PHASE 2 (veto-toggle honesty): compose_draft is veto-class — block on an EXPLICIT Off veto
    // (default Auto → behavior-preserving). ACTION, so STOP-ALL blocks it (no !isFrozen bypass).
    if (ctx.effectiveCapabilityGateFor(null, "compose_draft") === "Off") {
      return { kind: "ok", output: "Error: the 'compose_draft' capability is gated Off; composing drafts is forbidden by policy." };
    }
    const { handoff_id, new_draft_text } = args;
    const store = ctx.store;
    let resp: unknown;
    if (!store) {
      resp = "Error: the persistent store is unavailable.";
    } else {
      const updated = store.updateHandoffCargo(handoff_id, new_draft_text ?? "");
      if (!updated) {
        resp = `Error: handoff ${handoff_id} not found.`;
      } else {
        ctx.broadcast({ type: "handoffs_updated" });
        resp = {
          handoff_id: updated.id,
          state: updated.state,
          revision_count: updated.revision_count,
          composed_prompt: redactSecrets(updated.composed_prompt),
          message: `Revised handoff ${handoff_id} (revision ${updated.revision_count}). Read it back; stage when the operator is satisfied.`,
        };
      }
    }
    return { kind: "ok", output: resp };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// stage_handoff (server.ts:3173) — UNGATED. Freeze text, live-pane pre-check, secret guard, ->staged.
// High-confidence secret HARD-BLOCKS (records a refusal); low-confidence stages with a WARNING.
// ─────────────────────────────────────────────────────────────────────────────

const StageHandoffParams = z.object({
  handoff_id: z.string(),
});

export const stageHandoff: ActionDef<typeof StageHandoffParams> = {
  name: "stage_handoff",
  description:
    "Freeze a handoff draft and mark it 'staged' (UNGATED; validates the target pane is live). After staging, ask the operator to approve delivery.",
  params: StageHandoffParams,
  capability: "compose_draft",
  readOnly: false,
  // cv2 (D5): voice+rest. The REST twin is the "Stage" handoff-drawer button. Pure ledger op
  // (secret-guard + updateHandoffState -> staged) — safe on session:null. Registry-canonical path:
  // POST /api/handoffs/:handoff_id/stage (a state-transition verb under the single-handoff resource).
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "post", path: "/api/handoffs/:handoff_id/stage" },
  handler: (args, ctx): ActionResult => {
    // PHASE 2 (veto-toggle honesty): compose_draft is veto-class — block on an EXPLICIT Off veto
    // (default Auto → behavior-preserving). ACTION, so STOP-ALL blocks it (no !isFrozen bypass).
    if (ctx.effectiveCapabilityGateFor(null, "compose_draft") === "Off") {
      return { kind: "ok", output: "Error: the 'compose_draft' capability is gated Off; composing drafts is forbidden by policy." };
    }
    const { handoff_id } = args;
    const store = ctx.store;
    if (!store) {
      return { kind: "ok", output: "Error: the persistent store is unavailable." };
    }
    const h = store.getHandoff(handoff_id);
    if (!h) {
      return { kind: "ok", output: `Error: handoff ${handoff_id} not found.` };
    }
    const targetTerm = ctx.manager.terminals[h.to_pane];
    // bd #70: ungated existence guard (compose_draft is UNGATED) — resolve via the canonical
    // owning-project lookup so a target pane in a NON-active project isn't wrongly reported as
    // missing. Usability guard, NOT a gate-decision path (the divergence is intentional).
    const targetExists = !!targetTerm || !!findPaneOwningProject(ctx.manager, h.to_pane);
    if (!targetExists) {
      return { kind: "ok", output: `Cannot stage: target pane ${h.to_pane} no longer exists.` };
    }
    // Secret guard. High-confidence leak -> BLOCK; low-confidence -> stage WITH a warning.
    const scan = classifySecrets(h.composed_prompt);
    if (scan.confidence === "high") {
      recordStageRefusal(ctx, store, handoff_id, h.to_pane, scan.labels);
      return {
        kind: "ok",
        output: `Blocked: the composed prompt for handoff ${handoff_id} appears to contain a secret (${scan.labels.join(", ")}). Prompts must never carry secrets — revise it to remove the credential, then stage again.`,
      };
    }
    const staged = store.updateHandoffState(handoff_id, "staged");
    ctx.broadcast({ type: "handoffs_updated" });
    const warn =
      scan.confidence === "low"
        ? ` WARNING: the prompt contains a possible credential assignment (${scan.labels.join(", ")}) — confirm it carries no real secret before approving delivery.`
        : "";
    return {
      kind: "ok",
      output: {
        handoff_id,
        state: staged?.state,
        message: `Handoff ${handoff_id} is staged for pane ${h.to_pane}. Ask the operator to approve delivery (deliver_handoff).${warn}`,
      },
    };
  },
};

/**
 * Record the audit row for a BLOCKED stage (high-confidence secret). Extracted from stage_handoff so
 * the handler stays under CC 10. `store` is non-null at the call site (the handler guards it), but the
 * legacy branch re-checked `if (store)` before recording — preserved here as a defensive guard so the
 * write semantics stay byte-identical (behavior-preserving).
 */
function recordStageRefusal(
  ctx: ActionContext,
  store: NonNullable<ActionContext["store"]>,
  handoff_id: string,
  to_pane: string,
  labels: string[],
): void {
  if (!store) return;
  const activeProjectId = ctx.manager.ledger.activeProjectId || "default_project";
  store.recordActivity({
    type: "permission_changed",
    project_id: activeProjectId,
    pane_id: to_pane,
    summary: `BLOCKED staging handoff ${handoff_id}: secret detected (${labels.join(", ")})`,
    payload: { handoff_id, refused: true, secret_labels: labels },
    handoff_id,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// read_handoff (server.ts:3217) — UNGATED read; redacted output. readOnly:true.
// ─────────────────────────────────────────────────────────────────────────────

const ReadHandoffParams = z.object({
  handoff_id: z.string(),
});

export const readHandoff: ActionDef<typeof ReadHandoffParams> = {
  name: "read_handoff",
  description: "Read a single handoff (UNGATED, redacted output).",
  params: ReadHandoffParams,
  capability: "read_notes",
  readOnly: true,
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "get", path: "/api/handoffs/:handoff_id" },
  handler: (args, ctx): ActionResult => {
    // igc read-gating lever: handoffs carry note-class CONTENT, so gate them under "read_notes"
    // (null pane scope — handoffs are project/workspace-scoped, matching the notes reads).
    // Block only on an EXPLICIT operator Off, NOT the STOP-ALL frozen short-circuit (reads stay available during a freeze — behavior-preserving).
    if (!ctx.isFrozen() && ctx.effectiveCapabilityGateFor(null, "read_notes") === "Off") {
      return { kind: "ok", output: "Error: the 'read_notes' capability is gated Off; reading handoff content is forbidden by policy." };
    }
    const { handoff_id } = args;
    const store = ctx.store;
    let resp: unknown;
    if (!store) {
      resp = "Error: the persistent store is unavailable.";
    } else {
      const h = store.getHandoff(handoff_id);
      resp = h
        ? {
            handoff_id: h.id,
            state: h.state,
            from_pane: h.from_pane,
            to_pane: h.to_pane,
            kind: h.kind,
            revision_count: h.revision_count,
            composed_prompt: redactSecrets(h.composed_prompt),
            source_context: h.source_context, // already redacted at compose time
          }
        : `Error: handoff ${handoff_id} not found.`;
    }
    return { kind: "ok", output: resp };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// list_handoffs (server.ts:3235) — UNGATED read; redacted output. readOnly:true.
// redact-before-slice(200) ordering is load-bearing; staged rows surface a stale flag.
// ─────────────────────────────────────────────────────────────────────────────

const ListHandoffsParams = z.object({
  state: z.string().optional(),
});

export const listHandoffs: ActionDef<typeof ListHandoffsParams> = {
  name: "list_handoffs",
  description:
    "List handoffs in the active workspace, optionally filtered by state (UNGATED, redacted output).",
  params: ListHandoffsParams,
  capability: "read_notes",
  readOnly: true,
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "get", path: "/api/handoffs" },
  handler: (args, ctx): ActionResult => {
    // igc read-gating lever: handoffs carry note-class CONTENT, so gate them under "read_notes"
    // (null pane scope — handoffs are project/workspace-scoped, matching the notes reads).
    // Block only on an EXPLICIT operator Off, NOT the STOP-ALL frozen short-circuit (reads stay available during a freeze — behavior-preserving).
    if (!ctx.isFrozen() && ctx.effectiveCapabilityGateFor(null, "read_notes") === "Off") {
      return { kind: "ok", output: "Error: the 'read_notes' capability is gated Off; reading handoff content is forbidden by policy." };
    }
    const { state } = args;
    const store = ctx.store;
    let resp: unknown;
    if (!store) {
      resp = "Error: the persistent store is unavailable.";
    } else {
      const activeProjectId = ctx.manager.ledger.activeProjectId || "default_project";
      // Faithful: legacy passed args.state (any) straight through — an unknown state simply matches
      // nothing. Cast the optional free-form string to the store's union to satisfy the typed signature.
      const rows = store.listHandoffs({ workspaceId: activeProjectId, state: (state || undefined) as HandoffState | undefined });
      const now = Date.now();
      resp = rows.map((h) => {
        const stale = h.state === "staged" && isStagedStale(h.staged_at, now);
        return {
          handoff_id: h.id,
          state: h.state,
          to_pane: h.to_pane,
          from_pane: h.from_pane,
          revision_count: h.revision_count,
          composed_prompt: redactSecrets(h.composed_prompt).slice(0, 200),
          // Staged drafts never auto-expire; surface a stale flag so the operator notices.
          ...(h.state === "staged"
            ? { stale, staged_age_seconds: h.staged_at ? Math.floor((now - h.staged_at) / 1000) : null }
            : {}),
        };
      });
    }
    return { kind: "ok", output: resp };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// reject_handoff (server.ts:3258) — UNGATED pre-gate flip. If a delivery is PENDING at the gate,
// DELEGATE to applyResolution(id,"reject") (the single claim gate flips the row + broadcasts);
// otherwise flip the row directly. Two distinct message strings, both state:"rejected".
// ─────────────────────────────────────────────────────────────────────────────

const RejectHandoffParams = z.object({
  handoff_id: z.string(),
});

export const rejectHandoff: ActionDef<typeof RejectHandoffParams> = {
  name: "reject_handoff",
  description:
    "Reject/cancel a handoff (UNGATED pre-gate flip; if a delivery is pending at the gate, routes through the gate's reject path).",
  params: RejectHandoffParams,
  capability: "compose_draft",
  readOnly: false,
  // cv2 (D5): voice+rest. The REST twin is the "Reject" handoff-drawer button. Pure ledger op (flip the
  // row to 'rejected', OR — when a delivery is pending at the gate — route through the SAME applyResolution
  // claim gate). Safe on session:null (applyResolution reads the pendingApprovals store, not the session).
  // Registry-canonical path: POST /api/handoffs/:handoff_id/reject (a state-transition verb, sibling of /stage).
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "post", path: "/api/handoffs/:handoff_id/reject" },
  handler: (args, ctx): ActionResult => {
    // PHASE 2 (veto-toggle honesty): compose_draft is veto-class — block on an EXPLICIT Off veto
    // (default Auto → behavior-preserving). ACTION, so STOP-ALL blocks it (no !isFrozen bypass).
    if (ctx.effectiveCapabilityGateFor(null, "compose_draft") === "Off") {
      return { kind: "ok", output: "Error: the 'compose_draft' capability is gated Off; composing drafts is forbidden by policy." };
    }
    const { handoff_id } = args;
    const store = ctx.store;
    let resp: unknown;
    if (!store) {
      resp = "Error: the persistent store is unavailable.";
    } else {
      const h = store.getHandoff(handoff_id);
      if (!h) {
        resp = `Error: handoff ${handoff_id} not found.`;
      } else if (h.gate_approval_id && ctx.pendingApprovals.has(h.gate_approval_id)) {
        // A delivery is pending at the gate — route through the SAME claim gate.
        ctx.applyResolution(h.gate_approval_id, "reject");
        resp = {
          handoff_id,
          state: "rejected",
          message: `Cancelled the pending delivery of handoff ${handoff_id}.`,
        };
      } else {
        store.updateHandoffState(handoff_id, "rejected");
        ctx.broadcast({ type: "handoffs_updated" });
        resp = { handoff_id, state: "rejected", message: `Handoff ${handoff_id} rejected.` };
      }
    }
    return { kind: "ok", output: resp };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// deliver_handoff (server.ts:3281) — the ONLY handoff handler that WRITES. The gate is OWNED by
// ctx.dispatchProposal (capability "deliver_handoff", AND-composed with effectiveMode + active-pane
// veto), so the def is ALWAYS_ALLOWED at the runAction level to avoid DOUBLE-gating; the handler
// performs the real gate via dispatchProposal exactly as the legacy branch does. deliverOutcomeToHandoff
// (pure import) maps dispatch outcome.kind -> persisted-row effect. Five wire shapes:
//   store null / not found / not-staged / deliver-time secret block -> { output: <string> } (kind:"ok")
//   deliver_now (Full Auto) -> { output: "Delivered handoff <id> to pane <p>." } (row -> delivered)
//   await_approval (HiTL)   -> { status:"pending_approval", messageId, pane_id, prompt } (kind:"pending")
//   block (Read-Only/Off)   -> kind:"blocked" reason:outcome.text (row -> blocked_read_only); VOICE wire
//                              is byte-identical { output: outcome.text }; REST status-via-kinds -> 403.
//   noop (error|clarify)    -> { output: outcome.text } (no row change)
// ─────────────────────────────────────────────────────────────────────────────

const DeliverHandoffParams = z.object({
  handoff_id: z.string(),
});

export const deliverHandoff: ActionDef<typeof DeliverHandoffParams> = {
  name: "deliver_handoff",
  description:
    "Deliver a STAGED handoff into the target pane's live session (GATED by the deliver_handoff capability + the pane's effective mode). Full Auto writes immediately; Human-in-the-Loop creates a pending approval to read back; Read-Only/Off blocks.",
  params: DeliverHandoffParams,
  capability: ALWAYS_ALLOWED, // gate is delegated to dispatchProposal — do NOT double-gate in runAction.
  readOnly: false,
  // cv2 (D5): voice+rest. The REST twin is the "Deliver" handoff-drawer button. UNLIKE the four pure-
  // ledger composers, deliver WRITES to a live pane — but it routes through ctx.dispatchProposal, which on
  // REST is restDispatchProposal (server.ts ~1637), the SAME gated seam execute_plan rides over
  // POST /api/plans/:id/execute. So the REST path enforces capabilityGates.deliver_handoff at PARITY with
  // voice (Auto->write / Ask->HiTL pending / Off->block). Status-via-kinds maps the DispatchOutcome to HTTP:
  // the handler returns kind:"pending" (HiTL -> 202), kind:"blocked" (gate Off/read-only -> 403), or
  // kind:"ok" (delivered/secret-block/not-staged narration -> 200). No rest.toHttp needed — the default
  // resultToHttp kind->status map IS the contract. Registry-canonical path: POST .../:handoff_id/deliver
  // (the POST /api/<resource>/:id/<verb> family, sibling of /stage and /reject).
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "post", path: "/api/handoffs/:handoff_id/deliver" },
  handler: (args, ctx): ActionResult => {
    const { handoff_id } = args;
    const store = ctx.store;
    if (!store) {
      return { kind: "ok", output: "Error: the persistent store is unavailable." };
    }
    const h = store.getHandoff(handoff_id);
    if (!h) {
      return { kind: "ok", output: `Error: handoff ${handoff_id} not found.` };
    }
    if (h.state !== "staged") {
      return {
        kind: "ok",
        output: `Handoff ${handoff_id} is '${h.state}', not 'staged'. Stage it before delivery.`,
      };
    }
    // Deliver-time backstop: a prompt revised to a secret after staging is still hard-blocked.
    const secretBlock = deliverTimeSecretBlock(ctx, store, handoff_id, h.to_pane, h.composed_prompt);
    if (secretBlock) return secretBlock;
    const outcome = ctx.dispatchProposal({
      sess: ctx.session,
      callId: ctx.callId ?? "",
      pendingId: handoff_id,
      targetId: h.to_pane,
      instruction: h.composed_prompt,
      explicitKind: h.kind,
      trigger: "handoff delivery",
      capability: "deliver_handoff" as CapabilityGate,
    });
    return applyDeliverOutcome(ctx, store, handoff_id, h.to_pane, outcome.text, outcome.kind);
  },
};

/**
 * Map the dispatch outcome -> persisted-row effect + the ActionResult wire shape, for deliver_handoff.
 * Extracted from the handler (CC reduction); the row writes / broadcasts / four wire shapes are
 * byte-identical to the inlined branches (deliver_now / await_approval / block / noop). `deliverOutcomeToHandoff`
 * is the SAME pure mapping the legacy branch used.
 */
function applyDeliverOutcome(
  ctx: ActionContext,
  store: NonNullable<ActionContext["store"]>,
  handoff_id: string,
  to_pane: string,
  outcomeText: string,
  outcomeKind: string,
): ActionResult {
  // Pure mapping (src/handoffFlow): dispatch outcome -> persisted-row effect.
  const effect = deliverOutcomeToHandoff(outcomeKind as DeliverDispatchKind);
  if (effect.kind === "deliver_now") {
    // Full Auto: the write already landed inside dispatchProposal; flip the row to delivered now.
    store.updateHandoffState(handoff_id, effect.state, { approved_via: effect.approvedVia });
    ctx.broadcast({ type: "handoffs_updated" });
    return { kind: "ok", output: `Delivered handoff ${handoff_id} to pane ${to_pane}.` };
  }
  if (effect.kind === "await_approval") {
    // HiTL: persist the gate_approval_id; applyResolution flips to delivered on approve.
    store.setGateApprovalId(handoff_id, handoff_id);
    ctx.broadcast({ type: "handoffs_updated" });
    // Wire: { status:"pending_approval", messageId: handoff_id, pane_id: to_pane, prompt: outcomeText }.
    return {
      kind: "pending",
      messageId: handoff_id,
      summary: outcomeText,
      extra: { pane_id: to_pane, prompt: outcomeText },
    };
  }
  if (effect.kind === "block") {
    store.updateHandoffState(handoff_id, effect.state);
    ctx.broadcast({ type: "handoffs_updated" });
    // status-via-kinds: a gate Off / read-only block returns kind:"blocked" so the REST twin maps to
    // 403 (resultToHttp). VOICE WIRE IS BYTE-IDENTICAL: voiceResponse maps kind:"blocked" to
    // { output: result.reason } — the SAME { output: <outcomeText> } shape the legacy kind:"ok" emitted.
    return { kind: "blocked", reason: outcomeText };
  }
  // effect.kind === "noop" (error | clarify): no row change.
  return { kind: "ok", output: outcomeText };
}

/**
 * Deliver-time secret backstop for deliver_handoff: if the composed prompt is a HIGH-confidence
 * secret, record the refusal and return the blocked ActionResult; otherwise return null (delivery
 * proceeds). Extracted to keep the handler under CC 10 — same scan, same audit row, same string. The
 * legacy branch re-checked `if (store)` before recording; preserved here (store is non-null at the
 * call site but the guard keeps the write semantics byte-identical).
 */
function deliverTimeSecretBlock(
  ctx: ActionContext,
  store: NonNullable<ActionContext["store"]>,
  handoff_id: string,
  to_pane: string,
  composed_prompt: string,
): ActionResult | null {
  const scan = classifySecrets(composed_prompt);
  if (scan.confidence !== "high") return null;
  if (store) {
    const activeProjectId = ctx.manager.ledger.activeProjectId || "default_project";
    store.recordActivity({
      type: "permission_changed",
      project_id: activeProjectId,
      pane_id: to_pane,
      summary: `BLOCKED delivery of handoff ${handoff_id}: secret detected (${scan.labels.join(", ")})`,
      payload: { handoff_id, refused: true, secret_labels: scan.labels },
      handoff_id,
    });
  }
  return {
    kind: "ok",
    output: `Blocked: handoff ${handoff_id}'s prompt appears to contain a secret (${scan.labels.join(", ")}). Revise it to remove the credential before delivery.`,
  };
}

/** All HANDOFF group ActionDefs, in dispatch-anchor order (server.ts:3072-3281). */
export const HANDOFF_ACTIONS: ActionDef[] = [
  handoffContextBetweenPanes,
  proposeHandoff,
  reviseHandoff,
  stageHandoff,
  readHandoff,
  listHandoffs,
  rejectHandoff,
  deliverHandoff,
];
