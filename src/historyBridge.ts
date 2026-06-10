// src/historyBridge.ts — the seam between the server's HistoryManager (the ONLY writer that owns
// the debounced dirty cache, server.ts) and the action defs that historically re-implemented its
// file I/O inline (src/actions/defs/{panes_rest,reads}.ts) because importing server.ts boots a
// real listener.
//
// WHY THIS EXISTS (review block on PR #68): once HistoryManager deferred its writes into an
// in-memory dirty cache with a debounced flush, any def that read/wrote `.janus_history.json`
// DIRECTLY raced the flush — most destructively, a `clear_history` file-write during the flush
// window was silently RESURRECTED when the pending flush merged the dirty entries back over it.
// Defs now route through this bridge when a server has registered its manager (the production
// path), and fall back to their legacy direct-file behavior only when no bridge exists (bare
// unit tests of the defs, no server booted — where there is no concurrent writer to race).
export interface HistoryBridgeEntry {
  command: string;
  timestamp: string;
  output: string;
  finalResponse?: string;
}

export interface HistoryBridge {
  loadHistory(terminalId: string): HistoryBridgeEntry[];
  addCommand(terminalId: string, command: string): void;
  /** Clear ONE pane's history in the cache AND on disk (wins over any pending flush). */
  clearHistory(terminalId: string): void;
}

let bridge: HistoryBridge | null = null;

/** server.ts registers its HistoryManager singleton at boot; tests may register fakes. */
export function registerHistoryBridge(b: HistoryBridge | null): void {
  bridge = b;
}

export function getHistoryBridge(): HistoryBridge | null {
  return bridge;
}
