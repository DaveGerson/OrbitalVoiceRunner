// ── ORBITAL · ServiceMode switch ────────────────────────────────────────
// The headline autonomy lever. Maps 1:1 onto the backend globalPermissionsMode
// (auto→Full Auto, hitl→Human-in-the-Loop, read→Read-Only).
//
// 2K.4: escalating to FULL AUTO ("let 'em cook") is the single riskiest click in
// the kitchen, so it gets ONE inline confirm step — the button itself flips to
// "sure? tap again" for 3s (no modal stack). De-escalations (hitl/read) and the
// already-auto state stay one-tap. The voice/call-sheet path ("let 'em cook")
// stays direct: it's an explicit spoken phrase, and routing it through this
// click-side confirm would require a confirm seam in the voice dispatch.
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { INK, SERVICE_MODES, type ServiceModeId } from "./theme";
import { Icon } from "./primitives";

// ── Pure style helpers (module-level, no JSX) ─────────────────────────────

/** Returns the tooltip title for a service-mode button. */
export function getButtonTitle(confirming: boolean, label: string): string {
  return confirming
    ? "Full Auto lets every station fire without asking — tap again to confirm"
    : label;
}

/** Returns the CSS border value for a service-mode button. */
export function getButtonBorder(confirming: boolean): string {
  return confirming ? "2px dashed #fff4de" : "none";
}

/**
 * Returns the CSS background value for a service-mode button.
 * Priority: active > confirming > default.
 */
export function getButtonBackground(on: boolean, confirming: boolean, color: string): string {
  if (on) return color;
  if (confirming) return "#a8151a";
  return "transparent";
}

/**
 * Returns the CSS color value for a service-mode button.
 * Read-only active gets a light tint; all other active states use INK.
 */
export function getButtonColor(on: boolean, id: ServiceModeId): string {
  if (on) return id === "read" ? "#fff4de" : INK;
  return "#ffe9c7";
}

/** Returns the data-confirming attribute value (true when confirming, else undefined). */
export function getConfirmingAttr(confirming: boolean): true | undefined {
  return confirming || undefined;
}

// ── Inline render helper (returns ReactNode, not a React component) ────────

/** Renders the inner label span content for a service-mode button. */
function renderButtonLabel(
  on: boolean,
  confirming: boolean,
  kitchen: string,
  label: string,
): ReactNode {
  return (
    <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", lineHeight: 1.05 }}>
      <span>{confirming ? "sure? tap again" : kitchen}</span>
      {on && !confirming && <span style={{ fontSize: 12, fontWeight: 600, opacity: .8, fontFamily: "JetBrains Mono" }}>{label}</span>}
      {confirming && <span style={{ fontSize: 12, fontWeight: 600, opacity: .8, fontFamily: "JetBrains Mono" }}>no asking after this</span>}
    </span>
  );
}

export function ServiceMode({ mode, setMode }: { mode: ServiceModeId; setMode: (id: ServiceModeId) => void }) {
  const [confirmingAuto, setConfirmingAuto] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onPick = (id: ServiceModeId) => {
    if (id === "auto" && mode !== "auto" && !confirmingAuto) {
      setConfirmingAuto(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setConfirmingAuto(false), 3000);
      return;
    }
    setConfirmingAuto(false);
    setMode(id);
  };

  return (
    <div data-testid="service-mode" style={{ display: "flex", alignItems: "center", gap: 6, background: INK, padding: 4, borderRadius: 11, border: "2px solid " + INK }}>
      {SERVICE_MODES.map((m) => {
        const on = mode === m.id;
        const confirming = m.id === "auto" && confirmingAuto;
        return (
          <button key={m.id} data-testid={`service-${m.id}`} aria-pressed={on} data-confirming={getConfirmingAttr(confirming)}
            onClick={() => onPick(m.id)}
            title={getButtonTitle(confirming, m.label)} style={{
            display: "flex", alignItems: "center", gap: 7, padding: "6px 11px", borderRadius: 8, cursor: "pointer",
            border: getButtonBorder(confirming),
            background: getButtonBackground(on, confirming, m.color),
            color: getButtonColor(on, m.id),
            fontFamily: "DM Sans", fontWeight: 800, fontSize: 12.5, whiteSpace: "nowrap", transition: "all 140ms var(--ease-bounce)",
          }}>
            <Icon name={m.icon} size={15} />
            {renderButtonLabel(on, confirming, m.kitchen, m.label)}
          </button>
        );
      })}
    </div>
  );
}
