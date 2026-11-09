#!/usr/bin/env bash
# Runs publint and @arethetypeswrong/cli on the published arcadekit package (ADR-0018), then
# checks that the built arcadekit/core and arcadekit/input import no effect.
# Packs the package with pnpm first, so both tools see exactly what npm would get
# (only `files` included). attw checks each of the package's entries. Build first:
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
if ! (cd "$root" && ARCADEKIT_REQUIRE_DIST=1 "$root/node_modules/.bin/vitest" run packages/arcadekit/test/effect-free.test.ts); then
  failed+=("effect-free entries")
fi

if ((${#failed[@]} > 0)); then
  echo "Failed: ${failed[*]}" >&2
  exit 1
fi
echo "arcadekit passes publint, attw and the effect-free check."
