/**
 * DaemonStateBadge — a subtle nav badge that appears when the approval daemon has dropped to
 * FALLBACK mode (inc2 task 2.1 / A-1a).
 *
 * Renders ONLY when state === "fallback"; returns null when state === "python" or null (unknown /
 * not yet received). No earcon, no narration — the operator sees degraded state at a glance from
 * the header without any audio interruption.
 *
 * Styled to match the kitchen-status pill (same pill shape, same INK border / shadow system)
 * while deliberately using a muted amber-warning palette so it reads as advisory, not critical.
 */

import { INK } from "../orbital/theme";

export type DaemonState = "python" | "fallback" | null;

interface DaemonStateBadgeProps {
  /** The latest daemon_state received from the WS stream (null = not yet received). */
  state: DaemonState;
}

/**
 * A small status badge that appears in the nav only when the Python approval daemon has fallen
 * back to the built-in TS approver. Invisible in normal ("python") operation.
 */
export function DaemonStateBadge({ state }: DaemonStateBadgeProps) {
  if (state !== "fallback") return null;
  return (
    <div
      data-testid="daemon-state-badge"
      title="The Python approval daemon is unavailable — running in built-in fallback mode."
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        background: "#fff4de",
        color: INK,
        padding: "6px 12px",
        borderRadius: 999,
        border: "2px solid " + INK,
        boxShadow: "2px 2px 0 0 " + INK,
        flexShrink: 0,
        fontFamily: "DM Sans",
        fontWeight: 800,
        fontSize: 12,
        whiteSpace: "nowrap",
      }}
    >
      {/* amber dot — advisory, not critical */}
      <span
        data-testid="daemon-state-badge-dot"
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: "#f59e0b",
          border: "1.5px solid " + INK,
          flexShrink: 0,
        }}
      />
      Approver fallback
    </div>
  );
}
