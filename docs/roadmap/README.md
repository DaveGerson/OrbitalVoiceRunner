# Roadmap

Living capability roadmap for Orbital Harness / Janus, synthesized from three forward-looking
developer personas (Maya — power user; Devon — security/platform; Sam — voice-first).

| File | What it is |
|---|---|
| **`RECONCILIATION.md`** | **START HERE** — re-integrates this roadmap with the now-central capability-gate vision; proposed priority stack + decisions for the director |
| `NEXT-LEVEL-ROADMAP.md` | The headline roadmap — net-new capability, velocity & usability focus, 10 prioritized items (velocity-lens; read through `RECONCILIATION.md`) |
| `ROADMAP.md` | Round-one prioritized bug/UX roadmap (the foundation the next-level items assume is done) |
| `01..03-*.md` | Per-persona codebase assessments (the evidence behind the synthesis) |
| `next-level/{maya,devon,sam}.md` | Per-persona forward wishlists feeding the headline roadmap |

Provenance: salvaged from the retired `claude/relaxed-gates-LI27l` branch (archived at tag
`archive/relaxed-gates`). Line anchors were written against `main @16c62da` (2026-05-28) and are now
stale — current main is **`7efcaee` (2026-06-06)**, several hundred commits of prompt-composer/WS/
ledger/voice-UX work past that baseline. The SHA/date headers here and in `NEXT-LEVEL-ROADMAP.md` are
refreshed, but the inline `server.ts:NNN` / `App.tsx:NNN` citations are NOT — re-anchor each before
acting on any single item.

## ✅ Reconciled with the capability-gate vision

This roadmap was **deliberately narrowed to developer velocity & usability**, and in doing so it
**explicitly deprioritized the security/governance control-plane** — policy rule engine, command
risk-classification / tiered approval, signed audit log, multi-operator RBAC, global kill-switch
(see the "Removed" section in `NEXT-LEVEL-ROADMAP.md` and the rationale in `next-level/devon.md`).

That control-plane is now the **central product thesis** (the Janus capability-gate model: a
per-capability **Auto / Ask / Off** approval matrix as the safety dial). So the headline roadmap's
priority ordering is stale with respect to the current vision: it parks the very layer the product
now leads with.

**Reconciled — director decisions LOCKED 2026-06-01.** See **`RECONCILIATION.md`** for the authoritative
view: the matrix is the safety substrate the whole velocity roadmap rides on, and the locked stack is
`P0a harden → P0b push-observation + matrix surface → P1 velocity → P2 polish`, with RBAC, signed/replay
audit, per-path policy, and per-command risk badges **out of scope** under the single-director thesis.
`NEXT-LEVEL-ROADMAP.md` below is the velocity-lens source; read it through `RECONCILIATION.md`'s §4 stack.
