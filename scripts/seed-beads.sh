#!/usr/bin/env sh
# Seed the beads tracker for the "registry + plumbing" program.
#
# WHY THIS EXISTS: the specs were authored in a web container with no `bd`/Dolt,
# so the beads ship as this seed. Run it from a `bd`-equipped clone to file them.
# Source of truth = docs/superpowers/specs/2026-06-04-handoff-registry-plus-plumbing.md §4.
#
# Flags target the documented `bd` CLI; if your bd version differs, adjust the
# create/dep syntax (the manifest table in the handoff doc is authoritative).
#
# Preferred path: `bd import docs/beads/2026-06-04-registry-plumbing.jsonl`
# (this script is the explicit fallback / readable form of the same set).

set -eu

if ! command -v bd >/dev/null 2>&1; then
  echo "ERROR: bd (beads) not on PATH. Install beads, then re-run, or use:" >&2
  echo "       bd import docs/beads/2026-06-04-registry-plumbing.jsonl" >&2
  exit 1
fi

# Try the JSONL import first (single source of truth); fall back to explicit creates.
if bd import docs/beads/2026-06-04-registry-plumbing.jsonl 2>/dev/null; then
  echo "Imported beads from JSONL."
  bd ready || true
  exit 0
fi

echo "JSONL import unavailable on this bd version; creating issues explicitly..."

c() { bd create "$1" -t "$2" -p "$3" -d "$4"; }   # title, type, priority, description

# --- Epic p0: Pillar 0 Quick Wins ---
c "QW1 process-level error net (uncaughtException/unhandledRejection)" task 1 "Add a process-level net; log + best-effort drain; no force-exit on recoverable rejection. Test: tests/test_process_safety.ts."
c "QW2 guard PTY spawn (degrade-not-crash)" task 1 "Wrap pty.spawn/legacy spawn + createPtyTransport call; bad cmd/cwd -> clean error state. Test: tests/test_pty_spawn_guard.ts."
c "QW3 Gemini session onerror/onclose (minimal)" task 1 "Null activeLiveSession (guard reconnect race), detach approvals, notify frontend 'voice lost'. No reconnect (that is PLM4)."
c "QW4 await stop_all Stage-2 kills" task 1 "Promise.allSettled the kills; report only panes actually stopped. Extend tests/test_stop_all_two_stage.ts."
c "QW5 guard the onOutput chain" task 2 "Wrap classify/publish, history append, transition detect so one throw does not blind a pane. Test: tests/test_output_guard.ts."
c "QW6 prune broken sockets from clients set" task 3 "Remove a socket from clients on send error. Test: tests/test_broadcast_prune.ts."
c "H1 delete dead universal_terminal.py + fix CLAUDE.md battery" chore 3 "Remove universal_terminal.py + its test; drop the stale line from CLAUDE.md Build & Test."

# --- Epic p1: Registry ---
c "KS keystone create_pane launch-derivation single-home + schema guardrail" feature 1 "Fold preset->binary into one resolveLaunch; remove restart hack server.ts:871-873; schema makes a model-authored launch string unrepresentable. Gate half already done (restGateOutcome/G6). Tests: registry-spec 8.3b (17a-17f), incl. voice==REST identical launch."
c "REG1 registry Phase 1 (register-as-is; generated surfaces; derived matrix; action_log seam)" feature 1 "src/actions/{types,registry,gemini,rest,coverage}.ts; migrate 41 voice tools + rest infra; swap server.ts dispatch+REST to generators; derive matrix; write action_log table; delete regex guard. DoD: registry-spec 12 Phase-1."

# --- Epic plm: Registry plumbing (the choke-point payoff) ---
c "PLM1 per-action timeout in runAction" feature 1 "Promise.race a per-action deadline (default + ActionDef.timeoutMs); over-deadline -> {kind:error} answered once; brake exempt; realtime never blocks. Test: tests/test_action_timeout.ts."
c "PLM2 action-log view: get_action_log read action + GET /api/action-log + UI panel" feature 1 "Read action over action_log (redacted, filter by pane/capability/outcome, gateDisposition+ms); mountRestRoutes exposes the endpoint; minimal App.tsx panel. Test: tests/test_action_log_view.ts."
c "PLM3 durable-closure version guard (rehydrate skew)" feature 1 "Stamp persisted PendingAction intent with action name + registry schema-hash; on boot, missing capability or changed hash -> quarantine for re-confirm, never silently mis-run. Test: tests/test_durable_action_version.ts."
c "PLM4 session reconnect + in-flight idempotency" feature 1 "Persist resumption token; reconnect w/ backoff on close; idempotency key per runAction in action_log so a replay is detected (never double-apply); re-announce surviving approvals. Test: tests/test_session_reconnect.ts."
c "PLM5 health/counters strip (get_health + UI)" feature 2 "Aggregate session state, pane counts, pending count, recent error-rate from action_log; small always-visible strip. Test: tests/test_health.ts."

# --- Epic backlog: deferred (filed, not started) ---
c "CV1 convergence: reads -> REST" feature 2 "get_pane_summary/delta/gates, search_notes, list_capabilities; parity-cutover test per registry-spec 8.5b."
c "CV2 convergence: handoff lifecycle -> REST/WS" feature 2 "propose/revise/stage/deliver/read/list/reject_handoff."
c "CV3 convergence: infra -> voice" feature 2 "close_pane/restart_pane (Ask), archive, clear-exited, watch-rule CRUD."
c "RES2 PTY death handling + ConPTY drain tests" task 2 "Pane death -> attention+earcon; read/propose on dead pane -> clean blocked/clarify; restart via resolveLaunch."
c "RES3 server-restart recovery UX + running-PTY restore" task 2 "Persistence half done (kzt/nzt); add 'restart N panes?' boot prompt; nothing silently re-executes."
c "RES5 failure-injection test suite" task 2 "Kill mock session mid-call; transport exit mid-command; persist+re-import server."
c "RES6 attention-queue cap audit" task 2 "pruneAttention at every mutation site (BUG-035)."
c "DBT1 SQLite typed-row hydration" task 2 "Replace 40+ as any[] query casts with typed row mappers."
c "DBT2 Gemini message envelope typing" task 2 "One validated shape for the onmessage polyfills."
c "DBT3 legacy ledger backend decision" chore 3 "Retire JANUS_LEDGER_BACKEND=legacy (~500 LOC) or keep as documented escape hatch."
c "DBT4 App.tsx decomposition (4.5k lines)" task 2 "Split the UI monolith; parallel track."
c "REG2 Phase 2 Python catalog authority + codegen" feature 2 "Pydantic source-of-truth -> committed generated TS/JSON; no-drift test."

echo "Created beads. Set dependencies per the handoff manifest:"
echo "  ks depends-on qw2 ; reg1 depends-on ks ; plm1..plm5 depend-on reg1 ; plm5 also depends-on plm2"
echo "(e.g.: bd dep add <reg1-id> <ks-id>) — IDs were echoed above."
bd ready || true
