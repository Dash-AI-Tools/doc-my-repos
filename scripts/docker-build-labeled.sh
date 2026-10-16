#!/usr/bin/env bash
# Builds the production image with its OCI labels, the same way the release workflow does, and
# checks the labels on the result (installer-wizard task 5.1).
#
#   scripts/docker-build-labeled.sh                      # docmyrepos:dev for this machine
#   VERSION=1.2.0 TAG=docmyrepos:ci scripts/docker-build-labeled.sh
#   VERSION=1.2.0 PLATFORM=linux/amd64 scripts/docker-build-labeled.sh
#
# The labels are given to the build (`--label`, plus the VERSION and REVISION build arguments the
# Dockerfile already declares). The Dockerfile text is not changed by this script and holds no
# release-specific value. Settings, all optional:
#
#   VERSION   image version label (default: dev)
#   REVISION  commit the image is built from (default: HEAD of this checkout)
#   TAG       local image name (default: docmyrepos:<VERSION>)
#   PLATFORM  one platform, e.g. linux/amd64 (default: this machine). `--load` keeps one platform.
#
# Needs Docker with buildx. Nothing is pushed.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

SOURCE="https://github.com/Dash-AI-Tools/doc-my-repos"
LICENSES="MIT"
VERSION="${VERSION:-dev}"
REVISION="${REVISION:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
TAG="${TAG:-docmyrepos:${VERSION}}"

fail() { echo "build failed: $*" >&2; exit 1; }

case "$VERSION" in
  *[!0-9A-Za-z._-]* | "") fail "VERSION may only contain letters, digits, '.', '_' and '-'" ;;
esac

args=(
  buildx build --load
  --tag "$TAG"
  --build-arg "VERSION=${VERSION}"
  --build-arg "REVISION=${REVISION}"
  --label "org.opencontainers.image.source=${SOURCE}"
  --label "org.opencontainers.image.version=${VERSION}"
  --label "org.opencontainers.image.revision=${REVISION}"
  --label "org.opencontainers.image.licenses=${LICENSES}"
)
if [ -n "${PLATFORM:-}" ]; then args+=(--platform "$PLATFORM"); fi
args+=(.)

echo "docker ${args[*]}"
docker "${args[@]}"

check_label() {
  local key="$1" expected="$2" actual
  actual="$(docker inspect --format "{{ index .Config.Labels \"${key}\" }}" "$TAG")"
  [ "$actual" = "$expected" ] || fail "label ${key} is '${actual}', expected '${expected}'"
  echo "  ${key}=${actual}"
}

echo "labels on ${TAG}:"
check_label org.opencontainers.image.source "$SOURCE"
check_label org.opencontainers.image.version "$VERSION"
check_label org.opencontainers.image.revision "$REVISION"
check_label org.opencontainers.image.licenses "$LICENSES"
echo "built ${TAG}"
