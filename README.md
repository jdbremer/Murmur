# Murmur

**Local-first dictation for macOS.** Hold a key, speak, release — polished text appears wherever your cursor is.

Murmur mirrors the Wispr Flow experience (floating recording bar, hub window, per-app tones, personal dictionary) but runs **entirely on-device**: speech-to-text and LLM polishing both use local models you choose from a **US-only catalog** — every listed model comes from a US-based organization, enforced by the catalog's origin policy — and no audio or text ever leaves the machine. Built as an Electron app.

- 🎙️ System-wide push-to-talk (hold `fn`) + hands-free mode
- 🧠 Local STT (Parakeet, Whisper, Moonshine, …) and local polishing LLMs (Gemma 3, Phi-4-mini, Llama 3.2, OLMo 2, …) — US-origin only, with origin + license labels
- 🔒 No accounts, no telemetry, no network traffic except user-initiated model downloads

## Status

Early implementation. The full product & engineering plan lives in **[PLAN.md](./PLAN.md)** — UX spec, architecture, model catalogs, roadmap (M0–M6), risks, and open questions.

The scaffold is in place: the workspaces, the typed IPC contract, the model-catalog origin policy, the tray, the three windows and the three renderer apps. Speech-to-text, polishing, the model downloader and the native hotkey tap are not implemented yet.

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
