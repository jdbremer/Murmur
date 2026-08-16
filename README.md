<div align="center">

# Murmur

**Hold a key, speak, release — polished text appears wherever your cursor is.**

Dictation that runs entirely on your own machine. No account, no subscription,
no audio leaving the device.

[![Release](https://img.shields.io/github/v/release/jdbremer/Murmur?label=release)](https://github.com/jdbremer/Murmur/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/jdbremer/Murmur/total?label=downloads)](https://github.com/jdbremer/Murmur/releases)
[![CI](https://github.com/jdbremer/Murmur/actions/workflows/ci.yml/badge.svg)](https://github.com/jdbremer/Murmur/actions/workflows/ci.yml)
[![macOS 13+](https://img.shields.io/badge/macOS-13%2B-black?logo=apple)](#platform-support)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

</div>

<!--
  TODO: a demo GIF belongs here, and it is the single highest-value thing this
  README is missing — the whole product is a gesture, and no amount of prose
  substitutes for watching text land in another app.

  Roughly 8 seconds: hold the key, speak a sentence with an "um" in it, release,
  watch the cleaned line appear in a note. Record with the corner orb visible.
  Commit it to docs/demo.gif and swap this comment for:
      <div align="center"><img src="docs/demo.gif" alt="Murmur in use" width="720"></div>
-->

---

## Install

### [⬇ Download the latest release](https://github.com/jdbremer/Murmur/releases/latest)

That link always resolves to the newest version, so it is the one worth sharing
or bookmarking — never a specific tag. You only need it once: the app updates
itself from then on.

### macOS

| Chip          | File                         |
| ------------- | ---------------------------- |
| Apple Silicon | `Murmur-<version>-arm64.dmg` |
| Intel         | `Murmur-<version>.dmg`       |

Open the DMG and drag Murmur to Applications. It is signed with a Developer ID
and notarised, so it opens normally — no Gatekeeper warning, and none of the
`xattr` incantation an unsigned build would need.

### Windows

Download `Murmur.Setup.<version>.exe` from the [latest release](https://github.com/jdbremer/Murmur/releases/latest).

**It is not code-signed yet**, so SmartScreen shows "Windows protected your PC"
→ _More info_ → _Run anyway_. Only accept that if you trust this build — Murmur
asks for permission to watch your keyboard and type into other applications, so
it is not a prompt to wave through on a whim. [Building it
yourself](CONTRIBUTING.md) sidesteps the question entirely.

### Linux

**X11 sessions only** — see [Platform support](#platform-support) before you
install. Needs glibc 2.39+ (Ubuntu 24.04+, Debian 13+, Fedora 40+).

```bash
chmod +x Murmur-*.AppImage && ./Murmur-*.AppImage   # or:
sudo apt install ./Murmur-*-amd64.deb
```

---

## First run

Installers bundle the speech and polishing servers, so the only thing left is a
model and two permissions.

1. **Grant the permissions.** Onboarding asks for Accessibility and Input
   Monitoring on macOS — the first lets Murmur type into other apps, the second
   lets it see your dictation key. Nothing works without both, and macOS
   requires you to grant them by hand.
2. **Download a model.** Open the Hub → Models and pick a starter. Everything in
   the catalog is downloaded from Hugging Face, checksum-verified, and stored
   locally.
3. **Hold the key and talk.** `fn` on macOS, Right Ctrl on Windows and Linux.
   Release, and the polished text lands in whatever app has your cursor. Press
   Esc mid-sentence to cancel.

---

## Why local-first

Speech-to-text and LLM polishing both run on your machine, against models you
chose and downloaded. That is the entire architecture, not a privacy mode you
switch on.

- **No audio or text ever leaves the device.** The only outbound network path in
  the codebase is a Hugging-Face-only allowlist for downloading models, and it
  is a single file you can read.
- **No accounts, no telemetry, no analytics.** There is nothing to sign into and
  nothing phoning home.
- **A US-only model catalog.** Every listed speech and polishing model comes
  from a US-based organisation, enforced by an origin policy that is validated
  every time the catalog loads — not a claim in a README.
- **It works on a plane.** Once the model is downloaded, the network is
  irrelevant.

---

## What it does

**Dictation, everywhere.** System-wide push-to-talk plus a hands-free mode.
Local speech-to-text (Parakeet, Whisper, Moonshine) and local polishing (Gemma
3, Phi-4-mini, Llama 3.2, OLMo 2), each labelled with its origin and licence.
Fillers removed, punctuation added, your personal dictionary and snippets
applied.

**Command mode.** Select text, hold the key, and speak an instruction — the
selection is rewritten in place by the local model. On failure it never pastes
over your selection.

**Meeting capture** (macOS 14.2+ and Windows). Record a call and transcribe it
live to a Markdown file. Your microphone and the system audio are captured as
separate tracks, so the transcript attributes who said what. **Off by default,
and off means inert**: nothing is watched, captured or written until you switch
it on, and a live recording lights a red dot no setting can suppress.

**The Bar.** A thin resting sliver that grows into a 60 fps waveform while you
speak. Hover it and the pill becomes a row of buttons — Dictate, Scratchpad,
Mic, Hub — so a dictation can start from the mouse, not only the hotkey. It
floats over full-screen apps and follows you across Spaces.

**Insights.** What you have actually used it for: speaking rate against
published typing speeds, lifetime words, the fixes Murmur made for you, a
per-app breakdown, and a year-long streak heatmap. Every counter is local and is
reset only when you press reset.

**Scratchpad.** A small floating note window, one button away, that you can
dictate straight into. Notes are searchable and are never touched by the history
retention window.

**Vibe coding** (off by default, macOS only). With variable recognition on,
Murmur reads the editor in VS Code, Cursor or Windsurf while you dictate and
uses the names in the open file to recognise what you said — `useCallback` comes
back as one word. Spoken filenames become real ones, `@`-tagged in Cursor and
Windsurf. Nothing is stored or logged, and no other app is ever read.

**The Hub.** Onboarding, Models, History with full-text search, Insights, Notes,
Dictionary, Snippets, per-app-category Style, and Help with live permission and
engine status.

---

## Platform support

| Platform           | Dictation           | Default key | Installer              |
| ------------------ | ------------------- | ----------- | ---------------------- |
| macOS 13+          | yes — field-proven  | `fn`        | `.dmg` (arm64 + x64)   |
| Windows 10/11 x64  | yes — gated green   | Right Ctrl  | NSIS `.exe` (unsigned) |
| Linux x64, **X11** | yes — new, unproven | Right Ctrl  | AppImage + `.deb`      |
| Linux, **Wayland** | **no** — see below  | —           | (same package)         |

Read that ordering literally, because the three are not at the same maturity.
**macOS is used daily.** The **Windows** port has its native hook, paste,
sidecars, model install UX and installer, with every gate green on a Windows dev
box — human field testing is what is still thin. The **Linux/X11** backend is
the newest: it compiles and loads in CI on every push and has not yet been
driven through a dictation on real hardware. Treat it accordingly.

### Linux: X11 only, and it says so

The Linux backend uses XRecord to watch the key and XTEST to paste. Neither
reaches a native Wayland client, so on Wayland Murmur would observe nothing and
paste nowhere. That failure is silent by nature — XWayland still sets `DISPLAY`
and every call still succeeds — so the app detects the session up front and
reports itself unavailable with Wayland named as the reason, rather than
offering a dictation key that quietly does nothing.

Choose an **X11**/**Xorg** session at the login screen. Wayland support needs
the `xdg-desktop-portal` GlobalShortcuts protocol plus a `uinput` injector, and
is its own milestone.

Two more consequences of XRecord being listen-only: **Caps Lock and the Space
chords are not offered** on Linux (both need key suppression), and
**secure-input detection reports false** (X11 has no equivalent probe that does
not involve grabbing the keyboard away from the password dialog asking for it).

---

## Building from source

Everything a contributor needs — the dev loop, the per-OS native toolchain,
packaging, the release process, the IPC contract, and how the app degrades with
no models or sidecars installed — is in **[CONTRIBUTING.md](CONTRIBUTING.md)**.

The short version:

```bash
npm install && npm run dev
```

## Project documents

| Document                                 | What is in it                             |
| ---------------------------------------- | ----------------------------------------- |
| [PLAN.md](PLAN.md)                       | The full product and architecture plan    |
| [CONTRIBUTING.md](CONTRIBUTING.md)       | Development, packaging, releases, layout  |
| [HANDOFF.md](HANDOFF.md)                 | Product-wide backlog                      |
| [MAC-HANDOFF.md](MAC-HANDOFF.md)         | macOS residual work                       |
| [WINDOWS-HANDOFF.md](WINDOWS-HANDOFF.md) | Windows residual work                     |
| [LINUX-HANDOFF.md](LINUX-HANDOFF.md)     | Linux residual work, and the X11 boundary |

## License

[MIT](LICENSE) © 2026 Jordan Bremer.

The bundled `whisper-server` and `llama-server` binaries come from whisper.cpp
and llama.cpp, both MIT. Model weights are **not** bundled — you download them
yourself, and each carries its own licence, shown beside it in the Hub.
