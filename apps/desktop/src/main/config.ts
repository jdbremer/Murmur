/**
 * Every tunable the dictation loop and the engines depend on, in one place.
 *
 * PLAN §15.1 requires that *every* stage of the loop has a timeout and a
 * user-visible error state. Keeping the numbers here rather than sprinkled
 * through the pipeline means the transition tests can import the same values
 * the production code uses, and a future Settings screen has one thing to
 * override.
 *
 * The budgets come from PLAN §7.3 (5 s utterance, M-series 16 GB) with generous
 * headroom — a timeout is a failure surface, not a performance target.
 */

export const AUDIO = {
  /** 16 kHz mono Float32 everywhere (PLAN §5). */
  sampleRate: 16_000,
  /** Frames arrive at roughly this cadence from the AudioWorklet. */
  frameMs: 100,
  /**
   * Utterances shorter than this are treated as "no speech" rather than sent to
   * a model that would hallucinate a sentence out of a keystroke.
   */
  minUtteranceMs: 250,
  /** Hard cap per utterance (PLAN §5). Capture stops and the buffer is used. */
  maxUtteranceMs: 5 * 60_000,
  /** Rolling pre-buffer kept while the mic is warm so first syllables survive. */
  preRollMs: 300,
  /** Mic stream stays open this long after the last utterance (PLAN §5). */
  warmIdleMs: 5 * 60_000,
  /** Hands-free auto-finalise after this much trailing silence (PLAN §5). */
  handsFreeSilenceMs: 800,
  /** How often the Bar's waveform is fed, in milliseconds. */
  levelIntervalMs: 33,
} as const

/**
 * Long-form meeting capture (PLAN §18.2).
 *
 * The numbers that matter here are `maxSegmentMs` and `micHoldbackMs`, and both
 * are about something other than what they look like:
 *
 *  - `maxSegmentMs` **is the dictation-latency knob.** An in-flight segment
 *    cannot be preempted — aborting the HTTP request frees our client, but
 *    whisper-server runs the inference to completion regardless — so the worst
 *    case a dictation can wait behind meeting work is one segment's inference.
 *    At roughly 15× realtime, 15 s of audio costs about a second.
 *  - `micHoldbackMs` delays a mic segment that looks like speaker bleed, so a
 *    matching system transcript has time to arrive and cancel it. See
 *    `meeting/holdback.ts` for why the delay may never become a deletion.
 */
export const MEETING = {
  /** Trailing silence that ends a segment. */
  segmentSilenceMs: 700,
  /** Below this a "segment" is a cough, not a sentence. */
  minSegmentMs: 1_500,
  /** Hard cut. Also keeps every segment inside Whisper's 30 s window. */
  maxSegmentMs: 15_000,
  /** Carried into the next segment so a cut never clips a word onset. */
  segmentPreRollMs: 200,
  /** How often the detector samples the process list. */
  detectPollMs: 3_000,
  /** A meeting-shaped app must hold both input and output this long to count. */
  detectDwellMs: 20_000,
  /** After a decline, do not re-offer for the same app this soon. */
  detectCooldownMs: 5 * 60_000,
  /** Tap delivered nothing for this long while it should have — rebuild it. */
  systemAudioWatchdogMs: 5_000,
  /** A modal TCC dialog blocks the probe; a normal start should be quick. */
  systemAudioProbeMs: 60_000,
  systemAudioStartMs: 3_000,
  /** How long a bleed-suspect mic segment waits for a system transcript. */
  micHoldbackMs: 3_000,
  /** Everything at session start is suspect until the reference stream fills. */
  warmupMs: 1_500,
  /** Elapsed-time repaint cadence for the recording pill. */
  tickMs: 1_000,
} as const

export const TIMEOUTS = {
  /**
   * Hotkey-up → first audio frame accounted for. Guards against a capture
   * renderer that never answers (`audio.status` error, crashed page).
   */
  captureStartMs: 3_000,
  /** STT stage. Whisper turbo budgets ≤1 s; 30 s is a hang, not a slow model. */
  sttMs: 30_000,
  /** Polish stage. Skipped entirely when polishing is off (PLAN §7.3). */
  polishMs: 20_000,
  /** Clipboard swap + ⌘V + AX fallback. */
  insertMs: 5_000,
  /** Sidecar health-check probe before a model is declared ready. */
  sidecarHealthMs: 30_000,
  /** One HTTP request to a sidecar (excludes the stage timeout above). */
  sidecarRequestMs: 60_000,
  /** SIGTERM → SIGKILL escalation window when stopping a sidecar. */
  sidecarShutdownMs: 4_000,
} as const

export const SIDECAR = {
  /** Consecutive crashes before the engine reports `crash-loop` (PLAN §15.1). */
  maxRestarts: 3,
  /** Exponential backoff base between restarts. */
  restartBackoffMs: 500,
  restartBackoffMaxMs: 8_000,
  /** Health probe interval while waiting for a freshly spawned server. */
  healthPollMs: 250,
  /** Loopback address; never 0.0.0.0 (PLAN §10.3). */
  host: '127.0.0.1',
} as const

export const POLISH = {
  /**
   * Utterances at or below this many words skip polishing entirely — the round
   * trip costs more than it improves (PLAN §3.2.4, §7.3).
   */
  skipWordCount: 3,
  /** Unload the polish model after this long with no dictation (PLAN §7.1). */
  idleUnloadMs: 10 * 60_000,
  /** Sampling: deterministic-ish editing, not creative writing. */
  temperature: 0.2,
  topP: 0.9,
  /**
   * Output cap, derived from the input so a 5-word utterance cannot come back
   * as an essay: `ceil(inputTokens * factor) + floor`.
   */
  maxTokensFactor: 2.5,
  maxTokensFloor: 64,
  /**
   * Hallucination guard (PLAN §7.4). If the polished text falls outside
   * `[input * min, input * max]` characters we keep the raw transcript instead.
   * The window is wide on purpose: Clean-level editing legitimately removes a
   * third of a filler-heavy utterance, and Rewrite adds punctuation.
   */
  minLengthRatio: 0.4,
  maxLengthRatio: 2.0,
  /** Below this many characters the ratio test is meaningless; use a slack. */
  shortInputChars: 24,
  shortInputSlackChars: 40,
} as const

export const VAD = {
  /** Analysis window; 20 ms at 16 kHz = 320 samples. */
  frameSamples: 320,
  /**
   * Speech is declared when frame energy exceeds the running noise floor by
   * this many dB *and* the zero-crossing rate looks voiced.
   */
  thresholdDb: 9,
  /** Absolute floor: below this RMS nothing counts as speech, ever. */
  silenceFloorRms: 0.0025,
  /** Frames of speech required before the gate opens (debounce). */
  onsetFrames: 3,
  /** Frames of silence tolerated inside speech before the gate closes. */
  hangoverFrames: 25,
  /** Padding kept either side of the trimmed region, in frames. */
  padFrames: 8,
  /** Noise floor adaptation rate, per frame, while the gate is closed. */
  noiseAdaptation: 0.05,
} as const

export const DOWNLOAD = {
  /** Streaming chunk accounting interval for progress events. */
  progressIntervalMs: 250,
  /** Attempts per file before the download is failed. */
  maxAttempts: 3,
  retryBackoffMs: 1_000,
  /** Suffix for the in-flight file; renamed only after the hash matches. */
  partialSuffix: '.partial',
  /** Where a hash mismatch is parked for inspection (PLAN §15.2). */
  quarantineDirName: '.quarantine',
} as const

export const HOTKEY = {
  /** Two downs within this window latch hands-free mode (PLAN §2.1). */
  doubleTapMs: 350,
  /** Ignore a down/up pair shorter than this — a stray tap, not a hold. */
  minHoldMs: 120,
  /**
   * A press released within this window is a *tap*; longer is a hold. A
   * double-tap is tap-then-tap — a long dictation hold followed quickly by a
   * new press must never latch hands-free.
   */
  tapMaxMs: 300,
  /**
   * While a physical hold is live, the bridge asks the HID system this often
   * whether the key is actually still down. Event delivery can lose an up —
   * a tap disabled for slowness, another app's active tap — and a lost up
   * used to mean "dictation never stops".
   */
  physicalPollMs: 250,
  /**
   * When the OS refuses to install the tap/hook (a permission not yet
   * granted, a transient failure at login), retry this often until it takes.
   * This is what lets a permission granted mid-session bring the key to life
   * without a relaunch — a dictation key must never be silently dead.
   */
  startRetryMs: 3000,
} as const
