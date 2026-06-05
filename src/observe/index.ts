/**
 * src/observe/index.ts — the PTY OBSERVATION / TRIGGER pipeline (DBT5 / dec-2).
 *
 * This is the behaviour-preserving carve of the `manager.onOutput` / `manager.onIdle` observation
 * surface out of `startServer()`. It owns: classifying each PTY chunk into pane signals + transitions,
 * surfacing watch-rule and plan-step suggestions (as ATTENTION items — never pane writes), the
 * proactive completion announcement on the Running->Idle edge, the per-pane output buffer + 30ms
 * coalescing broadcast, and the best-effort PTY interaction-log leg.
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
import type { PaneSignalBus } from "../paneSignalBus";
import type { AnnouncementBus } from "../announcementBus";
import type { InteractionLogger } from "../interactionLog";

/** A pane transition edge — kept identical to the inline union it replaced. */
type Transition = "idle" | "prompt" | "error" | "build-failed" | "exited";

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
  } = deps;

  // ── Private observation state (was server-local; moves here as locals scoped to this server) ──
  const lastStates: Record<string, string> = {};
  const outputBuffers: Record<string, string[]> = {};
  let flushTimeout: NodeJS.Timeout | null = null;

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
      console.error("[summarizeCommandOutcome] Error:", err);
      // Honest neutral fallback — do NOT claim success; the outcome is unknown here.
      return "Command outcome summary unavailable.";
    }
  }

  const onIdle = async (terminalId: string): Promise<void> => {
    const term = manager.terminals[terminalId];
    if (term) {
      const history = historyManager.loadHistory(terminalId);
      // WS-D summary for the proactive completion notification. Built ONLY from
      // already-redacted/derived sources (never raw pane text): a fresh summarization when
      // there is substantive output, else the existing redacted finalResponse, else a brief
      // last-command-based fallback. Always set so the announcement below can fire.
      let summaryText = "finished";
      if (history.length > 0) {
        const lastEntry = history[history.length - 1];
        try {
          const cleanOutput = lastEntry.output ? stripAnsiSequences(lastEntry.output).trim() : "";
          if (cleanOutput.length > 5 && !lastEntry.finalResponse) {
            summaryText = await summarizeCommandOutcome(lastEntry.command, cleanOutput);
            lastEntry.finalResponse = summaryText;
            historyManager.saveHistory(terminalId, history);
            broadcast({ type: "history_updated", terminalId, history });
          } else if (lastEntry.finalResponse) {
            summaryText = lastEntry.finalResponse; // already WS-B redacted
          } else if (lastEntry.command) {
            summaryText = `${lastEntry.command} finished`;
          }
        } catch (err) {
          console.error("Auto-summarization failed for command outcomes:", err);
        }
      }

      // WS-D (BUG-024): announce on this genuine WS-C Running->Idle completion edge — no new
      // idle inference. Fires regardless of whether there was substantive output / an existing
      // finalResponse, with the redacted summary above as the message. The bus owns the
      // per-pane debounce / coalescing / rate limit, so a trivial completion is still safe.
      announcementBus.enqueue({ kind: "completion", terminalId, summary: summaryText });
      paneSignalBus.publish({ paneId: terminalId, kind: "idle", detail: summaryText.slice(0, 160) });
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
    const detail = term?.lastCommand ? redact(term.lastCommand).slice(0, 80) : undefined;
    paneSignalBus.publish({ paneId: terminalId, kind: "running", detail });
    broadcast({ type: "pane_status", terminalId, status: "Running" });
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
      broadcast({ type: "watch_rules_updated", watchRules: manager.ledger.watchRules });
    }
  }

  function handlePlansTrigger(terminalId: string, transition: Transition) {
    const plans = manager.ledger.plans;
    let changed = false;
    for (const plan of plans) {
      if (plan.status === "running") {
        const currentStep = plan.steps[plan.currentStepIndex];
        if (currentStep && currentStep.status === "running" && currentStep.terminalId === terminalId) {
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
              // Prompt-composer refactor: a plan is an OUTLINE, not an execution engine. We do
              // NOT auto-advance by writing the next step into a pane. Mark the next step pending,
              // pause the plan awaiting the operator, and SURFACE it as a co-pilot suggestion the
              // operator can act on (gated, on the active pane). (architecture §5: Demote plans.)
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
              changed = true;
            } else {
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
              changed = true;
            }
          } else if (transition === "error" || transition === "build-failed" || transition === "exited") {
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
            changed = true;
          }
        }
      }
    }
    if (changed) {
      manager.ledger["save"](true);
      broadcast({ type: "plans_updated", plans: manager.ledger.plans });
    }
  }

  function detectAndTriggerTransitions(terminalId: string, cleanChunk: string) {
    const term = manager.terminals[terminalId];
    if (!term) return;

    let transition: Transition | null = null;
    if (term.status === "Exited") {
      transition = "exited";
    } else {
      const lower = cleanChunk.toLowerCase();
      if (
        lower.includes("failed to compile") ||
        lower.includes("build failed") ||
        lower.includes("modulenotfounderror") ||
        lower.includes("compile error") ||
        lower.includes("npm err!") ||
        lower.includes("failed to build") ||
        lower.includes("error: command failed") ||
        lower.includes("error: not found")
      ) {
        transition = "build-failed";
      } else if (
        cleanChunk.includes("Error:") ||
        cleanChunk.includes("Exception:") ||
        cleanChunk.includes("Stderr:") ||
        lower.includes("traceback") ||
        lower.includes("fatal: ")
      ) {
        transition = "error";
      } else if (term.status === "Idle") {
        // The busy/idle status is now owned by the authoritative state machine
        // (src/statusMachine.ts). Here we only refine an already-Idle pane into a
        // "prompt" attention if it looks like a shell prompt awaiting input —
        // using the shared SHELL_PROMPT regex from statusConstants.ts (I4: shell
        // panes only, never an interactive_cli TUI). This is an attention-label
        // concern independent of the idle decision. Otherwise we defer to "idle".
        const isShell = term.runtimeType === "shell";
        const tail = stripAnsiSequences(cleanChunk);
        if (isShell && SHELL_PROMPT.test(tail)) {
          transition = "prompt";
        } else {
          transition = "idle";
        }
      }
    }

    const previousState = lastStates[terminalId];
    if (transition && transition !== previousState) {
      lastStates[terminalId] = transition;
      console.log(`[TRANSITION] Terminal ${terminalId} transitioned: ${previousState || "none"} -> ${transition}`);

      broadcast({
        type: "pane_transition",
        terminalId,
        transition,
        message: `Pane ${terminalId} is now ${transition}.`
      });

      if (transition === "build-failed" || transition === "error" || transition === "exited") {
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

        // WS-D (BUG-024): high-severity proactive announcement (reuses the existing
        // lastStates edge-dedup, so this fires once per genuine transition edge).
        announcementBus.enqueue({ kind: transition, terminalId, summary: hint });
      }

      handleWatchRulesTrigger(terminalId, transition);
      handlePlansTrigger(terminalId, transition);
    }
  }

  const onOutput = (terminalId: string, chunk: string): void => {
    const term = manager.terminals[terminalId];
    if (term) {
      const cleanChunk = stripAnsiSequences(chunk);
      // QW5 (bead qw5): this runs on EVERY PTY data chunk. Each observation step is independent —
      // a throw from one bad chunk in any of them used to propagate out of the PTY data event,
      // crashing the process AND blinding the pane (the buffering/broadcast tail below never ran).
      // Guard each step in its own try/catch so one failing step neither kills the others nor blinds
      // the stream; log and continue. This is a net, not a behavior change.
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
    // because PTY is high-volume). Lets "what did the operator's command actually produce?" be
    // answered from the same stream as the voice/tool legs.
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
  };

  return { onOutput, onIdle, onRunning, onQuiescing };
}

// Re-export the secret redactor's identity for callers that want the same default `redact` the
// pipeline uses, without reaching into server.ts. (server.ts passes `redact: redactSecrets`.)
export { redactSecrets };
