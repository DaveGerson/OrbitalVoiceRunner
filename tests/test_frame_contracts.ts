// tests/test_frame_contracts.ts — bead wsm-e2e-pinned-ys8d: server<->frontend WS frame contract
// catalog + choke-point exhaustiveness.
//
// The server->client WS frames used to be scattered string-literal sends with nothing guaranteeing
// the two frontend dispatch tables (Kitchen's handleObserveFrame/handleVoiceFrame, the classic UI's
// WS_HANDLERS/eventBus) agree with what the server actually emits. This suite pins FOUR invariants:
//   1a. every frame type EMITTED anywhere in server.ts/src has a zod schema in the catalog.
//   1b. every dispatch-table key (Kitchen observe/voice) exists in the catalog.
//   1c. every catalog type is consumed by >=1 frontend surface, or is explicitly in UNCONSUMED_FRAME_TYPES.
//   1d. RAW-SEND GUARD: zero raw `.send(JSON.stringify({type:...` sites remain outside the
//       choke-point module (src/frames/catalog.ts) — the ratchet that keeps the catalog honest.
//
// Runner: npx tsx --test --test-force-exit tests/test_frame_contracts.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FRAME_SCHEMAS, UNCONSUMED_FRAME_TYPES, validateFrame } from "../src/frames/catalog";
import { OBSERVE_FRAME_TYPES, VOICE_FRAME_TYPES } from "../src/orbital/useOrbitalDataHelpers";
import { WS_HANDLERS } from "../src/appHelpers";
import { STATIC_EFFECTS } from "../src/eventBus";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// ─────────────────────────────────────────────────────────────────────────────────────────────
// § 1a — every EMITTED frame type has a catalog schema.
//
// This is the ground-truth enumeration produced by an exhaustive audit (STUDY FIRST, per the
// review that shipped this file): grep server.ts + src/**/*.ts for every `broadcast(`/
// `ctx.broadcast(`/`deps.broadcast(`/`this.broadcast(`/`clientWs.send(JSON.stringify(` call site
// and read each site's literal `type:` value. A hardcoded, cited list (rather than a generic
// regex re-scan here) because several sites build the frame indirectly — a returned object
// (src/gating/index.ts buildActionPendingBroadcast, src/voice/index.ts buildActionActivityFrame),
// a symbolic constant (src/gating/index.ts's `WS_EVT.AUTO_EXECUTED` etc.), or a passed-through
// variable (`broadcast(frame)`, `notifyPending: (frame) => ...`) — none of which a "simple regex"
// can safely resolve without false positives (e.g. AttentionItem's own unrelated `type: "idle"`
// field). The RAW-SEND GUARD below (1d) is the mechanical regex ratchet; this list is the
// hand-audited source of truth it's checked against.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const EMITTED_FRAME_TYPES = [
  // observe/board lane
  "stdout_chunk",                    // src/observe/index.ts:1005 (bufferAndScheduleFlush)
  "terminals_updated",               // server.ts (broadcastTerminalsUpdated caller sites), src/gating/index.ts:712, src/actionEffects.ts (many), src/applyPaneMode.ts:207
  "pane_status",                     // src/observe/index.ts:616 (onRunning)
  "pane_quiescing",                  // src/observe/index.ts:649 (onQuiescing)
  "pane_transition",                 // src/observe/index.ts:879 (detectAndTriggerTransitions)
  "draft_updated",                   // server.ts:1538 (broadcastDraft)
  "history_updated",                 // src/observe/index.ts:483 (computeIdleSummary)
  "ledger_updated",                  // server.ts:1644 (broadcastLedgerUpdate)
  "plans_updated",                   // src/observe/index.ts:749/831, src/actions/defs/orchestration.ts:87/219, watch_rules.ts:263, src/actionEffects.ts:484, src/gating/index.ts:827
  "attention_updated",               // src/observe/index.ts (many), src/actions/defs/orient.ts:321
  "templates_updated",               // src/actions/defs/templates.ts:103/158/204
  "layouts_updated",                 // src/actions/defs/layouts.ts:76/317
  "handoffs_updated",                // src/actions/defs/handoff.ts (7 sites): 235/295/363/555/651/657/668
  "settings_updated",                // server.ts:1249, src/actions/defs/locks.ts:66/421/776, orient.ts:348, src/actionEffects.ts:289/314, src/applyPaneMode.ts:206, src/dispatch/paneWrite.ts (via applyPaneMode)
  "switch_active_pane",              // src/actions/defs/voice_ux.ts:317, panes_write.ts:75/332, src/voice/focusResolver.ts:164
  "frozen",                          // src/gating/index.ts:849/917 (stopAll/releaseStopAll)
  "stop_all",                        // src/gating/index.ts:875 (stopAll kill:true)
  "approval_pending",                // src/dispatch/paneWrite.ts:304 (via conn.notifyPending — broadcast on REST, sendFrame on voice)
  "approval_resolved",               // src/gating/index.ts:1221 (WS_EVT.APPROVAL_RESOLVED), src/applyPaneMode.ts:108 (drainPaneOnPromotion)
  "action_pending",                  // src/actions/defs/promote.ts:116, src/gating/index.ts:665/1361/1367 (buildActionPendingBroadcast + last-call retry)
  "action_resolved",                 // src/actions/defs/approvals_rest.ts:142/178, src/voiceApprovalRouting.ts:104/112/121, src/voice/spokenConfirm.ts:116/122, src/gating/index.ts:1374 (sweep)
  "command_auto_executed",           // server.ts:1217, src/dispatch/paneWrite.ts:259, src/gating/index.ts:1108 (WS_EVT.AUTO_EXECUTED)
  "command_blocked",                 // src/dispatch/paneWrite.ts:219/222, src/gating/index.ts:1113/1119/1138 (WS_EVT.BLOCKED)
  "permission_changed",              // src/applyPaneMode.ts:208 (execute() success block — confirmed applied switch only)
  "proactive_notification",          // src/announcementBus.ts:322/338 (toNotification, flush())
  "proactive_earcon",                // src/announcementBus.ts:269 (deliver())
  "error",                           // src/voice/index.ts:813/2461/2519 (voice-socket-only)
  "daemon_state",                    // server.ts:1598
  "action_activity",                 // src/voice/index.ts:371/389 (buildActionActivityFrame/emitActionActivity, via the shared broadcast)
  "dispatch_updated",                // src/actions/defs/dispatch_group.ts:208, src/observe/index.ts:409
  "watch_rule_suggested",            // src/observe/index.ts:687 (handleWatchRulesTrigger)
  "plan_completed",                  // src/observe/index.ts:749 (completePlan)
  "plan_paused",                     // src/observe/index.ts:778 (failPlanStep)
  "plan_step_completed",             // src/observe/index.ts:798 (handlePlanStepEdge)
  "macros_updated",                  // src/actions/defs/macros.ts:110/157
  "pane_note",                       // src/actionEffects.ts:317 (restart-resume permission note)
  // voice socket lane (src/voice/index.ts, mostly single-client `clientWs.send`)
  "audio",                           // src/voice/index.ts:1991 (relayModelAudio)
  "interrupted",                     // src/voice/index.ts:2004 (relayInterruptAndTurnState)
  "transcript_text",                 // src/voice/index.ts:1869/1936
  "grounding",                       // src/voice/index.ts:1975 (handleGrounding)
  "voice_channel_lost",              // src/voice/index.ts:1541/1545/2479 (via the shared broadcast, all clients)
  "voice_channel_restored",          // src/voice/index.ts:2255 (via the shared broadcast, all clients)
  "stop_all_done",                   // src/voice/index.ts:2573/2576/2580/2605 (per-request voice-socket ack)
] as const;

describe("frame contracts — 1a: every emitted frame type has a catalog schema", () => {
  for (const type of EMITTED_FRAME_TYPES) {
    it(`"${type}" is in the catalog`, () => {
      assert.ok(
        Object.hasOwn(FRAME_SCHEMAS, type),
        `emitted frame type "${type}" has no schema in src/frames/catalog.ts FRAME_SCHEMAS`,
      );
    });
  }

  it("the catalog has no schema for a type that isn't actually emitted (and isn't a known " +
    "frontend-only / harness-only exception)", () => {
    // fleet_exchange_summary_updated is the one documented exception: the e2e-harness-only
    // synthetic frame Kitchen's handleObserveFrame handles but the real server never emits (see
    // its catalog comment). Everything else in the catalog must trace to a real emit site.
    const KNOWN_CONSUMER_ONLY = new Set(["fleet_exchange_summary_updated"]);
    const emitted = new Set<string>(EMITTED_FRAME_TYPES);
    for (const type of Object.keys(FRAME_SCHEMAS)) {
      if (KNOWN_CONSUMER_ONLY.has(type)) continue;
      assert.ok(emitted.has(type), `catalog type "${type}" is not in the audited EMITTED_FRAME_TYPES list — drift?`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// § 1b — every dispatch-table key (Kitchen observe/voice) exists in the catalog.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("frame contracts — 1b: dispatch-table keys exist in the catalog", () => {
  for (const type of OBSERVE_FRAME_TYPES) {
    it(`handleObserveFrame key "${type}" is in the catalog`, () => {
      assert.ok(Object.hasOwn(FRAME_SCHEMAS, type), `Kitchen's handleObserveFrame handles "${type}" but the catalog has no schema for it`);
    });
  }
  for (const type of VOICE_FRAME_TYPES) {
    it(`handleVoiceFrame key "${type}" is in the catalog`, () => {
      assert.ok(Object.hasOwn(FRAME_SCHEMAS, type), `Kitchen's handleVoiceFrame handles "${type}" but the catalog has no schema for it`);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// § 1c — every catalog type is consumed by >=1 frontend surface, or is in UNCONSUMED_FRAME_TYPES.
//
// "classic WS_HANDLERS" per the task is shorthand for the classic UI's REAL dispatch surface,
// which is WS_HANDLERS keys UNION the eventBus fallback dispatchWsMessage falls through to for
// any type not in WS_HANDLERS (src/appHelpers.ts dispatchWsMessage -> handleEventBusFallback ->
// src/eventBus.ts effectForEvent). effectForEvent's two payload-dependent arms (attention_updated,
// pane_transition — both already covered via Kitchen too) are switch cases, not STATIC_EFFECTS
// keys, so they're listed explicitly here, cited from eventBus.ts's own switch.
// ─────────────────────────────────────────────────────────────────────────────────────────────
const EVENTBUS_SWITCH_CASES = ["attention_updated", "pane_transition"] as const; // src/eventBus.ts effectForEvent()

describe("frame contracts — 1c: every catalog type is consumed or explicitly UNCONSUMED", () => {
  const consumed = new Set<string>([
    ...OBSERVE_FRAME_TYPES,
    ...VOICE_FRAME_TYPES,
    ...Object.keys(WS_HANDLERS),
    ...Object.keys(STATIC_EFFECTS),
    ...EVENTBUS_SWITCH_CASES,
  ]);

  for (const type of Object.keys(FRAME_SCHEMAS)) {
    it(`"${type}" is consumed by a frontend surface or listed UNCONSUMED with a reason`, () => {
      const isConsumed = consumed.has(type);
      const isDeclaredUnconsumed = Object.hasOwn(UNCONSUMED_FRAME_TYPES, type);
      assert.ok(
        isConsumed || isDeclaredUnconsumed,
        `catalog type "${type}" has no frontend consumer AND is not in UNCONSUMED_FRAME_TYPES — silent gap`,
      );
      // No double-booking: a type genuinely consumed by a frontend surface should not also be
      // parked in UNCONSUMED_FRAME_TYPES (that set is specifically for real gaps).
      if (isConsumed) {
        assert.ok(!isDeclaredUnconsumed, `"${type}" IS consumed by a frontend surface but is also listed in UNCONSUMED_FRAME_TYPES — remove the stale entry`);
      }
    });
  }

  it("every UNCONSUMED_FRAME_TYPES entry is a real catalog type", () => {
    for (const type of Object.keys(UNCONSUMED_FRAME_TYPES)) {
      assert.ok(Object.hasOwn(FRAME_SCHEMAS, type), `UNCONSUMED_FRAME_TYPES lists "${type}" but it has no catalog schema`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// § 1d — RAW-SEND GUARD: zero `clientWs.send(JSON.stringify({type:` sites remain outside the
// choke point.
//
// SCOPE (documented at src/frames/catalog.ts's header too): this guard targets direct single-socket
// SERVER-SIDE sends that bypass BOTH choke points (`broadcast()` and `sendFrame()`) — the actual
// bypass risk this catalog exists to close. It matches the SPECIFIC identifier
// (`clientWs`, the per-connection WS param name `wss.on("connection", (clientWs, req) => ...)`
// binds in src/voice/index.ts — the ONLY server-side file with direct single-socket sends; grep
// confirms it: server.ts and src/observe/index.ts have zero `.send(JSON.stringify(` sites, they
// route everything through `broadcast()`) rather than a generic `.send(JSON.stringify(` scan,
// because the latter also matches CLIENT-SIDE sends (the frontend sending set_active_pane/audio/
// pane_input/draft_edit frames TO the server over `ws`/`wsRef.current`/`socket` — the opposite
// direction, explicitly out of scope: "the server->client WS frames" per the task).
//
// It deliberately does NOT flag `broadcast(...)`/`ctx.broadcast(...)`/`deps.broadcast(...)`/
// `this.broadcast(...)` call sites: those all resolve to the ONE shared `broadcast` function
// (threaded through dependency injection, never reimplemented), which is itself hardened in place
// (server.ts calls assertValidFrameIfEnabled as its first line) — converting ~50 already-correct
// call sites across 15 files to a differently-named wrapper would be pure churn for zero behavior
// change, which the task's own sizing note explicitly allows against ("making the existing
// broadcast() itself the choke point is FINE and smaller").
// ─────────────────────────────────────────────────────────────────────────────────────────────
const RAW_SEND_PATTERN = /\bclientWs\.send\(\s*JSON\.stringify\(/;

// Files/dirs excluded from the walk entirely (not source, or not part of this seam).
const EXCLUDED_DIR_NAMES = new Set(["node_modules", "dist", ".git", "e2e", "python"]);

function walkTsFiles(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
      walkTsFiles(path.join(dir, entry.name), out);
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry.name)) out.push(path.join(dir, entry.name));
  }
}

describe("frame contracts — 1d: raw-send guard (the ratchet)", () => {
  it("no raw .send(JSON.stringify( frame-send site exists outside src/frames/catalog.ts", () => {
    const CHOKE_POINT_MODULE = path.resolve(REPO_ROOT, "src/frames/catalog.ts");
    const candidates: string[] = [path.resolve(REPO_ROOT, "server.ts")];
    walkTsFiles(path.resolve(REPO_ROOT, "src"), candidates);

    const offenders: string[] = [];
    for (const file of candidates) {
      if (path.resolve(file) === CHOKE_POINT_MODULE) continue; // the choke point's OWN implementation
      const text = fs.readFileSync(file, "utf8");
      const lines = text.split(/\r?\n/);
      lines.forEach((line, i) => {
        if (RAW_SEND_PATTERN.test(line)) offenders.push(`${path.relative(REPO_ROOT, file)}:${i + 1}: ${line.trim()}`);
      });
    }

    assert.deepStrictEqual(offenders, [], `found raw .send(JSON.stringify( site(s) bypassing the sendFrame choke point:\n${offenders.join("\n")}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// § Smoke: validateFrame accepts every cataloged type's minimal shape, and rejects an unknown type.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("frame contracts — validateFrame smoke", () => {
  for (const type of Object.keys(FRAME_SCHEMAS)) {
    it(`validateFrame accepts a bare {type: "${type}"} frame`, () => {
      assert.doesNotThrow(() => validateFrame({ type }));
    });
  }

  it("validateFrame rejects an unrecognized type", () => {
    assert.throws(() => validateFrame({ type: "not_a_real_frame_type" }));
  });

  it("validateFrame rejects a non-object frame", () => {
    assert.throws(() => validateFrame("not-a-frame"));
  });
});
