/**
 * useApprovalsQueue.mockhonesty.test.tsx — BUG-038 (residual): mock-mode approval fabricates a
 * plausible-but-fake command result.
 *
 * Today `handleApprove` (src/classic/hooks/useApprovalsQueue.ts:95-113) in mock mode optimistically
 * drops the pending item and appends HARDCODED stdout — "Successfully installed pandas 2.1.0\nDONE"
 * (or "added 1 package, and audited 2 packages in 3s" for a tailwind command) — WITHOUT ever POSTing
 * /api/commands/approve. An operator/e2e viewer is trained on an instant, entirely fabricated success.
 *
 * REQUIRED post-fix behavior this suite pins (vitest + RTL renderHook, jsdom — the runner the
 * neighboring src/**.test.tsx use; see vitest.config.ts / package.json `test:component`):
 *   (a) mock-mode approve/reject NO LONGER fabricate plausible command output. Any text injected must
 *       be an unmistakable placeholder (contains "MOCK") — or nothing at all. This is the RED case.
 *   (b) NON-mock approve POSTs /api/commands/approve { approved:true } and injects NO hardcoded stdout
 *       (contract/guard — the honest real path).
 *
 * apiFetch is stubbed at the module boundary (vi.mock) so both the POST and the "no REST in mock mode"
 * halves are observable. See scratchpad/design/W6-plans-context-mock.md.
 *
 * Runner: npx vitest run src/classic/hooks/useApprovalsQueue.mockhonesty.test.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useApprovalsQueue } from "./useApprovalsQueue";
import { apiFetch } from "../../utils/api";
import type { PendingCommand, Terminal } from "../../types";

// Stub the fetch wrapper the hook uses so we can observe (and forbid) the REST POST.
vi.mock("../../utils/api", () => ({ apiFetch: vi.fn() }));
const mockedApiFetch = vi.mocked(apiFetch);

const FABRICATED_PANDAS = "Successfully installed pandas 2.1.0";
const FABRICATED_TAILWIND = "added 1 package, and audited 2 packages in 3s";

function makePending(overrides: Partial<PendingCommand> = {}): PendingCommand {
  return {
    messageId: "m1",
    terminalId: "t1",
    cmd: "pip install pandas",
    message: "t1 needs your ok: pip install pandas",
    rationale: { summary: "install pandas" },
    ...overrides,
  } as unknown as PendingCommand;
}

function mountQueue(isMock: boolean) {
  const setTerminals = vi.fn();
  const fetchTerminals = vi.fn();
  const isMockModeRef = { current: isMock };
  const hook = renderHook(() =>
    useApprovalsQueue({ isMockModeRef, setTerminals, fetchTerminals }),
  );
  return { hook, setTerminals, fetchTerminals };
}

/** Apply the LAST optimistic setTerminals updater (if any) against a seed pane and return its output.
 *  If setTerminals was never called (a valid "inject nothing" fix), the output is unchanged ("PRE"). */
function appendedOutput(setTerminals: ReturnType<typeof vi.fn>, seedOutput = "PRE"): string {
  if (!setTerminals.mock.calls.length) return seedOutput;
  const updater = setTerminals.mock.calls[setTerminals.mock.calls.length - 1][0];
  const seed = [{ id: "t1", output: seedOutput } as unknown as Terminal];
  return updater(seed)[0].output as string;
}

beforeEach(() => {
  mockedApiFetch.mockReset();
  mockedApiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as unknown as Response);
});
afterEach(() => cleanup());

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (a) mock-mode honesty — the RED case: NO fabricated command output
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("useApprovalsQueue — mock-mode approve fabricates nothing (BUG-038)", () => {
  it("does NOT inject the fabricated 'Successfully installed pandas' stdout", async () => {
    const { hook, setTerminals } = mountQueue(true);
    act(() => hook.result.current.setPendingCommands([makePending()]));
    await act(async () => { await hook.result.current.handleApprove("m1"); });

    const output = appendedOutput(setTerminals);
    expect(output).not.toContain(FABRICATED_PANDAS);
    expect(output).not.toContain("DONE");
    const injected = output.slice("PRE".length);
    if (injected.trim().length > 0) {
      // If ANY text is injected in mock mode, it must be an unmistakable placeholder.
      expect(injected.toUpperCase()).toContain("MOCK");
    }
    // Mock mode has no backend — it must NOT hit REST.
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });

  it("does NOT inject the fabricated tailwind 'added 1 package' stdout", async () => {
    const { hook, setTerminals } = mountQueue(true);
    act(() => hook.result.current.setPendingCommands([makePending({ messageId: "m2", cmd: "npm install tailwindcss" })]));
    await act(async () => { await hook.result.current.handleApprove("m2"); });

    const output = appendedOutput(setTerminals);
    expect(output).not.toContain(FABRICATED_TAILWIND);
    expect(output).not.toContain(FABRICATED_PANDAS);
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });

  it("mock-mode reject fabricates nothing and does not hit REST (guard)", async () => {
    const { hook, setTerminals } = mountQueue(true);
    act(() => hook.result.current.setPendingCommands([makePending()]));
    await act(async () => { await hook.result.current.handleReject("m1"); });

    expect(setTerminals).not.toHaveBeenCalled();
    expect(mockedApiFetch).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (b) non-mock contract — the honest real path (guard): POST { approved:true }, no fabricated stdout
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("useApprovalsQueue — non-mock approve is honest (BUG-038 guard)", () => {
  it("POSTs /api/commands/approve { messageId, approved:true } and injects NO stdout", async () => {
    const { hook, setTerminals } = mountQueue(false);
    act(() => hook.result.current.setPendingCommands([makePending()]));
    await act(async () => { await hook.result.current.handleApprove("m1"); });

    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockedApiFetch.mock.calls[0];
    expect(url).toBe("/api/commands/approve");
    expect((init as RequestInit)?.method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ messageId: "m1", approved: true });
    // The honest path never fabricates pane output.
    expect(setTerminals).not.toHaveBeenCalled();
  });

  it("non-mock reject POSTs { approved:false } and injects NO stdout", async () => {
    const { hook, setTerminals } = mountQueue(false);
    act(() => hook.result.current.setPendingCommands([makePending()]));
    await act(async () => { await hook.result.current.handleReject("m1"); });

    expect(mockedApiFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockedApiFetch.mock.calls[0];
    expect(url).toBe("/api/commands/approve");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ messageId: "m1", approved: false });
    expect(setTerminals).not.toHaveBeenCalled();
  });
});
