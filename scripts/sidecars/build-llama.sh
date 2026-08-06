#!/usr/bin/env bash
#
# Build a macOS universal `llama-server` for Murmur (PLAN §4, §7.1, §11).
#
# Produces:  .sidecars/bin/llama-server          (arm64 + x86_64 universal)
#            .sidecars/bin/llama-server.sha256
#
# Runs on macOS only, and is meant to run in CI (macos-14 for arm64,
# macos-13 for x86_64) or on a developer's Mac. It refuses to run anywhere else
# rather than producing a binary that cannot be shipped.
#
# Usage:
#   scripts/sidecars/build-llama.sh                   # both arches, universal
#   LLAMA_TAG=b10276 scripts/sidecars/build-llama.sh
#   ARCHS="arm64" scripts/sidecars/build-llama.sh     # single-arch, faster
#
# Environment:
#   LLAMA_TAG     llama.cpp release tag to build (default below — pinned).
#   ARCHS         space-separated subset of "arm64 x86_64".
#   OUT_DIR       where the binary lands (default <repo>/.sidecars/bin).
#   WORK_DIR      scratch checkout (default <repo>/.sidecars/src/llama.cpp).
#   CODESIGN_ID   Developer ID Application identity; signs the output when set.
#
# Note on the tag format: llama.cpp tags every master build as `b<number>`
# rather than cutting semver releases, so the pin below is a build tag. Bump it
# deliberately, with the latency bench as the gate (PLAN §16).

set -euo pipefail

LLAMA_TAG="${LLAMA_TAG:-b10276}"
ARCHS="${ARCHS:-arm64 x86_64}"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/../.." && pwd)"

OUT_DIR="${OUT_DIR:-${repo_root}/.sidecars/bin}"
WORK_DIR="${WORK_DIR:-${repo_root}/.sidecars/src/llama.cpp}"

log() { printf '[build-llama] %s\n' "$*"; }
die() { printf '[build-llama] error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "macOS only (this is $(uname -s)). Run it on a Mac or in CI."
command -v cmake >/dev/null 2>&1 || die "cmake not found — brew install cmake"
command -v git >/dev/null 2>&1 || die "git not found"
command -v xcrun >/dev/null 2>&1 || die "Xcode command line tools not found"

log "llama.cpp ${LLAMA_TAG}, arches: ${ARCHS}"

# -- fetch ------------------------------------------------------------------
if [ ! -d "${WORK_DIR}/.git" ]; then
  mkdir -p "$(dirname -- "${WORK_DIR}")"
  git clone --depth 1 --branch "${LLAMA_TAG}" \
    https://github.com/ggml-org/llama.cpp.git "${WORK_DIR}"
else
  git -C "${WORK_DIR}" fetch --depth 1 origin "refs/tags/${LLAMA_TAG}:refs/tags/${LLAMA_TAG}"
  git -C "${WORK_DIR}" checkout --force "${LLAMA_TAG}"
fi

built=()

# -- build per architecture -------------------------------------------------
for arch in ${ARCHS}; do
  build_dir="${WORK_DIR}/build-${arch}"
  log "configuring ${arch}"

  # Metal is arm64-only; x86_64 gets Accelerate + AVX2, which is the tier-C
  # path in PLAN §14 (polish off by default on Intel).
  metal="OFF"
  [ "${arch}" = "arm64" ] && metal="ON"

  # GGML_NATIVE=OFF for the same two reasons as build-whisper.sh: `-march=native`
  # resolves to `apple-m1` when cross-compiling x86_64 on an arm64 host and
  # clang rejects it, and a shipped binary must not be tuned to whichever
  # machine happened to build it.
  #
  # LLAMA_OPENSSL defaults to ON upstream, which makes CMake link cpp-httplib
  # against whatever OpenSSL it finds — on an arm64 runner that is Homebrew's
  # arm64-only dylib, so the x86_64 link dies on undefined SSL_/X509_ symbols.
  #
  # Turning it off is right on the merits, not just as a build workaround:
  # llama-server is only ever reached over loopback (see `loopbackFetch`, which
  # refuses any non-loopback host), and TLS to 127.0.0.1 buys nothing. It also
  # drops an OpenSSL dependency from a binary we ship.

  cmake -S "${WORK_DIR}" -B "${build_dir}" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_OSX_ARCHITECTURES="${arch}" \
    -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 \
    -DBUILD_SHARED_LIBS=OFF \
    -DLLAMA_BUILD_SERVER=ON \
    -DLLAMA_BUILD_EXAMPLES=OFF \
    -DLLAMA_BUILD_TESTS=OFF \
    -DLLAMA_CURL=OFF \
    -DLLAMA_OPENSSL=OFF \
    -DGGML_METAL="${metal}" \
    -DGGML_METAL_EMBED_LIBRARY="${metal}" \
    -DGGML_NATIVE=OFF \
    -DGGML_ACCELERATE=ON

  log "building ${arch}"
  cmake --build "${build_dir}" --config Release --target llama-server -j "$(sysctl -n hw.ncpu)"

  candidate=""
  for path in \
    "${build_dir}/bin/llama-server" \
    "${build_dir}/bin/Release/llama-server" \
    "${build_dir}/tools/server/llama-server"
  do
    if [ -f "${path}" ]; then candidate="${path}"; break; fi
  done
  [ -n "${candidate}" ] || die "llama-server not found under ${build_dir}"

  built+=("${candidate}")
  log "built ${arch}: ${candidate}"
done

# -- combine, strip, sign ---------------------------------------------------
mkdir -p "${OUT_DIR}"
output="${OUT_DIR}/llama-server"

if [ "${#built[@]}" -gt 1 ]; then
  log "creating a universal binary"
  lipo -create -output "${output}" "${built[@]}"
else
  cp -f "${built[0]}" "${output}"
fi

strip -Sx "${output}"
chmod 0755 "${output}"

if [ -n "${CODESIGN_ID:-}" ]; then
  log "signing with ${CODESIGN_ID}"
  codesign --force --options runtime --timestamp --sign "${CODESIGN_ID}" "${output}"
  codesign --verify --strict --verbose=2 "${output}"
fi

shasum -a 256 "${output}" | tee "${output}.sha256"
lipo -info "${output}"
log "done: ${output}"
