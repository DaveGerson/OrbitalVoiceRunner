# Orbital Harness — Prioritized Implementation Roadmap

Synthesized from three independent developer-persona assessments:

- `01-power-user-maya.md` — Maya Chen, solo founder running 4–6 agents in parallel (workflow/scale lens)
- `02-security-platform-devon.md` — Devon Park, senior platform/security engineer (trust/gating lens)
- `03-voice-first-sam.md` — Sam Rivera, voice-first developer (hands-free/audio lens)

The mandate for all three was narrow: **does the tool work, and does it support the intended
developer workflow** (hands-free voice orchestration of multiple AI coding agents). They were not
asked to propose fixes. This document is the synthesis step.

---

## Shared baseline (all three agree)

The foundation is real, not a mockup:

- `npm run lint` (tsc --noEmit) is clean; `npm test` is 13/13 green.
- The PTY spawn + stdin write loop genuinely works (`src/terminal.ts:210-312`); Maya verified
  end-to-end with a standalone probe.
- The permission state machine resolves the effective mode correctly (`server.ts:631-636`).
- Ledger writes are atomic (tmp + rename, `src/ledger.ts:83-117`).
- The auth boundary is enforced on both REST and the `/live` socket (`server.ts:138-149`, `:507-513`)
  — stronger than the README admits.
- **Approved command == executed command** — no edit/re-template step between approval and stdin
  (`server.ts:471` → `src/terminal.ts:308`). Devon's single most important property holds.

And all three reached the same verdict independently: **not usable today** for the advertised
workflow. The plumbing is real; the experience is unfinished and breaks exactly where the
multi-agent / hands-free value lives.

## Convergence map — where the personas overlap

The strongest signal for prioritization is what multiple personas flagged independently:

| Finding | Maya | Devon | Sam |
|---|:---:|:---:|:---:|
| No voice approval path (UI says "say Confirm"; no handler exists) | ✅ Blocker | ✅ (workflow) | ✅ Critical |
| `pendingApprovals` never cleaned on disconnect; **test asserts a cleanup that doesn't exist** | ✅ Blocker | ✅ High | ✅ Medium |
| Approval rationale computed server-side but never passed to the dialog → approve blind | ✅ High | ✅ High | — |
| Playback 24 kHz buffer in a 16 kHz AudioContext → distorted voice | ✅ Low | — | ✅ High |
| Pane output is pull-only / never pushed or spoken → poor situational awareness | ✅ Medium | — | ✅ High |
| Only-hands-free option is Full Auto + `--dangerously-skip-permissions` | ✅ | ✅ Medium | ✅ Medium |

These six are the spine of the roadmap.

---

## P0 — Make the core loop honest and trustworthy

*Nothing else matters until these are done. Each is a blocker cited by at least two personas, or a
correctness defect that makes the test suite untrustworthy.*

### P0.1 — Implement a voice approval path
The headline feature does not exist. The dashboard literally says *"Execute with voice 'Confirm'"*
(`App.tsx:1159`) but approvals only resolve via Enter/Esc/click (`ApprovalDialog.tsx:21-34`). In the
safe default (Human-in-the-Loop), every proposed command forces a hand back to the keyboard — the
opposite of the pitch. All three personas flagged this; Sam and Maya rank it the #1 blocker.
- Add a spoken-confirm intent (model-side tool or transcript intent) that maps to `handleApprove`
  for the active pending command, with an unambiguous spoken read-back before firing.
- Until it exists, the UI copy at `App.tsx:1159` is making a false promise — fix the copy in the
  same change if the feature slips.

### P0.2 — Make the approval dialog faithful
The backend computes `rationale = { trigger, summary }` and ships it (`server.ts:681-693`); `App.tsx`
even stores it (`App.tsx:355-364`); the dialog is built to render it (`ApprovalDialog.tsx:53-66`) —
but the mount at `App.tsx:633-641` never passes `rationale`. So the context panels are dead code and
the operator approves a bare command string. Also:
- Render **all** pending commands, not just `pendingCommands[0]` (`App.tsx:633`) — concurrent
  proposals are currently invisible.
- Stop defaulting the global `Enter` keybind to *approve* a shell command (`ApprovalDialog.tsx:21-34`);
  require focus/explicit action and default to the safe choice.

### P0.3 — Actually clean up orphaned approvals (and fix the lying test)
`tests/test_approvals.ts:44-72` asserts a session-close cleanup of `pendingApprovals` "as added in
server.ts" — **but that handler does not exist.** The real close handler (`server.ts:864-877`) never
touches the map. Consequences: the map grows unbounded across the client's 3 s auto-reconnect loop
(`App.tsx:391-409`), and approving a stale entry still `writeInput`s to the pane (`server.ts:471`)
while `sendToolResponse` throws into a catch — command runs, model never learns the outcome.
- Implement the cleanup the test claims exists; purge entries bound to a closing session.
- Rewrite the test to exercise the real handler, not an inline mock. This is the credibility fix for
  the whole suite — all three flagged "13/13 green" as not trustworthy because of this one test.

### P0.4 — Fix audio playback sample rate
`playAudioChunk` builds 24 kHz buffers (`audio.ts:30`) into a 16 kHz `AudioContext` (`App.tsx:319`),
and `nextStartTime` scheduling computes duration off the 24 kHz buffer (`audio.ts:54`). Result:
pitch/speed-distorted Janus voice and broken gap-free scheduling. For a voice-first user the spoken
channel is the *only* output. Use a separate playback context at 24 kHz (or resample correctly).

---

## P1 — Close the voice feedback loop & keep state in sync

*The voice channel has to carry state both directions, and the live process set must match what the
agent reasons over.*

### P1.1 — Surface errors and disconnects on the audio channel
The server sends `{type:"error"}` (`server.ts:510`, `:838-842`) but the client `onmessage` has **no
`error` case** (`App.tsx:349-389`) — a bad key or rejected socket just leaves the user stuck in
"LISTENING…" forever. Add audible + visual error/reconnecting cues; the auto-reconnect
(`App.tsx:391-409`) is currently silent.

### P1.2 — Make transcripts actually populate
The "Janus Voice Log" panel (`App.tsx:1430-1481`) is the accessibility fallback, but the session is
audio-only with no `inputAudioTranscription`/`outputAudioTranscription` configured
(`server.ts:555-592`, `:725-729`), so `part.text` stays empty. Enable transcription config so the
panel reflects what was said.

### P1.3 — Push/speak pane state instead of pull-only
The model only learns pane state when it calls `get_pane_summary` (`server.ts:614-619`), capped at
~100 lines with no real delta despite the "markdown delta" claim (`server.ts:762`). Sam can't hear a
failed build; Maya's orchestrator can't reliably tell who's blocked. Push notable stdout to the model
and/or summarize aloud; implement real deltas so re-reads don't re-spend tokens.

### P1.4 — Reconcile live pane IDs with ledger pane IDs
Startup spawns `primary-cli` (`server.ts:117`) but the ledger persists `pane_1`; the agent addresses
ledger IDs and gets "not found" (`server.ts:639`). Stale ledger entries accumulate as ghost panes
(`terminal.ts:525-548`). Reconcile live processes against the ledger on boot.

### P1.5 — Sync `switch_context` with the restart path
The voice `switch_context` handler (`server.ts:620-626`) doesn't update
`settings.projects.activeContext`/`localWorkspacePath` like the REST endpoint does (`server.ts:374-383`),
so a pane that dies after a verbal project switch restarts in the wrong cwd (`server.ts:265-273`).

---

## P2 — Multi-agent correctness at scale

*Maya's daily setup — multiple agents in one repo, walking away while they work.*

### P2.1 — Key command history by pane, not cwd
History files live in the pane's cwd (`server.ts:52-54`), so two agents in the same repo share one
file and clobber each other's output capture (`server.ts:104-112`). Key by pane ID.

### P2.2 — Replace guessed idle/busy detection
`updateStatusOnOutput` flips to "Idle" 1 s after last output via a 5-line regex (`terminal.ts:155-179`)
and ignores the configurable `idleTimeoutMs`. Agent TUIs that redraw constantly read as perpetually
"Running." Make the heuristic configurable and TUI-aware so `listPanes` is trustworthy.

---

## P3 — Security hardening & cleanup

*Lower urgency given the auth boundary already exists, but required before unattended/networked use.*

- **Full Auto guardrails.** Full Auto is one global dropdown click (`App.tsx:680-689`) and the
  shipped Antigravity preset defaults to Full Auto + `--dangerously-skip-permissions`
  (`terminal.ts:51`). Add friction/confirmation; reconsider the autonomous default.
- **API key at rest.** Persisted plaintext to `.janus_settings.json` via the settings dialog
  (`SettingsDialog.tsx:1037-1043`, `terminal.ts:451`). *(The file is now gitignored as of this branch;
  still consider .env-only or encryption-at-rest.)*
- **Boot/network posture.** A shell pane is spawned at module load before any auth/connection
  (`server.ts:115-117`) and the server binds `0.0.0.0` by default (`server.ts:910`). Defer the default
  spawn and default-bind to loopback.
- **Enforce or remove `rateLimitRequestsPerMin`** — defined in settings (`types.ts:83`) but never read.
- **Cleanup / honesty.** Remove dead `pidusage`/`cachedCpu` (`terminal.ts:76`) or wire up the CPU
  telemetry the UI implies; drop fabricated `--resume=<id>` flag synthesis no agent accepts
  (`terminal.ts:219-224`); fix the misleading "strictly local Python subprocess" copy that describes a
  path the Node server doesn't use (`SettingsDialog.tsx:1058-1064`).

---

## Suggested sequencing

1. **P0 as one milestone** — without it the product can't honestly claim "hands-free" or "human-in-the-
   loop," and the test suite can't be trusted. This is the gate to any demo or dogfooding.
2. **P1** — makes the voice loop usable in both directions and stops ledger/process drift; this is what
   turns "connects" into "usable for a real session."
3. **P2** — unlocks Maya's actual multi-agent workload.
4. **P3** — required before anyone runs it unattended or on a shared network.

The single highest-leverage fix is **P0.3 + the test rewrite**: it's cited by all three personas, it
removes a silent state-desync, and it restores trust in the green test suite that everything else is
measured against.
