/**
 * tests/test_panewrite_complexity_refactor.ts — behavior-pinning suite for
 * applyDispatchDecision (src/dispatch/paneWrite.ts), written BEFORE the
 * cyclomatic-complexity extraction (CC 17 → ≤ 10) to guarantee the refactor is
 * byte-for-byte behavior preserving.
 *
 * Coverage goals: every switch case (error_no_pane, error_kind_mismatch,
 * clarify_shell, capability_forbidden, blocked_read_only, auto_execute [+ the
 * inert-pane no-term sub-branch], pending_approval), every active-pane guard
 * branch (guard ON+active, ON+inactive, OFF), and the forceStage downgrade +
 * guard-skip interaction. Fixtures mirror tests/test_dispatch_join.ts.
 *
 * Editing scope per task: this NEW test file + src/dispatch/paneWrite.ts ONLY.
 */
import { describe, it } from "node:test";
import assert from "node:assert";

import {
  applyDispatchDecision,
  type DispatchDeps,
  type DispatchConn,
} from "../src/dispatch/paneWrite";
import { inferKind } from "../src/pendingApprovals";
import { isPaneActiveForWrite } from "../src/activePane";
import type { ProposalDecision } from "../src/pendingApprovals";
import type { CapabilityGate, GateValue } from "../src/types";

interface Recorded {
  writes: Array<{ paneId: string; cmd: string }>;
  commands: Array<{ paneId: string; cmd: string }>;
  broadcasts: Array<Record<string, unknown>>;
  notifies: Array<Record<string, unknown>>;
  announcements: Array<Record<string, unknown>>;
  pendingAdds: Array<{ record: unknown; sess: unknown; opts: unknown }>;
}

function freshRec(): Recorded {
  return {
    writes: [],
    commands: [],
    broadcasts: [],
    notifies: [],
    announcements: [],
    pendingAdds: [],
  };
}

function makeDeps(
  rec: Recorded,
  opts: {
    targetId: string;
    instruction: string;
    activePaneId: string | null;
    forceStage?: boolean;
    hasTerm?: boolean; // default true; false simulates an inert / ledger-only pane
    exited?: boolean; // res2: true simulates a REGISTERED pane whose process died in place
  }
): DispatchDeps {
  const hasTerm = opts.hasTerm !== false;
  return {
    manager: {
      ledger: { activeProjectId: "default_project" },
    } as unknown as DispatchDeps["manager"],
    pendingApprovals: {
      add: (record: unknown, sess: unknown, addOpts: unknown): void => {
        rec.pendingAdds.push({ record, sess, opts: addOpts });
      },
    } as unknown as DispatchDeps["pendingApprovals"],
    broadcast: (msg: any) => rec.broadcasts.push(msg as Record<string, unknown>),
    addCommand: (terminalId: string, command: string) =>
      rec.commands.push({ paneId: terminalId, cmd: command }),
    redactSecrets: (s: string) => `R(${s})`, // visible, idempotent transform so we can assert redaction sites
    getPaneSummary: (id: string, lines: number) => `summary:${id}:${lines}`,
    posturePayloadForPane: (id: string) => ({
      id,
      effective_gates: { write_to_pane: "Ask" } as unknown as Record<CapabilityGate, GateValue>,
      posture: "auto",
    }),
    announcementBus: {
      enqueue: (item: any) => rec.announcements.push(item as Record<string, unknown>),
    },
    approvalTtlMs: 5 * 60 * 1000,
    getActivePaneId: () => opts.activePaneId,
    isPaneActiveForWrite,
    targetId: opts.targetId,
    instruction: opts.instruction,
    capability: "write_to_pane",
    kind: inferKind(undefined, undefined),
    trigger: "Dispatch group 'brief'",
    effectiveMode: "Full Auto",
    pendingId: "call-1__dispatch_x__p_target",
    callId: "call-1",
    term: hasTerm
      ? {
          writeInput: (s: string) => rec.writes.push({ paneId: opts.targetId, cmd: s }),
          status: opts.exited ? "Exited" : "Running",
        }
      : undefined,
    forceStage: opts.forceStage,
  };
}

// guard ON (voice). enforceActivePaneGuard governs the single-active-pane refusal.
function voiceConn(rec: Recorded): DispatchConn {
  return {
    sess: { sendToolResponse: () => {} } as unknown as DispatchConn["sess"],
    notifyPending: (frame: any) => rec.notifies.push(frame as Record<string, unknown>),
    enforceActivePaneGuard: true,
    origin: "voice",
  };
}

// guard OFF (rest). operator-directed click — guard skipped.
function restConn(rec: Recorded): DispatchConn {
  return {
    sess: null,
    notifyPending: (frame: any) => rec.notifies.push(frame as Record<string, unknown>),
    enforceActivePaneGuard: false,
    origin: "rest",
  };
}

// A focused, non-forceStage deps bag so the guard never short-circuits a switch-case test.
function focusedDeps(rec: Recorded, instruction = "do it"): DispatchDeps {
  return makeDeps(rec, { targetId: "p1", instruction, activePaneId: "p1" });
}

// ─────────────────────────────────────────────────────────────────────────────
// Active-pane guard (conn.enforceActivePaneGuard) — all three rows of design §5.
// ─────────────────────────────────────────────────────────────────────────────
describe("applyDispatchDecision — active-pane guard", () => {
  it("guard ON + inactive pane: clarify, NO write, NO broadcast (refused above the mode gate)", () => {
    const rec = freshRec();
    const deps = makeDeps(rec, { targetId: "p_target", instruction: "go", activePaneId: "p_other" });
    const out = applyDispatchDecision({ type: "auto_execute" }, deps, voiceConn(rec));
    assert.strictEqual(out.kind, "clarify");
    assert.strictEqual(rec.writes.length, 0);
    assert.strictEqual(rec.broadcasts.length, 0);
    assert.strictEqual(rec.commands.length, 0);
  });

  it("guard ON + active pane: the switch runs normally (auto_execute lands)", () => {
    const rec = freshRec();
    const deps = makeDeps(rec, { targetId: "p1", instruction: "go", activePaneId: "p1" });
    const out = applyDispatchDecision({ type: "auto_execute" }, deps, voiceConn(rec));
    assert.strictEqual(out.kind, "executed");
    assert.strictEqual(rec.writes.length, 1);
  });

  it("guard OFF (rest) + inactive pane: NO clarify — operator click bypasses the guard", () => {
    const rec = freshRec();
    const deps = makeDeps(rec, { targetId: "p_target", instruction: "go", activePaneId: "p_other" });
    const out = applyDispatchDecision({ type: "auto_execute" }, deps, restConn(rec));
    assert.strictEqual(out.kind, "executed");
    assert.strictEqual(rec.writes.length, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Each switch case — exact return shape + side effects.
// ─────────────────────────────────────────────────────────────────────────────
describe("applyDispatchDecision — switch cases", () => {
  it("error_no_pane", () => {
    const rec = freshRec();
    const deps = makeDeps(rec, { targetId: "pX", instruction: "go", activePaneId: "pX" });
    const out = applyDispatchDecision({ type: "error_no_pane" }, deps, voiceConn(rec));
    assert.deepStrictEqual(out, { kind: "error", text: "Error: pane pX not found." });
    assert.strictEqual(rec.broadcasts.length, 0);
  });

  it("error_kind_mismatch surfaces the decision.reason verbatim", () => {
    const rec = freshRec();
    const deps = focusedDeps(rec);
    const out = applyDispatchDecision(
      { type: "error_kind_mismatch", reason: "kind mismatch boom" } as ProposalDecision,
      deps,
      voiceConn(rec)
    );
    assert.deepStrictEqual(out, { kind: "error", text: "kind mismatch boom" });
  });

  it("clarify_shell surfaces the decision.reason verbatim, no execution", () => {
    const rec = freshRec();
    const deps = focusedDeps(rec);
    const out = applyDispatchDecision(
      { type: "clarify_shell", reason: "use the shell pane" } as ProposalDecision,
      deps,
      voiceConn(rec)
    );
    assert.deepStrictEqual(out, { kind: "clarify", text: "use the shell pane" });
    assert.strictEqual(rec.writes.length, 0);
  });

  it("capability_forbidden: broadcasts command_blocked (redacted cmd) + blocked return", () => {
    const rec = freshRec();
    const deps = makeDeps(rec, { targetId: "p1", instruction: "secret-cmd", activePaneId: "p1" });
    const out = applyDispatchDecision(
      { type: "capability_forbidden", capability: "write_to_pane" },
      deps,
      voiceConn(rec)
    );
    assert.strictEqual(out.kind, "blocked");
    assert.strictEqual(
      (out as { text: string }).text,
      "Error: the 'write_to_pane' capability is gated Off for pane p1; this action is forbidden by policy."
    );
    assert.strictEqual(rec.broadcasts.length, 1);
    assert.deepStrictEqual(rec.broadcasts[0], {
      type: "command_blocked",
      terminalId: "p1",
      cmd: "R(secret-cmd)",
      reason: "Capability 'write_to_pane' is set to Off.",
    });
    assert.strictEqual(rec.writes.length, 0);
  });

  it("blocked_read_only: broadcasts command_blocked + Read-Only blocked return", () => {
    const rec = freshRec();
    const deps = makeDeps(rec, { targetId: "p1", instruction: "rm -rf", activePaneId: "p1" });
    const out = applyDispatchDecision({ type: "blocked_read_only" }, deps, voiceConn(rec));
    assert.strictEqual(out.kind, "blocked");
    assert.strictEqual(
      (out as { text: string }).text,
      "Error: Write execution block is active. Pane p1 is Read-Only."
    );
    assert.deepStrictEqual(rec.broadcasts[0], {
      type: "command_blocked",
      terminalId: "p1",
      cmd: "R(rm -rf)",
      reason: "Read-Only policy enforced.",
    });
    assert.strictEqual(rec.writes.length, 0);
  });

  it("auto_execute: addCommand + RAW writeInput + redacted broadcast + executed return", () => {
    const rec = freshRec();
    const deps = makeDeps(rec, { targetId: "p1", instruction: "ls -la", activePaneId: "p1" });
    const out = applyDispatchDecision({ type: "auto_execute" }, deps, voiceConn(rec));
    assert.strictEqual(out.kind, "executed");
    assert.strictEqual(
      (out as { text: string }).text,
      'Command executed automatically on pane p1: "R(ls -la)"'
    );
    // addCommand + writeInput get the RAW instruction; broadcast gets the REDACTED one.
    assert.deepStrictEqual(rec.commands, [{ paneId: "p1", cmd: "ls -la" }]);
    assert.deepStrictEqual(rec.writes, [{ paneId: "p1", cmd: "ls -la" }]);
    assert.deepStrictEqual(rec.broadcasts[0], {
      type: "command_auto_executed",
      terminalId: "p1",
      cmd: "R(ls -la)",
    });
  });

  it("auto_execute on an INERT pane (no term): error, NOTHING fired", () => {
    const rec = freshRec();
    const deps = makeDeps(rec, {
      targetId: "p1",
      instruction: "ls",
      activePaneId: "p1",
      hasTerm: false,
    });
    const out = applyDispatchDecision({ type: "auto_execute" }, deps, voiceConn(rec));
    assert.deepStrictEqual(out, {
      kind: "error",
      text: "Pane p1 is not running. Start it first (restart the pane), then try again.",
    });
    assert.strictEqual(rec.commands.length, 0, "no command recorded on a dead pane");
    assert.strictEqual(rec.writes.length, 0);
    assert.strictEqual(rec.broadcasts.length, 0);
  });

  // res2 (bead res2 / PTY death handling): a REGISTERED pane whose process crashed/exited IN PLACE
  // (term still present in manager.terminals, term.status === "Exited") previously fell through to
  // term.writeInput — a swallowed no-op against a dead PTY that STILL returned
  // {kind:'executed', ...}, a false-positive success narrated to the operator/model. Must now fail
  // clean with the SAME error shape as the never-spawned/archived (`!term`) case above, and must
  // NOT record the command / write / broadcast a false success.
  it("auto_execute on a REGISTERED-but-EXITED pane (dead in place): clean error, NOTHING fired", () => {
    const rec = freshRec();
    const deps = makeDeps(rec, {
      targetId: "p1",
      instruction: "ls",
      activePaneId: "p1",
      exited: true,
    });
    const out = applyDispatchDecision({ type: "auto_execute" }, deps, voiceConn(rec));
    assert.deepStrictEqual(out, {
      kind: "error",
      text: "Pane p1 is not running. Start it first (restart the pane), then try again.",
    });
    assert.strictEqual(rec.commands.length, 0, "no command recorded on a dead-in-place pane");
    assert.strictEqual(rec.writes.length, 0, "no write reaches the dead PTY");
    assert.strictEqual(rec.broadcasts.length, 0, "no false command_auto_executed broadcast");
  });

  it("pending_approval: stores a serializable record + session, announces, notifies, returns pending", () => {
    const rec = freshRec();
    const deps = makeDeps(rec, { targetId: "p1", instruction: "deploy", activePaneId: "p1" });
    const conn = voiceConn(rec);
    const out = applyDispatchDecision({ type: "pending_approval" }, deps, conn);
    assert.strictEqual(out.kind, "pending");
    assert.strictEqual(
      (out as { text: string }).text,
      // inferKind(undefined,undefined) ⇒ "agent_instruction" ⇒ verb "direct pane".
      'Pending approval: direct pane p1 — "R(deploy)". Read it back to the operator and ask them to approve or reject.'
    );

    // pendingApprovals.add: record carries RAW instruction; rationale carries REDACTED trigger/summary.
    assert.strictEqual(rec.pendingAdds.length, 1);
    const add = rec.pendingAdds[0];
    const record = add.record as Record<string, unknown>;
    assert.strictEqual(record.messageId, "call-1__dispatch_x__p_target");
    assert.strictEqual(record.instruction, "deploy");
    assert.strictEqual(record.terminalId, "p1");
    assert.strictEqual(record.callId, "call-1");
    assert.strictEqual(record.capability, "write_to_pane");
    assert.deepStrictEqual(record.rationale, {
      trigger: "R(Dispatch group 'brief')",
      summary: "R(summary:p1:5)",
    });
    assert.strictEqual(add.sess, conn.sess, "the live session is stashed in the side-map");
    assert.deepStrictEqual(add.opts, { workspaceId: "default_project", ttlMs: 5 * 60 * 1000 });

    // announcement bus carries the REAL approval_pending kind.
    assert.deepStrictEqual(rec.announcements, [
      { kind: "approval_pending", terminalId: "p1", summary: "Awaiting your approval." },
    ]);

    // notify frame: redacted cmd/instruction, posture enrichment, effective_mode, capability.
    assert.strictEqual(rec.notifies.length, 1);
    const n = rec.notifies[0];
    assert.strictEqual(n.type, "approval_pending");
    assert.strictEqual(n.messageId, "call-1__dispatch_x__p_target");
    assert.strictEqual(n.cmd, "R(deploy)");
    assert.strictEqual(n.instruction, "R(deploy)");
    assert.strictEqual(n.terminalId, "p1");
    assert.deepStrictEqual(n.rationale, { trigger: "R(Dispatch group 'brief')", summary: "R(summary:p1:5)" });
    assert.deepStrictEqual(n.effective_gates, { write_to_pane: "Ask" });
    assert.strictEqual(n.posture, "auto");
    assert.strictEqual(n.effective_mode, "Full Auto");
    assert.strictEqual(n.capability, "write_to_pane");

    // no live write on the pending path.
    assert.strictEqual(rec.writes.length, 0);
  });

  it("pending_approval verb is 'run on pane' for a non-agent_instruction kind", () => {
    const rec = freshRec();
    const deps = makeDeps(rec, { targetId: "p1", instruction: "ls", activePaneId: "p1" });
    (deps as { kind: unknown }).kind = "shell_command";
    const out = applyDispatchDecision({ type: "pending_approval" }, deps, voiceConn(rec));
    assert.strictEqual(
      (out as { text: string }).text,
      'Pending approval: run on pane p1 — "R(ls)". Read it back to the operator and ask them to approve or reject.'
    );
  });

  it("pending_approval uses workspace fallback 'default_project' when ledger has no activeProjectId", () => {
    const rec = freshRec();
    const deps = makeDeps(rec, { targetId: "p1", instruction: "deploy", activePaneId: "p1" });
    (deps.manager as unknown as { ledger: { activeProjectId: string | null } }).ledger.activeProjectId =
      null;
    applyDispatchDecision({ type: "pending_approval" }, deps, voiceConn(rec));
    assert.deepStrictEqual((rec.pendingAdds[0].opts as { workspaceId: string }).workspaceId, "default_project");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// forceStage — auto_execute downgrade + guard-clarify-skip (the structural coupling).
// ─────────────────────────────────────────────────────────────────────────────
describe("applyDispatchDecision — forceStage semantics", () => {
  it("forceStage=true: auto_execute on a NON-active pane (guard ON) STAGES, nothing lands", () => {
    const rec = freshRec();
    const deps = makeDeps(rec, {
      targetId: "p_target",
      instruction: "go",
      activePaneId: "p_other",
      forceStage: true,
    });
    const out = applyDispatchDecision({ type: "auto_execute" }, deps, voiceConn(rec));
    assert.strictEqual(out.kind, "pending");
    assert.strictEqual(rec.pendingAdds.length, 1);
    assert.strictEqual(rec.writes.length, 0);
    assert.ok(rec.announcements.some((a) => a.kind === "approval_pending"));
  });

  it("forceStage=false: SAME off-focus setup returns clarify (guard intact)", () => {
    const rec = freshRec();
    const deps = makeDeps(rec, {
      targetId: "p_target",
      instruction: "go",
      activePaneId: "p_other",
      forceStage: false,
    });
    const out = applyDispatchDecision({ type: "auto_execute" }, deps, voiceConn(rec));
    assert.strictEqual(out.kind, "clarify");
    assert.strictEqual(rec.pendingAdds.length, 0);
    assert.strictEqual(rec.writes.length, 0);
  });

  it("forceStage=true on the ACTIVE pane: auto_execute STILL stages (never silently lands)", () => {
    const rec = freshRec();
    const deps = makeDeps(rec, {
      targetId: "p_target",
      instruction: "go",
      activePaneId: "p_target",
      forceStage: true,
    });
    const out = applyDispatchDecision({ type: "auto_execute" }, deps, voiceConn(rec));
    assert.strictEqual(out.kind, "pending");
    assert.strictEqual(rec.writes.length, 0);
    assert.strictEqual(rec.pendingAdds.length, 1);
  });

  it("forceStage=true does NOT downgrade a non-auto decision (pending_approval stays pending)", () => {
    const rec = freshRec();
    const deps = makeDeps(rec, {
      targetId: "p1",
      instruction: "go",
      activePaneId: "p1",
      forceStage: true,
    });
    const out = applyDispatchDecision({ type: "pending_approval" }, deps, voiceConn(rec));
    assert.strictEqual(out.kind, "pending");
    assert.strictEqual(rec.pendingAdds.length, 1);
  });
});
