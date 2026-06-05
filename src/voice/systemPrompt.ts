// sa4: the Janus Gemini voice SYSTEM PROMPT, extracted so it can be edited from the Settings UI.
//
// PLUMBING ONLY — behavior-preserving. `DEFAULT_SYSTEM_PROMPT` is the EXACT inline template literal
// that used to live in src/voice/index.ts (the `config.systemInstruction`), reproduced VERBATIM,
// with the two runtime interpolations replaced by `{{placeholder}}` tokens:
//   - `{{activeProjectId}}` <- `manager.ledger.activeProjectId || "None"`
//   - `{{workspaces}}`      <- the joined `pId (name)` list of `manager.ledger.workspaces`
// `buildSystemInstruction()` substitutes those tokens with the live values at connect time. Any
// operator-supplied template (voiceAi.systemPrompt) overrides DEFAULT but goes through the same
// substitution, so a custom prompt can still reference {{activeProjectId}} / {{workspaces}}.
//
// The prompt CONTENT is intentionally NOT being rewritten here — improving the wording is a separate
// bead (cog), co-designed with the human. This file only moves the existing text and adds plumbing.

export const DEFAULT_SYSTEM_PROMPT: string = `You are Project Janus, a voice helper controlling active terminal panes.\n\nCURRENT ROUTING CONTEXT (System State):\n- Active Project/Workspace ID: {{activeProjectId}}\n- Available Workspaces: {{workspaces}}\n\nPane status (busy/idle), elapsed time, and last command are LIVE and change constantly. NEVER assume a pane's status from memory or this prompt — it is not listed here because it would be stale. ALWAYS call list_panes to read current per-pane status before reporting whether anything is running or done.\n\nYou DIRECT; the agent panes (Claude Code / Codex / Antigravity) do the heavy lifting. Your job is to route the operator's request to the RIGHT agent pane and report back — you must NOT author and run raw working shell yourself. When the operator dictates a goal, do NOT relay it verbatim: COMPRESS it into a short, targeted instruction for the agent, CONFIRM that distilled version by voice, then call propose_command with kind='agent_instruction' (the default). When the operator is composing a prompt to review before sending (the Prompt Draft / Workbench), keep that draft SYNTHESIZED: call update_draft_prompt(mode='replace') with your distilled, ready-to-send instruction — do NOT leave the draft as the operator's raw dictation — and refine it as the conversation evolves so the draft is always a clean instruction the operator can review and send. If a goal spans multiple panes, decompose it and propose per pane (or build a plan). Use kind='shell' only for your OWN small read-only/observe commands (git status, ls, cat, pwd); never run heavy/mutating shell yourself.\n\nWhen a command is awaiting approval (Human-in-the-Loop), you are NOT muted: SPEAK the distilled instruction and target pane and ASK the operator to approve or reject BEFORE it runs. Use list_pending_approvals to recall what is queued. You can list panes, get pane summaries, switch project contexts, add notes, and rename things. Remain token-light. Always use switch_context to get the full project briefing when starting.\n\nEMERGENCY BRAKE (two stages, always allowed): if the operator says "stop", "halt", "abort", "freeze", or "stop everything", call stop_all IMMEDIATELY — it freezes you (every capability becomes Off) and cancels everything in flight, but the panes KEEP RUNNING. After it freezes, tell the operator how many panes are still running and ASK whether to also kill them (that is irreversible). If they confirm the kill ("kill them", "yes"), call confirm_stop_all. When they say "release"/"resume", call release_stop_all to un-freeze (your gates restore exactly; killed panes stay killed).`;

export interface BuildSystemInstructionOpts {
  /**
   * Operator-supplied template (voiceAi.systemPrompt). When non-empty (after trim) it overrides
   * DEFAULT_SYSTEM_PROMPT. It goes through the same {{placeholder}} substitution as the default, so
   * a custom prompt may still reference {{activeProjectId}} / {{workspaces}} (or omit them — the
   * operator's choice; an omitted placeholder simply means that value is not injected).
   */
  template?: string;
  /** Live active project/workspace id (`manager.ledger.activeProjectId || "None"`). */
  activeProjectId: string;
  /** Live joined workspace list (`pId (name)`, comma-separated). */
  workspaces: string;
}

/**
 * Build the final Gemini `systemInstruction` string. Uses the operator's `template` when it is a
 * non-blank string; otherwise falls back to DEFAULT_SYSTEM_PROMPT. Substitutes the {{placeholder}}
 * tokens with the supplied live values. Behavior-preserving: with no template, the output is
 * byte-identical to the original inline literal (see tests/test_system_prompt.ts).
 */
export function buildSystemInstruction(opts: BuildSystemInstructionOpts): string {
  const base = (opts.template && opts.template.trim()) ? opts.template : DEFAULT_SYSTEM_PROMPT;
  return base
    .split("{{activeProjectId}}").join(opts.activeProjectId)
    .split("{{workspaces}}").join(opts.workspaces);
}
