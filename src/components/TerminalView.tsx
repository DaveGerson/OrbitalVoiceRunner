import React, { useEffect, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import { ZoomIn, ZoomOut, RotateCcw } from "lucide-react";
import { subscribeChunks } from "../terminalStream";

interface TerminalViewProps {
  /** Pane id — keys the live raw-chunk subscription and resize callback. */
  terminalId: string;
  /** Raw bytes (escape sequences intact) to seed scrollback on (re)open. */
  backfill?: string;
  /** Report the xterm grid so the backend PTY can be resized to match. */
  onResize?: (cols: number, rows: number) => void;
}

export const TerminalView: React.FC<TerminalViewProps> = ({ terminalId, backfill, onResize }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [fontSize, setFontSize] = useState<number>(12);
  // Keep the latest onResize without re-running the mount effect on every render.
  const onResizeRef = useRef<typeof onResize>(onResize);
  onResizeRef.current = onResize;

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

    term.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Seed scrollback with the raw backfill (escape sequences intact), exactly
    // once. After this, xterm owns the authoritative buffer.
    if (backfill) term.write(backfill);

    // Sync the backend PTY grid to the xterm grid. onResize fires after every
    // fit() (initial + container changes), so the PTY always wraps to the
    // operator's actual viewport.
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      onResizeRef.current?.(cols, rows);
    });
    // Report the initial fitted grid.
    onResizeRef.current?.(term.cols, term.rows);

    // Live lane: raw chunks written DIRECTLY into xterm — no React state, no
    // string accumulation, no line cap. xterm reconstructs the 2D grid itself.
    const unsubscribe = subscribeChunks(terminalId, (chunk) => {
      term.write(chunk);
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
      unsubscribe();
      resizeDisposable.dispose();
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
        <span className="text-[10px] font-mono opacity-50 px-1 select-none">{fontSize}px</span>
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
