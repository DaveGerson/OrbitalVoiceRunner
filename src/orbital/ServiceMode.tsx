// ── ORBITAL · ServiceMode switch ────────────────────────────────────────
// The headline autonomy lever. Maps 1:1 onto the backend globalPermissionsMode
// (auto→Full Auto, hitl→Human-in-the-Loop, read→Read-Only).
import { INK, SERVICE_MODES, type ServiceModeId } from "./theme";
import { Icon } from "./primitives";

export function ServiceMode({ mode, setMode }: { mode: ServiceModeId; setMode: (id: ServiceModeId) => void }) {
  return (
    <div data-testid="service-mode" style={{ display: "flex", alignItems: "center", gap: 6, background: INK, padding: 4, borderRadius: 11, border: "2px solid " + INK }}>
      {SERVICE_MODES.map((m) => {
        const on = mode === m.id;
        return (
          <button key={m.id} data-testid={`service-${m.id}`} aria-pressed={on} onClick={() => setMode(m.id)} title={m.label} style={{
            display: "flex", alignItems: "center", gap: 7, padding: "6px 11px", borderRadius: 8, cursor: "pointer", border: "none",
            background: on ? m.color : "transparent", color: on ? (m.id === "read" ? "#fff4de" : INK) : "#ffe9c7",
            fontFamily: "DM Sans", fontWeight: 800, fontSize: 12.5, whiteSpace: "nowrap", transition: "all 140ms var(--ease-bounce)",
          }}>
            <Icon name={m.icon} size={15} />
            <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", lineHeight: 1.05 }}>
              <span>{m.kitchen}</span>
              {on && <span style={{ fontSize: 9, fontWeight: 600, opacity: .8, fontFamily: "JetBrains Mono" }}>{m.label}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
