# Windows handoff

**Scope: Windows only.** Cross-platform product queue: [HANDOFF.md](./HANDOFF.md).
macOS: [MAC-HANDOFF.md](./MAC-HANDOFF.md). Spec: [PLAN.md](./PLAN.md).

| Doc | Owner / purpose |
| --- | --- |
| [PLAN.md](./PLAN.md) | Shared product & engineering spec. Windows is §4.1 and milestone **M7**. |
| [HANDOFF.md](./HANDOFF.md) | **App-wide** product backlog (language, Parakeet, History tab, insert-copy toast, privacy). |
| [MAC-HANDOFF.md](./MAC-HANDOFF.md) | macOS residual work. |
| **WINDOWS-HANDOFF.md** (this file) | Windows port status, gates, agent automation, OS-specific residual work. |

Session-only AI notes stay **out of the repo** (local agent state, scratch
plans). Anything durable for the product lands here or in a small code change.

**Autonomous loop:** hybrid computer-use via `scripts/agent/` (Playwright in-app
+ nut.js/Win32 OS control + injectPcm mic). Humans optional.

- Control API: [scripts/agent/README.md](./scripts/agent/README.md)  
- Acceptance gates: [scripts/agent/DEFINITION-OF-DONE.md](./scripts/agent/DEFINITION-OF-DONE.md)  
- Overnight prompt: [scripts/agent/OVERNIGHT-PROMPT.md](./scripts/agent/OVERNIGHT-PROMPT.md)

```bash
npm run agent:server          # keep running
npm run agent -- start
npm run agent -- click-text Help
npm run agent -- shot help
npm run agent -- take_screenshot desktop
npm run agent -- utterance    # down + inject PCM + up + snapshot
npm run agent -- stop
```

---

## Where things stand (Windows)

Verified on a Windows dev box (agent overnight loop — **commits only, never push**):

| Gate | Status | Notes |
| --- | --- | --- |
| G0 Boot | **pass** | Hub loads; `platform=win32` |
| G1 Dev loop | **pass** | `utterance` → listening→…→`stt-failed` (no model) |
| G2 Mic sim | **pass** | `play-mic` / injectPcm frames land |
| G3 UI Windows | **pass** | Settings = Right Ctrl / chords; **no** fn/⌘/⌥ |
| G4 Native load | **pass** | `@murmur/native: active — win32 x64` (`src/win/murmur_native_win.cpp`) |
| G5 Paste | **pass** | `debug.insertText` → Notepad file contains `hello` (SendInput + focus fix) |
| G5b Word | **pass (canned)** | Recognizable word pasted; real STT word still G7 |
| G6 Hotkey | **pass** | `WH_KEYBOARD_LL` installed; `startHotkeyListener` → true; Right Ctrl down/up via nut.js |
| G7 STT | **pass** | `whisper-server.exe` + `whisper-tiny-en`; JFK sample → `inserted` (107 chars, paste) |
| G8 Secure field | **pass** | Password TextBox focus → `secure-input` / “Secure field — Murmur will not type here.” |
| G9 Elevated | **pass** | Early refuse via `isForegroundElevated` + clear admin/UIPI message (unit + native API; live elevated Notepad needs UAC) |
| G10 Stability | **pass** | 20× short JFK utterance: 20 inserted, 0 stuck, 0 crash (~600 ms each) |

**Gates G0–G10** were green on the agent overnight loop. Human field testing
continues; treat E2E with real voice + polish as still worth a casual poke.

### Windows residual (platform-specific)

| Item | Notes |
| --- | --- |
| Ctrl+Space / Alt+Space chords | Removed from Settings; boot migrates to Right Ctrl — re-add only when Space latch is proven solid |
| Bar visibility on multi-monitor | Repositions to cursor display; verify on real multi-monitor desks |
| In-app sidecar install | Models UI installs whisper/llama from GitHub after confirm; keep HF allowlist story honest in docs |
| Polish “Ready” after install | After `Install llama-server` + Gemma download, badge should be Ready — re-verify |
| App-wide product items | See [HANDOFF.md](./HANDOFF.md) (language, Parakeet, History tab, insert-copy toast) |

Idle policy: if blocked, walk every Hub section — “would I like this as a user?” / advances hold→speak→insert.

---

## Constraints (how we work)

1. **Modular for two people.** Prefer new files under platform-specific paths
   (`packages/native/src/win/`, `apps/desktop/src/main/platform/win32/`,
   `*.win32.ts`, `scripts/sidecars/*.ps1`). Touch shared Mac paths only when the
   contract must change.
2. **Shared contracts stay deliberate.** Schema / IPC edits are small, backward
   compatible with existing Mac `settings.json`, and coordinated.
3. **Iteration first.** Before native glory: open the app, drive the real
   pipeline from the Hub, see the Bar, see mic levels or mic errors.
4. **Chords are first-class** on Windows (e.g. Ctrl+Space, Alt+Space), not only
   single keys. Schema and native matching must be correct before polish UX.
5. **Paste must be flawless** (clipboard race, UIPI/elevated apps, UIA fallback,
   password fields). If paste is wrong, the product is useless.

---

## Architecture (PLAN §4.1)

Only `@murmur/native` and packaging are per-OS. Windows implements:

| Concern | Approach |
| --- | --- |
| Hold-to-talk | `WH_KEYBOARD_LL` in the native module; chords + suppression |
| Text insert | Clipboard swap (already in main) + `SendInput` Ctrl+V; UIA fallback |
| Frontmost app | `GetForegroundWindow` → process name / AUMID |
| Permissions UI | Mic privacy; no fake Accessibility / Input Monitoring as on macOS |
| Sidecars | `*.exe` resolution + PowerShell/CMake builds; ONNX path can land first |
| Packaging | NSIS + signing later (after E2E) |

---

## Phases (effort: S / M / L — not calendar)

### A — Iteration cockpit · **M** · *landed (in tree)*

Dev-only Hub tools so we can iterate without a native hook:

- Simulate Bar tour (`debug.simulateDictation`).
- **Real pipeline** edges: hotkey down / up / double-tap / hold-then-release
  (`debug.simulateHotkey` exposed in Help → Developer).
- Live mic level + capture status broadcast (`audio.captureStatus`), including
  errors while idle.
- Engine + native status strip; platform badge (`win32` / `darwin`).
- Re-warm mic from the Hub (`debug.warmMic`).
- `app.info` for platform branching (Windows Help copy no longer pretends to be macOS TCC).

**Done:** on Windows, without `@murmur/native`, hold/release simulation drives
the Bar and orchestrator; mic shows levels or an explicit error.

Files (additive / small shared IPC): `WINDOWS-HANDOFF.md`, `DevToolsCard.tsx`,
`HelpSection.tsx` (platform branch), `app.info` + `debug.warmMic` +
`audio.captureStatus` in shared IPC, register/preload wiring.
`scripts/agent/` — Playwright Electron driver for unattended start / screenshot /
click / mic inject.

### B — Windows surface (hide Mac chrome) · **S–M** · *landed (G3)*

Platform-specific Settings hotkey lists and Help copy. No fn / ⌘ / ⌥ on Windows.
Schema accepts Windows presets (`rightCtrl`, `ctrlSpace`, `altSpace`, `capsLock`).

### C — Native scaffold · **M** · *current*

`packages/native/src/win/`, binding.gyp win condition, load path, `available: true`.

### D — Paste · **M–L**

SendInput + UIA + elevation errors + clipboard restore tuned on Windows.

### E — Global hotkey + chords · **L**

LL hook; presets include **Ctrl+Space**, **Alt+Space**, Right Ctrl, Caps Lock;
custom chords. Shared schema stays Mac-compatible.

### F — Frontmost app categories · **S**

Windows process map; dispatcher leaves Mac patterns intact.

### G — Speech engines · **M–L**

G1 ONNX STT (fastest). G2 whisper/llama `.exe` resolve + build scripts.

### H — E2E + packaging/CI · **M**

Win11 acceptance; NSIS/signing when ready; `windows-latest` CI leg.

---

## Execution order

```
A  Iteration cockpit     ✓ G0–G2
B  Windows-only UI       ✓ G3
C  Native scaffold       ✓ G4
D  Paste                 ✓ G5 / G5b (canned)
E  Hotkey + chords       ✓ G6 (Right Ctrl + chords in native)
F  App categories
G  STT                   ✓ G7 (whisper-server.exe + tiny.en)
H  Ship / CI             ✓ G8–G10 (secure / elevated refuse / 20× stable)
```

---

## File ownership (avoid merge pain)

| Mostly Windows (additive) | Shared (coordinate) | Mostly Mac (avoid on this branch) |
| --- | --- | --- |
| `packages/native/src/win/**` | `packages/shared` schema/IPC | `packages/native/src/*.mm` |
| `apps/desktop/.../platform/win32/**` | `packages/native/index.js`, `binding.gyp` | Mac-only Help/Settings strings if extracted |
| `scripts/sidecars/*.ps1` | `sidecar.ts` (`.exe` resolve) | `scripts/sidecars/*.sh` |
| `WINDOWS-HANDOFF.md`, `scripts/agent/**` | App-wide [HANDOFF.md](./HANDOFF.md) items | [MAC-HANDOFF.md](./MAC-HANDOFF.md) |

Branch practice: long-lived Windows work off `main`; rebase often; no drive-by
Mac refactors.

---

## Success criteria

**Iteration (A):** real hotkey simulate down/up; live level or mic error; status
visible; no physical hotkey required.

**Windows MVP:** no Mac-only UI; native active; chords work; paste reliable;
one STT path; Mac PRs do not thrash Windows-only files.

---

## Defaults

| Choice | Default |
| --- | --- |
| Default Windows hotkey | **Right Ctrl** hold (Ctrl+Space / Alt+Space / Caps Lock as presets) |
| First STT | **whisper.cpp `.exe` first** (ONNX later) |
| Caps Lock | Preset available, not default |
| Installer | After E2E once on this machine |
