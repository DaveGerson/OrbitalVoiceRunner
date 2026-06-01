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

## The spotlight (context-aware resolution) — `resolveCapabilityGateWithContext`

Resolution now has FOUR tiers (precedence, highest first). The director posture is
"trust follows focus": Janus acts freely on the pane the director is looking at.

1. **Explicit per-pane override** — always wins, both directions (the deliberate exception).
2. **Spotlight** — if `paneId === activePane` AND the capability is *productive* (in
   `SPOTLIGHT_CAPABILITIES` = `write_to_pane`, `deliver_handoff`), resolve to `Auto`. Only
   fires when there is no per-pane override (tier 1).
3. **Global default** — the matrix below (`DEFAULT_CAPABILITY_GATES`).
4. **`Auto`** — absent everything (legacy).

The spotlight NEVER loosens destructive (`close_pane`/`restart_pane`), meta
(`set_*_permissions`/`set_capability_gate`), or spawn (`create_pane`/`apply_recipe`/
`execute_plan`) capabilities — those always fall through to tier 3/4 even on the active pane.

## Default global matrix (`DEFAULT_CAPABILITY_GATES`) — "friction is worse, gate by category"

This is the OFF-CONTEXT baseline. `Ask` for the sharp edges; `Auto` for low-risk orientation.

- **Ask:** `write_to_pane`, `deliver_handoff` (productive writes off-context), `create_pane`,
  `execute_plan`, `apply_recipe`, `add_watch_rule` (spawn/cost), `close_pane`, `restart_pane`
  (destructive), `set_pane_permissions`, `set_global_permissions`, `set_capability_gate` (meta).
- **Auto:** `create_project`, `update_metadata`, `switch_context`, `set_voice_mute`,
  `dismiss_attention` (low-risk orientation).

On the ACTIVE pane, the spotlight loosens `write_to_pane`/`deliver_handoff` to `Auto`.

## Meta-gate — voice may TIGHTEN, never LOOSEN (`isLoosening`)

`set_capability_gate` by VOICE is allowed to make a gate MORE restrictive (Auto→Ask, Ask→Off)
and applies immediately. A LOOSENING change (Off→Ask, Ask→Auto) is REFUSED by voice and must
be done deliberately in the Settings UI — so a confused/misheard Janus cannot loosen its own
restraints. Restriction rank: `Auto(0) < Ask(1) < Off(2)`.

## Secret guard — prompts must never carry secrets (`classifySecrets`)

A composed prompt is classified before staging/delivery:
- **high** (recognized formats: private key, JWT, AWS/Google/GitHub/Slack keys) ⇒ **hard-block**
  staging AND delivery; audited.
- **low** (ambiguous `key=value` assignment) ⇒ deliver/stage **with a warning** (never silently
  mutate the verbatim prompt the PTY needs).
- **none** ⇒ proceed.

## Staged staleness — flag, never delete (`isStagedStale`)

A staged-but-undelivered handoff NEVER auto-expires. `list_handoffs` derives a `stale` flag +
`staged_age_seconds` at read time (threshold `STAGED_STALE_MS` = 15 min) so the operator can
notice; nothing is deleted.

## Test coverage map

`tests/test_capability_gate.ts` asserts:
- All 9 cells of the AND-veto table (mode × gate), pane-exists + non-empty + allowlist-clean.
- `Off` beats `Read-Only` (reports `capability_forbidden`, not `blocked_read_only`).
- `Ask` does NOT loosen `Read-Only`.
- `Ask` DOES tighten `Full Auto`.
- All 5 resolution-precedence rows.
- The 4 edge cases above.
- Back-compat: omitting `gate` reproduces the pre-matrix decision for all three modes.
