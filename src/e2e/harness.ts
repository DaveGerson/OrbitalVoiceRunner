import { useEffect, useRef, type MutableRefObject } from "react";
import type { Terminal, PendingCommand } from "../types";

/**
 * E2E test harness — fully isolated from the application internals.
 *
 * Everything here is gated on the `?mock=1` URL param and is a COMPLETE no-op for
 * real users. It exists as its own module (rather than inline in App.tsx) so the
 * test-support concern never tangles with — or merge-conflicts against — ongoing
 * application work. App.tsx integrates it through a single `useE2EHarness(...)`
 * call and the returned `e2eActiveRef`.
 */

export const MOCK_TERMINAL_ID = "mock_pane_1";

export type TranscriptEntry = { sender: "User" | "Janus"; text: string; timestamp: Date };

/** Injection surface exposed on `window.__ORBITAL_E2E__` for Playwright to drive. */
export interface OrbitalE2EHooks {
  injectStdoutChunk: (terminalId: string, chunk: string) => void;
  injectTranscript: (sender: "User" | "Janus", text: string) => void;
  injectPendingApproval: (cmd: string, terminalId?: string) => void;
  injectPendingAction: (capability: string, summary: string) => void;
}

export type PendingActionEntry = { actionId: string; capability: string; summary: string };

/** The application state/handlers the harness wires its injection hooks into. */
export interface E2EHarnessDeps {
  isMockModeRef: MutableRefObject<boolean>;
  setIsMockMode: (v: boolean) => void;
  setShowTranscriptPanel: (v: boolean) => void;
  setTerminals: (terminals: Terminal[]) => void;
  setActiveTerminalId: (id: string | null) => void;
  queueStdoutChunk: (terminalId: string, chunk: string) => void;
  setTranscript: (updater: (prev: TranscriptEntry[]) => TranscriptEntry[]) => void;
  setPendingCommands: (updater: (prev: PendingCommand[]) => PendingCommand[]) => void;
  setPendingActions: (updater: (prev: PendingActionEntry[]) => PendingActionEntry[]) => void;
}

/**
 * Deterministic mock pane seeded under ?mock=1. The backfill carries an ANSI color
 * sequence so the terminal e2e can prove xterm renders RAW bytes (ANSI interpreted,
 * not shown literally and not stripped). MOCKTERM_READY is the asserted token.
 */
function mockTerminal(): Terminal {
  return {
    id: MOCK_TERMINAL_ID,
    cwd: ".",
    command: "bash",
    backfill: "\x1b[32mMOCKTERM_READY\x1b[0m web-app@1.0.0 dev server\r\n$ ",
    output: "MOCKTERM_READY web-app@1.0.0 dev server\n$ ",
    status: "Running",
  };
}

/**
 * Install the e2e harness. No-op unless the page is loaded with `?mock=1`. When
 * active it: puts the app in deterministic mock mode, seeds a pane, opens the
 * transcript panel, and installs `window.__ORBITAL_E2E__` injection hooks wired to
 * the app's REAL handlers. Returns `e2eActiveRef` so the caller can let mock-mode-
 * gated side effects (e.g. the resize POST) still fire under e2e.
 */
export function useE2EHarness(deps: E2EHarnessDeps): { e2eActiveRef: MutableRefObject<boolean> } {
  const e2eActiveRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (new URLSearchParams(window.location.search).get("mock") !== "1") return;

    e2eActiveRef.current = true;
    deps.isMockModeRef.current = true;
    deps.setIsMockMode(true);
    // Open the transcript panel so injected transcript lines are mounted/visible.
    deps.setShowTranscriptPanel(true);
    deps.setTerminals([mockTerminal()]);
    deps.setActiveTerminalId(MOCK_TERMINAL_ID);

    const hooks: OrbitalE2EHooks = {
      injectStdoutChunk: (terminalId, chunk) => deps.queueStdoutChunk(terminalId, chunk),
      injectTranscript: (sender, text) =>
        deps.setTranscript((prev) => [...prev, { sender, text, timestamp: new Date() }]),
      injectPendingApproval: (cmd, terminalId = MOCK_TERMINAL_ID) =>
        deps.setPendingCommands((prev) => [...prev, {
          messageId: `mock_${prev.length + 1}`,
          cmd,
          terminalId,
          rationale: { trigger: "e2e injected", summary: "Mocked pending approval for e2e." },
        }]),
      injectPendingAction: (capability, summary) =>
        deps.setPendingActions((prev) => [...prev, {
          actionId: `mock_act_${prev.length + 1}`,
          capability,
          summary,
        }]),
    };
    (window as unknown as { __ORBITAL_E2E__?: OrbitalE2EHooks }).__ORBITAL_E2E__ = hooks;

    // Signal readiness so the Playwright fixture can wait deterministically.
    document.documentElement.setAttribute("data-e2e-ready", "1");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { e2eActiveRef };
}
