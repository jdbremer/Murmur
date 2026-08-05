import { z } from 'zod'

/**
 * The dictation loop's domain types (PLAN §3.2) and the history row it persists
 * (PLAN §9 `dictations`).
 */

/** Tone bucket derived from the frontmost app's bundle id (PLAN §2.2 "Style"). */
export const AppCategorySchema = z.enum(['personal', 'work', 'email', 'other'])
export type AppCategory = z.infer<typeof AppCategorySchema>

export const DictationTimingsSchema = z.object({
  sttMs: z.number().nonnegative(),
  /** 0 when polishing was skipped or disabled. */
  polishMs: z.number().nonnegative(),
  /** Hotkey-up → text inserted, the number PLAN §7.3 budgets. */
  totalMs: z.number().nonnegative(),
})
export type DictationTimings = z.infer<typeof DictationTimingsSchema>

export const DictationRecordSchema = z.object({
  id: z.string().min(1),
  /** Epoch milliseconds. */
  ts: z.number().int().nonnegative(),
  rawText: z.string(),
  /** `null` when polishing level is `off` or the hallucination guard fired. */
  polishedText: z.string().nullable(),
  appBundleId: z.string().min(1).nullable(),
  appCategory: AppCategorySchema,
  durationMs: z.number().int().nonnegative(),
  sttModelId: z.string().min(1),
  polishModelId: z.string().min(1).nullable(),
  timings: DictationTimingsSchema,
})
export type DictationRecord = z.infer<typeof DictationRecordSchema>

// ---------------------------------------------------------------------------
// State machine + events
// ---------------------------------------------------------------------------

/**
 * States of the main-process `DictationStateMachine`.
 *
 * `inserted` and `error` are *events*, not resting states: both settle back to
 * `idle`. See {@link DictationEventSchema}.
 */
export const DictationStateSchema = z.enum(['idle', 'listening', 'processing', 'inserting'])
export type DictationState = z.infer<typeof DictationStateSchema>

/** Failure modes the Bar renders as a short message (PLAN §2.1 "Error"). */
export const DictationErrorCodeSchema = z.enum([
  'no-speech',
  'mic-unavailable',
  'secure-input',
  'stt-failed',
  'polish-failed',
  'insert-failed',
  'timeout',
  'cancelled',
  'unknown',
])
export type DictationErrorCode = z.infer<typeof DictationErrorCodeSchema>

/**
 * What main broadcasts to the Bar (and Hub) on every state change.
 *
 * `listening` carries the current normalised mic amplitude so a Bar that
 * subscribes mid-utterance renders immediately; the high-rate updates in
 * between arrive on the dedicated `audio.level` event instead.
 */
export const DictationEventSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('idle') }),
  z.object({
    state: z.literal('listening'),
    /** True while the latched, double-tap hands-free mode is active. */
    handsFree: z.boolean().default(false),
    /** Normalised 0..1 mic amplitude. */
    level: z.number().min(0).max(1).default(0),
  }),
  z.object({
    state: z.literal('processing'),
    stage: z.enum(['transcribing', 'polishing']).default('transcribing'),
  }),
  z.object({ state: z.literal('inserting') }),
  z.object({
    state: z.literal('inserted'),
    charCount: z.number().int().nonnegative(),
    /** Clipboard-paste is the fast path; AX insertion is the fallback (PLAN §3.2.5). */
    method: z.enum(['paste', 'accessibility']),
  }),
  z.object({
    state: z.literal('error'),
    code: DictationErrorCodeSchema,
    message: z.string().min(1),
  }),
])
export type DictationEvent = z.infer<typeof DictationEventSchema>

/** High-rate mic amplitude pushed to the Bar for the waveform (PLAN §2.1). */
export const AudioLevelEventSchema = z.object({
  level: z.number().min(0).max(1),
  /** Optional short-window peak, for the taller "peak" ticks. */
  peak: z.number().min(0).max(1).nullable().default(null),
})
export type AudioLevelEvent = z.infer<typeof AudioLevelEventSchema>

/**
 * One chunk of captured audio, hidden-capture-renderer → main (PLAN §5).
 * Always 16 kHz mono Float32; the buffer is the raw `Float32Array` bytes.
 */
export const AudioFrameSchema = z.object({
  pcm: z.custom<ArrayBuffer>(
    (value) =>
      value instanceof ArrayBuffer ||
      Object.prototype.toString.call(value) === '[object ArrayBuffer]',
    { error: 'Expected an ArrayBuffer of Float32 PCM samples' },
  ),
  /** Number of Float32 samples in `pcm` (i.e. `pcm.byteLength / 4`). */
  sampleCount: z.number().int().positive(),
  sampleRate: z.literal(16_000).default(16_000),
  /** Capture timestamp in epoch milliseconds. */
  ts: z.number().nonnegative(),
})
export type AudioFrame = z.infer<typeof AudioFrameSchema>

/** Lifecycle reports from the hidden capture renderer. */
export const AudioCaptureStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('idle') }),
  z.object({ status: z.literal('ready'), deviceId: z.string().nullable(), sampleRate: z.number() }),
  z.object({ status: z.literal('error'), message: z.string().min(1) }),
])
export type AudioCaptureStatus = z.infer<typeof AudioCaptureStatusSchema>

/** Aggregate numbers for the Hub's Home header (PLAN §2.2.1). */
export const HistoryStatsSchema = z.object({
  totalWords: z.number().int().nonnegative(),
  avgWpm: z.number().nonnegative(),
  streakDays: z.number().int().nonnegative(),
})
export type HistoryStats = z.infer<typeof HistoryStatsSchema>
