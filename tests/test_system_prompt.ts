// sa4: the Janus Gemini voice SYSTEM PROMPT is editable from the Settings UI. The CONTRACT under
// test is: (1) {{placeholder}} token substitution, (2) operator-template override with fallback to
// DEFAULT, and (3) the DEFAULT carries every load-bearing identity + tool-name invariant the runtime
// depends on. These are CONTENT-AGNOSTIC structural guards PLUS content invariants — they do NOT pin
// the exact prose, so the prompt wording (rewritten by bead `cog`) can evolve freely as long as the
// token/builder contract and the load-bearing identity + tool surface remain intact.
//
// (History: the original sa4 plumbing guarded a BYTE-IDENTICAL pin to the pre-extraction inline
// literal. That pin became intentionally obsolete when `cog` rewrote the CONTENT, and is replaced
// below by invariant assertions on the rendered DEFAULT.)
//
// Runner: npx tsx --test --test-force-exit tests/test_system_prompt.ts

import { test } from "node:test";
import assert from "node:assert";
import { DEFAULT_SYSTEM_PROMPT, buildSystemInstruction } from "../src/voice/systemPrompt";

// --- Sample live values used across the substitution assertions -----------------------------------
const SAMPLE_ACTIVE_PROJECT_ID = "alpha-proj";
const SAMPLE_WORKSPACES = "alpha-proj (Alpha), beta-proj (Beta)";

// Every tool name the runtime wires to the voice model. If a rewrite drops or renames one of these in
// the prompt, the model loses the ability to invoke it — so these are load-bearing invariants, not
// prose. The PIN that used to assert byte-equality is GONE; THIS is what replaces it.
const LOAD_BEARING_TOOL_NAMES = [
  "list_panes",
  "propose_command",
  "agent_instruction",
  "update_draft_prompt",
  "list_pending_approvals",
  "switch_context",
  "close_pane",
  "stop_all",
  "confirm_stop_all",
  "release_stop_all",
];

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

test("DEFAULT teaches the Gemini/agy = Antigravity equivalence (demo 2026-08-18: 'a Gemini pane' guessed Codex)", () => {
  // Load-bearing content invariant, not prose: the operator says "Gemini" or "agy" for the
  // Antigravity preset. Without this the model has no mapping and substitutes another agent.
  assert.match(DEFAULT_SYSTEM_PROMPT, /Antigravity[^.\n]*(Gemini|agy)/i,
    "the prompt must state that Antigravity is the Gemini/agy CLI");
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

test("rendered DEFAULT holds the load-bearing identity + tool-surface invariants (cog rewrite)", () => {
  const rendered = buildSystemInstruction({
    activeProjectId: SAMPLE_ACTIVE_PROJECT_ID,
    workspaces: SAMPLE_WORKSPACES,
  });

  // Both tokens substitute and nothing leaks.
  assert.ok(rendered.includes(SAMPLE_ACTIVE_PROJECT_ID), "rendered DEFAULT must inject the live projectId");
  assert.ok(rendered.includes(SAMPLE_WORKSPACES), "rendered DEFAULT must inject the live workspaces list");
  assert.ok(!rendered.includes("{{") && !rendered.includes("}}"), "no placeholder token may leak through");

  // Identity invariants: the persona name and the EM framing that the product thesis depends on.
  assert.ok(rendered.includes("Project Janus"), "rendered DEFAULT must name 'Project Janus'");
  assert.ok(rendered.includes("Engagement Manager"), "rendered DEFAULT must carry the 'Engagement Manager' framing");

  // Persona/behavior invariants: the operating principle and the EM craft that ARE the point of cog.
  // A future rewrite that keeps the name + tool names but guts the persona should still fail here.
  assert.ok(
    rendered.includes("PROACTIVE IN THE WORK, REACTIVE IN THE TALK"),
    "rendered DEFAULT must state the core operating principle (proactive in the work, reactive in the talk)",
  );
  assert.ok(
    rendered.includes("BRIEF LIKE A PROMPT ENGINEER"),
    "rendered DEFAULT must keep the 'brief like a prompt engineer' move (the prompt-craft directive)",
  );
  // close_pane must carry its EXIT+ARCHIVE (recoverable) semantics, not merely the bare tool name —
  // that is what steers closure to close_pane instead of a shell 'exit'.
  assert.ok(
    rendered.includes("ARCHIVE") && rendered.includes("recoverable"),
    "rendered DEFAULT must describe close_pane's recoverable exit+archive semantics",
  );

  // Tool-surface invariants: every load-bearing tool name must be present so the model can call it.
  for (const tool of LOAD_BEARING_TOOL_NAMES) {
    assert.ok(rendered.includes(tool), `rendered DEFAULT must mention the '${tool}' tool`);
  }

  // The OLD TaskRabbit/relay framing must be GONE — the rewrite replaces "do the heavy lifting" and
  // "report back" with proactive EM ownership.
  assert.ok(!rendered.includes("do the heavy lifting"), "old 'do the heavy lifting' phrasing must be removed");
  assert.ok(!rendered.includes("report back"), "old 'report back' phrasing must be removed");
});

test("DEFAULT_SYSTEM_PROMPT carries the {{placeholder}} tokens (it is a template, not pre-rendered)", () => {
  assert.ok(DEFAULT_SYSTEM_PROMPT.includes("{{activeProjectId}}"), "{{activeProjectId}} placeholder present");
  assert.ok(DEFAULT_SYSTEM_PROMPT.includes("{{workspaces}}"), "{{workspaces}} placeholder present");
});
