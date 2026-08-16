# Contributing to Murmur

Everything below used to live in the README. It moved here when the README
became the front door for people installing the app rather than building it —
nothing was dropped.

The full product and architecture plan is **[PLAN.md](PLAN.md)**; the remaining
work is split across [HANDOFF.md](HANDOFF.md), [MAC-HANDOFF.md](MAC-HANDOFF.md),
[WINDOWS-HANDOFF.md](WINDOWS-HANDOFF.md) and
[LINUX-HANDOFF.md](LINUX-HANDOFF.md).

## Development

The same on all three platforms:

```bash
npm install          # workspaces: apps/desktop, packages/shared
npm run dev          # electron-vite dev — tray, Hub, Bar, hidden capture window
npm run build        # main + preload + all three renderers → apps/desktop/out
npm run typecheck    # tsc across every workspace
npm test             # vitest
npm run lint         # eslint (flat config) — `npm run format` for prettier
```

Building the native addon needs a toolchain, and only that differs by OS:

| OS      | What `npm install` needs to compile `@murmur/native`                     |
| ------- | ------------------------------------------------------------------------ |
| macOS   | Xcode Command Line Tools (`xcode-select --install`)                      |
| Windows | Visual Studio Build Tools with the C++ workload                          |
| Linux   | `apt install libx11-dev libxtst-dev` (dnf: `libX11-devel libXtst-devel`) |

A failed addon build never fails the install — you get a working checkout with
a no-op stub and no dictation, and `npm run native:build` is the command that
reports why, loudly.

Anywhere the addon is missing or fails to build, the app loads a typed no-op
stub instead. `npm run dev` boots and the UI, IPC and state machine all work;
dictation does not — the stub reports `available: false`, every permission reads
`unavailable`, and text insertion refuses. macOS-only Electron calls (the Bar's
`visibleOnFullScreen`, the Hub's inset title bar) are guarded, not assumed.

```bash
npm run native:build   # node-gyp rebuild in packages/native
```

## Packaging

Run the script for the OS you are on:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack:mac --workspace @murmur/desktop
```

| Script       | Runs on | Produces                                                         |
| ------------ | ------- | ---------------------------------------------------------------- |
| `pack:mac`   | macOS   | `apps/desktop/release/Murmur-<version>-arm64.dmg` and an x64 one |
| `pack:win`   | Windows | the NSIS `.exe`                                                  |
| `pack:linux` | Linux   | the `.AppImage` and the `.deb`                                   |

Each has to be built on its own OS: the native module and `better-sqlite3` are
both compiled per platform.

Whatever is in `.sidecars/bin` is bundled into the app's resources, which is
where a packaged app looks first. Build them first or you get an installer that
runs and cannot transcribe:

| OS      | Sidecar build                                                            |
| ------- | ------------------------------------------------------------------------ |
| macOS   | `scripts/sidecars/build-whisper.sh` and `build-llama.sh` (needs `cmake`) |
| Windows | `scripts/sidecars/fetch-*-win.ps1` — downloads official prebuilds        |
| Linux   | `scripts/sidecars/build-linux.sh` (needs `cmake` and `build-essential`)  |

Packaging without them succeeds deliberately, so a contributor who only needs
the UI is not forced through a whisper.cpp build — the release workflow is
where their absence is a hard failure.

The env var above skips macOS code signing, which is what you want for a local
build on a machine that has no Developer ID in its keychain — without it,
electron-builder hunts for an identity, fails, and takes the build down with
it. Drop it if you do have the certificate: `hardenedRuntime`, the entitlements
and notarisation are declared in `apps/desktop/electron-builder.yml`, and that
is the path releases take.

## Cutting a release

Bump the version across every manifest, commit, tag, and push:

```bash
npm version 0.4.5 --workspaces --include-workspace-root --no-git-tag-version
npm pkg set version=0.4.5 --prefix packages/native
npm install --package-lock-only --ignore-scripts
git add -A && git commit -m "Release 0.4.5"
git tag -a v0.4.5 -m "Murmur 0.4.5 — what changed"
git push origin main --follow-tags
```

**All three of the first commands, not just the first.** `npm version
--workspaces` covers the root, `apps/desktop` and `packages/shared` — and misses
`packages/native`, which is deliberately not a workspace so that a machine which
cannot run node-gyp still installs against the stub. The lockfile needs the same
correction, which is what the `--package-lock-only` install is for.

Getting this wrong is easy and invisible: the app builds and runs perfectly with
a native module reporting the previous version. `packages/shared/test/versions.test.ts`
is the gate that catches it, and it fails the release build rather than the
local one you were about to skip.

`.github/workflows/release.yml` then builds every installer on its native runner
and attaches them all to a **draft** release. Draft, so nothing reaches anyone
until you open it and click publish. The workflow runs typecheck and tests
against the tagged commit first, and fails loudly if the native module does not
compile or load — an installer whose addon silently failed would launch fine and
never dictate. The macOS signing secrets it expects are listed in a comment in
the workflow.

Publishing is also what the README's download link starts pointing at:
`releases/latest` resolves to the newest **published** release and ignores
drafts, so the link is correct the moment you click publish and not before.

There is no Homebrew tap, deliberately. A cask would buy one convenient install
line and nothing after it — the app updates itself through electron-updater, so
`brew upgrade` would have to be told to stay out of the way — while costing a
second repo, a cross-repo push token, and another thing to fail on release day.
Worth revisiting if people start asking for it; not worth carrying before then.

## Layout

| Path                | What lives there                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/desktop`      | The Electron app: `src/main`, `src/preload`, `src/renderer/{hub,bar,audio}`                                                                                                                 |
| `packages/shared`   | `@murmur/shared` — domain types, zod schemas, catalog policy, the typed IPC contract                                                                                                        |
| `packages/native`   | `@murmur/native` — the N-API addon (hotkey, text insertion, permissions): `src/murmur_native.mm` for macOS, `src/win/` for Windows, `src/linux/` for X11                                    |
| `resources/catalog` | `models.json`, validated against the origin policy every time it loads                                                                                                                      |
| `scripts/sidecars`  | `whisper-server` / `llama-server` binaries — `build-whisper.sh`/`build-llama.sh` build macOS universal, `build-linux.sh` builds Linux x64, `fetch-*-win.ps1` download Windows x64 prebuilds |
| `scripts/models`    | The first-party Parakeet NeMo→ONNX export we will run before listing it                                                                                                                     |

Inside `apps/desktop/src/main`:

| Path           | What lives there                                                                 |
| -------------- | -------------------------------------------------------------------------------- |
| `dictation/`   | The orchestrator (the loop), the hotkey bridge, clipboard-swap insertion         |
| `engines/`     | `SttEngine` / `PolishEngine` impls, sidecar lifecycle, the ONNX decode loops     |
| `models/`      | Catalog loading, the resumable downloader, on-disk storage, the hardware advisor |
| `store/`       | SQLite (WAL, migrations, FTS5), the repositories, the settings JSON store        |
| `net/fetch.ts` | The **only** outbound network path — a Hugging-Face-only allowlist (PLAN §10.2)  |
| `config.ts`    | Every timeout, threshold and budget, in one place                                |

## Running without models or sidecars

Everything degrades to a status rather than a crash, which is what makes the app
developable on a machine that has none of the heavy parts:

| Missing                    | What happens                                                                   |
| -------------------------- | ------------------------------------------------------------------------------ |
| `whisper-server` binary    | STT engine reports `unavailable(binary-missing)`, naming every path searched   |
| `llama-server` binary      | Polish engine likewise; dictation still inserts the raw transcript             |
| `onnxruntime-node`         | ONNX engine reports `unavailable(runtime-missing)`; Whisper is unaffected      |
| The model files themselves | `unavailable(model-missing)` until the download finishes                       |
| `@murmur/native`           | Hotkey listener never starts; insertion returns `unsupported-platform`         |
| An X11 session (Linux)     | The addon loads but reports `available: false` and names Wayland as the reason |

`MURMUR_SIDECAR_DIR` points a dev build at a custom sidecar build.
`MURMUR_DEBUG=1` enables debug logging; `MURMUR_LOG_TRANSCRIPTS=1` disables
transcript redaction (local debugging only — see `src/main/logging.ts`).

In an unpackaged build two dev-only IPC channels exist:
`debug.simulateDictation` cycles the state machine with no mic or models, and
`debug.simulateHotkey` feeds the **real** orchestrator a synthetic hotkey edge.
On macOS and Linux, `kill -USR2 <electron pid>` does the same as
`simulateHotkey` — each signal alternates down/up — so a whole dictation can be
driven from a shell without touching the app: signal, speak (`say` on macOS,
`spd-say` on Linux), signal again. Windows has no POSIX signals; drive it
through the IPC channel or `scripts/agent/` instead.

## Adding an IPC channel

1. Declare it in `packages/shared/src/ipc/contract.ts` — `invokeContract` (renderer → main, request/response), `eventContract` (main → renderer) or `messageContract` (renderer → main, fire-and-forget).
2. Register a handler in `apps/desktop/src/main/ipc/register.ts`.
3. Expose it on `window.murmur` in `apps/desktop/src/preload/index.ts`.

Payload types flow from step 1 to steps 2 and 3 automatically, and zod validates
at the boundary — see the header comment in `packages/shared/src/ipc/typed.ts`
for exactly what is checked when.

## CI

The full gate (lint, format, typecheck, test, build) runs on macOS arm64 per
push and PR, plus a port gate on `windows-latest` and `ubuntu-latest` that
compiles _and loads_ each platform's native addon — the only check that catches
an MSVC or GCC break the Mac job never sees. Sidecar builds run on demand and
weekly.
