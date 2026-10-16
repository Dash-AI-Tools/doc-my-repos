#!/bin/sh
# Container entrypoint (task 13.1): apply the database migrations, then start the server.
#
# - Required settings are not checked here. The migration step needs only DATABASE_URL; the app
#   validates everything else itself (session and sync secrets, the encryption key) and names
#   each problem in the page and the logs. GitHub and provider settings are entered in the
#   admin interface, not here.
# - The migrations wait up to DB_WAIT_SECONDS (default 60) for a database that is still starting,
#   then fail the container with a non-zero exit and a clear message. They never print the
#   connection string. Runs are serialized by an advisory lock, so replicas may start together.
# - SKIP_MIGRATIONS=1 skips the step (for example when a deploy job migrates once, or on replicas
#   that start after the first one).
# - The server replaces this shell (exec), so signals reach it: SIGTERM stops the background
#   scheduler and the server. Next 16 exits with code 143 on SIGTERM, which Docker treats as a normal stop.
set -eu

if [ "${SKIP_MIGRATIONS:-}" = "1" ]; then
  echo "docmyrepos: SKIP_MIGRATIONS=1, not applying database migrations"
else
  echo "docmyrepos: applying database migrations"
  if ! node dist/db-migrate.mjs; then
    echo "docmyrepos: database migrations failed; not starting the server" >&2
    exit 1
  fi
fi

exec "$@"
