#!/bin/sh
# Fails unless the release tag, the version in package.json, DOCMYREPOS_VERSION in install.sh,
# the version of every package under packages/, the default image tag in docker-compose.yml and
# a CHANGELOG.md section for that version are all the same, so an installer release always
# installs the image of its own version and the packages of a release match it.
#
#   scripts/check-release-versions.sh v1.2.3     # the release workflow passes the tag
#   scripts/check-release-versions.sh            # no tag: compares the files to each other
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

# Compose defaults to the published image of this version (still buildable from source).
# The ${...} is part of the compose file text to match, not a shell expansion.
# shellcheck disable=SC2016
compose_image=$(sed -n 's/^[[:space:]]*image:[[:space:]]*\${DOCMYREPOS_IMAGE:-\([^}]*\)}/\1/p' "$root/docker-compose.yml" | head -n 1)
[ -n "$compose_image" ] || fail "docker-compose.yml has no default DOCMYREPOS_IMAGE of the form ghcr.io/...:VERSION"
compose_tag=${compose_image##*:}
[ "$compose_tag" = "$package" ] || fail "versions differ: package.json='$package' docker-compose.yml image tag='$compose_tag'"
case $compose_image in
  ghcr.io/dash-ai-tools/doc-my-repos:"$package") ;;
  *) fail "docker-compose.yml default image must be ghcr.io/dash-ai-tools/doc-my-repos:$package (found '$compose_image')" ;;
esac

# The GitHub Release body is cut from this section.
[ -f "$root/CHANGELOG.md" ] || fail "CHANGELOG.md is missing"
# Escape dots so 0.1.0 does not match 0x1y0.
package_re=$(printf '%s' "$package" | sed 's/\./\\./g')
grep -Eq "^## (\[${package_re}\]|${package_re})( |$)" "$root/CHANGELOG.md" || fail "CHANGELOG.md has no section for $package"

printf 'versions match: %s\n' "$package"
