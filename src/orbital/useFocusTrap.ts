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

// ── Pure decision types ──────────────────────────────────────────────────────

/** All inputs to the focus-trap key handler — no live DOM access. */
export interface FocusTrapKeyArgs {
  /** Whether this dialog is the top-most entry in the dialog stack. */
  isTopOverlay: boolean;
  /** e.key */
  key: string;
  /** e.shiftKey */
  shiftKey: boolean;
  /** Whether a HiTL approval/action dialog is currently mounted. */
  hitlMounted: boolean;
  /** Whether an onClose callback is registered. */
  hasOnClose: boolean;
  /**
   * Whether the container node (ref.current) is non-null.
   * Defaults to true when omitted — callers only pass false when the ref is null.
   */
  hasNode?: boolean;
  /** All focusable elements inside the container, in DOM order. */
  focusables: HTMLElement[];
  /** document.activeElement at the time of the event. */
  activeElement: Element | null;
  /** Whether the container node contains the activeElement. */
  containerContainsActive: boolean;
}

export type FocusTrapKeyDecision =
  | { type: "noop" }
  | { type: "escape-close" }
  | { type: "prevent-default-only" }
  | { type: "focus"; element: HTMLElement };

/**
 * Pure decision helper for the focus-trap keydown handler.
 *
 * Receives all inputs as plain values (no live DOM access) and returns a
 * decision describing what the DOM shell should do:
 *   - "noop"             — do nothing
 *   - "escape-close"     — stopPropagation + call onClose
 *   - "prevent-default-only" — preventDefault (no focus move)
 *   - "focus"            — preventDefault + focus the given element
 *
 * Exported so it can be unit-tested without a browser.
 */
export function handleFocusTrapKey(args: FocusTrapKeyArgs): FocusTrapKeyDecision {
  if (!args.isTopOverlay) return { type: "noop" };
  if (args.key === "Escape") return resolveEscape(args);
  if (args.key === "Tab" && args.hasNode !== false) return resolveTab(args);
  return { type: "noop" };
}

/** Resolve the Escape key: noop when HiTL owns it or there is no onClose. */
function resolveEscape(args: FocusTrapKeyArgs): FocusTrapKeyDecision {
  if (args.hitlMounted) return { type: "noop" };
  if (!args.hasOnClose) return { type: "noop" };
  return { type: "escape-close" };
}

/**
 * Resolve the Tab key: wraps focus at the boundary or prevents default when
 * there are no focusable children.  Active focus outside the container is
 * treated the same as "at the boundary" (re-enters the trap cleanly).
 */
function resolveTab(args: FocusTrapKeyArgs): FocusTrapKeyDecision {
  const { focusables, activeElement, containerContainsActive, shiftKey } = args;
  if (focusables.length === 0) return { type: "prevent-default-only" };
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (shiftKey && (activeElement === first || !containerContainsActive)) {
    return { type: "focus", element: last };
  }
  if (!shiftKey && (activeElement === last || !containerContainsActive)) {
    return { type: "focus", element: first };
  }
  return { type: "noop" };
}

// ── DOM shell ────────────────────────────────────────────────────────────────

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
      // Only query the focusable subtree for Tab (the sole consumer) — keeps the
      // original cost profile: a querySelectorAll must NOT run on every keydown
      // document-wide while a dialog is mounted. Non-Tab keys don't use `els`.
      const els = e.key === "Tab" && node ? focusables() : [];
      const decision = handleFocusTrapKey({
        isTopOverlay: dialogStack[dialogStack.length - 1] === id,
        key: e.key,
        shiftKey: e.shiftKey,
        hitlMounted: hitlDialogMounted(),
        hasOnClose: !!onCloseRef.current,
        hasNode: !!node,
        focusables: els,
        activeElement: document.activeElement,
        containerContainsActive: !!node?.contains(document.activeElement),
      });
      if (decision.type === "noop") return;
      if (decision.type === "escape-close") { e.stopPropagation(); onCloseRef.current!(); return; }
      e.preventDefault();
      if (decision.type === "focus") decision.element.focus();
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
