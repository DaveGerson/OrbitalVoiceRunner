// ── ORBITAL · shared kitchen primitives ─────────────────────────────────
// Faithful TSX port of the design's kitchen/components.jsx. Visuals match the
// prototype (inline styles, exact hex); props are typed; data is real.
import { useState, type CSSProperties, type ReactNode } from "react";
import iconSprite from "./assets/icons.svg?raw";
import { INK, STATUS, CHEFS, type ChefKey, type StationStatus } from "./theme";

/** Inject the SVG symbol sheet once. Mount near the app root. */
export function IconSprite() {
  return <div style={{ display: "none" }} aria-hidden dangerouslySetInnerHTML={{ __html: iconSprite }} />;
}

export function Icon({ name, size = 18, color = "currentColor", style = {} }: {
  name: string; size?: number; color?: string; style?: CSSProperties;
}) {
  return (
    <svg width={size} height={size} style={{ color, flexShrink: 0, ...style }} aria-hidden>
      <use href={`#i-${name}`} />
    </svg>
  );
}

export type MascotVariant = "default" | "running" | "panic" | "wink";
const MASCOT_SRC: Record<MascotVariant, string> = {
  default: "/orbital/mascot-chef.svg",
  running: "/orbital/mascot-chef-running.svg",
  panic: "/orbital/mascot-chef-panic.svg",
  wink: "/orbital/mascot-chef-winking.svg",
};
export function Mascot({ variant = "default", size = 80, style = {} }: {
  variant?: MascotVariant; size?: number; style?: CSSProperties;
}) {
  return <img src={MASCOT_SRC[variant]} width={size} alt="" style={{ display: "block", ...style }} />;
}

export function Chip({ children, color = INK, bg = "#fff9ec", border = INK, style = {} }: {
  children: ReactNode; color?: string; bg?: string; border?: string; style?: CSSProperties;
}) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 999,
      border: `1.5px solid ${border}`, background: bg, color,
      fontFamily: "DM Sans, sans-serif", fontSize: 10, fontWeight: 800,
      letterSpacing: ".06em", textTransform: "uppercase", whiteSpace: "nowrap", lineHeight: 1.5, ...style,
    }}>{children}</span>
  );
}

export type ButtonVariant = "default" | "primary" | "butter" | "mint" | "blueberry" | "ghost";
export function Button({ children, variant = "default", size = "md", onClick, style = {}, icon, title, disabled }: {
  children?: ReactNode; variant?: ButtonVariant; size?: "sm" | "md" | "lg";
  onClick?: () => void; style?: CSSProperties; icon?: string; title?: string; disabled?: boolean;
}) {
  const palettes: Record<ButtonVariant, { bg: string; fg: string }> = {
    default:   { bg: "#fff9ec", fg: INK },
    primary:   { bg: "#e23a3a", fg: "#fff4de" },
    butter:    { bg: "#ffc94a", fg: INK },
    mint:      { bg: "#4db892", fg: INK },
    blueberry: { bg: "#4b3bb3", fg: "#fff4de" },
    ghost:     { bg: "transparent", fg: INK },
  };
  const p = palettes[variant] || palettes.default;
  const pad = size === "sm" ? "5px 10px" : size === "lg" ? "12px 20px" : "8px 14px";
  const fs = size === "sm" ? 12 : size === "lg" ? 15 : 13;
  const [hover, setHover] = useState(false);
  const [press, setPress] = useState(false);
  const shadow = variant === "ghost" ? "none" : press ? "none" : hover ? "4px 4px 0 0 " + INK : "2px 2px 0 0 " + INK;
  const translate = press ? "translate(2px,2px)" : hover ? "translate(-1px,-1px)" : "translate(0,0)";
  return (
    <button onClick={disabled ? undefined : onClick} title={title} disabled={disabled}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => { setHover(false); setPress(false); }}
      onMouseDown={() => setPress(true)} onMouseUp={() => setPress(false)}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
        padding: pad, borderRadius: 10,
        border: variant === "ghost" ? `2px dashed ${INK}55` : `2px solid ${INK}`,
        background: p.bg, color: p.fg,
        fontFamily: "DM Sans, sans-serif", fontSize: fs, fontWeight: 800,
        letterSpacing: ".01em", cursor: disabled ? "not-allowed" : "pointer", whiteSpace: "nowrap", lineHeight: 1.2,
        boxShadow: disabled ? "none" : shadow, transform: disabled ? "none" : translate, opacity: disabled ? 0.5 : 1,
        transition: "transform 120ms cubic-bezier(.34,1.56,.64,1), box-shadow 120ms", ...style,
      }}>
      {icon && <Icon name={icon} size={fs + 2} />}
      {children}
    </button>
  );
}

export function ChefAvatar({ chefKey, size = 24 }: { chefKey: ChefKey; size?: number }) {
  const c = CHEFS[chefKey] || { color: "#d4a15a", initials: "??" };
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%", background: c.color, border: "1.5px solid " + INK,
      display: "grid", placeItems: "center", flexShrink: 0,
      fontFamily: "Fraunces, serif", fontWeight: 900, fontSize: size * 0.42, color: INK,
    }}>{c.initials}</div>
  );
}

// progress pips → little pie-crust squares
export function Pips({ steps, done, color }: { steps: number; done: number; color: string }) {
  const n = Math.max(0, Math.min(steps, 40));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
      <div style={{ display: "flex", gap: 2 }}>
        {Array.from({ length: n }).map((_, i) => (
          <div key={i} style={{ width: 9, height: 9, borderRadius: 2, background: i < done ? color : "#f3e4c2", border: "1.5px solid " + INK }} />
        ))}
      </div>
      <span style={{ fontFamily: "JetBrains Mono", fontSize: 10, fontWeight: 700, color: "#5b3a23" }}>{done}/{steps}</span>
    </div>
  );
}

// Status badge — keeps the literal pane word, dresses it kitchen.
export function StatusBadge({ status }: { status: StationStatus }) {
  const s = STATUS[status];
  const live = status === "Running";
  return (
    <span data-testid="status-badge" data-status={status} style={{
      display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 9px 3px 7px", borderRadius: 999,
      border: "1.5px solid " + INK, background: s.color, color: INK,
      fontFamily: "DM Sans", fontSize: 10, fontWeight: 800, letterSpacing: ".05em", textTransform: "uppercase", whiteSpace: "nowrap",
    }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: INK, animation: live ? "orb-pulse 1s var(--ease-bounce) infinite" : "none" }} />
      {s.word}
    </span>
  );
}

// VOICE CUE — the spoken call for any clickable thing. Hands-free first.
export function VoiceCue({ phrase, dark, style = {}, tone = "muted" }: {
  phrase: string; dark?: boolean; style?: CSSProperties; tone?: "muted" | "live";
}) {
  const c = tone === "live" ? "#a8151a" : dark ? "#c89f74" : "#8a6a4f";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4, maxWidth: "100%",
      fontFamily: "JetBrains Mono, monospace", fontSize: 10, fontWeight: 600, color: c,
      letterSpacing: "-.01em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", ...style,
    }}>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden>
        <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><line x1="12" y1="18" x2="12" y2="21" />
      </svg>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>"{phrase}"</span>
    </span>
  );
}
