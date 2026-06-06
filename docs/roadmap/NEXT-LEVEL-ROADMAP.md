# Orbital Harness / Janus — Next-Level Capability Roadmap (velocity & usability focus)

Consolidated from three forward-looking persona wishlists — Maya (power user, scaling 4–6 agents),
Devon (security/platform engineer), Sam (voice-first developer) — in
`assessments/next-level/{maya,devon,sam}.md`. All three assume the round-one P0–P3 bug fixes in
`assessments/ROADMAP.md` are done; this document is strictly net-new capability, not bug repair.

**Scope of this revision.** This list is deliberately narrowed to items that **accelerate developer
velocity and usability** — getting the operator out of the babysitting loop and making a multi-agent
session legible and drivable (including by voice). The security/governance *control-plane* items the
reviews raised — policy rule engine, command risk-classification / tiered approval, signed audit log,
multi-operator RBAC + secrets brokering, global kill-switch, and enforced rate-limiting/anomaly flags
— have been **intentionally deprioritized out** of this roadmap (see "Removed" at the end). They remain
recorded in git history and in `assessments/next-level/devon.md` if revisited.

**The throughline:** today coordination and awareness route through one operator sitting at the screen.
The harness is reactive (pane state is *pulled*, never pushed) and single-threaded through a human
message-bus. Every velocity item below moves *observation, triggering, and attention-routing into the
tool itself* so an operator can run — and walk away from — a multi-agent session, by voice. Items are
ordered highest to lowest priority; cross-persona convergence is the strongest priority signal.

---

## Validation against `main` (snapshot taken at commit `16c62da`, 2026-05-28)

> ⚠️ **STALE — re-anchor before acting.** This validation snapshot was taken against `main @16c62da`
> (2026-05-28). Current main is **`dd87e9d` (2026-06-06)** — many commits past that baseline
> (prompt-composer refactor, WS hardening, the SQLite ledger cutover, capability-gate + handoff build,
> round-3/4 voice-UX). Every per-item status label and inline `server.ts:NNN` / `App.tsx:NNN` citation
> below dates to the `16c62da` snapshot and needs INDIVIDUAL re-verification against current main; only
> this header's SHA/date has been refreshed. Per `RECONCILIATION.md §5`, do that re-anchoring before
> acting on any single item.

Main advanced one commit past this branch's base — `16c62da refactor(terminal): update history
persistence and UI`. That commit landed several round-one dependencies these items rest on and
partially laid groundwork for two of them. **Net: the approval-UI substrate and per-pane history
improved; the observation/voice spine is still untouched.** Line anchors below reference the
pre-`16c62da` baseline unless a "main @16c62da" note gives the updated location (App.tsx grew ~484
lines, so its anchors all shifted down).

**Landed on main — dependencies now satisfied (de-risks the items that named them):**
- **Approval dialog now renders *all* pending commands** — `pendingCommands.map(...)` (`App.tsx:961`),
  was `pendingCommands[0]`. Directly enables **item 2**'s attention surface.
- **Rationale is now passed into and rendered by the dialog** — `rationale={pending.rationale}`
  (`App.tsx:967`) → `ApprovalDialog.tsx:51-60`. Approvals are no longer a bare command string, which
  makes the attention queue (**item 2**) legible.
- **Command history is now keyed by terminal ID** — `HistoryManager.loadHistory(terminalId)` /
  `allHistory[terminalId]` (`server.ts:63-126`). Fixes round-one P2.1 (co-located agents no longer
  clobber a shared per-cwd file) and gives **items 1 & 7** a clean per-pane substrate.

**Partial groundwork on main (a foundation, not the feature):**
- **A real `onIdle` status-transition hook now exists** — `term.onIdle` (`terminal.ts:74,173,184`) →
  `manager.onIdle` (`server.ts:210`). On idle it auto-summarizes the last command's outcome and
  broadcasts `history_updated`. A genuine building block for **item 4** (an event to hang watch-rules
  on) and a partial down-payment on **item 1** (a per-pane "what just happened" summary). **But it is
  UI-facing only** — it `broadcast`s to clients and never pushes to the live model session — and it is
  idle-only. Item 1's core (push *to the model* + real deltas) is unmet.
- **A `ProjectDialog` + project-management UI landed** (`App.tsx:9,933`; new
  `src/components/ProjectDialog.tsx`). Partial UI substrate for **item 5** (project CRUD now has a
  dialog — still screen-only, no voice tools) and **item 6** (project switching UI — still a single
  `activeProjectId` at `App.tsx:918`, `totalContextSize` still over the active project only at
  `App.tsx:920-921`, so the flattened cross-project fleet view is *not* done).

| Item | Status after main `16c62da` | Evidence |
|---|---|---|
| 1 Push observation + deltas | ❌ Open (partial substrate via onIdle / per-pane history) | `server.ts:721,883`; onIdle `server.ts:210` is UI-only |
| 2 Attention queue + digest + notifications | ⚠️ Dependency met (all approvals render w/ rationale) | `App.tsx:961,967` |
| 3 Multi-pane output tiles | ❌ Open | grid still metadata cards |
| 4 Watch/trigger rules + plans | ⚠️ Foundation (onIdle event now emitted) | `terminal.ts:173,184` → `server.ts:210` |
| 5 Voice-driven creation & control | ⚠️ UI substrate only (ProjectDialog), no voice tools | `App.tsx:933`; tools unchanged |
| 6 Cross-project fleet view | ❌ Open (project UI exists, no flatten) | single `activeProjectId` `App.tsx:918,920-921` |
| 7 Recipes / templates / handoff | ❌ Open | — |
| 8 Voice ergonomics bundle | ❌ Open | LISTENING/MUTED pill unchanged |
| 9 Hands-free confirmation | ❌ Open | typed-"SURE" `App.tsx:805-808`; false copy `App.tsx:1548` |
| 10 Velocity polish | ❌ Open | — |

---

## P0 — the velocity spine

### 1. Push-based observation with deltas (the situational-awareness backbone)
- **[Feature] · effort: M · Maya #6, Sam NL-1 — 2-persona convergence (strongest)**
- **Problem.** The model only learns a pane's state when it *chooses* to call `get_pane_summary`
  (`server.ts:614-616`), capped at ~100 lines with no real delta (the tool desc falsely claims
  "delta"). So Janus cannot reason about "who's blocked," cannot speak a failed build, and cannot
  drive any rule/plan/digest feature. Maya needs it for fleet awareness; Sam needs it for the "tap on
  the shoulder."
- **Sketch.** Maintain a per-pane read cursor; emit only *new* lines since last read. Add a
  server-side event detector over the `onOutput`/`stdout_chunk` path (`server.ts:182-210`) that
  classifies cheap transitions — `idle`, `prompt`, `error:`/`build failed`/`Tests: N failed`,
  `exited` — and feeds them to the live session as compact structured signals (a synthetic
  tool-result the model reads aloud) rather than raw scrollback. Pairs with the round-one busy/idle
  heuristic fix (`src/terminal.ts:155-179`), which still flips Idle on a hardcoded 1s timer and lies
  for redraw-heavy TUIs.
- **Why first.** It is the data plane that the attention queue (2), output tiles (3), watch-rules (4),
  and the spoken digest (8) all stand on. Build it once, well.
- **Status (main `16c62da`): ❌ open, partial substrate.** History is now per-pane (`server.ts:63-126`)
  and an `onIdle` hook exists (`server.ts:210`) that auto-summarizes on idle — but it only broadcasts
  to the UI, never pushes to the model, and `get_pane_summary` is still a pull-only tail mislabeled
  "delta" (`server.ts:721,883`). The idle heuristic is still hardcoded `1000`ms (`terminal.ts:268`).

### 2. Attention queue + spoken digest + push notifications ("who needs me?")
- **[Feature+UI] · effort: M · Maya #5+#9, Sam NL-7+UI-3 — 2-persona convergence (strongest)**
- **Problem.** Both Maya and Sam want one ordered, triageable list of everything waiting on the
  operator. Even with all approvals now rendered, there is no cross-pane FIFO, the alert lives only on
  a screen nobody's watching, and the per-card copy falsely claims a voice-confirm (`App.tsx:1548`).
  When three panes block while you're away, you return to three stalled agents with no idea which
  blocked first.
- **Sketch.** A server-side ordered attention queue spanning all panes (pending approvals,
  blocked/exited agents, item-9 confirmations), oldest-first, each with pane + reason + the resolving
  action. Surfaces three ways: (a) a persistent UI strip ("2 panes need you · 1 exited",
  click-to-jump); (b) a `get_attention_digest()` voice tool bound to "what needs me?" / "status" that
  reads it back ranked; (c) a real notification channel — browser Notification API on
  `approval_pending`/`command_blocked`/pane-exited (events already fire, `App.tsx:355-380`) plus an
  optional webhook to reach a phone. Backed by `pendingApprovals` (`server.ts:684`) + `listPanes()`.
- **Status (main `16c62da`): ⚠️ dependency now met.** The dialog renders all pending approvals with
  rationale (`App.tsx:961,967`) — the queue substrate exists. Still missing: the cross-pane queue, the
  `get_attention_digest()` voice tool, and notifications. Fix the false `App.tsx:1548` copy here.

### 3. Live multi-pane output tiles (turn the config matrix into a video wall)
- **[UI] · effort: M · Maya #8 — the single biggest legibility win for fleet monitoring**
- **Problem.** The "Grid Summary View" shows cards full of session IDs, context meters, and permission
  dropdowns (`App.tsx:1118-1275`) — metadata, not *what the agents are doing*. Monitoring 6 agents
  means clicking into one pane at a time (`App.tsx:928`), the opposite of "at a glance."
- **Sketch.** Make each dashboard card render a live mini-terminal: the last ~8 lines of
  `terminal.output` (already streamed via `queueStdoutChunk`, `App.tsx:67-88`) in an auto-scrolling
  monospace tile, reusing `TerminalView`. Add a density toggle (2-col / 3-col / compact) to fit the
  whole fleet on one screen. Composes with item 2 (urgency data) and item 6 (cross-project).

### 4. Watch/trigger rules + sequenced resumable plans ("when X → do Z", chained)
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

---

## P1 — hands-free & multi-project usability

### 5. Voice-driven pane / project creation & full settings control
- **[Feature] · effort: L · Sam NL-3 — Maya benefits (templates, item 7, ride on these tools)**
- **Problem.** The toolset can list, summarize, switch, note, rename, and propose (`server.ts:738-832`)
  but **cannot** create a pane/project, change a permission mode, mute the mic, or reconnect — all
  screen-only (`CreateTerminalDialog`, the selects at `App.tsx:680-689` and `App.tsx:1199-1207`). So
  starting a fresh multi-agent session — the most common complex workflow — *requires* the keyboard
  before voice can do anything. This is the gating dependency for true hands-free session setup.
- **Sketch.** Add tools mirroring the existing REST/dialog actions — `create_pane(name, tool_preset,
  cwd, permissions_mode)`, `create_project`, `delete_project` (guarded by item 9),
  `set_pane_permissions`, `set_global_permissions`, `set_mic_muted` — wired into the tool dispatch
  (`server.ts:604-721`) reusing the manager/ledger methods the HTTP routes already call.
- **Status (main `16c62da`): ⚠️ UI substrate only.** A `ProjectDialog` and project-management UI
  landed (`App.tsx:933`; `src/components/ProjectDialog.tsx`), so project CRUD is no longer ad-hoc — but
  it remains screen-only. No voice tools were added; hands-free session setup is still blocked.

### 6. Cross-project fleet view with urgency sorting
- **[UI] · effort: M · Maya #9+#10 — composes with items 2 and 3**
- **Problem.** The dashboard only ever renders `activeProject.panes` (`App.tsx:1088`); switching
  projects blanks and re-fetches. Agents live in 3+ projects but only one is visible — and the
  header's "Cumulative Context Size" is computed over the active project only, so the one fleet-wide
  number lies about scope. Cards also render in insertion order, so a blocked pane stays put.
- **Sketch.** An "All Projects" mode flattening every workspace's panes into one grid, urgency-sorted
  (pending-approval → exited/errored → idle → running) with a subtle project tag per tile; keep
  single-project as a filter, not a wall. Make global context/token counters genuinely fleet-wide.
- **Composes with:** item 2 (urgency data) and item 3 (output tiles).
- **Status (main `16c62da`): ❌ open (project UI exists, no flatten).** `ProjectDialog` and project
  filtering state landed, but the dashboard still renders a single `activeProjectId` (`App.tsx:918`)
  and `totalContextSize` is still computed over the active project only (`App.tsx:920-921`) — the
  flattened, urgency-sorted cross-project grid is not built, and the fleet-wide counter still lies.

### 7. Saved orchestration recipes / session templates + cross-pane handoff
- **[Feature] · effort: M · Maya #3+#4 — high daily value**
- **Problem.** Every new project Maya hand-builds the same fleet via a one-pane-at-a-time form, and
  when handing work between agents she's a copy-paste mule with the receiving agent getting zero
  context. Pane notes (`ledger.addPaneNote`) are per-pane and static — they don't travel.
- **Sketch.** A `template` = named pane specs `{name, cmd, toolPreset, permissionsMode, cwd-relative}`
  + optional starter notes/watch rules, applied in one shot via batch `addTerminal` (`server.ts:248`),
  stored in settings. Plus a `handoff(fromPane, toPane, note?)` tool that packages the source pane's
  summary (`getPaneSummary`, `src/terminal.ts:550`) + notes and primes the target pane (or stages it
  for approval if HITL), with a handoff edge drawn in the UI.
- **Builds on:** item 5's creation tools; handoff builds on item 1's summaries.

### 8. Voice-first ergonomics bundle: conversational focus, turn-state indicator, captions, earcons
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
- **Builds on:** item 1 (the events earcons/captions announce) and item 2 (the "your turn" state).

---

## P2 — polish & power-user

### 9. Hands-free confirmation for destructive actions (minimal safety so voice isn't blocked)
- **[Feature] · effort: M · Sam NL-4 — the one safety primitive kept, because it *unblocks* hands-free velocity**
- **Problem.** The screen UI guards destructive ops by forcing the operator to *type* "SURE"
  (`App.tsx:488-501`, still present at `App.tsx:805-808`) — exactly backwards for a hands-free user,
  yet voice mis-recognition on a destructive op is catastrophic ("delete the bin folder" heard as
  "delete the project"). Without a spoken equivalent, every destructive action drags Sam back to the
  keyboard.
- **Sketch.** A server-side `pendingConfirmations` map paralleling `pendingApprovals` (`server.ts:684`)
  plus `confirm_action`/`cancel_action` intents. Janus reads the action back verbatim and waits for a
  *distinct, hard-to-misfire* phrase ("say 'confirm delete'", never bare "yes") with a short
  auto-cancel timeout. Replaces the typed-"SURE" gate with a safe spoken equivalent — a usability
  enabler, scoped to a fixed strong phrase (no risk-tiering machinery).
- **Depends on:** item 5 (the voice actions that need guarding).

### 10. Velocity polish: voice macros, wake-word/turn discipline, high-contrast/ARIA pass
- **[Feature+UI] · effort: S–M each · Maya #7, Sam NL-8+UI-4 — refinements that compound daily**
- **Voice macros (Maya #7, S).** User-defined phrase → ordered `propose_command` group with a single
  approval batch; thin layer over the existing tool path.
- **Wake-word + half-duplex turn discipline (Sam NL-8, M).** A "Janus, …" gate before forwarding audio
  frames (`App.tsx:338-343`) + auto-suppress mic while Janus speaks except a barge-in word triggering
  `resetAudioPlayback` (`src/utils/audio.ts:57`). Makes an always-on mic trustworthy.
- **High-contrast/large-text theme + ARIA pass (Sam UI-4, M).** WCAG-AA contrast, larger base font,
  text+icon status (not color-only), `aria-label`s on icon buttons and the permission selects.

---

## Sequencing recommendation

**Build item 1 (push observation) first** — the most-converged-on request and the data plane that
watch-rules (4), the attention queue (2), output tiles (3), and the spoken digest (8) all depend on.
Without continuous, cheap, delta-tracked pane awareness, every "the tool watches for me" feature is
impossible.

**Then build the attention layer (item 2) and the video-wall (item 3)** in parallel — the two highest-
leverage legibility wins, both riding the round-one "render all pending approvals" fix that already
landed on main and the item-1 data. Together these get the operator out of the per-pane click-through
loop. **Watch-rules (item 4)** lands next on the item-1 substrate (and the `onIdle` event already on
main), turning awareness into automation.

After that the work splits cleanly: Maya's multi-project orchestration (5, 6, 7) and Sam's hands-free
spine (5, 8, 9), with item 10 as ongoing polish. Item 5 (voice-driven creation) is the shared
unlock — it's the precondition for hands-free setup *and* for templates/handoff (item 7).

The biggest cross-persona convergence points — and therefore the strongest priority signals — are
**push observation (1)** and **the attention queue/digest (2)**, each independently requested by both
the power-user and voice-first personas.

---

## Removed / deprioritized in this revision (governance / control-plane)

Cut per the velocity-and-usability refocus. Recorded here so the decision is explicit and reversible;
full write-ups remain in git history (commit `66446ef`) and `assessments/next-level/devon.md`:

- **Policy rule engine** (per-command/path allow/ask/deny) — Devon A1.
- **Global kill-switch + blast-radius indicator** — Devon A4+B4. *(A "stop all" affordance may still be
  worth a small UI follow-up, but the arm/latch control plane is out of scope here.)*
- **Command risk classification + tiered approval + risk badge** — Devon A2+B1.
- **Append-only signed audit log + replay** — Devon A3+B3.
- **Multi-operator RBAC + secrets brokering** — Devon A5+A6.
- **Enforced rate-limit + anomaly flags**, **diff/impact preview**, **per-pane policy/role chips** —
  Devon A7+B2+B5.

The one safety item retained is **item 9 (hands-free confirmation)**, kept because it directly *unblocks*
the hands-free workflow rather than constraining it.
