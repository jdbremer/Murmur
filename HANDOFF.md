# Handoff — remaining work

Written 2026-08-04. Everything below is verified against the tree at this
commit: `npm run typecheck`, `npm run lint`, `npm test` (430 tests) and
`npm run build` are all green, and the app boots with the native module active
and the 13-entry catalog loaded.

Read this alongside [PLAN.md](./PLAN.md) (the product & engineering spec) and
[README.md](./README.md) (layout, conventions, how to add an IPC channel).

---

## Where things stand

The main process was already complete. This round closed the two gaps that made
the app unusable end to end, and fixed a bug that stopped it compiling at all.

**Done in this commit:**

| Area              | What landed                                                                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/native` | **Fixed a compile failure.** `binding.gyp` enables ARC, so `static_cast` from `NSString*`/`NSDictionary*` to a CF type is illegal — two `__bridge` casts. The addon did not build before this. |
| Audio capture     | `src/renderer/audio/{capture-processor.js,capture.ts,mic-errors.ts,AudioCapture.tsx}` — `getUserMedia` + AudioWorklet, 16 kHz mono Float32, 100 ms frames                                      |
| Models UI         | `ModelsSection.tsx` + `hooks/useModels.ts` — download with live progress, cancel, select, delete, file import, origin/licence/hardware badges                                                  |
| Home / History    | FTS-backed search, paging, per-row copy & delete, clear all                                                                                                                                    |
| Dictionary        | Full CRUD, enable/disable toggle                                                                                                                                                               |
| Style             | Per-category formality / fillers / emoji / custom instructions, committed on blur                                                                                                              |
| Security          | Media permission handler (audio only, everything else denied), default-deny `window.open`, `http(s)`-only `shell.openExternal`                                                                 |
| New IPC channel   | `models.chooseFile` — native open dialog, since a sandboxed renderer cannot turn a `File` into an absolute path                                                                                |

**Two contract clarifications** worth knowing about, both in
`packages/shared/src/domain/dictation.ts`:

- `AudioCommand.warm` now documents that it **streams frames**. The old comment
  said "drop frames", but `PreRollBuffer` is a rolling ring fed by
  `orchestrator.pushFrame` while idle — a `warm` that withheld frames would
  leave pre-roll permanently empty and clip the first syllable of every
  utterance, which is the exact bug pre-roll exists to prevent. `warm` and
  `start` differ only in what _main_ does with the frames.

---

## What is left

### 1. The Bar is still placeholder visuals — **start here**

`src/renderer/bar/Bar.tsx` says so in its own header comment. It renders a
legible stand-in for each state but the waveform is a fake envelope
(`Bar.tsx:69`), not real audio.

What it needs:

- Drive the waveform from `window.murmur.dictation.onLevel`, which is already
  broadcast by main (`index.ts:157`).
- **Interpolate.** Levels arrive at 10 Hz, because main computes one RMS value
  per 100 ms PCM frame (`orchestrator.ts:601` `levelOf`). Rendering that raw
  looks like a stutter — animate toward the target between updates.
- Per-state rendering against `DictationEventSchema`: `listening` (+ a distinct
  hands-free treatment), `processing` with its `transcribing`/`polishing`
  stage, `inserting`, the `inserted` ✓ pulse with `charCount`, and `error` with
  the message and a next action.

If you want higher-rate levels rather than interpolation, the honest fix is a
separate low-rate level message from the worklet — do **not** shrink
`AUDIO.frameMs`, which is load-bearing for the STT path.

### 2. Microphone picker in Settings

`SettingsSection.tsx` currently has no mic selector, so `settings.micDeviceId`
can only ever be `null` (system default). The plumbing behind it is complete —
`CaptureController.setDevice` already reopens the stream on change
(`main/index.ts:260`).

The catch: `navigator.mediaDevices.enumerateDevices()` returns **empty labels**
until microphone permission has been granted. Either call it from the Hub and
show a "grant access to see device names" affordance, or add an IPC channel that
asks the capture renderer (which already holds permission) for the list. The
second is cleaner but needs a main→renderer request/response shape, which the
contract does not currently have — it only has broadcast.

### 3. Onboarding

Never built. PLAN §2.3. First run currently drops you into the Hub with no
model, no permissions granted and no explanation. Needs: permission priming
(Accessibility + Input Monitoring + Microphone — `permissions.*` IPC is already
wired), a first model download, and a "try it" step.

### 4. Mic failures are silently swallowed while idle

Real bug, small fix. `register.ts:154` routes an `audio.status` error to
`orchestrator.reportAudioError`, which **returns early when the phase is
`idle`** (`orchestrator.ts:305`). Main sends `warm` at startup
(`index.ts:304`), so if the mic fails then — permission denied, device in use —
the error is dropped on the floor and nothing surfaces it.

The capture renderer produces a good message for every case
(`mic-errors.ts`); it just has nowhere to go. Suggest surfacing it on the
`engines.changed` channel or adding a dedicated one, and rendering it in the Hub.

### 5. `net/fetch.ts` header oversells itself

Doc-only, but it is the file a security reviewer reads first. The header claims
_"a reviewer can grep for `fetch(` in `src/main`, find only this file, and be
done"_ and references `{@link loopbackFetch}` — **which does not exist**. There
are three other raw `fetch(` call sites: `sidecar.ts:286`,
`polish/client.ts:120`, `whisper-cpp.ts:199`.

The property mostly holds in practice — `whisper-cpp.ts:184` calls a local
`assertLoopback`, and sidecar URLs are built from a `127.0.0.1` constant — but
either write the `loopbackFetch` the comment promises and route those three
through it, or correct the comment. Do not leave it as is.

### 6. CI

None. At minimum: `typecheck`, `lint`, `test`, `build` on macOS, plus
`npm run native:build` — that last one would have caught the ARC bug fixed here.

### 7. Not verified end to end

**Nobody has yet watched this app turn speech into inserted text.** The capture
path is implemented and unit-tested, but proving the whole loop needs a machine
with:

- the sidecars built (`scripts/sidecars/build-*.sh`, needs `cmake`),
- a model downloaded (now possible from the Models UI),
- macOS Accessibility + Input Monitoring + Microphone granted.

Until someone does that, treat "dictation works" as unproven. The most likely
places for a first failure are the whisper-server multipart request
(`whisper-cpp.ts:199`) and the clipboard-swap timing (`injector.ts`,
`CLIPBOARD_RESTORE_MS = 150`).

---

## Verifying a change

```bash
npm ci
npm run native:build     # macOS only; required — see the ARC note above
npm run typecheck
npm test                 # 430 tests
npm run lint
npm run dev
```

Two gotchas that will cost you time otherwise:

- **npm ≥ 11.16 blocks install scripts.** You will see
  `npm warn allow-scripts 7 packages have install scripts not yet covered`. It
  works out anyway — `better-sqlite3` and `onnxruntime-node` ship prebuilt
  binaries and Electron lazily downloads its own on first `require`. If you do
  hit a missing binary: `npm approve-scripts --allow-scripts-pending
--workspaces=false`. The `--workspaces=false` is mandatory; it errors without it.
- **`app.getAppPath()` depends on how you launch.** `npx electron apps/desktop`
  resolves the catalog correctly; `npx electron apps/desktop/out/main/index.js`
  does not, and you will get a spurious "no catalog found". Use the former.

Without models or sidecars everything degrades to a status rather than a crash
(see the README table), so the UI is fully developable on a bare machine — use
the dev-only `debug.simulateDictation` / `debug.simulateHotkey` IPC channels.

## Testing notes

- Tests are typechecked under **`lib: ["ES2023"]` with no DOM**
  (`tsconfig.node.json` includes `test/**/*.ts`). A test that imports a renderer
  module using DOM types will fail typecheck. That is why `describeMicError`
  lives in its own DOM-free `mic-errors.ts` — keep pure logic out of
  DOM-dependent modules if you want it covered.
- `test/capture-processor.test.ts` installs the three AudioWorkletGlobalScope
  globals and grabs the class as it registers itself. The resampler emits
  `n - 1` samples per second at non-integer ratios; the test asserts that offset
  is **constant, not cumulative**, which is the property that actually matters.
