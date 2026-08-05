# Agent control loop (Windows handoff)

Unattended **computer-use** driver for Murmur: screenshots, precision clicks,
keyboard chords, and mic simulation — so an AI can iterate overnight without a
human at the keyboard.

## Architecture (hybrid — recommended)

| Layer              | Tool                                                | Use for                                                                          |
| ------------------ | --------------------------------------------------- | -------------------------------------------------------------------------------- |
| **A — In-app**     | Playwright Electron (+ CDP port `9222`)             | Hub selectors, DOM clicks, `window.murmur.*`, dictation pipeline                 |
| **B — OS**         | `@nut-tree-fork/nut-js` + PowerShell Win32 fallback | Full-desktop screenshot, absolute `(x,y)` clicks, real key chords, focus windows |
| **Mic**            | `debug.injectPcm` / `play_audio_to_mic` first       | Synthetic PCM into orchestrator — no admin, no VB-Cable                          |
| **Mic (optional)** | Chromium fake WAV / VB-Audio Cable                  | Real `getUserMedia` path only when needed                                        |

Why hybrid: pure screen coordinates are fragile for React UI; pure CDP cannot
test global hotkeys or paste into Notepad. Use **A** for the Hub, **B** for
system integration.

### Why not stock `@nut-tree/nut-js`?

Prebuilt binaries may require a paid nutjs.dev subscription. We use
**`@nut-tree-fork/nut-js`** (free npm prebuilds) and fall back to PowerShell
`user32` if the native module fails to load.

### VB-Audio Virtual Cable

Optional. Only needed to prove the **real** capture renderer device list.
Product gates must pass with internal inject. If you install Cable later:
play audio into **CABLE Input**, set app/mic to **CABLE Output**.

## Quick start

```bash
npm install
npx playwright install chromium

# terminal A
npm run agent:server

# terminal B
npm run agent -- health
npm run agent -- start
npm run agent -- click-text Help
npm run agent -- shot help
npm run agent -- take_screenshot desktop
npm run agent -- utterance
npm run agent -- snapshot
npm run agent -- stop
```

Artifacts: `.agent/screenshots/` · `.agent/session.json` · `.agent/server.json` (gitignored)

## Auth

Every route needs the per-run token the server writes to `.agent/server.json`
(mode 0600), sent as `x-murmur-agent-token`. `cli.mjs` reads it for you.
Requests carrying an `Origin` or `Referer` header are refused outright.

Loopback binding is not access control here: `/evaluate` runs arbitrary JS in a
renderer that holds the whole `window.murmur` IPC surface, and `/desktop/type`
injects real keystrokes into whatever window has focus. Any page in any browser
the developer has open can POST to `127.0.0.1` without a CORS preflight, so the
token — not the bind address — is what keeps a visited web page from driving the
app and the keyboard.

```bash
curl -H "x-murmur-agent-token: $(jq -r .token .agent/server.json)" \
     http://127.0.0.1:17321/health
```

Set `MURMUR_AGENT_TOKEN` to pin a known value (CI, remote driving).

## Tool map (agent-facing)

| Capability                | CLI                      | HTTP                                    |
| ------------------------- | ------------------------ | --------------------------------------- |
| take_screenshot (desktop) | `take_screenshot [name]` | `POST /take_screenshot`                 |
| screenshot Hub window     | `shot [name]`            | `POST /screenshot`                      |
| click selector            | `click <sel>`            | `POST /click`                           |
| click absolute            | `click-xy x y`           | `POST /click_xy` `{x,y,button?,focus?}` |
| type_text                 | `type hello`             | `POST /type_text`                       |
| press_keys / chords       | `keys Ctrl+Shift+P`      | `POST /press_keys` `{chord}`            |
| play_audio_to_mic         | `play-mic [ms]`          | `POST /play_audio_to_mic`               |
| pipeline utterance        | `utterance`              | `POST /utterance`                       |
| snapshot                  | `snapshot`               | `GET /snapshot`                         |
| focus window              | `focus Murmur`           | `POST /desktop/focus`                   |

## Overnight loop

1. Acceptance contract: [DEFINITION-OF-DONE.md](./DEFINITION-OF-DONE.md)
2. Paste prompt: [OVERNIGHT-PROMPT.md](./OVERNIGHT-PROMPT.md)
3. Windows plan: [../../WINDOWS-HANDOFF.md](../../WINDOWS-HANDOFF.md)

## Env

| Var                         | Meaning                                                      |
| --------------------------- | ------------------------------------------------------------ |
| `MURMUR_AGENT_PORT`         | Control server (default `17321`)                             |
| `MURMUR_CDP_PORT`           | Electron remote debugging (default `9222`)                   |
| `MURMUR_AGENT_SKIP_BUILD=1` | Skip rebuild if `out/` exists                                |
| `MURMUR_AGENT_FAKE_AUDIO`   | WAV path for Chromium fake capture                           |
| `MURMUR_AGENT_URL`          | CLI base URL                                                 |
| `MURMUR_DEV_TOOLS=1`        | Show Help → Developer panel (hidden in normal/production UI) |
