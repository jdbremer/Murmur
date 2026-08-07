#!/usr/bin/env bash
# Builds the macOS system-audio tap helper (PLAN §18.2).
#
# A standalone binary rather than part of @murmur/native: see the comment at
# the top of the Swift source for why the realtime constraints are worth
# isolating in their own process.
#
# Produces a universal binary so one build serves Apple silicon and Intel.
# macOS-only; a no-op everywhere else so `npm run build` stays portable.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-audio-tap: not macOS — skipping (meetings will run mic-only)."
  exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$ROOT/apps/desktop/resources/macos-audio-tap.swift"
OUT_DIR="$ROOT/apps/desktop/resources"
OUT="$OUT_DIR/macos-audio-tap"

if [[ ! -f "$SRC" ]]; then
  echo "build-audio-tap: $SRC is missing." >&2
  exit 1
fi

if ! command -v swiftc >/dev/null 2>&1; then
  echo "build-audio-tap: swiftc not found — install Xcode command line tools." >&2
  exit 1
fi

# 14.2 is where AudioHardwareCreateProcessTap arrives. The deployment target
# stays below the app's own floor of 13.0 on purpose: the binary is simply
# never spawned on older systems, and meetings fall back to mic-only.
build_slice() {
  local arch="$1" out="$2"
  swiftc "$SRC" \
    -O \
    -target "${arch}-apple-macosx14.2" \
    -framework CoreAudio \
    -framework AudioToolbox \
    -framework AVFoundation \
    -framework Foundation \
    -o "$out"
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "build-audio-tap: compiling arm64..."
build_slice arm64 "$TMP/tap-arm64"

if build_slice x86_64 "$TMP/tap-x86_64" 2>/dev/null; then
  echo "build-audio-tap: linking universal binary..."
  lipo -create "$TMP/tap-arm64" "$TMP/tap-x86_64" -output "$OUT"
else
  echo "build-audio-tap: x86_64 slice unavailable — shipping arm64 only."
  cp "$TMP/tap-arm64" "$OUT"
fi

chmod +x "$OUT"
echo "build-audio-tap: wrote $OUT"
lipo -archs "$OUT" 2>/dev/null || true
