// tests/test_paneownership_complexity_refactor.ts
//
// Characterization tests for findPaneOwningProject (src/paneOwnership.ts), pinning the EXACT
// observable behavior of every resolution tier before/after a complexity-only refactor:
//   (1) LIVE pane: manager.terminals[paneId].projectId -> ledger.getProject -> panes[paneId]
//   (2) the active project (ledger.getActiveProject) -> panes[paneId]
//   (3) targeted owner lookup (ledger.getProjectIdForPane) -> ledger.getProject -> panes[paneId]
//       — when getProjectIdForPane is a function it is AUTHORITATIVE: never falls back to the scan.
//   (4) fallback workspace scan (ledger.workspaces) ONLY when getProjectIdForPane is absent.
// Each tier is order-sensitive; the function returns the FIRST match.

import { describe, it } from "node:test";
import assert from "node:assert";
import { findPaneOwningProject } from "../src/paneOwnership";

// Minimal pane meta; only identity matters for these assertions.
function pane(id: string): any {
  return { pane_id: id, capabilityGates: {} };
}

// ---------------------------------------------------------------------------
// Tier 1 — LIVE pane via manager.terminals[paneId].projectId
// ---------------------------------------------------------------------------
describe("findPaneOwningProject — Tier 1 (live pane)", () => {
  it("resolves a live pane's owning project from terminals[].projectId + getProject", () => {
    const p = pane("p1");
    const manager: any = {
      terminals: { p1: { projectId: "proj-live" } },
      ledger: {
        getProject: (id: string) => (id === "proj-live" ? { id: "proj-live", panes: { p1: p } } : null),
        getActiveProject: () => null,
      },
    };
    assert.deepStrictEqual(findPaneOwningProject(manager, "p1"), { projectId: "proj-live", pane: p });
  });

  it("live projectId present but getProject finds NO pane -> falls through to later tiers", () => {
    const ap = pane("p1");
    const manager: any = {
      terminals: { p1: { projectId: "proj-live" } },
      ledger: {
        // getProject for the live project returns a project WITHOUT that pane.
        getProject: (id: string) => (id === "proj-live" ? { id: "proj-live", panes: {} } : null),
        getActiveProject: () => ({ id: "active", panes: { p1: ap } }),
      },
    };
    // Falls through tier 1 (no pane) into the active project.
    assert.deepStrictEqual(findPaneOwningProject(manager, "p1"), { projectId: "active", pane: ap });
  });

  it("live projectId present but ledger.getProject is ABSENT -> tier 1 skipped (optional chaining)", () => {
    const ap = pane("p1");
    const manager: any = {
      terminals: { p1: { projectId: "proj-live" } },
      ledger: {
        // getProject undefined entirely.
        getActiveProject: () => ({ id: "active", panes: { p1: ap } }),
      },
    };
    assert.deepStrictEqual(findPaneOwningProject(manager, "p1"), { projectId: "active", pane: ap });
  });

  it("no live terminal entry (no projectId) -> tier 1 skipped", () => {
    const ap = pane("p1");
    const manager: any = {
      terminals: {},
      ledger: {
        getProject: () => null,
        getActiveProject: () => ({ id: "active", panes: { p1: ap } }),
      },
    };
    assert.deepStrictEqual(findPaneOwningProject(manager, "p1"), { projectId: "active", pane: ap });
  });
});

// ---------------------------------------------------------------------------
// Tier 2 — the active project
// ---------------------------------------------------------------------------
describe("findPaneOwningProject — Tier 2 (active project)", () => {
  it("resolves via getActiveProject when no live pane matches", () => {
    const ap = pane("p2");
    const manager: any = {
      terminals: {},
      ledger: {
        getActiveProject: () => ({ id: "active", panes: { p2: ap } }),
      },
    };
    assert.deepStrictEqual(findPaneOwningProject(manager, "p2"), { projectId: "active", pane: ap });
  });

  it("active project present but lacks the pane -> falls through to tier 3/4", () => {
    const ownerPane = pane("p2");
    const manager: any = {
      terminals: {},
      ledger: {
        getActiveProject: () => ({ id: "active", panes: {} }),
        getProjectIdForPane: () => "owner",
        getProject: (id: string) => (id === "owner" ? { id: "owner", panes: { p2: ownerPane } } : null),
      },
    };
    assert.deepStrictEqual(findPaneOwningProject(manager, "p2"), { projectId: "owner", pane: ownerPane });
  });

  it("getActiveProject ABSENT entirely -> tier 2 skipped (optional chaining)", () => {
    const ownerPane = pane("p2");
    const manager: any = {
      terminals: {},
      ledger: {
        getProjectIdForPane: () => "owner",
        getProject: (id: string) => (id === "owner" ? { id: "owner", panes: { p2: ownerPane } } : null),
      },
    };
    assert.deepStrictEqual(findPaneOwningProject(manager, "p2"), { projectId: "owner", pane: ownerPane });
  });
});

// ---------------------------------------------------------------------------
// Tier 3 — targeted owner lookup via getProjectIdForPane (AUTHORITATIVE).
// ---------------------------------------------------------------------------
describe("findPaneOwningProject — Tier 3 (getProjectIdForPane)", () => {
  it("resolves the targeted owner + its pane", () => {
    const owner = pane("p3");
    const manager: any = {
      terminals: {},
      ledger: {
        getActiveProject: () => null,
        getProjectIdForPane: (id: string) => (id === "p3" ? "owner" : null),
        getProject: (id: string) => (id === "owner" ? { id: "owner", panes: { p3: owner } } : null),
      },
    };
    assert.deepStrictEqual(findPaneOwningProject(manager, "p3"), { projectId: "owner", pane: owner });
  });

  it("getProjectIdForPane is called with `this` bound to ledger", () => {
    const owner = pane("p3");
    const ledger: any = {
      marker: "L",
      getActiveProject: () => null,
      getProjectIdForPane(this: any, _id: string) {
        // `this` must be the ledger object (call uses .call(manager.ledger, ...)).
        assert.strictEqual(this.marker, "L");
        return "owner";
      },
      getProject: (id: string) => (id === "owner" ? { id: "owner", panes: { p3: owner } } : null),
    };
    const manager: any = { terminals: {}, ledger };
    assert.deepStrictEqual(findPaneOwningProject(manager, "p3"), { projectId: "owner", pane: owner });
  });

  it("ownerId found but the project lacks that pane -> returns null (does NOT scan workspaces)", () => {
    const stray = pane("p3");
    const manager: any = {
      terminals: {},
      ledger: {
        getActiveProject: () => null,
        getProjectIdForPane: () => "owner",
        getProject: (id: string) => (id === "owner" ? { id: "owner", panes: {} } : null),
        // A workspace DOES hold the pane, but the authoritative tier-3 path must NOT consult it.
        workspaces: { other: { id: "other", panes: { p3: stray } } },
      },
    };
    assert.strictEqual(findPaneOwningProject(manager, "p3"), null);
  });

  it("getProjectIdForPane returns falsy -> returns null (does NOT scan workspaces)", () => {
    const stray = pane("p3");
    const manager: any = {
      terminals: {},
      ledger: {
        getActiveProject: () => null,
        getProjectIdForPane: () => null,
        getProject: () => null,
        workspaces: { other: { id: "other", panes: { p3: stray } } },
      },
    };
    assert.strictEqual(findPaneOwningProject(manager, "p3"), null);
  });

  it("ownerId found but getProject ABSENT -> returns null (optional chaining, no scan)", () => {
    const manager: any = {
      terminals: {},
      ledger: {
        getActiveProject: () => null,
        getProjectIdForPane: () => "owner",
        // getProject undefined
        workspaces: { other: { id: "other", panes: { p3: pane("p3") } } },
      },
    };
    assert.strictEqual(findPaneOwningProject(manager, "p3"), null);
  });
});

// ---------------------------------------------------------------------------
// Tier 4 — workspace scan fallback (ONLY when getProjectIdForPane absent).
// ---------------------------------------------------------------------------
describe("findPaneOwningProject — Tier 4 (workspace scan)", () => {
  it("scans workspaces and returns the FIRST matching project", () => {
    const target = pane("p4");
    const manager: any = {
      terminals: {},
      ledger: {
        getActiveProject: () => null,
        // getProjectIdForPane absent -> scan fallback.
        workspaces: {
          a: { id: "a", panes: {} },
          b: { id: "b", panes: { p4: target } },
        },
      },
    };
    assert.deepStrictEqual(findPaneOwningProject(manager, "p4"), { projectId: "b", pane: target });
  });

  it("scan returns FIRST match in iteration order when multiple workspaces hold the id", () => {
    const first = pane("p4");
    const second = pane("p4");
    const manager: any = {
      terminals: {},
      ledger: {
        getActiveProject: () => null,
        workspaces: {
          a: { id: "a", panes: { p4: first } },
          b: { id: "b", panes: { p4: second } },
        },
      },
    };
    // Object.values order is insertion order -> "a" first.
    assert.deepStrictEqual(findPaneOwningProject(manager, "p4"), { projectId: "a", pane: first });
  });

  it("scan finds nothing -> returns null", () => {
    const manager: any = {
      terminals: {},
      ledger: {
        getActiveProject: () => null,
        workspaces: { a: { id: "a", panes: {} } },
      },
    };
    assert.strictEqual(findPaneOwningProject(manager, "p4"), null);
  });

  it("workspaces ABSENT entirely -> returns null (?? {} default)", () => {
    const manager: any = {
      terminals: {},
      ledger: {
        getActiveProject: () => null,
        // no getProjectIdForPane, no workspaces
      },
    };
    assert.strictEqual(findPaneOwningProject(manager, "p4"), null);
  });

  it("a null/undefined workspace entry is tolerated during the scan (ws?.panes)", () => {
    const target = pane("p4");
    const manager: any = {
      terminals: {},
      ledger: {
        getActiveProject: () => null,
        workspaces: {
          a: null,
          b: { id: "b", panes: { p4: target } },
        },
      },
    };
    assert.deepStrictEqual(findPaneOwningProject(manager, "p4"), { projectId: "b", pane: target });
  });
});

// ---------------------------------------------------------------------------
// Tier ORDERING — earlier tiers win over later ones for the same pane id.
// ---------------------------------------------------------------------------
describe("findPaneOwningProject — tier precedence", () => {
  it("live pane (tier 1) wins over the active project (tier 2)", () => {
    const live = pane("p");
    const activePane = pane("p");
    const manager: any = {
      terminals: { p: { projectId: "live" } },
      ledger: {
        getProject: (id: string) =>
          id === "live" ? { id: "live", panes: { p: live } } : null,
        getActiveProject: () => ({ id: "active", panes: { p: activePane } }),
      },
    };
    assert.deepStrictEqual(findPaneOwningProject(manager, "p"), { projectId: "live", pane: live });
  });

  it("active project (tier 2) wins over targeted owner lookup (tier 3)", () => {
    const activePane = pane("p");
    const owner = pane("p");
    const manager: any = {
      terminals: {},
      ledger: {
        getProject: (id: string) =>
          id === "active"
            ? { id: "active", panes: { p: activePane } }
            : id === "owner"
              ? { id: "owner", panes: { p: owner } }
              : null,
        getActiveProject: () => ({ id: "active", panes: { p: activePane } }),
        getProjectIdForPane: () => "owner",
      },
    };
    assert.deepStrictEqual(findPaneOwningProject(manager, "p"), { projectId: "active", pane: activePane });
  });
});
