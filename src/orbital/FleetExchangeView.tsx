// ── ORBITAL · FleetExchangeView ─────────────────────────────────────────
// Phase 5, Step 5.1 — evolving the all-project Fleet View ("All kitchens", Line.tsx) into a
// communication-by-exception surface: a compact, always-on-top lane naming exactly the panes that
// need the operator RIGHT NOW (needs-input / held approvals / failed / interrupted), each with
// act-in-place quick actions that route through the SAME canonical dispatchers voice/the rest of
// the board already use — no new effect paths. Reuses station.ts's Station + the existing
// exchangeByPane (3.3) and pendingCommands, additively enhanced by the optional per-pane
// FleetExchangeSummary projection (fleetProjection.ts / GET /api/fleet/exchange-summary) — absent
// entirely, everything still orders correctly off plain Station status (see fleetExchangeOrdering.ts).
//
// ZERO VISUAL DELTA: renders `null` whenever there is nothing exceptional across the fleet (no
// needs-input, no held approval, no failed/exited pane) — the SAME "nothing to see" state as
// before this component existed, so a quiet fleet looks byte-identical to today's board.
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { INK } from "./theme";
import { Chip, PostureChip, Pips } from "./primitives";
import { formatElapsed } from "./station";
import type { Station } from "./station";
import type { AttentionItem, ExchangeDraftView, FleetExchangeSummary, PendingCommand } from "../types";
import { attentionResolveTarget } from "./useOrbitalDataHelpers";
import {
  attentionApprovalsByPane, buildFleetRows, computeFleetCounters, sortFleetRows,
  type FleetRow, type FleetRowKind,
} from "./fleetExchangeOrdering";

const KIND_LABEL: Record<FleetRowKind, string> = {
  needs_input: "Needs your input",
  approval: "Awaiting your approval",
  failed: "Failed / exited",
  complete: "Finished",
  running: "Running",
  staged: "Staged",
  decision: "Idle",
};

const KIND_BG: Record<FleetRowKind, string> = {
  needs_input: "#ff8a3d", approval: "#ffd166", failed: "#e23a3a", complete: "#4db892",
  running: "#ffc94a", staged: "#c9a97a", decision: "#d4a15a",
};
const KIND_FG: Record<FleetRowKind, string> = {
  needs_input: INK, approval: INK, failed: "#fff4de", complete: INK, running: INK, staged: INK, decision: INK,
};

/** Pure: the fleet-wide "N agents · M need you · K running" header line. */
export function fleetCounterLine(counters: { total: number; needsYou: number; running: number }): string {
  return `${counters.total} agent${counters.total === 1 ? "" : "s"} · ${counters.needsYou} need${counters.needsYou === 1 ? "s" : ""} you · ${counters.running} running`;
}

export interface FleetExchangeViewProps {
  stations: Station[];
  /** Held approvals for the ACTIVE pane (the same array the blocking ApprovalDialog modal already
   *  renders from) — the rare fleet-wide case, kept for completeness. */
  pendingCommands: PendingCommand[];
  /** The attention inbox (bead e7h/8xn) — the COMMON fleet-wide source for a held approval on a
   *  BACKGROUND (non-active) pane, resolvable via the same `attentionResolveTarget` id-gate the
   *  inbox's own Approve/Deny already enforces. */
  attentionQueue?: AttentionItem[];
  /** Phase 3, Step 3.3's per-pane open instruction-envelope draft, keyed by pane id (additive). */
  exchangeByPane?: Record<string, ExchangeDraftView | null | undefined>;
  /** Phase 5.1's durable per-pane exchange projection, keyed by pane id (additive/optional). */
  exchangeSummaries?: Record<string, FleetExchangeSummary | undefined>;
  mutedProjectIds?: string[];
  dark: boolean;
  /** Injectable clock for deterministic age rendering in tests; defaults to Date.now(). */
  now?: number;
  /** Jump to this station's pane (the SAME open the board's own cards already fire) — also used
   *  for "Answer" (opens the composer/Workbench already living on that pane) and "Revise draft". */
  onOpen: (station: Station) => void;
  onApprove: (messageId: string) => void;
  onDeny: (messageId: string) => void;
  onRetry: (exchangeId: string) => void;
  onCancelExchange: (exchangeId: string) => void;
  onToggleMute: (projectId: string) => void;
}

function pendingCommandsByPane(commands: PendingCommand[]): Record<string, PendingCommand> {
  const map: Record<string, PendingCommand> = {};
  for (const c of commands) map[c.terminalId] = c;
  return map;
}

function FleetCardHeader({ row, muted, onToggleMute }: { row: FleetRow; muted: boolean; onToggleMute: () => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <Chip bg={KIND_BG[row.kind]} color={KIND_FG[row.kind]}>{KIND_LABEL[row.kind]}</Chip>
      <span style={{ fontFamily: "Fraunces, serif", fontWeight: 800, fontSize: 15, color: INK }}>{row.station.name}</span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontFamily: "DM Sans", fontSize: 12, fontWeight: 700, color: row.station.projectColor }}>
        <span aria-hidden style={{ width: 7, height: 7, borderRadius: 2, background: row.station.projectColor, border: "1.5px solid " + INK }} />
        {row.station.projectEmoji} {row.station.projectName}
      </span>
      <PostureChip posture={row.station.posture} mode={row.station.mode} />
      <Pips steps={8} done={row.station.contextPips} color={row.station.projectColor} label={row.station.contextLabel} />
      <div style={{ flex: 1 }} />
      <button
        data-testid="fleet-mute-toggle"
        aria-pressed={muted}
        onClick={onToggleMute}
        title={muted ? `Un-mute ${row.station.projectName}'s announcements` : `Mute ${row.station.projectName}'s announcements`}
        style={{
          padding: "3px 9px", borderRadius: 999, border: "1.5px solid " + INK, cursor: "pointer",
          background: muted ? "#8a6a4f" : "#fff4de", color: muted ? "#fff4de" : INK,
          fontFamily: "DM Sans", fontWeight: 700, fontSize: 12, whiteSpace: "nowrap",
        }}
      >
        {muted ? "🔇 Muted" : "🔔 Mute"}
      </button>
    </div>
  );
}

function FleetCardBody({ row, now }: { row: FleetRow; now: number }) {
  const age = row.updatedAt != null ? formatElapsed(Math.max(0, now - row.updatedAt)) : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 6 }}>
      {row.instructionSummary && (
        <div data-testid="fleet-card-instruction" style={{ fontFamily: "DM Sans", fontSize: 13, color: INK }}>
          {row.instructionSummary}
        </div>
      )}
      {row.waitingReason && (
        <div data-testid="fleet-card-waiting" style={{ fontFamily: "DM Sans", fontSize: 12, fontWeight: 700, color: "#a8151a" }}>
          Waiting: {row.waitingReason}
        </div>
      )}
      {row.lastResult && (
        <div data-testid="fleet-card-result" style={{ fontFamily: "DM Sans", fontSize: 12, color: "#2f7a5e" }}>
          Last result: {row.lastResult}
        </div>
      )}
      {age && <div data-testid="fleet-card-age" style={{ fontFamily: "JetBrains Mono", fontSize: 12, color: "#8a6a4f" }}>Age: {age}</div>}
    </div>
  );
}

function FleetCardActions({
  row, onOpen, onApprove, onDeny, onRetry, onCancelExchange,
}: {
  row: FleetRow;
  onOpen: () => void;
  onApprove: () => void;
  onDeny: () => void;
  onRetry: () => void;
  onCancelExchange: () => void;
}) {
  const btn = (testId: string, label: string, onClick: () => void, primary = false): ReactNode => (
    <button
      key={testId}
      data-testid={testId}
      onClick={onClick}
      style={{
        padding: "5px 12px", borderRadius: 8, border: "2px solid " + INK, cursor: "pointer",
        background: primary ? "#4db892" : "#fff9ec", color: INK,
        fontFamily: "DM Sans", fontWeight: 800, fontSize: 12.5, boxShadow: "2px 2px 0 0 " + INK,
      }}
    >
      {label}
    </button>
  );
  const actions: ReactNode[] = [];
  if (row.kind === "approval" && row.pendingApproval) {
    actions.push(btn("fleet-approve", "Approve", onApprove, true));
    actions.push(btn("fleet-deny", "Deny", onDeny));
  }
  if (row.kind === "needs_input") {
    actions.push(btn("fleet-answer", "Answer", onOpen, true));
  }
  if (row.kind === "failed" && row.exchangeId) {
    actions.push(btn("fleet-retry", "Retry", onRetry));
  }
  if (row.exchangeId && row.kind !== "decision") {
    actions.push(btn("fleet-cancel-exchange", "Hold / cancel", onCancelExchange));
  }
  actions.push(btn("fleet-open", "Open pane", onOpen));
  return <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 9 }}>{actions}</div>;
}

function FleetExceptionCard({
  row, dark, now, muted, onOpen, onApprove, onDeny, onRetry, onCancelExchange, onToggleMute,
}: {
  row: FleetRow; dark: boolean; now: number; muted: boolean;
  onOpen: () => void; onApprove: () => void; onDeny: () => void;
  onRetry: () => void; onCancelExchange: () => void; onToggleMute: () => void;
}) {
  return (
    <li
      data-testid="fleet-exception-card"
      data-fleet-pane-id={row.station.id}
      data-kind={row.kind}
      style={{
        listStyle: "none", background: dark ? "#2f1d12" : "#fff9ec", border: "2px solid " + INK,
        borderRadius: 12, padding: "10px 12px", boxShadow: "3px 3px 0 0 " + INK,
      }}
    >
      <FleetCardHeader row={row} muted={muted} onToggleMute={onToggleMute} />
      <FleetCardBody row={row} now={now} />
      <FleetCardActions row={row} onOpen={onOpen} onApprove={onApprove} onDeny={onDeny} onRetry={onRetry} onCancelExchange={onCancelExchange} />
    </li>
  );
}

function FleetTailRow({ row, onOpen }: { row: FleetRow; onOpen: () => void }) {
  return (
    <li data-testid="fleet-tail-row" data-fleet-pane-id={row.station.id} data-kind={row.kind} style={{ listStyle: "none" }}>
      <button
        onClick={onOpen}
        data-testid="fleet-tail-open"
        style={{
          width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 8, padding: "5px 8px",
          borderRadius: 6, border: "1.5px solid transparent", cursor: "pointer", background: "transparent",
          fontFamily: "DM Sans", fontSize: 12.5, color: INK,
        }}
      >
        <Chip bg={KIND_BG[row.kind]} color={KIND_FG[row.kind]} style={{ fontSize: 12 }}>{KIND_LABEL[row.kind]}</Chip>
        <span style={{ fontWeight: 700 }}>{row.station.name}</span>
        <span style={{ color: row.station.projectColor, fontWeight: 700 }}>{row.station.projectEmoji} {row.station.projectName}</span>
        {(row.lastResult || row.instructionSummary) && (
          <span style={{ color: "#8a6a4f", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {/* A finished exchange's RESULT is the more newsworthy one-liner for the compact tail;
                everything else (running/staged/idle) has no result yet, so its instruction shows. */}
            {row.lastResult || row.instructionSummary}
          </span>
        )}
      </button>
    </li>
  );
}

export function FleetExchangeView(props: FleetExchangeViewProps) {
  const now = props.now ?? Date.now();
  const muted = props.mutedProjectIds ?? [];
  const pcByPane = useMemo(() => pendingCommandsByPane(props.pendingCommands), [props.pendingCommands]);
  const attentionApprovalByPane = useMemo(
    () => attentionApprovalsByPane(props.attentionQueue ?? [], attentionResolveTarget),
    [props.attentionQueue],
  );
  const rows = useMemo(
    () => sortFleetRows(buildFleetRows(props.stations, {
      pendingCommandByPane: pcByPane,
      attentionApprovalByPane,
      exchangeByPane: props.exchangeByPane,
      summaryByPane: props.exchangeSummaries,
    })),
    [props.stations, pcByPane, attentionApprovalByPane, props.exchangeByPane, props.exchangeSummaries],
  );
  const exceptionRows = useMemo(() => rows.filter((r) => r.isException), [rows]);
  const tailRows = useMemo(() => rows.filter((r) => !r.isException), [rows]);
  const counters = useMemo(() => computeFleetCounters(rows), [rows]);
  const [showTail, setShowTail] = useState(false);

  // Zero visual delta: nothing across the whole fleet needs the operator right now.
  if (exceptionRows.length === 0) return null;

  return (
    <section
      data-testid="fleet-exception-view"
      aria-label="Fleet exceptions — needs you"
      style={{ padding: "14px 20px 0", maxWidth: 1280, margin: "0 auto", width: "100%" }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontFamily: "Fraunces, serif", fontWeight: 900, fontSize: 17, color: INK }}>
          🛎 {counters.needsYou} need{counters.needsYou === 1 ? "s" : ""} you
        </h2>
        <span data-testid="fleet-counters" style={{ fontFamily: "JetBrains Mono", fontSize: 12, color: "#8a6a4f" }}>
          {fleetCounterLine(counters)}
        </span>
      </div>
      <ul style={{ margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
        {exceptionRows.map((row) => (
          <Fragment key={row.station.id}>
            <FleetExceptionCard
              row={row}
              dark={props.dark}
              now={now}
              muted={muted.includes(row.station.project)}
              onOpen={() => props.onOpen(row.station)}
              onApprove={() => row.pendingApproval && props.onApprove(row.pendingApproval.messageId)}
              onDeny={() => row.pendingApproval && props.onDeny(row.pendingApproval.messageId)}
              onRetry={() => row.exchangeId && props.onRetry(row.exchangeId)}
              onCancelExchange={() => row.exchangeId && props.onCancelExchange(row.exchangeId)}
              onToggleMute={() => props.onToggleMute(row.station.project)}
            />
          </Fragment>
        ))}
      </ul>
      {tailRows.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <button
            data-testid="fleet-tail-toggle"
            aria-expanded={showTail}
            onClick={() => setShowTail((v) => !v)}
            style={{
              padding: "4px 10px", borderRadius: 8, border: "1.5px dashed " + INK, cursor: "pointer",
              background: "transparent", fontFamily: "DM Sans", fontWeight: 700, fontSize: 12, color: INK,
            }}
          >
            {showTail ? "Hide" : "Show"} {tailRows.length} more
          </button>
          {showTail && (
            <ul data-testid="fleet-tail-list" style={{ margin: "8px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              {tailRows.map((row) => (
                <Fragment key={row.station.id}>
                  <FleetTailRow row={row} onOpen={() => props.onOpen(row.station)} />
                </Fragment>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
