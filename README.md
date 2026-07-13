# Orbital Harness — Janus Voice Communication Cockpit

A web-based, voice-controlled **communication cockpit** for a fleet of local
terminal coding agents (Claude Code, Codex, Antigravity, or any CLI). You speak
to **Project Janus** (a Gemini Live voice agent); it observes your terminal
panes, drafts and routes instructions to them, correlates what comes back, and
reports outcomes — all under a configurable capability-gate safety matrix.

**The boundary, in one sentence:** *Orbital listens, understands, drafts,
routes, correlates, and reports; the terminal agents do the engineering.*
Orbital never plans implementations, never fabricates instruction content the
operator didn't say, never verifies an agent's engineering (it records the
agent's own report), and never re-sends work on its own initiative.

## How it works

```
 Browser (mic + cockpit UI)      Node server (server.ts)               Gemini Live
 ──────────────────────────      ───────────────────────               ───────────
 PCM 16kHz  ──audio frames──▶    WebSocket /live  ──realtime audio──▶   model
 audio out  ◀──audio frames──    WebSocket /live  ◀──audio + tools───   (tool calls)
 live UI    ◀──stdout chunks──          │
                                        │ spawns / observes / gated writes
                                        ▼
                                 UniversalTerminal panes (real PTY, node-pty/ConPTY)
                                        │
                                        ▼
                                 SQLite ledger (.janus.db — JanusStore, schema v12)
                                 projects · panes · approvals · agent_exchanges ·
                                 exchange_events · context_deliveries · telemetry
```

1. The browser streams mic audio over `/live`; the server forwards it to a
   Gemini Live session. Panes boot **inert** — nothing spawns until you (or a
   gated action) starts one.
2. The model's tool calls ride a unified action registry (voice + REST twins).
   Every pane-mutating action routes through the **capability-gate matrix**
   (per-capability Auto/Ask/Off, global + per-pane) — the single permission
   choke-point.
3. A Python "cortex" daemon (stdio-JSON) owns deterministic decision logic
   (context curation, focus/target ranking, SITREP ranking, session-pool
   planning) with a fail-closed TypeScript floor: a dead daemon can only ever
   narrow behavior, never widen it.

## The exchange lifecycle (schema v12)

Every operator instruction is tracked as a durable **AgentExchange** — a
communication record, not a work engine — through a 12-state lifecycle:

```
draft → awaiting_clarification → awaiting_approval → staged → delivered
      → running → needs_input → terminal_idle → agent_complete
                                              → agent_failed
      (any cancellable state → cancelled; any in-flight state → interrupted)
```

Key guarantees (spec: `docs/superpowers/specs/2026-07-09-agent-exchange-spine.md`):

- **Exactly-once delivery**: approval confirmation and every state transition
  are CAS-guarded; a double-click, replayed voice call, or duplicated approval
  can never double-type into a live agent.
- **Draft-version binding**: editing a draft invalidates any outstanding
  approval — what the operator heard read back is byte-for-byte what can land.
- **Never invent history**: on restart, in-flight exchanges are quarantined to
  `interrupted` (surfaced for the operator to dismiss or follow up) — never
  auto-resumed, never re-sent, never settled from stale scrollback.
- **Reports, not verification**: `agent_complete` records the agent's own
  report (result envelope or conservative prose heuristic). Orbital never runs
  tests/builds to "verify" an exchange.
- **Redaction at rest**: instructions are delivered raw but persisted redacted;
  every free-text column is scrubbed at the write boundary.

Instruction drafting rides the **InstructionEnvelope**
(`objective / relevant_context / constraints / requested_output /
completion_signal` — operator-stated content only; spec:
`docs/superpowers/specs/2026-07-09-instruction-routing.md`), converged with the
Workbench draft so voice and typed edits mutate the same versioned draft.

## Fleet cockpit

- **Fleet exception view** — "communication by exception": a per-pane card lane
  showing only what needs you (questions, held approvals, failures/interrupts),
  with lifecycle-consistent quick actions (Answer / Approve / Deny / Retry for
  interrupted exchanges / Hold-cancel / Open pane) and per-project announcement
  mute.
- **Exchange replay** — one exchange's full redacted communication timeline
  (events, approvals, context versions, terminal transitions; instruction
  content only ever as a hash): `GET /api/exchanges/:exchange_id/replay`.
- **Communication-quality metrics** — wrong-target tripwire, duplicate
  deliveries, clarification causes, speech-to-draft / delivery latency, context
  cost: `GET /api/exchange-metrics` or `npx tsx scripts/exchange-metrics-report.ts`.
- **Exchange-aware notifications** — exactly-once narration of questions/
  failures (background projects cross over named explicitly, never stealing
  focus), spoken SITREP board, catch-up digests anchored to your away window.

Operations, feature flags, rollout order, and troubleshooting:
**`docs/runbooks/communication-cockpit-operations.md`**.

## Permissions model

Every pane has a `permissionsMode`; a `globalPermissionsMode` can override it.
The effective mode is: use the global mode unless it is `Inherit`, in which case
the pane's own mode applies (defaulting to `Human-in-the-Loop`). On top of the
mode, each capability (write_to_pane, send_keys, create_pane, …) carries its own
Auto/Ask/Off gate, AND-composed with the mode.

| Mode               | Effect on proposed writes                             |
| ------------------ | ---------------------------------------------------- |
| `Full Auto`        | Commands write to the pane without confirmation.      |
| `Human-in-the-Loop`| Each write is held as a pending approval in the UI.   |
| `Read-Only`        | Output only; the pane accepts no agent writes.        |
| `Inherit` (global) | Falls back to the pane's own mode.                    |

Tool presets (`Claude Code`, `Codex`, `Antigravity`, `Custom`) seed a pane's
startup command and, for non-custom presets, manage permission flags based on
the mode.

## Project structure (orientation)

```
server.ts                  Express + WS hub; Gemini Live bridge; REST API (~3,200 lines — grep first)
src/terminal.ts            UniversalTerminal + OrchestratorManager (pane lifecycle over real PTY)
src/store/                 SQLite ledger (JanusStore, schema v12), migrations, retention
src/exchanges/             AgentExchange spine: lifecycle, correlator service, recovery,
                           instruction envelope, draft registry, result envelope,
                           fleet projection, metrics, replay
src/voice/                 Gemini Live session, target resolver, SITREP, session pool, spoken confirm
src/observe/               Pane-output observation: transitions, completion heuristics, attention
src/gating/, src/dispatch/ Capability-gate choke-point + the single gated write path
src/actions/               Unified action registry (voice + REST surfaces)
src/orbital/, src/classic/ React frontends (cockpit / classic)
python/                    The decision layer: cortex synthesizer + policies daemons (stdio-JSON)
docs/                      Specs, runbooks, reviews, roadmap
```

Persistent state lives next to the server: `.janus.db` (SQLite — the ONLY
ledger backend), `.janus_settings.json`, `.janus_history.json` (redacted pane
command history), `.janus_interaction_log.jsonl`. A one-way JSON→SQLite boot
migration upgrades pre-SQLite installs.

## Prerequisites

- Node.js 18+ (developed against Node 22)
- Python 3 (for the cortex/policies daemons; the TS floor covers a missing Python)
- A Google Gemini API key with access to the Live API

## Setup & running

```bash
npm install
cp .env.example .env   # set GEMINI_API_KEY
npm run dev            # server + Vite middleware at http://localhost:3000
```

```bash
npm run build          # vite + esbuild → dist/server.cjs
npm start              # run the production build
npm test               # unit suite (tsx --test --test-force-exit)
npm run test:component # vitest component tests
npm run test:e2e       # Playwright (?mock=1 harness, auto-starts Vite)
npm run test:py        # python pytest suites
npm run typecheck      # tsc --noEmit
npm run complexity     # eslint gates: CC<=10 + cognitive<=15 (errors, zero suppressions)
npm run catalog        # regenerate the capability catalog (drift-gated by tests)
```

Open http://localhost:3000, click **Connect**, and grant microphone access.
Panes boot inert — create one via the UI or `/restart`.

## Security posture

- The REST API sits behind a per-boot token (`x-api-token` header / an
  `httpOnly SameSite=strict` cookie seeded on loopback or via an explicit
  `?auth_token=` bootstrap); an Origin fence guards the WS. Still: the server
  runs commands on the host — run it only in trusted environments and avoid
  `Full Auto` for untrusted input.
- Secrets are redacted before persistence and before any model-bound string.
- The latest security review of the communication pipeline:
  `docs/review/2026-07-10-communication-security-review-5.4.md`.
