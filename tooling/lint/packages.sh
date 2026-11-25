#!/usr/bin/env bash
# Runs publint and @arethetypeswrong/cli on each published package, then
# tooling/lint/consumer.ts on a program that installs both.
# Packs each package with pnpm first, so the checks see exactly what npm would get
# (only `files` included). Build first:
#   pnpm build:packages && pnpm lint:packages
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT

consumer="$out/consumer"
mkdir -p "$consumer"
echo '{ "type": "module" }' >"$consumer/package.json"

failed=()
for name in arcadekit three; do
  dir="$root/packages/$name"
  tarball="$(cd "$dir" && pnpm pack --pack-destination "$out" | tail -n 1)"
  installed="$consumer/node_modules/$(node -p "require('$dir/package.json').name")"
  mkdir -p "$installed"
  tar -xzf "$tarball" -C "$installed" --strip-components=1
  if ! "$root/node_modules/.bin/publint" run "$tarball" --strict; then
    failed+=("publint($name)")
  fi
  if ! "$root/node_modules/.bin/attw" "$tarball" --profile esm-only --no-emoji; then
    failed+=("attw($name)")
  fi
done

# The peers, at the versions the workspace locks.
for peer in effect @effect/platform-browser three @types/three; do
  mkdir -p "$(dirname "$consumer/node_modules/$peer")"
  ln -s "$(readlink -f "$root/packages/three/node_modules/$peer")" "$consumer/node_modules/$peer"
done
if ! node "$root/tooling/lint/consumer.ts" "$consumer"; then
  failed+=("consumer(run time)")
fi
if ! "$root/node_modules/.bin/tsc" -p "$consumer"; then
  failed+=("consumer(types)")
fi

if ((${#failed[@]} > 0)); then
  echo "Failed: ${failed[*]}" >&2
  exit 1
fi
echo "arcadekit and @arcadekit/three pass publint, attw and the consumer check."
