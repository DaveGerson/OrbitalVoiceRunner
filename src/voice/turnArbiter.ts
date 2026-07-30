// src/voice/turnArbiter.ts -- the TURN ARBITER (conversation scheduler), Wave 1: pure decision core.
//
// Spec: docs/superpowers/specs/2026-07-29-turn-arbiter-design.md section 3.1-3.2, section 4-W1,
// section 5-T1/T2. One module owns the TIMING decision for every model-bound spoken turn (not its
// transport -- a caller still holds the live session and performs the actual send; this module only
// decides whether/what/how to speak). PURE + synchronous: no I/O, no scheduled callbacks of its own,
// no wall-clock reads -- the caller supplies `now` on every evaluate() call (LOCKED seam: turn-timing
// decisions stay in-process TS, never a Python round-trip near ackState()). Wave 1 ships the core +
// the delivery-mode matrix (D4) with ZERO call-site re-routes -- later waves wire producers through
// submit().
//
// Priority classes (lower = more severe, drains first): 0 corrections; 1 operator-response (exempt,
// never queued); 2 deadline narrations; 3 completions; 4 acks; 5 passive context.
//
// Standing invariant this module exists to guarantee: "told-more beats silently-missed" -- every
// submit() eventually surfaces in exactly one drain digest (or an interrupt), never silently dropped.

export type DeliveryMode = "forced-turn" | "steered-digest" | "passive-context";

/** D1 -- while the operator holds the floor, a class-2 deadline pauses, up to this extension. */
export const TTL_FLOOR_EXTENSION_CAP_MS = 60_000;

/** Classes that carry a settings dial. Class 1 (operator-response) is always immediate -- undialed. */
const DIALABLE_CLASSES = [0, 2, 3, 4, 5] as const;
type DialableClass = (typeof DIALABLE_CLASSES)[number];

/** D4 floor: these classes may never be configured passive-context (minimum steered-digest). */
const FLOOR_CLASSES = new Set<DialableClass>([0, 2]);

const VALID_MODES = new Set<DeliveryMode>(["forced-turn", "steered-digest", "passive-context"]);

/** D4 defaults: 0/2 forced-turn (must-voice), 3/4 steered-digest, 5 passive-context. */
export const DEFAULT_DELIVERY_MATRIX: Record<DialableClass, DeliveryMode> = {
  0: "forced-turn",
  2: "forced-turn",
  3: "steered-digest",
  4: "steered-digest",
  5: "passive-context",
};

export type DeliveryMatrix = Record<DialableClass, DeliveryMode>;

export interface NormalizeMatrixResult {
  matrix: DeliveryMatrix;
  violations: string[];
}

/**
 * Resolve one class's raw dial value into a valid mode, in order: the "no silent value exists"
 * fallback (invalid/unrecognized input -> the class default) then the D4 floor clamp (an otherwise-
 * valid but under-floor passive-context on classes 0/2 -> steered-digest). A clean, in-floor value
 * passes through untouched. Any correction appends a human-readable violation.
 */
function resolveClassMode(cls: DialableClass, raw: unknown, violations: string[]): DeliveryMode {
  if (!VALID_MODES.has(raw as DeliveryMode)) {
    violations.push(`class ${cls} dialed to invalid value ${JSON.stringify(raw)} -- falling back to the default`);
    return DEFAULT_DELIVERY_MATRIX[cls];
  }
  const mode = raw as DeliveryMode;
  if (FLOOR_CLASSES.has(cls) && mode === "passive-context") {
    violations.push(`class ${cls} cannot be passive-context (steered-digest floor) -- clamped`);
    return "steered-digest";
  }
  return mode;
}

/**
 * normalizeDeliveryMatrix -- the settings-boundary validator (D4), and the source of truth
 * createTurnArbiter re-runs internally so an unvalidated matrix can never reach the core (defense in
 * depth). Pure: `raw` is never mutated. Absent/undefined input -> the defaults, zero violations.
 * Class 1 has no dial: any attempt to configure it is stripped from the result and reported.
 */
export function normalizeDeliveryMatrix(raw: unknown): NormalizeMatrixResult {
  const violations: string[] = [];
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const matrix = { ...DEFAULT_DELIVERY_MATRIX };

  if (Object.prototype.hasOwnProperty.call(src, "1")) {
    violations.push("class 1 (operator-response) is always immediate -- dial ignored");
  }
  for (const cls of DIALABLE_CLASSES) {
    if (!Object.prototype.hasOwnProperty.call(src, String(cls))) continue;
    matrix[cls] = resolveClassMode(cls, src[String(cls)], violations);
  }
  return { matrix, violations };
}

// -- The decision core ------------------------------------------------------------------------

export interface SubmitItem {
  /** Structured, already-redacted narration facts (NOT a scripted sentence -- D3 prompt-steered). */
  facts: string;
  cls: 0 | 1 | 2 | 3 | 4 | 5;
  paneId?: string;
  /** Items sharing a key coalesce ("pane-completion", "last-call:<approvalId>"). */
  coalesceKey?: string;
  /** Class-2 only: the TTL this item is honest about (D1). */
  deadline?: { expiresAt: number; onExpirySwap: string };
  /** Wave-2: optional within-class severity rank (lower = more severe -- e.g. vc-D ranks an
   *  `exception` correction ahead of an `info` one even when it arrives later). Absent -> every
   *  item in the class ties, so insertion order (FIFO) stays the sole tiebreaker -- an additive
   *  refinement that never changes behavior for a producer that doesn't set it. */
  severityRank?: number;
}

export interface DigestItem {
  facts: string;
  cls: number;
  paneId?: string;
  coalesceKey?: string;
  /** D2 told-more floor: every TAIL item is flagged so the visual stack/catch-up never misses it. */
  forVisualStack: boolean;
}

export interface TailGroup {
  coalesceKey?: string;
  count: number;
}

export interface Digest {
  /** The single highest-class (lowest cls number) item, spoken in full. */
  headline: DigestItem;
  /** Severity-ordered (cls ascending, FIFO within a class), post-coalescing. */
  tail: DigestItem[];
  tailCount: number;
  /** coalesceKey-grouped summary of the tail ("three panes finished") -- partitions tailCount. */
  tailGroups: TailGroup[];
}

export type DrainDecision =
  | { action: "hold" }
  | { action: "drain"; digest: Digest; mode: DeliveryMode }
  | { action: "interrupt-at-phrase-boundary"; digest: Digest };

export interface EvaluateCtx {
  now: number;
  floorHeld: boolean;
  turnClear: boolean;
}

export interface TurnArbiter {
  submit(item: SubmitItem): void;
  evaluate(ctx: EvaluateCtx): DrainDecision;
  /** The gating sweep consults this per last-call coalesceKey before expiring it (D1). */
  floorPausedMs(coalesceKey: string): number;
  /** D4 (fikj.12): live re-dial. Re-normalizes `raw` (the SAME floor clamp + fallback as
   *  construction — defense in depth) and swaps the ACTIVE matrix in place: already-queued items
   *  drain under the new modes, nothing is dropped or reconstructed. Violations are returned for
   *  the settings boundary to surface. */
  updateMatrix(raw: unknown): NormalizeMatrixResult;
}

/** Internal queued representation. Class-1 items never reach here (see submit()). */
interface QueuedItem {
  key: string;
  facts: string;
  cls: SubmitItem["cls"];
  paneId?: string;
  coalesceKey?: string;
  deadline?: { expiresAt: number; onExpirySwap: string };
  severityRank?: number;
  insertionOrder: number;
  /** Accumulated floor-held pause for this item's deadline, capped at TTL_FLOOR_EXTENSION_CAP_MS. */
  pausedMs: number;
  /** The `now` this item was last ticked at; null until its first evaluate() observation. */
  lastTick: number | null;
}

function toDigestItem(it: QueuedItem, forVisualStack: boolean): DigestItem {
  return { facts: it.facts, cls: it.cls, paneId: it.paneId, coalesceKey: it.coalesceKey, forVisualStack };
}

/** Groups the tail by coalesceKey; an item without one is its own solo group. Always partitions tail. */
function buildTailGroups(tail: DigestItem[]): TailGroup[] {
  const groups = new Map<string, TailGroup>();
  const order: string[] = [];
  let solo = 0;
  for (const it of tail) {
    const groupKey = it.coalesceKey ?? `solo-${solo++}`;
    const existing = groups.get(groupKey);
    if (existing) {
      existing.count += 1;
    } else {
      groups.set(groupKey, { coalesceKey: it.coalesceKey, count: 1 });
      order.push(groupKey);
    }
  }
  return order.map((k) => groups.get(k)!);
}

/** Same (coalesceKey, paneId) -> the same identity (latest-wins). No coalesceKey -> always distinct. */
function identityKey(coalesceKey: string | undefined, paneId: string | undefined, autoSeq: number): string {
  if (coalesceKey === undefined) return `auto-${autoSeq}`;
  return `key-${coalesceKey}--pane-${paneId ?? ""}`;
}

/** The facts a class-2 item speaks at drain time: swapped to the honest expiry notice once its
 *  floor-extended deadline has genuinely passed (D1 TTL honesty). Untouched otherwise. */
function factsForDrain(it: QueuedItem, now: number): string {
  if (it.cls === 2 && it.deadline && now >= it.deadline.expiresAt + it.pausedMs) {
    return it.deadline.onExpirySwap;
  }
  return it.facts;
}

/**
 * createTurnArbiter -- the Wave-1 decision surface. `opts.matrix` is re-normalized here (defense in
 * depth per D4) so a raw/hostile matrix can never leak an under-floor or silent mode into the core.
 */
export function createTurnArbiter(opts?: { matrix?: unknown }): TurnArbiter {
  const { matrix } = normalizeDeliveryMatrix(opts?.matrix);
  const queue = new Map<string, QueuedItem>();
  const immediate: QueuedItem[] = [];
  const lastKnownPausedMs = new Map<string, number>();
  let seq = 0;

  function submit(item: SubmitItem): void {
    if (item.cls === 1) {
      // Class 1 (operator-response) is exempt: never queued, delivered on the very next evaluate().
      immediate.push({
        key: `imm-${seq++}`,
        facts: item.facts,
        cls: item.cls,
        paneId: item.paneId,
        coalesceKey: item.coalesceKey,
        insertionOrder: 0,
        pausedMs: 0,
        lastTick: null,
      });
      return;
    }
    const key = identityKey(item.coalesceKey, item.paneId, seq);
    const existing = queue.get(key);
    const insertionOrder = existing ? existing.insertionOrder : seq;
    // Coalescing: latest-wins content, but the pause clock keeps tracking the SAME identity -- a
    // resubmitted last-call is a re-fired display of one deadline, not a fresh one.
    const pausedMs = existing ? existing.pausedMs : 0;
    const lastTick = existing ? existing.lastTick : null;
    seq += 1;
    queue.set(key, {
      key,
      facts: item.facts,
      cls: item.cls,
      paneId: item.paneId,
      coalesceKey: item.coalesceKey,
      deadline: item.deadline,
      severityRank: item.severityRank,
      insertionOrder,
      pausedMs,
      lastTick,
    });
  }

  /** Advances one item's pause clock by the elapsed span since its last observation, crediting the
   *  span only while floorHeld (D1). First observation just sets the baseline (no pause change). */
  function advancePause(it: QueuedItem, now: number, floorHeld: boolean): void {
    if (it.lastTick === null) {
      it.lastTick = now;
      return;
    }
    const dt = now - it.lastTick;
    if (floorHeld && dt > 0) {
      it.pausedMs = Math.min(TTL_FLOOR_EXTENSION_CAP_MS, it.pausedMs + dt);
    }
    it.lastTick = now;
  }

  /** Ticks one class-2 deadline item and reports whether it has become an interrupt candidate:
   *  extension fully consumed AND the (floor-extended) deadline reached while STILL floor-held. */
  function tickOne(it: QueuedItem, now: number, floorHeld: boolean): boolean {
    advancePause(it, now, floorHeld);
    if (it.coalesceKey !== undefined) lastKnownPausedMs.set(it.coalesceKey, it.pausedMs);
    const effectiveExpiry = it.deadline!.expiresAt + it.pausedMs;
    return floorHeld && now >= effectiveExpiry;
  }

  /**
   * Advances every queued class-2 deadline's pause clock (D1). Returns the (at most one) item that
   * has become an interrupt-at-phrase-boundary candidate this tick, or null.
   */
  function tickDeadlines(now: number, floorHeld: boolean): QueuedItem | null {
    let interruptCandidate: QueuedItem | null = null;
    for (const it of queue.values()) {
      if (it.cls !== 2 || !it.deadline) continue;
      if (tickOne(it, now, floorHeld) && interruptCandidate === null) {
        interruptCandidate = it;
      }
    }
    return interruptCandidate;
  }

  function buildImmediateDrain(): DrainDecision {
    const items = immediate.splice(0, immediate.length);
    const [headlineItem, ...tailItems] = items;
    const headline = toDigestItem(headlineItem, false);
    const tail = tailItems.map((it) => toDigestItem(it, true));
    return {
      action: "drain",
      digest: { headline, tail, tailCount: tail.length, tailGroups: buildTailGroups(tail) },
      mode: "forced-turn",
    };
  }

  function buildQueueDrain(now: number): DrainDecision {
    const resolved = [...queue.values()]
      .map((it) => ({ ...it, facts: factsForDrain(it, now) }))
      .sort((a, b) => a.cls - b.cls || (a.severityRank ?? 0) - (b.severityRank ?? 0) || a.insertionOrder - b.insertionOrder);
    queue.clear();
    const [headlineItem, ...tailItems] = resolved;
    const headline = toDigestItem(headlineItem, false);
    const tail = tailItems.map((it) => toDigestItem(it, true));
    const mode = matrix[headlineItem.cls as DialableClass] ?? "steered-digest";
    return {
      action: "drain",
      digest: { headline, tail, tailCount: tail.length, tailGroups: buildTailGroups(tail) },
      mode,
    };
  }

  function evaluate(ctx: EvaluateCtx): DrainDecision {
    const { now, floorHeld, turnClear } = ctx;
    const interruptCandidate = tickDeadlines(now, floorHeld);
    if (interruptCandidate) {
      queue.delete(interruptCandidate.key);
      const headline = toDigestItem(interruptCandidate, false);
      return { action: "interrupt-at-phrase-boundary", digest: { headline, tail: [], tailCount: 0, tailGroups: [] } };
    }
    if (immediate.length > 0) return buildImmediateDrain();
    if (!turnClear || queue.size === 0) return { action: "hold" };
    return buildQueueDrain(now);
  }

  function floorPausedMs(coalesceKey: string): number {
    return lastKnownPausedMs.get(coalesceKey) ?? 0;
  }

  function updateMatrix(raw: unknown): NormalizeMatrixResult {
    const result = normalizeDeliveryMatrix(raw);
    // Swap IN PLACE: buildQueueDrain closed over `matrix` by reference, so mutating the same
    // object re-dials every future drain without touching the queue (never-drop invariant).
    Object.assign(matrix, result.matrix);
    return result;
  }

  return { submit, evaluate, floorPausedMs, updateMatrix };
}
