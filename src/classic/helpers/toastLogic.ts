// src/classic/helpers/toastLogic.ts — pure tone→presentation derivation for the classic
// raw-control-key outcome toast, hoisted out of src/App.tsx's ToastNotificationStack IIFE so the
// inline `tone === "deferred" ? ... : ...` ternaries live in one tested place. The toast carries a
// `tone` of "blocked" | "deferred" | "refused"; ONLY "deferred" gets the amber/⏳ treatment, every
// other tone falls through to the red/⛔ treatment (verbatim with the former inline App logic).

export type RawKeyTone = "blocked" | "deferred" | "refused";

/** Tailwind border+text classes for the toast container, by tone. */
export function rawKeyToneContainerClass(tone: RawKeyTone): string {
  return tone === "deferred"
    ? "border-amber-500/30 text-amber-400"
    : "border-red-500/30 text-red-400";
}

/** Tailwind text color for the toast title row, by tone. */
export function rawKeyToneTitleClass(tone: RawKeyTone): string {
  return tone === "deferred" ? "text-amber-500" : "text-red-500";
}

/** Leading glyph (with trailing space, verbatim) prefixed to the toast title, by tone. */
export function rawKeyToneGlyph(tone: RawKeyTone): string {
  return tone === "deferred" ? "⏳ " : "⛔ ";
}
