# What “perfect” means for the Windows overnight loop

This is the **acceptance contract**. The agent may only stop (or mark a phase
complete) when the matching checks pass via `scripts/agent` — not when code
“looks right.”

Re-read this file at the start of every overnight cycle.

## Locked decisions (human quiz — 2026-08-04)

| Decision               | Choice                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| Overnight stop line    | **Hardened perfect: G0–G10** (not just MVP)                                                        |
| Default Windows hotkey | **Right Ctrl hold** (not Ctrl+Space default; chords still supported)                               |
| First STT path         | **whisper.cpp sidecar `.exe` first** (not ONNX-first)                                              |
| Mac isolation          | **Shared contract PRs allowed** (schema/IPC ok; still prefer additive win files)                   |
| Mic for gates          | **injectPcm is fine**; best if we can also produce a **recognizable word that pastes** (see G5/G7) |
| Paste matrix (G5)      | **Notepad only**                                                                                   |
| Stuck gate (3 fails)   | **Document blocker + skip to next unblocked gate**; never leave tree broken                        |

---

## Non‑negotiables (product)

1. **Hold key/chord → speak → release → polished text appears** in the focused
   app (Notepad at minimum; Chrome/Teams as stretch).
2. **Local-first**: no audio/transcript leaves the machine except user-initiated
   model downloads from the HF allowlist.
3. **Windows UI never lies**: no macOS keys (fn/⌘/⌥), no fake Accessibility /
   Input Monitoring as macOS TCC.
4. **Fail soft**: missing model/sidecar/native capability is a clear status +
   next action, never a crash or silent no-op.
5. **Privacy of the hook**: listen only for the configured hotkey/chord; never
   buffer or log other key content.

---

## Agent verification gates (must automate)

| Gate                  | How to prove                                                             | Pass criteria                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| G0 Boot               | `agent start` + `snapshot`                                               | Hub loads; `platform=win32`; no crash                                                                                                       |
| G1 Dev loop           | `click-text Help` + `shot` + `utterance`                                 | Pipeline runs; snapshot shows listening→…→error/inserted                                                                                    |
| G2 Mic sim            | `play-mic` during listening                                              | Levels move or buffer advances; no hang                                                                                                     |
| G3 UI Windows         | Settings hotkey list                                                     | No fn/⌘/⌥ labels when `platform=win32`                                                                                                      |
| G4 Native load        | `snapshot.app.native`                                                    | Contains `active` (not stub) on win32 after Phase C                                                                                         |
| G5 Paste              | Focus Notepad + insert test phrase                                       | Exact phrase appears in Notepad; clipboard restored                                                                                         |
| G5b Recognizable word | Prefer real STT word **or** agent `debug` path that inserts a known word | At least one path pastes a real word string (e.g. `hello`) into Notepad — sine-only PCM that never becomes text is not enough for “perfect” |
| G6 Hotkey             | Default **Right Ctrl** hold; OS key or simulate                          | Hold starts listen; release finishes; no stuck listen                                                                                       |
| G7 STT                | **whisper-server.exe** + catalog model + utterance                       | `inserted` with non-empty text (stretch: polish on)                                                                                         |
| G8 Secure field       | Password-class focus                                                     | Dictation refused with clear message                                                                                                        |
| G9 Elevated           | Elevated Notepad (optional)                                              | Clear UIPI error, no hang                                                                                                                   |
| G10 Stability         | 20× utterance loop                                                       | No crash; no stuck `processing`                                                                                                             |

**Done for “Windows MVP”** = G0–G7 green on this machine.  
**Done for this overnight run (human lock)** = **G0–G10 green** + no open P0 in
`WINDOWS-HANDOFF.md`. Agent may stop only then (or when process is killed).

---

## Phase map (same as WINDOWS-HANDOFF)

| Phase | Theme             | Exit gate                              |
| ----- | ----------------- | -------------------------------------- |
| A     | Iteration cockpit | G0–G2                                  |
| B     | Windows surface   | G3                                     |
| C     | Native scaffold   | G4                                     |
| D     | Paste             | G5                                     |
| E     | Hotkey + chords   | G6                                     |
| F     | App categories    | snapshot frontmost ≠ null in work apps |
| G     | STT engines       | G7                                     |
| H     | Harden + pack     | G8–G10 + installer stretch             |

---

## What the agent must do each cycle

1. `health` — server + OS backend alive
2. `start` if not running (rebuild unless `MURMUR_AGENT_SKIP_BUILD=1` mid-cycle)
3. Implement **one** vertical slice toward the next failing gate
4. `typecheck` + relevant unit tests
5. Re-run the gate commands; screenshot on fail into `.agent/screenshots/`
6. Update `WINDOWS-HANDOFF.md` “Where things stand” if a gate newly passes
7. If gate fails after a change: fix or revert; do not advance phase
8. Stop only when **Windows MVP (G0–G7)** is green, unless the human’s prompt
   asks to continue toward G10

---

## Explicit out of scope for MVP (do not block overnight)

- NSIS / Authenticode / winget
- Vulkan GPU sidecars (CPU/ONNX first)
- Pixel-perfect Bar waveform art
- Full Mac HANDOFF items (Bar polish, onboarding) unless they block Windows gates
- Linux

---

## Mic strategy order

1. **`debug.injectPcm` / `play_audio_to_mic`** — always available, no admin
2. Chromium `--use-file-for-fake-audio-capture` when a WAV is provided
3. VB-Audio Virtual Cable + ffmpeg — optional, only if testing real
   `getUserMedia` device enumeration

Never block product progress on (3).
