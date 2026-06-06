import { useEffect, useRef, type MutableRefObject } from "react";
import type { Terminal, PendingCommand, CapabilityGateMap, Workspace, PaneMeta } from "../types";

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
// f06: a SECOND seeded pane so the e2e can exercise a real A→B context switch with distinct
// model/human context — the felt bug is "highlight moves, context body lags."
export const MOCK_TERMINAL_ID_2 = "mock_pane_2";

export type TranscriptEntry = { sender: "User" | "Janus"; text: string; timestamp: Date; grounding?: { queries: string[]; sources: { uri: string; title: string }[] } };

/** Injection surface exposed on `window.__ORBITAL_E2E__` for Playwright to drive. */
export interface OrbitalE2EHooks {
  injectStdoutChunk: (terminalId: string, chunk: string) => void;
  injectTranscript: (sender: "User" | "Janus", text: string) => void;
  /** aqx (build-out): attach grounded queries/sources to the most recent Janus turn (drives the chip). */
  injectGrounding: (queries: string[], sources: { uri: string; title: string }[]) => void;
  injectPendingApproval: (cmd: string, terminalId?: string) => void;
  injectPendingAction: (capability: string, summary: string) => void;
  /**
   * U3 (bead wsm-e2e-pinned-dlj): stage a WIP draft for `paneId` so the e2e can exercise the
   * `wipDrafts.length > 0` clause of the Sync Spec tab draft-pending badge independently of
   * `promptBuffer`. ?mock=1-gated test-support only; a no-op for real users.
   */
  injectWipDraft: (paneId: string, text: string) => void;
  /**
   * WS-F resumption pin (spec §6.1, §8). The ?mock=1 harness is CLIENT-ONLY (no real server WS), so
   * the disconnect/reconnect round-trip is staged at the harness layer. `simulateDisconnect` models
   * the server's `detachSession`: it is a deliberate NO-OP on the staged arrays — staged approvals
   * and actions are KEPT (not purged), which is the whole point of the pin (chips must survive). It
   * only flips an internal flag so a subsequent reconnect knows a disconnect happened.
   */
  simulateDisconnect: () => void;
  /**
   * WS-F resumption pin (spec §6.2/§7). Models the server's `reannounceSurvivors`: reads the staged
   * survivors that outlived `simulateDisconnect` (they were never purged) and pushes ONE batched
   * `Janus` resumption digest line — the same "Welcome back — N actions waiting from before: …"
   * envelope the server speaks — composed from each survivor's maintained context. The chips already
   * persist (the arrays were untouched), so they repopulate for the full list. Returns the digest
   * string it pushed (or `null` when there were no survivors → silent, mirroring the server).
   */
  simulateReconnect: () => string | null;
  /**
   * bead 8sq (spec §2.A): set the mock pane's SERVER-resolved effective posture so the GateChip
   * renders deterministically under ?mock=1 (the harness is client-only; there's no real server to
   * resolve gates). Replaces the mock terminal's `effective_gates` + `posture` and re-seeds it.
   */
  setPostureMock: (posture: "OPEN" | "GUARDED" | "LOCKED", effectiveGates: CapabilityGateMap) => void;
  /**
   * bead 8sq (spec §2.C): drive the two-stage STOP-ALL banner. `frozen` toggles the FROZEN banner;
   * `running` sets the still-running pane count the Stage-2 hold-to-fire kill targets.
   */
  setFrozenMock: (frozen: boolean, running: string[]) => void;
  /**
   * f06 (bead wsm-e2e-pinned-f06): switch the active pane the SAME way a tile click does —
   * `setActiveTerminalId(paneId)` — with NO terminals_updated / ledger_updated broadcast. This is
   * exactly the condition under test: the context body must flip to the new pane's name + model/human
   * context in the same frame as the cyan highlight, derived from the already-seeded local ledger.
   */
  switchActivePane: (paneId: string) => void;
}

export type PendingActionEntry = { actionId: string; capability: string; summary: string };

/** The application state/handlers the harness wires its injection hooks into. */
export interface E2EHarnessDeps {
  isMockModeRef: MutableRefObject<boolean>;
  setIsMockMode: (v: boolean) => void;
  setShowTranscriptPanel: (v: boolean) => void;
  setTerminals: (terminals: Terminal[]) => void;
  setActiveTerminalId: (id: string | null) => void;
  // f06: seed a ledger so the context body (derived from `ledger`) has real per-pane model/human
  // context to render — without this the harness ledger is `{}` and activePaneMeta is always null.
  setLedger: (ledger: Record<string, Workspace>) => void;
  queueStdoutChunk: (terminalId: string, chunk: string) => void;
  setTranscript: (updater: (prev: TranscriptEntry[]) => TranscriptEntry[]) => void;
  setPendingCommands: (updater: (prev: PendingCommand[]) => PendingCommand[]) => void;
  setPendingActions: (updater: (prev: PendingActionEntry[]) => PendingActionEntry[]) => void;
  // bead 8sq: the two-stage STOP-ALL banner state (driven by the harness setFrozenMock hook).
  setFrozen: (v: boolean) => void;
  setFrozenRunning: (running: string[]) => void;
  // U3: setter for the wipDrafts register — type mirrors the useState shape at src/App.tsx:220.
  setWipDrafts: (
    updater: (prev: { paneId: string; draft: { text: string; updatedAt: string; updatedBy?: string } }[])
      => { paneId: string; draft: { text: string; updatedAt: string; updatedBy?: string } }[],
  ) => void;
}

/**
 * One survivor's resumption-digest line, composed from the SAME maintained provenance the server's
 * `renderResumptionLine` uses (spec §5/§7): `<capability/cmd> → <terminalId>: "<instruction>"` plus a
 * `(you said: <trigger>)` clause when a heard trigger is present. Pure; missing rationale degrades to
 * just the command line. Kept verbatim alongside the action variant so the e2e RENDERS the same digest
 * shape the server speaks (the server round-trip itself is pinned by the T2–T4 unit/server tests).
 */
function approvalResumptionLine(cmd: PendingCommand): string {
  const trigger = cmd.rationale?.trigger?.trim();
  const saidClause = trigger ? ` (you said: ${trigger})` : "";
  return `write_to_pane → ${cmd.terminalId}: "${cmd.cmd}"${saidClause}`;
}

/** The action variant of a resumption line: `<capability>: <summary>` (spec §6.2 — actions join the digest). */
function actionResumptionLine(action: PendingActionEntry): string {
  return `${action.capability}: ${action.summary}`;
}

/**
 * The ONE batched resumption digest spoken on reconnect (spec §7) — byte-faithful to the server's
 * `reannounceSurvivors` envelope. 0 survivors → `null` (silent). 1 → the single-item form. 2–3 → the
 * "N actions waiting from before: …; Which first?" form. >3 → name 3, then "+N more". `lines` is the
 * already-rendered per-survivor context, most-recent first.
 */
function buildResumptionDigest(lines: string[]): string | null {
  const total = lines.length;
  if (total === 0) return null;
  const shown = lines.slice(0, 3);
  if (total === 1) {
    return `Welcome back — one action still waiting: ${shown[0]}. Approve, or has this moved on?`;
  }
  if (total <= 3) {
    return `Welcome back — ${total} actions waiting from before: ${shown.join("; ")}. Which first?`;
  }
  return `Welcome back — ${total} actions waiting from before: ${shown.join("; ")}; …and ${total - 3} more, all in your queue.`;
}

/**
 * Deterministic mock pane seeded under ?mock=1. The backfill carries an ANSI color
 * sequence so the terminal e2e can prove xterm renders RAW bytes (ANSI interpreted,
 * not shown literally and not stripped). MOCKTERM_READY is the asserted token.
 */
function mockTerminal(
  posture: "OPEN" | "GUARDED" | "LOCKED" = "GUARDED",
  effectiveGates: CapabilityGateMap = DEFAULT_MOCK_GATES,
  id: string = MOCK_TERMINAL_ID,
): Terminal {
  return {
    id,
    cwd: ".",
    command: "bash",
    backfill: "\x1b[32mMOCKTERM_READY\x1b[0m web-app@1.0.0 dev server\r\n$ ",
    output: "MOCKTERM_READY web-app@1.0.0 dev server\n$ ",
    status: "Running",
    // bead 8sq: seed a server-resolved posture so the GateChip renders deterministically under ?mock=1.
    posture,
    effective_gates: effectiveGates,
  };
}

/**
 * f06: a minimal PaneMeta for the seeded ledger. Only the fields the context body reads
 * (name + modelContext + humanContext, App.tsx:2031-2034) carry distinct A/B values; the rest are
 * inert defaults so the ledger type-checks. ?mock=1-gated test-support only.
 */
function mockPaneMeta(
  paneId: string,
  name: string,
  modelText: string,
  humanText: string,
): PaneMeta {
  const at = new Date().toISOString();
  return {
    pane_id: paneId,
    name,
    runtime_type: "bash",
    last_known_state: "Running",
    is_busy: false,
    alive: true,
    notes: [],
    modelContext: [{ text: modelText, at }],
    humanContext: [{ text: humanText, at }],
    permissions_mode: "Human-in-the-Loop",
    session_id: `sess_${paneId}`,
    tool_preset: "Claude Code",
    context_size: 0,
  };
}

/**
 * f06: a 2-pane ledger with DISTINCT per-pane context so the e2e can prove the context body flips
 * A→B with no broadcast. `mock_pane_1` = "React Frontend" (A-*), `mock_pane_2` = "Python Backend" (B-*).
 */
function mockLedger(): Record<string, Workspace> {
  return {
    mock_project: {
      id: "mock_project",
      name: "Mock Project",
      directory: ".",
      summary: "",
      notes: [],
      panes: {
        [MOCK_TERMINAL_ID]: mockPaneMeta(MOCK_TERMINAL_ID, "React Frontend", "A-model-context", "A-human-context"),
        [MOCK_TERMINAL_ID_2]: mockPaneMeta(MOCK_TERMINAL_ID_2, "Python Backend", "B-model-context", "B-human-context"),
      },
    },
  };
}

/**
 * The default mock effective-gate map — productive writes Auto (this IS the active/focused pane in the
 * harness, so the spotlight loosens them), a couple of gates on Ask/Off → resolves to GUARDED, and the
 * focus ★ shows. A deterministic fixture the chip e2e asserts against.
 */
const DEFAULT_MOCK_GATES: CapabilityGateMap = {
  write_to_pane: "Auto",
  deliver_handoff: "Auto",
  create_pane: "Ask",
  close_pane: "Ask",
  delete_pane: "Ask",
  delete_project: "Ask",
  restart_pane: "Ask",
  set_pane_permissions: "Ask",
  set_global_permissions: "Ask",
  set_capability_gate: "Ask",
  add_watch_rule: "Ask",
  execute_plan: "Ask",
  apply_recipe: "Ask",
  create_project: "Auto",
  update_metadata: "Auto",
  switch_context: "Auto",
  set_voice_mute: "Auto",
  dismiss_attention: "Auto",
  // c55.10: rest-only writes tightened to Ask (parity with the matrix).
  send_keys: "Ask",
  remove_watch_rule: "Ask",
  delete_orchestrator_plan: "Ask",
};

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
    // f06: seed BOTH panes (so a switch target tile exists) and a ledger with distinct per-pane
    // context (so the body has something real to flip between). mock_pane_1 stays the default active.
    deps.setTerminals([
      mockTerminal(),
      mockTerminal("GUARDED", DEFAULT_MOCK_GATES, MOCK_TERMINAL_ID_2),
    ]);
    deps.setLedger(mockLedger());
    deps.setActiveTerminalId(MOCK_TERMINAL_ID);

    // WS-F (spec §6.1): tracks that a simulated disconnect happened. The staged arrays are KEPT —
    // this flag only lets `simulateReconnect` model the server's "re-attach on a fresh session" seam.
    let disconnected = false;
    // A synchronous shadow of what's been staged — the harness analog of the server-side stores
    // (`pendingApprovals` / `pendingActions`) the real `reannounceSurvivors` reads. React state is
    // async, so the digest is built off this shadow (in lockstep with the inject hooks below), not a
    // deferred setState read. Survivors are KEPT here across a disconnect, exactly like the durable rows.
    const stagedApprovals: PendingCommand[] = [];
    const stagedActions: PendingActionEntry[] = [];

    const hooks: OrbitalE2EHooks = {
      injectStdoutChunk: (terminalId, chunk) => deps.queueStdoutChunk(terminalId, chunk),
      injectTranscript: (sender, text) =>
        deps.setTranscript((prev) => [...prev, { sender, text, timestamp: new Date() }]),
      injectGrounding: (queries, sources) =>
        deps.setTranscript((prev) => {
          let lastJanus = -1;
          for (let i = prev.length - 1; i >= 0; i--) { if (prev[i].sender === "Janus") { lastJanus = i; break; } }
          if (lastJanus === -1) return prev;
          const next = prev.slice();
          next[lastJanus] = { ...next[lastJanus], grounding: { queries, sources } };
          return next;
        }),
      injectPendingApproval: (cmd, terminalId = MOCK_TERMINAL_ID) => {
        const record: PendingCommand = {
          messageId: `mock_${stagedApprovals.length + 1}`,
          cmd,
          terminalId,
          rationale: { trigger: "e2e injected", summary: "Mocked pending approval for e2e." },
        };
        stagedApprovals.push(record);
        deps.setPendingCommands((prev) => [...prev, record]);
      },
      injectPendingAction: (capability, summary) => {
        const record: PendingActionEntry = {
          actionId: `mock_act_${stagedActions.length + 1}`,
          capability,
          summary,
        };
        stagedActions.push(record);
        deps.setPendingActions((prev) => [...prev, record]);
      },

      // U3: stage a WIP draft for `paneId`, driving the wipDrafts gate-clause of the Sync Spec badge.
      injectWipDraft: (paneId, text) =>
        deps.setWipDrafts((prev) => [...prev, { paneId, draft: { text, updatedAt: new Date().toISOString() } }]),

      // WS-F disconnect (spec §6.1): DETACH, not purge. Deliberately does NOT clear the staged arrays
      // (React state) NOR the shadow — the survivors must persist so their chips stay mounted across
      // the round-trip. We only flip the flag; the server-side clock-pause + durable-keep is covered
      // by the unit/server tests (T2–T4); this client pin asserts the survivors are never discarded.
      simulateDisconnect: () => {
        disconnected = true;
      },

      // WS-F reconnect (spec §6.2/§7): read the survivors that outlived the disconnect (they were
      // never purged) most-recent first, render each one's maintained context, and push ONE batched
      // Janus digest. The chips already persist (arrays untouched), so they repopulate the full list.
      simulateReconnect: () => {
        // A reconnect only re-announces survivors when a disconnect actually preceded it — mirrors
        // the server, where `reannounceSurvivors` runs on a fresh connect (after a prior detach).
        if (!disconnected) return null;
        // Most-recent first: injection order is chronological, so reverse to lead with the newest.
        const lines = [
          ...[...stagedApprovals].reverse().map(approvalResumptionLine),
          ...[...stagedActions].reverse().map(actionResumptionLine),
        ];
        const digest = buildResumptionDigest(lines);
        if (digest) {
          deps.setTranscript((prev) => [...prev, { sender: "Janus", text: digest, timestamp: new Date() }]);
        }
        disconnected = false; // re-attached: a fresh window is open.
        return digest;
      },

      // bead 8sq: re-seed the mock pane with a chosen server-resolved posture so the chip e2e can
      // assert OPEN / GUARDED / LOCKED + the popover breakdown deterministically.
      setPostureMock: (posture, effectiveGates) => {
        deps.setTerminals([mockTerminal(posture, effectiveGates)]);
        deps.setActiveTerminalId(MOCK_TERMINAL_ID);
      },

      // bead 8sq: drive the two-stage STOP-ALL banner (frozen flag + still-running pane count).
      setFrozenMock: (frozen, running) => {
        deps.setFrozen(frozen);
        deps.setFrozenRunning(running);
      },

      // f06: switch the active pane via the REAL setter a tile click fires — NO broadcast. The body
      // must flip from the local (already-seeded) ledger in the same frame as the highlight.
      switchActivePane: (paneId) => {
        deps.setActiveTerminalId(paneId);
      },
    };
    (window as unknown as { __ORBITAL_E2E__?: OrbitalE2EHooks }).__ORBITAL_E2E__ = hooks;

    // Signal readiness so the Playwright fixture can wait deterministically.
    document.documentElement.setAttribute("data-e2e-ready", "1");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { e2eActiveRef };
}
