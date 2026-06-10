// Desktop notifications for the kitchen (2K.6) — a port of the classic app's
// triggerDesktopNotification (src/App.tsx:243), background-only by design:
// the kitchen narrates everything in the foreground already (toast + radio
// transcript), so a desktop note only fires when the tab is actually hidden.
// All paths are try/caught — a denied/absent Notification API degrades silently.

/** Fire a desktop notification ONLY when the document is hidden and permission is granted. */
export function notifyDesktop(title: string, body: string): void {
  try {
    if (typeof document === "undefined" || !document.hidden) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    new Notification(title, { body });
  } catch { /* blocked/unsupported — degrade silently */ }
}

/**
 * Ask for notification permission. Must be called from a user gesture (the
 * kitchen calls it on the first radio tune-in). No-op once decided.
 */
export function requestNotifyPermission(): void {
  try {
    if ("Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  } catch { /* unsupported — degrade silently */ }
}
