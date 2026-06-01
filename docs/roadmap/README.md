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
`archive/relaxed-gates`). Line anchors validate against `main @16c62da` (2026-05-28) and predate the
prompt-composer/WS work now on the trunk — re-anchor before acting on any single item.

## ⚠️ Out of sync with the higher-level tool vision

This roadmap was **deliberately narrowed to developer velocity & usability**, and in doing so it
**explicitly deprioritized the security/governance control-plane** — policy rule engine, command
risk-classification / tiered approval, signed audit log, multi-operator RBAC, global kill-switch
(see the "Removed" section in `NEXT-LEVEL-ROADMAP.md` and the rationale in `next-level/devon.md`).

That control-plane is now the **central product thesis** (the Janus capability-gate model: a
per-capability **Auto / Ask / Off** approval matrix as the safety dial). So the headline roadmap's
priority ordering is stale with respect to the current vision: it parks the very layer the product
now leads with.

**Reconciled (2026-05-31):** see **`RECONCILIATION.md`** for the re-integrated view — the matrix is now
the safety substrate the whole velocity roadmap rides on, several roadmap items (5, 7, 9) moved toward
done via the matrix build, and the cut governance items are re-scored (some built, some now cheap and
re-elevated, some correctly deferred). Until the director confirms the §6 decisions there, treat
`NEXT-LEVEL-ROADMAP.md`'s ordering as velocity-lens input, not the authoritative plan.
