#!/bin/sh
# Writes the CHANGELOG.md section for one MAJOR.MINOR.PATCH version to stdout (or to --output).
# Used by the release workflow to fill the GitHub Release body. Fails if the section is missing.
#
#   scripts/release-notes.sh 0.1.0
#   scripts/release-notes.sh 0.1.0 --output release-notes.md
#
# CHECK_ROOT points at another checkout (the tests use it).
set -eu

root=${CHECK_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}
version=${1:-}
output=""

fail() {
  printf 'release-notes: %s\n' "$*" >&2
  exit 1
}

[ -n "$version" ] || fail "usage: release-notes.sh MAJOR.MINOR.PATCH [--output file]"
shift
while [ $# -gt 0 ]; do
  case $1 in
    --output)
      [ $# -ge 2 ] || fail "--output needs a path"
      output=$2
      shift 2
      ;;
    --output=*)
      output=${1#--output=}
      shift
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done

printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail "version must be MAJOR.MINOR.PATCH (got '$version')"
changelog=$root/CHANGELOG.md
[ -f "$changelog" ] || fail "CHANGELOG.md is missing"

# Keep a Changelog headings: "## [0.1.0] - 2026-10-29" or "## 0.1.0 - 2026-10-29".
version_re=$(printf '%s' "$version" | sed 's/\./\\./g')
start=$(grep -nE "^## (\[${version_re}\]|${version_re})( |$)" "$changelog" | head -n 1 | cut -d: -f1 || true)
[ -n "$start" ] || fail "CHANGELOG.md has no '## [$version]' (or '## $version') section"

next=$(tail -n +$((start + 1)) "$changelog" | grep -nE '^## ' | head -n 1 | cut -d: -f1 || true)
if [ -n "$next" ]; then
  end=$((start + next - 1))
else
  end=$(wc -l <"$changelog")
fi

tmp=$(mktemp)
trap 'rm -f -- "$tmp"' EXIT
# Heading becomes a top-level markdown title for the GitHub Release body.
sed -n "${start},${end}p" "$changelog" | sed -e '1s/^## /# /' >"$tmp"
# Drop trailing blank lines.
while [ -s "$tmp" ] && [ -z "$(tail -n 1 "$tmp" | tr -d '[:space:]')" ]; do
  # POSIX: remove the last line.
  sed '$d' "$tmp" >"$tmp.next"
  mv -- "$tmp.next" "$tmp"
done
[ -s "$tmp" ] || fail "CHANGELOG.md section for $version is empty"
printf '\nFull changelog: https://github.com/Dash-AI-Tools/doc-my-repos/blob/v%s/CHANGELOG.md\n' "$version" >>"$tmp"

if [ -n "$output" ]; then
  cp -- "$tmp" "$output"
else
  cat -- "$tmp"
fi
