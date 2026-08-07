#!/usr/bin/env bash
#
# Build `whisper-server` and `llama-server` for Linux x64 (PLAN §4.1, §11).
#
# Produces:  .sidecars/bin/whisper-server   + .sha256
#            .sidecars/bin/llama-server     + .sha256
#
# One script for both, unlike macOS: there is no universal binary to lipo
# together and no codesigning step, so the two builds differ only in the repo
# and the target and splitting them would be duplication for its own sake.
#
# Usage:
#   scripts/sidecars/build-linux.sh                # both
#   scripts/sidecars/build-linux.sh whisper        # just one
#   WHISPER_TAG=v1.9.2 LLAMA_TAG=b10276 scripts/sidecars/build-linux.sh
#
# Environment:
#   WHISPER_TAG   whisper.cpp release tag (default below — pinned).
#   LLAMA_TAG     llama.cpp release tag (default below — pinned).
#   OUT_DIR       where the binaries land (default <repo>/.sidecars/bin).
#   WORK_DIR      scratch checkouts (default <repo>/.sidecars/src).
#   JOBS          parallel build jobs (default: nproc).
#
# The tags match build-whisper.sh / build-llama.sh on purpose. All three
# platforms ship the same upstream version, so a transcription difference
# between a Mac and a Linux box is never "they were on different builds" —
# PLAN §16 makes the pin the mitigation and bumping it a deliberate act.

set -euo pipefail

# Keep in step with build-whisper.sh and build-llama.sh.
WHISPER_TAG="${WHISPER_TAG:-v1.9.2}"
LLAMA_TAG="${LLAMA_TAG:-b10276}"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/../.." && pwd)"

OUT_DIR="${OUT_DIR:-${repo_root}/.sidecars/bin}"
WORK_DIR="${WORK_DIR:-${repo_root}/.sidecars/src}"
JOBS="${JOBS:-$(nproc 2>/dev/null || echo 4)}"

log() { printf '[build-linux] %s\n' "$*"; }
die() { printf '[build-linux] error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "Linux only (this is $(uname -s)). Use build-whisper.sh / build-llama.sh on macOS."
command -v cmake >/dev/null 2>&1 || die "cmake not found — apt install cmake (dnf: cmake)"
command -v git >/dev/null 2>&1 || die "git not found"
command -v c++ >/dev/null 2>&1 || die "no C++ compiler — apt install build-essential"

targets=("$@")
[ "${#targets[@]}" -eq 0 ] && targets=(whisper llama)

fetch() {
  local url="$1" tag="$2" dir="$3"
  if [ ! -d "${dir}/.git" ]; then
    mkdir -p "$(dirname -- "${dir}")"
    git clone --depth 1 --branch "${tag}" "${url}" "${dir}"
  else
    git -C "${dir}" fetch --depth 1 origin "refs/tags/${tag}:refs/tags/${tag}"
    git -C "${dir}" checkout --force "${tag}"
  fi
}

# Locate a built target — it has moved between bin/ and the example directory
# across upstream releases, so all the historical spots are checked.
locate() {
  local build_dir="$1" name="$2" path
  for path in \
    "${build_dir}/bin/${name}" \
    "${build_dir}/bin/Release/${name}" \
    "${build_dir}/examples/server/${name}" \
    "${build_dir}/tools/server/${name}"
  do
    if [ -f "${path}" ]; then printf '%s' "${path}"; return 0; fi
  done
  return 1
}

finish() {
  local built="$1" name="$2"
  mkdir -p "${OUT_DIR}"
  local output="${OUT_DIR}/${name}"
  cp -f "${built}" "${output}"
  # Debug and local symbols only; keep the build tree if you need to symbolicate.
  strip --strip-unneeded "${output}" 2>/dev/null || true
  chmod 0755 "${output}"
  sha256sum "${output}" | tee "${output}.sha256"
  log "done: ${output}"
}

build_whisper() {
  local dir="${WORK_DIR}/whisper.cpp" build_dir
  build_dir="${dir}/build-linux"
  log "whisper.cpp ${WHISPER_TAG}"
  fetch https://github.com/ggml-org/whisper.cpp.git "${WHISPER_TAG}" "${dir}"

  # GGML_NATIVE=OFF is the same load-bearing flag as on macOS, for the second
  # of the two reasons given there: `-march=native` tunes the binary to the
  # machine that compiled it, so a build host with newer vector extensions
  # than the user's produces a server that dies with SIGILL the first time it
  # reaches one. Shipped binaries must be portable.
  #
  # No GPU backend. CUDA/ROCm/Vulkan would each need their own runtime present
  # on the user's box, and a sidecar that fails to load is worse than a slower
  # one that always works. CPU is the honest default for a first Linux build.
  cmake -S "${dir}" -B "${build_dir}" \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF \
    -DWHISPER_BUILD_EXAMPLES=ON \
    -DWHISPER_BUILD_TESTS=OFF \
    -DGGML_NATIVE=OFF

  cmake --build "${build_dir}" --config Release --target whisper-server -j "${JOBS}"

  local built
  built="$(locate "${build_dir}" whisper-server)" || die "whisper-server not found under ${build_dir}"
  finish "${built}" whisper-server
}

build_llama() {
  local dir="${WORK_DIR}/llama.cpp" build_dir
  build_dir="${dir}/build-linux"
  log "llama.cpp ${LLAMA_TAG}"
  fetch https://github.com/ggml-org/llama.cpp.git "${LLAMA_TAG}" "${dir}"

  # CURL and OpenSSL off: llama-server would otherwise link them for its model
  # downloader, which Murmur never uses — the Hub does every fetch through
  # net/fetch.ts and its Hugging-Face allowlist (PLAN §10.2). Linking them
  # would add runtime deps to the .deb for a code path we refuse to run.
  cmake -S "${dir}" -B "${build_dir}" \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF \
    -DLLAMA_BUILD_SERVER=ON \
    -DLLAMA_BUILD_EXAMPLES=OFF \
    -DLLAMA_BUILD_TESTS=OFF \
    -DLLAMA_CURL=OFF \
    -DLLAMA_OPENSSL=OFF \
    -DGGML_NATIVE=OFF

  cmake --build "${build_dir}" --config Release --target llama-server -j "${JOBS}"

  local built
  built="$(locate "${build_dir}" llama-server)" || die "llama-server not found under ${build_dir}"
  finish "${built}" llama-server
}

for target in "${targets[@]}"; do
  case "${target}" in
    whisper) build_whisper ;;
    llama) build_llama ;;
    *) die "unknown target '${target}' (expected: whisper, llama)" ;;
  esac
done
