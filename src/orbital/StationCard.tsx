// ── ORBITAL · StationCard ───────────────────────────────────────────────
// One coding-agent pane on the line. Faithful port of components.jsx's
// StationCard, fed by the real merged Station view-model.
import { useState } from "react";
import { INK, RUNTIMES, STATUS } from "./theme";
import { ChefAvatar, Chip, Pips, PostureChip, StatusBadge, VoiceCue } from "./primitives";
import { CHEFS } from "./theme";
import type { Station } from "./station";
import type { StoredHandoff } from "../store/types";
import { StationHandoffDrawer } from "./StationHandoffDrawer";
import {
  deriveCardColors,
  deriveCardTag,
  deriveCardBoxShadow,
  deriveCardTransform,
  deriveSpineStyle,
  deriveScribbleColor,
  deriveScribbleBorderColor,
  deriveOutputLineColor,
  deriveFooterBorderColor,
  deriveCueBorderColor,
} from "./stationCardHelpers";

const PIP_COUNT = 8;

export function StationCard({ st, accentHex, dark, compact, tilt = 0, onOpen, layout, showCue, active, handoffs, onDeliverHandoff, onReviseHandoff, onStageHandoff, onRejectHandoff, onFetchHandoffPrompt }: {
  st: Station; accentHex: string; dark: boolean; compact: boolean; tilt?: number;
  onOpen: () => void; layout: "grid" | "rail" | "list"; showCue: boolean; active: boolean;
  // j4e1 (additive): handoffs bound TO this station + the hero-action callbacks. Omitted → no drawer.
  handoffs?: StoredHandoff[];
  onDeliverHandoff?: (id: string) => void;
  onReviseHandoff?: (id: string, text: string) => void;
  onStageHandoff?: (id: string) => void;
  onRejectHandoff?: (id: string) => void;
  onFetchHandoffPrompt?: (id: string) => Promise<string | null>;
}) {
  const [hover, setHover] = useState(false);
  const rt = RUNTIMES[st.toolPreset] || RUNTIMES.Custom;
  const { cardBg, fg, sub, sunken } = deriveCardColors(dark);
  const needs = st.status === "Needs Input";
  const isRun = st.status === "Running";
  const isExit = st.status === "Exited";
  const list = layout === "list";
  const tag = deriveCardTag(st.projectName || "");

  function renderHeaderRow() {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 7, paddingLeft: 4 }}>
        <span style={{ fontFamily: "JetBrains Mono", fontSize: 12, fontWeight: 700, color: sub }}>#{st.id}</span>
        <span style={{ width: 7, height: 7, borderRadius: 2, background: accentHex, border: "1.5px solid " + INK }} />
        <span style={{ fontFamily: "DM Sans", fontSize: 12, fontWeight: 800, color: accentHex, letterSpacing: ".06em" }}>{tag}</span>
        {active && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "1px 7px", borderRadius: 999, background: "#ffc94a", border: "1.5px solid " + INK, fontFamily: "DM Sans", fontSize: 12, fontWeight: 800, letterSpacing: ".05em", textTransform: "uppercase", color: INK }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#e23a3a", animation: "orb-pulse 1s var(--ease-bounce) infinite" }} />active
          </span>
        )}
        {!list && <div style={{ flex: 1 }} />}
        {/* 2K.2: the pane's autonomy at a glance — server truth (posture/permissions_mode), visual only */}
        {!list && <PostureChip posture={st.posture} mode={st.mode} />}
        {!list && <StatusBadge status={st.status} />}
      </div>
    );
  }

  function renderIdentityBlock() {
    return (
      <div style={{ flex: list ? "0 0 auto" : "none", minWidth: list ? 200 : "auto" }}>
        {renderHeaderRow()}
        <h3 style={{ margin: "0 0 6px", paddingLeft: 4, fontFamily: "Fraunces, serif", fontWeight: 800, fontSize: compact ? 16 : 18, lineHeight: 1.12, color: fg, letterSpacing: "-.01em" }}>{st.name}</h3>
        <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 4 }}>
          <ChefAvatar chefKey={st.chef} size={20} />
          <span style={{ fontFamily: "DM Sans", fontSize: 12, fontWeight: 700, color: fg }}>Chef {CHEFS[st.chef].name}</span>
          <span style={{ fontFamily: "JetBrains Mono", fontSize: 12, fontWeight: 600, color: sub, marginLeft: 2 }}>· {rt.label}</span>
        </div>
      </div>
    );
  }

  function renderScribble() {
    if (compact || list || !st.scribble) return null;
    return (
      <div style={{
        margin: "10px 0 0", padding: "5px 9px", background: sunken, border: "1.5px solid " + deriveScribbleBorderColor(dark), borderRadius: 7,
        fontFamily: "Caveat, cursive", fontSize: 16, fontWeight: 600, color: deriveScribbleColor(needs, dark),
        lineHeight: 1.1, transform: "rotate(-.5deg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      }}>"{st.scribble}"</div>
    );
  }

  function renderOutputPeek() {
    if (!isRun || compact || list || st.outputTail.length === 0) return null;
    return (
      <div data-testid="station-peek" style={{ marginTop: 10, background: INK, borderRadius: 8, padding: "7px 10px", overflow: "hidden", maxHeight: 62 }}>
        {st.outputTail.slice(-3).map((l, i) => (
          <div key={i} style={{
            fontFamily: "JetBrains Mono, monospace", fontSize: 12, lineHeight: 1.5,
            color: deriveOutputLineColor(l),
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>{l}</div>
        ))}
      </div>
    );
  }

  function renderFooter() {
    return (
      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginTop: list ? 0 : 10, paddingTop: list ? 0 : 9, paddingLeft: 4,
        borderTop: list ? "none" : "1.5px dashed " + deriveFooterBorderColor(dark), flex: list ? 1 : "none",
      }}>
        {list && <PostureChip posture={st.posture} mode={st.mode} />}
        {list && <StatusBadge status={st.status} />}
        <Pips steps={PIP_COUNT} done={st.contextPips} color={accentHex} label={st.contextLabel} />
        <div style={{ flex: 1 }} />
        {needs && <Chip bg="#ff8a3d" color="#fff4de">{STATUS["Needs Input"].emoji} at the pass</Chip>}
        <span style={{ fontFamily: "JetBrains Mono", fontSize: 12, color: sub }}>{st.elapsed}</span>
      </div>
    );
  }

  // j4e1: the per-station handoff drawer — the deliver/revise/reject hero surface. Renders only when
  // this station owns handoffs (to_pane) AND the callbacks are wired; the drawer self-hides otherwise.
  function renderHandoffDrawer() {
    if (!handoffs || handoffs.length === 0 || !onDeliverHandoff || !onReviseHandoff || !onStageHandoff || !onRejectHandoff || !onFetchHandoffPrompt) return null;
    return (
      <StationHandoffDrawer handoffs={handoffs}
        onDeliver={onDeliverHandoff} onRevise={onReviseHandoff} onStage={onStageHandoff}
        onReject={onRejectHandoff} onFetchPrompt={onFetchHandoffPrompt} />
    );
  }

  function renderVoiceCue() {
    if (!showCue || list) return null;
    return (
      <div style={{ marginTop: 8, paddingTop: 7, paddingLeft: 4, borderTop: "1.5px dotted " + deriveCueBorderColor(dark) }}>
        <VoiceCue phrase={`open ${st.name.toLowerCase()}`} dark={dark} />
      </div>
    );
  }

  return (
    // 2K.5: a station card is a real button to the keyboard — Tab reaches it, Enter/Space opens
    // it, and the kitchen-wide :focus-visible ring (orbital.css) makes the stop unmistakable.
    <div onClick={onOpen} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      role="button" tabIndex={0} aria-label={`Open ${st.name} — ${st.status}`}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); }
      }}
      data-testid="station-card" data-pane-id={st.id} data-status={st.status}
      style={{
        background: cardBg, border: "2px solid " + INK, borderRadius: 14, padding: compact ? 11 : 14,
        opacity: isExit ? 0.6 : 1, filter: isExit ? "saturate(.5)" : "none",
        boxShadow: deriveCardBoxShadow(active, hover, needs),
        transform: deriveCardTransform(hover, tilt),
        transition: "transform 160ms var(--ease-bounce), box-shadow 160ms",
        cursor: "pointer", position: "relative", overflow: "hidden",
        display: list ? "flex" : "block", alignItems: "center", gap: 14,
      }}>
      {/* accent spine — animated barber-pole while the pane is actually working */}
      <div style={deriveSpineStyle(accentHex, isRun)} />

      {renderIdentityBlock()}
      {renderScribble()}
      {renderOutputPeek()}
      {renderFooter()}
      {renderHandoffDrawer()}
      {renderVoiceCue()}
    </div>
  );
}
