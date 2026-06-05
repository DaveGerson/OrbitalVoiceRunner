# Multi-CLI Permission-Mode Adapter + Live Mode-Switch + Manual Key Controls

**Date:** 2026-06-05
**Status:** Draft for review
**Primary bead:** `wsm-e2e-pinned-1y8` (restart_pane voice tool: Full-Auto must reach the LIVE process + drain pending)
**Companion scope:** GUI control-key bar (operator request, 2026-06-05)
**Proposed new beads:** `agent-adapter-extraction`, `pane-raw-key-controls`, `multi-cli-live-switch-verification`

---

## 1. BLUF

Introduce a polymorphic **`AgentAdapter`** (one per CLI preset: Claude Code / Codex / Antigravity / Custom) that owns *every* per-CLI difference — spawn flags, permission-mode mechanics, session pinning, and resume — behind one interface. On top of it:

1. **`restart_pane` voice tool + a single `applyPaneMode` choke point** so a Full-Auto promotion actually **reaches the live process** (bead `1y8`), draining pending approvals/actions on promotion.
2. A **manual GUI control-key bar** (arrows, `Ctrl+C`, `Shift+Tab`, `Esc`, `Enter`, …) that writes raw control bytes into a pane's PTY.

All three converge on **one new low-level primitive — `UniversalTerminal.writeRaw(bytes)`** — a single unbuffered `transport.write()` with no Enter-append and no paste-burst split. The live mode-switch and the `Shift+Tab` button are *literally the same call*.

The headline behavioral guarantee: **launch every agent pane safe-but-escalation-ready, switch to Full-Auto live where the CLI supports it, and fall back to a lossless restart-resume where it doesn't.**

---

## 2. Background — the current-state bugs this fixes

| # | Problem | Evidence |
|---|---|---|
| B1 | **Full-Auto never reaches a live pane.** `setPermissionsMode()` only mutates the *next* spawn's command string; the running process is unaffected. | `src/terminal.ts:444-456` |
| B2 | **Claude's bypass flag is wrongly injected into Codex & Antigravity.** Every non-Custom spawn appends `--dangerously-skip-permissions` — an Anthropic-only flag. | `src/terminal.ts:417-425` |
| B3 | **Session capture is unreliable.** A synthetic non-UUID id is generated, then `checkForSessionId()` scrapes stdout for a session id that **Claude never prints** → `--resume` rarely fires. | `src/terminal.ts:429-438`, `462-478`; research: ids live only at `~/.claude/projects/<cwd>/<uuid>.jsonl` |
| B4 | **No raw-key path.** `/api/terminals/:id/input` always appends Enter (submit semantics); the frontend xterm forwards no keystrokes. No way to send `Ctrl+C`, arrows, or `Shift+Tab`. | `server.ts:1066-1082`, `src/terminal.ts:837-855`, `src/components/TerminalView.tsx` (no `onData`) |
| B5 | **All CLI branching is inline `if (toolPreset !== "Custom")`** (≥6 sites) — the root of why Codex/Antigravity behavior is wrong and untestable. | `src/terminal.ts:134, 165, 417, 431, 446, 463` |

---

## 3. Architecture — one primitive, three consumers

```
                       ┌─────────────────────────────────────────┐
                       │  UniversalTerminal.writeRaw(bytes)       │  ← the ONE new primitive
                       │  = transport.write(bytes)  (no \r, no    │
                       │    paste split, guarded on !transport)   │
                       └──────────────▲───────────▲───────────────┘
                                      │           │
              ┌───────────────────────┘           └───────────────────────┐
   POST /api/terminals/:id/raw-input              AgentAdapter.planModeChange(from,to)
   (GUI control-key bar → writeRaw)               → { live-signal: ESC[Z steps } | { restart-resume } | { unsupported }
                                                          │
                                                  applyPaneMode(paneId, mode)  ← single choke point
                                                  (voice restart_pane • UI <select> • voice set_pane_permissions)
```

**Key principle:** the *generic* raw key bar sends literal keystrokes (a `Shift+Tab` button writes `ESC[Z` verbatim — correct only where that CLI binds it to mode-cycling). The *semantic* "promote this pane to Full-Auto" action goes through `applyPaneMode` → the adapter, which picks the right per-CLI mechanism (which may **not** be `ESC[Z`). Two distinct surfaces, one primitive.

---

## 4. The `AgentAdapter` interface

One adapter instance per pane, selected by `tool_preset`. Lives in a new `src/agents/` module (`src/agents/index.ts` + `claude.ts`, `codex.ts`, `antigravity.ts`, `custom.ts`). `UniversalTerminal` holds an `adapter` and delegates all preset-conditional logic to it, retiring the six inline branches (B5).

```ts
type Mode = "Full Auto" | "Human-in-the-Loop" | "Read-Only";
type ModeStep = { bytes: string; expectMarker?: RegExp };   // one read-after-write cycle step

interface AgentAdapter {
  readonly preset: "Claude Code" | "Codex" | "Antigravity" | "Custom";

  // — spawn —
  resolveSpawnCommand(cwd: string): { bin: string; onPath: boolean };
  generateSessionId(): string | null;                 // Claude: UUID; others: null (capture post-spawn)
  buildLaunchCommand(o: { mode: Mode; sessionId: string | null; cwd: string; seedPrompt?: string }):
    { argv: string[]; bypassSeededInRing: boolean; launchWindowHot: boolean };
  buildResumeCommand(o: { sessionId: string; mode: Mode; cwd: string }): { argv: string[] };
  safeStartCycle(): ModeStep[];                        // steps to cycle DOWN from a hot launch (empty if not hot)

  // — live permission mode —
  planModeChange(from: Mode, to: Mode):
      { kind: "live-signal"; steps: ModeStep[] }
    | { kind: "restart-resume" }
    | { kind: "unsupported" };
  modeCycleByte(): string | null;                      // Claude ESC[Z; agy ESC[1;2B (once verified); Codex null
  parseCurrentMode(ptyFrame: string): Mode | null;     // read-after-write status-bar parser (null = keep reading)

  // — session continuity —
  pinnedSessionId(): string | null;
  captureSessionId(ctx: { ptyOutput: string; cwd: string }): string | null;

  // — feature flags (orchestrator hides/falls back per CLI) —
  capabilities(): {
    supportsLivePermissionSwitch: boolean;
    supportsSessionPin: boolean;
    supportsResume: boolean;
    modeSupport: boolean;            // false for Custom → hide the mode dial
    readyForLiveCycle: boolean;      // false for Codex/agy until verification bead flips it
  };
}
```

**Design rationale**
- `parseCurrentMode` + `ModeStep.expectMarker` enforce **read-after-write** — never blind cycle-counting (Claude `auto` mode and Codex's picker are non-idempotent and will desync a counter).
- `planModeChange` is the single polymorphic decision point: Claude → `live-signal`; Codex/agy → `restart-resume` (until verified); Custom → `unsupported`.
- `capabilities().readyForLiveCycle` lets us ship Claude's live path immediately while Codex/agy stay on the safe restart-resume floor — same interface, no forked call sites.

---

## 5. Per-CLI strategy table

| | **Claude Code** (HIGH conf.) | **Codex** (LOW — not installed) | **Antigravity `agy` v1.0.4** (LOW) | **Custom** |
|---|---|---|---|---|
| **Binary** | `claude` (on PATH), v2.1.158 | `codex` (absent locally) | full path `…\agy\bin\agy.exe` (not on PATH until `agy install`) | user argv |
| **Safe-but-ready launch** | `claude --session-id <uuid> --allow-dangerously-skip-permissions --permission-mode plan` (bypass seeded in ring, **not** hot) | `codex --sandbox workspace-write --ask-for-approval on-request` (set safety by launch flags) | `agy.exe --dangerously-skip-permissions -i "<seed>"` (**hot launch window** — no `--allow-` equivalent) | verbatim argv, no flags |
| **Live → Full-Auto** | ✅ `ESC[Z` (0x1b5b5a) ring steps, read-after-write | ⚠️ `/permissions` picker only (`Shift+Tab` = *Plan/Default*, NOT perms) → **restart-resume** | ❓ `shift+down` `ESC[1;2B` cycle **unverified axis** → **restart-resume** | ❌ unsupported |
| **Session pin** | ✅ `--session-id <uuid>` (deterministic) | ❌ capture newest `~/.codex/sessions/.../rollout-*.jsonl` UUID | ❌ capture quit-msg / newest `~/.gemini/antigravity-cli/brain/<uuid>/` | ❌ none |
| **Lossless resume** | `claude --resume <uuid> --dangerously-skip-permissions` (no `--fork-session`) | `codex resume <id> --dangerously-bypass-approvals-and-sandbox` | `agy.exe --conversation=<uuid> --dangerously-skip-permissions` | cold respawn |
| **Status marker** | only `acceptEdits`⇒`⏵⏵ accept edits on` confirmed; rest TBD live | footer + `/status` TBD live | tokens `request-review\|proceed-in-sandbox\|always-proceed\|strict`, customizable via `/statusline` | n/a |

`Full Auto` ≡ true permission bypass (Claude `bypassPermissions`; Codex Full-Access/`--yolo`; agy `always-proceed`). `Human-in-the-Loop` ≡ asks per action (Claude `default`; Codex `on-request`; agy `request-review`). `Read-Only` ≡ the most restrictive non-acting mode (Claude `plan`; Codex `read-only`; agy `strict`). The three Janus modes map to **distinct** per-CLI modes — no overlap.

---

## 6. The `applyPaneMode` choke point (bead `1y8`)

A single async function (in `OrchestratorManager` or the server `coreState`) that **every** mode-change caller routes through:

```
applyPaneMode(paneId, targetMode, source):  // source ∈ voice | ui | restart_pane
  1. gate: gateOrDefer("set_pane_permissions", paneId, …)  → forbidden | deferred | allowed
  2. plan = pane.adapter.planModeChange(pane.currentMode, targetMode)
  3. switch plan.kind:
       live-signal    → for each step: term.writeRaw(step.bytes); await readUntil(step.expectMarker, timeout)
       restart-resume → sid = pane.adapter.pinnedSessionId() ?? pane.capturedSessionId
                        term.shellCmd = adapter.buildResumeCommand({sessionId: sid, mode: targetMode}).argv
                        await term.stop(); term.start()   // existing lifecycle; start() reads the rebuilt command
       unsupported    → return { ok:false, reason:"pane has no permission model" }
  4. if targetMode === "Full Auto": drain pending approvals + pending actions for paneId   (§11)
  5. persist mode to ledger (PERSIST-WINS, see note); broadcast settings_updated + terminals_updated
```

**Callers unified:** the new `restart_pane` voice tool (a gated `ActionDef`, mirroring `set_pane_permissions` at `src/actions/defs/locks.ts:110`), the UI mode `<select>` (`App.tsx:3970`), and voice `set_pane_permissions` all call `applyPaneMode`. The existing `set_pane_permissions` is refactored to delegate here instead of the inert `setPermissionsMode`.

**Interaction with bead `gpd` (PERSIST-WINS):** step 5 writes operator intent to the ledger; `syncLedger` must already prefer persisted mode (that's `gpd`). These are siblings — `applyPaneMode` is the writer, `gpd` guarantees a later sync won't revert it. Note the dependency in both beads.

---

## 7. Raw-input primitive + endpoint (fixes B4)

**`UniversalTerminal.writeRaw(bytes: string): void`** — the sole raw path:
```ts
writeRaw(bytes: string): void {
  if (!this.transport) return;          // inert/un-spawned pane → no-op (caller surfaces 409)
  this.transport.write(bytes);          // single combined write; NO \r, NO deliverSubmit, NO paste split
}
```
`transport.write` is already a pure passthrough (`src/ptyTransport.ts:134-140`) — no transport change needed.

**`POST /api/terminals/:id/raw-input`** — `{ bytes: string }` → look up `manager.terminals[id]` (404 if missing, **409 if not spawned**) → gate per §10 → `term.writeRaw(bytes)`. ~12–15 lines, mirrors the existing input endpoint (`server.ts:1066-1082`) but skips `writeInput`/history. (WS `raw_input` message is a deferred alternative; REST is simpler for discrete clicks and is the same surface the adapter calls server-side.)

---

## 8. GUI control-key bar (operator request)

**Key → byte map**

| Key | Bytes | Class |
|---|---|---|
| Up / Down / Right / Left | `ESC[A` / `ESC[B` / `ESC[C` / `ESC[D` | nav (always-allowed) |
| Enter | `0x0d` (CR) | nav (commits already-staged) |
| Tab | `0x09` | nav |
| Esc | `0x1b` | nav (dismiss/cancel) |
| PageUp / PageDown | `ESC[5~` / `ESC[6~` | nav (program scrollback) |
| **Ctrl+C** | `0x03` (ETX/SIGINT) | **disruptive (gated)** |
| **Shift+Tab** | `ESC[Z` (0x1b5b5a) | **disruptive (gated)** |

**UI:** compact control strip injected at `src/App.tsx:3775` (above the Restart/Connect row), mirrored into the compact-grid cluster (~`App.tsx:3861`), independent of the mode `<select>`. Three groups (nav / terminal-ops / disruptive), reusing the existing icon-button class (`p-2 border border-white/5 hover:… text-zinc-400 hover:text-white rounded active:scale-95`); disruptive keys take the amber/warn `POSTURE_STYLE` tint. Each button → `writeControlKey(paneId, bytes)` (mirrors `handleRestartTerminal`, `App.tsx:1114`) → the raw-input endpoint. `title=` tooltips for accessibility; condense to icon-only/overflow on narrow viewports.

**Caveat captured:** the literal `Shift+Tab` button is a *raw key* (only cycles modes on Claude). The *semantic* Full-Auto promotion is the mode `<select>`/voice path → `applyPaneMode`. Both ride `writeRaw`, but they are different affordances.

---

## 9. Session determinism & restart-resume fallback

- **Claude:** orchestrator **generates** the UUID, passes `--session-id <uuid>` at first launch, stores it. Resume = `--resume <uuid>` on respawn (do **not** combine `--session-id`+`--resume` in one invocation; do **not** pass `--fork-session`; never `--no-session-persistence`). This **replaces** the unreliable `checkForSessionId` scrape (B3).
- **Codex / agy:** no pin flag → `captureSessionId()` watches the newest on-disk rollout/brain dir (or scrapes agy's quit message) right after spawn. agy multi-pane hazard: `-c` resumes most-recent *globally-in-workspace* → **always resume by explicit `--conversation=<uuid>`**, or give each pane its own workspace dir.

---

## 10. Capability-gating model (zero new matrix rows for v1)

Bifurcated, anchored to `src/actions/capabilities.ts`:
- **Always-allowed** (orientation: arrows, Tab, Esc, Enter, PgUp/PgDn) → the existing `ALWAYS_ALLOWED` sentinel (`src/actions/types.ts:~343`); runAction bypasses the gate. No friction in HITL.
- **Gated `write_to_pane`** (disruptive: `Ctrl+C`, `Shift+Tab`) → existing `gateOrDefer("write_to_pane", paneId, …)` (`server.ts:1843`) — Ask off-spotlight, Auto on spotlight, durable defer.
- The **semantic mode change** (`applyPaneMode`) gates on **`set_pane_permissions`** (it *is* a lock change), not `write_to_pane`.

Deferred to product (see §13): whether `Ctrl+C`-as-halt deserves looser treatment, and whether `Shift+Tab` mode-cycle earns a dedicated `change_agent_mode` capability later.

---

## 11. Drain-on-promotion semantics (bead `1y8`)

On promotion to `Full Auto`, pending approvals + pending actions **for that pane** become moot (the agent will now self-approve). `applyPaneMode` step 4:
- `PendingApprovalStore`: filter by `terminalId === paneId`, resolve/cancel each, broadcast `approval_resolved` (the event added in PR #29).
- `PendingActionStore`: filter actions whose `params.paneId === paneId`, cancel, broadcast.
- Add a per-pane drain helper to each store (none exists today).

---

## 12. Test plan (TDD)

**Unit (hermetic, no real CLI):**
- `AgentAdapter` per preset: `buildLaunchCommand` argv (Claude `--allow-…`+`--session-id`; agy full-path+`-i`; Codex flags; Custom identity); `planModeChange` dispositions; `safeStartCycle` emptiness; `capabilities()` flags; `parseCurrentMode` against captured marker fixtures; `buildResumeCommand`.
- `writeRaw`: writes exact bytes, no `\r`, no paste split, no-op when transport null (extend `tests/test_terminal_input.ts`).
- `applyPaneMode`: live-signal path drives `writeRaw` steps + read-after-write; restart-resume path calls stop→respawn-with-resume; unsupported short-circuits; **drain** clears pending for the pane; gate forbidden/deferred honored. Use the `setLiveConnector`/store seams + a scripted PTY.
- raw-input endpoint: 404 / 409-not-spawned / gated-disruptive / always-allowed-nav (drive real server via `startServer({port:0})`).
- B2 regression: Codex/agy launch argv no longer contains `--dangerously-skip-permissions` *unless* that adapter chose it.

**Live-verification bead** (`multi-cli-live-switch-verification`) — the manual checklist that can't be unit-tested (ties into `ngw`):
- Claude: capture verbatim status-bar strings for default/plan/bypass/auto; confirm bypass stays in the ring after cycling down; confirm `ESC[Z` survives ConPTY; confirm `--resume`+mode flag precedence.
- Codex: install binary; confirm `/permissions` picker order + bytes; confirm `Shift+Tab` ≠ approval axis; confirm resume+bypass composes.
- agy: confirm `shift+down` cycles the *permission* axis (not plan/diff/mermaid); capture footer tokens; confirm `ESC[1;2B` survives ConPTY; confirm lossless `--conversation` resume + bypass re-arm.
- All: assert post-launch `parseCurrentMode` reports the **safe** target before any work (no hot-window leak).

---

## 13. Open product decisions

1. **`Ctrl+C` gating** — gate under `write_to_pane` (consistent), or treat as a safe always-allowed emergency brake (friction on "stop the runaway" is arguably wrong)? *Recommend:* always-allowed brake, aligned with stop-all.
2. **`Shift+Tab` home capability** — ride `write_to_pane` for v1 (recommended), or stand up `change_agent_mode` now?
3. **agy on PATH** — run `agy install` (clean `agy …` invocation) vs. spawn by full path (zero setup, brittle to relocation)? *Recommend:* full path in adapter + note `agy install` as optional.
4. **agy `-i` seed** — confirm a long-lived driven pane stays interactive with `-i` vs a bare spawn.
5. **Enter-as-submit edge** — Enter is always-allowed though it can submit an already-typed composer line. Accept (authoring already happened)?

---

## 14. Scope & phasing (incremental, each independently shippable + green)

- **P1 — `writeRaw` + raw-input endpoint + GUI key bar.** Smallest, immediately useful, unblocks manual control today. No adapter needed yet.
- **P2 — `AgentAdapter` extraction.** Move the 6 inline branches behind adapters (behavior-preserving; fixes B2). Pure refactor under existing tests.
- **P3 — session-id determinism.** Claude `--session-id` pin replaces the scrape (fixes B3); Codex/agy capture.
- **P4 — `applyPaneMode` + `restart_pane` voice tool + drain.** The Claude live path + restart-resume floor for all (bead `1y8` done).
- **P5 — live-verification bead** flips Codex/agy `readyForLiveCycle` as each is confirmed.

---

## 15. Risks (from research `openRisks`)

- **`Shift+Tab` axis divergence** — hardcoding `ESC[Z` mis-sets Codex. Mitigated by adapter-owned `modeCycleByte()`.
- **agy cycle axis unverified** + **Codex not installed** — both LOW confidence → default restart-resume; gated behind verification.
- **Fragile status parsing** — only one Claude marker documented; `parseCurrentMode` must fail-safe (return null → keep reading), never blind-count.
- **Hot-launch window** — real for agy (no `--allow-` equivalent); assert safe-mode before dispatch.
- **ConPTY may mangle `ESC[Z` / `ESC[1;2B`** — explicit verification step; fallback to remapped keybinding for agy.
- **Session capture races** under concurrent panes (Codex/agy) — prefer explicit-UUID resume or per-pane workspaces.
- **Resume-mode precedence** unconfirmed — verify the supplied flag wins over restored mode.

---

## Appendix — key source anchors
`src/terminal.ts`: `buildLaunchCommand` 159-173 · ctor 398-442 · `checkForSessionId` 462-478 · `setPermissionsMode` 444-456 · `writeInput`/`deliverSubmit` 805-855 · `start` 639 · `stop` 873 ·
`src/ptyTransport.ts`: `write` 40,134-140 ·
`server.ts`: input ep 1066-1082 · restart ep 1001-1033 · `gateOrDefer` 1843 · `effectiveCapabilityGateFor` 1801 · `runAction` 2859 · decls 2920 · WS_EVT 2117 ·
`src/actions/capabilities.ts` 25-52,73 · `src/actions/types.ts` ALWAYS_ALLOWED ~343 · `src/types.ts` CapabilityGate 13-15 ·
`src/actions/defs/locks.ts` `set_pane_permissions` 110-179 ·
`src/App.tsx`: pane toolbar 3775 · restart 1114-1122 · mode select 3970 · compact grid 3861 ·
`src/components/TerminalView.tsx` (xterm, no key forwarding).
