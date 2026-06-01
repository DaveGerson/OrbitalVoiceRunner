# OrbitalVoiceRunner — Future-State Target Technical Architecture

**Step 4 of the multi-part review.** This document synthesizes the "general
technical components" surfaced across all 8 journey deep-dives and gap registers
into a single **target architecture** — what a best-in-class, still strictly
**audio-only / hands-free / eyes-off** version of OrbitalVoiceRunner would look
like — and contrasts each subsystem against what exists today.

It is the **future / target + comparison** companion to the as-is walkthrough,
which lives in the sibling document `current-technical-process.md`. That sibling
owns the full current process flow; this document does **not** re-derive it. Where
a current behavior is cited here, it is only to anchor a contrast or a migration
target, with `file:line` evidence drawn from the journey docs.

Source material (all code-verified): the eight journey deep-dives and gap
registers under `docs/journeys/*/`, plus `README.md` and `JOURNEYS_DESIGN.md`.

---

## 1. Design Principles for the Target

These five principles are the constitution the target architecture is measured
against. Every subsystem decision below traces to one or more of them. They are
derived directly from the recurring failure classes in the gap registers.

### P1 — Hands-free / eyes-off first (the screen is optional, never required)
The operator's only guaranteed channels are **voice in** and **audio out (speech +
earcons)**. Any capability that today requires a click, a glance at a modal, or a
keyboard is a **defect**, not a convenience. Concrete debts this targets:
`switch_context` not moving the UI focus (J1-G1) is irrelevant once the screen is
optional; the keyboard-only, 100-char-truncating buffer→ledger bridge (J7-G2);
the keyboard-only handoff console (J4-G5); the absence of a voice `restart_pane`
(J5-G9); the visual-only `recentlyIdled` animation with no audio twin (J6-G13).

### P2 — Proactive audio (push, don't make the operator poll)
The system **detects** completions, errors, exits, plan-step transitions, and
approval timeouts server-side already — but never speaks them unprompted. A
best-in-class eyes-off product **interrupts the operator with audio** when
something material happens, on a priority-ranked, barge-in-safe event bus. This
targets the single largest cross-journey gap: pull-only observation (J1-G5,
J2-G1, J6-G5, J8-G5/J8-G7).

### P3 — Safety by default (gate, classify, confirm, time-out)
Human-in-the-Loop is the default and must be **trustworthy**: the operator must
*hear what they are approving* (J3-G1), approvals must target the *intended* pane
(J1-G7, J2-G7, J3-G3), negation and risk must be understood (J3-G2, J3-G14,
J2-G8), per-pane policy changes must not be silently nullified by the global
override (J5-G1), the `--dangerously-skip-permissions` flag must actually apply to
the running process (J5-G2/J5-G12), and no approval may freeze the session forever
(J2-G9, J3-G7). Secrets must never leave the host unredacted (J8-G1).

### P4 — Durability (nothing the operator said or decided is lost to a restart)
Notes, handoffs, the dictation buffer, pending approvals, and the Gemini session
resumption token must all survive a server bounce. Today the ledger is durable and
atomic, but pending approvals (J2-G6), the prompt buffer (J7-G1), the session
token (J4-G6), and history's write path (J4-G10) are not.

### P5 — Honest tool contracts (the model is told the truth, always)
Gemini reasons entirely from tool descriptions and responses. A description that
claims redaction/delta/analysis that does not exist (J8-G2, J8-G3) or a digest
that claims to cover approvals but does not (J2-G3, J3-G13) actively *steers the
model into confidently wrong behavior*. Every tool's description must match its
implementation; every silent no-op must become an explicit error response
(J2-G10, J5-G11, J8-G10); every placeholder LLM result must be real
(`gemini-3.5-flash` is not a model — J1-G2, J4-G3).

---

## 2. Target Architecture Diagram + Narrative

```
 BROWSER (mic + speaker + optional screen)            NODE ORCHESTRATOR (server)                         GEMINI LIVE ("Janus")
 ──────────────────────────────────────              ──────────────────────────────                     ─────────────────────
 mic PCM 16k ─audio─▶                                  ┌──────────────────────────────────────────┐
              barge-in                                 │  AUDIO I/O & SESSION GATEWAY               │
 spkr 24k  ◀─audio──                                   │   /live WS · full-duplex echo-cancel       │──realtime audio──▶  model
 earcons   ◀─events─                                   │   · session resume (durable token)         │◀─audio + tool────  tool calls
 (risk-tiered)                                         └──────────────┬─────────────────────────────┘
 UI (optional, ◀─state push─                                          │ tool dispatch / responses
  fully mirrors voice)                                                ▼
                                          ┌───────────────────────────────────────────────────────────────────┐
                                          │  TOOL EXECUTOR  (honest contracts · explicit errors · no silent ok) │
                                          └───┬───────────┬───────────┬────────────┬───────────┬───────────────┘
                                              │           │           │            │           │
                                  ┌───────────▼──┐ ┌──────▼─────┐ ┌───▼────────┐ ┌─▼─────────┐ ┌▼─────────────────┐
                                  │ PERMISSIONS  │ │ APPROVALS  │ │ PANE / PTY │ │ ORCHESTR. │ │ KNOWLEDGE &      │
                                  │ & GATING     │ │ (durable,  │ │ MANAGER +  │ │ PLANS     │ │ CONTINUITY       │
                                  │ effective +  │ │ session-   │ │ STATUS     │ │ (fan-out  │ │ briefing synth · │
                                  │ risk-class · │ │ scoped ·   │ │ DETECTION  │ │ + join ·  │ │ searchable notes·│
                                  │ time-boxed)  │ │ TTL · read │ │ (sentinel/ │ │ parallel) │ │ structured       │
                                  │              │ │ -aloud)    │ │  /proc)    │ │           │ │ handoffs)        │
                                  └──────┬───────┘ └─────┬──────┘ └─────┬──────┘ └─────┬─────┘ └────────┬─────────┘
                                         │               │              │              │                │
                                         └───────────────┴──────┬───────┴──────────────┴────────────────┘
                                                                ▼
                                          ┌──────────────────────────────────────────────────────────┐
                                          │  REDACTION / SECRET-SCRUB  (every payload model-bound)     │
                                          └──────────────────────────────┬─────────────────────────────┘
                                                                         │ scrubbed output
                                          ┌──────────────────────────────▼─────────────────────────────┐
                                          │  PROACTIVE AUDIO EVENT BUS                                  │
                                          │  pane_completed · attention_alert · approval_pending(read)  │
                                          │  · plan_step · permission_changed · note_saved · timeout    │
                                          │  priority-ranked → speak / earcon (barge-in aware)          │
                                          └──────────────────────────────┬─────────────────────────────┘
                                                                         │ inject-to-model / emit-to-client
                                          ┌──────────────────────────────▼─────────────────────────────┐
                                          │  DURABLE STATE                                              │
                                          │  Ledger (atomic) · Notes[] (typed) · Handoffs[] · History   │
                                          │  (atomic) · pendingApprovals (persisted) · session token    │
                                          │  · promptBuffer (persisted)                                 │
                                          └──────────────────────────────────────────────────────────────┘
```

**Narrative.** The target keeps today's overall topology — browser ↔ Node bridge ↔
Gemini Live, with `UniversalTerminal` child processes and an atomic JSON ledger —
because those foundations are sound (PTY spawn, atomic ledger writes, the gating
waterfall, the earcon synthesizer, and the session-resumption *wiring* are all
verified solid). The departures are structural in three places:

1. **A redaction layer becomes mandatory and unconditional** on the path from any
   pane content to the model. Nothing reaches Gemini un-scrubbed (P3/P5).
2. **A proactive audio event bus is inserted** between detection (which already
   exists: `onIdle`, `detectAndTriggerTransitions`) and the operator. Today those
   detections terminate at watch-rules/plans and a visual badge; in the target they
   also fan out to *speech* (P2).
3. **Approvals, the dictation buffer, and the session token join the ledger as
   durable state**, and `pendingApprovals` becomes a typed, TTL'd, session-scoped,
   read-aloud queue rather than an in-memory map the session blocks on (P3/P4).

Everything else is the same components, hardened to honor the five principles.

---

## 3. Subsystem-by-Subsystem Target Design (Today → Target)

### 3.1 Audio I/O & Barge-in

**Today.** Browser captures 16 kHz PCM, base64-frames it over `/live`, and uses a
**half-duplex barge-in guard** that *drops* mic frames while Janus speaks
(App.tsx:857–859) to avoid loopback. Earcons are Web-Audio-synthesized and
differentiated by event *type* (alert/execute/success/chime) but **not by risk or
agent**; `approval_pending` and `command_blocked` share one identical "alert"
tone (J2-G8). The barge-in guard means the operator literally cannot interrupt
Janus mid-utterance with a correction.

**Target.** Move to **full-duplex with acoustic echo cancellation** so the operator
can barge in ("stop — reject that") while Janus is mid-sentence, instead of having
their microphone muted. Earcons become a **structured sound alphabet**: distinct
signatures per *semantic class* and per *risk tier* — a gentle chime for read-only
proposals, an urgent triple-tone for destructive patterns (`rm -rf`, `DROP TABLE`,
`git push --force`), a separate "blocked" tone distinct from "pending," a
"completed" tone per agent type so an eyes-off operator can tell a Claude Code
completion from a Codex one by ear alone (J1-G8, J2-G8, J3-G14, J5-G3, J6-G13,
J8-G7). The audio channel is the product's primary surface, so it is treated as a
first-class designed system, not a set of incidental beeps.

### 3.2 Gemini Live Session & Resumption

**Today.** One Gemini Live session per `/live` connection. `contextWindowCompression`
is configured (`triggerTokens: 25000`, sliding window `targetTokens: 16000` —
server.ts:1571–1573). The resumption token *is* captured
(`lastSessionResumptionToken`, server.ts:1030/1078–1080) and *is* passed back on
reconnect (server.ts:1570) — but it is a module-level `let`, so a server restart
loses it and Janus starts a cold session (J4-G6). The system prompt is rendered
**once** at connect and never refreshed, so panes created later are invisible to
the model unless it re-queries (J1-G10, J4-G7, J6-G9). The system prompt also omits
`globalPermissionsMode` and active-pane context (J5-G8, J7-G6).

**Target.** **Persist the resumption token to disk** (alongside the ledger or a
`.janus_session.json`) on every `sessionResumptionUpdate`, with a TTL check, so
an operator returning after a server bounce resumes the *same* conversation (P4,
J4-G6). **Stop embedding live, mutable state in the static system prompt**: the
prompt should carry stable instructions + global policy state + the active-pane
hint, while *current* pane state is always fetched via `list_panes` (the prompt
instructs the model to do so after any structural change) or pushed via the event
bus (J1-G10, J6-G9). Inject `globalPermissionsMode`, the override rule, and the
operator's `activeTerminalId` so Janus can reason about whether a per-pane change
will take effect and can default note-attachment to the active pane (J5-G8,
J7-G6).

### 3.3 Tool Executor & Honest Tool Contracts

**Today.** A single dispatch over `message.toolCall.functionCalls`. Several
contracts lie or no-op silently: `get_pane_summary` is described as "clean,
redacted markdown delta" but returns raw, unredacted, non-delta output (J8-G2);
`get_attention_digest` claims to cover "approvals" but reads only the attention
queue (J2-G3, J3-G13); `set_pane_permissions` and `add_pane_note` return success
even when the target pane/project does not exist (J5-G11, J8-G10); the REST
approve path no-ops on a missing terminal but still tells Janus it succeeded
(J2-G10); the only server-side LLM call uses the **non-existent** model
`gemini-3.5-flash` and silently falls back to a placeholder string for *every*
command summary (J1-G2, J4-G3).

**Target.** Establish a **tool-contract invariant** (P5): a description must
describe the implementation, and *every* tool returns a truthful result —
explicit error responses on missing pane/project/terminal so Janus can tell the
operator "that pane no longer exists" instead of falsely confirming. Rewrite the
`get_pane_summary` and `get_attention_digest` descriptions to match reality (or,
preferably, make reality match the *good* description by adding redaction + delta —
see 3.4/3.11). Fix the summarization model to a real flash-tier model with an
integration smoke test asserting a non-placeholder result. Add runtime enum
validation on `permissions_mode` so a hallucinated value is rejected, not written
(J5-G5). The executor is the chokepoint where P5 is enforced.

### 3.4 Permissions / Gating Model

**Today.** Effective mode = global, unless global is `Inherit`, then pane mode
(default HiTL) — verified correct and defensive (server.ts:1271–1276). But a
per-pane voice change is **silently nullified** whenever the global is pinned to
something other than `Inherit`: Janus confirms "done" while gating is unchanged
(J5-G1, the most dangerous safety gap in the permissions model). Promotions to
Full Auto write `--dangerously-skip-permissions` into the *restart* command string
but do **not** restart the live process, so the subprocess keeps its old policy —
a split-brain state with no hands-free way to fix it (J5-G2, J5-G12, J5-G9).

**Target.** The gating subsystem becomes **honest and complete** (P3):
- On any `set_pane_permissions`, read the global mode; if it is not `Inherit`,
  return a spoken rider — "Warning: global mode is Full Auto, so this pane change
  has no effect on gating until you set global to Inherit" (J5-G1). Janus is also
  told this rule in the prompt so it warns proactively (J5-G8).
- `setPermissionsMode` reports `restartRequired`; Janus offers to restart the pane
  by voice via a new `restart_pane` tool (3.12) so the flag actually applies
  (J5-G2/J5-G9/J5-G12).
- **Time-boxed autonomy** ("Full Auto for the next 5 minutes, then revert") via a
  `fullAutoExpiresAt` field + server timer + spoken countdown.
- **Scoped autonomy** ("auto-approve `npm test`, ask for everything else") via a
  per-pane `autoApprovePatterns` allow-list checked in `propose_command`.
- **Auto-demote on anomaly**: a pane in Full Auto that emits an error/build-failed
  transition drops to HiTL, emits `permission_changed`, and the bus speaks it.
- On promotion to Full Auto, **drain that pane's pending approvals** consistently
  with the new mode rather than leaving them stranded (J5-G10).
- Every transition emits a `permission_changed` event with old→new mode, read
  aloud with prior-state echo (J5-G3).

### 3.5 Pane / PTY Manager & Status Detection (replace the `is_busy` heuristic)

**Today — the heuristic is the worst-rated reliability gap in the system.**
`is_busy` is `status === "Running"`, and `status` is set by (a) a regex that flips
to Idle on any line ending in `$`/`#`/`>`/`?` — which matches dollar amounts,
shell comments, closing tags, and AI-agent markdown — and (b) a hardcoded
**1-second** silence timeout that flips long silent commands (compiles, installs,
network waits) to Idle while they are still running (J6-G1, J6-G2). It is computed
only at `syncLedger` call time, carries **no elapsed-time** stamp (J6-G4), is
re-armed by stderr noise (J6-G10), and is **entirely untested end-to-end** (J6-G3).
`alive` is reliable via process events but the `detached: true` spawn risks
orphaned/zombie process groups (J6-G6). The configurable `idleTimeoutMs` setting is
ignored; the timer is hardcoded (J1-G9).

**Target — authoritative status, not inference (P1 freshness, P5 honesty):**
- Replace the timeout+regex with a **PTY prompt-sentinel**: write a unique token to
  the PTY after each command and detect its echo to mark "shell returned to prompt"
  — a deterministic idle signal — and/or poll **`/proc/[pid]/stat`** on Linux to
  read whether the process tree is in `R` (running) vs `S` (sleeping/waiting).
- Add **`last_status_change_at`** to `PaneMeta` so spoken summaries say "running
  for 6 minutes" / "idle since 14:32" — the signal that distinguishes a hung pane
  from a fast one (J6-G4).
- Surface the **current command** in `PaneMeta` so `list_panes` can say "running
  `npm run build`, started 2 minutes ago" without a second history call (J6-G11).
- Add a **`kill(pid, 0)` watchdog** (and track the process group) to keep `alive`
  honest for detached groups (J6-G6).
- Honor `idleTimeoutMs` from settings (J1-G9), and treat stderr as non-authoritative
  for status (J6-G10).
- **Test the heuristic by feeding raw chunks**, not by setting `term.status`
  directly (J6-G3).

### 3.6 Ledger / Persistence & Data Model (structured notes / handoffs)

**Today.** Atomic ledger writes (temp + rename) are a genuine strength and survive
restarts. But notes on both `Workspace` and `PaneMeta` are plain `string[]` — **no
timestamp, type, author, or ID** (J4-G1, J7-G3, J8-G8). History lives in a separate
`.janus_history.json` written with a **non-atomic** `writeFileSync` (J4-G10), and
is siloed from the ledger/briefing (J4-G4). Handoffs leave **no persistent named
artifact** — just an untagged note plus a transient stdin comment (J4-G5).

**Target — a typed, queryable knowledge data model (P4):**
- Replace `notes: string[]` with **`Note[]`**: `{ id, text, timestamp, type:
  "decision"|"todo"|"warning"|"observation"|"handoff", author: "janus"|"user",
  paneId? }`. This unblocks search, filtering, deletion-by-ID, and prioritized
  briefings (foundational for J4/J7/J8).
- Add a **`handoffs: Handoff[]`** array to `Workspace`: `{ id, timestamp,
  sourcePaneId, targetPaneId, contextNotes, lastCommands[] }` — a durable,
  retrievable record. The stdin injection becomes a *bonus* delivery channel, not
  the artifact (J4-G5).
- Bring `HistoryManager` writes onto the **same atomic temp-rename pattern** as the
  ledger (J4-G10), and add `loadAllHistory(paneIds[])` for cross-pane aggregation
  (J4-G4).
- Persist `promptBufferText` (3.10) and `pendingApprovals` (3.7) to disk.

### 3.7 Approvals (durable, session-scoped, voice-disambiguated, read-aloud)

**Today — structurally correct gating, but eyes-off-hostile.** When a HiTL command
is proposed, the server withholds `sendToolResponse`, which **hard-blocks the
Gemini session**: Janus is *mute* and cannot speak the proposal aloud (J2-G1,
J3-G1). The earcon is the only signal, and it is identical for pending vs blocked
(J2-G8). Voice "approve" resolves `pendingEntries[0]` — the **oldest** entry, not
the one most recently described — with no spoken confirmation of which pane, so in
a multi-pane fan-out the operator can approve the wrong command (J1-G7, J2-G7,
J3-G3). The parser is naive substring matching with **no negation** ("I don't want
to cancel" → reject), apostrophe fragility ("dont run" misses), and silent
collision resolution where `isApprove` wins (J3-G2, J3-G4, J3-G5). There is **no
TTL**, so an unanswered approval freezes the session indefinitely (J2-G9, J3-G7).
The map is **in-memory and lost on restart** (J2-G6), shared across connections
with an **unscoped REST path** (J3-G6). There is **no voice tool to list pending
approvals** (J2-G2, J3-G8).

**Target — approvals become a first-class, durable, spoken queue (P2/P3/P4):**
- **Non-blocking two-phase proposal.** `propose_command` returns an immediate
  `pending_approval` acknowledgment so Janus stays live and **speaks the proposal
  aloud** ("I'd like to run `git push origin main` on backend — say approve or
  cancel"); the open vote lives on a side-channel, resolved later (J2-G1, J3-G1).
- **Voice-disambiguated targeting.** Track the most-recently-described pending
  command; resolve *that* on "approve," support ordinals and command-fragment
  matching ("approve the npm install," "reject command two"), and **speak back**
  which pane/command was resolved (J1-G7, J2-G7, J3-G3). Support "approve all" /
  "reject all" (J2-G14).
- **Robust intent parsing.** Negation-window check, apostrophe normalization, an
  explicit-clarification path when approve+reject collide rather than silently
  approving (J3-G2, J3-G4, J3-G5).
- **Risk classification** attached to each entry (`low|medium|high` from a pattern
  classifier) drives a risk-tiered earcon and a mandatory verbal caution +
  double-confirm for destructive commands (J2-G7, J3-G14).
- **TTL with countdown.** Each entry timestamps; on expiry it auto-rejects, tells
  the session, and the bus speaks "cancelled after no response" (J2-G9, J3-G7).
- **Durable + scoped.** Persist `pendingApprovals` to disk; on reconnect, restore
  and re-issue them, re-attaching via the durable resumption token; add session
  identity checks to the REST path (J2-G6, J3-G6).
- **Voice-queryable.** A `list_pending_approvals` tool reads the queue aloud, and
  the attention digest also mentions pending approvals (J2-G2, J3-G8, J2-G3).

### 3.8 Proactive Audio Event Bus (push completions / errors to Janus)

**Today.** Detection already happens server-side: `onIdle` fires on Running→Idle
(terminal.ts), and `detectAndTriggerTransitions` classifies error/build-failed/
exited and pushes to the attention queue. But these terminate at **watch
rules, plan progression, and a visual badge** — they **never push audio**. The
frontend even **drops** the orchestration broadcast events entirely (no `onmessage`
branches), relying on a 3-second poll (J1-G5). The result: the operator must
*ask*; nothing is volunteered. This is the largest cross-journey gap (J1-G5,
J2-G1, J6-G5, J8-G5/J8-G7) and the direct contradiction of an eyes-off product.

**Target — a priority-ranked proactive audio bus (P2) is the keystone new
subsystem.** A single server-side bus consumes the existing detection events and
fans them out to **spoken audio + earcons**, barge-in aware:
- `pane_completed` → "Codex on ui-revamp just finished" (from `onIdle`).
- `attention_alert` → "Warning: data-pipeline exited with a build error" (from
  `detectAndTriggerTransitions`, high-severity items).
- `approval_pending` → the read-aloud proposal (3.7).
- `plan_step_completed` / `plan_completed` / `plan_paused` → spoken progress.
- `permission_changed`, `note_saved` (earcon), `approval_timeout`.

Events are **priority-ranked** (destructive/error first, informational last) and
**routed to the right project** — attention items must record the *pane's* project
(`term.projectId`), not whatever was active at trigger time (J1-G16). On the
client, every event type gets a real `onmessage` handler and the 3-second poll is
demoted to a reconnect-only safety net (J1-G5). Janus can also **follow up
automatically**: on "tell me about the build failure," switch context + summarize
the errored pane before speaking (J1-G6 routing, deep-dive 1 §6.6).

### 3.9 Orchestration / Plans (parallel fan-out + join)

**Today.** Despite Journey 1 being named "Fan-out / Delegate in Parallel," the
`Plan` type is **strictly sequential**: `currentStepIndex` advances one step at a
time after the prior step transitions (J1-G4). Recipes are **two hardcoded
server-side objects** with `echo` prefixes that can trip idle/error classification
(J1-G13). `handoff_context_between_panes` injects a `#`-comment block that Claude
Code treats as a shell command, not context (J1-G12). Watch rules provide a
genuine but primitive single-shot coordination primitive.

**Target — true parallel orchestration (P1 throughput):**
- Add a **`parallel_group` step kind** to `Plan`: dispatch all steps in the group
  concurrently across panes, then **join** on a condition (all reach idle / all
  succeed) before the next phase (J1-G4). This makes "run tests on all three panes
  at once" actually parallel.
- **Voice-composed recipes**: "make me a Python pipeline with a FastAPI pane in
  HiTL and a Celery worker in Full Auto" composes a fan-out plan dynamically,
  instead of selecting one of two static recipes; drop the `echo` prefixes
  (J1-G13).
- Replace the comment-injection handoff with a structured, agent-appropriate
  context prefix (and the durable `Handoff` artifact from 3.6) (J1-G12, J4-G5).
- **Reliable agent session handshake**: agents emit a well-known machine-readable
  line (e.g. `JANUS_SESSION_ID=<uuid>`) parsed with certainty, replacing the
  speculative regex + synthetic-ID scheme that silently loses resume context
  (J1-G6). Unify the three divergent restart command strings into one derived from
  the ledger + preset (J1-G3, J1-G11).

### 3.10 Knowledge & Continuity (briefing synthesis, searchable notes, dictation)

**Today.** `switch_context` returns a **raw JSON dump** that Janus must narrate
itself — non-deterministic, untestable, and at risk under context compression
(J4-G2). The briefing **excludes history** (J4-G4). Notes only reach Janus on a
`switch_context` round-trip, never mid-session and never in the prompt (J4-G7,
J7-G5). There is **no note search/list tool** (J4-G8, J7-G7), **no delete/amend**
(J4-G9, J7-G4), and the static project `summary` is never updated (J4-G11). The
ambient **prompt buffer is in-memory only** (lost on restart), unbounded, and its
only ledger bridge is a keyboard-only 100-char truncation (J7-G1, J7-G2, J7-G8).
No session-gap "since you were last here" catch-up exists (J4-G12).

**Target — continuity that survives restarts and is queryable by voice (P1/P4):**
- **Server-side briefing synthesis**: a real flash-tier call produces a cached
  3–5 sentence project narrative (deterministic, testable) returned alongside the
  structured data, including recent cross-pane commands (J4-G2, J4-G4).
- **Notes searchable and editable by voice**: `get_project_notes` / `search_notes`
  (standalone, no full context switch), `delete_note` / `amend_note` keyed by the
  new note IDs (J4-G8, J4-G9, J7-G4, J7-G7).
- **Notes in context mid-session**: a compact recent-notes summary in the system
  prompt + contextual auto-attachment to the active pane so "note this here"
  needs no ID (J4-G7, J7-G5, J7-G6).
- **Durable dictation buffer**: persist `promptBufferText`, cap/rotate it, and add
  a voice "commit the spec buffer" tool that stores the *full* text, not 100 chars
  (J7-G1, J7-G2, J7-G8).
- **Session-gap catch-up** spoken on first connect after a gap (J4-G12); allow
  Janus to `update_project_summary` (J4-G11).

### 3.11 Output Redaction / Secret-Scrubbing (before sending to the model)

**Today — this is the single Critical *security* gap.** `get_pane_summary` strips
ANSI and nothing else; raw output — including any AWS keys, JWTs, `.env` values,
PATs, private-key headers printed to the terminal — is forwarded **verbatim to
Google's Gemini Live API**, with the operator unable to see it happening and the
tool description falsely calling the output "redacted" so the model never warns
(J8-G1, J8-G2). The same un-scrubbed path also feeds the `propose_command`
rationale snapshot.

**Target — a mandatory, unconditional redaction layer (P3/P5).** Every payload
bound for the model — `get_pane_summary`, the approval rationale snapshot, the
briefing, history summaries, any pane content — passes through a **single
secret-scrub stage** that masks well-known secret shapes (AWS key shape, `eyJ…`
JWTs, `BEGIN … PRIVATE KEY`, common `.env`/token patterns) to `[REDACTED]` before
the tool response is assembled. It is centralized so there is exactly one place to
audit. With redaction real, the tool description becomes *true*. Add the missing
companions the false description already promised: **semantic error/warning
extraction** (return `{errors, warnings, exit_code, last_command}` so the spoken
narration is signal, not log noise — J8-G6) and **delta tracking** (a per-pane
`lastSummarisedIndex` so "anything new?" returns only new lines, not a re-read —
J8-G5), plus **scrollback search** over the existing `.janus_scrollback_<id>.log`
for "find the last error" queries (J1-G15, J8-G4).

---

## 4. Target Tool Surface

Current Janus tools (verified at server.ts:1579–1833): `list_panes`,
`propose_command`, `get_pane_command_history`, `get_pane_summary`,
`switch_context`, `add_project_note`, `add_pane_note`, `rename_project`,
`rename_pane`, `get_attention_digest`, `create_project`, `create_pane`,
`set_global_permissions`, `set_voice_mute`, `add_watch_rule`,
`create_orchestrator_plan`, `execute_plan`, `apply_orchestration_recipe`,
`handoff_context_between_panes`, `set_pane_permissions`.

Proposed additions / changes (each tied to the journeys it unblocks):

| Tool | Add / Change | Purpose | Journeys |
|---|---|---|---|
| `list_pending_approvals` | **Add** | Read the pending-approval queue aloud (pane, command, risk, rationale) | J2, J3 |
| `restart_pane` | **Add** | Hands-free restart so `--dangerously-skip-permissions` actually applies after a Full Auto promotion | J5 |
| `get_project_notes` | **Add** | Recall notes mid-session without a full `switch_context` reset | J4, J7, J8 |
| `search_notes` | **Add** | Keyword/semantic note query ("find the rate-limiting note") | J4, J7 |
| `delete_note` / `amend_note` | **Add** | Voice CRUD: correct or retract a mis-dictated note (keyed by new note ID) | J4, J7 |
| `commit_spec_buffer` | **Add** | Persist the *full* dictation buffer to a durable note (no 100-char truncation) | J7 |
| `update_project_summary` | **Add** | Let Janus refresh the stale static project summary | J4 |
| `search_pane_output` | **Add** | Query the 512 KB scrollback log by keyword/range ("first error") | J8, J1 |
| `get_pane_errors` | **Add** | Structured error/warning/exit-code extraction for clean spoken narration | J8 |
| `dismiss_attention` | **Add** | Voice-dismiss attention items so the digest stops repeating stale alerts | J1, J6 |
| `get_status_summary` | **Add** | Merge `list_panes` (in-flight, with elapsed time + current command) and the attention digest into one spoken status | J6 |
| `set_pane_permissions` | **Change** | Add optional `duration_minutes` (time-boxed) and `auto_approve_patterns`; warn when global override nullifies the change; error on unknown pane; validate the mode enum | J5 |
| `get_pane_summary` | **Change** | Honest contract: redacted + delta + optional `limit`/`offset`; structured error extraction | J8 |
| `get_attention_digest` | **Change** | Include pending approvals + elapsed-time/recency; description matches behavior | J2, J3, J6 |
| `create_project` | **Change** | Add the missing `key_terms` parameter to the schema | J1 |
| `create_orchestrator_plan` / `execute_plan` | **Change** | Support a `parallel_group` step kind (fan-out + join) | J1 |
| `handoff_context_between_panes` | **Change** | Produce a durable `Handoff` artifact; agent-appropriate context delivery instead of a shell comment | J4, J1 |
| `apply_orchestration_recipe` | **Change** | Voice-composable recipes; drop `echo` prefixes | J1 |

---

## 5. Gap → Target Capability Mapping (with sequencing)

Sequencing: **Now** = safety/security/honesty/durability blockers an eyes-off
operator can be actively harmed or misled by. **Next** = the proactive-audio and
status-accuracy core that delivers the eyes-off promise. **Later** = richer
continuity, parallelism, and polish that build on the Now/Next foundations.

| Major Gap ID(s) | Target capability that resolves it | Subsystem | Seq |
|---|---|---|---|
| J8-G1 | Mandatory secret-scrub on all model-bound output | 3.11 | **Now** |
| J8-G2, J8-G3, J2-G3, J3-G13 | Honest tool contracts (descriptions match impl) | 3.3 | **Now** |
| J1-G2, J4-G3 | Replace `gemini-3.5-flash` with a real model + smoke test | 3.3 | **Now** |
| J3-G1, J2-G1 | Non-blocking proposal; Janus speaks the command aloud | 3.7 | **Now** |
| J1-G7, J2-G7, J3-G3 | Voice-disambiguated approval targeting + spoken confirm | 3.7 | **Now** |
| J3-G2, J3-G4, J3-G5 | Negation-aware, apostrophe-safe, collision-clarifying parser | 3.7 | **Now** |
| J5-G1 | Warn when global override nullifies a per-pane change | 3.4 | **Now** |
| J2-G6, J3-G6, J2-G9, J3-G7 | Durable, session-scoped, TTL'd approvals | 3.7 | **Now** |
| J7-G1, J4-G6, J4-G10 | Persist prompt buffer, session token, atomic history | 3.6 / 3.2 | **Now** |
| J2-G10, J5-G11, J8-G10 | Explicit error responses on missing pane/terminal | 3.3 | **Now** |
| J1-G5, J2-G1, J6-G5, J8-G7 | Proactive audio event bus (push completions/errors) | 3.8 | **Next** |
| J6-G1, J6-G2, J6-G3, J6-G10 | Sentinel/`/proc` status detection (kill `is_busy` heuristic) | 3.5 | **Next** |
| J6-G4, J6-G11 | `last_status_change_at` + current-command in `PaneMeta` | 3.5 | **Next** |
| J6-G6 | `kill(pid,0)` watchdog / process-group tracking for `alive` | 3.5 | **Next** |
| J5-G2, J5-G9, J5-G12 | `restart_pane` voice tool; flag applies to live process | 3.4 / 3.12 | **Next** |
| J2-G2, J3-G8 | `list_pending_approvals`; digest includes approvals | 3.7 / 4 | **Next** |
| J2-G8, J3-G14, J5-G3, J1-G8 | Risk-tiered / agent-differentiated earcon alphabet | 3.1 | **Next** |
| J4-G1, J7-G3, J8-G8 | Typed `Note[]` schema (timestamp/type/author/id) | 3.6 | **Next** |
| J5-G5, J5-G8, J7-G6 | Mode-enum validation; global state + active pane in prompt | 3.4 / 3.2 | **Next** |
| J4-G2, J4-G4 | Server-side briefing synthesis + cross-pane history | 3.10 | **Later** |
| J4-G8, J7-G7, J4-G9, J7-G4 | `get_project_notes` / `search_notes` / delete / amend | 3.10 / 4 | **Later** |
| J7-G2, J7-G8 | `commit_spec_buffer`; bounded, durable buffer | 3.10 / 4 | **Later** |
| J4-G5, J1-G12 | Durable `Handoff` artifact + agent-appropriate delivery | 3.6 / 3.9 | **Later** |
| J1-G4 | Parallel `parallel_group` plan step (fan-out + join) | 3.9 | **Later** |
| J1-G3, J1-G6, J1-G11 | Unified restart command + reliable session-ID handshake | 3.9 | **Later** |
| J8-G5, J8-G4, J8-G6, J1-G15 | Delta tracking, scrollback search, error extraction | 3.11 | **Later** |
| J5-G4, J4-G7, J7-G13 | Documentation truthfulness (README / JOURNEYS_DESIGN) | P5 | **Later** |
| J2-G14, J5-G10, J6-G12, J6-G13 | Batch approve, promotion-drain, queue TTL, idle earcon | 3.7 / 3.4 / 3.8 | **Later** |

*(`3.12` in the table refers to the `restart_pane` tool described in §4.)*

---

## 6. Summary — The Target's Six Biggest Departures from Today

1. **Pull becomes push.** A proactive, priority-ranked audio event bus speaks
   completions, errors, exits, plan transitions, and timeouts unprompted — the
   detections already exist server-side but today die at a visual badge (J1-G5,
   J6-G5).
2. **Approvals stop freezing and start talking.** A non-blocking, read-aloud,
   risk-classified, voice-disambiguated, TTL'd, *durable* approval queue replaces
   the in-memory map that mutes Janus and resolves the wrong (oldest) command
   (J2-G1, J3-G1/G3, J2-G6/G9).
3. **`is_busy` is replaced with an authoritative signal.** A PTY prompt-sentinel
   plus `/proc` state and elapsed-time stamping kills the 1-second/regex heuristic
   that lies about long-running and shell-suffixed work (J6-G1/G2/G4).
4. **Nothing model-bound leaves the host un-scrubbed.** A mandatory central
   redaction layer closes the verbatim-secret-exfiltration path, and tool
   descriptions are made true (delta/redacted/analyzed) instead of aspirational
   (J8-G1/G2).
5. **Everything spoken or decided survives a restart.** Prompt buffer, pending
   approvals, and the Gemini resumption token join the already-durable ledger;
   notes and handoffs become typed, searchable, voice-editable artifacts
   (J7-G1, J2-G6, J4-G6, J4-G1/G5).
6. **The screen becomes optional and parallelism becomes real.** Per-pane policy
   changes can no longer be silently nullified and apply to the live process via a
   voice `restart_pane`; fan-out gains a true parallel plan step with a join — so
   the hands-free, multi-agent promise the product is named for is actually
   deliverable (J5-G1/G2/G9, J1-G4).
