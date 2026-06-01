/**
 * terminalStream — a tiny per-terminal pub/sub bridge between the WebSocket layer
 * and the xterm instance.
 *
 * Why this exists: a real terminal is a 2D grid that programs paint onto with
 * cursor/escape codes. Routing raw PTY bytes through React state (accumulating a
 * capped string and re-rendering) corrupts that paint model — it line-caps,
 * thrashes xterm.reset(), and drops carriage-return updates. Instead, raw chunks
 * are published here and written DIRECTLY into xterm via term.write(), so xterm
 * owns the authoritative buffer and React never re-renders on output.
 */

type ChunkListener = (chunk: string) => void;

const listeners: Record<string, Set<ChunkListener>> = {};

/** Push a raw stdout chunk to whatever xterm is currently showing this pane. */
export function publishChunk(terminalId: string, chunk: string): void {
  const set = listeners[terminalId];
  if (!set) return;
  for (const cb of set) {
    try {
      cb(chunk);
    } catch {
      // a torn-down xterm; the unsubscribe on unmount will clean it up
    }
  }
}

/** Subscribe an xterm writer to a pane's raw stream. Returns an unsubscribe fn. */
export function subscribeChunks(terminalId: string, cb: ChunkListener): () => void {
  (listeners[terminalId] ||= new Set()).add(cb);
  return () => {
    const set = listeners[terminalId];
    if (!set) return;
    set.delete(cb);
    if (set.size === 0) delete listeners[terminalId];
  };
}
