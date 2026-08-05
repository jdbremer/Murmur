# Sidecar binaries

Murmur ships two loopback inference servers inside the app bundle
(`Contents/Resources/bin/`), built from source in CI and signed with the
hardened runtime — PLAN §4 and §16 both require that no executable is ever
downloaded at runtime, only model _data_.

| Binary           | Source                          | Pinned tag | Used by                    |
| ---------------- | ------------------------------- | ---------- | -------------------------- |
| `whisper-server` | [ggml-org/whisper.cpp][whisper] | `v1.9.2`   | the Whisper STT engine     |
| `llama-server`   | [ggml-org/llama.cpp][llama]     | `b10276`   | the local polishing engine |

[whisper]: https://github.com/ggml-org/whisper.cpp
[llama]: https://github.com/ggml-org/llama.cpp

## Building

### macOS

Scripts refuse to run elsewhere rather than emitting a Mac-only universal
binary. They need Xcode command line tools, `cmake` and `git`.

```bash
scripts/sidecars/build-whisper.sh          # universal arm64 + x86_64
scripts/sidecars/build-llama.sh

ARCHS="arm64" scripts/sidecars/build-llama.sh          # faster, dev only
WHISPER_TAG=v1.9.3 scripts/sidecars/build-whisper.sh   # try a newer tag
CODESIGN_ID="Developer ID Application: …" scripts/sidecars/build-llama.sh
```

Output lands in `.sidecars/bin/` (git-ignored), together with a `.sha256` file.
`strip -Sx` runs before signing, so the shipped binaries carry no debug symbols;
keep the build tree if you need to symbolicate a crash.

### Windows (dev)

Official ggml-org x64 prebuilds include `whisper-server.exe` + DLLs. Fetch into
`.sidecars/bin/`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/sidecars/fetch-whisper-win.ps1
```

The app resolves `whisper-server.exe` via `resolveSidecarBinary` (Windows adds
the `.exe` suffix). Official Windows prebuilds do not take `--api-key`; the app
binds the sidecar to `127.0.0.1` only and omits that flag on `win32`.

## Where the app looks

`resolveSidecarBinary()` in `apps/desktop/src/main/engines/sidecar.ts` searches,
in order:

1. `$MURMUR_SIDECAR_DIR` — set this to point a dev build at a custom build;
2. `<Resources>/bin/` — where electron-builder places them in a packaged app;
3. `<repo>/.sidecars/bin/` — what these scripts produce.

A missing binary is **not** an error: the engine reports
`unavailable(binary-missing)` naming every path it looked in, and the Bar shows
a message with a next action. That is what lets the whole app — including its
test suite — run on a machine with no sidecars at all, which is the normal state
of the Linux development container.

## Bumping a pin

Both upstreams move quickly and their build flags move with them. The HTTP API
is our stable seam (PLAN §16), so a bump is a deliberate act:

1. change the default tag in the script;
2. rebuild both binaries and run the latency bench (PLAN §13.4) — the gate is
   ±20%;
3. re-run the STT wiring fixtures;
4. commit the new tag with the bench numbers in the message.

`llama.cpp` tags every master commit as `b<number>` rather than cutting semver
releases, which is why its pin looks like a build number.
