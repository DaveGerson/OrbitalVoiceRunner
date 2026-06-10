// ── ORBITAL · Back of House (settings rooms) ────────────────────────────
// The admin/settings area, reskinned as restaurant back-of-house "rooms". Per the
// UX brief this surface is CALM — no mascots, no scribbles, no whimsy (those are
// Line-only). Every room is wired to the REAL settings backend (GET/PUT /api/settings)
// or is an explicit, visibly-disabled placeholder. Nothing here is fake.
//   • The Rulebook   — the capability-gate matrix (Auto/Ask/Off), the safety dial.
//   • Chef de Cuisine — global autonomy posture + the voice (Gemini) settings.
//   • The Walk-In    — the one cold key Orbital keeps (Gemini); masked, set-only.
//   • The Boiler Room — advanced PTY/idle plumbing.
//   • The Recipe Card — the raw live config (read-only mirror).
//   • Loading Dock / Boss's Office — integrations / budget: disabled placeholders.
import { Fragment, useState, type CSSProperties, type ReactNode } from "react";
import { INK, SERVICE_MODES, type ServiceModeId } from "./../theme";
import { Button, Chip, Icon } from "./../primitives";
import { CAPABILITY_CATEGORIES, CAPABILITY_LABELS } from "../../gateSurface";
import { DEFAULT_CAPABILITY_GATES, type SystemSettings, type CapabilityGateMap, type CapabilityGate, type GateValue } from "../../types";

type RoomId = "rulebook" | "chef" | "walkin" | "boiler" | "recipe" | "dock" | "boss";
const ROOMS: { id: RoomId; label: string; icon: string; sub: string; live: boolean }[] = [
  { id: "rulebook", label: "The Rulebook", icon: "menu", sub: "who can do what", live: true },
  { id: "chef", label: "Chef de Cuisine", icon: "chef-hat", sub: "the voice & autonomy", live: true },
  { id: "walkin", label: "The Walk-In", icon: "salt", sub: "the cold key", live: true },
  { id: "boiler", label: "The Boiler Room", icon: "spark", sub: "advanced plumbing", live: true },
  { id: "recipe", label: "The Recipe Card", icon: "ticket", sub: "raw config", live: true },
  { id: "dock", label: "The Loading Dock", icon: "plus", sub: "integrations", live: false },
  { id: "boss", label: "Boss's Office", icon: "user", sub: "the budget", live: false },
];

const GATES: { v: GateValue; word: string; tip: string; bg: string }[] = [
  { v: "Auto", word: "let 'em cook", tip: "fires on its own", bg: "#4db892" },
  { v: "Ask", word: "to the pass", tip: "brings it to you", bg: "#ffc94a" },
  { v: "Off", word: "not in my kitchen", tip: "blocked", bg: "#e23a3a" },
];

function GateSeg({ value, onChange }: { value: GateValue; onChange: (v: GateValue) => void }) {
  return (
    <div style={{ display: "flex", gap: 0, border: "2px solid " + INK, borderRadius: 8, overflow: "hidden", flexShrink: 0 }}>
      {GATES.map((g, i) => {
        const on = value === g.v;
        return (
          <Fragment key={g.v}>
            <button data-testid={`gate-${g.v}`} title={g.tip} aria-pressed={on} onClick={() => onChange(g.v)}
              style={{ padding: "4px 9px", border: "none", borderLeft: i ? "2px solid " + INK : "none", background: on ? g.bg : "transparent", color: INK, cursor: "pointer", fontFamily: "DM Sans", fontWeight: 800, fontSize: 11, whiteSpace: "nowrap" }}>
              {g.v}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}

function Room({ emoji, title, sub, color, children }: { emoji: string; title: string; sub: string; color: string; children: ReactNode }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", background: color, border: "3px solid " + INK, borderRadius: 14, boxShadow: "4px 4px 0 0 " + INK, marginBottom: 16 }}>
        <span style={{ fontSize: 26 }}>{emoji}</span>
        <div>
          <div style={{ fontFamily: "Fraunces, serif", fontWeight: 900, fontSize: 22, color: INK, lineHeight: 1 }}>{title}</div>
          <div style={{ fontFamily: "DM Sans", fontSize: 12.5, fontWeight: 600, color: INK, opacity: .75, marginTop: 2 }}>{sub}</div>
        </div>
      </div>
      {children}
    </div>
  );
}

function Card({ dark, children }: { dark: boolean; children: ReactNode }) {
  return <div style={{ background: dark ? "#241409" : "#fff9ec", border: "2px solid " + INK, borderRadius: 12, padding: 16, marginBottom: 12, boxShadow: "3px 3px 0 0 " + INK }}>{children}</div>;
}
function Lbl({ children, dark }: { children: ReactNode; dark: boolean }) {
  return <div style={{ fontFamily: "DM Sans", fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".08em", color: dark ? "#c89f74" : "#5b3a23", marginBottom: 6 }}>{children}</div>;
}
function fieldStyle(dark: boolean): CSSProperties {
  return { width: "100%", padding: "9px 11px", border: "2px solid " + INK, borderRadius: 9, background: dark ? "#1a0f08" : "#fff4de", color: dark ? "#ffe9c7" : INK, fontFamily: "DM Sans", fontSize: 13.5, fontWeight: 600, outline: "none", boxSizing: "border-box" };
}

// 2K.2: one live pane the Rulebook can scope to — id/name plus its CURRENT per-pane override
// map (from the ledger; absent ⇒ the pane inherits the global default).
export interface RulebookPane {
  id: string;
  name: string;
  project: string;
  overrides?: Partial<CapabilityGateMap>;
}

export function BackOfHouse({ dark, settings, globalMode, setGlobalMode, saveSettings, panes = [], setPaneGates }: {
  dark: boolean;
  settings: SystemSettings | null;
  globalMode: "Full Auto" | "Human-in-the-Loop" | "Read-Only" | "Inherit";
  setGlobalMode: (m: "Full Auto" | "Human-in-the-Loop" | "Read-Only") => void;
  saveSettings: (next: SystemSettings) => void;
  /** 2K.2: live panes for the Rulebook's pane scope. */
  panes?: RulebookPane[];
  /** 2K.2: PUT the pane's whole override map (…/capability-gates). */
  setPaneGates?: (projectId: string, paneId: string, gates: Record<string, string>) => void;
}) {
  const [room, setRoom] = useState<RoomId>("rulebook");
  // 2K.2: the Rulebook's scope — "kitchen" (the global map, existing behavior) or one live pane
  // (its override map, PUT to the per-pane capability-gates route). Falls back to kitchen scope
  // if the scoped pane disappears (closed/archived).
  const [scope, setScope] = useState<string>("kitchen");
  const scopedPane = scope !== "kitchen" ? panes.find((p) => p.id === scope) : undefined;
  const fg = dark ? "#ffe9c7" : INK;

  // The configured global gate map, seeded with the real safe defaults so unset caps show their true
  // effective gate (never a misleading all-Auto). Writing a gate persists the full map.
  const globalGates: CapabilityGateMap = { ...DEFAULT_CAPABILITY_GATES, ...(settings?.advanced?.capabilityGates ?? {}) };
  // Pane scope: the pane's override wins per-capability; anything unset inherits the global value.
  const gates: CapabilityGateMap = scopedPane ? { ...globalGates, ...(scopedPane.overrides ?? {}) } : globalGates;
  const setGate = (cap: CapabilityGate, v: GateValue) => {
    if (scopedPane) {
      // Write {existing override + this change} so untouched capabilities keep inheriting.
      setPaneGates?.(scopedPane.project, scopedPane.id, { ...(scopedPane.overrides ?? {}), [cap]: v });
      return;
    }
    if (!settings) return;
    saveSettings({ ...settings, advanced: { ...settings.advanced, capabilityGates: { ...globalGates, [cap]: v } } });
  };
  const patchVoice = (patch: Partial<SystemSettings["voiceAi"]>) => { if (settings) saveSettings({ ...settings, voiceAi: { ...settings.voiceAi, ...patch } }); };
  const patchAdvanced = (patch: Partial<SystemSettings["advanced"]>) => { if (settings) saveSettings({ ...settings, advanced: { ...settings.advanced, ...patch } }); };

  return (
    <div style={{ flex: 1, display: "flex", overflow: "hidden", minHeight: 0, background: dark ? "#1a0f08" : "var(--cream)" }}>
      {/* room nav (calm — no mascots) */}
      <aside style={{ width: 230, flexShrink: 0, borderRight: "3px solid " + INK, background: dark ? "#241409" : "#fff4de", padding: 12, overflowY: "auto" }}>
        <div style={{ fontFamily: "Fraunces, serif", fontWeight: 900, fontSize: 16, color: fg, padding: "4px 8px 10px" }}>Back of House</div>
        {ROOMS.map((r) => {
          const on = room === r.id;
          return (
            <Fragment key={r.id}>
              <button data-testid={`boh-room-${r.id}`} aria-pressed={on} onClick={() => setRoom(r.id)}
                style={{ width: "100%", display: "flex", alignItems: "center", gap: 9, padding: "9px 10px", marginBottom: 4, borderRadius: 9, border: on ? "2px solid " + INK : "2px solid transparent", background: on ? "#ffc94a" : "transparent", color: on ? INK : fg, cursor: "pointer", textAlign: "left", boxShadow: on ? "2px 2px 0 0 " + INK : "none" }}>
                <Icon name={r.icon} size={16} color={on ? INK : "#a8151a"} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontFamily: "DM Sans", fontWeight: 800, fontSize: 13 }}>{r.label}</span>
                  <span style={{ display: "block", fontFamily: "DM Sans", fontSize: 10.5, opacity: .7 }}>{r.sub}</span>
                </span>
                {!r.live && <Chip bg={dark ? "#1a0f08" : "#fff9ec"} color="#8a6a4f">soon</Chip>}
              </button>
            </Fragment>
          );
        })}
      </aside>

      {/* room body */}
      <div data-testid="boh-body" style={{ flex: 1, overflowY: "auto", padding: 24, minWidth: 0 }}>
        {!settings && <div style={{ fontFamily: "DM Sans", fontSize: 14, fontWeight: 600, color: "#8a6a4f" }}>loading the house…</div>}

        {settings && room === "rulebook" && (
          <Room emoji="📋" title="The Rulebook" sub={`"Auto" fires on its own · "Ask" brings it to the pass · "Off" — not in my kitchen`} color="#ffc94a">
            {/* 2K.2: scope — the whole kitchen (global map) or one live station (its override map). */}
            <Card dark={dark}>
              <Lbl dark={dark}>Who do these rules apply to?</Lbl>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <button data-testid="rulebook-scope-kitchen" aria-pressed={!scopedPane} onClick={() => setScope("kitchen")}
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 999, border: "2px solid " + INK, cursor: "pointer", background: !scopedPane ? "#ffc94a" : (dark ? "#1a0f08" : "#fff4de"), color: !scopedPane ? INK : fg, fontFamily: "DM Sans", fontWeight: 800, fontSize: 12.5, boxShadow: !scopedPane ? "2px 2px 0 0 " + INK : "none" }}>
                  🍽 Whole kitchen
                </button>
                {panes.map((p) => {
                  const on = scopedPane?.id === p.id;
                  return (
                    <Fragment key={p.id}>
                      <button data-testid={`rulebook-scope-${p.id}`} aria-pressed={on} onClick={() => setScope(p.id)}
                        style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 999, border: "2px solid " + INK, cursor: "pointer", background: on ? "#4db892" : (dark ? "#1a0f08" : "#fff4de"), color: on ? INK : fg, fontFamily: "DM Sans", fontWeight: 800, fontSize: 12.5, boxShadow: on ? "2px 2px 0 0 " + INK : "none" }}>
                        {p.name}
                      </button>
                    </Fragment>
                  );
                })}
              </div>
              <div data-testid="rulebook-scope-note" style={{ fontFamily: "DM Sans", fontSize: 11.5, color: "#8a6a4f", marginTop: 8 }}>
                {scopedPane
                  ? <>Tuning <strong>{scopedPane.name}</strong> only — its overrides win; anything you don't touch keeps following the kitchen rule.</>
                  : <>Kitchen-wide defaults — every station follows these unless you tune it individually above.</>}
              </div>
            </Card>
            {Object.entries(CAPABILITY_CATEGORIES).map(([cat, caps]) => (
              <Fragment key={cat}>
                <Card dark={dark}>
                  <Lbl dark={dark}>{cat}</Lbl>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {caps.map((cap) => (
                      <Fragment key={cap}>
                        <div data-testid={`rule-${cap}`} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <span style={{ flex: 1, minWidth: 0, fontFamily: "DM Sans", fontSize: 13, fontWeight: 600, color: fg }}>{CAPABILITY_LABELS[cap] ?? cap}</span>
                          <GateSeg value={gates[cap]} onChange={(v) => setGate(cap, v)} />
                        </div>
                      </Fragment>
                    ))}
                  </div>
                </Card>
              </Fragment>
            ))}
          </Room>
        )}

        {settings && room === "chef" && (
          <Room emoji="👨‍🍳" title="Chef de Cuisine" sub="the global default — pick a single station in the Rulebook's scope row to tune just that pane" color="#ff8a3d">
            <Card dark={dark}>
              <Lbl dark={dark}>Service mode (global autonomy)</Lbl>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {SERVICE_MODES.map((m) => {
                  const on = (globalMode === "Inherit" ? "Human-in-the-Loop" : globalMode) === m.mode;
                  return (
                    <Fragment key={m.id}>
                      <button data-testid={`boh-mode-${m.id as ServiceModeId}`} aria-pressed={on} onClick={() => setGlobalMode(m.mode)}
                        style={{ flex: 1, minWidth: 150, textAlign: "left", padding: "10px 12px", borderRadius: 10, border: "2px solid " + INK, background: on ? m.color : (dark ? "#1a0f08" : "#fff4de"), color: on ? "#fff4de" : fg, cursor: "pointer", boxShadow: on ? "3px 3px 0 0 " + INK : "none" }}>
                        <div style={{ fontFamily: "DM Sans", fontWeight: 800, fontSize: 13 }}>{m.kitchen}</div>
                        <div style={{ fontFamily: "DM Sans", fontSize: 11, opacity: .85 }}>{m.label} · {m.sub}</div>
                      </button>
                    </Fragment>
                  );
                })}
              </div>
            </Card>
            <Card dark={dark}>
              <Lbl dark={dark}>The Chef's voice</Lbl>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <label style={{ flex: 1, minWidth: 160 }}>
                  <div style={{ fontFamily: "DM Sans", fontSize: 11, fontWeight: 700, color: "#8a6a4f", marginBottom: 4 }}>Voice</div>
                  <select data-testid="boh-voice" value={settings.voiceAi.voice} onChange={(e) => patchVoice({ voice: e.target.value })} style={fieldStyle(dark)}>
                    {["Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Aoede"].map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </label>
                <label style={{ flex: 1, minWidth: 160 }}>
                  <div style={{ fontFamily: "DM Sans", fontSize: 11, fontWeight: 700, color: "#8a6a4f", marginBottom: 4 }}>Volume · {Math.round((settings.voiceAi.volume ?? 1) * (settings.voiceAi.volume > 1 ? 1 : 100))}%</div>
                  <input data-testid="boh-volume" type="range" min={0} max={100} value={Math.round((settings.voiceAi.volume > 1 ? settings.voiceAi.volume : settings.voiceAi.volume * 100))} onChange={(e) => patchVoice({ volume: Number(e.target.value) / 100 })} style={{ width: "100%" }} />
                </label>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, cursor: "pointer" }}>
                <input type="checkbox" checked={!!settings.voiceAi.groundingEnabled} onChange={(e) => patchVoice({ groundingEnabled: e.target.checked })} />
                <span style={{ fontFamily: "DM Sans", fontSize: 13, fontWeight: 600, color: fg }}>Let the Chef look things up (web grounding)</span>
              </label>
            </Card>
          </Room>
        )}

        {settings && room === "walkin" && (
          <Room emoji="🧊" title="The Walk-In" sub="the only key Orbital keeps cold — your coding CLIs sign in themselves" color="#4db892">
            <Card dark={dark}>
              <Lbl dark={dark}>Gemini API key (the voice)</Lbl>
              <WalkInKey dark={dark} masked={settings.secrets.geminiApiKey} onSave={(key) => saveSettings({ ...settings, secrets: { ...settings.secrets, geminiApiKey: key } })} />
            </Card>
          </Room>
        )}

        {settings && room === "boiler" && (
          <Room emoji="🔧" title="The Boiler Room" sub="advanced plumbing — change with care, Chef" color="#8a6a4f">
            <Card dark={dark}>
              {([
                ["maxBufferLines", "Scrollback buffer (lines)"],
                ["idleTimeoutMs", "Idle timeout (ms)"],
                ["agentIdleTimeoutMs", "Agent idle timeout (ms)"],
                ["historyMaxCommands", "History — max commands"],
              ] as const).map(([key, label]) => (
                <Fragment key={key}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                    <span style={{ flex: 1, fontFamily: "DM Sans", fontSize: 13, fontWeight: 600, color: fg }}>{label}</span>
                    <input data-testid={`boiler-${key}`} type="number" defaultValue={settings.advanced[key] ?? undefined}
                      onBlur={(e) => { const n = Number(e.target.value); if (Number.isFinite(n) && n > 0) patchAdvanced({ [key]: n } as Partial<SystemSettings["advanced"]>); }}
                      style={{ ...fieldStyle(dark), width: 140 }} />
                  </div>
                </Fragment>
              ))}
              <div style={{ fontFamily: "DM Sans", fontSize: 11.5, color: "#8a6a4f", marginTop: 4 }}>Saved when you tab out of a field.</div>
            </Card>
          </Room>
        )}

        {settings && room === "recipe" && (
          <Room emoji="🧾" title="The Recipe Card" sub="the raw config, exactly as the kitchen reads it" color="#4b3bb3">
            <Card dark={dark}>
              <pre data-testid="boh-recipe" style={{ margin: 0, fontFamily: "JetBrains Mono, monospace", fontSize: 11.5, lineHeight: 1.5, color: fg, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 520, overflowY: "auto" }}>
                {JSON.stringify(settings, null, 2)}
              </pre>
            </Card>
          </Room>
        )}

        {room === "dock" && <DisabledRoom dark={dark} emoji="📦" title="The Loading Dock" sub="integrations — GitHub, Jira, Linear" blurb="No deliveries wired up yet. When integrations land, you'll hook them up here." />}
        {room === "boss" && <DisabledRoom dark={dark} emoji="💰" title="Boss's Office" sub="the budget" blurb="Spend tracking isn't plumbed yet. The numbers go here when the books are open." />}
      </div>
    </div>
  );
}

function WalkInKey({ dark, masked, onSave }: { dark: boolean; masked: string; onSave: (key: string) => void }) {
  const [val, setVal] = useState("");
  const configured = masked && (masked.includes("•") || masked === "CONFIGURED_IN_ENV" || masked.length > 0);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <Chip bg={configured ? "#4db892" : "#e23a3a"} color="#fff4de">{configured ? "● a key is in the walk-in" : "no key yet"}</Chip>
        {configured && <span style={{ fontFamily: "JetBrains Mono", fontSize: 11, color: "#8a6a4f" }}>{masked === "CONFIGURED_IN_ENV" ? "(from environment)" : masked.slice(0, 6) + "…"}</span>}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input data-testid="boh-key-input" type="password" value={val} onChange={(e) => setVal(e.target.value)} placeholder="paste a new key to replace it…" style={{ ...fieldStyle(dark), flex: 1, fontFamily: "JetBrains Mono" }} />
        <Button variant="mint" icon="check" disabled={!val.trim()} onClick={() => { onSave(val.trim()); setVal(""); }}>Stock it</Button>
      </div>
      <div style={{ fontFamily: "DM Sans", fontSize: 11.5, color: "#8a6a4f", marginTop: 8 }}>Leave blank to keep the current key. Orbital never shows it back to you.</div>
    </div>
  );
}

function DisabledRoom({ dark, emoji, title, sub, blurb }: { dark: boolean; emoji: string; title: string; sub: string; blurb: string }) {
  return (
    <Room emoji={emoji} title={title} sub={sub} color={dark ? "#3a2415" : "#e7d5b5"}>
      <div data-testid="boh-disabled" style={{ opacity: .65, background: dark ? "#241409" : "#fff9ec", border: "2px dashed " + INK, borderRadius: 12, padding: 28, textAlign: "center" }}>
        <div style={{ fontFamily: "DM Sans", fontSize: 13.5, fontWeight: 600, color: dark ? "#c89f74" : "#5b3a23", maxWidth: 420, margin: "0 auto" }}>{blurb}</div>
      </div>
    </Room>
  );
}
