// ── ORBITAL · The Instruction Workbench (Phase 3, Step 3.3) ─────────────────
// Surfaces a pane's open InstructionEnvelope draft — the structured exchange behind the Order Pad's
// rendered prose (docs/superpowers/specs/2026-07-09-instruction-routing.md §5.2: "every envelope
// render is mirrored into the ledger draft … so the Workbench buffer shows byte-for-byte what will
// be sent"). This panel adds the structure the operator can't see in that plain text: WHERE it's
// going, WHAT's still missing before it can send, and whether what's on screen matches what was last
// delivered.
//
// Renders NOTHING when `exchange` is null (flag off, or no open draft for this pane) — the Order Pad
// is then exactly what it was before this step (zero visual delta, the no-exchange regression the
// component test pins).
//
// Controls route through the SAME canonical, already-existing paths the rest of the Order Pad uses —
// no parallel effect path:
//   • Send   → the existing operator-direct Workbench lane, POST …/draft/send (spec §5.3) — the
//              SAME button/handler TerminalWindow's onSend already wires; this component just calls
//              the callback the caller passes in.
//   • Revise → UI-only: focuses the existing composer textarea so the operator edits the SAME
//              durable draft (typed edits already converge onto the exchange via the existing
//              draft_edit / PUT …/draft path — see src/exchanges/draftRegistry.ts's prose-override).
//   • Cancel → the existing "clear the draft" affordance (PUT …/draft {text:""}, the same route the
//              Order Pad's own "Scrap" button already calls) — this panel does not invent a second
//              clear path, it offers the SAME one from inside the exchange view.
//   • Retarget → moving a draft to a different pane is currently a VOICE-ONLY verb
//              (retarget_instruction/confirm_instruction, src/actions/defs/voice_ux.ts) — there is
//              no REST/WS surface for it today, and adding a new mutating route is out of this
//              step's scope (server-side changes here are limited to additive data-flow fields).
//              Rather than fabricate a fake button, this panel shows the target honestly (so the
//              operator can always verify where a send will go) and marks Retarget as voice-only
//              with an accessible explanation, instead of a silently-broken click target.
import type { CSSProperties, ReactNode } from "react";
import { INK } from "./theme";
import { Button, Chip } from "./primitives";
import type { ExchangeDraftView } from "../types";
import { deriveExchangeApprovalState, exchangeReadinessSummary, type ExchangeApprovalState } from "../classic/helpers/composerLogic";

// ── pure view helpers (exported for tests) ──────────────────────────────────────────────────────

const APPROVAL_CHIP: Record<ExchangeApprovalState, { label: string; bg: string; fg: string }> = {
  none: { label: "not sent", bg: "#f3e4c2", fg: INK },
  sent: { label: "delivered", bg: "#4db892", fg: INK },
  stale: { label: "revised since delivery", bg: "#ff8a3d", fg: INK },
};

/** The approval chip's label/palette for a given state — exported so the compact card chip
 *  (StationCard) and the full panel below always agree on the same three words. */
export function approvalChipSkin(state: ExchangeApprovalState): { label: string; bg: string; fg: string } {
  return APPROVAL_CHIP[state];
}

/** One line naming the pane a draft targets, or an honest "no target yet" — never fabricated. */
export function targetLabel(target: ExchangeDraftView["target"]): string {
  return target ? `${target.paneId} (${target.projectId})` : "no pane targeted yet";
}

// ── compact card chip (StationCard) ─────────────────────────────────────────────────────────────

/**
 * The compact pane-card indicator: state chip + a short waiting reason when not ready. Renders
 * nothing for a null exchange — a station with no open instruction draft looks exactly as it did
 * before this step.
 */
export function ExchangeStateChip({ exchange }: { exchange: ExchangeDraftView | null | undefined }) {
  if (!exchange) return null;
  const approval = deriveExchangeApprovalState(exchange.draftVersion, exchange.sentVersions);
  const skin = approvalChipSkin(approval);
  // NOTE: `=== false` narrowing — see composerLogic.ts's exchangeReadinessSummary doc comment.
  const waiting = exchange.readiness.ready === false ? exchange.readiness.clarification : null;
  return (
    <span data-testid="exchange-card-chip" style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <Chip bg={skin.bg} color={skin.fg} style={{ fontSize: 12 }}>📨 {skin.label}</Chip>
      {waiting && (
        <span data-testid="exchange-card-waiting" title={waiting} style={{ fontFamily: "DM Sans", fontSize: 12, fontWeight: 700, color: "#8a6a4f", maxWidth: 160, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {waiting}
        </span>
      )}
    </span>
  );
}

// ── the full panel ───────────────────────────────────────────────────────────────────────────────

function fieldRow(label: string, value: string | null, testId: string, dark: boolean): ReactNode {
  if (!value) return null;
  return (
    <div data-testid={testId} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={fieldLabelStyle(dark)}>{label}</span>
      <span style={fieldValueStyle(dark)}>{value}</span>
    </div>
  );
}

function fieldListRow(label: string, items: string[], testId: string, dark: boolean): ReactNode {
  if (items.length === 0) return null;
  return (
    <div data-testid={testId} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={fieldLabelStyle(dark)}>{label}</span>
      <ul style={{ margin: 0, paddingLeft: 16 }}>
        {items.map((item, i) => (
          <li key={i} style={fieldValueStyle(dark)}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function fieldLabelStyle(dark: boolean): CSSProperties {
  return { fontFamily: "DM Sans", fontSize: 12, fontWeight: 800, letterSpacing: ".06em", textTransform: "uppercase", color: dark ? "#c89f74" : "#8a6a4f" };
}
function fieldValueStyle(dark: boolean): CSSProperties {
  return { fontFamily: "DM Sans", fontSize: 13, fontWeight: 600, color: dark ? "#ffe9c7" : INK, lineHeight: 1.4, wordBreak: "break-word" };
}

export interface InstructionWorkbenchProps {
  exchange: ExchangeDraftView | null;
  dark: boolean;
  /** Client-local "I clicked Send and the server accepted it" marker for the REST Workbench lane,
   *  which does not yet stamp `sentVersions` server-side (see composerLogic.ts's
   *  deriveExchangeApprovalState doc comment) — the honest bridge for an otherwise-invisible send. */
  optimisticDeliveredVersion?: number | null;
  /** Focuses the existing composer editing this SAME durable draft. */
  onRevise: () => void;
  /** Clears the draft via the existing PUT …/draft {text:""} route (same as "Scrap"). */
  onCancel: () => void;
  /** Fires the existing POST …/draft/send route (same as the Order Pad's own Send button). */
  onSend: () => void;
}

/**
 * The exchange draft state + controls panel. Renders nothing when `exchange` is null — callers can
 * mount this unconditionally next to the plain-text draft surface with zero visual impact when no
 * instruction envelope draft is open for the pane.
 */
export function InstructionWorkbench({ exchange, dark, optimisticDeliveredVersion, onRevise, onCancel, onSend }: InstructionWorkbenchProps) {
  if (!exchange) return null;
  const approval = deriveExchangeApprovalState(exchange.draftVersion, exchange.sentVersions, optimisticDeliveredVersion);
  const approvalSkin = approvalChipSkin(approval);
  const readinessText = exchangeReadinessSummary(exchange.readiness);
  const canSend = exchange.readiness.ready;

  return (
    <section
      data-testid="instruction-workbench"
      aria-label="Instruction draft"
      style={{
        display: "flex", flexDirection: "column", gap: 10, padding: 12, marginBottom: 10,
        border: "2px solid " + INK, borderRadius: 10,
        background: dark ? "#1a0f08" : "#fff4de", boxShadow: "2px 2px 0 0 " + INK,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontFamily: "Fraunces, serif", fontWeight: 800, fontSize: 14, color: dark ? "#ffe9c7" : INK }}>📨 Instruction draft</span>
        <span data-testid="exchange-approval-chip" data-approval-state={approval}>
          <Chip bg={approvalSkin.bg} color={approvalSkin.fg}>{approvalSkin.label}</Chip>
        </span>
        <span style={{ fontFamily: "JetBrains Mono", fontSize: 12, color: "#8a6a4f" }} data-testid="exchange-version">
          v{exchange.draftVersion}
        </span>
        <div style={{ flex: 1 }} />
        <span data-testid="exchange-target" style={{ fontFamily: "JetBrains Mono", fontSize: 12, fontWeight: 700, color: dark ? "#9be3c0" : "#2f7a5e" }}>
          → {targetLabel(exchange.target)}
        </span>
      </div>

      {/* aria-live status: readiness — the ONE thing that determines whether Send will actually go
          (spec §2.2's readiness predicate). Matches CaptionBar's role="status"/aria-live idiom. */}
      <div data-testid="exchange-readiness" role="status" aria-live="polite" style={{ fontFamily: "DM Sans", fontSize: 12, fontWeight: 700, color: canSend ? "#2f7a5e" : "#a8151a" }}>
        {readinessText}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {fieldRow("Objective", exchange.objective || null, "exchange-objective", dark)}
        {fieldListRow("Context", exchange.relevantContext, "exchange-context", dark)}
        {fieldListRow("Constraints", exchange.constraints, "exchange-constraints", dark)}
        {fieldRow("Requested output", exchange.requestedOutput, "exchange-requested-output", dark)}
        {fieldRow("Completion signal", exchange.completionSignal, "exchange-completion-signal", dark)}
      </div>

      <div role="group" aria-label="Instruction draft controls" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Button testId="exchange-revise" variant="default" size="sm" icon="ticket" onClick={onRevise} title="Edit this draft in the composer below">
          Revise
        </Button>
        <RetargetControl dark={dark} target={exchange.target} />
        <Button testId="exchange-cancel" variant="default" size="sm" icon="x" onClick={onCancel} title="Clear this draft">
          Cancel
        </Button>
        <div style={{ flex: 1 }} />
        <Button testId="exchange-send" variant="primary" size="sm" icon="arrow-right" onClick={onSend} disabled={!canSend}
          title={canSend ? "Send this instruction to the pane" : readinessText}>
          Send
        </Button>
      </div>
    </section>
  );
}

// Retargeting a draft to a different pane is voice-only today (see the file header comment) — this
// renders an honestly-labeled, keyboard-focusable, non-mutating affordance rather than either
// omitting destination-change entirely or faking a button that does nothing.
function RetargetControl({ dark, target }: { dark: boolean; target: ExchangeDraftView["target"] }) {
  const hint = `Retargeting is voice-only right now — say "send this to <pane> instead". Currently targeting ${targetLabel(target)}.`;
  return (
    <button
      type="button"
      data-testid="exchange-retarget"
      aria-disabled="true"
      aria-describedby="exchange-retarget-hint"
      title={hint}
      onClick={(e) => e.preventDefault()}
      style={{
        display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 8,
        border: "1.5px dashed " + (dark ? "#c89f74" : "#8a6a4f"), background: "transparent",
        color: dark ? "#c89f74" : "#8a6a4f", cursor: "not-allowed",
        fontFamily: "DM Sans", fontWeight: 800, fontSize: 12,
      }}
    >
      🎙 Retarget
      <span id="exchange-retarget-hint" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
        {hint}
      </span>
    </button>
  );
}

// Re-export the effort types purely for caller ergonomics (so TerminalWindow doesn't need a second
// import line for the exchange approval state union).
export type { ExchangeApprovalState };
