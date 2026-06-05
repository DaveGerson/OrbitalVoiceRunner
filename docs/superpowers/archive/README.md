# Archived design docs

Docs here are **delivered or superseded** — kept for provenance, not for active tracking.

A doc lands in `archive/` when:
- its work is fully merged to `main` and its named beads are all closed (**done**), or
- a newer committed doc has become the system of record for the same scope (**superseded**).

Live, in-flight plans/specs stay in `docs/superpowers/{plans,specs}/`. Canonical current
state always lives in **beads** (`bd prime`) — these files are point-in-time records.

## Contents

- `plans/2026-06-04-handoff-registry-plus-plumbing.md` — the line-anchored execution scaffold
  behind the committed spec `specs/2026-06-04-handoff-registry-plus-plumbing.md`. All four waves
  (A crash-safety, B keystone create_pane parity, C REG1 registry, D PLM1-5 plumbing) merged to
  `main`; every named bead (qw1-6, h1, ks, reg1, plm1-5) CLOSED. Both done **and** superseded by
  its committed spec sibling, which is the system of record. The only deferred slivers (PLM2/PLM5
  UI panels) are tracked under open bead `wsm-e2e-pinned-apu`.
