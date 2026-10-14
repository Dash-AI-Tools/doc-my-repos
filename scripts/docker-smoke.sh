#!/usr/bin/env bash
# Smoke test of the production image (task 13.3), used by CI and runnable by hand:
#
#   docker build -t docmyrepos:ci .
#   IMAGE=docmyrepos:ci DATABASE_URL=postgres://user:pass@host.docker.internal:5432/smoke \
#     scripts/docker-smoke.sh
#
# Starts the image against the given Postgres with a throwaway GitHub App key (generated here,
# never a real credential) and the sync scheduler off, so GitHub is never contacted. Checks that
# the migrations ran, /api/health answers 200, / redirects to /login and /api/status is 401 without a
# session, the login page renders, the security headers are
# set, and that `docker stop` ends the container cleanly. Prints the container log on failure.
set -euo pipefail

IMAGE="${IMAGE:-docmyrepos:ci}"
PORT="${SMOKE_PORT:-3000}"
WAIT_SECONDS="${SMOKE_WAIT_SECONDS:-90}"
NAME="docmyrepos-smoke-$$"
# host.docker.internal is mapped below, so the same URL works on Linux (CI) and Docker Desktop.
export DATABASE_URL="${DATABASE_URL:-postgres://docmyrepos:docmyrepos@host.docker.internal:5432/docmyrepos}"

workdir="$(mktemp -d)"
trap 'status=$?; if [ "$status" -ne 0 ]; then echo "--- container log ---" >&2; docker logs "$NAME" >&2 2>&1 || true; fi; docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$workdir"; exit "$status"' EXIT

fail() { echo "smoke test failed: $*" >&2; exit 1; }

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$workdir/key.pem" 2>/dev/null
GITHUB_APP_PRIVATE_KEY="$(cat "$workdir/key.pem")"
export GITHUB_APP_PRIVATE_KEY

docker run -d --init --name "$NAME" \
  --add-host host.docker.internal:host-gateway \
  -p "127.0.0.1:${PORT}:3000" \
  -e DATABASE_URL \
  -e GITHUB_APP_PRIVATE_KEY \
  -e GITHUB_APP_ID=1 \
  -e GITHUB_APP_INSTALLATION_ID=1 \
  -e GITHUB_WEBHOOK_SECRET=smoke-test-webhook-secret \
  -e SYNC_SECRET=smoke-test-sync-secret-value \
  -e SESSION_SECRET=smoke-test-session-secret-value \
  -e SYNC_SCHEDULER=0 \
  "$IMAGE" >/dev/null

base="http://127.0.0.1:${PORT}"
echo "waiting up to ${WAIT_SECONDS}s for ${base}/api/health"
ready=""
for _ in $(seq 1 "$WAIT_SECONDS"); do
  if curl -fsS "${base}/api/health" -o "$workdir/status.json" 2>/dev/null; then ready=1; break; fi
  if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" != "true" ]; then fail "the container exited"; fi
  sleep 1
done
[ -n "$ready" ] || fail "/api/health did not answer 200 within ${WAIT_SECONDS}s"
echo "/api/health: $(cat "$workdir/status.json")"

docker logs "$NAME" 2>&1 | grep -q "applying database migrations" || fail "the entrypoint did not run the migrations"

# The portal is behind a login: an anonymous visitor to / is redirected to /login, and the unauthenticated
# /api/status is 401 (it lists repositories). The login page itself is public.
code="$(curl -sS -o /dev/null -w '%{http_code}' "${base}/")"
[ "$code" = "307" ] || fail "GET / without a session answered $code, expected a redirect to /login"
code="$(curl -sS -o /dev/null -w '%{http_code}' "${base}/api/status")"
[ "$code" = "401" ] || fail "GET /api/status without a session answered $code, expected 401"
code="$(curl -sS -o "$workdir/home.html" -D "$workdir/home.headers" -w '%{http_code}' "${base}/login")"
[ "$code" = "200" ] || fail "GET /login answered $code"
grep -qi "DocMyRepos" "$workdir/home.html" || fail "the login page does not mention DocMyRepos"
grep -qi '^content-security-policy:' "$workdir/home.headers" || fail "no Content-Security-Policy header"
if grep -qi '^x-powered-by:' "$workdir/home.headers"; then fail "X-Powered-By is set"; fi

# No credential may reach the log.
if docker logs "$NAME" 2>&1 | grep -q -e "BEGIN PRIVATE KEY" -e "smoke-test-sync-secret-value" -e "smoke-test-webhook-secret"; then
  fail "a secret appears in the container log"
fi

docker stop -t 30 "$NAME" >/dev/null
exit_code="$(docker inspect -f '{{.State.ExitCode}}' "$NAME")"
# 0 and 143 (128 + SIGTERM) are both a normal stop.
case "$exit_code" in 0 | 143) ;; *) fail "exit code $exit_code after docker stop" ;; esac
echo "smoke test passed (exit code after docker stop: ${exit_code})"
