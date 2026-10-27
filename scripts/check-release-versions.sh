#!/bin/sh
# Fails unless the release tag, the version in package.json, DOCMYREPOS_VERSION in install.sh and
# the version of every package under packages/ are all the same, so an installer release always
# installs the image of its own version and the packages of a release match it.
#
#   scripts/check-release-versions.sh v1.2.3     # the release workflow passes the tag
#   scripts/check-release-versions.sh            # no tag: compares package.json and install.sh
#
# CHECK_ROOT points at another checkout (the tests use it).
set -eu

root=${CHECK_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}
tag=${1:-}

package=$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' "$root/package.json" | head -n 1)
installer=$(sed -n 's/^DOCMYREPOS_VERSION="\([^"]*\)"$/\1/p' "$root/install.sh" | head -n 1)
release=${tag#v}

fail() {
  printf 'check-release-versions: %s\n' "$*" >&2
  exit 1
}

semver='^[0-9]+\.[0-9]+\.[0-9]+$'
printf '%s' "$package" | grep -Eq "$semver" || fail "package.json has no MAJOR.MINOR.PATCH version (found '$package')"
printf '%s' "$installer" | grep -Eq "$semver" || fail "install.sh has no DOCMYREPOS_VERSION of the form MAJOR.MINOR.PATCH (found '$installer')"
if [ -n "$tag" ]; then
  case $tag in
    v*) ;;
    *) fail "the tag '$tag' must start with v (for example v$package)" ;;
  esac
  printf '%s' "$release" | grep -Eq "$semver" || fail "the tag '$tag' is not vMAJOR.MINOR.PATCH"
fi

if [ "$package" != "$installer" ] || { [ -n "$tag" ] && [ "$release" != "$package" ]; }; then
  fail "versions differ: tag='${tag:-none}' package.json='$package' install.sh='$installer'"
fi

# The published packages share the app's version (changesets `fixed`).
for dir in "$root"/packages/*/; do
  [ -f "$dir/package.json" ] || continue
  name=$(basename "$dir")
  own=$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' "$dir/package.json" | head -n 1)
  [ "$own" = "$package" ] || fail "versions differ: package.json='$package' packages/$name/package.json='$own'"
done

printf 'versions match: %s\n' "$package"
