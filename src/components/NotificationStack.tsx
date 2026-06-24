import { ProactiveNotification } from "../notificationStack";

/**
 * WS-D (BUG-024): the on-screen proactive-notification stack. Renders the coalesced
 * notifications (one entry per pane+severity; latest message wins). High-severity entries
 * are styled as alerts. Each entry is dismissible. Messages are already WS-B redacted by
 * the server.
 */
export function NotificationStack({
  notifications,
  onDismiss,
}: {
  notifications: ProactiveNotification[];
  onDismiss: (id: string) => void;
}) {
  if (notifications.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-40 flex flex-col gap-2 w-[340px] max-w-[90vw]"
      role="region"
      aria-label="Proactive notifications"
      aria-live="polite"
    >
      {notifications.map((n) => {
        const high = n.severity === "high";
        return (
          <div
            key={n.id}
            className={[
              "rounded-lg border px-4 py-3 shadow-lg shadow-black/60 backdrop-blur-sm",
              "animate-in slide-in-from-right-8 fade-in duration-200 flex items-start gap-3",
              high
                ? "bg-red-950/80 border-red-500/60"
                : "bg-[#111]/90 border-emerald-500/40",
            ].join(" ")}
          >
            <div
              className={[
                "flex-shrink-0 w-2.5 h-2.5 rounded-full mt-1.5",
                high ? "bg-red-500" : "bg-emerald-400",
              ].join(" ")}
            />
            <div className="flex-1 min-w-0">
              <div className="text-xs uppercase tracking-wide text-neutral-400 font-medium">
                {n.terminalId}
              </div>
              <div className="text-sm text-neutral-100 break-words">{n.message}</div>
            </div>
            <button
              onClick={() => onDismiss(n.id)}
              aria-label="Dismiss notification"
              className="flex-shrink-0 text-neutral-500 hover:text-neutral-200 text-lg leading-none"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
