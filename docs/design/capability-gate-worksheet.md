# Capability-Gate Modulation — Behavior Worksheet & Test Spec

> Purpose: the authoritative, human-evaluable specification of how the capability
> gate **modulates** what Janus is allowed to do. Every row here is asserted by
> `tests/test_capability_gate.ts`. If you want to change the safety behavior, change
> this table first, then the test, then the code.

## The two mechanisms

The capability gate is **two composable pieces**:

1. **Resolution** — `resolveCapabilityGate(paneGate, globalGate)` decides WHICH gate
   value applies for a (pane, capability): the per-pane override wins; else the global
   default; else `Auto` (back-compat = today's mode-only behavior).
2. **AND-veto** — `decideProposal(...)` composes the resolved `gate` with the pane's
   `effectiveMode` into a single decision. **A gate can only TIGHTEN, never loosen, the
   mode.** Most-restrictive wins: `Off > Read-Only > Ask > (Auto/Full-Auto)`.

## Mechanism 1 — Resolution precedence

`resolveCapabilityGate(paneGate, globalGate)`:

| paneGate | globalGate | Result | Why |
|----------|-----------|--------|-----|
| `Ask`  | (any)    | `Ask`  | Per-pane override always wins |
| `Off`  | `Auto`   | `Off`  | Per-pane override wins even when global is looser |
| `Auto` | `Off`    | `Auto` | Per-pane override wins even when global is stricter (override is explicit) |
| —      | `Ask`    | `Ask`  | No pane override ⇒ global default applies |
| —      | —        | `Auto` | No override, no global ⇒ Auto (absent matrix = legacy behavior) |

Key property: an **explicit per-pane value always wins**, in both directions. A pane set
to `Auto` overrides a global `Off` — this is intentional (the override is a deliberate
operator/director act). The matrix is a default; the pane is the exception.

## Mechanism 2 — The AND-veto truth table

Assumes: pane exists, instruction is non-empty, and kind/allowlist checks have passed
(those are tested separately in `test_approvals_wse.ts`). Columns = resolved gate; rows =
effective permission mode.

| effectiveMode ↓ \ gate → | `Auto`              | `Ask`              | `Off`                  |
|--------------------------|---------------------|--------------------|------------------------|
| **Full Auto**            | `auto_execute`      | `pending_approval` | `capability_forbidden` |
| **Human-in-the-Loop**    | `pending_approval`  | `pending_approval` | `capability_forbidden` |
| **Read-Only**            | `blocked_read_only` | `blocked_read_only`| `capability_forbidden` |

Reading the table — the safety invariants it encodes:
- **`Off` forbids outright** in every mode (top of the lattice). Even a Read-Only pane
  reports `capability_forbidden` (Off is evaluated before Read-Only).
- **`Read-Only` cannot be loosened by a gate.** `Ask` on a Read-Only pane does NOT become
  a pending write — it stays `blocked_read_only`. You cannot Ask your way past Read-Only.
- **`Ask` tightens Full-Auto.** A Full-Auto pane with `Ask` gate does NOT auto-execute —
  it forces a human approval. This is how the director keeps a checkpoint on a fast pane.
- **`Auto` is transparent** — it defers entirely to the mode (the legacy behavior).

### Edge cases (also asserted)
| Case | Input | Expected | Why |
|------|-------|----------|-----|
| Missing pane | `paneExists=false` | `error_no_pane` | Checked first, before any gate |
| Empty instruction | `instruction="  "` | `clarify_shell` | Never type a bare newline, in any mode |
| Gate omitted | `gate=undefined` | defaults to `Auto` | Back-compat: absent matrix = mode-only |
| Off + missing pane | `Off`, `paneExists=false` | `error_no_pane` | Pane existence outranks the gate |

## How to evaluate this worksheet (for the director)

1. Read the 3×3 table as a **lattice of restriction**. Ask: "for each pane I run, is the
   most-restrictive-wins rule what I want?" The contentious cell is usually
   *Full-Auto × Ask* (does an Ask gate justify interrupting a pane I marked Full-Auto?).
2. Check the **resolution direction**: do you want a per-pane `Auto` to be able to override
   a global `Off`? (Current answer: yes — the pane is the explicit exception.) If you want
   global `Off` to be a hard floor nothing can override, that is a *different* table and we
   change `resolveCapabilityGate`.
3. Everything here is mechanical and proven by the test. The *policy* questions (what the
   DEFAULTS should be per capability) live in `janus-capability-gate-handoffs.md`.

## Test coverage map

`tests/test_capability_gate.ts` asserts:
- All 9 cells of the AND-veto table (mode × gate), pane-exists + non-empty + allowlist-clean.
- `Off` beats `Read-Only` (reports `capability_forbidden`, not `blocked_read_only`).
- `Ask` does NOT loosen `Read-Only`.
- `Ask` DOES tighten `Full Auto`.
- All 5 resolution-precedence rows.
- The 4 edge cases above.
- Back-compat: omitting `gate` reproduces the pre-matrix decision for all three modes.
