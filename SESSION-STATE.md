# SESSION STATE — Murmur

Updated: 2026-08-05T02:05-05:00 | Focus: fn-release delivery fix + Command Mode, live-QC'd; review workflow running before push
Claimed by: (none — all commits pushed to origin/main)

## DONE (this session)

- `5d26686` — **the fn release bug**: field report "long dictations never stop" root-caused to delivery loss — tap lived on Electron's busy main run loop (OS disables slow taps mid-hold) and Wispr Flow's active tap shares the chain. Fixed threefold: dedicated tap thread, HID-state reconciliation watchdog (250 ms; synthetic edges exempt), fn matched by key code so arrow-key flagsChanged noise can't phantom-double-tap. Double-tap is tap-then-tap now; quick tap exits hands-free; stale hands-free flag cleared. New bridge suite replays the field failure (hotkey.test.ts).
- `e1418a3` — **Command Mode (PLAN §18.1)**: hold the key with text selected → the utterance is an edit instruction, selection rewritten in place by the local model. AX getSelectedText in native; no-fallback failure discipline (never paste the instruction over a selection); Settings toggle; on by default. Live-QC'd: "rewrite this as one short pirate sentence" rewrote the ⌘A'd TextEdit selection.
- Live regression: plain dictation through the rebuilt native module (519 ms STT). 518 tests green.
- `2c9f2f5` + `fdf1a27` + the teardown fix — adversarial review round 2 (10 agents): all 7 verdicts REAL, all fixed. Highlights: a probe-proven use-after-free in the tap teardown (retained run loop + no RemoveSource-after-join + entry-observer readiness), the stale-native-binary watchdog tell, polish-off fallback to plain dictation, truncation refusal, AX read timebox, visible command indicator. Teardown live-QC'd: dictate → SIGTERM → clean exit. 520 tests.

- Stage 1 `14a7b32` — real Bar: 60 fps canvas waveform, 30 Hz worklet meter (`audio.meter`), shimmer/✓/error states, click-through + hover controls, `EscapeCancel`, device-list IPC. 43 donor tests ported + 10 new meter tests.
- Stage 2 `028631a` — Settings mic picker + language + history retention + live "Try it" tester.
- Stage 3 `31a13b5` — full onboarding (PLAN §2.4) gated on new `onboardingCompleted` setting; Help rebuilt with live permission/engine panels; appearance actually applied.
- Stage 4 `428e847` — idle mic errors surfaced (`audio.captureStatus`/`captureChanged`); `loopbackFetch` made real; polish ChatClient takes explicit transport.
- Stage 5 `00bf4f2` — **DICTATION PROVEN END TO END** on this machine (7 s utterance: STT 550 ms, polish 1024 ms, release→inserted ≈ 1.3 s). Fixed whisper-server spawn (`--api-key` doesn't exist in v1.9.2; `--convert false` wrong). Added dev-only SIGUSR2 hotkey driver.
- Stage 6 `4a72f07` — CI: full gate on macos-14; sidecar builds on demand + weekly canary.
- 497 tests green at every commit. HANDOFF.md rewritten from ground truth.

## FIELD VERIFICATION (owner, 2026-08-05)

- The fn release fix is confirmed on the physical key, with Wispr Flow running: "it's quicker, it looks good, the app is working." HANDOFF item #1 is closed.

## IN-FLIGHT

- Nothing. The review ran (11 agents, 14 findings, 7 confirmed — all fixed, including the presenter/window settle-to-idle seam and the loopback redirect hole), the branch merged to main, and main is pushed.

## NEXT

1. Real `fn`-key hold test (Preston's finger + Input Monitoring grant; mic already granted, paste already works).
2. llama.cpp pin bump for macOS 27 Metal (bench-gated, PLAN §16) — polish drops from ~1.0 s toward ~0.4 s.
3. Parity: streaming partials (M5) → command mode (§18.1) → voice punctuation → snippets → menu-bar quick controls → icon + DMG.

## GOTCHAS / CONSTRAINTS

- Electron postinstall may be skipped by npm: "Error: Electron uninstall" from electron-vite → run `node node_modules/electron/install.js`.
- whisper-server (v1.9.2) has NO auth flag — loopback bind is its isolation; don't reintroduce `--api-key`.
- llama-server on macOS 27: Metal shader compile fails on b10276, CPU fallback engaged — do not "fix" by disabling the embed flag; bump the pin with bench numbers.
- Donor branch is fully harvested — do NOT merge it; retire it.
- `echoCancellation:true` did not stop `say`-through-speakers from being heard (feared, didn't happen).
- Dictionary seed candidates: "Murmur" (whisper heard "Wormor").
- US-only catalog policy, loopback+token sidecars, no-telemetry, no AI attribution in commits — all standing.

## LINKS & COMMANDS

- Gate: `npm run typecheck && npm run lint && npm test && npm run build`
- Hands-off dictation: `MURMUR_DEBUG=1 MURMUR_LOG_TRANSCRIPTS=1 npm run dev` then `kill -USR2 <electron pid>; say "words"; kill -USR2 <pid>`
- History: `sqlite3 -readonly "~/Library/Application Support/Murmur/murmur.db" 'select * from dictations order by ts desc limit 3'`
- Canon: PLAN.md · HANDOFF.md (rewritten 2026-08-05) · README.md
