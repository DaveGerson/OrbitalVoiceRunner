/**
 * scripts/catalog.ts — the CAPABILITY CATALOG generator (REG1 Phase-1 exit, workstream C / spec §5.7,
 * §8.4 #20a, goal G0). Renders the one-page "what can this system do?" map: docs/CAPABILITIES.md,
 * GROUPED BY capability, derived 100% from the canonical REGISTRY + CAPABILITY_DEFS.
 *
 * PURITY (critical): this imports REGISTRY (which pulls in src/actions/defs/* → ../terminal etc.).
 * That chain has NO module-level side effect — terminal.ts boots no PTY/server, and registry.ts does
 * NOT import server.ts — so this script runs WITHOUT a server/PTY. It is DETERMINISTIC: stable sort
 * everywhere, and it NEVER calls Date / Date.now / Math.random, so the no-drift test is stable.
 *
 * Invocation:
 *   npm run catalog            → render + WRITE docs/CAPABILITIES.md (exit 0)
 *   CATALOG_CHECK=1 npm run catalog   (or: tsx scripts/catalog.ts --check)
 *                              → render in-memory; exit 0 if it matches the committed doc, else exit 1
 *                                with a diff hint (writes nothing). This is the CI no-drift guard.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { REGISTRY } from "../src/actions/registry";
import { CAPABILITY_DEFS, CAPABILITY_DEF_BY_ID } from "../src/actions/capabilities";
import { ALWAYS_ALLOWED } from "../src/actions/types";
import type { ActionDef, CapabilityDef, Surface } from "../src/actions/types";

// ─────────────────────────────────────────────────────────────────────────────
// Paths (resolved relative to THIS file, so it works from any cwd / under tsx).
// ─────────────────────────────────────────────────────────────────────────────
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DOC_PATH = path.resolve(HERE, "..", "docs", "CAPABILITIES.md");

const SURFACE_ORDER: readonly Surface[] = ["voice", "rest", "ws"];

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Surfaces rendered in a fixed order (voice/rest/ws) so the table never drifts on Set iteration. */
function surfaceLabel(surfaces: ReadonlySet<Surface>): string {
  return SURFACE_ORDER.filter((s) => surfaces.has(s)).join(" / ");
}

/**
 * Collapse a verbose, multi-sentence ActionDef.description into a single plain-language line for the
 * table. Strategy: take the text up to the first sentence terminator (. ! ? or :), strip any leading
 * "ALL-CAPS LABEL:" prefix the longer descriptions carry, collapse whitespace, escape table pipes,
 * and cap the length. Deterministic and side-effect-free.
 */
function oneLine(description: string): string {
  let s = (description || "").replace(/\s+/g, " ").trim();
  // Cut at the first sentence terminator followed by space/end (keep the terminator off).
  const m = s.match(/^(.*?[.!?:])(\s|$)/);
  if (m) s = m[1];
  // Drop a redundant leading "SOMETHING:" gloss prefix (e.g. "EMERGENCY BRAKE Stage 1 (always allowed):").
  s = s.replace(/[.!?:]+$/, "").trim();
  // Escape characters that would break the markdown table cell.
  s = s.replace(/\|/g, "\\|");
  // Cap length defensively (all current one-liners are short; this just bounds drift).
  const MAX = 160;
  if (s.length > MAX) s = s.slice(0, MAX - 1).trimEnd() + "…";
  return s;
}

/** Stable name sort for actions within a group. */
function byName(a: ActionDef, b: ActionDef): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** One markdown table of actions (already sorted by the caller). */
function actionsTable(actions: ActionDef[]): string {
  const lines: string[] = [];
  lines.push("| Action | Surfaces | Read-only | Description |");
  lines.push("| --- | --- | --- | --- |");
  for (const a of actions) {
    const ro = a.readOnly ? "yes" : "no";
    lines.push(`| \`${a.name}\` | ${surfaceLabel(a.surfaces)} | ${ro} | ${oneLine(a.description)} |`);
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render the full catalog markdown from the live REGISTRY + CAPABILITY_DEFS. Pure: same inputs →
 * byte-identical output, no clock/random. Trailing newline included.
 */
export function renderCatalog(): string {
  // Bucket every action under the capability it DECLARES (action.capability). The ALWAYS_ALLOWED
  // sentinel is its own group (the emergency brake + any other always-allowed action, e.g.
  // deliver_handoff which gates internally via dispatchProposal).
  const byCapability = new Map<string, ActionDef[]>();
  for (const a of REGISTRY) {
    const key = a.capability;
    const arr = byCapability.get(key) ?? [];
    arr.push(a);
    byCapability.set(key, arr);
  }

  // Capabilities that actually have wired actions, excluding ALWAYS_ALLOWED, sorted by id.
  const wiredCapabilityIds = [...byCapability.keys()]
    .filter((k) => k !== ALWAYS_ALLOWED)
    .sort();

  const totalActions = REGISTRY.length;
  const alwaysAllowed = (byCapability.get(ALWAYS_ALLOWED) ?? []).slice().sort(byName);
  const wiredCapCount = wiredCapabilityIds.length;

  // Matrix capabilities that have NO action wired yet (defined in CAPABILITY_DEFS but unused by the
  // registry). Listed in an appendix so the "what can this system do" map is complete.
  const wiredSet = new Set(wiredCapabilityIds);
  const unwiredDefs = CAPABILITY_DEFS.filter((d) => !wiredSet.has(d.id)).slice().sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );

  const out: string[] = [];

  // ── Header ──
  out.push("# Capability Catalog");
  out.push("");
  out.push(
    "The one-page map of everything this system can do. Every row is **generated** from the canonical " +
      "action registry (`src/actions/registry.ts`) and the capability matrix (`src/actions/capabilities.ts`) — " +
      "it is the single source of truth, not hand-maintained prose."
  );
  out.push("");
  out.push(
    "> Regenerate with `npm run catalog`. CI runs `CATALOG_CHECK=1` (or `tsx scripts/catalog.ts --check`) " +
      "to fail the build if this file drifts from the registry."
  );
  out.push("");
  out.push(
    `**${totalActions}** actions across **${wiredCapCount}** gated capabilities, plus the always-allowed group.`
  );
  out.push("");
  out.push("- **Surfaces** — where the action is exposed: `voice` (Gemini Live tool), `rest` (HTTP), `ws` (WebSocket).");
  out.push("- **Read-only** — `yes` means the result text is secret-redacted before it leaves the process.");
  out.push("- **Gate** — the *default* per-capability policy (`Auto` runs, `Ask` confirms, `Off` forbids). Tunable globally and per pane.");
  out.push("");

  // ── Always-allowed group first (the brake trio + internally-gated always-allowed actions) ──
  out.push("## Always allowed (emergency brake)");
  out.push("");
  out.push(
    "These bypass the capability gate entirely — they work even while the system is frozen. The brake " +
      "trio (`stop_all` → `confirm_stop_all` → `release_stop_all`) is the hard kill-switch."
  );
  out.push("");
  out.push(actionsTable(alwaysAllowed));
  out.push("");

  // ── One section per wired capability, sorted by id ──
  for (const capId of wiredCapabilityIds) {
    const def: CapabilityDef | undefined = CAPABILITY_DEF_BY_ID.get(capId);
    const actions = (byCapability.get(capId) ?? []).slice().sort(byName);
    const label = def ? def.label : capId;
    const gate = def ? def.defaultGate : "(unknown)";
    const category = def ? def.category : "(uncategorized)";
    const spotlight = def?.spotlightEligible ? " · spotlight-eligible" : "";

    out.push(`## ${label}`);
    out.push("");
    out.push(`- **Capability:** \`${capId}\``);
    out.push(`- **Default gate:** ${gate}${spotlight}`);
    out.push(`- **Category:** ${category}`);
    out.push("");
    out.push(actionsTable(actions));
    out.push("");
  }

  // ── Appendix: matrix capabilities with no action wired yet ──
  if (unwiredDefs.length > 0) {
    out.push("## Capabilities without actions (matrix-only)");
    out.push("");
    out.push(
      "These capability rows exist in the matrix (so they are tunable and reserved) but have no action " +
        "wired to them in the current registry."
    );
    out.push("");
    out.push("| Capability | Label | Default gate | Category |");
    out.push("| --- | --- | --- | --- |");
    for (const d of unwiredDefs) {
      out.push(`| \`${d.id}\` | ${d.label} | ${d.defaultGate} | ${d.category} |`);
    }
    out.push("");
  }

  // Single trailing newline, no others.
  return out.join("\n").replace(/\n+$/, "\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI: write (default) or --check / CATALOG_CHECK=1 (no-drift guard)
// ─────────────────────────────────────────────────────────────────────────────

function isCheckMode(): boolean {
  return process.env.CATALOG_CHECK === "1" || process.argv.includes("--check");
}

/** Entry point. Returns the process exit code (0 ok, 1 drift). */
function main(): number {
  const rendered = renderCatalog();

  if (isCheckMode()) {
    // Normalize CRLF→LF (see tests/test_catalog.ts): the check guards CONTENT drift, not the
    // on-disk EOL that core.autocrlf controls. CI runs on Linux (no CR injection) so this only
    // matters for a Windows `npm run catalog -- --check`, but keep it consistent with the test.
    const existing = fs.existsSync(DOC_PATH)
      ? fs.readFileSync(DOC_PATH, "utf8").replace(/\r\n/g, "\n")
      : null;
    if (existing === rendered) {
      process.stdout.write(`catalog: docs/CAPABILITIES.md is up to date (${REGISTRY.length} actions).\n`);
      return 0;
    }
    process.stderr.write(
      "catalog: DRIFT — docs/CAPABILITIES.md is out of sync with the registry.\n" +
        "         Run `npm run catalog` to regenerate, then commit docs/CAPABILITIES.md.\n"
    );
    return 1;
  }

  fs.mkdirSync(path.dirname(DOC_PATH), { recursive: true });
  fs.writeFileSync(DOC_PATH, rendered, "utf8");
  process.stdout.write(`catalog: wrote ${DOC_PATH} (${REGISTRY.length} actions).\n`);
  return 0;
}

// Only run main() when invoked as a script (not when imported by the no-drift test).
const INVOKED_DIRECTLY =
  process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (INVOKED_DIRECTLY) {
  process.exit(main());
}
