# Orbital Harness / Janus — Next-Level Capability Roadmap

Consolidated from three forward-looking persona wishlists — Maya (power user, scaling 4–6 agents),
Devon (security/platform engineer), Sam (voice-first developer) — in
`assessments/next-level/{maya,devon,sam}.md`. All three assume the round-one P0–P3 bug fixes in
`assessments/ROADMAP.md` are done; this document is strictly net-new capability, not bug repair.

**The throughline:** today coordination, awareness, and trust all route through one sighted operator
sitting at the screen. The harness is reactive (pane state is *pulled*, never pushed), binary (the
whole policy surface is a single tri-state enum at `server.ts:631-636`), and single-threaded through
a human message-bus. Every persona, from a different angle, asks for the same shift: move
*observation, triggering, attention-routing, and trust legibility into the tool itself* so an operator
can run a multi-agent session unattended, by voice, and safely. The items below are ordered highest to
lowest priority; cross-persona convergence is treated as the strongest priority signal.

---

## Validation against `main` (as of commit `16c62da`, 2026-05-28)

Main advanced one commit past this branch's base — `16c62da refactor(terminal): update history
persistence and UI`. That commit landed several of the round-one dependencies these next-level items
rest on, and partially laid groundwork for two of them. **Net: the trust-UI substrate improved
materially; the observation/voice/policy spine is still untouched.** Line anchors below reference the
pre-`16c62da` baseline unless a "main @16c62da" note gives the updated location (App.tsx grew ~484
lines, so its anchors have all shifted down).

**Landed on main — round-one dependencies now satisfied (de-risks the items that named them):**
- **Approval dialog now renders *all* pending commands** — `pendingCommands.map(...)` (`App.tsx:961`),
  was `pendingCommands[0]`. Satisfies the dependency called out by **item 5** (ROADMAP P0.2).
- **Rationale is now passed into and rendered by the dialog** — `rationale={pending.rationale}`
  (`App.tsx:967`) → `ApprovalDialog.tsx:51-60`. The end-to-end plumbing **item 11** wanted to ride is
  now actually connected (previously computed server-side but dropped before the component).
- **Enter-to-approve removed** — the dialog now only binds Escape (`ApprovalDialog.tsx:24`). Partially
  satisfies **item 11**'s "never Enter-to-fire" for the *default* path; risk-*tiered* confirmation is
  still net-new.
- **Command history is now keyed by terminal ID** — `HistoryManager.loadHistory(terminalId)` /
  `allHistory[terminalId]` (`server.ts:63-126`). Fixes round-one P2.1 (co-located agents no longer
  clobber a shared per-cwd file) and gives **items 1 & 12** a clean per-pane substrate.

**Partial groundwork on main (a foundation, not the feature):**
- **A real `onIdle` status-transition hook now exists** — `term.onIdle` (`terminal.ts:74,173,184`) →
  `manager.onIdle` (`server.ts:210`). On idle it auto-summarizes the last command's outcome and
  broadcasts `history_updated`. This is a genuine building block for **item 2** (an event to hang
  watch-rules on) and a partial down-payment on **item 1** (a per-pane "what just happened" summary).
  **But it is UI-facing only** — it `broadcast`s to clients and never pushes to the live model session
  — and it is idle-only (no error/exit/prompt-class signals). Item 1's core (push *to the model* +
  real deltas) is unmet.
- **A `ProjectDialog` + project-management UI landed** (`App.tsx:9,933`; new
  `src/components/ProjectDialog.tsx`). Partial UI substrate for **item 7** (project CRUD now has a
  dialog — still screen-only, no voice tools) and **item 10** (project switching UI — still a single
  `activeProjectId` at `App.tsx:918`, `totalContextSize` still computed over the active project only at
  `App.tsx:920-921`, so the flattened cross-project fleet view is *not* done).

**Still open after main (items + their deps unaddressed):**
- **Push observation / real deltas (item 1) — NOT done.** `get_pane_summary` still returns a tail
  (`server.ts:721`) and is still falsely described as "markdown delta … Pull, not push"
  (`server.ts:883`). No model-facing event push.
- **Idle heuristic still hardcoded `1000`ms (`terminal.ts:268`), ignoring the configured
  `idleTimeoutMs` (default 2000).** Round-one P2.2 stands; **item 1**'s heuristic note stands.
- **False "Execute with voice 'Confirm'" copy still present** (`App.tsx:1548`) with no voice-confirm
  handler — **item 5**'s honesty flag and **item 8** (no spoken confirm) both stand.
- **Typed-"SURE" destructive gate still present** (`App.tsx:805-808`) — **item 8** unmet.
- **Antigravity preset still ships Full Auto + `--dangerously-skip-permissions`** (`terminal.ts:51`) —
  **item 4** / round-one P3 not addressed.
- **No kill-switch / emergency-stop / arm latch** anywhere — **item 4** unmet.
- **`rateLimitRequestsPerMin` still defined-but-unread** — **item 15** unmet.
- **Items 2, 3, 9, 10 (fleet), 11 (classifier/tiering), 12, 13 remain net-new and unstarted.**

| Item | Status after main `16c62da` | Evidence |
|---|---|---|
| 1 Push observation + deltas | ❌ Open (partial substrate via onIdle/per-pane history) | `server.ts:721,883`; onIdle `server.ts:210` is UI-only |
| 2 Watch/trigger rules | ⚠️ Foundation (onIdle event now emitted) | `terminal.ts:173,184` → `server.ts:210` |
| 3 Policy rule engine | ❌ Open | gate still binary `server.ts` mode branch |
| 4 Kill-switch + blast-radius | ❌ Open | no emergency/arm route; Antigravity Full Auto `terminal.ts:51` |
| 5 Attention queue + digest | ⚠️ Dependency met (all approvals render) | `App.tsx:961,967` |
| 6 Multi-pane output tiles | ❌ Open | grid still metadata cards |
| 7 Voice-driven creation | ⚠️ UI substrate only (ProjectDialog), no voice tools | `App.tsx:933`; tools unchanged |
| 8 Spoken confirm protocol | ❌ Open | typed-"SURE" `App.tsx:805-808`; copy `App.tsx:1548` |
| 9 Recipes/templates/handoff | ❌ Open | — |
| 10 Cross-project fleet view | ❌ Open (project UI exists, no flatten) | single `activeProjectId` `App.tsx:918,920-921` |
| 11 Risk classify + tiered approval | ⚠️ Plumbing met (rationale wired, Enter removed) | `App.tsx:967`; `ApprovalDialog.tsx:24,51-60` |
| 12 Signed audit log | ❌ Open (history now per-id, not an audit log) | `server.ts:63-126` |
| 13 RBAC + secrets broker | ❌ Open | single shared token |
| 14 Voice ergonomics bundle | ❌ Open | LISTENING/MUTED pill unchanged |
| 15 Polish grab-bag | ❌ Open | `rateLimitRequestsPerMin` still unread |

---

## P0-aspirational — the spine

### 1. Push-based observation with deltas (the situational-awareness backbone)
- **[Feature] · P1-effort: M · Maya #6, Sam NL-1, (Devon A7 depends on it) — 3-persona convergence (strong)**
- **Problem.** The model only learns a pane's state when it *chooses* to call `get_pane_summary`
  (`server.ts:614-616`), capped at ~100 lines with no real delta (the tool desc falsely claims
  "delta"). So Janus cannot reason about "who's blocked," cannot speak a failed build, and cannot
  drive any rule/plan/digest feature. This is the single most-converged-on request: Maya needs it for
  fleet awareness, Sam needs it for the "tap on the shoulder," Devon's anomaly detection rides on it.
- **Sketch.** Maintain a per-pane read cursor; emit only *new* lines since last read. Add a
  server-side event detector over the `onOutput`/`stdout_chunk` path (`server.ts:182-210`) that
  classifies cheap transitions — `idle`, `prompt`, `error:`/`build failed`/`Tests: N failed`,
  `exited` — and feeds them to the live session as compact structured signals (a synthetic
  tool-result the model reads aloud) rather than raw scrollback. Pairs with the round-one busy/idle
  heuristic fix (`src/terminal.ts:155-179`), which currently flips Idle after a 1s timer and lies for
  redraw-heavy TUIs.
- **Why first.** It is the data plane that items 2, 3, 5, and 8 all stand on. Build it once, well.
- **Status (main `16c62da`): ❌ open, partial substrate.** History is now per-pane (`server.ts:63-126`)
  and an `onIdle` hook exists (`server.ts:210`) that auto-summarizes on idle — but it only broadcasts
  to the UI, never pushes to the model, and `get_pane_summary` is still a pull-only tail mislabeled
  "delta" (`server.ts:721,883`). The idle heuristic is still hardcoded `1000`ms (`terminal.ts:268`).

### 2. Watch/trigger rules + sequenced resumable plans ("when X → do Z", chained)
- **[Feature] · effort: M (rules) → L (DAG) · Maya #1+#2, partial Sam NL-1 — convergence on the trigger primitive**
- **Problem.** Maya's most common manual ritual: babysit pane A, then go kick off pane B. "When the
  refactor finishes, run the tests next door." Today nothing watches for the transition but the human.
  Real work also has ordering ("migrate, then regen client, then integration tests, then PR") that
  stalls with no record if the operator steps away mid-chain.
- **Sketch.** A `watchRules: {paneId, on: "idle"|"prompt"|"regex"|"exited", action}[]` evaluated off
  the status-transition signal from item 1. Actions reuse existing machinery: `propose_command` into
  another pane (`server.ts:627`), fire a notification, or speak. Expose a `create_watch` tool beside
  the existing function declarations (`server.ts:739`) so it's voice-settable. A `Plan` is then just
  chained watch rules with `{waitFor, onFail}` per step, persisted into the ledger
  (atomic Workspace serialization, `src/ledger.ts`) so it resumes across a server restart or the
  auto-reconnect loop. Ship rules first; the DAG is a fast-follow on the same primitive.
- **Depends on:** item 1.
- **Status (main `16c62da`): ⚠️ foundation present.** The `onIdle` status-transition event is now
  emitted (`terminal.ts:173,184` → `server.ts:210`) — exactly the primitive a watch rule binds to.
  The rule engine, persistence, and `create_watch` tool are still net-new.

### 3. Policy rule engine — per-command / per-path allowlist + denylist
- **[Feature] · effort: L · Devon A1 (keystone) — Maya/Sam benefit indirectly via safer unattended ops**
- **Problem.** The gate is binary per pane (`server.ts:631-636`): Full Auto fires *everything*, HITL
  asks for *everything*, and the only way to escape approval fatigue is Full Auto — exactly the
  dangerous one. Unattended operation (Maya) and hands-free operation (Sam) both *require* a safe
  middle: auto-approve `git status`/`ls`/`npm test`, always ask for `git push`, never run
  `rm -rf`/`curl|sh`/`sudo`.
- **Sketch.** A `PolicyRuleSet` evaluated inside the `propose_command` handler *before* the mode
  branch at `server.ts:638`. Ordered rules `{match: regex|glob, path?: glob on cwd, decision:
  "auto"|"ask"|"deny", reason}`; first match wins; `deny` short-circuits to `command_blocked` even in
  Full Auto; `ask` forces HITL even under Full Auto. Ship a non-disableable built-in denylist
  (`rm -rf /`, fork-bomb, `curl|sh`, `chmod 777`, secret-file reads). Persist in `.janus_settings.json`
  (extend `SystemSettings.advanced`, `src/types.ts`) with per-preset overrides on `CliPreset`.
- **Why high.** It is the keystone everything else in the trust column attaches to (risk badges,
  tiered approval, rate limiting); without it Full Auto stays all-or-nothing.

### 4. Global kill-switch + ambient blast-radius indicator
- **[Feature+UI] · effort: S · Devon A4+B4 — Maya (fleet stop) and Sam (safe spoken stop) both want it**
- **Problem.** When an agent goes wrong across N panes there is no single control to stop everything;
  you close panes one at a time while the model keeps proposing. And the current-autonomy state is a
  small dropdown that reads the same whether Read-Only or Full Auto (`App.tsx:680-689`) — nothing
  screams when panes are hot (the Antigravity preset *ships* Full Auto, `src/terminal.ts:51`).
- **Sketch.** `POST /api/emergency-stop`: iterate `manager.terminals` calling `stop()` (the
  SIGTERM→SIGKILL teardown already exists, `src/terminal.ts:318-363`), drop and reject every
  `pendingApprovals` entry, and set a `manager.armed = false` latch checked at the top of the
  `propose_command` branch (`server.ts:627`) so further proposals return blocked until `POST /api/arm`.
  Must also gate the auto-reconnect re-arm so a killed session does not silently come back hot. UI:
  a persistent header banner that goes pulsing red when any pane is Full Auto (naming the count), with
  a dedicated **STOP ALL** button (confirm-on-click) and re-arm affordance.
- **Extends** round-one P3 "Full Auto guardrails."

### 5. Attention queue + spoken digest + push notifications ("who needs me?")
- **[Feature+UI] · effort: M · Maya #5+#9, Devon B3-adjacent, Sam NL-7+UI-3 — 3-persona convergence (strongest)**
- **Problem.** All three independently want one ordered, triageable list of everything waiting on the
  operator. Today the ApprovalDialog only ever shows `pendingCommands[0]` (`App.tsx:633`); concurrent
  proposals are invisible, there is no FIFO, the amber alert lives only on a screen nobody's looking
  at, and the per-card copy falsely claims a voice-confirm (`App.tsx:1159`). When three panes block
  while the operator is away, they return to three stalled agents with no idea which blocked first.
- **Sketch.** A server-side ordered attention queue spanning all panes (approvals, blocked/exited
  agents, NL-4 confirmations), oldest-first, each with pane + reason + the resolving action. Surfaces
  three ways: (a) a persistent UI strip/panel ("2 panes need you · 1 exited", click-to-jump);
  (b) a `get_attention_digest()` voice tool bound to "what needs me?" / "status" that reads it back
  ranked; (c) a real notification channel — browser Notification API on
  `approval_pending`/`command_blocked`/pane-exited (events already fire, `App.tsx:355-380`) plus an
  optional webhook to reach a phone. Backed by `pendingApprovals` (`server.ts:684`) + `listPanes()`.
- **Depends on:** the round-one fix to render all pending approvals (ROADMAP P0.2).
- **Status (main `16c62da`): ⚠️ dependency now met.** The dialog renders all pending approvals
  (`pendingCommands.map`, `App.tsx:961`) and shows rationale (`App.tsx:967`) — so the queue substrate
  exists. Still missing: the cross-pane attention queue, the `get_attention_digest()` voice tool, and
  push notifications. The false "Execute with voice 'Confirm'" copy persists at `App.tsx:1548`.

### 6. Live multi-pane output tiles (turn the config matrix into a video wall)
- **[UI] · effort: M · Maya #8 — the single biggest legibility win for fleet monitoring**
- **Problem.** The "Grid Summary View" shows cards full of session IDs, context meters, and permission
  dropdowns (`App.tsx:1118-1275`) — metadata, not *what the agents are doing*. Monitoring 6 agents
  means clicking into one pane at a time (`App.tsx:928`), the opposite of "at a glance."
- **Sketch.** Make each dashboard card render a live mini-terminal: the last ~8 lines of
  `terminal.output` (already streamed via `queueStdoutChunk`, `App.tsx:67-88`) in an auto-scrolling
  monospace tile, reusing `TerminalView`. Add a density toggle (2-col / 3-col / compact) to fit the
  whole fleet on one screen. Composes with items 5 (urgency sort) and 10 (cross-project).

### 7. Voice-driven pane / project creation & full settings control
- **[Feature] · effort: L · Sam NL-3 — Maya benefits (templates, item 9, ride on these tools)**
- **Problem.** The toolset can list, summarize, switch, note, rename, and propose (`server.ts:738-832`)
  but **cannot** create a pane/project, change a permission mode, mute the mic, or reconnect — all
  screen-only (`CreateTerminalDialog`, the selects at `App.tsx:680-689` and `App.tsx:1199-1207`). So
  starting a fresh multi-agent session — the most common complex workflow — *requires* the keyboard
  before voice can do anything. This is the gating dependency for true hands-free session setup.
- **Sketch.** Add tools mirroring the existing REST/dialog actions — `create_pane(name, tool_preset,
  cwd, permissions_mode)`, `create_project`, `delete_project` (guarded by item 8),
  `set_pane_permissions`, `set_global_permissions`, `set_mic_muted` — wired into the tool dispatch
  (`server.ts:604-721`) reusing the manager/ledger methods the HTTP routes already call.
- **Status (main `16c62da`): ⚠️ UI substrate only.** A `ProjectDialog` and project-management UI
  landed (`App.tsx:933`; `src/components/ProjectDialog.tsx`), so project CRUD is no longer ad-hoc — but
  it remains screen-only. No voice tools (`create_pane`, `create_project`, `set_pane_permissions`, …)
  were added; hands-free session setup is still blocked.

### 8. Spoken confirm protocol for destructive / high-blast-radius actions
- **[Feature] · effort: M · Sam NL-4 — converges with Devon's tiered-confirm intent (item 11)**
- **Problem.** The screen UI guards destructive ops by forcing the operator to *type* "SURE"
  (`App.tsx:488-501`) — exactly backwards for a hands-free user, yet voice mis-recognition on a
  destructive op is catastrophic ("delete the bin folder" heard as "delete the project").
- **Sketch.** A server-side `pendingConfirmations` map paralleling `pendingApprovals` (`server.ts:684`)
  plus `confirm_action`/`cancel_action` intents. Janus reads the action back verbatim and waits for a
  *distinct, hard-to-misfire* phrase ("say 'confirm delete'", never bare "yes") with a short
  auto-cancel timeout. Replaces the typed-"SURE" gate with a safe spoken equivalent; the required
  confirmation strength is driven by the risk tier from item 11.
- **Depends on:** item 7 (the voice actions that need guarding) and ties to item 11.

---

## P1 — make the session comfortable, trustworthy, and team-ready

### 9. Saved orchestration recipes / session templates + cross-pane handoff
- **[Feature] · effort: M · Maya #3+#4 — single-persona but high daily value**
- **Problem.** Every new project Maya hand-builds the same fleet via a one-pane-at-a-time form, and
  when handing work between agents she's a copy-paste mule with the receiving agent getting zero
  context. Pane notes (`ledger.addPaneNote`) are per-pane and static — they don't travel.
- **Sketch.** A `template` = named pane specs `{name, cmd, toolPreset, permissionsMode, cwd-relative}`
  + optional starter notes/watch rules, applied in one shot via batch `addTerminal` (`server.ts:248`),
  stored in settings. Plus a `handoff(fromPane, toPane, note?)` tool that packages the source pane's
  summary (`getPaneSummary`, `src/terminal.ts:550`) + notes and primes the target pane (or stages it
  for approval if HITL), with a handoff edge drawn in the UI.
- **Builds on:** item 7's creation tools; handoff builds on item 1's summaries.

### 10. Cross-project fleet view with urgency sorting
- **[UI] · effort: M · Maya #9+#10 — composes with items 5 and 6**
- **Problem.** The dashboard only ever renders `activeProject.panes` (`App.tsx:1088`); switching
  projects blanks and re-fetches. Agents live in 3+ projects but only one is visible — and the
  header's "Cumulative Context Size" is computed over the active project only, so the one fleet-wide
  number lies about scope. Cards also render in insertion order, so a blocked pane stays put.
- **Sketch.** An "All Projects" mode flattening every workspace's panes into one grid, urgency-sorted
  (pending-approval → exited/errored → idle → running) with a subtle project tag per tile; keep
  single-project as a filter, not a wall. Make global context/token counters genuinely fleet-wide.
- **Composes with:** items 5 (urgency data) and 6 (output tiles).
- **Status (main `16c62da`): ❌ open (project UI exists, no flatten).** `ProjectDialog` and project
  filtering state landed, but the dashboard still renders a single `activeProjectId` (`App.tsx:918`)
  and `totalContextSize` is still computed over the active project only (`App.tsx:920-921`) — the
  flattened, urgency-sorted cross-project grid is not built, and the fleet-wide counter still lies.

### 11. Command risk classification + tiered approval, with risk badge in the dialog
- **[Feature+UI] · effort: M · Devon A2+B1 — converges with Sam NL-4 (item 8) on tiered confirmation**
- **Problem.** A `git status` and a `git push --force` get the same amber "Confirm & Fire" modal
  (`ApprovalDialog.tsx:68-81`); approvers habituate and approve `--force` on muscle memory. The
  operator can't see *why* a command is dangerous.
- **Sketch.** `classifyRisk(cmd, cwd) -> {tier: low|medium|high|critical, signals[]}` (writes outside
  cwd, deletes, network egress, privilege escalation, package install, history rewrite). Carry a `risk`
  field through the rationale plumbing that already exists end-to-end (`server.ts:681-693` →
  `pendingApprovals` → dialog). Render it as a colored badge at `ApprovalDialog.tsx:44-47` listing the
  triggering signals; tier drives confirmation strength (low = one click; high/critical = type-to- or
  speak-to-confirm, never Enter-to-fire). Tier also feeds item 3's defaults and item 8's spoken
  confirm. Cheap because it rides existing plumbing.
- **Builds on:** item 3 (rules) and round-one P0.2 (pass `rationale` into the dialog).
- **Status (main `16c62da`): ⚠️ plumbing now in place.** `rationale` is wired end-to-end into the
  dialog (`App.tsx:967` → `ApprovalDialog.tsx:51-60`) and Enter-to-fire was removed
  (`ApprovalDialog.tsx:24`), so the risk badge has a home to render into. The `classifyRisk` function
  and tier-driven confirmation strength are still net-new.

### 12. Append-only signed audit log + in-app timeline / replay
- **[Feature+UI] · effort: M · Devon A3+B3 — single-persona but compliance-gating**
- **Problem.** The only record is `HistoryManager` writing plaintext, mutable command+output per cwd
  (`server.ts:93-112`) — it captures *what ran* but not *who approved it, under which mode, against
  which rule, why*. Auto-executions and blocks vanish after a 4-second toast (`App.tsx:374-380`).
- **Sketch.** A dedicated `AuditLog` recording a structured event per gate decision
  (`auto_executed`/`approved`/`rejected`/`blocked`/`policy_match`/`mode_change`/`kill`) with operator
  id (item 13), pane, cwd, command, risk tier, rule fired, timestamp. Hash-chain each entry so
  tampering is detectable; expose `GET /api/audit?from=&to=&format=` behind `authMiddleware`
  (`server.ts:138-149`). Keep separate from `HistoryManager` (that's for the model's context, this is
  for the auditor). The "replay" surface is a persistent filterable in-app timeline panel.

### 13. Multi-operator identity + roles (RBAC) + secrets brokering
- **[Feature] · effort: L · Devon A5+A6 — the team-grade unlock**
- **Problem.** There is one shared secret (`API_AUTH_TOKEN`, `server.ts:142`); everyone with the
  cookie is the same anonymous god-user, and the server binds `0.0.0.0` by default. No approval can be
  attributed, no person revoked. Separately, secrets today must be baked into a command (hitting the
  model context, audit, and shell history) or pre-exported into the pane env.
- **Sketch.** Per-operator tokens → roles (`owner`/`operator`/`observer`) gating who can flip global
  mode, approve which risk tier, edit policy (item 3), or hit the kill-switch; stamp operator id into
  every audit event (item 12) and into `pendingApprovals` so the dialog shows *who* it waits on. MVP =
  static operator table + token→operator map; full = OIDC/SSO. Plus a named-secret broker: the model
  references a handle (`${secret:GH_TOKEN}`) substituted at `writeInput` time (`src/terminal.ts:308`)
  *after* logging, so cleartext never lands in audit/history; secrets live in an encrypted store, not
  `.janus_settings.json`. Add a redaction pass on captured stdout (`src/terminal.ts:261-291`).
- **Extends** round-one P3 "API key at rest" and "boot/network posture."

### 14. Voice-first ergonomics bundle: conversational focus, turn-state indicator, captions, earcons
- **[Feature+UI] · effort: M (combined) · Sam NL-5+NL-6+UI-1+UI-2 — accessibility spine**
- **Problem.** Sam thinks in *agents*, not pane IDs, but there's no focused-pane concept, so every
  reference forces disambiguation. There's no audible/visible "whose turn is it" (only the
  LISTENING/MUTED pill, `App.tsx:722-735`), no non-speech status cues, and the voice log is an
  easy-to-miss side panel rather than a live caption.
- **Sketch.** (a) Server-side `focusedPaneId` per session set by `focus_pane(reference)` resolving
  fuzzy spoken references ("build agent", "the second one") against `listPanes()`; bare commands then
  implicitly target it. (b) Extend the pill into a conversational state machine
  (LISTENING / JANUS SPEAKING / THINKING / EXECUTING / WAITING ON YOU / RECONNECTING) with
  `aria-live`, derived from `activeSources` (`src/utils/audio.ts:18`) and tool-call activity.
  (c) A persistent high-contrast caption bar above the system bar mirroring current speech.
  (d) An earcon library in `src/utils/audio.ts` (distinct tones for approval-pending, build-failed,
  your-turn, connection-lost) on a separate gain node so they duck under Janus's voice.

---

## P2 — polish & power-user

### 15. Voice macros, wake-word/turn discipline, diff-preview, accessibility pass, rate-limit/anomaly
- **[Feature+UI] · effort: S–M each · Maya #7, Sam NL-8+UI-4, Devon A7+B2+B5 — grab-bag of refinements**
- **Voice macros (Maya #7, S).** User-defined phrase → ordered `propose_command` group with a single
  approval batch; thin layer over the existing tool path.
- **Wake-word + half-duplex turn discipline (Sam NL-8, M).** A "Janus, …" gate before forwarding audio
  frames (`App.tsx:338-343`) + auto-suppress mic while Janus speaks except a barge-in word triggering
  `resetAudioPlayback` (`src/utils/audio.ts:57`). Makes an always-on mic trustworthy.
- **Diff / impact preview before approval (Devon B2, M).** For safe-to-dry-run verbs (`git push
  --dry-run`, `ls` the delete glob, `git diff --cached --stat`) run the preview in the pane cwd and
  show it beside the rationale (`ApprovalDialog.tsx:53-66`).
- **High-contrast/large-text theme + ARIA pass (Sam UI-4, M).** WCAG-AA contrast, larger base font,
  text+icon status (not color-only), `aria-label`s on icon buttons and the permission selects.
- **Enforced rate limit + anomaly flags (Devon A7, S/M).** Wire the already-defined-but-unread
  `rateLimitRequestsPerMin` (`src/types.ts`) as a token bucket at `server.ts:627`; flag proposals that
  don't match the spoken trigger (`currentSessionUserUtterance`, `server.ts:681`) — fallible voice
  transcription means an injected/hallucinated command that doesn't match what was *said* is exactly
  the case to surface. **Extends** round-one P3 "enforce rateLimitRequestsPerMin."
- **Per-pane policy/role status chips (Devon B5, S).** Glanceable color-coded mode + rule-set + who-can-act
  chip on each pane header.

---

## Sequencing recommendation

**Build item 1 (push observation) first** — it is the most-converged-on request (all three personas)
and the data plane that watch-rules (2), the attention queue (5), output tiles (6), and digests (14)
all depend on. Without continuous, cheap, delta-tracked pane awareness, every "the tool watches for me"
feature is impossible.

**Then build the trust keystone, item 3 (policy rule engine)**, in parallel with item 4
(kill-switch + blast-radius banner). Together these convert the gate from a binary light-switch into a
control surface, and they are the precondition for *any* safe unattended or hands-free Full-Auto-ish
operation — which is what items 2, 7, and 8 are reaching for.

**Then the attention layer (item 5) and the video-wall (item 6)** — the two highest-leverage
legibility wins, both riding the round-one "render all pending approvals" fix and the item-1 data.

After that, the work splits cleanly by persona lane and can parallelize: Maya's orchestration (2, 9,
10), Sam's hands-free spine (7, 8, 14), and Devon's team-grade trust (11, 12, 13), with item 15 as
ongoing polish. The biggest cross-persona convergence points — and therefore the strongest priority
signals — are **push observation (1)** and **the attention queue/digest (5)**, each independently
requested by all three; the tiered-confirmation idea (Devon 11 + Sam 8) is the next strongest
two-persona overlap.
