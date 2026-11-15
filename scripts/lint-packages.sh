#!/usr/bin/env bash
# Runs publint and @arethetypeswrong/cli on the published arcadekit package.
# Packs the package with pnpm first, so both tools see exactly what npm would get
# (only `files` included). Build first:
#   pnpm build:packages && pnpm lint:packages
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$root/packages/arcadekit"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

failed=()
tarball="$(cd "$dir" && pnpm pack --pack-destination "$out" | tail -n 1)"
if ! "$root/node_modules/.bin/publint" run "$tarball" --strict; then
  failed+=("publint")
fi
if ! "$root/node_modules/.bin/attw" "$tarball" --profile esm-only --no-emoji; then
  failed+=("attw")
fi

if ((${#failed[@]} > 0)); then
  echo "Failed: ${failed[*]}" >&2
  exit 1
fi
echo "arcadekit passes publint and attw."
