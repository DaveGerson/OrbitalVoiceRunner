// ── ORBITAL · StationCard ───────────────────────────────────────────────
// One coding-agent pane on the line. Faithful port of components.jsx's
// StationCard, fed by the real merged Station view-model.
import { useState } from "react";
import { INK, RUNTIMES, STATUS } from "./theme";
import { ChefAvatar, Chip, Pips, StatusBadge, VoiceCue } from "./primitives";
import { CHEFS } from "./theme";
import type { Station } from "./station";

const PIP_COUNT = 8;

export function StationCard({ st, accentHex, dark, compact, tilt = 0, onOpen, layout, showCue, active }: {
  st: Station; accentHex: string; dark: boolean; compact: boolean; tilt?: number;
  onOpen: () => void; layout: "grid" | "rail" | "list"; showCue: boolean; active: boolean;
}) {
  const [hover, setHover] = useState(false);
  const rt = RUNTIMES[st.toolPreset] || RUNTIMES.Custom;
  const cardBg = dark ? "#2f1d12" : "#fff9ec";
  const fg = dark ? "#ffe9c7" : INK;
  const sub = dark ? "#c89f74" : "#8a6a4f";
  const sunken = dark ? "#241409" : "#fff4de";
  const needs = st.status === "Needs Input";
  const isRun = st.status === "Running";
  const isExit = st.status === "Exited";
  const list = layout === "list";
  const tag = (st.projectName || "").replace(/[^a-z]/gi, "").slice(0, 4).toUpperCase() || "—";

  return (
    <div onClick={onOpen} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      data-testid="station-card" data-pane-id={st.id} data-status={st.status}
      style={{
        background: cardBg, border: "2px solid " + INK, borderRadius: 14, padding: compact ? 11 : 14,
        opacity: isExit ? 0.6 : 1, filter: isExit ? "saturate(.5)" : "none",
        boxShadow: (active ? "0 0 0 3px var(--butter), " : "") + (hover ? "6px 6px 0 0 " + INK : needs ? "3px 3px 0 0 #ff8a3d" : "3px 3px 0 0 " + INK),
        transform: `${hover ? "translate(-1px,-2px) " : ""}rotate(${hover ? 0 : tilt}deg)`,
        transition: "transform 160ms var(--ease-bounce), box-shadow 160ms",
        cursor: "pointer", position: "relative", overflow: "hidden",
        display: list ? "flex" : "block", alignItems: "center", gap: 14,
      }}>
      {/* accent spine — animated barber-pole while the pane is actually working */}
      <div style={{
        position: "absolute", top: 0, left: 0, bottom: 0, width: 5, backgroundColor: accentHex,
        backgroundImage: isRun ? "repeating-linear-gradient(135deg, rgba(255,255,255,.55) 0 5px, rgba(255,255,255,0) 5px 10px)" : "none",
        backgroundSize: "14px 14px", animation: isRun ? "orb-spine .6s linear infinite" : "none",
      }} />

      <div style={{ flex: list ? "0 0 auto" : "none", minWidth: list ? 200 : "auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 7, paddingLeft: 4 }}>
          <span style={{ fontFamily: "JetBrains Mono", fontSize: 10, fontWeight: 700, color: sub }}>#{st.id}</span>
          <span style={{ width: 7, height: 7, borderRadius: 2, background: accentHex, border: "1.5px solid " + INK }} />
          <span style={{ fontFamily: "DM Sans", fontSize: 10, fontWeight: 800, color: accentHex, letterSpacing: ".06em" }}>{tag}</span>
          {active && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "1px 7px", borderRadius: 999, background: "#ffc94a", border: "1.5px solid " + INK, fontFamily: "DM Sans", fontSize: 9, fontWeight: 800, letterSpacing: ".05em", textTransform: "uppercase", color: INK }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#e23a3a", animation: "orb-pulse 1s var(--ease-bounce) infinite" }} />active
            </span>
          )}
          {!list && <div style={{ flex: 1 }} />}
          {!list && <StatusBadge status={st.status} />}
        </div>
        <h3 style={{ margin: "0 0 6px", paddingLeft: 4, fontFamily: "Fraunces, serif", fontWeight: 800, fontSize: compact ? 16 : 18, lineHeight: 1.12, color: fg, letterSpacing: "-.01em" }}>{st.name}</h3>
        <div style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 4 }}>
          <ChefAvatar chefKey={st.chef} size={20} />
          <span style={{ fontFamily: "DM Sans", fontSize: 12, fontWeight: 700, color: fg }}>Chef {CHEFS[st.chef].name}</span>
          <span style={{ fontFamily: "JetBrains Mono", fontSize: 10, fontWeight: 600, color: sub, marginLeft: 2 }}>· {rt.label}</span>
        </div>
      </div>

      {!compact && !list && st.scribble && (
        <div style={{
          margin: "10px 0 0", padding: "5px 9px", background: sunken, border: "1.5px solid " + (dark ? "#5b3a23" : INK), borderRadius: 7,
          fontFamily: "Caveat, cursive", fontSize: 16, fontWeight: 600, color: needs ? "#e23a3a" : dark ? "#ffc94a" : "#a8151a",
          lineHeight: 1.1, transform: "rotate(-.5deg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>"{st.scribble}"</div>
      )}

      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginTop: list ? 0 : 10, paddingTop: list ? 0 : 9, paddingLeft: 4,
        borderTop: list ? "none" : "1.5px dashed " + (dark ? "#5b3a23" : "#c9a97a"), flex: list ? 1 : "none",
      }}>
        {list && <StatusBadge status={st.status} />}
        <Pips steps={PIP_COUNT} done={st.contextPips} color={accentHex} label={st.contextLabel} />
        <div style={{ flex: 1 }} />
        {needs && <Chip bg="#ff8a3d" color="#fff4de">{STATUS["Needs Input"].emoji} at the pass</Chip>}
        <span style={{ fontFamily: "JetBrains Mono", fontSize: 10, color: sub }}>{st.elapsed}</span>
      </div>

      {showCue && !list && (
        <div style={{ marginTop: 8, paddingTop: 7, paddingLeft: 4, borderTop: "1.5px dotted " + (dark ? "#5b3a23" : "#d9bf94") }}>
          <VoiceCue phrase={`open ${st.name.toLowerCase()}`} dark={dark} />
        </div>
      )}
    </div>
  );
}
