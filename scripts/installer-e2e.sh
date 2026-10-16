#!/usr/bin/env bash
# End-to-end test of the installer (install-wizard task 5.3), used by CI and runnable by hand:
#
#   scripts/docker-build-labeled.sh        # or: docker build -t docmyrepos:ci .
#   pnpm --filter create-docmyrepos build
#   IMAGE=docmyrepos:ci scripts/installer-e2e.sh
#
# For each key layout (`inline` in .env, `file` as a compose secret) it:
#   1. runs the BUILT installer (packages/create-docmyrepos/dist) non-interactively against a fake
#      GitHub on a loopback port (DOCMYREPOS_GITHUB_API_URL), with the image you built, so no real
#      GitHub, registry or credential is involved;
#   2. checks the files it wrote (key layout, owner-only modes);
#   3. waits for /api/health, signs in with the bootstrap administrator, reads /api/status with
#      the session, and calls POST /api/sync (a wrong secret is refused, the right one is answered).
#
# The installer pins ghcr.io/dash-ai-tools/doc-my-repos:<tag>. The image you built is tagged that
# way locally (tag `e2e`), and a `docker` shim on PATH answers `docker compose pull` by checking
# the image exists locally; every other docker command is passed through unchanged. The app is
# started with api.github.com mapped to 127.0.0.1 (an override file), so a sync cannot reach the
# real GitHub; it answers 502/503 because it cannot sync, which is the expected outcome here.
#
# The host layout rule is faked per layout with scripts/installer-e2e-host.mjs (see there). With
# the `file` layout the installer runs with --no-start: on Linux the key file is owned by you and
# the container user (uid 1000) must be able to read it, so the script relaxes its mode to 0644
# before starting (test only; the installer's own rule is "uid 1000 or Docker Desktop").
#
# Settings (all optional):
#   IMAGE        local image to test (default docmyrepos:ci)
#   E2E_PORT     host port for the app (default 3200)
#   E2E_LAYOUTS  layouts to run, in order (default "inline file")
#   E2E_KEEP=1   keep the temporary folder and containers on failure for inspection
#
# Needs Docker with Compose v2, Node 22.18+ (it runs the TypeScript fake server), openssl and curl.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${IMAGE:-docmyrepos:ci}"
PORT="${E2E_PORT:-3200}"
LAYOUTS="${E2E_LAYOUTS:-inline file}"
IMAGE_TAG="e2e"
IMAGE_REF="ghcr.io/dash-ai-tools/doc-my-repos:${IMAGE_TAG}"
ORG="acme"
ADMIN_EMAIL="admin@example.com"
BASE="http://127.0.0.1:${PORT}"
REAL_DOCKER="$(command -v docker)"

workdir="$(mktemp -d)"
fake_pid=""
current_dir=""
current_project=""

fail() { echo "installer e2e failed: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }

cleanup() {
  local status=$?
  if [ "$status" -ne 0 ] && [ -n "$current_dir" ] && [ -f "$current_dir/docker-compose.yml" ]; then
    echo "--- app log (${current_project}) ---" >&2
    (cd "$current_dir" && COMPOSE_PROJECT_NAME="$current_project" "$REAL_DOCKER" compose logs --tail 40 app >&2) 2>&1 || true
  fi
  if [ "$status" -ne 0 ] && [ "${E2E_KEEP:-}" = "1" ]; then
    echo "kept ${workdir} and the containers (E2E_KEEP=1)" >&2
    exit "$status"
  fi
  for layout in $LAYOUTS; do
    if [ -f "$workdir/$layout/docker-compose.yml" ]; then
      (cd "$workdir/$layout" && COMPOSE_PROJECT_NAME="docmyrepos-e2e-$layout" "$REAL_DOCKER" compose down -v --remove-orphans >/dev/null 2>&1) || true
    fi
  done
  if [ -n "$fake_pid" ]; then kill "$fake_pid" 2>/dev/null || true; fi
  "$REAL_DOCKER" rmi "$IMAGE_REF" >/dev/null 2>&1 || true
  rm -rf "$workdir"
  exit "$status"
}
trap cleanup EXIT

mode_of() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

# --- Preconditions -------------------------------------------------------------------------------
"$REAL_DOCKER" image inspect "$IMAGE" >/dev/null 2>&1 || fail "the image ${IMAGE} does not exist; build it first (scripts/docker-build-labeled.sh)"
[ -f "$ROOT/packages/create-docmyrepos/dist/run.js" ] || fail "the installer is not built; run: pnpm --filter create-docmyrepos build"
"$REAL_DOCKER" compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required"

"$REAL_DOCKER" tag "$IMAGE" "$IMAGE_REF"

# --- The docker shim: `compose pull` checks the local image, everything else is real docker ------
shim="$workdir/shim"
mkdir -p "$shim"
cat >"$shim/docker" <<SHIM
#!/usr/bin/env bash
if [ "\${1:-}" = "compose" ] && [ "\${2:-}" = "pull" ]; then
  exec "$REAL_DOCKER" image inspect "$IMAGE_REF" >/dev/null
fi
exec "$REAL_DOCKER" "\$@"
SHIM
chmod +x "$shim/docker"

# --- A throwaway App key and the fake GitHub -----------------------------------------------------
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$workdir/app-key.pem" 2>/dev/null
chmod 600 "$workdir/app-key.pem"
openssl pkey -in "$workdir/app-key.pem" -pubout -out "$workdir/app-key.pub" 2>/dev/null

FAKE_GITHUB_PUBLIC_KEY_FILE="$workdir/app-key.pub" FAKE_GITHUB_URL_FILE="$workdir/fake-url" \
  node "$ROOT/scripts/installer-e2e-fake-github.mjs" >"$workdir/fake.log" 2>&1 &
fake_pid=$!
for _ in $(seq 1 50); do
  [ -s "$workdir/fake-url" ] && break
  kill -0 "$fake_pid" 2>/dev/null || { cat "$workdir/fake.log" >&2; fail "the fake GitHub server did not start"; }
  sleep 0.2
done
[ -s "$workdir/fake-url" ] || fail "the fake GitHub server did not report its address"
FAKE_URL="$(tr -d '\n' <"$workdir/fake-url")"
echo "fake GitHub: ${FAKE_URL}"

ADMIN_PASSWORD="$(openssl rand -hex 16)"
WEBHOOK_SECRET="$(openssl rand -hex 16)"

env_value() { sed -n "s/^$1='\(.*\)'\$/\1/p" "$2/.env" | head -n 1; }

run_installer() {
  local layout="$1" dir="$2"; shift 2
  local fake_uid=1001
  if [ "$layout" = "file" ]; then fake_uid=1000; fi
  env \
    PATH="$shim:$PATH" \
    COMPOSE_PROJECT_NAME="$current_project" \
    NODE_OPTIONS="--import=$ROOT/scripts/installer-e2e-host.mjs" \
    E2E_FAKE_PLATFORM=linux E2E_FAKE_UID="$fake_uid" \
    DOCMYREPOS_GITHUB_API_URL="$FAKE_URL" \
    DOCMYREPOS_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
    DOCMYREPOS_APP_ID=12345 \
    DOCMYREPOS_APP_KEY_FILE="$workdir/app-key.pem" \
    DOCMYREPOS_WEBHOOK_SECRET="$WEBHOOK_SECRET" \
    node "$ROOT/packages/create-docmyrepos/bin/create-docmyrepos.js" \
      --yes --dir "$dir" --org "$ORG" --admin-email "$ADMIN_EMAIL" --app existing --repos all \
      --port "$PORT" --url "http://localhost:${PORT}" --image-tag "$IMAGE_TAG" "$@"
}

wait_healthy() {
  for _ in $(seq 1 90); do
    if curl -fsS "${BASE}/api/health" -o "$workdir/health.json" 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

for layout in $LAYOUTS; do
  step "layout: ${layout}"
  dir="$workdir/$layout"
  current_dir="$dir"
  current_project="docmyrepos-e2e-$layout"

  # Keep the real GitHub unreachable from the app (compose merges this override automatically).
  mkdir -p "$dir"
  cat >"$dir/docker-compose.override.yml" <<'OVERRIDE'
services:
  app:
    extra_hosts:
      - "api.github.com:127.0.0.1"
OVERRIDE

  if [ "$layout" = "file" ]; then
    run_installer "$layout" "$dir" --no-start
  else
    run_installer "$layout" "$dir"
  fi

  # --- The files ---------------------------------------------------------------------------------
  [ "$(mode_of "$dir/.env")" = "600" ] || fail "[$layout] .env is not owner-only"
  grep -q 'replace-with-' "$dir/.env" && fail "[$layout] .env has a placeholder"
  if [ "$layout" = "inline" ]; then
    grep -q '^GITHUB_APP_PRIVATE_KEY=' "$dir/.env" || fail "[$layout] the key is not inline in .env"
    [ ! -e "$dir/github-app.private-key.pem" ] || fail "[$layout] a key file was written"
  else
    [ -f "$dir/github-app.private-key.pem" ] || fail "[$layout] no key file"
    [ "$(mode_of "$dir/github-app.private-key.pem")" = "600" ] || fail "[$layout] the key file is not owner-only"
    grep -q '^GITHUB_APP_PRIVATE_KEY_PATH=' "$dir/.env" || fail "[$layout] .env does not point at the key file"
    grep -q 'github_app_key' "$dir/docker-compose.yml" || fail "[$layout] the compose file has no key secret"
    # The container user is uid 1000. On a Linux host where that is not you, it needs to read the file.
    if [ "$(uname -s)" = "Linux" ] && [ "$(id -u)" != "1000" ]; then chmod 644 "$dir/github-app.private-key.pem"; fi
    step "starting the stack (file layout)"
    (cd "$dir" && COMPOSE_PROJECT_NAME="$current_project" "$REAL_DOCKER" compose up -d --wait --wait-timeout 180)
  fi

  # --- Healthy, sign in, status, sync ------------------------------------------------------------
  wait_healthy || fail "[$layout] /api/health did not answer 200"
  echo "health: $(cat "$workdir/health.json")"

  jar="$workdir/$layout.cookies"
  printf '{"email":"%s","password":"%s"}' "$ADMIN_EMAIL" "$ADMIN_PASSWORD" >"$workdir/login.json"
  code="$(curl -sS -o "$workdir/login.out" -w '%{http_code}' -c "$jar" -X POST \
    -H 'Content-Type: application/json' --data-binary "@$workdir/login.json" "${BASE}/api/auth/login")"
  [ "$code" = "200" ] || fail "[$layout] the bootstrap administrator could not sign in (HTTP $code)"
  grep -q 'dmr_session' "$jar" || fail "[$layout] sign-in set no session cookie"
  code="$(curl -sS -o /dev/null -w '%{http_code}' -b "$jar" "${BASE}/api/status")"
  [ "$code" = "200" ] || fail "[$layout] /api/status with the session answered $code"
  echo "signed in as ${ADMIN_EMAIL}; /api/status 200"

  sync_secret="$(env_value SYNC_SECRET "$dir")"
  [ -n "$sync_secret" ] || fail "[$layout] no SYNC_SECRET in .env"
  printf 'Authorization: Bearer wrong-secret-wrong-secret\n' >"$workdir/bad.header"
  code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H "@$workdir/bad.header" "${BASE}/api/sync")"
  [ "$code" = "401" ] || fail "[$layout] POST /api/sync with a wrong secret answered $code, expected 401"
  printf 'Authorization: Bearer %s\n' "$sync_secret" >"$workdir/good.header"
  code="$(curl -sS -o "$workdir/sync.out" -w '%{http_code}' -X POST -H "@$workdir/good.header" "${BASE}/api/sync")"
  case "$code" in
    200 | 202 | 502 | 503) ;;
    *) fail "[$layout] POST /api/sync answered $code, expected the sync to run (200, 202, 502 or 503)" ;;
  esac
  grep -q '"ok"' "$workdir/sync.out" || grep -q '"error"' "$workdir/sync.out" || fail "[$layout] POST /api/sync did not answer with JSON"
  echo "POST /api/sync: HTTP ${code}"

  # --- No credential in the log ------------------------------------------------------------------
  logs="$(cd "$dir" && COMPOSE_PROJECT_NAME="$current_project" "$REAL_DOCKER" compose logs app 2>&1)"
  for secret in "$ADMIN_PASSWORD" "$WEBHOOK_SECRET" "$sync_secret" "BEGIN PRIVATE KEY" "BEGIN RSA PRIVATE KEY"; do
    case "$logs" in *"$secret"*) fail "[$layout] a secret appears in the app log" ;; esac
  done

  (cd "$dir" && COMPOSE_PROJECT_NAME="$current_project" "$REAL_DOCKER" compose down -v --remove-orphans >/dev/null 2>&1)
  echo "layout ${layout}: passed"
done

echo
echo "installer end-to-end test passed (layouts: ${LAYOUTS})"
