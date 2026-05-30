# Holistic User Flow Today — How the 8 Journeys Compose

> **Authoritative synthesis.** This grounds the experiential operator narrative
> (`_operator-narrative.md`) into the structural reality of how all eight journeys
> chain into one session loop **today**, verified against `server.ts` / `src/`,
> not the design ideal. Companion to the per-journey deep-dives and gap registers.
> Modality: voice-only, hands-free, eyes-off. Janus = Gemini Live agent. "Content" =
> terminal output via `get_pane_summary`. Screen does not exist for the operator.

---

## 1. Executive Summary

OrbitalVoiceRunner is built around **one loop** the operator lives in:

> **connect → fan out agent panes (J1) → supervise in Human-in-the-Loop (J2) →
> review & approve commands by voice (J3) → adjust a pane's autonomy (J5) → ask for
> status (J6) → dictate specs/notes (J7) → narrate a pane's output (J8) → capture &
> hand off for next time (J4) → loop.**

The loop is real and continuous: a single Gemini Live WebSocket session, a single
`OrchestratorManager` with live PTY children, and a single atomically-persisted
`Ledger` underpin every leg. **Each journey works roughly as well in isolation as
its own gaps file claims.** The headline verdict is about composition, not isolation:

> **The journeys do not chain. They share a backbone, but the connective tissue
> between journeys — model-context propagation after structural change, a spoken
> layer over pending state, multi-pane targeting, effective-permission truth,
> proactive push, and a truthful history summary — is precisely what is missing.**

The recurring failure shape is identical at every seam: **journey N produces a state
change, but the thing journey N+1 needs to consume that change is never updated or is
updated with a placeholder.** And because each journey was designed assuming an
operator can glance at a screen to recover, the seams between journeys — invisible
eyes-off — are exactly where work is silently lost or misdirected. The product is a
strong set of parts wired onto a spine with five or six load-bearing cracks.

---

## 2. The Unified Flow

The diagram shows the operator's full session loop. Solid arrows are the happy path;
`╳` marks a **broken or silent seam** where control passes between journeys and the
handoff fails today. Gap IDs annotate each break.

```
                              ┌──────────────────────────────────────────────┐
                              │   SHARED BACKBONE (one per session)           │
                              │   • Gemini Live session (1 WS /live)          │
                              │   • OrchestratorManager + UniversalTerminal[] │
                              │   • Ledger (.janus_ledger.json, atomic)       │
                              │   • pendingApprovals map (in-memory)          │
                              │   • attentionQueue (in-memory)                │
                              │   • effective-permissions resolver            │
                              │   • earcons + audio I/O (browser)             │
                              └───────────────────┬──────────────────────────┘
                                                  │ every journey reads/writes this
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │                                                                                │
   ▼                                                                                │
[CONNECT]  system prompt rendered ONCE (server.ts:1568) ── freezes pane list at 0   │
   │                                                                                │
   ▼                                                                                │
┌───────────────┐                                                                   │
│ J1  FAN OUT   │  create_project / create_pane → real PTY children spawn           │
│  (delegate)   │  Ledger writes atomically. Two agents run concurrently.           │
└──────┬────────┘                                                                   │
       │ panes now exist                                                            │
       │   ╳ J1-G10: model context NOT refreshed → Janus thinks 0 panes exist       │
       │   ╳ J1-G1 : switch_context never updates UI activeProjectId                 │
       ▼                                                                            │
┌───────────────┐                                                                   │
│ J2 SUPERVISE  │  agent/Janus calls propose_command → effective-mode resolver      │
│  (ATC, HiTL)  │  HiTL branch: entry → pendingApprovals; approval_pending earcon   │
└──────┬────────┘                                                                   │
       │   ╳ J2-G1 : tool response WITHHELD → Janus goes MUTE while pending         │
       │   ╳ J2-G2/G3: "what needs attention?" reads attentionQueue, NOT pending    │
       │             approvals → "nothing pending" while commands wait              │
       ▼                                                                            │
┌───────────────┐                                                                   │
│ J3 REVIEW &   │  operator says "go ahead" → voice intercept (server.ts:1127)      │
│  APPROVE      │  substring match → resolves pendingEntries[0] (OLDEST, FIFO)      │
└──────┬────────┘                                                                   │
       │   ╳ J3-G1 : command never spoken → every voice approval is BLIND           │
       │   ╳ J3-G3 : multi-pane → approves wrong pane (oldest, not intended)        │
       │   ╳ J3-G2/G5: "cancel"/"dont run" misfire (no negation / apostrophe drop)  │
       ▼ command written to PTY                                                     │
┌───────────────┐                                                                   │
│ J5 ADJUST     │  set_pane_permissions → writes term + ledger, says "success"      │
│  AUTONOMY     │                                                                   │
└──────┬────────┘                                                                   │
       │   ╳ J5-G1 : global ≠ Inherit → per-pane change is a SILENT NO-OP           │
       │   ╳ J5-G2/G9: Full Auto needs restart + flag inject; no restart_pane tool  │
       ▼                                                                            │
┌───────────────┐                                                                   │
│ J6 STATUS     │  list_panes → syncLedger → is_busy / alive                        │
│  CHECK        │  alive: TRUSTWORTHY (process events).                             │
└──────┬────────┘                                                                   │
       │   ╳ J6-G1/G2: is_busy false after 1s silence or any $/#/>/? line →         │
       │             "idle/done" reported while pane is mid-build                   │
       │   ╳ J6-G5 : onIdle / error detection never push audio → must always ASK    │
       ▼                                                                            │
┌───────────────┐                                                                   │
│ J7 DICTATE    │  add_project_note / add_pane_note → Ledger atomic write (SOLID)   │
│  SPEC         │                                                                   │
└──────┬────────┘                                                                   │
       │   ╳ J7-G5/G7: note stored but NOT recallable in-session (no get_notes)     │
       │   ╳ J7-G6/J8-G10: wrong/stale pane_id → note SILENTLY dropped, "added"     │
       ▼                                                                            │
┌───────────────┐                                                                   │
│ J8 NARRATE    │  get_pane_summary → last 20 lines, ANSI-stripped (SOLID stripping)│
│  WALKTHROUGH  │                                                                   │
└──────┬────────┘                                                                   │
       │   ╳ J8-G6 : raw log noise, no semantic extraction (audio-hostile)          │
       │   ╳ J8-G4/G5: only last 20 lines; no delta cursor → re-reads same output   │
       │   ╳ J8-G1 : NO redaction → secrets go verbatim to Gemini (invisible)       │
       ▼                                                                            │
┌───────────────┐                                                                   │
│ J4 CAPTURE &  │  switch_context briefing (notes intact) + handoff_context...      │
│  HAND OFF     │  notes durable; handoff note persists.                            │
└──────┬────────┘                                                                   │
       │   ╳ J4-G3/J1-G2: history finalResponse = "Execution finished successfully" │
       │             (dead model gemini-3.5-flash) → handoff/summary CONTAMINATED   │
       │   ╳ J4-G5 : handoff = stdin bash comment + untagged note; no artifact      │
       │   ╳ J4-G6 : session resumption token in-memory → lost on restart           │
       │                                                                            │
       └────────────────────────► LOOP back to J1 / J2 / J6 ◄──────────────────────┘
```

**Where control actually passes between journeys (the spine of the loop):**

- **J1 is the bootstrap and is re-entrant.** Every other journey assumes panes exist;
  J1 is the only journey that creates them. But the moment it does, the seam to
  everything else (J1-G10) opens: the model's context is frozen at connect time.
- **J2 and J3 are two halves of one mechanism.** `propose_command` (J2) and the voice
  intercept (J3) operate on the *same* `pendingApprovals` map. J2 is "command becomes
  pending"; J3 is "operator resolves it." Control passes through the in-memory map and
  the open Gemini tool call — and that handoff is where Janus goes mute (J2-G1).
- **J5 sits underneath J2/J3** as a control-plane mutation: it changes what the J2
  resolver computes. But the resolver reads global-first, so J5's per-pane change is
  invisible to the J2 path whenever global ≠ Inherit (J5-G1).
- **J6 feeds every decision** — it is the read model the operator consults before
  acting in J1/J2/J5. A false `is_busy` (J6-G1) chains a wrong status into a wrong
  next move in any downstream journey.
- **J7 and J8 are the observe/record pair** that feed J4. J8 reads output, J7 records
  intent, J4 persists continuity. The dead summarizer (J4-G3) poisons the data J8/J4
  hand forward.
- **J4 closes the loop** back to the next session — and the resumption-token loss
  (J4-G6) means "next session" starts from zero model memory.

---

## 3. Journey-to-Journey Handoffs

Each row is a transition **between** journeys: what state must carry across, whether
it does today, and the seam/gap if it does not. All citations code-verified.

| Transition | State that must carry across | Carries today? | Seam / Gap |
|---|---|---|---|
| **J1 → J2/J3/J6 (fan-out → everything)** | The newly-created panes must become visible to (a) the Gemini model and (b) the UI focus | **No (model), No (UI)** | System prompt rendered once at connect (`server.ts:1568`); no ephemeral context injection after `create_pane`. Janus believes 0 panes exist until it re-calls `list_panes`. **J1-G10.** `switch_context` emits only `broadcastLedgerUpdate()` (`server.ts:1255–1265`), never a `context_switched` event → UI `activeProjectId` stale. **J1-G1.** |
| **J2 → J3 (propose → review)** | The proposed command string + a spoken description must reach the operator so the approval is informed | **No** | HiTL branch deliberately withholds `sendToolResponse` (`server.ts:1334`) → Gemini session hard-blocks → **Janus cannot speak**. Only signal is an undifferentiated `alert` earcon. **J2-G1 + J3-G1.** No `get_pending_commands` tool; command never re-enters model context. |
| **J2 → J6 (supervise → "what needs attention?")** | Pending approvals should be discoverable when the operator asks for status | **No** | `get_attention_digest` reads `attentionQueue` only (`server.ts:1360–1373`); `pendingApprovals` is a separate map (`server.ts:978`). Tool description falsely claims it covers "approvals" → Janus confidently says "nothing pending" while commands wait. **J2-G2 / J2-G3 / J3-G8.** |
| **J3 across panes (review N agents → approve the intended one)** | Which pane's command the operator means must bind to the resolved entry | **No** | Voice intercept resolves `pendingEntries[0]` — insertion-order FIFO, no sort despite the comment (`server.ts:1133–1136`). With multiple HiTL panes, "approve" fires the oldest, with no spoken confirmation of which pane/command. **J3-G3 / J2-G7 / J1-G7.** |
| **J3 → PTY (approve → execution)** | Operator intent (approve vs reject vs neither) must map cleanly to action | **Partially** | Naive substring match: bare `cancel`/`execute` misfire, no negation window, `"don't run"` fails when ASR drops the apostrophe (`server.ts:1127–1129`). `isApprove` silently wins collisions (`server.ts:1139`). **J3-G2 / J3-G4 / J3-G5 / J2-G12.** |
| **J5 → J2 (promote autonomy → gating actually changes)** | The new pane mode must change what `propose_command` does next | **No, when global ≠ Inherit** | Resolver reads `globalPermissionsMode` first; pane mode only consulted on `Inherit` (`server.ts:1271–1275`). `set_pane_permissions` never checks global and reports "successfully" (`server.ts:1542–1557`). Confident-sounding no-op in both directions. **J5-G1.** |
| **J5 → subprocess (promote Claude/Codex → Full Auto effective)** | `--dangerously-skip-permissions` must reach the running process | **No** | `setPermissionsMode` mutates `shellCmd` only (`terminal.ts:118–130`); flag applies on next restart. No `restart_pane` voice tool exists → eyes-off operator stranded. **J5-G2 / J5-G9 / J5-G12.** |
| **J6 → action (status → next move)** | `is_busy` must reflect real execution before the operator acts on it | **No** | `is_busy` flips false after 1s output silence or on any line ending `$`/`#`/`>`/`?` (`terminal.ts:163–188`). `alive` is reliable; `is_busy` is not. Operator chains a false "idle/done" into a wrong next task. **J6-G1 / J6-G2.** No elapsed time (J6-G4); no proactive push (J6-G5). |
| **J7 → J7 recall / J4 (dictate → remember in-session)** | A note just dictated must be recallable without a full context reset | **No** | Notes re-enter context only via `switch_context`'s full briefing (`ledger.ts:197–209`); no `get_project_notes` / `search_notes` tool; not injected into the live session. Memory is write-only mid-session. **J7-G5 / J7-G7.** No delete/amend (J7-G4). |
| **J7/J8 → ledger (dictate/observe → persist on right pane)** | The note must land on the pane the operator meant | **No (no active-pane signal)** | Client `activeTerminalId` never sent to server (`App.tsx`), so Janus guesses `pane_id`. Wrong/stale ID → `addPaneNote` silently no-ops while handler returns "Note added" (`ledger.ts:158–163`, `server.ts:1342–1347`). **J7-G6 / J8-G10.** |
| **J8 → operator ear (observe → understand)** | Output must be a coherent, change-aware, safe narration | **No** | Raw last-20-lines, no semantic extraction (J8-G6); no delta cursor → re-reads identical lines (J8-G4/G5); no redaction → secrets go verbatim to Gemini, invisible to operator (J8-G1). |
| **J6/J8 → J4 (what happened → record it)** | A truthful per-command outcome must flow into history, status, and handoff | **No** | `summarizeCommandOutcome` calls non-existent `gemini-3.5-flash` (`server.ts:209`); catch returns fixed `"Execution finished successfully."` (`server.ts:214–216`). Every history `finalResponse`, and the handoff packet built from them, is the same placeholder — even for failed steps. **J4-G3 / J1-G2.** |
| **J4 → handoff artifact (capture → retrievable record)** | A named, dated, retrievable hand-off must exist | **No** | Hand-off = bash comment into target stdin (scrolls away; Claude Code tries to *run* it per J1-G12) + one untagged note (`server.ts:1516–1541`). No `handoffs[]` array, no document. **J4-G5.** |
| **J4 → next session (this session → re-brief)** | The Gemini conversation must survive a restart | **No** | `lastSessionResumptionToken` is an in-memory `let` (`server.ts:1030`); lost on restart. Notes/history survive on disk; live model memory resets to zero. **J4-G6.** |

---

## 4. Shared Backbone

Every journey leans on the same small set of components. Because they are shared, a
single weakness in one is not a local bug — it is a **systemic crack that reappears in
every journey that touches it.** The six load-bearing weaknesses:

1. **Dead command-outcome summarizer** (`gemini-3.5-flash`, `server.ts:209`) — falls
   back to the fixed string `"Execution finished successfully."` for every command.
2. **Unsynced `switch_context`** — changes ledger `activeProjectId` but emits no event
   the UI or model can consume to refresh focus/context (`server.ts:1255–1265`).
3. **Unreliable `is_busy`** — 1-second timeout + prompt-pattern heuristic
   (`terminal.ts:163–188`) reports false idle on any non-trivial workload.
4. **Janus-mute-while-pending** — withheld tool response hard-blocks the Gemini
   session during every HiTL approval (`server.ts:1334`).
5. **Global-first permission resolver** — pane mode ignored unless global is `Inherit`
   (`server.ts:1271–1275`), so per-pane changes can be silent no-ops.
6. **In-memory-only volatile state** — `pendingApprovals`, `attentionQueue`,
   `promptBufferText`, and `lastSessionResumptionToken` all live in process memory and
   die on restart.

Plus two pull-only / no-push truths: the system prompt is frozen at connect
(`server.ts:1568`), and `onIdle` / `detectAndTriggerTransitions` never push audio to
Janus — so the model only ever learns about state when explicitly asked.

### Shared-failure → journeys impacted matrix

| Shared weakness (evidence) | J1 | J2 | J3 | J4 | J5 | J6 | J7 | J8 | Ripple |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|---|
| **Dead summarizer** `server.ts:209,214` | ● | | ✓ | ●●● | | ● | | ●● | History, status read-back, and hand-off all read the same placeholder; J4 emits confidently false "all succeeded." |
| **Unsynced `switch_context` / frozen system prompt** `server.ts:1255,1568` | ●●● | ● | ● | ●● | | ●● | ●● | ● | Every journey after J1 may start from a model that doesn't know panes exist; UI focus diverges from voice focus. |
| **Unreliable `is_busy`** `terminal.ts:163–188` | ● | ● | | ● | | ●●● | | ●● | Status journey core is untrustworthy; false idle misroutes J1 next-task, J5 timing, J8 "is it done?". |
| **Janus mute while pending** `server.ts:1334` | | ●●● | ●●● | | ● | | | | The J2→J3 bridge is pure silence + one earcon; the safety harness becomes a blindfold eyes-off. |
| **Global-first resolver** `server.ts:1271–1275` | | ●● | ● | | ●●● | ● | | | Autonomy changes (J5) and the supervise/review gate (J2/J3) can be silently nullified; "done" over a no-op. |
| **In-memory volatile state** `server.ts:978,1030,133` | | ●● | ●● | ●●● | | ● | ●● | | Restart loses pending approvals, prompt buffer, and session memory; continuity (J4) and re-entry collapse. |
| **No proactive audio push** `terminal.ts:539; server.ts:430` | ● | ●● | ● | | ● | ●●● | | ● | The eyes-off premise (don't watch) is broken: completions/errors are never announced; operator must keep asking. |
| **Naive voice intercept** `server.ts:1127–1136` | ● | ●● | ●●● | | | | | | Multi-pane targeting, negation, and ASR-apostrophe failures fire/skip real executions on the wrong pane. |
| **No redaction in `get_pane_summary`** `terminal.ts:593–599` | | ● | ● | ● | | | | ●●● | Secrets in any pane's output flow verbatim to Gemini through J8 and the J2/J3 rationale snapshot — invisible. |

Legend: ●●● = primary failure surface, ●● = strong impact, ● = secondary impact,
✓ = relies on the component but failure is masked.

**Reading the matrix:** the two most viral cracks are the **frozen/ unsynced context**
(touches all 8 journeys) and the **dead summarizer + in-memory volatility** (poison the
entire capture/continuity column J4 plus the read-back paths J6/J8). No journey is an
island: the columns with the most ink — J2, J3, J4, J6 — are exactly the journeys whose
*job* is to mediate between other journeys (supervise, approve, record, report).

---

## 5. Cohesion Verdict

Drawing on the narrative's "Where the seams show" section, made architectural and
prioritized. The honest split: **the nouns are solid, the verbs that connect them are
not.**

### Genuinely smooth today (composes well)

- **J1 spawn is real and concurrent.** `create_project` + `create_pane` spin up genuine
  PTY children via `script -q -f -c` with `detached: true` (`terminal.ts:220–316`); the
  ledger writes atomically. This is the strongest moment and the foundation the loop
  stands on.
- **Durable note capture (J7) is the most reliable verb.** `add_project_note` →
  `Ledger.addNote` → synchronous atomic write (`ledger.ts:181–186, 110–127`). Verbatim,
  survives restart. The one place "I told Janus" reliably becomes durable state.
- **`alive` (J6) is trustworthy** — driven by real `process.on('exit'|'close'|'error')`
  events (`terminal.ts:304–315`). Dead panes are reported correctly.
- **The HiTL *gate itself* (J2/J3) is correctly enforced** when the operator already
  knows what's pending: the three-branch resolver and the approve/reject execution path
  are atomic and unblock the session correctly. The earcon fires reliably on new items.
- **The `switch_context` *briefing payload* (J4) is intact** — notes, pane metadata,
  directory all come back correctly; durable notes from earlier in the session are in it.

### Where journeys fail to compose (prioritized by eyes-off severity)

1. **P0 — The supervise→review bridge is silence (J2-G1 + J3-G1).** The single most
   dangerous seam: Janus goes mute the instant a command is pending and never speaks the
   command, so every voice approval is blind. This turns the product's core safety
   harness into a blindfold. Architecturally: the HiTL design correctly blocks execution
   but couples "block execution" to "block the model's voice" — the two must be
   decoupled (non-blocking two-phase proposal) before eyes-off review is viable.

2. **P0 — Multi-pane approval lands on the wrong runway (J3-G3 / J2-G7).** The *normal*
   fan-out state is multiple pending commands; "approve" resolves the oldest, not the
   intended one, with no spoken confirmation. J1's whole value (parallelism) directly
   creates J3's most dangerous ambiguity. Targeting must bind to the command Janus last
   described, with spoken read-back of pane + command.

3. **P0 — Confident false truth from the dead summarizer (J4-G3 / J1-G2).** History,
   status read-back, and hand-off all read `"Execution finished successfully."`
   regardless of reality. This is worse than no summary: it actively misinforms across
   J6/J8/J4. A one-line model-name fix unblocks the entire capture/continuity column.

4. **P1 — Autonomy changes can be silent no-ops (J5-G1 / J5-G9).** A global override
   nullifies per-pane promotion/demotion while Janus says "successfully," and even when
   effective, Full Auto needs a restart with no voice tool. "I said trust this pane" and
   "this pane is actually trusted" are not the same state, and nothing tells the operator.

5. **P1 — Status lies on anything non-trivial (J6-G1 / J6-G2 / J6-G5).** `is_busy` reads
   false mid-build, and completions/errors are never pushed proactively. Status feeds
   every decision in the loop, so a false idle propagates a wrong next move into J1/J5/J8.

6. **P1 — Structural changes don't propagate (J1-G10 / J1-G1).** Creating panes doesn't
   refresh the model's awareness; voice context switches don't move the UI. Every
   downstream journey may start from a model that doesn't know the panes exist.

7. **P2 — Memory is a one-way door (J7-G5 / J7-G7).** Notes go in durably but can't be
   recalled or searched in-session without a full `switch_context` reset, and can't be
   deleted by voice. The capture verb works; the recall verb is missing.

8. **P2 — The hand-off is vapor, and resets overnight (J4-G5 / J4-G6).** "Hand-off" is a
   transient stdin comment plus an untagged note — no retrievable artifact — and the
   in-memory resumption token means tomorrow's "pick up where we left off" is "start
   over." Continuity is the journey, and it is the least continuous.

9. **P2 — Narration is audio-hostile and unsafe (J8-G6 / J8-G4/G5 / J8-G1).** Raw log
   noise read syllable-by-syllable, no delta so every check-in sounds identical, and no
   redaction so secrets leak to Gemini invisibly. The "coherent narration" ideal is
   Gemini improvising over a raw 20-line slice.

**Bottom line:** OrbitalVoiceRunner today is a well-built collection of journey *parts*
sitting on a shared spine whose *connective tissue* is missing or cracked in six
places. The parts that *create or store* state (J1 spawn, J7 notes, J4 briefing payload,
`alive`) are solid. The parts that *propagate state between journeys* — context refresh,
the spoken layer over pending approvals, multi-pane targeting, effective-permission
truth, proactive push, and truthful history — are exactly where the experience breaks.
Every one of these breaks is invisible eyes-off, because each journey was designed
assuming a screen the target operator does not have. Fixing the six shared backbone
weaknesses (Section 4), in roughly the P0→P2 order above, would convert the product from
"eight journeys that each work alone" into "one loop the operator can actually live in."
