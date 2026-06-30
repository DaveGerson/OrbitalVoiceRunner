# Cortex Seam — Flip Readiness Decision Package

- **Date:** 2026-06-29
- **Status:** OPERATOR DECISION REQUIRED
- **Plan ref:** `docs/superpowers/plans/2026-06-27-seam-completion-plan.md`
- **Cortex design:** `docs/superpowers/specs/2026-06-27-python-cortex-shadow-design.md`

---

## BLUF

The cortex seam is **FLIP-READY**: the SHADOW mechanism is built and running default-off, the
18-fixture parity battery is green, and `cortex_decide_golden.json` is in the repo.
Completing the seam (plan §6 DoD items e–h) is blocked **only** on three operator decisions
and the prod metrics window those decisions unlock — no additional code infrastructure is
needed before you decide.

---

## 3 Decisions You Owe

### Decision 1 — B-3: Approve the curation rule ladder (the deferred curation policy)

**What it is.**
`cortex.decide()` currently returns an identity baseline (keep everything, drop nothing,
`strategy: "baseline-identity"`). B-3 replaces that with a four-rule ladder gated on live
system signals. The plan proposes these three live-state rules (plus the identity fallback):

| Rule name | Signal condition | Effect |
|---|---|---|
| `frozen-posture` | `gatePosture == "Off"` | `keep=["project","frame"]`, drop pane/board/breadcrumbs |
| `inactive-pane` | `pane.status` in `{Idle, Exited}` or absent | `keep=["project","breadcrumbs","board","frame"]`, drop pane |
| `post-approval-focus` | `lastApprovalTs` present and `now - lastApprovalTs < 30 000 ms` | rerank active pane to front of keep list |
| `baseline-identity` | no signals match | keep all tiers, identity order |

**Recommendation:** approve the ladder as-is as the v0.2.0 starting set.

Rationale: these three conditions are already observable in live `tiers` and `ctx` (no new
telemetry plumbing needed), they cover the highest-signal pane lifecycle transitions, and each
rule degrades safely (SHADOW until flip, identity if signals absent). The 30 s
post-approval window is the same quiescing heuristic already established in the approval
migration. You can tune values after shipping.

**Why it blocks.**
B-3 is the prerequisite that makes the B-1 flip *meaningful*. Flipping with only the identity
baseline is safe but operationally pointless — you would be primary with zero curation benefit.
The B-4 RETIRE gate explicitly requires B-3 shipped before `synth.py` is deleted.

**Your call:** approve the ladder above, or substitute / add rules before implementation starts.

---

### Decision 2 — B-1: Set the bounded-divergence trust threshold + activation window

**What it is.**
Before setting `JANUS_CORTEX_PRIMARY=1` in prod, the operator must define the numeric trust
gate: the shadow divergence ceiling that must hold over a confirmed observation window.

**Recommendation:**

- **Metric:** `|Δ textLen| / textLen < 5%` (relative text-length divergence between cortex-filtered
  brief and full `synthesizeAsync` brief), measured over the same shadow window pattern used for
  the approval flip (i.e., the same duration of continuous shadow-match you required for
  `JANUS_APPROVAL_PYTHON_PRIMARY=1`).
- **When to set the flag:** once that window closes clean on the shadow stats visible in
  `GET /api/health → memory.daemon`.

Rationale: 5% textLen delta is a tight but achievable ceiling for an identity baseline (should
be 0% divergence until B-3 lands), and mirrors the approval migration's discipline of requiring
a real observation window before promotion. The textLen proxy is computable from the existing
`SynthesizedBrief` response without new instrumentation.

**Why it blocks.**
The B-1 flip mechanism (`JANUS_CORTEX_PRIMARY`, `setCortexPrimary`, `resolveWithCortex`) is
already spec'd and buildable now, but the implementation cannot be activated without a declared
threshold — otherwise there is no principled condition under which a subagent or you can pull
the trigger. The threshold also anchors the B-4 RETIRE gate's `cortexFallbackRate ≈ 0`
requirement.

**Your call:** confirm 5% / same window length, or set different values.

---

### Decision 3 — B-4: Define the RETIRE prerequisites window

**What it is.**
B-4 deletes `synth.py` and the TS synthesizer client paths. The plan's gate requires all
three of these to be true before deletion is permitted:

1. B-1 (`JANUS_CORTEX_PRIMARY=1`) is active in prod.
2. B-3 (real curation rules) is shipped.
3. `health.memory.daemon.cortexFallbackRate ≈ 0` over an **operator-confirmed** observation window.

The `cortexFallbackRate` counter (`health.memory.daemon.cortexFallbackRate`, mirroring the
approval flip counter from Inc 2.3) is **already wired** — it shipped alongside the B-1 mechanism
(`getCortexFallbackStats` + `daemonHealthWithCortex`), is warm-up-immune, and reads 0 until the
flip is live. So this prerequisite is already met; the observation window can start the moment
the flip is activated in prod.

**Recommendation:** define the RETIRE window as the same duration used for the approval-twin
RETIRE (A-2), and require the cortexFallbackRate counter to be green (not just near-zero, but
confirmed by you closing the observation manually) before the deletion PR is merged.

**Why it blocks.**
Without a declared window length, the "≈ 0 over a window" gate is unactionable — a subagent
cannot know when RETIRE is permitted. The counter sub-task within B-4 also cannot be treated
as done until you confirm it is the right metric.

**Your call:** confirm the window duration and confirm that operator sign-off (not just a
counter value) is the final gate on the deletion PR.

---

## What Is Already Done vs What Is Left

| ID | Name | State | Notes |
|---|---|---|---|
| **Inc 4.1** | `cortex.decide` IDENTITY baseline + `createPythonCortexClient` + `observeCortexShadow` fire-and-forget | **DONE — on main** | SHADOW is live, zero user risk |
| **Inc 4.2** | `cortex.synthesize_shadow` byte-for-byte parity vs `synth.py` (18-fixture battery), `shadowBudget` in trace | **DONE — on main** | Parity battery continuously green |
| **B-5** | `tests/fixtures/cortex_decide_golden.json` + `test_cortex_decide_golden_parity.ts` | **DONE — fixture confirmed in repo** | Golden tripwire is live in test suite |
| **B-1 mechanism** | `JANUS_CORTEX_PRIMARY` env flag, `setCortexPrimary`, `resolveWithCortex`, fail-closed floor | **BUILT, DEFAULT-OFF** | Awaiting Decision 2 before prod activation |
| **cortexFallbackRate counter** | `health.memory.daemon.cortexFallbackRate` (sub-task of B-4) | **WIRED, DEFAULT-OFF** | Built alongside B-1 (`getCortexFallbackStats` + `daemonHealthWithCortex`); warm-up-immune; reads 0 until the flip is live |
| **B-3** | Real curation rules (frozen-posture / inactive-pane / post-approval-focus) | **DECISION-GATED** | Blocked on Decision 1 |
| **B-2** | Outcome-triggers + diff-gated inject-gate (`command_outcome` as 4th trigger) | **DECISION-GATED** | Operator must confirm diff-gated vs debounce vs significance |
| **B-6** | Hysteresis / quietWindowMs callable | **DECISION-GATED** | One value: `quietWindowMs` (suggested 500 ms) |
| **B-7** | Session/connection-management lifecycle policy | **DECISION-GATED** | Three decisions: TTL values, restartOnExit opt-in vs default, SHADOW-only vs apply scope |
| **B-4** | Cortex RETIRE — delete `synth.py`, retire `PythonSynthClient` | **METRICS-GATED** | Requires B-1 + B-3 in prod + cortexFallbackRate ≈ 0 over confirmed window |

---

## Smaller Decision-Gated Follow-Ups (not blocking the flip)

**B-6 — Hysteresis (`quietWindowMs`).**
One value to set. Suggested default: `quietWindowMs = 500 ms`. This damps back-to-back identical
snapshots from double-firing the cortex. Independent of B-1, B-2, B-3 — can be implemented any
time after you confirm the 500 ms value (or substitute your own). It does NOT block the flip.

**B-2 — Outcome-triggers (diff-gated vs alternatives).**
The plan proposes diff-gated (inject on `command_outcome` only if the tier digest changed).
Alternatives are debounce (time-window) and significance (content-change threshold). This is a
product call about injection noise tolerance. Independent of B-1 and B-3 — buildable the moment
you confirm the strategy. It does NOT block the flip.

---

## Execution Order Once You Decide

```
Decision 1 (B-3 ladder) ──▶ implement B-3 ──┐
                                              ├──▶ B-1 flip in prod ──▶ wire cortexFallbackRate counter
Decision 2 (B-1 threshold) ──────────────────┘                          ──▶ confirmed window ──▶ B-4 RETIRE
Decision 3 (B-4 window) ──▶ sets the RETIRE gate condition

Parallel (any time after confirming the value):
  quietWindowMs → B-6
  diff-gated confirm → B-2
```

The flip (B-1) can technically activate with the identity baseline before B-3 lands, but the
recommended order is B-3 first so the first prod primary is actually doing useful curation.
