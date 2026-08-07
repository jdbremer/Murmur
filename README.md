# Murmur

**Local-first dictation for macOS, Windows and Linux.** Hold a key, speak, release — polished text appears wherever your cursor is.

Murmur mirrors the Wispr Flow experience (floating recording bar, hub window, per-app tones, personal dictionary) but runs **entirely on-device**: speech-to-text and LLM polishing both use local models you choose from a **US-only catalog** — every listed model comes from a US-based organization, enforced by the catalog's origin policy — and no audio or text ever leaves the machine. Built as an Electron app.

- 🎙️ System-wide push-to-talk (`fn` on macOS, Right Ctrl on Windows and Linux) + hands-free mode
- 🧠 Local STT (Parakeet, Whisper, Moonshine, …) and local polishing LLMs (Gemma 3, Phi-4-mini, Llama 3.2, OLMo 2, …) — US-origin only, with origin + license labels
- 🔒 No accounts, no telemetry, no network traffic except user-initiated model downloads

## Download

Installers are attached to each [release](https://github.com/jdbremer/Murmur/releases):

| OS      | File                             | Notes                                                             |
| ------- | -------------------------------- | ----------------------------------------------------------------- |
| macOS   | `.dmg`, separate arm64 and Intel | macOS 13 Ventura or newer                                         |
| Windows | NSIS `.exe`, x64                 | Windows 10 / 11                                                   |
| Linux   | `.AppImage` and `.deb`, x64      | **X11 sessions only** — see [Platform support](#platform-support) |

**They are all currently unsigned**, which each OS will tell you about in its
own alarming way:

- **macOS** quarantines anything downloaded and Gatekeeper refuses to open it,
  usually reporting that Murmur "is damaged". It is not. Right-click → Open, or
  on macOS 15+ go to System Settings → Privacy & Security → Open Anyway. You can
  also clear it directly: `xattr -dr com.apple.quarantine /Applications/Murmur.app`
- **Windows** SmartScreen shows "Windows protected your PC" → More info → Run anyway.
- **Linux** has no equivalent gate. Mark the AppImage executable and run it
  (`chmod +x Murmur-*.AppImage`), or `sudo apt install ./murmur_*.deb`.

Only accept those warnings if you trust this build — Murmur asks for permission
to watch your keyboard and type into other applications, so that is not a
prompt to wave through on a whim. Building it yourself (below) sidesteps the
question entirely. Signing and notarisation are the fix and are already
declared in `apps/desktop/electron-builder.yml`, waiting on a certificate.

Also note macOS ties Accessibility and Input Monitoring grants to an app's code
signature, so with an unsigned build those permissions can reset on each update.

Installers bundle the `whisper-server` and `llama-server` binaries, so the only
thing left after installing is downloading a model from the Hub.

## Status

**Field-proven on macOS. Gated green on Windows. New and unproven on Linux.** Hold the key, speak, release — polished text lands in the frontmost app.

Read that ordering literally, because the three are not at the same maturity. macOS is used daily. The Windows port has its native hook, paste, whisper/llama sidecars, Models install UX and NSIS installer, with gates G0–G10 green on a Windows dev box ([WINDOWS-HANDOFF.md](./WINDOWS-HANDOFF.md)); human field testing is what is still thin. The Linux/X11 backend is the newest of the three — it compiles and loads in CI on every push, and has not yet been driven through a dictation on real hardware. Treat it accordingly. The full plan lives in **[PLAN.md](./PLAN.md)**. Remaining work:

- **[HANDOFF.md](./HANDOFF.md)** — product-wide backlog
- **[MAC-HANDOFF.md](./MAC-HANDOFF.md)** — macOS residual work
- **[WINDOWS-HANDOFF.md](./WINDOWS-HANDOFF.md)** — Windows residual work
- **[LINUX-HANDOFF.md](./LINUX-HANDOFF.md)** — Linux residual work, and the X11/Wayland boundary

What works today:

- **The whole dictation loop**: key listener (own thread, HID-reconciled release so a lost up-edge can never strand a dictation) → capture renderer → pre-roll + VAD → whisper.cpp or ONNX Runtime → local LLM polish with the hallucination guard → clipboard-swap insertion (with an Accessibility fallback on macOS, for apps that drop synthetic keystrokes) → history. The listener is a `CGEventTap` on macOS, a `WH_KEYBOARD_LL` hook on Windows and an XRecord context on Linux; the reconciliation reads `IOHID`, `GetAsyncKeyState` and `XQueryKeymap` respectively.
- **Command mode** (PLAN §18.1): hold the key with text selected and speak an instruction — the selection is rewritten in place by the local model, with a no-fallback failure discipline that never pastes over a selection on error.
- **The Bar**: 28-bar 60 fps canvas waveform on a ~30 Hz mic meter, shimmer, ✓ pulse, error hold, click-through window with hover controls (cancel · mic picker · Hub), Esc-to-cancel, Reduce Motion support, and a distinct indicator when an utterance is editing a selection.
- **The Hub**: first-run onboarding (permissions → starter models → tutorial), Models with the enforced US-only catalog, History with FTS5 search and stats, Dictionary, per-app-category Style, Settings (hotkey, mic picker, language, retention), Help with live permission/engine/capture status.
- **CI**: the full gate (lint, format, typecheck, test, build) on macOS arm64 per push/PR, plus a port gate on `windows-latest` and `ubuntu-latest` that compiles _and loads_ each platform's native addon — the only check that catches an MSVC or GCC break the Mac job never sees; sidecar builds on demand and weekly.

Still to come: app-wide items in [HANDOFF.md](./HANDOFF.md) (spoken language UX, Parakeet catalog, History tab, insert-copy fallback); llama Metal pin on macOS 27; on Windows, hook-health recovery and a human E2E pass on the installer; on Linux, a first dictation on real hardware, plus Wayland (see below). See also [MAC-HANDOFF.md](./MAC-HANDOFF.md), [WINDOWS-HANDOFF.md](./WINDOWS-HANDOFF.md) and [LINUX-HANDOFF.md](./LINUX-HANDOFF.md).

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

### Packaging

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

The env var above skips macOS code signing; see [Download](#download) for what
unsigned means in practice. Drop it once a Developer ID is configured —
`hardenedRuntime`, the entitlements and notarisation are already declared in
`apps/desktop/electron-builder.yml`.

### Cutting a release

Push a tag and `.github/workflows/release.yml` builds every installer on its
native runner and attaches them all to a **draft** release:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

Draft, so nothing reaches anyone until you open it and click publish. The
workflow runs typecheck and tests against the tagged commit first, and fails
loudly if the native module does not compile or load — an installer whose addon
silently failed would launch fine and never dictate. The macOS signing secrets
it expects are listed in a comment in the workflow.

### Layout

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

### Running without models or sidecars

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

### Platform support

| Platform           | Dictation           | Default key | Installer            |
| ------------------ | ------------------- | ----------- | -------------------- |
| macOS 13+          | yes — field-proven  | `fn`        | `.dmg` (arm64 + x64) |
| Windows 10/11 x64  | yes — gates G0–G10  | Right Ctrl  | NSIS `.exe`          |
| Linux x64, **X11** | yes — new, unproven | Right Ctrl  | AppImage + `.deb`    |
| Linux, **Wayland** | **no** — see below  | —           | (same package)       |

Everything platform-specific — the key listener, clipboard-swap text insertion,
secure-input detection, the permission prompts — is isolated in
`@murmur/native`, which compiles on all three (`"os": ["darwin", "win32", "linux"]`)
and is referenced as an _optional_ dependency:

```bash
npm run native:build   # node-gyp rebuild in packages/native
```

Anywhere the addon is missing or fails to build, the app loads a typed no-op
stub instead. `npm run dev` boots and the UI, IPC and state machine all work;
dictation does not — the stub reports `available: false`, every permission reads
`unavailable`, and text insertion refuses. macOS-only Electron calls (the Bar's
`visibleOnFullScreen`, the Hub's inset title bar) are guarded, not assumed.

#### Linux: X11 only, and it says so

The Linux backend uses XRecord to watch the key and XTEST to paste. Neither
reaches a native Wayland client, so on a Wayland session Murmur would observe
nothing and paste nowhere. That failure is silent by nature — XWayland still
sets `DISPLAY`, `XOpenDisplay` still succeeds, the record context is still
created, and no key ever arrives — so the addon detects the session up front
and reports `available: false` with Wayland named as the reason, rather than
presenting a dictation key that quietly does nothing.

To dictate on Linux today, choose an **X11**/**Xorg** session at the login
screen. Wayland support needs the `xdg-desktop-portal` GlobalShortcuts protocol
plus a `uinput` injector, and is its own milestone (PLAN §4.1, M8).

Two more consequences of XRecord being listen-only — it can observe keys but
never swallow one:

- **Caps Lock and the Space chords are not offered** on Linux. Both depend on
  suppression; without it, Caps Lock would toggle caps on every dictation and a
  chord would type a space. Right Ctrl, Right Alt, Right Super and a custom
  keycode are the presets, and none of those is suppressed on any platform.
- **Secure-input detection reports false.** X11 has no
  `EnableSecureEventInput` twin, and the nearest probe — testing for an
  exclusive keyboard grab — would mean grabbing the keyboard away from whatever
  password dialog is asking for it.

The macOS Accessibility insertion fallback also has no Linux twin (its
equivalent is AT-SPI2 over D-Bus); `insertTextViaAccessibility` reports that
plainly rather than letting main believe a fallback succeeded.

### Adding an IPC channel

1. Declare it in `packages/shared/src/ipc/contract.ts` — `invokeContract` (renderer → main, request/response), `eventContract` (main → renderer) or `messageContract` (renderer → main, fire-and-forget).
2. Register a handler in `apps/desktop/src/main/ipc/register.ts`.
3. Expose it on `window.murmur` in `apps/desktop/src/preload/index.ts`.

Payload types flow from step 1 to steps 2 and 3 automatically, and zod validates at the boundary — see the header comment in `packages/shared/src/ipc/typed.ts` for exactly what is checked when.
