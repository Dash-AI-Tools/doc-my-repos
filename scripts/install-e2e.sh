#!/bin/sh
# End-to-end test of install.sh with real Docker, used by CI and runnable by hand:
#
#   docker build -t docmyrepos:ci .
#   DOCMYREPOS_IMAGE=docmyrepos:ci scripts/install-e2e.sh
#
# Installs into a temporary folder with throwaway answers, then checks that the app answers its
# health check, redirects to the sign-in page, lets the bootstrap administrator sign in, keeps the
# database off the host, wrote an owner-only .env, and that a second install into the same folder is
# refused without touching the first. Then upgrades it to a second tag of the same image and checks
# the backup, the data, the image line and that a repeat is a no-op. Always removes the containers,
# the volume and the extra tag. Prints the app log on failure.
set -eu

IMAGE=${DOCMYREPOS_IMAGE:?set DOCMYREPOS_IMAGE to the image to install}
PORT=${INSTALL_E2E_PORT:-3100}
EMAIL=e2e@example.com
PASSWORD=e2e-throwaway-password

root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
dir="$work/site"
next="$IMAGE-next"

cleanup() {
  status=$?
  if [ -f "$dir/docker-compose.yml" ]; then
    if [ "$status" -ne 0 ]; then
      printf -- '--- app log ---\n' >&2
      (cd "$dir" && docker compose logs --tail 60 app) >&2 2>&1 || true
    fi
    (cd "$dir" && docker compose down -v >/dev/null 2>&1) || true
  fi
  docker rmi "$next" >/dev/null 2>&1 || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

fail() {
  printf 'install e2e failed: %s\n' "$*" >&2
  exit 1
}

export DOCMYREPOS_ADMIN_PASSWORD="$PASSWORD"
export DOCMYREPOS_IMAGE="$IMAGE"

printf '== install\n'
sh "$root/install.sh" --yes --dir "$dir" --port "$PORT" --admin-email "$EMAIL" || fail "install.sh exited non-zero"

printf '== checks\n'
base="http://127.0.0.1:$PORT"
curl -fsS -o /dev/null "$base/api/health" || fail "/api/health did not answer 200"

code=$(curl -s -o /dev/null -w '%{http_code}' "$base/")
case $code in
  30?) ;;
  *) fail "/ answered $code, expected a redirect to the sign-in page" ;;
esac
curl -fsS "$base/login" | grep -qi '<form' || fail "the sign-in page has no form"

login=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/api/auth/login" \
  -H 'Content-Type: application/json' -H "Origin: $base" \
  --data "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")
[ "$login" = 200 ] || fail "the administrator could not sign in (status $login)"
wrong=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$base/api/auth/login" \
  -H 'Content-Type: application/json' -H "Origin: $base" \
  --data "{\"email\":\"$EMAIL\",\"password\":\"not-the-password\"}")
[ "$wrong" = 401 ] || fail "a wrong password answered $wrong, expected 401"

[ -n "$(find "$dir/.env" -prune -type f -perm 600)" ] || fail ".env is not owner-only (mode 600)"
db=$(cd "$dir" && docker compose ps -q db)
[ -n "$db" ] || fail "the database container is not running"
published=$(docker port "$db" 2>/dev/null || true)
[ -z "$published" ] || fail "the database port is published on the host ($published)"

printf '== second install into the same folder is refused\n'
before=$(cksum "$dir/.env" "$dir/docker-compose.yml")
if sh "$root/install.sh" --yes --dir "$dir" --port "$PORT" --admin-email "$EMAIL" >/dev/null 2>&1; then
  fail "a second install into the same folder succeeded"
fi
after=$(cksum "$dir/.env" "$dir/docker-compose.yml")
[ "$before" = "$after" ] || fail "the second install changed the first one's files"

printf '== upgrade to a second tag of the image\n'
signin() {
  curl -s -o /dev/null -w '%{http_code}' -X POST "$base/api/auth/login" \
    -H 'Content-Type: application/json' -H "Origin: $base" \
    --data "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"
}
docker tag "$IMAGE" "$next" || fail "could not tag $next"
compose_before=$(cksum "$dir/docker-compose.yml")
sh "$root/install.sh" --upgrade --yes --dir "$dir" --image "$next" || fail "install.sh --upgrade exited non-zero"
curl -fsS -o /dev/null "$base/api/health" || fail "/api/health did not answer 200 after the upgrade"
grep -qx "DOCMYREPOS_IMAGE=$next" "$dir/.env" || fail ".env does not name the new image"
[ "$(cksum "$dir/docker-compose.yml")" = "$compose_before" ] || fail "the upgrade changed the compose file"
[ -n "$(find "$dir/.env" -prune -type f -perm 600)" ] || fail ".env is not owner-only after the upgrade"
backup=$(find "$dir" -maxdepth 1 -name 'backup-*.sql' -type f)
[ -n "$backup" ] && [ "$(printf '%s\n' "$backup" | wc -l | tr -d ' ')" = 1 ] || fail "expected exactly one backup file"
[ -s "$backup" ] || fail "the backup is empty"
[ -n "$(find "$backup" -prune -type f -perm 600)" ] || fail "the backup is not owner-only"
grep -q 'CREATE TABLE' "$backup" || fail "the backup holds no schema"
[ "$(signin)" = 200 ] || fail "the administrator can no longer sign in after the upgrade (the data was lost)"

printf '== a repeated upgrade is a no-op\n'
sh "$root/install.sh" --upgrade --yes --dir "$dir" --image "$next" >/dev/null || fail "the repeated upgrade failed"
[ "$(find "$dir" -maxdepth 1 -name 'backup-*.sql' -type f | wc -l | tr -d ' ')" = 1 ] || fail "the repeated upgrade took another backup"

printf 'install e2e passed\n'
