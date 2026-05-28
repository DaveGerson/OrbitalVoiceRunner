# Prioritized Implementation Roadmap — Orbital Harness / Janus Terminal Orchestrator

*Synthesized from three independent persona assessments:*
- **Marcus Chen** — Backend / Distributed Systems (`backend-systems-assessment.md`)
- **Priya Raman** — Frontend / UX (`frontend-ux-assessment.md`)
- **Sofia Almeida** — Security & DevOps (`security-devops-assessment.md`)

---

## Overall verdict

A clean, coherent **proof-of-concept** with sensible layering (`server → OrchestratorManager → UniversalTerminal → Ledger`) and a conceptually correct permissions model. But across all three lenses the same conclusion emerges: **the substrate is built for a demo, not for the stated goal** of orchestrating multiple, long-running, interactive CLI agents under real network and security conditions. Three findings are independently rated *fit-breaking / critical*:

1. **No PTY** — interactive agent CLIs (the product's entire target) don't actually work over pipes. *(Backend #1)*
2. **No authentication on any boundary + bound to `0.0.0.0`** — unauthenticated remote RCE today, and the permissions model is bypassable. *(Security C1/C2)*
3. **No WebSocket resilience + a mute that doesn't mute** — the voice core dies invisibly on any blip and keeps transmitting while showing "MUTED". *(Frontend #1/#2)*

The roadmap below sequences fixes by **severity, dependency, and shared effort**, collapsing the ~30 distinct findings into phased workstreams. Cross-cutting items (flagged by 2+ reviewers) are marked **[×N]**.

---

## Cross-cutting findings (flagged by multiple reviewers)

| Finding | Backend | Frontend | Security | Verdict |
|---|---|---|---|---|
| No PTY → interactive CLIs/TUIs broken (also breaks `<pre>` rendering) | #1 | #8 | — | **Fit-breaking [×2]** |
| Permissions gate is advisory, bypassable, not at the execution chokepoint | #8 | — | C2 | **Critical [×2]** |
| Unguarded `JSON.parse` on WS input → crash/DoS | #6 | — | M3 | **[×2]** |
| Fabricated `cpuUsage` (`Math.random()`) surfaced as real telemetry | #9 | (shown in UI) | L1 | **[×3]** |
| `pendingApprovals` single-slot / never expires → lost commands, hung agent turns | #7 | #5 | — | **[×2]** |
| No session/connection teardown & resumption | #2 | #2 | — | **[×2]** |

These are the highest-leverage fixes — each closes problems seen from more than one angle.

---

## Phase 0 — Stop the bleeding (days, mostly Small effort)

*Highest impact-to-effort. Trust, privacy, and unauthenticated-RCE fixes. Do these first.*

| ID | Item | Source | Effort | Impact |
|---|---|---|---|---|
| P0.1 | **Authenticate every boundary + bind `127.0.0.1` by default.** Shared-secret bearer token in Express middleware *and* WS `verifyClient`; `Origin` check; `0.0.0.0` becomes a warned opt-in. | Sec R1/R2, Back #8 | S | **Critical** |
| P0.2 | **Fix the mic-mute stale closure.** Read mute via `useRef` inside `onaudioprocess` so "MUTED" actually stops transmission. | FE R1 | S | **Critical** (privacy) |
| P0.3 | **Secrets hygiene.** Add `.janus_settings.json` to `.gitignore`; stop reflecting the unmasked key on `PUT /api/settings`; stop broadcasting it in `settings_updated`. | Sec R5 | S | High |
| P0.4 | **Flip insecure defaults.** Antigravity preset off `Full Auto` + `--dangerously-skip-permissions`; require explicit opt-in. | Sec R6/H3 | S | High |
| P0.5 | **Guard `JSON.parse` (WS + REST) + body limits.** try/catch around every parse, `express.json({ limit })`, WS message-size caps. | Back R6, Sec R7 | S | High |
| P0.6 | **Scrub child-process env.** Stop passing `process.env` wholesale; inject an explicit allowlist, never `GEMINI_API_KEY`. | Sec R4, Back #8 | S | High |

---

## Phase 1 — Make the core actually work (the "fit" fixes)

*Without these the product does not do what it claims. Mostly Medium/Large.*

| ID | Item | Source | Effort | Impact |
|---|---|---|---|---|
| P1.1 | **Adopt `node-pty`** in `UniversalTerminal` — real TTY semantics, flushing, resize. Unblocks all interactive agent CLIs. | Back R1/#1 | L | **Critical** |
| P1.2 | **Enforce permissions at a single `executeCommand` chokepoint** that REST-create, approve, Full Auto, and tool-call all pass through. Make HITL a real boundary, not UI decoration. | Sec R3/C2, Back #8 | M | **Critical** |
| P1.3 | **WebSocket resilience (client).** Exponential backoff + jitter reconnect, `onerror` handler, handle server `error` message, "reconnecting/disconnected" banner, re-acquire mic on reconnect. | FE R2 | M | High |
| P1.4 | **Session lifecycle (server).** `session.close()` on disconnect; capture/replay `sessionResumptionUpdate` handles; guard `sendToolResponse` against closed sessions. | Back R2/#2 | M | High |
| P1.5 | **Approval queue end-to-end.** `pendingCommand` → `PendingCommand[]`; stacked approval cards; TTL + timeout tool-response; key by `{socketId, callId}`; reconcile with `/api/commands/pending`. | FE R4, Back R7/#7 | M | High |
| P1.6 | **Audio pipeline rebuild.** Separate 24 kHz playback context; migrate capture to `AudioWorkletNode`; enable `echoCancellation/noiseSuppression/autoGainControl`; stop routing mic → destination. | FE R3 | M | High |

---

## Phase 2 — Durability, correctness & containment

*Survive real load, long sessions, crashes, and misuse.*

| ID | Item | Source | Effort | Impact |
|---|---|---|---|---|
| P2.1 | **Async, atomic, debounced persistence.** `fs.promises.writeFile` → temp + `rename`; single in-flight writer w/ dirty flag; stop `save()` inside the per-pane `syncLedger` loop. | Back R3/#3 | M | High |
| P2.2 | **Process teardown.** `detached: true` + process-group kill, `SIGTERM`→timeout→`SIGKILL`; clear `idleTimer` in `stop()`; server `SIGINT/SIGTERM` reaper; `restart` awaits exit. | Back R4/#4 | M | High |
| P2.3 | **stdout backpressure + coalescing.** Buffer per pane, flush on interval/size, drop-coalesce when `client.bufferedAmount` exceeds a watermark. | Back R5/#5 | M | High |
| P2.4 | **Real terminal emulation (xterm.js).** Replace `<pre>`, respect `maxBufferLines`, batch `stdout_chunk` via rAF/throttle, store output outside the main React tree to stop full-app re-renders. Pairs with P1.1 (PTY cols/rows). | FE R7/#8 | L | High |
| P2.5 | **Audit logging.** Durable append-only log (timestamp, source, pane, command, decision, approver) for every propose/approve/execute. | Sec R8 | M | High |
| P2.6 | **Command policy engine + enforce `rateLimitRequestsPerMin`.** Denylist (`rm -rf`, `curl | sh`, credential paths) + optional allowlist; wire the already-defined rate-limit setting. | Sec R9/H4 | M | Med |
| P2.7 | **Mic-permission lifecycle.** Pre-flight `permissions.query`, denied empty-state, input-level meter; move `getUserMedia` out of `onopen` and gate `isLive` on success. | FE R5/#4 | M | High |

---

## Phase 3 — Quality, accessibility & maintainability

| ID | Item | Source | Effort | Impact |
|---|---|---|---|---|
| P3.1 | **Accessibility pass.** `role="dialog"`/`aria-modal`/`aria-labelledby` + focus trap & restore on all modals; visible focus rings (kill blanket `focus:outline-none`); `aria-live="assertive"` on approval alert + toasts; `aria-label` on icon buttons; text alternatives for color-coded status. | FE R6 | M | High |
| P3.2 | **Replace/label fabricated `cpuUsage`** with real metrics (`pidusage`) or remove from API + ledger. | Back R8, Sec L1, FE | S | Med |
| P3.3 | **Real delta in `get_pane_summary`** — per-pane read cursor, emit only new lines (token economy the design claims). | Back R9/#9 | S | Med |
| P3.4 | **SettingsDialog refactor** — `useReducer`/react-hook-form over the typed schema; reconcile field paths with `SETTINGS_SPEC.md` (current `advanced.*`/`secrets.*` vs spec `orchestrator.*`/`voiceAi.*`); numeric validation. | FE R8/#9 | L | Med |
| P3.5 | **WS as single source of truth** — drop/relegate the 3 s poll to remove stdout flicker. | FE R10 | S | Med |
| P3.6 | **Client correctness** — remove `process.cwd()`/`process.platform` from browser code; add top-level `ErrorBoundary`; fix `<title>`/favicon/meta. | FE R11 | S | Med |
| P3.7 | **Lift `GenericPromptModal`** out of `App` into a stable component (fixes input-state reset under live stdout). | FE R9/#7 | S | Med |
| P3.8 | **Wire or remove** volume/speed/latency/`audioBufferSize` settings (currently inert "theater"). | FE R12 | S | Low |

---

## Phase 4 — Production readiness (DevOps)

| ID | Item | Source | Effort | Impact |
|---|---|---|---|---|
| P4.1 | **CI pipeline** — `npm run lint`, `npm test`, `npm audit --audit-level=high`, Dependabot. | Sec R11 | S | Med |
| P4.2 | **Sandboxing / least privilege** — container / `cwd` jail / least-priv user for command execution; document the threat model. | Sec R10 | L | High |
| P4.3 | **Hardening + observability** — `helmet`, `/healthz`, structured logging/metrics, correlation IDs across propose→approve→execute, child-process timeouts. | Back R11, Sec R12 | M | Med |
| P4.4 | **Persist scrollback** — rotating per-pane transcript file (server/pane restart currently loses all history). | Back gap | M | Med |

---

## Suggested execution order (dependency-aware)

```
Phase 0  ──▶  Phase 1  ──▶  Phase 2  ──▶  Phase 3  ──▶  Phase 4
(S, days)   (core fit)    (durability)   (polish)     (prod)

Critical path:
  P0.1 auth ─┬─▶ P1.2 enforced gate ─▶ P2.6 policy engine ─▶ P2.5 audit
             └─▶ (unblocks safe multi-client)
  P1.1 PTY ──────▶ P2.4 xterm.js (needs PTY cols/rows)
  P1.3 WS reconnect ─▶ P1.4 session resumption (pair)
  P0.2 mute + P1.6 audio (same file, ship together)
```

**Recommended first sprint:** all of **Phase 0** (high-trust, low-effort) + start **P1.1 (PTY)** and **P1.2 (enforced gate)** in parallel — these are the two largest fit/security blockers and are independent.

---

## Top 10 (flattened, if you only track one list)

1. **P0.1** Auth on every boundary + bind localhost *(Critical)*
2. **P1.1** `node-pty` backend *(Critical — core capability)*
3. **P1.2** Single enforced permissions chokepoint *(Critical)*
4. **P0.2** Fix mic-mute stale closure *(Critical — privacy)*
5. **P1.3** WebSocket reconnection + error surfacing *(High)*
6. **P0.3 / P0.6** Secrets hygiene + env scrubbing *(High)*
7. **P1.5** Approval queue (multi-pending) *(High)*
8. **P1.6** Audio pipeline rebuild *(High)*
9. **P2.1 / P2.2** Atomic persistence + process-group teardown *(High)*
10. **P3.1** Accessibility & focus management *(High)*

---

*This roadmap is synthesis only — no source code was modified. See the three persona assessments in this directory for full file:line evidence behind each item.*
