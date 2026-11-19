#!/usr/bin/env bash
# Runs publint and @arethetypeswrong/cli on each published package.
# Packs each package with pnpm first, so both tools see exactly what npm would get
# (only `files` included). Build first:
#   pnpm build:packages && pnpm lint:packages
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

failed=()
for name in arcadekit three; do
  dir="$root/packages/$name"
  tarball="$(cd "$dir" && pnpm pack --pack-destination "$out" | tail -n 1)"
  if ! "$root/node_modules/.bin/publint" run "$tarball" --strict; then
    failed+=("publint($name)")
  fi
  if ! "$root/node_modules/.bin/attw" "$tarball" --profile esm-only --no-emoji; then
    failed+=("attw($name)")
  fi
done

if ((${#failed[@]} > 0)); then
  echo "Failed: ${failed[*]}" >&2
  exit 1
fi
echo "arcadekit and @arcadekit/three pass publint and attw."
