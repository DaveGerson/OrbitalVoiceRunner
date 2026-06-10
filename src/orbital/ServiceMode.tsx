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
import { useEffect, useRef, useState } from "react";
import { INK, SERVICE_MODES, type ServiceModeId } from "./theme";
import { Icon } from "./primitives";

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
          <button key={m.id} data-testid={`service-${m.id}`} aria-pressed={on} data-confirming={confirming || undefined}
            onClick={() => onPick(m.id)}
            title={confirming ? "Full Auto lets every station fire without asking — tap again to confirm" : m.label} style={{
            display: "flex", alignItems: "center", gap: 7, padding: "6px 11px", borderRadius: 8, cursor: "pointer",
            border: confirming ? "2px dashed #fff4de" : "none",
            background: on ? m.color : confirming ? "#a8151a" : "transparent",
            color: on ? (m.id === "read" ? "#fff4de" : INK) : "#ffe9c7",
            fontFamily: "DM Sans", fontWeight: 800, fontSize: 12.5, whiteSpace: "nowrap", transition: "all 140ms var(--ease-bounce)",
          }}>
            <Icon name={m.icon} size={15} />
            <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", lineHeight: 1.05 }}>
              <span>{confirming ? "sure? tap again" : m.kitchen}</span>
              {on && !confirming && <span style={{ fontSize: 9, fontWeight: 600, opacity: .8, fontFamily: "JetBrains Mono" }}>{m.label}</span>}
              {confirming && <span style={{ fontSize: 9, fontWeight: 600, opacity: .8, fontFamily: "JetBrains Mono" }}>no asking after this</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
