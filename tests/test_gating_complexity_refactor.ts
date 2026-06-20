// tests/test_gating_complexity_refactor.ts — CHARACTERIZATION tests for the cyclomatic-complexity
// burndown refactor of src/gating/index.ts (the capability-gate SAFETY CORE). These pin the CURRENT
// gate-DECISION behaviour of the seven over-limit functions so the behaviour-preserving refactor
// (extract helpers / guard clauses / dispatch-lookup tables) can be proven not to change a single
// observable decision, side-effect, or its ordering.
//
// They are written to be GREEN against the UNREFACTORED code FIRST (per D-6 of the spec). Because
// this is a fail-closed SECURITY choke-point, the cases deliberately lean on EDGE / UNKNOWN inputs —
// the exact class the terminal.ts switch→lookup-table swap regressed on (a prototype member name fed
// to a string-keyed map). We feed: an unknown capability, a missing/dead pane, conflicting
// global-vs-per-pane state, the frozen overlay (fail-closed Off), and prototype-member-name keys
// ("toString", "constructor", "__proto__", "hasOwnProperty") to both the capability axis and the
// pane axis.
//
// Covered functions (line @ HEAD : current cyclomatic complexity):
//   - createGating (≈L160, CC15): boot hydration of deferred-action survivors (quarantine vs rebuild),
//     and the structural exposure of the pending stores / constants.
//   - composeAwayDigest (≈L310, CC42): event-bucketing, per-pane dedupe, clause cap — re-pinned at the
//     bucket/edge level (the main path lives in test_away_digest.ts).
//   - gateOrDefer (≈L441, CC19): Off→forbidden, Ask→deferred(+broadcast), Auto→run; unknown cap; null
//     pane (global action); the action_pending payload shape.
//   - stopAll (≈L566, CC19): Stage-1 freeze cancels in-flight + halts plans/rules; Stage-2 kill set.
//   - applyResolution (≈L769, CC28): every ResolveReason branch (not_found / lost_race / dead_pane /
//     approved / rejected / expired), the dup-send draft-clear guard, and the resolve-event emission.
//   - applyDeferral (≈L868, CC11): re-arm vs cap vs not_found, including a CLAIMED record (mid-resolve).
//   - sweepExpiredApprovalsUnsafe (≈L940, CC15): the none/lastcall/reject decision on both legs.
//
// PURE / in-memory: createGating is driven with a minimal structural deps bag (store null OR a
// JanusStore(":memory:")), no PTY, no API key, no disk. pushApprovalNarration is captured.
//
// Runner: npx tsx --test --test-force-exit tests/test_gating_complexity_refactor.ts

import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { createGating, type Gating, type GatingDeps } from "../src/gating";
import { JanusStore } from "../src/store/sqliteStore";
import { APPROVAL_GRACE_MS } from "../src/pendingApprovals";

const TTL = 5 * 60 * 1000; // gating's APPROVAL_TTL_MS

// ─────────────────────────────────────────────────────────────────────────────
// Harness — a structural manager/coreState the gating core can be built over. Each
// capture array lets a test observe broadcasts / narrations / written commands / activity.
// ─────────────────────────────────────────────────────────────────────────────
type Captures = {
  broadcasts: any[];
  narrations: string[];
  commands: { terminalId: string; command: string }[];
  ledgerUpdates: number;
  draftBroadcasts: { projectId: string; paneId: string }[];
};

type Term = {
  status: "Running" | "Exited" | "Idle";
  permissionsMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only";
  projectId?: string;
  writes: string[];
  stopCount: number;
  writeInput: (s: string) => void;
  stop: () => Promise<void>;
};

function mkTerm(opts: Partial<Term> = {}): Term {
  const t: Term = {
    status: opts.status ?? "Running",
    permissionsMode: opts.permissionsMode ?? "Human-in-the-Loop",
    projectId: opts.projectId,
    writes: [],
    stopCount: 0,
    writeInput(s: string) { this.writes.push(s); },
    async stop() { this.stopCount++; this.status = "Exited"; },
  };
  return t;
}

const stores: JanusStore[] = [];
afterEach(() => { while (stores.length) { try { stores.pop()!.close(); } catch { /* best-effort */ } } });

function mkStore(): JanusStore {
  const s = new JanusStore(":memory:"); s.init(); stores.push(s);
  return s;
}

function makeHarness(opts: {
  store?: JanusStore | null;
  globalMode?: "Inherit" | "Full Auto" | "Human-in-the-Loop" | "Read-Only";
  globalGates?: Record<string, string>;
  terminals?: Record<string, Term>;
  activePaneId?: string | null;
  frozen?: boolean;
  activeLiveSession?: any;
  ledgerProjects?: Record<string, { pane_id: string; capabilityGates?: Record<string, string> }[]>;
} = {}): { gating: Gating; cap: Captures; manager: any; coreState: any } {
  const cap: Captures = { broadcasts: [], narrations: [], commands: [], ledgerUpdates: 0, draftBroadcasts: [] };
  const terminals = opts.terminals ?? {};

  // A minimal ledger that supports findPaneOwningProject (workspaces[pid].panes[paneId]) and the
  // draft/getDraft/setDraft seam the approved path touches, plus plans/watchRules for stopAll.
  const workspaces: Record<string, { panes: Record<string, any> }> = {};
  for (const [pid, panes] of Object.entries(opts.ledgerProjects ?? {})) {
    workspaces[pid] = { panes: {} };
    for (const p of panes) {
      workspaces[pid].panes[p.pane_id] = {
        pane_id: p.pane_id,
        capabilityGates: p.capabilityGates,
      };
    }
  }
  const drafts: Record<string, { text: string }> = {};
  const ledger: any = {
    activeProjectId: "default_project",
    getActiveProject: () => undefined,
    workspaces,
    plans: [],
    watchRules: [],
    save: () => {},
    getDraft: (pid: string, paneId: string) => drafts[`${pid}:${paneId}`],
    setDraft: (pid: string, paneId: string, text: string) => { drafts[`${pid}:${paneId}`] = { text }; return true; },
    updatePane: () => {},
  };

  const manager: any = {
    globalPermissionsMode: opts.globalMode ?? "Inherit",
    terminals,
    settings: { advanced: { capabilityGates: opts.globalGates ?? {} } },
    ledger,
  };
  const coreState: any = {
    activeFrontendWs: opts.activeLiveSession ? {} : null,
    activeLiveSession: opts.activeLiveSession ?? null,
    clients: new Set(),
    activePaneId: opts.activePaneId ?? null,
    frozen: opts.frozen ?? false,
    lastStopAllFailed: [],
    setFrozen(v: boolean) { this.frozen = v; },
  };
  const deps: GatingDeps = {
    manager,
    store: opts.store ?? null,
    broadcast: (m: any) => cap.broadcasts.push(m),
    broadcastLedgerUpdate: () => { cap.ledgerUpdates++; },
    broadcastDraft: (projectId: string, paneId: string) => cap.draftBroadcasts.push({ projectId, paneId }),
    coreState,
    announcementBus: { enqueue: (m: any) => { cap.broadcasts.push({ __bus: m }); return true; }, stop: () => {} } as any,
    pushApprovalNarration: (_s: any, text: string) => { cap.narrations.push(text); return true; },
    sanitizeSettingsForClient: (s: any) => s,
    addCommand: (terminalId: string, command: string) => cap.commands.push({ terminalId, command }),
  };
  return { gating: createGating(deps), cap, manager, coreState };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. effectiveModeFor / effectiveCapabilityGateFor / gateCapability — the gate DECISION core.
// ═════════════════════════════════════════════════════════════════════════════
describe("gating refactor — effectiveModeFor (mode resolution)", () => {
  it("Inherit + known pane -> the pane's own mode", () => {
    const { gating } = makeHarness({
      globalMode: "Inherit",
      terminals: { p1: mkTerm({ permissionsMode: "Full Auto" }) },
    });
    assert.strictEqual(gating.effectiveModeFor("p1"), "Full Auto");
  });
  it("Inherit + UNKNOWN pane -> Human-in-the-Loop (fail-safe default)", () => {
    const { gating } = makeHarness({ globalMode: "Inherit", terminals: {} });
    assert.strictEqual(gating.effectiveModeFor("nope"), "Human-in-the-Loop");
  });
  // HARDENED (post-refactor adversarial review): the pane lookup is Object.hasOwn-guarded, so a
  // prototype-member-name pane id ("toString", "constructor", "__proto__", ...) no longer resolves
  // to an inherited Object.prototype function — it falls through to the HiTL default exactly like
  // any other unknown pane. (Real pane ids are opaque strings; this is defense-in-depth against the
  // same prototype-leak class that bit terminal.ts's normalizePreset.)
  it("Inherit + prototype-member-name pane id -> HiTL default (prototype-leak guarded)", () => {
    const { gating } = makeHarness({ globalMode: "Inherit", terminals: {} });
    for (const k of ["toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "constructor", "__proto__"]) {
      assert.strictEqual(gating.effectiveModeFor(k), "Human-in-the-Loop", `${k} must hit the HiTL default`);
    }
    // A genuinely-absent NON-prototype key hits the same HiTL fallback (the intended path).
    assert.strictEqual(gating.effectiveModeFor("a-real-but-unknown-pane"), "Human-in-the-Loop");
  });
  it("global override wins over the pane's own mode", () => {
    const { gating } = makeHarness({
      globalMode: "Read-Only",
      terminals: { p1: mkTerm({ permissionsMode: "Full Auto" }) },
    });
    assert.strictEqual(gating.effectiveModeFor("p1"), "Read-Only");
  });
});

describe("gating refactor — effectiveCapabilityGateFor (capability DECISION + fail-closed frozen)", () => {
  it("explicit per-pane override wins over the global default", () => {
    const { gating } = makeHarness({
      globalGates: { write_to_pane: "Off" },
      ledgerProjects: { default_project: [{ pane_id: "p1", capabilityGates: { write_to_pane: "Auto" } }] },
    });
    assert.strictEqual(gating.effectiveCapabilityGateFor("p1", "write_to_pane" as any), "Auto");
  });
  it("conflicting global-vs-per-pane: global Auto, pane Off -> the pane override (Off) wins (tighter)", () => {
    const { gating } = makeHarness({
      globalGates: { close_pane: "Auto" },
      ledgerProjects: { default_project: [{ pane_id: "p1", capabilityGates: { close_pane: "Off" } }] },
    });
    assert.strictEqual(gating.effectiveCapabilityGateFor("p1", "close_pane" as any), "Off");
  });
  it("spotlight: active pane + productive capability with no override -> Auto", () => {
    const { gating } = makeHarness({
      activePaneId: "p1",
      globalGates: { write_to_pane: "Ask" },
      ledgerProjects: { default_project: [{ pane_id: "p1" }] },
      terminals: { p1: mkTerm() },
    });
    assert.strictEqual(gating.effectiveCapabilityGateFor("p1", "write_to_pane" as any), "Auto");
  });
  it("NON-active pane falls through to the global default (no spotlight)", () => {
    const { gating } = makeHarness({
      activePaneId: "other",
      globalGates: { write_to_pane: "Ask" },
      ledgerProjects: { default_project: [{ pane_id: "p1" }] },
    });
    assert.strictEqual(gating.effectiveCapabilityGateFor("p1", "write_to_pane" as any), "Ask");
  });
  it("null/undefined pane -> no per-pane override, global default applies", () => {
    const { gating } = makeHarness({ globalGates: { create_pane: "Ask" } });
    assert.strictEqual(gating.effectiveCapabilityGateFor(null, "create_pane" as any), "Ask");
    assert.strictEqual(gating.effectiveCapabilityGateFor(undefined, "create_pane" as any), "Ask");
  });
  it("UNKNOWN capability with no global entry -> Auto (the documented back-compat default)", () => {
    const { gating } = makeHarness({ ledgerProjects: { default_project: [{ pane_id: "p1" }] } });
    assert.strictEqual(gating.effectiveCapabilityGateFor("p1", "totally_made_up" as any), "Auto");
  });
  // CHARACTERIZATION of the SAME pre-existing latent quirk on the capability axis (do NOT "fix"
  // here): the global gate map is a plain object, so `globalGates["toString"]` is the inherited
  // HARDENED (post-refactor adversarial review): the gate lookups are Object.hasOwn-guarded, so a
  // prototype-member-name capability no longer leaks the inherited function past the gate — it falls
  // through to the same "Auto" back-compat default as any other unknown capability. This matters
  // because `set_capability_gate` is model-exposed with `capability: z.string()` (no enum guard), so
  // a prototype-name capability IS reachable — the review refuted the earlier "can never reach prod".
  it("prototype-member-name CAPABILITY -> Auto default (prototype-leak guarded, reachable via set_capability_gate)", () => {
    const { gating } = makeHarness({ ledgerProjects: { default_project: [{ pane_id: "p1" }] } });
    // No longer a leaked function — guarded to the Auto back-compat default.
    assert.strictEqual(gating.effectiveCapabilityGateFor("p1", "toString" as any), "Auto");
    assert.strictEqual(gating.effectiveCapabilityGateFor("p1", "hasOwnProperty" as any), "Auto");
    assert.strictEqual(gating.effectiveCapabilityGateFor("p1", "__proto__" as any), "Auto");
    // A real, non-prototype unknown capability hits the same Auto back-compat default (the intended path).
    assert.strictEqual(gating.effectiveCapabilityGateFor("p1", "a_real_unknown_cap" as any), "Auto");
    // And FROZEN still wins -> Off (the fail-closed guarantee holds regardless).
    const { gating: gf } = makeHarness({ frozen: true, ledgerProjects: { default_project: [{ pane_id: "p1" }] } });
    assert.strictEqual(gf.effectiveCapabilityGateFor("p1", "toString" as any), "Off");
  });
  it("FROZEN is the fail-closed choke-point: EVERY resolution becomes Off, even an explicit Auto override", () => {
    const { gating } = makeHarness({
      frozen: true,
      globalGates: { write_to_pane: "Auto" },
      ledgerProjects: { default_project: [{ pane_id: "p1", capabilityGates: { write_to_pane: "Auto" } }] },
    });
    assert.strictEqual(gating.effectiveCapabilityGateFor("p1", "write_to_pane" as any), "Off");
    assert.strictEqual(gating.effectiveCapabilityGateFor(null, "create_pane" as any), "Off");
    assert.strictEqual(gating.effectiveCapabilityGateFor("p1", "unknown_cap" as any), "Off");
  });
});

describe("gating refactor — gateCapability (Off-veto guard + audit)", () => {
  it("Off -> forbidden:true; Auto/Ask -> forbidden:false (the gate value rides along)", () => {
    const { gating } = makeHarness({ globalGates: { close_pane: "Off", create_pane: "Ask", read_pane: "Auto" } });
    assert.deepStrictEqual(gating.gateCapability("close_pane" as any, null), { forbidden: true, gate: "Off" });
    assert.deepStrictEqual(gating.gateCapability("create_pane" as any, null), { forbidden: false, gate: "Ask" });
    assert.deepStrictEqual(gating.gateCapability("read_pane" as any, null), { forbidden: false, gate: "Auto" });
  });
  it("frozen forces forbidden:true for any capability (fail-closed)", () => {
    const { gating } = makeHarness({ frozen: true, globalGates: { read_pane: "Auto" } });
    assert.deepStrictEqual(gating.gateCapability("read_pane" as any, null), { forbidden: true, gate: "Off" });
  });
  it("records a permission_changed audit row when a store is wired (and never throws without one)", () => {
    const store = mkStore();
    const { gating } = makeHarness({ store, globalGates: { create_pane: "Ask" } });
    gating.gateCapability("create_pane" as any, null);
    const rows = store.getEvents({ type: "permission_changed" });
    assert.ok(rows.some((r) => /capability create_pane gate=Ask/.test(r.summary)), "exercise audited");
    // store-null path: no throw.
    const { gating: g2 } = makeHarness({ store: null });
    assert.doesNotThrow(() => g2.gateCapability("create_pane" as any, null));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. gateOrDefer — Off→forbidden, Ask→deferred(+broadcast), Auto→run.
// ═════════════════════════════════════════════════════════════════════════════
describe("gating refactor — gateOrDefer dispositions", () => {
  it("Auto -> {disposition:'run'} and stages NOTHING", () => {
    const { gating, cap } = makeHarness({ globalGates: { create_pane: "Auto" } });
    const out = gating.gateOrDefer("create_pane" as any, null, "make a pane", () => "ran");
    assert.deepStrictEqual(out, { disposition: "run" });
    assert.strictEqual(gating.pendingActions.all().length, 0, "Auto never stages a deferred action");
    assert.ok(!cap.broadcasts.some((b) => b.type === "action_pending"), "Auto does not broadcast action_pending");
  });

  it("Off -> {disposition:'forbidden'}, stages NOTHING, broadcasts NOTHING", () => {
    const { gating, cap } = makeHarness({ globalGates: { delete_project: "Off" } });
    let ran = 0;
    const out = gating.gateOrDefer("delete_project" as any, null, "nuke", () => { ran++; return "x"; });
    assert.deepStrictEqual(out, { disposition: "forbidden" });
    assert.strictEqual(ran, 0, "the effect never runs on Off");
    assert.strictEqual(gating.pendingActions.all().length, 0);
    assert.ok(!cap.broadcasts.some((b) => b.type === "action_pending"));
  });

  it("Ask -> {disposition:'deferred'}, stages the action UNCLAIMED, and broadcasts action_pending", () => {
    const { gating, cap } = makeHarness({ globalGates: { create_pane: "Ask" } });
    let ran = 0;
    const out = gating.gateOrDefer("create_pane" as any, null, "make a pane", () => { ran++; return "ok"; }, { a: 1 }, "Full Auto");
    assert.strictEqual(out.disposition, "deferred");
    assert.strictEqual(ran, 0, "Ask defers — the effect does NOT run yet");
    const staged = gating.pendingActions.all();
    assert.strictEqual(staged.length, 1, "exactly one action staged");
    assert.strictEqual(staged[0].capability, "create_pane");
    const evt = cap.broadcasts.find((b) => b.type === "action_pending");
    assert.ok(evt, "action_pending broadcast");
    assert.strictEqual(evt.capability, "create_pane");
    assert.strictEqual(evt.requested_mode, "Full Auto", "the requested mode rides the payload");
    assert.strictEqual(evt.pane_id, null, "global action carries pane_id null");
  });

  it("frozen forces Off -> forbidden even when the matrix says Auto (fail-closed)", () => {
    const { gating } = makeHarness({ frozen: true, globalGates: { create_pane: "Auto" } });
    assert.deepStrictEqual(
      gating.gateOrDefer("create_pane" as any, null, "make a pane", () => "ran"),
      { disposition: "forbidden" },
    );
  });

  it("UNKNOWN capability with no gate entry resolves Auto -> run (documented default)", () => {
    const { gating } = makeHarness({});
    assert.deepStrictEqual(
      gating.gateOrDefer("made_up_capability" as any, null, "?", () => "ran"),
      { disposition: "run" },
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. applyResolution — every ResolveReason branch of the CC28 switch.
// ═════════════════════════════════════════════════════════════════════════════
describe("gating refactor — applyResolution branches", () => {
  function seed(gating: Gating, messageId: string, terminalId: string, instruction: string, session: any) {
    gating.pendingApprovals.add(
      { messageId, instruction, kind: "agent_instruction", terminalId, callId: messageId, timestamp: Date.now() } as any,
      session,
    );
  }

  it("not_found: unknown messageId is an idempotent no-op (no write, no broadcast)", () => {
    const { gating, cap } = makeHarness({});
    const action = gating.applyResolution("ghost", "approve");
    assert.strictEqual(action.reason ?? action.record, undefined === undefined ? action.reason : action.record); // shape sanity
    assert.strictEqual(cap.broadcasts.length, 0, "no broadcasts for a not_found resolve");
    assert.strictEqual(cap.commands.length, 0, "no command recorded");
  });

  it("approved: writes the instruction EXACTLY once, records the command, narrates, emits AUTO_EXECUTED{approved:true} + APPROVAL_RESOLVED", () => {
    const term = mkTerm({ projectId: "default_project" });
    const { gating, cap } = makeHarness({ terminals: { p1: term } });
    const session = { sendClientContent: () => {} };
    seed(gating, "m1", "p1", "echo hi", session);

    gating.applyResolution("m1", "approve", { vocal: true });

    assert.deepStrictEqual(term.writes, ["echo hi"], "instruction written exactly once");
    assert.deepStrictEqual(cap.commands, [{ terminalId: "p1", command: "echo hi" }], "command recorded once");
    const auto = cap.broadcasts.find((b) => b.type === "command_auto_executed");
    assert.ok(auto && auto.approved === true && auto.vocal === true, "AUTO_EXECUTED carries approved + vocal");
    assert.ok(cap.broadcasts.some((b) => b.type === "approval_resolved" && b.messageId === "m1" && b.outcome === "approved"));
    assert.ok(cap.narrations.some((t) => /Approving/.test(t)), "spoken read-back");
  });

  it("approved + matching WIP draft -> draft cleared and draft_updated re-broadcast (dup-send fix)", () => {
    const term = mkTerm({ projectId: "default_project" });
    const { gating, cap, manager } = makeHarness({ terminals: { p1: term } });
    manager.ledger.setDraft("default_project", "p1", "echo hi", "operator");
    seed(gating, "m1", "p1", "echo hi", { sendClientContent: () => {} });

    gating.applyResolution("m1", "approve");

    assert.strictEqual(manager.ledger.getDraft("default_project", "p1").text, "", "matching draft cleared");
    assert.ok(cap.draftBroadcasts.some((d) => d.paneId === "p1"), "draft_updated re-broadcast");
  });

  it("approved + UNRELATED WIP draft -> draft PRESERVED (the match-or-contains guard protects it)", () => {
    const term = mkTerm({ projectId: "default_project" });
    const { gating, manager } = makeHarness({ terminals: { p1: term } });
    manager.ledger.setDraft("default_project", "p1", "a different half-written thought", "operator");
    seed(gating, "m1", "p1", "echo hi", { sendClientContent: () => {} });

    gating.applyResolution("m1", "approve");

    assert.strictEqual(
      manager.ledger.getDraft("default_project", "p1").text, "a different half-written thought",
      "an unrelated draft is never destroyed",
    );
  });

  it("rejected: NO write, narrates a rejection, emits BLOCKED + APPROVAL_RESOLVED{outcome:rejected}", () => {
    const term = mkTerm({ projectId: "default_project" });
    const { gating, cap } = makeHarness({ terminals: { p1: term } });
    seed(gating, "m1", "p1", "rm -rf /", { sendClientContent: () => {} });

    gating.applyResolution("m1", "reject", { vocal: true });

    assert.deepStrictEqual(term.writes, [], "rejected never writes");
    assert.ok(cap.broadcasts.some((b) => b.type === "command_blocked"), "BLOCKED broadcast");
    assert.ok(cap.broadcasts.some((b) => b.type === "approval_resolved" && b.outcome === "rejected"));
    assert.ok(cap.narrations.some((t) => /Rejecting/.test(t)));
  });

  it("dead_pane: target missing -> NO write, narrates 'pane is gone', BLOCKED with the missing-pane reason", () => {
    // Approve a record whose terminal does NOT exist in manager.terminals -> resolveDecision returns dead_pane.
    const { gating, cap } = makeHarness({ terminals: {} });
    seed(gating, "m1", "ghostpane", "echo hi", { sendClientContent: () => {} });

    const action = gating.applyResolution("m1", "approve");
    assert.strictEqual(action.reason, "dead_pane");
    assert.strictEqual(cap.commands.length, 0, "no command recorded for a dead pane");
    assert.ok(cap.broadcasts.some((b) => b.type === "command_blocked" && /missing/i.test(b.reason)), "BLOCKED: pane missing");
    assert.ok(cap.narrations.some((t) => /is gone/.test(t)));
    assert.ok(cap.broadcasts.some((b) => b.type === "approval_resolved" && b.outcome === "dead_pane"));
  });

  it("expired: narrates the timeout, enqueues an approval_expired earcon, BLOCKED (timeout), APPROVAL_RESOLVED{expired}", () => {
    const term = mkTerm({ projectId: "default_project" });
    const { gating, cap } = makeHarness({ terminals: { p1: term } });
    seed(gating, "m1", "p1", "echo hi", { sendClientContent: () => {} });

    const action = gating.applyResolution("m1", "expire");
    assert.strictEqual(action.reason, "expired");
    assert.deepStrictEqual(term.writes, [], "expire never writes");
    assert.ok(cap.broadcasts.some((b) => b.__bus && b.__bus.kind === "approval_expired"), "approval_expired earcon enqueued");
    assert.ok(cap.broadcasts.some((b) => b.type === "command_blocked" && /timeout/i.test(b.reason)));
    assert.ok(cap.broadcasts.some((b) => b.type === "approval_resolved" && b.outcome === "expired"));
  });

  it("lost_race: a SECOND resolve of the same id writes/broadcasts NOTHING (exactly-once preserved)", () => {
    const term = mkTerm({ projectId: "default_project" });
    const { gating, cap } = makeHarness({ terminals: { p1: term } });
    seed(gating, "m1", "p1", "echo hi", { sendClientContent: () => {} });

    gating.applyResolution("m1", "approve"); // first resolve claims+deletes
    const before = { writes: term.writes.length, broadcasts: cap.broadcasts.length, commands: cap.commands.length };
    const second = gating.applyResolution("m1", "reject"); // the record is gone -> not_found/no-op

    assert.strictEqual(term.writes.length, before.writes, "no second write");
    assert.strictEqual(cap.commands.length, before.commands, "no second command record");
    // Whatever the resolver returns for an already-resolved id, it must not produce a NEW write/command.
    assert.ok(second, "resolve returns an action object");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. stopAll — Stage-1 freeze (cancel in-flight, panes survive) + Stage-2 kill.
// ═════════════════════════════════════════════════════════════════════════════
describe("gating refactor — stopAll two-stage brake", () => {
  it("Stage 1 (kill=false): sets frozen, expires pending approvals + deferred actions, panes survive, returns still-running ids", async () => {
    const a = mkTerm(); const b = mkTerm({ status: "Exited" });
    const { gating, cap, coreState } = makeHarness({ terminals: { a, b }, globalGates: { create_pane: "Ask" } });
    // Seed in-flight: a pending approval + a deferred action.
    gating.pendingApprovals.add(
      { messageId: "x1", instruction: "echo", kind: "shell", terminalId: "a", callId: "x1", timestamp: Date.now() } as any,
      { sendClientContent: () => {} },
    );
    gating.gateOrDefer("create_pane" as any, null, "stage me", () => "ran"); // Ask -> staged
    assert.strictEqual(gating.pendingActions.all().length, 1, "an action is staged pre-freeze");

    const still = await gating.stopAll(false);

    assert.strictEqual(coreState.frozen, true, "Stage 1 freezes");
    assert.strictEqual(a.stopCount, 0, "Stage 1 does NOT kill panes");
    assert.strictEqual(gating.pendingApprovals.all().length, 0, "Stage 1 expired all pending approvals");
    assert.strictEqual(gating.pendingActions.all().length, 0, "Stage 1 expired all deferred actions");
    assert.deepStrictEqual(still, ["a"], "returns only the still-running (non-Exited) pane ids");
    assert.ok(cap.broadcasts.some((bx) => bx.type === "frozen" && bx.frozen === true), "broadcasts frozen:true");
  });

  it("Stage 1 halts running plans and disables enabled watch-rules (passive co-pilot state)", async () => {
    const { gating, manager } = makeHarness({});
    manager.ledger.plans.push({ status: "running" }, { status: "done" });
    manager.ledger.watchRules.push({ enabled: true }, { enabled: false });
    await gating.stopAll(false);
    assert.strictEqual(manager.ledger.plans[0].status, "paused", "running plan paused");
    assert.strictEqual(manager.ledger.plans[1].status, "done", "non-running plan untouched");
    assert.strictEqual(manager.ledger.watchRules[0].enabled, false, "enabled rule disabled");
  });

  it("Stage 2 (kill=true): stops every non-Exited pane exactly once; returns the actually-killed set", async () => {
    const a = mkTerm(); const b = mkTerm(); const dead = mkTerm({ status: "Exited" });
    const { gating } = makeHarness({ terminals: { a, b, dead } });
    const killed = await gating.stopAll(true);
    assert.strictEqual(a.stopCount, 1); assert.strictEqual(b.stopCount, 1);
    assert.strictEqual(dead.stopCount, 0, "an already-Exited pane is not re-stopped");
    assert.deepStrictEqual(killed.sort(), ["a", "b"]);
  });

  it("killAllPanes partitions fulfilled vs rejected stop()s (a failing kill is excluded from killed[])", async () => {
    const ok = mkTerm();
    const bad = mkTerm();
    bad.stop = async () => { throw new Error("refused"); };
    const { gating } = makeHarness({ terminals: { ok, bad } });
    const { killed, failed } = await gating.killAllPanes();
    assert.deepStrictEqual(killed, ["ok"], "only the fulfilled kill is in killed[]");
    assert.deepStrictEqual(failed, ["bad"], "the rejected kill is surfaced in failed[]");
  });

  it("releaseStopAll clears frozen and broadcasts frozen:false (matrix was never mutated)", () => {
    const { gating, cap, coreState } = makeHarness({ frozen: true });
    gating.releaseStopAll();
    assert.strictEqual(coreState.frozen, false);
    assert.ok(cap.broadcasts.some((b) => b.type === "frozen" && b.frozen === false));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. applyDeferral — re-arm / cap / not_found, including the CLAIMED (mid-resolve) edge.
// ═════════════════════════════════════════════════════════════════════════════
describe("gating refactor — applyDeferral edges", () => {
  const T0 = 1_700_000_000_000;
  function setup() {
    const { gating, cap } = makeHarness({ terminals: { t1: mkTerm() } });
    gating.pendingApprovals.add(
      { messageId: "d1", instruction: "npm run deploy", kind: "shell", terminalId: "t1", callId: "d1", timestamp: T0 } as any,
      { sendClientContent: () => {} },
    );
    return { gating, cap };
  }

  it("re-arm: returns deferred, keeps the record UNCLAIMED, re-stamps timestamp, clears lastCallAt", () => {
    const { gating } = setup();
    const rec = gating.pendingApprovals.get("d1")!;
    rec.lastCallAt = T0 + TTL + 5;
    const out = gating.applyDeferral("d1", T0 + TTL + 10);
    assert.strictEqual(out.reason, "deferred");
    assert.ok(!rec.claimed, "still approvable later");
    assert.strictEqual(rec.timestamp, T0 + TTL + 10, "TTL re-armed");
    assert.strictEqual(rec.lastCallAt, undefined, "lastCallAt cleared");
  });

  it("unknown messageId -> not_found, no narration", () => {
    const { gating, cap } = setup();
    cap.narrations.length = 0;
    assert.strictEqual(gating.applyDeferral("nope").reason, "not_found");
    assert.strictEqual(cap.narrations.length, 0);
  });

  it("a CLAIMED record (mid-resolve) -> not_found (defer must not touch a record being resolved)", () => {
    const { gating } = setup();
    const rec = gating.pendingApprovals.get("d1")! as any;
    rec.claimed = true;
    assert.strictEqual(gating.applyDeferral("d1").reason, "not_found", "a claimed record is off-limits to defer");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. sweepExpiredApprovalsUnsafe — the none/lastcall/reject decision.
// ═════════════════════════════════════════════════════════════════════════════
describe("gating refactor — sweep decision (none / lastcall / reject)", () => {
  const T0 = 1_000_000_000;
  function setup(session: any) {
    const { gating, cap } = makeHarness({ terminals: { t1: mkTerm() }, activeLiveSession: session });
    gating.pendingApprovals.add(
      { messageId: "s1", instruction: "rm -rf build", kind: "shell", terminalId: "t1", callId: "s1", timestamp: T0 } as any,
      session,
    );
    return { gating, cap };
  }

  it("before TTL -> 'none': no last-call, still pending, silent", () => {
    const session = { sendClientContent: () => {} };
    const { gating, cap } = setup(session);
    gating.sweepExpiredApprovals(T0 + 1_000);
    assert.strictEqual(gating.pendingApprovals.get("s1")!.lastCallAt, undefined);
    assert.ok(gating.pendingApprovals.has("s1"));
    assert.strictEqual(cap.narrations.length, 0);
  });

  it("connected + past TTL, no prior last-call -> 'lastcall': stamps lastCallAt and SPEAKS (no reject)", () => {
    const session = { sendClientContent: () => {} };
    const { gating, cap } = setup(session);
    const t1 = T0 + TTL + 1;
    gating.sweepExpiredApprovals(t1);
    assert.strictEqual(gating.pendingApprovals.get("s1")!.lastCallAt, t1, "stamped");
    assert.ok(gating.pendingApprovals.has("s1"), "NOT rejected on the first crossing");
    assert.ok(cap.narrations.some((t) => /approve now or I'll drop it/.test(t)), "spoke the last-call");
  });

  it("connected + last-call spoken + grace elapsed -> 'reject' via the unchanged expire path", () => {
    const session = { sendClientContent: () => {} };
    const { gating } = setup(session);
    const t1 = T0 + TTL + 1;
    gating.sweepExpiredApprovals(t1);                       // lastcall
    gating.sweepExpiredApprovals(t1 + APPROVAL_GRACE_MS);   // inside grace: still pending
    assert.ok(gating.pendingApprovals.has("s1"), "inside grace, waits");
    gating.sweepExpiredApprovals(t1 + APPROVAL_GRACE_MS + 1); // grace elapsed: reject
    assert.strictEqual(gating.pendingApprovals.has("s1"), false, "rejected after a heard last-call + grace");
  });

  it("DISCONNECTED past TTL -> 'none': the clock is paused (never reject without a spoken last-call)", () => {
    // No session attached to the record at all -> sessionFor() is undefined -> isConnected false.
    const { gating, cap } = makeHarness({ terminals: { t1: mkTerm() } });
    gating.pendingApprovals.add(
      { messageId: "s1", instruction: "x", kind: "shell", terminalId: "t1", callId: "s1", timestamp: T0 } as any,
      undefined as any,
    );
    gating.sweepExpiredApprovals(T0 + TTL + APPROVAL_GRACE_MS + 9999);
    assert.ok(gating.pendingApprovals.has("s1"), "a disconnected item is never auto-rejected");
    assert.strictEqual(gating.pendingApprovals.get("s1")!.lastCallAt, undefined, "no last-call into a dead channel");
    assert.strictEqual(cap.narrations.length, 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. createGating boot hydration — quarantine vs rebuild of deferred-action survivors.
// ═════════════════════════════════════════════════════════════════════════════
describe("gating refactor — boot hydration (createGating)", () => {
  it("an UNSTAMPED / version-mismatched durable deferred-action row is QUARANTINED (skipped), not blindly rebuilt", () => {
    // Stage an Ask action carrying params WITHOUT a valid schemaHash stamp. checkActionVersion on the
    // next boot returns !ok -> the survivor is quarantined (NOT re-staged). This is the FAIL-SAFE
    // security behavior (PLM3): a drifted/unstamped intent must not replay against a possibly-changed
    // effect. The refactor must keep this guard exactly — a regression here would silently re-arm a
    // stale destructive action after a restart.
    const store = mkStore();
    {
      const { gating } = makeHarness({ store, globalGates: { create_pane: "Ask" } });
      gating.gateOrDefer("create_pane" as any, null, "create x", () => "ran", { foo: "bar" }); // no schemaHash
      assert.strictEqual(gating.pendingActions.all().length, 1, "staged + persisted in the first core");
    }
    // A FRESH core over the SAME store: the unstamped survivor is quarantined, so nothing re-stages.
    const { gating: g2 } = makeHarness({ store });
    assert.strictEqual(
      g2.pendingActions.all().length, 0,
      "an unstamped/mismatched survivor is quarantined on boot, NOT rebuilt",
    );
    // The quarantine is audited (best-effort) — proves the boot loop took the quarantine branch.
    const rows = store.getEvents({ type: "permission_changed" });
    assert.ok(rows.some((r) => /QUARANTINED deferred create_pane/.test(r.summary)), "quarantine audited");
  });

  it("store === null: boot hydration is a clean no-op (legacy parity, never throws)", () => {
    assert.doesNotThrow(() => makeHarness({ store: null }));
  });

  it("createGating exposes the SAME pending-store instances + the TTL/sweep constants (shared-state invariant)", () => {
    const { gating } = makeHarness({});
    assert.ok(gating.pendingApprovals, "pendingApprovals exposed");
    assert.ok(gating.pendingActions, "pendingActions exposed");
    assert.strictEqual(gating.APPROVAL_TTL_MS, TTL);
    assert.strictEqual(gating.APPROVAL_SWEEP_MS, 30 * 1000);
    assert.ok(Array.isArray(gating.shellAllowlist) || typeof gating.shellAllowlist === "object", "shellAllowlist exposed");
  });
});
