/**
 * WS-D: SINGLE SOURCE OF TRUTH for per-announcement-kind metadata + the message-template
 * schema and its defaults.
 *
 * Previously the earcon mapping, severity bucket, priority ranking and template key were
 * spread across `announcementBus.ts`, `eventBus.ts`, `App.tsx` and `SettingsDialog.tsx` —
 * four copies that already drifted once (`exited` was mis-bucketed as normal severity while
 * carrying an `alert` earcon). This module collapses them into ONE compiler-enforced table:
 * adding a kind is a single object literal the type checker forces you to complete; there is
 * no second place to update.
 */

/** Status-keyed earcon vocabulary (App.tsx oscillator tones). */
export type EarconType = "completion" | "alert" | "success" | "execute" | "chime";

/** The earcon vocabulary as used by the client event bus, which may also yield "no earcon". */
export type EarconTypeOrNull = EarconType | null;

export type AnnouncementKind =
  | "completion"   // genuine WS-C Running->Idle edge (real work finished)
  | "error"        // error text detected
  | "build-failed" // build failure
  | "exited"       // process exited
  | "plan_completed"
  | "plan_paused";

/** The operator-editable template keys (Settings surface). */
export type TemplateKey =
  | "completion"
  | "error"
  | "buildFailed"
  | "exited"
  | "planCompleted"
  | "planPaused";

export interface KindMeta {
  /** Immediate non-verbal feedback tone. */
  earcon: EarconType;
  /** Severity bucket the notification stack groups by. */
  severity: "high" | "normal";
  /** Priority ranking — highest fires first when a coalescing window is flushed. */
  priority: number;
  /** Which operator-editable message template renders this kind. */
  templateKey: TemplateKey;
}

/**
 * The authoritative per-kind table. `Record<AnnouncementKind, KindMeta>` makes the compiler
 * reject any kind that omits a field or that is added without an entry here.
 *
 * `exited` is intentionally HIGH severity: it carries the `alert` earcon, gets its own
 * high-severity coalescing bucket, and is exempt from the per-pane debounce so a genuine
 * process exit is never starved by a preceding completion on the same pane (design §4).
 */
export const KIND_META: Record<AnnouncementKind, KindMeta> = {
  "build-failed": { earcon: "alert", severity: "high", priority: 5, templateKey: "buildFailed" },
  error:          { earcon: "alert", severity: "high", priority: 4, templateKey: "error" },
  exited:         { earcon: "alert", severity: "high", priority: 3, templateKey: "exited" },
  plan_paused:    { earcon: "alert", severity: "high", priority: 2, templateKey: "planPaused" },
  completion:     { earcon: "completion", severity: "normal", priority: 1, templateKey: "completion" },
  plan_completed: { earcon: "success", severity: "normal", priority: 0, templateKey: "planCompleted" },
};

/** Derived projections — never hand-maintained; always read from KIND_META. */
export const EARCON_FOR: Record<AnnouncementKind, EarconType> =
  Object.fromEntries(
    (Object.keys(KIND_META) as AnnouncementKind[]).map((k) => [k, KIND_META[k].earcon])
  ) as Record<AnnouncementKind, EarconType>;

export const PRIORITY: Record<AnnouncementKind, number> =
  Object.fromEntries(
    (Object.keys(KIND_META) as AnnouncementKind[]).map((k) => [k, KIND_META[k].priority])
  ) as Record<AnnouncementKind, number>;

export function severityOf(kind: AnnouncementKind): "high" | "normal" {
  return KIND_META[kind].severity;
}

export function isHighSeverity(kind: AnnouncementKind): boolean {
  return KIND_META[kind].severity === "high";
}

/** Operator-editable message templates (Settings surface). `{pane}` / `{summary}` are
 *  interpolated. Defaults are intentionally brief (maintainer Decision 2). */
export type AnnouncementTemplates = Record<TemplateKey, string>;

export const DEFAULT_ANNOUNCEMENT_TEMPLATES: AnnouncementTemplates = {
  completion: "Pane '{pane}' finished. {summary}",
  error: "Pane '{pane}' reported an error. {summary}",
  buildFailed: "Build failed on pane '{pane}'.",
  exited: "Pane '{pane}' exited.",
  planCompleted: "Plan completed. {summary}",
  planPaused: "Plan paused. {summary}",
};

/** Settings render order: [templateKey, human label]. The dialog drives its field list from
 *  this single array so the default strings are never re-typed by hand. */
export const ANNOUNCEMENT_TEMPLATE_FIELDS: ReadonlyArray<readonly [TemplateKey, string]> = [
  ["completion", "Completion"],
  ["error", "Error"],
  ["buildFailed", "Build failed"],
  ["exited", "Exited"],
  ["planCompleted", "Plan completed"],
  ["planPaused", "Plan paused"],
];

export function templateFor(kind: AnnouncementKind, t: AnnouncementTemplates): string {
  return t[KIND_META[kind].templateKey];
}
