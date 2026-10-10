#!/usr/bin/env bash
# Builds the package to publish from a clean clone of a commit that is already on GitHub,
# so nothing on this machine that isn't in the repository (untracked files, local edits,
# what install scripts left in node_modules) can end up in it. Dependencies are installed
# without running their install scripts. Prints the tarball's files and checksum, and the
# command that publishes exactly that file.
#
#   scripts/pack-release.sh [commit]    (default: the commit checked out here; it must be pushed)
set -euo pipefail

commit="$(git rev-parse "${1:-HEAD}")"
remote="$(git remote get-url origin)"
work="$(mktemp -d "${TMPDIR:-/tmp}/jevvium-release.XXXXXX")"

git clone --quiet "$remote" "$work/repo"
cd "$work/repo"
if ! git -c advice.detachedHead=false checkout --quiet "$commit" 2> /dev/null; then
  echo "Commit $commit isn't on $remote: push it first." >&2
  exit 1
fi
npm ci --ignore-scripts --no-audit --no-fund
npm pack --pack-destination "$work" > /dev/null
tarball="$(ls "$work"/jevvium-*.tgz)"

echo
tar -tzf "$tarball" | sed 's/^package\//  /'
echo
echo "Built from $commit:"
shasum -a 256 "$tarball"
echo
echo "Publish exactly this file with:"
echo "  npm publish $tarball"
