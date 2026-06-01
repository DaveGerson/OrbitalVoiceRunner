# Janus Capability-Gate Matrix + First-Class Handoffs

> Status: implemented (v1) on `claude/prompt-composer-refactor`. Backend verified
> (`npm run lint`, `npm run smoke:handoff`). Voice/UI legs pending live test.

## Product thesis

Janus is a **human-in-the-loop thought partner** that accelerates software creation.
The human is the **director** (sets strategy, architects the technical design); Janus is
the **project manager** that helps delegate work to a team of CLI terminal agents
(Claude Code / Codex / Antigravity running in panes). The director drives by **voice**;
Janus and the director **co-author** the prompts delegated to the CLI agents. Janus never
autonomously writes to an agent — it drafts, the director refines by voice, the director
approves delivery.

## The safety model: one capability × gate matrix

Janus must be **able to do everything**. Safety comes from a settings-controlled
**approval matrix**: every Janus capability has a gate policy `Auto | Ask | Off`, with a
global default and a per-pane override. This is the single dial that keeps the system from
becoming erratic.

The matrix **generalizes the existing `effectiveModeFor` / `dispatchProposal` /
`decideProposal` spine** (which previously gated only `propose_command`) to the full
capability set. The resolver applies an **AND-veto: most-restrictive-wins** — the
per-capability gate is composed with the pane's effective permission mode, and the stricter
of the two governs. `Off` is the hard veto; `Read-Only` beats `Ask`; `Ask` forces a pending
approval; `Auto` defers to the effective mode.

| Capability | Default gate | Settings key |
|---|---|---|
| `write_to_pane` | Ask | `capabilityGates.write_to_pane` |
| `deliver_handoff` | Ask | `capabilityGates.deliver_handoff` |
| `create_pane` | Ask | `capabilityGates.create_pane` |
| `close_pane` | Ask | `capabilityGates.close_pane` |
| `restart_pane` | Ask | `capabilityGates.restart_pane` |
| `set_pane_permissions` | Ask | `capabilityGates.set_pane_permissions` |
| `set_global_permissions` | Ask | `capabilityGates.set_global_permissions` |
| `set_capability_gate` | Ask (voice) / Auto (REST-UI) | `capabilityGates.set_capability_gate` |
| `add_watch_rule` | Ask | `capabilityGates.add_watch_rule` |
| `execute_plan` | Ask | `capabilityGates.execute_plan` |
| `apply_recipe` | Ask | `capabilityGates.apply_recipe` |
| `create_project` | Auto | `capabilityGates.create_project` |
| `update_metadata` | Auto | `capabilityGates.update_metadata` |
| `switch_context` | Auto | `capabilityGates.switch_context` |
| `set_voice_mute` | Auto | `capabilityGates.set_voice_mute` |
| `dismiss_attention` | Auto | `capabilityGates.dismiss_attention` |
| `compose_or_revise_draft` | **never gated** (by design — never touches a pane) | (none) |
| reads (`list_panes` / `get_pane_summary` / `list_handoffs` / …) | Auto (ungatable; redaction is the control) | (none) |

### Settings shape (additive, back-compatible)

```ts
// src/types.ts
export type CapabilityGate =
  | "write_to_pane" | "deliver_handoff" | "create_pane" | "close_pane"
  | "restart_pane" | "set_pane_permissions" | "set_global_permissions"
  | "set_capability_gate" | "add_watch_rule" | "execute_plan"
  | "apply_recipe" | "create_project" | "update_metadata"
  | "switch_context" | "set_voice_mute" | "dismiss_attention";
export type GateValue = "Auto" | "Ask" | "Off";

// SystemSettings.advanced (optional): capabilityGates?: Partial<Record<CapabilityGate, GateValue>>
// CliPreset + PaneMeta carry the same optional shape (per-pane override / template).
// Absent => effectiveCapabilityGateFor returns "Auto" (today's implicit behavior).
```

## The Handoff artifact (first-class, SQLite-persisted)

A `Handoff` is a typed edge between two panes, moving through a state machine. **Compose /
revise / stage never touch a pane** (they only mutate the stored artifact); the
**staged → delivered** transition rides the `deliver_handoff` gate and lands the composed
prompt verbatim in the target pane's PTY.

```
 propose ─▶ composing ⇄ revising ─▶ staged ─▶[deliver_handoff GATE]─▶ delivered ─▶ consumed
                                                  │
                                                  └─▶ rejected / blocked_read_only / expired
```

- **Persistence:** `handoffs` table (migration → `user_version=2`), with `events.handoff_id`
  for the audit trail. Every state transition is an atomic row-flip **plus** a `HANDOFF`
  audit event in one `recordActivity` transaction, so the live row and the audit spine can
  never diverge. Source context is **redacted**; `composed_prompt` is stored verbatim and
  **not FTS-indexed** (avoids surfacing secrets).
- **Source may be an archived/exited pane** (captured from scrollback/history), fixing the
  live-only limitation of the legacy handoff.
- **`deliver_handoff` is the sole writer** — it routes through `dispatchProposal`. Full-Auto
  flips to `delivered` immediately; HiTL persists `gate_approval_id` and the row flips in
  `flipHandoffOnResolve` on approval (the same post-write choke-point as every other gated
  write); Read-Only/Off blocks.

## New Gemini tools

- **Ungated (store-only):** `propose_handoff`, `revise_handoff`, `stage_handoff`,
  `read_handoff`, `list_handoffs`, `reject_handoff`.
- **Gated (`deliver_handoff`):** `deliver_handoff` — the only handoff tool that writes.
- **Matrix control:** `set_capability_gate`, `get_pane_gates`, `list_capabilities`.

## Accepted debt (v1)

- **Ask-tier for non-PTY mutating handlers** (`create_pane` / `set_pane_permissions` /
  `set_global_permissions`): the `Off` veto is enforced and audited, but `Ask` currently
  proceeds-and-audits rather than staging a deferred side effect (there is no in-flight
  `writeInput` to defer). Full deferred-execution staging is **WS-F**.
- **Two-store seam:** the in-memory `PendingApprovalStore` remains the live gate; v1
  persists handoff rows + audit events only. Full `PendingApproval` persistence is **WS-F**.
- **Smoke coverage:** `scripts/smoke-handoff.ts` proves persistence rigorously and proves
  real PTY delivery via a `bytesAfter > 0` check; it does not yet assert response *content*
  (PONG) nor drive the full server `deliver_handoff` → `flipHandoffOnResolve` handler
  (it exercises `decideProposal` + delivery inline). Hardening is a follow-up.

## Director decisions (2026-06-01)

1. **`deliver_handoff` default = GLOBAL AUTO + per-pane gating** (not always-Ask). Added
   dimension to design: the gate dial is also about **context management of panes/projects**,
   not only autonomy/trust — gating may key off context-scope, not just a trust flag. *(To be
   designed when we implement the default flip.)*
2. **Meta-gate = self-gate voice changes.** `set_capability_gate` by VOICE requires director
   approval; the UI stays direct. Closes G5.
3. **Secrets must never be in prompts at all.** Secrets exist only for Gemini auth (live +
   synthesis APIs). `composed_prompt` must never store/index/surface secrets — stronger than
   "don't FTS-index": guard on compose + never index + audit.
4. **Next = clean branch + harden smoke tests** (done: G2/G4 closed on `feat/handoff-hardening`;
   G3 server-path coverage still open). Two-store seam / WS-F deferral accepted.

## Open questions for the director

1. `deliver_handoff` default gate is `Ask` (mirrors `write_to_pane`). Should trusted panes
   default to `Auto`?
2. Staged-but-undelivered drafts: no auto-expire in v1 (only pending-approval sweeps at
   5 min). Want a separate staged-draft staleness TTL?
3. `set_capability_gate` via voice is `Ask` but REST/UI is `Auto` (prevents a bootstrap
   lock-out — the UI is the human). Confirm the asymmetry is acceptable.
4. Confirm `composed_prompt` is never FTS-indexed (secret-surface avoidance).
5. Confirm the two-store seam (defer full `PendingApproval` persistence to WS-F) is
   acceptable for this one-pass build.
