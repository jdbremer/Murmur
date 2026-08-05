# Murmur

**Local-first dictation for macOS.** Hold a key, speak, release — polished text appears wherever your cursor is.

Murmur mirrors the Wispr Flow experience (floating recording bar, hub window, per-app tones, personal dictionary) but runs **entirely on-device**: speech-to-text and LLM polishing both use local models you choose from a **US-only catalog** — every listed model comes from a US-based organization, enforced by the catalog's origin policy — and no audio or text ever leaves the machine. Built as an Electron app.

- 🎙️ System-wide push-to-talk (hold `fn`) + hands-free mode
- 🧠 Local STT (Parakeet, Whisper, Moonshine, …) and local polishing LLMs (Gemma 3, Phi-4-mini, Llama 3.2, OLMo 2, …) — US-origin only, with origin + license labels
- 🔒 No accounts, no telemetry, no network traffic except user-initiated model downloads

## Status

Early implementation. The full product & engineering plan lives in **[PLAN.md](./PLAN.md)** — UX spec, architecture, model catalogs, roadmap (M0–M6), risks, and open questions.

The **main process is complete**: the dictation orchestrator with per-stage timeouts and typed error states, the no-ML VAD, both STT engines (whisper.cpp sidecar, ONNX Runtime utility process), the polish engine with its prompt builder and hallucination guard, the model manager with a resumable checksum-verified downloader, the SQLite store with FTS5 search, clipboard-swap text insertion, and the macOS native module (event tap, paste synthesis, permissions).

Still to come: the Bar and Hub UIs, the audio-capture renderer's `getUserMedia` half, onboarding, and CI. Dictation therefore does not run end to end yet — the main process is ready for it, the microphone is not connected.

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

| Path                | What lives there                                                                        |
| ------------------- | --------------------------------------------------------------------------------------- |
| `apps/desktop`      | The Electron app: `src/main`, `src/preload`, `src/renderer/{hub,bar,audio}`             |
| `packages/shared`   | `@murmur/shared` — domain types, zod schemas, catalog policy, the typed IPC contract    |
| `packages/native`   | `@murmur/native` — the macOS-only N-API addon (hotkey tap, text insertion, permissions) |
| `resources/catalog` | `models.json`, validated against the origin policy every time it loads                  |
| `scripts/sidecars`  | Build universal `whisper-server` / `llama-server` binaries — macOS only                 |
| `scripts/models`    | The first-party Parakeet NeMo→ONNX export we will run before listing it                 |

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

### macOS vs. other platforms

Murmur ships on macOS first; Windows and Linux ports are planned post-1.0 (PLAN.md §4.1). Everything platform-specific — the `fn`-key event tap, clipboard-swap text insertion, secure-input detection, the permission prompts — is isolated in `@murmur/native`, which for now is compiled only on macOS (`"os": ["darwin"]`) and referenced as an _optional_ dependency.

You can still develop on Linux or Windows today. `npm install` skips the native package there, and the app loads a typed no-op stub in its place, so `npm run dev` boots and the UI, IPC and state machine all work. Dictation itself does not: the stub reports `available: false`, every permission reads `unavailable`, and text insertion refuses. macOS-only Electron calls (the Bar's `visibleOnFullScreen`, the Hub's inset title bar) are guarded, not assumed.

To build the addon on a Mac:

```bash
npm run native:build   # node-gyp rebuild in packages/native
```

### Adding an IPC channel

1. Declare it in `packages/shared/src/ipc/contract.ts` — `invokeContract` (renderer → main, request/response), `eventContract` (main → renderer) or `messageContract` (renderer → main, fire-and-forget).
2. Register a handler in `apps/desktop/src/main/ipc/register.ts`.
3. Expose it on `window.murmur` in `apps/desktop/src/preload/index.ts`.

Payload types flow from step 1 to steps 2 and 3 automatically, and zod validates at the boundary — see the header comment in `packages/shared/src/ipc/typed.ts` for exactly what is checked when.
