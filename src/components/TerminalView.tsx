import React, { useEffect, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import "xterm/css/xterm.css";
import { ZoomIn, ZoomOut, RotateCcw } from "lucide-react";

interface TerminalViewProps {
  output: string;
}

export const TerminalView: React.FC<TerminalViewProps> = ({ output }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const writtenLengthRef = useRef<number>(0);
  const [fontSize, setFontSize] = useState<number>(12);

  useEffect(() => {
    if (!containerRef.current) return;

    // Initialize xterm Terminal with custom theme matching Orbital Harness UI
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
      convertEol: true,
      rows: 24,
      cols: 80,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    term.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Write initial output
    term.write(output);
    writtenLengthRef.current = output.length;

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
      resizeObserver.disconnect();
      if (containerEl) {
        containerEl.removeEventListener("touchstart", handleTouchStart);
        containerEl.removeEventListener("touchmove", handleTouchMove);
      }
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

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

  // Update output when it changes
  useEffect(() => {
    const term = terminalRef.current;
    if (!term) return;

    const lastLength = writtenLengthRef.current;
    if (output.length < lastLength) {
      // Re-initialize terminal buffer on contraction or restart
      term.reset();
      term.write(output);
    } else if (output.length > lastLength) {
      // Write only the new incremental slice
      const chunk = output.slice(lastLength);
      term.write(chunk);
    }
    writtenLengthRef.current = output.length;
  }, [output]);

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
