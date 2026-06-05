// sa4: the Janus Gemini voice SYSTEM PROMPT is now editable from the Settings UI. This is
// PLUMBING ONLY and MUST be behavior-preserving — DEFAULT_SYSTEM_PROMPT is the OLD inline literal
// VERBATIM with {{placeholder}} tokens where it interpolated the live values, and
// buildSystemInstruction() substitutes those tokens.
//
// The decisive guard here is the BEHAVIOR-PRESERVING PIN: a frozen copy of the ORIGINAL inline
// template literal (with the SAME sample values the old code interpolated) must equal, byte for
// byte, what the new builder produces from DEFAULT_SYSTEM_PROMPT. That equality is the proof there
// is NO behavior change in the prompt sent to Gemini.
//
// Runner: npx tsx --test --test-force-exit tests/test_system_prompt.ts

import { test } from "node:test";
import assert from "node:assert";
import { DEFAULT_SYSTEM_PROMPT, buildSystemInstruction } from "../src/voice/systemPrompt";

// --- Sample live values used across the pin/substitution assertions -------------------------------
const SAMPLE_ACTIVE_PROJECT_ID = "alpha-proj";
const SAMPLE_WORKSPACES = "alpha-proj (Alpha), beta-proj (Beta)";

// FROZEN ORACLE: this is the ORIGINAL inline `systemInstruction` template literal from
// src/voice/index.ts (pre-sa4), reproduced VERBATIM, with the two interpolations expressed as plain
// JS template substitutions of the SAME sample values. If sa4 changed even one byte of the prompt,
// the byte-equality assertion below fails. DO NOT edit this to make the test pass — it is the oracle.
const ORIGINAL_LITERAL_OUTPUT = `You are Project Janus, a voice helper controlling active terminal panes.\n\nCURRENT ROUTING CONTEXT (System State):\n- Active Project/Workspace ID: ${SAMPLE_ACTIVE_PROJECT_ID}\n- Available Workspaces: ${SAMPLE_WORKSPACES}\n\nPane status (busy/idle), elapsed time, and last command are LIVE and change constantly. NEVER assume a pane's status from memory or this prompt — it is not listed here because it would be stale. ALWAYS call list_panes to read current per-pane status before reporting whether anything is running or done.\n\nYou DIRECT; the agent panes (Claude Code / Codex / Antigravity) do the heavy lifting. Your job is to route the operator's request to the RIGHT agent pane and report back — you must NOT author and run raw working shell yourself. When the operator dictates a goal, do NOT relay it verbatim: COMPRESS it into a short, targeted instruction for the agent, CONFIRM that distilled version by voice, then call propose_command with kind='agent_instruction' (the default). When the operator is composing a prompt to review before sending (the Prompt Draft / Workbench), keep that draft SYNTHESIZED: call update_draft_prompt(mode='replace') with your distilled, ready-to-send instruction — do NOT leave the draft as the operator's raw dictation — and refine it as the conversation evolves so the draft is always a clean instruction the operator can review and send. If a goal spans multiple panes, decompose it and propose per pane (or build a plan). Use kind='shell' only for your OWN small read-only/observe commands (git status, ls, cat, pwd); never run heavy/mutating shell yourself.\n\nWhen a command is awaiting approval (Human-in-the-Loop), you are NOT muted: SPEAK the distilled instruction and target pane and ASK the operator to approve or reject BEFORE it runs. Use list_pending_approvals to recall what is queued. You can list panes, get pane summaries, switch project contexts, add notes, and rename things. Remain token-light. Always use switch_context to get the full project briefing when starting.\n\nEMERGENCY BRAKE (two stages, always allowed): if the operator says "stop", "halt", "abort", "freeze", or "stop everything", call stop_all IMMEDIATELY — it freezes you (every capability becomes Off) and cancels everything in flight, but the panes KEEP RUNNING. After it freezes, tell the operator how many panes are still running and ASK whether to also kill them (that is irreversible). If they confirm the kill ("kill them", "yes"), call confirm_stop_all. When they say "release"/"resume", call release_stop_all to un-freeze (your gates restore exactly; killed panes stay killed).`;

test("buildSystemInstruction with NO template returns DEFAULT with the live values substituted", () => {
  const out = buildSystemInstruction({
    activeProjectId: SAMPLE_ACTIVE_PROJECT_ID,
    workspaces: SAMPLE_WORKSPACES,
  });
  // The live values are injected...
  assert.ok(out.includes(SAMPLE_ACTIVE_PROJECT_ID), "output must contain the live projectId");
  assert.ok(out.includes(SAMPLE_WORKSPACES), "output must contain the live workspaces list");
  // ...and NO placeholder tokens leak through.
  assert.ok(!out.includes("{{"), "no '{{' placeholder may remain in the rendered instruction");
  assert.ok(!out.includes("}}"), "no '}}' placeholder may remain in the rendered instruction");
});

test("buildSystemInstruction uses a CUSTOM template when one is provided (with substitution)", () => {
  const out = buildSystemInstruction({
    template: "custom {{activeProjectId}}",
    activeProjectId: "P",
    workspaces: "ignored",
  });
  assert.strictEqual(out, "custom P", "custom template overrides DEFAULT and substitutes placeholders");
});

test("a blank/whitespace custom template falls back to DEFAULT", () => {
  const blank = buildSystemInstruction({ template: "   ", activeProjectId: "P", workspaces: "W" });
  assert.ok(blank.startsWith("You are Project Janus"), "whitespace-only template falls back to DEFAULT");
});

test("BEHAVIOR-PRESERVING PIN: DEFAULT, substituted, equals the ORIGINAL inline literal byte-for-byte", () => {
  const rendered = buildSystemInstruction({
    activeProjectId: SAMPLE_ACTIVE_PROJECT_ID,
    workspaces: SAMPLE_WORKSPACES,
  });
  assert.strictEqual(
    rendered,
    ORIGINAL_LITERAL_OUTPUT,
    "the rendered DEFAULT prompt MUST be byte-identical to the original inline literal — no behavior change",
  );
});

test("DEFAULT_SYSTEM_PROMPT carries the {{placeholder}} tokens (it is a template, not pre-rendered)", () => {
  assert.ok(DEFAULT_SYSTEM_PROMPT.includes("{{activeProjectId}}"), "{{activeProjectId}} placeholder present");
  assert.ok(DEFAULT_SYSTEM_PROMPT.includes("{{workspaces}}"), "{{workspaces}} placeholder present");
});
