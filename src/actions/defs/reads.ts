/**
 * src/actions/defs/reads.ts — REG1 group READS.
 *
 * Seven READ-ONLY voice tools, FAITHFUL PORTS of their legacy server.ts dispatch branches:
 *   - get_pane_command_history (server.ts:2542)
 *   - get_pane_summary         (server.ts:2565)
 *   - get_pane_delta           (server.ts:2571)
 *   - list_pending_approvals   (server.ts:2651)
 *   - get_attention_digest     (server.ts:2762)
 *   - get_pane_gates           (server.ts:3382)
 *   - list_capabilities        (server.ts:3396)
 *
 * NONE of these branches gate — none call gateOrDefer / dispatchProposal / gateCapability — so NONE
 * of these handlers gate either (handler-owned gate model; faithful = ungated). readOnly:true for
 * all, so runAction re-redacts every string leaf on egress (the inline redactions below are therefore
 * idempotent double-redacts — preserved exactly as the legacy branches do them).
 *
 * Grounding notes:
 *   - HistoryManager (server.ts:100) is a server.ts-defined process-global singleton; importing it
 *     would import server.ts and BOOT a real listener (JANUS_NO_AUTOSTART guards the entrypoint).
 *     So get_pane_command_history re-implements HistoryManager.loadHistory inline against the SAME
 *     `.janus_history.json` at process.cwd() with the SAME maxCmds (manager.settings.advanced
 *     .historyMaxCommands ?? 50) — byte-identical read behavior, no server cycle.
 *   - stripAnsiSequences / redactSecrets are module-level exports of ../terminal (the fallback path
 *     here calls redactSecrets directly; ctx.redact === redactSecrets, used for the inline digest
 *     redactions so there is one redaction source).
 *   - serializePending is a pure export of ../pendingApprovals.
 *   - The pendingApprovals store, pruneAttention, and effectiveCapabilityGateFor are INJECTED via
 *     ActionContext (they close over per-connection / server-lifetime state).
 */

import fs from "fs";
import path from "path";
import { z } from "zod";
import type { ActionDef, ActionResult } from "../types";
import type { GateValue } from "../../types";
import { ALWAYS_ALLOWED } from "../types";
import { ALL_CAPABILITIES } from "../../gateSurface";
import { stripAnsiSequences, redactSecrets } from "../../terminal";
import { serializePending } from "../../pendingApprovals";

/** Empty-params schema (pins declarations -> properties {}), shared by the no-arg reads. */
const NoParams = z.object({});

/** A single pane_id arg (required for the per-pane summary/delta/history reads). */
const PaneIdParams = z.object({
  pane_id: z.string(),
});

/** get_pane_gates accepts an OPTIONAL pane_id (omitted/empty => resolve GLOBAL gates). */
const OptionalPaneIdParams = z.object({
  pane_id: z.string().optional(),
});

/** The shape one .janus_history.json entry carries (mirrors server.ts:93 HistoryEntry). */
interface HistoryEntry {
  command: string;
  timestamp: string;
  output: string;
  finalResponse?: string;
}

// get_pane_gates + list_capabilities report the WHOLE gate matrix (gateSurface.ALL_CAPABILITIES — the
// single source widened to 22 by the matrix-convergence work). Reporting the full matrix (incl the
// promoted read/focus/draft/archive/clear caps) is what lets the model + UI discover the read-gating
// lever (Decision 9). The two get_pane_gates / list_capabilities goldens are regenerated accordingly.

// ─────────────────────────────────────────────────────────────────────────────
// get_pane_command_history (server.ts:2542)
// ─────────────────────────────────────────────────────────────────────────────
export const getPaneCommandHistory: ActionDef<typeof PaneIdParams> = {
  name: "get_pane_command_history",
  description:
    "Return the list of recently executed commands in this pane with their concise, high-level final responses/outcomes, rather than raw/messy terminal outputs. Highly token-light and preserves context.",
  params: PaneIdParams,
  capability: "read_pane",
  readOnly: true,
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "get", path: "/api/panes/:pane_id/history" },
  handler: (args, ctx): ActionResult => {
    // igc read-gating lever: block ONLY on the explicit Off veto for "read_pane" (an unseeded
    // capability resolves to Auto, so this is behavior-preserving until the operator sets Off).
    // ctx.effectiveCapabilityGateFor is the PURE resolver (no audit side effect on the allowed path).
    // Block only on an EXPLICIT operator Off, NOT the STOP-ALL frozen short-circuit (reads stay available during a freeze — behavior-preserving).
    if (!ctx.isFrozen() && ctx.effectiveCapabilityGateFor(args.pane_id, "read_pane") === "Off") {
      return { kind: "ok", output: "Error: the 'read_pane' capability is gated Off; reading pane content is forbidden by policy." };
    }
    const targetId = args.pane_id;
    // FAITHFUL PORT of HistoryManager.getInstance().loadHistory(targetId): read the SAME
    // .janus_history.json at process.cwd(), parse, return parsed[terminalId] sliced to the last
    // maxCmds. Returns [] on missing/corrupt file or missing key (so an unknown pane yields [],
    // NOT an error — contrast get_pane_summary / get_pane_delta). HistoryManager lives in server.ts
    // and cannot be imported without booting the listener; this reproduces its loadHistory exactly.
    const maxCmds = ctx.manager.settings?.advanced?.historyMaxCommands ?? 50;
    let history: HistoryEntry[] = [];
    try {
      const filePath = path.join(process.cwd(), ".janus_history.json");
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(data);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const list = parsed[targetId];
          if (Array.isArray(list)) history = list.slice(-maxCmds);
        }
      }
    } catch {
      // missing / corrupt file -> empty history
      history = [];
    }
    const conciseHistory = history.map((entry) => ({
      command: entry.command,
      timestamp: entry.timestamp,
      // WS-B: when no summarized finalResponse exists, the raw output fallback is ANSI-stripped
      // (slice(-300) applied to the stripped string), trimmed, THEN secret-redacted; falling back
      // to the literal 'No output captured.' when that is empty. Order is load-bearing.
      finalResponse:
        entry.finalResponse ||
        redactSecrets(stripAnsiSequences(entry.output).slice(-300).trim()) ||
        "No output captured.",
    }));
    return { kind: "ok", output: conciseHistory };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// get_pane_summary (server.ts:2565)
// ─────────────────────────────────────────────────────────────────────────────
export const getPaneSummary: ActionDef<typeof PaneIdParams> = {
  name: "get_pane_summary",
  description:
    "Return the last ~20 lines of one pane's recent terminal output (ANSI-stripped and secret-redacted). Primary observation path. Pull, not push. NOTE: known secret patterns (AWS keys, JWTs, PEM blocks, GitHub/Slack tokens, Google API keys, generic key=value secrets) are scrubbed and replaced with [REDACTED:*] tokens before this response is sent. This is NOT a delta — it is a snapshot of the most recent lines only; incremental diffing is a later workstream.",
  params: PaneIdParams,
  capability: "read_pane",
  readOnly: true,
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "get", path: "/api/panes/:pane_id/summary" },
  handler: (args, ctx): ActionResult => {
    // igc read-gating lever: block ONLY on the explicit Off veto for "read_pane" (Auto fallback =
    // behavior-preserving). PURE resolver, so the common allowed path adds no audit row.
    // Block only on an EXPLICIT operator Off, NOT the STOP-ALL frozen short-circuit (reads stay available during a freeze — behavior-preserving).
    if (!ctx.isFrozen() && ctx.effectiveCapabilityGateFor(args.pane_id, "read_pane") === "Off") {
      return { kind: "ok", output: "Error: the 'read_pane' capability is gated Off; reading pane content is forbidden by policy." };
    }
    // getPaneSummary returns either a fenced, redacted code block OR the literal
    // `Error: Pane <id> does not exist.` STRING for a missing pane — either way it is an ok-kind
    // string output (the pane-missing case is NOT an ActionResult error).
    return { kind: "ok", output: ctx.manager.getPaneSummary(args.pane_id) };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// get_pane_delta (server.ts:2571)
// ─────────────────────────────────────────────────────────────────────────────
export const getPaneDelta: ActionDef<typeof PaneIdParams> = {
  name: "get_pane_delta",
  description:
    "Return ONLY the pane output that is new since you last read this pane (true incremental delta; ANSI-stripped, secret-redacted). Advances a per-pane read cursor, so repeated calls won't re-show old lines. Prefer this over get_pane_summary when tracking progress.",
  params: PaneIdParams,
  capability: "read_pane",
  readOnly: true,
  surfaces: new Set(["voice"]),
  handler: (args, ctx): ActionResult => {
    // igc read-gating lever: block ONLY on the explicit Off veto for "read_pane" (Auto fallback =
    // behavior-preserving). PURE resolver — gate the read BEFORE the cursor advances on the Off path.
    // Block only on an EXPLICIT operator Off, NOT the STOP-ALL frozen short-circuit (reads stay available during a freeze — behavior-preserving).
    if (!ctx.isFrozen() && ctx.effectiveCapabilityGateFor(args.pane_id, "read_pane") === "Off") {
      return { kind: "ok", output: "Error: the 'read_pane' capability is gated Off; reading pane content is forbidden by policy." };
    }
    // getPaneDelta consumes the per-pane read cursor (intended mutation inside the domain method —
    // it is what makes repeated calls non-redundant) and returns a fenced redacted block, the
    // '[No new output since last read]' string, or the `Error: Pane <id> does not exist.` string.
    // All ok-kind output, same pane-missing caveat as get_pane_summary.
    return { kind: "ok", output: ctx.manager.getPaneDelta(args.pane_id) };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// list_pending_approvals (server.ts:2651)
// ─────────────────────────────────────────────────────────────────────────────
export const listPendingApprovals: ActionDef<typeof NoParams> = {
  name: "list_pending_approvals",
  description:
    "List the commands/instructions currently awaiting the operator's spoken approval (pane, kind, distilled instruction, rationale, count). Use it when the operator asks 'what's queued for approval?' and to disambiguate which one they mean before approving/rejecting.",
  params: NoParams,
  capability: "read_notes",
  readOnly: true,
  surfaces: new Set(["voice"]),
  handler: (_args, ctx): ActionResult => {
    // WS-E.1 (BUG-016): read the SAME store, scoped to this session, and advance the per-session
    // announce watermark so the proactive announcer won't re-announce already-listed approvals.
    const entries = ctx.pendingApprovals.forSession(ctx.session);
    if (entries.length) ctx.pendingApprovals.setLastAnnounced(ctx.session, entries[entries.length - 1].messageId);
    // M3: reuse serializePending (already redacts + computes ageSeconds); add the voice-facing
    // `index`/`pane_id` aliases on top.
    const items = entries.map((p, i) => {
      const ser = serializePending(p);
      return { index: i + 1, pane_id: ser.terminalId, ...ser };
    });
    return { kind: "ok", output: { count: items.length, items } };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// get_attention_digest (server.ts:2762)
// ─────────────────────────────────────────────────────────────────────────────
export const getAttentionDigest: ActionDef<typeof NoParams> = {
  name: "get_attention_digest",
  description:
    "Speak a structured summary of items needing the operator's attention: panes that transitioned to error/exit states AND any commands currently awaiting spoken approval (both are merged into one digest).",
  params: NoParams,
  capability: "read_notes",
  readOnly: true,
  surfaces: new Set(["voice"]),
  handler: (_args, ctx): ActionResult => {
    ctx.pruneAttention(); // BUG-035: evict stale items before reading the digest
    const unread = ctx.manager.attentionQueue.filter((item) => !item.dismissed);
    // BUG-009: MERGE pending approvals — the digest tool claims to cover approvals, so it must
    // actually include them (one source of truth: the same store list_pending_approvals reads).
    const pending = ctx.pendingApprovals.forSession(ctx.session);
    let text = "";
    if (unread.length === 0 && pending.length === 0) {
      text = "There are no pending alerts or actions requiring your attention right now.";
    } else {
      if (unread.length > 0) {
        text += `There are ${unread.length} items requiring attention. `;
        unread.forEach((item, index) => {
          // BUG-025: enrich with live elapsed time + last command.
          const term = ctx.manager.terminals[item.terminalId];
          let timing = "";
          if (term) {
            const elapsedMs = Date.now() - term.lastStatusChangeAt;
            const mins = Math.floor(elapsedMs / 60000);
            const secs = Math.floor((elapsedMs % 60000) / 1000);
            const dur = mins > 0 ? `${mins} minute${mins === 1 ? "" : "s"}` : `${secs} second${secs === 1 ? "" : "s"}`;
            timing = ` It has been ${term.status.toLowerCase()} for ${dur}`;
            // P2 (WS-B): redact secrets in the verbatim last command.
            if (term.lastCommand) timing += `, last command was '${ctx.redact(term.lastCommand)}'`;
            timing += ".";
          }
          text += `${index + 1}. Pane ${item.terminalId} in project ${item.projectId} transitioned to ${item.type}: ${item.message}.${timing} `;
        });
      }
      if (pending.length > 0) {
        ctx.pendingApprovals.setLastAnnounced(ctx.session, pending[pending.length - 1].messageId);
        text += `You also have ${pending.length} command${pending.length === 1 ? "" : "s"} awaiting approval: `;
        pending.forEach((p, i) => {
          const verb = p.kind === "agent_instruction" ? "direct pane" : "run on pane";
          text += `${i + 1}. ${verb} ${p.terminalId} — "${ctx.redact(p.instruction)}". `;
        });
      }
    }
    return { kind: "ok", output: text };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// get_pane_gates (server.ts:3382)
// ─────────────────────────────────────────────────────────────────────────────
export const getPaneGates: ActionDef<typeof OptionalPaneIdParams> = {
  name: "get_pane_gates",
  description: "Read the resolved capability-gate matrix for a pane (or global if pane_id omitted). UNGATED read.",
  params: OptionalPaneIdParams,
  capability: "read_notes",
  readOnly: true,
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "get", path: "/api/panes/:pane_id/gates" },
  handler: (args, ctx): ActionResult => {
    // UNGATED read (legacy comment). pane_id omitted/empty => resolve GLOBAL gates (pass null).
    // effectiveCapabilityGateFor merges pane gate over global, applies spotlight loosening on the
    // active pane, and applies the frozen short-circuit (all-Off while frozen).
    const { pane_id } = args;
    const resolved: Record<string, GateValue> = {};
    for (const c of ALL_CAPABILITIES) {
      resolved[c] = ctx.effectiveCapabilityGateFor(pane_id || null, c);
    }
    return { kind: "ok", output: { pane_id: pane_id ?? null, gates: resolved } };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// list_capabilities (server.ts:3396)
// ─────────────────────────────────────────────────────────────────────────────
export const listCapabilities: ActionDef<typeof NoParams> = {
  name: "list_capabilities",
  description: "List every gateable capability name. UNGATED read.",
  params: NoParams,
  capability: "read_notes",
  readOnly: true,
  surfaces: new Set(["voice", "rest"]),
  rest: { method: "get", path: "/api/capabilities" },
  handler: (_args, _ctx): ActionResult => {
    // UNGATED read. The SAME matrix as get_pane_gates (gateSurface.ALL_CAPABILITIES — one source).
    return { kind: "ok", output: [...ALL_CAPABILITIES] };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// get_stop_all_status (c55 Batch F — NEW rest-only boot-restore snapshot)
// ─────────────────────────────────────────────────────────────────────────────
// FAITHFUL PORT of the inline GET /api/stop-all/status (server.ts): the snapshot the client reads ONCE
// on page load to RESTORE the FROZEN banner before any WS frame exists (the `{type:'frozen'}` frame
// only fires on a CHANGE, so a fresh load against an already-frozen server would otherwise miss it —
// spec §2.C/§10.3 "frozen survives a restart"). Structured body {frozen, running} that the flat
// {output:string} cannot carry, so it rides the rest.toHttp primitive and emits the object TOP-LEVEL.
// ALWAYS_ALLOWED (a brake-state READ is never gated) + rest-only (pure-UI; no voice tool). running is
// EMPTY unless frozen — exactly the inline guard `frozen ? runningPaneIds() : []`.
export const getStopAllStatus: ActionDef<typeof NoParams> = {
  name: "get_stop_all_status",
  description:
    "Read the live STOP-ALL freeze state {frozen, running} so a fresh page load can restore the FROZEN banner. running lists the still-alive pane ids only while frozen. UNGATED boot-restore read.",
  params: NoParams,
  capability: ALWAYS_ALLOWED,
  // ALWAYS_ALLOWED (the brake status must be readable even while frozen, exactly like the brake trio).
  // readOnly:false because the §8.1 invariant binds readOnly ONLY to the read_pane/read_notes caps; the
  // body is {frozen:boolean, running:string[]} (pane ids — no secrets), so no egress redaction is lost
  // (faithful to the inline route, which did none).
  readOnly: false,
  surfaces: new Set(["rest"]),
  rest: {
    method: "get",
    path: "/api/stop-all/status",
    // Emit {frozen, running} TOP-LEVEL (not wrapped in {output}) — the exact legacy inline body shape.
    toHttp: (result): { status: number; body: unknown } => ({
      status: 200,
      body: result.kind === "ok" ? result.output : { frozen: false, running: [] },
    }),
  },
  handler: (_args, ctx): ActionResult => {
    const frozen = ctx.isFrozen();
    return { kind: "ok", output: { frozen, running: frozen ? ctx.runningPaneIds() : [] } };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// get_terminal_history (c55 Batch F — NEW rest-only RAW history array)
// ─────────────────────────────────────────────────────────────────────────────
// FAITHFUL PORT of the inline GET /api/terminals/:id/history (server.ts): returns the RAW
// HistoryManager.loadHistory(id) array — full `output` per entry, NO ANSI strip / redaction / concise
// mapping (that is get_pane_command_history's PROSE shape, deliberately NOT reused here). HistoryManager
// lives in server.ts and cannot be imported without booting the listener, so this reproduces
// loadHistory EXACTLY: read the SAME .janus_history.json at process.cwd(), parse, return
// parsed[paneId].slice(-maxCmds) (or [] on missing key / corrupt file). Structured array body -> the
// rest.toHttp primitive emits it TOP-LEVEL. rest-only (no voice twin — the voice history read is prose).
export const getTerminalHistory: ActionDef<typeof PaneIdParams> = {
  name: "get_terminal_history",
  description:
    "Return the RAW recorded command history array for one pane (full command + timestamp + output + finalResponse per entry) for the UI history panel. UNGATED read.",
  params: PaneIdParams,
  capability: "read_pane",
  readOnly: true,
  surfaces: new Set(["rest"]),
  rest: {
    method: "get",
    path: "/api/terminals/:pane_id/history",
    // Emit the raw history array TOP-LEVEL (not wrapped in {output}) — the exact legacy inline body.
    toHttp: (result): { status: number; body: unknown } => ({
      status: 200,
      body: result.kind === "ok" ? result.output : [],
    }),
  },
  handler: (args, ctx): ActionResult => {
    const targetId = args.pane_id;
    const maxCmds = ctx.manager.settings?.advanced?.historyMaxCommands ?? 50;
    let history: HistoryEntry[] = [];
    try {
      const filePath = path.join(process.cwd(), ".janus_history.json");
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(data);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const list = parsed[targetId];
          if (Array.isArray(list)) history = list.slice(-maxCmds);
        }
      }
    } catch {
      history = [];
    }
    // RAW: the entries are returned verbatim (no concise/redacted mapping) — the UI history panel shape.
    return { kind: "ok", output: history };
  },
};

/** The READS group registry slice. */
export const READS_ACTIONS: ActionDef[] = [
  getPaneCommandHistory,
  getPaneSummary,
  getPaneDelta,
  listPendingApprovals,
  getAttentionDigest,
  getPaneGates,
  listCapabilities,
  getStopAllStatus,
  getTerminalHistory,
];
