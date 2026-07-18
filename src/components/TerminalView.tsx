import React, { useEffect, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import { ZoomIn, ZoomOut, RotateCcw } from "lucide-react";
import { subscribeChunks } from "../terminalStream";
// resync's pure helpers live in a CSS-free sibling module so the unit tests can
// import the REAL implementations (this file imports xterm CSS, which the node
// test runner cannot load).
import { tryFetchBackfill, resolveBackfill, shouldSkipQuietResync } from "./terminalViewResync";

interface TerminalViewProps {
  /** Pane id — keys the live raw-chunk subscription and resize callback. */
  terminalId: string;
  /** Raw bytes (escape sequences intact) to seed scrollback on (re)open. */
  backfill?: string;
  /** Report the xterm grid so the backend PTY can be resized to match. */
  onResize?: (cols: number, rows: number) => void;
  /**
   * 3C.2b: bumps when the data socket RE-opens after a drop. Each bump rebuilds the screen from a
   * fresh snapshot (reset + rewrite) and writes a dim one-line marker, so a socket gap is never a
   * silent hole in the scrollback.
   */
  resyncKey?: number;
  /**
   * 3C.2b: fetch this pane's freshest raw backfill (server truth). When provided, it is also
   * called once on mount so the burner opens on truth rather than a possibly-stale React snapshot.
   * `null` → fall back to the latest `backfill` prop.
   */
  fetchBackfill?: () => Promise<string | null>;
  /** Operator keystrokes typed into this focused pane — raw xterm onData bytes, escape sequences intact. */
  onInput?: (data: string) => void;
}

export const TerminalView: React.FC<TerminalViewProps> = ({ terminalId, backfill, onResize, resyncKey, fetchBackfill, onInput }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [fontSize, setFontSize] = useState<number>(12);
  // Keep the latest onResize without re-running the mount effect on every render.
  const onResizeRef = useRef<typeof onResize>(onResize);
  onResizeRef.current = onResize;
  // Same idiom for onInput: the mount effect (deps [terminalId]) must not re-run when the
  // onInput callback identity changes between renders.
  const onInputRef = useRef<typeof onInput>(onInput);
  onInputRef.current = onInput;
  // 3C.2b: latest fetcher/backfill without re-running the mount effect; the resync entry point is
  // installed by the mount effect (it needs the live term) and invoked by the resyncKey effect.
  const fetchBackfillRef = useRef<typeof fetchBackfill>(fetchBackfill);
  fetchBackfillRef.current = fetchBackfill;
  const backfillRef = useRef<typeof backfill>(backfill);
  backfillRef.current = backfill;
  const resyncRef = useRef<((opts: { marker: boolean }) => void) | null>(null);

  // Re-create the terminal when the pane changes; the raw stream + backfill are
  // pane-specific, so a key change must reset xterm cleanly.
  useEffect(() => {
    if (!containerRef.current) return;

    // Initialize xterm Terminal with custom theme matching Orbital Harness UI.
    // NOTE: no convertEol — a real PTY already emits \r\n, and forcing it would
    // corrupt lone-\r in-place updates (spinners, progress bars).
    const term = new Terminal({
      cursorBlink: true,
      fontSize: fontSize,
      fontFamily: '"Fira Code", "JetBrains Mono", Courier, monospace',
      theme: {
        background: "#060606",
        foreground: "#b4b4b4",
        cursor: "#22d3ee", // cyan-400
        black: "#000000",
        red: "#ef4444",
        green: "#22c55e",
        yellow: "#eab308",
        blue: "#3b82f6",
        magenta: "#ec4899",
        cyan: "#06b6d4",
        white: "#f4f4f5",
        brightBlack: "#71717a",
        brightRed: "#f87171",
        brightGreen: "#4ade80",
        brightYellow: "#facc15",
        brightBlue: "#60a5fa",
        brightMagenta: "#f472b6",
        brightCyan: "#22d3ee",
        brightWhite: "#ffffff",
      },
      scrollback: 10000,
      rows: 24,
      cols: 80,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Seed scrollback with the raw backfill (escape sequences intact) for an instant first paint.
    // When a fetchBackfill is wired (the kitchen burner), a quiet resync below replaces this with
    // SERVER truth right after mount — the React-state snapshot can be up to a poll-interval stale.
    // Safe before open(): xterm's write buffer/parser live on the terminal core and don't need the
    // DOM renderer that open() installs (CoreTerminal.write() has no dependency on it) — open()
    // itself is deferred below, but seeding the buffer here still lands the very first paint.
    if (backfill) term.write(backfill);
    // The base the screen was last rebuilt from — lets the quiet resync skip a no-op rewrite.
    let lastBase = backfill ?? "";

    // Sync the backend PTY grid to the xterm grid. onResize fires after every
    // fit() (initial + container changes), so the PTY always wraps to the
    // operator's actual viewport.
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      onResizeRef.current?.(cols, rows);
    });

    // Operator typing edge: forward raw xterm onData bytes (escape sequences intact) so the
    // frontend can stream them to the backend PTY. No local echo / convertEol here — the PTY
    // echoes what it accepts.
    const inputDisposable = term.onData((data) => {
      onInputRef.current?.(data);
    });

    // Live lane: raw chunks written DIRECTLY into xterm — no React state, no
    // string accumulation, no line cap. xterm reconstructs the 2D grid itself.
    // While a resync's snapshot fetch is in flight, chunks are ALSO journaled so they can be
    // replayed after the reset+rewrite (otherwise the rewrite would clobber them — a fresh hole).
    let disposed = false;
    let journal: string[] | null = null;
    const unsubscribe = subscribeChunks(terminalId, (chunk) => {
      if (journal) journal.push(chunk);
      term.write(chunk);
    });

    // 3C.2b: rebuild the screen from snapshot truth. `marker: true` (socket reconnected) always
    // rewrites and stamps the dim gap marker; `marker: false` (mount refresh) is quiet — it skips
    // when the snapshot brings nothing new, and never yanks an operator who has scrolled up.
    const resync = async ({ marker }: { marker: boolean }) => {
      if (journal) return; // a resync is already in flight
      journal = [];
      const fetched = await tryFetchBackfill(fetchBackfillRef.current);
      const replay = journal ?? [];
      journal = null;
      if (disposed) return;
      const fresh = resolveBackfill(fetched, backfillRef.current); // degrade to the freshest React state
      if (!marker) {
        const buf = term.buffer.active;
        const atBottom = buf.viewportY >= buf.baseY;
        if (shouldSkipQuietResync(fresh, lastBase, atBottom)) return; // nothing new / operator reading
      }
      // One synchronous frame: reset, rewrite from truth, stamp the gap (reconnect only), then
      // replay any chunks that streamed in while the snapshot was in flight.
      term.reset();
      if (fresh !== null) { term.write(fresh); lastBase = fresh; }
      if (marker) term.write("\r\n\x1b[2m— reconnected; replayed from snapshot —\x1b[0m\r\n");
      for (const c of replay) term.write(c);
    };
    resyncRef.current = (opts) => { void resync(opts); };

    // Burner open (3C.2b): pull the pane's freshest backfill so the screen starts from truth —
    // the prop snapshot above only covers up to the last poll/refetch.
    if (fetchBackfillRef.current) void resync({ marker: false });

    // wsm-e2e-pinned-g2qe: term.open()/fitAddon.fit() deferred one animation frame, guarded by
    // `disposed` + `isConnected`. React 18 StrictMode double-invokes this effect in dev (mount →
    // cleanup → re-mount); xterm.js schedules an async Viewport refresh off open()/fit() that
    // still fires after the terminal is torn down, reading a now-undefined internal field and
    // surfacing as an uncaught "Cannot read properties of undefined (reading 'dimensions')"
    // pageerror (xterm.js Viewport._innerRefresh / syncScrollArea). Cancelling the rAF in cleanup
    // means the StrictMode-discarded first pass never calls open() at all, so it never schedules
    // that callback in the first place — the real (second) pass opens cleanly one frame later.
    let openRafId: number | null = requestAnimationFrame(() => {
      openRafId = null;
      if (disposed || !containerRef.current?.isConnected) return;
      term.open(containerRef.current);
      try {
        fitAddon.fit();
      } catch (err) {}
      // Report the initial fitted grid now that open()/fit() have actually run (this used to run
      // synchronously right after fit(); it now runs here so it still reports the FITTED cols/rows,
      // not the pre-fit constructor defaults).
      onResizeRef.current?.(term.cols, term.rows);
    });

    // Handle container resize
    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch (err) {}
    });
    resizeObserver.observe(containerRef.current);

    // Touch scrolling gesture handler for mobile/touch devices
    let touchStartY = 0;
    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        touchStartY = e.touches[0].clientY;
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 1) {
        const touchY = e.touches[0].clientY;
        const deltaY = touchStartY - touchY;
        
        // Scroll 1 line per 8px delta distance
        if (Math.abs(deltaY) > 8) {
          const linesToScroll = Math.round(deltaY / 8);
          if (linesToScroll !== 0) {
            term.scrollLines(linesToScroll);
            touchStartY = touchY;
          }
        }
        
        // Prevent background page bounce while dragging terminal logs
        if (e.cancelable) {
          e.preventDefault();
        }
      }
    };

    const containerEl = containerRef.current;
    if (containerEl) {
      containerEl.addEventListener("touchstart", handleTouchStart, { passive: true });
      containerEl.addEventListener("touchmove", handleTouchMove, { passive: false });
    }

    return () => {
      disposed = true;
      if (openRafId !== null) cancelAnimationFrame(openRafId);
      resyncRef.current = null;
      unsubscribe();
      resizeDisposable.dispose();
      inputDisposable.dispose();
      resizeObserver.disconnect();
      if (containerEl) {
        containerEl.removeEventListener("touchstart", handleTouchStart);
        containerEl.removeEventListener("touchmove", handleTouchMove);
      }
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
    // Re-mount xterm when the pane changes so the new pane's backfill + stream
    // bind cleanly. fontSize is handled in a separate effect (no re-mount).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId]);

  // 3C.2b/c: the data socket RE-opened after a drop — rebuild this screen from a fresh snapshot
  // and stamp the gap marker so the hole is never silent. Keyed on the bump, not the value (the
  // initial render must not resync; mount handles its own quiet refresh above).
  const lastResyncKeyRef = useRef<number | undefined>(resyncKey);
  useEffect(() => {
    if (resyncKey === undefined || resyncKey === lastResyncKeyRef.current) {
      lastResyncKeyRef.current = resyncKey;
      return;
    }
    lastResyncKeyRef.current = resyncKey;
    resyncRef.current?.({ marker: true });
  }, [resyncKey]);

  // Sync state changes back to active terminal instance
  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;
    
    // Set both options or options.fontSize depending on precise xterm package signature
    try {
      term.options.fontSize = fontSize;
    } catch (e) {
      try {
        term.options = { fontSize };
      } catch (e2) {}
    }

    // Trigger immediate fit calculation reflow
    setTimeout(() => {
      if (fitAddonRef.current) {
        try {
          fitAddonRef.current.fit();
        } catch (err) {}
      }
    }, 50);
  }, [fontSize]);

  const handleZoomIn = () => {
    setFontSize(prev => Math.min(prev + 1, 24));
  };

  const handleZoomOut = () => {
    setFontSize(prev => Math.max(prev - 1, 8));
  };

  const handleResetZoom = () => {
    setFontSize(12);
  };

  return (
    <div className="w-full h-full min-h-[300px] overflow-hidden bg-[#060606] relative rounded-md border border-white/5 group">
      {/* Dynamic zoom tools anchored in top right */}
      <div className="absolute top-3 right-3 z-10 flex items-center gap-1 bg-black/80 backdrop-blur-md px-2 py-1 rounded border border-white/10 opacity-40 group-hover:opacity-100 transition-opacity duration-200">
        <span className="text-xs font-mono opacity-50 px-1 select-none">{fontSize}px</span>
        <button
          onClick={handleZoomOut}
          title="Zoom Out"
          className="p-1 hover:bg-white/10 text-zinc-400 hover:text-white rounded transition-colors"
        >
          <ZoomOut className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={handleZoomIn}
          title="Zoom In"
          className="p-1 hover:bg-white/10 text-zinc-400 hover:text-white rounded transition-colors"
        >
          <ZoomIn className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={handleResetZoom}
          title="Reset Zoom"
          className="p-1 hover:bg-white/10 text-zinc-400 hover:text-white rounded transition-colors border-l border-white/10 pl-1.5 ml-0.5"
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
      </div>

      <div ref={containerRef} className="absolute inset-0 p-4 pt-12" />
    </div>
  );
};
