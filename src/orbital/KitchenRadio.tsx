// ── ORBITAL · Kitchen Radio (the voice channel) ─────────────────────────
// Ported from the design's radio.jsx. The Chef de Cuisine = Project Janus, the
// voice that runs the line. Everything here is real: the transcript feed is the
// live data.transcript (operator ASR + Janus turns + grounded sources), the mic
// toggle drives the real getUserMedia capture, and tuning in opens the real
// Gemini /live session (see useOrbitalData goLive/stopLive). Offline until the
// operator tunes in (voice is user-initiated — mic + a Gemini session).
import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import { INK } from "./theme";
import { Chip, Icon, VoiceCue } from "./primitives";
import type { TranscriptEntry } from "./useOrbitalData";

function ChefDeCuisineMark({ size = 42, live }: { size?: number; live: boolean }) {
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", background: "#fff4de", border: "2px solid " + INK, display: "grid", placeItems: "center", flexShrink: 0, position: "relative", boxShadow: live ? "0 0 0 3px #ff8a3d55" : "none" }}>
      <Icon name="chef-hat" size={size * 0.6} color={INK} />
      {live && <span style={{ position: "absolute", bottom: -2, right: -2, width: 12, height: 12, borderRadius: "50%", background: "#4db892", border: "2px solid " + INK }} />}
    </div>
  );
}

function Waveform({ active, color = "#e23a3a", bars = 26, h = 26 }: { active: boolean; color?: string; bars?: number; h?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2, height: h }}>
      {Array.from({ length: bars }).map((_, i) => (
        <span key={i} style={{ width: 3, borderRadius: 2, background: color, height: active ? "100%" : "12%", transformOrigin: "center", animation: active ? `orb-wave 0.9s ease-in-out ${(i % 7) * 0.09}s infinite` : "none", opacity: active ? 1 : 0.35 }} />
      ))}
    </div>
  );
}

function fmtTime(d: Date): string {
  try { return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return ""; }
}

function Bubble({ m, dark }: { m: TranscriptEntry; dark: boolean }) {
  const me = m.sender === "User";
  const g = m.grounding;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: me ? "flex-end" : "flex-start", gap: 2 }}>
      <div style={{ maxWidth: "88%", padding: "7px 11px", borderRadius: 12, border: "2px solid " + INK, background: me ? "#ffc94a" : (dark ? "#3a2415" : "#fff9ec"), color: me ? INK : (dark ? "#ffe9c7" : INK), boxShadow: "2px 2px 0 0 " + INK, fontFamily: "DM Sans", fontSize: 13, fontWeight: me ? 700 : 600, lineHeight: 1.35, borderBottomRightRadius: me ? 3 : 12, borderBottomLeftRadius: me ? 12 : 3 }}>
        {!me && <span style={{ fontFamily: "DM Sans", fontWeight: 800, fontSize: 9, letterSpacing: ".08em", textTransform: "uppercase", color: "#a8151a", display: "block", marginBottom: 2 }}>Chef de Cuisine</span>}
        {m.text}
        {g && g.sources && g.sources.length > 0 && (
          <div data-testid="radio-grounding" style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
            <span style={{ fontFamily: "JetBrains Mono", fontSize: 8.5, color: "#8a6a4f", textTransform: "uppercase", letterSpacing: ".06em" }}>grounded via</span>
            {g.sources.slice(0, 3).map((s, i) => (
              <a key={i} href={s.uri} target="_blank" rel="noreferrer" title={s.title || s.uri} style={{ fontFamily: "DM Sans", fontSize: 9.5, fontWeight: 700, color: "#2f7a5e", textDecoration: "underline", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title || s.uri}</a>
            ))}
          </div>
        )}
      </div>
      <span style={{ fontFamily: "JetBrains Mono", fontSize: 9, color: "#8a6a4f", padding: "0 4px" }}>{fmtTime(m.timestamp)}</span>
    </div>
  );
}

const CALLS: { group: string; color: string; lines: string[] }[] = [
  { group: "The Line", color: "#a8151a", lines: ["open auth refactor", "switch to search indexer", "what's on the line, Chef?"] },
  { group: "The Pass", color: "#c98a16", lines: ["fire it, Chef", "86 that one", "what's at the pass?"] },
  { group: "Service mode", color: "#4b3bb3", lines: ["let 'em cook", "taste every plate", "hands off — read only"] },
  { group: "The Order Pad", color: "#2f7a5e", lines: ["tell auth refactor to rerun the tests", "send it to the line", "scrap that draft"] },
  { group: "Emergency", color: "#e23a3a", lines: ["ALL HANDS — stop the line", "kill the burners", "back to service"] },
];

export function KitchenRadio({ dark, live, muted, reconnecting, transcript, voiceCues, onGoLive, onToggleMute }: {
  dark: boolean; live: boolean; muted: boolean; reconnecting: boolean; transcript: TranscriptEntry[];
  voiceCues: boolean; onGoLive: () => void; onToggleMute: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [calls, setCalls] = useState(false);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [transcript]);

  const panelBg = dark ? "#241409" : "#fff4de";
  const listening = live && !muted;

  return (
    <aside data-testid="kitchen-radio" style={{ position: "relative", display: "flex", flexDirection: "column", minHeight: 0, background: panelBg, height: "100%", overflow: "hidden" }}>
      {/* header */}
      <div style={{ padding: "12px 14px", background: INK, color: "#fff4de", display: "flex", alignItems: "center", gap: 10, borderBottom: "3px solid " + INK }}>
        <ChefDeCuisineMark size={42} live={listening} />
        <div style={{ flex: 1, lineHeight: 1.1, minWidth: 0 }}>
          <div style={{ fontFamily: "Caveat, cursive", fontSize: 15, color: "#ffc94a", transform: "rotate(-1.5deg)" }}>"runnin' the line"</div>
          <div style={{ fontFamily: "Fraunces, serif", fontWeight: 900, fontSize: 18 }}>Kitchen Radio</div>
        </div>
        <button onClick={() => setCalls((c) => !c)} title="What can I say?" style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 9px", borderRadius: 8, border: "2px solid #fff4de", background: calls ? "#ffc94a" : "transparent", color: calls ? INK : "#fff4de", cursor: "pointer", fontFamily: "DM Sans", fontWeight: 800, fontSize: 11, whiteSpace: "nowrap", flexShrink: 0 }}>🎙 calls</button>
        <Chip bg={!live ? "#8a6a4f" : muted ? "#8a6a4f" : "#e23a3a"} color="#fff4de" border="#fff4de">{!live ? (reconnecting ? "…" : "OFF AIR") : muted ? "MUTED" : "● LIVE"}</Chip>
      </div>

      {/* now-speaking waveform */}
      <div style={{ padding: "11px 14px", background: dark ? "#2f1d12" : "#fff9ec", borderBottom: "2px solid " + INK, display: "flex", alignItems: "center", gap: 10 }}>
        <Icon name="chef-hat" size={18} color="#a8151a" />
        <Waveform active={listening} color={dark ? "#ffc94a" : "#e23a3a"} />
      </div>

      {/* transcript */}
      <div ref={scrollRef} data-testid="radio-transcript" style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
        {transcript.length === 0 && (
          <div style={{ margin: "auto", textAlign: "center", fontFamily: "Caveat, cursive", fontSize: 17, color: "#8a6a4f" }}>
            {live ? "listening for you, Chef…" : "tune in the radio to talk to the Chef de Cuisine"}
          </div>
        )}
        {transcript.map((m, i) => <Fragment key={i}><Bubble m={m} dark={dark} /></Fragment>)}
        {listening && transcript.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: "Caveat, cursive", fontSize: 17, color: "#8a6a4f", transform: "rotate(-1deg)", paddingLeft: 4 }}>
            <span className="orb-listening-dot" /> listening for you, Chef…
          </div>
        )}
      </div>

      {/* mic control */}
      <div style={{ padding: 12, borderTop: "2px solid " + INK, background: dark ? "#2f1d12" : "#fff9ec" }}>
        {voiceCues && <div style={{ textAlign: "center", marginBottom: 8 }}><VoiceCue phrase="hey Chef, what's on the line?" dark={dark} tone="live" /></div>}
        {!live ? (
          <button data-testid="radio-golive" onClick={onGoLive} style={micBtn("#ffc94a")}>
            <Icon name="spark" size={18} /> {reconnecting ? "Tuning in…" : "Tune in the radio"}
          </button>
        ) : (
          <button data-testid="radio-mute" onClick={onToggleMute} style={micBtn(muted ? "#fff9ec" : "#4db892")}>
            <Icon name={muted ? "x" : "spark"} size={18} /> {muted ? "Mic off — tap to talk" : "I'm listening, Chef"}
          </button>
        )}
      </div>

      {/* CALL SHEET — what you can say (hands-free reference) */}
      {calls && (
        <div className="orb-pop-in" data-testid="radio-calls" style={{ position: "absolute", inset: 0, zIndex: 5, background: dark ? "#1a0f08f2" : "#fff4def5", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "12px 14px", borderBottom: "3px solid " + INK, display: "flex", alignItems: "center", gap: 8, background: "#ffc94a" }}>
            <span style={{ fontSize: 18 }}>🎙</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontFamily: "Fraunces, serif", fontWeight: 900, fontSize: 18, color: INK }}>What're my calls?</div>
              <div style={{ fontFamily: "Caveat, cursive", fontSize: 14, color: "#a8151a" }}>everything here works hands-free</div>
            </div>
            <button onClick={() => setCalls(false)} aria-label="Close" style={{ width: 30, height: 30, border: "2px solid " + INK, borderRadius: 8, background: "#fff4de", cursor: "pointer", fontWeight: 800, color: INK }}>✕</button>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 14 }}>
            {CALLS.map((g) => (
              <Fragment key={g.group}>
                <div>
                  <div style={{ fontFamily: "DM Sans", fontWeight: 800, fontSize: 10, letterSpacing: ".1em", textTransform: "uppercase", color: g.color, marginBottom: 6 }}>{g.group}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {g.lines.map((l, i) => (
                      <Fragment key={i}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 9px", background: dark ? "#2f1d12" : "#fff9ec", border: "1.5px solid " + INK, borderRadius: 8, boxShadow: "1.5px 1.5px 0 0 " + INK }}>
                          <VoiceCue phrase={l} dark={dark} tone="live" style={{ fontSize: 11.5 }} />
                          <div style={{ flex: 1 }} />
                          <span style={{ fontFamily: "DM Sans", fontWeight: 800, fontSize: 9, letterSpacing: ".06em", textTransform: "uppercase", color: "#8a6a4f" }}>say it ›</span>
                        </div>
                      </Fragment>
                    ))}
                  </div>
                </div>
              </Fragment>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

function micBtn(bg: string): CSSProperties {
  return { width: "100%", padding: "11px", borderRadius: 12, border: "2px solid " + INK, background: bg, color: INK, cursor: "pointer", fontFamily: "DM Sans", fontWeight: 800, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, boxShadow: "3px 3px 0 0 " + INK };
}
