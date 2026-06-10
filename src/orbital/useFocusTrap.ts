// ── ORBITAL · shared dialog semantics (2K.5) ────────────────────────────
// One small hook for every kitchen overlay: initial focus, a Tab/Shift+Tab
// focus trap, Escape-to-close, and focus restoration on unmount. No deps.
//
// Stacking: kitchen overlays can sit on top of each other (burner → call
// sheet) AND under the shared HiTL dialogs (ApprovalDialog/ActionConfirmDialog,
// which own their own isTop Escape handling at z-260). A module-level stack
// makes Escape close the TOP-most kitchen overlay only (Phase 1's 1B.2 rule,
// extended), and a mounted HiTL dialog suppresses kitchen Escape entirely so
// one keypress can never both reject an approval and close the burner.
import { useEffect, useRef, type RefObject } from "react";

const dialogStack: symbol[] = [];

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** A shared HiTL dialog is mounted above everything — it owns Escape (1B.2). */
function hitlDialogMounted(): boolean {
  return !!document.querySelector('[data-testid="approval-dialog"], [data-testid="action-dialog"]');
}

/**
 * Attach to a dialog container (give it tabIndex={-1}). Returns the ref.
 * `onClose` (optional) is fired on Escape when this overlay is top-most.
 */
export function useDialog<T extends HTMLElement>(onClose?: () => void): RefObject<T> {
  const ref = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const id = Symbol("orb-dialog");
    dialogStack.push(id);
    const node = ref.current;
    const prevFocus = document.activeElement as HTMLElement | null;
    const focusables = (): HTMLElement[] =>
      node ? Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
    // Initial focus: the first focusable control, else the container itself.
    (focusables()[0] ?? node)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== id) return; // top-most kitchen overlay only
      if (e.key === "Escape") {
        if (hitlDialogMounted()) return; // the HiTL dialog owns Escape while mounted
        if (onCloseRef.current) { e.stopPropagation(); onCloseRef.current(); }
        return;
      }
      if (e.key === "Tab" && node) {
        const els = focusables();
        if (els.length === 0) { e.preventDefault(); return; }
        const first = els[0];
        const last = els[els.length - 1];
        const active = document.activeElement;
        const inside = node.contains(active);
        if (e.shiftKey && (active === first || !inside)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (active === last || !inside)) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const i = dialogStack.indexOf(id);
      if (i >= 0) dialogStack.splice(i, 1);
      try { prevFocus?.focus(); } catch { /* unmounted */ }
    };
  }, []);

  return ref;
}
