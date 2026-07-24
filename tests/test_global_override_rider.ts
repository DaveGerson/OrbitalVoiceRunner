// tests/test_global_override_rider.ts — BUG-003 residual (P0): the global-override spoken rider.
//
// THE BUG: effectiveModeFor is GLOBAL-FIRST by design (src/gating/index.ts:534-540 — a non-"Inherit"
// global mode dominates the per-pane mode). That precedence is correct and MUST NOT change. The defect
// is that the two pane-permission mutators still report unconditional success — "…updated to X
// successfully." — even when a non-Inherit global mode silently nullifies the pane change's gating
// effect. Eyes-off, the operator hears "done" over a no-op and believes the pane is locked/promoted
// when the global mode still wins.
//
// REQUIRED (post-fix) BEHAVIOR pinned here:
//   (a) When ctx.manager.globalPermissionsMode !== "Inherit", the SUCCESS output of BOTH
//       set_pane_permissions and promote_pane_mode — on the LIVE-delegate path (applyPaneModeDelegate)
//       AND the ledger-only LEGACY path (legacyApplyPanePerms) — appends a spoken rider that
//         • NAMES the current global mode,
//         • says the pane change has NO gating EFFECT,
//         • says it stays that way until GLOBAL returns to INHERIT.
//   (b) When global IS "Inherit", NO rider — the success string is byte-for-byte the clean original.
//   (c) Both tool DESCRIPTIONS state the global-over-pane precedence (so the model can warn proactively).
//
// These are RED until the fix lands (today the handlers return the bare "…successfully." string with no
// rider, and the descriptions never mention global/Inherit). Pure: a hand-built fake ActionContext, no
// server, no PTY — mirrors the fakeCtx idiom in tests/test_apply_pane_mode.ts (:355, :385).
//
// Runner: npx tsx --test --test-force-exit tests/test_global_override_rider.ts

import { describe, it } from "node:test";
import assert from "node:assert";
import { setPanePermissions, promotePaneMode } from "../src/actions/defs/locks";

// The exact clean-success string both handlers return today (delegate + legacy share it byte-for-byte,
// src/actions/defs/locks.ts:141 and :189). Used to assert the Inherit case stays byte-exact (no rider).
const cleanSuccess = (paneId: string, mode: string): string =>
  `Safety permission mode for pane ${paneId} updated to ${mode} successfully.`;

/**
 * A hand-built fake ActionContext (typed `any`, exactly like test_apply_pane_mode.ts's fakeCtx) that
 * routes the pane-permission handlers to a clean SUCCESS on either path:
 *   - LEGACY path  (over.wireLiveTerm !== true): no live term, pane exists in the ledger only, so the
 *     handler falls through to legacyApplyPanePerms; gateOrDefer allows (disposition:"run").
 *   - DELEGATE path (over.wireLiveTerm === true): a live term is present AND ctx.applyPaneMode is wired
 *     to a stub that reports ok, so the handler returns via applyPaneModeDelegate's ok branch.
 * `globalMode` becomes ctx.manager.globalPermissionsMode — the signal the rider keys on.
 */
function makeCtx(opts: {
  globalMode: string;
  paneId: string;
  projectId: string;
  wireLiveTerm?: boolean;
}): any {
  const { globalMode, paneId, projectId, wireLiveTerm } = opts;
  const ledgerPane = { permissions_mode: "Human-in-the-Loop" as string };
  const ctx: any = {
    manager: {
      globalPermissionsMode: globalMode,
      terminals: wireLiveTerm
        ? { [paneId]: { permissionsMode: "Human-in-the-Loop", setPermissionsMode() {} } }
        : {},
      ledger: {
        getProject: (id: string) => (id === projectId ? { panes: { [paneId]: ledgerPane } } : undefined),
        save() {},
      },
    },
    versionStamp: {},
    // gateOrDefer: allow (Auto). legacyApplyPanePerms calls applyPanePerms() itself in its return, so we
    // do NOT invoke run() here (returning disposition:"run" is enough to reach the ok return).
    gateOrDefer: () => ({ disposition: "run" as const }),
    broadcastLedgerUpdate() {},
    broadcastTerminalsUpdated() {},
  };
  if (wireLiveTerm) {
    // The LIVE choke-point delegate reports a confirmed switch → applyPaneModeDelegate's r.ok branch.
    ctx.applyPaneMode = async () => ({ ok: true, kind: "live-signal", reason: "ok" });
  }
  return ctx;
}

/** Assert `out` carries the required rider semantics for a non-Inherit `globalName` global mode. */
function assertRider(out: string, targetMode: string, globalName: string): void {
  const lo = out.toLowerCase();
  assert.ok(out.includes(`updated to ${targetMode} successfully`), `base success sentence preserved: ${out}`);
  assert.ok(out.includes(globalName), `rider NAMES the current global mode (${globalName}): ${out}`);
  assert.ok(lo.includes("global"), `rider mentions the GLOBAL mode as the dominating cause: ${out}`);
  assert.ok(lo.includes("inherit"), `rider tells the operator to return global to Inherit: ${out}`);
  assert.ok(/no .{0,24}effect/.test(lo), `rider states the pane change has NO gating effect: ${out}`);
}

// A global mode DIFFERENT from the requested pane mode, so "Read-Only" appearing in the output can ONLY
// come from the rider (the pane target is Full Auto).
const GLOBAL = "Read-Only";
const TARGET = "Full Auto";

describe("BUG-003 rider — set_pane_permissions appends the global-override rider (global != Inherit)", () => {
  it("LEGACY path (ledger-only pane) rides the global-override warning", async () => {
    const ctx = makeCtx({ globalMode: GLOBAL, paneId: "p_leg", projectId: "proj" });
    const res: any = await setPanePermissions.handler(
      { project_id: "proj", pane_id: "p_leg", permissions_mode: TARGET },
      ctx,
    );
    assert.strictEqual(res.kind, "ok");
    assertRider(String(res.output), TARGET, GLOBAL);
  });

  it("DELEGATE path (live term) rides the global-override warning", async () => {
    const ctx = makeCtx({ globalMode: GLOBAL, paneId: "p_del", projectId: "proj", wireLiveTerm: true });
    const res: any = await setPanePermissions.handler(
      { project_id: "proj", pane_id: "p_del", permissions_mode: TARGET },
      ctx,
    );
    assert.strictEqual(res.kind, "ok");
    assertRider(String(res.output), TARGET, GLOBAL);
  });

  it("global == Inherit → NO rider (byte-for-byte clean success)", async () => {
    const ctx = makeCtx({ globalMode: "Inherit", paneId: "p_clean", projectId: "proj" });
    const res: any = await setPanePermissions.handler(
      { project_id: "proj", pane_id: "p_clean", permissions_mode: TARGET },
      ctx,
    );
    assert.strictEqual(res.kind, "ok");
    assert.strictEqual(String(res.output), cleanSuccess("p_clean", TARGET), "Inherit success must stay clean");
    const lo = String(res.output).toLowerCase();
    assert.ok(!lo.includes("global") && !lo.includes("inherit"), "no rider text on a clean Inherit success");
  });

  // The Inherit guard MUST hold on the DELEGATE path too (both tools share applyPaneModeDelegate). A
  // rider wired UNCONDITIONALLY into the delegate's ok-branch — instead of through the Inherit-guarded
  // helper — would pass every non-Inherit test above yet wrongly rider a clean Inherit+live-term
  // success. This pins the guard on the live path, not just the ledger-only one.
  it("global == Inherit on the DELEGATE path (live term) → NO rider either", async () => {
    const ctx = makeCtx({ globalMode: "Inherit", paneId: "p_clean_del", projectId: "proj", wireLiveTerm: true });
    const res: any = await setPanePermissions.handler(
      { project_id: "proj", pane_id: "p_clean_del", permissions_mode: TARGET },
      ctx,
    );
    assert.strictEqual(res.kind, "ok");
    assert.strictEqual(String(res.output), cleanSuccess("p_clean_del", TARGET), "Inherit success on the delegate path must stay clean");
    const lo = String(res.output).toLowerCase();
    assert.ok(!lo.includes("global") && !lo.includes("inherit"), "no rider text on a clean Inherit delegate success");
  });
});

describe("BUG-003 rider — promote_pane_mode appends the global-override rider (global != Inherit)", () => {
  it("LEGACY path (ledger-only pane) rides the global-override warning", async () => {
    const ctx = makeCtx({ globalMode: GLOBAL, paneId: "pp_leg", projectId: "proj" });
    const res: any = await promotePaneMode.handler(
      { project_id: "proj", pane_id: "pp_leg", permissions_mode: TARGET },
      ctx,
    );
    assert.strictEqual(res.kind, "ok");
    assertRider(String(res.output), TARGET, GLOBAL);
  });

  it("DELEGATE path (live term) rides the global-override warning", async () => {
    const ctx = makeCtx({ globalMode: GLOBAL, paneId: "pp_del", projectId: "proj", wireLiveTerm: true });
    const res: any = await promotePaneMode.handler(
      { project_id: "proj", pane_id: "pp_del", permissions_mode: TARGET },
      ctx,
    );
    assert.strictEqual(res.kind, "ok");
    assertRider(String(res.output), TARGET, GLOBAL);
  });

  it("global == Inherit → NO rider (byte-for-byte clean success)", async () => {
    const ctx = makeCtx({ globalMode: "Inherit", paneId: "pp_clean", projectId: "proj" });
    const res: any = await promotePaneMode.handler(
      { project_id: "proj", pane_id: "pp_clean", permissions_mode: TARGET },
      ctx,
    );
    assert.strictEqual(res.kind, "ok");
    assert.strictEqual(String(res.output), cleanSuccess("pp_clean", TARGET), "Inherit success must stay clean");
  });

  // Same delegate-path Inherit guard for promote_pane_mode (it too routes live changes through the
  // shared applyPaneModeDelegate) — an unconditional delegate rider must not slip through here.
  it("global == Inherit on the DELEGATE path (live term) → NO rider either", async () => {
    const ctx = makeCtx({ globalMode: "Inherit", paneId: "pp_clean_del", projectId: "proj", wireLiveTerm: true });
    const res: any = await promotePaneMode.handler(
      { project_id: "proj", pane_id: "pp_clean_del", permissions_mode: TARGET },
      ctx,
    );
    assert.strictEqual(res.kind, "ok");
    assert.strictEqual(String(res.output), cleanSuccess("pp_clean_del", TARGET), "Inherit success on the delegate path must stay clean");
    const lo = String(res.output).toLowerCase();
    assert.ok(!lo.includes("global") && !lo.includes("inherit"), "no rider text on a clean Inherit delegate success");
  });
});

describe("BUG-003 rider (c) — the tool descriptions state the global-over-pane precedence", () => {
  it("set_pane_permissions.description mentions the global mode + Inherit precedence", () => {
    const d = setPanePermissions.description.toLowerCase();
    assert.ok(d.includes("global"), `description must mention the global mode: ${setPanePermissions.description}`);
    assert.ok(d.includes("inherit"), `description must mention the Inherit precedence: ${setPanePermissions.description}`);
  });

  it("promote_pane_mode.description mentions the global mode + Inherit precedence", () => {
    const d = promotePaneMode.description.toLowerCase();
    assert.ok(d.includes("global"), `description must mention the global mode: ${promotePaneMode.description}`);
    assert.ok(d.includes("inherit"), `description must mention the Inherit precedence: ${promotePaneMode.description}`);
  });
});
