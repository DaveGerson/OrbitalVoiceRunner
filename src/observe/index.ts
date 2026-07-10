/**
 * src/observe/index.ts — the PTY OBSERVATION / TRIGGER pipeline (DBT5 / dec-2).
 *
 * This is the behaviour-preserving carve of the `manager.onOutput` / `manager.onIdle` observation
 * surface out of `startServer()`. It owns: classifying each PTY chunk into pane signals + transitions,
 * surfacing watch-rule and plan-step suggestions (as ATTENTION items — never pane writes), the
 * proactive completion announcement on the Running->Idle edge, the per-pane output buffer + 30ms
 * coalescing broadcast, and the best-effort PTY interaction-log leg.
 *
 * Dispatch JOIN hook (docs/design/templates-layouts-dispatch.md §5): this pipeline also feeds the
 * in-memory dispatch-group tracker (src/dispatch/joinTracker.ts) — `onRunning` flips staged members
 * to in-flight, and `detectAndTriggerTransitions` settles them on the edge-deduped
 * idle/error/build-failed/exited edges and fans out the ONE group-completion (attention item +
 * attention_updated/dispatch_updated frames + announcement). Still pure observation + notification:
 * the tracker is bookkeeping only, and no pane write originates here.
 *
 * CRITICAL invariant (why this is the cleanest carve): the triggers here only ever SURFACE attention
 * suggestions and broadcast frames — there is NO autonomous CLI write, so there is NO capability-gate
 * coupling. The whole pipeline is pure observation + notification.
 *
 * Coupling flows ONLY through the injected `deps` bag (and the manager passed explicitly). This module
 * imports its deps' concrete types, the pure helpers it already used (stripAnsiSequences,
 * classifyPaneOutput, SHELL_PROMPT), and types — NEVER server.ts. The private observation state
 * (`lastStates`, `outputBuffers`, `flushTimeout`) lives as locals inside `attachObserve`, scoped to the
 * one server instance, exactly as it did when these were closures inside `startServer()`.
 */

import { GoogleGenAI } from "@google/genai";
import { OrchestratorManager, stripAnsiSequences, redactSecrets } from "../terminal";
import { SHELL_PROMPT } from "../statusConstants";
import { classifyPaneOutput } from "../paneSignals";
import { dispatchJoinTracker } from "../dispatch/joinTracker";
import { getExchangeService, exchangeSpineActive } from "../exchanges/spine";
import type { PaneSignalKind } from "../exchanges/service";
import type { PaneSignalBus } from "../paneSignalBus";
import type { AnnouncementBus } from "../announcementBus";
import type { InteractionLogger } from "../interactionLog";

/** A pane transition edge — kept identical to the inline union it replaced. */
type Transition = "idle" | "prompt" | "error" | "build-failed" | "exited";

// The transition-classification keyword tables, lifted out of the inline ||-chains so the ladder is
// hand-verifiable in one place and the classifier stays under CC 10. Order/semantics are IDENTICAL
// to the original: build-failed markers are matched against the LOWERCASED chunk; the error markers
// split into case-SENSITIVE substrings ("Error:"/"Exception:"/"Stderr:") and lowercased ones
// ("traceback"/"fatal: ").
const BUILD_FAILED_MARKERS = [
  "failed to compile", "build failed", "modulenotfounderror", "compile error",
  "npm err!", "failed to build", "error: command failed", "error: not found",
] as const;
const ERROR_MARKERS_CASE_SENSITIVE = ["Error:", "Exception:", "Stderr:"] as const;
const ERROR_MARKERS_LOWER = ["traceback", "fatal: "] as const;

/** The subset of transitions that escalate to a high-severity attention item + proactive announce. */
type FailureTransition = "build-failed" | "error" | "exited";
const FAILURE_TRANSITIONS = new Set<FailureTransition>(["build-failed", "error", "exited"]);
/** Type guard: narrows a Transition to the high-severity FailureTransition subset. */
function isFailureTransition(t: Transition): t is FailureTransition {
  return FAILURE_TRANSITIONS.has(t as FailureTransition);
}

// ── AgentExchange spine wiring (step 1.4, spec §5 "pane signals") ──────────────────────────────
// The correlator taps the SAME observe call sites that already feed the dispatch join tracker —
// NOT a PaneSignalBus subscription (the bus lanes debounce/dedupe for their consumers; a
// debounced-away edge must still settle an exchange). Every helper below is best-effort and NEVER
// throws (spec §9.6 — a spine outage must never affect real observation); `off` mode short-circuits
// before even allocating the ExchangeService singleton, so this is zero behavior delta by default.

/** The pane's currently-ACTIVE exchange (its delivery marker), or undefined off/unbound/unknown. */
function activeExchangeForPane(terminalId: string): string | undefined {
  if (!exchangeSpineActive()) return undefined;
  try {
    return getExchangeService().activeExchangeForPane(terminalId);
  } catch (e) {
    console.error(`[exchange-spine] activeExchangeForPane failed for ${terminalId}:`, e);
    return undefined;
  }
}

/** Feed one observed pane signal to the exchange correlator (advances the active exchange's own
 *  lifecycle — terminal_running/terminal_quiescing/terminal_idle/needs_input_detected/
 *  agent_failure_reported; a no-op when there is no active exchange on this pane). */
function settleExchangeSignal(terminalId: string, kind: PaneSignalKind, detail?: string): void {
  if (!exchangeSpineActive()) return;
  try {
    getExchangeService().onPaneSignal({ paneId: terminalId, kind, detail });
  } catch (e) {
    console.error(`[exchange-spine] onPaneSignal(${kind}) failed for ${terminalId}:`, e);
  }
}

/** Map the observe pipeline's Transition vocabulary onto the exchange service's PaneSignalKind —
 *  `build-failed` has no distinct exchange-level kind, so it folds into `error` (both are the same
 *  agent_failure_reported edge; spec §1.4 never distinguishes build-failed from a plain error). */
function toExchangeSignalKind(t: Transition): PaneSignalKind {
  return t === "build-failed" ? "error" : t;
}

/** A structural view of the bits of a UniversalTerminal the transition classifier reads. */
interface ClassifiableTerm {
  status: string;
  runtimeType?: string;
}

/** True when the chunk carries a build-failed marker (matched against the lowercased text). */
function isBuildFailedChunk(lower: string): boolean {
  return BUILD_FAILED_MARKERS.some((m) => lower.includes(m));
}

/** True when the chunk carries an error marker (case-sensitive markers OR lowercased markers). */
function isErrorChunk(cleanChunk: string, lower: string): boolean {
  return ERROR_MARKERS_CASE_SENSITIVE.some((m) => cleanChunk.includes(m)) ||
    ERROR_MARKERS_LOWER.some((m) => lower.includes(m));
}

/**
 * Refine an already-Idle pane: a shell pane whose ANSI-stripped tail matches SHELL_PROMPT is a
 * "prompt" (I4: shell panes only, never an interactive_cli TUI); otherwise it is plain "idle". This
 * is an attention-label concern independent of the authoritative idle decision (statusMachine.ts).
 */
function classifyIdleRefinement(term: ClassifiableTerm, cleanChunk: string): Transition {
  const isShell = term.runtimeType === "shell";
  const tail = stripAnsiSequences(cleanChunk);
  return isShell && SHELL_PROMPT.test(tail) ? "prompt" : "idle";
}

/**
 * Classify a PTY chunk into a pane transition, or null for no edge. IDENTICAL ladder to the original
 * inline chain: Exited short-circuits to "exited"; else build-failed (precedence) > error > (only
 * when the pane is already Idle) the prompt/idle refinement.
 */
function classifyTransition(term: ClassifiableTerm, cleanChunk: string): Transition | null {
  if (term.status === "Exited") return "exited";
  const lower = cleanChunk.toLowerCase();
  if (isBuildFailedChunk(lower)) return "build-failed";
  if (isErrorChunk(cleanChunk, lower)) return "error";
  if (term.status === "Idle") return classifyIdleRefinement(term, cleanChunk);
  return null;
}

/**
 * The single history entry shape the observe pipeline reads/writes. Structural so this module does NOT
 * import `HistoryEntry`/`HistoryManager` from server.ts (the no-server.ts-coupling rule). The singleton
 * is threaded in via `deps.historyManager`.
 */
export interface ObserveHistoryEntry {
  command: string;
  timestamp: string;
  output: string;
  finalResponse?: string;
}

/** The minimal history surface the observe pipeline uses (the server.ts `HistoryManager` satisfies it). */
export interface ObserveHistoryManager {
  loadHistory(terminalId: string): ObserveHistoryEntry[];
  saveHistory(terminalId: string, history: ObserveHistoryEntry[]): void;
  appendOutputToLastCommand(terminalId: string, chunk: string): void;
}

/**
 * The observe pipeline's injected dependency bag. Everything the moved closures used from
 * `startServer()` scope, threaded explicitly so the SAME shared cells are mutated across the boundary.
 *
 *  - broadcast / announcementBus / paneSignalBus / pruneAttention: the notification + attention sinks.
 *  - interactionLog + getLastInteractionId: the best-effort correlated PTY leg (module-mutable id; read-only here).
 *  - redact: redactSecrets, applied before any pane text is announced/displayed/summarized.
 *  - historyManager: the server's HistoryManager singleton (passed in, not imported).
 *  - ai: the server-scoped GoogleGenAI fallback client used by the idle-edge outcome summarizer.
 */
export interface ObserveDeps {
  broadcast: (msg: any) => void;
  announcementBus: AnnouncementBus;
  paneSignalBus: PaneSignalBus;
  pruneAttention: () => void;
  interactionLog: InteractionLogger;
  getLastInteractionId: () => string | null;
  redact: (s: string) => string;
  historyManager: ObserveHistoryManager;
  ai: GoogleGenAI;
  // P0a memory: optional sink for decaying cross-pane breadcrumbs (redacted one-liners).
  onBreadcrumb?: (b: { ts: number; paneId: string | null; text: string }) => void;
}

/** The handlers wired onto the manager. */
export interface ObserveHandlers {
  onOutput: (terminalId: string, chunk: string) => void;
  onIdle: (terminalId: string) => Promise<void>;
  // Phase 1 "ears": the symmetric BEGINNING edge to onIdle. Publishes a 'running' pane signal
  // (model channel, fact [C]) and a pane_status WS frame (operator UI, fact [D]) on the genuine
  // Running edge. The PaneSignalBus owns the per-(pane,kind) debounce.
  onRunning: (terminalId: string) => void;
  // Conservative Phase 2: the HUMBLE pre-idle "cooking…" edge. Publishes a 'quiescing' pane
  // signal (model channel) and a lightweight pane_quiescing WS frame (operator UI) when the pane
  // goes quiet inside the pre-idle window — WITHOUT enqueuing a completion announcement (cooking
  // is not 'done'). The PaneSignalBus owns the per-(pane,kind) debounce.
  onQuiescing: (terminalId: string) => void;
  // res2 (bead res2 / wsm-e2e-pinned-y09): the PUSH exit edge. Fired from
  // UniversalTerminal.onExit the instant a pane's PTY exits — does NOT depend on a subsequent
  // output chunk (unlike the onOutput-driven classifier below, which a silent SIGKILL never
  // reaches). Reuses the identical classifyTransition/emitHighSeverityTransition path, so it is
  // the SAME attention item / attention_updated broadcast / paneSignalBus 'exited' publish, deduped
  // through the same lastStates edge tracking (a chunk that already classified this exit, or a
  // later one, can never double-fire it).
  onExit: (terminalId: string) => void;
}

// VOICE_TRACE is recomputed here from the same env signal server.ts uses, so the high-volume PTY
// interaction leg stays gated identically without coupling to a server.ts export.
const VOICE_TRACE = !!process.env.JANUS_DEBUG_VOICE && process.env.JANUS_DEBUG_VOICE !== "0";

/**
 * attachObserve(manager, deps) — build the `onOutput` / `onIdle` handlers plus their private,
 * per-server observation state. The caller assigns `manager.onOutput = onOutput` /
 * `manager.onIdle = onIdle` AFTER all deps (broadcast, announcementBus, paneSignalBus, ...) are
 * constructed, exactly mirroring the original late-bound closure assignments.
 */
export function attachObserve(manager: OrchestratorManager, deps: ObserveDeps): ObserveHandlers {
  const {
    broadcast,
    announcementBus,
    paneSignalBus,
    pruneAttention,
    interactionLog,
    getLastInteractionId,
    redact,
    historyManager,
    ai,
    onBreadcrumb,
  } = deps;

  // ── Private observation state (was server-local; moves here as locals scoped to this server) ──
  const lastStates: Record<string, string> = {};
  const outputBuffers: Record<string, string[]> = {};
  let flushTimeout: NodeJS.Timeout | null = null;

  // Dispatch join (templates-layouts-dispatch §5): settle in-flight dispatch members on a pane
  // edge and announce each group it NEWLY completed through the existing sinks. Called from TWO
  // sites — the genuine onIdle completion edge (success settle; shell panes return to a prompt,
  // so the chunk classifier often never sees a fresh "idle" edge) and detectAndTriggerTransitions
  // (failure settles: error/build-failed/exited). noteTransition only flips still-running members
  // and reports a group exactly once, so the sites can never double-announce.
  function settleDispatchJoin(
    terminalId: string,
    transition: "idle" | "prompt" | "error" | "build-failed" | "exited"
  ): void {
    // Step 1.4: gate exchange-correlated members to the pane's ACTIVE exchange (the delivery
    // marker) instead of the old blind paneId match — legacy/flag-off members (no exchangeId) are
    // unaffected (see joinTracker.ts's noteTransition/settleGroupMembers).
    const activeExchangeId = activeExchangeForPane(terminalId);
    for (const g of dispatchJoinTracker.noteTransition(terminalId, transition, Date.now(), activeExchangeId)) {
      const total = g.members.length;
      const done = g.members.filter((m) => m.status === "done").length;
      const failed = g.members.filter((m) => m.status === "error" || m.status === "blocked").length;
      const summary = `Dispatch '${g.name}' complete: ${done}/${total} done${failed > 0 ? `, ${failed} failed` : ""}`;
      manager.attentionQueue.push({
        id: "att_" + Math.random().toString(36).substring(2, 11),
        // Informational completion item ("idle" — widened onto AttentionItem.type for this).
        type: "idle",
        terminalId,
        projectId: manager.ledger.activeProjectId || "default_project",
        message: summary,
        timestamp: new Date().toISOString(),
        dismissed: false
      });
      pruneAttention(); // BUG-035 cap/TTL
      broadcast({ type: "attention_updated", queue: manager.attentionQueue });
      broadcast({ type: "dispatch_updated", dispatches: dispatchJoinTracker.list() });
      announcementBus.enqueue({ kind: "completion", terminalId, summary });
    }
  }

  // Best-effort summarization: when no API key is configured and Google's client library falls
  // back to Application Default Credentials (ADC), the ADC lookup fails with a long, alarming
  // stack trace ("Could not load the default credentials..."). That's an EXPECTED outcome in
  // dev/CI without a key configured, not a bug — log it at debug level so it doesn't read as a
  // crash. Any other error kind still surfaces via console.error so real regressions on this
  // path aren't swallowed. Extracted to keep summarizeCommandOutcome's complexity under CC 10.
  function logSummarizeCommandOutcomeError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (/could not load the default credentials/i.test(message)) {
      console.debug("[summarizeCommandOutcome] No credentials configured; skipping summary.");
    } else {
      console.error("[summarizeCommandOutcome] Error:", err);
    }
  }

  async function summarizeCommandOutcome(command: string, rawOutput: string): Promise<string> {
    try {
      const apiKey = (manager.settings.secrets?.geminiApiKey && manager.settings.secrets.geminiApiKey !== "CONFIGURED_IN_ENV")
        ? manager.settings.secrets.geminiApiKey
        : (process.env.GEMINI_API_KEY || "");

      const summarizeAi = apiKey ? new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      }) : ai;

      // WS-B: redactSecrets applied to raw output before it reaches the model (was UNREDACTED,
      // finding N-5). Secrets printed to a pane are now scrubbed before this Gemini call.
      const prompt = `You are a strict, command-line terminal outcome synthesizer.
Summarize the final response and outcome of the following command execution. Do NOT include raw or verbose stdout log sequences. Focus exclusively on the ultimate outcome, success/failure of the command, and any critical final lines of output (key numbers, final results, final generated file text, or compile error statements). Do not say who you are. Keep your summary to 1-2 small conversational sentences, highly professional and compact.

Command: ${command}
Verbose Output:
${redact(rawOutput.slice(-3000))}`;

      // NOTE: `rawOutput` is now sent to the summarizer model via redact (redactSecrets), which
      // scrubs AWS keys, JWTs, PEM blocks, Google API keys, GitHub/Slack tokens, and
      // generic key=value secret assignments before any content reaches the model.
      const response = await summarizeAi.models.generateContent({
        model: "gemini-3.5-flash",
        contents: prompt,
      });
      return response.text?.trim() || "No outcomes summary available.";
    } catch (err) {
      logSummarizeCommandOutcomeError(err);
      // Honest neutral fallback — do NOT claim success; the outcome is unknown here.
      return "Command outcome summary unavailable.";
    }
  }

  // WS-D summary for the proactive completion notification. Built ONLY from already-redacted/derived
  // sources (never raw pane text): a fresh summarization when there is substantive output (which is
  // then persisted + history_updated re-broadcast), else the existing redacted finalResponse, else a
  // brief last-command-based fallback, else the bare "finished". Extracted from onIdle so the handler
  // stays under CC 10; the side-effect ordering (save -> broadcast) is identical to the inline code.
  async function computeIdleSummary(terminalId: string): Promise<string> {
    const history = historyManager.loadHistory(terminalId);
    if (history.length === 0) return "finished";
    const lastEntry = history[history.length - 1];
    try {
      const cleanOutput = lastEntry.output ? stripAnsiSequences(lastEntry.output).trim() : "";
      if (cleanOutput.length > 5 && !lastEntry.finalResponse) {
        const summary = await summarizeCommandOutcome(lastEntry.command, cleanOutput);
        lastEntry.finalResponse = summary;
        historyManager.saveHistory(terminalId, history);
        broadcast({ type: "history_updated", terminalId, history });
        return summary;
      }
      if (lastEntry.finalResponse) return lastEntry.finalResponse; // already WS-B redacted
      if (lastEntry.command) return `${lastEntry.command} finished`;
    } catch (err) {
      console.error("Auto-summarization failed for command outcomes:", err);
    }
    return "finished";
  }

  const onIdle = async (terminalId: string): Promise<void> => {
    // AgentExchange spine (step 1.4): the genuine Running→Idle completion edge also settles the
    // pane's active exchange (delivered/running/needs_input -> terminal_idle). Best-effort/no-op
    // internally (settleExchangeSignal never throws); off by default.
    settleExchangeSignal(terminalId, "idle");
    // Dispatch join: the genuine Running→Idle completion edge is the SUCCESS settle signal (the
    // chunk classifier below dedups on lastStates, so shell panes that return to a prompt never
    // produce a fresh "idle" edge there). Guarded per QW5 — a join fault must not skip the
    // summarization/announcement below.
    try {
      settleDispatchJoin(terminalId, "idle");
    } catch (e) {
      console.error(`[onIdle] dispatch-join settle failed for ${terminalId}:`, e);
    }
    const term = manager.terminals[terminalId];
    if (!term) return;

    const summaryText = await computeIdleSummary(terminalId);

    // WS-D (BUG-024): announce on this genuine WS-C Running->Idle completion edge — no new
    // idle inference. Fires regardless of whether there was substantive output / an existing
    // finalResponse, with the redacted summary above as the message. The bus owns the
    // per-pane debounce / coalescing / rate limit, so a trivial completion is still safe.
    announcementBus.enqueue({ kind: "completion", terminalId, summary: summaryText });
    paneSignalBus.publish({ paneId: terminalId, kind: "idle", detail: summaryText.slice(0, 160) });
    // P0a memory: drop a redacted one-liner breadcrumb on the genuine Running->Idle "finished" edge.
    if (onBreadcrumb) {
      const lc = redact(summaryText).slice(0, 80);
      onBreadcrumb({ ts: Date.now(), paneId: terminalId, text: `pane ${terminalId} finished${lc ? `: ${lc}` : ""}` });
    }
  };

  // Phase 1 "ears": the symmetric BEGINNING handle. Fired by the manager on the genuine
  // Running edge (UniversalTerminal.onRunning). It (a) publishes a 'running' pane signal so
  // the model hears the pane start (fact [C]) and (b) broadcasts a pane_status WS frame so the
  // operator UI flips the chip to Running in real time without waiting for the 20s poll
  // (fact [D]). detail is built ONLY from already-redacted/derived sources (the pane's last
  // command, redacted + capped) — never raw pane bytes. The bus owns the per-(pane,kind)
  // debounce, so a chatty Running edge can't spam the model; no second debounce here.
  const onRunning = (terminalId: string): void => {
    const term = manager.terminals[terminalId];
    // y09 follow-up: a fresh spawn is a NEW pane lifetime — clear any stamped "exited" (or other)
    // edge from a prior life so a genuine silent death after this restart can classify a fresh
    // "exited" transition instead of being suppressed by the stale dedup (detectAndTriggerTransitions
    // no-ops when transition === lastStates[terminalId]). Without this, once a pane has exited once
    // — including via an intentional stop, which still stamps lastStates via the chunk classifier —
    // every subsequent restart's silent death goes unsignalled for the rest of the server's life.
    delete lastStates[terminalId];
    const detail = term?.lastCommand ? redact(term.lastCommand).slice(0, 80) : undefined;
    paneSignalBus.publish({ paneId: terminalId, kind: "running", detail });
    broadcast({ type: "pane_status", terminalId, status: "Running" });
    // AgentExchange spine (step 1.4): the genuine Running edge advances the pane's active exchange
    // (delivered|needs_input -> running). Best-effort/no-op internally; off by default.
    settleExchangeSignal(terminalId, "running", detail);
    // Dispatch join (templates-layouts-dispatch §5): the genuine Running edge is what flips a
    // staged dispatch member to in-flight (its approved write landed and the pane started). Pure
    // bookkeeping — settling/announcing happens on the transition edges below. Guarded so a join
    // fault can never break the Running observation (QW5 philosophy). Step 1.4: gated to the
    // pane's ACTIVE exchange for exchange-correlated members (see joinTracker.ts).
    try {
      dispatchJoinTracker.noteRunning(terminalId, activeExchangeForPane(terminalId));
    } catch (e) {
      console.error(`[ONRUNNING] dispatch-join step failed for ${terminalId}:`, e);
    }
    // P0a memory: drop a redacted one-liner breadcrumb on the Running edge (cross-pane working memory).
    if (onBreadcrumb) {
      const lc = term?.lastCommand ? redact(term.lastCommand).slice(0, 80) : "";
      onBreadcrumb({ ts: Date.now(), paneId: terminalId, text: `pane ${terminalId} started${lc ? `: ${lc}` : ""}` });
    }
  };

  // Conservative Phase 2: the HUMBLE pre-idle "cooking…" handle. Fired by the manager when the
  // pane goes quiet inside the idle-debounce window (UniversalTerminal.onQuiescing). It (a)
  // publishes a 'quiescing' pane signal so the model hears the pane is wrapping up but NOT done
  // (the formatter narrates it humbly) and (b) broadcasts a lightweight pane_quiescing WS frame
  // so the UI can show the humble label without waiting for the 20s poll. It deliberately does
  // NOT enqueue an announcementBus completion — cooking is not 'done', only the genuine onIdle
  // edge announces. detail is built ONLY from already-redacted/derived sources (the pane's last
  // command), never raw pane bytes. The bus owns the per-(pane,kind) debounce.
  const onQuiescing = (terminalId: string): void => {
    const term = manager.terminals[terminalId];
    const detail = term?.lastCommand ? redact(term.lastCommand).slice(0, 80) : undefined;
    paneSignalBus.publish({ paneId: terminalId, kind: "quiescing", detail });
    broadcast({ type: "pane_quiescing", terminalId });
    // AgentExchange spine (step 1.4): advisory only (spec §1.4) — never changes exchange state.
    settleExchangeSignal(terminalId, "quiescing", detail);
    // P0a memory: drop a redacted one-liner breadcrumb on the pre-idle "wrapping up" edge.
    if (onBreadcrumb) {
      const lc = term?.lastCommand ? redact(term.lastCommand).slice(0, 80) : "";
      onBreadcrumb({ ts: Date.now(), paneId: terminalId, text: `pane ${terminalId} wrapping up${lc ? `: ${lc}` : ""}` });
    }
  };

  function handleWatchRulesTrigger(terminalId: string, transition: Transition) {
    const rules = manager.ledger.watchRules;
    let changed = false;
    for (const rule of rules) {
      if (rule.enabled && rule.triggerTerminalId === terminalId && rule.triggerTransition === transition) {
        // Prompt-composer refactor: watch rules NEVER write to a CLI pane. They are co-pilot
        // nudges — when the trigger matches, we SURFACE the suggested command for the operator
        // (who can act on it, gated, on the active pane). No autonomous, background, or
        // cross-pane write happens here. (architecture §5: Remove watch-rule autonomous writes.)
        console.log(`[WATCH RULE NUDGE] Rule ${rule.id} matched: suggesting '${rule.actionCommand}' for '${rule.actionTerminalId}' (not writing).`);
        const itemID = "att_" + Math.random().toString(36).substring(2, 11);
        manager.attentionQueue.push({
          id: itemID,
          type: "confirmation",
          terminalId: rule.actionTerminalId,
          projectId: manager.ledger.activeProjectId || "default_project",
          message: `Suggestion: run '${rule.actionCommand}' on '${rule.actionTerminalId}' (trigger: '${terminalId}' → '${transition}').`,
          timestamp: new Date().toISOString(),
          dismissed: false,
          details: {
            kind: "watch_rule_suggestion",
            ruleId: rule.id,
            suggestedCommand: rule.actionCommand,
            targetTerminalId: rule.actionTerminalId,
          },
        });
        pruneAttention(); // BUG-035 cap/TTL
        broadcast({ type: "attention_updated", queue: manager.attentionQueue });
        broadcast({
          type: "watch_rule_suggested",
          ruleId: rule.id,
          suggestedCommand: rule.actionCommand,
          targetTerminalId: rule.actionTerminalId,
          message: `Watch rule matched — suggested '${rule.actionCommand}' on '${rule.actionTerminalId}'. Not executed; awaiting the operator.`
        });
        if (rule.oneShot) {
          rule.enabled = false;
          changed = true;
        }
      }
    }
    if (changed) {
      manager.ledger["save"](true);
      // wsm-e2e-pinned-33c.4: watch_rules_updated is PRUNED — no client consumes that frame (the
      // classic UI's Alerts/Orchestrate tabs were removed d858e5e; Kitchen has no watch-rule surface).
      // The oneShot-disable persist above is unchanged.
    }
  }

  // Prompt-composer refactor (architecture §5: Demote plans): a plan is an OUTLINE, not an execution
  // engine. On a matched step edge we advance/complete/fail the plan and SURFACE the next step as a
  // co-pilot suggestion — we NEVER auto-write the next step into a pane. The three arms below are the
  // exact bodies of the original nested branches, lifted out so each function stays under CC 10.

  /** Step matched its expected transition AND a next step exists: pause + surface the suggestion. */
  function advanceToNextPlanStep(plan: any, nextIndex: number): void {
    plan.currentStepIndex = nextIndex;
    const nextStep = plan.steps[nextIndex];
    nextStep.status = "pending";
    plan.status = "paused";
    const itemID = "att_" + Math.random().toString(36).substring(2, 11);
    manager.attentionQueue.push({
      id: itemID,
      type: "confirmation",
      terminalId: nextStep.terminalId,
      projectId: manager.ledger.activeProjectId || "default_project",
      message: `Plan '${plan.name}': step ${nextIndex + 1} ready — suggest '${nextStep.command}' on '${nextStep.terminalId}'.`,
      timestamp: new Date().toISOString(),
      dismissed: false,
      details: {
        kind: "plan_step_suggestion",
        planId: plan.id,
        stepId: nextStep.id,
        suggestedCommand: nextStep.command,
        targetTerminalId: nextStep.terminalId,
      },
    });
    pruneAttention(); // BUG-035 cap/TTL
    broadcast({ type: "attention_updated", queue: manager.attentionQueue });
    announcementBus.enqueue({
      kind: "plan_paused",
      terminalId: nextStep.terminalId,
      summary: `Plan '${plan.name}' — step ${nextIndex + 1} ready for your approval.`
    });
  }

  /** Step matched and was the LAST step: the plan is complete. */
  function completePlan(plan: any): void {
    plan.status = "completed";
    console.log(`[PLAN COMPLETED] Plan '${plan.name}' finished successfully!`);
    broadcast({
      type: "plan_completed",
      planId: plan.id,
      message: `Plan '${plan.name}' completed all steps successfully!`
    });
    announcementBus.enqueue({
      kind: "plan_completed",
      terminalId: plan.id,
      summary: `Plan '${plan.name}' completed.`
    });
  }

  /** A failure transition on the running step: fail the step + pause the plan. */
  function failPlanStep(plan: any, currentStep: any, terminalId: string, transition: Transition): void {
    currentStep.status = "failed";
    plan.status = "paused";
    console.log(`[PLAN PAUSED] Plan '${plan.name}' failed on step ${plan.currentStepIndex + 1} due to ${transition}.`);
    const itemID = "att_" + Math.random().toString(36).substring(2, 11);
    manager.attentionQueue.push({
      id: itemID,
      type: "build-failed",
      terminalId,
      projectId: manager.ledger.activeProjectId || "default_project",
      message: `Plan '${plan.name}' was paused on step ${plan.currentStepIndex + 1}: pane returned ${transition}.`,
      timestamp: new Date().toISOString(),
      dismissed: false
    });
    pruneAttention(); // BUG-035 cap/TTL
    broadcast({ type: "attention_updated", queue: manager.attentionQueue });
    broadcast({
      type: "plan_paused",
      planId: plan.id,
      message: `Plan '${plan.name}' paused due to execution error.`
    });
    announcementBus.enqueue({
      kind: "plan_paused",
      terminalId,
      summary: `Plan '${plan.name}' paused on step ${plan.currentStepIndex + 1}.`
    });
  }

  /**
   * Handle a transition edge against ONE plan whose current running step is bound to `terminalId`.
   * Returns true when the plan changed (the caller then force-persists + re-broadcasts the board).
   */
  function handlePlanStepEdge(plan: any, currentStep: any, terminalId: string, transition: Transition): boolean {
    if (transition === currentStep.expectedTransition) {
      currentStep.status = "completed";
      console.log(`[PLAN PROGRESS] Plan '${plan.name}' - Step ${plan.currentStepIndex + 1} completed!`);
      broadcast({
        type: "plan_step_completed",
        planId: plan.id,
        stepId: currentStep.id,
        message: `Plan step completed successfully on '${terminalId}'.`
      });
      const nextIndex = plan.currentStepIndex + 1;
      if (nextIndex < plan.steps.length) {
        advanceToNextPlanStep(plan, nextIndex);
      } else {
        completePlan(plan);
      }
      return true;
    }
    if (transition === "error" || transition === "build-failed" || transition === "exited") {
      failPlanStep(plan, currentStep, terminalId, transition);
      return true;
    }
    return false;
  }

  function handlePlansTrigger(terminalId: string, transition: Transition) {
    const plans = manager.ledger.plans;
    let changed = false;
    for (const plan of plans) {
      if (plan.status !== "running") continue;
      const currentStep = plan.steps[plan.currentStepIndex];
      if (currentStep && currentStep.status === "running" && currentStep.terminalId === terminalId) {
        if (handlePlanStepEdge(plan, currentStep, terminalId, transition)) changed = true;
      }
    }
    if (changed) {
      manager.ledger["save"](true);
      broadcast({ type: "plans_updated", plans: manager.ledger.plans });
    }
  }

  // The high-severity escalation (build-failed/error/exited): push a redacted attention item,
  // re-broadcast the queue, enqueue the proactive announcement, and — for `exited` only — publish
  // the voice-lane signal (error/prompt already flow per-chunk via classifyPaneOutput). Extracted
  // from detectAndTriggerTransitions so each function stays under CC 10; behaviour is identical.
  function emitHighSeverityTransition(terminalId: string, transition: FailureTransition, cleanChunk: string): void {
    const activeProjectId = manager.ledger.activeProjectId || "default_project";
    const id = "att_" + Math.random().toString(36).substring(2, 11);
    // WS-B: scrub the chunk before it becomes a displayed/announced hint.
    const hint = redact(cleanChunk.trim()).slice(-160);
    manager.attentionQueue.push({
      id,
      type: transition,
      terminalId,
      projectId: activeProjectId,
      message: `Pane '${terminalId}' transitioned to '${transition}' state.`,
      timestamp: new Date().toISOString(),
      dismissed: false
    });
    pruneAttention(); // BUG-035 cap/TTL
    broadcast({ type: "attention_updated", queue: manager.attentionQueue });

    // WS-D (BUG-024): high-severity proactive announcement (reuses the existing lastStates
    // edge-dedup, so this fires once per genuine transition edge).
    announcementBus.enqueue({ kind: transition, terminalId, summary: hint });

    // 1C.2 (Phase 1 Track C): a crashed/ended pane must reach the VOICE lane too. Publish exactly
    // like the idle/running/quiescing edges (same bus, redacted detail); only `exited` needs the
    // lane here. The lastStates edge-dedup above means it fires once per genuine exit.
    if (transition === "exited") {
      paneSignalBus.publish({ paneId: terminalId, kind: "exited", detail: hint || undefined });
    }
  }

  function detectAndTriggerTransitions(terminalId: string, cleanChunk: string) {
    const term = manager.terminals[terminalId];
    if (!term) return;

    const transition = classifyTransition(term, cleanChunk);
    const previousState = lastStates[terminalId];
    if (!transition || transition === previousState) return;

    lastStates[terminalId] = transition;
    console.log(`[TRANSITION] Terminal ${terminalId} transitioned: ${previousState || "none"} -> ${transition}`);

    broadcast({
      type: "pane_transition",
      terminalId,
      transition,
      message: `Pane ${terminalId} is now ${transition}.`
    });

    if (isFailureTransition(transition)) {
      emitHighSeverityTransition(terminalId, transition, cleanChunk);
    }

    // AgentExchange spine (step 1.4): feed this classified edge to the pane's active exchange too
    // (needs_input_detected on 'prompt', agent_failure_reported on error/build-failed/exited, and
    // terminal_idle here is a harmless idempotent repeat of onIdle's own signal — the underlying
    // state CAS makes a duplicate edge a structural no-op). Best-effort/no-op internally.
    settleExchangeSignal(terminalId, toExchangeSignalKind(transition));

    handleWatchRulesTrigger(terminalId, transition);
    handlePlansTrigger(terminalId, transition);

    // Dispatch join (templates-layouts-dispatch §5): settle in-flight dispatch members on the
    // FAILURE edges here (error/build-failed/exited — lastStates-deduped, once per genuine edge).
    // The SUCCESS settle lives on the genuine onIdle completion edge instead: a shell pane returns
    // to a prompt after a command, so this classifier often sees no fresh "idle" edge at all
    // (prompt==previousState), while the status machine's Running→Idle edge always fires.
    // noteTransition only touches still-running members, so the two sites can never double-announce
    // a group. Guarded per QW5: a join fault must never break observation.
    try {
      settleDispatchJoin(terminalId, transition);
    } catch (e) {
      console.error(`[TRANSITION] dispatch-join step failed for ${terminalId}:`, e);
    }
  }

  // QW5 (bead qw5): this runs on EVERY PTY data chunk. Each observation step is independent — a throw
  // from one bad chunk used to propagate out of the PTY data event, crashing the process AND blinding
  // the pane (the buffering/broadcast tail never ran). Guard each step in its own try/catch so one
  // failing step neither kills the others nor blinds the stream; log and continue. This is a net, not
  // a behavior change. Extracted from onOutput so the handler stays under CC 10.
  function runObservationSteps(terminalId: string, cleanChunk: string): void {
    try {
      // Push-observation: classify each chunk and publish error/prompt signals. The bus
      // debounces per (pane,kind), so a chatty pane won't spam the model.
      const cls = classifyPaneOutput(cleanChunk);
      if (cls) {
        paneSignalBus.publish({ paneId: terminalId, kind: cls.kind, detail: cls.detail });
      }
    } catch (e) {
      console.error(`[ONOUTPUT] pane-signal step failed for ${terminalId}:`, e);
    }
    try {
      historyManager.appendOutputToLastCommand(terminalId, cleanChunk);
    } catch (e) {
      console.error(`[ONOUTPUT] history step failed for ${terminalId}:`, e);
    }
    try {
      // Classify transitions and handle trigger rules
      detectAndTriggerTransitions(terminalId, cleanChunk);
    } catch (e) {
      console.error(`[ONOUTPUT] transition step failed for ${terminalId}:`, e);
    }
  }

  // Correlated log: attribute terminal output to the active turn (best-effort; VOICE_TRACE-gated
  // because PTY is high-volume). Lets "what did the operator's command actually produce?" be answered
  // from the same stream as the voice/tool legs.
  function logCorrelatedPtyOutput(terminalId: string, chunk: string): void {
    const lastInteractionId = getLastInteractionId();
    if (VOICE_TRACE && lastInteractionId) {
      try {
        interactionLog.log({
          interactionId: lastInteractionId,
          kind: "pty",
          paneId: terminalId,
          text: stripAnsiSequences(chunk).slice(0, 500),
        });
      } catch { /* observability never breaks the PTY loop */ }
    }
  }

  // Per-pane output buffer + the single 30ms coalescing flush timer (shared across panes). Identical
  // to the inline tail; extracted so onOutput stays flat.
  function bufferAndScheduleFlush(terminalId: string, chunk: string): void {
    if (!outputBuffers[terminalId]) {
      outputBuffers[terminalId] = [];
    }
    outputBuffers[terminalId].push(chunk);

    if (!flushTimeout) {
      flushTimeout = setTimeout(() => {
        flushTimeout = null;
        for (const [tid, chunks] of Object.entries(outputBuffers)) {
          if (chunks.length > 0) {
            broadcast({
              type: "stdout_chunk",
              terminalId: tid,
              chunk: chunks.join("")
            });
            outputBuffers[tid] = [];
          }
        }
      }, 30);
    }
  }

  const onOutput = (terminalId: string, chunk: string): void => {
    const term = manager.terminals[terminalId];
    if (term) {
      runObservationSteps(terminalId, stripAnsiSequences(chunk));
    }
    logCorrelatedPtyOutput(terminalId, chunk);
    bufferAndScheduleFlush(terminalId, chunk);
  };

  // res2/y09: the PUSH exit edge (manager.onExit, forwarded from UniversalTerminal.onExit). Calls
  // the SAME detectAndTriggerTransitions the onOutput chunk path uses — classifyTransition
  // short-circuits to "exited" the moment term.status is "Exited" (already true by the time this
  // fires), so a pane that dies with no trailing output chunk still gets the attention item +
  // attention_updated broadcast + paneSignalBus 'exited' publish. No new decision logic; this is
  // strictly a second, chunk-independent entry point into the existing classifier. Own try/catch
  // (QW5 philosophy): an observation fault here must never propagate out of the exit teardown.
  const onExit = (terminalId: string): void => {
    try {
      detectAndTriggerTransitions(terminalId, "");
    } catch (e) {
      console.error(`[ONEXIT] transition step failed for ${terminalId}:`, e);
    }
  };

  return { onOutput, onIdle, onRunning, onQuiescing, onExit };
}

// Re-export the secret redactor's identity for callers that want the same default `redact` the
// pipeline uses, without reaching into server.ts. (server.ts passes `redact: redactSecrets`.)
export { redactSecrets };
