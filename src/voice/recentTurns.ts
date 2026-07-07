// src/voice/recentTurns.ts — the small, BOUNDED server-side ring buffer of the most recent completed
// transcript turns (hwu.3, "save that as a note"). It is the ONE source the save_transcript_note verb
// reads to capture "the last thing said" without re-plumbing the interaction log.
//
// SEAM (per hwu.3 riskNote): the voice loop (src/voice/index.ts) pushes exactly ONE entry per COMPLETED
// transcript turn — the operator's finalized ASR line (handleOperatorUtterance) and Janus's finalized
// spoken line (handleModelUtterance). It must NEVER be updated per audio frame / per keystroke: push is
// O(1) and the two call sites already fire once per turn. Appending in the audio-frame handler instead
// would degrade the voice path — that is the sabotage this module's contract guards against.
//
// This is a PROCESS-GLOBAL singleton (`recentTurns`), not per-connection: OrbitalVoiceRunner drives one
// live operator voice session at a time, and "save the last thing said" is inherently about that single
// live conversation. The buffer is bounded (fixed capacity, oldest evicted) so it can never grow
// unbounded regardless of session length. The raw text is stored VERBATIM (untruncated) — redaction is
// applied by the CONSUMER (save_transcript_note) immediately before persistence, never here, so the
// live transcript stays faithful and the ledger stays secret-free.

/** Which side of the conversation a turn came from. Mirrors StoredNote.author (src/store/types.ts). */
export type TurnAuthor = "janus" | "user";

/** One completed transcript turn: who spoke, the finalized (untruncated) text, and when. */
export interface TranscriptTurn {
  author: TurnAuthor;
  text: string;
  at: number; // epoch ms
}

/** Default capacity — a handful of turns is all "save the last thing said" ever needs; bounded so a
 *  long session can never grow the buffer. */
export const DEFAULT_RECENT_TURNS_CAPACITY = 24;

/**
 * A fixed-capacity circular buffer of completed transcript turns. `push` is O(1) (a single slot write
 * + index bump — NO array shift), so wiring it into the per-turn voice hooks adds no measurable cost.
 * `latest` walks backwards from newest (bounded by capacity) to find the most recent turn, optionally
 * filtered by author.
 */
export class RecentTurnsBuffer {
  private readonly cap: number;
  private readonly slots: Array<TranscriptTurn | undefined>;
  private next = 0;  // index of the next write slot
  private count = 0; // number of filled slots (0..cap)

  constructor(capacity: number = DEFAULT_RECENT_TURNS_CAPACITY) {
    this.cap = Math.max(1, Math.floor(capacity));
    this.slots = new Array<TranscriptTurn | undefined>(this.cap);
  }

  /** Append one completed turn. O(1). Empty/whitespace text is IGNORED (never store an empty turn), so
   *  the buffer only ever holds saveable content. `at` defaults to now. */
  push(author: TurnAuthor, text: string, at: number = Date.now()): void {
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (!trimmed) return;
    this.slots[this.next] = { author, text: trimmed, at };
    this.next = (this.next + 1) % this.cap;
    if (this.count < this.cap) this.count += 1;
  }

  /** The most recent turn (optionally restricted to one author), or null when there is none. */
  latest(author?: TurnAuthor): TranscriptTurn | null {
    for (let i = 0; i < this.count; i += 1) {
      const idx = (this.next - 1 - i + this.cap * 2) % this.cap;
      const turn = this.slots[idx];
      if (turn && (!author || turn.author === author)) return turn;
    }
    return null;
  }

  /** Number of turns currently buffered (bounded by capacity). */
  size(): number {
    return this.count;
  }

  /** Drop every buffered turn (test setup / session reset). */
  clear(): void {
    this.next = 0;
    this.count = 0;
    this.slots.fill(undefined);
  }
}

/** The process-global recent-turns ring the voice loop appends to and save_transcript_note reads. */
export const recentTurns = new RecentTurnsBuffer();
