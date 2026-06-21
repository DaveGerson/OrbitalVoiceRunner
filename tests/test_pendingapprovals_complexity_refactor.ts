/**
 * Pinning tests for the cyclomatic-complexity burndown of src/pendingApprovals.ts.
 *
 * TARGET: decideProposal (the single, security-critical pure gate decision). This suite exercises
 * EVERY branch and ordering edge so a VERBATIM, behavior-preserving extraction can be proven
 * identical. It is intentionally redundant with existing coverage (test_capability_gate.ts,
 * test_approvals_wse.ts) — its job is to LOCK the exact decision lattice during refactor.
 *
 * GREEN against PRE-refactor code, and MUST stay green after.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decideProposal,
  type DecideProposalInput,
  type EffectiveMode,
  type GateValue,
  type ApprovalKind,
  type RuntimeType,
} from "../src/pendingApprovals";

const allow = new Set(["git", "ls", "echo"]);

function input(over: Partial<DecideProposalInput> = {}): DecideProposalInput {
  return {
    kind: "agent_instruction",
    instruction: "do the thing",
    effectiveMode: "Human-in-the-Loop",
    runtimeType: "interactive_cli",
    paneExists: true,
    allowlist: allow,
    ...over,
  };
}

describe("decideProposal — early-exit precedence (order is load-bearing)", () => {
  it("(1) missing pane wins over everything, even an empty instruction", () => {
    const d = decideProposal(input({ paneExists: false, instruction: "" }));
    assert.deepEqual(d, { type: "error_no_pane" });
  });

  it("(1) missing pane wins over an Off gate", () => {
    const d = decideProposal(input({ paneExists: false, gate: "Off", capability: "x" }));
    assert.deepEqual(d, { type: "error_no_pane" });
  });

  it("(2) empty instruction -> clarify_shell, before auto_execute (Full Auto)", () => {
    const d = decideProposal(input({ instruction: "", effectiveMode: "Full Auto", kind: "shell", runtimeType: "shell" }));
    assert.equal(d.type, "clarify_shell");
    if (d.type === "clarify_shell") {
      assert.match(d.reason, /didn't catch a command/);
    }
  });

  it("(2) whitespace-only instruction is treated as empty (trim)", () => {
    const d = decideProposal(input({ instruction: "   \t \n ", effectiveMode: "Full Auto" }));
    assert.equal(d.type, "clarify_shell");
  });

  it("(2) empty instruction clarifies even in Read-Only (before any mode/gate)", () => {
    const d = decideProposal(input({ instruction: "", effectiveMode: "Read-Only", gate: "Off", capability: "z" }));
    assert.equal(d.type, "clarify_shell");
  });

  it("(3) agent_instruction on a shell pane -> error_kind_mismatch", () => {
    const d = decideProposal(input({ kind: "agent_instruction", runtimeType: "shell", instruction: "add retries" }));
    assert.equal(d.type, "error_kind_mismatch");
    if (d.type === "error_kind_mismatch") assert.match(d.reason, /raw shell/);
  });

  it("(3) kind mismatch fires before the Off gate", () => {
    const d = decideProposal(input({ kind: "agent_instruction", runtimeType: "shell", gate: "Off", capability: "w" }));
    assert.equal(d.type, "error_kind_mismatch");
  });

  it("(3) agent_instruction on interactive_cli is NOT a mismatch", () => {
    const d = decideProposal(input({ kind: "agent_instruction", runtimeType: "interactive_cli" }));
    assert.notEqual(d.type, "error_kind_mismatch");
  });

  it("(3) shell kind on a shell pane is NOT a mismatch", () => {
    const d = decideProposal(input({ kind: "shell", runtimeType: "shell", instruction: "git status" }));
    assert.notEqual(d.type, "error_kind_mismatch");
  });
});

describe("decideProposal — shell allowlist (kind:'shell')", () => {
  it("(4) non-allowlisted shell -> clarify_shell with the first token in the reason", () => {
    const d = decideProposal(input({ kind: "shell", runtimeType: "shell", instruction: "npm run build" }));
    assert.equal(d.type, "clarify_shell");
    if (d.type === "clarify_shell") assert.match(d.reason, /"npm"/);
  });

  it("(4) non-allowlisted shell clarifies even in Full Auto (re-route before mode gate)", () => {
    const d = decideProposal(input({ kind: "shell", runtimeType: "shell", instruction: "rm -rf /", effectiveMode: "Full Auto" }));
    assert.equal(d.type, "clarify_shell");
    if (d.type === "clarify_shell") assert.match(d.reason, /"rm"/);
  });

  it("(4) allowlisted shell passes the allowlist check (first token, lowercased)", () => {
    const d = decideProposal(input({ kind: "shell", runtimeType: "shell", instruction: "git status", effectiveMode: "Full Auto" }));
    assert.deepEqual(d, { type: "auto_execute" });
  });

  it("(4) allowlist does NOT apply to agent_instruction (npm allowed through as instruction)", () => {
    const d = decideProposal(input({ kind: "agent_instruction", runtimeType: "interactive_cli", instruction: "npm run build", effectiveMode: "Full Auto" }));
    assert.deepEqual(d, { type: "auto_execute" });
  });
});

describe("decideProposal — gate × mode AND-veto (most-restrictive wins)", () => {
  it("(5) gate Off -> capability_forbidden, echoing the capability", () => {
    const d = decideProposal(input({ gate: "Off", capability: "write_to_pane" }));
    assert.deepEqual(d, { type: "capability_forbidden", capability: "write_to_pane" });
  });

  it("(5) gate Off forbids even in Full Auto", () => {
    const d = decideProposal(input({ gate: "Off", capability: "deliver_handoff", effectiveMode: "Full Auto" }));
    assert.deepEqual(d, { type: "capability_forbidden", capability: "deliver_handoff" });
  });

  it("(5) capability defaults to write_to_pane when omitted, on Off", () => {
    const d = decideProposal(input({ gate: "Off" }));
    assert.deepEqual(d, { type: "capability_forbidden", capability: "write_to_pane" });
  });

  it("(6) Read-Only wins over Ask gate (cannot Ask past Read-Only)", () => {
    const d = decideProposal(input({ effectiveMode: "Read-Only", gate: "Ask" }));
    assert.deepEqual(d, { type: "blocked_read_only" });
  });

  it("(6) Read-Only blocks in plain Auto gate too", () => {
    const d = decideProposal(input({ effectiveMode: "Read-Only", gate: "Auto" }));
    assert.deepEqual(d, { type: "blocked_read_only" });
  });

  it("(6) Off still wins over Read-Only (Off checked first)", () => {
    const d = decideProposal(input({ effectiveMode: "Read-Only", gate: "Off", capability: "c" }));
    assert.deepEqual(d, { type: "capability_forbidden", capability: "c" });
  });

  it("(7) Ask gate forces pending_approval even when mode is Full Auto", () => {
    const d = decideProposal(input({ effectiveMode: "Full Auto", gate: "Ask" }));
    assert.deepEqual(d, { type: "pending_approval" });
  });

  it("(7) Ask gate -> pending in HiTL too", () => {
    const d = decideProposal(input({ effectiveMode: "Human-in-the-Loop", gate: "Ask" }));
    assert.deepEqual(d, { type: "pending_approval" });
  });

  it("(8) Full Auto + Auto gate -> auto_execute", () => {
    const d = decideProposal(input({ effectiveMode: "Full Auto", gate: "Auto" }));
    assert.deepEqual(d, { type: "auto_execute" });
  });

  it("(8) Full Auto with omitted gate (defaults Auto) -> auto_execute", () => {
    const d = decideProposal(input({ effectiveMode: "Full Auto" }));
    assert.deepEqual(d, { type: "auto_execute" });
  });

  it("(9) HiTL + Auto gate -> pending_approval (the else)", () => {
    const d = decideProposal(input({ effectiveMode: "Human-in-the-Loop", gate: "Auto" }));
    assert.deepEqual(d, { type: "pending_approval" });
  });

  it("(9) HiTL with omitted gate -> pending_approval", () => {
    const d = decideProposal(input({ effectiveMode: "Human-in-the-Loop" }));
    assert.deepEqual(d, { type: "pending_approval" });
  });
});

describe("decideProposal — full lattice sweep (mode × gate, valid agent pane)", () => {
  const modes: EffectiveMode[] = ["Full Auto", "Human-in-the-Loop", "Read-Only"];
  const gates: (GateValue | undefined)[] = ["Auto", "Ask", "Off", undefined];

  // Expected decision type for each (mode, gate) cell, derived from the PRE-refactor source order:
  //   Off -> forbidden ; then Read-Only -> blocked ; then Ask -> pending ;
  //   then Full Auto -> auto_execute ; else pending.
  function expected(mode: EffectiveMode, gate: GateValue | undefined): string {
    const g = gate ?? "Auto";
    if (g === "Off") return "capability_forbidden";
    if (mode === "Read-Only") return "blocked_read_only";
    if (g === "Ask") return "pending_approval";
    if (mode === "Full Auto") return "auto_execute";
    return "pending_approval";
  }

  for (const mode of modes) {
    for (const gate of gates) {
      it(`mode=${mode} gate=${gate ?? "(default)"} -> ${expected(mode, gate)}`, () => {
        const d = decideProposal(input({ effectiveMode: mode, gate, kind: "agent_instruction", runtimeType: "interactive_cli" }));
        assert.equal(d.type, expected(mode, gate));
      });
    }
  }
});

describe("decideProposal — defaults & misc", () => {
  it("runtimeType undefined (pane unknown shape) does not trip the mismatch for agent_instruction", () => {
    const d = decideProposal(input({ kind: "agent_instruction", runtimeType: undefined, effectiveMode: "Full Auto" }));
    assert.deepEqual(d, { type: "auto_execute" });
  });

  it("shell kind with runtimeType undefined still checks allowlist", () => {
    const d = decideProposal(input({ kind: "shell", runtimeType: undefined, instruction: "ls -la", effectiveMode: "Full Auto" }));
    assert.deepEqual(d, { type: "auto_execute" });
  });

  it("shell kind, allowlisted, but Off gate -> forbidden (gate after allowlist)", () => {
    const d = decideProposal(input({ kind: "shell", runtimeType: "shell", instruction: "git status", gate: "Off", capability: "shell_cap" }));
    assert.deepEqual(d, { type: "capability_forbidden", capability: "shell_cap" });
  });
});
