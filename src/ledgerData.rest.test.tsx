/**
 * ledgerData.rest.test.tsx — REST-PRESERVATION SMOKE (bead wsm-e2e-pinned-4ib).
 *
 * Operator acceptance gate #1: "all REST API calls are maintained when smoke testing." This renders
 * the REAL cockpit (<App/> = the classic AppRaw tree) in non-mock mode with a recording `fetch` stub,
 * then asserts the EXACT set of REST endpoints the boot path issues. It is deliberately identical
 * before and after the useLedgerData extraction — a dropped, renamed, or duplicated call fails it.
 *
 * Why not the Playwright mock lane: every fetcher short-circuits on `?mock=1`, so the mock harness
 * SUPPRESSES the very calls under test. The faithful capture point is the `fetch` seam, non-mock.
 *
 * Intent catalogue: docs/superpowers/specs/2026-06-24-ledger-data-parity-catalogue.md.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import App from "./App";

interface Call { url: string; method: string }
let calls: Call[];

// The 7 read-only GET endpoints owned by the ledger-data layer (the surface useLedgerData lifts).
// Matched as substrings so the dynamic projectId in the notes path is tolerated.
const LEDGER_DATA_BOOT_ENDPOINTS = [
  "/api/terminals",
  "/api/ledger",
  "/api/settings",
  "/api/plans",
  "/api/archive",
  "/api/stop-all/status",
  "/api/projects/default_project/notes",
];

// The FULL boot GET set the cockpit issues = the 7 ledger-data endpoints above + 2 sibling-hook
// boot fetches (fetchPendingCommands → useApprovalsQueue, fetchWipDrafts → useComposer). Asserting
// the EXACT set (not just "the 7 are present") makes this a true preservation gate: it fails on a
// DROPPED ledger call, a RENAMED endpoint, AND on an accidental new/duplicated call introduced by
// the extraction. fetchActiveDraft is correctly absent on boot (no active pane). Captured verbatim
// against pre-extraction main (86e3737) — see the parity catalogue.
const EXPECTED_BOOT_GET_SET = [
  "/api/archive",
  "/api/commands/pending",
  "/api/ledger",
  "/api/plans",
  "/api/projects/default_project/drafts",
  "/api/projects/default_project/notes",
  "/api/settings",
  "/api/stop-all/status",
  "/api/terminals",
].sort();

/** Canned bodies shaped so the boot render never crashes (terminals/plans arrays, etc.). */
function cannedBody(url: string): unknown {
  if (url.includes("/api/terminals")) return [];
  if (url.includes("/api/plans")) return [];
  if (url.endsWith("/notes")) return { notes: [] };
  if (url.includes("/api/archive")) return { archived: [] };
  if (url.includes("/api/stop-all/status")) return { frozen: false, running: [] };
  if (url.includes("/api/settings")) return { advanced: { globalPermissionsMode: "Inherit" } };
  if (url.includes("/api/ledger")) return {};
  if (url.endsWith("/drafts")) return { drafts: [] };
  if (url.includes("/api/commands/pending")) return [];
  return {};
}

beforeEach(() => {
  calls = [];
  // jsdom has no WebSocket; a boot effect that touches the constructor would ReferenceError. The live
  // socket only opens on startLive (panes boot inert), but shim defensively so the mount is clean.
  if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
    (globalThis as { WebSocket?: unknown }).WebSocket = class { static OPEN = 1; readyState = 0; close() {} send() {} addEventListener() {} } as unknown;
  }
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
    return new Response(JSON.stringify(cannedBody(url)), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ledger-data REST preservation — boot", () => {
  it("issues every ledger-data GET endpoint on boot (non-mock)", async () => {
    render(<App />);

    // Wait until the boot effect has flushed its fetches (terminals is the first ledger-data call).
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes("/api/terminals"))).toBe(true);
    });
    // Give the rest of the boot fan-out a tick to settle.
    await waitFor(() => {
      const gets = calls.filter((c) => c.method === "GET").map((c) => c.url);
      for (const ep of LEDGER_DATA_BOOT_ENDPOINTS) {
        expect(gets.some((u) => u.includes(ep)), `missing boot GET ${ep}`).toBe(true);
      }
    });

    // Strong preservation assertion: the deduped boot GET set must EQUAL the golden set exactly —
    // no ledger call dropped, no endpoint renamed, nothing new or duplicated leaking from the move.
    const gets = Array.from(new Set(calls.filter((c) => c.method === "GET").map((c) => c.url))).sort();
    expect(gets).toEqual(EXPECTED_BOOT_GET_SET);
  });
});
