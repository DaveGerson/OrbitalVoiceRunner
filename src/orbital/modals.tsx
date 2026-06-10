// ── ORBITAL · modals (New Pane / New Project) ───────────────────────────
// Ported from the shell's ModalShell + NewPaneModal/NewProjectModal. Outputs
// map straight onto the real createPane/createProject backend calls.
import { Fragment, useState, type CSSProperties, type ReactNode } from "react";
import { INK, PROJECT_COLORS, PROJECT_EMOJIS } from "./theme";
import { Button, Mascot, type MascotVariant } from "./primitives";
import { useDialog } from "./useFocusTrap";
import type { StationProject } from "./station";

function ModalShell({ dark, accent, mascot, title, scribble, onClose, children, footer }: {
  dark: boolean; accent: string; mascot?: MascotVariant; title: string; scribble: string;
  onClose: () => void; children: ReactNode; footer: ReactNode;
}) {
  // 2K.5: shared dialog semantics — initial focus, focus trap, Escape closes (top-most only).
  const dialogRef = useDialog<HTMLDivElement>(onClose);
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(42,26,16,.6)", zIndex: 220, display: "grid", placeItems: "center", padding: 20 }}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}
        onClick={(e) => e.stopPropagation()} className="orb-pop-in" data-testid="orbital-modal" style={{ width: "min(480px, 95vw)", background: dark ? "#241409" : "#fff9ec", border: "3px solid " + INK, borderRadius: 16, boxShadow: "8px 8px 0 0 " + INK, overflow: "hidden", outline: "none" }}>
        <div style={{ padding: "14px 16px", background: accent, borderBottom: "3px solid " + INK, display: "flex", alignItems: "center", gap: 12 }}>
          {mascot && <Mascot variant={mascot} size={50} />}
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "Caveat, cursive", fontSize: 17, color: "#a8151a", transform: "rotate(-2deg)", marginBottom: -2 }}>{scribble}</div>
            <div style={{ fontFamily: "Fraunces, serif", fontWeight: 900, fontSize: 24, color: INK, letterSpacing: "-.01em" }}>{title}</div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ width: 32, height: 32, border: "2px solid " + INK, borderRadius: 8, background: "#fff4de", cursor: "pointer", fontWeight: 800, color: INK }}>✕</button>
        </div>
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>{children}</div>
        <div style={{ padding: "12px 18px", borderTop: "2px solid " + INK, background: dark ? "#2f1d12" : "#fff4de", display: "flex", justifyContent: "flex-end", gap: 8 }}>{footer}</div>
      </div>
    </div>
  );
}

function FieldLbl({ children, dark }: { children: ReactNode; dark: boolean }) {
  return <span style={{ fontFamily: "DM Sans", fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: ".08em", color: dark ? "#c89f74" : "#5b3a23" }}>{children}</span>;
}
const modalInput = (dark: boolean): CSSProperties => ({ width: "100%", padding: "9px 11px", border: "2px solid " + INK, borderRadius: 9, background: dark ? "#241409" : "#fff4de", color: dark ? "#ffe9c7" : INK, fontFamily: "DM Sans", fontSize: 13.5, fontWeight: 600, outline: "none", boxShadow: "inset 2px 2px 0 0 #00000010", boxSizing: "border-box" });
function Pill({ on, onClick, children, dark }: { on: boolean; onClick: () => void; children: ReactNode; dark: boolean }) {
  return <button onClick={onClick} style={{ padding: "7px 13px", borderRadius: 999, border: "2px solid " + INK, cursor: "pointer", background: on ? "#ffc94a" : dark ? "#241409" : "#fff4de", color: dark && !on ? "#ffe9c7" : INK, fontFamily: "DM Sans", fontWeight: 800, fontSize: 12.5, boxShadow: on ? "2px 2px 0 0 " + INK : "none" }}>{children}</button>;
}

const CLIS: [string, string][] = [["Claude Code", "Claude Code"], ["Codex", "Codex"], ["Antigravity", "Antigravity"], ["Custom", "Custom"]];
const PERMS: [string, string][] = [["Full Auto", "let 'em cook"], ["Human-in-the-Loop", "taste every plate"], ["Read-Only", "hands off"]];

export function NewPaneModal({ projectId, projects, dark, onClose, onCreate }: {
  projectId: string; projects: StationProject[]; dark: boolean; onClose: () => void;
  onCreate: (o: { name: string; projectId: string; toolPreset: string; permissionsMode: string }) => void;
}) {
  const [name, setName] = useState("");
  const [project, setProject] = useState(projectId === "all" ? (projects[0]?.id ?? "") : projectId);
  const [toolPreset, setToolPreset] = useState("Claude Code");
  const [perm, setPerm] = useState("Human-in-the-Loop");
  return (
    <ModalShell dark={dark} accent="#ffc94a" mascot="wink" title="Fire up a pane" scribble="what're we cookin'?" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon="fire" onClick={() => onCreate({ name, projectId: project, toolPreset, permissionsMode: perm })}>Fire it up</Button></>}>
      <label style={{ display: "flex", flexDirection: "column", gap: 5 }}><FieldLbl dark={dark}>What's it working on?</FieldLbl>
        <input data-testid="newpane-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Webhook retries" style={modalInput(dark)} /></label>
      <label style={{ display: "flex", flexDirection: "column", gap: 5 }}><FieldLbl dark={dark}>Project</FieldLbl>
        <select value={project} onChange={(e) => setProject(e.target.value)} style={modalInput(dark)}>{projects.map((p) => <option key={p.id} value={p.id}>{p.emoji} {p.name}</option>)}</select></label>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}><FieldLbl dark={dark}>Which CLI?</FieldLbl>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{CLIS.map(([v, l]) => <Fragment key={v}><Pill on={toolPreset === v} onClick={() => setToolPreset(v)} dark={dark}>{l}</Pill></Fragment>)}</div></div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}><FieldLbl dark={dark}>Permissions</FieldLbl>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{PERMS.map(([v, l]) => <Fragment key={v}><Pill on={perm === v} onClick={() => setPerm(v)} dark={dark}>{l}</Pill></Fragment>)}</div></div>
    </ModalShell>
  );
}

export function NewProjectModal({ dark, onClose, onCreate }: {
  dark: boolean; onClose: () => void; onCreate: (o: { name: string; directory: string; emoji: string; color: string }) => void;
}) {
  const [name, setName] = useState("");
  const [directory, setDirectory] = useState("");
  const [emoji, setEmoji] = useState("🍳");
  const [color, setColor] = useState(PROJECT_COLORS[0]);
  return (
    <ModalShell dark={dark} accent="#4db892" mascot="default" title="Open a kitchen" scribble="a whole new menu!" onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="mint" icon="plus" onClick={() => onCreate({ name, directory, emoji, color })}>Open it up</Button></>}>
      <label style={{ display: "flex", flexDirection: "column", gap: 5 }}><FieldLbl dark={dark}>Project name</FieldLbl>
        <input data-testid="newproject-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Notifications service" style={modalInput(dark)} /></label>
      <label style={{ display: "flex", flexDirection: "column", gap: 5 }}><FieldLbl dark={dark}>Working directory</FieldLbl>
        <input value={directory} onChange={(e) => setDirectory(e.target.value)} placeholder="~/code/notifications" style={{ ...modalInput(dark), fontFamily: "JetBrains Mono" }} /></label>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}><FieldLbl dark={dark}>Sign</FieldLbl>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{PROJECT_EMOJIS.map((e) => <button key={e} onClick={() => setEmoji(e)} style={{ width: 40, height: 40, fontSize: 20, borderRadius: 9, border: "2px solid " + INK, cursor: "pointer", background: emoji === e ? "#ffc94a" : dark ? "#241409" : "#fff4de", boxShadow: emoji === e ? "2px 2px 0 0 " + INK : "none" }}>{e}</button>)}</div></div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}><FieldLbl dark={dark}>Accent</FieldLbl>
        <div style={{ display: "flex", gap: 8 }}>{PROJECT_COLORS.map((c) => <button key={c} aria-label={c} onClick={() => setColor(c)} style={{ width: 34, height: 34, borderRadius: "50%", border: "2px solid " + INK, cursor: "pointer", background: c, boxShadow: color === c ? "0 0 0 3px var(--butter), 2px 2px 0 0 " + INK : "2px 2px 0 0 " + INK }} />)}</div></div>
    </ModalShell>
  );
}
