/**
 * tests/test_prompt_templates.ts — PROMPT TEMPLATES (journey-expansion work item B, spec §7).
 *
 * Three layers, all PTY-free / no server boot / no Gemini:
 *   (1) PURE ENGINE (src/templates.ts) — extractSlots (order of first appearance, dedup, whitespace
 *       inside braces, the [A-Za-z0-9_-]+ name charset), instantiateTemplate (fills provided values,
 *       reports missing, leaves unfilled slots VERBATIM, ignores extra values), valuesArrayToRecord
 *       (later-wins on duplicate names).
 *   (2) DEF HANDLERS (src/actions/defs/templates.ts) via the SAME runAction choke-point the voice +
 *       REST paths use, against a minimal stub ActionContext: create -> push + save(true) +
 *       templates_updated broadcast + slot-name narration; gate Off -> blocked; gate Ask (deferred)
 *       -> pending; update/delete UNKNOWN id -> ok narration BEFORE the gate (watch_rules Decision-2
 *       precedent — gateOrDefer must NOT be consulted); create -> list roundtrip on the fake ledger;
 *       apply_prompt_template -> instantiated text lands in setDraft (append mode -> appendDraft),
 *       missing slots -> clarify listing the names, unknown template -> ok narration, explicit
 *       pane_id resolves the project off manager.terminals[pane].projectId, no active pane -> ok.
 *   (3) REST PROJECTION — list_prompt_templates' rest.toHttp projects the RAW templates array
 *       top-level (the list_watch_rules precedent), [] on non-ok.
 *
 * Runner: npx tsx --test --test-force-exit tests/test_prompt_templates.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert";

import { extractSlots, instantiateTemplate, valuesArrayToRecord } from "../src/templates";
import { REGISTRY } from "../src/actions/registry";
import { runAction } from "../src/actions/gemini";
import type { ActionContext, ActionDef, GateDisposition } from "../src/actions/types";
import type { PromptTemplate } from "../src/types";

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (1) the pure engine
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe("templates engine — extractSlots", () => {
  it("returns slots in order of FIRST appearance, deduped", () => {
    const slots = extractSlots("A {{b}} then {{a}} then {{b}} again, then {{c}}.");
    assert.deepStrictEqual(slots, ["b", "a", "c"]);
  });

  it("tolerates whitespace inside the braces ({{ name }})", () => {
    assert.deepStrictEqual(extractSlots("hi {{ name }} and {{  other_one  }}"), ["name", "other_one"]);
  });

  it("dedups across whitespace variants of the SAME slot name", () => {
    assert.deepStrictEqual(extractSlots("{{x}} and {{ x }} and {{  x }}"), ["x"]);
  });

  it("matches ONLY the [A-Za-z0-9_-]+ charset (dots/spaces/empty are not slots)", () => {
    const slots = extractSlots("{{ok-name_1}} {{bad name}} {{x.y}} {{}} {{Z9}}");
    assert.deepStrictEqual(slots, ["ok-name_1", "Z9"]);
  });

  it("returns [] for a slot-free body", () => {
    assert.deepStrictEqual(extractSlots("no slots here, not even { single } braces"), []);
  });
});

describe("templates engine — instantiateTemplate", () => {
  it("fills every provided slot", () => {
    const r = instantiateTemplate("run {{cmd}} on {{branch}}", { cmd: "tests", branch: "main" });
    assert.strictEqual(r.text, "run tests on main");
    assert.deepStrictEqual(r.missing, []);
  });

  it("reports missing slots AND leaves them verbatim (whitespace form preserved)", () => {
    const r = instantiateTemplate("run {{cmd}} on {{ branch }}", { cmd: "tests" });
    assert.deepStrictEqual(r.missing, ["branch"]);
    // the unfilled slot survives byte-for-byte (the WHOLE match, including inner whitespace)
    assert.strictEqual(r.text, "run tests on {{ branch }}");
  });

  it("ignores extra values that match no slot", () => {
    const r = instantiateTemplate("just {{one}}", { one: "1", two: "2", three: "3" });
    assert.strictEqual(r.text, "just 1");
    assert.deepStrictEqual(r.missing, []);
  });

  it("fills a repeated slot at every occurrence", () => {
    const r = instantiateTemplate("{{x}} and {{x}} and {{ x }}", { x: "y" });
    assert.strictEqual(r.text, "y and y and y");
  });
});

describe("templates engine — valuesArrayToRecord", () => {
  it("normalizes the [{name,value}] shape; LATER wins on duplicate names", () => {
    const rec = valuesArrayToRecord([
      { name: "a", value: "first" },
      { name: "b", value: "only" },
      { name: "a", value: "second" },
    ]);
    assert.deepStrictEqual(rec, { a: "second", b: "only" });
  });

  it("returns {} for undefined / empty input", () => {
    assert.deepStrictEqual(valuesArrayToRecord(undefined), {});
    assert.deepStrictEqual(valuesArrayToRecord([]), {});
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (2) def handlers — minimal stub ActionContext through the real runAction choke-point
// ════════════════════════════════════════════════════════════════════════════════════════════════

interface CtxProbe {
  broadcasts: Array<Record<string, unknown>>;
  saveCalls: boolean[];
  gateCalls: Array<{ capability: string; paneId: string | null; summary: string }>;
  setDrafts: Array<{ projectId: string; paneId: string; text: string; who: string }>;
  appendDrafts: Array<{ projectId: string; paneId: string; text: string; who: string }>;
  draftBroadcasts: Array<{ projectId: string; paneId: string }>;
}

function makeCtx(opts?: {
  templates?: PromptTemplate[];
  /** What gateOrDefer answers (default: run — the effect executes inline). */
  gate?: GateDisposition;
  /** Live terminals keyed by pane id (apply's explicit pane_id resolution). */
  terminals?: Record<string, { projectId?: string }>;
  /** The operator's open pane (apply's default target); null = no pane open. */
  activeTarget?: { projectId: string; paneId: string } | null;
}): { ctx: ActionContext; probe: CtxProbe; templates: PromptTemplate[] } {
  const probe: CtxProbe = {
    broadcasts: [],
    saveCalls: [],
    gateCalls: [],
    setDrafts: [],
    appendDrafts: [],
    draftBroadcasts: [],
  };
  const templates = opts?.templates ?? [];
  const ledger = {
    promptTemplates: templates,
    save: (force: boolean): void => {
      probe.saveCalls.push(force);
    },
    setDraft: (projectId: string, paneId: string, text: string, who: string): void => {
      probe.setDrafts.push({ projectId, paneId, text, who });
    },
    appendDraft: (projectId: string, paneId: string, text: string, who: string): void => {
      probe.appendDrafts.push({ projectId, paneId, text, who });
    },
  };
  const ctx = {
    manager: { ledger, terminals: opts?.terminals ?? {} },
    session: null,
    redact: (s: string) => s,
    broadcast: (msg: unknown): void => {
      probe.broadcasts.push(msg as Record<string, unknown>);
    },
    gateOrDefer: (capability: string, paneId: string | null, summary: string, run: () => string): GateDisposition => {
      probe.gateCalls.push({ capability, paneId, summary });
      const g = opts?.gate ?? { disposition: "run" as const };
      // faithful to the real choke-point: "run" means the caller executes the effect itself;
      // deferred stages the closure (NOT run here); forbidden never runs it.
      void run;
      return g;
    },
    activeDraftTarget: (): { projectId: string; paneId: string } | null => opts?.activeTarget ?? null,
    broadcastDraft: (projectId: string, paneId: string): void => {
      probe.draftBroadcasts.push({ projectId, paneId });
    },
    // PHASE 2: apply_prompt_template now Off-vetoes on the veto-class compose_draft capability.
    // Default Auto keeps these tests behavior-preserving (the gate never bites here).
    effectiveCapabilityGateFor: (): "Auto" | "Ask" | "Off" => "Auto",
  } as unknown as ActionContext;
  return { ctx, probe, templates };
}

function seedTemplate(over?: Partial<PromptTemplate>): PromptTemplate {
  return {
    id: "tpl_seed1",
    name: "review",
    description: "code review brief",
    body: "Review the {{branch}} branch focusing on {{focus}}.",
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

describe("create_prompt_template — gated update_metadata", () => {
  it("create (gate run): pushes + save(true) + templates_updated broadcast; narration names the slots", async () => {
    const { ctx, probe, templates } = makeCtx();
    const result = await runAction(
      REGISTRY,
      "create_prompt_template",
      { name: "review", body: "Review {{branch}} for {{focus}}" },
      ctx
    );
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(templates.length, 1, "the template was pushed onto the ledger array");
    assert.strictEqual(templates[0].name, "review");
    assert.ok(probe.saveCalls.includes(true), "create must persist via ledger.save(true)");
    assert.ok(
      probe.broadcasts.some((m) => m.type === "templates_updated"),
      "create must broadcast templates_updated"
    );
    const out = (result as { output: string }).output;
    assert.ok(out.includes("branch") && out.includes("focus"), `narration must name the slots (got: ${out})`);
  });

  it("create -> list roundtrip: list_prompt_templates surfaces the saved template with DERIVED slots", async () => {
    const { ctx, templates } = makeCtx();
    await runAction(REGISTRY, "create_prompt_template", { name: "r", body: "do {{a}} then {{b}}" }, ctx);
    assert.strictEqual(templates.length, 1);
    const list = await runAction(REGISTRY, "list_prompt_templates", {}, ctx);
    assert.strictEqual(list.kind, "ok");
    const out = (list as { output: { count: number; templates: Array<{ id: string; slots: string[] }> } }).output;
    assert.strictEqual(out.count, 1);
    assert.strictEqual(out.templates[0].id, templates[0].id);
    assert.deepStrictEqual(out.templates[0].slots, ["a", "b"], "slots are derived from the body, never stored");
  });

  it("gate Off (forbidden) -> kind blocked; NOTHING saved or broadcast", async () => {
    const { ctx, probe, templates } = makeCtx({ gate: { disposition: "forbidden" } });
    const result = await runAction(REGISTRY, "create_prompt_template", { name: "x", body: "b" }, ctx);
    assert.strictEqual(result.kind, "blocked");
    assert.strictEqual(templates.length, 0, "Off must not push the template");
    assert.strictEqual(probe.saveCalls.length, 0, "Off must not persist");
    assert.strictEqual(probe.broadcasts.length, 0, "Off must not broadcast");
  });

  it("gate Ask (deferred) -> kind pending with the staged actionId/summary; nothing saved yet", async () => {
    const { ctx, templates } = makeCtx({
      gate: { disposition: "deferred", actionId: "act-1", summary: "Save prompt template 'x'" },
    });
    const result = await runAction(REGISTRY, "create_prompt_template", { name: "x", body: "b" }, ctx);
    assert.strictEqual(result.kind, "pending");
    assert.strictEqual((result as { messageId: string }).messageId, "act-1");
    assert.strictEqual((result as { summary: string }).summary, "Save prompt template 'x'");
    assert.strictEqual(templates.length, 0, "Ask defers — the push runs only on confirm");
  });
});

describe("update/delete unknown id — ok narration BEFORE the gate (Decision-2 precedent)", () => {
  it("update_prompt_template unknown id -> ok 'not found' WITHOUT consulting gateOrDefer", async () => {
    const { ctx, probe } = makeCtx();
    const result = await runAction(
      REGISTRY,
      "update_prompt_template",
      { template_id: "tpl_ghost", name: "new" },
      ctx
    );
    assert.strictEqual(result.kind, "ok");
    assert.ok(String((result as { output: unknown }).output).includes("not found"));
    assert.strictEqual(probe.gateCalls.length, 0, "an unknown-id no-op must never reach the gate");
  });

  it("delete_prompt_template unknown id -> ok 'not found' WITHOUT consulting gateOrDefer", async () => {
    const { ctx, probe } = makeCtx();
    const result = await runAction(REGISTRY, "delete_prompt_template", { template_id: "tpl_ghost" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.ok(String((result as { output: unknown }).output).includes("not found"));
    assert.strictEqual(probe.gateCalls.length, 0, "an unknown-id no-op must never reach the gate");
  });
});

describe("apply_prompt_template — instantiate into the WIP draft (ungated compose_draft)", () => {
  it("fills the slots and lands the INSTANTIATED text in setDraft for the active pane (+ draft broadcast)", async () => {
    const { ctx, probe } = makeCtx({
      templates: [seedTemplate()],
      activeTarget: { projectId: "projA", paneId: "pane1" },
    });
    const result = await runAction(
      REGISTRY,
      "apply_prompt_template",
      {
        template_id: "tpl_seed1",
        values: [
          { name: "branch", value: "auth-fix" },
          { name: "focus", value: "error handling" },
        ],
      },
      ctx
    );
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(probe.setDrafts.length, 1, "replace mode writes through setDraft");
    assert.deepStrictEqual(probe.setDrafts[0], {
      projectId: "projA",
      paneId: "pane1",
      text: "Review the auth-fix branch focusing on error handling.",
      who: "janus",
    });
    assert.strictEqual(probe.appendDrafts.length, 0, "replace mode must not append");
    assert.deepStrictEqual(probe.draftBroadcasts, [{ projectId: "projA", paneId: "pane1" }]);
  });

  it("mode:'append' uses appendDraft instead of setDraft", async () => {
    const { ctx, probe } = makeCtx({
      templates: [seedTemplate({ body: "extra: {{thing}}" })],
      activeTarget: { projectId: "projA", paneId: "pane1" },
    });
    const result = await runAction(
      REGISTRY,
      "apply_prompt_template",
      { template_id: "tpl_seed1", values: [{ name: "thing", value: "tests" }], mode: "append" },
      ctx
    );
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(probe.appendDrafts.length, 1, "append mode writes through appendDraft");
    assert.strictEqual(probe.appendDrafts[0].text, "extra: tests");
    assert.strictEqual(probe.setDrafts.length, 0, "append mode must not replace");
  });

  it("missing slot values -> kind clarify LISTING the missing names (never guesses)", async () => {
    const { ctx, probe } = makeCtx({
      templates: [seedTemplate()],
      activeTarget: { projectId: "projA", paneId: "pane1" },
    });
    const result = await runAction(
      REGISTRY,
      "apply_prompt_template",
      { template_id: "tpl_seed1", values: [{ name: "branch", value: "main" }] },
      ctx
    );
    assert.strictEqual(result.kind, "clarify");
    assert.ok((result as { text: string }).text.includes("focus"), "clarify must list the missing slot names");
    assert.strictEqual(probe.setDrafts.length + probe.appendDrafts.length, 0, "no draft write on clarify");
  });

  it("unknown template id -> ok narration (no clarify dead-end, no draft write)", async () => {
    const { ctx, probe } = makeCtx({ activeTarget: { projectId: "projA", paneId: "pane1" } });
    const result = await runAction(REGISTRY, "apply_prompt_template", { template_id: "tpl_ghost" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.ok(String((result as { output: unknown }).output).includes("not found"));
    assert.strictEqual(probe.setDrafts.length, 0);
  });

  it("explicit pane_id resolves the project off manager.terminals[pane].projectId", async () => {
    const { ctx, probe } = makeCtx({
      templates: [seedTemplate({ body: "no slots" })],
      terminals: { px: { projectId: "projX" } },
      // the active pane is DIFFERENT — explicit pane_id must win
      activeTarget: { projectId: "projA", paneId: "pane1" },
    });
    const result = await runAction(REGISTRY, "apply_prompt_template", { template_id: "tpl_seed1", pane_id: "px" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.strictEqual(probe.setDrafts.length, 1);
    assert.strictEqual(probe.setDrafts[0].projectId, "projX", "project resolved from the live terminal");
    assert.strictEqual(probe.setDrafts[0].paneId, "px");
  });

  it("explicit pane_id that is NOT running -> ok narration, no draft write", async () => {
    const { ctx, probe } = makeCtx({ templates: [seedTemplate({ body: "no slots" })], terminals: {} });
    const result = await runAction(
      REGISTRY,
      "apply_prompt_template",
      { template_id: "tpl_seed1", pane_id: "ghost-pane" },
      ctx
    );
    assert.strictEqual(result.kind, "ok");
    assert.ok(String((result as { output: unknown }).output).includes("not running"));
    assert.strictEqual(probe.setDrafts.length, 0);
  });

  it("no active pane (and no pane_id) -> ok narration, no draft write", async () => {
    const { ctx, probe } = makeCtx({ templates: [seedTemplate({ body: "no slots" })], activeTarget: null });
    const result = await runAction(REGISTRY, "apply_prompt_template", { template_id: "tpl_seed1" }, ctx);
    assert.strictEqual(result.kind, "ok");
    assert.ok(String((result as { output: unknown }).output).includes("No pane is open"));
    assert.strictEqual(probe.setDrafts.length, 0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (3) REST projection — list def's rest.toHttp projects the RAW templates array
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe("list_prompt_templates — rest.toHttp raw-array projection", () => {
  function findDef(name: string): ActionDef {
    const def = REGISTRY.find((d) => d.name === name);
    assert.ok(def, `registry must contain ${name}`);
    return def!;
  }

  it("ok result -> 200 with the templates array TOP-LEVEL (not wrapped in {output})", () => {
    const def = findDef("list_prompt_templates");
    assert.ok(def.rest?.toHttp, "list_prompt_templates must declare rest.toHttp");
    const tpls = [{ id: "tpl_1", name: "r", slots: ["a"] }];
    const { status, body } = def.rest!.toHttp!({ kind: "ok", output: { count: 1, templates: tpls } }, {});
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, tpls, "the RAW array is the body");
  });

  it("non-ok result -> 200 with []", () => {
    const def = findDef("list_prompt_templates");
    const { status, body } = def.rest!.toHttp!({ kind: "error", message: "boom" }, {});
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(body, []);
  });

  it("binds GET /api/templates on the rest surface", () => {
    const def = findDef("list_prompt_templates");
    assert.ok(def.surfaces.has("rest"));
    assert.strictEqual(def.rest!.method, "get");
    assert.strictEqual(def.rest!.path, "/api/templates");
  });
});
