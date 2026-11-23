#!/usr/bin/env bash
# Run TLC on the PeerRollback model. Reproducible TLC jar version below.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODEL_DIR="$ROOT/model"
TOOLS_DIR="${ARCADEKIT_TLA_DIR:-$ROOT/.tools}"
JAR="$TOOLS_DIR/tla2tools.jar"
# tla2tools from tlaplus v1.8.0 release (TLC reports Version 2026.11.19.180144).
JAR_URL="${ARCADEKIT_TLA_JAR_URL:-https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar}"
JAR_SHA256="${ARCADEKIT_TLA_JAR_SHA256:-fdffef247f563ef6edbfd44958d2a82db79e7564e07cb673262d896353fa6713}"

mkdir -p "$TOOLS_DIR"
if [[ ! -f "$JAR" ]]; then
  echo "Downloading tla2tools.jar…" >&2
  curl -fsSL -o "$JAR" "$JAR_URL"
fi
got="$(sha256sum "$JAR" | awk '{print $1}')"
if [[ "$got" != "$JAR_SHA256" ]]; then
  echo "tla2tools.jar sha256 mismatch: got $got want $JAR_SHA256" >&2
  exit 1
fi

if ! command -v java >/dev/null; then
  echo "java is required to run TLC" >&2
  exit 1
fi

cd "$MODEL_DIR"
exec java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC -config PeerRollback.cfg PeerRollback.tla "$@"
