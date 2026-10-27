import "server-only";

import { handleStatusRequest, type StatusApiDeps } from "./status-api";

/**
 * `GET /api/health`: liveness and readiness for the Docker `HEALTHCHECK`, load balancers and
 * `scripts/docker-smoke.sh`. It is the only status endpoint reachable without a session, so it
 * answers with nothing but the verdict: `200 {"status":"ok"}` when the app and its database answer
 * and the configuration is usable, otherwise the same fixed `503 {"error":"unavailable"}` as
 * `/api/status` (which it asks, so the two never disagree). It never contains a repository name,
 * count or sync detail: those stay behind the login on `/api/status`.
 */
export async function handleHealthRequest(
  request: Request,
  deps: StatusApiDeps,
): Promise<Response> {
  const res = await handleStatusRequest(request, deps);
  if (!res.ok) return res;
  return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: res.headers });
}
