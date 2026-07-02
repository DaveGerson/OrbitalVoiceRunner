/**
 * src/lifecycleLock.ts — wsm-e2e-pinned-kcc0: a minimal per-pane async mutex.
 *
 * WHY: restart (respawn_pane) vs archive (stopAndArchivePane) today coordinate only BY CONVENTION —
 * manager.terminals as the shared ownership slot, UniversalTerminal's own `_stopping` promise
 * (idempotent re-entrant stop()), and the kdtu archivingPanes intent-flag. That convention already
 * closes the archive-vs-restart ghost-respawn race (bead kdtu — see src/terminal.ts stopAndArchivePane
 * + src/actions/defs/panes_rest.ts's respawn continuation). What it does NOT close: two overlapping
 * respawn_pane calls on the SAME pane both resume past the shared `await term.stop()` and both call
 * `term.start()`. UniversalTerminal.start() is self-defending (3P.3 — it kills any stale transport
 * before spawning), so a double-start never leaves two LIVE PTYs, but it is wasteful (spawn-then-
 * immediately-kill) and racy in a subtler way: start() flips `sessionIsFresh` to false as a SIDE
 * EFFECT, so the second overlapping start() launches with `--resume` instead of `--session-id` —
 * whichever call's start() runs last "wins" the live transport, and that choice is a data race, not a
 * decision. This module makes pane lifecycle MUTATIONS serialize per pane id, so overlapping
 * respawn/archive calls on ONE pane run one-at-a-time instead of interleaving.
 *
 * DESIGN (the load-bearing property): `withPaneLifecycleLock` runs `fn` SYNCHRONOUSLY, in the SAME
 * tick as the call, whenever the pane's lock is uncontended — it does NOT insert a microtask hop via
 * `.then()` on the free-lock path. This matters because bead kdtu's fix depends on a synchronous-tick
 * property (see src/terminal.ts stopAndArchivePane: `archivingPanes.add(paneId)` runs BEFORE any
 * await, and the respawn continuation's ownership+archivingPanes re-check runs in the SAME tick its
 * `await term.stop()` resolves, with no await in between). Every existing pinned test exercises the
 * lock UNCONTENDED (a single lifecycle op per pane in flight), so this scheduling choice reproduces
 * today's exact timing byte-for-byte on that path while still fully serializing the CONTENDED path
 * (two overlapping ops on the same pane), where `fn` is queued behind the in-flight one via `.then()`.
 *
 * No external deps. Unlocked in a `finally` (a throwing/rejecting `fn` still releases). The queue never
 * grows unbounded: each pane holds at most ONE pending tail promise at a time (a second caller replaces
 * the map entry with ITS OWN tail, chained after the first — not appended to a list), and the map entry
 * is deleted once the tail settles (bounded to the number of PANES with lifecycle ops in flight, not the
 * number of calls ever made).
 */

// One pending "tail" promise per pane id — present only while a lifecycle op is in flight or queued.
const paneLocks = new Map<string, Promise<unknown>>();

/**
 * Serialize `fn` against any other `withPaneLifecycleLock` call for the SAME `paneId`. Calls for
 * DIFFERENT pane ids never wait on each other (the mutex is keyed, not global).
 *
 * - Uncontended (no lifecycle op currently in flight for this pane): `fn` runs IMMEDIATELY,
 *   synchronously in this tick (see the module doc for why this matters).
 * - Contended (an op for this pane is in flight): `fn` runs only after the prior op's promise
 *   SETTLES (resolved OR rejected — a failed prior op must not wedge the pane's lock forever).
 *
 * Releases (removes this pane from the lock map) once `fn`'s promise settles — but only if no LATER
 * caller has since taken the pane's tail slot, so a chain of queued callers unwinds correctly.
 */
export function withPaneLifecycleLock<T>(paneId: string, fn: () => Promise<T>): Promise<T> {
  const prior = paneLocks.get(paneId);
  // Uncontended: invoke fn() synchronously (no `.then()` indirection) so a caller whose first await
  // lives inside fn fires on the SAME tick it would have without this lock. Contended: queue behind
  // the prior op, regardless of whether IT resolved or rejected (`fn` still gets its turn — a failed
  // prior op must not wedge the pane's lock forever).
  const result: Promise<T> = prior ? prior.then(fn, fn) : fn();
  paneLocks.set(paneId, result as Promise<unknown>);
  // Release (clear the pane's slot) the INSTANT this call settles — attached here, BEFORE `result` is
  // handed back to the caller, so this handler is registered (and therefore runs) before any handler
  // the caller attaches via `await`/`.then()` on the same `result` (Promise callbacks on one promise
  // fire in registration order). That ordering is what makes the "released promptly" test below hold:
  // a caller that `await`s this call sees the pane already unlocked by the time it resumes. Only clear
  // the slot if nobody has since queued a NEWER call behind this one (`paneLocks.get(paneId) ===
  // result` — a later caller already replaced the map entry with ITS OWN result).
  const release = (): void => { if (paneLocks.get(paneId) === result) paneLocks.delete(paneId); };
  result.then(release, release);
  return result;
}
