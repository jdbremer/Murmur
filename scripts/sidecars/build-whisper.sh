#!/usr/bin/env bash
#
# Build a macOS universal `whisper-server` for Murmur (PLAN §4, §11).
#
# Produces:  .sidecars/bin/whisper-server        (arm64 + x86_64 universal)
#            .sidecars/bin/whisper-server.sha256
#
# Runs on macOS only, and is meant to run in CI (macos-14 for arm64,
# macos-13 for x86_64) or on a developer's Mac. It refuses to run anywhere else
# rather than producing a binary that cannot be shipped.
#
# Usage:
#   scripts/sidecars/build-whisper.sh                 # both arches, universal
#   WHISPER_TAG=v1.9.2 scripts/sidecars/build-whisper.sh
#   ARCHS="arm64" scripts/sidecars/build-whisper.sh   # single-arch, faster
#
# Environment:
#   WHISPER_TAG   whisper.cpp release tag to build (default below — pinned).
#   ARCHS         space-separated subset of "arm64 x86_64".
#   OUT_DIR       where the binary lands (default <repo>/.sidecars/bin).
#   WORK_DIR      scratch checkout (default <repo>/.sidecars/src/whisper.cpp).
#   CODESIGN_ID   Developer ID Application identity; signs the output when set.
#
# Why a pinned tag: whisper.cpp's HTTP API is our stable seam, but its build
# flags and server flags do move. PLAN §16 makes version-pinning the mitigation,
# and bumping this constant is a deliberate act gated by the bench suite.

set -euo pipefail

WHISPER_TAG="${WHISPER_TAG:-v1.9.2}"
ARCHS="${ARCHS:-arm64 x86_64}"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/../.." && pwd)"

OUT_DIR="${OUT_DIR:-${repo_root}/.sidecars/bin}"
WORK_DIR="${WORK_DIR:-${repo_root}/.sidecars/src/whisper.cpp}"

log() { printf '[build-whisper] %s\n' "$*"; }
die() { printf '[build-whisper] error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "macOS only (this is $(uname -s)). Run it on a Mac or in CI."
command -v cmake >/dev/null 2>&1 || die "cmake not found — brew install cmake"
command -v git >/dev/null 2>&1 || die "git not found"
command -v xcrun >/dev/null 2>&1 || die "Xcode command line tools not found"

log "whisper.cpp ${WHISPER_TAG}, arches: ${ARCHS}"

# -- fetch ------------------------------------------------------------------
if [ ! -d "${WORK_DIR}/.git" ]; then
  mkdir -p "$(dirname -- "${WORK_DIR}")"
  git clone --depth 1 --branch "${WHISPER_TAG}" \
    https://github.com/ggml-org/whisper.cpp.git "${WORK_DIR}"
else
  git -C "${WORK_DIR}" fetch --depth 1 origin "refs/tags/${WHISPER_TAG}:refs/tags/${WHISPER_TAG}"
  git -C "${WORK_DIR}" checkout --force "${WHISPER_TAG}"
fi

built=()

# -- build per architecture -------------------------------------------------
for arch in ${ARCHS}; do
  build_dir="${WORK_DIR}/build-${arch}"
  log "configuring ${arch}"

  # Metal is arm64-only; an x86_64 build falls back to Accelerate + AVX, which
  # is the tier-C path in PLAN §14.
  metal="OFF"
  [ "${arch}" = "arm64" ] && metal="ON"

  # GGML_NATIVE=OFF is load-bearing twice over.
  #
  # It has to be off to cross-compile at all: ggml's default adds
  # `-march=native`, which on an Apple Silicon host resolves to `apple-m1`
  # even while the target is x86_64, and clang rejects it — "unknown target
  # CPU 'apple-m1'". That is what broke the first release build.
  #
  # It also has to be off for anything we *ship*. `-march=native` tunes the
  # binary to the machine that compiled it, so a runner with newer vector
  # extensions than the user's Mac produces a whisper-server that dies with
  # SIGILL the first time it hits one. A portable build is the point.

  cmake -S "${WORK_DIR}" -B "${build_dir}" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_OSX_ARCHITECTURES="${arch}" \
    -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 \
    -DBUILD_SHARED_LIBS=OFF \
    -DWHISPER_BUILD_EXAMPLES=ON \
    -DWHISPER_BUILD_TESTS=OFF \
    -DGGML_METAL="${metal}" \
    -DGGML_METAL_EMBED_LIBRARY="${metal}" \
    -DGGML_NATIVE=OFF \
    -DGGML_ACCELERATE=ON

  log "building ${arch}"
  cmake --build "${build_dir}" --config Release --target whisper-server -j "$(sysctl -n hw.ncpu)"

  # The target has moved between bin/ and the example directory across releases.
  candidate=""
  for path in \
    "${build_dir}/bin/whisper-server" \
    "${build_dir}/bin/Release/whisper-server" \
    "${build_dir}/examples/server/whisper-server"
  do
    if [ -f "${path}" ]; then candidate="${path}"; break; fi
  done
  [ -n "${candidate}" ] || die "whisper-server not found under ${build_dir}"

  built+=("${candidate}")
  log "built ${arch}: ${candidate}"
done

# -- combine, strip, sign ---------------------------------------------------
mkdir -p "${OUT_DIR}"
output="${OUT_DIR}/whisper-server"

if [ "${#built[@]}" -gt 1 ]; then
  log "creating a universal binary"
  lipo -create -output "${output}" "${built[@]}"
else
  cp -f "${built[0]}" "${output}"
fi

# -Sx removes debug and local symbols. Keep the dSYMs from the build tree if you
# need to symbolicate a crash; the shipped binary does not carry them.
strip -Sx "${output}"
chmod 0755 "${output}"

if [ -n "${CODESIGN_ID:-}" ]; then
  log "signing with ${CODESIGN_ID}"
  # Hardened runtime is required for notarisation (PLAN §16).
  codesign --force --options runtime --timestamp --sign "${CODESIGN_ID}" "${output}"
  codesign --verify --strict --verbose=2 "${output}"
fi

shasum -a 256 "${output}" | tee "${output}.sha256"
lipo -info "${output}"
log "done: ${output}"
