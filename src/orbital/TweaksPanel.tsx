// ── ORBITAL · Tweaks panel (product) ────────────────────────────────────
// A real, always-available preferences flyout (the design's tweaks-panel.jsx
// was a design-time edit-mode harness). Kitchen-skinned controls; state flows
// through useTweaks (localStorage).
import { useState, type ReactNode } from "react";
import { INK } from "./theme";
import { Icon } from "./primitives";

export function TweakSection({ label }: { label: string }) {
  return <div style={{ fontFamily: "DM Sans", fontWeight: 800, fontSize: 12, letterSpacing: ".1em", textTransform: "uppercase", color: "#8a6a4f", padding: "8px 0 2px" }}>{label}</div>;
}

export function TweakRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, justifyContent: "space-between" }}>
      <span style={{ fontFamily: "DM Sans", fontSize: 12.5, fontWeight: 700, color: INK }}>{label}</span>
      {children}
    </div>
  );
}

export function TweakRadio<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: readonly T[]; onChange: (v: T) => void;
}) {
  return (
    <TweakRow label={label}>
      <div style={{ display: "flex", gap: 3, background: INK, padding: 3, borderRadius: 8 }}>
        {options.map((o) => {
          const on = value === o;
          return (
            <button key={o} onClick={() => onChange(o)} style={{
              padding: "3px 9px", borderRadius: 5, border: "none", cursor: "pointer",
              background: on ? "#ffc94a" : "transparent", color: on ? INK : "#c89f74",
              fontFamily: "DM Sans", fontSize: 12, fontWeight: 800, textTransform: "capitalize",
            }}>{o}</button>
          );
        })}
      </div>
    </TweakRow>
  );
}

export function TweakToggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <TweakRow label={label}>
      <button onClick={() => onChange(!value)} role="switch" aria-checked={value} aria-label={label} style={{
        width: 42, height: 24, borderRadius: 999, border: "2px solid " + INK, cursor: "pointer", position: "relative",
        background: value ? "#4db892" : "#f3e4c2", transition: "background 160ms",
      }}>
        <span style={{ position: "absolute", top: 1, left: value ? 19 : 1, width: 16, height: 16, borderRadius: "50%", background: "#fff4de", border: "2px solid " + INK, transition: "left 160ms var(--ease-bounce)" }} />
      </button>
    </TweakRow>
  );
}

export function TweakColor({ label, value, options, onChange }: {
  label: string; value: string; options: { key: string; hex: string }[]; onChange: (key: string) => void;
}) {
  return (
    <TweakRow label={label}>
      <div style={{ display: "flex", gap: 8 }}>
        {options.map((o) => (
          <button key={o.key} onClick={() => onChange(o.key)} aria-label={o.key} style={{
            width: 26, height: 26, borderRadius: "50%", border: "2px solid " + INK, cursor: "pointer", background: o.hex,
            boxShadow: value === o.hex ? "0 0 0 3px var(--butter), 2px 2px 0 0 " + INK : "2px 2px 0 0 " + INK,
          }} />
        ))}
      </div>
    </TweakRow>
  );
}

export function TweaksPanel({ title = "Tweaks", children }: { title?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button data-testid="tweaks-toggle" onClick={() => setOpen(true)} title="Tweaks" style={{
        position: "fixed", right: 16, bottom: 16, zIndex: 120, width: 44, height: 44, borderRadius: 12,
        border: "2px solid " + INK, background: "#fff9ec", cursor: "pointer", boxShadow: "3px 3px 0 0 " + INK,
        display: "grid", placeItems: "center",
      }}><Icon name="spark" size={20} color={INK} /></button>
    );
  }
  return (
    <div data-testid="tweaks-panel" style={{
      position: "fixed", right: 16, bottom: 16, zIndex: 120, width: 280, maxHeight: "calc(100vh - 32px)",
      display: "flex", flexDirection: "column", background: "#fff9ec", color: INK,
      border: "2px solid " + INK, borderRadius: 14, boxShadow: "5px 5px 0 0 " + INK, overflow: "hidden",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: "2px solid " + INK, background: "#ffc94a" }}>
        <b style={{ fontFamily: "Fraunces, serif", fontWeight: 900, fontSize: 16 }}>{title}</b>
        <button aria-label="Close tweaks" onClick={() => setOpen(false)} style={{ width: 26, height: 26, border: "2px solid " + INK, borderRadius: 7, background: "#fff4de", cursor: "pointer", fontWeight: 800, color: INK }}>✕</button>
      </div>
      <div style={{ padding: "6px 14px 14px", display: "flex", flexDirection: "column", gap: 9, overflowY: "auto" }}>{children}</div>
    </div>
  );
}
