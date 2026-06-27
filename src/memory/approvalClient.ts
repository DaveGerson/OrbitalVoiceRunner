// src/memory/approvalClient.ts — the APPROVAL typed facade over the shared Python daemon core
// (seam Inc 1, task 1.6). A thin wrapper, sibling to synthFacadeOverCore: it owns ONLY the
// `approval.parse` op's wire mapping (transcript in, ParsedApproval-shaped `parsed` out) and validates
// the raw response with ApprovalParseResponseSchema. It SHARES the caller's core so synth + approval
// ride one multiplexed daemon — it never spawns its own. NEVER rejects: any miss (daemon unavailable,
// expiry, error response, schema reject) resolves to null, which the SHADOW recorder counts as a miss.
import type { PythonModuleClient } from "./pythonClient";
import { ApprovalParseResponseSchema, type WireParsedApproval } from "./types";

export interface PythonApprovalClient {
  /** Parse one transcript via the daemon; resolves the ParsedApproval-shaped result, or null on any
   *  miss. NEVER rejects. */
  parse(transcript: string): Promise<WireParsedApproval | null>;
  /** True only when the shared daemon has pinged and the breaker is closed. */
  available(): boolean;
}

/** Build the approval facade over an EXISTING shared core (does NOT dispose it — the core owner does). */
export function createPythonApprovalClient(core: PythonModuleClient): PythonApprovalClient {
  return {
    available() { return core.available(); },
    parse(transcript) {
      return core.request("approval.parse", { transcript }).then((obj) => {
        if (!obj) return null;
        const parsed = ApprovalParseResponseSchema.safeParse(obj);
        return parsed.success && parsed.data.ok ? parsed.data.parsed : null;
      });
    },
  };
}
