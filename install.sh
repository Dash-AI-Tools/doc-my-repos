#!/bin/sh
# DocMyRepos installer. Sets up a complete installation with Docker in a new folder:
#
#   curl -fsSL https://github.com/Dash-AI-Tools/doc-my-repos/releases/download/v0.1.0/install.sh | sh
#   curl -fsSL .../install.sh | sh -s -- --dry-run     # flags go after `sh -s --`
#   curl -fsSL <newer release>/install.sh | sh -s -- --upgrade --dir ./docmyrepos
#
# Read it before you run it: it is one file, it fetches nothing except the container image (from the
# registry below) and it talks to nothing except Docker and http://127.0.0.1. Documentation:
# https://github.com/Dash-AI-Tools/doc-my-repos/blob/main/docs/guides/install-script.md
#
# Everything happens inside `main`, called on the last line, so a download that is cut short
# defines no complete function and runs nothing.

set -eu

# Kept equal to package.json and the release tag by scripts/check-release-versions.sh.
DOCMYREPOS_VERSION="0.1.0"
DEFAULT_IMAGE="ghcr.io/dash-ai-tools/doc-my-repos:${DOCMYREPOS_VERSION}"

NL='
'
ECHO_OFF=0
ROLLBACK=0
CREATED_DIR=""
DIR=""
ANSWER=""

say() { printf '%s\n' "$*"; }
note() { printf '==> %s\n' "$*"; }
die() {
  printf 'install.sh: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
DocMyRepos installer

Usage: sh install.sh [options]
       curl -fsSL <url>/install.sh | sh -s -- [options]

Options (each also reads the DOCMYREPOS_* variable named in brackets):
  --dir <folder>          install folder, default ./docmyrepos      [DOCMYREPOS_DIR]
  --port <number>         port on this machine, default 3000        [DOCMYREPOS_PORT]
  --admin-email <email>   first administrator's email               [DOCMYREPOS_ADMIN_EMAIL]
  --image <reference>     container image, default the version of this script [DOCMYREPOS_IMAGE]
  --upgrade               upgrade the installation in --dir to that image: backs up the database,
                          changes only the image in .env, restarts, waits for health
  --yes                   do not ask anything; every answer must be given
  --dry-run               show the plan and write nothing
  -h, --help              this text

The administrator password is read only from DOCMYREPOS_ADMIN_PASSWORD (12 or more characters,
no ' or \). When it is not given the installer asks for it, or generates one and shows it once.
EOF
}

# ---------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------

restore_echo() {
  if [ "$ECHO_OFF" = 1 ]; then
    stty echo <&3 2>/dev/null || true
    ECHO_OFF=0
  fi
}

cleanup() {
  status=$?
  restore_echo
  if [ -n "$DIR" ]; then rm -f -- "$DIR/.env.tmp.$$"; fi
  if [ "$ROLLBACK" = 1 ] && [ "$status" -ne 0 ] && [ -n "$DIR" ]; then
    rm -f -- "$DIR/.env.tmp.$$" "$DIR/docker-compose.yml.tmp.$$" "$DIR/.env" "$DIR/docker-compose.yml"
    if [ -n "$CREATED_DIR" ]; then rmdir -- "$CREATED_DIR" 2>/dev/null || true; fi
    printf 'install.sh: failed before the installation was complete; the files it wrote were removed.\n' >&2
  fi
  exit "$status"
}

has() { command -v "$1" >/dev/null 2>&1; }

# The value of NAME in a .env file (first match), read as text and never evaluated.
env_value() { # name, file
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      "$1="*)
        printf '%s' "${line#"$1="}"
        return 0
        ;;
    esac
  done <"$2"
  return 1
}

# Parts of an image reference. The tag is empty for a digest or a reference without one.
image_tag() {
  case $1 in *@*) return 0 ;; esac
  case ${1##*/} in *:*) printf '%s' "${1##*:}" ;; esac
}
image_repo() {
  case $1 in
    *@*) printf '%s' "${1%%@*}" ;;
    *)
      case ${1##*/} in
        *:*) printf '%s' "${1%:*}" ;;
        *) printf '%s' "$1" ;;
      esac
      ;;
  esac
}
is_semver() { printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; }
version_lt() { # a, b: succeeds when version a is older than version b
  IFS=. read -r a1 a2 a3 <<EOF
$1
EOF
  IFS=. read -r b1 b2 b3 <<EOF
$2
EOF
  [ "$a1" -lt "$b1" ] && return 0
  [ "$a1" -gt "$b1" ] && return 1
  [ "$a2" -lt "$b2" ] && return 0
  [ "$a2" -gt "$b2" ] && return 1
  [ "$a3" -lt "$b3" ]
}

# Random bytes as hex or base64, from openssl or the kernel.
rand_hex() {
  if has openssl; then
    openssl rand -hex "$1"
  else
    LC_ALL=C od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'
  fi
}
rand_base64() {
  if has openssl; then
    openssl rand -base64 "$1" | tr -d '\n'
  else
    LC_ALL=C head -c "$1" /dev/urandom | base64 | tr -d '\n'
  fi
}

# ---------------------------------------------------------------------------------------------
# Validation. Each takes a value and succeeds when it is acceptable. Nothing here expands a value
# as code; values are only ever compared and printed with printf '%s'.
# ---------------------------------------------------------------------------------------------

has_control_chars() {
  [ -n "$(printf '%s' "$1" | LC_ALL=C tr -d '[:print:]')" ]
}

valid_port() {
  case $1 in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "${#1}" -le 5 ] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

valid_email() {
  case $1 in
    *"$NL"*) return 1 ;;
  esac
  has_control_chars "$1" && return 1
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$'
}

valid_dir() {
  [ -n "$1" ] || return 1
  case $1 in
    *"$NL"*) return 1 ;;
  esac
  ! has_control_chars "$1"
}

valid_image() {
  case $1 in
    '' | *[!A-Za-z0-9._/:@-]*) return 1 ;;
  esac
  return 0
}

# At least 12 printable characters, and none that the .env quoting cannot hold.
valid_password() {
  [ "${#1}" -ge 12 ] || return 1
  case $1 in
    *"'"* | *"\\"* | *"$NL"*) return 1 ;;
  esac
  ! has_control_chars "$1"
}

password_problem() {
  if [ "${#1}" -lt 12 ]; then
    say "The password must be at least 12 characters."
  else
    say "The password may not contain ' or \\ or control characters."
  fi
}

port_in_use() {
  if has lsof; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  elif has ss; then
    [ -n "$(ss -ltn "sport = :$1" 2>/dev/null | tail -n +2)" ]
  elif has nc; then
    nc -z 127.0.0.1 "$1" >/dev/null 2>&1
  else
    return 1
  fi
}

# ---------------------------------------------------------------------------------------------
# Prompts. Questions go to stderr and answers come from fd 3 (the terminal), because stdin is the
# script itself when it is piped from curl.
# ---------------------------------------------------------------------------------------------

prompt_line() { # label, default -> ANSWER
  if [ -n "$2" ]; then printf '%s [%s]: ' "$1" "$2" >&2; else printf '%s: ' "$1" >&2; fi
  IFS= read -r ANSWER <&3 || die "the input closed before every question was answered."
  [ -n "$ANSWER" ] || ANSWER=$2
}

prompt_secret() { # label -> ANSWER, without echo on a real terminal
  printf '%s: ' "$1" >&2
  if [ -t 3 ]; then
    stty -echo <&3 2>/dev/null && ECHO_OFF=1
  fi
  IFS= read -r ANSWER <&3 || {
    restore_echo
    die "the input closed before every question was answered."
  }
  restore_echo
  printf '\n' >&2
}

confirm() { # question -> succeeds on yes (default yes)
  printf '%s [Y/n]: ' "$1" >&2
  IFS= read -r ANSWER <&3 || die "the input closed before every question was answered."
  case $ANSWER in
    '' | y | Y | yes | YES | Yes) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------------------------

check_prerequisites() {
  note "Checking this machine"
  case $(uname -s) in
    Linux | Darwin) ;;
    *) die "unsupported system '$(uname -s)'. Use Linux, macOS, or WSL on Windows." ;;
  esac
  has curl || die "curl is not installed. Install curl and run this again."
  has docker || die "Docker is not installed. Install it from https://docs.docker.com/get-docker/ and run this again."
  if ! docker compose version >/dev/null 2>&1; then
    if has docker-compose; then
      die "found the old 'docker-compose' (v1) but not 'docker compose' (v2). Upgrade to Docker Compose v2."
    fi
    die "Docker Compose v2 is not installed ('docker compose version' failed). See https://docs.docker.com/compose/install/."
  fi
  compose_version=$(docker compose version --short 2>/dev/null || true)
  compose_version=${compose_version#v}
  compose_major=${compose_version%%.*}
  case $compose_major in
    '' | *[!0-9]*) ;;
    *) [ "$compose_major" -ge 2 ] || die "Docker Compose $compose_version is too old; version 2 or newer is required." ;;
  esac
  docker info >/dev/null 2>&1 || die "the Docker daemon is not reachable. Start Docker (Docker Desktop, or 'sudo systemctl start docker') and run this again."
  say "    Docker and Docker Compose are ready."
}

# ---------------------------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------------------------

write_compose() {
  # The repository's docker-compose.yml with the image taken from .env and no published database
  # port. tests/unit/install-script.test.ts keeps the hardening settings equal to the original.
  cat <<'EOF'
# DocMyRepos: the app and its Postgres database. Written by install.sh; settings are in .env.
#
# Upgrade: set DOCMYREPOS_IMAGE in .env to the new version, then
#   docker compose pull && docker compose up -d --wait
#
# TLS belongs to a reverse proxy in front of the app. The app is published on APP_BIND (127.0.0.1
# by default). The database is never published.
services:
  db:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_USER: docmyrepos
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is not set in .env}
      POSTGRES_DB: docmyrepos
    volumes:
      - db-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U $$POSTGRES_USER -d $$POSTGRES_DB"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 5s

  app:
    image: ${DOCMYREPOS_IMAGE:?DOCMYREPOS_IMAGE is not set in .env}
    env_file:
      - .env
    environment:
      DATABASE_URL: postgres://docmyrepos:${POSTGRES_PASSWORD}@db:5432/docmyrepos
    depends_on:
      db:
        condition: service_healthy
    ports:
      - "${APP_BIND:-127.0.0.1}:${APP_PORT:-3000}:3000"
    healthcheck:
      # The test comes from the image (GET /api/health).
      interval: 10s
    restart: unless-stopped
    init: true
    stop_grace_period: 30s
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    pids_limit: 512
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  db-data:
EOF
}

write_env() {
  cat <<EOF
# DocMyRepos installation written by install.sh $DOCMYREPOS_VERSION. Keep this file private and back
# it up with your database: SETTINGS_ENCRYPTION_KEY decrypts the secrets stored in the database.
COMPOSE_PROJECT_NAME=$PROJECT
DOCMYREPOS_IMAGE=$IMAGE
APP_BIND=127.0.0.1
APP_PORT=$PORT
POSTGRES_PASSWORD=$DB_PASSWORD
SETTINGS_ENCRYPTION_KEY=$ENCRYPTION_KEY
SESSION_SECRET=$SESSION_SECRET
SYNC_SECRET=$SYNC_SECRET
# First administrator, created at the first sign-in. Remove both lines after you have signed in,
# then run: docker compose up -d
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_PASSWORD='$ADMIN_PASSWORD'
EOF
}

write_files() {
  umask 077
  ROLLBACK=1
  if [ ! -d "$DIR" ]; then
    mkdir -p -- "$DIR"
    CREATED_DIR=$DIR
  fi
  write_env >"$DIR/.env.tmp.$$"
  write_compose >"$DIR/docker-compose.yml.tmp.$$"
  mv -- "$DIR/docker-compose.yml.tmp.$$" "$DIR/docker-compose.yml"
  mv -- "$DIR/.env.tmp.$$" "$DIR/.env"
  ROLLBACK=0
}

# ---------------------------------------------------------------------------------------------
# Start and verify
# ---------------------------------------------------------------------------------------------

fail_start() { # step
  printf 'install.sh: could not %s.\n' "$1" >&2
  if [ "$2" = logs ]; then
    printf -- '--- last lines of the app log ---\n' >&2
    (cd -- "$DIR" && docker compose logs --tail 30 app) >&2 2>&1 || true
  fi
  printf 'The files are in %s. To look closer: cd %s && docker compose logs app\n' "$DIR" "$DIR" >&2
  exit 1
}

# Makes the image available. One that is already here (a local build, a mirror pulled earlier) is
# used as it is. The reference is given to Compose in the environment, which wins over .env, so the
# image can be pulled before .env is changed. Returns 1, after a hint, when the pull fails.
ensure_image() {
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    note "Using the image $IMAGE that is already on this machine"
  else
    note "Pulling the image (this can take a minute)"
    (cd -- "$DIR" && DOCMYREPOS_IMAGE=$IMAGE docker compose pull) || {
      printf 'install.sh: if %s is not published (yet), build it and pass --image, or check the network.\n' "$IMAGE" >&2
      return 1
    }
  fi
}

start_stack() {
  ensure_image || fail_start "pull the image $IMAGE" none
  note "Starting DocMyRepos and its database"
  (cd -- "$DIR" && docker compose up -d --wait --wait-timeout 180) || fail_start "start the containers or reach a healthy state" logs
  curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/health" || fail_start "reach http://127.0.0.1:$PORT/api/health" logs
}

# ---------------------------------------------------------------------------------------------
# Upgrade
# ---------------------------------------------------------------------------------------------

backup_database() {
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  BACKUP="$DIR/backup-$stamp.sql"
  note "Backing up the database to $BACKUP"
  if ! (umask 077 && cd -- "$DIR" && docker compose exec -T db pg_dump --clean --if-exists -U docmyrepos docmyrepos >"backup-$stamp.sql"); then
    rm -f -- "$BACKUP"
    die "the database backup failed. Nothing was changed."
  fi
  if [ ! -s "$BACKUP" ]; then
    rm -f -- "$BACKUP"
    die "the database backup is empty. Nothing was changed."
  fi
}

# Replaces the DOCMYREPOS_IMAGE line of .env and keeps every other line as it is.
rewrite_image() {
  tmp="$DIR/.env.tmp.$$"
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      DOCMYREPOS_IMAGE=*) printf 'DOCMYREPOS_IMAGE=%s\n' "$IMAGE" ;;
      *) printf '%s\n' "$line" ;;
    esac
  done <"$DIR/.env" >"$tmp"
  mv -- "$tmp" "$DIR/.env"
}

fail_upgrade() { # step
  printf 'install.sh: could not %s after switching to %s.\n' "$1" "$IMAGE" >&2
  printf -- '--- last lines of the app log ---\n' >&2
  (cd -- "$DIR" && docker compose logs --tail 30 app) >&2 2>&1 || true
  cat >&2 <<EOF

The database was backed up before the change: $BACKUP
To go back to $CURRENT:
  cd "$DIR"
  docker compose stop app
  docker compose exec -T db psql -U docmyrepos -d docmyrepos < "$(basename "$BACKUP")"
  (in .env, set DOCMYREPOS_IMAGE=$CURRENT)
  docker compose up -d --wait
EOF
  exit 1
}

upgrade() {
  umask 077
  if [ -z "$DIR" ]; then
    if [ "$INTERACTIVE" = 1 ]; then
      while :; do
        prompt_line "Install folder to upgrade" "./docmyrepos"
        if valid_dir "$ANSWER"; then DIR=$ANSWER; break; fi
        say "That is not a usable folder name." >&2
      done
    else
      DIR=./docmyrepos
    fi
  fi
  if [ ! -f "$DIR/.env" ] || [ ! -f "$DIR/docker-compose.yml" ]; then
    die "$DIR does not hold an installation made by this script (it needs .env and docker-compose.yml). Nothing was changed."
  fi
  CURRENT=$(env_value DOCMYREPOS_IMAGE "$DIR/.env" || true)
  [ -n "$CURRENT" ] || die "$DIR/.env has no DOCMYREPOS_IMAGE line, so it is not an installation this script can upgrade. Nothing was changed."
  valid_image "$CURRENT" || die "the DOCMYREPOS_IMAGE in $DIR/.env is not a usable image reference. Nothing was changed."
  PORT=$(env_value APP_PORT "$DIR/.env" || true)
  valid_port "$PORT" || die "the APP_PORT in $DIR/.env is missing or invalid. Nothing was changed."
  # The loopback health check answers only when the app listens on loopback or everywhere; with a
  # specific other address, `up --wait` (the image's health check) is the verification.
  BIND=$(env_value APP_BIND "$DIR/.env" || true)
  case $BIND in '' | 127.0.0.1 | 0.0.0.0) CHECK_LOOPBACK=1 ;; *) CHECK_LOOPBACK=0 ;; esac

  if [ "$CURRENT" = "$IMAGE" ]; then
    say "Already up to date: the installation in $DIR runs $IMAGE. Nothing was changed."
    exit 0
  fi
  if [ "$(image_repo "$CURRENT")" = "$(image_repo "$IMAGE")" ]; then
    current_tag=$(image_tag "$CURRENT")
    target_tag=$(image_tag "$IMAGE")
    if is_semver "$current_tag" && is_semver "$target_tag" && version_lt "$target_tag" "$current_tag"; then
      die "refusing to go from $current_tag to the older $target_tag: database migrations only go forward. To go back on purpose, restore a backup (see the install script guide). Nothing was changed."
    fi
  fi

  say ""
  say "Upgrade plan"
  say "    Folder   $DIR"
  say "    From     $CURRENT"
  say "    To       $IMAGE"
  say "    Backup   $DIR/backup-<time>.sql (the database, owner-only), taken before anything changes"
  say "    Changes  only DOCMYREPOS_IMAGE in $DIR/.env; the compose file and your data are kept"
  say ""
  if [ "$DRY" = 1 ]; then
    say "Dry run: nothing was changed."
    exit 0
  fi
  if [ "$INTERACTIVE" = 1 ] && [ "$YES" = 0 ]; then
    confirm "Upgrade now?" || {
      say "Nothing was changed. Bye."
      exit 0
    }
  fi

  database=$( (cd -- "$DIR" && docker compose ps -q db) 2>/dev/null || true)
  [ -n "$database" ] || die "the database is not running, so it cannot be backed up. Start the installation (cd \"$DIR\" && docker compose up -d) and run this again. Nothing was changed."

  ensure_image || die "could not pull the image $IMAGE. Nothing was changed."
  backup_database
  note "Switching to $IMAGE"
  rewrite_image
  note "Restarting"
  (cd -- "$DIR" && docker compose up -d --wait --wait-timeout 180) || fail_upgrade "start the new version or reach a healthy state"
  if [ "$CHECK_LOOPBACK" = 1 ]; then
    curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/health" || fail_upgrade "reach http://127.0.0.1:$PORT/api/health"
  fi

  say ""
  say "DocMyRepos was upgraded and is running on port $PORT"
  say ""
  say "    Was     $CURRENT"
  say "    Now     $IMAGE"
  say "    Backup  $BACKUP"
  say ""
  say "Keep the backup until you are sure the new version works, then delete it: it holds your"
  say "data, so treat it like .env."
  exit 0
}

# ---------------------------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------------------------

main() {
  DIR=${DOCMYREPOS_DIR:-}
  PORT=${DOCMYREPOS_PORT:-}
  ADMIN_EMAIL=${DOCMYREPOS_ADMIN_EMAIL:-}
  ADMIN_PASSWORD=${DOCMYREPOS_ADMIN_PASSWORD:-}
  IMAGE=${DOCMYREPOS_IMAGE:-$DEFAULT_IMAGE}
  YES=0
  DRY=0
  UPGRADE=0

  while [ $# -gt 0 ]; do
    case $1 in
      --dir) [ $# -ge 2 ] || die "--dir needs a value"; DIR=$2; shift 2 ;;
      --dir=*) DIR=${1#--dir=}; shift ;;
      --port) [ $# -ge 2 ] || die "--port needs a value"; PORT=$2; shift 2 ;;
      --port=*) PORT=${1#--port=}; shift ;;
      --admin-email) [ $# -ge 2 ] || die "--admin-email needs a value"; ADMIN_EMAIL=$2; shift 2 ;;
      --admin-email=*) ADMIN_EMAIL=${1#--admin-email=}; shift ;;
      --image) [ $# -ge 2 ] || die "--image needs a value"; IMAGE=$2; shift 2 ;;
      --image=*) IMAGE=${1#--image=}; shift ;;
      --yes | -y) YES=1; shift ;;
      --dry-run) DRY=1; shift ;;
      --upgrade) UPGRADE=1; shift ;;
      -h | --help) usage; exit 0 ;;
      *) printf 'install.sh: unknown option %s (see --help)\n' "$1" >&2; exit 2 ;;
    esac
  done

  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  # Questions are answered at the terminal, not on stdin (which is the script when piped).
  # DOCMYREPOS_TTY replaces /dev/tty; the tests use it. The probe runs in a subshell because a
  # failed redirection on `exec` would end the whole script in a POSIX shell.
  INTERACTIVE=0
  TTY_PATH=${DOCMYREPOS_TTY:-/dev/tty}
  if [ "$YES" = 0 ] && (: <"$TTY_PATH") 2>/dev/null; then
    exec 3<"$TTY_PATH"
    INTERACTIVE=1
  fi

  # Fail fast on a bad given value, before any prerequisite work.
  [ -z "$DIR" ] || valid_dir "$DIR" || die "the folder must not be empty or contain control characters."
  [ -z "$PORT" ] || valid_port "$PORT" || die "the port must be a number from 1 to 65535."
  [ -z "$ADMIN_EMAIL" ] || valid_email "$ADMIN_EMAIL" || die "the admin email does not look like an email address."
  valid_image "$IMAGE" || die "the image reference may only contain letters, digits and . _ / : @ -"
  [ -z "$ADMIN_PASSWORD" ] || valid_password "$ADMIN_PASSWORD" || die "$(password_problem "$ADMIN_PASSWORD")"

  say "DocMyRepos installer $DOCMYREPOS_VERSION"
  check_prerequisites
  if [ "$UPGRADE" = 1 ]; then upgrade; fi

  # Folder
  [ -n "$DIR" ] || {
    if [ "$INTERACTIVE" = 1 ]; then
      while :; do
        prompt_line "Install folder" "./docmyrepos"
        if valid_dir "$ANSWER"; then DIR=$ANSWER; break; fi
        say "That is not a usable folder name." >&2
      done
    else
      DIR=./docmyrepos
    fi
  }

  # Port
  if [ -n "$PORT" ]; then
    ! port_in_use "$PORT" || die "port $PORT is already in use on this machine. Choose another with --port."
  elif [ "$INTERACTIVE" = 1 ]; then
    while :; do
      prompt_line "Port for the portal" "3000"
      if ! valid_port "$ANSWER"; then
        say "The port must be a number from 1 to 65535." >&2
      elif port_in_use "$ANSWER"; then
        say "Port $ANSWER is already in use. Choose another." >&2
      else
        PORT=$ANSWER
        break
      fi
    done
  else
    PORT=3000
    ! port_in_use "$PORT" || die "port 3000 is already in use on this machine. Choose another with --port."
  fi

  # Folder state
  if [ -e "$DIR" ] && [ ! -d "$DIR" ]; then
    die "$DIR exists and is not a folder."
  fi
  if [ -e "$DIR/.env" ] || [ -e "$DIR/docker-compose.yml" ]; then
    die "$DIR already contains an installation (.env or docker-compose.yml). Nothing was changed. Choose another folder."
  fi

  # Administrator
  if [ -z "$ADMIN_EMAIL" ]; then
    if [ "$INTERACTIVE" = 1 ]; then
      while :; do
        prompt_line "First administrator's email" ""
        if valid_email "$ANSWER"; then ADMIN_EMAIL=$ANSWER; break; fi
        say "That does not look like an email address." >&2
      done
    else
      printf 'install.sh: missing answers (no terminal to ask):\n  --admin-email or DOCMYREPOS_ADMIN_EMAIL\n' >&2
      exit 2
    fi
  fi
  GENERATED_PASSWORD=0
  if [ -z "$ADMIN_PASSWORD" ]; then
    if [ "$INTERACTIVE" = 1 ]; then
      while :; do
        prompt_secret "Administrator password (12+ characters, Enter to generate one)"
        if [ -z "$ANSWER" ]; then GENERATED_PASSWORD=1; break; fi
        if valid_password "$ANSWER"; then ADMIN_PASSWORD=$ANSWER; break; fi
        password_problem "$ANSWER" >&2
      done
    else
      GENERATED_PASSWORD=1
    fi
  fi

  # Plan
  say ""
  say "Plan"
  say "    Folder      $DIR"
  say "    Address     http://127.0.0.1:$PORT"
  say "    Admin       $ADMIN_EMAIL ($( [ "$GENERATED_PASSWORD" = 1 ] && printf 'generated password, shown once at the end' || printf 'password you gave' ))"
  say "    Image       $IMAGE"
  say "    Files       $DIR/docker-compose.yml, $DIR/.env (owner-only, holds the generated secrets)"
  say ""
  if [ "$DRY" = 1 ]; then
    say "Dry run: nothing was written and nothing was started."
    exit 0
  fi
  if [ "$INTERACTIVE" = 1 ] && [ "$YES" = 0 ]; then
    confirm "Install now?" || {
      say "Nothing was written. Bye."
      exit 0
    }
  fi

  # Secrets
  [ "$GENERATED_PASSWORD" = 0 ] || ADMIN_PASSWORD=$(rand_base64 18 | tr '+/' '-_' | tr -d '=')
  ENCRYPTION_KEY=$(rand_base64 32)
  SESSION_SECRET=$(rand_hex 32)
  SYNC_SECRET=$(rand_hex 32)
  DB_PASSWORD=$(rand_hex 24)
  PROJECT="docmyrepos-$(rand_hex 3)"

  note "Writing the files"
  write_files

  start_stack

  say ""
  say "DocMyRepos is running at http://127.0.0.1:$PORT"
  say ""
  say "    Sign in as   $ADMIN_EMAIL"
  if [ "$GENERATED_PASSWORD" = 1 ]; then
    say "    Password     $ADMIN_PASSWORD   (shown once; it is also in $DIR/.env)"
  fi
  say ""
  say "Next:"
  say "  1. Open http://127.0.0.1:$PORT and sign in."
  say "  2. Go to Admin > Workspace configuration and enter your GitHub App (guide:"
  say "     https://github.com/Dash-AI-Tools/doc-my-repos/blob/main/docs/github-app-setup.md)."
  say "  3. On the Repository access tab, press Run first sync."
  say "  4. After signing in, remove ADMIN_EMAIL and ADMIN_PASSWORD from $DIR/.env and run:"
  say "     cd $DIR && docker compose up -d"
  say ""
  say "Back up $DIR/.env with your database: it holds the key that decrypts your stored secrets."
}

main "$@"
