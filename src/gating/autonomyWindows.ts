/**
 * src/gating/autonomyWindows.ts — the PURE state surface for f09.2 timed autonomy windows.
 *
 * A window is a bounded, auto-reverting grant of FULL AUTO on ONE pane's productive capabilities
 * (see src/types.ts AutonomyWindow). This module owns ONLY the in-memory bookkeeping + the
 * (de)serialization to a settings_kv string — it does NO I/O, NO audit, NO broadcast, and reads NO
 * clock of its own (every liveness/expiry check takes an explicit `now`). That keeps it:
 *   - pure + directly unit-testable (no Date.now, no store), and
 *   - a CLEAN, exported surface f09.3 (posture profiles) layers on without reaching into gating.
 *
 * SAFETY POSTURE (the crown jewels): this module never DECIDES a gate — it only reports whether a
 * window is live for (pane, capability). The Ask→Auto overlay + the fail-closed ordering
 * (window BEFORE frozen short-circuit) live in the synchronous gate choke-point (gating/index.ts)
 * via the pure applyAutonomyWindow helper. Windows NEVER survive a restart: the store starts EMPTY
 * and the boot path revokes any persisted rows (gating/index.ts), so nothing here rehydrates as live.
 */

import type { AutonomyWindow, CapabilityGate } from "../types";

/** Default window length when the operator names no duration. */
export const DEFAULT_AUTONOMY_MINUTES = 20;
/** Hard clamp bounds (server-side) for a requested window duration. */
export const MIN_AUTONOMY_MINUTES = 1;
export const MAX_AUTONOMY_MINUTES = 120;
/** How far before expiry the ONE spoken last-call warning fires (~2 min). */
export const AUTONOMY_WARN_LEAD_MS = 2 * 60 * 1000;
/** The settings_kv key the persisted (boot-revoked) window array lives under. */
export const AUTONOMY_WINDOWS_KV = "autonomy_windows";

/**
 * The capabilities a window loosens by default — the PRODUCTIVE writes (the same set the spotlight
 * is allowed to loosen on the active pane). Destructive / meta / spawn capabilities are deliberately
 * NOT here: a window makes an agent run its own productive work unattended, it does not hand it the
 * keys to delete panes or change the locks.
 */
export const DEFAULT_AUTONOMY_CAPABILITIES: readonly CapabilityGate[] = ["write_to_pane", "deliver_handoff"];

/**
 * The ONLY capabilities a window may loosen — the productive writes. A window makes an agent run its
 * own productive work unattended; it must NEVER cover a META (set_capability_gate / set_*_permissions)
 * or DESTRUCTIVE (delete_pane / close_pane / execute_plan) capability. Otherwise a granted window that
 * covers set_capability_gate would resolve that meta gate to Auto, so every subsequent voice
 * grant_autonomy_window would return disposition 'run' and apply SILENTLY — perpetual self-renewal
 * with arbitrary capability widening (Wave-7 blocker). Deliberately identical to the default set (the
 * productive writes); kept as a named allowlist so the intent — and any future divergence — is explicit.
 */
export const WINDOW_ELIGIBLE_CAPABILITIES: readonly CapabilityGate[] = DEFAULT_AUTONOMY_CAPABILITIES;

/**
 * Sanitize a requested window capability set to the productive-write allowlist
 * (WINDOW_ELIGIBLE_CAPABILITIES): drop any META / DESTRUCTIVE / unknown capability so a window can
 * NEVER be opened over the control surface or a destructive verb. An omitted or all-ineligible request
 * falls back to the default productive set (a window always covers SOMETHING productive, never nothing
 * meta). Pure; the single choke point both the action def and the gating mutator route through.
 */
export function sanitizeAutonomyCapabilities(caps: readonly string[] | null | undefined): CapabilityGate[] {
  const allow = new Set<string>(WINDOW_ELIGIBLE_CAPABILITIES);
  const filtered = (caps ?? []).filter((c) => allow.has(c)) as CapabilityGate[];
  return filtered.length ? filtered : [...DEFAULT_AUTONOMY_CAPABILITIES];
}

/**
 * Clamp a requested duration to [MIN, MAX] minutes. A missing / non-finite value defaults to
 * DEFAULT_AUTONOMY_MINUTES; 0 / negative clamp UP to MIN; anything over MAX clamps DOWN to MAX.
 * Fractional minutes are floored (a whole-minute window). Pure.
 */
export function clampAutonomyMinutes(minutes: number | undefined | null): number {
  const n = typeof minutes === "number" && Number.isFinite(minutes) ? Math.floor(minutes) : DEFAULT_AUTONOMY_MINUTES;
  if (n < MIN_AUTONOMY_MINUTES) return MIN_AUTONOMY_MINUTES;
  if (n > MAX_AUTONOMY_MINUTES) return MAX_AUTONOMY_MINUTES;
  return n;
}

/** Structural guard for a deserialized window row (a corrupt/partial KV row is dropped, never trusted). */
function isAutonomyWindowShape(v: unknown): v is AutonomyWindow {
  if (!v || typeof v !== "object") return false;
  const w = v as Record<string, unknown>;
  return typeof w.id === "string"
    && typeof w.pane_id === "string"
    && Array.isArray(w.capabilities)
    && typeof w.granted_at === "number"
    && typeof w.expires_at === "number";
}

/**
 * Parse the persisted settings_kv window array. Tolerant: a null/empty/corrupt value yields [] (the
 * boot path only uses this to enumerate rows for the revoke-audit, never to rehydrate live state).
 */
export function deserializeAutonomyWindows(raw: string | null | undefined): AutonomyWindow[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAutonomyWindowShape);
  } catch {
    return [];
  }
}

/**
 * The in-memory autonomy-window store: at most ONE live window per pane (a new grant replaces the
 * prior one). A Map (not a plain object) so a pane id equal to an Object.prototype member name can
 * never collide with an inherited property (the prototype-leak class the gating resolver guards).
 */
export class AutonomyWindowStore {
  private byPane = new Map<string, AutonomyWindow>();
  private seq = 0;

  /** Open (or replace) the window on `paneId`; returns the created record. Duration is caller-clamped. */
  grant(paneId: string, capabilities: readonly CapabilityGate[], now: number, durationMs: number): AutonomyWindow {
    const w: AutonomyWindow = {
      id: `aw_${now}_${this.seq++}`,
      pane_id: paneId,
      capabilities: [...capabilities],
      granted_at: now,
      expires_at: now + durationMs,
    };
    this.byPane.set(paneId, w);
    return w;
  }

  /** Remove the window on `paneId` (if any); returns the removed record or null. */
  end(paneId: string): AutonomyWindow | null {
    const w = this.byPane.get(paneId) ?? null;
    if (w) this.byPane.delete(paneId);
    return w;
  }

  /**
   * The window on `paneId` IFF it is still live at `now` (lazy expiry — an expired window reports
   * null WITHOUT being mutated, so a dead sweep timer can never keep a pane hot). Does not delete.
   */
  liveWindowFor(paneId: string, now: number): AutonomyWindow | null {
    const w = this.byPane.get(paneId);
    if (!w) return null;
    return now < w.expires_at ? w : null;
  }

  /** True IFF a LIVE window on `paneId` covers `capability` at `now`. The gate resolver's hot check. */
  isCapabilityLive(paneId: string, capability: string, now: number): boolean {
    const w = this.liveWindowFor(paneId, now);
    return !!w && w.capabilities.includes(capability as CapabilityGate);
  }

  /** Every stored window (live or not) — the sweep iterates this to warn/expire. */
  all(): AutonomyWindow[] {
    return [...this.byPane.values()];
  }

  /** Serialize the current windows for settings_kv persistence. */
  serialize(): string {
    return JSON.stringify(this.all());
  }
}
