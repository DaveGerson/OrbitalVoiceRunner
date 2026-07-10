# Fleet View — Design Spec

**Date:** 2026-06-25 · **Status:** Draft for Claude Design iteration · **Surface:** Orbital Kitchen (classic UI is being deprecated)
**Grounded against:** `main` @ `d6a35d5` · roadmap `docs/roadmap/NEXT-LEVEL-ROADMAP.md` item 6 · persona `docs/roadmap/01-power-user-maya.md`

> **How to use this doc:** This is the behavior + data + states spec. The *visual* iteration happens in Claude Design — sections marked **🎨 Design-iterable** are the open forks to play with there. Everything else is grounded in the live codebase and should hold steady.

---

## 1. BLUF

Fleet View is a single screen showing **every AI-agent pane across all your local projects at once**, urgency-sorted, with **act-in-place** controls (approve/deny/quick-reply without leaving the view). It is an **opt-in mode** — the single-project board stays the default.

**Key engineering finding (de-risks the whole thing):** this is a **pure frontend reshape**. ~70% of the substrate already ships:
- The "All kitchens" scope **already flattens panes across all projects** (`Line.tsx:125`).
- Urgency sort **already exists** (`sortStationsByUrgency`, `station.ts:172`, applied at `station.ts:202`).
- Act-in-place approve/deny **already ships** in the attention inbox (`useOrbitalData.ts:1840`), hitting the same REST route voice uses.
- `/api/terminals` **already returns every project's panes** in one flat array — no per-project scoping, no new endpoint.

So Fleet View = promote the existing "All kitchens" flatten into a first-class, urgency-sorted **monitoring + action** surface, with project tags and fleet-wide counters. No server changes required.

---

## 2. The user & the problem

**Persona:** Maya — power-user driving 4–6 agents by voice across several repos; wants fleet legibility without babysitting panes.

**The moment:** You're running agents across three repos. You're looking at **Project A**'s board. An agent in **Project B** finishes and hits an approval prompt — it's now idle, *waiting on you* — but you're blind to it because B isn't on screen. It hides until you happen to flip over.

**The fix in one line:** nothing urgent in any project hides just because you're not currently looking at that project.

**Before → after:**
```
 TODAY (one project at a time)          FLEET VIEW (all projects, urgency-sorted)
 ┌─ Project A ▼ ─────────────┐          ┌─ All Projects · 3 need you ───────────────────┐
 │  ▢ agent-1  running       │          │ ⚠ agent-7  NEEDS YOU   [B]  approve│deny       │
 │  ▢ agent-2  idle          │          │ ⚠ agent-3  ERRORED     [A]  view│restart       │
 └───────────────────────────┘          │ ▢ agent-2  idle        [A]                     │
   (B + C hidden — blind to              │ ▢ agent-1  running     [A]  ▸ peek             │
    anything urgent over there)          │ ▢ agent-9  running     [C]  ▸ peek             │
                                         └────────────────────────────────────────────────┘
```

---

## 3. Scope (YAGNI)

**In scope (v1):**
- All panes across **all local projects** in this Janus instance, on this machine.
- Urgency-sorted single grid; project tag per card.
- Fleet-wide counters (total / running / needs-you).
- Act-in-place: approve/deny a pending approval; send a one-line reply to an agent awaiting input; jump-to-pane.
- Opt-in toggle from the existing project switcher; single-project remains default.

**Out of scope (explicitly):**
- **Remote / cross-machine fleet** (agents on other Janus instances) — needs a sync layer; this is v2.
- New server endpoints, new data model, or new gating logic — none needed.
- The full "video wall" live-terminal-per-card (that was deliberately deferred in decision D7 in favor of text-peek; Fleet View reuses the existing peek, it does not build xterm-per-card).
- Re-skinning the classic UI (deprecated).

---

## 4. What already exists (build ON this, don't rebuild)

| Capability | Where | Reuse in Fleet View |
|---|---|---|
| Flatten panes across all projects | `Line.tsx:125` (`selectedProject === "all"`), `Line.tsx:180` ("All kitchens" row) | This becomes the Fleet View scope. |
| A "Station" per pane with all needed fields | `station.ts:11-35` | Each fleet card binds to a Station. |
| Urgency sort (Needs Input → Exited → Idle → Running) | `station.ts:172-182`, applied `station.ts:202` | Fleet grid order — as-is. |
| All-projects pane data, single fetch | `GET /api/terminals` (`useOrbitalData.ts:433`); WS `terminals_updated` | No new fetch; data is already client-side. |
| All workspaces (project metadata: name, color, emoji) | `GET /api/ledger` (`useOrbitalData.ts:444`) | Project tags / grouping. |
| Act-in-place approve/deny | `useOrbitalData.ts:1840` `approveAttention`/`denyAttention` → `POST /api/commands/approve` | Same callbacks on the fleet card. |
| Live status patches | WS `pane_status`, `approval_pending`, `action_pending` (`useOrbitalData.ts:647-793`) | Cards update in real time, no polling. |

**Station fields available per card** (`station.ts:11-35`): `status` (Running / Needs Input / Exited / Idle), `project`, `projectName`, `projectColor`, `projectEmoji`, `name`, `toolPreset`, `chef`, `cwd`, `elapsed`, `contextFill`/`contextLabel`/`contextPips`, `outputTail` (last 4 lines), `needsInput`, `posture` (OPEN/GUARDED/LOCKED), `mode` (Full Auto / Human-in-the-Loop / Read-Only).

---

## 5. The experience

### 5.1 Entry & toggle
- Fleet View is reached from the **existing project switcher / "All kitchens" row** (`Line.tsx:173-218`). Selecting "All Projects" enters Fleet View; selecting a single project returns to today's per-project board.
- Single-project is the **default landing** (per decision: opt-in). The toggle is sticky within a session.
- 🎨 **Design-iterable:** how prominent the toggle is — a segmented control ("This project | All projects"), a dedicated nav item, or just the top row of the existing project list.

### 5.2 The fleet grid
- One scrollable grid of **fleet cards**, ordered by urgency (Needs Input first, then Exited/errored, then Idle, then Running).
- Each card is tagged with its **project** (color dot + emoji + short name, from `projectColor`/`projectEmoji`/`projectName`).
- Header shows **fleet-wide counters**: `N agents · M need you · K running` (computed client-side over the full stations array — see §7).
- 🎨 **Design-iterable — the single biggest layout fork:** *flat urgency list* vs *grouped-by-project with urgency within each group*. (Recommendation: **flat urgency by default**, with a "group by project" toggle — Maya's core need is "what needs me, anywhere," which a flat urgency sort serves best; grouping is a secondary lens.)

### 5.3 The fleet card (anatomy)
Minimum binding per card: status, agent name, project tag, and a contextual action zone.
```
┌──────────────────────────────────────────────┐
│ ⚠ NEEDS YOU   refactor-agent      [🟦 webapp] │  status • name • project tag
│ "Run: npm run migrate"            ⏳ 0:42      │  ask preview • countdown (if approval)
│ [ Approve ]  [ Deny ]   ⟶ open                 │  act-in-place zone
└──────────────────────────────────────────────┘
```
- 🎨 **Design-iterable:** how much per card — full output peek (`outputTail`, last 4 lines) on every card vs only on hover/expand vs only on running cards; whether to show context meter / mode / posture chips. Denser = more agents on screen; richer = more per agent. (Recommendation: compact by default — status, name, project, action zone, a one-line peek; expand-on-hover for the rest.)

### 5.4 Act-in-place (the interaction that matters)
Per the locked decision, you act **without leaving the view**. Behavior depends on what the agent is waiting on:
- **Pending approval** → `Approve` / `Deny` buttons on the card, wired to the existing `approveCommand(messageId)` / `rejectCommand(messageId)` (`useOrbitalData.ts:1803/1840`). Optimistic clear + the existing toasts ("Order up! 🍽" / "86'd it"). Show the auto-reject **countdown**.
- **Awaiting free-text input** → an inline **quick-reply** field that sends one line to that pane (reuse the pane-input path the composer already uses), then collapses.
- **Errored / Exited** → `View` (jump-to-pane) and, where applicable, `Restart`.
- **Running / Idle** → a `▸ peek` affordance (expand the `outputTail`) and `⟶ open` (jump-to-pane). No destructive actions.
- **Jump-to-pane** (`⟶ open`) on any card: switches the board to that pane's project and focuses it — the escape hatch to the full pane when act-in-place isn't enough.

### 5.5 Counters become fleet-wide
Today the header counts are computed over the active project's stations only (`Line.tsx:179`, `OrbitalApp.tsx:222`). In Fleet View they aggregate over **all** stations. (Pure client-side change — see §7.)

---

## 6. States & edge cases

| State | Behavior |
|---|---|
| **0 projects / 0 panes** | Empty state: "No agents running across any project." + a hint to start one. |
| **1 project only** | Fleet View still works but is degenerate; the toggle may be hidden or a no-op. (🎨 Design: decide whether to surface the toggle at all with one project.) |
| **Many panes (20–40+)** | Density matters. Provide a density control and/or collapse the Running/Idle tail behind a "show N running" expander, keeping Needs-You/Errored always visible. (🎨 Design-iterable — see §8.) |
| **Agent exits / errors while you're looking** | Card re-sorts upward in real time (WS `pane_status` / signals). Subtle motion, not a jarring jump. An earcon already fires for exits (`504d1ec`) — Fleet View should not double-announce. |
| **Approval expires before you act** | Countdown hits 0 → card transitions to its auto-resolved state and re-sorts; no error. |
| **STOP-ALL / frozen** | When the system is frozen, act-in-place controls must reflect the gate — disabled or clearly "frozen," consistent with the existing posture/gate treatment. Do not allow an action the gate would reject. |
| **Action fails (network / gate reject)** | Revert the optimistic update + show the failure toast, same pattern as the attention inbox today. |

---

## 7. Data & wiring (grounded — no server changes)

- **Source:** the existing `stations` array (all projects) already in memory via `deriveStations` (`station.ts:202`) over `GET /api/terminals` + `GET /api/ledger`.
- **Order:** `sortStationsByUrgency` (`station.ts:172`) — reuse as-is.
- **Counters:** aggregate client-side over the full `stations` array (e.g. `stations.filter(s => s.status === "Needs Input").length`), generalizing the per-project counts at `Line.tsx:179` / `OrbitalApp.tsx:222`.
- **Actions:** `approveCommand` / `rejectCommand` (`useOrbitalData.ts:1803/1840`) and the existing pane-input path. No new routes.
- **Live updates:** existing WS frames (`terminals_updated`, `pane_status`, `approval_pending`, `action_pending`) already drive the stations; Fleet View inherits real-time updates for free.

**Seams a frontend engineer would touch** (non-binding, for orientation): `src/orbital/views/Line.tsx` (the board + scope), `src/orbital/station.ts` (any new fleet-card-derived fields), `src/orbital/OrbitalApp.tsx` (counters + toggle wiring), and a new `FleetCard` component (parallel to the existing station card / `Pass.tsx` `AttentionRow`).

---

## 8. 🎨 Open design decisions to iterate in Claude Design

These are the genuine forks — bring options to Claude Design and pick visually:

1. **Layout: flat urgency vs grouped-by-project.** *(Rec: flat by default, "group by project" toggle.)* Flat answers "what needs me, anywhere"; grouped answers "how is each repo doing." Could support both as a lens switch.
2. **Card density / richness.** Compact (status + name + project + actions + 1-line peek) vs rich (add context meter, mode/posture chips, larger output peek). Drives how many agents fit on screen. *(Rec: compact default, expand-on-hover.)*
3. **Scale behavior at 20–40+ panes.** Always-visible Needs-You/Errored band + collapsible Running/Idle? Density toggle (2-col / 3-col / compact)? Virtualized list? *(Rec: pin urgent, collapse calm tail.)*
4. **Toggle surfacing.** Segmented control vs nav item vs top row of the project list.
5. **Project tag treatment.** Color dot + emoji + name vs a colored left-border per card vs a project "swimlane" header (ties to #1).
6. **Whether to show fleet context/token totals.** Useful for budget awareness, but adds noise. *(Rec: a single fleet-wide context figure in the header, off by default.)*
7. **Quick-reply ergonomics.** Inline field on the card vs a popover vs jump-to-pane-with-cursor-ready.

---

## 9. Acceptance criteria (v1)

- [ ] An "All Projects" mode reachable from the project switcher; single-project remains the default.
- [ ] One grid shows panes from **every local project**, urgency-sorted, each tagged with its project.
- [ ] Header counters are **fleet-wide** (total / needs-you / running).
- [ ] A pending approval can be **approved or denied from its fleet card** (existing route), with countdown + optimistic update + toast.
- [ ] An agent awaiting input can be **answered with a one-line quick reply** from its card.
- [ ] `Jump-to-pane` from any card switches to that project and focuses the pane.
- [ ] Cards re-sort in real time as statuses change; no polling added.
- [ ] Frozen/STOP-ALL correctly gates act-in-place controls.
- [ ] No new server endpoints, no new gating logic.

---

## 10. v2 / later

- Remote / cross-machine fleet (cross-instance sync).
- Saved fleet filters/segments (e.g. "only errored", "only Project B + C").
- The full live-terminal "video wall" (revisit the D7 text-peek-vs-xterm trade-off if perf allows).
