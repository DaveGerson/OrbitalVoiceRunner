// tests/test_useorbitaldata_complexity_refactor.ts — CHARACTERIZATION tests for the cyclomatic-
// complexity burndown of src/orbital/useOrbitalData.ts (the orbital live-data hook). The over-limit
// functions (handleObserveFrame CC55, the voice ws.onmessage CC15, setGlobalMode/saveSettings/
// applyTemplate/saveLayout/applyLayout) were reduced by extracting their PURE decision logic — frame
// projection, transcript grounding, REST-narration ladders — into src/orbital/useOrbitalDataHelpers.ts.
// These tests import the REAL helpers and pin every branch they decompose so the behaviour-preserving
// refactor changes nothing observable: same projected shapes, same byte-exact toast strings, same
// fallbacks. Written to be GREEN against the helpers (which reproduce the original inline behaviour).
//
// PURE: imports ../src/orbital/useOrbitalDataHelpers ONLY (no React, no DOM, no fetch). The hook shell
// (sockets, setState, useEffect) is exercised by the e2e-live suite — out of scope here.
//
// Runner: npx tsx --test --test-force-exit tests/test_useorbitaldata_complexity_refactor.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  projectTemplatesFrame, historyEntriesFromFrame, draftTextFromFrame, shouldAdoptMute,
  buildPendingCommand, buildPendingAction, blockedToastText, attachGrounding,
  firstServerMessage, hasSettingsEcho, globalModeToast, resolvePaneCommand, paneSlug,
  layoutApplyToast, layoutSaveToast, templateClarifyText, templateApplyToast, layoutGatedText,
} from "../src/orbital/useOrbitalDataHelpers";

describe("projectTemplatesFrame", () => {
  it("returns null when the frame has no templates array (caller refetches)", () => {
    assert.strictEqual(projectTemplatesFrame({}), null);
    assert.strictEqual(projectTemplatesFrame({ templates: "nope" as unknown }), null);
  });
  it("filters rows missing a string id/body and re-derives slots from the body", () => {
    const out = projectTemplatesFrame({
      templates: [
        { id: "a", body: "Hello {{name}} and {{place}}", name: "Greet", description: "d", created_at: 5, updated_at: 6 },
        { id: 7, body: "bad-id" },            // dropped: non-string id
        { id: "b" },                          // dropped: no string body
        { id: "c", body: "no slots here" },   // kept: empty slots
      ],
    });
    assert.strictEqual(out!.length, 2);
    assert.deepStrictEqual(out![0], {
      id: "a", name: "Greet", description: "d", body: "Hello {{name}} and {{place}}",
      slots: ["name", "place"], created_at: 5, updated_at: 6,
    });
    // missing name/description/timestamps coerce to ""/0 (byte-exact with the inline map)
    assert.deepStrictEqual(out![1], {
      id: "c", name: "", description: "", body: "no slots here", slots: [], created_at: 0, updated_at: 0,
    });
  });
});

describe("historyEntriesFromFrame", () => {
  it("returns the array when present, null otherwise (refetch signal)", () => {
    const arr = [{ command: "ls", timestamp: "t", output: "o" }];
    assert.strictEqual(historyEntriesFromFrame({ history: arr } as never), arr as never);
    assert.strictEqual(historyEntriesFromFrame({}), null);
    assert.strictEqual(historyEntriesFromFrame({ history: "x" as unknown }), null);
  });
});

describe("draftTextFromFrame", () => {
  it("reads a string draft text, else empty string", () => {
    assert.strictEqual(draftTextFromFrame({ draft: { text: "hi" } }), "hi");
    assert.strictEqual(draftTextFromFrame({ draft: { text: 7 as unknown } }), "");
    assert.strictEqual(draftTextFromFrame({}), "");
    assert.strictEqual(draftTextFromFrame({ draft: {} }), "");
  });
});

describe("shouldAdoptMute", () => {
  it("adopts only a boolean that DIFFERS from current (guards the optimistic echo)", () => {
    assert.strictEqual(shouldAdoptMute(true, false), true);
    assert.strictEqual(shouldAdoptMute(false, true), true);
    assert.strictEqual(shouldAdoptMute(true, true), false);   // same → no bounce
    assert.strictEqual(shouldAdoptMute(false, false), false);
    assert.strictEqual(shouldAdoptMute("true" as unknown, false), false); // non-boolean ignored
    assert.strictEqual(shouldAdoptMute(undefined, false), false);
  });
});

describe("buildPendingCommand / buildPendingAction", () => {
  it("carries the broadcast payload fields verbatim into the chip", () => {
    const cmd = buildPendingCommand({
      messageId: "m1", cmd: "rm -rf", terminalId: "t1", rationale: { summary: "why" },
      effective_gates: { x: "Ask" }, posture: "GUARDED", effective_mode: "Human-in-the-Loop", capability: "write_to_pane",
    } as never) as unknown as Record<string, unknown>;
    assert.strictEqual(cmd.messageId, "m1");
    assert.strictEqual(cmd.terminalId, "t1");
    assert.strictEqual(cmd.posture, "GUARDED");
    assert.strictEqual(cmd.capability, "write_to_pane");
    const act = buildPendingAction({
      actionId: "a1", capability: "create_pane", summary: "spawn", effective_gate: "Ask",
      effective_mode: "Full Auto", posture: "OPEN", pane_id: "p1", requested_mode: "Read-Only", global_override: true,
    } as never) as unknown as Record<string, unknown>;
    assert.strictEqual(act.actionId, "a1");
    assert.strictEqual(act.pane_id, "p1");
    assert.strictEqual(act.global_override, true);
  });
});

describe("blockedToastText", () => {
  it("names pane + command, appends the reason only when a non-empty string", () => {
    assert.strictEqual(blockedToastText("t1", "git push", "policy"), "Held back on t1: git push — policy");
    assert.strictEqual(blockedToastText("t1", "git push", ""), "Held back on t1: git push");
    assert.strictEqual(blockedToastText("t1", "git push", undefined), "Held back on t1: git push");
    assert.strictEqual(blockedToastText("t1", "git push", 5 as unknown), "Held back on t1: git push");
  });
});

describe("attachGrounding", () => {
  const base = () => [
    { sender: "User", text: "q" },
    { sender: "Janus", text: "a1" },
    { sender: "Janus", text: "a2" },
  ];
  it("no-ops (returns same ref) when both sources and queries are empty", () => {
    const prev = base();
    assert.strictEqual(attachGrounding(prev, [], []), prev);
    assert.strictEqual(attachGrounding(prev, undefined, undefined), prev);
  });
  it("no-ops (same ref) when there is no Janus turn to attach to", () => {
    const prev = [{ sender: "User", text: "q" }];
    assert.strictEqual(attachGrounding(prev, ["s"], ["query"]), prev);
  });
  it("attaches to the LAST Janus turn, copying the array (immutably)", () => {
    const prev = base();
    const next = attachGrounding(prev, ["s1"], ["q1"]);
    assert.notStrictEqual(next, prev);              // new array
    assert.strictEqual(next[2].text, "a2");         // last Janus
    assert.deepStrictEqual((next[2] as unknown as { grounding: unknown }).grounding, { queries: ["q1"], sources: ["s1"] });
    assert.strictEqual((next[1] as { grounding?: unknown }).grounding, undefined); // earlier Janus untouched
    assert.strictEqual((prev[2] as { grounding?: unknown }).grounding, undefined); // original not mutated
  });
  it("coerces non-array sources/queries to [] (so one present still attaches)", () => {
    const prev = base();
    const next = attachGrounding(prev, ["only-source"], "not-an-array" as unknown);
    assert.deepStrictEqual((next[2] as unknown as { grounding: unknown }).grounding, { queries: [], sources: ["only-source"] });
  });
});

describe("firstServerMessage", () => {
  it("returns the first non-empty string among output, error, clarify (in that order)", () => {
    assert.strictEqual(firstServerMessage({ output: "o", error: "e", clarify: "c" }), "o");
    assert.strictEqual(firstServerMessage({ error: "e", clarify: "c" }), "e");
    assert.strictEqual(firstServerMessage({ clarify: "c" }), "c");
    assert.strictEqual(firstServerMessage({ output: "", error: "e" }), "e"); // empty string skipped
    assert.strictEqual(firstServerMessage({}), undefined);
    assert.strictEqual(firstServerMessage({ output: 5 as unknown }), undefined); // non-string skipped
  });
});

describe("hasSettingsEcho", () => {
  it("true only for a non-empty settings object (a thin ack can't wipe optimistic state)", () => {
    assert.strictEqual(hasSettingsEcho({ settings: { a: 1 } }), true);
    assert.strictEqual(hasSettingsEcho({ settings: {} }), false);   // empty → no adopt
    assert.strictEqual(hasSettingsEcho({ settings: null }), false);
    assert.strictEqual(hasSettingsEcho({}), false);
    assert.strictEqual(hasSettingsEcho(null), false);
  });
});

describe("globalModeToast", () => {
  it("byte-exact ternary copy for each mode", () => {
    assert.strictEqual(globalModeToast("Full Auto"), "Lettin' 'em cook 🔥");
    assert.strictEqual(globalModeToast("Read-Only"), "Hands off — watchin' the line");
    assert.strictEqual(globalModeToast("Human-in-the-Loop"), "Tastin' every plate 🛎");
    assert.strictEqual(globalModeToast("Inherit"), "Tastin' every plate 🛎"); // the else arm
  });
});

describe("resolvePaneCommand", () => {
  it("prefers a configured preset command", () => {
    assert.strictEqual(resolvePaneCommand("Claude Code", [{ name: "Claude Code", command: "my-claude" }]), "my-claude");
  });
  it("falls back to the built-in default per preset name", () => {
    assert.strictEqual(resolvePaneCommand("Claude Code", []), "claude");
    assert.strictEqual(resolvePaneCommand("Codex", undefined), "codex");
    assert.strictEqual(resolvePaneCommand("Antigravity", []), "antigravity");
    assert.strictEqual(resolvePaneCommand("Custom", []), undefined);
  });
  it("leaves an unknown preset unresolved for the server to derive", () => {
    assert.strictEqual(resolvePaneCommand("Mystery", []), undefined);
  });
  it("preserves a configured Custom command verbatim", () => {
    assert.strictEqual(resolvePaneCommand("Custom", [{ name: "Custom", command: "pwsh.exe" }]), "pwsh.exe");
    assert.strictEqual(resolvePaneCommand("Custom", [{ name: "Custom", command: "  pwsh.exe -NoLogo  " }]), "  pwsh.exe -NoLogo  ");
  });
  it("treats a configured whitespace-only command as unresolved", () => {
    assert.strictEqual(resolvePaneCommand("Custom", [{ name: "Custom", command: "   " }]), undefined);
  });
  it("a preset present but without a command falls through to the default map", () => {
    assert.strictEqual(resolvePaneCommand("Codex", [{ name: "Codex" }]), "codex");
  });
});

describe("paneSlug", () => {
  it("lowercases, dashes non-alnum, trims edge dashes, caps at 24", () => {
    assert.strictEqual(paneSlug("My Cool Pane!!"), "my-cool-pane");
    assert.strictEqual(paneSlug("  --Edge--  "), "edge");
    assert.strictEqual(paneSlug("a".repeat(40)), "a".repeat(24));
  });
  it("defaults to 'pane' when empty/undefined or all-symbol", () => {
    assert.strictEqual(paneSlug(undefined), "pane");
    assert.strictEqual(paneSlug(""), "pane");
    assert.strictEqual(paneSlug("***"), "pane");
  });
});

describe("layoutSaveToast", () => {
  it("'saved' narration earns the on-the-books ack (fire)", () => {
    assert.deepStrictEqual(layoutSaveToast({ output: "Layout saved" }, "Lunch"),
      { msg: "Layout 'Lunch' is on the books 🗺", kind: "fire" });
  });
  it("any other 200 body surfaces honestly as a warn (raw output, else generic)", () => {
    assert.deepStrictEqual(layoutSaveToast({ output: "no live panes" }, "Lunch"),
      { msg: "no live panes", kind: "warn" });
    assert.deepStrictEqual(layoutSaveToast({}, "Lunch"),
      { msg: "Couldn't save that layout, Chef — try again.", kind: "warn" });
  });
});

describe("layoutApplyToast", () => {
  it("'applied' output → fire + execute earcon", () => {
    assert.deepStrictEqual(layoutApplyToast({ output: "2 panes applied" }),
      { msg: "2 panes applied", kind: "fire", earcon: "execute" });
  });
  it("missing/empty output → the default applied copy (fire + execute)", () => {
    assert.deepStrictEqual(layoutApplyToast({}),
      { msg: "Layout applied 🔥", kind: "fire", earcon: "execute" });
    assert.deepStrictEqual(layoutApplyToast({ output: "" }),
      { msg: "Layout applied 🔥", kind: "fire", earcon: "execute" });
  });
  it("an ok-narration refusal (no 'applied') → warn + no earcon", () => {
    assert.deepStrictEqual(layoutApplyToast({ output: "not found" }),
      { msg: "not found", kind: "warn", earcon: undefined });
  });
});

describe("templateClarifyText", () => {
  it("uses the server clarify string, else the generic ask", () => {
    assert.strictEqual(templateClarifyText({ clarify: "need place" }), "need place");
    assert.strictEqual(templateClarifyText({}), "That template needs more values, Chef");
    assert.strictEqual(templateClarifyText({ clarify: "" }), "That template needs more values, Chef");
  });
});

describe("templateApplyToast", () => {
  it("'applied to pane' → filled-draft ack (fire), naming the pane", () => {
    assert.deepStrictEqual(templateApplyToast({ output: "applied to pane t1" }, "t1"),
      { msg: "Draft's filled on t1 — review it at the station 📝", kind: "fire" });
  });
  it("any other 200 → honest warn (raw output, else generic)", () => {
    assert.deepStrictEqual(templateApplyToast({ output: "pane not running" }, "t1"),
      { msg: "pane not running", kind: "warn" });
    assert.deepStrictEqual(templateApplyToast({}, "t1"),
      { msg: "Couldn't fill that draft, Chef — try again.", kind: "warn" });
  });
});

describe("layoutGatedText", () => {
  it("uses the server error reason, else the generic gated-off copy", () => {
    assert.strictEqual(layoutGatedText({ error: "recipe vetoed" }), "recipe vetoed");
    assert.strictEqual(layoutGatedText({}), "That layout's gated off, Chef");
    assert.strictEqual(layoutGatedText({ error: "" }), "That layout's gated off, Chef");
  });
});
