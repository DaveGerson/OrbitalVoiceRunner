// Shared test teardown helper.
//
// WHY THIS EXISTS (the test_live_harness UV_HANDLE_CLOSING flake):
// The unit runner uses `tsx --test --test-force-exit`. --test-force-exit calls
// process.exit() the instant the last test settles. On Windows, if a libuv handle in
// the process is still mid-close, process.exit()'s synchronous handle-walk uv_close()s
// a handle already in UV_HANDLE_CLOSING and aborts ("Assertion failed:
// !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76"). Any suite
// that calls Node's global `fetch` leaves an undici keep-alive socket (a live
// uv_tcp/uv_async-backed handle) in the connection pool AFTER the server is closed;
// that socket's teardown races force-exit. Closing the global undici dispatcher (the
// fetch keep-alive pool) before the suite finishes removes the racing handle.
//
// node-pty's ConPTY teardown (the conout worker_threads.Worker = a uv_async_t) is the
// analogous hazard for the pty-spawning suites and is handled at the source by
// UniversalTerminal.stop()/NodePtyTransport (idempotent kill + drainTeardown).

/** Close Node's global fetch (undici) dispatcher so its keep-alive sockets don't
 *  linger into --test-force-exit's process.exit(). Best-effort + idempotent. */
export async function closeFetchPool(): Promise<void> {
  try {
    const sym = Symbol.for("undici.globalDispatcher.1");
    const dispatcher = (globalThis as any)[sym];
    if (dispatcher?.close) {
      await dispatcher.close();
    } else if (dispatcher?.destroy) {
      await dispatcher.destroy();
    }
  } catch {
    // No global fetch dispatcher present (e.g. suite never called fetch) — nothing to do.
  }
}

/**
 * Deterministically tear down an in-process server suite so --test-force-exit cannot
 * abort on a half-closed libuv handle (src\win\async.c:76).
 *
 * Order matters:
 *  1. close the server (drains WS clients + http connections),
 *  2. close the global fetch keep-alive pool (its socket otherwise outlives close()),
 *  3. yield for a drain window so libuv finishes CLOSING those handles BEFORE the
 *     runner's process.exit() fires. 5 of the 6 server suites historically carried a
 *     bare 100ms settle here (load-bearing by accident, marginal under CPU load); this
 *     centralizes it at a value proven 0/24 under 4x parallel load.
 *
 * `drainMs` defaults to 250ms. The drain DOES hold the loop briefly, which is fine —
 * these suites run under --test-force-exit anyway.
 */
export async function teardownServerSuite(
  running: { close: () => Promise<void> } | undefined | null,
  drainMs = 250
): Promise<void> {
  try { await running?.close(); } catch { /* best-effort */ }
  await closeFetchPool();
  await new Promise((r) => setTimeout(r, drainMs));
}
