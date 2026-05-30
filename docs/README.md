# OrbitalVoiceRunner — Journey Review & Technical Audit

A code-verified, journey-driven review of OrbitalVoiceRunner (the voice-only,
hands-free/eyes-off Gemini Live terminal orchestrator, "Janus"). Produced by a
multi-agent pipeline: per-journey deep-dives → per-journey gap analysis →
holistic synthesis → forward/as-is architecture → consolidated bug log →
independent final audit.

> **Headline verdict (Phase 7, HIGH confidence):** a *solid backbone with broken
> connective tissue*. Every journey works in isolation for a sighted user but
> fails at the exact seam an eyes-off operator cannot recover from.
> **Not hands-free-safe today.** 39 distinct defects, 8 P0.

## Start here
- **[review/IMPLEMENTATION_PLAN.md](review/IMPLEMENTATION_PLAN.md)** — build-ready remediation plan: 12 workstreams across 4 milestones, dependency-aware sequencing, per-item file/function targets, data-model & tool-schema changes, tests, and the "hands-free-safe" definition of done.
- **[review/final-review.md](review/final-review.md)** — independent audit, re-verification (8/8 confirmed), priority challenges, new findings, remediation roadmap, readiness sign-off.
- **[review/BUG_LOG.md](review/BUG_LOG.md)** — consolidated, de-duplicated, prioritized bug log (P0→P3) + capability-coverage matrix + "what genuinely works". *(Stands in for the absent `BACKLOG.md` referenced by the design docs.)*

## Synthesis
- **[synthesis/holistic-user-flow-today.md](synthesis/holistic-user-flow-today.md)** — how all 8 journeys compose into one session loop today; journey-to-journey handoff table; shared-failure → journeys-impacted matrix.
- **[synthesis/current-technical-process.md](synthesis/current-technical-process.md)** — as-is end-to-end process trace, component inventory, real tool surface, persistence/event model, and a 23-item inconsistencies & oddities catalogue.
- **[synthesis/future-technical-architecture.md](synthesis/future-technical-architecture.md)** — best-in-class target architecture, subsystem-by-subsystem "Today → Target" contrasts, target tool surface, and a gap→target migration map.
- **[synthesis/_operator-narrative.md](synthesis/_operator-narrative.md)** — first-person "day in the car" eyes-off narrative chaining the journeys, friction tied to gap IDs (input to the holistic synthesis).

## Per-journey (deep-dive + gaps)
| # | Journey | Deep-dive | Gaps |
|---|---------|-----------|------|
| 1 | Fan-out / delegate in parallel | [deep-dive](journeys/1-fan-out/deep-dive.md) | [gaps](journeys/1-fan-out/gaps.md) |
| 2 | Supervisor / air-traffic control | [deep-dive](journeys/2-supervisor/deep-dive.md) | [gaps](journeys/2-supervisor/gaps.md) |
| 3 | Review & approve across panes | [deep-dive](journeys/3-review-approve/deep-dive.md) | [gaps](journeys/3-review-approve/gaps.md) |
| 4 | Knowledge capture & continuity | [deep-dive](journeys/4-knowledge-capture/deep-dive.md) | [gaps](journeys/4-knowledge-capture/gaps.md) |
| 5 | Adjust autonomy mid-session | [deep-dive](journeys/5-adjust-autonomy/deep-dive.md) | [gaps](journeys/5-adjust-autonomy/gaps.md) |
| 6 | On-demand status check | [deep-dive](journeys/6-status-check/deep-dive.md) | [gaps](journeys/6-status-check/gaps.md) |
| 7 | Dictate a specification *(secondary)* | [deep-dive](journeys/7-dictate-spec/deep-dive.md) | [gaps](journeys/7-dictate-spec/gaps.md) |
| 8 | Narrate a terminal walk-through *(secondary)* | [deep-dive](journeys/8-narrate-walkthrough/deep-dive.md) | [gaps](journeys/8-narrate-walkthrough/gaps.md) |

## The P0 set (eyes-off severity)
1. **BUG-001** — Janus is mute while an approval is pending and never speaks the command → blind voice approval.
2. **BUG-002** — No secret redaction before pane output reaches Gemini; tool description falsely claims "redacted".
3. **BUG-003** — Global permission override silently nullifies per-pane changes while reporting success.
4. **BUG-005** — Dead `gemini-3.5-flash` summarizer → every command outcome is the placeholder "Execution finished successfully."
5. **BUG-006** — `is_busy` reports false idle on any non-trivial workload (1s timer + prompt-pattern regex).
6. **BUG-007** — Multi-pane voice approval resolves the oldest FIFO entry, not the intended pane; no spoken read-back.
7. **BUG-008** — Naive substring voice parser: no negation handling; `isApprove` wins collisions.
8. **BUG-013** — In-memory-only volatile state (pending approvals, prompt buffer, resumption token) lost on restart/drop.

> **Critical coupling (Phase 7, N-5):** BUG-005 and BUG-002 are hard-coupled — the
> summarizer sends raw output to a *second* Gemini call, so fixing the model name
> without a redaction layer would *worsen* secret exfiltration. Redaction must land first.

## Method & caveats
- **Code-verified:** findings cite `file:line`; the final audit independently re-read the 8 highest-stakes claims (8 CONFIRM / 0 REFUTE, minor citation drift only).
- **Analysis only:** no production code (`server.ts`, `src/`) was modified by this review — only `docs/`. Fixes are a separate follow-up.
- **Lens:** severity/priority is judged by **hands-free / eyes-off operator impact** throughout.
