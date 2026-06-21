/**
 * src/dispatch/joinTracker.ts — dispatch-group JOIN bookkeeping (journey-expansion fan-out kernel).
 *
 * `dispatch_to_panes` sends ONE instruction to N panes (each write individually gated by the
 * existing dispatch engine). This module tracks the group so the operator gets ONE "all done"
 * signal instead of N separate completions. PURE bookkeeping: no I/O, no timers, no broadcast —
 * src/observe/index.ts feeds it pane edges and fans out the completion it returns.
 *
 * Member lifecycle:
 *   staged  — the write is parked as a pending approval (HiTL / forceStage); flips to running
 *             on the pane's next genuine Running edge (the approval was confirmed + dispatched).
 *   running — the write landed; flips on the pane's terminal transitions:
 *             idle -> done, error/build-failed -> error, exited -> error.
 *   done / blocked / error — settled.
 *
 * A group COMPLETES the moment no member is staged/running. Settled-at-dispatch groups (every
 * write blocked) complete immediately — the dispatch handler reports that synchronously and no
 * join fires. Records are IN-MEMORY (session-scoped coordination, like the pre-WS-F approval map);
 * a bounded ring keeps the registry small. Durable dispatch history is the action_log's job.
 */

export type DispatchMemberStatus = "staged" | "running" | "done" | "blocked" | "error";

export interface DispatchMember {
  paneId: string;
  status: DispatchMemberStatus;
  detail?: string;
}

export interface DispatchGroup {
  id: string;
  name: string;
  instruction: string;
  createdAt: number;
  members: DispatchMember[];
  completed: boolean;
  completedAt?: number;
}

const MAX_GROUPS = 50;

export class DispatchJoinTracker {
  private groups: DispatchGroup[] = [];
  private seq = 0;

  create(name: string, instruction: string, paneIds: string[], now: number = Date.now()): DispatchGroup {
    const group: DispatchGroup = {
      id: `dispatch_${now.toString(36)}_${(this.seq++).toString(36)}`,
      name,
      instruction,
      createdAt: now,
      members: paneIds.map((paneId) => ({ paneId, status: "staged" as const })),
      completed: false,
    };
    this.groups.push(group);
    if (this.groups.length > MAX_GROUPS) this.groups.splice(0, this.groups.length - MAX_GROUPS);
    return group;
  }

  get(id: string): DispatchGroup | undefined {
    return this.groups.find((g) => g.id === id);
  }

  list(): DispatchGroup[] {
    return [...this.groups];
  }

  /** Stamp a member's dispatch-time outcome (executed -> running, pending -> staged, …). */
  recordOutcome(groupId: string, paneId: string, status: DispatchMemberStatus, detail?: string): void {
    const m = this.get(groupId)?.members.find((x) => x.paneId === paneId);
    if (!m) return;
    m.status = status;
    if (detail !== undefined) m.detail = detail;
  }

  /** A pane started Running: confirmed staged members on that pane are now in flight. */
  noteRunning(paneId: string): void {
    for (const g of this.groups) {
      if (g.completed) continue;
      for (const m of g.members) {
        if (m.paneId === paneId && m.status === "staged") m.status = "running";
      }
    }
  }

  /**
   * A pane hit a terminal transition. Settle matching in-flight members and return every group
   * this edge NEWLY completed (the caller announces those — once each).
   */
  noteTransition(
    paneId: string,
    transition: "idle" | "prompt" | "error" | "build-failed" | "exited",
    now: number = Date.now()
  ): DispatchGroup[] {
    if (transition === "prompt") return []; // awaiting input is not a settle edge
    const settled: DispatchMemberStatus = transition === "idle" ? "done" : "error";
    const newlyCompleted: DispatchGroup[] = [];
    for (const g of this.groups) {
      if (g.completed) continue;
      const touched = this.settleGroupMembers(g, paneId, transition, settled);
      if (touched && this.settledAtDispatch(g)) {
        g.completed = true;
        g.completedAt = now;
        newlyCompleted.push(g);
      }
    }
    return newlyCompleted;
  }

  /**
   * Settle every running member of `group` on `paneId` to `settled` (error members also get the
   * pane-edge detail). Returns whether any member was touched. Verbatim extraction of the inner
   * settle loop from noteTransition — semantics IDENTICAL (including the `every` completion check,
   * which settledAtDispatch already expresses).
   */
  private settleGroupMembers(
    group: DispatchGroup,
    paneId: string,
    transition: "idle" | "error" | "build-failed" | "exited",
    settled: DispatchMemberStatus
  ): boolean {
    let touched = false;
    for (const m of group.members) {
      if (m.paneId === paneId && m.status === "running") {
        m.status = settled;
        if (settled === "error") m.detail = `pane ${transition}`;
        touched = true;
      }
    }
    return touched;
  }

  /** True when the group settled entirely at dispatch time (nothing staged/running to join on). */
  settledAtDispatch(group: DispatchGroup): boolean {
    return group.members.every((m) => m.status !== "staged" && m.status !== "running");
  }
}

/**
 * The process-wide tracker instance. Both writers live OUTSIDE the connection scope (the action
 * def registers groups; observe settles them), so a plain module singleton — same pattern as the
 * announcement/pane-signal buses being shared server-lifetime collaborators — is the honest shape.
 */
export const dispatchJoinTracker = new DispatchJoinTracker();
