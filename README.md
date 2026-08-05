# Murmur

**Local-first dictation for macOS.** Hold a key, speak, release — polished text appears wherever your cursor is.

Murmur mirrors the Wispr Flow experience (floating recording bar, hub window, per-app tones, personal dictionary) but runs **entirely on-device**: speech-to-text and LLM polishing both use local models you choose from a **US-only catalog** — every listed model comes from a US-based organization, enforced by the catalog's origin policy — and no audio or text ever leaves the machine. Built as an Electron app.

- 🎙️ System-wide push-to-talk (hold `fn`) + hands-free mode
- 🧠 Local STT (Parakeet, Whisper, Moonshine, …) and local polishing LLMs (Gemma 3, Phi-4-mini, Llama 3.2, OLMo 2, …) — US-origin only, with origin + license labels
- 🔒 No accounts, no telemetry, no network traffic except user-initiated model downloads

## Status

**Working on macOS (field-proven).** Hold `fn`, speak, release — polished text lands in the frontmost app. Windows port is in progress with native hook, paste, whisper/llama sidecars, and Models install UX. The full plan lives in **[PLAN.md](./PLAN.md)**. Remaining work:

- **[HANDOFF.md](./HANDOFF.md)** — product-wide backlog
- **[MAC-HANDOFF.md](./MAC-HANDOFF.md)** — macOS residual work
- **[WINDOWS-HANDOFF.md](./WINDOWS-HANDOFF.md)** — Windows residual work

What works today:

- **The whole dictation loop**: event tap (own thread, HID-reconciled release so a lost up-edge can never strand a dictation) → capture renderer → pre-roll + VAD → whisper.cpp or ONNX Runtime → local LLM polish with the hallucination guard → clipboard-swap insertion with AX fallback → history.
- **Command mode** (PLAN §18.1): hold the key with text selected and speak an instruction — the selection is rewritten in place by the local model, with a no-fallback failure discipline that never pastes over a selection on error.
- **The Bar**: 28-bar 60 fps canvas waveform on a ~30 Hz mic meter, shimmer, ✓ pulse, error hold, click-through window with hover controls (cancel · mic picker · Hub), Esc-to-cancel, Reduce Motion support, and a distinct indicator when an utterance is editing a selection.
- **The Hub**: first-run onboarding (permissions → starter models → tutorial), Models with the enforced US-only catalog, History with FTS5 search and stats, Dictionary, per-app-category Style, Settings (hotkey, mic picker, language, retention), Help with live permission/engine/capture status.
- **CI**: the full gate on macOS arm64 per push/PR; sidecar builds on demand and weekly.

Still to come: app-wide items in [HANDOFF.md](./HANDOFF.md) (spoken language UX, Parakeet catalog, History tab, insert-copy fallback); llama Metal pin on macOS 27; Windows packaging. See also [MAC-HANDOFF.md](./MAC-HANDOFF.md) and [WINDOWS-HANDOFF.md](./WINDOWS-HANDOFF.md).

## Development

```bash
npm install          # workspaces: apps/desktop, packages/shared
npm run dev          # electron-vite dev — tray, Hub, Bar, hidden capture window
npm run build        # main + preload + all three renderers → apps/desktop/out
npm run typecheck    # tsc across every workspace
npm test             # vitest
npm run lint         # eslint (flat config) — `npm run format` for prettier
```

### Layout

| Path                | What lives there                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `apps/desktop`      | The Electron app: `src/main`, `src/preload`, `src/renderer/{hub,bar,audio}`                           |
| `packages/shared`   | `@murmur/shared` — domain types, zod schemas, catalog policy, the typed IPC contract                  |
| `packages/native`   | `@murmur/native` — the macOS + Windows N-API addon (hotkey, text insertion, permissions)              |
| `resources/catalog` | `models.json`, validated against the origin policy every time it loads                                |
| `scripts/sidecars`  | `whisper-server` / `llama-server` binaries — `.sh` builds macOS universal, `.ps1` fetches Windows x64 |
| `scripts/models`    | The first-party Parakeet NeMo→ONNX export we will run before listing it                               |

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

| Missing                      | What happens                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `whisper-server` binary      | STT engine reports `unavailable(binary-missing)`, naming every path searched |
| `llama-server` binary        | Polish engine likewise; dictation still inserts the raw transcript           |
| `onnxruntime-node`           | ONNX engine reports `unavailable(runtime-missing)`; Whisper is unaffected    |
| The model files themselves   | `unavailable(model-missing)` until the download finishes                     |
| `@murmur/native` (non-macOS) | Hotkey listener never starts; insertion returns `unsupported-platform`       |

`MURMUR_SIDECAR_DIR` points a dev build at a custom sidecar build.
`MURMUR_DEBUG=1` enables debug logging; `MURMUR_LOG_TRANSCRIPTS=1` disables
transcript redaction (local debugging only — see `src/main/logging.ts`).

In an unpackaged build two dev-only IPC channels exist:
`debug.simulateDictation` cycles the state machine with no mic or models, and
`debug.simulateHotkey` feeds the **real** orchestrator a synthetic hotkey edge.
From a shell, `kill -USR2 <electron pid>` does the same as `simulateHotkey` —
each signal alternates down/up — so a whole dictation can be driven without
touching the app: signal, `say` a sentence, signal again.

### macOS vs. other platforms

Murmur ships on macOS first; the Windows port is underway (PLAN.md §4.1, [WINDOWS-HANDOFF.md](./WINDOWS-HANDOFF.md)) and Linux is planned post-1.0. Everything platform-specific — the `fn`-key event tap / Right-Ctrl low-level hook, clipboard-swap text insertion, secure-input detection, the permission prompts — is isolated in `@murmur/native`, which compiles on macOS and Windows (`"os": ["darwin", "win32"]`) and is referenced as an _optional_ dependency.

You can still develop on Linux today (or anywhere the addon is unavailable). `npm install` skips the native package there, and the app loads a typed no-op stub in its place, so `npm run dev` boots and the UI, IPC and state machine all work. Dictation itself does not: the stub reports `available: false`, every permission reads `unavailable`, and text insertion refuses. macOS-only Electron calls (the Bar's `visibleOnFullScreen`, the Hub's inset title bar) are guarded, not assumed.

To build the addon on a Mac:

```bash
npm run native:build   # node-gyp rebuild in packages/native
```

### Adding an IPC channel

1. Declare it in `packages/shared/src/ipc/contract.ts` — `invokeContract` (renderer → main, request/response), `eventContract` (main → renderer) or `messageContract` (renderer → main, fire-and-forget).
2. Register a handler in `apps/desktop/src/main/ipc/register.ts`.
3. Expose it on `window.murmur` in `apps/desktop/src/preload/index.ts`.

Payload types flow from step 1 to steps 2 and 3 automatically, and zod validates at the boundary — see the header comment in `packages/shared/src/ipc/typed.ts` for exactly what is checked when.
