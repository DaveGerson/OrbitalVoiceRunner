// ── ORBITAL · Emergency Stop (All Hands) ────────────────────────────────
// Two-stage panic, ported from radio.jsx. Stage 1 = frozen (server already
// froze Janus when the modal opened); hold-to-fire kills the burners (Stage 2).
// onKill → stop-all/confirm · onClose → stop-all/release + dismiss.
import { useEffect, useRef, useState } from "react";
import { INK } from "./theme";
import { Button, Chip, Mascot } from "./primitives";

export function EmergencyStop({ onClose, onKill, runningCount }: { onClose: () => void; onKill: () => void; runningCount: number }) {
  const [stage, setStage] = useState<1 | 2>(1);
  const [hold, setHold] = useState(0);
  const holdTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const startHold = () => {
    if (holdTimer.current) return;
    holdTimer.current = setInterval(() => {
      setHold((h) => {
        if (h >= 100) { if (holdTimer.current) clearInterval(holdTimer.current); holdTimer.current = null; onKill(); setStage(2); return 100; }
        return h + 7;
      });
    }, 40);
  };
  const endHold = () => { if (holdTimer.current) { clearInterval(holdTimer.current); holdTimer.current = null; } if (stage === 1) setHold(0); };
  useEffect(() => () => { if (holdTimer.current) clearInterval(holdTimer.current); }, []);

  return (
    <div data-testid="emergency-stop" style={{ position: "fixed", inset: 0, zIndex: 300, display: "grid", placeItems: "center", padding: 20 }}>
      <div className="orb-siren" style={{ position: "absolute", inset: 0 }} />
      <div className="orb-shake" onClick={(e) => e.stopPropagation()} style={{ position: "relative", width: "min(560px, 94vw)", background: "#fff4de", border: "4px solid " + INK, borderRadius: 18, boxShadow: "10px 10px 0 0 " + INK, overflow: "hidden" }}>
        <div style={{ height: 16, backgroundImage: "repeating-linear-gradient(45deg, #2a1a10 0 14px, #ffc94a 14px 28px)" }} />
        {stage === 1 ? (
          <div style={{ padding: "22px 24px 26px", textAlign: "center" }}>
            <div style={{ position: "absolute", top: 26, right: 18 }}><Mascot variant="panic" size={92} style={{ animation: "orb-jiggle 0.4s linear infinite" }} /></div>
            <Chip bg="#e23a3a" color="#fff4de" style={{ fontSize: 11 }}>🚨 emergency brake · stage 1</Chip>
            <h2 style={{ fontFamily: "Fraunces, serif", fontWeight: 900, fontSize: 40, lineHeight: 1, color: "#a8151a", margin: "12px 0 6px", letterSpacing: "-.02em" }}>ALL HANDS!</h2>
            <p style={{ fontFamily: "Caveat, cursive", fontSize: 24, color: "#e23a3a", transform: "rotate(-1.5deg)", margin: "0 0 12px" }}>"86 the line — everybody stop!"</p>
            <p style={{ fontFamily: "DM Sans", fontSize: 14, fontWeight: 600, color: "#5b3a23", maxWidth: 400, margin: "0 auto 18px", lineHeight: 1.45 }}>
              The Chef de Cuisine is <strong>frozen</strong> and every in-flight order is cancelled. The burners are <strong>still hot</strong> — {runningCount} stations are running. Hold the kill switch to cut the gas, or release the brake to get back to service.
            </p>
            <button data-testid="hold-to-kill" onMouseDown={startHold} onMouseUp={endHold} onMouseLeave={endHold} onTouchStart={startHold} onTouchEnd={endHold}
              style={{ position: "relative", width: "100%", padding: "16px", borderRadius: 12, border: "3px solid " + INK, background: "#e23a3a", color: "#fff4de", cursor: "pointer", fontFamily: "Fraunces, serif", fontWeight: 900, fontSize: 18, overflow: "hidden", boxShadow: "4px 4px 0 0 " + INK, marginBottom: 12 }}>
              <div style={{ position: "absolute", inset: 0, width: hold + "%", background: "#a8151a", transition: "width 40ms linear" }} />
              <span style={{ position: "relative" }}>{hold > 0 ? `CUTTING THE GAS… ${hold}%` : `🔥 HOLD to kill ${runningCount} burners`}</span>
            </button>
            <Button variant="mint" icon="check" style={{ width: "100%", justifyContent: "center" }} onClick={onClose}>Release the brake — back to service</Button>
          </div>
        ) : (
          <div style={{ padding: "26px 24px 28px", textAlign: "center" }}>
            <div style={{ position: "absolute", top: 28, right: 20 }}><Mascot variant="default" size={88} /></div>
            <Chip bg="#2a1a10" color="#fff4de" style={{ fontSize: 11 }}>kitchen closed · stage 2</Chip>
            <h2 style={{ fontFamily: "Fraunces, serif", fontWeight: 900, fontSize: 38, lineHeight: 1, color: INK, margin: "12px 0 6px" }}>Gas is off.</h2>
            <p style={{ fontFamily: "Caveat, cursive", fontSize: 24, color: "#2f7a5e", transform: "rotate(-1.5deg)", margin: "0 0 14px" }}>"every burner's out, Chef."</p>
            <p style={{ fontFamily: "DM Sans", fontSize: 14, fontWeight: 600, color: "#5b3a23", maxWidth: 380, margin: "0 auto 20px", lineHeight: 1.45 }}>
              All {runningCount} running stations were killed. Nothing's cooking. Open them back up from the line whenever you're ready to fire again.
            </p>
            <Button variant="primary" icon="play" style={{ width: "100%", justifyContent: "center" }} onClick={onClose}>Re-open the kitchen</Button>
          </div>
        )}
      </div>
    </div>
  );
}
