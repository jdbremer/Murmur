# Linux handoff

**Scope: Linux only.** Cross-platform product queue: [HANDOFF.md](./HANDOFF.md).
macOS: [MAC-HANDOFF.md](./MAC-HANDOFF.md). Windows:
[WINDOWS-HANDOFF.md](./WINDOWS-HANDOFF.md). Spec: [PLAN.md](./PLAN.md) §4.1, M8.

| Doc                              | Owner / purpose                                                        |
| -------------------------------- | ---------------------------------------------------------------------- |
| [PLAN.md](./PLAN.md)             | Shared product & engineering spec. Linux is §4.1 and milestone **M8**. |
| [HANDOFF.md](./HANDOFF.md)       | **App-wide** product backlog.                                          |
| **LINUX-HANDOFF.md** (this file) | Linux port status, the X11/Wayland boundary, residual work.            |

---

## Where things stand

**Honest summary: the code exists, compiles and loads. Nobody has dictated with
it.** Read the gate table as "not started", not "failing".

| Gate                     | Status      | Notes                                                                                      |
| ------------------------ | ----------- | ------------------------------------------------------------------------------------------ |
| Compiles                 | **pass**    | `gate-ports` on `ubuntu-latest` builds the addon per push (`libx11-dev`, `libxtst-dev`)    |
| Loads                    | **pass**    | Same job asserts `platformInfo()` is not the JS stub                                       |
| Typecheck / test / build | **pass**    | Full suite green on the Linux leg                                                          |
| L0 Boot                  | **not run** | Hub loads, `platform=linux`                                                                |
| L1 Dev loop              | **not run** | `kill -USR2 <pid>` → listening→…→`stt-failed` with no model                                |
| L2 Mic                   | **not run** | getUserMedia through PipeWire/PulseAudio                                                   |
| L3 UI                    | **not run** | Settings shows Right Ctrl / Right Alt / Right Super / Custom; **no** fn, Caps Lock, chords |
| L4 Native load           | **not run** | `@murmur/native: active — linux x64 X11 (XTEST yes, RECORD yes, …)`                        |
| L5 Paste                 | **not run** | `debug.insertText` → text lands in gedit/GNOME Text Editor                                 |
| L6 Hotkey                | **not run** | XRecord delivers Right Ctrl down/up; `hotkeyPhysicallyDown` tracks `XQueryKeymap`          |
| L7 STT                   | **not run** | `whisper-server` from `build-linux.sh` + whisper-tiny-en → inserted                        |
| L8 Selection             | **not run** | Command mode reads the PRIMARY selection                                                   |
| L9 Wayland refusal       | **not run** | On a Wayland session the Hub says so and the key is never presented as working             |
| L10 Stability            | **not run** | 20× short utterance, 0 stuck, 0 crash                                                      |
| L11 Packaging            | **not run** | AppImage and `.deb` install and launch on Ubuntu LTS                                       |

The first session on real hardware should walk L0–L11 in order. L9 is the one
most likely to be wrong in an interesting way, because it depends on how a
given desktop sets `XDG_SESSION_TYPE` and `WAYLAND_DISPLAY`.

---

## The X11 boundary

`packages/native/src/linux/murmur_native_linux.cpp` uses **XRecord** to observe
the hotkey and **XTEST** to paste. Both are X11 extensions and neither reaches
a native Wayland client.

This is why the backend refuses a Wayland session outright rather than trying:
XWayland leaves `DISPLAY` set, `XOpenDisplay` succeeds, the record context is
created — and no key from a Wayland app is ever delivered. A dictation key that
looks configured and silently never fires is the exact failure this codebase
keeps refusing to ship, so `isAvailable()` returns false and `platformInfo()`
names Wayland as the reason.

**XRecord is listen-only.** It cannot swallow a key, and three things follow:

| Consequence                         | Why, and where it is handled                                                                                                                                                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No Caps Lock, no Space chords       | Both need suppression: Caps Lock would toggle caps every dictation, a chord would type a space. `LINUX_HOTKEY_KEYS` omits them and `sanitizeHotkeyForPlatform` heals them to Right Ctrl.                                                                                |
| `isSecureInputActive` returns false | X11 has no `EnableSecureEventInput` twin. The only probe — testing for an exclusive keyboard grab — means grabbing the keyboard away from the password dialog you are trying to detect.                                                                                 |
| Our own paste could self-trigger    | Windows tags injected keys via `dwExtraInfo`; XRecord carries no such field, so a `gInjecting` flag brackets the XTEST call. It is a window, not a tag — an edge already queued when the flag goes up still arrives. Only reachable with a Custom binding on Ctrl or V. |

PLAN §4.1 originally specified XGrabKey so the key _could_ be suppressed. That
is unworkable for bare-modifier presets: an XGrabKey grab on Right Ctrl takes
the key exclusively, so Ctrl stops working in every other app while Murmur
runs. The deviation is recorded in PLAN §4.1.

---

## Not yet done

| Item                        | Why it matters                                                                                                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A dictation on hardware** | Everything above is compile-and-load confidence. No transcript has been inserted into a real Linux app. This is the gate that matters.                                                                |
| Wayland                     | Needs the `xdg-desktop-portal` GlobalShortcuts protocol for the key and a `uinput` injector (or the virtual-keyboard protocol) for paste. Its own milestone; today Wayland is refused with a message. |
| AT-SPI2 insertion fallback  | `insertTextViaAccessibility` reports unimplemented. macOS uses its AX twin for apps that drop synthetic keystrokes; on Linux those apps have no fallback and the paste simply fails.                  |
| StatusNotifier tray         | PLAN §4.1 lists it. Electron's tray works on most desktops; GNOME needs an extension. Unverified.                                                                                                     |
| Flatpak                     | PLAN §4.1 lists AppImage + `.deb` + Flatpak. The first two are wired into `pack:linux`; Flatpak is not, and its sandbox would need holes for X11 and the sidecars.                                    |
| arm64                       | `electron-builder.yml` builds x64 only. The sidecar script builds for the host, so an arm64 package needs an arm64 runner.                                                                            |
| Multi-monitor Bar           | Same open question as Windows — repositions to the cursor's display, unverified on a real multi-head desk.                                                                                            |
| Sidecar digests             | `build-linux.sh` builds from a pinned tag rather than fetching, so there is no download to pin a digest against — but the tag pin should stay in step with the macOS scripts.                         |
| GPU sidecars                | `build-linux.sh` builds CPU-only on purpose (a Vulkan/CUDA sidecar that fails to load is worse than a slower one that always works). Revisit once there is a machine to measure on.                   |

---

## Building it

```bash
sudo apt install libx11-dev libxtst-dev cmake build-essential
npm install
npm run native:build          # fails loudly if the X11 headers are missing
scripts/sidecars/build-linux.sh
npm run pack:linux --workspace @murmur/desktop
```

Driving it without touching the UI, same as macOS:

```bash
kill -USR2 <electron pid>     # alternates hotkey down/up
spd-say "this is a test"
kill -USR2 <electron pid>
```
