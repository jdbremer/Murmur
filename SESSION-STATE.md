# SESSION STATE — Murmur

Updated: 2026-08-05T00:45-05:00 | Focus: donor harvest + bug fixes + first-ever E2E dictation proof, on branch `buildout/flow-parity`
Claimed by: Preston's overnight autonomous session (merge to main + push in progress; clear when landed)

## DONE (this session)

- Stage 1 `14a7b32` — real Bar: 60 fps canvas waveform, 30 Hz worklet meter (`audio.meter`), shimmer/✓/error states, click-through + hover controls, `EscapeCancel`, device-list IPC. 43 donor tests ported + 10 new meter tests.
- Stage 2 `028631a` — Settings mic picker + language + history retention + live "Try it" tester.
- Stage 3 `31a13b5` — full onboarding (PLAN §2.4) gated on new `onboardingCompleted` setting; Help rebuilt with live permission/engine panels; appearance actually applied.
- Stage 4 `428e847` — idle mic errors surfaced (`audio.captureStatus`/`captureChanged`); `loopbackFetch` made real; polish ChatClient takes explicit transport.
- Stage 5 `00bf4f2` — **DICTATION PROVEN END TO END** on this machine (7 s utterance: STT 550 ms, polish 1024 ms, release→inserted ≈ 1.3 s). Fixed whisper-server spawn (`--api-key` doesn't exist in v1.9.2; `--convert false` wrong). Added dev-only SIGUSR2 hotkey driver.
- Stage 6 `4a72f07` — CI: full gate on macos-14; sidecar builds on demand + weekly canary.
- 497 tests green at every commit. HANDOFF.md rewritten from ground truth.

## IN-FLIGHT

- Adversarial review workflow (4 lenses → refuting verifiers) over the branch diff — fold confirmed findings in, then merge `buildout/flow-parity` → main and push.

## NEXT

1. Fix confirmed review findings; re-gate; merge + push to origin/main.
2. Real `fn`-key hold test (Preston's finger + Input Monitoring grant; mic already granted, paste already works).
3. llama.cpp pin bump for macOS 27 Metal (bench-gated, PLAN §16) — polish drops from ~1.0 s toward ~0.4 s.
4. Parity: streaming partials (M5) → command mode (§18.1) → voice punctuation → snippets → menu-bar quick controls → icon + DMG.

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
