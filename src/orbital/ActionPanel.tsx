// ── ORBITAL · Action Panel (hwu.7) ─────────────────────────────────────────
// A deterministic, READ-ONLY sidebar region that re-keys to the agent's most recent completed
// voice tool call (the `action_activity` WS frame). Voice stays terse; this panel carries the
// depth. It AUGMENTS the attention inbox (which lives in ThePass) — it never replaces the inbox or
// its approve/deny flow, and it emits no mutations.
//
// The name→view mapping is a pure, deterministic lookup (exported for unit tests). Every branch has
// a safe fallback: an unknown tool renders a generic summary card, a gating-refusal string renders
// as a refusal (never as cached data), a deferred kind:"pending" renders an "awaiting approval"
// card (never as a completed result), and a malformed payload never blanks or crashes the panel.
import { INK } from "./theme";
import type { ActionActivityFrame, ActionActivityPayload } from "../types";

// ── Pure view model + picker (exported for tests) ───────────────────────────

export type ActionPanelView =
  | { view: "sitrep"; title: string; body: string; truncated: boolean }
  | { view: "notes"; title: string; rows: string[]; truncated: boolean }
  | { view: "digest"; title: string; body: string; truncated: boolean }
  | { view: "refusal"; title: string; body: string }
  | { view: "awaiting"; title: string; body: string }
  | { view: "error"; title: string; body: string }
  | { view: "generic"; title: string; body: string; truncated: boolean };

/** Deterministic name→view family for a kind:"ok" result. Absent names fall to the generic card. */
const OK_VIEW_BY_NAME: Record<string, "sitrep" | "notes" | "digest"> = {
  get_status_summary: "sitrep",
  get_project_notes: "notes",
  search_notes: "notes",
  catch_me_up: "digest",
};

const TITLE_BY_NAME: Record<string, string> = {
  get_status_summary: "Status Summary",
  get_project_notes: "Project Notes",
  search_notes: "Note Search",
  catch_me_up: "Catch-Up Digest",
};

function titleFor(name: string): string {
  return TITLE_BY_NAME[name] ?? name;
}

/** Render any structured output to a display string (prose passes through; objects pretty-print). */
export function stringifyOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output == null) return "";
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

/** One display row for a note/search item — prefers a text-ish field, else the raw JSON. */
function rowText(item: unknown): string {
  if (typeof item === "string") return item;
  if (item && typeof item === "object") {
    const o = item as Record<string, unknown>;
    const t = o.text ?? o.snippet ?? o.summary ?? o.content;
    if (typeof t === "string") return t;
  }
  return JSON.stringify(item);
}

/** Extract the note/search rows from an ok-output object, or null if it is not a list payload. */
export function noteRowsFrom(output: unknown): string[] | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  const list = Array.isArray(o.notes) ? o.notes : Array.isArray(o.results) ? o.results : null;
  return list ? list.map(rowText) : null;
}

/** notes/search family: a string output is a gating refusal/miss (render it, NOT cached data). */
function pickNotesView(name: string, p: ActionActivityPayload, truncated: boolean): ActionPanelView {
  if (typeof p.output === "string" && !truncated) {
    return { view: "refusal", title: titleFor(name), body: p.output };
  }
  const rows = noteRowsFrom(p.output);
  if (rows) return { view: "notes", title: titleFor(name), rows, truncated };
  return { view: "generic", title: titleFor(name), body: stringifyOutput(p.output), truncated };
}

/** kind:"ok" routing by tool name. */
function pickOkView(name: string, p: ActionActivityPayload): ActionPanelView {
  const truncated = !!p.truncated;
  const family = OK_VIEW_BY_NAME[name];
  if (family === "notes") return pickNotesView(name, p, truncated);
  if (family === "sitrep") return { view: "sitrep", title: titleFor(name), body: stringifyOutput(p.output), truncated };
  if (family === "digest") return { view: "digest", title: titleFor(name), body: stringifyOutput(p.output), truncated };
  return { view: "generic", title: titleFor(name), body: stringifyOutput(p.output), truncated };
}

/**
 * The pure name→view picker. A deferred kind:"pending" is an "awaiting approval" card (never a
 * result); kind:"blocked" is a refusal; kind:"error"/"clarify" render their message. Everything
 * else (kind:"ok" or an unrecognized kind) routes by tool name, with a generic fallback.
 */
export function pickActionView(frame: ActionActivityFrame): ActionPanelView {
  const { name, payload: p } = frame;
  if (p.kind === "pending") {
    return { view: "awaiting", title: titleFor(name), body: p.summary ?? "This action is waiting for your approval." };
  }
  if (p.kind === "blocked") {
    return { view: "refusal", title: titleFor(name), body: p.reason ?? "This action was blocked by policy." };
  }
  if (p.kind === "error") {
    return { view: "error", title: titleFor(name), body: p.message ?? "Something went wrong." };
  }
  if (p.kind === "clarify") {
    return { view: "generic", title: titleFor(name), body: p.message ?? "", truncated: !!p.truncated };
  }
  return pickOkView(name, p);
}

// ── The component ───────────────────────────────────────────────────────────

const ACCENT_BY_VIEW: Record<ActionPanelView["view"], string> = {
  sitrep: "#4b3bb3",
  notes: "#4db892",
  digest: "#ff8a3d",
  refusal: "#e23a3a",
  awaiting: "#ffc94a",
  error: "#e23a3a",
  generic: "#8a7a6a",
};

function palette(dark: boolean) {
  return {
    surface: dark ? "#221610" : "#fffdf7",
    text: dark ? "#f4e9dc" : INK,
    subtle: dark ? "#b59d86" : "#8a7a6a",
    border: dark ? "#3a2415" : "#e7cfa0",
  };
}

function ViewBody({ v, dark }: { v: ActionPanelView; dark: boolean }) {
  const c = palette(dark);
  if (v.view === "notes") {
    if (v.rows.length === 0) return <div style={{ color: c.subtle, fontStyle: "italic" }}>No matching notes.</div>;
    return (
      <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 6 }}>
        {v.rows.map((r, i) => (
          <li key={i} style={{ color: c.text, lineHeight: 1.4 }}>{r}</li>
        ))}
      </ul>
    );
  }
  const mono = v.view === "generic";
  return (
    <div
      style={{
        color: c.text,
        lineHeight: 1.5,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontFamily: mono ? "ui-monospace, monospace" : "inherit",
        fontSize: mono ? 12 : 14,
      }}
    >
      {v.body || <span style={{ color: c.subtle, fontStyle: "italic" }}>Nothing to show.</span>}
    </div>
  );
}

/**
 * The read-only action panel. `frame` is the most recent completed tool call (null before any
 * call — renders nothing so the sidebar layout is byte-identical at rest). The root element is
 * keyed by callId, so the panel re-keys (fresh mount) per completed call.
 */
export function ActionPanel({ frame, dark }: { frame: ActionActivityFrame | null; dark: boolean }) {
  if (!frame) return null;
  const v = pickActionView(frame);
  const c = palette(dark);
  const accent = ACCENT_BY_VIEW[v.view];
  return (
    // key={callId} on the root element re-keys the panel per completed tool call (a fresh mount,
    // resetting scroll/transition state) — done on this intrinsic element rather than on the
    // <ActionPanel> call site so it doesn't depend on custom-component key typing.
    <section
      key={frame.callId}
      aria-label="Action panel"
      data-testid="action-panel"
      data-view={v.view}
      style={{
        flexShrink: 0,
        maxHeight: "38%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: c.surface,
        borderTop: "3px solid " + c.border,
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          borderLeft: "4px solid " + accent,
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 13, color: c.text, letterSpacing: 0.3 }}>{v.title}</span>
        {"truncated" in v && v.truncated ? (
          <span style={{ fontSize: 12, fontWeight: 700, color: "#e23a3a" }}>TRUNCATED</span>
        ) : null}
        <span style={{ marginLeft: "auto", fontSize: 12, textTransform: "uppercase", color: c.subtle }}>{v.view}</span>
      </header>
      <div style={{ padding: "0 12px 12px", overflowY: "auto", minHeight: 0 }}>
        <ViewBody v={v} dark={dark} />
      </div>
    </section>
  );
}
