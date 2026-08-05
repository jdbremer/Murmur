# SESSION STATE — Murmur

Updated: 2026-08-04T23:35-05:00 | Focus: environment bootstrap + full repo audit on Preston's M5 Pro; next session executes the staged build-out
Claimed by: (none — this session ended after bootstrap; the build-out session should claim stages as it starts them)

## DONE (this session)

- Verified HANDOFF.md against git: local main == origin/main at 5bfd0c5, clean tree. Every handoff claim spot-checked in source — all accurate.
- `npm ci` clean (npm 11.12.1 < 11.16, so no approve-scripts dance needed).
- `npm run native:build` — murmur_native.node compiles on macOS 27 / M5 Pro (the ARC __bridge fix works).
- Full gate green on this machine: typecheck, lint, test (430), build.
- Sidecars built (arm64-only, dev): `.sidecars/bin/whisper-server` (whisper.cpp v1.9.2) + `.sidecars/bin/llama-server` (llama.cpp b10276), with .sha256 files. cmake installed via brew.
- Models downloaded + sha256-verified into `~/Library/Application Support/Murmur/models/`:
  - `whisper-large-v3-turbo-q5_0/ggml-large-v3-turbo-q5_0.bin` (574 MB, STT)
  - `gemma-3-4b-it-qat-q4_0/gemma-3-4B-it-QAT-Q4_0.gguf` (2.4 GB, polish)
- `~/Library/Application Support/Murmur/settings.json` pre-seeded to select both models, so first boot loads them via `engines.apply`.

## IN-FLIGHT

- Nothing mid-edit. Repo is untouched except this file.

## NEXT (ordered — the starter prompt covers these as Stages 0–7)

1. Boot `npm run dev`; Preston grants Microphone + Accessibility + Input Monitoring (the only human-required step).
2. **Harvest the donor branch** (see GOTCHAS): real Bar waveform, mic picker, onboarding — HANDOFF items #1–#3 largely exist there already.
3. Fix HANDOFF #4 (idle mic errors swallowed at orchestrator.ts:305 vs warm at index.ts:304) and #5 (write the promised `loopbackFetch`, route sidecar.ts / polish/client.ts / whisper-cpp.ts raw fetches through it).
4. Prove dictation end to end (HANDOFF #7 — never yet demonstrated): `debug.simulateHotkey` + `say` into the mic; watch whisper multipart (whisper-cpp.ts:199) and clipboard restore (injector.ts, 150 ms).
5. CI (HANDOFF #6), then Wispr-parity buildout: streaming partials (M5), command mode, voice commands, snippets (PLAN §18).

## GOTCHAS / CONSTRAINTS

- **Donor branch — do NOT plain-merge.** `origin/claude/dictation-app-planning-cq047p` carries two commits main lacks (f991747, 29119a9; pushed 21:45/22:03 CDT, i.e. AFTER PR #1 merged and unseen by 5bfd0c5): faithful Bar (BarCanvas 60 fps, shimmer, ✓ pulse, click-through via `bar.pointerRegion`, escape.ts, 65 tests), full onboarding (`hub/onboarding/`), mic-device IPC (`audio.listDevices/devices/devicesChanged`), 30 Hz `audio.meter`, richer Hub sections. Built against a DIFFERENT capture architecture (pre-roll in renderer; orchestrator level broadcast removed). Main's capture (pre-roll in main, warm streams frames) is the committed, tested design HANDOFF.md defends — harvest donor components onto main's architecture, don't merge.
- US-only model catalog (`originPolicy: ["US"]`) is an owner decision (PLAN decision log 2026-08-05). Never widen it.
- Only outbound network path is `net/fetch.ts` (HF allowlist). Sidecars are loopback + per-launch bearer token. No telemetry, ever.
- Don't shrink `AUDIO.frameMs` (100 ms) — load-bearing for STT framing.
- Tests typecheck DOM-free (`tsconfig.node.json` includes `test/`); keep pure logic out of DOM modules or it can't be covered.
- Launch dev via `npm run dev` (or `npx electron apps/desktop`); pointing electron at `out/main/index.js` breaks catalog resolution.
- No AI attribution in commits/PRs — plain messages, repo's existing style (imperative subject, thorough body). No Co-Authored-By lines.

## LINKS & COMMANDS

- Gate: `npm run typecheck && npm run lint && npm test && npm run build`
- Native rebuild: `npm run native:build` · Sidecars: `ARCHS=arm64 scripts/sidecars/build-{whisper,llama}.sh` → `.sidecars/bin/`
- Dev-only IPC: `debug.simulateDictation` (state machine only), `debug.simulateHotkey` (real pipeline, synthetic trigger)
- Env: `MURMUR_DEBUG=1`, `MURMUR_LOG_TRANSCRIPTS=1`, `MURMUR_SIDECAR_DIR=…`
- Donor diff: `git diff ffed2cd..origin/claude/dictation-app-planning-cq047p` (or per-file `git show 29119a9:<path>`)
- Canon: PLAN.md (spec) · HANDOFF.md (Jay's verified work items) · README.md (conventions, IPC recipe)
