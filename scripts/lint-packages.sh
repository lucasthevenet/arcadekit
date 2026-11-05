#!/usr/bin/env bash
# Runs publint and @arethetypeswrong/cli on each published kit package (ADR-0016).
# Packs every package with pnpm first, so both tools see exactly what npm would get
# (workspace: ranges rewritten, only `files` included). Build the packages first:
#   pnpm build:packages && pnpm lint:packages
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
packages=(core input content save audio render-three runtime net foldkit)
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

failed=()
for name in "${packages[@]}"; do
  echo "── @arcadekit/$name"
  dir="$root/packages/$name"
  tarball="$(cd "$dir" && pnpm pack --pack-destination "$out" | tail -n 1)"
  if ! "$root/node_modules/.bin/publint" run "$tarball" --strict; then
    failed+=("$name (publint)")
  fi
  if ! "$root/node_modules/.bin/attw" "$tarball" --profile esm-only --no-emoji; then
    failed+=("$name (attw)")
  fi
done

if ((${#failed[@]} > 0)); then
  echo "Failed: ${failed[*]}" >&2
  exit 1
fi
echo "All ${#packages[@]} packages pass publint and attw."
