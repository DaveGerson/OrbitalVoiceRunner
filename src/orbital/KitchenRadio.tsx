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
import { useDialog } from "./useFocusTrap";
import type { TranscriptEntry } from "./useOrbitalData";
import { chipColorForKind, deriveConversationalState, hasToolActivity } from "./useConversationalState";

// ── Pure helpers (CC burndown) ────────────────────────────────────────────

/**
 * Background color for the status Chip. Single source of truth (bead m9v): the boolean ladder is
 * reduced to a discrete ConversationalKind via the same reducer the nav pill uses, then mapped
 * through chipColorForKind — so the radio chip and the design pill can never paint one state two
 * colors. The radio chip has no tool-activity input, so toolActive/reconnecting are false here.
 */
export function getChipBg(live: boolean, micBlocked: boolean, connected: boolean, muted: boolean): string {
  const { kind } = deriveConversationalState({
    live, micBlocked, connected, muted,
    reconnecting: false, speaking: false, waiting: false, executing: false, toolActive: false,
  });
  return chipColorForKind(kind);
}

/** Label text for the status Chip. */
export function getChipLabel(live: boolean, micBlocked: boolean, connected: boolean, muted: boolean, reconnecting: boolean): string {
  if (!live) return reconnecting ? "…" : "OFF AIR";
  if (micBlocked) return "MIC BLOCKED";
  if (!connected) return "TUNING IN…";
  if (muted) return "MUTED";
  return "● LIVE";
}

/**
 * velocity-mech: the conversational HELPER line that rides alongside the terse status pill — the
 * chef-voice gloss of what the pill means, so an eyes-off operator hears the state in the kitchen's
 * voice. Same arg order + branch precedence as getChipLabel/getChipBg (mic-blocked beats tuning beats
 * muted), so the pill, its color, and this line never disagree about which state is showing.
 */
export function getChipHelper(live: boolean, micBlocked: boolean, connected: boolean, muted: boolean, reconnecting: boolean): string {
  if (!live) return reconnecting ? "Hang tight — gettin' back on air…" : "Off air — tap to tune in, Chef";
  if (micBlocked) return "Mic's blocked — check browser permissions";
  if (!connected) return "Tunin' in — one sec…";
  if (muted) return "Mic's off — tap to talk";
  return "I'm listening, Chef";
}

/** Background color for the mute/unmute button while live. */
export function getMicBtnBg(micBlocked: boolean, muted: boolean): string {
  if (micBlocked) return "#ff8a3d";
  if (muted) return "#fff9ec";
  return "#4db892";
}

/** Label text for the mute/unmute button while live. */
export function getMicBtnLabel(micBlocked: boolean, muted: boolean): string {
  if (micBlocked) return "Mic's blocked — check browser permissions";
  if (muted) return "Mic off — tap to talk";
  return "I'm listening, Chef";
}

/** Icon name for the mute/unmute button while live. */
export function getMicBtnIconName(micBlocked: boolean, muted: boolean): string {
  return muted || micBlocked ? "x" : "spark";
}

/** Panel background color. */
export function getPanelBg(dark: boolean): string {
  return dark ? "#241409" : "#fff4de";
}

/** Waveform section background color. */
export function getWaveformSectionBg(dark: boolean): string {
  return dark ? "#2f1d12" : "#fff9ec";
}

/** Waveform bar color. */
export function getWaveformColor(dark: boolean): string {
  return dark ? "#ffc94a" : "#e23a3a";
}

/** Mic control section background color. */
export function getMicControlBg(dark: boolean): string {
  return dark ? "#2f1d12" : "#fff9ec";
}

/** Background color for a Bubble message. */
export function getBubbleBg(me: boolean, dark: boolean): string {
  if (me) return "#ffc94a";
  return dark ? "#3a2415" : "#fff9ec";
}

/** Text color for a Bubble message. */
export function getBubbleColor(me: boolean, dark: boolean): string {
  if (me) return INK;
  return dark ? "#ffe9c7" : INK;
}

// ── Components ────────────────────────────────────────────────────────────

// 2K.5: the call sheet as a proper dialog — initial focus, focus trap, Escape closes. Split out
// so the useDialog hook mounts/unmounts with the overlay itself.
function CallSheet({ dark, stations, onCall, onClose }: {
  dark: boolean; stations: { name: string }[]; onCall: (phrase: string) => void; onClose: () => void;
}) {
  const dialogRef = useDialog<HTMLDivElement>(onClose);
  return (
    <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="What're my calls?"
      className="orb-pop-in" data-testid="radio-calls" style={{ position: "absolute", inset: 0, zIndex: 5, background: dark ? "#1a0f08f2" : "#fff4def5", display: "flex", flexDirection: "column", outline: "none" }}>
      <div style={{ padding: "12px 14px", borderBottom: "3px solid " + INK, display: "flex", alignItems: "center", gap: 8, background: "#ffc94a" }}>
        <span style={{ fontSize: 18 }}>🎙</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontFamily: "Fraunces, serif", fontWeight: 900, fontSize: 18, color: INK }}>What're my calls?</div>
          <div style={{ fontFamily: "Caveat, cursive", fontSize: 14, color: "#a8151a" }}>everything here works hands-free</div>
        </div>
        <button onClick={onClose} aria-label="Close" style={{ width: 30, height: 30, border: "2px solid " + INK, borderRadius: 8, background: "#fff4de", cursor: "pointer", fontWeight: 800, color: INK }}>✕</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 14 }}>
        {buildCalls(stations).map((g) => (
          <Fragment key={g.group}>
            <div>
              <div style={{ fontFamily: "DM Sans", fontWeight: 800, fontSize: 12, letterSpacing: ".1em", textTransform: "uppercase", color: g.color, marginBottom: 6 }}>{g.group}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {g.lines.map((l, i) => (
                  <Fragment key={i}>
                    <button data-testid="radio-call" onClick={() => { onCall(l); onClose(); }}
                      style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: 8, padding: "7px 9px", background: dark ? "#2f1d12" : "#fff9ec", border: "1.5px solid " + INK, borderRadius: 8, boxShadow: "1.5px 1.5px 0 0 " + INK, boxSizing: "border-box" }}>
                      <VoiceCue phrase={l} dark={dark} tone="live" style={{ fontSize: 12 }} />
                      <div style={{ flex: 1 }} />
                      <span style={{ fontFamily: "DM Sans", fontWeight: 800, fontSize: 12, letterSpacing: ".06em", textTransform: "uppercase", color: "#8a6a4f" }}>say it ›</span>
                    </button>
                  </Fragment>
                ))}
              </div>
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

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
      <div style={{ maxWidth: "88%", padding: "7px 11px", borderRadius: 12, border: "2px solid " + INK, background: getBubbleBg(me, dark), color: getBubbleColor(me, dark), boxShadow: "2px 2px 0 0 " + INK, fontFamily: "DM Sans", fontSize: 13, fontWeight: me ? 700 : 600, lineHeight: 1.35, borderBottomRightRadius: me ? 3 : 12, borderBottomLeftRadius: me ? 12 : 3 }}>
        {!me && <span style={{ fontFamily: "DM Sans", fontWeight: 800, fontSize: 12, letterSpacing: ".08em", textTransform: "uppercase", color: "#a8151a", display: "block", marginBottom: 2 }}>Chef de Cuisine</span>}
        {m.text}
        {g && g.sources && g.sources.length > 0 && (
          <div data-testid="radio-grounding" style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
            <span style={{ fontFamily: "JetBrains Mono", fontSize: 12, color: "#8a6a4f", textTransform: "uppercase", letterSpacing: ".06em" }}>grounded via</span>
            {g.sources.slice(0, 3).map((s, i) => (
              <a key={i} href={s.uri} target="_blank" rel="noreferrer" title={s.title || s.uri} style={{ fontFamily: "DM Sans", fontSize: 12, fontWeight: 700, color: "#2f7a5e", textDecoration: "underline", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title || s.uri}</a>
            ))}
          </div>
        )}
      </div>
      <span style={{ fontFamily: "JetBrains Mono", fontSize: 12, color: "#8a6a4f", padding: "0 4px" }}>{fmtTime(m.timestamp)}</span>
    </div>
  );
}

// The call sheet mirrors the LIVE line: "The Line" / "Order Pad" groups are built from the actual
// stations so a real pane "Webhook retries" surfaces "open webhook retries" (voice parity, brief §2.1).
// The static groups (Service mode / The Pass / Emergency) are stable global calls.
function buildCalls(stations: { name: string }[]): { group: string; color: string; lines: string[] }[] {
  const lineCalls = stations.slice(0, 6).map((s) => `open ${s.name.toLowerCase()}`);
  const first = stations[0]?.name?.toLowerCase();
  return [
    { group: "The Line", color: "#a8151a", lines: [...lineCalls, "what's on the line, Chef?"] },
    { group: "The Pass", color: "#c98a16", lines: ["fire it, Chef", "86 that one", "what's at the pass?"] },
    { group: "Service mode", color: "#4b3bb3", lines: ["let 'em cook", "taste every plate", "hands off — read only"] },
    { group: "The Order Pad", color: "#2f7a5e", lines: [first ? `tell ${first} to rerun the tests` : "send the order to the line", "send it to the line", "scrap that draft"] },
    { group: "Emergency", color: "#e23a3a", lines: ["ALL HANDS — stop the line", "kill the burners", "back to service"] },
  ];
}

export function KitchenRadio({
  dark, live, muted, reconnecting, connected, micBlocked, audioPlaying, approvalWaiting,
  transcript, voiceCues, stations, onGoLive, onStopLive, onToggleMute, onCall,
}: {
  dark: boolean; live: boolean; muted: boolean; reconnecting: boolean;
  /** 1B.5: the voice /live socket is actually OPEN — "● LIVE" gates on this, not on the click. */
  connected: boolean;
  /** 1B.5: getUserMedia denied/failed — the chip must say MIC BLOCKED, not "I'm listening". */
  micBlocked: boolean;
  /** bead 8fz.2: Janus audio is ACTUALLY playing (data.audioPlaying) — the chip's "speaking" rung. */
  audioPlaying: boolean;
  /** bead 8fz.2: a resolvable approval is on the attention queue (data.approvalWaiting) — the
   *  chip's "waiting" rung. */
  approvalWaiting: boolean;
  transcript: TranscriptEntry[];
  voiceCues: boolean; stations: { name: string }[]; onGoLive: () => void; onStopLive: () => void; onToggleMute: () => void; onCall: (phrase: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [calls, setCalls] = useState(false);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [transcript]);

  const listening = live && connected && !muted && !micBlocked;
  // bead 8fz.2: the chip reads the FULL 10-kind reducer directly (kind -> label + color) instead of
  // the retired getChipLabel/getChipBg boolean ladders. `executing` has no backing signal yet
  // (reserved for a follow-up wave that surfaces real dispatch/tool-write-in-flight telemetry).
  const convo = deriveConversationalState({
    live, connected, micBlocked, muted, reconnecting,
    speaking: audioPlaying, waiting: approvalWaiting, executing: false,
    toolActive: hasToolActivity(transcript),
  });

  function renderTranscriptBody() {
    return (
      <>
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
      </>
    );
  }

  function renderMicControl() {
    return (
      <div style={{ padding: 12, borderTop: "2px solid " + INK, background: getMicControlBg(dark) }}>
        {voiceCues && <div style={{ textAlign: "center", marginBottom: 8 }}><VoiceCue phrase="hey Chef, what's on the line?" dark={dark} tone="live" /></div>}
        {!live ? (
          <button data-testid="radio-golive" onClick={onGoLive} style={micBtn("#ffc94a")}>
            <Icon name="spark" size={18} /> {reconnecting ? "Tuning in…" : "Tune in the radio"}
          </button>
        ) : (
          <div style={{ display: "flex", gap: 8 }}>
            <button data-testid="radio-mute" onClick={onToggleMute} style={{ ...micBtn(getMicBtnBg(micBlocked, muted)), flex: 1 }}>
              <Icon name={getMicBtnIconName(micBlocked, muted)} size={18} /> {getMicBtnLabel(micBlocked, muted)}
            </button>
            <button data-testid="radio-stoplive" onClick={onStopLive} style={micBtn("#e23a3a")}>
              <Icon name="x" size={18} /> Sign off
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <aside data-testid="kitchen-radio" style={{ position: "relative", display: "flex", flexDirection: "column", minHeight: 0, background: getPanelBg(dark), height: "100%", overflow: "hidden" }}>
      {/* header */}
      <div style={{ padding: "12px 14px", background: INK, color: "#fff4de", display: "flex", alignItems: "center", gap: 10, borderBottom: "3px solid " + INK }}>
        <ChefDeCuisineMark size={42} live={listening} />
        <div style={{ flex: 1, lineHeight: 1.1, minWidth: 0 }}>
          <div style={{ fontFamily: "Caveat, cursive", fontSize: 15, color: "#ffc94a", transform: "rotate(-1.5deg)" }}>"runnin' the line"</div>
          <div style={{ fontFamily: "Fraunces, serif", fontWeight: 900, fontSize: 18 }}>Kitchen Radio</div>
        </div>
        <button onClick={() => setCalls((c) => !c)} title="What can I say?" style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 9px", borderRadius: 8, border: "2px solid #fff4de", background: calls ? "#ffc94a" : "transparent", color: calls ? INK : "#fff4de", cursor: "pointer", fontFamily: "DM Sans", fontWeight: 800, fontSize: 12, whiteSpace: "nowrap", flexShrink: 0 }}>🎙 calls</button>
        {/* 1B.5: LIVE means live — between the click and the socket opening the chip reads
            "TUNING IN…", and a blocked mic is named loudly instead of pretending to listen.
            velocity-mech: the conversational gloss rides the chip as a title (hover/AT readout).
            bead 8fz.2: role="status" + aria-live="polite" so a screen reader announces the turn
            state too — the label text only ever changes on a real kind TRANSITION (deriveConversat-
            ionalState returns the same stable string for an unchanged kind across re-renders, e.g.
            each streamed audio chunk), so this never spams one announcement per chunk. */}
        <span
          role="status"
          aria-live="polite"
          title={getChipHelper(live, micBlocked, connected, muted, reconnecting)}
          style={{ display: "inline-flex" }}
        >
          <Chip bg={chipColorForKind(convo.kind)} color="#fff4de" border="#fff4de">
            {convo.label}
          </Chip>
        </span>
      </div>

      {/* now-speaking waveform */}
      <div style={{ padding: "11px 14px", background: getWaveformSectionBg(dark), borderBottom: "2px solid " + INK, display: "flex", alignItems: "center", gap: 10 }}>
        <Icon name="chef-hat" size={18} color="#a8151a" />
        <Waveform active={listening} color={getWaveformColor(dark)} />
      </div>

      {/* transcript */}
      <div ref={scrollRef} data-testid="radio-transcript" style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
        {renderTranscriptBody()}
      </div>

      {/* mic control */}
      {renderMicControl()}

      {/* CALL SHEET — what you can say (hands-free reference). 2K.5: a real dialog (focus trap,
          Escape closes). */}
      {calls && <CallSheet dark={dark} stations={stations} onCall={onCall} onClose={() => setCalls(false)} />}
    </aside>
  );
}

function micBtn(bg: string): CSSProperties {
  return { width: "100%", padding: "11px", borderRadius: 12, border: "2px solid " + INK, background: bg, color: INK, cursor: "pointer", fontFamily: "DM Sans", fontWeight: 800, fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", gap: 8, boxShadow: "3px 3px 0 0 " + INK };
}
