/**
 * Custom fetch wrapper that handles API token expiry or invalidation with graceful page reload.
 */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (res.status === 401) {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  }
  return res;
}
