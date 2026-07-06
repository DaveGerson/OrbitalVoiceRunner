/**
 * src/actions/defs/voice_ux.ts — voice-UX trio (wave 3): get_status_summary + focus_pane.
 *
 * SCAFFOLD-OWNED, NEVER edited by implementers — this file holds BOTH new tool defs with FINAL
 * metadata (names, params, descriptions, capability rows). Handlers are one-line delegations to
 * feature-owned modules; implementers change behavior only inside their own delegate module
 * (src/voice/sitrep.ts — hwu1, src/voice/focusResolver.ts — fz1), so registry/catalog/coverage/
 * gemini-declarations output is frozen at scaffold time and `npm run catalog` is already final.
 */

import { z } from "zod";
import type { ActionDef } from "../types";
import { ALWAYS_ALLOWED } from "../types";
import { runStatusSummary } from "../../voice/sitrep";
import { runFocusPane } from "../../voice/focusResolver";

const NoParams = z.object({});

export const getStatusSummary: ActionDef<typeof NoParams> = {
  name: "get_status_summary",
  description:
    "Speak a prioritized situation report (SITREP): what needs your action first (pending approvals), then what's busy or running a plan, then alerts, then idle panes. Honors the operator's sitrepShape preference (brief/walk/full). Cheap orientation call — the conversational sibling of list_panes + get_attention_digest.",
  params: NoParams,
  // rm4: ALWAYS_ALLOWED — this composes ONLY already-ungated orientation/alert surfaces (pane
  // existence/status metadata, the attention queue, pending-approval summaries, plan status). read_pane/
  // read_notes gate CONTENT recall, not orientation (docs/design/capability-gate-worksheet.md); same
  // rationale row as get_attention_digest. It adds no capability row and can never leak gated content
  // because the composer only touches the surfaces listed above (all pre-redacted via ctx.redact).
  capability: ALWAYS_ALLOWED,
  // readOnly:false — NOT because the output skips redaction (composeSitrep pre-redacts every field
  // it touches via ctx.redact before this handler ever sees it), but because the §8.1 invariant
  // (tests/test_action_registry.ts) binds readOnly:true ONLY to the read_pane/read_notes capabilities;
  // an ALWAYS_ALLOWED action must be readOnly:false to satisfy it. Same resolution as
  // get_stop_all_status (src/actions/defs/reads.ts) for the identical ALWAYS_ALLOWED-vs-readOnly conflict.
  readOnly: false,
  surfaces: new Set(["voice"]),
  handler: (_args, ctx) => runStatusSummary(ctx),
};

const FocusPaneParams = z.object({ reference: z.string() });

export const focusPane: ActionDef<typeof FocusPaneParams> = {
  name: "focus_pane",
  description:
    "Resolve a spoken reference to a pane ('the build pane', 'the stuck one', 'pane two', 'that one') and make it the active pane. Use when the operator names a pane conversationally; use switch_active_pane only when you already hold an exact pane id. Changes focus only; never runs a command.",
  params: FocusPaneParams,
  capability: "focus_pane", // the EXISTING promoted row (Auto default, veto enforcement) — NO new capabilities.ts row (D4)
  readOnly: false,
  surfaces: new Set(["voice"]),
  handler: (args, ctx) => runFocusPane(args.reference, ctx),
};

/** The voice-UX trio's canonical defs (aggregated into REGISTRY). */
export const VOICE_UX_ACTIONS: ActionDef[] = [getStatusSummary, focusPane];
