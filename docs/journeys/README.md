# Per-Journey Deep Dives — status and scope

This directory holds the **eight core user journeys** of OrbitalVoiceRunner as *intent*
documents: what the operator is trying to accomplish, and how the session flows when they do.

| Artifact | Status | Role |
|---|---|---|
| `<n>-<name>/deep-dive.md` | **Historical** (audited 2026-05-30, banner-stamped) | Narrative of operator intent + the May-2026 implementation trace. |
| `<n>-<name>/gaps.md` | **RETIRED 2026-08-05** — see below | Was a per-journey defect register. Superseded by beads. |
| [`../../JOURNEYS_DESIGN.md`](../../JOURNEYS_DESIGN.md) | **Live** | Current architectural map of the journeys + the cross-cutting coherence layer. |
| [`../../tests/test_journeys.ts`](../../tests/test_journeys.ts) | **Live — the source of truth** | J1–J8 executed against real PTYs and a real ledger. If it passes, the journey works. |

---

## Why the gap registers were retired

The eight `gaps.md` files (639 lines) were removed on **2026-08-05**. They were not wrong when
written — they were a snapshot that the code outran.

1. **They were a parallel issue tracker.** Project policy is that `bd` (beads) is the only task
   tracker. These registers were a second, frozen queue with its own ID scheme (`J<n>-G<n>`).
2. **They were a dead-end queue.** Of the **108** unique gap IDs across the eight registers
   (J1:17, J2:16, J3:14, J4:12, J5:12, J6:13, J7:13, J8:11), exactly **six** were ever promoted to
   beads — the 2026-06-11 `journey-coverage` export: `J1-G17`, `J2-G16`, `J2-G5`, `J3-G12`,
   `J3-G9`, `J8-G10`. No open bead tracks a gap row as live work; the only open mention of a
   `J<n>-G<n>` ID is bead `9jt3`, the optional one-time re-verification sweep filed at retirement.
3. **Their `file:line` citations had rotted.** They anchored the approval path at
   `server.ts:1127–1139`; that logic now lives in `src/approvalIntent.ts` (intent parsing),
   `src/voiceApprovalRouting.ts` (routing), `src/gating/index.ts` (TTL → last-call → grace →
   expire, brake), and `src/voice/turnArbiter.ts` (scheduling). Grepping the cited lines returned
   unrelated code — an active hazard for both humans and agents.
4. **Several entries had inverted, not merely aged.** `J3-G7` was titled *"No approval timeout:
   orphaned tool calls block the Gemini session indefinitely"*, with evidence *"no `setTimeout` or
   TTL exists anywhere in the `pendingApprovals` lifecycle."* Today the TTL → last-call → grace →
   expire lifecycle is mature enough that its **phrasing** is the remaining debt (bead `y9tj`).
   Acting on that register would mean rebuilding a shipped feature.

### Recovering the retired content

Nothing was lost; the files remain in git history.

```bash
# read one register as it stood at its final revision
git show 3888f38:docs/journeys/3-review-approve/gaps.md

# find the commit that deleted them
git log --diff-filter=D --oneline -- 'docs/journeys/*/gaps.md'
```

**Before acting on anything recovered this way, re-verify it against current code, then file a
bead.** Do not treat a recovered gap row as a live finding.

---

## Where journey defects live now

- **Live defects:** beads — `bd ready`, `bd list --status open`, `bd show <id>`.
- **The retired rows themselves:** bead `9jt3` (P4) is the optional one-time sweep to re-verify the
  108 recovered rows against current code. It is not on the critical path.
- **Cross-cutting conversational defects** (the assistant saying something untrue about state —
  stale last-calls, brake phrasing, arbiter drain ordering): see the **Conversational Coherence**
  layer in [`../../JOURNEYS_DESIGN.md`](../../JOURNEYS_DESIGN.md).
- **Standing re-scope ritual:** bead `akv` re-scopes active workstreams against the shipped UI.
  That ritual is what these frozen registers were reaching for, and it does not go stale.
