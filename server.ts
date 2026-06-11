import express from "express";
import path from "path";
import fs from "fs";
import { GoogleGenAI, Type } from "@google/genai";
import { WebSocketServer } from "ws";
import http from "http";
import dotenv from "dotenv";
import crypto from "crypto";
import { OrchestratorManager, UniversalTerminal, stripAnsiSequences, redactSecrets, classifySecrets, normalizePreset, presetCommand } from "./src/terminal";
import { registerHistoryBridge } from "./src/historyBridge";
import { PaneSignalBus } from "./src/paneSignalBus";
import { AnnouncementBus, pruneAttentionQueue, DEFAULT_ANNOUNCEMENT_TEMPLATES } from "./src/announcementBus";
import {
  PendingApprovalStore,
  // c55.15: serializePending moved into the list_pending_commands registry def (its toHttp maps the array).
  // c55.9: the PURE [decide] half of the pane-write pipe — the SAME resolver the voice wrapper calls
  // (src/voice/index.ts) — so the REST dispatchProposal wrapper shares ONE decision, no duplication.
  decideProposal,
  inferKind,
} from "./src/pendingApprovals";
// c55.9: the SHARED [apply effect] dispatch core (extracted in step 1). The REST dispatchProposal
// wrapper below binds the three connection-bound values (sess:null, notify=broadcast, guard:false,
// origin:"rest") — byte-identical engine to the voice wrapper, two bindings.
import { applyDispatchDecision } from "./src/dispatch/paneWrite";
import { JanusStore } from "./src/store/sqliteStore";
import { deliverOutcomeToHandoff } from "./src/handoffFlow";
// c55 + concurrent multi-cli merge: c55 dropped restGateOutcome from create_pane/recipes (now registry-
// served via resultToHttp status-via-kinds), but it is RETAINED because the concurrent /api/terminals/:id/
// raw-input route below uses it for the gated Shift+Tab disposition. classifyRawKey + isPaneActiveForWrite
// serve that same raw-input route.
import { restGateOutcome } from "./src/restGate";
import { classifyRawKey, isKnownRawKey } from "./src/rawKeyClass";
import { isBlankApiKey, shouldNudgeReconnectOnSettingsKey } from "./src/voiceResumption";
import { isPaneActiveForWrite } from "./src/activePane";
import { planRecipeApply } from "./src/recipeApply";
import { migrateOnBootIfNeeded, initStoreWithQuarantine } from "./src/store/migrate";
import type { CapabilityGate } from "./src/types";
import { resolveProjectDir, isBadProjectDir } from "./src/projectDir";
import { z } from "zod";
import { REGISTRY, actionSchemaHash } from "./src/actions/registry";
import { CAPABILITY_DEFS } from "./src/actions/capabilities";
import { runAction, resultToToolResponse, toGeminiDeclarations } from "./src/actions/gemini";
import type { ActionContext } from "./src/actions/types";
import { mountRestRoutes, resultToHttp, type RestApp, type RestRequest, type RestResponse } from "./src/actions/rest";
import { InteractionLogger, createFileInteractionSink, NOOP_SINK } from "./src/interactionLog";
import { createCoreState } from "./src/core/coreState";
import { attachObserve } from "./src/observe";
import { createMemoryService, createPythonSynthClient, defaultModuleDir, type PythonSynthClient } from "./src/memory";
import { createGating } from "./src/gating";
import { attachVoiceSession, pushApprovalNarration } from "./src/voice";

dotenv.config();

const PORT = Number(process.env.PORT) || 3000;

// ── Correlated interaction log (Issue #1 instrumentation + "capture voice/thinking/actions/system,
// analyzed together") ───────────────────────────────────────────────────────────────────────────
// Append-only JSONL: every leg of an operator TURN (voice_in -> gemini_thinking/text -> tool_call ->
// action_result -> approval -> pty) is one redacted line keyed by a shared interaction_id, so a whole
// turn is reconstructable (scripts/analyze-interactions.ts) — and the approve→dispatch lag of Issue #1
// becomes visible in the per-leg timestamps. Always on; JANUS_INTERACTION_LOG=off disables, or set a
// path to relocate. JANUS_DEBUG_VOICE additionally echoes legs to stderr AND enables the (higher-
// volume) pty leg.
const INTERACTION_LOG_PATH = process.env.JANUS_INTERACTION_LOG ?? ".janus_interaction_log.jsonl";
const VOICE_TRACE = !!process.env.JANUS_DEBUG_VOICE && process.env.JANUS_DEBUG_VOICE !== "0";
const interactionSink =
  INTERACTION_LOG_PATH.toLowerCase() === "off" ? NOOP_SINK : createFileInteractionSink(INTERACTION_LOG_PATH);
const interactionLog = new InteractionLogger({
  sink: (line) => {
    interactionSink(line);
    if (VOICE_TRACE) console.error("[VOICE-TRACE]", line);
  },
  redact: redactSecrets,
});
// Best-effort PTY attribution: the active turn's id, mirrored to module scope so manager.onOutput
// (server-scope, not per-connection) can tag terminal output with the turn it most likely belongs to.
let lastInteractionId: string | null = null;

// Automatic session secret token loaded from env or generated cryptographically fresh on boot.
// Exported so in-process integration tests can authenticate without guessing the token.
export const API_AUTH_TOKEN = process.env.API_AUTH_TOKEN || crypto.randomBytes(32).toString("hex");

// ── 2S.2: PUT /api/settings body validation ──────────────────────────────────────────────────────
// The settings body stays a PERMISSIVE passthrough overall (settings carry many shapes — do NOT
// enumerate the world), but the fields that drive GATE DECISIONS are strict when present:
//   - advanced.globalPermissionsMode must be a REAL mode (a garbage value used to be assigned
//     verbatim AND persisted, so every later gate decision compared against an unknown mode);
//   - advanced.capabilityGates values must be Auto/Ask/Off on KNOWN capability keys. Unknown keys
//     are STRIPPED (forward compat: an older server accepting a newer client), never a 400.
// A non-object body is a 400 (it used to throw a 500 deeper in updateSettings).
const SettingsGateValueSchema = z.enum(["Auto", "Ask", "Off"]);
const SettingsGlobalModeSchema = z.enum(["Full Auto", "Human-in-the-Loop", "Read-Only", "Inherit"]);
const KNOWN_CAPABILITY_IDS: ReadonlySet<string> = new Set(CAPABILITY_DEFS.map((d) => d.id));

/** Validate (and forward-compat-strip) a PUT /api/settings body IN PLACE. Returns a 400-able error
 *  naming the offending field, or ok. Pure over everything except the unknown-gate-key strip.
 *  (Uniform shape, not a discriminated union — this tsconfig is non-strict, so `!r.ok` would not narrow.) */
export function validateSettingsPutBody(body: unknown): { ok: boolean; error?: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "Settings body must be a JSON object." };
  }
  const advanced = (body as Record<string, unknown>).advanced;
  if (advanced === undefined) return { ok: true };
  if (typeof advanced !== "object" || advanced === null || Array.isArray(advanced)) {
    return { ok: false, error: "Invalid settings field 'advanced': expected an object." };
  }
  const adv = advanced as Record<string, unknown>;
  if (adv.globalPermissionsMode !== undefined &&
      !SettingsGlobalModeSchema.safeParse(adv.globalPermissionsMode).success) {
    return {
      ok: false,
      error: `Invalid settings field 'advanced.globalPermissionsMode': must be one of ${SettingsGlobalModeSchema.options.join(", ")}.`,
    };
  }
  const gates = adv.capabilityGates;
  if (gates !== undefined) {
    if (typeof gates !== "object" || gates === null || Array.isArray(gates)) {
      return { ok: false, error: "Invalid settings field 'advanced.capabilityGates': expected an object map of capability -> Auto|Ask|Off." };
    }
    const gateMap = gates as Record<string, unknown>;
    for (const key of Object.keys(gateMap)) {
      if (!KNOWN_CAPABILITY_IDS.has(key)) {
        delete gateMap[key]; // unknown capability row: strip, don't 400 (forward compat).
        continue;
      }
      if (!SettingsGateValueSchema.safeParse(gateMap[key]).success) {
        return {
          ok: false,
          error: `Invalid settings field 'advanced.capabilityGates.${key}': must be one of ${SettingsGateValueSchema.options.join(", ")}.`,
        };
      }
    }
  }
  return { ok: true };
}

// The Gemini Live session is created through this seam so tests and the offline
// simulator can swap in a fake session (no API key, no microphone) that still
// drives the real tool-dispatch / approval code paths in this file.
//
// The optional `key` is the RESOLVED operator API key for this attempt, threaded so the REAL
// connector can pre-validate it (bead 9fz). Test/mock connectors installed via setLiveConnector
// ignore it — that is HOW installMockLive() keeps connecting keylessly while the real path
// short-circuits a blank key (see realLiveConnector below).
export type LiveConnector = (ai: GoogleGenAI, params: any, key?: string | null) => Promise<any>;

// bead 9fz: the DEFAULT (real) connector. Pre-validate a BLANK key HERE — at the real-connector
// boundary — so we never fire a keyless ai.live.connect() that can only close with 1007 ("API key
// not valid"), wasting a handshake and a bounded reconnect-budget slot. This deliberately lives in
// the connector, NOT in connectLiveSession: installMockLive() replaces this connector wholesale and
// connects with NO key, so the mock harness stays functional while only the real path short-circuits.
export const realLiveConnector: LiveConnector = (ai, params, key) => {
  if (isBlankApiKey(key)) {
    // Reject WITHOUT touching ai.live.connect — connectLiveSession's catch turns this into a clean
    // "set a key in Settings" error frame instead of a 1007 round-trip. (Never log the key.)
    return Promise.reject(new Error("No Gemini API key is configured — set one in Settings to start voice."));
  }
  return ai.live.connect(params);
};
let liveConnector: LiveConnector = realLiveConnector;
export function setLiveConnector(fn: LiveConnector) {
  liveConnector = fn;
}
/** Read the currently-installed connector (tests assert the mock path stays functional). */
export function getLiveConnector(): LiveConnector {
  return liveConnector;
}

// bead 9fz (part 2): the settings PUT nudges the live voice session to (re)connect when the operator
// sets a NON-EMPTY Gemini key, so they need not reload. The current voice connection registers its
// reconnect closure here (via attachVoiceSession's registerReconnectNudge dep); the settings handler
// invokes it. Module-scoped (one active operator connection at a time, same model as activeFrontendWs).
let voiceReconnectNudge: (() => void) | null = null;
// bead 53q: the registry is single-slot but two voice WS connections can briefly overlap (the new one
// connects before the old one's close fires). Without an owner token, the LATER connection's close
// (which calls setVoiceReconnectNudge(null)) would clear the SURVIVING connection's nudge. We tag the
// nudge with its owner; a clear only takes effect when the caller IS the current owner, so a stale/
// foreign connection's close can never poke the live one's nudge. YAGNI: still one active slot — this
// is just defensive identity, NOT multi-session fan-out.
let voiceReconnectNudgeOwner: unknown = null;
/**
 * Register/clear the live voice session's reconnect closure (called by attachVoiceSession).
 * Registering a non-null fn takes ownership. Clearing (fn === null) only takes effect when `owner`
 * matches the CURRENT owner — a stale connection clearing its own nudge after a newer one registered
 * is a no-op. `owner` is optional for back-compat (single-connection test seams pass none, which still
 * register/clear the same undefined-owned slot).
 */
export function setVoiceReconnectNudge(fn: (() => void) | null, owner?: unknown) {
  if (fn === null) {
    // Identity-guarded clear: only the current owner may clear the active nudge.
    if (owner === voiceReconnectNudgeOwner) {
      voiceReconnectNudge = null;
      voiceReconnectNudgeOwner = null;
    }
    return;
  }
  voiceReconnectNudge = fn;
  voiceReconnectNudgeOwner = owner;
}
/** Nudge the live voice session to (re)connect, if one is wired. Never throws. */
export function requestVoiceReconnect() {
  try { voiceReconnectNudge?.(); } catch (e) { console.warn("[VOICE] reconnect nudge threw (ignored):", e); }
}

// PLM4 (Finding A): the per-session GoogleGenAI client (built from the operator's key) is constructed
// through this seam so a test can simulate the PRE-TRY setup throwing (e.g. a malformed-but-present
// key making `new GoogleGenAI(...)` throw) BEFORE connectLiveSession's own try — the never-throw hole
// the initial-connect wrap now closes. Prod default just constructs the real client. Returns the
// SDK client to use; `fallback` is the server's shared `ai` (used when there is no per-session key).
export type SessionAiFactory = (key: string, fallback: GoogleGenAI) => GoogleGenAI;
let sessionAiFactory: SessionAiFactory = (key, fallback) =>
  key
    ? new GoogleGenAI({ apiKey: key, httpOptions: { headers: { "User-Agent": "aistudio-build" } } })
    : fallback;
export function setSessionAiFactory(fn: SessionAiFactory) {
  sessionAiFactory = fn;
}
/** Restore the default (real) session-AI factory. Tests call this in their teardown. */
export function resetSessionAiFactory() {
  sessionAiFactory = (key, fallback) =>
    key
      ? new GoogleGenAI({ apiKey: key, httpOptions: { headers: { "User-Agent": "aistudio-build" } } })
      : fallback;
}
console.log("-----------------------------------------------------------------");
console.log(`[SECURITY] Session API Authentication Token generated.`);
console.log("-----------------------------------------------------------------");

function getCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";");
  for (const cookie of cookies) {
    const parts = cookie.trim().split("=");
    if (parts[0] === name) {
      return parts.slice(1).join("=");
    }
  }
  return null;
}

// Returns a deep copy of `settings` with the Gemini API key masked, safe to send to
// any client (REST response or WS broadcast). The masking matches GET /api/settings so
// the key is never shipped in plaintext over the `settings_updated` broadcast. PUT
// restores the real key server-side when it sees a masked/blank value coming back.
function sanitizeSettingsForClient<T extends { secrets?: { geminiApiKey?: string } }>(settings: T): T {
  const sanitized = JSON.parse(JSON.stringify(settings)) as T;
  const key = sanitized.secrets?.geminiApiKey;
  if (key && key !== "CONFIGURED_IN_ENV" && key.length > 8) {
    sanitized.secrets!.geminiApiKey = key.substring(0, 6) + "••••••••" + key.substring(key.length - 4);
  }
  return sanitized;
}

export interface HistoryEntry {
  command: string;
  timestamp: string;
  output: string;
  finalResponse?: string;
}

// 4E.1: HistoryManager used to fs.readFileSync + JSON.parse the WHOLE multi-pane
// .janus_history.json, mutate, JSON.stringify(...,null,2) + writeFileSync — on EVERY PTY
// data chunk (src/observe/index.ts onOutput → appendOutputToLastCommand). A chatty pane
// was continuous O(file-size) synchronous I/O blocking the loop that serves voice/WS/HTTP,
// and the write was non-atomic. Mutations now land in an in-memory DIRTY cache and flush
// DEBOUNCED (JANUS_HISTORY_FLUSH_MS, default 500ms after the last mutation, with a
// JANUS_HISTORY_FLUSH_MAX_MS = 2s maximum linger so a perpetually-chatty pane still
// persists), ASYNC (fs.promises), and ATOMIC (write tmp + rename). loadHistory serves
// dirty panes from the cache, so a read after a write but before the flush is NEVER stale.
// The on-disk format is unchanged (operators may have tooling): one pretty-printed JSON
// object keyed by terminalId. The flush MERGES over the on-disk file so foreign pane keys
// written by the inline action-def ports (src/actions/defs/{reads,panes_rest,handoff}.ts)
// survive. server close() awaits flushAll(); an abrupt kill loses at most the linger
// window (~2s) of output tail — history is a display/recall buffer, not a ledger.
export class HistoryManager {
  private static instance: HistoryManager;

  // Flush policy (env-tunable so the unit suite can compress the windows).
  private readonly flushDebounceMs = Math.max(10, Number(process.env.JANUS_HISTORY_FLUSH_MS) || 500);
  private readonly flushMaxLingerMs = Math.max(
    this.flushDebounceMs,
    Number(process.env.JANUS_HISTORY_FLUSH_MAX_MS) || 2000,
  );

  // Per-file (cwd can change across in-process test servers) dirty state:
  // filePath -> terminalId -> the latest pruned entries awaiting flush. saveHistory always
  // installs a FRESH array, so reference equality tells the flusher whether a key was
  // re-dirtied while an async flush was in flight.
  private dirty = new Map<string, Map<string, HistoryEntry[]>>();
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private firstDirtyAt = new Map<string, number>();
  private flushChain = new Map<string, Promise<void>>();
  private tmpSeq = 0;

  private constructor() {}

  public static getInstance(): HistoryManager {
    if (!HistoryManager.instance) {
      HistoryManager.instance = new HistoryManager();
    }
    return HistoryManager.instance;
  }

  private getFilePath(): string {
    return path.join(process.cwd(), ".janus_history.json");
  }

  private getLimits() {
    const maxCmds = manager.settings?.advanced?.historyMaxCommands ?? 50;
    const maxOutput = manager.settings?.advanced?.historyMaxOutputLength ?? 5000;
    return { maxCmds, maxOutput };
  }

  /** Parse the on-disk multi-pane map; {} on missing/corrupt (legacy loadHistory behavior). */
  private readFileMap(filePath: string): Record<string, HistoryEntry[]> {
    try {
      if (fs.existsSync(filePath)) {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, HistoryEntry[]>;
        }
      }
    } catch (e) {
      // Return empty if file not found or corrupted
    }
    return {};
  }

  public loadHistory(terminalId: string): HistoryEntry[] {
    const filePath = this.getFilePath();
    const { maxCmds } = this.getLimits();
    // Dirty-first: an unflushed mutation must be visible immediately (never stale).
    // Entries are copied so callers mutating the result (addCommand/onIdle) can't alias
    // the cache — exactly the isolation the per-call JSON.parse used to provide.
    const dirty = this.dirty.get(filePath)?.get(terminalId);
    if (dirty) return dirty.slice(-maxCmds).map(entry => ({ ...entry }));
    const list = this.readFileMap(filePath)[terminalId];
    return Array.isArray(list) ? list.slice(-maxCmds) : [];
  }

  public saveHistory(terminalId: string, history: HistoryEntry[]): void {
    const filePath = this.getFilePath();
    const { maxCmds, maxOutput } = this.getLimits();
    const pruned = history.slice(-maxCmds).map(entry => ({
      ...entry,
      output: (entry.output || "").slice(-maxOutput)
    }));
    let perFile = this.dirty.get(filePath);
    if (!perFile) {
      perFile = new Map();
      this.dirty.set(filePath, perFile);
    }
    perFile.set(terminalId, pruned);
    this.scheduleFlush(filePath);
  }

  public addCommand(terminalId: string, command: string) {
    const history = this.loadHistory(terminalId);
    const newEntry: HistoryEntry = {
      command,
      timestamp: new Date().toISOString(),
      output: ""
    };
    history.push(newEntry);
    this.saveHistory(terminalId, history);
  }

  public appendOutputToLastCommand(terminalId: string, chunk: string) {
    const history = this.loadHistory(terminalId);
    if (history.length > 0) {
      const lastEntry = history[history.length - 1];
      const { maxOutput } = this.getLimits();
      lastEntry.output = ((lastEntry.output || "") + chunk).slice(-maxOutput);
      this.saveHistory(terminalId, history);
    }
  }

  /** Clear ONE pane's history — in the dirty cache AND (via the flush) on disk. Installing an
   *  empty dirty array means the clear WINS over any entries already pending flush, closing the
   *  review-flagged race where a def-level direct file clear was resurrected by a pending flush. */
  public clearHistory(terminalId: string): void {
    this.saveHistory(terminalId, []);
  }

  /** Debounce per file; the max-linger deadline caps how long a chatty pane can defer. */
  private scheduleFlush(filePath: string): void {
    const now = Date.now();
    if (!this.firstDirtyAt.has(filePath)) this.firstDirtyAt.set(filePath, now);
    const lingerDeadline = this.firstDirtyAt.get(filePath)! + this.flushMaxLingerMs;
    const delay = Math.max(0, Math.min(this.flushDebounceMs, lingerDeadline - now));
    const prev = this.debounceTimers.get(filePath);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      void this.flushFile(filePath);
    }, delay);
    timer.unref?.(); // never holds the process open; close() flushes the remainder
    this.debounceTimers.set(filePath, timer);
  }

  /** Serialize flushes per file (a rename racing a rename is how files get corrupted). */
  private flushFile(filePath: string): Promise<void> {
    const prev = this.flushChain.get(filePath) ?? Promise.resolve();
    const next = prev
      .then(() => this.doFlush(filePath))
      .catch((e) => {
        // Same failure posture as the legacy writer: warn and keep serving from memory
        // (the dirty entries survive, so the next mutation/flush retries).
        console.warn(`[HistoryManager] Failed to save history to ${filePath}:`, e);
      });
    this.flushChain.set(filePath, next);
    return next;
  }

  private async doFlush(filePath: string): Promise<void> {
    const perFile = this.dirty.get(filePath);
    if (!perFile || perFile.size === 0) {
      this.firstDirtyAt.delete(filePath);
      return;
    }
    const snapshot = new Map(perFile); // terminalId -> array reference at flush time
    this.firstDirtyAt.delete(filePath); // mutations during the flush open a new linger window

    // Merge over the on-disk file so out-of-band writers' OTHER pane keys survive.
    let allHistory: Record<string, HistoryEntry[]> = {};
    try {
      const data = await fs.promises.readFile(filePath, "utf-8");
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) allHistory = parsed;
    } catch {
      // missing/corrupt file: start fresh (legacy behavior)
    }
    for (const [terminalId, entries] of snapshot) allHistory[terminalId] = entries;

    // Atomic: write a unique sibling tmp, then rename over the live file.
    const tmpPath = `${filePath}.${process.pid}.${++this.tmpSeq}.tmp`;
    await fs.promises.writeFile(tmpPath, JSON.stringify(allHistory, null, 2), "utf-8");
    try {
      await fs.promises.rename(tmpPath, filePath);
    } catch (e) {
      try { await fs.promises.unlink(tmpPath); } catch { /* best-effort cleanup */ }
      throw e;
    }

    // Clear ONLY keys not re-dirtied during the async write (saveHistory always installs
    // a new array, so reference equality is exact).
    for (const [terminalId, entries] of snapshot) {
      if (perFile.get(terminalId) === entries) perFile.delete(terminalId);
    }
    if (perFile.size === 0) this.dirty.delete(filePath);
  }

  /** Flush every pending mutation now — the server close() path. */
  public async flushAll(): Promise<void> {
    const files = new Set([...this.dirty.keys(), ...this.debounceTimers.keys()]);
    for (const timer of this.debounceTimers.values()) clearTimeout(timer);
    this.debounceTimers.clear();
    await Promise.all([...files].map((filePath) => this.flushFile(filePath)));
  }
}

// Register the singleton on the history bridge so the action defs (which cannot import server.ts
// without booting a listener) route reads/writes/clears through the SAME dirty cache instead of
// racing the debounced flush with direct file I/O (review block on PR #68).
registerHistoryBridge(HistoryManager.getInstance());

// WS-M/Handoffs: the persistent JanusStore (SQLite). better-sqlite3 loads cleanly under tsx
// (confirmed by the store unit tests + smoke), so a static import is fine here — unlike node-pty
// which the transport layer loads via createRequire. init() applies migrations (idempotent);
// bootMaintenance() prunes stale rows/scrollback. Created BEFORE the manager so it can serve as
// the manager's ledger backend when the cutover flag is on.
// 3V.5: store-init failure used to SILENTLY fall back to the legacy JSON ledger — but a previous
// boot's migration already renamed .janus_ledger.json to .bak (and LEDGER_MIGRATED_KEY blocks any
// re-import), so a corrupt .janus.db booted the app EMPTY on legacy and stranded every new write.
// initStoreWithQuarantine instead renames the bad DB (plus -wal/-shm twins) to .janus.db.corrupt-<ts>
// (loudly, recoverably) and retries ONCE with a fresh DB; only if THAT also fails do we fall back to
// legacy — and we say so.
let store: JanusStore | null = null;
{
  const storeInit = initStoreWithQuarantine(process.env.JANUS_DB || ".janus.db", (s) => {
    s.init();
    s.bootMaintenance({
      now: Date.now(),
      eventsTtlDays: 30,
      archiveTtlDays: 14,
      scrollbackDirs: [process.cwd()],
    });
  });
  store = storeInit.store;
  if (store) {
    console.log(`[STORE] JanusStore initialized (handoffs + capability-gate audit)${storeInit.quarantinedTo ? ` — FRESH DB after quarantining the corrupt one to ${storeInit.quarantinedTo}` : ""}.`);

    // One-shot, gated, reversible JSON→SQLite ledger migration. Runs at most once
    // (guarded by an in-DB marker set INSIDE the import transaction — 3V.5), only if a legacy
    // .janus_ledger.json exists, and renames the originals to .bak (strictly after the commit) so
    // the operator can verify/rollback. Idempotent across restarts even though .janus.db already
    // exists for the handoff store. An EXISTING-but-unparseable ledger now THROWS into this catch
    // (3V.5) — which leaves the JSON file untouched at its live path (no rename, no marker).
    try {
      const migrated = migrateOnBootIfNeeded(store, {
        ledgerPath: process.env.JANUS_LEDGER_PATH || ".janus_ledger.json",
        settingsPath: ".janus_settings.json",
        historyPath: ".janus_history.json",
      });
      if (migrated) console.log("[STORE] Migrated legacy JSON ledger → SQLite (originals renamed to .bak).");
    } catch (e) {
      console.error("[STORE] Ledger migration skipped (import failed; legacy JSON left intact):", e);
    }
  } else {
    console.error("[STORE] JanusStore unavailable even after the quarantine retry — falling back to the legacy JSON ledger; HANDOFF PERSISTENCE IS DISABLED for this run.");
  }
}

// WS-M cutover seam (design §5.3). The store satisfies LedgerLike, so it IS the
// manager's ledger — making drafts/context/approvals/etc. durable across restart.
// DEFAULT: SQLite (when the store booted). Escape hatch: JANUS_LEDGER_BACKEND=legacy
// forces the in-memory/JSON Ledger. If the store failed to boot, we fall back to
// legacy automatically so the app still runs.
const forceLegacy = process.env.JANUS_LEDGER_BACKEND === "legacy";
const useSqliteLedger = store !== null && !forceLegacy;
export const manager = new OrchestratorManager(useSqliteLedger ? { ledger: store! } : undefined);
console.log(useSqliteLedger
  ? "[STORE] OrchestratorManager ledger backend: SQLite (durable). Set JANUS_LEDGER_BACKEND=legacy to opt out."
  : `[STORE] OrchestratorManager ledger backend: legacy JSON Ledger${forceLegacy ? " (JANUS_LEDGER_BACKEND=legacy)" : " (store unavailable)"}.`);

// `store` is a process-wide singleton: created once here at import and SHARED by every
// startServer() call. Releasing it is therefore a PROCESS-level concern, not a per-server one —
// closing it inside an individual server's close() would pull the shared DB handle out from under
// any sibling server still running in the same process (e.g. multiple in-process test suites under
// `tsx --test`, which previously made test_live_harness flake at the file level). We close it
// exactly once, synchronously, on process exit: better-sqlite3 writes are already durable
// per-statement, so this is pure handle cleanup, and a synchronous close in the 'exit' handler
// finishes before teardown — avoiding the UV_HANDLE_CLOSING abort that a still-in-flight close hit.
process.once("exit", () => { try { store?.close(); } catch { /* best-effort handle cleanup */ } });

// QW1 — process-level error net (bead qw1). This orchestrator drives PTYs and a Gemini Live
// socket; a throw at an async edge (a PTY data event, a Gemini callback) surfaces here as an
// uncaughtException, and a dropped promise as an unhandledRejection. Without a net, either one
// tears the whole voice channel down. This is a GUARD, not a framework: structured-log and keep
// running. We do NOT force a crash exit on a recoverable rejection — the existing
// process.once("exit") already closes the store, so this is best-effort. Installed ONCE at module
// scope (not inside startServer, which is re-invoked per in-process test server and would otherwise
// accumulate listeners and trip Node's MaxListeners warning).
export const __processSafety = { unhandledRejections: 0, uncaughtExceptions: 0 };
let __processNetInstalled = false;
function installProcessErrorNet(): void {
  if (__processNetInstalled) return;
  __processNetInstalled = true;
  process.on("unhandledRejection", (reason: unknown) => {
    __processSafety.unhandledRejections++;
    console.error("[PROCESS-SAFETY] unhandledRejection (recovered, not exiting):", reason);
    // Best-effort net: do NOT process.exit() — a dropped promise must not kill the voice channel.
  });
  process.on("uncaughtException", (err: unknown) => {
    __processSafety.uncaughtExceptions++;
    console.error("[PROCESS-SAFETY] uncaughtException (recovered, not crashing):", err);
    // Best-effort net: keep the loop alive. The process.once("exit") handler closes the store on a
    // real exit; we deliberately do not force one here on a single recoverable throw.
  });
}
installProcessErrorNet();
// Test-only seam: re-attach the net after a suite has temporarily detached process listeners to
// isolate the handler under test. Idempotent — only attaches handlers that are not already present.
export function __installProcessErrorNetForTest(): void {
  __processNetInstalled = false;
  installProcessErrorNet();
}

// Prompt-composer refactor (step 6): the single global prompt buffer is gone. Each pane now keeps
// its OWN persistent WIP draft in the ledger (PaneMeta.draft), composed against the active pane.

export interface StartServerOptions {
  /** Port to bind. Use 0 for an ephemeral port (handy in tests). Defaults to PORT (3000). */
  port?: number;
  /** Host to bind. Defaults to 0.0.0.0 in production, 127.0.0.1 otherwise. */
  bindHost?: string;
  /** Mount the Vite dev middleware. Defaults to true outside production. Disable in tests. */
  enableVite?: boolean;
  /** Actually call server.listen(). Defaults to true. */
  listen?: boolean;
}

export interface RunningServer {
  app: express.Express;
  server: http.Server;
  wss: WebSocketServer;
  manager: OrchestratorManager;
  /** The actually-bound port (resolved even when port 0 was requested). */
  port: number;
  /** Stop the HTTP/WS servers and tear down all live terminals. */
  close: () => Promise<void>;
  /** QW3 test seam: read the hoisted live session (null === no voice channel). NOT for prod use. */
  _testActiveLiveSession?: () => any;
  /** QW3 test seam: read the pending-approval store (for survivor/detach assertions). */
  _testPendingApprovals?: () => PendingApprovalStore;
  /** QW6 test seam: the broadcast client set (for dead-socket pruning assertions). NOT for prod use. */
  _testClients?: () => Set<any>;
  /** Active-pane-guard test seam: pin coreState.activePaneId (the UI's set_active_pane WS effect)
   *  so REST suites can assert the single-active-pane refusal without a live socket. NOT for prod use. */
  _testSetActivePane?: (id: string | null) => void;
  /** bead 9fz test seam: register/clear a spy reconnect-nudge so a settings-PUT suite can assert the
   *  non-empty-key trigger without a live Gemini socket. NOT for prod use. */
  _testSetReconnectNudge?: (fn: (() => void) | null) => void;
}

async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const enableVite = options.enableVite ?? process.env.NODE_ENV !== "production";
  const shouldListen = options.listen ?? true;

  // Snapshot the live-session connector for THIS server instance. `liveConnector` is a module-level
  // seam (setLiveConnector); reading it late, at WS-connect time, let a sibling in-process server's
  // installMockLive() clobber the global between this server's boot and a client connecting — so a
  // session created here would be recorded into the WRONG mock handle, and that suite's
  // `waitFor(mock.latest())` would time out (the test_live_harness file-level flake under parallel
  // `tsx --test`). Binding it synchronously at startServer() time — there is no await between a
  // suite's installMockLive() and its startServer() call — pins each server to its own connector.
  const boundLiveConnector = liveConnector;
  // PLM4 (Finding A): snapshot the session-AI factory for THIS server too (same pinning rationale as
  // boundLiveConnector) so a sibling test server cannot redirect our pre-try client construction.
  const boundSessionAiFactory = sessionAiFactory;

  const app = express();
  app.use(express.json());

  // Automatically seed the httpOnly SameSite API cookie on core layout/page renders
  app.use((req, res, next) => {
    if (!req.path.startsWith("/api") && !req.path.startsWith("/live")) {
      const currentToken = getCookie(req.headers.cookie, "auth_token");
      if (currentToken !== API_AUTH_TOKEN) {
        res.cookie("auth_token", API_AUTH_TOKEN, {
          httpOnly: true,
          sameSite: "strict",
          secure: process.env.NODE_ENV === "production"
        });
      }
    }
    next();
  });

  const authMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const tokenFromCookie = getCookie(req.headers.cookie, "auth_token");
    const tokenFromHeader = req.headers["x-api-token"]?.toString() || req.headers["authorization"]?.toString().replace(/^Bearer\s+/, "");
    
    if (tokenFromCookie === API_AUTH_TOKEN || tokenFromHeader === API_AUTH_TOKEN) {
      next();
    } else {
      res.status(401).json({ error: "Unauthorized: Invalid or missing API security token. Reload your interface." });
    }
  };

  app.use("/api", authMiddleware);

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/live" });

  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });

  // Push-observation: one bus per server; each /live connection subscribes its session.
  const paneSignalBus = new PaneSignalBus();

  // dec-2 (DBT5): the PTY observation/trigger pipeline (summarizeCommandOutcome, onIdle,
  // handleWatchRulesTrigger, handlePlansTrigger, detectAndTriggerTransitions, onOutput) moved to
  // src/observe/index.ts. attachObserve(...) is invoked below — AFTER broadcast / announcementBus /
  // pruneAttention are constructed — and its returned handlers are assigned to manager.onOutput /
  // manager.onIdle there. (The handlers are late-bound closures, exactly as the inline assignments
  // were, so the call must follow the deps it captures.)

  // dec-1 (DBT5): the shared mutable runtime state — coreState.activeFrontendWs, coreState.activeLiveSession, the broadcast
  // client set, coreState.activePaneId (the single write-target source of truth), the STOP-ALL `frozen` freeze
  // (durably persisted, restored from the kv on construction), and coreState.lastStopAllFailed — hoisted into ONE
  // shared object so the domains later carved out of this file (observe/gating/voice) mutate the SAME
  // cells via their injected deps bag rather than closing over server-local `let`s. Mutate `frozen`
  // ONLY via coreState.setFrozen so persistence stays coupled. See src/core/coreState.ts.
  const coreState = createCoreState(store);

  function broadcast(msg: any) {
    const data = JSON.stringify(msg);
    for (const client of coreState.clients) {
      if (client.readyState === 1) { // OPEN
        try {
          client.send(data);
        } catch (e) {
          // QW6 (bead qw6): a send that throws means the socket is dead. Drop it from the set so the
          // next broadcast doesn't re-throw on the same corpse (and the set doesn't leak); the
          // matching clientWs.on("close") cleanup may never have fired for an abrupt break.
          console.error("Failed to send socket broadcast:", e);
          coreState.clients.delete(client);
        }
      }
    }
  }

  // Step 6 (the Workbench): per-pane WIP draft helpers. The draft is composed against the ACTIVE
  // pane (single source of truth, step 5); composing/editing it is not a CLI write and is ungated.
  function activeDraftTarget(): { projectId: string; paneId: string } | null {
    if (!coreState.activePaneId) return null;
    return { projectId: manager.ledger.activeProjectId || "default_project", paneId: coreState.activePaneId };
  }
  function broadcastDraft(projectId: string, paneId: string) {
    const draft = manager.ledger.getDraft(projectId, paneId) ?? { text: "", updatedAt: new Date().toISOString() };
    broadcast({ type: "draft_updated", projectId, paneId, draft });
  }
  function appendActiveDraft(line: string, updatedBy: "janus" | "operator") {
    const t = activeDraftTarget();
    if (!t) return; // no active pane -> nowhere to compose (step 5)
    manager.ledger.appendDraft(t.projectId, t.paneId, line, updatedBy);
    broadcastDraft(t.projectId, t.paneId);
  }

  // WS-D (BUG-024): proactive feedback controller. Per the maintainer decision this drives
  // earcons + a coalescing on-screen notification stack (Seam B / broadcast) — NOT in-voice
  // spoken turns. It owns the per-pane debounce, coalescing window, and token-bucket rate
  // limit so the event path below stays thin (just enqueue).
  const announcementBus = new AnnouncementBus({
    broadcast,
    getTemplates: () => manager.settings.announcements || DEFAULT_ANNOUNCEMENT_TEMPLATES,
  });

  // BUG-035: keep the attentionQueue bounded + TTL-evicted wherever it is mutated.
  function pruneAttention() {
    pruneAttentionQueue(manager.attentionQueue);
  }

  // Memory Synthesis P0a: the in-process, anti-rot working-context layer. WorldModel reads live
  // manager + store; the FallbackAssembler blends the five redacted tiers into one char-budgeted
  // brief; the BreadcrumbRing is fed from the ears edges (onBreadcrumb below) and decays by recency.
  // No new runtime deps, no Python (P0b swaps in behind MemoryService.synthesize). The advanced
  // knobs are optional/additive — absent ⇒ DEFAULT_MEMORY_CONFIG. (manager/store satisfy the
  // WorldModel deps structurally; every text field is redacted at the WorldModel boundary.)
  // store is null under JANUS_LEDGER_BACKEND=legacy (or store-init failure). The WorldModel only
  // reads getProject/getProjectBriefing; a null-safe shim degrades the Project tier to absent
  // (the brief still synthesizes from pane/board/frame/breadcrumbs — anti-rot survives, M8).
  const memoryStore = store ?? { getProject: () => null, getProjectBriefing: () => null };
  // The WorldModel reads the gate posture off `settings.globalPermissionsMode`, but the live value
  // is `manager.globalPermissionsMode` (resolved from advanced.globalPermissionsMode). Adapt the
  // manager to the WorldModel's narrow dep shape (live getters — every read is current, never a
  // stale snapshot) so the Janus-frame tier reports the REAL posture instead of the safe default.
  const memoryManager = {
    get activeId() { return manager.activeId; },
    get terminals() { return manager.terminals as any; },
    get ledger() { return { activeProjectId: manager.ledger.activeProjectId }; },
    get settings() { return { globalPermissionsMode: manager.globalPermissionsMode }; },
    listPanes: () => manager.listPanes(),
  };
  // P0b: the optional warm Python synthesizer. A STRICT UPGRADE — gated by the master switch, eagerly
  // pre-warmed and non-fatal. Absent/broken interpreter ⇒ permanent fallback; Janus stays fully functional.
  const memoryPythonEnabled = manager.settings.advanced?.memoryPythonEnabled !== false; // default true
  // Clamp at boot: a persisted 0/negative/NaN deadline would fire synthesizeAsync's race timer immediately
  // (?? does not catch 0), pinning Janus to permanent fallback even with a healthy daemon. Floor to the default.
  const _synthTimeoutRaw = manager.settings.advanced?.memorySynthTimeoutMs;
  const memorySynthTimeoutMs =
    typeof _synthTimeoutRaw === "number" && Number.isFinite(_synthTimeoutRaw) && _synthTimeoutRaw > 0
      ? _synthTimeoutRaw
      : 150;
  let pythonSynthClient: PythonSynthClient | undefined;
  if (memoryPythonEnabled) {
    try {
      pythonSynthClient = createPythonSynthClient({ moduleDir: defaultModuleDir(), repoRoot: process.cwd() });
    } catch (e) {
      console.error("[memory] python synth client init failed (continuing on fallback):", e);
      pythonSynthClient = undefined;
    }
  }
  const memory = createMemoryService(
    { manager: memoryManager, store: memoryStore, redact: redactSecrets },
    {
      totalBudgetChars: manager.settings.advanced?.memoryBudgetChars ?? 4800,
      weights: { project: 0.40, pane: 0.30, breadcrumbs: 0.15, board: 0.10, frame: 0.05 },
      breadcrumbMax: manager.settings.advanced?.breadcrumbMax ?? 12,
      breadcrumbMaxAgeMs: manager.settings.advanced?.breadcrumbMaxAgeMs ?? 900_000,
    },
    pythonSynthClient,
    memorySynthTimeoutMs,
  );

  // dec-2 (DBT5): attach the PTY observation/trigger pipeline (src/observe/index.ts). This is invoked
  // HERE — after broadcast / announcementBus / pruneAttention / paneSignalBus are constructed — and the
  // returned handlers are bound onto the manager, exactly mirroring the inline `manager.onOutput = ...`
  // / `manager.onIdle = ...` assignments this replaced. The pipeline's private state (lastStates,
  // outputBuffers, flushTimeout) lives as locals inside attachObserve, scoped to this server instance.
  const { onOutput, onIdle, onRunning, onQuiescing } = attachObserve(manager, {
    broadcast,
    announcementBus,
    paneSignalBus,
    pruneAttention,
    interactionLog,
    getLastInteractionId: () => lastInteractionId,
    redact: redactSecrets,
    historyManager: HistoryManager.getInstance(),
    ai,
    // Memory Synthesis P0a: feed the decaying breadcrumb ring from the ears edges
    // (onRunning/onIdle/onQuiescing each call this with a redacted one-liner).
    onBreadcrumb: memory.addBreadcrumb,
  });
  manager.onOutput = onOutput;
  manager.onIdle = onIdle;
  // Phase 1 "ears": fan the BEGINNING edge (pane_status WS frame + 'running' model signal),
  // mirroring the onIdle wiring above. The pane_status broadcast is emitted from inside
  // attachObserve via the injected broadcast — server.ts only binds the handler.
  manager.onRunning = onRunning;
  // Conservative Phase 2: fan the HUMBLE pre-idle "cooking…" edge (pane_quiescing WS frame +
  // 'quiescing' model signal), mirroring the onRunning/onIdle wiring above. The frames are
  // emitted from inside attachObserve via the injected broadcast/paneSignalBus.
  manager.onQuiescing = onQuiescing;

  function broadcastLedgerUpdate() {
    broadcast({
      type: "ledger_updated",
      ledger: manager.ledger.workspaces
    });
  }

  // dec-5 (DBT5): pushApprovalNarration — narrate a SYSTEM EVENT into the live session so the model
  // speaks it to the operator — now lives in src/voice (it is voice egress) and is imported above. It
  // is a pure standalone function (session + text, no closure state), so gating can inject the SAME
  // identity here while STILL never importing voice (gating imports nothing from voice; server.ts wires
  // the dependency). Passed into createGating AND attachVoiceSession unchanged.

  // dec-4 (DBT5): the SHARED GATING / SAFETY CORE — the capability-gate resolver, the deferred-action +
  // pending-approval stores (with their durable boot hydration), the effective-posture surface, the
  // single resolve choke-point (applyResolution), the TWO-STAGE EMERGENCY STOP-ALL brake, and the TTL
  // sweep — moved to src/gating/index.ts. Constructed HERE (before the REST mount + the WS/voice block)
  // so every surface injects the SAME pending stores. pushApprovalNarration is an INJECTED slot so
  // gating never imports voice. See src/gating/index.ts.
  const gating = createGating({
    manager,
    store,
    broadcast,
    broadcastLedgerUpdate,
    broadcastDraft,
    coreState,
    announcementBus,
    pushApprovalNarration,
    sanitizeSettingsForClient,
    addCommand: (terminalId, command) => HistoryManager.getInstance().addCommand(terminalId, command),
  });
  // Destructure the gating seam so the existing inline call sites across the REST + WS surfaces keep
  // referencing these by name. ONE shared object by reference — the pending stores + the posture
  // surface read coreState.frozen/activePaneId across the boundary, so a WS write is immediately seen.
  // dec-5 (DBT5): the voice-only gating consumers (effectiveModeFor / reannounceSurvivors /
  // shellAllowlist / APPROVAL_TTL_MS) are no longer destructured here — attachVoiceSession receives the
  // whole `gating` object and destructures them inside src/voice. server.ts keeps only the names its
  // REST surface + REST ctxFactory still reference.
  const {
    effectiveCapabilityGateFor,
    gateCapability,
    gateOrDefer,
    posturePayloadForPane,
    broadcastTerminalsUpdated,
    runningPaneIds,
    stopAll,
    releaseStopAll,
    applyResolution,
    applyPaneMode,
    pendingApprovals,
    pendingActions,
  } = gating;

  // B1 (async spawn): the manager now boots panes on a deferred tick. Two distinct edges:
  //  - onSpawned: start() returned (transport assigned OR degraded to Exited). Re-paint the UI so a
  //    fast-failing pane flips Running->Exited promptly instead of showing stale "Running" until the
  //    next probe. A degraded pane never reaches markSpawnReady, so it emits NO false "ready".
  //  - onReady: the child actually attached its PTY (first onData / markSpawnReady). This is the
  //    phase-2 "ready" source — publish a `created` pane signal so the live session can speak a
  //    turn-gated "pane is up" ack (the gate lives in the subscriber, src/voiceAckGate.ts).
  // Manager-level singletons assigned ONCE here (not per-connection): broadcastTerminalsUpdated (just
  // destructured from gating) and paneSignalBus (server.ts:401, the full bus with .publish) are both
  // in scope. Own try/catch each — a failed repaint/publish must NEVER escape the manager callback.
  manager.onSpawned = (terminalId) => {
    try { broadcastTerminalsUpdated(); } catch (e) { console.error("[onSpawned] repaint failed:", e); }
  };
  manager.onReady = (terminalId) => {
    try { paneSignalBus.publish({ paneId: terminalId, kind: "created" }); }
    catch (e) { console.error("[onReady] pane-signal publish failed:", e); }
  };
  // wsm-e2e-pinned-5h0 (A-voice): the operator-initiated exit+archive completion edge. Publishes a
  // turn-gated "closed" pane signal (voice/index.ts defers it mid-utterance) so Janus confirms the
  // close only in a gap. Fires for BOTH the close_pane voice tool and the UI Exit button (both route
  // through manager.stopAndArchivePane), so the confirmation is consistent across surfaces.
  manager.onClosed = (terminalId) => {
    try { paneSignalBus.publish({ paneId: terminalId, kind: "closed" }); }
    catch (e) { console.error("[onClosed] pane-signal publish failed:", e); }
  };

  // c55 Batch F (+ concurrent multi-cli merge): GET /api/terminals (list_panes) is now served by the
  // registry-derived list_panes def (mountRestRoutes only-set above). The rest surface builds the SAME flat
  // per-pane array this inline route did (id/cwd/command/backfill[raw ANSI]/output[getRecentOutput(20)]/
  // status/quiescing/permissions_mode/tool_preset/session_id/context_size/effective_gates[16]/posture from
  // posturePayloadForPane) — the concurrent `quiescing` "cooking…" overlay field is carried in the def
  // builder too — and the def's rest.toHttp emits it TOP-LEVEL, byte-identical to this body. The voice
  // surface still narrates the project/pane TREE (handler is surface-aware: ctx.surface==='rest' -> flat).

  // c55.11: GET /api/ledger now served by the registry-derived get_ledger def (mountRestRoutes only-set above).

  // c55 Batch D: POST /api/terminals (create_pane) is now served by the registry-derived create_pane
  // def (mountRestRoutes only-set above). coerceArgs aliases the camelCase body (terminalId/projectId/
  // toolPreset/permissionsMode) onto the snake_case zod keys and drops a client `command` for a
  // non-Custom preset (the inline route ignored it; the def's .superRefine forbids it). The launch
  // command is DERIVED server-side via the SAME presetCommand(normalizePreset(...)) home, and the spawn
  // rides the SAME create_pane gateOrDefer. STATUS-VIA-KINDS: Off -> kind:"blocked" (403), Ask ->
  // kind:"pending" (202), Auto -> kind:"ok" (200) — the status branches survive; only the 403/202/200
  // BODY shape changes to the registry shape (was restGateOutcome). The registry handler ALSO sets the
  // new pane active + broadcasts switch_active_pane (the inline route did not) — a benign redundant
  // broadcast (the client already self-activates on 200). The cwd existsSync fallback is now resolved
  // inside the def from the project directory.

  // c55 Batch C: POST /api/terminals/:pane_id/restart is now served by the registry-derived respawn_pane
  // def (mountRestRoutes only-set above). It NOW ENFORCES the restart_pane gate (the inline route here
  // skipped it — a deliberate safety improvement). Same stop()+start() / ledger-rebuild branches and the
  // same ledger_updated + terminals_updated broadcasts. Accepted delta: inline 404 -> 200 ok-narration.

  // TWO-STAGE EMERGENCY STOP-ALL (bead 8sq, spec §2.C). Auth is enforced by
  // app.use("/api", authMiddleware) — the single shared director token. Always-allowed
  // (see stopAll/releaseStopAll): an emergency brake is never gated.
  //   POST /api/stop-all          -> Stage 1 (freeze + cancel in-flight; panes keep running).
  //   POST /api/stop-all/confirm  -> Stage 2 (hold-to-fire kill of running PTYs; only when frozen).
  //   POST /api/stop-all/release  -> clear the freeze (clean restore; matrix was never mutated).
  // c55 Batch F: GET /api/stop-all/status (the boot-restore freeze snapshot) is now served by the
  // registry-derived get_stop_all_status def (mountRestRoutes only-set above). The handler returns the
  // SAME {frozen, running} object (running = ctx.runningPaneIds() iff frozen, via the injected closures)
  // and the def's rest.toHttp emits it TOP-LEVEL — byte-identical to this inline body. This is the
  // snapshot the client reads ONCE on page load to restore the FROZEN banner before any WS frame exists
  // ({type:'frozen'} only fires on a CHANGE — spec §2.C/§10.3 "frozen survives a restart").

  // c55 Batch A: the three POST brake twins (POST /api/stop-all, /confirm, /release) are now served
  // by the registry-derived REST mount (stop_all / confirm_stop_all / release_stop_all in the
  // mountRestRoutes only-set above). They run the SAME injected brake closures (stopAll / releaseStopAll)
  // and broadcast the same frames.
  // Accepted body deltas (client ignores the body): confirm-while-not-frozen 409 -> 200 ok-narration.

  // c55 Batch C: POST /api/terminals/:pane_id/input (send_keys) and /resize (resize_pane) are now served
  // by the registry-derived rest-only defs (mountRestRoutes only-set above) — both ALWAYS_ALLOWED to
  // preserve the inline routes' ungated behavior. send_keys records history + writeInput + ledger_updated;
  // resize_pane validates cols/rows as positive ints via zod (replacing the inline 400) and calls
  // manager.resize. Accepted deltas (client ignores the body): inline 404 -> 200 ok, inline 400 -> zod 500.

  // Raw control-byte path (multi-cli adapter spec §7, §10) — KEPT INLINE (concurrent multi-cli feature; no
  // c55 registry twin; a future convergence item). Writes literal keystrokes (arrows,
  // Tab, Esc, Enter, PgUp/PgDn, Ctrl+C, Shift+Tab) into a pane's PTY via writeRaw — NO Enter-append,
  // NO history (contrast the /input endpoint above, which is SUBMIT semantics). The gate is
  // BIFURCATED: navigation keys + Ctrl+C (the emergency brake) are always-allowed and run
  // immediately; the disruptive Shift+Tab (ESC[Z) routes through gateOrDefer("write_to_pane", …)
  // so it is Ask off-spotlight (202 deferred), Auto on-spotlight (200), or Off (403).
  app.post("/api/terminals/:id/raw-input", (req, res) => {
    const { id } = req.params;
    const { bytes } = req.body;
    if (typeof bytes !== "string" || bytes.length === 0) {
      res.status(400).json({ error: "Missing or empty bytes parameter" });
      return;
    }
    const term = manager.terminals[id];
    if (!term) {
      res.status(404).json({ error: "Terminal not found or offline" });
      return;
    }
    // 409 when the pane exists but has no live PTY (inert / un-spawned) — writeRaw would no-op.
    if (!(term as any).transport) {
      res.status(409).json({ error: "Pane has no live process (not spawned)." });
      return;
    }
    // Active-pane guard (mirrors the voice write path in src/voice/index.ts): raw keystrokes may
    // only ever reach the SINGLE pane the operator has open (coreState.activePaneId). Refuse a key
    // aimed at any other pane — in ALL gate modes and for EVERY key, including the always-allowed
    // nav keys and the Ctrl+C brake — because the guard is about WHICH pane, not which key. This
    // sits BEFORE the always-allowed/gated branching so nothing reaches a non-active pane's PTY.
    if (!isPaneActiveForWrite(coreState.activePaneId, id)) {
      res.status(409).json({
        error: coreState.activePaneId
          ? `Raw input refused: pane '${id}' is not the active pane ('${coreState.activePaneId}'). Switch to it first.`
          : `Raw input refused: no pane is active, so there is nowhere to write. Open the pane first.`,
      });
      return;
    }
    // bead ym3: raw-input is an ALLOWLIST, not a denylist-of-one. Reject ANY payload that is not one
    // of the 11 vetted canonical control-key sequences (isKnownRawKey) BEFORE writeRaw — this is what
    // stops an arbitrary shell line ("rm -rf ~\r") from being written verbatim to the PTY, bypassing
    // the write_to_pane gate. Sits AFTER the 400/404/409 checks and BEFORE classifyRawKey, so
    // classifyRawKey only ever runs on a vetted key. (Ctrl+C \x03 IS in the table — §13.1 preserved.)
    if (!isKnownRawKey(bytes)) {
      res.status(400).json({ error: "Unrecognized raw-key sequence" });
      return;
    }
    // Always-allowed keys (nav + Ctrl+C brake) bypass the gate and dispatch now.
    if (classifyRawKey(bytes) === "always-allowed") {
      term.writeRaw(bytes);
      res.json({ success: true });
      return;
    }
    // Gated disruptive key (Shift+Tab): defer the writeRaw effect through the capability gate.
    const rawEffect = (): string => { term.writeRaw(bytes); return "ok"; };
    const g = gateOrDefer("write_to_pane", id, `Send Shift+Tab (mode cycle) to pane ${id}`, rawEffect);
    const out = restGateOutcome(g);
    if (g.disposition === "run") rawEffect(); // Auto: run now
    res.status(out.status).json(out.body);
  });

  // c55 Batch C: the inline POST /api/terminals/:id/resize is converged to the registry resize_pane def
  // (mountRestRoutes only-set above) — removed here to avoid double-registration. The concurrent merge had
  // kept the inline /resize; resize_pane supersedes it (zod cols/rows positive ints; inline 400 -> zod 500).

  // c55 Batch F: GET /api/terminals/:id/history (the RAW history array) is now served by the
  // registry-derived get_terminal_history def (mountRestRoutes only-set above) at GET
  // /api/terminals/:pane_id/history (snake_case route segment lands directly on the snake zod key). The
  // def reproduces HistoryManager.loadHistory(id) EXACTLY (same .janus_history.json read at
  // process.cwd(), same maxCmds slice, RAW entries — NOT the concise get_pane_command_history prose) and
  // rest.toHttp emits the raw array TOP-LEVEL — byte-identical to this inline body.

  // c55 Batch C: POST /api/terminals/:pane_id/history/clear is now served by the registry-derived
  // clear_history def (mountRestRoutes only-set above), ALWAYS_ALLOWED (preserving the inline route's
  // ungated behavior). Same HistoryManager.saveHistory(id, []) effect; client ignores the body.

  // Project and Pane management endpoints
  // c55.16: POST /api/projects is now served by the registry-derived create_project def
  // (mountRestRoutes only-set above). The def gained an optional `name` param + a coerceArgs shim
  // (aliases the UI body id->project_id / keyTerms->key_terms only when the snake key is absent) and
  // ports the inline post-create RENAME as a 2nd in-handler ledger mutation — addProject then, iff a
  // truthy name, renameProject — before the single ledger_updated broadcast (both are pure ledger ops,
  // no connection scope). Accepted client-invisible body deltas: 200 {success:true} -> 200 {output:"…"};
  // malformed no-id 400 -> zod 500 (same class as create_pane). The client (App.tsx) reads no response
  // field; it repaints off the ledger_updated WS frame + a follow-on fetchLedger/fetchTerminals.

  // c55.14: PUT /api/projects/:id now served by the registry-derived update_project def (mountRestRoutes only-set above).

  // c55 Batch B: PUT /api/projects/:project_id/rename is now served by the registry twin
  // rename_project (mountRestRoutes only-set above) — same renameProject + ledger_updated broadcast.
  // Accepted body delta (client ignores it): { success:true } -> 200 { output:"Project renamed to …" }.

  // c55.12: POST /api/projects/:id/notes now served by the registry-derived create_project_note def (mountRestRoutes only-set above).
  // c55.12: GET /api/projects/:id/notes now served by the registry-derived read_project_notes def (unredacted {notes:[…]} feed; only-set above).
  // c55.12: PUT /api/notes/:id now served by the registry-derived edit_note def (mountRestRoutes only-set above).
  // c55.12: DELETE /api/notes/:id now served by the registry-derived remove_note def (mountRestRoutes only-set above).

  // c55 Batch B: PUT /api/projects/:project_id/panes/:pane_id/rename is now served by the registry
  // twin rename_pane (mountRestRoutes only-set above) — same renamePane + ledger_updated broadcast.
  // Accepted body delta (client ignores it): { success:true } -> 200 { output:"Pane renamed to …" }.

  // c55.12: POST /api/projects/:projectId/panes/:paneId/notes now served by the registry-derived create_pane_note def (mountRestRoutes only-set above).
  // c55.12: POST /api/projects/:projectId/panes/:paneId/context now served by the registry-derived add_pane_context def (mountRestRoutes only-set above).

  // c55 Batch D: PUT /api/projects/:project_id/panes/:pane_id/permissions (set_pane_permissions) is now
  // served by the registry twin (mountRestRoutes only-set above). The rest.path uses snake_case segments
  // and coerceArgs aliases the body {permissions -> permissions_mode}. behaviorDelta: the registry twin
  // is GATED via gateOrDefer (on Ask it STAGES a pending action instead of applying — the inline route
  // applied unconditionally + skipped the invalid-mode/pane-not-found pre-checks). Same setPermissionsMode
  // + ledger write + ledger_updated/terminals_updated broadcasts on the Auto path. Client ignores the body.

  // c55.16: the BULK per-pane capability-gate OVERRIDE write (the matrix editor's per-pane "Save",
  // PUT /api/projects/:project_id/panes/:pane_id/capability-gates) is now served by the registry twin
  // set_pane_gates (mountRestRoutes only-set below). It is the rest-only, UNGATED, VERBATIM operator
  // loosening surface (the voice set_capability_gate tool stays single-entry tighten-only and is now
  // voice-only). The def's rest.path uses snake_case segments, coerceArgs aliases the body
  // {capabilityGates -> capability_gates}, and rest.toHttp reproduces the exact 200 {success,
  // capabilityGates} / 404 {error:"Pane not found"} contract (incl. empty-clears-to-null) byte-for-byte.
  // The handler faithfully ports the inline (A)-(H): notFound sentinel before any mutation, the
  // Auto|Ask|Off silent-drop normalize, updatePane(.,.,true) on both set+clear, the if(store) audit, and
  // both broadcasts on both paths. tests/test_pane_gates_rest.ts pins the round-trip unchanged.

  // c55 Batch B: POST /api/projects/:project_id/switch is now served by the registry twin
  // switch_context (mountRestRoutes only-set above) — same switchContext + activeContext/
  // localWorkspacePath writes + saveSettings + ledger_updated broadcast. Accepted body delta (client
  // ignores it, repaints off the WS frame): { success:true, activeProjectId } -> 200 { output:<project
  // briefing> } (the briefing object the voice path already returns).

  // c55.14: DELETE /api/projects/:id now served by the registry-derived delete_project def (mountRestRoutes
  // only-set above) — NOW GATED (delete_project cap, default Ask) via gateOrDefer; behaviorDelta from the
  // ungated inline delete. Same workspace removal + active-context reassignment + ledger_updated broadcast.
  // c55.14: DELETE /api/projects/:projectId/panes/:paneId now served by the registry-derived delete_pane def
  // (only-set above) — NOW GATED (delete_pane cap, default Ask). Same stop+drop terminal + pane removal +
  // ledger_updated/terminals_updated broadcasts. The Graceful per-pane EXIT (stop+archive) is below.
  // c55.14: POST /api/projects/:projectId/panes/:paneId/stop (graceful per-pane EXIT — terminate the PTY and
  // archive the pane, PRESERVING the ledger record) now served by the registry-derived stop_pane def
  // (only-set above), ALWAYS_ALLOWED (preserving the inline route's ungated behavior). Same stopAndArchivePane
  // + ledger_updated/terminals_updated broadcasts; the {archived} payload rides in the ok output body.

  // --- Terminal archive (recoverable "clear exited") ---

  // c55 Batch C: POST /api/terminals/clear-exited is now served by the registry-derived clear_exited def
  // (mountRestRoutes only-set above), ALWAYS_ALLOWED (preserving the inline route's ungated behavior).
  // Same effect: stop+drop dead live terminal objects, ledger.archiveExitedPanes(activeId), then
  // ledger_updated + terminals_updated broadcasts. The {archived} count rides in the ok output body.

  // c55.13: GET /api/archive, POST /api/archive/:paneId/restore, DELETE /api/archive/:paneId are now
  // served by the registry-derived list_archived_panes / restore_archived_pane / delete_archived_pane
  // defs (mountRestRoutes only-set above). Same projection + broadcasts; rest-only, ungated operator-UI.

  // --- ORCHESTRATION PIPELINES & AUTOMATIONS ENDPOINTS ---
  const recipes = [
    {
      id: "full-stack-web",
      name: "Full-Stack Web App Suite",
      description: "Vite SPA client, Express backend router, and test watcher setup.",
      // startupCommand is SUGGESTED, not auto-run: panes always open a bare shell
      // (see /api/recipes/apply). The operator runs the suggestion explicitly so a
      // pane never starts doing work on its own ("always bare shell, never auto-run").
      panes: [
        { id: "pane_frontend", name: "SPA Frontend (Vite)", startupCommand: "npm run dev", preset: "Custom" as const, permissionsMode: "Human-in-the-Loop" as const },
        { id: "pane_api", name: "Proxy Router (Express Server)", startupCommand: "node server.ts", preset: "Custom" as const, permissionsMode: "Full Auto" as const },
        { id: "pane_tests", name: "Vitest Live Suite", startupCommand: "npm run test", preset: "Custom" as const, permissionsMode: "Read-Only" as const }
      ]
    },
    {
      id: "python-worker",
      name: "SQL Pipeline & background Queue",
      description: "FastAPI Web Engine with an RQ asynchronous background worker.",
      panes: [
        { id: "pane_fastapi", name: "Microservice Host (Uvicorn)", startupCommand: "uvicorn main:app --reload", preset: "Custom" as const, permissionsMode: "Human-in-the-Loop" as const },
        { id: "pane_worker", name: "Asynchronous Poll Task Queue", startupCommand: "python -m rq worker tasks_queue", preset: "Custom" as const, permissionsMode: "Full Auto" as const }
      ]
    }
  ];

  // 1. Attention alerting queue
  // c55.11: GET /api/attention now served by the registry-derived get_attention_queue def (mountRestRoutes only-set above).

  // c55 Batch A: POST /api/attention/:id/dismiss is now served by the registry twin dismiss_attention
  // (mountRestRoutes only-set above) — same attention_updated broadcast. Accepted body delta (client
  // ignores the body): unknown-id 404 -> 200 ok-narration. GET /api/attention stays inline (a bare read,
  // out of scope). POST /api/attention/clear is a c55 Batch D thin shim over the SAME def (below).

  // c55 Batch D: POST /api/attention/clear is the "dismiss ALL" alias of dismiss_attention (id omitted).
  // dismiss_attention's rest binding owns the PER-ITEM path (POST /api/attention/:id/dismiss, Batch A);
  // a second path binding for one def needs the multi-path mount seam (Batch H). Until then this stays a
  // THIN inline SHIM: the only inline part is the PATH ALIAS — EXECUTION routes through the registry
  // (runAction('dismiss_attention', {}) -> the SAME handler does the mass-dismiss + prune +
  // attention_updated broadcast), so there is NO logic twin to drift. Pipes through resultToHttp.
  app.post("/api/attention/clear", async (req, res) => {
    const ctx = buildRestActionContext(req as unknown as RestRequest);
    const result = await runAction(REGISTRY, "dismiss_attention", {}, ctx);
    resultToHttp(result, res as unknown as RestResponse);
  });

  // 2. Watch automation rules
  // c55 Batch G: GET/POST /api/watch-rules and DELETE /api/watch-rules/:id are now served by the
  // registry-derived rest-only defs list_watch_rules / add_watch_rule / remove_watch_rule
  // (mountRestRoutes only-set above), all ALWAYS_ALLOWED (preserving the inline routes' ungated behavior).
  // list_watch_rules' rest.toHttp emits the RAW WatchRule[] array TOP-LEVEL (byte-identical to the inline
  // res.json(watchRules) body the client's setWatchRules() consumes). add/remove force-save + broadcast
  // watch_rules_updated identically. Accepted deltas (client ignores the body): inline add missing-field
  // 400 -> zod 500; inline remove 404 -> 200 ok-narration.

  // 3. Multi-step sequenced resumable plans
  // c55.11: GET /api/plans now served by the registry-derived list_orchestrator_plans def (mountRestRoutes only-set above).

  // c55 Batch A: POST /api/plans (create) is now served by the registry twin create_orchestrator_plan
  // (mountRestRoutes only-set above) — same plans_updated broadcast and ledger["save"](true) persist.
  // Accepted body delta (client ignores the body): the inline missing-name/steps 400 becomes a zod
  // validation 500 (no valid client sends an empty payload). GET /api/plans (c55.11),
  // POST /api/plans/:id/execute (c55.9), and DELETE /api/plans/:id (c55 Batch G) are now ALL converged
  // to registry defs (see the notes just below) — none stay inline.

  // c55.9: POST /api/plans/:id/execute is now served by the registry-derived execute_plan def
  // (mountRestRoutes only-set above) — the inline route here is DELETED (converged). Step 1's pane
  // write rides the SAME gated choke-point (restDispatchProposal -> applyDispatchDecision), so the
  // REST Run-plan button respects capabilityGates.execute_plan (Auto/Ask/Off) at parity with voice
  // (BUG-040 closed — the inline route wrote step 1 UN-gated). The def's rest.toHttp preserves the
  // inline status contract: pane-offline 400 / plan-not-found 404 (+ executed 200 / pending 202 /
  // blocked 403 / clarify 409). The client ignores the body and repaints off plans_updated /
  // approval_pending WS frames. The inlineExceptions held row is removed in the SAME change (no-twin guard).

  // c55 Batch G: DELETE /api/plans/:id is now served by the registry-derived rest-only def
  // delete_orchestrator_plan (mountRestRoutes only-set above), ALWAYS_ALLOWED (preserving the inline
  // route's ungated behavior). The def's rest.path uses :plan_id (snake_case) so Express injects the path
  // param directly onto the snake_case zod key. Same splice + force-save + plans_updated broadcast.
  // Accepted delta (client ignores the body): inline 404 "Plan not found." -> 200 ok-narration.

  // 4. Recipes and templates
  // c55.11: GET /api/recipes now served by the registry-derived list_orchestration_recipes def (mountRestRoutes only-set above).
  //         (The `recipes` const above still feeds ctx.recipes, which the def reads.)

  // c55 Batch D: POST /api/recipes/apply (apply_orchestration_recipe) is now served by the registry twin
  // (mountRestRoutes only-set above). coerceArgs aliases the body {recipeId -> recipe_id}; the handler
  // shares the SAME pure planner (planRecipeApply) + per-pane gateOrDefer("create_pane") + the SAME
  // presetCommand(normalizePreset()) launch derivation, and STATUS-VIA-KINDS makes the layout
  // apply_recipe=Off veto a kind:"blocked" -> 403 (the inline route already 403'd; preserved). The
  // per-pane broadcasts live INSIDE the def's spawnPane so a deferred-confirm repaints. behaviorDelta
  // (client ignores the body): inline 404 (no active project / unknown recipe) -> 200 ok-narration; the
  // 200 body is now { output:<spawned/deferred/blocked summary string> } (was {success,spawned,deferred,blocked}).

  // c55 Batch D: POST /api/handoff (handoff_context_between_panes) is now served by the registry twin
  // (mountRestRoutes only-set above). coerceArgs aliases the camelCase body {sourcePaneId,targetPaneId,
  // contextNotes} onto the snake_case zod keys. Same addModelContext write to the target pane's
  // model-context layer (ungated — handoff carries CONTEXT, not commands) + ledger_updated broadcast.
  // behaviorDelta (client ignores the body): inline 400 (both panes must be active) -> 200 ok-narration.

  // Step 6 (the Workbench): per-pane WIP draft REST. Composing/editing a draft is not a CLI write.
  app.get("/api/panes/:projectId/:paneId/draft", (req, res) => {
    const draft = manager.ledger.getDraft(req.params.projectId, req.params.paneId)
      ?? { text: "", updatedAt: new Date().toISOString() };
    res.json({ draft });
  });

  app.put("/api/panes/:projectId/:paneId/draft", (req, res) => {
    const { text } = req.body;
    if (text === undefined) { res.status(400).json({ error: "Missing text field" }); return; }
    const ok = manager.ledger.setDraft(req.params.projectId, req.params.paneId, text, "operator");
    if (!ok) { res.status(404).json({ error: "Pane not found" }); return; }
    broadcastDraft(req.params.projectId, req.params.paneId);
    res.json({ success: true });
  });

  // The WIP register (the scalable part of "B"): every pane in a project with a non-empty draft,
  // so work composed for one pane is never lost when the operator switches to another.
  app.get("/api/projects/:projectId/drafts", (req, res) => {
    res.json({ drafts: manager.ledger.listDrafts(req.params.projectId) });
  });

  // Send the draft to its pane. This is an OPERATOR-DIRECT write (the operator is above the gate,
  // architecture §2): clicking Send IS the approval, so it writes immediately. The draft is then
  // cleared. Janus never calls this — it only fills the draft for the operator to send.
  app.post("/api/panes/:projectId/:paneId/draft/send", (req, res) => {
    const { projectId, paneId } = req.params;
    const text = (manager.ledger.getDraft(projectId, paneId)?.text ?? "").trim();
    if (!text) { res.status(400).json({ error: "Draft is empty." }); return; }
    const term = manager.terminals[paneId];
    if (!term) { res.status(400).json({ error: `Pane '${paneId}' is not live.` }); return; }
    HistoryManager.getInstance().addCommand(paneId, text);
    term.writeInput(text);
    broadcast({ type: "command_auto_executed", terminalId: paneId, cmd: redactSecrets(text) });
    manager.ledger.setDraft(projectId, paneId, "", "operator");
    broadcastDraft(projectId, paneId);
    res.json({ success: true });
  });

  app.get("/api/settings", (req, res) => {
    res.json(sanitizeSettingsForClient(manager.settings));
  });

  app.put("/api/settings", (req, res) => {
    // 2S.2: validate BEFORE applying anything. The body stays a PERMISSIVE passthrough overall
    // (settings carry many shapes) but the DANGEROUS fields are strict; an invalid one is a 400
    // naming the field, and the live settings/mode are untouched. (The only updateSettings()
    // call site is this route — there is no WS/voice settings-mutation path to mirror.)
    const validated = validateSettingsPutBody(req.body);
    if (!validated.ok) {
      res.status(400).json({ error: validated.error });
      return;
    }
    const newSettings = req.body;
    // bead 9fz (part 2): capture the RAW incoming key BEFORE the masked/sentinel substitution below
    // mutates it, so we can tell a genuinely-new credential from a masked round-trip echo. NEVER logged.
    const incomingGeminiKey: string | null | undefined = newSettings.secrets?.geminiApiKey;
    if (newSettings.secrets && (newSettings.secrets.geminiApiKey?.includes("••••") || newSettings.secrets.geminiApiKey === "CONFIGURED_IN_ENV" || !newSettings.secrets.geminiApiKey)) {
      newSettings.secrets.geminiApiKey = manager.settings.secrets.geminiApiKey;
    }
    manager.updateSettings(newSettings);
    broadcast({
      type: "settings_updated",
      globalPermissionsMode: manager.globalPermissionsMode,
      settings: sanitizeSettingsForClient(manager.settings)
    });
    // bead 9fz (part 2): the operator just set a REAL (non-blank, non-masked, non-env-sentinel) Gemini
    // key — nudge the live voice session to (re)connect so they need not reload the page. The blank-key
    // short-circuit (realLiveConnector) means a prior keyless connect failed cleanly; this resumes it.
    if (shouldNudgeReconnectOnSettingsKey(incomingGeminiKey)) {
      requestVoiceReconnect();
    }
    res.json({ success: true, settings: sanitizeSettingsForClient(manager.settings), globalPermissionsMode: manager.globalPermissionsMode });
  });

  // dec-4 (DBT5): the WS-E pending-approval store + the deferred-action store + their durable boot
  // hydration, effectiveModeFor / effectiveCapabilityGateFor / gateCapability / gateOrDefer, the
  // effective-posture surface (effectiveGatesForPane / posturePayloadForPane / allPanePostures /
  // broadcastTerminalsUpdated), the TWO-STAGE STOP-ALL brake (runningPaneIds / stopAll / killAllPanes /
  // releaseStopAll), reannounceSurvivors, the WS_EVT literals, flipHandoffOnResolve, and the single
  // resolve choke-point applyResolution all moved to src/gating/index.ts (constructed as `gating`
  // above; the bindings are destructured there). The REST approval/action routes below consume the
  // SAME pending stores via those destructured bindings.

  // c55.15: GET /api/commands/pending is now served by the registry-derived list_pending_commands def
  // (mountRestRoutes only-set above) — toHttp emits pendingApprovals.all().map(serializePending) top-level.
  // c55.15: GET /api/actions/pending is now served by the registry-derived list_pending_actions def — toHttp
  // emits the {id,capability,summary,ageSeconds} array top-level (ageSeconds computed in-handler via Date.now()).
  // c55.15: POST /api/actions/:id/confirm is now served by the registry-derived confirm_pending_action def —
  // toHttp preserves 404 (missing) / 200 (already|output) / 500 (throw); broadcasts action_resolved/confirmed.
  // c55.15: POST /api/actions/:id/cancel is now served by the registry-derived cancel_pending_action def —
  // toHttp preserves 404 (missing) / 200 (already=lost_race); broadcasts action_resolved/cancelled.
  // c55.15: POST /api/commands/approve is now served by the registry-derived approve_pending_command def —
  // toHttp preserves 404 (missing) / 422 (dead_pane) / 200 (already|ok) via applyResolution.

  // dec-4 (DBT5): sweepExpiredApprovals moved to src/gating/index.ts. Arm its TTL sweep interval here
  // (the inline `setInterval(sweepExpiredApprovals, APPROVAL_SWEEP_MS)` + .unref() this replaces) and
  // keep the returned handle so the close() handler can clearInterval it.
  const approvalSweepTimer = gating.startSweepTimer();

  // 4E.3b: periodic incremental retention. bootMaintenance (module scope, once per process)
  // used to be the ONLY prune — an always-on server never reclaimed events/approvals/
  // action_log rows, and the eventual boot prune after long uptime was one giant blocking
  // delete. This unref'd per-server interval (default 10min, JANUS_RETENTION_SWEEP_MS)
  // runs sweepMaintenance — BATCHED deletes (≤1000 rows per table per tick) so a sweep can
  // never stall the serving loop; a backlog simply drains across ticks. Same TTLs as the
  // boot prune (+ the 4E.3c categories: claimed pending_approvals, action_log 30d TTL).
  // Cleared in close(); sweepMaintenance itself is a no-op once the shared store closes.
  const RETENTION_SWEEP_MS = Math.max(30_000, Number(process.env.JANUS_RETENTION_SWEEP_MS) || 600_000);
  let retentionSweepTimer: NodeJS.Timeout | null = null;
  if (store) {
    retentionSweepTimer = setInterval(() => {
      try {
        store!.sweepMaintenance({ now: Date.now(), eventsTtlDays: 30, archiveTtlDays: 14 });
      } catch (e) {
        console.error("[STORE] periodic retention sweep failed (will retry next tick):", e);
      }
    }, RETENTION_SWEEP_MS);
    retentionSweepTimer.unref?.();
  }

  // dec-5 (DBT5): the GEMINI LIVE VOICE SESSION — the entire `wss.on("connection", ...)` envelope
  // (the resumption-token persist/rehydrate, the per-connection live-session lifecycle, the gated
  // voice approval/dispatch path, the per-call ActionContext factory, the bounded auto-reconnect, and
  // the clientWs message/close handlers) — moved to src/voice/index.ts. attachVoiceSession wires the
  // connection handler onto `wss`; the ~20 per-connection mutable lets are an explicit per-connection
  // VoiceSessionState INSIDE the connection callback (never shared across connections). The whole
  // `gating` object is injected so voice destructures the SAME pending stores + resolver it shares with
  // the REST surface; pushApprovalNarration is the pure imported voice egress (gating gets the same one).
  attachVoiceSession(wss, {
    manager,
    store,
    broadcast,
    broadcastLedgerUpdate,
    broadcastDraft,
    appendActiveDraft,
    activeDraftTarget,
    sanitizeSettingsForClient,
    coreState,
    paneSignalBus,
    announcementBus,
    pruneAttention,
    interactionLog,
    recipes,
    addCommand: (terminalId, command) => HistoryManager.getInstance().addCommand(terminalId, command),
    ai,
    boundLiveConnector,
    boundSessionAiFactory,
    gating,
    memory,
    setLastInteractionId: (v) => { lastInteractionId = v; },
    pushApprovalNarration,
    REGISTRY,
    runAction,
    resultToToolResponse,
    toGeminiDeclarations,
    API_AUTH_TOKEN,
    getCookie,
    // bead 9fz: the live voice connection registers its reconnect-nudge here; the settings PUT invokes
    // it (via requestVoiceReconnect) when the operator sets a real Gemini key — voice resumes, no reload.
    registerReconnectNudge: setVoiceReconnectNudge,
  });

  // ── REST surface, DERIVED from the registry (cv/PLM2). One ActionContext per request, session:null
  // (the result maps to HTTP, not a Gemini sendToolResponse). The `only` allow-set scopes the mount so
  // it never collides with the existing hand-written routes; it grows as cv1 converges reads.
  //
  // c55.9: the pane-WRITE choke-point (dispatchProposal) is no longer a refusing stub — it is the REST
  // binding of the SHARED dispatch core (applyDispatchDecision). It resolves the SAME pure gate the
  // voice wrapper resolves (effectiveModeFor + effectiveCapabilityGateFor + decideProposal) and binds
  // the THREE connection-bound values for REST: sess=null (no Gemini session; PLM4 detachSession
  // survivors already keep+resolve session-less pendings), notifyPending=broadcast (all operator UIs,
  // not one socket), enforceActivePaneGuard=false (an operator Run-plan click is operator-DIRECTED, not
  // a Janus proposal — design §5 row 3), origin="rest". This closes BUG-040: REST Run-plan now respects
  // capabilityGates.execute_plan (Auto->write / Ask->HiTL pending / Off->block) at PARITY with voice.
  const restDispatchProposal: ActionContext["dispatchProposal"] = (opts) => {
    const { sess: _sess, callId, targetId, instruction } = opts;
    const pendingId = opts.pendingId ?? callId;
    const capability: CapabilityGate = opts.capability ?? "write_to_pane";
    const term = manager.terminals[targetId];
    const wsProj = manager.ledger.getActiveProject();
    const paneExists = !!term || !!(wsProj && wsProj.panes[targetId]);
    const runtimeType = term?.runtimeType;
    const kind = inferKind(opts.explicitKind, runtimeType);

    // The SAME pure [decide] half the voice wrapper runs (src/voice/index.ts) — global-first effective
    // mode, AND-composed with the per-capability gate, then the pure decision. No duplication.
    const effectiveMode = gating.effectiveModeFor(targetId);
    const gate = effectiveCapabilityGateFor(targetId, capability);
    const decision = decideProposal({ kind, instruction, effectiveMode, runtimeType, paneExists, allowlist: gating.shellAllowlist, capability, gate });

    return applyDispatchDecision(
      decision,
      {
        manager,
        pendingApprovals,
        broadcast,
        addCommand: (terminalId, command) => HistoryManager.getInstance().addCommand(terminalId, command),
        redactSecrets,
        getPaneSummary: (paneId, lines) => manager.getPaneSummary(paneId, lines),
        posturePayloadForPane,
        announcementBus,
        approvalTtlMs: gating.APPROVAL_TTL_MS,
        getActivePaneId: () => coreState.activePaneId,
        isPaneActiveForWrite,
        targetId,
        instruction,
        capability,
        kind,
        trigger: opts.trigger,
        effectiveMode,
        pendingId,
        callId,
        term,
        // Fan-out staging (dispatch_to_panes): never auto-execute — every write parks as a pending
        // approval. The REST guard is already off, so only the auto_execute downgrade applies here.
        forceStage: opts.forceStage === true,
      },
      {
        // REST binds the THREE connection-bound values: null session, broadcast as the pending-notify
        // sink (all operator UIs), the active-pane guard SKIPPED (operator-directed click), origin rest.
        sess: null,
        notifyPending: (frame) => broadcast(frame),
        enforceActivePaneGuard: false,
        origin: "rest",
      }
    );
  };

  function buildRestActionContext(req: RestRequest): ActionContext {
    // PLM4 (3): synthesize a STABLE per-request idempotency key for the REST surface (REST has no
    // Gemini call.id). The key is a hash of the action name + the request shape (params/query/body),
    // so an identical retried request maps to the same key while distinct requests stay unique. Pure
    // + best-effort: a hashing fault falls back to null (no key recorded, never blocks the request).
    const restIdempotencyKey = (name: string): string | null => {
      try {
        const material = JSON.stringify({ name, params: req.params ?? {}, query: req.query ?? {}, body: req.body ?? {} });
        return "rest:" + crypto.createHash("sha256").update(material).digest("hex").slice(0, 32);
      } catch { return null; }
    };
    return {
      manager,
      session: null,
      callId: undefined,
      trigger: "rest",
      surface: "rest",                          // explicit dispatch-surface token (action_log)
      userUtterance: "",
      broadcast,
      broadcastLedgerUpdate,
      gateOrDefer,
      dispatchProposal: restDispatchProposal,  // c55.9: shared gated pane-write seam (was a refusing stub)
      gateCapability,
      redact: redactSecrets,
      getActivePaneId: () => coreState.activePaneId,
      setActivePane: (id) => { coreState.activePaneId = id; },
      activeDraftTarget,
      broadcastDraft,
      broadcastTerminalsUpdated,
      effectiveCapabilityGateFor,
      pruneAttention,
      pendingApprovals,
      pendingActions,                           // c55.15: the converged approvals/pending REST defs read it
      applyResolution,
      applyPaneMode,
      store,
      sanitizeSettingsForClient,
      recipes: recipes as ActionContext["recipes"],
      stopAll,
      releaseStopAll,
      isFrozen: () => coreState.frozen,
      memorySynthesizerState: () => memory.service.synthesizerState(),
      // c55 Batch F: the STOP-ALL boot-restore snapshot (get_stop_all_status) + the list_panes flat
      // REST array both read SERVER truth — the live running-pane set and the frozen-aware posture.
      runningPaneIds,
      posturePayloadForPane,
      audit: (row) => {
        if (!store) return;
        let argsRedacted: string | null = null;
        try { argsRedacted = row.args === undefined ? null : redactSecrets(JSON.stringify(row.args)); }
        catch { argsRedacted = null; }
        try {
          store.recordAction({
            name: row.name, capability: row.capability, result_kind: row.resultKind,
            ms: row.ms, args_redacted: argsRedacted, surface: row.surface ?? "rest",
            idempotency_key: restIdempotencyKey(row.name),
          });
        } catch { /* best-effort */ }
      },
    };
  }
  // Mount the registry-derived REST twins. cv1 adds the six session-independent read twins
  // (collision-free new paths) alongside the observability reads (/api/action-log + /api/health):
  //   get_pane_summary -> GET /api/panes/:pane_id/summary
  //   get_pane_command_history -> GET /api/panes/:pane_id/history
  //   get_pane_gates -> GET /api/panes/:pane_id/gates
  //   list_capabilities -> GET /api/capabilities
  //   list_handoffs -> GET /api/handoffs
  //   read_handoff -> GET /api/handoffs/:handoff_id
  // c55.16 (Batch H terminal step): the registry now auto-serves EVERY rest-surface def. The
  // `only:` allow-filter is RETIRED — collision-freedom is no longer enforced by an allow-list but
  // PROVEN by the no-twin shadow guard (tests/test_no_inline_twins.ts): no surviving inline route
  // shares verb+normalized-path with a mounted def, and no two mounted defs collide either. The
  // surviving inline exceptions (drafts, settings, raw-input, attention/clear path-alias) all live
  // on paths no registry def claims (set_capability_gate is voice-only; set_pane_gates / create_project
  // / execute_plan are converged with their inline twins deleted). See the design at
  // docs/superpowers/specs/2026-06-05-c55-16-opts-only-drop-guard-design.md.
  mountRestRoutes(app as unknown as RestApp, REGISTRY, buildRestActionContext);

  // Vite middleware for development (dynamically imported so tests / production
  // bundles that disable it don't need vite resolvable at module load).
  if (enableVite) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else if (process.env.NODE_ENV === "production") {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const close = async (): Promise<void> => {
    announcementBus.stop(); // WS-D: clear coalescing/rate-limit timers
    clearInterval(approvalSweepTimer); // WS-E.3: clear the TTL sweep
    if (retentionSweepTimer) clearInterval(retentionSweepTimer); // 4E.3b: stop the retention sweep
    for (const term of Object.values(manager.terminals)) {
      try {
        await term.stop();
      } catch (err) {
        console.error(`Error stopping terminal ${term.terminalId}:`, err);
      }
    }
    // 4E.1: drain the debounced history cache — the last output tail of every pane must
    // hit disk before the process can exit. (After the terminal stop loop so the final
    // PTY chunks have already been appended.)
    try {
      await HistoryManager.getInstance().flushAll();
    } catch (err) {
      console.warn("[HistoryManager] close-time flush failed:", err);
    }
    // Force every live WS client + lingering keep-alive socket to CLOSED before we
    // resolve. Otherwise wss/server.close() leave half-closed libuv handles in the
    // CLOSING state; a subsequent process.exit (e.g. the unit runner's
    // --test-force-exit) then double-closes them and aborts (UV_HANDLE_CLOSING).
    for (const ws of wss.clients) {
      try { ws.terminate(); } catch { /* already gone */ }
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Tear down the Python synthesizer daemon — stops the orphaned `python ... __main__.py` per instance.
    pythonSynthClient?.dispose();
    // NOTE: we deliberately do NOT close the JanusStore here. It is a process-wide singleton shared
    // by every startServer() call (see the `process.once("exit", ...)` handler near its creation);
    // closing it per-server would break sibling in-process servers (the test_live_harness flake).
  };

  const shutdown = async () => {
    console.log("Shutting down cleanly, stopping all terminals...");
    await close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const bindHost = options.bindHost ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
  const requestedPort = options.port ?? PORT;

  if (shouldListen) {
    await new Promise<void>((resolve, reject) => {
      // A bind failure (EADDRINUSE, EACCES, ...) lands on the server's "error" event. Without
      // this listener the QW1 process net swallows it and this promise NEVER settles — the boot
      // hangs silently forever. Wire the rejection BEFORE listen; remove it on success so a
      // later runtime "error" doesn't reject a long-settled promise. The wss listener is needed
      // too: ws's WebSocketServer({ server }) FORWARDS the http server's "error" onto the wss,
      // where, unconsumed, it re-throws as an uncaughtException.
      const onListenError = (err: Error) => reject(err);
      server.once("error", onListenError);
      wss.once("error", onListenError);
      server.listen(requestedPort, bindHost, () => {
        server.removeListener("error", onListenError);
        wss.removeListener("error", onListenError);
        const addr = server.address();
        const boundPort = typeof addr === "object" && addr ? addr.port : requestedPort;
        console.log(`Server running on http://${bindHost}:${boundPort}`);
        resolve();
      });
    });
  }

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : requestedPort;

  return {
    app, server, wss, manager, port, close,
    _testActiveLiveSession: () => coreState.activeLiveSession,
    _testPendingApprovals: () => pendingApprovals,
    _testClients: () => coreState.clients,
    _testSetActivePane: (id: string | null) => { coreState.activePaneId = id; },
    _testSetReconnectNudge: (fn: (() => void) | null) => { setVoiceReconnectNudge(fn); },
  };
}

export { startServer };

// Auto-start when run as the entrypoint (`tsx server.ts` in dev or
// `node dist/server.cjs` in prod). Tests and the offline simulator set
// JANUS_NO_AUTOSTART=1 before importing so they can own the server lifecycle.
// (An env flag rather than import.meta/require.main detection because esbuild
// bundles this to CJS, where import.meta is empty.)
if (process.env.JANUS_NO_AUTOSTART !== "1") {
  startServer().catch((e) => {
    console.error("[server] failed to start (is the port already in use?):", e);
    process.exitCode = 1;
  });
}
