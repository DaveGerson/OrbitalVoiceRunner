// Live smoke for the Orbital Kitchen cutover — runs against a REAL running server (node dist/server.cjs),
// validating the exact backend contract the kitchen UI depends on: the static app, the REST reads, a
// real PTY spawn, and the mic-free observe WebSocket streaming live stdout (no Gemini session).
// Usage: node scripts/live-smoke-kitchen.mjs <baseHttp> <token>   e.g. node scripts/live-smoke-kitchen.mjs http://127.0.0.1:3100 livesmoke
import WebSocket from "ws";

const BASE = process.argv[2] || "http://127.0.0.1:3100";
const TOKEN = process.argv[3] || "livesmoke";
const WS_BASE = BASE.replace(/^http/, "ws");
const H = { "x-api-token": TOKEN, "Content-Type": "application/json" };
let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? "✓" : "✗"} ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Returns true when the GET / response looks like the built app shell. Pure (no side effects). */
export function isValidAppShell(status, html) {
  return status === 200 && /<div id="root">/.test(html) && /assets\/index-.*\.js/.test(html);
}

/**
 * Given the raw /api/actions/pending array, return the best-match create_pane action for paneId.
 * Prefers an exact summary match so stale actions from a reused server are skipped; falls back to
 * any create_pane action. Returns undefined when pending is not an array. Pure (no side effects).
 */
export function findOurPendingAction(pending, paneId) {
  if (!Array.isArray(pending)) return undefined;
  return (
    pending.find((a) => a.capability === "create_pane" && (a.summary || "").includes(paneId)) ||
    pending.find((a) => a.capability === "create_pane")
  );
}

/**
 * Reduce a frames array to a { [type]: count } histogram. Pure (no side effects).
 */
export function buildFrameHistogram(frames) {
  const hist = {};
  for (const f of frames) hist[f.type] = (hist[f.type] || 0) + 1;
  return hist;
}

/**
 * Returns true when the pane record's backfill/output text contains the live marker.
 * Guards against non-object found values. Pure (no side effects).
 */
export function paneHasMarker(found) {
  return typeof found === "object" && found !== null && /ORBITAL_LIVE_/.test((found.backfill || "") + (found.output || ""));
}

async function main() {
  // 1) the built app is served
  const root = await fetch(`${BASE}/`);
  const html = await root.text();
  ok(isValidAppShell(root.status, html), "GET / serves the built app shell");

  // 2) REST reads the kitchen boots from
  for (const path of ["/api/terminals", "/api/ledger", "/api/settings"]) {
    const r = await fetch(`${BASE}${path}`, { headers: H });
    ok(r.status === 200, `GET ${path} → 200`);
  }
  const unauth = await fetch(`${BASE}/api/terminals`);
  ok(unauth.status === 401, "GET /api/terminals without token → 401 (auth enforced)");

  // 3) connect the mic-free observe socket BEFORE spawning, so we watch live frames arrive
  const ws = new WebSocket(`${WS_BASE}/live?observe=1`, { headers: { Cookie: `auth_token=${TOKEN}` } });
  const frames = [];
  const sawType = (t) => frames.some((f) => f.type === t);
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); setTimeout(() => rej(new Error("ws open timeout")), 5000); });
  ws.on("message", (d) => { try { frames.push(JSON.parse(d.toString())); } catch { /* skip */ } });
  ok(true, "observe WS /live?observe=1 connected");

  // 4) spawn a REAL pty pane whose command self-prints a marker, so the stdout-stream assertion is
  //    deterministic (not dependent on a shell prompt or the gated /input route).
  const paneId = `livesmoke_${process.pid}_${Date.now()}`; // unique per run (delete_pane is gated, so old panes linger)
  const spawn = await fetch(`${BASE}/api/terminals`, {
    method: "POST", headers: H,
    body: JSON.stringify({ terminalId: paneId, cwd: ".", command: "bash -lc 'for i in $(seq 1 60); do echo ORBITAL_LIVE_$i; sleep 0.4; done'", toolPreset: "Custom", permissionsMode: "Full Auto", projectId: "default_project" }),
  });
  ok([200, 202].includes(spawn.status), `POST /api/terminals (spawn real PTY) → ${spawn.status}`);
  if (spawn.status === 202) {
    // create_pane is gated Ask → it deferred. Confirm it (also exercises the live HiTL confirm path).
    await sleep(400);
    const pending = await (await fetch(`${BASE}/api/actions/pending`, { headers: H })).json();
    // Match OUR action by the pane id in its summary (stale actions can linger on a reused server).
    const act = findOurPendingAction(pending, paneId);
    ok(!!act, "gated create_pane queued a pending action");
    if (act) {
      const conf = await fetch(`${BASE}/api/actions/${act.id}/confirm`, { method: "POST", headers: H });
      ok(conf.status === 200, `confirm pending create_pane → ${conf.status}`);
    }
  }
  ws.send(JSON.stringify({ type: "set_active_pane", paneId }));

  // 5) confirm the pane's output STREAMS over the observe socket (the live burner path). The pane prints
  //    every 0.4s, so a multi-second window reliably catches several live chunks regardless of spawn race.
  await sleep(3500);
  const term = await (await fetch(`${BASE}/api/terminals`, { headers: H })).json();
  const found = Array.isArray(term) && term.find((t) => t.id === paneId);
  ok(!!found, "spawned pane appears in GET /api/terminals");
  ok(sawType("terminals_updated") || sawType("pane_status"), `observe socket received board frames (${[...new Set(frames.map((f) => f.type))].join(",") || "none"})`);
  const hist = buildFrameHistogram(frames);
  console.log("  [diag] frames:", JSON.stringify(hist), "| total", frames.length);
  const stdoutFrames = frames.filter((f) => f.type === "stdout_chunk");
  console.log("  [diag] stdout panes:", JSON.stringify([...new Set(stdoutFrames.map((f) => f.terminalId))]));
  const streamed = stdoutFrames.map((f) => f.chunk || "").join("");
  console.log("  [diag] streamed preview:", JSON.stringify(streamed.slice(0, 120)));
  // primary live-burner proof: real PTY stdout reached the mic-free observe socket, live, with our text
  ok(streamed.includes("ORBITAL_LIVE_"), `observe socket streamed live PTY stdout incl. marker (${streamed.length} bytes)`);
  // ...and the command actually ran (its marker is in the pane's output/backfill the burner seeds from)
  ok(paneHasMarker(found), "pane backfill/output carries the live marker (command ran)");

  // 6) clean up the pane
  await fetch(`${BASE}/api/terminals/${paneId}`, { method: "DELETE", headers: H }).catch(() => {});
  ws.close();

  console.log(failures === 0 ? "\nLIVE SMOKE PASSED" : `\nLIVE SMOKE FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error("live smoke error:", e); process.exit(1); });
