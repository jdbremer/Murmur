# Mac handoff — remaining work

**Scope: macOS only.** Cross-platform product queue: [HANDOFF.md](./HANDOFF.md).
Windows: [WINDOWS-HANDOFF.md](./WINDOWS-HANDOFF.md). Spec: [PLAN.md](./PLAN.md).

This file continues the macOS queue as of `origin/main` (2026-08-05 field-proven
dictation). Platform-shared product items (language picker UX, Parakeet catalog,
History tab, insert-fallback copy toast) live in **HANDOFF.md**, not here.

---
# Handoff ΓÇö remaining work

Written 2026-08-05, superseding the 2026-08-04 version. Everything below is
verified against the tree at this commit: `npm run typecheck`, `npm run lint`,
`npm test` (497 tests) and `npm run build` are green on an M5 Pro running
macOS 27, and ΓÇö the headline ΓÇö **dictation has now been demonstrated end to
end on real hardware**: synthetic hotkey edge ΓåÆ live microphone ΓåÆ VAD ΓåÆ
whisper-server (Metal) ΓåÆ Gemma polish ΓåÆ clipboard-swap paste into TextEdit ΓåÆ
history row ΓåÆ idle. A 7.0 s utterance: STT 550 ms, polish 1024 ms,
release-to-inserted Γëê 1.3 s ΓÇö inside PLAN ┬º7.3's Γëñ 1.5 s target with polish
still on CPU.

Read this alongside [PLAN.md](./PLAN.md) (the product & engineering spec),
[README.md](./README.md) (layout, conventions), and
[SESSION-STATE.md](./SESSION-STATE.md) (cross-session state).

---

## Closed since the last handoff

| # (old) | Item                      | How it closed                                                                                                                                                                                                                |
| ------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | The Bar's real visuals    | 28-bar 60 fps canvas waveform fed by a ~30 Hz worklet meter (`audio.meter` ΓåÆ `audio.level`), shimmer, Γ£ô pulse, error hold, Reduce Motion path, click-through window + hover controls, Esc-while-listening via `EscapeCancel` |
| 2       | Microphone picker         | Device list enumerated in the capture renderer (the only context that can see labels), cached in main, picker in Settings and in the Bar's hover menu                                                                        |
| 3       | Onboarding                | Full PLAN ┬º2.4 sequence gated on the new `onboardingCompleted` setting; step logic pure + tested; Help rebuilt with live permission/engine panels                                                                            |
| 4       | Idle mic errors swallowed | `audio.captureStatus` invoke + `audio.captureChanged` broadcast; surfaced in Settings and Help. The orchestrator's idle early-return stands ΓÇö it was right                                                                   |
| 5       | `loopbackFetch` fiction   | Now real; whisper + sidecar health go through it, polish `ChatClient` takes its transport as a required ctor arg (loopback for bundled, global for external)                                                                 |
| 6       | CI                        | `.github/workflows/ci.yml` ΓÇö full gate on macos-14; sidecars on demand + weekly canary                                                                                                                                       |
| 7       | Never proven end to end   | Proven ΓÇö see header. `kill -USR2 <pid>` (dev builds) drives the real pipeline from a shell; `say` provides the speech                                                                                                        |

Two sidecar-spawn bugs found by the proof (the exact class HANDOFF predicted):
whisper.cpp v1.9.2's server has **no `--api-key` flag** (exits at launch;
crash-loop) and `--convert` is a bare default-off flag ΓÇö both removed from the
spawn args. Whisper's isolation is its loopback bind; llama keeps the token.

## What is left

### 1. Real `fn`-key hold ΓÇö VERIFIED in the field

Owner-confirmed 2026-08-05, with Wispr Flow running alongside: hold `fn`,
speak, release ΓÇö "it's quicker, it looks good, the app is working." The
release-loss root cause (tap starved on Electron's main run loop; another
app's active tap in the chain) is fixed by the dedicated tap thread plus the
250 ms HID reconciliation watchdog, and the phantom double-tap route
(arrow-key flagsChanged noise) is closed by key-code matching. Still worth a
casual poke when convenient: double-tap to latch hands-free and a single tap
to exit, and Command Mode by hand (select text, hold `fn`, say "tighten this
up").

### 2. llama.cpp Metal fails to compile on macOS 27 ΓÇö pin bump, bench-gated

`b10276` logs `ggml_metal_library_init_from_source: error compiling source`
and falls back to CPU. Functional (polish 1.0 s), but Metal should halve it.
Bump the pin in `scripts/sidecars/build-llama.sh`, rebuild, and run the bench
before committing (PLAN ┬º16). Whisper's Metal works after one identical
grumble.

### 3. Donor branch ΓÇö harvested; retire it

`origin/claude/dictation-app-planning-cq047p` was mined for the Bar,
onboarding, mic picker and Help. Its capture architecture (pre-roll in the
renderer) was deliberately **not** taken ΓÇö main's design is committed and
tested. Its richer Home/Dictionary/Style/Models section variants were also
left; main's are live and adequate. Nothing else worth taking; delete the
branch or leave it as history.

### 4. Parity buildout, in value order (PLAN M4/M5, ┬º18)

1. Streaming partial transcripts in the Bar (M5) behind `transcribeStreaming`.
2. Command mode (┬º18.1) ΓÇö second hotkey, AX-read selection, spoken instruction
   ΓåÆ local rewrite ΓåÆ replace. Reuses the whole pipeline.
3. Voice punctuation/commands ("new line", "scratch that") pre-polish.
4. Snippets, re-polish-from-history, clipboard-only mode, menu-bar quick
   controls, app icon + unsigned local DMG.

### 5. Review leftovers, ranked

- **Design question for the owner** ΓÇö command mode triggers on selection
  presence with the _same_ hotkey (matches the reference product's shipped
  UX; PLAN ┬º18.1 sketched a second hotkey). The review's one confirmed UX
  hazard: a leftover selection (double-clicked word, auto-selecting field)
  turns dictation into an edit of that selection. Mitigations shipped: blue
  Bar indicator + distinct aria, ready-polish gate, 6k-char cap, Settings
  toggle, target-app undo restores. If real use still surprises, the fix is a
  modifier chord (e.g. hold fn+shift) ΓÇö the plumbing supports it in an hour.
- Command rows inflate history word-stats (the edited selection counts as
  words dictated). Cosmetic; fix when stats grow a per-mode breakdown.
- The external-endpoint consent warning predates command mode ΓÇö it promises
  "transcripts" leave the device, but selections now ride along too. One
  sentence in `endpointWarnings`.
- Selection liveness is not re-verified at insert time; a user who clicks
  away mid-edit gets the result at the new caret instead of a refusal.

### 6. Small persistent gotchas

- npm may skip Electron's postinstall: `electron-vite dev` then dies with
  "Electron uninstall". Fix: `node node_modules/electron/install.js`.
- Launch dev via `npm run dev` (catalog path resolution).
- `.sidecars/**` is eslint-ignored on purpose ΓÇö upstream checkouts carry their
  own configs.
- Whisper heard "Wormor" for "Murmur" ΓÇö seed the Dictionary with `Murmur`
  (and your own names) as the first real entries.

## Verifying a change

```bash
npm ci                    # if electron is missing after: node node_modules/electron/install.js
npm run native:build      # macOS only
npm run typecheck && npm run lint && npm test && npm run build
npm run dev               # MURMUR_DEBUG=1 MURMUR_LOG_TRANSCRIPTS=1 for the full trail
# hands-off dictation: kill -USR2 <electron pid>; say "words"; kill -USR2 <pid>
```

